/**
 * Chart data conversion, interval support, incremental updates, and chart states.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const chartData = require('../build-test/lib/chartData.js');

/** A consensus-timestamp candle, i.e. one with an honest time axis. */
function timeCandle(bucketStart, closeRaw, tradeCount = 1) {
  // A realistic PriceRational: raw quote numerator over raw base denominator,
  // both scaled by their own 6 decimals. closeRaw is therefore the price in
  // whole quote units (2000000 raw = 2.000000).
  const rational = (raw) => ({ numerator: raw, denominator: '1000000', baseDecimals: '6', quoteDecimals: '6' });
  return {
    poolComponent: 'pool1',
    baseResource: 'otl_base',
    quoteResource: 'otl_quote',
    interval: '1h',
    bucketStart,
    bucketEnd: String(Number(bucketStart) + 3_600_000),
    open: rational(closeRaw),
    high: rational(String(Number(closeRaw) * 2)),
    low: rational(String(Math.max(1, Math.floor(Number(closeRaw) / 2)))),
    close: rational(closeRaw),
    baseVolumeRaw: '1000',
    quoteVolumeRaw: '2000',
    tradeCount,
    firstTradeId: 't1',
    lastTradeId: 't1',
    partial: true,
    bucketKind: 'TIME',
  };
}

/** An epoch-bucketed candle: no trustworthy wall clock. */
function epochCandle(bucketStart) {
  return { ...timeCandle(bucketStart, '100', 2), bucketKind: 'EPOCH', bucketStart, bucketEnd: String(Number(bucketStart) + 1) };
}

test('chart: display conversion happens only through the protocol boundary', () => {
  const converted = chartData.toChartCandles([timeCandle('1700000000000', '2000000')]);
  assert.equal(converted.length, 1);
  // Bucket key is Unix ms; lightweight-charts wants seconds.
  assert.equal(converted[0].time, 1700000000);
  assert.equal(converted[0].close, 2);
  assert.equal(converted[0].baseVolumeRaw, '1000');
  assert.equal(converted[0].partial, true);
});

test('chart: a sub-unit price survives the display boundary exactly', () => {
  // `toDisplayPrice` is the sanctioned display conversion and the frontend must
  // not second-guess it. 25 raw quote units over 1 raw base unit at 6 decimals
  // is 0.000025 — the boundary must not round it up to a different magnitude.
  const converted = chartData.toChartCandles([timeCandle('1700000000000', '25')]);
  assert.equal(converted[0].close, 0.000025);
  // The exact rational is untouched everywhere else in the pipeline.
  const exact = require('@tari-ootle/protocol-client');
  const tiny = { numerator: '25', denominator: '1000000', baseDecimals: '6', quoteDecimals: '6' };
  const one = { numerator: '1000000', denominator: '1000000', baseDecimals: '6', quoteDecimals: '6' };
  assert.equal(exact.comparePrices(tiny, one), -1, 'exact comparison is unaffected by display rounding');
  assert.equal(exact.toDisplayPrice(one, 12).value, '1');
});

test('chart: an epoch-bucketed series is refused rather than drawn on a fake axis', () => {
  const basis = chartData.chartTimeBasis([epochCandle('100'), epochCandle('101')]);
  assert.equal(basis.kind, 'EPOCH_ONLY');
  assert.match(basis.reason, /invented/i);
  assert.throws(() => chartData.toChartCandles([epochCandle('100')]), chartData.ChartBasisError);
  assert.throws(() => chartData.toChartCandles([]), chartData.ChartBasisError);
});

test('chart: mixed time bases are not given a single axis', () => {
  const basis = chartData.chartTimeBasis([timeCandle('1700000000000', '1'), epochCandle('5')]);
  assert.notEqual(basis.kind, 'WALL_CLOCK');
  assert.throws(() => chartData.toChartCandles([timeCandle('1700000000000', '1'), epochCandle('5')]));
});

test('chart: empty series reports NONE, not an error', () => {
  assert.equal(chartData.chartTimeBasis([]).kind, 'NONE');
});

test('chart: interval support is delegated and sub-epoch precision is refused', () => {
  const noCadence = chartData.checkIntervalSupport('1m', { timeSource: 'EPOCH_BOUNDARY' });
  assert.equal(noCadence.supported, false);
  assert.match(noCadence.reason, /cannot support/);

  // A one-hour epoch cadence cannot honestly back a 1-minute candle.
  const coarse = chartData.checkIntervalSupport('1m', { timeSource: 'EPOCH_BOUNDARY', epochDurationMs: '3600000' });
  assert.equal(coarse.supported, false);
  assert.match(coarse.reason, /coarser/);

  const ok = chartData.checkIntervalSupport('1h', { timeSource: 'EPOCH_BOUNDARY', epochDurationMs: '3600000' });
  assert.equal(ok.supported, true);
  assert.equal(ok.basis, 'EPOCH_BOUNDARY');

  const consensus = chartData.checkIntervalSupport('1m', { timeSource: 'CONSENSUS_TIMESTAMP' });
  assert.equal(consensus.supported, true);
  assert.equal(consensus.basis, 'CONSENSUS_TIMESTAMP');

  // Local observation time is not a consensus clock.
  const local = chartData.checkIntervalSupport('1d', { timeSource: 'LOCAL_RECEIPT' });
  assert.equal(local.supported, false);
  assert.match(local.reason, /fabricated/);
});

test('chart: every interval is reported so the UI can disable the unsupported ones', () => {
  const all = chartData.supportedIntervals({ timeSource: 'CONSENSUS_TIMESTAMP' });
  assert.equal(all.length, 6);
  assert.deepEqual(all.map((entry) => entry.interval), ['1m', '5m', '15m', '1h', '4h', '1d']);
  assert.ok(all.every((entry) => entry.supported));
});

test('chart: a live trade replaces the open bucket, never the whole series', () => {
  // Display values stay at or above 1 so the assertion is about the merge
  // semantics rather than about `toDisplayPrice`'s sub-unit rounding.
  const history = chartData.toChartCandles([timeCandle('1700000000000', '10000000'), timeCandle('1700003600000', '20000000')]);
  const replacement = chartData.toChartCandles([timeCandle('1700003600000', '25000000', 3)])[0];

  const appended = chartData.applyTailUpdate(history, replacement);
  assert.equal(appended.length, 2, 'the open bucket is replaced in place');
  assert.equal(appended[1].close, 25);
  assert.equal(appended[1].tradeCount, 3);
  // The earlier candle is untouched.
  assert.equal(appended[0].close, 10);

  // Applying the same replacement again is idempotent (duplicate update).
  const again = chartData.applyTailUpdate(appended, replacement);
  assert.equal(again.length, 2);
  assert.equal(again[1].close, 25);

  // A brand new bucket appends.
  const newBucket = chartData.toChartCandles([timeCandle('1700007200000', '30000000')])[0];
  const grown = chartData.applyTailUpdate(again, newBucket);
  assert.equal(grown.length, 3);
  assert.equal(grown[2].close, 30);

  // A late update to an older bucket leaves the series alone; the store is the
  // only authority for historical rebuilds.
  const late = chartData.toChartCandles([timeCandle('1700000000000', '11000000')])[0];
  const unchanged = chartData.applyTailUpdate(grown, late);
  assert.equal(unchanged.length, 3);
  assert.equal(unchanged[0].close, 10);

  // Appending into an empty series seeds it.
  assert.equal(chartData.applyTailUpdate([], newBucket).length, 1);
});

test('chart states: unavailable outranks loading, and a fake chart is never rendered', () => {
  const base = { candleCount: 10, tradeCount: 10, basis: chartData.chartTimeBasis([timeCandle('1700000000000', '1')]), subscribed: true };

  assert.equal(chartData.resolveChartState({ ...base, loading: true, health: { status: 'UNAVAILABLE', source: 'x' } }).state, 'UNAVAILABLE');
  assert.equal(chartData.resolveChartState({ ...base, loading: true, health: { status: 'SYNCED', source: 'x' } }).state, 'LOADING');
  assert.equal(chartData.resolveChartState({ ...base, candleCount: 0, tradeCount: 0, health: { status: 'SYNCED', source: 'x' } }).state, 'NO_TRADES_YET');
  assert.equal(chartData.resolveChartState({ ...base, candleCount: 0, tradeCount: 4, health: { status: 'SYNCED', source: 'x' } }).state, 'EMPTY_MARKET');
  assert.equal(chartData.resolveChartState({ ...base, basis: chartData.chartTimeBasis([epochCandle('1')]), health: { status: 'SYNCED', source: 'x' } }).state, 'DEGRADED');
  assert.equal(chartData.resolveChartState({ ...base, health: { status: 'STALE', source: 'x' } }).state, 'STALE');
  assert.equal(chartData.resolveChartState({ ...base, health: { status: 'DEGRADED', source: 'x' } }).state, 'DEGRADED');
  assert.equal(chartData.resolveChartState({ ...base, subscribed: false, health: { status: 'SYNCED', source: 'x' } }).state, 'DEGRADED');
  assert.equal(chartData.resolveChartState({ ...base, health: { status: 'SYNCED', source: 'x' } }).state, 'LIVE');
});

test('chart states: an unavailable source renders no canvas at all', () => {
  const state = chartData.resolveChartState({
    loading: false,
    health: { status: 'UNAVAILABLE', source: 'none', reason: 'No market-data source is configured for this build.' },
    candleCount: 0,
    tradeCount: 0,
    basis: chartData.chartTimeBasis([]),
    subscribed: false,
  });
  assert.equal(state.renderCanvas, false);
  assert.match(state.detail, /No market-data source/);
});

test('chart states: "no trades yet" is distinguishable from "empty market"', () => {
  const health = { status: 'SYNCED', source: 'x' };
  const noTrades = chartData.resolveChartState({ loading: false, health, candleCount: 0, tradeCount: 0, basis: chartData.chartTimeBasis([]), subscribed: true });
  const emptyMarket = chartData.resolveChartState({ loading: false, health, candleCount: 0, tradeCount: 7, basis: chartData.chartTimeBasis([]), subscribed: true });
  assert.equal(noTrades.state, 'NO_TRADES_YET');
  assert.equal(emptyMarket.state, 'EMPTY_MARKET');
  assert.notEqual(noTrades.detail, emptyMarket.detail);
  // Neither fabricates a chart.
  assert.equal(noTrades.renderCanvas, false);
  assert.equal(emptyMarket.renderCanvas, false);
});
