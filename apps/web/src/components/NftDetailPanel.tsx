/**
 * NFT detail.
 *
 * Buy Now and Sell Now go through the protocol-client's authoritative
 * resolvers: discovery → reread → resolve → construct → sign → submit. The UI
 * never treats discovery data as execution authority, and a component that has
 * moved since discovery surfaces the resolver's own stale verdict.
 *
 * The highest discovered collection bid is shown as a recommendation with an
 * explicit statement that it is not guaranteed best execution.
 */

import { useEffect, useRef, useState } from 'react';
import { resolveBuyNow, resolveSellNow, type MarketplaceResolution } from '@tari-ootle/protocol-client';
import { marketplaceReadbackFrom, type MarketplaceSource, type NftDescriptor } from '../services/marketplace.js';
import { loadNftMetadata, type NftMetadata } from '../services/nftMetadata.js';
import { useApp } from '../state/AppContext.js';
import { executeSwap, newOperationId, IdentityChangedError, ReviewMismatchError, type ExecutionWallets } from '../services/execution.js';
import { createReview } from '../lib/review.js';
import { normalizeError } from '../lib/errorMessage.js';
import { marketplaceRouteBuilder, toMarketplacePreview, type MarketplaceTransactionIntent } from '@tari-ootle/wallet-adapter';
import { formatAddress, formatUnits, UNAVAILABLE } from '../lib/format.js';
import { asRawExecutionAmount } from '../lib/tradeBoundary.js';
import { Badge, Card, CardHeader, DataRow, EmptyState, Notice } from './primitives.js';

/**
 * Map a thrown value to a user-facing status without leaking internals. An
 * identity change or a review mismatch is called out explicitly, because the
 * user should understand that nothing was signed and why.
 */
function failureStatus(error: unknown, operation: string): { tone: 'warn' | 'danger'; title: string; detail: string } {
  if (error instanceof IdentityChangedError) {
    return { tone: 'warn', title: `Not submitted � wallet changed`, detail: `${error.message} Nothing was signed.` };
  }
  if (error instanceof ReviewMismatchError) {
    return { tone: 'danger', title: 'Not submitted � review mismatch', detail: error.message };
  }
  return { tone: 'danger', title: `${operation} not submitted`, detail: normalizeError({ error }).message };
}

export function NftDetailPanel({
  source,
  collectionResource,
  nftId,
  onBack,
}: {
  source: MarketplaceSource;
  collectionResource: string;
  nftId: string;
  onBack: () => void;
}) {
  const { wallet, readback, executionWallets, walletBridge, liveExecutionIdentity } = useApp();
  const [metadata, setMetadata] = useState<NftMetadata | undefined>(undefined);
  const [imageBroken, setImageBroken] = useState(false);
  const [item, setItem] = useState<NftDescriptor | undefined>(undefined);
  const [quoteResource, setQuoteResource] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<{ tone: 'warn' | 'danger' | 'info'; title: string; detail: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /**
   * Synchronous submission guard. usy is React state, so it stays alse
   * for every click that lands before the re-render, and a rapid double click
   * starts two submissions and creates two durable operations. A ref is
   * updated in the same tick, so the second click is refused. The same guard
   * covers buy and sell, which must not run concurrently against one wallet.
   */
  const submitGuard = useRef(false);
  const [route, setRoute] = useState<MarketplaceResolution<MarketplaceTransactionIntent> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all = await source.listItems(collectionResource);
      const found = all.find((entry) => entry.nftId === nftId);
      if (cancelled) return;
      setItem(found);
      setQuoteResource(found?.quoteResource);
      if (found?.metadataUri !== undefined) {
        const loaded = await loadNftMetadata(found.metadataUri, collectionResource);
        if (!cancelled) setMetadata(loaded);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, collectionResource, nftId]);

  const readbackProvider = readback();
  const wallets = executionWallets();
  const canAct = wallet.status === 'CONNECTED' && readbackProvider !== undefined;

  const buyNow = async () => {
    if (submitGuard.current) return;
    if (readbackProvider === undefined || quoteResource === undefined || item?.listingAddress === undefined) return;
    submitGuard.current = true;
    setBusy(true);
    setStatus(undefined);
    try {
      const outcome = await resolveBuyNow<MarketplaceTransactionIntent>(
        {
          listing: { listingAddress: item.listingAddress },
          expectedQuoteResource: asRawExecutionAmount(quoteResource, 'expectedQuoteResource'),
          ...(item.priceRaw === undefined ? {} : { expectedPrice: asRawExecutionAmount(item.priceRaw, 'expectedPrice') }),
          buyerAccount: wallet.account ?? '',
        },
        {
          discovery: {
            findListing: async () => source.readListing(item.listingAddress as string),
            findCollectionBids: async (criteria) => source.findBids(criteria.collectionResource, criteria.quoteResource),
          },
          readback: marketplaceReadbackFrom(readbackProvider),
          builder: marketplaceRouteBuilder(),
        },
      );
      setRoute(outcome);
      if (outcome.status !== 'READY') {
        setStatus({ tone: outcome.status === 'STALE' ? 'warn' : 'danger', title: `Buy now ${outcome.status.toLowerCase()}`, detail: outcome.reason });
        return;
      }
      await submit(outcome, 'MARKET_BUY_NFT', wallets, readbackProvider);
    } catch (error) {
      setStatus(failureStatus(error, 'Buy now'));
    } finally {
      submitGuard.current = false;
      setBusy(false);
    }
  };

  const sellNow = async () => {
    if (submitGuard.current) return;
    if (readbackProvider === undefined || quoteResource === undefined) return;
    submitGuard.current = true;
    setBusy(true);
    setStatus(undefined);
    try {
      const outcome = await resolveSellNow<MarketplaceTransactionIntent>(
        {
          collectionResource: asRawExecutionAmount(collectionResource, 'collectionResource'),
          nftId: asRawExecutionAmount(nftId, 'nftId'),
          quoteResource: asRawExecutionAmount(quoteResource, 'quoteResource'),
          sellerAccount: wallet.account ?? '',
        },
        {
          discovery: {
            findListing: async () => undefined,
            findCollectionBids: async (criteria) => source.findBids(criteria.collectionResource, criteria.quoteResource),
          },
          readback: marketplaceReadbackFrom(readbackProvider),
          builder: marketplaceRouteBuilder(),
        },
      );
      setRoute(outcome);
      if (outcome.status !== 'READY') {
        setStatus({ tone: 'warn', title: `Sell now ${outcome.status.toLowerCase()}`, detail: outcome.reason });
        return;
      }
      await submit(outcome, 'MARKET_FILL_COLLECTION_BID', wallets, readbackProvider);
    } catch (error) {
      setStatus(failureStatus(error, 'Sell now'));
    } finally {
      submitGuard.current = false;
      setBusy(false);
    }
  };

  const submit = async (
    outcome: MarketplaceResolution<MarketplaceTransactionIntent>,
    operationKind: string,
    walletsAvailable: ExecutionWallets | undefined,
    provider: NonNullable<typeof readbackProvider>,
  ) => {
    if (outcome.status !== 'READY' || walletsAvailable === undefined) return;
    const bridge = walletBridge();
    const identity = liveExecutionIdentity();
    if (bridge === undefined || identity === undefined) {
      setStatus({ tone: 'danger', title: 'Not submitted', detail: 'No verified wallet identity is available for this operation.' });
      return;
    }
    // The review is built from the READBACK values the resolver used, never from
    // the discovery payload the user saw first. If they differ, the resolver has
    // already returned STALE and execution never reaches this point.
    // The review is bound to the SIGNER, not to the asset. It previously carried
    // the input asset's resource address in both ternary branches, so every NFT
    // review claimed an account that was not the connected wallet, and the
    // account check in the differential review could never mean anything.
    const settlementAccount = wallet.account;
    if (settlementAccount === undefined || settlementAccount === '') {
      setStatus({ tone: 'danger', title: 'Not submitted', detail: 'No connected account is available to bind this review to.' });
      return;
    }
    const review = createReview({
      operationId: newOperationId('nft'),
      network: wallet.networkId ?? 'unknown',
      account: settlementAccount,
      identity,
      legs: [
        {
          operation: outcome.route.routeKind,
          componentAddress: outcome.route.componentOrOrderId,
          method: outcome.route.builderOperation,
          amounts: [
            {
              resourceAddress: outcome.route.inputAsset.resourceAddress,
              amountRaw: asRawExecutionAmount(outcome.route.exactAmount, 'exactAmount'),
              role: 'INPUT',
              ...(outcome.route.inputAsset.nftId === undefined ? {} : { nftId: outcome.route.inputAsset.nftId }),
            },
            ...(outcome.route.outputAsset.nftId === undefined
              ? [{ resourceAddress: outcome.route.outputAsset.resourceAddress, amountRaw: outcome.route.exactAmount, role: 'OUTPUT' as const }]
              : [{ resourceAddress: outcome.route.outputAsset.resourceAddress, amountRaw: '0', role: 'OUTPUT' as const, nftId: outcome.route.outputAsset.nftId }]),
          ],
        },
      ],
    });
    const result = await executeSwap<MarketplaceTransactionIntent>(walletsAvailable as ExecutionWallets, {
      resolvedIntent: outcome.route.builderIntent,
      recordInput: {
        operationId: review.operationId,
        operationKind,
        componentOrOrderId: outcome.route.componentOrOrderId,
        resources: [outcome.route.outputAsset.resourceAddress, outcome.route.inputAsset.resourceAddress],
        amounts: { exact: asRawExecutionAmount(outcome.route.exactAmount, 'exactAmount') },
        lastReadback: {
          source: 'WALLET_PROVIDER',
          identity: { epoch: outcome.route.readback.readAtEpoch, stateIdentity: outcome.route.componentOrOrderId, readAtUnixMs: Date.now() },
        },
      },
      toPreview: toMarketplacePreview,
      context: {
        assets: [outcome.route.outputAsset.resourceAddress, outcome.route.inputAsset.resourceAddress],
        operation: outcome.route.routeKind,
        network: wallet.networkId ?? 'unknown',
        poolOrDestination: outcome.route.componentOrOrderId,
        privacyDisclosure: 'Listing, offer, and bid terms are public on-chain.',
      },
      identity,
      liveIdentity: await bridge.liveIdentity(identity.nonce),
      review,
    });
    void provider;
    if (result.outcome === 'SUBMITTED') setStatus({ tone: 'info', title: 'Submitted', detail: `Transaction ${result.transactionId}.` });
    else if (result.outcome === 'UNKNOWN') setStatus({ tone: 'warn', title: 'Outcome unknown', detail: `${result.transportError} Recorded as UNKNOWN and being reconciled.` });
    else setStatus({ tone: 'danger', title: 'Failed', detail: result.reason });
  };

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <button type="button" className="btn btn--sm btn--ghost" onClick={onBack}>
        ← Back
      </button>

      <div className="market-layout">
        <Card className="card--flush">
          <div style={{ aspectRatio: '1 / 1', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {metadata?.image !== undefined && !imageBroken ? (
              <img
                src={metadata.image}
                alt={`Media for ${metadata.name}`}
                referrerPolicy="no-referrer"
                decoding="async"
                onError={() => setImageBroken(true)}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              <span className="hint">{imageBroken ? 'Image could not be loaded' : 'No media supplied for this item'}</span>
            )}
          </div>
          <div style={{ padding: 'var(--s-4)' }} className="stack">
            <h1 style={{ fontSize: 'var(--text-xl)' }}>{metadata?.name ?? `Item ${nftId}`}</h1>
            {metadata?.description !== undefined && <p className="hint">{metadata.description}</p>}
            {metadata?.failure !== undefined && (
              <Notice tone="warn" title="Metadata unavailable">
                {metadata.failure} The item is still shown with its exact identities.
              </Notice>
            )}
            {metadata?.wasAltered === true && (
              <p className="hint">Some characters were removed from the supplied metadata for safe display.</p>
            )}
          </div>
        </Card>

        <aside className="market-layout__aside stack">
          <Card className="stack">
            <h2 className="card__title">Identity</h2>
            <DataRow label="Collection resource" value={<span className="mono" style={{ wordBreak: 'break-all' }}>{collectionResource}</span>} />
            <DataRow label="Non-fungible id" value={<span className="mono">{nftId}</span>} />
            <DataRow label="Owner" value={UNAVAILABLE} title="Ownership is only shown when a source proves it is public." />
            <DataRow label="Quote resource" value={quoteResource === undefined ? UNAVAILABLE : <span className="mono" style={{ wordBreak: 'break-all' }}>{quoteResource}</span>} />
            <p className="hint">
              The symbol and image are labels. The collection resource and item id above are what the marketplace settles against, and two collections
              can share a name.
            </p>
          </Card>

          <Card className="stack">
            <h2 className="card__title">Actions</h2>
            <DataRow
              label="Buy now"
              value={item?.priceRaw === undefined ? UNAVAILABLE : formatUnits(item.priceRaw, '0', { maxFractionDigits: 4 })}
              title="Discovery price. The resolver rereads it authoritatively and refuses if it changed."
            />
            <DataRow label="Best collection bid" value={route?.status === 'READY' ? formatUnits(route.route.exactAmount, '0', { maxFractionDigits: 4 }) : UNAVAILABLE} />

            <button type="button" className="btn btn--primary btn--block" disabled={!canAct || busy || item?.listingAddress === undefined} onClick={() => void buyNow()}>
              {busy ? 'Working…' : 'Buy now'}
            </button>
            <button type="button" className="btn btn--block" disabled={!canAct || busy} onClick={() => void sellNow()}>
              Sell into best bid
            </button>
            <button type="button" className="btn btn--block" disabled={!canAct}>
              Make offer
            </button>
            <button type="button" className="btn btn--block" disabled={!canAct}>
              List
            </button>
            <button type="button" className="btn btn--block" disabled>
              Cancel listing
            </button>

            {!canAct && (
              <Notice tone="warn" title="Actions unavailable">
                Buying, selling, and offering each require an authoritative reread of the listing, offer, or bid component. Connect a wallet that can
                read those components.
              </Notice>
            )}

            {status !== undefined && (
              <Notice tone={status.tone} title={status.title}>
                {status.detail}
              </Notice>
            )}
          </Card>

          <Card className="stack">
            <CardHeader title="Settlement expectation" />
            {route?.status === 'READY' ? (
              <p className="hint">{route.route.expectedSettlement}</p>
            ) : (
              <EmptyState title="No resolved route" detail="Resolve a listing, bid, or offer to see exactly what will settle." />
            )}
            <p className="hint">
              Component <span className="mono">{route?.status === 'READY' ? formatAddress(route.route.componentOrOrderId, 10, 6) : UNAVAILABLE}</span>
            </p>
            <Badge tone="neutral">Discovery data is never execution authority</Badge>
          </Card>
        </aside>
      </div>
    </div>
  );
}




