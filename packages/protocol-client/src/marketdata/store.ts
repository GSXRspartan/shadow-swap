/**
 * Market-data store: canonical activity records plus DERIVED candles.
 *
 * Candles are never authoritative and are always rebuildable from the activity records they
 * were derived from — that is what makes late/out-of-order ingestion and reorg invalidation
 * correct instead of approximate.
 */
import { aggregateCandle, bucketForTrade, candleKey, compareTradesForOrdering } from './candle.js';
import { priceFromSettled } from './price.js';
import {
  CandleInterval,
  CanonicalTrade,
  MarketDataStore,
  OhlcvCandle,
  PoolActivityKind,
  PoolActivityRecord,
  PoolPair,
  TradeDirection,
  TradeObservation,
} from './types.js';

/**
 * Stable, chain-derived trade id. NEVER random: the same confirmed transaction always
 * produces the same id, which is what makes re-ingestion idempotent.
 */
function epochKeyOf(trade: CanonicalTrade): bigint {
  return BigInt(trade.epoch ?? trade.time.epoch ?? trade.time.bucketKey);
}

export function deriveTradeId(observation: { chainTxId: string; instructionIndex: string; poolComponent: string }): string {
  return `${observation.chainTxId}:${observation.instructionIndex}:${observation.poolComponent}`;
}

export function deriveActivityId(observation: { chainTxId: string; instructionIndex: string; poolComponent: string; kind: PoolActivityKind }): string {
  return `${observation.chainTxId}:${observation.instructionIndex}:${observation.poolComponent}:${observation.kind}`;
}

/** Validate an untrusted observation before it may become a canonical record. */
export function validateObservation(observation: TradeObservation, pair: PoolPair): CanonicalTrade {
  const raw = (v: string, f: string): bigint => {
    if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(`${f} must be a raw non-negative integer string, got "${v}"`);
    const n = BigInt(v);
    if (n > (1n << 128n) - 1n) throw new Error(`${f} exceeds 128 bits`);
    return n;
  };
  if (typeof observation.chainTxId !== 'string' || observation.chainTxId.trim() === '') throw new Error('trade requires a chain transaction id');
  // A trade may only ever be recorded against the pool whose pair it is being validated
  // against. Without this, a discovery source could file another pool's trade here.
  if (observation.poolComponent !== pair.poolComponent) {
    throw new Error(`trade pool ${observation.poolComponent} does not match the indexed pool ${pair.poolComponent}`);
  }
  if (!/^\d+$/.test(observation.instructionIndex)) throw new Error('instructionIndex must be a non-negative integer string');
  if (!/^\d+$/.test(observation.feeBps) || BigInt(observation.feeBps) >= 10_000n) throw new Error('feeBps must be an integer below 10000');
  const input = raw(observation.inputAmountRaw, 'inputAmountRaw');
  const output = raw(observation.outputAmountRaw, 'outputAmountRaw');
  if (input === 0n || output === 0n) throw new Error('a trade with a zero amount is not a trade');
  const rABefore = raw(observation.reserveABefore, 'reserveABefore');
  const rBBefore = raw(observation.reserveBBefore, 'reserveBBefore');
  const rAAfter = raw(observation.reserveAAfter, 'reserveAAfter');
  const rBAfter = raw(observation.reserveBAfter, 'reserveBAfter');
  // Reserves must be strictly positive (an empty pool cannot produce a trade) and the
  // recorded direction must match this pool's pair exactly.
  if (rABefore === 0n || rBBefore === 0n || rAAfter === 0n || rBAfter === 0n) throw new Error('pool reserves must be positive for a trade record');
  const isAB = observation.inputResource === pair.resourceA && observation.outputResource === pair.resourceB;
  const isBA = observation.inputResource === pair.resourceB && observation.outputResource === pair.resourceA;
  if (!isAB && !isBA) throw new Error(`trade resources (${observation.inputResource} → ${observation.outputResource}) do not belong to pool ${pair.poolComponent}`);
  // The trade must be consistent with the recorded reserve movement: the output reserve can
  // never grow beyond what the input reserve supplied. This rejects impossible/hostile data.
  const reserveDelta = isAB ? rBAfter - rBBefore : rAAfter - rABefore;
  const outAmount = isAB ? output : input;
  const gain = reserveDelta > 0n ? reserveDelta : 0n;
  if (gain > outAmount) throw new Error('impossible reserves: the output reserve grew by more than the traded amount');
  // CONSTANT-PRODUCT INVARIANT (independently derived, not copied from the swap maths).
  //
  // For a swap the pool deposits the FULL input and withdraws exactly `output`, so
  //   k_after = (rA + in) * (rB - out)  >=  rA * rB = k_before
  // holds for every real trade, and strictly holds whenever a fee is retained. An
  // observation that violates it describes a price the pool could not have executed
  // at, which is exactly what a hostile or broken indexer would publish to paint a
  // chart. This is display-layer defence: it costs one exact integer comparison and
  // it keeps a fabricated price out of the candle series and the volume ranking.
  //
  // Deliberately NOT asserted: that the input reserve grew by exactly `input`. The
  // repository does not fix whether "before/after" brackets the swap instruction or
  // the whole transaction, and inventing that rule here would silently drop real
  // trades. The invariant above is true either way.
  if (rAAfter * rBAfter < rABefore * rBBefore) {
    throw new Error('impossible reserves: the trade would reduce the pool constant product');
  }
  const direction: TradeDirection = isAB ? 'BASE_TO_QUOTE' : 'QUOTE_TO_BASE';
  const baseIn = direction === 'BASE_TO_QUOTE' ? input : output;
  const quoteOut = direction === 'BASE_TO_QUOTE' ? output : input;
  const time = observation.time;
  if (time === undefined || typeof time.bucketKey !== 'string' || time.bucketKey === '') throw new Error('trade requires a time bucket key');
  if (observation.epoch === undefined && time.epoch === undefined && time.unixMs === undefined) {
    throw new Error('trade requires either an epoch or a consensus timestamp for bucketing');
  }
  return {
    tradeId: deriveTradeId(observation),
    poolComponent: observation.poolComponent,
    chainTxId: observation.chainTxId,
    instructionIndex: observation.instructionIndex,
    epoch: observation.epoch ?? time.epoch,
    substateIdentity: observation.substateIdentity,
    time,
    inputResource: observation.inputResource,
    outputResource: observation.outputResource,
    inputAmountRaw: observation.inputAmountRaw,
    outputAmountRaw: observation.outputAmountRaw,
    reserveABefore: rABefore.toString(),
    reserveBBefore: rBBefore.toString(),
    reserveAAfter: rAAfter.toString(),
    reserveBAfter: rBAfter.toString(),
    feeBps: observation.feeBps,
    direction,
    executionPrice: priceFromSettled({ quoteOutRaw: quoteOut.toString(), baseInRaw: baseIn.toString(), baseDecimals: pair.baseDecimals, quoteDecimals: pair.quoteDecimals }),
    traderIdentity: observation.traderIdentity,
    ingestionSource: observation.source,
    finality: observation.finality ?? 'PROVISIONAL',
  };
}

export class InMemoryMarketDataStore implements MarketDataStore {
  private readonly activity = new Map<string, PoolActivityRecord>();
  private readonly trades = new Map<string, CanonicalTrade>();
  private readonly candles = new Map<string, OhlcvCandle>();
  private readonly cursors = new Map<string, string>();
  private readonly sourceSet = new Set<string>();

  async upsertActivity(record: PoolActivityRecord): Promise<{ inserted: boolean; updated: boolean }> {
    const existing = this.activity.get(record.activityId);
    if (existing !== undefined) {
      // Idempotent re-ingestion: a confirmed record is never downgraded or duplicated.
      if (existing.finality === 'INVALIDATED' && record.finality !== 'INVALIDATED') {
        throw new Error(`activity ${record.activityId} was invalidated; it cannot be silently reinstated`);
      }
      const promoted = existing.finality === 'PROVISIONAL' && record.finality === 'FINALIZED';
      // A finalized record is never downgraded by a later provisional observation.
      const merged: PoolActivityRecord = existing.finality === 'FINALIZED' && record.finality !== 'FINALIZED' ? { ...record, finality: 'FINALIZED' } : record;
      this.activity.set(record.activityId, merged);
      this.sourceSet.add(record.ingestionSource);
      // The TRADE index must move with the activity, or candles and metrics would keep
      // reading a stale/provisional copy after a finality promotion.
      if (merged.trade !== undefined) this.trades.set(merged.trade.tradeId, merged.trade);
      return { inserted: false, updated: promoted || existing.trade?.tradeId !== record.trade?.tradeId || existing.finality !== merged.finality };
    }
    this.activity.set(record.activityId, record);
    this.sourceSet.add(record.ingestionSource);
    if (record.trade !== undefined) this.trades.set(record.trade.tradeId, record.trade);
    return { inserted: true, updated: false };
  }

  async getActivity(activityId: string): Promise<PoolActivityRecord | undefined> {
    const r = this.activity.get(activityId);
    return r === undefined ? undefined : { ...r };
  }

  async getTrade(tradeId: string): Promise<CanonicalTrade | undefined> {
    const t = this.trades.get(tradeId);
    return t === undefined ? undefined : { ...t };
  }

  async listTrades(filter: { poolComponent: string; limit: number; beforeBucketKey?: string }): Promise<CanonicalTrade[]> {
    const all = [...this.trades.values()].filter((t) => t.poolComponent === filter.poolComponent && t.finality !== 'INVALIDATED');
    all.sort(compareTradesForOrdering);
    // The cursor is only applied when supplied — evaluating BigInt(undefined) would throw.
    const cursor = filter.beforeBucketKey;
    const bounded = cursor === undefined ? all : all.filter((t) => epochKeyOf(t) < BigInt(cursor));
    return bounded.slice(-filter.limit).reverse().map((t) => ({ ...t }));
  }

  async listActivity(filter: { poolComponent: string; limit: number }): Promise<PoolActivityRecord[]> {
    return [...this.activity.values()].filter((a) => a.poolComponent === filter.poolComponent).slice(-filter.limit).reverse();
  }

  async upsertCandle(candle: OhlcvCandle): Promise<void> {
    this.candles.set(candleKey(candle), candle);
  }

  async listCandles(filter: { poolComponent: string; interval: CandleInterval; limit: number }): Promise<OhlcvCandle[]> {
    return [...this.candles.values()]
      .filter((c) => c.poolComponent === filter.poolComponent && c.interval === filter.interval)
      .sort((a, b) => (BigInt(a.bucketStart) < BigInt(b.bucketStart) ? -1 : BigInt(a.bucketStart) > BigInt(b.bucketStart) ? 1 : 0))
      .slice(-filter.limit);
  }

  async deleteCandles(poolComponent: string, interval: CandleInterval): Promise<number> {
    let n = 0;
    for (const [key, c] of [...this.candles.entries()]) {
      if (c.poolComponent === poolComponent && c.interval === interval) {
        this.candles.delete(key);
        n += 1;
      }
    }
    return n;
  }

  async invalidateTrade(tradeId: string, reason: string): Promise<string[]> {
    const trade = this.trades.get(tradeId);
    if (trade === undefined) return [];
    const invalidated: CanonicalTrade = { ...trade, finality: 'INVALIDATED', invalidationReason: reason } as CanonicalTrade;
    this.trades.set(tradeId, invalidated);
    const affected: string[] = [];
    for (const [id, record] of [...this.activity.entries()]) {
      if (record.trade?.tradeId === tradeId) {
        this.activity.set(id, { ...record, finality: 'INVALIDATED', invalidationReason: reason, trade: invalidated });
        affected.push(record.poolComponent);
      }
    }
    return [...new Set(affected)];
  }

  async getCursor(name: string): Promise<string | undefined> {
    return this.cursors.get(name);
  }

  async setCursor(name: string, value: string): Promise<void> {
    this.cursors.set(name, value);
  }

  sources(): string[] {
    return [...this.sourceSet].sort();
  }

  /** All canonical trades for a pool, for a full rebuild. */
  async listAllTrades(poolComponent: string): Promise<CanonicalTrade[]> {
    return [...this.trades.values()].filter((t) => t.poolComponent === poolComponent).sort(compareTradesForOrdering);
  }
}
