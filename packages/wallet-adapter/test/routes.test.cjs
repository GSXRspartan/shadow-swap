/**
 * Route builders: every returned bucket is deposited (the engine rejects dangling outputs,
 * audit_engine_tests m05), multi-hop is ONE transaction with the whole-route minimum on the
 * final hop, and pool creation is an atomic create-and-fund.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../dist/index.js');

const R = (n) => `resource_${n.repeat(64).slice(0, 64)}`;
const P = (n) => `component_${n.repeat(64).slice(0, 64)}`;
const ACCT = P('f');
const hop = (pool, i, o, q) => ({ poolComponent: P(pool), inputResource: R(i), outputResource: R(o), quotedOutput: q, feeBps: '30' });

test('swap, add and remove intents capture and deposit every returned bucket', () => {
  const swap = w.buildSwapIntent({ poolComponent: P('1'), accountAddress: ACCT, inputResource: R('a'), outputResource: R('b'), rawInputAmount: '10', minOutput: '5', maxEpoch: '9', operationId: 'op', quoteEvidence: { quotedOutput: '6', feeBps: '30', slippageBps: '50', effectiveInput: '9' } });
  const call = swap.instructions.find((i) => i.kind === 'call_method');
  assert.equal(call.output.name, 'swap_output');
  assert.deepEqual(swap.instructions.at(-1), { kind: 'deposit_all', accountAddress: ACCT, bucket: { kind: 'workspace_bucket', name: 'swap_output' } });

  const add = w.buildAddLiquidityIntent({ poolComponent: P('1'), accountAddress: ACCT, resourceA: R('a'), resourceB: R('b'), rawAmountA: '10', rawAmountB: '10', maxEpoch: '9', operationId: 'op' });
  assert.equal(add.instructions.at(-1).kind, 'deposit_all');

  const remove = w.buildRemoveLiquidityIntent({ poolComponent: P('1'), accountAddress: ACCT, lpResource: R('l'), rawLpAmount: '10', maxEpoch: '9', operationId: 'op' });
  const deposits = remove.instructions.filter((i) => i.kind === 'deposit_all');
  assert.deepEqual(deposits.map((d) => d.bucket.offset), [0, 1], 'both tuple elements of (Bucket, Bucket) are deposited');
});

test('multi-hop: one transaction, buckets chained on the workspace, min 1 between hops, whole-route min last', () => {
  const intent = w.buildMultiHopSwapIntent({ accountAddress: ACCT, rawInputAmount: '1000000', hops: [hop('1', 'a', 'b', '1490000'), hop('2', 'b', 'c', '880000')], minOutput: '875000', maxEpoch: '99', operationId: 'op', slippageBps: '50' });
  assert.equal(intent.operation, 'multi_hop_swap');
  const kinds = intent.instructions.map((i) => i.kind);
  assert.deepEqual(kinds, ['withdraw_fungible', 'call_method', 'call_method', 'deposit_all']);
  const [, h1, h2, dep] = intent.instructions;
  assert.equal(h1.args[0].name, 'route_0');
  assert.equal(h1.output.name, 'route_1');
  assert.equal(h2.args[0].name, 'route_1', 'hop 2 consumes hop 1 output from the workspace');
  assert.equal(h1.args[2], '1', 'an intermediate hop may never pay zero');
  assert.equal(h2.args[2], '875000', 'the user bound is enforced by the final hop');
  assert.equal(dep.bucket.name, 'route_2');
  assert.equal(intent.route.length, 2);
});

test('multi-hop: disconnected, cyclic, self, repeated-pool, over-long and unreachable-min routes are refused', () => {
  const base = { accountAddress: ACCT, rawInputAmount: '10', minOutput: '1', maxEpoch: '9', operationId: 'op', slippageBps: '50' };
  assert.throws(() => w.buildMultiHopSwapIntent({ ...base, hops: [hop('1', 'a', 'b', '5'), hop('2', 'c', 'd', '5')] }), /continue/);
  assert.throws(() => w.buildMultiHopSwapIntent({ ...base, hops: [hop('1', 'a', 'b', '5'), hop('2', 'b', 'a', '5')] }), /cyclic/);
  assert.throws(() => w.buildMultiHopSwapIntent({ ...base, hops: [hop('1', 'a', 'b', '5'), hop('1', 'b', 'c', '5')] }), /twice/);
  assert.throws(() => w.buildMultiHopSwapIntent({ ...base, hops: [hop('1', 'a', 'b', '5')] }), /2\.\.3/);
  assert.throws(() => w.buildMultiHopSwapIntent({ ...base, hops: [hop('1', 'a', 'b', '5'), hop('2', 'b', 'c', '5'), hop('3', 'c', 'd', '5'), hop('4', 'd', 'e', '5')] }), /2\.\.3/);
  assert.throws(() => w.buildMultiHopSwapIntent({ ...base, minOutput: '6', hops: [hop('1', 'a', 'b', '5'), hop('2', 'b', 'c', '5')] }), /never settle/);
  assert.throws(() => w.buildMultiHopSwapIntent({ ...base, minOutput: '0', hops: [hop('1', 'a', 'b', '5'), hop('2', 'b', 'c', '5')] }), /positive/);
});

test('route wiring: one hop builds an ordinary swap, two hops build the atomic route', () => {
  const builder = w.ammRouteIntentBuilder(ACCT, () => 'op');
  const one = builder.multiHopSwap({ quote: { amountIn: '10', hops: [{ poolComponent: P('1'), inputResource: R('a'), outputResource: R('b'), amountIn: '10', amountOut: '6', feeBps: '30' }] }, minOutput: '5', maxEpoch: '9', slippageBps: '50' });
  assert.equal(one.operation, 'swap');
  const two = builder.multiHopSwap({ quote: { amountIn: '10', hops: [{ poolComponent: P('1'), inputResource: R('a'), outputResource: R('b'), amountIn: '10', amountOut: '6', feeBps: '30' }, { poolComponent: P('2'), inputResource: R('b'), outputResource: R('c'), amountIn: '6', amountOut: '4', feeBps: '30' }] }, minOutput: '3', maxEpoch: '9', slippageBps: '50' });
  assert.equal(two.operation, 'multi_hop_swap');
});

test('create pool: Pool::new, then add_liquidity on the NEW component by workspace reference, then deposit LP', () => {
  const intent = w.buildCreatePoolIntent({ poolTemplateAddress: 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab', accountAddress: ACCT, resourceA: R('a'), resourceB: R('b'), rawAmountA: '4000000', rawAmountB: '9000000', feeBps: 30, maxEpoch: '9', operationId: 'op' });
  assert.deepEqual(intent.instructions.map((i) => i.kind), ['call_function', 'withdraw_fungible', 'withdraw_fungible', 'call_method', 'deposit_all']);
  assert.equal(intent.instructions[0].method, 'new');
  assert.deepEqual(intent.instructions[0].args, [R('a'), R('b'), '30']);
  assert.equal(intent.instructions[3].componentWorkspace.name, 'new_pool');
  assert.equal(intent.instructions[3].componentAddress, undefined);
  assert.deepEqual(w.initialLiquidityPreview('4000000', '9000000'), { totalShares: '6000000', lockedShares: '1000', creatorShares: '5999000' }, 'same numbers as engine test m06');
});

test('create pool: same resource, below-minimum deposits, bad fee and bad template are refused', () => {
  const base = { poolTemplateAddress: 'ab'.repeat(32), accountAddress: ACCT, resourceA: R('a'), resourceB: R('b'), rawAmountA: '1000000', rawAmountB: '1000000', feeBps: 30, maxEpoch: '9', operationId: 'op' };
  assert.throws(() => w.buildCreatePoolIntent({ ...base, resourceB: R('a') }), /distinct/);
  assert.throws(() => w.buildCreatePoolIntent({ ...base, rawAmountA: '999999' }), /MINIMUM_INITIAL_LIQUIDITY/);
  assert.throws(() => w.buildCreatePoolIntent({ ...base, feeBps: 0 }), /feeBps/);
  assert.throws(() => w.buildCreatePoolIntent({ ...base, poolTemplateAddress: 'Pool' }), /template/);
  assert.equal(w.isqrt(10n ** 30n), 10n ** 15n);
});

// ---------------------------------------------------------------------------
// Venue-aware routing: ammRouteIntentBuilder must pick the builder and the name from the
// venue each hop's own pool component reported, and refuse a route it cannot describe.
// ---------------------------------------------------------------------------

const T = (n) => n.repeat(64).slice(0, 64);
const PUBLIC_TEMPLATE = T('1');
const REVEALED_TEMPLATE = T('2');
const classify = (template) => (template === PUBLIC_TEMPLATE ? 'PUBLIC' : template === REVEALED_TEMPLATE ? 'REVEALED' : undefined);
const quoteHop = (pool, i, o) => ({ poolComponent: P(pool), inputResource: R(i), outputResource: R(o), amountIn: '1000000', amountOut: '990000', feeBps: '30' });
const routeQuote = (hops) => ({ inputResource: hops[0].inputResource, outputResource: hops.at(-1).outputResource, amountIn: '1000000', amountOut: '980000', hops });
const buildWith = (classifier, hops, templateAddresses) =>
  w
    .ammRouteIntentBuilder(ACCT, () => 'op', classifier)
    .multiHopSwap({ quote: routeQuote(hops), minOutput: '900000', maxEpoch: '99', slippageBps: '50', templateAddresses });
const build = (hops, templateAddresses) => buildWith(classify, hops, templateAddresses);
/** The historical two-argument call: no classifier at all, not `undefined` for one. */
const buildUnclassified = (hops, templateAddresses) =>
  w
    .ammRouteIntentBuilder(ACCT, () => 'op')
    .multiHopSwap({ quote: routeQuote(hops), minOutput: '900000', maxEpoch: '99', slippageBps: '50', templateAddresses });

test('route builder: a single REVEALED hop builds the revealed-pool swap, a PUBLIC hop the ordinary one', () => {
  const revealed = build([quoteHop('a', 'x', 'y')], [REVEALED_TEMPLATE]);
  assert.equal(revealed.operation, 'revealed_swap');
  const pub = build([quoteHop('a', 'x', 'y')], [PUBLIC_TEMPLATE]);
  assert.equal(pub.operation, 'swap');
  // Same venue-independent instruction shape: both templates expose the same `swap`.
  assert.deepEqual(
    revealed.instructions.map((i) => i.kind),
    pub.instructions.map((i) => i.kind),
  );
});

test('route builder: a route crossing both venues is named mixed and carries each hop venue', () => {
  const mixed = build([quoteHop('a', 'x', 'y'), quoteHop('b', 'y', 'z')], [REVEALED_TEMPLATE, PUBLIC_TEMPLATE]);
  assert.equal(mixed.operation, 'mixed_multi_hop_swap');
  assert.deepEqual(mixed.route.map((h) => h.venue), ['REVEALED', 'PUBLIC']);
  assert.deepEqual(mixed.instructions.map((i) => i.kind), ['withdraw_fungible', 'call_method', 'call_method', 'deposit_all']);
  // Only the INPUT leaves the account; the intermediate stays on the workspace.
  assert.equal(mixed.instructions[0].resourceAddress, R('x'));
  assert.equal(mixed.instructions.filter((i) => i.kind === 'withdraw_fungible').length, 1);

  const allRevealed = build([quoteHop('a', 'x', 'y'), quoteHop('b', 'y', 'z')], [REVEALED_TEMPLATE, REVEALED_TEMPLATE]);
  assert.equal(allRevealed.operation, 'revealed_multi_hop_swap');
  const allPublic = build([quoteHop('a', 'x', 'y'), quoteHop('b', 'y', 'z')], [PUBLIC_TEMPLATE, PUBLIC_TEMPLATE]);
  assert.equal(allPublic.operation, 'multi_hop_swap');
});

test('route builder: a hop whose template is unrecorded or unreported is REFUSED, not assumed public', () => {
  // Assuming "public" would be the less revealing of the two descriptions, so a signer could
  // be shown public-pool wording for a trade that was actually transparent-pool. Refuse.
  assert.throws(() => build([quoteHop('a', 'x', 'y')], [T('9')]), /not a recorded Shadow Swap pool template/);
  assert.throws(() => build([quoteHop('a', 'x', 'y')], [undefined]), /did not report its template/);
  assert.throws(
    () => build([quoteHop('a', 'x', 'y'), quoteHop('b', 'y', 'z')], [REVEALED_TEMPLATE]),
    /2 hops but 1 template addresses/,
  );
});

test('route builder: without a classifier every hop stays unnamed and the public names are kept', () => {
  // The historical call shape. Callers that omit the classifier quote public pools only, and
  // nothing silently becomes a revealed-pool trade.
  const one = buildUnclassified([quoteHop('a', 'x', 'y')], [REVEALED_TEMPLATE]);
  assert.equal(one.operation, 'swap');
  const two = buildUnclassified([quoteHop('a', 'x', 'y'), quoteHop('b', 'y', 'z')], [REVEALED_TEMPLATE, PUBLIC_TEMPLATE]);
  assert.equal(two.operation, 'multi_hop_swap');
  assert.deepEqual(two.route.map((h) => h.venue), [undefined, undefined]);
});
