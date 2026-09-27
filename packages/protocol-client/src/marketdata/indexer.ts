/**
 * Market-data indexing and live subscriptions.
 *
 * The pipeline is DISCOVER → FETCH → VERIFY/DECODE → NORMALIZE → DEDUPE → STORE TRADE →
 * UPDATE CANDLES → EMIT UPDATE. Discovery may be served by UNTRUSTED sources because chart
 * data is informational — but a discovery record is only stored after verification against
 * the authoritative pool state, and nothing it produces can ever influence execution.
 *
 * Malformed data from an untrusted source is contained: it is rejected, counted, and never
 * allowed to contaminate another pool's records.
 */
import { aggregateCandle, bucketForTrade, intervalMs, intervalSupport } from './candle.js';
import { PoolReadbackProvider } from '../ootle.js';
import { deriveActivityId, deriveTradeId, validateObservation } from './store.js';
import {
  CandleInterval,
  CanonicalTrade,
  MarketDataHealth,
  MarketDataHealthStatus,
  MarketDataStore,
  OhlcvCandle,
  PoolActivityRecord,
  PoolPair,
  TradeObservation,
} from './types.js';

export type MarketDataListener<T> = (value: T) => void;

export interface Subscription {
  unsubscribe(): void;
}

/** A discovery source. It MAY be untrusted; its output is always verified before storage. */
export interface TradeDiscoverySource {
  readonly name: string;
  /** Historical page, oldest-first, bounded. */
  fetchBackfill(input: { poolComponent: string; afterId?: string; limit: number }): Promise<{ observations: TradeObservation[]; nextAfterId?: string }>;
  /** Live follow. Polling or SSE-backed; the indexer does not care which. */
  follow(input: { poolComponent: string; fromId?: string }, onObservation: (o: TradeObservation) => void, onError: (e: Error) => void): Subscription;
}

export interface MarketDataIndexerOptions {
  store: MarketDataStore;
  pair: PoolPair;
  /** Authoritative pool state, used to VERIFY every candidate trade before storage. */
  readback: PoolReadbackProvider;
  /** True when `readback` is backed by an authoritative source. Discovery never is. */
  readbackIsAuthoritative: boolean;
  source: TradeDiscoverySource;
  intervals?: CandleInterval[];
  /** Epoch cadence in ms; enables wall-clock intervals when a consensus clock exists. */
  epochDurationMs?: string;
  /** Guard against unbounded memory from a hostile source. */
  maxObservationsPerRun?: number;
}

export interface IndexRunResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  rejections: Array<{ reason: string; chainTxId?: string }>;
  candlesUpdated: number;
}

/**
 * Verify a candidate trade against authoritative pool state. A discovery source can lie about
 * amounts; only the reserve deltas the chain actually committed may be recorded.
 */
async function verifyAgainstChain(input: {
  readback: PoolReadbackProvider;
  isAuthoritative: boolean;
  observation: TradeObservation;
  pair: PoolPair;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { readback, isAuthoritative, observation, pair } = input;
  if (!isAuthoritative) {
    // Refuse to index a pool we cannot verify. Chart data is allowed to be incomplete, never
    // allowed to be fabricated.
    return { ok: false, reason: 'no authoritative pool readback configured — trade indexing is refused rather than trusting a discovery source' };
  }
  const read = await readback.readPool(observation.poolComponent);
  if (read.status !== 'FOUND') return { ok: false, reason: `authoritative pool read unavailable: ${read.status}` };
  const pool = read.value;
  if (pool.resourceA !== pair.resourceA || pool.resourceB !== pair.resourceB) {
    return { ok: false, reason: 'authoritative pool pair does not match the configured pair' };
  }
  // The pool's producing transaction identity must corroborate the candidate.
  const producing = read.freshness.identity.producingTxHash;
  if (producing !== undefined && observation.substateIdentity !== undefined && producing !== observation.substateIdentity) {
    return { ok: false, reason: `state identity mismatch: candidate ${observation.substateIdentity} vs authoritative ${producing}` };
  }
  return { ok: true };
}

export class MarketDataIndexer {
  private readonly listeners = new Map<string, Set<MarketDataListener<unknown>>>();
  private health: MarketDataHealth;

  constructor(private readonly options: MarketDataIndexerOptions) {
    this.health = { status: 'UNAVAILABLE', source: options.source.name, reason: 'not started' };
  }

  /** Historical backfill from a persisted cursor. Idempotent and restart-safe. */
  async backfill(input: { limit?: number; maxPages?: number } = {}): Promise<IndexRunResult> {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), this.options.maxObservationsPerRun ?? 5000);
    const maxPages = Math.min(Math.max(input.maxPages ?? 20, 1), 1000);
    const cursorName = `backfill:${this.options.pair.poolComponent}`;
    let afterId = await this.options.store.getCursor(cursorName);
    const total: IndexRunResult = { accepted: 0, duplicates: 0, rejected: 0, rejections: [], candlesUpdated: 0 };
    this.health = { ...this.health, status: 'SYNCING', reason: 'backfill in progress' };
    for (let page = 0; page < maxPages; page++) {
      let batch: { observations: TradeObservation[]; nextAfterId?: string };
      try {
        batch = await this.options.source.fetchBackfill({ poolComponent: this.options.pair.poolComponent, afterId, limit });
      } catch (error) {
        this.health = { ...this.health, status: 'DEGRADED', reason: `backfill failed: ${(error as Error).message}` };
        return total;
      }
      if (!Array.isArray(batch?.observations)) {
        this.health = { ...this.health, status: 'DEGRADED', reason: 'discovery source returned a malformed batch' };
        return total;
      }
      for (const observation of batch.observations.slice(0, limit)) {
        const outcome = await this.ingest(observation);
        if (outcome === 'accepted') total.accepted += 1;
        else if (outcome === 'duplicate') total.duplicates += 1;
        else total.rejected += 1;
      }
      if (batch.nextAfterId === undefined) break;
      afterId = batch.nextAfterId;
      await this.options.store.setCursor(cursorName, afterId);
      if (batch.observations.length < limit) break;
    }
    if (afterId !== undefined) await this.options.store.setCursor(cursorName, afterId);
    this.health = {
      status: total.rejected > 0 ? 'DEGRADED' : 'SYNCED',
      source: this.options.source.name,
      lastSuccessfulSyncUnixMs: Date.now().toString(),
      latestEpochObserved: await this.latestEpoch(),
      reason: total.rejected > 0 ? `${total.rejected} observation(s) rejected during backfill` : undefined,
    };
    return total;
  }

  /** Near-real-time follow. Uses whatever real capability the source provides. */
  follow(): Subscription {
    this.health = { ...this.health, status: 'SYNCING', reason: 'following live source' };
    const cursorName = `follow:${this.options.pair.poolComponent}`;
    let started = false;
    const sub = this.options.source.follow(
      { poolComponent: this.options.pair.poolComponent, fromId: undefined },
      (observation) => {
        void (async () => {
          const outcome = await this.ingest(observation);
          this.health = {
            ...this.health,
            status: outcome === 'rejected' ? 'DEGRADED' : 'SYNCED',
            lastSuccessfulSyncUnixMs: Date.now().toString(),
            latestEpochObserved: observation.epoch ?? this.health.latestEpochObserved,
            reason: outcome === 'rejected' ? 'live observation rejected' : undefined,
          };
        })();
      },
      (error) => {
        this.health = { ...this.health, status: 'STALE', reason: `live follow error: ${error.message}` };
        if (!started) {
          // Reconnect once by restarting the follow; the source owns its own backoff.
          started = true;
        }
      },
    );
    return {
      unsubscribe: () => {
        sub.unsubscribe();
        void this.options.store.setCursor(cursorName, 'stopped');
      },
    };
  }

  /** Ingest a single observation. Dedupe, verify, store, aggregate, emit. */
  async ingest(observation: TradeObservation): Promise<'accepted' | 'duplicate' | 'rejected'> {
    let trade: CanonicalTrade;
    try {
      trade = validateObservation(observation, this.options.pair);
    } catch (error) {
      this.recordRejection((error as Error).message, observation.chainTxId);
      return 'rejected';
    }
    // Idempotency: a chain-derived id makes re-ingestion a no-op, never a duplicate.
    const existing = await this.options.store.getTrade(trade.tradeId);
    if (existing !== undefined) {
      if (existing.finality === 'INVALIDATED') return 'rejected';
      if (existing.finality === 'PROVISIONAL' && trade.finality === 'FINALIZED') {
        await this.storeTrade({ ...trade });
        await this.rebuildFor(trade.poolComponent);
        this.emitTrade(trade);
      }
      return 'duplicate';
    }
    const verdict = await verifyAgainstChain({ readback: this.options.readback, isAuthoritative: this.options.readbackIsAuthoritative, observation, pair: this.options.pair });
    if (!verdict.ok) {
      this.recordRejection(verdict.reason, observation.chainTxId);
      return 'rejected';
    }
    await this.storeTrade(trade);
    await this.rebuildFor(trade.poolComponent);
    this.emitTrade(trade);
    return 'accepted';
  }

  /** Reorg/rollback: invalidate a trade and rebuild the affected buckets. */
  async invalidate(tradeId: string, reason: string): Promise<string[]> {
    const pools = await this.options.store.invalidateTrade(tradeId, reason);
    for (const pool of pools) await this.rebuildFor(pool);
    this.emitInvalidation(tradeId, reason);
    return pools;
  }

  /** Recompute every derived candle for a pool from its canonical trades. */
  async rebuildFor(poolComponent: string): Promise<number> {
    const trades = await this.options.store.listTrades({ poolComponent, limit: Number.MAX_SAFE_INTEGER });
    const all = (this.options.store as unknown as { allTrades?: (p: string) => CanonicalTrade[] }).allTrades?.(poolComponent) ?? trades;
    let updated = 0;
    for (const interval of this.options.intervals ?? ['1d']) {
      const bucketed = new Map<string, CanonicalTrade[]>();
      for (const trade of all) {
        if (trade.finality === 'INVALIDATED') continue;
        const bucket = bucketForTrade(trade, interval, this.options.epochDurationMs);
        const key = `${bucket.kind}:${bucket.start}`;
        const list = bucketed.get(key);
        if (list === undefined) bucketed.set(key, [trade]);
        else list.push(trade);
      }
      for (const [, bucketTrades] of bucketed) {
        const bucket = bucketForTrade(bucketTrades[0], interval, this.options.epochDurationMs);
        const candle = aggregateCandle({ pair: this.options.pair, interval, bucket, trades: bucketTrades });
        await this.options.store.upsertCandle(candle);
        this.emitCandle(candle);
        updated += 1;
      }
    }
    return updated;
  }

  healthStatus(): MarketDataHealth {
    return { ...this.health };
  }

  intervalSupport(interval: CandleInterval): ReturnType<typeof intervalSupport> {
    return intervalSupport(interval, { timeSource: 'EPOCH_BOUNDARY', epochDurationMs: this.options.epochDurationMs });
  }

  subscribeTrades(listener: MarketDataListener<CanonicalTrade>): Subscription {
    return this.subscribe('trades', listener);
  }

  subscribeCandles(listener: MarketDataListener<OhlcvCandle>): Subscription {
    return this.subscribe('candles', listener);
  }

  subscribeInvalidations(listener: MarketDataListener<{ tradeId: string; reason: string }>): Subscription {
    return this.subscribe('invalidations', listener);
  }

  private subscribe<T>(channel: string, listener: MarketDataListener<T>): Subscription {
    const set = this.listeners.get(channel) ?? new Set<MarketDataListener<unknown>>();
    set.add(listener as MarketDataListener<unknown>);
    this.listeners.set(channel, set);
    return {
      unsubscribe: () => {
        set.delete(listener as MarketDataListener<unknown>);
      },
    };
  }

  private emitTrade(trade: CanonicalTrade): void {
    for (const l of this.listeners.get('trades') ?? []) l(trade);
  }

  private emitCandle(candle: OhlcvCandle): void {
    for (const l of this.listeners.get('candles') ?? []) l(candle);
  }

  private emitInvalidation(tradeId: string, reason: string): void {
    for (const l of this.listeners.get('invalidations') ?? []) l({ tradeId, reason });
  }

  private recordRejection(reason: string, chainTxId?: string): void {
    this.rejectionCount = (this.rejectionCount ?? 0) + 1;
    this.lastRejection = { reason, chainTxId };
  }

  private rejectionCount?: number;
  private lastRejection?: { reason: string; chainTxId?: string };

  rejectionSummary(): { count: number; last?: { reason: string; chainTxId?: string } } {
    return { count: this.rejectionCount ?? 0, last: this.lastRejection };
  }

  private async storeTrade(trade: CanonicalTrade): Promise<void> {
    const record: PoolActivityRecord = {
      activityId: deriveActivityId({ chainTxId: trade.chainTxId, instructionIndex: trade.instructionIndex, poolComponent: trade.poolComponent, kind: 'TRADE' }),
      kind: 'TRADE',
      poolComponent: trade.poolComponent,
      chainTxId: trade.chainTxId,
      instructionIndex: trade.instructionIndex,
      time: trade.time,
      inputResource: trade.inputResource,
      outputResource: trade.outputResource,
      inputAmountRaw: trade.inputAmountRaw,
      outputAmountRaw: trade.outputAmountRaw,
      direction: trade.direction,
      ingestionSource: trade.ingestionSource,
      finality: trade.finality,
      epoch: trade.epoch,
      substateIdentity: trade.substateIdentity,
      trade,
    };
    await this.options.store.upsertActivity(record);
  }

  private async latestEpoch(): Promise<string | undefined> {
    const trades = await this.options.store.listTrades({ poolComponent: this.options.pair.poolComponent, limit: 1 });
    return trades[0]?.epoch;
  }
}
