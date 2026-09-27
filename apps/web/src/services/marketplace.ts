/**
 * NFT marketplace service.
 *
 * Discovery and authoritative readback are kept strictly separate, exactly as the
 * protocol-client models them:
 *   - `MarketplaceDiscoveryProvider` is advisory (an indexer). It is never the
 *     authority for an execution amount.
 *   - `MarketplaceReadbackProvider` is the wallet-backed reread every resolver
 *     performs immediately before construction.
 *
 * Collection aggregates (floor, best bid, spread, depth) come from the
 * protocol-client's `buildCollectionMarketData`, not from UI math.
 */

import {
  buildCollectionMarketData,
  type CollectionBid,
  type CollectionMarketData,
  type ItemOffer,
  type Listing,
  type MarketplaceDiscoveryProvider,
  type MarketplaceReadbackProvider,
  type AuthoritativeRead,
  type RecentSale,
} from '@tari-ootle/protocol-client';
import { discoveryList, postJson } from './net.js';
import type { AppConfig } from './config.js';

export interface NftDescriptor {
  collectionResource: string;
  nftId: string;
  /** Exact identities, always present. */
  listingAddress?: string;
  offerAddress?: string;
  bidAddress?: string;
  priceRaw?: string;
  quoteResource?: string;
  /** Untrusted. Rendered only through the sanitiser. */
  metadataUri?: string;
}

export interface MarketplaceSource {
  readonly name: string;
  listCollections(): Promise<string[] | undefined>;
  listItems(collectionResource: string): Promise<NftDescriptor[]>;
  readListing(listingAddress: string): Promise<Listing | undefined>;
  findBids(collectionResource: string, quoteResource: string): Promise<CollectionBid[]>;
  findItemOffers(collectionResource: string, quoteResource: string): Promise<ItemOffer[]>;
  recentSales(collectionResource: string, quoteResource: string): Promise<RecentSale[]>;
}

export class UnavailableMarketplaceSource implements MarketplaceSource {
  readonly name = 'unconfigured';
  private readonly reason = 'No NFT discovery endpoint is configured for this build. Collections and items are not fabricated.';

  async listCollections(): Promise<string[] | undefined> {
    return undefined;
  }
  async listItems(): Promise<NftDescriptor[]> {
    return [];
  }
  async readListing(): Promise<Listing | undefined> {
    return undefined;
  }
  async findBids(): Promise<CollectionBid[]> {
    return [];
  }
  async findItemOffers(): Promise<ItemOffer[]> {
    return [];
  }
  async recentSales(): Promise<RecentSale[]> {
    return [];
  }
  get unavailableReason(): string {
    return this.reason;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function raw(value: unknown): string | undefined {
  const text = str(value);
  return text !== undefined && /^\d+$/.test(text) ? text : undefined;
}

const LISTING_STATUSES = new Set(['ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED']);

export function parseListing(rawListing: unknown): Listing | undefined {
  if (typeof rawListing !== 'object' || rawListing === null) return undefined;
  const record = rawListing as Record<string, unknown>;
  const listingAddress = str(record.listingAddress);
  const sellerAccount = str(record.sellerAccount);
  const collectionResource = str(record.collectionResource);
  const nftId = str(record.nftId);
  const quoteResource = str(record.quoteResource);
  const price = raw(record.price);
  const expiresAtEpoch = raw(record.expiresAtEpoch);
  if (listingAddress === undefined || sellerAccount === undefined || collectionResource === undefined || nftId === undefined) return undefined;
  if (quoteResource === undefined || price === undefined || expiresAtEpoch === undefined) return undefined;
  const status = LISTING_STATUSES.has(String(record.status)) ? (record.status as Listing['status']) : 'ACTIVE';
  const listing: Listing = { listingAddress, sellerAccount, collectionResource, nftId, quoteResource, price, expiresAtEpoch, status };
  const createdAtEpoch = raw(record.createdAtEpoch);
  if (createdAtEpoch !== undefined) listing.createdAtEpoch = createdAtEpoch;
  return listing;
}

export function parseCollectionBid(rawBid: unknown): CollectionBid | undefined {
  if (typeof rawBid !== 'object' || rawBid === null) return undefined;
  const record = rawBid as Record<string, unknown>;
  const bidAddress = str(record.bidAddress);
  const buyerAccount = str(record.buyerAccount);
  const collectionResource = str(record.collectionResource);
  const quoteResource = str(record.quoteResource);
  const pricePerNft = raw(record.pricePerNft);
  const originalQuantity = raw(record.originalQuantity);
  const remainingQuantity = raw(record.remainingQuantity);
  const originalEscrow = raw(record.originalEscrow);
  const remainingEscrow = raw(record.remainingEscrow);
  const createdAtEpoch = raw(record.createdAtEpoch);
  const expiresAtEpoch = raw(record.expiresAtEpoch);
  if (bidAddress === undefined || buyerAccount === undefined || collectionResource === undefined || quoteResource === undefined) return undefined;
  if (pricePerNft === undefined || originalQuantity === undefined || remainingQuantity === undefined) return undefined;
  if (originalEscrow === undefined || remainingEscrow === undefined || createdAtEpoch === undefined || expiresAtEpoch === undefined) return undefined;
  const status = ['ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'].includes(String(record.status))
    ? (record.status as CollectionBid['status'])
    : 'ACTIVE';
  return { bidAddress, buyerAccount, collectionResource, quoteResource, pricePerNft, originalQuantity, remainingQuantity, originalEscrow, remainingEscrow, createdAtEpoch, expiresAtEpoch, status };
}

export function parseItemOffer(rawOffer: unknown): ItemOffer | undefined {
  if (typeof rawOffer !== 'object' || rawOffer === null) return undefined;
  const record = rawOffer as Record<string, unknown>;
  const offerAddress = str(record.offerAddress);
  const buyerAccount = str(record.buyerAccount);
  const collectionResource = str(record.collectionResource);
  const nftId = str(record.nftId);
  const quoteResource = str(record.quoteResource);
  const amount = raw(record.amount);
  const createdAtEpoch = raw(record.createdAtEpoch);
  const expiresAtEpoch = raw(record.expiresAtEpoch);
  if (offerAddress === undefined || buyerAccount === undefined || collectionResource === undefined || nftId === undefined) return undefined;
  if (quoteResource === undefined || amount === undefined || createdAtEpoch === undefined || expiresAtEpoch === undefined) return undefined;
  const status = ['ACTIVE', 'ACCEPTED', 'CANCELLED', 'EXPIRED'].includes(String(record.status)) ? (record.status as ItemOffer['status']) : 'ACTIVE';
  return { offerAddress, buyerAccount, collectionResource, nftId, quoteResource, amount, createdAtEpoch, expiresAtEpoch, status };
}

export function parseRecentSale(rawSale: unknown): RecentSale | undefined {
  if (typeof rawSale !== 'object' || rawSale === null) return undefined;
  const record = rawSale as Record<string, unknown>;
  const listingOrOfferAddress = str(record.listingOrOfferAddress);
  const collectionResource = str(record.collectionResource);
  const nftId = str(record.nftId);
  const quoteResource = str(record.quoteResource);
  const amount = raw(record.amount);
  if (listingOrOfferAddress === undefined || collectionResource === undefined || nftId === undefined) return undefined;
  if (quoteResource === undefined || amount === undefined) return undefined;
  const sale: RecentSale = {
    listingOrOfferAddress,
    collectionResource,
    nftId,
    quoteResource,
    amount,
    source: record.source === 'RECEIPT' ? 'RECEIPT' : 'INDEXER_OBSERVATION',
  };
  const epoch = raw(record.epoch);
  if (epoch !== undefined) sale.epoch = epoch;
  return sale;
}

/** Indexer-backed discovery. Malformed records are dropped, never coerced. */
export class IndexerMarketplaceSource implements MarketplaceSource {
  readonly name: string;
  private failureReason: string | undefined;
  /** Set when the configured URL is unusable. Discovery then fails closed. */
  private readonly invalid: string | undefined;

  constructor(private readonly url: string) {
    let host: string | undefined;
    try {
      host = new URL(url).host;
    } catch {
      host = undefined;
    }
    this.invalid = host === undefined ? `The configured NFT discovery endpoint is not a valid URL: ${url}` : undefined;
    this.name = host === undefined ? 'indexer:invalid' : `indexer:${host}`;
  }

  /**
   * Why the most recent query produced nothing, when the cause was a transport
   * or shape failure rather than a legitimately empty result. `undefined` means
   * the endpoint answered. The page uses this only to choose its wording.
   */
  get unavailableReason(): string | undefined {
    return this.failureReason;
  }

  private async query<T>(name: string, params: Record<string, unknown>, parse: (raw: unknown) => T | undefined): Promise<T[]> {
    if (this.invalid !== undefined) {
      this.failureReason = this.invalid;
      return [];
    }
    // Bounded transport: always terminates, always caps the body, and always
    // states a reason, so "the endpoint is down" can never be rendered as
    // "there are no collections".
    const result = await postJson(this.url, { query: name, params });
    if (!result.ok) {
      this.failureReason = result.reason;
      return [];
    }
    const list = discoveryList(result.payload);
    if (!list.ok) {
      this.failureReason = list.reason;
      return [];
    }
    const parsed = list.list.map(parse).filter((entry): entry is T => entry !== undefined);
    // Every record being dropped is a shape mismatch, not an empty result: say so
    // rather than letting the page report a clean zero.
    this.failureReason =
      parsed.length === 0 && list.list.length > 0
        ? `The discovery endpoint returned ${list.list.length} record(s), none of which this build could read.`
        : undefined;
    return parsed;
  }

  async listCollections(): Promise<string[] | undefined> {
    const collections = await this.query<string>('nft_collections', {}, (rawCollection) => str(typeof rawCollection === 'object' && rawCollection !== null ? (rawCollection as Record<string, unknown>).collectionResource : rawCollection));
    return collections.length > 0 ? collections : undefined;
  }

  async listItems(collectionResource: string): Promise<NftDescriptor[]> {
    return this.query<NftDescriptor>('nft_items', { collectionResource }, (rawItem) => {
      if (typeof rawItem !== 'object' || rawItem === null) return undefined;
      const record = rawItem as Record<string, unknown>;
      const nftId = str(record.nftId);
      if (nftId === undefined) return undefined;
      const descriptor: NftDescriptor = { collectionResource, nftId };
      const listingAddress = str(record.listingAddress);
      const offerAddress = str(record.offerAddress);
      const bidAddress = str(record.bidAddress);
      const price = raw(record.price);
      const quoteResource = str(record.quoteResource);
      const metadataUri = str(record.metadataUri);
      if (listingAddress !== undefined) descriptor.listingAddress = listingAddress;
      if (offerAddress !== undefined) descriptor.offerAddress = offerAddress;
      if (bidAddress !== undefined) descriptor.bidAddress = bidAddress;
      if (price !== undefined) descriptor.priceRaw = price;
      if (quoteResource !== undefined) descriptor.quoteResource = quoteResource;
      if (metadataUri !== undefined) descriptor.metadataUri = metadataUri;
      return descriptor;
    });
  }

  async readListing(listingAddress: string): Promise<Listing | undefined> {
    const [listing] = await this.query<Listing>('nft_listing_read', { listingAddress }, parseListing);
    return listing;
  }

  async findBids(collectionResource: string, quoteResource: string): Promise<CollectionBid[]> {
    return this.query<CollectionBid>('nft_collection_bids', { collectionResource, quoteResource }, parseCollectionBid);
  }

  async findItemOffers(collectionResource: string, quoteResource: string): Promise<ItemOffer[]> {
    return this.query<ItemOffer>('nft_item_offers', { collectionResource, quoteResource }, parseItemOffer);
  }

  async recentSales(collectionResource: string, quoteResource: string): Promise<RecentSale[]> {
    return this.query<RecentSale>('nft_recent_sales', { collectionResource, quoteResource }, parseRecentSale);
  }
}

/**
 * Freshness shape the wallet-backed readback produces (`ExecutionAuthoritativeRead`):
 * `{ source, identity: { epoch?, stateIdentity?, readAtUnixMs } }`. Adapted here into
 * the marketplace port's `AuthoritativeFreshness` so the Ootle provider can be
 * reused without re-implementing any parsing.
 */
interface WalletFreshnessShape {
  source: string;
  identity: { epoch?: string; stateIdentity?: string; readAtUnixMs: number };
}

type WalletRead<T> = { status: 'FOUND'; value: T; freshness: WalletFreshnessShape } | { status: 'UNAVAILABLE'; reason: string };

interface WalletReadbackShape {
  readListing(listingAddress: string): Promise<WalletRead<Listing>>;
  readItemOffer(offerAddress: string): Promise<WalletRead<ItemOffer>>;
  readCollectionBid(bidAddress: string): Promise<WalletRead<CollectionBid>>;
}

function adapt<T extends Listing | ItemOffer | CollectionBid>(found: { status: 'FOUND'; value: T; freshness: WalletFreshnessShape }): AuthoritativeRead<T> {
  const source = found.freshness.source === 'WALLET_PROVIDER' ? 'WALLET_PROVIDER' : found.freshness.source === 'BROWSER_PROVIDER' ? 'BROWSER_PROVIDER' : 'INDEXER_SUBSTATE';
  return {
    status: 'FOUND',
    value: found.value,
    freshness: {
      source,
      observedAtUnixMs: found.freshness.identity.readAtUnixMs,
      ...(found.freshness.identity.epoch === undefined ? {} : { readAtEpoch: found.freshness.identity.epoch }),
    },
  };
}

/**
 * Adapter turning the readback port the wallet provides into the marketplace
 * port the resolvers require. Discovery data is never used here.
 */
export function marketplaceReadbackFrom(readback: WalletReadbackShape): MarketplaceReadbackProvider {
  return {
    async readListing(listingAddress) {
      const result = await readback.readListing(listingAddress);
      if (result.status !== 'FOUND') return { status: 'UNAVAILABLE', reason: result.reason };
      return adapt(result);
    },
    async readItemOffer(offerAddress) {
      const result = await readback.readItemOffer(offerAddress);
      if (result.status !== 'FOUND') return { status: 'UNAVAILABLE', reason: result.reason };
      return adapt(result);
    },
    async readCollectionBid(bidAddress) {
      const result = await readback.readCollectionBid(bidAddress);
      if (result.status !== 'FOUND') return { status: 'UNAVAILABLE', reason: result.reason };
      return adapt(result);
    },
  };
}

export function marketplaceDiscoveryFrom(source: MarketplaceSource): MarketplaceDiscoveryProvider {
  return {
    async findListing(criteria) {
      if (criteria.listingAddress !== undefined) {
        const listing = await source.readListing(criteria.listingAddress);
        if (listing === undefined) return undefined;
        if (criteria.collectionResource !== undefined && listing.collectionResource !== criteria.collectionResource) return undefined;
        if (criteria.nftId !== undefined && listing.nftId !== criteria.nftId) return undefined;
        if (listing.quoteResource !== criteria.quoteResource) return undefined;
        return listing;
      }
      if (criteria.collectionResource === undefined || criteria.nftId === undefined) return undefined;
      const items = await source.listItems(criteria.collectionResource);
      for (const item of items) {
        if (item.nftId !== criteria.nftId || item.listingAddress === undefined) continue;
        const listing = await source.readListing(item.listingAddress);
        if (listing === undefined) continue;
        if (listing.quoteResource !== criteria.quoteResource) continue;
        return listing;
      }
      return undefined;
    },
    async findCollectionBids(criteria) {
      return source.findBids(criteria.collectionResource, criteria.quoteResource);
    },
  };
}

/** Collection aggregates via the protocol-client (never re-derived in the UI). */
export function buildCollectionView(input: {
  collectionResource: string;
  quoteResource: string;
  listings: Listing[];
  itemOffers: ItemOffer[];
  bids: CollectionBid[];
  recentSales: RecentSale[];
}): CollectionMarketData {
  return buildCollectionMarketData(input);
}

export type { CollectionMarketData, Listing, ItemOffer, CollectionBid, AuthoritativeRead };

export function createMarketplaceSource(config: AppConfig): MarketplaceSource {
  const url = config.indexerUrls[0];
  return url === undefined ? new UnavailableMarketplaceSource() : new IndexerMarketplaceSource(url);
}
