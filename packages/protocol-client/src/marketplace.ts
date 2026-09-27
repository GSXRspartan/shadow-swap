/**
 * Marketplace discovery is advisory. `MarketplaceReadbackProvider` is the separate boundary a
 * wallet/provider must use immediately before construction/signing. All on-chain amounts, u64
 * quantities, and epochs are decimal strings so no blockchain value passes through `number`.
 */
export type RawAmount = string;
export type RawU64 = string;
export type MarketplaceReadSource = 'INDEXER_SUBSTATE' | 'WALLET_PROVIDER' | 'BROWSER_PROVIDER';
export type ListingStatus = 'ACTIVE' | 'SOLD' | 'CANCELLED' | 'EXPIRED';
export type ItemOfferStatus = 'ACTIVE' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED';
export type CollectionBidStatus = 'ACTIVE' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'EXPIRED';

export interface Listing {
  listingAddress: string;
  sellerAccount: string;
  collectionResource: string;
  nftId: string;
  quoteResource: string;
  price: RawAmount;
  /** The current listing template does not expose this field. */
  createdAtEpoch?: RawU64;
  expiresAtEpoch: RawU64;
  status: ListingStatus;
}

export interface ItemOffer {
  offerAddress: string;
  buyerAccount: string;
  collectionResource: string;
  nftId: string;
  quoteResource: string;
  amount: RawAmount;
  createdAtEpoch: RawU64;
  expiresAtEpoch: RawU64;
  status: ItemOfferStatus;
}

export interface CollectionBid {
  bidAddress: string;
  buyerAccount: string;
  collectionResource: string;
  quoteResource: string;
  pricePerNft: RawAmount;
  originalQuantity: RawU64;
  remainingQuantity: RawU64;
  originalEscrow: RawAmount;
  remainingEscrow: RawAmount;
  createdAtEpoch: RawU64;
  expiresAtEpoch: RawU64;
  status: CollectionBidStatus;
}

export interface AuthoritativeFreshness {
  source: MarketplaceReadSource;
  /** Epoch returned by the provider where available. */
  readAtEpoch?: RawU64;
  observedAtUnixMs: number;
}

export type AuthoritativeRead<T> =
  | { status: 'FOUND'; value: T; freshness: AuthoritativeFreshness }
  | { status: 'UNAVAILABLE'; reason: string };

/** This interface is intentionally separate from index/discovery search. */
export interface MarketplaceReadbackProvider {
  readListing(listingAddress: string): Promise<AuthoritativeRead<Listing>>;
  readItemOffer(offerAddress: string): Promise<AuthoritativeRead<ItemOffer>>;
  readCollectionBid(bidAddress: string): Promise<AuthoritativeRead<CollectionBid>>;
}

/** Indexers may implement this for discovery only; their returned orders are never settled directly. */
export interface MarketplaceDiscoveryProvider {
  findListing(criteria: { listingAddress?: string; collectionResource?: string; nftId?: string; quoteResource: string }): Promise<Listing | undefined>;
  findCollectionBids(criteria: { collectionResource: string; quoteResource: string }): Promise<CollectionBid[]>;
}

export type MarketplaceRouteKind =
  | 'NFT_BUY_NOW'
  | 'NFT_SELL_NOW'
  | 'NFT_ACCEPT_ITEM_OFFER'
  | 'NFT_CREATE_LISTING'
  | 'NFT_CREATE_ITEM_OFFER'
  | 'NFT_CREATE_COLLECTION_BID';

export type MarketplaceBuilderOperation = 'buy_listing' | 'fill_collection_bid' | 'accept_item_offer';
export type MarketplaceResolutionStatus = 'READY' | 'STALE' | 'EXPIRED' | 'FILLED' | 'CANCELLED' | 'INSUFFICIENT_REMAINING_ESCROW' | 'UNAVAILABLE';

/** Adapter injection keeps protocol-client independent of walletd, browser, and Sapient signers. */
export interface MarketplaceRouteBuilder<TIntent> {
  buyListing(listing: Listing, buyerAccount: string): TIntent;
  fillCollectionBid(bid: CollectionBid, sellerAccount: string, nftId: string): TIntent;
  acceptItemOffer(offer: ItemOffer, sellerAccount: string): TIntent;
}

export interface ExecutableMarketplaceRoute<TIntent> {
  routeKind: Extract<MarketplaceRouteKind, 'NFT_BUY_NOW' | 'NFT_SELL_NOW' | 'NFT_ACCEPT_ITEM_OFFER'>;
  componentOrOrderId: string;
  inputAsset: { resourceAddress: string; amount?: RawAmount; nftId?: string };
  outputAsset: { resourceAddress: string; amount?: RawAmount; nftId?: string };
  collectionResource: string;
  nftId: string;
  quoteResource: string;
  exactAmount: RawAmount;
  expiryEpoch: RawU64;
  currentAuthoritativeStatus: ListingStatus | ItemOfferStatus | CollectionBidStatus;
  readback: AuthoritativeFreshness;
  walletWithdrawals: Array<{ resourceAddress: string; amount?: RawAmount; nftId?: string }>;
  builderOperation: MarketplaceBuilderOperation;
  builderIntent: TIntent;
  expectedSettlement: string;
}

export type MarketplaceResolution<TIntent> =
  | { status: 'READY'; route: ExecutableMarketplaceRoute<TIntent> }
  | { status: Exclude<MarketplaceResolutionStatus, 'READY'>; componentOrOrderId?: string; reason: string };

export interface BuyNowInput {
  listing: { listingAddress: string } | { collectionResource: string; nftId: string };
  expectedQuoteResource: string;
  expectedPrice?: RawAmount;
  buyerAccount: string;
}

export interface SellNowInput {
  collectionResource: string;
  nftId: string;
  quoteResource: string;
  sellerAccount: string;
  /** The seller may choose a discovered bid; otherwise the highest discovered bid is recommended. */
  selectedBidAddress?: string;
}

export interface AcceptItemOfferInput {
  offerAddress: string;
  sellerAccount: string;
  expectedCollectionResource: string;
  expectedNftId: string;
  expectedQuoteResource: string;
  expectedAmount: RawAmount;
}

function normalizedDecimal(value: RawAmount): [string, string] {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid non-negative market amount: ${value}`);
  const [integer, fraction = ''] = value.split('.');
  return [integer.replace(/^0+(?=\d)/, ''), fraction.replace(/0+$/, '')];
}

function compareDecimal(left: RawAmount, right: RawAmount): number {
  const [leftInteger, leftFraction] = normalizedDecimal(left);
  const [rightInteger, rightFraction] = normalizedDecimal(right);
  if (leftInteger.length !== rightInteger.length) return leftInteger.length - rightInteger.length;
  if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
  const decimals = Math.max(leftFraction.length, rightFraction.length);
  const lhs = leftFraction.padEnd(decimals, '0');
  const rhs = rightFraction.padEnd(decimals, '0');
  return lhs === rhs ? 0 : lhs < rhs ? -1 : 1;
}

function addDecimal(left: RawAmount, right: RawAmount): RawAmount {
  const [leftInteger, leftFraction] = normalizedDecimal(left);
  const [rightInteger, rightFraction] = normalizedDecimal(right);
  const decimals = Math.max(leftFraction.length, rightFraction.length);
  const scale = 10n ** BigInt(decimals);
  const scaled = (integer: string, fraction: string) => BigInt(integer) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
  const total = scaled(leftInteger, leftFraction) + scaled(rightInteger, rightFraction);
  const whole = total / scale;
  const fraction = (total % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function subtractDecimal(left: RawAmount, right: RawAmount): RawAmount {
  if (compareDecimal(left, right) < 0) throw new Error('Market spread cannot be negative');
  const [leftInteger, leftFraction] = normalizedDecimal(left);
  const [rightInteger, rightFraction] = normalizedDecimal(right);
  const decimals = Math.max(leftFraction.length, rightFraction.length);
  const scale = 10n ** BigInt(decimals);
  const scaled = (integer: string, fraction: string) => BigInt(integer) * scale + BigInt(fraction.padEnd(decimals, '0') || '0');
  const difference = scaled(leftInteger, leftFraction) - scaled(rightInteger, rightFraction);
  const whole = difference / scale;
  const fraction = (difference % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function positiveU64(value: RawU64): boolean {
  return /^[1-9]\d*$/.test(value);
}

function compareU64(left: RawU64, right: RawU64): number {
  return BigInt(left) === BigInt(right) ? 0 : BigInt(left) < BigInt(right) ? -1 : 1;
}

function terminalStatus(status: ListingStatus | ItemOfferStatus | CollectionBidStatus): Exclude<MarketplaceResolutionStatus, 'READY'> {
  if (status === 'EXPIRED') return 'EXPIRED';
  if (status === 'SOLD' || status === 'FILLED') return 'FILLED';
  if (status === 'CANCELLED') return 'CANCELLED';
  return 'STALE';
}

export async function resolveBuyNow<TIntent>(input: BuyNowInput, deps: { discovery: MarketplaceDiscoveryProvider; readback: MarketplaceReadbackProvider; builder: MarketplaceRouteBuilder<TIntent> }): Promise<MarketplaceResolution<TIntent>> {
  const discovered = await deps.discovery.findListing(
    'listingAddress' in input.listing
      ? { listingAddress: input.listing.listingAddress, quoteResource: input.expectedQuoteResource }
      : { ...input.listing, quoteResource: input.expectedQuoteResource },
  );
  if (!discovered) return { status: 'UNAVAILABLE', reason: 'Listing is not discoverable in the requested quote book' };
  const read = await deps.readback.readListing(discovered.listingAddress);
  if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', componentOrOrderId: discovered.listingAddress, reason: read.reason };
  const listing = read.value;
  if (listing.status !== 'ACTIVE') return { status: terminalStatus(listing.status), componentOrOrderId: listing.listingAddress, reason: 'Listing is no longer active' };
  if (listing.quoteResource !== input.expectedQuoteResource || input.expectedPrice !== undefined && compareDecimal(listing.price, input.expectedPrice) !== 0) {
    return { status: 'STALE', componentOrOrderId: listing.listingAddress, reason: 'Listing quote or exact price changed since discovery' };
  }
  if ('collectionResource' in input.listing && (listing.collectionResource !== input.listing.collectionResource || listing.nftId !== input.listing.nftId)) {
    return { status: 'STALE', componentOrOrderId: listing.listingAddress, reason: 'Listing NFT identity changed since discovery' };
  }
  return {
    status: 'READY',
    route: {
      routeKind: 'NFT_BUY_NOW', componentOrOrderId: listing.listingAddress, collectionResource: listing.collectionResource, nftId: listing.nftId,
      quoteResource: listing.quoteResource, exactAmount: listing.price, expiryEpoch: listing.expiresAtEpoch, currentAuthoritativeStatus: listing.status,
      readback: read.freshness, inputAsset: { resourceAddress: listing.quoteResource, amount: listing.price }, outputAsset: { resourceAddress: listing.collectionResource, nftId: listing.nftId },
      walletWithdrawals: [{ resourceAddress: listing.quoteResource, amount: listing.price }], builderOperation: 'buy_listing', builderIntent: deps.builder.buyListing(listing, input.buyerAccount),
      expectedSettlement: 'Exact NFT is deposited to the buyer account and exact quote payment is deposited to the immutable seller account.',
    },
  };
}

function isDiscoveredFillable(bid: CollectionBid): boolean {
  return (bid.status === 'ACTIVE' || bid.status === 'PARTIALLY_FILLED') && positiveU64(bid.remainingQuantity) && compareDecimal(bid.remainingEscrow, bid.pricePerNft) >= 0;
}

function rankBids(bids: CollectionBid[]): CollectionBid[] {
  return [...bids].sort((left, right) => {
    const price = compareDecimal(right.pricePerNft, left.pricePerNft);
    if (price !== 0) return price;
    const epoch = compareU64(left.createdAtEpoch, right.createdAtEpoch);
    return epoch !== 0 ? epoch : left.bidAddress.localeCompare(right.bidAddress);
  });
}

export async function resolveSellNow<TIntent>(input: SellNowInput, deps: { discovery: MarketplaceDiscoveryProvider; readback: MarketplaceReadbackProvider; builder: MarketplaceRouteBuilder<TIntent> }): Promise<MarketplaceResolution<TIntent>> {
  const discovered = rankBids((await deps.discovery.findCollectionBids({ collectionResource: input.collectionResource, quoteResource: input.quoteResource })).filter(isDiscoveredFillable));
  const selected = input.selectedBidAddress ? discovered.find((bid) => bid.bidAddress === input.selectedBidAddress) : discovered[0];
  if (!selected) return { status: 'UNAVAILABLE', reason: 'No fillable collection bid is available in the requested quote book' };
  const read = await deps.readback.readCollectionBid(selected.bidAddress);
  if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', componentOrOrderId: selected.bidAddress, reason: read.reason };
  const bid = read.value;
  if (bid.status !== 'ACTIVE' && bid.status !== 'PARTIALLY_FILLED') return { status: terminalStatus(bid.status), componentOrOrderId: bid.bidAddress, reason: 'Selected bid is no longer fillable' };
  if (bid.collectionResource !== input.collectionResource || bid.quoteResource !== input.quoteResource) return { status: 'STALE', componentOrOrderId: bid.bidAddress, reason: 'Selected bid no longer matches the requested market' };
  if (!positiveU64(bid.remainingQuantity)) return { status: 'FILLED', componentOrOrderId: bid.bidAddress, reason: 'Selected bid has no remaining quantity' };
  if (compareDecimal(bid.remainingEscrow, bid.pricePerNft) < 0) return { status: 'INSUFFICIENT_REMAINING_ESCROW', componentOrOrderId: bid.bidAddress, reason: 'Selected bid cannot fund one exact fill' };
  return {
    status: 'READY',
    route: {
      routeKind: 'NFT_SELL_NOW', componentOrOrderId: bid.bidAddress, collectionResource: bid.collectionResource, nftId: input.nftId,
      quoteResource: bid.quoteResource, exactAmount: bid.pricePerNft, expiryEpoch: bid.expiresAtEpoch, currentAuthoritativeStatus: bid.status,
      readback: read.freshness, inputAsset: { resourceAddress: bid.collectionResource, nftId: input.nftId }, outputAsset: { resourceAddress: bid.quoteResource, amount: bid.pricePerNft },
      walletWithdrawals: [{ resourceAddress: bid.collectionResource, nftId: input.nftId }], builderOperation: 'fill_collection_bid', builderIntent: deps.builder.fillCollectionBid(bid, input.sellerAccount, input.nftId),
      expectedSettlement: 'One exact NFT is deposited to the immutable buyer account and one bid price is deposited to the seller account.',
    },
  };
}

export async function resolveAcceptItemOffer<TIntent>(input: AcceptItemOfferInput, deps: { readback: MarketplaceReadbackProvider; builder: MarketplaceRouteBuilder<TIntent> }): Promise<MarketplaceResolution<TIntent>> {
  const read = await deps.readback.readItemOffer(input.offerAddress);
  if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', componentOrOrderId: input.offerAddress, reason: read.reason };
  const offer = read.value;
  if (offer.status !== 'ACTIVE') return { status: terminalStatus(offer.status), componentOrOrderId: offer.offerAddress, reason: 'Item offer is no longer active' };
  if (offer.collectionResource !== input.expectedCollectionResource || offer.nftId !== input.expectedNftId || offer.quoteResource !== input.expectedQuoteResource || compareDecimal(offer.amount, input.expectedAmount) !== 0) {
    return { status: 'STALE', componentOrOrderId: offer.offerAddress, reason: 'Item offer terms no longer match the requested exact NFT settlement' };
  }
  return {
    status: 'READY',
    route: {
      routeKind: 'NFT_ACCEPT_ITEM_OFFER', componentOrOrderId: offer.offerAddress, collectionResource: offer.collectionResource, nftId: offer.nftId,
      quoteResource: offer.quoteResource, exactAmount: offer.amount, expiryEpoch: offer.expiresAtEpoch, currentAuthoritativeStatus: offer.status,
      readback: read.freshness, inputAsset: { resourceAddress: offer.collectionResource, nftId: offer.nftId }, outputAsset: { resourceAddress: offer.quoteResource, amount: offer.amount },
      walletWithdrawals: [{ resourceAddress: offer.collectionResource, nftId: offer.nftId }], builderOperation: 'accept_item_offer', builderIntent: deps.builder.acceptItemOffer(offer, input.sellerAccount),
      expectedSettlement: 'Exact NFT is deposited to the immutable buyer account and escrowed quote is deposited to the seller account.',
    },
  };
}

export interface RecentSale {
  listingOrOfferAddress: string;
  collectionResource: string;
  nftId: string;
  quoteResource: string;
  amount: RawAmount;
  epoch?: RawU64;
  /** Listings have no native events; use receipt/indexer observation rather than display metadata. */
  source: 'RECEIPT' | 'INDEXER_OBSERVATION';
}

export interface BidDepthLevel { pricePerNft: RawAmount; totalQuantity: RawU64; totalQuoteDepth: RawAmount; }
export interface CollectionMarketData {
  collectionResource: string;
  quoteResource: string;
  floorAsk?: Listing;
  bestBid?: CollectionBid;
  spread?: RawAmount;
  totalBidDepth: RawAmount;
  listedNftCount: RawU64;
  activeBidQuantity: RawU64;
  bidDepth: BidDepthLevel[];
  activeListings: Listing[];
  itemOffers: ItemOffer[];
  collectionBids: CollectionBid[];
  recentSales: RecentSale[];
}

/** Deterministic index projection. It never changes the authoritative settlement readback rule. */
export function buildCollectionMarketData(input: { collectionResource: string; quoteResource: string; listings: Listing[]; itemOffers: ItemOffer[]; bids: CollectionBid[]; recentSales: RecentSale[] }): CollectionMarketData {
  const sameBook = <T extends { collectionResource: string; quoteResource: string }>(items: T[]) => items.filter((item) => item.collectionResource === input.collectionResource && item.quoteResource === input.quoteResource);
  const activeListings = sameBook(input.listings).filter((listing) => listing.status === 'ACTIVE').sort((left, right) => compareDecimal(left.price, right.price));
  const collectionBids = rankBids(sameBook(input.bids).filter(isDiscoveredFillable));
  const itemOffers = sameBook(input.itemOffers).filter((offer) => offer.status === 'ACTIVE');
  const recentSales = sameBook(input.recentSales);
  const depth = new Map<RawAmount, BidDepthLevel>();
  for (const bid of collectionBids) {
    const level = depth.get(bid.pricePerNft) ?? { pricePerNft: bid.pricePerNft, totalQuantity: '0', totalQuoteDepth: '0' };
    level.totalQuantity = (BigInt(level.totalQuantity) + BigInt(bid.remainingQuantity)).toString();
    level.totalQuoteDepth = addDecimal(level.totalQuoteDepth, bid.remainingEscrow);
    depth.set(bid.pricePerNft, level);
  }
  const bidDepth = [...depth.values()].sort((left, right) => compareDecimal(right.pricePerNft, left.pricePerNft));
  const floorAsk = activeListings[0];
  const bestBid = collectionBids[0];
  return {
    collectionResource: input.collectionResource, quoteResource: input.quoteResource, floorAsk, bestBid,
    // A crossed cached book is possible while a fill is pending; represent its executable spread
    // as zero rather than throwing or creating a negative unsigned amount.
    spread: floorAsk && bestBid ? (compareDecimal(floorAsk.price, bestBid.pricePerNft) < 0 ? '0' : subtractDecimal(floorAsk.price, bestBid.pricePerNft)) : undefined,
    totalBidDepth: collectionBids.reduce((sum, bid) => addDecimal(sum, bid.remainingEscrow), '0'),
    listedNftCount: BigInt(activeListings.length).toString(), activeBidQuantity: collectionBids.reduce((sum, bid) => (BigInt(sum) + BigInt(bid.remainingQuantity)).toString(), '0'),
    bidDepth, activeListings, itemOffers, collectionBids, recentSales,
  };
}

/** Seller-selected bid helper for UIs. A resolver still re-reads this component before signing. */
export function selectSellNowBid(bids: CollectionBid[], bidAddress: string): CollectionBid {
  const bid = bids.find((candidate) => candidate.bidAddress === bidAddress);
  if (!bid || !isDiscoveredFillable(bid)) throw new Error('Selected collection bid is not fillable');
  return bid;
}

export type MarketplaceHistoryState = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
export interface MarketplaceHistoryEntry {
  transactionId: string;
  operation: string;
  state: MarketplaceHistoryState;
  componentOrOrderId?: string;
  collectionResource: string;
  nftId?: string;
  quoteResource: string;
  amount?: RawAmount;
  failureReason?: string;
  createdAtUnixMs: number;
  submittedEpoch?: RawU64;
  confirmedEpoch?: RawU64;
}

/** Persistence is application-owned; this API prevents UI text from becoming operation state. */
export interface MarketplaceHistoryStore {
  save(entry: MarketplaceHistoryEntry): Promise<void>;
  get(transactionId: string): Promise<MarketplaceHistoryEntry | undefined>;
}
