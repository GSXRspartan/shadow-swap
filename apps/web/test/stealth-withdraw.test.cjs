require('./bootstrap.cjs');
/**
 * Stealth-typed inputs (tTARI, created-Stealth) for Sapient seed accounts:
 * `{ kind: 'withdrawStealthAndExecute' }` (tari-wallet v0.6.17 messages.ts / provider-api.md).
 *
 * Verification level: REFERENCE-PROVIDER. The workspace-id discipline below is checked against a
 * model of how Sapient assembles the final transaction, transcribed from the shipped
 * @chironbuilder/ootle-sdk 0.1.30 (`buildWithdrawStealthAndExecute`) and its vendored builder
 * (`emitInstructions`): withdraw -> PutLast(0) -> StealthTransfer(revealed_input_bucket 0) ->
 * PutLast(1) -> follow-ups appended raw. It is NOT a live-wallet observation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('@tari-ootle/wallet-adapter');
const sw = require('../build-test/services/stealthWithdraw.js');
const review = require('../build-test/lib/review.js');
const tari = require('../build-test/services/tariWindow.js');
const executionIdentity = require('../build-test/lib/executionIdentity.js');

const TTARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
const X = `resource_${'a1'.repeat(32)}`;
const Z = `resource_${'a3'.repeat(32)}`;
const CSTL = `resource_${'c5'.repeat(32)}`;
const ACCT = `component_${'e1'.repeat(32)}`;
const POOL = `component_${'f1'.repeat(32)}`;
const POOL2 = `component_${'f2'.repeat(32)}`;
const OFFER = `component_${'f3'.repeat(32)}`;
const TEMPLATE = 'ab'.repeat(32);
const STEALTH = new Set([TTARI, CSTL]);
const LOCAL = { transactionRequests: true, stealthWithdraw: true };
const RELAYED = { transactionRequests: true, stealthWithdraw: false };
const base = { maxEpoch: '10', operationId: 'op' };
const evidence = { quotedOutput: '100', feeBps: '30', slippageBps: '50', effectiveInput: '1000' };

const swapFromTari = () => w.buildSwapIntent({ poolComponent: POOL, accountAddress: ACCT, inputResource: TTARI, outputResource: X, rawInputAmount: '1000', minOutput: '90', ...base, quoteEvidence: evidence });

/** Sapient's final instruction list for a withdrawStealthAndExecute operation (reference model). */
function sapientAssemble(op) {
  return [
    { CallMethod: { call: { Address: ACCT }, method: 'withdraw', args: ['<resource>', '<amount + dust>'] } },
    { PutLastInstructionOutputOnWorkspace: { key: 0 } },
    { StealthTransfer: { resource_address_ref: { Address: op.resourceAddress }, statement: '<wallet-built>', revealed_input_bucket: { id: 0, offset: null } } },
    { PutLastInstructionOutputOnWorkspace: { key: 1 } },
    ...op.followUpInstructions,
  ];
}

/** Every workspace reference points at an id allocated EARLIER; no id is allocated twice; every bucket is consumed. */
function assertWorkspaceDiscipline(list) {
  const allocated = new Set();
  const consumed = new Set();
  for (const ins of list) {
    const refs = [];
    const walk = (n) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        if (n.Workspace !== undefined && typeof n.Workspace === 'object') refs.push(n.Workspace.id);
        else if (typeof n.Workspace === 'number') refs.push(n.Workspace);
        else Object.values(n).forEach(walk);
      }
    };
    walk(ins.CallMethod?.args ?? ins.CallFunction?.args ?? []);
    if (typeof ins.CallMethod?.call?.Workspace === 'number') refs.push(ins.CallMethod.call.Workspace);
    if (ins.StealthTransfer) refs.push(ins.StealthTransfer.revealed_input_bucket.id);
    for (const r of refs) {
      assert.ok(allocated.has(r), `workspace ${r} referenced before it exists`);
      consumed.add(r);
    }
    const key = ins.PutLastInstructionOutputOnWorkspace?.key;
    if (key !== undefined) {
      assert.equal(allocated.has(key), false, `workspace ${key} allocated twice`);
      allocated.add(key);
    }
  }
  return { allocated, consumed };
}

test('plan: public inputs keep the plain instruction path', () => {
  const intent = w.buildSwapIntent({ poolComponent: POOL, accountAddress: ACCT, inputResource: X, outputResource: TTARI, rawInputAmount: '5', minOutput: '1', ...base, quoteEvidence: evidence });
  assert.deepEqual(sw.planInputMode(intent.instructions, { stealthResources: STEALTH, capabilities: LOCAL }), { mode: 'instructions' });
});

test('plan: walletd-relayed accounts (no stealthWithdraw) keep the existing plain path for tTARI', () => {
  assert.deepEqual(sw.planInputMode(swapFromTari().instructions, { stealthResources: STEALTH, capabilities: RELAYED }), { mode: 'instructions' });
  assert.deepEqual(sw.planInputMode(swapFromTari().instructions, { stealthResources: STEALTH }), { mode: 'instructions' });
});

test('plan: a Sapient local account uses withdrawStealthAndExecute for a single Stealth input', () => {
  assert.deepEqual(sw.planInputMode(swapFromTari().instructions, { stealthResources: STEALTH, capabilities: LOCAL }), { mode: 'stealth', resourceAddress: TTARI });
});

test('plan: a two-input operation with a Stealth side is BLOCKED for a local account, with the reason', () => {
  const add = w.buildAddLiquidityIntent({ poolComponent: POOL, accountAddress: ACCT, resourceA: TTARI, resourceB: X, rawAmountA: '10', rawAmountB: '10', ...base });
  const plan = sw.planInputMode(add.instructions, { stealthResources: STEALTH, capabilities: LOCAL });
  assert.equal(plan.mode, 'blocked');
  assert.match(plan.reason, /single input/);
  const noTrio = sw.planInputMode(swapFromTari().instructions, { stealthResources: STEALTH, capabilities: { stealthWithdraw: true, transactionRequests: false } });
  assert.equal(noTrio.mode, 'blocked');
});

test('operation: tTARI swap -> follow-ups use the revealed bucket at id 1 and allocate from 2', () => {
  const { operation, followUps } = sw.buildStealthWithdrawOperation(swapFromTari().instructions, ACCT);
  assert.equal(operation.kind, 'withdrawStealthAndExecute');
  assert.equal(operation.resourceAddress, TTARI);
  assert.equal(operation.amount, '1000');
  assert.deepEqual(operation.relatedComponents, [POOL], 'the pool must be registered as an input');
  assert.equal(followUps[0].CallMethod.method, 'swap');
  assert.deepEqual(followUps[0].CallMethod.args[0], { Workspace: { id: 1, offset: null } });
  assert.deepEqual(followUps[1], { PutLastInstructionOutputOnWorkspace: { key: 2 } });
  assert.deepEqual(followUps[2].CallMethod.args, [{ Workspace: { id: 2, offset: null } }]);
  assert.equal(followUps[2].CallMethod.method, 'deposit');
  const { allocated, consumed } = assertWorkspaceDiscipline(sapientAssemble(operation));
  assert.deepEqual([...allocated].sort(), [0, 1, 2]);
  assert.deepEqual([...consumed].sort(), [0, 1, 2], 'every bucket is consumed: nothing dangles');
  tari.assertStealthWithdrawOperation(operation);
});

test('operation: multi-hop from tTARI chains 1 -> 2 -> 3 and registers every pool', () => {
  const intent = w.buildMultiHopSwapIntent({ accountAddress: ACCT, rawInputAmount: '1000', hops: [{ poolComponent: POOL, inputResource: TTARI, outputResource: X, quotedOutput: '500', feeBps: '30' }, { poolComponent: POOL2, inputResource: X, outputResource: Z, quotedOutput: '200', feeBps: '30' }], minOutput: '190', ...base, slippageBps: '50' });
  const { operation } = sw.buildStealthWithdrawOperation(intent.instructions, ACCT);
  assert.deepEqual(operation.relatedComponents, [POOL, POOL2].sort());
  const { allocated, consumed } = assertWorkspaceDiscipline(sapientAssemble(operation));
  assert.deepEqual([...allocated].sort(), [0, 1, 2, 3]);
  assert.equal(consumed.size, 4);
});

test('operation: a created-Stealth SwapOffer create escrows the revealed bucket (CallFunction arg 0 = id 1)', () => {
  const intent = w.buildCreateSwapOfferIntent({ offerTemplateAddress: TEMPLATE, accountAddress: ACCT, offered: { kind: 'fungible', resource: CSTL, amount: '400' }, requested: { kind: 'fungible', resource: X, amount: '700' }, designatedTaker: null, hashLock: null, expiresAtEpoch: '0', ...base });
  assert.equal(sw.planInputMode(intent.instructions, { stealthResources: STEALTH, capabilities: LOCAL }).mode, 'stealth');
  const { operation, followUps } = sw.buildStealthWithdrawOperation(intent.instructions, ACCT);
  assert.equal(operation.resourceAddress, CSTL, 'the resource is never changed');
  assert.deepEqual(followUps[0].CallFunction.args[0], { Workspace: { id: 1, offset: null } });
  assert.equal(operation.relatedComponents, undefined, 'a constructor touches no existing component');
  assertWorkspaceDiscipline(sapientAssemble(operation));
});

test('operation: a taker paying tTARI into a SwapOffer fill deposits what is released', () => {
  const intent = w.buildFillSwapOfferIntent({ offerComponent: OFFER, accountAddress: ACCT, payment: { kind: 'fungible', resource: TTARI, amount: '2500' }, preimage: null, ...base });
  const { operation, followUps } = sw.buildStealthWithdrawOperation(intent.instructions, ACCT);
  assert.deepEqual(operation.relatedComponents, [OFFER]);
  assert.equal(followUps.at(-1).CallMethod.method, 'deposit');
  assertWorkspaceDiscipline(sapientAssemble(operation));
});

test('operation: a follow-up that calls the account for anything but deposit is refused (as the wallet would)', () => {
  const intent = swapFromTari();
  const hostile = [...intent.instructions, { kind: 'call_method', componentAddress: ACCT, method: 'withdraw', args: [X, '1'], argTypes: ['ResourceAddress', 'Amount'] }];
  assert.throws(() => sw.buildStealthWithdrawOperation(hostile, ACCT), /may not call "withdraw" on your own account|cannot withdraw anything else/);
  assert.throws(() => sw.buildStealthWithdrawOperation(intent.instructions, `component_${'99'.repeat(32)}`), /connected account/);
});

test('review: the wallet request carries the frozen Stealth operation built from the SAME intent, and the differential accepts it', () => {
  const intent = swapFromTari();
  const identity = executionIdentity.captureIdentity({ provider: {}, expectedNetwork: 'esmeralda', providerNetwork: 'esmeralda', account: ACCT, capabilities: LOCAL, nonce: 'n1' });
  const r = review.reviewFromAmmIntent({ intent, operationId: 'op', network: 'esmeralda', identity, stealthInput: { resourceAddress: TTARI } });
  const op = r.walletRequest.operation;
  assert.equal(op.kind, 'withdrawStealthAndExecute');
  assert.ok(Object.isFrozen(op) && Object.isFrozen(op.followUpInstructions));
  assert.deepEqual(r.walletRequest.instructions, op.followUpInstructions);
  const diff = review.diffReviewForIntent(r, intent);
  assert.equal(diff.ok, true, diff.mismatches.join('; '));
  assert.throws(() => review.reviewFromAmmIntent({ intent, operationId: 'op', network: 'esmeralda', identity, stealthInput: { resourceAddress: X } }), /Stealth input is not the resource/);
});

test('transport: exactly the documented withdrawStealthAndExecute fields are sent; anything else is refused', async () => {
  const { operation } = sw.buildStealthWithdrawOperation(swapFromTari().instructions, ACCT);
  const seen = [];
  const provider = {
    async request(envelope) {
      seen.push(JSON.parse(JSON.stringify(envelope)));
      if (envelope.method === 'tari_createTransactionRequest') return { requestId: 'req_s' };
      if (envelope.method === 'tari_getTransactionRequest') return { requestId: 'req_s', status: 'approved', note: '', createdAt: 1, expiresAt: 2 };
      if (envelope.method === 'tari_submitTransactionRequest') return { transactionId: 'tx_s' };
      throw new Error(`unexpected ${envelope.method}`);
    },
  };
  const result = await tari.submitViaTransactionRequest(provider, operation, { onRequestId: () => undefined, onSubmitted: () => undefined });
  assert.equal(result.transactionId, 'tx_s');
  const create = seen.find((e) => e.method === 'tari_createTransactionRequest');
  assert.deepEqual(create.params, JSON.parse(JSON.stringify(operation)));
  await assert.rejects(tari.createTransactionRequest(provider, { ...operation, viewKey: 'x' }), /undocumented field "viewKey"/);
  await assert.rejects(tari.createTransactionRequest(provider, { ...operation, followUpInstructions: [] }), /no follow-up instructions/);
  await assert.rejects(tari.createTransactionRequest(provider, { ...operation, amount: '0' }), /positive raw integer/);
  await assert.rejects(tari.createTransactionRequest(provider, { kind: 'sendPrivately', resourceAddress: TTARI }), /creates only "instructions" and "withdrawStealthAndExecute"/);
});
