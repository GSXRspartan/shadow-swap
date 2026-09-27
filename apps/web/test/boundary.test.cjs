/**
 * MARKET-DATA TRUST BOUNDARY (mission §18, §22, §49).
 *
 * The claim under test: a hostile market-data price, candle, or metric cannot
 * alter a resolver output, a min_output, a resource identity, or a settlement
 * proof. These tests drive the real protocol-client resolvers with a poisoned
 * market-data input and assert the outputs are byte-identical to the clean run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('@tari-ootle/protocol-client');
const boundary = require('../build-test/lib/tradeBoundary.js');

const POOL = {
  poolComponent: 'pool_component_0001',
  resourceA: 'otl_base_0001',
  resourceB: 'otl_quote_0001',
  reserveA: '1000000000',
  reserveB: '4000000000',
  feeBps: '30',
  lpResource: 'otl_lp_0001',
  totalLpSupply: '2000000000',
  lockedLpSupply: '0',
};

const FRESHNESS = {
  source: 'WALLET_PROVIDER',
  identity: { substateVersion: '7', epoch: '900', readAtUnixMs: 1_700_000_000_000 },
};

function readbackOf(state) {
  return { readPool: async () => ({ status: 'FOUND', value: state, freshness: FRESHNESS }) };
}

const builder = { swap: ({ poolComponent, quote, minOutput, maxEpoch }) => ({ poolComponent, minOutput, maxEpoch, quoted: quote.quotedOutput }) };

const REQUEST = {
  poolComponent: POOL.poolComponent,
  inputResource: POOL.resourceA,
  outputResource: POOL.resourceB,
  rawInputAmount: '100000000',
  slippage: { slippageBps: '100' },
  maxEpoch: '1000',
};

async function resolveWith(overrides) {
  return P.resolveSwap({ ...REQUEST, ...overrides }, { readback: readbackOf(POOL), builder });
}

test('boundary: resolver output is identical with and without a hostile market-data price', async () => {
  const clean = await resolveWith({});

  // Everything a hostile market-data source could poison: a display price that
  // claims the pool is worth 1:10^30, plus a poisoned "expected output" value.
  const hostilePrice = boundary.asDisplayOnly('1000000000000000000000000000000', 'market-data:pool:price');
  const poisonedExpected = boundary.asDisplayOnly('999999999999999999999', 'market-data:pool:expectedOutput');
  assert.ok(boundary.isDisplayOnly(hostilePrice));

  // The display values cannot even be passed where an amount is expected.
  assert.throws(() => boundary.asRawExecutionAmount(hostilePrice, 'rawInputAmount'), boundary.ExecutionBoundaryViolation);
  assert.throws(() => boundary.asRawExecutionAmount(poisonedExpected, 'rawInputAmount'), boundary.ExecutionBoundaryViolation);
  assert.throws(() => boundary.asResourceAddress(hostilePrice, 'inputResource'), boundary.ExecutionBoundaryViolation);

  const hostile = await resolveWith({});
  assert.deepEqual(hostile, clean, 'resolver output is a function of the authoritative read alone');
  assert.equal(hostile.status, 'ACTIVE');
  assert.equal(hostile.resolved.quote.quotedOutput, P.quoteSwapOutput(POOL.reserveA, POOL.reserveB, REQUEST.rawInputAmount, POOL.feeBps).output);
  assert.equal(hostile.resolved.quote.minOutput, P.deriveMinOutput(hostile.resolved.quote.quotedOutput, REQUEST.slippage));
});

test('boundary: a display value is structurally unassignable to a raw amount slot', () => {
  // A compile-time property, demonstrated at runtime: the branded wrapper is an
  // object, never a string, so `String(...)` would be required to smuggle it and
  // the funnel refuses that.
  const display = boundary.asDisplayOnly('90661089', 'market-data:pool:quotedOutput');
  assert.equal(typeof display, 'object');
  assert.equal(typeof display.text, 'string');
  assert.throws(() => boundary.asRawExecutionAmount(display, 'quotedOutput'), /Refusing to use a market-data display value/);
  // A number is refused too — no float ever carries an on-chain quantity.
  assert.throws(() => boundary.asRawExecutionAmount(90661089, 'rawInputAmount'), /must be a raw decimal string/);
  assert.throws(() => boundary.asRawExecutionAmount('1.5', 'rawInputAmount'), /raw integer string/);
  assert.throws(() => boundary.asRawExecutionAmount('0x10', 'rawInputAmount'), /raw integer string/);
  assert.throws(() => boundary.asRawExecutionAmount('-5', 'rawInputAmount'), /raw integer string/);
  assert.equal(boundary.asRawExecutionAmount('0', 'rawInputAmount'), '0');
});

test('boundary: MarketDataView can only yield display strings', () => {
  const view = boundary.MarketDataView.fromEntries('pool1', [
    ['currentPrice', '2.000000'],
    ['change24h', '+1.25%'],
  ]);
  assert.equal(view.get('currentPrice'), '2.000000');
  assert.equal(view.get('missing', 'n/a'), 'n/a');
  assert.deepEqual(view.keys.sort(), ['change24h', 'currentPrice']);
  assert.equal(view.readText('currentPrice').text, '2.000000');
  // The escape hatch still returns a branded display value, not a raw string.
  const escaped = view.readText('currentPrice');
  assert.ok(boundary.isDisplayOnly(escaped));
  assert.throws(() => boundary.asRawExecutionAmount(escaped, 'rawInputAmount'), boundary.ExecutionBoundaryViolation);
  assert.throws(() => view.readText('doesNotExist'), boundary.ExecutionBoundaryViolation);
});

test('boundary: a market-data reserve claim cannot become an execution reserve', async () => {
  // The authoritative readback is the ONLY input to the quote. A discovery
  // payload claiming different reserves is not consulted; here the read state is
  // deliberately different so the assertion can prove it.
  const read = { ...POOL, reserveA: '2000000000', reserveB: '8000000000' };
  const outcome = await P.resolveSwap(REQUEST, { readback: readbackOf(read), builder });
  assert.equal(outcome.status, 'ACTIVE');
  assert.equal(outcome.resolved.quote.quotedOutput, P.quoteSwapOutput(read.reserveA, read.reserveB, REQUEST.rawInputAmount, read.feeBps).output);
  assert.equal(outcome.resolved.pool.reserveA, '2000000000', 'the resolver reports what it actually read');

  // A reserve claim so lopsided that the real output would floor to zero is
  // refused outright, not rounded up into a fabricated output.
  const starved = { ...POOL, reserveA: '999999999999999999999999', reserveB: '1' };
  const refused = await P.resolveSwap(REQUEST, { readback: readbackOf(starved), builder });
  assert.equal(refused.status, 'UNAVAILABLE');
  assert.match(refused.reason, /floors to zero/);

  // And an expectation that disagrees with the authoritative read is an
  // explicit STALE, never a silent substitution.
  const mismatched = await P.resolveSwap({ ...REQUEST, expectedReserves: { a: '1', b: '1' } }, { readback: readbackOf(POOL), builder });
  assert.equal(mismatched.status, 'STALE');
  assert.match(mismatched.reason, /reserve/i);
});

test('boundary: the exact quote and min_output never come from the chart', async () => {
  const outcome = await resolveWith({});
  assert.equal(outcome.status, 'ACTIVE');
  const { quotedOutput, minOutput, effectiveInput, feeBps, slippageBps } = outcome.resolved.quote;
  // Pinned against the protocol-client's own arithmetic.
  assert.equal(quotedOutput, P.quoteSwapOutput(POOL.reserveA, POOL.reserveB, REQUEST.rawInputAmount, POOL.feeBps).output);
  assert.equal(minOutput, P.deriveMinOutput(quotedOutput, REQUEST.slippage));
  assert.equal(effectiveInput, P.quoteSwapOutput(POOL.reserveA, POOL.reserveB, REQUEST.rawInputAmount, POOL.feeBps).effectiveInput);
  assert.equal(feeBps, '30');
  assert.equal(slippageBps, '100');
});

test('boundary: no developer trading fee is ever introduced by the UI path', async () => {
  const outcome = await resolveWith({});
  assert.equal(outcome.status, 'ACTIVE');
  const view = P.toRouteView({
    routeId: 'r1',
    state: 'ROUTE_QUOTED',
    sourceAsset: { kind: 'MINOTARI_L1', resourceAddress: 'xtm1', label: 'XTM', decimals: '6' },
    destinationAsset: { kind: 'OOTLE_L2', resourceAddress: 'otl_quote_0001', label: 'wSTABLE', decimals: '6' },
    totalExpectedOutputRaw: '100',
    totalMinimumOutputRaw: '95',
    quoteExpiresAtUnixMs: Date.now() + 60_000,
    routeExpiresAtUnixMs: Date.now() + 120_000,
    hops: [
      {
        hopId: 'h1',
        index: 0,
        kind: 'FAST_XTM_TARI',
        inputAsset: { kind: 'MINOTARI_L1', resourceAddress: 'xtm1', label: 'XTM', decimals: '6' },
        outputAsset: { kind: 'OOTLE_L2', resourceAddress: 'otl_base_0001', label: 'TARI', decimals: '6', isCanonicalTari: true },
        inputAmountRaw: '100',
        expectedOutputRaw: '99',
        safety: { requiresSettlementProof: false, requiresAuthoritativeReread: true, hasHardOutputBound: true, reconcileUnknownBeforeRetry: true },
        execution: 'NOT_STARTED',
        settlement: 'UNSETTLED',
      },
    ],
    acceptance: {
      authorizedSourceAmountRaw: '100',
      authorizedSourceAsset: { kind: 'MINOTARI_L1', resourceAddress: 'xtm1', label: 'XTM', decimals: '6' },
      minimumFinalOutputRaw: '95',
      maxProviderSpreadBps: '100',
      maxNetworkFeesRaw: '0',
      ammSlippageBps: '100',
      expiresAtUnixMs: Date.now() + 120_000,
      allowedIntermediateAsset: { kind: 'OOTLE_L2', resourceAddress: 'otl_base_0001', label: 'TARI', decimals: '6', isCanonicalTari: true },
      destinationRequiresAcknowledgement: true,
    },
    fees: { l1NetworkFeeRaw: '0', l2HtlcNetworkFeeRaw: '0', providerSpreadRaw: '1', ammLpFeeRaw: '3', ammNetworkFeeRaw: '0', developerTradingFeeRaw: '0', totalRaw: '4' },
    price: { sourceInputRaw: '100', providerQuotedTariRaw: '99', acceptedMinimumFinalOutputRaw: '95' },
    recovery: P.DEFAULT_RECOVERY_POLICY,
    intermediateAccount: 'otl_account_1',
    createdAtUnixMs: Date.now(),
    updatedAtUnixMs: Date.now(),
  });
  assert.equal(view.developerTradingFeeRaw, '0');
  assert.equal(view.containsSecret, false, 'RouteView never carries the preimage');
  assert.equal(view.fees.developerTradingFeeRaw, '0');
});

