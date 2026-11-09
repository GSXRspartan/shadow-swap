/**
 * Epoch-bucketed price chart (SVG line + volume bars).
 *
 * This renders when candles exist but carry no wall-clock basis — the honest
 * case for chain data, because consensus epochs are ordinal integers and no
 * trustworthy timestamp exists on-chain. The x axis is labelled in epochs and
 * the axis formatter formats ordinals as epochs, so no fake time is implied.
 *
 * Prices come from the protocol's display boundary (exact rationals to display
 * numbers); raw base volume is an exact string in the candle model and is
 * rendered as the tooltip text. All size/alignment is CSS-driven; no JS clock
 * or resize observer is needed beyond the container's own layout.
 */
import { useMemo, useState } from 'react';
import { toChartSeries, type OhlcvCandle } from '@tari-ootle/protocol-client';
import { formatNumber, UNAVAILABLE } from '../lib/format.js';
import { Badge } from './primitives.js';

export interface EpochChartProps {
  candles: readonly OhlcvCandle[];
  baseSymbol: string;
  quoteSymbol: string;
  interval: string;
  height?: number;
}

export function EpochChart({ candles, baseSymbol, quoteSymbol, interval, height = 320 }: EpochChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | undefined>(undefined);
  const model = useMemo(() => {
    if (candles.length === 0) return undefined;
    // Same display boundary as the candlestick chart: exact price rationals cross
    // to Number exactly once, inside the protocol's toChartSeries. `time` here is
    // the epoch-bucket key (an ordinal), NOT a timestamp — never plotted on a
    // time axis.
    const series = toChartSeries([...candles], { maxSignificantDigits: 12 });
    const points = candles.map((candle, index) => {
      const point = series[index];
      return {
        epoch: Number(BigInt(point.time)),
        close: point.close,
        volume: candle.baseVolumeRaw === '0' ? 0 : Number(BigInt(candle.baseVolumeRaw)),
        candle,
      };
    });
    const minEpoch = Math.min(...points.map((p) => p.epoch));
    const maxEpoch = Math.max(...points.map((p) => p.epoch));
    const prices = points.map((p) => p.close);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const maxVolume = Math.max(...points.map((p) => p.volume), 1);
    const spanEpoch = Math.max(1, maxEpoch - minEpoch);
    const spanPrice = Math.max(Number.EPSILON, maxPrice - minPrice);
    const W = 800;
    const H = height;
    const pad = { l: 64, r: 16, t: 16, b: 32 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;
    const x = (epoch: number) => pad.l + ((epoch - minEpoch) / spanEpoch) * innerW;
    const y = (price: number) => pad.t + innerH - ((price - minPrice) / spanPrice) * innerH;
    const linePoints = points.map((p) => `${x(p.epoch).toFixed(1)},${y(p.close).toFixed(1)}`).join(' ');
    return { points, minEpoch, maxEpoch, minPrice, maxPrice, maxVolume, W, H, pad, innerW, innerH, x, y, linePoints };
  }, [candles, height]);

  if (model === undefined) return null;
  const hovered = hoverIndex === undefined ? undefined : model.points[hoverIndex];
  const last = model.points[model.points.length - 1];

  return (
    <div className="card card--flush">
      <div className="card__head" style={{ flexWrap: 'wrap', gap: 'var(--s-2)' }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s-2)', alignItems: 'center' }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>
            Price — {baseSymbol}/{quoteSymbol}
          </strong>
          <Badge tone="info">Epoch axis · {interval}</Badge>
        </div>
        <span className="hint mono" style={{ fontSize: 'var(--text-xs)' }}>
          consensus epochs {model.minEpoch} → {model.maxEpoch} · no wall clock on-chain
        </span>
      </div>
      <div style={{ padding: '0 var(--s-4)' }}>
        <span className="hint" style={{ fontSize: 'var(--text-xs)' }} aria-live="polite">
          {hovered !== undefined
            ? `Epoch ${hovered.epoch}: close ${hovered.close.toPrecision(6)} ${baseSymbol}/${quoteSymbol}, base volume ${hovered.candle.baseVolumeRaw}`
            : last !== undefined
              ? `Last (epoch ${last.epoch}): ${last.close.toPrecision(6)} · volume ${last.candle.baseVolumeRaw}`
              : UNAVAILABLE}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${model.W} ${model.H}`}
        width="100%"
        height={model.H}
        role="img"
        aria-label={`Price chart ${baseSymbol}/${quoteSymbol} across epochs ${model.minEpoch} to ${model.maxEpoch}`}
        style={{ display: 'block' }}
      >
        {/* Volume bars */}
        {model.points.map((p, i) => {
          const barH = (p.volume / model.maxVolume) * (model.innerH * 0.35);
          const w = Math.max(1, model.innerW / model.points.length - 2);
          return (
            <rect
              key={`vol-${i}`}
              x={model.x(p.epoch) - w / 2}
              y={model.pad.t + model.innerH - barH}
              width={w}
              height={barH}
              fill={p.close >= (model.points[Math.max(0, i - 1)]?.close ?? 0) ? 'rgba(53,214,154,0.35)' : 'rgba(251,113,133,0.35)'}
            />
          );
        })}
        {/* Price line */}
        <polyline points={model.linePoints} fill="none" stroke="#b7f04a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {/* Min/max labels */}
        <text x={model.pad.l} y={model.pad.t - 4} fontSize="11" fill="currentColor" opacity="0.6">
          {formatNumber(model.maxPrice, 6)}
        </text>
        <text x={model.pad.l} y={model.pad.t + model.innerH} fontSize="11" fill="currentColor" opacity="0.6">
          {formatNumber(model.minPrice, 6)}
        </text>
        <text x={model.pad.l} y={model.H - 8} fontSize="11" fill="currentColor" opacity="0.6">
          epoch {model.minEpoch}
        </text>
        <text x={model.W - model.pad.r} y={model.H - 8} fontSize="11" fill="currentColor" opacity="0.6" textAnchor="end">
          epoch {model.maxEpoch}
        </text>
        {/* Hover targets */}
        {model.points.map((p, i) => (
          <rect
            key={`hit-${i}`}
            x={model.x(p.epoch) - 4}
            y={model.pad.t}
            width={8}
            height={model.innerH}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
            onClick={() => setHoverIndex(i)}
          />
        ))}
      </svg>
    </div>
  );
}
