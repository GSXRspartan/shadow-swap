require('./bootstrap.cjs');
/**
 * Route intents -> the EXACT instruction list a wallet signs, and the review a signer sees.
 *
 * The engine facts these encode (audit_engine_tests/tests/multihop_routes.rs):
 *   m05 an undeposited returned bucket fails the transaction, so every output is captured
 *       with PutLastInstructionOutputOnWorkspace and deposited;
 *   m01-m04 a multi-hop route is ONE transaction and is atomic;
 *   m06 a pool created in a transaction is called through ComponentReference::Workspace.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('@tari-ootle/wallet-adapter');
const { buildSignableInstructions } = require('../build-test/lib/instructions.js');
const review = require('../build-test/lib/review.js');
const executionIdentity = require('../build-test/lib/executionIdentity.js');
const { encodeLiteral } = require('../build-test/lib/instructionArgs.js');
const lit = (type, value) => ({ Literal: encodeLiteral(type, value) });

const R = (n) => `resource_${n.repeat(64).slice(0, 64)}`;
const P = (n) => `component_${n.repeat(64).slice(0, 64)}`;
const ACCT = P('f');
const identity = executionIdentity.captureIdentity({ provider: {}, expectedNetwork: 'esmeralda', providerNetwork: 'esmeralda', account: ACCT, capabilities: { transactionRequests: true }, nonce: 'n1' });

test('wire: a direct swap is withdraw -> put -> swap -> put -> deposit (the output is never dangling)', () => {
  const intent = w.buildSwapIntent({ poolComponent: P('1'), accountAddress: ACCT, inputResource: R('a'), outputResource: R('b'), rawInputAmount: '10', minOutput: '5', maxEpoch: '9', operationId: 'op', quoteEvidence: { quotedOutput: '6', feeBps: '30', slippageBps: '50', effectiveInput: '9' } });
  const wire = buildSignableInstructions({ instructions: intent.instructions, maxEpoch: '9' });
  // No WithMaxEpoch: Ootle has no such instruction; the wallet sets the transaction's max_epoch.
  assert.deepEqual(wire, [
    { CallMethod: { call: { Address: ACCT }, method: 'withdraw', args: [lit('ResourceAddress', R('a')), lit('Amount', '10')] } },
    { PutLastInstructionOutputOnWorkspace: { key: 0 } },
    { CallMethod: { call: { Address: P('1') }, method: 'swap', args: [{ Workspace: { id: 0, offset: null } }, lit('ResourceAddress', R('b')), lit('Amount', '5')] } },
    { PutLastInstructionOutputOnWorkspace: { key: 1 } },
    { CallMethod: { call: { Address: ACCT }, method: 'deposit', args: [{ Workspace: { id: 1, offset: null } }] } },
  ]);
});

test('wire: remove liquidity deposits BOTH tuple elements by offset', () => {
  const intent = w.buildRemoveLiquidityIntent({ poolComponent: P('1'), accountAddress: ACCT, lpResource: R('e'), rawLpAmount: '10', maxEpoch: '9', operationId: 'op' });
  const wire = buildSignableInstructions({ instructions: intent.instructions });
  const deposits = wire.filter((i) => i.CallMethod?.method === 'deposit');
  assert.deepEqual(deposits.map((d) => d.CallMethod.args[0]), [{ Workspace: { id: 1, offset: 0 } }, { Workspace: { id: 1, offset: 1 } }]);
});

test('wire: a two-hop route is ONE instruction list chaining workspace ids, final min on the last hop', () => {
  const intent = w.buildMultiHopSwapIntent({ accountAddress: ACCT, rawInputAmount: '1000000', hops: [{ poolComponent: P('1'), inputResource: R('a'), outputResource: R('b'), quotedOutput: '1490000', feeBps: '30' }, { poolComponent: P('2'), inputResource: R('b'), outputResource: R('c'), quotedOutput: '880000', feeBps: '30' }], minOutput: '875000', maxEpoch: '99', operationId: 'op', slippageBps: '50' });
  const wire = buildSignableInstructions({ instructions: intent.instructions, maxEpoch: '99' });
  const swaps = wire.filter((i) => i.CallMethod?.method === 'swap');
  assert.equal(swaps.length, 2);
  assert.deepEqual(swaps[0].CallMethod.args, [{ Workspace: { id: 0, offset: null } }, lit('ResourceAddress', R('b')), lit('Amount', '1')]);
  assert.deepEqual(swaps[1].CallMethod.args, [{ Workspace: { id: 1, offset: null } }, lit('ResourceAddress', R('c')), lit('Amount', '875000')]);
  assert.deepEqual(wire.at(-1), { CallMethod: { call: { Address: ACCT }, method: 'deposit', args: [{ Workspace: { id: 2, offset: null } }] } });
});

test('review: a route shows the WHOLE-ROUTE minimum, never the intermediate hop bound of 1', () => {
  const intent = w.buildMultiHopSwapIntent({ accountAddress: ACCT, rawInputAmount: '1000000', hops: [{ poolComponent: P('1'), inputResource: R('a'), outputResource: R('b'), quotedOutput: '1490000', feeBps: '30' }, { poolComponent: P('2'), inputResource: R('b'), outputResource: R('c'), quotedOutput: '880000', feeBps: '30' }], minOutput: '875000', maxEpoch: '99', operationId: 'op', slippageBps: '50' });
  const r = review.reviewFromAmmIntent({ intent, operationId: 'op', network: 'esmeralda', identity, maxEpochRaw: '99' });
  assert.equal(r.legs[0].minOutputRaw, '875000');
  assert.equal(review.diffReviewAgainstIntent(r, intent).ok, true, review.diffReviewAgainstIntent(r, intent).mismatches.join('; '));
  assert.throws(() => review.reviewFromAmmIntent({ intent, operationId: 'op', network: 'esmeralda', identity, minOutputRaw: '1' }), /min_output/);
});

test('wire: create pool calls Pool::new, then add_liquidity on ComponentReference::Workspace, then deposits LP', () => {
  const intent = w.buildCreatePoolIntent({ poolTemplateAddress: 'ab'.repeat(32), accountAddress: ACCT, resourceA: R('a'), resourceB: R('b'), rawAmountA: '4000000', rawAmountB: '9000000', feeBps: 30, maxEpoch: '9', operationId: 'op' });
  const wire = buildSignableInstructions({ instructions: intent.instructions });
  // TemplateAddress serialises as the bare 64-hex hash (engine fixture "probe").
  assert.deepEqual(wire[0], { CallFunction: { address: 'ab'.repeat(32), function: 'new', args: [lit('ResourceAddress', R('a')), lit('ResourceAddress', R('b')), lit('u16', '30')] } });
  assert.deepEqual(wire[1], { PutLastInstructionOutputOnWorkspace: { key: 0 } });
  const add = wire.find((i) => i.CallMethod?.method === 'add_liquidity');
  assert.deepEqual(add.CallMethod.call, { Workspace: 0 }, 'the new pool is addressed through the workspace');
  assert.equal(wire.at(-1).CallMethod.method, 'deposit');
  const r = review.reviewFromAmmIntent({ intent, operationId: 'op', network: 'esmeralda', identity });
  assert.equal(r.legs[0].amounts.length, 2, 'both deposits are named in the review');
});
