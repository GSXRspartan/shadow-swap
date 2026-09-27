import { TransactionPreview } from './interface.js';
import { MarketplaceTransactionIntent, buyListing, fillCollectionBid, acceptItemOffer, toMarketplacePreview } from './marketplace.js';
import type { Listing, ItemOffer, CollectionBid, MarketplaceRouteBuilder } from '@tari-ootle/protocol-client';

/**
 * Bridges the protocol-client marketplace resolvers to the signer-agnostic builder
 * functions. This is the ONLY sanctioned wiring point: resolvers re-read authoritative
 * state, then delegate construction here — builders must never be invoked on discovery
 * data alone.
 */
export function marketplaceRouteBuilder(): MarketplaceRouteBuilder<MarketplaceTransactionIntent> {
  return {
    buyListing(listing, buyerAccount) {
      // Identity comes from the AUTHORITATIVE readback values (the resolver passes the
      // reread), never from a discovery payload.
      return buyListing(
        listing.listingAddress,
        buyerAccount,
        listing.quoteResource,
        listing.price,
        { nftResource: listing.collectionResource, nftId: listing.nftId, expiryEpoch: safeEpochShim(listing.expiresAtEpoch) },
      );
    },
    fillCollectionBid(bid, sellerAccount, nftId) {
      return fillCollectionBid(
        bid.bidAddress,
        sellerAccount,
        bid.collectionResource,
        nftId,
        { quoteResource: bid.quoteResource, amount: bid.pricePerNft, expiryEpoch: safeEpochShim(bid.expiresAtEpoch) },
      );
    },
    acceptItemOffer(offer, sellerAccount) {
      return acceptItemOffer(
        offer.offerAddress,
        sellerAccount,
        offer.collectionResource,
        offer.nftId,
        { quoteResource: offer.quoteResource, amount: offer.amount, expiryEpoch: safeEpochShim(offer.expiresAtEpoch) },
      );
    },
  };
}

/** Adapter-side glue: convert a resolver-constructed intent into the wallet preview seam. */
export function toWiredMarketplacePreview(intentValue: MarketplaceTransactionIntent): TransactionPreview {
  return toMarketplacePreview(intentValue);
}

/** Numeric display shim for preview-only fields; the decimal string stays authoritative. */
function safeEpochShim(epoch: string): number {
  if (!/^\d+$/.test(epoch)) return 0;
  const value = Number(epoch);
  return Number.isSafeInteger(value) ? value : 0;
}
