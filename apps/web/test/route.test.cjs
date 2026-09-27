/**
 * Multi-hop route presentation: hop chain, partial completion, requote,
 * recovery, and the accepted minimum as a protected floor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('@tari-ootle/protocol-client');
const rp = require('../build-test/lib/routeProgress.js');

const TARI = { kind: 'OOTLE_L2', resourceAddress: 'otl_canonical_tari', label: 'TARI', decimals: '6', isCanonicalTari: true };
const WSTABLE = { kind: 'OOTLE_L2', resourceAddress: 'otl_wstable', label: 'wSTABLE', decimals: '6' };
const XTM = { kind: 'MINOTARI_L1', resourceAddress: 'otl_xtm', label: 'XTM', decimals: '6' };

const NOW = 1_700_000_000_000;
const FEES = {
  l1NetworkFeeRaw: '10',
  l2HtlcNetworkFeeRaw: '5',
  providerSpreadRaw: '100',
  ammLpFeeRaw: '3',
  ammNetworkFeeRaw: '1',
  developerTradingFeeRaw: '0',
  totalRaw: '119',
};

function hop(overrides) {
  return {
    hopId: 'h1',
    index: 0,
    kind: 'FAST_XTM_TARI',
    inputAsset: XTM,
    outputAsset: TARI,
    inputAmountRaw: '1000000',
    expectedOutputRaw: '990000',
    minimumOutputRaw: '980000',
    safety: { requiresSettlementProof: false, requiresAuthoritativeReread: true, hasHardOutputBound: true, reconcileUnknownBeforeRetry: true },
    execution: 'NOT_STARTED',
    settlement: 'UNSETTLED',
    ...overrides,
  };
}

function ammHop(overrides) {
  return hop({
    hopId: 'h2',
    index: 1,
    kind: 'AMM_SWAP',
    inputAsset: TARI,
    outputAsset: WSTABLE,
    inputAmountRaw: '990000',
    expectedOutputRaw: '985000',
    minimumOutputRaw: '975000',
    safety: { requiresSettlementProof: true, requiresAuthoritativeReread: true, hasHardOutputBound: true, reconcileUnknownBeforeRetry: true },
    ...overrides,
  });
}

function makeRecord(overrides) {
  return {
    routeId: 'route-1',
    state: 'ROUTE_QUOTED',
    sourceAsset: XTM,
    destinationAsset: WSTABLE,
    totalExpectedOutputRaw: '985000',
    totalMinimumOutputRaw: '975000',
    quoteExpiresAtUnixMs: NOW + 60_000,
    routeExpiresAtUnixMs: NOW + 300_000,
    hops: [hop({}), ammHop({})],
    acceptance: {
      authorizedSourceAmountRaw: '1000000',
      authorizedSourceAsset: XTM,
      minimumFinalOutputRaw: '960000',
      maxProviderSpreadBps: '100',
      maxNetworkFeesRaw: '0',
      ammSlippageBps: '100',
      expiresAtUnixMs: NOW + 300_000,
      allowedIntermediateAsset: TARI,
      destinationRequiresAcknowledgement: true,
    },
    fees: FEES,
    price: { sourceInputRaw: '1000000', providerQuotedTariRaw: '990000', acceptedMinimumFinalOutputRaw: '960000' },
    recovery: P.DEFAULT_RECOVERY_POLICY,
    intermediateAccount: 'otl_account_1',
    createdAtUnixMs: NOW,
    updatedAtUnixMs: NOW,
    ...overrides,
  };
}

function viewOf(overrides) {
  return P.toRouteView(makeRecord(overrides), { provider: { providerId: 'provider-a', spreadBps: '100' } });
}

test('route: the hop chain is built from the actual hop kinds, XTM → TARI → AMM → wSTABLE', () => {
  const chain = rp.routeChain(viewOf({}));
  const labels = chain.map((node) => node.label);
  assert.deepEqual(labels, ['XTM', 'FAST XTM / TARI', 'TARI', 'AMM', 'wSTABLE']);
  assert.equal(chain[0].kind, 'SOURCE');
  assert.equal(chain[1].kind, 'CROSS_LAYER');
  assert.equal(chain[2].kind, 'INTERMEDIATE');
  assert.equal(chain[3].kind, 'AMM');
  assert.equal(chain[4].kind, 'DESTINATION');
});

test('route: a quoted route is not yet authorised, and says so', () => {
  const view = viewOf({});
  assert.equal(view.state, 'ROUTE_QUOTED');
  assert.equal(view.requiresApproval, true);
  const progress = rp.deriveRouteProgress(view);
  assert.equal(progress.headline, 'Quote ready');
  assert.equal(progress.actionRequired, 'NONE');
  assert.equal(progress.stages[0].status, 'ACTIVE');
  assert.equal(progress.stages[1].status, 'ACTIVE');
  assert.equal(progress.stages[0].label, 'Preparing');
  assert.equal(progress.stages[1].label, 'Awaiting wallet approval');
});

test('route: the preimage is never present on a view the UI can render', () => {
  const view = viewOf({});
  assert.equal(view.containsSecret, false);
  // Inspect the KEYS, not the text: the `containsSecret: false` marker itself
  // contains the substring "secret" and must not be confused with a leak.
  const keys = collectKeys(view);
  for (const forbidden of ['preimage', 'preimageHex', 'walletPreimageHex', 'secret', 'secretHex', 'seed', 'privateKey', 'S']) {
    assert.equal(keys.has(forbidden), false, `RouteView must not carry a "${forbidden}" field`);
  }
  const serialised = JSON.stringify(view);
  assert.equal(/"preimage/i.test(serialised), false);
  assert.equal(/"[a-f0-9]{64}"/i.test(serialised), false, 'no 32-byte hex blob is present');
});

function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      collectKeys(entry, into);
    }
  }
  return into;
}

test('route: a settled cross-layer hop with a paused AMM hop is a partial completion, not a failure', () => {
  const view = viewOf({
    state: 'ROUTE_PAUSED',
    hops: [hop({ execution: 'CONFIRMED', settlement: 'SETTLED', chainTxId: 'l1_tx_1', settledAmountRaw: '990000' }), ammHop({ execution: 'NOT_STARTED' })],
    pause: { reason: 'INTERMEDIATE_SETTLED_REQUOTE_REQUIRED', detail: 'AMM moved', atUnixMs: NOW },
    price: { sourceInputRaw: '1000000', providerQuotedTariRaw: '990000', settledTariRaw: '990000', acceptedMinimumFinalOutputRaw: '960000' },
  });
  const progress = rp.deriveRouteProgress(view);
  assert.equal(progress.partiallyComplete, true);
  assert.equal(progress.actionRequired, 'REQUOTE');
  assert.equal(progress.headline, 'Intermediate asset received — final swap paused');
  assert.match(progress.explanation, /settled/i);
  // The intermediate is stated to remain the user's, never rolled back.
  assert.equal(progress.explanation.includes('rolled back'), false);
  // Hop 1 is DONE; the AMM hop is still PENDING, not FAILED.
  const hop1Stage = progress.stages.find((stage) => stage.id === 'hop-0');
  const hop2Stage = progress.stages.find((stage) => stage.id === 'hop-1');
  assert.equal(hop1Stage.status, 'DONE');
  assert.equal(hop1Stage.chainTxId, 'l1_tx_1');
  assert.equal(hop2Stage.status, 'PENDING');
  assert.equal(progress.stages.some((stage) => stage.status === 'FAILED'), false);
});

test('route: a failed AMM hop pauses rather than failing the whole route', () => {
  const view = viewOf({
    state: 'ROUTE_PAUSED',
    hops: [hop({ execution: 'CONFIRMED', settlement: 'SETTLED' }), ammHop({ execution: 'FAILED', failureReason: 'AMM reverted' })],
    pause: { reason: 'AMM_EXECUTION_FAILED', detail: 'reverted', atUnixMs: NOW },
  });
  const progress = rp.deriveRouteProgress(view);
  assert.equal(progress.actionRequired, 'CONTINUE');
  assert.equal(progress.headline, 'Intermediate asset received — final swap failed');
  assert.match(progress.explanation, /not rolled back/);
  assert.equal(progress.stages.find((stage) => stage.id === 'hop-1').status, 'FAILED');
});

test('route: an unknown outcome is recovery, never a retry offer', () => {
  const view = viewOf({
    state: 'ROUTE_RECOVERY_REQUIRED',
    hops: [hop({ execution: 'CONFIRMED', settlement: 'SETTLED' }), ammHop({ execution: 'UNKNOWN' })],
  });
  const progress = rp.deriveRouteProgress(view);
  assert.equal(progress.actionRequired, 'RECOVER');
  assert.equal(progress.headline, 'Recovery required');
  assert.match(progress.explanation, /will not resubmit/);
  assert.equal(progress.stages.find((stage) => stage.id === 'hop-1').status, 'UNKNOWN');
});

test('route: a fully settled route completes', () => {
  const view = viewOf({
    state: 'ROUTE_SETTLED',
    hops: [hop({ execution: 'CONFIRMED', settlement: 'SETTLED' }), ammHop({ execution: 'CONFIRMED', settlement: 'SETTLED', chainTxId: 'l2_tx_1' })],
  });
  const progress = rp.deriveRouteProgress(view);
  assert.equal(progress.actionRequired, 'NONE');
  assert.equal(progress.headline, 'Route complete');
  assert.equal(progress.partiallyComplete, false);
  assert.equal(progress.stages[progress.stages.length - 1].status, 'DONE');
});

test('route: a deliberately skipped hop keeps the intermediate and offers continuation', () => {
  const view = viewOf({ state: 'HOP2_SKIPPED', hops: [hop({ execution: 'CONFIRMED', settlement: 'SETTLED' }), ammHop({ execution: 'NOT_STARTED' })] });
  const progress = rp.deriveRouteProgress(view);
  assert.equal(progress.actionRequired, 'CONTINUE');
  assert.equal(progress.headline, 'Intermediate asset kept');
  assert.match(progress.explanation, /remains under your control/);
});

test('route: the accepted minimum is surfaced as a protected floor', () => {
  const view = viewOf({});
  const progress = rp.deriveRouteProgress(view);
  assert.equal(progress.acceptedMinimumFinalOutputRaw, '960000');
  assert.equal(progress.minimumProtected, true);
  assert.equal(view.fees.developerTradingFeeRaw, '0');
});

test('requote: a new quote below the accepted minimum demands a fresh acceptance', () => {
  const comparison = rp.compareRequote({
    originalExpectedOutputRaw: '985000',
    originalExpectedOutputLabel: '0.985000',
    newExpectedOutputRaw: '930000',
    newExpectedOutputLabel: '0.930000',
    newMinimumOutputRaw: '900000',
    newMinimumOutputLabel: '0.900000',
    acceptedMinimumFinalOutputRaw: '960000',
    acceptedMinimumLabel: '0.960000',
    pauseReason: 'AMM_MIN_OUTPUT_BELOW_ACCEPTED_MINIMUM',
  });
  assert.equal(comparison.belowAcceptedMinimum, true);
  assert.equal(comparison.canContinueWithoutReacceptance, false);
  assert.equal(comparison.headline, 'New quote cannot meet your minimum');
  assert.match(comparison.detail, /lower a floor you already approved/);
  assert.equal(comparison.userAcceptedMinimumRaw, '960000');
});

test('requote: a new quote that still clears the floor may continue', () => {
  const comparison = rp.compareRequote({
    originalExpectedOutputRaw: '985000',
    newExpectedOutputRaw: '980000',
    newMinimumOutputRaw: '970000',
    acceptedMinimumFinalOutputRaw: '960000',
    pauseReason: 'AMM_QUOTE_EXPIRED',
  });
  assert.equal(comparison.belowAcceptedMinimum, false);
  assert.equal(comparison.canContinueWithoutReacceptance, true);
  assert.equal(comparison.headline, 'New quote available');
  assert.match(comparison.detail, /original expected output/);
});

test('requote: with no new quote, continuation is not offered', () => {
  const comparison = rp.compareRequote({
    originalExpectedOutputRaw: '985000',
    acceptedMinimumFinalOutputRaw: '960000',
    pauseReason: 'AMM_LIQUIDITY_GONE',
  });
  assert.equal(comparison.canContinueWithoutReacceptance, false);
});

test('route: every pause reason has a human explanation', () => {
  const reasons = [
    'INTERMEDIATE_SETTLED_REQUOTE_REQUIRED',
    'AMM_LIQUIDITY_GONE',
    'AMM_MIN_OUTPUT_BELOW_ACCEPTED_MINIMUM',
    'AMM_QUOTE_EXPIRED',
    'AMM_PRICE_OUT_OF_ACCEPTED_BOUNDS',
    'INTERMEDIATE_AMOUNT_MISMATCH',
    'AMM_DUST_INPUT',
    'AMM_EXECUTION_FAILED',
    'WALLET_PROVIDER_UNAVAILABLE',
  ];
  for (const reason of reasons) {
    const explanation = rp.explainPause(reason);
    assert.ok(explanation.length > 20, `${reason} must be explained`);
    assert.equal(explanation.includes(reason), false, 'the raw enum value is never shown to a user');
  }
  // An unknown reason still produces readable copy rather than a blank panel.
  assert.match(rp.explainPause('SOME_FUTURE_REASON'), /paused/);
});

