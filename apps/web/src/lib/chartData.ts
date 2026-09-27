/**
 * Chart data conversion — the frontend's only contact with the display boundary.
 *
 * The exact → Number conversion itself is NOT reimplemented here: it happens
 * inside the protocol-client's `toChartSeries` / `toDisplayPrice`. This module
 * only (a) decides whether a series has an honest time axis, (b) maps the
 * protocol's bucket keys onto the charting library's `Time` type, and (c)
 * implements the incremental update used for live trades so the whole history
 * is never re-read per trade.
 *
 * All functions here are pure so they can be regression-tested without a DOM.
 */

import { toChartSeries, intervalSupport, type CandleInterval, type OhlcvCandle, type TimeSource } from '@tari-ootle/protocol-client';

export const CHART_INTERVALS: readonly CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export interface ChartTimeBasis {
  /**
   * 'WALL_CLOCK' — every candle has a genuine consensus timestamp, so a real
   * time axis is representable.
   * 'EPOCH_ONLY'  — candles are aggregated by consensus epoch. There is no
   * trustworthy wall clock, so drawing a time axis would fabricate precision.
   * 'NONE'        — no candles at all.
   */
  kind: 'WALL_CLOCK' | 'EPOCH_ONLY' | 'NONE';
  reason?: string;
}

export function chartTimeBasis(candles: readonly OhlcvCandle[]): ChartTimeBasis {
  if (candles.length === 0) return { kind: 'NONE', reason: 'No candles have been aggregated for this pool yet.' };
  if (candles.every((c) => c.bucketKind === 'TIME')) return { kind: 'WALL_CLOCK' };
  if (candles.every((c) => c.bucketKind === 'EPOCH')) {
    return {
      kind: 'EPOCH_ONLY',
      reason:
        'This market-data source exposes consensus epoch boundaries but no consensus wall-clock timestamp. A time axis would have to be invented, so the series is shown as an epoch-indexed table instead of a fabricated chart.',
    };
  }
  return { kind: 'EPOCH_ONLY', reason: 'Mixed candle time bases; no single honest time axis is representable.' };
}

/**
 * Display-number series in protocol order. `Number` precision loss is
 * inherited from the protocol-client boundary and is confined to this value.
 */
export interface ChartCandleDisplay {
  /** lightweight-charts `UTCTimestamp` (seconds) or epoch bucket as an ordinal. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Raw base volume, kept for the tooltip so the number stays exact in text. */
  baseVolumeRaw: string;
  bucketStart: string;
  partial: boolean;
  tradeCount: number;
}

const MS_PER_SECOND = 1000n;

export class ChartBasisError extends Error {}

/**
 * Convert exact candles to chart points. Throws `ChartBasisError` when the
 * series has no honest wall-clock basis, because the caller must then render a
 * structured unavailable state rather than a fabricated axis.
 */
export function toChartCandles(candles: readonly OhlcvCandle[], maxSignificantDigits = 12): ChartCandleDisplay[] {
  const basis = chartTimeBasis(candles);
  if (basis.kind !== 'WALL_CLOCK') {
    throw new ChartBasisError(basis.reason ?? 'Candle series has no wall-clock time basis.');
  }
  // The single sanctioned exact → display conversion.
  const points = toChartSeries([...candles], { maxSignificantDigits });
  return points.map((point, index) => {
    const candle = candles[index];
    // A malformed bucket key is a hostile-input condition, not a crash. Report
    // it as a chart-basis failure so the caller shows a structured state rather
    // than an unhandled SyntaxError from BigInt().
    let seconds: number;
    try {
      const ms = BigInt(point.time);
      if (ms <= 0n) throw new Error('non-positive');
      seconds = Number(ms / MS_PER_SECOND);
    } catch {
      throw new ChartBasisError(`Candle ${index} has a malformed bucket key (${String(point.time)}); the series cannot be placed on a time axis.`);
    }
    if (!Number.isSafeInteger(seconds)) {
      throw new ChartBasisError(`Candle ${index} bucket key exceeds the chart time range.`);
    }
    return {
      time: seconds,
      open: point.open,
      high: point.high,
      low: point.low,
      close: point.close,
      volume: point.volume,
      baseVolumeRaw: candle.baseVolumeRaw,
      bucketStart: candle.bucketStart,
      partial: candle.partial,
      tradeCount: candle.tradeCount,
    };
  });
}

/**
 * Incremental candle update for a live trade.
 *
 * A trade in the newest open bucket REPLACES that bucket; a trade in an older
 * bucket requires a targeted rebuild of that bucket, which the store already
 * does. The frontend therefore only ever mutates the tail — it never re-reads
 * or re-aggregates the whole history.
 *
 * Duplicate and late updates: the caller passes the store's authoritative
 * replacement candle, so applying it twice is idempotent.
 */
export function applyTailUpdate(current: readonly ChartCandleDisplay[], replacement: ChartCandleDisplay): ChartCandleDisplay[] {
  if (current.length === 0) return [replacement];
  const last = current[current.length - 1];
  if (replacement.time < last.time) {
    // Older bucket: the series is left untouched here. The store is the only
    // authority for historical rebuilds, and the UI is told to refresh.
    return [...current];
  }
  if (replacement.time === last.time) {
    return [...current.slice(0, -1), replacement];
  }
  return [...current, replacement];
}

export interface IntervalAvailability {
  interval: CandleInterval;
  supported: boolean;
  basis?: 'CONSENSUS_TIMESTAMP' | 'EPOCH_BOUNDARY';
  /** Why the interval is unsupported. Present only when `supported` is false. */
  reason?: string;
}

/** Delegates to the protocol-client. The frontend never invents interval support. */
export function checkIntervalSupport(
  interval: CandleInterval,
  options: { timeSource: TimeSource; epochDurationMs?: string },
): IntervalAvailability {
  const support = intervalSupport(interval, options);
  if (support.supported) return { interval, supported: true, basis: support.basis };
  return { interval, supported: false, reason: support.reason };
}

export function supportedIntervals(options: { timeSource: TimeSource; epochDurationMs?: string }): IntervalAvailability[] {
  return CHART_INTERVALS.map((interval) => checkIntervalSupport(interval, options));
}

// ---------------------------------------------------------------------------
// Chart state machine
// ---------------------------------------------------------------------------

export type ChartState =
  | 'LOADING'
  | 'LIVE'
  | 'STALE'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'EMPTY_MARKET'
  | 'NO_TRADES_YET';

export interface ChartStateResolution {
  state: ChartState;
  headline: string;
  detail: string;
  /** Whether the chart canvas should be mounted at all. */
  renderCanvas: boolean;
}

export interface ChartStateInput {
  loading: boolean;
  /** Market-data health, straight from the query API. */
  health: { status: 'SYNCED' | 'SYNCING' | 'STALE' | 'DEGRADED' | 'UNAVAILABLE'; reason?: string; source: string };
  candleCount: number;
  tradeCount: number;
  basis: ChartTimeBasis;
  subscribed: boolean;
}

/**
 * Precedence is deliberate: a hard UNAVAILABLE health outranks a stale one, an
 * empty market is distinguishable from a source that has never produced a
 * trade, and a fabricated chart is never rendered.
 */
export function resolveChartState(input: ChartStateInput): ChartStateResolution {
  const { health, basis } = input;
  if (health.status === 'UNAVAILABLE') {
    return {
      state: 'UNAVAILABLE',
      headline: 'Market data unavailable',
      detail: health.reason ?? `The market-data source "${health.source}" is not reporting.`,
      renderCanvas: false,
    };
  }
  if (input.loading) {
    return { state: 'LOADING', headline: 'Loading market data', detail: 'Reading candles and interval support from the market-data query API.', renderCanvas: false };
  }
  if (input.candleCount === 0) {
    if (input.tradeCount === 0) {
      return {
        state: 'NO_TRADES_YET',
        headline: 'No trades yet',
        detail: 'This pool has no settled trade in the indexed window, so no candle can be drawn. The rest of the page remains usable.',
        renderCanvas: false,
      };
    }
    return {
      state: 'EMPTY_MARKET',
      headline: 'No candles for this interval',
      detail: 'Trades exist for this pool but none fall in a bucket for the selected interval.',
      renderCanvas: false,
    };
  }
  if (basis.kind !== 'WALL_CLOCK') {
    return {
      state: 'DEGRADED',
      headline: 'Chart not available for this source',
      detail: basis.reason ?? 'The candle series has no honest time axis.',
      renderCanvas: false,
    };
  }
  if (health.status === 'STALE') {
    return {
      state: 'STALE',
      headline: 'Market data is stale',
      detail: health.reason ?? 'The market-data source has not confirmed a recent sync. Values shown are the last confirmed data and may be behind the chain.',
      renderCanvas: true,
    };
  }
  if (health.status === 'DEGRADED') {
    return {
      state: 'DEGRADED',
      headline: 'Market data degraded',
      detail: health.reason ?? 'The market-data source is reporting reduced fidelity.',
      renderCanvas: true,
    };
  }
  if (!input.subscribed) {
    return {
      state: 'DEGRADED',
      headline: 'Live updates not connected',
      detail: 'Showing the last confirmed series. Live subscription is reconnecting.',
      renderCanvas: true,
    };
  }
  return { state: 'LIVE', headline: 'Live', detail: 'Streaming confirmed market data.', renderCanvas: true };
}
