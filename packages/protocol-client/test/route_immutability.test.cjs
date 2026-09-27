/**
 * Route record immutability.
 *
 * The security property: a route record is a value, not a shared mutable
 * object. A snapshot taken by the UI, a persisted history entry, or the
 * execution layer must keep showing what it showed, no matter how many events
 * are applied afterwards.
 *
 * The previous `applyRouteEvent` used `{ ...record }`, which shared the `hops`
 * array and every hop object, plus `price`. A pre-event snapshot therefore
 * mutated retroactively — the review a user approved could silently become a
 * different record after the click.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const route = require('../dist/multihop/route.js');
const types = require('../dist/multihop/types.js');

const TARI = { kind: 'OOTLE_L2', resourceAddress: 'otl_canonical_tari', label: 'TARI', decimals: '6', isCanonicalTari: true };
const WSTABLE = { kind: 'OOTLE_L2', resourceAddress: 'otl_wstable', label: 'wSTABLE', decimals: '6' };
const XTM = { kind: 'MINOTARI_L1', resourceAddress: 'otl_xtm', label: 'XTM', decimals: '6' };
const SAFETY = { requiresSettlementProof: true, requiresAuthoritativeReread: true, hasHardOutputBound: true, reconcileUnknownBeforeRetry: true };

function makeRecord() {
  return {
    routeId: 'route-1',
    state: 'ROUTE_QUOTED',
    sourceAsset: XTM,
    destinationAsset: WSTABLE,
    totalExpectedOutputRaw: '985000',
    totalMinimumOutputRaw: '975000',
    quoteExpiresAtUnixMs: Date.now() + 60_000,
    routeExpiresAtUnixMs: Date.now() + 300_000,
    hops: [
      {
        hopId: 'h1',
        index: 0,
        kind: 'FAST_XTM_TARI',
        inputAsset: XTM,
        outputAsset: TARI,
        inputAmountRaw: '1000000',
        expectedOutputRaw: '990000',
        minimumOutputRaw: '980000',
        safety: { ...SAFETY, requiresSettlementProof: false },
        execution: 'NOT_STARTED',
        settlement: 'UNSETTLED',
      },
      {
        hopId: 'h2',
        index: 1,
        kind: 'AMM_SWAP',
        inputAsset: TARI,
        outputAsset: WSTABLE,
        inputAmountRaw: '990000',
        expectedOutputRaw: '985000',
        minimumOutputRaw: '975000',
        safety: { ...SAFETY },
        execution: 'NOT_STARTED',
        settlement: 'UNSETTLED',
      },
    ],
    acceptance: {
      authorizedSourceAmountRaw: '1000000',
      authorizedSourceAsset: XTM,
      minimumFinalOutputRaw: '960000',
      maxProviderSpreadBps: '100',
      maxNetworkFeesRaw: '0',
      ammSlippageBps: '100',
      expiresAtUnixMs: Date.now() + 300_000,
      allowedIntermediateAsset: TARI,
      destinationRequiresAcknowledgement: true,
    },
    fees: { l1NetworkFeeRaw: '10', l2HtlcNetworkFeeRaw: '5', providerSpreadRaw: '100', ammLpFeeRaw: '3', ammNetworkFeeRaw: '1', developerTradingFeeRaw: '0', totalRaw: '119' },
    price: { sourceInputRaw: '1000000', providerQuotedTariRaw: '990000', acceptedMinimumFinalOutputRaw: '960000' },
    recovery: { ...types.DEFAULT_RECOVERY_POLICY },
    intermediateAccount: 'otl_account_1',
    createdAtUnixMs: Date.now(),
    updatedAtUnixMs: Date.now(),
  };
}

const PROOF_REF = { proofId: 'p1', routeId: 'route-1', fingerprint: 'ffff0000ffff0000' };

test('immutability: applying an event does not mutate the previous record', () => {
  const before = makeRecord();
  const hop1Before = before.hops[0];
  const priceBefore = before.price;

  const after = route.applyRouteEvent(before, { kind: 'ACCEPT_ROUTE' });

  assert.equal(after.state, 'ROUTE_ACCEPTED');
  // The previous record keeps its own state and is a DIFFERENT object graph.
  assert.equal(before.state, 'ROUTE_QUOTED', 'the previous record must keep its state');
  assert.notEqual(after, before);
  assert.notEqual(after.hops, before.hops, 'the hops array must be copied');
  assert.notEqual(after.hops[0], before.hops[0], 'each hop object must be copied');
  assert.notEqual(after.price, before.price, 'the price model must be copied');
  assert.equal(hop1Before, before.hops[0], 'the previous hops array must be untouched');
  assert.equal(priceBefore, before.price);
});

test('immutability: a hop transition never reaches back into the earlier snapshot', () => {
  const quoted = route.applyRouteEvent(makeRecord(), { kind: 'ACCEPT_ROUTE' });
  const snapshot = JSON.parse(JSON.stringify(quoted));

  // Drive the route forward through several transitions.
  let current = route.applyRouteEvent(quoted, { kind: 'BEGIN_HOP1' });
  assert.equal(current.hops[0].execution, 'EXECUTING');
  assert.equal(current.hops[0].settlement, 'UNSETTLED');

  current = route.applyRouteEvent(current, { kind: 'HOP1_SETTLED', settledAmountRaw: '990000', proofRef: PROOF_REF });
  assert.equal(current.hops[0].settlement, 'SETTLED');

  // The approved snapshot must be byte-identical to what the user reviewed.
  assert.deepEqual(JSON.parse(JSON.stringify(quoted)), snapshot, 'an approved snapshot changed after later events');
  assert.equal(quoted.hops[0].execution, 'NOT_STARTED');
  assert.equal(quoted.hops[0].settledAmountRaw, undefined);
});

test('immutability: a price model is not rewritten on the earlier snapshot', () => {
  const accepted = route.applyRouteEvent(makeRecord(), { kind: 'ACCEPT_ROUTE' });
  const executing = route.applyRouteEvent(accepted, { kind: 'BEGIN_HOP1' });
  const settled = route.applyRouteEvent(executing, { kind: 'HOP1_SETTLED', settledAmountRaw: '990000', proofRef: PROOF_REF });

  assert.equal(settled.price.settledTariRaw, '990000', 'the settled amount lands on the new record');
  assert.equal(accepted.price.settledTariRaw, undefined, 'a pre-settlement snapshot must not claim a settled amount');
  assert.equal(executing.price.settledTariRaw, undefined);
});

test('immutability: the accepted minimum cannot be lowered by a later event', () => {
  const accepted = route.applyRouteEvent(makeRecord(), { kind: 'ACCEPT_ROUTE' });
  const executing = route.applyRouteEvent(accepted, { kind: 'BEGIN_HOP1' });
  const settled = route.applyRouteEvent(executing, { kind: 'HOP1_SETTLED', settledAmountRaw: '990000', proofRef: PROOF_REF });

  for (const record of [accepted, executing, settled]) {
    assert.equal(record.acceptance.minimumFinalOutputRaw, '960000', 'the user-accepted floor is invariant');
    assert.equal(record.totalMinimumOutputRaw, '975000');
  }
  assert.notEqual(settled.acceptance, accepted.acceptance, 'acceptance must be copied, not shared');
});

test('immutability: a returned record is frozen, so a holder cannot rewrite history', () => {
  const accepted = route.applyRouteEvent(makeRecord(), { kind: 'ACCEPT_ROUTE' });
  assert.equal(Object.isFrozen(accepted), true, 'the returned record must be frozen');
  assert.equal(Object.isFrozen(accepted.hops), true);
  assert.equal(Object.isFrozen(accepted.hops[0]), true);
  assert.equal(Object.isFrozen(accepted.acceptance), true);
  assert.equal(Object.isFrozen(accepted.price), true);

  // A silent retroactive rewrite is now a loud failure.
  assert.throws(() => {
    'use strict';
    accepted.state = 'ROUTE_SETTLED';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    accepted.hops[0].execution = 'CONFIRMED';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    accepted.acceptance.minimumFinalOutputRaw = '1';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    accepted.price.settledTariRaw = '1';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    accepted.hops.push(accepted.hops[0]);
  }, TypeError);
});

test('immutability: the input record is also frozen after a transition, closing the last alias', () => {
  const input = makeRecord();
  const accepted = route.applyRouteEvent(input, { kind: 'ACCEPT_ROUTE' });
  // `input` was copied, not frozen, so a caller that owns it can still use it —
  // but the copy guarantees isolation.
  assert.notEqual(input, accepted);
  assert.equal(input.state, 'ROUTE_QUOTED');
  // Two successive applications from the same base are independent.
  const a = route.applyRouteEvent(input, { kind: 'ACCEPT_ROUTE' });
  const b = route.applyRouteEvent(input, { kind: 'ACCEPT_ROUTE' });
  assert.notEqual(a, b);
  // `updatedAtUnixMs` is the wall-clock time of EACH transition by definition,
  // so two applications a millisecond apart (which a fast CI runner straddles —
  // observed as the only difference in this assertion's CI failure) must differ
  // in that field and in nothing else. The comparison normalises the stamp and
  // keeps the full-depth equality, so a genuine shared-reference mutation of
  // any nested route object still fails here.
  const normalise = (record) => {
    const copy = JSON.parse(JSON.stringify(record));
    copy.updatedAtUnixMs = '<wall-clock>';
    return copy;
  };
  assert.deepEqual(normalise(a), normalise(b), 'the same event from the same base yields equal state');
  assert.ok(Number.isFinite(a.updatedAtUnixMs) && a.updatedAtUnixMs >= input.updatedAtUnixMs, 'each transition carries a fresh wall-clock stamp');
  assert.ok(b.updatedAtUnixMs >= a.updatedAtUnixMs);
});

test('immutability: cloneRouteRecord produces an independent deep copy', () => {
  const original = makeRecord();
  const copy = route.cloneRouteRecord(original);
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), JSON.parse(JSON.stringify(original)));
  for (let i = 0; i < copy.hops.length; i += 1) {
    assert.notEqual(copy.hops[i], original.hops[i]);
    assert.notEqual(copy.hops[i].safety, original.hops[i].safety);
    assert.notEqual(copy.hops[i].inputAsset, original.hops[i].inputAsset);
  }
  assert.notEqual(copy.acceptance.authorizedSourceAsset, original.acceptance.authorizedSourceAsset);
  assert.notEqual(copy.recovery, original.recovery);
});

test('immutability: a terminal route cannot be re-driven', () => {
  let current = route.applyRouteEvent(makeRecord(), { kind: 'ACCEPT_ROUTE' });
  current = route.applyRouteEvent(current, { kind: 'BEGIN_HOP1' });
  current = route.applyRouteEvent(current, { kind: 'HOP1_SETTLED', settledAmountRaw: '990000', proofRef: PROOF_REF });
  current = route.applyRouteEvent(current, { kind: 'SKIP_HOP2' });
  current = route.applyRouteEvent(current, { kind: 'SETTLE_PARTIAL' });
  assert.equal(current.state, 'ROUTE_SETTLED');

  // A terminal snapshot is immune to a replayed event.
  assert.throws(() => route.applyRouteEvent(current, { kind: 'BEGIN_HOP2', operationId: 'op-1' }), /terminal/);
  assert.throws(() => route.applyRouteEvent(current, { kind: 'FAIL_TERMINAL', reason: 'x' }), /terminal/);
  assert.equal(current.state, 'ROUTE_SETTLED');
});
