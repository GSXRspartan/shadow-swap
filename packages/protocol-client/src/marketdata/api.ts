/**
 * Pool metrics and the frontend query API.
 *
 * Everything here is INFORMATIONAL. A metric can be wrong, stale, or absent; it can never
 * set an execution amount, a min_output, a resource, or a settlement proof. The frontend is
 * told that explicitly so it can show a degraded state honestly.
 */
import { comparePrices, toDisplayPrice } from './price.js';
import { intervalSupport } from './candle.js';
import {
  CandleInterval,
  CandleSeriesView,
  CanonicalTrade,
  ChartCandlePoint,
  IntervalSupport,
  MarketDataHealth,
  MarketDataStore,
  OhlcvCandle,
  PoolActivityPage,
  PoolMetrics,
  PoolPair,
  PoolPageHeaderView,
  TradeListPage,
} from './types.js';

const DAY_MS = 86_400_000n;

/** Latest valid execution price, and the change against a reference price. */
export function computePriceChange24h(input: { trades: CanonicalTrade[]; nowMs: bigint }): PoolMetrics['priceChange24h'] {
  const ordered = [...input.trades].sort((a, b) => {
    const ae = BigInt(a.epoch ?? a.time.bucketKey);
    const be = BigInt(b.epoch ?? b.time.bucketKey);
    if (ae !== be) return ae < be ? -1 : 1;
    return a.tradeId < b.tradeId ? -1 : 1;
  });
  if (ordered.length === 0) return { value: { numerator: '0', denominator: '1', baseDecimals: '0', quoteDecimals: '0' }, direction: 'UNAVAILABLE', reason: 'no trades indexed' };
  const latest = ordered[ordered.length - 1];
  const latestKey = BigInt(latest.epoch ?? latest.time.bucketKey);
  // The boundary is expressed in the trade's own time domain. With epoch-only ordering the
  // caller supplies the epoch cadence so "24h" is meaningful rather than guessed.
  const boundary = input.nowMs;
  let reference: CanonicalTrade | undefined;
  for (const trade of ordered) {
    const key = BigInt(trade.epoch ?? trade.time.bucketKey);
    if (key <= boundary) reference = trade;
    else break;
  }
  if (reference === undefined) {
    return { value: latest.executionPrice, direction: 'UNAVAILABLE', reason: 'no trade at or before the 24h boundary — the pool may be younger than 24h' };
  }
  if (reference.tradeId === latest.tradeId) {
    return { value: latest.executionPrice, direction: 'FLAT', reason: 'only one trade in the window' };
  }
  const cmp = comparePrices(latest.executionPrice, reference.executionPrice);
  return {
    value: latest.executionPrice,
    direction: cmp > 0 ? 'UP' : cmp < 0 ? 'DOWN' : 'FLAT',
  };
}

/** Store-backed metrics. */
export async function computePoolMetricsForStore(input: {
  store: MarketDataStore;
  poolComponent: string;
  pair: PoolPair;
  health: MarketDataHealth;
  nowEpochKey: string;
  currentReserves?: { reserveA: string; reserveB: string };
}): Promise<PoolMetrics> {
  const trades = await input.store.listAllTrades(input.poolComponent);
  return computePoolMetricsFromTrades({ ...input, trades });
}


/** Metrics from an explicit trade set — pure, so metrics are testable without a store. */
export function computePoolMetricsFromTrades(input: {
  store?: MarketDataStore;
  trades: CanonicalTrade[];
  poolComponent: string;
  pair: PoolPair;
  health: MarketDataHealth;
  nowEpochKey: string;
  currentReserves?: { reserveA: string; reserveB: string };
}): PoolMetrics {
  const ordered = [...input.trades].sort((a, b) => {
    const ae = BigInt(a.epoch ?? a.time.bucketKey);
    const be = BigInt(b.epoch ?? b.time.bucketKey);
    if (ae !== be) return ae < be ? -1 : 1;
    return a.tradeId < b.tradeId ? -1 : 1;
  });
  const latest = ordered[ordered.length - 1];
  const nowKey = BigInt(input.nowEpochKey);
  const inWindow = ordered.filter((t) => BigInt(t.epoch ?? t.time.bucketKey) >= nowKey);
  let baseVolume = 0n;
  let quoteVolume = 0n;
  let fees = 0n;
  for (const t of inWindow) {
    const baseAmount = t.direction === 'BASE_TO_QUOTE' ? BigInt(t.inputAmountRaw) : BigInt(t.outputAmountRaw);
    const quoteAmount = t.direction === 'BASE_TO_QUOTE' ? BigInt(t.outputAmountRaw) : BigInt(t.inputAmountRaw);
    baseVolume += baseAmount;
    quoteVolume += quoteAmount;
    fees += (BigInt(t.inputAmountRaw) * BigInt(t.feeBps)) / 10_000n;
  }
  const metrics: PoolMetrics = {
    poolComponent: input.poolComponent,
    pair: input.pair,
    health: input.health,
  };
  if (latest !== undefined) metrics.currentPrice = latest.executionPrice;
  metrics.priceChange24h = computePriceChange24h({ trades: ordered, nowMs: nowKey });
  if (inWindow.length > 0) {
    metrics.baseVolume24hRaw = baseVolume.toString();
    metrics.quoteVolume24hRaw = quoteVolume.toString();
    metrics.tradeCount24h = inWindow.length;
    metrics.lpFees24hBaseRaw = fees.toString();
  }
  if (input.currentReserves !== undefined) {
    metrics.currentReserves = input.currentReserves;
    // Native quantities only. No fiat TVL is invented.
    metrics.liquidityNative = {
      baseRaw: input.pair.baseResource === input.pair.resourceA ? input.currentReserves.reserveA : input.currentReserves.reserveB,
      quoteRaw: input.pair.baseResource === input.pair.resourceA ? input.currentReserves.reserveB : input.currentReserves.reserveA,
      label: 'NATIVE_QUANTITIES',
    };
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Frontend query API
// ---------------------------------------------------------------------------

export interface MarketDataQueryApi {
  poolHeader(input: { poolComponent: string; health: MarketDataHealth; nowEpochKey: string; currentReserves?: { reserveA: string; reserveB: string } }): Promise<PoolPageHeaderView>;
  candles(input: { poolComponent: string; interval: CandleInterval; limit: number; pair: import('./types.js').PoolPair; epochDurationMs?: string }): Promise<CandleSeriesView>;
  recentTrades(input: { poolComponent: string; limit: number; beforeBucketKey?: string }): Promise<TradeListPage>;
  poolActivity(input: { poolComponent: string; limit: number }): Promise<PoolActivityPage>;
}

export function createMarketDataQueryApi(input: { store: MarketDataStore; pairs: Map<string, import('./types.js').PoolPair> }): MarketDataQueryApi {
  const pairOf = (poolComponent: string): import('./types.js').PoolPair => {
    const pair = input.pairs.get(poolComponent);
    if (pair === undefined) throw new Error(`unknown pool ${poolComponent}`);
    return pair;
  };
  return {
    async poolHeader(q): Promise<PoolPageHeaderView> {
      const pair = pairOf(q.poolComponent);
      const metrics = await computePoolMetricsForStore({ store: input.store, poolComponent: q.poolComponent, pair, health: q.health, nowEpochKey: q.nowEpochKey, currentReserves: q.currentReserves });
      const change = metrics.priceChange24h ?? { direction: 'UNAVAILABLE' as const, value: undefined, reason: 'price change unavailable' };
      return {
        poolComponent: q.poolComponent,
        pair,
        currentPrice: metrics.currentPrice,
        priceChange24h: {
          direction: change.direction,
          percentDisplay: change.direction === 'UNAVAILABLE' || metrics.currentPrice === undefined ? undefined : percentDisplay(change.value, metrics.currentPrice),
          reason: change.reason,
        },
        baseVolume24hRaw: metrics.baseVolume24hRaw,
        quoteVolume24hRaw: metrics.quoteVolume24hRaw,
        tradeCount24h: metrics.tradeCount24h,
        lpFees24hBaseRaw: metrics.lpFees24hBaseRaw,
        liquidityNative: metrics.liquidityNative,
        health: q.health,
        informationalOnly: true,
      };
    },
    async candles(q): Promise<CandleSeriesView> {
      const candles = await input.store.listCandles({ poolComponent: q.poolComponent, interval: q.interval, limit: q.limit });
      const support: IntervalSupport = intervalSupport(q.interval, { timeSource: 'EPOCH_BOUNDARY', epochDurationMs: q.epochDurationMs });
      return { poolComponent: q.poolComponent, interval: q.interval, support, candles: support.supported ? candles : [] };
    },
    async recentTrades(q): Promise<TradeListPage> {
      const trades = await input.store.listTrades({ poolComponent: q.poolComponent, limit: q.limit, beforeBucketKey: q.beforeBucketKey });
      const last = trades[trades.length - 1];
      return { trades, nextBeforeBucketKey: last?.epoch, hasMore: trades.length === q.limit };
    },
    async poolActivity(q): Promise<PoolActivityPage> {
      const activity = await input.store.listActivity({ poolComponent: q.poolComponent, limit: q.limit });
      return { activity, hasMore: activity.length === q.limit };
    },
  };
}

/** Percent change between a reference price and the current price, as a display string. */
function percentDisplay(reference: { numerator: string; denominator: string; baseDecimals: string; quoteDecimals: string } | undefined, current: { numerator: string; denominator: string; baseDecimals: string; quoteDecimals: string } | undefined): string | undefined {
  if (reference === undefined || current === undefined) return undefined;
  const diff = BigInt(current.numerator) * BigInt(reference.denominator) - BigInt(reference.numerator) * BigInt(current.denominator);
  const den = BigInt(reference.numerator) * BigInt(current.denominator);
  if (den === 0n) return undefined;
  // exact bps, then formatted
  const bps = (diff * 10_000n) / den;
  const sign = bps < 0n ? '-' : '';
  return `${sign}${(bps < 0n ? -bps : bps) / 100n}.${((bps < 0n ? -bps : bps) % 100n).toString().padStart(2, '0')}%`;
}

// ---------------------------------------------------------------------------
// Chart adapter (§31/§32): the ONLY place floats appear
// ---------------------------------------------------------------------------

/**
 * Convert exact candles into a TradingView-style series. This is the deliberate, documented
 * display boundary: `Number` precision loss happens HERE and nowhere else. Core storage and
 * aggregation never see a float.
 */
export function toChartSeries(candles: OhlcvCandle[], options: { maxSignificantDigits?: number } = {}): ChartCandlePoint[] {
  return candles.map((c) => {
    const time = c.bucketKind === 'TIME' ? c.bucketStart : c.bucketStart;
    return {
      time,
      open: Number(toDisplayPrice(c.open, options.maxSignificantDigits).value),
      high: Number(toDisplayPrice(c.high, options.maxSignificantDigits).value),
      low: Number(toDisplayPrice(c.low, options.maxSignificantDigits).value),
      close: Number(toDisplayPrice(c.close, options.maxSignificantDigits).value),
      volume: Number(c.baseVolumeRaw),
    };
  });
}
