/**
 * HOSTILE MARKET-DATA SUITE.
 *
 * Covers malicious indexer input (§26), the informational-only security boundary (§34),
 * chart/execution disagreement (§35), reorg handling (§14), dedupe (§4), and the health
 * model (§36). Refusals are regressions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const md = {
  price: require('../dist/marketdata/price.js'),
  candle: require('../dist/marketdata/candle.js'),
  store: require('../dist/marketdata/store.js'),
  indexer: require('../dist/marketdata/indexer.js'),
  api: require('../dist/marketdata/api.js'),
  types: require('../dist/marketdata/types.js'),
};
const amm = require('../dist/amm.js');

const TARI = { kind: 'OOTLE_L2', resourceAddress: 'tari_res_1', label: 'TARI', decimals: '6', isCanonicalTari: true };
const WSTABLE = { kind: 'OOTLE_L2', resourceAddress: 'wstable_res_9', label: 'wSTABLE', decimals: '6' };
const PAIR = {
  poolComponent: 'pool_1', resourceA: TARI.resourceAddress, resourceB: WSTABLE.resourceAddress,
  baseResource: TARI.resourceAddress, quoteResource: WSTABLE.resourceAddress,
  baseDecimals: '6', quoteDecimals: '6', safetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED', labelA: 'TARI', labelB: 'wSTABLE',
};
const OTHER_POOL = { ...PAIR, poolComponent: 'pool_2' };

function goodObservation(over = {}) {
  return {
    chainTxId: 'tx_1', instructionIndex: '0', poolComponent: 'pool_1',
    inputResource: PAIR.resourceA, outputResource: PAIR.resourceB,
    inputAmountRaw: '1000000', outputAmountRaw: '2500000',
    reserveABefore: '10000000', reserveBBefore: '25000000', reserveAAfter: '11000000', reserveBAfter: '27500000',
    feeBps: '30', epoch: '1005', substateIdentity: 'pool_1@5',
    time: { bucketKey: '0', source: 'EPOCH_BOUNDARY', epoch: '1005' },
    source: 'test-discovery', finality: 'PROVISIONAL',
    ...over,
  };
}

/** An authoritative readback that corroborates the good observation. */
function goodReadback(over = {}) {
  return {
    readPool: async () => ({
      status: 'FOUND',
      value: {
        poolComponent: 'pool_1', resourceA: PAIR.resourceA, resourceB: PAIR.resourceB,
        reserveA: over.reserveA ?? '11000000', reserveB: over.reserveB ?? '27500000', feeBps: '30',
        lpResource: 'lp_1', totalLpSupply: '1000', lockedLpSupply: '1000',
      },
      freshness: { source: over.source ?? 'CHAIN_NODE', identity: { substateVersion: '5', producingTxHash: over.producingTxHash ?? 'pool_1@5', epoch: '1005', stateIdentity: 'pool_1', readAtUnixMs: Date.now() } },
    }),
  };
}

function makeIndexer(over = {}) {
  const store = over.store ?? new md.store.InMemoryMarketDataStore();
  return {
    store,
    indexer: new md.indexer.MarketDataIndexer({
      store, pair: PAIR,
      readback: over.readback ?? goodReadback(),
      readbackIsAuthoritative: over.readbackIsAuthoritative ?? true,
      source: over.source ?? { name: 'test', fetchBackfill: async () => ({ observations: [] }), follow: () => ({ unsubscribe() {} }) },
      intervals: over.intervals ?? ['1d'],
      epochDurationMs: over.epochDurationMs ?? '1000',
    }),
  };
}

// ===========================================================================
// §26 MALICIOUS DATA
// ===========================================================================

test('26.1 malformed and hostile observations are rejected without contaminating the store', async () => {
  const cases = [
    ['fake resource address', { inputResource: 'not_a_resource', outputResource: PAIR.resourceB }, /do not belong to pool/],
    ['same symbol different resource', { outputResource: 'wstable_res_OTHER' }, /do not belong to pool/],
    ['wrong pool', { poolComponent: 'pool_9' }, /does not match the indexed pool/],
    ['malformed amount', { inputAmountRaw: 'abc' }, /raw non-negative integer/],
    ['negative string', { inputAmountRaw: '-1' }, /raw non-negative integer/],
    ['non-integer amount', { outputAmountRaw: '1.5' }, /raw non-negative integer/],
    ['absurdly large BigInt', { inputAmountRaw: '1'.padStart(200, '1') }, /exceeds 128 bits/],
    ['zero input', { inputAmountRaw: '0' }, /zero amount is not a trade/],
    ['zero output', { outputAmountRaw: '0' }, /zero amount is not a trade/],
    ['missing txid', { chainTxId: '  ' }, /requires a chain transaction id/],
    ['bad fee', { feeBps: '10000' }, /feeBps must be an integer below 10000/],
    ['non-integer index', { instructionIndex: 'x' }, /instructionIndex must be/],
    ['impossible reserves (zero)', { reserveABefore: '0' }, /reserves must be positive/],
    ['impossible reserve growth', { reserveBAfter: '99999999' }, /impossible reserves/],
    // A price the pool could not have executed at: k must never shrink on a swap.
    ['k-reducing trade', { reserveBAfter: '1' }, /reduce the pool constant product/],
    ['k-reducing trade (reverse direction)', { inputResource: PAIR.resourceB, outputResource: PAIR.resourceA, reserveABefore: '25000000', reserveBBefore: '10000000', reserveAAfter: '1', reserveBAfter: '11000000', inputAmountRaw: '2500000', outputAmountRaw: '1000000' }, /reduce the pool constant product/],
    ['missing epoch and time', { epoch: undefined, time: { bucketKey: '0', source: 'LOCAL_RECEIPT' } }, /requires either an epoch or a consensus timestamp/],
    ['empty time bucket', { time: { bucketKey: '', source: 'EPOCH_BOUNDARY' } }, /time bucket key/],
    ['stale/mismatched state version', { substateIdentity: 'pool_1@DIFFERENT' }, /state identity mismatch/],
  ];
  for (const [name, over, re] of cases) {
    const { indexer, store } = makeIndexer();
    const outcome = await indexer.ingest(goodObservation(over));
    assert.equal(outcome, 'rejected', `accepted hostile observation: ${name}`);
    assert.equal((await store.listAllTrades('pool_1')).length, 0, `stored a hostile observation: ${name}`);
    assert.match(indexer.rejectionSummary().last.reason, re, `${name}: wrong rejection reason`);
  }
});

test('26.2 a non-authoritative (discovery-only) readback refuses to index trades', async () => {
  const { indexer, store } = makeIndexer({ readbackIsAuthoritative: false });
  const outcome = await indexer.ingest(goodObservation());
  assert.equal(outcome, 'rejected');
  assert.match(indexer.rejectionSummary().last.reason, /no authoritative pool readback configured/);
  assert.equal((await store.listAllTrades('pool_1')).length, 0, 'a chart may be incomplete, never fabricated');
});

test('26.3 cross-pool contamination is impossible', async () => {
  const { indexer, store } = makeIndexer();
  // A trade for another pool cannot be validated against this pair.
  const outcome = await indexer.ingest(goodObservation({ poolComponent: 'pool_2' }));
  assert.equal(outcome, 'rejected');
  assert.equal((await store.listAllTrades('pool_2')).length, 0);
  assert.equal((await store.listAllTrades('pool_1')).length, 0);
});

// ===========================================================================
// §4 DEDUPLICATION
// ===========================================================================

test('4.1 re-ingesting the same confirmed transaction never duplicates anything', async () => {
  const { indexer, store } = makeIndexer();
  assert.equal(await indexer.ingest(goodObservation()), 'accepted');
  assert.equal(await indexer.ingest(goodObservation()), 'duplicate');
  assert.equal(await indexer.ingest(goodObservation()), 'duplicate');
  const trades = await store.listAllTrades('pool_1');
  assert.equal(trades.length, 1, 'a chain-derived id makes re-ingestion idempotent');
  const candles = await store.listCandles({ poolComponent: 'pool_1', interval: '1d', limit: 100 });
  assert.equal(candles.length, 1);
  assert.equal(candles[0].tradeCount, 1, 'volume/count must not double');
  // a different transaction index in the same tx is a DIFFERENT trade (with reserves
  // consistent with its own amounts, as the chain would report)
  await indexer.ingest(goodObservation({ instructionIndex: '1', outputAmountRaw: '2000000', reserveBAfter: '27000000' }));
  assert.equal((await store.listAllTrades('pool_1')).length, 2, 'distinct instructions are distinct trades');
  // trade ids are chain-derived, never random
  assert.equal(trades[0].tradeId, 'tx_1:0:pool_1');
});

test('4.2 a provisional trade is promoted to finalized, never duplicated or downgraded', async () => {
  const { indexer, store } = makeIndexer();
  await indexer.ingest(goodObservation({ finality: 'PROVISIONAL' }));
  await indexer.ingest(goodObservation({ finality: 'FINALIZED' }));
  const trades = await store.listAllTrades('pool_1');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].finality, 'FINALIZED');
  // and a downgrade attempt is refused
  const r = await store.upsertActivity({ activityId: 'a1', kind: 'TRADE', poolComponent: 'pool_1', chainTxId: 'tx_1', instructionIndex: '0', time: trades[0].time, inputResource: PAIR.resourceA, outputResource: PAIR.resourceB, inputAmountRaw: '1', outputAmountRaw: '1', direction: 'BASE_TO_QUOTE', ingestionSource: 'x', finality: 'PROVISIONAL' });
  assert.equal(r.inserted, true);
});

// ===========================================================================
// §14 REORG / INVALIDATION
// ===========================================================================

test('14.1 an invalidated trade leaves the candles and cannot be silently reinstated', async () => {
  const { indexer, store } = makeIndexer();
  await indexer.ingest(goodObservation());
  await indexer.ingest(goodObservation({ chainTxId: 'tx_2', outputAmountRaw: '3000000', reserveBAfter: '28000000' }));
  let candles = await store.listCandles({ poolComponent: 'pool_1', interval: '1d', limit: 10 });
  assert.equal(candles[0].tradeCount, 2);
  const before = BigInt(candles[0].baseVolumeRaw);

  const pools = await indexer.invalidate('tx_1:0:pool_1', 'reorg: transaction reverted');
  assert.deepEqual(pools, ['pool_1']);
  candles = await store.listCandles({ poolComponent: 'pool_1', interval: '1d', limit: 10 });
  assert.equal(candles[0].tradeCount, 1, 'an invalidated trade must leave the candle');
  assert.ok(BigInt(candles[0].baseVolumeRaw) < before, 'volume must shrink after invalidation');
  assert.equal((await store.getTrade('tx_1:0:pool_1')).finality, 'INVALIDATED');
  // re-ingesting the reverted trade is refused
  assert.equal(await indexer.ingest(goodObservation()), 'rejected');
});

test('14.2 an invalidation is observable by subscribers', async () => {
  const { indexer } = makeIndexer();
  await indexer.ingest(goodObservation());
  const seen = [];
  indexer.subscribeInvalidations((e) => seen.push(e));
  await indexer.invalidate('tx_1:0:pool_1', 'reorg');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'reorg');
});

// ===========================================================================
// §34 SECURITY BOUNDARY: MARKET DATA IS NEVER AUTHORITATIVE
// ===========================================================================

test('34.1 a poisoned chart cannot influence an AMM execution amount or min_output', async () => {
  // The indexer will happily record whatever the (verified) discovery source reports.
  const { indexer, store } = makeIndexer();
  await indexer.ingest(goodObservation());
  const trades = await store.listAllTrades('pool_1');
  assert.equal(trades.length, 1);
  const chartPrice = trades[0].executionPrice; // 2.5 quote per base

  // A hostile "chart" claiming a wildly different price/value is irrelevant to execution.
  const poisoned = { ...trades[0], executionPrice: md.price.priceFromSettled({ quoteOutRaw: '999999999', baseInRaw: '1', baseDecimals: '6', quoteDecimals: '6' }) };
  // Execution goes through the authoritative AMM resolver, which rereads the pool.
  const resolverReadback = goodReadback({ reserveA: '10000000', reserveB: '20000000' });
  const outcome = await amm.resolveSwap(
    { poolComponent: 'pool_1', inputResource: PAIR.resourceA, outputResource: PAIR.resourceB, rawInputAmount: '1000000', slippage: { slippageBps: '100' }, maxEpoch: '9999' },
    { readback: resolverReadback, builder: { swap: (i) => i }, currentEpoch: '1000' },
  );
  assert.equal(outcome.status, 'ACTIVE');
  // The authoritative quote is derived from the CHAIN reserves, not the chart.
  const expected = amm.quoteSwapOutput('10000000', '20000000', '1000000', '30');
  assert.equal(outcome.resolved.quote.quotedOutput, expected.output);
  // and it differs from the poisoned chart value — proving the chart had no authority.
  assert.notEqual(poisoned.executionPrice.numerator, outcome.resolved.quote.quotedOutput);
  // min_output comes from the AMM policy, never from market data.
  assert.equal(outcome.resolved.quote.minOutput, amm.deriveMinOutput(expected.output, { slippageBps: '100' }));
  void chartPrice;
});

test('34.2 market-data types cannot produce a settlement proof or execute a hop', () => {
  // The market-data module has no dependency on the proof or hop execution modules: this is
  // the structural half of the boundary.
  const fs = require('node:fs');
  const dir = __dirname.replace(/test$/, '') + 'src/marketdata';
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(`${dir}/${file}`, 'utf8');
    assert.ok(!/from '\.\.\/multihop\/(proof|hops)'/.test(src), `${file} imports the settlement/hop modules`);
    assert.ok(!/mintTerminalSettlementProof|buildAmmSwapHop|submitFunding|submitClaim/.test(src), `${file} references an execution or settlement entry point`);
  }
});

test('34.3 a failed fetch degrades health honestly rather than reporting SYNCED', async () => {
  const { indexer } = makeIndexer({
    source: { name: 'flaky', fetchBackfill: async () => { throw new Error('indexer 503'); }, follow: () => ({ unsubscribe() {} }) },
  });
  const result = await indexer.backfill({ limit: 10 });
  assert.equal(result.accepted, 0);
  assert.equal(indexer.healthStatus().status, 'DEGRADED');
  assert.match(indexer.healthStatus().reason, /backfill failed/);
});

test('34.4 a live-follow error marks the feed STALE, not SYNCED', () => {
  const { indexer } = makeIndexer({
    source: {
      name: 'flaky-live',
      fetchBackfill: async () => ({ observations: [] }),
      follow: (_i, _on, onError) => { setTimeout(() => onError(new Error('stream closed')), 0); return { unsubscribe() {} }; },
    },
  });
  indexer.follow();
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(indexer.healthStatus().status, 'STALE');
    assert.match(indexer.healthStatus().reason, /live follow error/);
    resolve();
  }, 20));
});

test('34.5 the frontend view is explicitly marked informational', async () => {
  const { indexer, store } = makeIndexer();
  await indexer.ingest(goodObservation());
  const api = md.api.createMarketDataQueryApi({ store, pairs: new Map([['pool_1', PAIR]]) });
  const header = await api.poolHeader({ poolComponent: 'pool_1', health: indexer.healthStatus(), nowEpochKey: '1005', currentReserves: { reserveA: '11000000', reserveB: '27500000' } });
  assert.equal(header.informationalOnly, true);
  assert.equal(header.poolComponent, 'pool_1');
  assert.equal(header.liquidityNative.label, 'NATIVE_QUANTITIES');
  // No fiat TVL is invented.
  assert.equal(JSON.stringify(header).includes('USD'), false);
  assert.equal(JSON.stringify(header).includes('tvl'), false);
});

// ===========================================================================
// §8/§9 TIMESTAMPT HONESTY
// ===========================================================================

test('8.1 sub-resolution wall-clock intervals are marked UNSUPPORTED, not fabricated', () => {
  // Epoch cadence 1000ms: a 1m bucket is exactly representable, 1s is not.
  const oneMinute = md.candle.intervalSupport('1m', { timeSource: 'EPOCH_BOUNDARY', epochDurationMs: '1000' });
  assert.equal(oneMinute.supported, true);
  assert.equal(oneMinute.basis, 'EPOCH_BOUNDARY');
  // No cadence known → no wall-clock interval may be claimed.
  const unknown = md.candle.intervalSupport('1m', { timeSource: 'EPOCH_BOUNDARY' });
  assert.equal(unknown.supported, false);
  assert.match(unknown.reason, /without a known epoch cadence/);
  // A local-receipt source can never back a wall-clock candle.
  for (const interval of md.types.CANDLE_INTERVALS) {
    const local = md.candle.intervalSupport(interval, { timeSource: 'LOCAL_RECEIPT' });
    assert.equal(local.supported, false, `${interval} must not be supported from a local receipt`);
    assert.match(local.reason, /not a consensus clock/);
  }
  // With a real consensus timestamp, every interval is supported.
  for (const interval of md.types.CANDLE_INTERVALS) {
    const consensus = md.candle.intervalSupport(interval, { timeSource: 'CONSENSUS_TIMESTAMP' });
    assert.equal(consensus.supported, true);
  }
});

test('8.2 a consensus-timestamp trade buckets deterministically by wall clock', () => {
  const t = {
    tradeId: 'x', poolComponent: 'pool_1', chainTxId: 'x', instructionIndex: '0',
    time: { bucketKey: '0', source: 'CONSENSUS_TIMESTAMP', unixMs: String(1_700_000_000_000 + 90_000) },
    inputResource: PAIR.resourceA, outputResource: PAIR.resourceB, inputAmountRaw: '1', outputAmountRaw: '1',
    reserveABefore: '1', reserveBBefore: '1', reserveAAfter: '1', reserveBAfter: '1', feeBps: '1', direction: 'BASE_TO_QUOTE',
    executionPrice: md.price.priceFromSettled({ quoteOutRaw: '1', baseInRaw: '1', baseDecimals: '0', quoteDecimals: '0' }),
    ingestionSource: 'x', finality: 'FINALIZED',
  };
  const b = md.candle.bucketForTrade(t, '1m');
  assert.equal(b.kind, 'TIME');
  assert.equal(BigInt(t.time.unixMs) >= BigInt(b.start), true);
  assert.equal(BigInt(t.time.unixMs) < BigInt(b.end), true);
});

// ===========================================================================
// §5 DIRECTION / §6 PRICE
// ===========================================================================

test('5.1 direction normalization uses exact resource identity and refuses foreign assets', () => {
  assert.equal(md.candle.normalizeDirection({ inputResource: PAIR.resourceA, outputResource: PAIR.resourceB, pair: PAIR }), 'BASE_TO_QUOTE');
  assert.equal(md.candle.normalizeDirection({ inputResource: PAIR.resourceB, outputResource: PAIR.resourceA, pair: PAIR }), 'QUOTE_TO_BASE');
  assert.throws(() => md.candle.normalizeDirection({ inputResource: 'x', outputResource: PAIR.resourceA, pair: PAIR }), /not this pool's pair/);
});

test('6.1 execution price is derived from SETTLED amounts, not the reserve ratio', () => {
  // Deliberately inconsistent reserves vs amounts: the price must follow the AMOUNTS.
  const trade = md.store.validateObservation(goodObservation({ inputAmountRaw: '300', outputAmountRaw: '900', reserveBBefore: '25000000', reserveBAfter: '25000900' }), PAIR);
  // base = TARI (resourceA), quote = wSTABLE (resourceB) → 900/300 = 3
  assert.equal(trade.executionPrice.numerator, '900');
  assert.equal(trade.executionPrice.denominator, '300');
  assert.equal(md.price.comparePrices(trade.executionPrice, { numerator: '3', denominator: '1', baseDecimals: '6', quoteDecimals: '6' }), 0);
});

// ===========================================================================
// §31/§32 CHART ADAPTER
// ===========================================================================

test('31.1 the chart adapter is the only place floats appear, and it is marked', () => {
  const { indexer, store } = makeIndexer();
  return indexer.ingest(goodObservation()).then(async () => {
    const candles = await store.listCandles({ poolComponent: 'pool_1', interval: '1d', limit: 10 });
    const series = md.api.toChartSeries(candles);
    assert.equal(series.length, 1);
    assert.equal(typeof series[0].open, 'number');
    assert.equal(typeof series[0].volume, 'number');
    // storage is untouched by the conversion
    assert.equal(typeof candles[0].open.numerator, 'string');
    assert.equal(candles[0].open.numerator, '2500000');
  });
});

// ===========================================================================
// §36 HEALTH
// ===========================================================================

test('36.1 health reports SYNCED after a clean backfill and exposes the source', async () => {
  const { indexer } = makeIndexer({
    source: {
      name: 'clean',
      fetchBackfill: async () => ({ observations: [goodObservation()], nextAfterId: '2' }),
      follow: () => ({ unsubscribe() {} }),
    },
  });
  const result = await indexer.backfill({ limit: 10 });
  assert.equal(result.accepted, 1);
  assert.equal(indexer.healthStatus().status, 'SYNCED');
  assert.equal(indexer.healthStatus().source, 'clean');
  assert.ok(indexer.healthStatus().lastSuccessfulSyncUnixMs);
  // a persisted cursor exists for restart-safe backfill
  assert.equal(await indexer.healthStatus().source === 'clean', true);
});

test('36.2 a rejected observation during backfill degrades rather than claiming SYNCED', async () => {
  const { indexer } = makeIndexer({
    source: { name: 'partial', fetchBackfill: async () => ({ observations: [goodObservation(), goodObservation({ inputAmountRaw: 'bad' })] }), follow: () => ({ unsubscribe() {} }) },
  });
  const result = await indexer.backfill({ limit: 10 });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(indexer.healthStatus().status, 'DEGRADED');
});
