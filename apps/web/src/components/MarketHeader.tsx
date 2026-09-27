/**
 * Market header.
 *
 * Every value is the output of the market-data query API's `poolHeader`. No
 * percentage, change, volume, or fee is recomputed in this component. A metric
 * the query API did not produce renders as the explicit unavailable marker —
 * never as zero.
 */

import type { PoolPageHeaderView } from '@tari-ootle/protocol-client';
import type { PoolIdentityChip, SafetyPresentation } from '../lib/assetIdentity.js';
import { formatPrice, formatUnits, UNAVAILABLE } from '../lib/format.js';
import type { HealthPresentation } from '../lib/health.js';
import { Badge, IdentityTooltip, type BadgeTone } from './primitives.js';
import type { PoolDescriptor } from '../services/pools.js';

const CHANGE_TONE: Record<string, BadgeTone> = { UP: 'ok', DOWN: 'danger', FLAT: 'neutral', UNAVAILABLE: 'neutral' };

function Metric({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="stack" style={{ gap: 2, minWidth: 0 }}>
      <span className="label">{label}</span>
      {/* No `white-space: nowrap`: a value wider than its grid track must wrap
          (breaking at the unit boundary), never widen the page. The track itself
          is capped by `minmax(0, 1fr)` in the stylesheet. */}
      <span className={`num ${tone ?? ''}`.trim()} style={{ fontSize: 'var(--text-lg)', fontWeight: 600, overflowWrap: 'anywhere' }} title={title}>
        {value}
      </span>
    </div>
  );
}

export function MarketHeader({
  pool,
  identity,
  safety,
  health,
  header,
}: {
  pool: PoolDescriptor;
  identity: PoolIdentityChip;
  safety: SafetyPresentation;
  health: HealthPresentation;
  header?: PoolPageHeaderView;
}) {
  const change = header?.priceChange24h;
  const changeTone = change === undefined || change.direction === 'UNAVAILABLE' ? undefined : change.direction === 'UP' ? 'up' : change.direction === 'DOWN' ? 'down' : undefined;
  const changeText =
    change === undefined || change.direction === 'UNAVAILABLE'
      ? UNAVAILABLE
      : change.direction === 'FLAT' && change.percentDisplay === undefined
        ? '0.00%'
        : (change.percentDisplay ?? UNAVAILABLE);

  return (
    <div className="card stack" style={{ gap: 'var(--s-4)' }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 'var(--s-3)' }}>
        <div className="row" style={{ gap: 'var(--s-2)', minWidth: 0, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 'var(--text-2xl)' }}>
            <IdentityTooltip
              label={`${identity.base.symbol} / ${identity.quote.symbol}`}
              resourceAddress={pool.base.resourceAddress}
              symbol={identity.base.symbol}
              classification={identity.base.safetyClass}
            />{' '}
            <span className="muted">/</span>{' '}
            <IdentityTooltip
              label={identity.quote.symbol}
              resourceAddress={pool.quote.resourceAddress}
              symbol={identity.quote.symbol}
              classification={identity.quote.safetyClass}
            />
          </h1>
          <Badge tone={CHANGE_TONE[change?.direction ?? 'UNAVAILABLE'] ?? 'neutral'} title={change?.reason}>
            24h {changeText}
          </Badge>
          <Badge tone={safety.severity === 'ok' ? 'ok' : safety.severity === 'info' ? 'info' : safety.severity === 'warn' ? 'warn' : 'danger'} title={safety.explanation}>
            {safety.label}
          </Badge>
          <Badge tone={health.severity === 'ok' ? 'ok' : health.severity === 'info' ? 'info' : health.severity === 'warn' ? 'warn' : 'danger'} title={health.detail}>
            Data {health.label}
          </Badge>
        </div>
        {header?.informationalOnly === true && (
          <span className="hint" title="Market data can populate display values only. It never sets an execution amount, a minimum output, or a settlement proof.">
            Informational
          </span>
        )}
      </div>

      <div className="grid-4">
        <Metric
          label="Price"
          value={header?.currentPrice === undefined ? UNAVAILABLE : formatPrice(header.currentPrice)}
          title={header?.currentPrice === undefined ? 'No execution price has been indexed for this pool yet.' : undefined}
          tone={changeTone}
        />
        <Metric
          label="24h volume"
          value={header?.baseVolume24hRaw === undefined ? UNAVAILABLE : `${formatUnits(header.baseVolume24hRaw, identity.base.decimals, { abbreviate: true, maxFractionDigits: 2 })} ${identity.base.symbol}`}
          title="Settled base-asset volume. No fiat conversion is invented."
        />
        <Metric
          label="24h quote volume"
          value={header?.quoteVolume24hRaw === undefined ? UNAVAILABLE : `${formatUnits(header.quoteVolume24hRaw, identity.quote.decimals, { abbreviate: true, maxFractionDigits: 2 })} ${identity.quote.symbol}`}
        />
        <Metric
          label="24h LP fees"
          value={header?.lpFees24hBaseRaw === undefined ? UNAVAILABLE : `${formatUnits(header.lpFees24hBaseRaw, identity.base.decimals, { maxFractionDigits: 4 })} ${identity.base.symbol}`}
          title="Paid entirely to liquidity providers. There is no protocol or developer revenue."
        />
      </div>

      <div className="grid-4">
        <Metric
          label="Liquidity"
          value={
            header?.liquidityNative === undefined
              ? UNAVAILABLE
              : `${formatUnits(header.liquidityNative.baseRaw, identity.base.decimals, { abbreviate: true, maxFractionDigits: 2 })} / ${formatUnits(
                  header.liquidityNative.quoteRaw,
                  identity.quote.decimals,
                  { abbreviate: true, maxFractionDigits: 2 },
                )}`
          }
          title="Native quantities only. This build does not invent a fiat total value locked."
        />
        <Metric label="24h trades" value={header?.tradeCount24h === undefined ? UNAVAILABLE : String(header.tradeCount24h)} />
        <Metric label="Fee tier" value={pool.feeBps === undefined ? UNAVAILABLE : `${pool.feeBps} bps`} title="Paid to liquidity providers." />
        <Metric label="Last sync" value={health.lastSyncText} title={health.hasWallClockSync ? 'Source wall-clock sync time.' : 'No trustworthy wall clock; showing the source epoch instead.'} />
      </div>
    </div>
  );
}
