const test = require('node:test');
const assert = require('node:assert/strict');

const {
  acceptItemOffer,
  buyListing,
  cancelCollectionBid,
  cancelItemOffer,
  cancelListing,
  createCollectionBid,
  createItemOffer,
  createListing,
  fillCollectionBid,
  refundExpiredCollectionBid,
  refundExpiredItemOffer,
} = require('../dist/marketplace.js');

const target = {
  nftResource: 'resource_nft',
  nftId: 'nft_1',
  quoteResource: 'resource_quote',
  amount: '42',
  expiryEpoch: 99,
};

test('create listing withdraws the exact NFT and calls the published template', () => {
  const intent = createListing({
    templateAddress: 'template_listing',
    sellerAccount: 'account_seller',
    nftResource: target.nftResource,
    nftId: target.nftId,
    quoteResource: target.quoteResource,
    price: target.amount,
    expiryEpoch: target.expiryEpoch,
  });

  assert.deepEqual(intent.instructions, [
    {
      kind: 'withdraw_non_fungible',
      accountAddress: 'account_seller',
      resourceAddress: target.nftResource,
      nonFungibleId: target.nftId,
      output: { kind: 'workspace_bucket', name: 'listing_nft' },
    },
    {
      kind: 'call_function',
      templateAddress: 'template_listing',
      templateName: 'FixedPriceListing',
      method: 'create',
      args: ['account_seller', { kind: 'workspace_bucket', name: 'listing_nft' }, target.quoteResource, target.amount, target.expiryEpoch],
      resourcesInvolved: [target.nftResource, target.quoteResource],
    },
  ]);
});

test('buy listing withdraws exact quote payment and requires an authoritative listing readback', () => {
  const intent = buyListing('component_listing', 'account_buyer', target.quoteResource, target.amount, {
    nftResource: target.nftResource,
    nftId: target.nftId,
    expiryEpoch: target.expiryEpoch,
  });

  assert.equal(intent.requiredReadbacks[0], 'listing');
  assert.deepEqual(intent.instructions[0], {
    kind: 'withdraw_fungible',
    accountAddress: 'account_buyer',
    resourceAddress: target.quoteResource,
    amount: target.amount,
    output: { kind: 'workspace_bucket', name: 'listing_payment' },
  });
  assert.deepEqual(intent.instructions[1], {
    kind: 'call_method',
    componentAddress: 'component_listing',
    method: 'buy',
    args: [{ kind: 'workspace_bucket', name: 'listing_payment' }, 'account_buyer'],
    resourcesInvolved: [target.quoteResource],
  });
});

test('item-offer creation escrows quote and acceptance withdraws the exact NFT', () => {
  const creation = createItemOffer({
    templateAddress: 'template_offer',
    buyerAccount: 'account_buyer',
    nftResource: target.nftResource,
    nftId: target.nftId,
    quoteResource: target.quoteResource,
    offerAmount: '7',
    expiryEpoch: target.expiryEpoch,
  });
  assert.equal(creation.instructions[0].kind, 'withdraw_fungible');
  assert.equal(creation.instructions[1].templateAddress, 'template_offer');
  assert.deepEqual(creation.instructions[1].args, ['account_buyer', { kind: 'workspace_bucket', name: 'item_offer_quote' }, target.nftResource, target.nftId, target.expiryEpoch]);

  const acceptance = acceptItemOffer('component_offer', 'account_seller', target.nftResource, target.nftId, {
    quoteResource: target.quoteResource,
    amount: '7',
  });
  assert.equal(acceptance.requiredReadbacks[0], 'offer');
  assert.deepEqual(acceptance.instructions[0], {
    kind: 'withdraw_non_fungible',
    accountAddress: 'account_seller',
    resourceAddress: target.nftResource,
    nonFungibleId: target.nftId,
    output: { kind: 'workspace_bucket', name: 'item_offer_nft' },
  });
  assert.equal(acceptance.instructions[1].componentAddress, 'component_offer');
  assert.deepEqual(acceptance.instructions[1].args, [{ kind: 'workspace_bucket', name: 'item_offer_nft' }, 'account_seller']);
});

test('collection-bid escrow uses exact BigInt arithmetic above Number.MAX_SAFE_INTEGER', () => {
  const pricePerNft = '90071992547409931234567890';
  const quantity = '9007199254740993';
  const escrow = (BigInt(pricePerNft) * BigInt(quantity)).toString();
  const intent = createCollectionBid({
    templateAddress: 'template_bid',
    buyerAccount: 'account_buyer',
    collectionResource: target.nftResource,
    quoteResource: target.quoteResource,
    pricePerNft,
    quantity,
    expiryEpoch: target.expiryEpoch,
  });

  assert.equal(intent.target.amount, escrow);
  assert.equal(intent.instructions[0].amount, escrow);
  assert.equal(intent.instructions[1].templateAddress, 'template_bid');
  assert.deepEqual(intent.instructions[1].args, ['account_buyer', { kind: 'workspace_bucket', name: 'collection_bid_quote' }, target.nftResource, pricePerNft, quantity, target.expiryEpoch]);
});

test('collection-bid fill withdraws the exact NFT and requires an authoritative bid readback', () => {
  const intent = fillCollectionBid('component_bid', 'account_seller', target.nftResource, target.nftId, {
    quoteResource: target.quoteResource,
    amount: target.amount,
  });

  assert.equal(intent.requiredReadbacks[0], 'bid');
  assert.deepEqual(intent.instructions[0], {
    kind: 'withdraw_non_fungible',
    accountAddress: 'account_seller',
    resourceAddress: target.nftResource,
    nonFungibleId: target.nftId,
    output: { kind: 'workspace_bucket', name: 'collection_bid_nft' },
  });
  assert.equal(intent.instructions[1].componentAddress, 'component_bid');
  assert.deepEqual(intent.instructions[1].args, [{ kind: 'workspace_bucket', name: 'collection_bid_nft' }, 'account_seller']);
});

test('cancel and expiry-refund operations use only their existing component address', () => {
  const operations = [
    cancelListing('component_listing', target),
    cancelItemOffer('component_offer', target),
    refundExpiredItemOffer('component_offer', target),
    cancelCollectionBid('component_bid', target),
    refundExpiredCollectionBid('component_bid', target),
  ];

  for (const intent of operations) {
    assert.equal(intent.instructions.length, 1);
    assert.equal(intent.instructions[0].kind, 'call_method');
    assert.deepEqual(intent.instructions[0].args, []);
    assert.equal(intent.instructions[0].componentAddress, intent.target.componentOrOrderId);
    assert.ok(intent.requiredReadbacks.length === 1);
  }
});
