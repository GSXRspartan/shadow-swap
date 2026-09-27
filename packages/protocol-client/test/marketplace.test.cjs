const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCollectionMarketData,
  resolveAcceptItemOffer,
  resolveBuyNow,
  resolveSellNow,
} = require('../dist/marketplace.js');

const freshness = { source: 'WALLET_PROVIDER', readAtEpoch: '100', observedAtUnixMs: 1 };
const listing = { listingAddress: 'listing_1', sellerAccount: 'seller', collectionResource: 'collection_a', nftId: 'nft_1', quoteResource: 'quote_a', price: '40', expiresAtEpoch: '200', status: 'ACTIVE' };
const offer = { offerAddress: 'offer_1', buyerAccount: 'buyer', collectionResource: 'collection_a', nftId: 'nft_1', quoteResource: 'quote_a', amount: '37', createdAtEpoch: '90', expiresAtEpoch: '200', status: 'ACTIVE' };
const bid = { bidAddress: 'bid_1', buyerAccount: 'buyer', collectionResource: 'collection_a', quoteResource: 'quote_a', pricePerNft: '34', originalQuantity: '3', remainingQuantity: '2', originalEscrow: '102', remainingEscrow: '68', createdAtEpoch: '90', expiresAtEpoch: '200', status: 'PARTIALLY_FILLED' };
const builder = {
  buyListing: (value, buyerAccount) => ({ operation: 'buy_listing', value, buyerAccount }),
  fillCollectionBid: (value, sellerAccount, nftId) => ({ operation: 'fill_collection_bid', value, sellerAccount, nftId }),
  acceptItemOffer: (value, sellerAccount) => ({ operation: 'accept_item_offer', value, sellerAccount }),
};

function readback({ listingValue = listing, offerValue = offer, bidValue = bid } = {}) {
  return {
    readListing: async () => ({ status: 'FOUND', value: listingValue, freshness }),
    readItemOffer: async () => ({ status: 'FOUND', value: offerValue, freshness }),
    readCollectionBid: async () => ({ status: 'FOUND', value: bidValue, freshness }),
  };
}

test('Buy Now uses authoritative active listing state and exact identity', async () => {
  const result = await resolveBuyNow(
    { listing: { collectionResource: 'collection_a', nftId: 'nft_1' }, expectedQuoteResource: 'quote_a', expectedPrice: '40', buyerAccount: 'buyer' },
    { discovery: { findListing: async () => listing, findCollectionBids: async () => [] }, readback: readback(), builder },
  );
  assert.equal(result.status, 'READY');
  assert.equal(result.route.builderOperation, 'buy_listing');
  assert.deepEqual(result.route.walletWithdrawals, [{ resourceAddress: 'quote_a', amount: '40' }]);
  assert.equal(result.route.outputAsset.nftId, 'nft_1');
});

test('Buy Now rejects stale price and terminal listing state', async () => {
  const changed = { ...listing, price: '41' };
  const stale = await resolveBuyNow(
    { listing: { listingAddress: 'listing_1' }, expectedQuoteResource: 'quote_a', expectedPrice: '40', buyerAccount: 'buyer' },
    { discovery: { findListing: async () => listing, findCollectionBids: async () => [] }, readback: readback({ listingValue: changed }), builder },
  );
  assert.equal(stale.status, 'STALE');
  const expired = await resolveBuyNow(
    { listing: { listingAddress: 'listing_1' }, expectedQuoteResource: 'quote_a', buyerAccount: 'buyer' },
    { discovery: { findListing: async () => listing, findCollectionBids: async () => [] }, readback: readback({ listingValue: { ...listing, status: 'EXPIRED' } }), builder },
  );
  assert.equal(expired.status, 'EXPIRED');
});

test('Sell Now recommends highest price deterministically and rejects invalidated cached best bid', async () => {
  const equalLater = { ...bid, bidAddress: 'bid_2', pricePerNft: '34', createdAtEpoch: '91' };
  const lower = { ...bid, bidAddress: 'bid_3', pricePerNft: '33' };
  const result = await resolveSellNow(
    { collectionResource: 'collection_a', nftId: 'nft_1', quoteResource: 'quote_a', sellerAccount: 'seller' },
    { discovery: { findListing: async () => undefined, findCollectionBids: async () => [lower, equalLater, bid] }, readback: readback(), builder },
  );
  assert.equal(result.status, 'READY');
  assert.equal(result.route.componentOrOrderId, 'bid_1');
  const invalidated = await resolveSellNow(
    { collectionResource: 'collection_a', nftId: 'nft_1', quoteResource: 'quote_a', sellerAccount: 'seller' },
    { discovery: { findListing: async () => undefined, findCollectionBids: async () => [bid] }, readback: readback({ bidValue: { ...bid, status: 'FILLED', remainingQuantity: '0', remainingEscrow: '0' } }), builder },
  );
  assert.equal(invalidated.status, 'FILLED');
});

test('Sell Now ignores quote-mismatched, zero-quantity, expired, and underfunded bids', async () => {
  const result = await resolveSellNow(
    { collectionResource: 'collection_a', nftId: 'nft_1', quoteResource: 'quote_a', sellerAccount: 'seller' },
    { discovery: { findListing: async () => undefined, findCollectionBids: async () => [
      { ...bid, bidAddress: 'wrong-quote', quoteResource: 'quote_b', pricePerNft: '100' },
      { ...bid, bidAddress: 'zero', remainingQuantity: '0' },
      { ...bid, bidAddress: 'expired', status: 'EXPIRED' },
      { ...bid, bidAddress: 'underfunded', remainingEscrow: '33' },
    ] }, readback: readback(), builder },
  );
  assert.equal(result.status, 'UNAVAILABLE');
});

test('Accept Item Offer preserves exact NFT and rejects mismatched or expired terms', async () => {
  const ready = await resolveAcceptItemOffer(
    { offerAddress: 'offer_1', sellerAccount: 'seller', expectedCollectionResource: 'collection_a', expectedNftId: 'nft_1', expectedQuoteResource: 'quote_a', expectedAmount: '37' },
    { readback: readback(), builder },
  );
  assert.equal(ready.status, 'READY');
  assert.equal(ready.route.builderOperation, 'accept_item_offer');
  const wrongNft = await resolveAcceptItemOffer(
    { offerAddress: 'offer_1', sellerAccount: 'seller', expectedCollectionResource: 'collection_a', expectedNftId: 'nft_2', expectedQuoteResource: 'quote_a', expectedAmount: '37' },
    { readback: readback(), builder },
  );
  assert.equal(wrongNft.status, 'STALE');
  const expired = await resolveAcceptItemOffer(
    { offerAddress: 'offer_1', sellerAccount: 'seller', expectedCollectionResource: 'collection_a', expectedNftId: 'nft_1', expectedQuoteResource: 'quote_a', expectedAmount: '37' },
    { readback: readback({ offerValue: { ...offer, status: 'EXPIRED' } }), builder },
  );
  assert.equal(expired.status, 'EXPIRED');
});

test('market index keeps quote books separate and aggregates BigInt bid depth exactly', () => {
  const huge = { ...bid, bidAddress: 'huge', pricePerNft: '90071992547409931234567890', remainingQuantity: '9007199254740993', remainingEscrow: '810647932926689626721623276860', originalEscrow: '810647932926689626721623276860' };
  const data = buildCollectionMarketData({
    collectionResource: 'collection_a', quoteResource: 'quote_a', listings: [listing, { ...listing, listingAddress: 'other-book', quoteResource: 'quote_b', price: '1' }],
    itemOffers: [offer], bids: [bid, huge, { ...bid, bidAddress: 'other-book', quoteResource: 'quote_b', pricePerNft: '100' }], recentSales: [],
  });
  assert.equal(data.floorAsk.listingAddress, 'listing_1');
  assert.equal(data.bestBid.bidAddress, 'huge');
  assert.equal(data.activeBidQuantity, (2n + 9007199254740993n).toString());
  assert.equal(data.totalBidDepth, '810647932926689626721623276928');
  assert.equal(data.bidDepth.length, 2);
});
