/**
 * Market-data service.
 *
 * Owns the `MarketDataStore`, the `MarketDataIndexer` per pool, and the
 * `MarketDataQueryApi` the UI reads. It wires existing protocol interfaces; it
 * implements no aggregation, no pricing, and no interval policy of its own.
 *
 * TRUST BOUNDARY: everything produced here is informational. The service
 * returns `MarketDataHealth` verbatim and never exposes a method that mutates an
 * execution amount.
 */

import {
  InMemoryMarketDataStore,
  MarketDataIndexer,
  createMarketDataQueryApi,
  type MarketDataQueryApi,
  type MarketDataHealth,
  type MarketDataStore,
  type OhlcvCandle,
  type CanonicalTrade,
  type Subscription,
  type TradeDiscoverySource,
  type TradeObservation,
  type PoolReadbackProvider,
} from '@tari-ootle/protocol-client';
import { CHART_INTERVALS } from '../lib/chartData.js';
import type { PoolDescriptor } from './pools.js';

const UNAVAILABLE_HEALTH: MarketDataHealth = {
  status: 'UNAVAILABLE',
  source: 'none',
  reason: 'No market-data discovery source is configured for this build.',
};

export interface MarketDataBundle {
  store: MarketDataStore;
  query: MarketDataQueryApi;
  indexer?: MarketDataIndexer;
  health(): MarketDataHealth;
  /** Replace the health record from an external signal (e.g. source outage). */
  setHealth(health: MarketDataHealth): void;
  subscribeCandles(listener: (candle: OhlcvCandle) => void): Subscription;
  subscribeTrades(listener: (trade: CanonicalTrade) => void): Subscription;
  subscribeInvalidations(listener: (event: { tradeId: string; reason: string }) => void): Subscription;
  /** Feed an observation directly (used by the in-app execution sink). */
  ingest(observation: TradeObservation): Promise<'accepted' | 'duplicate' | 'rejected'>;
  rebuild(poolComponent: string): Promise<number>;
}

export interface MarketDataServiceOptions {
  pools: readonly PoolDescriptor[];
  source?: TradeDiscoverySource;
  /**
   * Authoritative pool readback. When absent, the indexer refuses to store any
   * trade — chart data is allowed to be incomplete, never fabricated.
   */
  readback?: PoolReadbackProvider;
  readbackIsAuthoritative?: boolean;
  epochDurationMs?: string;
}

class Bundle implements MarketDataBundle {
  readonly store: MarketDataStore;
  readonly query: MarketDataQueryApi;
  readonly indexer?: MarketDataIndexer;
  private readonly subscriptions = new Map<string, Subscription>();
  private healthRecord: MarketDataHealth;

  constructor(
    pool: PoolDescriptor,
    options: MarketDataServiceOptions,
  ) {
    this.store = new InMemoryMarketDataStore();
    this.query = createMarketDataQueryApi({
      store: this.store,
      pairs: new Map([[pool.poolComponent, pool.pair]]),
    });
    this.healthRecord = { ...UNAVAILABLE_HEALTH, source: options.source?.name ?? 'none' };
    if (options.source !== undefined && options.readback !== undefined) {
      this.indexer = new MarketDataIndexer({
        store: this.store,
        pair: pool.pair,
        readback: options.readback,
        readbackIsAuthoritative: options.readbackIsAuthoritative === true,
        source: options.source,
        intervals: [...CHART_INTERVALS],
        epochDurationMs: options.epochDurationMs,
      });
      this.healthRecord = this.indexer.healthStatus();
      this.subscriptions.set('candles', this.indexer.subscribeCandles((candle) => this.emit('candles', candle)));
      this.subscriptions.set('trades', this.indexer.subscribeTrades((trade) => this.emit('trades', trade)));
      this.subscriptions.set('invalidations', this.indexer.subscribeInvalidations((event) => this.emit('invalidations', event)));
    }
  }

  private readonly listeners = new Map<string, Set<(value: never) => void>>();

  private emit(channel: string, value: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) (listener as (value: unknown) => void)(value);
  }

  health(): MarketDataHealth {
    const live = this.indexer?.healthStatus();
    if (live !== undefined) {
      this.healthRecord = { ...live };
      return this.healthRecord;
    }
    return this.healthRecord;
  }

  setHealth(health: MarketDataHealth): void {
    this.healthRecord = health;
  }

  subscribeCandles(listener: (candle: OhlcvCandle) => void): Subscription {
    return this.register('candles', listener);
  }

  subscribeTrades(listener: (trade: CanonicalTrade) => void): Subscription {
    return this.register('trades', listener);
  }

  subscribeInvalidations(listener: (event: { tradeId: string; reason: string }) => void): Subscription {
    return this.register('invalidations', listener);
  }

  private register<T>(channel: string, listener: (value: T) => void): Subscription {
    const set = this.listeners.get(channel) ?? new Set<(value: never) => void>();
    set.add(listener as unknown as (value: never) => void);
    this.listeners.set(channel, set);
    return {
      unsubscribe: () => {
        set.delete(listener as unknown as (value: never) => void);
      },
    };
  }

  async ingest(observation: TradeObservation): Promise<'accepted' | 'duplicate' | 'rejected'> {
    if (this.indexer === undefined) return 'rejected';
    return this.indexer.ingest(observation);
  }

  async rebuild(poolComponent: string): Promise<number> {
    if (this.indexer === undefined) return 0;
    return this.indexer.rebuildFor(poolComponent);
  }

  /** Tear down the underlying discovery subscription, if any. */
  stop(): void {
    this.subscriptions.get('candles')?.unsubscribe();
    this.subscriptions.get('trades')?.unsubscribe();
    this.subscriptions.get('invalidations')?.unsubscribe();
    this.subscriptions.clear();
  }
}

export class MarketDataService {
  private readonly bundles = new Map<string, Bundle>();

  constructor(private readonly options: MarketDataServiceOptions) {}

  bundleFor(poolComponent: string, pool: PoolDescriptor): MarketDataBundle {
    const existing = this.bundles.get(poolComponent);
    if (existing !== undefined) return existing;
    const created = new Bundle(pool, this.options);
    this.bundles.set(poolComponent, created);
    return created;
  }

  async backfill(bundle: MarketDataBundle, limit = 200): Promise<{ accepted: number; rejected: number }> {
    const indexer = bundle.indexer;
    if (indexer === undefined) return { accepted: 0, rejected: 0 };
    const result = await indexer.backfill({ limit });
    return { accepted: result.accepted, rejected: result.rejected };
  }

  follow(bundle: MarketDataBundle): Subscription | undefined {
    return bundle.indexer?.follow();
  }
}
