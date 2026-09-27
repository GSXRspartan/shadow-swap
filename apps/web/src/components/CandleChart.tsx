/**
 * Candlestick + volume chart.
 *
 * Chart lifecycle (mission §53): the chart and both series are created ONCE per
 * mount, historical data is set once with `fitContent`, and live trades are
 * applied with the incremental `series.update()` path. The whole history is
 * never re-set per trade.
 *
 * The chart is never rendered when there is no honest time axis — see
 * `resolveChartState`. Volume lives in a lower pane via the v5 `addPane()` API.
 *
 * `attributionLogo: true` is the licence-compliant TradingView attribution
 * (Apache-2.0 §"attribution notice"), backed by a visible footer link in
 * `AppShell`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { ChartCandleDisplay, ChartStateResolution } from '../lib/chartData.js';
import { formatNumber, UNAVAILABLE } from '../lib/format.js';
import { Badge, EmptyState, SegmentedControl } from './primitives.js';
import type { CandleInterval } from '@tari-ootle/protocol-client';

/**
 * Chart colours are declared as literals because lightweight-charts paints to a
 * canvas and cannot read CSS custom properties. They are kept in step with
 * `styles/tokens.css`: `UP`/`DOWN` mirror `--up`/`--down`, and the price line uses
 * the lime brand accent.
 */
const UP = '#35d69a';
const DOWN = '#fb7185';
const VOL_UP = 'rgba(53, 214, 154, 0.42)';
const VOL_DOWN = 'rgba(251, 113, 133, 0.42)';
const ACCENT = '#b7f04a';

const CHART_THEME = {
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: '#8b96a8',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 11,
    attributionLogo: true as const,
    panes: { separatorColor: '#1e2430', separatorHoverColor: '#29313f', enableResize: true },
  },
  grid: {
    vertLines: { color: 'rgba(30, 36, 48, 0.7)' },
    horzLines: { color: 'rgba(30, 36, 48, 0.7)' },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: '#3a4557', width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: '#1b2029' },
    horzLine: { color: '#3a4557', width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: '#1b2029' },
  },
  rightPriceScale: { borderColor: '#1e2430', scaleMargins: { top: 0.1, bottom: 0.1 } },
  timeScale: { borderColor: '#1e2430', rightOffset: 4, barSpacing: 8, minBarSpacing: 0.5, timeVisible: true, secondsVisible: false },
  localization: {
    priceFormatter: (price: number) => (price >= 1000 ? price.toFixed(0) : price >= 1 ? price.toFixed(4) : price.toPrecision(6)),
  },
  handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
  autoSize: false,
};

export interface ChartLegendRow {
  label: string;
  value: string;
  tone?: 'up' | 'down';
}

interface HoverState {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeRaw: string;
}

export function CandleChart({
  candles,
  interval,
  onIntervalChange,
  intervals,
  state,
  quoteSymbol,
  baseSymbol,
  lastPrice,
  priceDirection,
  height = 380,
}: {
  /** Full historical series. Changing identity triggers exactly one `setData`. */
  candles: readonly ChartCandleDisplay[];
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
  intervals: ReadonlyArray<{ interval: CandleInterval; supported: boolean; reason?: string }>;
  state: ChartStateResolution;
  quoteSymbol: string;
  baseSymbol: string;
  lastPrice: string;
  priceDirection: 'UP' | 'DOWN' | 'FLAT' | 'UNAVAILABLE';
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | undefined>(undefined);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | undefined>(undefined);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | undefined>(undefined);
  const appliedRef = useRef<readonly ChartCandleDisplay[] | undefined>(undefined);
  const [hover, setHover] = useState<HoverState | undefined>(undefined);

  // ---- create once -------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, CHART_THEME);
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dotted,
      priceLineColor: ACCENT,
      lastValueVisible: true,
    });
    candleSeriesRef.current = candleSeries;

    // Lower pane for volume, using the v5 pane API.
    const volumePane = chart.addPane();
    const volumeSeries = volumePane.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('right', 1).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    volumeSeriesRef.current = volumeSeries;

    const onCrosshair = (param: { time?: unknown; point?: { x: number; y: number }; seriesData?: Map<unknown, unknown> }) => {
      const time = param.time as number | undefined;
      if (time === undefined) {
        setHover(undefined);
        return;
      }
      const point = param.seriesData?.get(candleSeries) as { open?: number; high?: number; low?: number; close?: number; volume?: number } | undefined;
      if (point === undefined) {
        setHover(undefined);
        return;
      }
      const match = candlesRef.current.find((candle) => candle.time === time);
      setHover({
        time,
        open: point.open ?? 0,
        high: point.high ?? 0,
        low: point.low ?? 0,
        close: point.close ?? 0,
        volumeRaw: match?.baseVolumeRaw ?? UNAVAILABLE,
      });
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const width = Math.max(1, Math.floor(entry.contentRect.width));
      const nextHeight = Math.max(200, Math.floor(entry.contentRect.height));
      chartRef.current?.resize(width, nextHeight, false);
    });
    observer.observe(container);
    chart.resize(Math.max(1, container.clientWidth), height, false);

    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = undefined;
      candleSeriesRef.current = undefined;
      volumeSeriesRef.current = undefined;
      appliedRef.current = undefined;
    };
    // Intentionally mount-only: the chart is created once and driven
    // imperatively afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Latest candles for crosshair lookups without re-subscribing.
  const candlesRef = useRef<readonly ChartCandleDisplay[]>(candles);
  candlesRef.current = candles;

  // ---- data: set once, then incremental -----------------------------------
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (candleSeries === undefined || volumeSeries === undefined || chart === undefined) return;

    if (candles.length === 0) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
      appliedRef.current = candles;
      return;
    }

    const previous = appliedRef.current;
    if (previous === undefined || previous.length === 0) {
      candleSeries.setData(candles.map(toCandle));
      volumeSeries.setData(candles.map(toVolume));
      chart.timeScale().fitContent();
      appliedRef.current = candles;
      return;
    }

    const lastApplied = previous[previous.length - 1];
    const incoming = candles[candles.length - 1];
    // Only the tail is touched. A new bucket appends; the same bucket replaces.
    if (incoming !== undefined && lastApplied !== undefined && incoming.time >= lastApplied.time) {
      candleSeries.update(toCandle(incoming));
      volumeSeries.update(toVolume(incoming));
    } else {
      // The store replaced history (a rebuild or interval change): reset once.
      candleSeries.setData(candles.map(toCandle));
      volumeSeries.setData(candles.map(toVolume));
      chart.timeScale().fitContent();
    }
    appliedRef.current = candles;
  }, [candles]);

  // ---- last price line ---------------------------------------------------
  useEffect(() => {
    // The series draws its own current-price line from the last value, so the
    // headline price needs no imperative series work.
    void lastPrice;
  }, [lastPrice]);

  const legend = useMemo<ChartLegendRow[]>(() => {
    const o = hover?.open ?? candles[candles.length - 1]?.open;
    const h = hover?.high ?? candles[candles.length - 1]?.high;
    const l = hover?.low ?? candles[candles.length - 1]?.low;
    const c = hover?.close ?? candles[candles.length - 1]?.close;
    const base = `${baseSymbol}/${quoteSymbol}`;
    return [
      { label: 'Open', value: o === undefined ? UNAVAILABLE : `${formatNumber(o, 6)} ${base}` },
      { label: 'High', value: h === undefined ? UNAVAILABLE : `${formatNumber(h, 6)} ${base}` },
      { label: 'Low', value: l === undefined ? UNAVAILABLE : `${formatNumber(l, 6)} ${base}` },
      { label: 'Close', value: c === undefined ? UNAVAILABLE : `${formatNumber(c, 6)} ${base}` },
    ];
  }, [hover, candles, baseSymbol, quoteSymbol]);

  return (
    <div className="card card--flush" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="card__head" style={{ flexWrap: 'wrap', gap: 'var(--s-2)' }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-2)' }}>
          <SegmentedControl
            label="Chart interval"
            value={interval}
            onChange={onIntervalChange}
            options={intervals.map((entry) => ({
              value: entry.interval,
              label: entry.interval,
              disabled: !entry.supported,
              title: entry.supported ? undefined : (entry.reason ?? 'This interval is not supported by the market-data source.'),
            }))}
          />
          <Badge tone={state.state === 'LIVE' ? 'ok' : state.state === 'LOADING' ? 'info' : 'warn'}>{state.state.replace('_', ' ')}</Badge>
        </div>
        <div className="row" style={{ gap: 'var(--s-3)', flexWrap: 'wrap' }}>
          <span className="row" style={{ gap: 4 }}>
            <span className="label">Last</span>
            <span className={`num ${priceDirection === 'UP' ? 'up' : priceDirection === 'DOWN' ? 'down' : ''}`.trim()} style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>
              {lastPrice}
            </span>
          </span>
          {legend.map((row) => (
            <span key={row.label} className="row" style={{ gap: 4 }}>
              <span className="label">{row.label}</span>
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                {row.value}
              </span>
            </span>
          ))}
        </div>
      </div>

      {state.renderCanvas ? (
        <div ref={containerRef} style={{ position: 'relative', width: '100%', height }} role="img" aria-label={`Candlestick chart for ${baseSymbol} against ${quoteSymbol}. Latest price ${lastPrice}.`} />
      ) : (
        <div style={{ minHeight: height, display: 'flex', alignItems: 'center' }}>
          <EmptyState title={state.headline} detail={state.detail} />
        </div>
      )}
    </div>
  );
}

function toCandle(point: ChartCandleDisplay) {
  return { time: point.time as UTCTimestamp, open: point.open, high: point.high, low: point.low, close: point.close };
}

function toVolume(point: ChartCandleDisplay) {
  return {
    time: point.time as UTCTimestamp,
    value: point.volume,
    color: point.close >= point.open ? VOL_UP : VOL_DOWN,
  };
}

export type { IChartApi };
