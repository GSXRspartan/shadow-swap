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
  decodeCollectionBid,
  decodeItemOffer,
  decodeListing,
  setMarketplaceCurrentEpoch,
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
import { REAL_INDEXER_TRANSPORT } from './pools.js';
import { TariIndexerDiscovery, type DiscoveredComponent } from './ootleIndexer.js';
import { describeIdentity, isVerified, verifyIndexerIdentity } from './indexerIdentity.js';
import { safeLocalStorage, type RegistryStorage } from './poolRegistry.js';
import {
  knownComponents as registryKnownComponents,
  rememberDiscovered as registryRememberDiscovered,
  seededTemplateFor as registrySeededTemplateFor,
} from './marketplaceRegistry.js';
import { deploymentFor, marketplaceTemplateNameFor, recordVerifiedGeneration, type ProtocolDeployment } from './protocolDeployment.js';
import { codecFor, normalizeBatchEntry } from './ootleWire.js';
import { describeGeneration, type IndexerWireFormat } from '../lib/ootleCohort.js';

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

export function createMarketplaceSource(config: AppConfig, storage?: RegistryStorage): MarketplaceSource {
  /*
   * Two sources, chosen in this order, and the default is the chain.
   *
   * 1. `OotleIndexerMarketplaceSource` — reads real components from the configured
   *    Ootle indexer using the routes that actually exist (`/substates/fetch`,
   *    `/transaction-receipts`). This is the default, and it is what a deployment
   *    with no extra services uses.
   *
   * 2. `IndexerMarketplaceSource` — the `{query, params}` JSON-RPC-style discovery
   *    protocol, used only when an operator explicitly points `VITE_NFT_DISCOVERY_URL`
   *    at a service that speaks it.
   *
   * WHY THE DEFAULT CHANGED, IN ONE SENTENCE: the previous default passed the bare
   * indexer ORIGIN to the `{query, params}` source, and the Ootle indexer serves no
   * such route — `POST /` answers 404 with no CORS headers, so every query failed
   * and the marketplace rendered "no collections" for a network where three
   * templates are published and readable.
   */
  const dedicated = config.nftDiscoveryUrl;
  if (dedicated !== undefined) return new IndexerMarketplaceSource(dedicated);
  const url = config.indexerUrls[0];
  return url === undefined ? new UnavailableMarketplaceSource() : new OotleIndexerMarketplaceSource(config, storage);
}

/* ------------------------------------------------------------------------- *
 * Ootle-indexer-backed discovery.
 *
 * Everything above is the operator-service protocol and is unchanged. Everything
 * below reads the chain through the routes it actually has, and reuses the
 * protocol-client's own dual-form decoders so there is exactly ONE implementation
 * of "what does this marketplace component's state mean".
 * ------------------------------------------------------------------------- */

/**
 * A raw-substate reader over `POST /substates/fetch`, with a per-address memo.
 *
 * The memo is what keeps this affordable: decoding one listing needs the component
 * substate AND its escrow vault substate, and `componentsOfTemplates` has just read
 * the components, so without a cache every component would be fetched twice. Reads
 * are idempotent and the snapshot is short-lived, so a memo cannot serve stale
 * state across a settlement.
 */
class IndexerSubstateReader {
  private readonly memo = new Map<string, unknown>();

  /** `format` is the wire format the endpoint declared at `GET /info` (lib/ootleCohort.ts). */
  constructor(
    private readonly base: string,
    private readonly format: IndexerWireFormat,
  ) {}

  async read(address: string): Promise<unknown> {
    const cached = this.memo.get(address);
    if (cached !== undefined) return cached;
    const payload = await postJson(`${this.base}/substates/fetch`, { requests: [address], cached_only: false });
    if (!payload.ok) throw new Error(payload.reason);
    const substates = (payload.payload as Record<string, unknown> | undefined)?.substates;
    if (typeof substates !== 'object' || substates === null) throw new Error('The batch substate response carried no `substates` map.');
    const entry = (substates as Record<string, unknown>)[address];
    // Absent from the map: the indexer holds no live version of it. That is "not
    // present", which the decoders already treat as a refusal, never as an empty value.
    if (entry === undefined) return undefined;
    const codec = await codecFor(this.format);
    if (!codec.ok) throw new Error(codec.reason);
    const normalized = normalizeBatchEntry(entry, this.format, codec.value, address);
    if (!normalized.ok) throw new Error(normalized.reason);
    const value = normalized.value.value;
    const unwrapped = (value.Component as unknown) ?? value;
    this.memo.set(address, unwrapped);
    return unwrapped;
  }
}

/**
 * Establish the endpoint's identity AND the protocol deployment that applies to it.
 * Every marketplace read starts here, so a template address is never consulted on a
 * network generation it was not published on.
 */
async function verifiedMarketplaceDeployment(
  base: string,
  config: AppConfig,
): Promise<{ ok: true; deployment: ProtocolDeployment; format: IndexerWireFormat; epoch?: string } | { ok: false; reason: string }> {
  const identity = await verifyIndexerIdentity(base, { network: config.network, networkName: config.network });
  if (!isVerified(identity)) {
    return { ok: false, reason: `The indexer's network identity could not be established: ${describeIdentity(identity)}. No marketplace state is read.` };
  }
  const lock = recordVerifiedGeneration(config.network, identity.cohort.generation);
  if (!lock.ok) return { ok: false, reason: lock.reason };
  const deployment = deploymentFor(config.network, identity.cohort.generation);
  return {
    ok: true,
    deployment,
    format: identity.cohort.wireFormat,
    ...(identity.currentEpoch === undefined ? {} : { epoch: identity.currentEpoch }),
  };
}

interface MarketplaceSnapshot {
  listings: Listing[];
  offers: ItemOffer[];
  bids: CollectionBid[];
  /** Components read from the chain that no template could decode. Diagnostic only. */
  undecodable: number;
}

const EMPTY_SNAPSHOT: MarketplaceSnapshot = { listings: [], offers: [], bids: [], undecodable: 0 };

/**
 * Marketplace discovery read directly from the Ootle chain.
 *
 * SECURITY POSTURE — unchanged from every other discovery layer here:
 *   - discovery is ADVISORY. Every action rereads the component through the WALLET
 *     provider (`marketplaceReadbackFrom`) immediately before construction, so a
 *     wrong or stale discovery record can never become an executed amount;
 *   - nothing here can make a component appear. Candidates come from a bounded
 *     receipt scan plus an untrusted local cache, and each is reverified against its
 *     own on-chain `header.template_address`;
 *   - a component that cannot be decoded is COUNTED, not silently dropped, so "0
 *     listings" is never actually "0 listings plus N unreadable states".
 */
export class OotleIndexerMarketplaceSource implements MarketplaceSource {
  readonly name: string;
  private failureReason: string | undefined;
  private snapshot: MarketplaceSnapshot | undefined;
  private inFlight: Promise<MarketplaceSnapshot> | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: RegistryStorage | undefined = safeLocalStorage(),
  ) {
    const host = config.indexerUrls[0] === undefined ? undefined : (() => {
      try {
        return new URL(config.indexerUrls[0] as string).host;
      } catch {
        return undefined;
      }
    })();
    this.name = host === undefined ? 'ootle-indexer:invalid' : `ootle-indexer:${host}`;
  }

  get unavailableReason(): string | undefined {
    return this.failureReason;
  }

  /** Concurrent callers share one discovery pass instead of racing the chain. */
  private async ensure(): Promise<MarketplaceSnapshot> {
    if (this.snapshot !== undefined) return this.snapshot;
    if (this.inFlight !== undefined) return this.inFlight;
    this.inFlight = this.discover()
      .then((snapshot) => {
        this.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async discover(): Promise<MarketplaceSnapshot> {
    const base = this.config.indexerUrls[0];
    if (base === undefined) {
      this.failureReason = 'No indexer endpoint is configured for this build. Marketplace discovery is unavailable.';
      return EMPTY_SNAPSHOT;
    }
    try {
      const verified = await verifiedMarketplaceDeployment(base, this.config);
      if (!verified.ok) {
        this.failureReason = verified.reason;
        return EMPTY_SNAPSHOT;
      }
      const { deployment, format } = verified;
      // Expiry depends on the current epoch, so the decoder is given the epoch the
      // indexer just reported. Without it an expired listing would still read as
      // ACTIVE and a buy would be offered against an order that cannot settle.
      if (verified.epoch !== undefined) setMarketplaceCurrentEpoch(verified.epoch);
      const templates = deployment.marketplaceTemplates;
      if (templates === undefined) {
        this.failureReason = `The indexer serves the ${describeGeneration(deployment.generation)}. ${deployment.status} No marketplace component can exist there yet, so none is shown.`;
        return EMPTY_SNAPSHOT;
      }

      const client = new TariIndexerDiscovery(base, {
        transport: REAL_INDEXER_TRANSPORT,
        verifyIdentity: async () => ({ ok: true }),
        wireFormat: format,
      });
      const found = await client.componentsOfTemplates(
        Object.values(templates),
        registryKnownComponents(deployment.registryKey, this.storage),
      );
      if (!found.ok) {
        this.failureReason = `Marketplace components could not be read from the indexer: ${found.reason}`;
        return EMPTY_SNAPSHOT;
      }

      const snapshot: MarketplaceSnapshot = { listings: [], offers: [], bids: [], undecodable: 0 };
      const reader = new IndexerSubstateReader(base, format);
      for (const component of found.components) {
        const name = marketplaceTemplateNameFor(deployment, component.templateAddress);
        if (name === undefined) continue;
        // Prefer the protocol seed's pin when there is one; otherwise fall back to
        // the template this component's own header just reported, which
        // `componentsOfTemplates` already matched against the recorded set.
        const pinned = registrySeededTemplateFor(deployment.registryKey, component.componentAddress) ?? name;
        try {
          const facts =
            pinned === 'FixedPriceListing'
              ? await decodeListing(reader, component.componentAddress, templates.FixedPriceListing)
              : pinned === 'ItemOffer'
                ? await decodeItemOffer(reader, component.componentAddress, templates.ItemOffer)
                : await decodeCollectionBid(reader, component.componentAddress, templates.CollectionBid);
          if (facts.listing !== undefined) snapshot.listings.push(facts.listing);
          if (facts.itemOffer !== undefined) snapshot.offers.push(facts.itemOffer);
          if (facts.collectionBid !== undefined) snapshot.bids.push(facts.collectionBid);
        } catch {
          snapshot.undecodable += 1;
        }
      }
      registryRememberDiscovered(
        deployment.registryKey,
        found.components.map((component: DiscoveredComponent) => component.componentAddress),
        this.storage,
      );
      if (snapshot.undecodable > 0 && snapshot.listings.length + snapshot.offers.length + snapshot.bids.length === 0) {
        this.failureReason = `${snapshot.undecodable} marketplace component(s) were found on chain but none could be decoded by this build. Nothing is fabricated in their place.`;
      }
      return snapshot;
    } catch (error) {
      this.failureReason = `Marketplace discovery failed: ${(error as Error).message}`;
      return EMPTY_SNAPSHOT;
    }
  }

  async listCollections(): Promise<string[] | undefined> {
    const snapshot = await this.ensure();
    const seen = new Set<string>();
    for (const listing of snapshot.listings) seen.add(listing.collectionResource);
    for (const offer of snapshot.offers) seen.add(offer.collectionResource);
    for (const bid of snapshot.bids) seen.add(bid.collectionResource);
    return seen.size === 0 ? undefined : [...seen].sort();
  }

  async listItems(collectionResource: string): Promise<NftDescriptor[]> {
    const snapshot = await this.ensure();
    const byKey = new Map<string, NftDescriptor>();
    const touch = (nftId: string): NftDescriptor => {
      const existing = byKey.get(nftId);
      if (existing !== undefined) return existing;
      const created: NftDescriptor = { collectionResource, nftId };
      byKey.set(nftId, created);
      return created;
    };
    for (const listing of snapshot.listings) {
      if (listing.collectionResource !== collectionResource) continue;
      const item = touch(listing.nftId);
      item.listingAddress = listing.listingAddress;
      item.priceRaw = listing.price;
      item.quoteResource = listing.quoteResource;
    }
    for (const offer of snapshot.offers) {
      if (offer.collectionResource !== collectionResource) continue;
      const item = touch(offer.nftId);
      item.offerAddress = offer.offerAddress;
      // An offer is a bid, not an ask: it never becomes the card's headline price.
      item.priceRaw = item.priceRaw ?? offer.amount;
      item.quoteResource = item.quoteResource ?? offer.quoteResource;
    }
    return [...byKey.values()].sort((a, b) => (a.nftId < b.nftId ? -1 : a.nftId > b.nftId ? 1 : 0));
  }

  /**
   * Read one listing by address.
   *
   * Discovery first, because it is already decoded and free. If discovery has not
   * seen it, the component is read DIRECTLY from the chain and decoded — this is
   * what makes a shared listing link resolve even when the component has aged out
   * of the receipt window.
   */
  async readListing(listingAddress: string): Promise<Listing | undefined> {
    const snapshot = await this.ensure();
    const known = snapshot.listings.find((l) => l.listingAddress === listingAddress);
    if (known !== undefined) return known;
    const base = this.config.indexerUrls[0];
    if (base === undefined) return undefined;
    try {
      const verified = await verifiedMarketplaceDeployment(base, this.config);
      if (!verified.ok) return undefined;
      if (verified.epoch !== undefined) setMarketplaceCurrentEpoch(verified.epoch);
      const templates = verified.deployment.marketplaceTemplates;
      if (templates === undefined) return undefined;
      const facts = await decodeListing(new IndexerSubstateReader(base, verified.format), listingAddress, templates.FixedPriceListing);
      return facts.listing;
    } catch {
      // Wrong template, absent component, or an undecodable body all land here.
      // A direct read that cannot be proven is reported as absent, never coerced.
      return undefined;
    }
  }

  async findBids(collectionResource: string, quoteResource: string): Promise<CollectionBid[]> {
    const snapshot = await this.ensure();
    return snapshot.bids.filter((bid) => bid.collectionResource === collectionResource && bid.quoteResource === quoteResource);
  }

  async findItemOffers(collectionResource: string, quoteResource: string): Promise<ItemOffer[]> {
    const snapshot = await this.ensure();
    return snapshot.offers.filter((offer) => offer.collectionResource === collectionResource && offer.quoteResource === quoteResource);
  }

  /**
   * Recent sales are NOT derived.
   *
   * A transaction receipt records which substates a transaction touched; it does not
   * record the price a given listing settled at, nor which of several touched
   * components was the counterparty. Deriving a "recent sale" from it would mean
   * inventing the amount — the exact thing this app exists not to do — so the list
   * is empty until an authoritative source for it exists.
   */
  async recentSales(): Promise<RecentSale[]> {
    return [];
  }
}
