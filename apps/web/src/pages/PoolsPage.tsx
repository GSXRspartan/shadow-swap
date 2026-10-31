/**
 * Pool discovery.
 *
 * A searchable, sortable list of discovered pools. Every metric comes from the
 * market-data query API; a metric the query API could not produce renders as the
 * explicit unavailable marker. No fiat TVL is invented, and a pool with no
 * market data still appears with `—` rather than disappearing.
 */

import { useEffect, useMemo, useState } from 'react';
import { CreatePoolPanel } from '../components/CreatePoolPanel.js';
import { Link } from 'react-router-dom';
import { useApp } from '../state/AppContext.js';
import { presentSafety, weakestClassification, type SafetyPresentation } from '../lib/assetIdentity.js';
import { formatPrice, formatUnits, UNAVAILABLE } from '../lib/format.js';
import { presentHealth } from '../lib/health.js';
import type { PoolPageHeaderView } from '@tari-ootle/protocol-client';
import { Badge, Card, CardHeader, EmptyState, LoadingBlock, Notice, type BadgeTone } from '../components/primitives.js';
import type { PoolDescriptor } from '../services/pools.js';

type SortKey = 'pair' | 'liquidity' | 'volume' | 'change' | 'fee';
type Direction = 'asc' | 'desc';

const SEVERITY_TONE: Record<SafetyPresentation['severity'], BadgeTone> = {
  ok: 'ok',
  info: 'info',
  warn: 'warn',
  danger: 'danger',
};

interface Row {
  pool: PoolDescriptor;
  header?: PoolPageHeaderView;
  safety: SafetyPresentation;
  pairLabel: string;
}

export function PoolsPage() {
  const { market, refreshPools, bundleFor } = useApp();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('liquidity');
  const [direction, setDirection] = useState<Direction>('desc');
  const [headers, setHeaders] = useState<Map<string, PoolPageHeaderView>>(new Map());

  // Header metrics are advisory; failures simply leave the pool without numbers.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = new Map<string, PoolPageHeaderView>();
      for (const pool of market.pools) {
        const bundle = bundleFor(pool.poolComponent, pool);
        if (bundle === undefined) continue;
        const health = bundle.health();
        next.set(
          pool.poolComponent,
          await bundle.query.poolHeader({ poolComponent: pool.poolComponent, health, nowEpochKey: health.latestEpochObserved ?? '0' }),
        );
      }
      if (!cancelled) setHeaders(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [market.pools, bundleFor]);

  const rows = useMemo<Row[]>(
    () =>
      market.pools.map((pool) => ({
        pool,
        header: headers.get(pool.poolComponent),
        safety: presentSafety(weakestClassification(pool.base.safetyClass, pool.quote.safetyClass)),
        pairLabel: `${pool.base.symbol ?? 'Unnamed'} / ${pool.quote.symbol ?? 'Unnamed'}`,
      })),
    [market.pools, headers],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle === '' ? rows : rows.filter((row) => row.pairLabel.toLowerCase().includes(needle) || row.pool.poolComponent.toLowerCase().includes(needle));
    const value = (row: Row): number | string | bigint => {
      switch (sort) {
        case 'pair':
          return row.pairLabel;
        case 'volume':
          return row.header?.baseVolume24hRaw === undefined ? -1n : BigInt(row.header.baseVolume24hRaw);
        case 'liquidity':
          return row.header?.liquidityNative?.baseRaw === undefined ? -1n : BigInt(row.header.liquidityNative.baseRaw);
        case 'fee':
          return row.pool.feeBps === undefined ? -1n : BigInt(row.pool.feeBps);
        case 'change':
        default:
          return row.header?.priceChange24h.percentDisplay ?? '';
      }
    };
    return [...matching].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (typeof left === 'string' || typeof right === 'string') {
        const cmp = String(left).localeCompare(String(right));
        return direction === 'asc' ? cmp : -cmp;
      }
      if (left === right) return 0;
      const cmp = left < right ? -1 : 1;
      return direction === 'asc' ? cmp : -cmp;
    });
  }, [rows, query, sort, direction]);

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setDirection(key === 'pair' ? 'asc' : 'desc');
    }
  };

  /*
   * Health comes from `market.health` and is NOT re-derived here.
   *
   * This page used to compute its own badge from
   * `PROTOCOL_AVAILABLE && market.discovery.pools.length > 0`, while
   * `AppContext.refreshPools` computed the same badge from the deployment state
   * alone. The two disagreed on the live network — the header said "Data: Synced"
   * and this page said "Data Unavailable" — over the same fact, on the same screen,
   * at the same moment.
   *
   * The context's rule is the correct one and is already documented there: the
   * DEPLOYMENT state decides the badge, because a reachable network whose pool
   * components need a wallet to decode is not an outage, and a network that
   * cannot be read is not an empty market. One derivation, one badge.
   */
  const health = market.health;

  /**
   * The six states are kept apart because each one is a different fact about
   * the world with a different operator response:
   *
   *   INDEXER_UNAVAILABLE   the chain could not be read
   *   RATE_LIMITED          the chain is answering; this client asked too fast
   *   WRONG_NETWORK         the chain was read and it is not the one we permit
   *   PROTOCOL_NOT_DEPLOYED the chain is reachable; our templates are unpublished
   *   PROTOCOL_DEPLOYED_EMPTY templates are live; no component instantiated yet
   *   PROTOCOL_AVAILABLE    pool components exist on chain
   *
   * `RATE_LIMITED` is deliberately NOT rendered as an outage. Since Ootle v0.46.0
   * rate-limits every public indexer read route, and discovery issues a burst of
   * pages, a throttle is usually this app's own request rate. Telling the user the
   * indexer is down would be a false claim about the network, and the remedy
   * ("wait a moment, then refresh") is different from an outage's.
   */
  const state = market.discovery.state;
  const isRateLimited = state === 'RATE_LIMITED';
  const isOutage = state === 'INDEXER_UNAVAILABLE' || state === 'WRONG_NETWORK';
  const isEmptyDeployment = state === 'PROTOCOL_NOT_DEPLOYED' || state === 'PROTOCOL_DEPLOYED_EMPTY';
  const candidates = market.discovery.candidates;


  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 'var(--text-2xl)' }}>Pools</h1>
        <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <Badge tone={health.severity === 'ok' ? 'ok' : health.severity === 'info' ? 'info' : health.severity === 'warn' ? 'warn' : 'danger'} title={health.detail}>
            Data {health.label}
          </Badge>
          <button type="button" className="btn btn--sm" onClick={() => void refreshPools()}>
            Refresh
          </button>
        </div>
      </div>

      {isRateLimited && (
        <Notice tone="info" title="Indexer rate limit reached">
          The indexer is answering but is throttling this browser. Wait a moment and refresh. The chain is reachable; this is a request-rate limit, not an outage.
        </Notice>
      )}

      {isOutage && (
        <Notice tone="warn" title={state === 'WRONG_NETWORK' ? 'Refusing this network' : 'Pool discovery unavailable'}>
          {market.discovery.unavailableReason}
        </Notice>
      )}

      {isEmptyDeployment && (
        <Notice tone="info" title={state === 'PROTOCOL_NOT_DEPLOYED' ? 'Network reachable, protocol not yet deployed' : 'Protocol published, not yet in use'}>
          {market.discovery.detail}
        </Notice>
      )}

      <Card className="card--flush">
        <CardHeader
          title={
            // A failed discovery is NOT a zero. Rendering "0 pools" when the
            // request failed tells a user their money has no market, which is a
            // different and much stronger claim than "we could not find out".
            //
            // And a count must describe the ROWS BELOW IT. The body lists decoded
            // pools when a wallet has read them, and otherwise lists discovered
            // components whose state only the wallet can decode. An earlier draft
            // always used `filtered.length`, so a page listing one component
            // component header read "0 pools" — the exact false negative this
            // comment exists to prevent, one level down from the outage case.
            isOutage && market.pools.length === 0
              ? 'Pool list unavailable'
              : state === 'PROTOCOL_NOT_DEPLOYED'
                ? 'Templates not published yet'
                : market.pools.length > 0
                  ? `${filtered.length} pool${filtered.length === 1 ? '' : 's'}`
                  : candidates.length > 0
                    ? `${candidates.length} pool component${candidates.length === 1 ? '' : 's'} discovered`
                    : 'No pools'
          }
          actions={
            <div className="field" style={{ maxWidth: 280, width: '100%', minWidth: 0 }}>
              <label className="sr-only" htmlFor="pool-search">
                Search pools
              </label>
              <input
                id="pool-search"
                className="input"
                type="search"
                placeholder="Search pair or pool address"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={market.pools.length === 0}
                style={{ width: '100%', minWidth: 0 }}
                title={
                  market.pools.length === 0
                    ? 'Search applies to decoded pools. Connect a wallet to read reserves, then pair and address search become available.'
                    : 'Filter by pair or by pool component address.'
                }
              />
            </div>
          }
        />
        {market.loading ? (
          <div style={{ padding: 'var(--s-4)' }}>
            <LoadingBlock label="Loading pools" rows={5} />
          </div>
        ) : isEmptyDeployment ? (
          <EmptyState
            title={state === 'PROTOCOL_NOT_DEPLOYED' ? 'Protocol not yet deployed on this network' : 'Published, but no pool has been created'}
            detail={
              market.discovery.detail ??
              (state === 'PROTOCOL_NOT_DEPLOYED'
                ? 'The indexer is reachable and reports no published protocol template. Publish the four templates, then refresh. No pool is fabricated to fill this page.'
                : 'The protocol templates are published and the indexer is reachable. No pool component has been instantiated from them yet.')
            }
          />
        ) : isOutage ? (
          <EmptyState
            title="Pool list unavailable"
            detail={market.discovery.unavailableReason ?? 'The indexer could not be read. No claim is made about whether pools exist.'}
          />
        ) : market.pools.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Discovered liquidity pools with market metrics</caption>
              <thead>
                <tr>
                  <SortableHeader label="Pair" sortKey="pair" sort={sort} direction={direction} onSort={toggleSort} />
                  <th scope="col" className="right">Price</th>
                  <SortableHeader label="24h change" sortKey="change" sort={sort} direction={direction} onSort={toggleSort} align="right" />
                  <SortableHeader label="24h volume" sortKey="volume" sort={sort} direction={direction} onSort={toggleSort} align="right" />
                  <SortableHeader label="Liquidity" sortKey="liquidity" sort={sort} direction={direction} onSort={toggleSort} align="right" />
                  <th scope="col" className="right">24h LP fees</th>
                  <th scope="col">Market data</th>
                  <th scope="col">Asset safety</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.pool.poolComponent}>
                    <td>
                      <Link to={`/pools/${encodeURIComponent(row.pool.poolComponent)}`} style={{ fontWeight: 600 }}>
                        {row.pairLabel}
                      </Link>
                      <div className="hint mono truncate" style={{ maxWidth: 220 }}>
                        {row.pool.poolComponent}
                      </div>
                    </td>
                    <td className="right num">{row.header?.currentPrice === undefined ? UNAVAILABLE : formatPrice(row.header.currentPrice)}</td>
                    <td className="right num">
                      {row.header?.priceChange24h.direction === undefined || row.header.priceChange24h.direction === 'UNAVAILABLE'
                        ? UNAVAILABLE
                        : (row.header.priceChange24h.percentDisplay ?? UNAVAILABLE)}
                    </td>
                    <td className="right num">
                      {row.header?.baseVolume24hRaw === undefined
                        ? UNAVAILABLE
                        : formatUnits(row.header.baseVolume24hRaw, row.pool.base.decimals, { abbreviate: true, maxFractionDigits: 2 })}
                    </td>
                    <td className="right num">
                      {row.header?.liquidityNative === undefined
                        ? UNAVAILABLE
                        : `${formatUnits(row.header.liquidityNative.baseRaw, row.pool.base.decimals, { abbreviate: true, maxFractionDigits: 2 })} / ${formatUnits(
                            row.header.liquidityNative.quoteRaw,
                            row.pool.quote.decimals,
                            { abbreviate: true, maxFractionDigits: 2 },
                          )}`}
                    </td>
                    <td className="right num">
                      {row.header?.lpFees24hBaseRaw === undefined ? UNAVAILABLE : formatUnits(row.header.lpFees24hBaseRaw, row.pool.base.decimals, { maxFractionDigits: 4 })}
                    </td>
                    <td>
                      <PoolHealthBadge poolComponent={row.pool.poolComponent} />
                    </td>
                    <td>
                      <Badge tone={SEVERITY_TONE[row.safety.severity]} title={row.safety.explanation}>
                        {row.safety.label}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : candidates.length > 0 ? (
          // Pool components exist on chain but their state is raw CBOR to the
          // indexer: only the wallet's `tari_getSubstate` decodes it. So the
          // addresses are listed and every financial field is the explicit
          // unavailable marker rather than a number this app did not read.
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Pool components discovered on chain</caption>
              <thead>
                <tr>
                  <th scope="col">Pool component</th>
                  <th scope="col">Template</th>
                  <th scope="col">Version</th>
                  <th scope="col">Pair / reserves</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.componentAddress}>
                    <td className="mono truncate" style={{ maxWidth: 320 }}>
                      {candidate.componentAddress}
                    </td>
                    <td className="mono truncate">{candidate.templateAddress}</td>
                    <td className="num">{candidate.version}</td>
                    <td className="right">{UNAVAILABLE}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint" style={{ padding: 'var(--s-3) var(--s-4)' }}>
              Reserves, fee and LP supply are read from your wallet at the authoritative reread, never from this list. Discovery only says which pool components exist.
            </p>
          </div>
        ) : (
          <EmptyState title="No pools to show" detail="Discovery returned no pools for this deployment. No pool list is fabricated." />
        )}
      </Card>

      <p className="hint">
        Liquidity is shown as native quantities. No fiat total value locked is shown, because nothing in this build has a defensible price for it.
      </p>

      <CreatePoolPanel />
    </div>
  );
}

function PoolHealthBadge({ poolComponent }: { poolComponent: string }) {
  const { market } = useApp();
  // Per-pool health is only available once a wallet-backed market-data bundle
  // exists for that pool; until then the global source health is the honest
  // answer for the row. The earlier version of this component looked the pool up
  // and discarded it (`void pool`), which read as a resolved per-pool state and
  // was not one.
  const presentation = presentHealth({ status: market.health.status, source: market.health.label, reason: market.health.detail });
  return (
    <Badge tone={presentation.severity === 'ok' ? 'ok' : presentation.severity === 'info' ? 'info' : presentation.severity === 'warn' ? 'warn' : 'danger'} title={`${poolComponent}: ${presentation.detail}`}>
      {presentation.label}
    </Badge>
  );
}

function SortableHeader({
  label,
  sortKey,
  sort,
  direction,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  sort: SortKey;
  direction: Direction;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === sortKey;
  return (
    <th scope="col" className={align === 'right' ? 'right' : undefined} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSort(sortKey)} style={{ color: active ? 'var(--text-1)' : 'inherit', padding: 0, minHeight: 'auto' }}>
        {label}
        <span aria-hidden="true" className="muted">
          {active ? (direction === 'asc' ? ' ▲' : ' ▼') : ''}
        </span>
        <span className="sr-only">{active ? `sorted ${direction === 'asc' ? 'ascending' : 'descending'}` : 'not sorted'}</span>
      </button>
    </th>
  );
}

