/**
 * Pool market page.
 *
 * Desktop priority: market header → chart → market details, with the swap card
 * on the right. Below: recent trades, pool activity, and liquidity controls.
 * Mobile priority: header → swap → chart → metrics → activity, achieved with
 * CSS `order` on one render tree rather than a second tree.
 *
 * Every number rendered here comes from the frontend query API or a protocol
 * resolver. This page performs no market-data or AMM math.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { CandleInterval, CanonicalTrade, OhlcvCandle, PoolActivityRecord, PoolPageHeaderView, TimeSource } from '@tari-ootle/protocol-client';
import { useApp } from '../state/AppContext.js';
import { buildPoolIdentity, presentSafety } from '../lib/assetIdentity.js';
import { ChartBasisError, chartTimeBasis, resolveChartState, toChartCandles, checkIntervalSupport, applyTailUpdate, type ChartCandleDisplay } from '../lib/chartData.js';
import { formatPrice, UNAVAILABLE } from '../lib/format.js';
import { presentHealth, type HealthPresentation } from '../lib/health.js';
import { CandleChart } from '../components/CandleChart.js';
import { SwapCard } from '../components/SwapCard.js';
import { LiquidityPanel } from '../components/LiquidityPanel.js';
import { RecentTrades } from '../components/RecentTrades.js';
import { PoolActivityList } from '../components/PoolActivityList.js';
import { MarketHeader } from '../components/MarketHeader.js';
import { Card, EmptyState, Notice } from '../components/primitives.js';
import type { PoolDescriptor } from '../services/pools.js';

const CANDLE_LIMIT = 400;
const TRADE_PAGE = 40;
const ACTIVITY_PAGE = 25;
const TIME_SOURCE: TimeSource = 'EPOCH_BOUNDARY';
const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function PoolPage() {
  const { poolComponent = '' } = useParams();
  const { market, wallet, bundleFor } = useApp();
  const pool = market.pools.find((entry) => entry.poolComponent === poolComponent);

  const [interval, setInterval] = useState<CandleInterval>('1h');
  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [chartCandles, setChartCandles] = useState<ChartCandleDisplay[]>([]);
  const [basisError, setBasisError] = useState<string | undefined>(undefined);
  const [intervalNote, setIntervalNote] = useState<string | undefined>(undefined);
  const [header, setHeader] = useState<PoolPageHeaderView | undefined>(undefined);
  const [trades, setTrades] = useState<CanonicalTrade[]>([]);
  const [tradeCursor, setTradeCursor] = useState<string | undefined>(undefined);
  const [hasMoreTrades, setHasMoreTrades] = useState(false);
  const [activity, setActivity] = useState<PoolActivityRecord[]>([]);
  const [activityPage, setActivityPage] = useState(1);
  const [subscribed, setSubscribed] = useState(false);

  const intervalRef = useRef<CandleInterval>(interval);
  intervalRef.current = interval;

  const bundle = useMemo(() => (pool === undefined ? undefined : bundleFor(pool.poolComponent, pool)), [pool, bundleFor]);

  const intervals = useMemo(() => INTERVALS.map((value) => checkIntervalSupport(value, { timeSource: TIME_SOURCE })), []);

  useEffect(() => {
    const current = intervals.find((entry) => entry.interval === interval);
    if (current !== undefined && !current.supported) {
      const fallback = intervals.find((entry) => entry.supported);
      if (fallback !== undefined) setInterval(fallback.interval);
    }
  }, [intervals, interval]);

  // ---- header -------------------------------------------------------------
  useEffect(() => {
    if (pool === undefined || bundle === undefined) {
      setHeader(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      const health = bundle.health();
      const view = await bundle.query.poolHeader({
        poolComponent: pool.poolComponent,
        health,
        nowEpochKey: health.latestEpochObserved ?? '0',
      });
      if (!cancelled) setHeader(view);
    })();
    return () => {
      cancelled = true;
    };
  }, [pool, bundle]);

  // ---- candles ------------------------------------------------------------
  useEffect(() => {
    if (pool === undefined) return;
    const source = bundle;
    if (source === undefined) {
      setCandles([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const series = await source.query.candles({ poolComponent: pool.poolComponent, interval, limit: CANDLE_LIMIT, pair: pool.pair });
        if (cancelled) return;
        setCandles(series.candles);
        setIntervalNote(series.support.supported ? undefined : series.support.reason);
      } catch (error) {
        if (!cancelled) {
          setCandles([]);
          setIntervalNote((error as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pool, bundle, interval]);

  // ---- trades + activity --------------------------------------------------
  useEffect(() => {
    if (pool === undefined || bundle === undefined) return;
    let cancelled = false;
    void (async () => {
      const [tradePage, activityResult] = await Promise.all([
        bundle.query.recentTrades({ poolComponent: pool.poolComponent, limit: TRADE_PAGE }),
        bundle.query.poolActivity({ poolComponent: pool.poolComponent, limit: ACTIVITY_PAGE }),
      ]);
      if (cancelled) return;
      setTrades(tradePage.trades);
      setTradeCursor(tradePage.nextBeforeBucketKey);
      setHasMoreTrades(tradePage.hasMore);
      setActivity(activityResult.activity);
    })();
    return () => {
      cancelled = true;
    };
  }, [pool, bundle]);

  // ---- live subscription (one subscription, two effects) ------------------
  useEffect(() => {
    if (bundle === undefined) {
      setSubscribed(false);
      return;
    }
    setSubscribed(true);
    const sub = bundle.subscribeCandles((candle: OhlcvCandle) => {
      if (candle.interval !== intervalRef.current) return;
      setCandles((existing) => {
        const index = existing.findIndex((entry) => entry.bucketStart === candle.bucketStart);
        if (index === -1) return [...existing, candle].slice(-CANDLE_LIMIT);
        const next = [...existing];
        next[index] = candle;
        return next;
      });
      // Incremental tail update — the whole history is never re-derived here.
      try {
        const [display] = toChartCandles([candle]);
        if (display !== undefined) setChartCandles((existing) => applyTailUpdate(existing, display));
      } catch {
        /* non-wall-clock bucket: the full-conversion effect owns it */
      }
    });
    return () => {
      sub.unsubscribe();
      setSubscribed(false);
    };
  }, [bundle]);

  // Full conversion on history change only (mount, interval change, rebuild).
  useEffect(() => {
    try {
      setChartCandles(toChartCandles(candles));
      setBasisError(undefined);
    } catch (error) {
      setChartCandles([]);
      setBasisError(error instanceof ChartBasisError ? error.message : (error as Error).message);
    }
  }, [candles]);

  if (pool === undefined) {
    return (
      <Card>
        <EmptyState
          title="Pool not found"
          detail={
            market.discovery.unavailableReason ??
            'This pool is not in the current discovery result. Discovery data is advisory; a pool that is not discoverable cannot be displayed.'
          }
          action={
            <Link className="btn btn--sm" to="/pools">
              Back to pools
            </Link>
          }
        />
      </Card>
    );
  }

  const identity = buildPoolIdentity({
    poolComponent: pool.poolComponent,
    base: { resourceAddress: pool.base.resourceAddress, symbol: pool.base.symbol, decimals: pool.base.decimals, safetyClass: pool.base.safetyClass },
    quote: { resourceAddress: pool.quote.resourceAddress, symbol: pool.quote.symbol, decimals: pool.quote.decimals, safetyClass: pool.quote.safetyClass },
  });
  const safety = presentSafety(identity.weakest);
  const health: HealthPresentation = presentHealth(bundle?.health());
  const basis = chartTimeBasis(candles);
  const chartState = resolveChartState({
    loading,
    health: { status: health.status, reason: health.detail, source: health.label },
    candleCount: candles.length,
    tradeCount: trades.length,
    basis,
    subscribed,
  });

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <MarketHeader pool={pool} identity={identity} safety={safety} health={health} header={header} />

      {wallet.status !== 'CONNECTED' && (
        <Notice tone="info" title="Read-only mode">
          Market data below comes from the market-data query API and is informational. Connecting a wallet enables the authoritative pool reread that any
          quote or transaction requires.
        </Notice>
      )}

      {identity.requiresAcknowledgement && (
        <Notice tone="warn" title={`${safety.label} asset in this pool`}>
          {safety.explanation}
        </Notice>
      )}

      {intervalNote !== undefined && (
        <Notice tone="warn" title="Interval unavailable">
          {intervalNote}
        </Notice>
      )}

      <div className="market-layout">
        <div className="stack" style={{ order: 2, gap: 'var(--s-4)' }}>
          <CandleChart
            candles={chartCandles}
            interval={interval}
            onIntervalChange={setInterval}
            intervals={intervals.map((entry) => ({ interval: entry.interval, supported: entry.supported, reason: entry.reason }))}
            state={chartState}
            baseSymbol={identity.base.symbol}
            quoteSymbol={identity.quote.symbol}
            lastPrice={header?.currentPrice === undefined ? UNAVAILABLE : formatPrice(header.currentPrice)}
            priceDirection={header?.priceChange24h.direction ?? 'UNAVAILABLE'}
            height={380}
          />
          {basisError !== undefined && (
            <Notice tone="info" title="Epoch-bucketed series">
              {basisError}
            </Notice>
          )}
          <RecentTrades
            trades={trades}
            pool={pool}
            hasMore={hasMoreTrades}
            onLoadMore={async () => {
              if (bundle === undefined || tradeCursor === undefined) return;
              const page = await bundle.query.recentTrades({ poolComponent: pool.poolComponent, limit: TRADE_PAGE, beforeBucketKey: tradeCursor });
              setTrades((existing) => [...existing, ...page.trades]);
              setTradeCursor(page.nextBeforeBucketKey);
              setHasMoreTrades(page.hasMore);
            }}
          />
          <PoolActivityList
            activity={activity}
            pool={pool}
            hasMore={activity.length >= ACTIVITY_PAGE * activityPage}
            onLoadMore={async () => {
              if (bundle === undefined) return;
              const next = activityPage + 1;
              const result = await bundle.query.poolActivity({ poolComponent: pool.poolComponent, limit: ACTIVITY_PAGE * next });
              setActivity(result.activity);
              setActivityPage(next);
            }}
          />
          <LiquidityPanel pool={pool} />
        </div>

        <aside className="market-layout__aside" style={{ order: 1 }} aria-label="Swap">
          <SwapCard pool={pool} />
        </aside>
      </div>

      <PoolDetails pool={pool} />
    </div>
  );
}

function PoolDetails({ pool }: { pool: PoolDescriptor }) {
  return (
    <Card>
      <h2 className="card__title" style={{ marginBottom: 'var(--s-3)' }}>
        Market details
      </h2>
      <div className="grid-2">
        <div className="stack" style={{ gap: 'var(--s-2)', minWidth: 0 }}>
          <span className="label">Pool component</span>
          <span className="mono" style={{ wordBreak: 'break-all', fontSize: 'var(--text-sm)' }}>
            {pool.poolComponent}
          </span>
        </div>
        <div className="stack" style={{ gap: 'var(--s-2)' }}>
          <span className="label">Fee tier</span>
          <span className="num">{pool.feeBps === undefined ? UNAVAILABLE : `${pool.feeBps} bps`}</span>
        </div>
      </div>
      <hr className="divider" />
      <div className="grid-2">
        {[pool.base, pool.quote].map((asset, index) => (
          <div key={asset.resourceAddress} className="stack" style={{ gap: 'var(--s-1)', minWidth: 0 }}>
            <span className="label">{index === 0 ? 'Base asset' : 'Quote asset'}</span>
            <span style={{ fontWeight: 600 }}>{asset.symbol ?? 'Unnamed'}</span>
            <span className="mono muted" style={{ wordBreak: 'break-all', fontSize: 'var(--text-sm)' }}>
              {asset.resourceAddress}
            </span>
            <span className="hint">
              {index === 0 ? 'Base' : 'Quote'} · {asset.decimals} decimals · {asset.safetyClass}
            </span>
          </div>
        ))}
      </div>
      <hr className="divider" />
      <p className="hint">
        Symbols are labels, never settlement identity. Two resources can share a symbol; the addresses above are what the protocol routes, prices, and
        settles against.
      </p>
    </Card>
  );
}
