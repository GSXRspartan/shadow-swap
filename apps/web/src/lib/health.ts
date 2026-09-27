/**
 * Market-data health presentation.
 *
 * The health object is produced by the market-data model, not by the browser.
 * This module only turns it into a badge + explanation, and it never downgrades
 * a status on the user's behalf.
 */

import type { MarketDataHealth, MarketDataHealthStatus } from '@tari-ootle/protocol-client';
import { formatTradeTime } from './format.js';

export interface HealthPresentation {
  status: MarketDataHealthStatus;
  label: string;
  detail: string;
  /** Never colour-only: each state also carries a distinct glyph/text. */
  severity: 'ok' | 'info' | 'warn' | 'danger';
  lastSyncText: string;
  hasWallClockSync: boolean;
}

const LABELS: Record<MarketDataHealthStatus, string> = {
  SYNCED: 'Synced',
  SYNCING: 'Syncing',
  STALE: 'Stale',
  DEGRADED: 'Degraded',
  UNAVAILABLE: 'Unavailable',
};

const SEVERITY: Record<MarketDataHealthStatus, HealthPresentation['severity']> = {
  SYNCED: 'ok',
  SYNCING: 'info',
  STALE: 'warn',
  DEGRADED: 'warn',
  UNAVAILABLE: 'danger',
};

const DETAIL: Record<MarketDataHealthStatus, string> = {
  SYNCED: 'Market data is current with the indexed chain state.',
  SYNCING: 'The market-data source is still catching up.',
  STALE: 'The market-data source has not confirmed a recent sync. Displayed prices and volumes may lag the chain.',
  DEGRADED: 'The market-data source is reporting reduced fidelity. Treat displayed values as approximate.',
  UNAVAILABLE: 'No market-data source is reporting. Prices, volume, and candles are not available.',
};

export function presentHealth(health: MarketDataHealth | undefined): HealthPresentation {
  if (health === undefined) {
    return {
      status: 'UNAVAILABLE',
      label: LABELS.UNAVAILABLE,
      detail: 'No health record was returned for this pool.',
      severity: 'danger',
      lastSyncText: '—',
      hasWallClockSync: false,
    };
  }
  const lastSync = formatTradeTime({
    source: 'CONSENSUS_TIMESTAMP',
    unixMs: health.lastSuccessfulSyncUnixMs,
    epoch: health.latestEpochObserved,
    bucketKey: health.latestEpochObserved ?? '0',
  });
  return {
    status: health.status,
    label: LABELS[health.status],
    detail: health.reason ?? DETAIL[health.status],
    severity: SEVERITY[health.status],
    lastSyncText: lastSync.text,
    hasWallClockSync: lastSync.hasWallClock,
  };
}

/** Pool-level health when no pool has been selected yet. */
export function aggregateHealth(presentations: readonly HealthPresentation[]): HealthPresentation {
  if (presentations.length === 0) {
    return presentHealth({ status: 'UNAVAILABLE', source: 'none', reason: 'No market-data source is configured for this deployment.' });
  }
  const rank: Record<MarketDataHealthStatus, number> = { SYNCED: 0, SYNCING: 1, DEGRADED: 2, STALE: 3, UNAVAILABLE: 4 };
  const worst = presentations.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a));
  return { ...worst, detail: `${worst.detail} (${presentations.length} pool${presentations.length === 1 ? '' : 's'} reporting)` };
}
