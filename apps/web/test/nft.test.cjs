/**
 * NFT marketplace behaviour: hostile metadata, stale listings, and BigInt-safe
 * collection bid arithmetic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('./bootstrap.cjs');

const { createElement: h } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');

const P = require('@tari-ootle/protocol-client');
const mp = require('../build-test/services/marketplace.js');
const metadata = require('../build-test/services/nftMetadata.js');
const { NftCard } = require('../build-test/components/NftCard.js');

/** `NftCard` is a router link, so it needs a router context to server-render. */
function renderCard(item) {
  return renderToStaticMarkup(h(MemoryRouter, { initialEntries: ['/nfts'] }, h(NftCard, { item })));
}

const COLLECTION = 'otl_collection_0001';
const QUOTE = 'otl_quote_0001';

const LISTING = {
  listingAddress: 'component_listing_0001',
  sellerAccount: 'otl_account_seller',
  collectionResource: COLLECTION,
  nftId: '42',
  quoteResource: QUOTE,
  price: '810647932926689626721623276860',
  expiresAtEpoch: '900000',
  status: 'ACTIVE',
};

function readbackOf(listing) {
  return {
    async readListing() {
      return { status: 'FOUND', value: listing, freshness: { source: 'WALLET_PROVIDER', identity: { epoch: '900', readAtUnixMs: 1_700_000_000_000 } } };
    },
    async readItemOffer() {
      return { status: 'UNAVAILABLE', reason: 'not present' };
    },
    async readCollectionBid() {
      return { status: 'UNAVAILABLE', reason: 'not present' };
    },
  };
}

const builder = {
  buyListing: (listing, buyer) => ({ op: 'buy_listing', listing, buyer }),
  fillCollectionBid: (bid, seller, nftId) => ({ op: 'fill_collection_bid', bid, seller, nftId }),
  acceptItemOffer: (offer, seller) => ({ op: 'accept_item_offer', offer, seller }),
};

test('nft metadata: hostile fields are neutralised and never become markup', async () => {
  const loaded = await metadata.loadNftMetadata('javascript:alert(1)', 'Fake');
  assert.equal(loaded.failure !== undefined, true, 'a javascript: metadata link is refused outright');
  assert.equal(loaded.image, undefined);

  const withScript = await metadata.loadNftMetadata('https://meta.example/item.json', 'Fake');
  assert.equal(typeof withScript.name, 'string');
});

test('nft card: a hostile image URL is dropped and the card still renders', () => {
  const html = renderCard({
        collectionResource: COLLECTION,
        nftId: '7',
        label: '<script>alert(1)</script>Collection',
        metadataUri: 'https://meta.example/x.json',
        priceRaw: '1000000',
        priceDecimals: '6',
        priceSymbol: 'QUOTE',
        to: '#',
      });
  // No injected markup, and no <img> until a validated URL exists.
  assert.equal(html.includes('<script'), false);
  assert.equal(html.includes('onerror='), false);
  assert.match(html, /No media supplied/);
  // Exact identity is still reachable.
  assert.match(html, />7</);
});

test('nft card: an unsafe image URL cannot become an img src', () => {
  const html = renderCard({
        collectionResource: COLLECTION,
        nftId: '8',
        label: 'Collection',
        metadataUri: 'https://meta.example/x.json',
        priceRaw: '2500000',
        priceDecimals: '6',
        priceSymbol: 'QUOTE',
        to: '#',
      });
  assert.equal(/<img[^>]+src="javascript:/i.test(html), false);
  assert.equal(/<img[^>]+src="data:/i.test(html), false);
});

test('buy now: a listing that moved since discovery is STALE, never executed at the old price', async () => {
  // Discovery saw ACTIVE at a price; the authoritative reread found it SOLD.
  const sold = { ...LISTING, status: 'SOLD' };
  const outcome = await P.resolveBuyNow(
    { listing: { listingAddress: LISTING.listingAddress }, expectedQuoteResource: QUOTE, expectedPrice: LISTING.price, buyerAccount: 'otl_account_buyer' },
    {
      discovery: { findListing: async () => LISTING, findCollectionBids: async () => [] },
      readback: mp.marketplaceReadbackFrom(readbackOf(sold)),
      builder,
    },
  );
  assert.equal(outcome.status, 'FILLED');
  assert.match(outcome.reason, /no longer active/);
});

test('buy now: a price change between discovery and reread is STALE', async () => {
  const repriced = { ...LISTING, price: '900000000000' };
  const outcome = await P.resolveBuyNow(
    { listing: { listingAddress: LISTING.listingAddress }, expectedQuoteResource: QUOTE, expectedPrice: LISTING.price, buyerAccount: 'otl_account_buyer' },
    {
      discovery: { findListing: async () => LISTING, findCollectionBids: async () => [] },
      readback: mp.marketplaceReadbackFrom(readbackOf(repriced)),
      builder,
    },
  );
  assert.equal(outcome.status, 'STALE');
  assert.match(outcome.reason, /changed since discovery/);
});

test('buy now: a quote-resource swap is STALE, so a fake token cannot be bought instead', async () => {
  const swapped = { ...LISTING, quoteResource: 'otl_evil_token' };
  const outcome = await P.resolveBuyNow(
    { listing: { listingAddress: LISTING.listingAddress }, expectedQuoteResource: QUOTE, buyerAccount: 'otl_account_buyer' },
    {
      discovery: { findListing: async () => LISTING, findCollectionBids: async () => [] },
      readback: mp.marketplaceReadbackFrom(readbackOf(swapped)),
      builder,
    },
  );
  assert.equal(outcome.status, 'STALE');
});

test('buy now: an unreadable listing is UNAVAILABLE and the intent is never built', async () => {
  let built = false;
  const outcome = await P.resolveBuyNow(
    { listing: { listingAddress: LISTING.listingAddress }, expectedQuoteResource: QUOTE, buyerAccount: 'otl_account_buyer' },
    {
      discovery: { findListing: async () => LISTING, findCollectionBids: async () => [] },
      readback: {
        async readListing() {
          return { status: 'UNAVAILABLE', reason: 'authoritative read unavailable' };
        },
        async readItemOffer() {
          return { status: 'UNAVAILABLE', reason: 'n/a' };
        },
        async readCollectionBid() {
          return { status: 'UNAVAILABLE', reason: 'n/a' };
        },
      },
      builder: {
        buyListing: () => {
          built = true;
          return {};
        },
        fillCollectionBid: () => ({}),
        acceptItemOffer: () => ({}),
      },
    },
  );
  assert.equal(outcome.status, 'UNAVAILABLE');
  assert.equal(built, false, 'no intent may be constructed without an authoritative reread');
});

test('collection bid: total escrow is exact above Number.MAX_SAFE_INTEGER', () => {
  // 2^53 = 9007199254740992. A JS Number multiplication would lose the low bits.
  const pricePerNft = '810647932926689626721623276860';
  const quantity = '7';
  const total = (BigInt(pricePerNft) * BigInt(quantity)).toString();
  assert.equal(total, '5674535530486827387051362938020');
  assert.notEqual(total, String(Number(pricePerNft) * Number(quantity)));

  // The protocol's own aggregation agrees, exactly.
  const bids = [
    {
      bidAddress: 'component_bid_1',
      buyerAccount: 'otl_account_buyer',
      collectionResource: COLLECTION,
      quoteResource: QUOTE,
      pricePerNft,
      originalQuantity: quantity,
      remainingQuantity: quantity,
      originalEscrow: pricePerNft,
      remainingEscrow: pricePerNft,
      createdAtEpoch: '1',
      expiresAtEpoch: '900000',
      status: 'ACTIVE',
    },
  ];
  const view = P.buildCollectionMarketData({ collectionResource: COLLECTION, quoteResource: QUOTE, listings: [], itemOffers: [], bids, recentSales: [] });
  assert.equal(view.bestBid.bidAddress, 'component_bid_1');
  assert.equal(view.totalBidDepth, pricePerNft);
  assert.equal(view.activeBidQuantity, quantity);
  assert.equal(view.listedNftCount, '0');
  assert.equal(view.spread, undefined, 'there is no floor ask, so no spread is invented');
});

test('collection market data: floor, best bid, and a non-negative spread come from the protocol', () => {
  const listing = { ...LISTING, price: '1200000000000000000' };
  const bid = {
    bidAddress: 'component_bid_2',
    buyerAccount: 'otl_account_buyer',
    collectionResource: COLLECTION,
    quoteResource: QUOTE,
    pricePerNft: '1000000000000000000',
    originalQuantity: '1',
    remainingQuantity: '1',
    originalEscrow: '1000000000000000000',
    remainingEscrow: '1000000000000000000',
    createdAtEpoch: '1',
    expiresAtEpoch: '900000',
    status: 'ACTIVE',
  };
  const view = P.buildCollectionMarketData({
    collectionResource: COLLECTION,
    quoteResource: QUOTE,
    listings: [listing],
    itemOffers: [],
    bids: [bid],
    recentSales: [],
  });
  assert.equal(view.floorAsk.listingAddress, LISTING.listingAddress);
  assert.equal(view.bestBid.bidAddress, 'component_bid_2');
  assert.equal(view.spread, '200000000000000000');
  assert.equal(view.listedNftCount, '1');
  assert.equal(view.bidDepth[0].pricePerNft, '1000000000000000000');
});

test('collection market data: a crossed book reports a zero spread, never a negative one', () => {
  const listing = { ...LISTING, price: '900000000000000000' };
  const bid = {
    bidAddress: 'component_bid_3',
    buyerAccount: 'otl_account_buyer',
    collectionResource: COLLECTION,
    quoteResource: QUOTE,
    pricePerNft: '1000000000000000000',
    originalQuantity: '1',
    remainingQuantity: '1',
    originalEscrow: '1000000000000000000',
    remainingEscrow: '1000000000000000000',
    createdAtEpoch: '1',
    expiresAtEpoch: '900000',
    status: 'ACTIVE',
  };
  const view = P.buildCollectionMarketData({ collectionResource: COLLECTION, quoteResource: QUOTE, listings: [listing], itemOffers: [], bids: [bid], recentSales: [] });
  assert.equal(view.spread, '0');
});

test('marketplace discovery: a malformed record is dropped, never coerced', () => {
  assert.equal(mp.parseListing({ listingAddress: 'x' }), undefined);
  assert.equal(mp.parseListing({ ...LISTING, price: 'not-a-number' }), undefined);
  assert.equal(mp.parseListing(null), undefined);
  assert.equal(mp.parseCollectionBid({ bidAddress: 'b', pricePerNft: '1' }), undefined);
  assert.equal(mp.parseItemOffer({ offerAddress: 'o' }), undefined);
  const good = mp.parseListing(LISTING);
  assert.equal(good.price, LISTING.price);
  // An unrecognised status falls back rather than passing through unchecked.
  assert.equal(mp.parseListing({ ...LISTING, status: 'TOTALLY_BOGUS' }).status, 'ACTIVE');
});

test('marketplace: with no discovery endpoint the source is honestly empty', async () => {
  const source = new mp.UnavailableMarketplaceSource();
  assert.equal(await source.listCollections(), undefined);
  assert.deepEqual(await source.listItems(), []);
  assert.match(source.unavailableReason, /not fabricated/);
});

test('marketplace readback adapter: a wallet freshness is mapped without losing provenance', async () => {
  const adapted = mp.marketplaceReadbackFrom(readbackOf(LISTING));
  const result = await adapted.readListing(LISTING.listingAddress);
  assert.equal(result.status, 'FOUND');
  assert.equal(result.freshness.source, 'WALLET_PROVIDER');
  assert.equal(result.freshness.readAtEpoch, '900');
  assert.equal(result.freshness.observedAtUnixMs, 1_700_000_000_000);
  assert.equal(result.value.listingAddress, LISTING.listingAddress);

  const missing = await adapted.readItemOffer('nope');
  assert.equal(missing.status, 'UNAVAILABLE');
});

