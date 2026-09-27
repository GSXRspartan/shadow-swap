/**
 * OHLCV candle aggregation.
 *
 * Two design decisions follow directly from the traced source model
 * (docs/MARKET_DATA_SOURCE_MODEL.md):
 *
 * 1. NO TRUSTWORTHY WALL-CLOCK TIMESTAMP EXISTS in the Ootle indexer API. Candles are
 *    therefore bucketed by CONSENSUS EPOCH (which every source does expose) unless a
 *    producer supplies a genuine consensus timestamp. Sub-resolution wall-clock intervals
 *    are reported UNSUPPORTED with a reason rather than fabricated from epoch numbers.
 * 2. CANDLES ARE ALWAYS DERIVED. A candle is a pure function of the activity records in its
 *    bucket, so a late or out-of-order trade REPLACES the bucket's aggregate rather than
 *    being appended. `rebuildCandles` must therefore be logically identical to incremental
 *    aggregation, which the property suite verifies.
 *
 * Prices are exact rationals; volumes and counts are exact integers. No float is used
 * anywhere in the aggregation path.
 */
import { comparePrices, PriceRational } from './price.js';
import { CANDLE_INTERVALS, CandleInterval, CanonicalTrade, IntervalSupport, OhlcvCandle, PoolPair, TradeDirection } from './types.js';

const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function intervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}

/**
 * Honest interval support. A wall-clock interval is only supported when the trade time
 * source is a genuine CONSENSUS_TIMESTAMP; with epoch-only ordering we can still bucket by
 * epoch, and any interval at or above the epoch cadence is representable.
 */
export function intervalSupport(interval: CandleInterval, options: { timeSource: 'CONSENSUS_TIMESTAMP' | 'EPOCH_BOUNDARY' | 'INDEXER_OBSERVED' | 'LOCAL_RECEIPT'; epochDurationMs?: string }): IntervalSupport {
  if (options.timeSource === 'CONSENSUS_TIMESTAMP') return { supported: true, basis: 'CONSENSUS_TIMESTAMP' };
  if (options.timeSource === 'EPOCH_BOUNDARY') {
    const epochMs = options.epochDurationMs === undefined ? null : BigInt(options.epochDurationMs);
    const required = BigInt(INTERVAL_MS[interval]);
    if (epochMs === null) {
      return { supported: false, reason: 'epoch-bucketed source without a known epoch cadence cannot support a wall-clock interval' };
    }
    if (epochMs <= required) {
      return { supported: true, basis: 'EPOCH_BOUNDARY' };
    }
    return { supported: false, reason: `epoch cadence ${epochMs}ms is coarser than the ${interval} interval (${INTERVAL_MS[interval]}ms) — fabricating sub-epoch candles is refused` };
  }
  return { supported: false, reason: `time source ${options.timeSource} is not a consensus clock — wall-clock candles would be fabricated` };
}

export interface BucketKey {
  start: string;
  end: string;
  kind: 'TIME' | 'EPOCH';
}

/**
 * Deterministic bucket for a trade. Epoch buckets need the epoch cadence to express an end
 * key; when unknown, the bucket is a single epoch (start == end) and remains stable.
 */
export function bucketForTrade(trade: CanonicalTrade, interval: CandleInterval, epochDurationMs?: string): BucketKey {
  if (trade.time.source === 'CONSENSUS_TIMESTAMP' && trade.time.unixMs !== undefined) {
    const ms = BigInt(trade.time.unixMs);
    const width = BigInt(INTERVAL_MS[interval]);
    const start = (ms / width) * width;
    return { start: start.toString(), end: (start + width).toString(), kind: 'TIME' };
  }
  // Epoch bucket: one epoch per bucket unless a cadence lets us group epochs.
  const epoch = trade.epoch ?? trade.time.epoch ?? trade.time.bucketKey;
  if (epoch === undefined) throw new Error('trade has neither a consensus timestamp nor an epoch — it cannot be bucketed');
  const perBucket = epochsPerBucket(interval, epochDurationMs);
  const e = BigInt(epoch);
  const start = (e / perBucket) * perBucket;
  return { start: start.toString(), end: (start + perBucket).toString(), kind: 'EPOCH' };
}

function epochsPerBucket(interval: CandleInterval, epochDurationMs?: string): bigint {
  if (epochDurationMs === undefined) return 1n;
  const epochMs = BigInt(epochDurationMs);
  if (epochMs <= 0n) return 1n;
  const width = BigInt(INTERVAL_MS[interval]);
  const n = width / epochMs;
  return n < 1n ? 1n : n;
}

/**
 * Deterministic ordering key. Chain ordering first (epoch, then the chain-derived event id /
 * instruction index), with the trade id only as the final deterministic tie-breaker.
 * Ingestion arrival order is NEVER used.
 */
export function compareTradesForOrdering(a: CanonicalTrade, b: CanonicalTrade): number {
  const ae = BigInt(a.epoch ?? a.time.epoch ?? a.time.bucketKey);
  const be = BigInt(b.epoch ?? b.time.epoch ?? b.time.bucketKey);
  if (ae !== be) return ae < be ? -1 : 1;
  if (a.time.unixMs !== undefined && b.time.unixMs !== undefined && a.time.unixMs !== b.time.unixMs) {
    return BigInt(a.time.unixMs) < BigInt(b.time.unixMs) ? -1 : 1;
  }
  const ai = BigInt(a.instructionIndex);
  const bi = BigInt(b.instructionIndex);
  if (ai !== bi) return ai < bi ? -1 : 1;
  return a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0;
}

export function candleKey(candle: Pick<OhlcvCandle, 'poolComponent' | 'interval' | 'bucketStart'>): string {
  return `${candle.poolComponent}|${candle.interval}|${candle.bucketStart}`;
}

/**
 * Aggregate a set of trades into ONE candle. This is a pure function of its input, which is
 * what makes late/out-of-order insertion correct: the caller replaces the bucket wholesale
 * instead of mutating it.
 */
export function aggregateCandle(input: {
  pair: PoolPair;
  interval: CandleInterval;
  bucket: BucketKey;
  trades: CanonicalTrade[];
  partial?: boolean;
}): OhlcvCandle {
  const trades = [...input.trades].sort(compareTradesForOrdering);
  if (trades.length === 0) throw new Error('cannot aggregate an empty candle — empty buckets are omitted, never invented');
  const first = trades[0];
  const last = trades[trades.length - 1];
  let high = first.executionPrice;
  let low = first.executionPrice;
  let baseVolume = 0n;
  let quoteVolume = 0n;
  let fees = 0n;
  let buyBase = 0n;
  let sellBase = 0n;
  for (const t of trades) {
    if (comparePrices(t.executionPrice, high) > 0) high = t.executionPrice;
    if (comparePrices(t.executionPrice, low) < 0) low = t.executionPrice;
    const inAmount = BigInt(t.inputAmountRaw);
    const outAmount = BigInt(t.outputAmountRaw);
    // Base volume is always denominated in the BASE asset, whichever side was sold.
    const baseAmount = t.direction === 'BASE_TO_QUOTE' ? inAmount : outAmount;
    const quoteAmount = t.direction === 'BASE_TO_QUOTE' ? outAmount : inAmount;
    baseVolume += baseAmount;
    quoteVolume += quoteAmount;
    if (t.direction === 'BASE_TO_QUOTE') buyBase += baseAmount;
    else sellBase += baseAmount;
    fees += (inAmount * BigInt(t.feeBps)) / 10_000n;
  }
  return {
    poolComponent: input.pair.poolComponent,
    baseResource: input.pair.baseResource,
    quoteResource: input.pair.quoteResource,
    interval: input.interval,
    bucketStart: input.bucket.start,
    bucketEnd: input.bucket.end,
    open: first.executionPrice,
    high,
    low,
    close: last.executionPrice,
    baseVolumeRaw: baseVolume.toString(),
    quoteVolumeRaw: quoteVolume.toString(),
    tradeCount: trades.length,
    firstTradeId: first.tradeId,
    lastTradeId: last.tradeId,
    partial: input.partial ?? false,
    feesGeneratedBaseRaw: fees.toString(),
    buyBaseVolumeRaw: buyBase.toString(),
    sellBaseVolumeRaw: sellBase.toString(),
    bucketKind: input.bucket.kind,
  };
}

/** Group trades by bucket, then aggregate each bucket deterministically. */
export function rebuildCandles(input: {
  pair: PoolPair;
  interval: CandleInterval;
  trades: CanonicalTrade[];
  epochDurationMs?: string;
  partialBuckets?: ReadonlySet<string>;
}): OhlcvCandle[] {
  const buckets = new Map<string, CanonicalTrade[]>();
  const keys = new Map<string, BucketKey>();
  for (const trade of input.trades) {
    if (trade.finality === 'INVALIDATED') continue; // invalidated trades never reach a candle
    const bucket = bucketForTrade(trade, input.interval, input.epochDurationMs);
    const key = `${bucket.kind}:${bucket.start}`;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [trade]);
    else list.push(trade);
    keys.set(key, bucket);
  }
  const out: OhlcvCandle[] = [];
  for (const [key, trades] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const bucket = keys.get(key);
    if (bucket === undefined) continue;
    out.push(aggregateCandle({ pair: input.pair, interval: input.interval, bucket, trades, partial: input.partialBuckets?.has(key) ?? false }));
  }
  return out;
}

/** Direction normalization against a canonical pair. Exact address comparison only. */
export function normalizeDirection(input: { inputResource: string; outputResource: string; pair: PoolPair }): TradeDirection {
  if (input.inputResource === input.pair.baseResource && input.outputResource === input.pair.quoteResource) return 'BASE_TO_QUOTE';
  if (input.inputResource === input.pair.quoteResource && input.outputResource === input.pair.baseResource) return 'QUOTE_TO_BASE';
  throw new Error(`trade resources (${input.inputResource} → ${input.outputResource}) are not this pool's pair`);
}
