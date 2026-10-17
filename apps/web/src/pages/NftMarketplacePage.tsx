/**
 * The one honest statement about an empty marketplace.
 *
 * A previous version rendered TWO notices for the same condition: a warn box saying
 * the discovery request failed, and an empty state saying the endpoint "returned no
 * collections". Those are different claims and only one could be true — a failure
 * is not an empty chain, and telling a user the chain is empty when the read never
 * happened is the single most misleading thing this page could do.
 *
 * So: if the source carries a reason, that is the whole message. If it does not, the
 * chain answered and was empty, and "empty" is the honest word.
 */
function discoveryNotice(source: MarketplaceSource): { tone: 'warn' | 'info'; title: string; body: string } {
  const reason = typeof (source as { unavailableReason?: unknown }).unavailableReason === 'string'
    ? ((source as unknown as { unavailableReason: string }).unavailableReason)
    : undefined;
  if (reason !== undefined) {
    return {
      tone: 'warn',
      title: 'Discovery unavailable',
      body: `${reason} No collection, item, listing, or price is shown in place of a read that did not happen.`,
    };
  }
  return {
    tone: 'info',
    title: 'No live marketplace components',
    body: 'The indexer answered, and it reported no listing, item offer, or collection bid instantiated from this protocol\u2019s three published templates. Nothing is fabricated to fill the grid.',
  };
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../state/AppContext.js';
import { createMarketplaceSource, type MarketplaceSource } from '../services/marketplace.js';
import { formatAddress, UNAVAILABLE } from '../lib/format.js';
import { safeLabel } from '../lib/sanitize.js';
import { Badge, Card, CardHeader, EmptyState, LoadingBlock, Notice, SegmentedControl } from '../components/primitives.js';
import { CollectionPanel } from '../components/CollectionPanel.js';
import { NftDetailPanel } from '../components/NftDetailPanel.js';

type Tab = 'collections' | 'holdings';

export function NftMarketplacePage() {
  const { config } = useApp();
  const source = useMemo<MarketplaceSource>(() => createMarketplaceSource(config), [config]);
  const [collections, setCollections] = useState<string[] | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await source.listCollections();
      if (cancelled) return;
      setCollections(found);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 'var(--text-2xl)' }}>NFT marketplace</h1>
        <Badge tone="testnet">Experimental</Badge>
      </div>
      <Notice tone="info" title="Non-custodial listings">
        Listings, offers, and collection bids settle on-chain against immutable component addresses. Discovery data here is advisory; every action
        rereads the component authoritatively before anything is signed.
      </Notice>
      {loaded && (collections === undefined || collections.length === 0) && <MarketplaceDiscoveryNotice source={source} />}
      <CollectionBrowser source={source} collections={collections} loading={!loaded} />
    </div>
  );
}

function MarketplaceDiscoveryNotice({ source }: { source: MarketplaceSource }) {
  const notice = discoveryNotice(source);
  return (
    <Notice tone={notice.tone} title={notice.title}>
      {notice.body}
    </Notice>
  );
}

function CollectionBrowser({
  source,
  collections,
  loading,
}: {
  source: MarketplaceSource;
  collections: string[] | undefined;
  loading: boolean;
}) {
  const [tab, setTab] = useState<Tab>('collections');
  const { wallet } = useApp();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<{ collectionResource: string; nftId: string } | undefined>(undefined);
  const [items, setItems] = useState<Awaited<ReturnType<MarketplaceSource['listItems']>>>([]);

  useEffect(() => {
    if (selected === undefined) return;
    let cancelled = false;
    void (async () => {
      const found = await source.listItems(selected);
      if (!cancelled) setItems(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, source]);

  if (detail !== undefined) {
    return <NftDetailPanel source={source} collectionResource={detail.collectionResource} nftId={detail.nftId} onBack={() => setDetail(undefined)} />;
  }

  if (selected !== undefined) {
    return (
      <CollectionPanel
        source={source}
        collectionResource={selected}
        onSelectItem={(nftId) => setDetail({ collectionResource: selected, nftId })}
        items={items}
        quoteSymbol="QUOTE"
        quoteDecimals="0"
      />
    );
  }

  return (
    <Card className="card--flush">
      <CardHeader
        title="Browse"
        actions={
          <SegmentedControl
            label="Browse mode"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'collections', label: 'Collections' },
              { value: 'holdings', label: 'My NFTs', disabled: wallet.status !== 'CONNECTED', title: wallet.status !== 'CONNECTED' ? 'Connect a wallet to see your holdings.' : undefined },
            ]}
          />
        }
      />
      {loading ? (
        <div style={{ padding: 'var(--s-4)' }}>
          <LoadingBlock label="Loading collections" rows={4} />
        </div>
      ) : tab === 'collections' ? (
        collections === undefined || collections.length === 0 ? (
              <EmptyState title="Nothing to browse" detail="See the notice above for why. No placeholder collection is offered in place of a real one." />

        ) : (
          <div style={{ padding: 'var(--s-4)' }} className="grid-3">
            {collections.map((collection) => (
              <button key={collection} type="button" className="card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setSelected(collection)}>
                <div className="stack" style={{ gap: 'var(--s-1)' }}>
                  <span className="truncate" style={{ fontWeight: 600 }}>
                    {safeLabel(collection, 40) || 'Collection'}
                  </span>
                  <span className="hint mono truncate">{formatAddress(collection, 10, 6)}</span>
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        <EmptyState
          title="Holdings view needs an indexer"
          detail="Your NFTs are shown from discovery data only. Indexer data is never settlement-authoritative; buying, listing, and cancelling all reread the component state first."
          action={<span className="hint">Account {wallet.account ?? UNAVAILABLE}</span>}
        />
      )}
    </Card>
  );
}

export function CollectionRoutePage() {
  const { collectionResource = '' } = useParams();
  const { config } = useApp();
  const source = useMemo<MarketplaceSource>(() => createMarketplaceSource(config), [config]);
  const [items, setItems] = useState<Awaited<ReturnType<MarketplaceSource['listItems']>>>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await source.listItems(collectionResource);
      if (!cancelled) setItems(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [source, collectionResource]);

  if (selected !== undefined) {
    return <NftDetailPanel source={source} collectionResource={collectionResource} nftId={selected} onBack={() => setSelected(undefined)} />;
  }

  return (
    <div className="stack">
      <Link to="/nfts" className="hint">
        ← All collections
      </Link>
      <CollectionPanel
        source={source}
        collectionResource={collectionResource}
        items={items}
        onSelectItem={setSelected}
        quoteSymbol="QUOTE"
        quoteDecimals="0"
      />
    </div>
  );
}

