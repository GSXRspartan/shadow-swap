/**
 * Canonical market-data types: pool activity records, trades, candles, metrics, health, and
 * the frontend-facing read models.
 *
 * HARD BOUNDARY (mission §34): everything in this module is INFORMATIONAL. No type here may
 * be used to set an execution amount, a min_output, to select a resource, to create a
 * settlement proof, or to trigger a hop. Execution always rereads the chain authoritatively
 * (`resolveSwap` / `verifyTerminalSettlementProof`).
 */

import { PriceRational } from './price.js';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Where a trade's time came from. `LOCAL_RECEIPT` and `INDEXER_OBSERVED` are NOT consensus
 * time and are never used for wall-clock candles.
 */
export type TimeSource = 'CONSENSUS_TIMESTAMP' | 'EPOCH_BOUNDARY' | 'INDEXER_OBSERVED' | 'LOCAL_RECEIPT';

export interface TradeTime {
  /** Bucket key. For EPOCH_BOUNDARY this is the epoch; for wall clock, Unix ms. */
  bucketKey: string;
  source: TimeSource;
  /** Only set when source is CONSENSUS_TIMESTAMP. */
  unixMs?: string;
  /** Local observation time (INDEXER_OBSERVED / LOCAL_RECEIPT only), informational. */
  observedAtUnixMs?: string;
  /** Consensus epoch at which the trade committed, when known. */
  epoch?: string;
}

// ---------------------------------------------------------------------------
// Pool identity / pair metadata
// ---------------------------------------------------------------------------

export type AssetSafetyClass = 'CANONICAL_TARI' | 'PUBLIC_IMMUTABLE_OR_VETTED' | 'ISSUER_CONTROLLED' | 'UNKNOWN';

/**
 * Deterministic, stable pair orientation. The engine orders the pair; analytics normalize to
 * BASE/QUOTE. The canonical orientation is derived from the exact ResourceAddresses (never
 * labels), so it is stable across restarts and independent of ingest order.
 */
export interface PoolPair {
  poolComponent: string;
  /** Exact addresses, engine-canonical ordering. */
  resourceA: string;
  resourceB: string;
  /** BASE = resourceA, QUOTE = resourceB unless the pool declares otherwise. */
  baseResource: string;
  quoteResource: string;
  baseDecimals: string;
  quoteDecimals: string;
  safetyClass: AssetSafetyClass;
  /** Display-only preferred orientation; never changes stored economics. */
  displayBaseResource?: string;
  displayQuoteResource?: string;
  labelA?: string;
  labelB?: string;
}

export type TradeDirection = 'BASE_TO_QUOTE' | 'QUOTE_TO_BASE';

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export type PoolActivityKind = 'TRADE' | 'ADD_LIQUIDITY' | 'REMOVE_LIQUIDITY';
export type TradeFinality = 'PROVISIONAL' | 'FINALIZED' | 'INVALIDATED';

export interface PoolActivityRecord {
  /** Stable, chain-derived identity. Never random. */
  activityId: string;
  kind: PoolActivityKind;
  poolComponent: string;
  chainTxId: string;
  /** Instruction/leg index when a transaction has more than one pool operation. */
  instructionIndex: string;
  time: TradeTime;
  /** Exact addresses as the underlying operation used them. */
  inputResource: string;
  outputResource: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  direction: TradeDirection;
  /** Ingestion provenance. Discovery sources never upgrade to authoritative. */
  ingestionSource: string;
  finality: TradeFinality;
  /** Epoch / state version identity when the source exposed it. */
  epoch?: string;
  substateIdentity?: string;
  /** Reason for invalidation, when INVALIDATED. */
  invalidationReason?: string;
  /** Trade-only fields. */
  trade?: CanonicalTrade;
}

/** An immutable, canonical fungible swap record. */
export interface CanonicalTrade {
  tradeId: string;
  poolComponent: string;
  chainTxId: string;
  instructionIndex: string;
  epoch?: string;
  substateIdentity?: string;
  time: TradeTime;
  /** Exact resource addresses. */
  inputResource: string;
  outputResource: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  reserveABefore: string;
  reserveBBefore: string;
  reserveAAfter: string;
  reserveBAfter: string;
  feeBps: string;
  direction: TradeDirection;
  /** Quote-per-base execution price, exact. */
  executionPrice: PriceRational;
  /**
   * Trader identity ONLY when actually public and needed. Omitted otherwise — stealth and
   * confidential addresses must never be deanonymised for a chart.
   */
  traderIdentity?: string;
  ingestionSource: string;
  finality: TradeFinality;
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export type IntervalSupport =
  | { supported: true; basis: 'CONSENSUS_TIMESTAMP' | 'EPOCH_BOUNDARY' }
  | { supported: false; reason: string };

export interface OhlcvCandle {
  poolComponent: string;
  baseResource: string;
  quoteResource: string;
  interval: CandleInterval;
  /** Bucket start key: Unix ms for consensus time, epoch number for epoch buckets. */
  bucketStart: string;
  bucketEnd: string;
  open: PriceRational;
  high: PriceRational;
  low: PriceRational;
  close: PriceRational;
  /** Base volume = actual settled base amounts. */
  baseVolumeRaw: string;
  /** Quote volume = actual settled quote amounts. */
  quoteVolumeRaw: string;
  tradeCount: number;
  firstTradeId: string;
  lastTradeId: string;
  /** True when the bucket is still open (may gain trades). */
  partial: boolean;
  /** LP fees retained in this bucket (from actual inputs and fee_bps). */
  feesGeneratedBaseRaw?: string;
  buyBaseVolumeRaw?: string;
  sellBaseVolumeRaw?: string;
  /** Whether the bucket is time-based (wall clock) or epoch-based. */
  bucketKind: 'TIME' | 'EPOCH';
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface PoolMetrics {
  poolComponent: string;
  pair: PoolPair;
  currentPrice?: PriceRational;
  priceChange24h?: { value: PriceRational; direction: 'UP' | 'DOWN' | 'FLAT' | 'UNAVAILABLE'; reason?: string };
  baseVolume24hRaw?: string;
  quoteVolume24hRaw?: string;
  tradeCount24h?: number;
  /** LP fees only. Never labelled protocol/developer revenue. */
  lpFees24hBaseRaw?: string;
  currentReserves?: { reserveA: string; reserveB: string };
  /** Native quantities only. No fiat TVL is invented. */
  liquidityNative?: { baseRaw: string; quoteRaw: string; label: 'NATIVE_QUANTITIES' };
  health: MarketDataHealth;
}

export type MarketDataHealthStatus = 'SYNCED' | 'SYNCING' | 'STALE' | 'DEGRADED' | 'UNAVAILABLE';

export interface MarketDataHealth {
  status: MarketDataHealthStatus;
  source: string;
  lastSuccessfulSyncUnixMs?: string;
  latestEpochObserved?: string;
  /** Measured lag in the source's own units, when measurable. */
  lag?: string;
  lagUnit?: 'EPOCH' | 'EVENT_ID' | 'MILLIS';
  reason?: string;
}

// ---------------------------------------------------------------------------
// Store + indexer contracts
// ---------------------------------------------------------------------------

export interface MarketDataStore {
  upsertActivity(record: PoolActivityRecord): Promise<{ inserted: boolean; updated: boolean }>;
  getActivity(activityId: string): Promise<PoolActivityRecord | undefined>;
  getTrade(tradeId: string): Promise<CanonicalTrade | undefined>;
  listTrades(filter: { poolComponent: string; limit: number; beforeBucketKey?: string }): Promise<CanonicalTrade[]>;
  listActivity(filter: { poolComponent: string; limit: number }): Promise<PoolActivityRecord[]>;
  /** Candles are DERIVED and always rebuildable from activity records. */
  upsertCandle(candle: OhlcvCandle): Promise<void>;
  listCandles(filter: { poolComponent: string; interval: CandleInterval; limit: number }): Promise<OhlcvCandle[]>;
  deleteCandles(poolComponent: string, interval: CandleInterval): Promise<number>;
  /** Invalidate a trade (reorg) and report which pools/candles are affected. */
  invalidateTrade(tradeId: string, reason: string): Promise<string[]>;
  getCursor(name: string): Promise<string | undefined>;
  setCursor(name: string, value: string): Promise<void>;
  /** Provenance: which sources contributed. */
  sources(): string[];
  /** All canonical trades for a pool, ordered, for a full rebuild or metrics. */
  listAllTrades(poolComponent: string): Promise<CanonicalTrade[]>;
}

export interface TradeObservation {
  /** Chain-derived identity inputs. */
  chainTxId: string;
  instructionIndex: string;
  poolComponent: string;
  inputResource: string;
  outputResource: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  reserveABefore: string;
  reserveBBefore: string;
  reserveAAfter: string;
  reserveBAfter: string;
  feeBps: string;
  epoch?: string;
  substateIdentity?: string;
  time: TradeTime;
  traderIdentity?: string;
  source: string;
  /** Producer-side hint; a FINALIZED trade may still be invalidated later. */
  finality?: TradeFinality;
}

// ---------------------------------------------------------------------------
// Frontend read models
// ---------------------------------------------------------------------------

export interface PoolPageHeaderView {
  poolComponent: string;
  pair: PoolPair;
  currentPrice?: PriceRational;
  priceChange24h: { direction: 'UP' | 'DOWN' | 'FLAT' | 'UNAVAILABLE'; percentDisplay?: string; reason?: string };
  baseVolume24hRaw?: string;
  quoteVolume24hRaw?: string;
  tradeCount24h?: number;
  lpFees24hBaseRaw?: string;
  liquidityNative?: { baseRaw: string; quoteRaw: string };
  health: MarketDataHealth;
  /** Chart values never carry authority. */
  informationalOnly: true;
}

export interface CandleSeriesView {
  poolComponent: string;
  interval: CandleInterval;
  support: IntervalSupport;
  candles: OhlcvCandle[];
}

export interface TradeListPage {
  trades: CanonicalTrade[];
  nextBeforeBucketKey?: string;
  hasMore: boolean;
}

export interface PoolActivityPage {
  activity: PoolActivityRecord[];
  hasMore: boolean;
}

/** TradingView-style point. Display conversion happens HERE, deliberately. */
export interface ChartCandlePoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
