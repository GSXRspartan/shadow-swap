require('./bootstrap.cjs');
/**
 * Browser instruction JSON == the JSON the REAL v0.48 engine executed.
 *
 * `ootle-v048-instructions.json` is written by audit_engine_tests/tests/instruction_wire_v048.rs,
 * which builds every browser operation with the upstream Rust builder, serialises it with
 * upstream serde, deserialises it again and EXECUTES the deserialised list (balances are
 * asserted there). Here the same parameters go through this app's own builders
 * (@tari-ootle/wallet-adapter) and serializer (lib/instructions.ts), and the output must be
 * the identical JSON. If both hold, what the browser hands a wallet is a transaction the
 * engine runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ootle-v048-instructions.json');
const w = require('@tari-ootle/wallet-adapter');
const { buildSignableInstructions } = require('../build-test/lib/instructions.js');
const { encodeLiteral, LiteralEncodingError } = require('../build-test/lib/instructionArgs.js');

const scenario = (name) => {
  const s = fixture.scenarios.find((x) => x.name === name);
  assert.ok(s, `fixture scenario ${name}`);
  return s;
};
const wire = (intent) => buildSignableInstructions({ instructions: intent.instructions ?? intent, maxEpoch: '10' });
const evidence = { quotedOutput: '1', feeBps: '30', slippageBps: '50', effectiveInput: '1' };

test('fixture: produced by the pinned v0.48.0 engine', () => {
  assert.match(fixture.cohort, /v0\.48\.0 \(6a25dbc5/);
  assert.ok(fixture.literals.length >= 30);
  assert.ok(fixture.scenarios.length >= 12);
});

test('literals: every engine-produced CBOR encoding is reproduced byte for byte', () => {
  for (const { type, value, hex } of fixture.literals) {
    assert.equal(encodeLiteral(type, value), hex, `${type} ${JSON.stringify(value)}`);
  }
});

test('literals: out-of-range and malformed values are refused, never truncated or guessed', () => {
  const bad = [
    ['Amount', '-1'], ['Amount', '1.5'], ['Amount', '01'], ['Amount', (1n << 128n).toString()],
    ['u16', '65536'], ['u64', (1n << 64n).toString()], ['bool', 'true'],
    ['ResourceAddress', 'component_' + '0'.repeat(64)], ['ResourceAddress', 'resource_abc'],
    ['ComponentAddress', 'resource_' + '0'.repeat(64)], ['Hash32', 'ab'], ['PublicKey', 'XY'.repeat(32)],
    ['Bytes', 'abc'], ['NonFungibleId', 'art-1'], ['NonFungibleId', 'str_'], ['NonFungibleId', 'u32_4294967296'],
    ['NonFungibleId', 'uuid_00'], ['NonFungibleId', 'u64:5'], ['NonFungibleId', 'str_' + 'x'.repeat(65)],
    ['Amount', null], ['Bucket', 'x'],
  ];
  for (const [type, value] of bad) assert.throws(() => encodeLiteral(type, value), LiteralEncodingError, `${type} ${value}`);
});

test('probe: bare-hex CallFunction address, integer workspace keys, Address call reference', () => {
  assert.equal(fixture.probe[0].CallFunction.address.length, 64);
  assert.deepEqual(fixture.probe[1], { PutLastInstructionOutputOnWorkspace: { key: 0 } });
});

test('wire == engine: create_pool (Pool::new by template hash, add_liquidity on the workspace component)', () => {
  const { params, instructions } = scenario('create_pool');
  const intent = w.buildCreatePoolIntent({ ...params, maxEpoch: '10', operationId: 'op' });
  assert.deepEqual(wire(intent), instructions);
});

test('wire == engine: add_liquidity', () => {
  const { params, instructions } = scenario('add_liquidity');
  assert.deepEqual(wire(w.buildAddLiquidityIntent({ ...params, maxEpoch: '10', operationId: 'op' })), instructions);
});

test('wire == engine: swap', () => {
  const { params, instructions } = scenario('swap');
  assert.deepEqual(wire(w.buildSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence })), instructions);
});

test('wire == engine: multi_hop_swap (intermediate min 1, route min on the last hop)', () => {
  const { params, instructions } = scenario('multi_hop_swap');
  const intent = w.buildMultiHopSwapIntent({
    accountAddress: params.accountAddress,
    rawInputAmount: params.rawInputAmount,
    minOutput: params.minOutput,
    hops: params.hops.map((h) => ({ ...h, quotedOutput: '1000000', feeBps: '30' })),
    maxEpoch: '10',
    operationId: 'op',
    slippageBps: '50',
  });
  assert.deepEqual(wire(intent), instructions);
});

test('wire == engine: remove_liquidity (both tuple elements deposited)', () => {
  const { params, instructions } = scenario('remove_liquidity');
  assert.deepEqual(wire(w.buildRemoveLiquidityIntent({ ...params, maxEpoch: '10', operationId: 'op' })), instructions);
});

test('wire == engine: marketplace create_listing withdraws the NFT with withdraw_non_fungible', () => {
  const { params, instructions } = scenario('create_listing');
  const intent = w.createListing({ ...params, expiryEpoch: Number(params.expiryEpoch) });
  assert.deepEqual(wire(intent), instructions);
  assert.equal(instructions[0].CallMethod.method, 'withdraw_non_fungible');
});

test('wire == engine: marketplace buy_listing', () => {
  const { params, instructions } = scenario('buy_listing');
  const intent = w.buyListing(params.listingAddress, params.buyerAccount, params.quoteResource, params.amount, { quantity: '1', expiryEpoch: 0 });
  assert.deepEqual(wire(intent), instructions);
});

test('wire: no instruction kind outside upstream Instruction is ever emitted (no WithMaxEpoch)', () => {
  const allowed = new Set(['CallMethod', 'CallFunction', 'PutLastInstructionOutputOnWorkspace']);
  for (const s of fixture.scenarios) for (const i of s.instructions) assert.ok(allowed.has(Object.keys(i)[0]), `${s.name}: ${Object.keys(i)[0]}`);
  const { params } = scenario('swap');
  const out = wire(w.buildSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence }));
  for (const i of out) assert.ok(allowed.has(Object.keys(i)[0]), Object.keys(i)[0]);
});

test('wire: a call whose argument types are not declared is refused, not guessed', () => {
  const { params } = scenario('swap');
  const intent = w.buildSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence });
  const stripped = intent.instructions.map((i) => (i.kind === 'call_method' ? { ...i, argTypes: undefined } : i));
  assert.throws(() => wire(stripped), /declared type/);
  const mistyped = intent.instructions.map((i) => (i.kind === 'call_method' ? { ...i, argTypes: ['Bucket', 'Amount', 'Amount'] } : i));
  assert.throws(() => wire(mistyped), LiteralEncodingError);
});
