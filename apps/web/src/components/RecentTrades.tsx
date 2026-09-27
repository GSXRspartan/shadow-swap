/**
 * Recent trades.
 *
 * Renders the canonical trade records the query API returned. Time is honest:
 * a trade with only an epoch bucket shows its epoch, never a synthesised
 * wall-clock timestamp. Prices come from the exact rational through the display
 * boundary; amounts stay exact raw strings until formatted.
 */

import type { CanonicalTrade } from '@tari-ootle/protocol-client';
import { formatAddress, formatPrice, formatTradeTime, formatUnits, UNAVAILABLE } from '../lib/format.js';
import { Badge, Card, CardHeader, EmptyState, IdentityTooltip } from './primitives.js';
import type { PoolDescriptor } from '../services/pools.js';

const DIRECTION_TONE = { BASE_TO_QUOTE: 'ok', QUOTE_TO_BASE: 'danger' } as const;

export function RecentTrades({
  trades,
  pool,
  hasMore,
  onLoadMore,
}: {
  trades: readonly CanonicalTrade[];
  pool: PoolDescriptor;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
}) {
  return (
    <Card className="card--flush">
      <CardHeader
        title="Recent trades"
        actions={
          hasMore ? (
            <button type="button" className="btn btn--sm" onClick={() => void onLoadMore()}>
              Load more
            </button>
          ) : (
            <span className="hint">{trades.length} shown</span>
          )
        }
      />
      {trades.length === 0 ? (
        <EmptyState
          title="No trades yet"
          detail="No settled trade has been indexed for this pool. Market data is verified against an authoritative pool read, so nothing is shown until a real trade can be corroborated."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Most recent settled trades for {pool.base.symbol} against {pool.quote.symbol}</caption>
            <thead>
              <tr>
                <th scope="col">Side</th>
                <th scope="col" className="right">
                  Price
                </th>
                <th scope="col" className="right">
                  Base
                </th>
                <th scope="col" className="right">
                  Quote
                </th>
                <th scope="col">Time</th>
                <th scope="col">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => {
                const time = formatTradeTime(trade.time);
                const baseAmount = trade.direction === 'BASE_TO_QUOTE' ? trade.inputAmountRaw : trade.outputAmountRaw;
                const quoteAmount = trade.direction === 'BASE_TO_QUOTE' ? trade.outputAmountRaw : trade.inputAmountRaw;
                return (
                  <tr key={trade.tradeId}>
                    <td>
                      <Badge tone={DIRECTION_TONE[trade.direction]}>
                        <IdentityTooltip
                          label={trade.direction === 'BASE_TO_QUOTE' ? 'Buy' : 'Sell'}
                          resourceAddress={trade.direction === 'BASE_TO_QUOTE' ? trade.inputResource : trade.outputResource}
                          symbol={trade.direction === 'BASE_TO_QUOTE' ? pool.base.symbol : pool.quote.symbol}
                        />
                      </Badge>
                    </td>
                    <td className="right num">{formatPrice(trade.executionPrice)}</td>
                    <td className="right num">{formatUnits(baseAmount, pool.base.decimals, { maxFractionDigits: 4 })}</td>
                    <td className="right num">{formatUnits(quoteAmount, pool.quote.decimals, { maxFractionDigits: 4 })}</td>
                    <td>
                      <span className="hint" title={time.title}>
                        {time.text}
                      </span>
                    </td>
                    <td>
                      <span className="mono muted" title={trade.chainTxId}>
                        {formatAddress(trade.chainTxId, 8, 6)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {trades.length > 0 && (
        <p className="hint" style={{ padding: 'var(--s-3) var(--s-4)' }}>
          Trader identities are omitted unless the source proves they are public. Finality:{' '}
          {trades.every((trade) => trade.finality === 'FINALIZED') ? 'all finalized' : trades.some((trade) => trade.finality === 'PROVISIONAL') ? 'includes provisional' : UNAVAILABLE}
          . An invalidated trade never reaches this list.
        </p>
      )}
    </Card>
  );
}
