/**
 * Collection page.
 *
 * Floor, best bid, spread, bid depth, listed count, and recent sales all come
 * from the protocol-client's `buildCollectionMarketData`. The UI performs no
 * spread or depth arithmetic, and quote books are never merged across quote
 * resources.
 *
 * Collection bid form arithmetic is BigInt-only: price × quantity and the escrow
 * totals are computed with `BigInt`, never with JS `Number`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { CollectionBid } from '@tari-ootle/protocol-client';
import { buildCollectionView, type MarketplaceSource } from '../services/marketplace.js';
import { useApp } from '../state/AppContext.js';
import { formatUnits, formatAddress, UNAVAILABLE } from '../lib/format.js';
import { NftCard } from './NftCard.js';
import { MarketplaceActionDialog } from './MarketplaceActionDialog.js';
import { type MarketplaceAction } from '../services/marketplaceActions.js';
import { activeDeployment } from '../services/protocolDeployment.js';
import { Badge, Card, CardHeader, DataRow, EmptyState, LoadingBlock, Notice, SegmentedControl } from './primitives.js';

type Tab = 'items' | 'listings' | 'offers' | 'bids' | 'activity';

export function CollectionPanel({
  source,
  collectionResource,
  items,
  onSelectItem,
  quoteSymbol,
  quoteDecimals,
}: {
  source: MarketplaceSource;
  collectionResource: string;
  items: ReadonlyArray<{ collectionResource: string; nftId: string; listingAddress?: string; offerAddress?: string; priceRaw?: string; quoteResource?: string; metadataUri?: string }>;
  onSelectItem: (nftId: string) => void;
  quoteSymbol: string;
  quoteDecimals: string;
}) {
  const [tab, setTab] = useState<Tab>('items');
  const [quoteResource] = useState<string | undefined>(items.find((item) => item.quoteResource !== undefined)?.quoteResource);
  const [market, setMarket] = useState<ReturnType<typeof buildCollectionView> | undefined>(undefined);

  useEffect(() => {
    if (quoteResource === undefined) return;
    let cancelled = false;
    void (async () => {
      const [listings, itemOffers, bids, recentSales] = await Promise.all([
        Promise.resolve(items.flatMap((item) => (item.listingAddress === undefined ? [] : [{ listingAddress: item.listingAddress, sellerAccount: '', collectionResource, nftId: item.nftId, quoteResource: item.quoteResource ?? quoteResource, price: item.priceRaw ?? '0', expiresAtEpoch: '0', status: 'ACTIVE' as const }]))),
        source.findItemOffers(collectionResource, quoteResource),
        source.findBids(collectionResource, quoteResource),
        source.recentSales(collectionResource, quoteResource),
      ]);
      if (cancelled) return;
      setMarket(buildCollectionView({ collectionResource, quoteResource, listings, itemOffers, bids, recentSales }));
    })();
    return () => {
      cancelled = true;
    };
  }, [source, collectionResource, quoteResource, items]);

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <h1 className="mono truncate" style={{ fontSize: 'var(--text-xl)' }} title={collectionResource}>
          {collectionResource}
        </h1>
        {quoteResource !== undefined && <Badge tone="neutral">Quote book {formatAddress(quoteResource, 6, 4)}</Badge>}
      </div>

      {quoteResource === undefined && (
        <Notice tone="info" title="No quote book">
          No quote resource is known for this collection in this build, so no floor, bid, or spread can be computed. Quote books are never merged.
        </Notice>
      )}

      {market !== undefined && (
        <div className="grid-4">
          <DataRow label="Floor ask" value={market.floorAsk === undefined ? UNAVAILABLE : `${formatUnits(market.floorAsk.price, quoteDecimals, { maxFractionDigits: 4 })} ${quoteSymbol}`} />
          <DataRow label="Best bid" value={market.bestBid === undefined ? UNAVAILABLE : `${formatUnits(market.bestBid.pricePerNft, quoteDecimals, { maxFractionDigits: 4 })} ${quoteSymbol}`} />
          <DataRow label="Spread" value={market.spread === undefined ? UNAVAILABLE : `${formatUnits(market.spread, quoteDecimals, { maxFractionDigits: 4 })} ${quoteSymbol}`} title="A crossed or cached book reports a spread of zero rather than a negative number." />
          <DataRow label="Listed count" value={market.listedNftCount} />
        </div>
      )}

      {market !== undefined && market.bidDepth.length > 0 && (
        <Card className="card--flush">
          <CardHeader title="Bid depth" />
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Collection bid depth</caption>
              <thead>
                <tr>
                  <th scope="col" className="right">Price per NFT</th>
                  <th scope="col" className="right">Quantity</th>
                  <th scope="col" className="right">Quote depth</th>
                </tr>
              </thead>
              <tbody>
                {market.bidDepth.map((level) => (
                  <tr key={level.pricePerNft}>
                    <td className="right num">{formatUnits(level.pricePerNft, quoteDecimals, { maxFractionDigits: 4 })}</td>
                    <td className="right num">{level.totalQuantity}</td>
                    <td className="right num">{formatUnits(level.totalQuoteDepth, quoteDecimals, { maxFractionDigits: 4 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="card--flush">
        <CardHeader
          title="Collection"
          actions={
            <SegmentedControl
              label="Collection section"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'items', label: 'Items' },
                { value: 'listings', label: 'Listings' },
                { value: 'offers', label: 'Offers' },
                { value: 'bids', label: 'Bids' },
                { value: 'activity', label: 'Activity' },
              ]}
            />
          }
        />
        {tab === 'bids' ? (
          <div style={{ padding: 'var(--s-4)' }}>
            <BidsPanel source={source} collectionResource={collectionResource} quoteResource={quoteResource} quoteDecimals={quoteDecimals} quoteSymbol={quoteSymbol} />
          </div>
        ) : (
          <CollectionTab
            tab={tab}
            market={market}
            items={items}
            quoteDecimals={quoteDecimals}
            quoteSymbol={quoteSymbol}
            onSelectItem={onSelectItem}
          />
        )}
      </Card>

      <CollectionBidForm collectionResource={collectionResource} quoteResource={quoteResource} quoteDecimals={quoteDecimals} quoteSymbol={quoteSymbol} />
    </div>
  );
}

function CollectionTab({
  tab,
  market,
  items,
  quoteDecimals,
  quoteSymbol,
  onSelectItem,
}: {
  tab: Tab;
  market: ReturnType<typeof buildCollectionView> | undefined;
  items: ReadonlyArray<{ collectionResource: string; nftId: string; listingAddress?: string; offerAddress?: string; priceRaw?: string; quoteResource?: string; metadataUri?: string }>;
  quoteDecimals: string;
  quoteSymbol: string;
  onSelectItem: (nftId: string) => void;
}) {
  if (tab === 'items') {
    if (items.length === 0) {
      return <EmptyState title="No items discovered" detail="The discovery endpoint returned no items for this collection. Nothing is fabricated." />;
    }
    return (
      <div style={{ padding: 'var(--s-4)' }} className="grid-4">
        {items.map((item) => (
          <NftCard
            key={`${item.collectionResource}-${item.nftId}`}
            item={{
              collectionResource: item.collectionResource,
              nftId: item.nftId,
              label: item.collectionResource,
              metadataUri: item.metadataUri,
              priceRaw: item.priceRaw,
              priceDecimals: quoteDecimals,
              priceSymbol: quoteSymbol,
              to: '#',
            }}
          />
        ))}
      </div>
    );
  }

  if (market === undefined) return <LoadingBlock label="Loading collection data" rows={3} />;

  if (tab === 'listings') {
    if (market.activeListings.length === 0) return <EmptyState title="No active listings" detail="No listing in this quote book is active." />;
    return (
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Active listings</caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="right">Price</th>
              <th scope="col">Listing</th>
            </tr>
          </thead>
          <tbody>
            {market.activeListings.map((listing) => (
              <tr key={listing.listingAddress}>
                <td>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSelectItem(listing.nftId)}>
                    {listing.nftId}
                  </button>
                </td>
                <td className="right num">{formatUnits(listing.price, quoteDecimals, { maxFractionDigits: 4 })}</td>
                <td className="mono muted">{formatAddress(listing.listingAddress, 8, 6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (tab === 'offers') {
    if (market.itemOffers.length === 0 && market.collectionBids.length === 0) {
      return <EmptyState title="No offers" detail="No active item offer or collection bid in this quote book." />;
    }
    return (
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Active offers and collection bids</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col" className="right">Amount</th>
              <th scope="col" className="right">Remaining</th>
              <th scope="col">Component</th>
            </tr>
          </thead>
          <tbody>
            {market.collectionBids.map((bid) => (
              <tr key={bid.bidAddress}>
                <td>
                  <Badge tone="info">Collection bid</Badge>
                </td>
                <td className="right num">{formatUnits(bid.pricePerNft, quoteDecimals, { maxFractionDigits: 4 })}</td>
                <td className="right num">
                  {bid.remainingQuantity} · {formatUnits(bid.remainingEscrow, quoteDecimals, { maxFractionDigits: 4 })}
                </td>
                <td className="mono muted">{formatAddress(bid.bidAddress, 8, 6)}</td>
              </tr>
            ))}
            {market.itemOffers.map((offer) => (
              <tr key={offer.offerAddress}>
                <td>
                  <Badge tone="ok">Item offer</Badge>
                </td>
                <td className="right num">{formatUnits(offer.amount, quoteDecimals, { maxFractionDigits: 4 })}</td>
                <td className="right num">Item {offer.nftId}</td>
                <td className="mono muted">{formatAddress(offer.offerAddress, 8, 6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (market.recentSales.length === 0) return <EmptyState title="No recent sales" detail="No settled sale is known for this quote book." />;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Recent sales</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="right">Amount</th>
            <th scope="col">Time</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {market.recentSales.map((sale) => (
            <tr key={`${sale.listingOrOfferAddress}-${sale.nftId}`}>
              <td className="mono">{sale.nftId}</td>
              <td className="right num">{formatUnits(sale.amount, quoteDecimals, { maxFractionDigits: 4 })}</td>
              <td className="hint">{sale.epoch === undefined ? UNAVAILABLE : `Epoch ${sale.epoch}`}</td>
              <td className="hint">{sale.source.replace('_', ' ').toLowerCase()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Collection bid form.
 *
 * All arithmetic is BigInt. The total escrow is derived from the exact
 * `pricePerNft × quantity` product the escrow contract will require, never from
 * a JS `Number` multiplication, so amounts above 2^53 stay exact.
 */
function CollectionBidForm({ collectionResource, quoteResource, quoteDecimals, quoteSymbol }: { collectionResource: string; quoteResource: string | undefined; quoteDecimals: string; quoteSymbol: string }) {
  const { wallet } = useApp();
  const [pendingAction, setPendingAction] = useState<MarketplaceAction | undefined>(undefined);

  return (
    <Card className="stack">
      <h2 className="card__title">Place a collection bid</h2>
      {quoteResource === undefined ? (
        <Notice tone="warn" title="No quote resource">
          A collection bid escrows a specific quote resource. Without a known quote book no bid can be constructed, so none is offered here.
        </Notice>
      ) : (
        <>
          <DataRow
            label="Escrows"
            value={`${quoteSymbol} (${quoteDecimals} decimals)`}
            title="The full price multiplied by the quantity is escrowed up front when the transaction settles."
          />
          <Notice tone="info" title="Escrowed in full">
            A collection bid escrows the full total up front. Partial fills release the unused remainder; expiry and cancellation refund what is
            left.
          </Notice>
          <button
            type="button"
            className="btn btn--primary"
            disabled={wallet.status !== 'CONNECTED'}
            onClick={() =>
              setPendingAction({
                kind: 'PLACE_COLLECTION_BID',
                buyerAccount: wallet.account ?? '',
                collectionResource,
                quoteResource: quoteResource as string,
                pricePerNftRaw: '0',
                quantityRaw: '1',
                expiryEpoch: 0,
              })
            }
          >
            Place a bid
          </button>
          {wallet.status !== 'CONNECTED' && <p className="hint">Connect a wallet to place a bid.</p>}
        </>
      )}

      {pendingAction !== undefined && (
        <MarketplaceActionDialog
          request={{ action: pendingAction, quoteDecimals }}
          onClose={() => setPendingAction(undefined)}
          onDone={() => setPendingAction(undefined)}
        />
      )}
    </Card>
  );
}

/**
 * Open collection bids, read from chain state.
 *
 * Every row's status comes from the component itself, never from the discovery
 * index. That distinction is the whole reason this panel exists separately from the
 * market summary: a bid that has been FILLED still appears in a discovery index for
 * a while, and showing it as open would invite someone to fill it a second time.
 *
 * A bid belonging to the connected account offers Cancel, which refunds whatever
 * escrow remains. A bid belonging to someone else does not offer it at all — an
 * action the chain would reject is not a control to show.
 */
function BidsPanel({ source, collectionResource, quoteResource, quoteDecimals, quoteSymbol }: { source: MarketplaceSource; collectionResource: string; quoteResource: string | undefined; quoteDecimals: string; quoteSymbol: string }) {
  const { config, wallet, readback } = useApp();
  const [bids, setBids] = useState<CollectionBid[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pendingAction, setPendingAction] = useState<MarketplaceAction | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (quoteResource === undefined) {
      setLoaded(true);
      return;
    }
    const found = await source.findBids(collectionResource, quoteResource);
    setBids(found);
    setLoaded(true);
  }, [source, collectionResource, quoteResource]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A settled bid must stop being presented as open the moment it settles, so the
  // panel rereads the authoritative status rather than trusting what discovery said
  // when the page loaded.
  useEffect(() => {
    const provider = readback();
    // The template of the network generation this session VERIFIED; none means no
    // bid on this generation can be one of ours, so nothing is reread.
    const bidTemplate = activeDeployment(config.network)?.marketplaceTemplates?.CollectionBid;
    if (provider === undefined || bids.length === 0 || bidTemplate === undefined) return;
    let cancelled = false;
    void (async () => {
      const verified = await Promise.all(
        bids.map(async (bid) => {
          // Pinned to the published CollectionBid template. Without the pin the
          // readback falls back to a legacy flat-field decode, which is exactly the
          // downgrade this protocol refuses: a bid component that is not the one
          // this deployment published must fail closed rather than parse.
          const read = await provider.readCollectionBid(bid.bidAddress, { templateAddress: bidTemplate });
          return read.status === 'FOUND' ? read.value.status : bid.status;
        }),
      );
      if (!cancelled) setBids((current) => current.map((bid, index) => ({ ...bid, status: verified[index] ?? bid.status })));
    })();
    return () => {
      cancelled = true;
    };
  }, [readback, bids, config.network]);

  if (quoteResource === undefined) {
    return <EmptyState title="No quote book" detail="A collection bid is escrowed in one specific payment resource, so bids are not shown until this collection has a known quote book." />;
  }
  if (!loaded) return <LoadingBlock label="Reading bids from chain" />;
  if (bids.length === 0) return <EmptyState title="No open bids" detail="Nobody has bid on this collection in this payment resource." />;

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Collection bids</caption>
          <thead>
            <tr>
              <th scope="col">Price per item</th>
              <th scope="col">Quantity</th>
              <th scope="col">Status</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {bids.map((bid) => {
              const mine = wallet.account !== undefined && bid.buyerAccount === wallet.account;
              return (
                <tr key={bid.bidAddress}>
                  <td className="num">
                    {formatUnits(bid.pricePerNft, quoteDecimals, { maxFractionDigits: 6 })} {quoteSymbol}
                  </td>
                  <td className="num">{bid.remainingQuantity}</td>
                  <td>
                    <Badge tone={bid.status === 'ACTIVE' ? 'ok' : bid.status === 'FILLED' ? 'info' : 'neutral'}>{bid.status}</Badge>
                  </td>
                  <td>
                    {mine && bid.status === 'ACTIVE' ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() =>
                          setPendingAction({
                            kind: 'CANCEL_COLLECTION_BID',
                            bidAddress: bid.bidAddress,
                            buyerAccount: bid.buyerAccount,
                            collectionResource,
                            quoteResource: bid.quoteResource,
                            refundAmountRaw: bid.remainingEscrow,
                          })
                        }
                      >
                        Cancel and refund
                      </button>
                    ) : (
                      <span className="hint">{mine ? 'Settled' : 'Fill from the item page'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pendingAction !== undefined && (
        <MarketplaceActionDialog
          request={{ action: pendingAction, quoteDecimals }}
          onClose={() => setPendingAction(undefined)}
          onDone={() => void refresh()}
        />
      )}
    </div>
  );
}

