/**
 * Pool activity: swaps, adds, and removes, from the canonical activity records.
 * Bounded pagination; the list is never unbounded.
 */

import type { PoolActivityRecord } from '@tari-ootle/protocol-client';
import { formatAddress, formatTradeTime, formatUnits } from '../lib/format.js';
import { Badge, Card, CardHeader, EmptyState, type BadgeTone } from './primitives.js';
import type { PoolDescriptor } from '../services/pools.js';

const KIND_LABEL: Record<PoolActivityRecord['kind'], string> = {
  TRADE: 'Swap',
  ADD_LIQUIDITY: 'Add liquidity',
  REMOVE_LIQUIDITY: 'Remove liquidity',
};

const KIND_TONE: Record<PoolActivityRecord['kind'], BadgeTone> = {
  TRADE: 'info',
  ADD_LIQUIDITY: 'ok',
  REMOVE_LIQUIDITY: 'warn',
};

export function PoolActivityList({
  activity,
  pool,
  hasMore,
  onLoadMore,
}: {
  activity: readonly PoolActivityRecord[];
  pool: PoolDescriptor;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
}) {
  return (
    <Card className="card--flush">
      <CardHeader
        title="Pool activity"
        actions={
          hasMore ? (
            <button type="button" className="btn btn--sm" onClick={() => void onLoadMore()}>
              Load more
            </button>
          ) : (
            <span className="hint">{activity.length} shown</span>
          )
        }
      />
      {activity.length === 0 ? (
        <EmptyState title="No activity" detail="No swap, add, or remove has been indexed for this pool yet." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Canonical pool activity for {pool.base.symbol} against {pool.quote.symbol}</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col" className="right">
                  In
                </th>
                <th scope="col" className="right">
                  Out
                </th>
                <th scope="col">Time</th>
                <th scope="col">Transaction</th>
                <th scope="col">Finality</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((record) => {
                const time = formatTradeTime(record.time);
                return (
                  <tr key={record.activityId}>
                    <td>
                      <Badge tone={KIND_TONE[record.kind]}>{KIND_LABEL[record.kind]}</Badge>
                    </td>
                    <td className="right num">{formatUnits(record.inputAmountRaw, decimalsFor(pool, record.inputResource), { maxFractionDigits: 4 })}</td>
                    <td className="right num">{formatUnits(record.outputAmountRaw, decimalsFor(pool, record.outputResource), { maxFractionDigits: 4 })}</td>
                    <td>
                      <span className="hint" title={time.title}>
                        {time.text}
                      </span>
                    </td>
                    <td>
                      <span className="mono muted" title={record.chainTxId}>
                        {formatAddress(record.chainTxId, 8, 6)}
                      </span>
                    </td>
                    <td>
                      <span className="hint">{record.finality.toLowerCase()}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function decimalsFor(pool: PoolDescriptor, resourceAddress: string): string {
  if (resourceAddress === pool.base.resourceAddress) return pool.base.decimals;
  if (resourceAddress === pool.quote.resourceAddress) return pool.quote.decimals;
  // Unknown resource: never guess decimals. The API would need to supply them.
  return '0';
}
