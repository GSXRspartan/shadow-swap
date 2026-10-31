/**
 * Public-AMM route finding, integer quote composition and authoritative multi-hop resolution.
 * The engine side (atomic settlement, exact payout parity) is proven in
 * audit_engine_tests/tests/multihop_routes.rs; these tests pin the TypeScript composition.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { enumerateRoutes, quoteRoute, rankRoutes, resolveMultiHopSwap, quoteSwapOutput, MAX_HOPS } = require('../dist/index.js');

const R = (n) => `resource_${String(n).repeat(64).slice(0, 64)}`;
const P = (n) => `component_${String(n).repeat(64).slice(0, 64)}`;
const A = R('a'), B = R('b'), C = R('c'), D = R('d'), E = R('e');
const pool = (id, x, y, rx, ry, fee = '30') => ({ poolComponent: P(id), resourceA: x, resourceB: y, reserveA: String(rx), reserveB: String(ry), feeBps: fee });

const GRAPH = [
  pool('1', A, B, 200_000_000, 300_000_000),
  pool('2', B, C, 250_000_000, 150_000_000),
  pool('3', C, D, 300_000_000, 100_000_000),
  pool('4', A, C, 2_000_000, 2_000_000),
  pool('5', D, E, 50_000_000, 50_000_000),
];

test('router: enumerates every simple path up to the hop limit, never revisiting a pool or resource', () => {
  const routes = enumerateRoutes(GRAPH, A, C);
  const ids = routes.map((r) => r.map((p) => p.poolComponent.slice(10, 11)).join('>')).sort();
  assert.deepEqual(ids, ['1>2', '4']);
  for (const route of enumerateRoutes(GRAPH, A, E, 3)) assert.ok(route.length <= 3);
  const toE = enumerateRoutes(GRAPH, A, E, 3);
  assert.equal(toE.length, 1, 'only A-C-D-E fits in 3 hops; A-B-C-D-E (4 hops) is excluded');
  assert.equal(toE[0].length, 3);
  assert.equal(enumerateRoutes(GRAPH, A, E, 2).length, 0, 'the hop limit is enforced');
  assert.equal(enumerateRoutes(GRAPH, A, D, 3).length, 2, 'A-B-C-D and A-C-D');
  assert.equal(enumerateRoutes(GRAPH, A, A).length, 0, 'no route from a resource to itself');
  assert.equal(MAX_HOPS, 3);
});

test('router: malformed or empty pools are not routable', () => {
  const bad = [pool('6', A, B, 0, 10), pool('7', A, A, 10, 10), { ...pool('8', A, B, 10, 10), reserveA: '1.5' }];
  assert.equal(enumerateRoutes(bad, A, B).length, 0);
});

test('router: a composed quote equals hop-by-hop quoteSwapOutput exactly (integer only)', () => {
  const q = quoteRoute([GRAPH[0], GRAPH[1]], A, '1000000');
  const h1 = quoteSwapOutput('200000000', '300000000', '1000000', '30').output;
  const h2 = quoteSwapOutput('250000000', '150000000', h1, '30').output;
  assert.equal(q.hops[0].amountOut, h1);
  assert.equal(q.amountOut, h2);
  assert.equal(q.kind, 'MULTI_HOP_AMM');
  assert.equal(q.outputResource, C);
  assert.equal(q.feeBpsTotal, '60');
  // mid output: 1e6 * (3e8/2e8) * (1.5e8/2.5e8) = 900_000
  assert.equal(q.midOutput, '900000');
  assert.ok(BigInt(q.totalCostBps) >= 60n, 'route cost includes at least both fees');
});

test('router: routes are ranked by executable output, not hop count (engine m08 scenario)', () => {
  const pools = [pool('4', A, C, 2_000_000, 2_000_000), pool('1', A, B, 500_000_000, 500_000_000), pool('2', B, C, 500_000_000, 500_000_000)];
  const ranked = rankRoutes(pools, A, C, '1000000');
  assert.equal(ranked.routes.length, 2);
  assert.equal(ranked.routes[0].kind, 'MULTI_HOP_AMM', 'the deep two-hop route pays more than the thin direct pool');
  assert.ok(BigInt(ranked.routes[0].amountOut) > BigInt(ranked.routes[1].amountOut));
  // A deep direct pool wins over the same two hops.
  const deep = rankRoutes([pool('4', A, C, 500_000_000, 500_000_000), ...pools.slice(1)], A, C, '1000000');
  assert.equal(deep.routes[0].kind, 'DIRECT_AMM');
});

test('router: an unquotable candidate is reported with its reason, never silently dropped', () => {
  const ranked = rankRoutes([pool('1', A, B, 10, 10)], A, B, '1');
  assert.equal(ranked.routes.length, 0);
  assert.equal(ranked.rejected.length, 1);
  assert.match(ranked.rejected[0].reason, /too small|zero/);
});

function readbackOver(pools) {
  const reads = [];
  return {
    reads,
    async readPool(component) {
      reads.push(component);
      const p = pools.find((x) => x.poolComponent === component);
      if (p === undefined) return { status: 'UNAVAILABLE', reason: 'not found' };
      return { status: 'FOUND', value: { poolComponent: component, resourceA: p.resourceA, resourceB: p.resourceB, reserveA: p.reserveA, reserveB: p.reserveB, feeBps: p.feeBps, lpResource: 'resource_lp', totalLpSupply: '1', lockedLpSupply: '1' }, freshness: {} };
    },
  };
}
const builder = { multiHopSwap: (x) => ({ built: x }) };
const SLIPPAGE = { slippageBps: '50' };

test('resolver: EVERY hop is re-read and the min output derives from the FRESH route quote', async () => {
  const rb = readbackOver(GRAPH);
  const out = await resolveMultiHopSwap({ inputResource: A, outputResource: C, rawInputAmount: '1000000', pools: [P('1'), P('2')], slippage: SLIPPAGE, maxEpoch: '100' }, { readback: rb, builder, currentEpoch: '10' });
  assert.equal(out.status, 'ACTIVE');
  assert.deepEqual(rb.reads, [P('1'), P('2')]);
  assert.equal(out.minOutput, String((BigInt(out.quote.amountOut) * 9950n) / 10000n));
  assert.equal(out.builderIntent.built.minOutput, out.minOutput);
});

test('resolver: reserves that moved against the user since the quote are STALE, not silently re-priced', async () => {
  const shown = quoteRoute([GRAPH[0], GRAPH[1]], A, '1000000').amountOut;
  const moved = [{ ...GRAPH[0], reserveB: '200000000' }, GRAPH[1]];
  const out = await resolveMultiHopSwap({ inputResource: A, outputResource: C, rawInputAmount: '1000000', pools: [P('1'), P('2')], slippage: SLIPPAGE, maxEpoch: '100', expectedOutput: shown }, { readback: readbackOver(moved), builder });
  assert.equal(out.status, 'STALE');
});

test('resolver: wrong destination, broken path, repeated pool, missing pool and expiry are refused', async () => {
  const rb = readbackOver(GRAPH);
  const base = { inputResource: A, rawInputAmount: '1000000', slippage: SLIPPAGE, maxEpoch: '100' };
  assert.equal((await resolveMultiHopSwap({ ...base, outputResource: D, pools: [P('1'), P('2')] }, { readback: rb, builder })).status, 'CONFLICTED');
  assert.equal((await resolveMultiHopSwap({ ...base, outputResource: D, pools: [P('1'), P('3')] }, { readback: rb, builder })).status, 'CONFLICTED');
  assert.equal((await resolveMultiHopSwap({ ...base, outputResource: B, pools: [P('1'), P('1')] }, { readback: rb, builder })).status, 'CONFLICTED');
  assert.equal((await resolveMultiHopSwap({ ...base, outputResource: B, pools: [P('9')] }, { readback: rb, builder })).status, 'UNAVAILABLE');
  assert.equal((await resolveMultiHopSwap({ ...base, outputResource: C, pools: [P('1'), P('2')] }, { readback: rb, builder, currentEpoch: '100' })).status, 'EXPIRED');
  assert.equal((await resolveMultiHopSwap({ ...base, outputResource: E, pools: [P('1'), P('2'), P('3'), P('5')] }, { readback: rb, builder })).status, 'UNAVAILABLE');
});
