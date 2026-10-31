require('./bootstrap.cjs');
/**
 * The unified pair resolver: a mechanism is EXECUTABLE only when this build constructs its
 * transaction; every other mechanism carries its exact blocker. Types are never coerced.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePairRoutes, bestAmmQuote, CANONICAL_TARI } = require('../build-test/lib/routeResolver.js');

const R = (n) => `resource_${n.repeat(64).slice(0, 64)}`;
const P = (n) => `component_${n.repeat(64).slice(0, 64)}`;
const pool = (id, x, y, rx, ry) => ({ poolComponent: P(id), resourceA: x, resourceB: y, reserveA: String(rx), reserveB: String(ry), feeBps: '30' });
const A = R('a'), B = R('b'), C = R('c');
const POOLS = [pool('1', A, B, 500_000_000, 500_000_000), pool('2', B, C, 500_000_000, 500_000_000), pool('3', A, C, 2_000_000, 2_000_000)];
const byMech = (opts) => Object.fromEntries(opts.map((o) => [o.mechanism, o]));

test('public fungible pair: direct and multi-hop AMM are executable and compared by output', () => {
  const opts = byMech(resolvePairRoutes({ input: { resource: A, kind: 'fungible' }, output: { resource: C, kind: 'fungible' }, amountIn: '1000000', pools: POOLS, poolTemplateRecorded: true }));
  assert.equal(opts.AMM.availability, 'EXECUTABLE');
  assert.equal(opts.MULTI_HOP_AMM.availability, 'EXECUTABLE');
  const best = bestAmmQuote(Object.values(opts));
  assert.equal(best.kind, 'MULTI_HOP_AMM', 'the deep two-hop route out-pays the thin direct pool');
  assert.equal(opts.P2P_OFFER, undefined, 'no private lane is offered for two public fungibles');
});

test('native tTARI is AMM-eligible by exact address and names the Sapient stealth-withdraw requirement', () => {
  const opts = byMech(resolvePairRoutes({ input: { resource: CANONICAL_TARI, kind: 'stealth' }, output: { resource: A, kind: 'fungible' }, amountIn: '1000', pools: [pool('9', CANONICAL_TARI, A, 1e9, 1e9)], poolTemplateRecorded: true }));
  assert.equal(opts.AMM.availability, 'EXECUTABLE');
  assert.ok(opts.AMM.requiredCapabilities.some((c) => /withdrawStealthAndExecute/.test(c)));
  assert.equal(opts.P2P_OFFER, undefined);
});

test('created-Stealth and confidential never reach the AMM; the P2P lane is reported, not offered', () => {
  for (const kind of ['stealth', 'confidential']) {
    const opts = byMech(resolvePairRoutes({ input: { resource: R('s'), kind }, output: { resource: A, kind: 'fungible' }, amountIn: '1000', pools: POOLS, poolTemplateRecorded: true }));
    assert.equal(opts.AMM, undefined, `${kind} is not coerced into a pool`);
    assert.equal(opts.P2P_OFFER.availability, 'ENGINE_VERIFIED_NOT_ENABLED');
    assert.match(opts.P2P_OFFER.reason, /p2p_offer_routes\.rs/);
    assert.match(opts.P2P_OFFER.privacy, /REVEALED/);
  }
  const conf = byMech(resolvePairRoutes({ input: { resource: R('s'), kind: 'confidential' }, output: { resource: A, kind: 'fungible' }, pools: [], poolTemplateRecorded: true }));
  assert.match(conf.P2P_OFFER.reason, /blinded commitments/);
});

test('NFT routes: marketplace for NFT -> fungible, barter reported for NFT <-> NFT', () => {
  const sell = byMech(resolvePairRoutes({ input: { resource: R('n'), kind: 'non_fungible' }, output: { resource: A, kind: 'fungible' }, pools: [], poolTemplateRecorded: true }));
  assert.equal(sell.NFT_MARKETPLACE.availability, 'EXECUTABLE');
  const barter = byMech(resolvePairRoutes({ input: { resource: R('n'), kind: 'non_fungible' }, output: { resource: R('m'), kind: 'non_fungible' }, pools: [], poolTemplateRecorded: true }));
  assert.equal(barter.NFT_BARTER.availability, 'ENGINE_VERIFIED_NOT_ENABLED');
});

test('no recorded Pool template, no amount, no pool and unknown assets all carry an exact reason', () => {
  const none = byMech(resolvePairRoutes({ input: { resource: A, kind: 'fungible' }, output: { resource: C, kind: 'fungible' }, amountIn: '10', pools: POOLS, poolTemplateRecorded: false }));
  assert.equal(none.AMM.availability, 'BLOCKED');
  assert.match(none.AMM.reason, /No Shadow Swap Pool template is recorded/);
  const noAmount = byMech(resolvePairRoutes({ input: { resource: A, kind: 'fungible' }, output: { resource: C, kind: 'fungible' }, pools: POOLS, poolTemplateRecorded: true }));
  assert.match(noAmount.AMM.reason, /Enter an amount/);
  const isolated = byMech(resolvePairRoutes({ input: { resource: A, kind: 'fungible' }, output: { resource: R('z'), kind: 'fungible' }, amountIn: '10', pools: POOLS, poolTemplateRecorded: true }));
  assert.equal(isolated.AMM.availability, 'NO_LIQUIDITY');
  assert.equal(isolated.MULTI_HOP_AMM.availability, 'NO_LIQUIDITY');
  const unknown = byMech(resolvePairRoutes({ input: { resource: A, kind: 'unknown' }, output: { resource: C, kind: 'fungible' }, pools: [], poolTemplateRecorded: true }));
  assert.equal(unknown.CROSS_LAYER.availability, 'BLOCKED');
  assert.deepEqual(resolvePairRoutes({ input: { resource: A, kind: 'fungible' }, output: { resource: A, kind: 'fungible' }, pools: POOLS, poolTemplateRecorded: true }), []);
});
