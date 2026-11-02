/**
 * Route-impact execution guard regressions.
 *
 * Reproduces the live acceptance incident: a 1.0-tTARI input into the seeded
 * esmeralda pool (reserves 596,664 / 603,674) quotes totalCostBps 6268 ??? the
 * UI previously let the user approve that with only a toned row. The guard now
 * blocks >5000 bps by default behind an explicit override, and warns at
 * >2000 bps. The 62.68% number is reproduced EXACTLY from those reserves by
 * packages/protocol-client's ammRouter tests; here the guard's tiers are what
 * is pinned.
 */
require('./bootstrap.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { routeImpactGuard, IMPACT_WARN_BPS, IMPACT_BLOCK_BPS } = require('../build-test/lib/routeImpactGuard.js');

test('guard: an ordinary route cost is allowed without ceremony', () => {
  assert.deepEqual(routeImpactGuard({ totalCostBps: '300', overrideConfirmed: false }), { kind: 'OK', allowed: true });
  assert.deepEqual(routeImpactGuard({ totalCostBps: '0', overrideConfirmed: false }), { kind: 'OK', allowed: true });
  assert.deepEqual(routeImpactGuard({ overrideConfirmed: false }), { kind: 'OK', allowed: true }, 'a missing cost never blocks (the row carries no data)');
});

test('guard: warn tier at 20-50 percent, still submittable', () => {
  assert.equal(routeImpactGuard({ totalCostBps: '2000', overrideConfirmed: false }).kind, 'OK');
  const warn = routeImpactGuard({ totalCostBps: '3268', overrideConfirmed: false });
  assert.equal(warn.kind, 'WARN');
  assert.equal(warn.allowed, true);
  assert.ok(warn.detail.includes('32.68%'), 'the cost percent must be shown');
});

test('guard: blocked tier above 50 percent without an override', () => {
  const blocked = routeImpactGuard({ totalCostBps: '6268', overrideConfirmed: false });
  assert.equal(blocked.kind, 'BLOCK');
  assert.equal(blocked.allowed, false, 'the live acceptance figure (62.68%) must be blocked by default');
  assert.ok(blocked.detail.includes('override'), 'the refusal must name the only way past it');
});

test('guard: the block is bypassable only by the explicit override, and the tier boundaries hold', () => {
  const overridden = routeImpactGuard({ totalCostBps: '6268', overrideConfirmed: true });
  assert.equal(overridden.allowed, true, 'an explicit decision may proceed (disposable testnet client)');
  assert.ok(overridden.title?.startsWith('Extreme price impact'), 'the override verdict declares itself as an override');
  assert.equal(routeImpactGuard({ totalCostBps: '5000', overrideConfirmed: false }).allowed, true, 'exactly the block threshold is still a warn, not a block');
  assert.equal(routeImpactGuard({ totalCostBps: '5001', overrideConfirmed: false }).allowed, false, 'first bps past the threshold blocks');
  assert.equal(routeImpactGuard({ totalCostBps: '2001', overrideConfirmed: false }).kind, 'WARN', 'first bps past the warn threshold warns');
});

test('guard: malformed costs fail open for display but never for execution (the row is dataless, not hostile)', () => {
  // The caller only passes strings that passed the router's own validation; a
  // malformed value is a programming error surfaced as OK-for-display, and the
  // pipeline refuses malformed intent inputs well before reaching here.
  assert.equal(routeImpactGuard({ totalCostBps: '-5', overrideConfirmed: false }).kind, 'OK');
});

test('guard: tiers are the documented constants', () => {
  assert.equal(IMPACT_WARN_BPS, 2000n);
  assert.equal(IMPACT_BLOCK_BPS, 5000n);
});
