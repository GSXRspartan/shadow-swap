const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeListing,
  decodeItemOffer,
  decodeCollectionBid,
  readEscrow,
  decodeComponentHeader,
  marketplaceTemplateAddress,
  MarketplaceDecodeError,
  setMarketplaceCurrentEpoch,
  resetMarketplaceCurrentEpoch,
} = require('../dist/marketplaceSubstate.js');
const { createOotleReadbackProvider } = require('../dist/ootle.js');

// LIVE ESMERALDA SUBSTATES.
//
// Every fixture below is the exact `body.state` / vault content returned by the running
// v0.45 wallet daemon's `substates.get` for the marketplace components this repository's
// live vertical slice created on 2026-10-07 (epoch 11993). The addresses, template ids,
// ids and amounts are not invented: they are the recorded live values, and each test
// asserts the decode reproduces them exactly.
//
//   FixedPriceListing cancelled  component_ecae9742...  tx ab5267e1...  fee 2914
//   FixedPriceListing sold       component_c17805be...  tx 0af825a4...  fee 3826
//   ItemOffer cancelled          component_1f99a8ef...  tx af62be93...  fee 3280
//   ItemOffer accepted           component_72f6d74a...  tx 485f44c1...  fee 4477
//   CollectionBid filled         component_3ae55b9f...  tx 17358e02...  fee 4450
//   CollectionBid cancelled      component_d4571d92...  tx fa660102...  fee 3238

const TPL_LISTING = '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329';
const TPL_OFFER = '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6';
const TPL_BID = '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54';

const TTARI = '0101010101010101010101010101010101010101010101010101010101010101';
const NFT_A_RESTART_B = '478638b1585da5a19004af5c5ae1752eb4fa6d7669cb226f5d2de113bfc3fb1b';
const NFT_B_SOAK_A = 'e6d192037660ad95ae6bc50e3380f435dcf161453fa5754807c33b52a5623bd8';
const NFT_A_SOAK_B = 'ef30dd8954ed712c9a48ed27a8e979f9322295c5b3ab34aecb46681fb73ef3d0';
const ACCOUNT_A = 'de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b';

const LISTING_CANCELLED = 'component_ecae9742ce3f299888a62e1e9404a3e13977dc8d801f972ebb73c27ec0a0bea5';
const LISTING_SOLD = 'component_c17805be3d99e884544fb5dee33fd428ca3534a523d0b44bd56a41df33442da6';
const OFFER_CANCELLED = 'component_1f99a8ef77885e14c5f7a541b94345c828dfa7468ab1f1a00fdf01e4c9b69c0e';
const OFFER_ACCEPTED = 'component_72f6d74a47415d44ed994d09dcfc3e4aef8bc8db7fde1aaf9a33b6182861b807';
const BID_FILLED = 'component_3ae55b9fbb867bc768205d9a32bb5226fc1b5c25c65d0e97b2028378ef0daaa4';
const BID_CANCELLED = 'component_d4571d92653d0e532e7a1e30a46461159bf0657b025125e09ceb4bb4250023f5';

function tagComponent(hex) { return { '@cbor': 'tag', tag: 128, value: { '@cbor': 'bytes', hex } }; }
function tagRes(hex) { return { '@cbor': 'tag', tag: 131, value: { '@cbor': 'bytes', hex } }; }
function tagVault(hex) { return { '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex } }; }
function nftIdString(s) { return [1, [s]]; }

// A vault's `resource_container` is a plain serde-derived substate, NOT a CBOR-encoded
// component state tuple, so its token ids arrive as NAMED variant objects. Verified live
// against both indexers on v0.46.0 (see docs/OOTLE_V046_MIGRATION.md).
function vaultNftIdString(s) { return { String: s }; }
function vaultNftIdU64(n) { return { U64: n }; }

function component(templateAddress, state, extraHeader = {}) {
  return {
    Component: {
      header: { template_address: templateAddress, owner_rule: 'None', ...extraHeader },
      body: { state },
    },
  };
}

function nftVault(resourceHex, ids) {
  return { Vault: { freeze_flags: 0, resource_container: { NonFungible: { address: `resource_${resourceHex}`, locked_token_ids: [], token_ids: ids.map(vaultNftIdString) } } } };
}

function ttariVault(resourceHex, revealed) {
  return { Vault: { freeze_flags: 0, resource_container: { Stealth: { address: `resource_${resourceHex}`, locked_amount: '0', revealed_amount: String(revealed) } } } };
}

// --- live listing substates -------------------------------------------------

// Cancelled: the NFT vault is EMPTY, proving cancel returned the item to the seller.
const LISTING_CANCELLED_SUBSTATE = component(TPL_LISTING, [
  tagVault('ec6f5867cc06573d009c4c27ab1b5821c722f41e647cff2dbcf7b79e0840c47a'),
  tagRes(NFT_A_RESTART_B),
  nftIdString('v042-restart-swap-b-f2a02'),
  tagRes(TTARI),
  100,
  tagComponent(ACCOUNT_A),
  0,
  [2, []],
]);

// Sold: also an EMPTY NFT vault, proving the sale moved the item rather than copying it.
const LISTING_SOLD_SUBSTATE = component(TPL_LISTING, [
  tagVault('c1d1534c4d9b8d67d176349e9168b656a2c2126ace04cfd8e78267949d500eda'),
  tagRes(NFT_A_RESTART_B),
  nftIdString('v042-restart-swap-b-f2a02'),
  tagRes(TTARI),
  100,
  tagComponent(ACCOUNT_A),
  0,
  [1, []],
]);

// An ACTIVE listing with the NFT still escrowed, reconstructed from the live create
// dry run's up-substates (the create never committed, so no such component exists; this
// fixture exists to prove the decoder reports escrow, not to claim a component).
const LISTING_ACTIVE_SUBSTATE = component(TPL_LISTING, [
  tagVault('0844561f831f45f4acd554e8b11af432db0ca210309d7b2cb575883a452d7d60'),
  tagRes(NFT_A_RESTART_B),
  nftIdString('v042-restart-swap-b-f2a02'),
  tagRes(TTARI),
  100,
  tagComponent(ACCOUNT_A),
  0,
  [0, []],
]);

// --- live offer / bid substates --------------------------------------------

const OFFER_CANCELLED_SUBSTATE = component(TPL_OFFER, [
  tagVault('1ff74744068c77badf1d79fdd03e9f24b6c5b8bd55d334e74335dd4d7938820a'),
  tagComponent(ACCOUNT_A),
  tagRes(NFT_A_RESTART_B),
  nftIdString('v042-restart-swap-b-f2a02'),
  tagRes(TTARI),
  100,
  11993,
  0,
  [2, []],
]);

const OFFER_ACCEPTED_SUBSTATE = component(TPL_OFFER, [
  tagVault('720d6ff11f34c2b168fb05156d329a5b66571587139d72ccdd38fc09efd4b36f'),
  tagComponent(ACCOUNT_A),
  tagRes(NFT_A_RESTART_B),
  nftIdString('v042-restart-swap-b-f2a02'),
  tagRes(TTARI),
  100,
  11993,
  0,
  [1, []],
]);

// An ACTIVE offer with escrow still held, reconstructed from the live create dry run.
const OFFER_ACTIVE_SUBSTATE = component(TPL_OFFER, [
  tagVault('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
  tagComponent(ACCOUNT_A),
  tagRes(NFT_A_RESTART_B),
  nftIdString('v042-restart-swap-b-f2a02'),
  tagRes(TTARI),
  100,
  11993,
  0,
  [0, []],
]);

const BID_FILLED_SUBSTATE = component(TPL_BID, [
  tagVault('3aca98669865d6318fa877a878379eab699c90d67d7abb38533aa7c750964940'),
  tagComponent(ACCOUNT_A),
  tagRes(NFT_B_SOAK_A),
  tagRes(TTARI),
  100,
  1,
  0,
  100,
  0,
  11993,
  0,
  [2, []],
]);

// Cancelled bid: remaining_quantity is still 1 (nothing was filled) but remaining_escrow
// is 0 and the vault is empty. This is the live accounting shape the decoder must keep.
const BID_CANCELLED_SUBSTATE = component(TPL_BID, [
  tagVault('d49eb418f1f53c5ca0bdb2249f5c4b1f39a9fc1f76f805ca4948e8d6e7a20d47'),
  tagComponent(ACCOUNT_A),
  tagRes(NFT_A_SOAK_B),
  tagRes(TTARI),
  100,
  1,
  1,
  100,
  0,
  11993,
  0,
  [3, []],
]);

const BID_ACTIVE_SUBSTATE = component(TPL_BID, [
  tagVault('3aca98669865d6318fa877a878379eab699c90d67d7abb38533aa7c750964940'),
  tagComponent(ACCOUNT_A),
  tagRes(NFT_B_SOAK_A),
  tagRes(TTARI),
  100,
  1,
  1,
  100,
  100,
  11993,
  0,
  [0, []],
]);

const EMPTY_NFT_VAULT = nftVault(NFT_A_RESTART_B, []);
const EMPTY_TTARI_VAULT = ttariVault(TTARI, 0);

function substates(extra = {}) {
  return {
    [LISTING_CANCELLED]: LISTING_CANCELLED_SUBSTATE,
    [LISTING_SOLD]: LISTING_SOLD_SUBSTATE,
    [OFFER_CANCELLED]: OFFER_CANCELLED_SUBSTATE,
    [OFFER_ACCEPTED]: OFFER_ACCEPTED_SUBSTATE,
    [BID_FILLED]: BID_FILLED_SUBSTATE,
    [BID_CANCELLED]: BID_CANCELLED_SUBSTATE,
    'vault_ec6f5867cc06573d009c4c27ab1b5821c722f41e647cff2dbcf7b79e0840c47a': EMPTY_NFT_VAULT,
    'vault_c1d1534c4d9b8d67d176349e9168b656a2c2126ace04cfd8e78267949d500eda': EMPTY_NFT_VAULT,
    'vault_0844561f831f45f4acd554e8b11af432db0ca210309d7b2cb575883a452d7d60': nftVault(NFT_A_RESTART_B, ['v042-restart-swap-b-f2a02']),
    'vault_1ff74744068c77badf1d79fdd03e9f24b6c5b8bd55d334e74335dd4d7938820a': EMPTY_TTARI_VAULT,
    'vault_720d6ff11f34c2b168fb05156d329a5b66571587139d72ccdd38fc09efd4b36f': EMPTY_TTARI_VAULT,
    'vault_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff': ttariVault(TTARI, 100),
    'vault_3aca98669865d6318fa877a878379eab699c90d67d7abb38533aa7c750964940': ttariVault(TTARI, 0),
    'vault_d49eb418f1f53c5ca0bdb2249f5c4b1f39a9fc1f76f805ca4948e8d6e7a20d47': EMPTY_TTARI_VAULT,
    ...extra,
  };
}

function reader(map) {
  return { read: async (address) => map[address] };
}

test.afterEach(() => resetMarketplaceCurrentEpoch());

// --- FixedPriceListing -------------------------------------------------------

test('live cancelled listing decodes to the recorded settlement facts and an empty escrow', async () => {
  setMarketplaceCurrentEpoch(11993);
  const facts = await decodeListing(reader(substates()), LISTING_CANCELLED, TPL_LISTING);
  assert.deepEqual(facts.listing, {
    listingAddress: LISTING_CANCELLED,
    sellerAccount: `component_${ACCOUNT_A}`,
    collectionResource: `resource_${NFT_A_RESTART_B}`,
    nftId: 'str_v042-restart-swap-b-f2a02',
    quoteResource: `resource_${TTARI}`,
    price: '100',
    expiresAtEpoch: '0',
    status: 'CANCELLED',
  });
  assert.equal(facts.templateAddress, TPL_LISTING);
  assert.equal(facts.escrow.empty, true, 'a cancelled listing must hold nothing');
  assert.equal(facts.escrow.resourceAddress, `resource_${NFT_A_RESTART_B}`);
});

test('live sold listing decodes Sold with no residual escrow', async () => {
  setMarketplaceCurrentEpoch(11993);
  const facts = await decodeListing(reader(substates()), LISTING_SOLD, TPL_LISTING);
  assert.equal(facts.listing.status, 'SOLD');
  assert.equal(facts.escrow.empty, true, 'a sold listing must hold nothing');
});

test('an Active listing reports the exact escrowed NFT id, so a filled listing is distinguishable from an empty one', async () => {
  setMarketplaceCurrentEpoch(11993);
  const map = substates({ [LISTING_CANCELLED]: LISTING_ACTIVE_SUBSTATE });
  const facts = await decodeListing(reader(map), LISTING_CANCELLED, TPL_LISTING);
  assert.equal(facts.listing.status, 'ACTIVE');
  assert.equal(facts.escrow.empty, false);
  assert.deepEqual(facts.escrow.tokenIds, ['str_v042-restart-swap-b-f2a02']);
});

test('an escrow vault may render token ids as named variants OR as the CBOR enum tuple', async () => {
  setMarketplaceCurrentEpoch(11993);
  const V = 'vault_0844561f831f45f4acd554e8b11af432db0ca210309d7b2cb575883a452d7d60';

  // Named-variant rendering: what a vault substate actually carries on the wire.
  const named = { Vault: { freeze_flags: 0, resource_container: { NonFungible: { address: `resource_${NFT_A_RESTART_B}`, locked_token_ids: [], token_ids: [vaultNftIdString('v042-restart-swap-b-f2a02')] } } } };
  const viaNamed = await decodeListing(reader(substates({ [LISTING_CANCELLED]: LISTING_ACTIVE_SUBSTATE, [V]: named })), LISTING_CANCELLED, TPL_LISTING);
  assert.deepEqual(viaNamed.escrow.tokenIds, ['str_v042-restart-swap-b-f2a02']);

  // Positional-tuple rendering: the same value as it appears inside a component's own
  // CBOR state. Accepting both is deliberate; they are one type in two encodings.
  const tuple = { Vault: { freeze_flags: 0, resource_container: { NonFungible: { address: `resource_${NFT_A_RESTART_B}`, locked_token_ids: [], token_ids: [nftIdString('v042-restart-swap-b-f2a02')] } } } };
  const viaTuple = await decodeListing(reader(substates({ [LISTING_CANCELLED]: LISTING_ACTIVE_SUBSTATE, [V]: tuple })), LISTING_CANCELLED, TPL_LISTING);
  assert.deepEqual(viaTuple.escrow.tokenIds, ['str_v042-restart-swap-b-f2a02']);
});

test('a numeric escrow token id is named rather than silently dropped', async () => {
  setMarketplaceCurrentEpoch(11993);
  const V = 'vault_0844561f831f45f4acd554e8b11af432db0ca210309d7b2cb575883a452d7d60';
  const numeric = { Vault: { freeze_flags: 0, resource_container: { NonFungible: { address: `resource_${NFT_A_RESTART_B}`, locked_token_ids: [], token_ids: [vaultNftIdU64(7), vaultNftIdString('named')] } } } };
  const facts = await decodeListing(reader(substates({ [LISTING_CANCELLED]: LISTING_ACTIVE_SUBSTATE, [V]: numeric })), LISTING_CANCELLED, TPL_LISTING);
  assert.deepEqual(facts.escrow.tokenIds, ['u64_7', 'str_named']);
});

test('an escrow token id that is no v0.48 NonFungibleId variant is refused, not passed through', async () => {
  setMarketplaceCurrentEpoch(11993);
  const V = 'vault_0844561f831f45f4acd554e8b11af432db0ca210309d7b2cb575883a452d7d60';
  const bogus = { Vault: { freeze_flags: 0, resource_container: { NonFungible: { address: `resource_${NFT_A_RESTART_B}`, locked_token_ids: [], token_ids: [{ Weird: 'x' }] } } } };
  await assert.rejects(
    decodeListing(reader(substates({ [LISTING_CANCELLED]: LISTING_ACTIVE_SUBSTATE, [V]: bogus })), LISTING_CANCELLED, TPL_LISTING),
    (e) => e instanceof MarketplaceDecodeError && /is not a NonFungibleId variant/.test(e.message),
  );
});

test('a listing whose expiry has passed is reported EXPIRED, never ACTIVE', async () => {
  setMarketplaceCurrentEpoch(20000);
  const expiring = component(TPL_LISTING, [
    tagVault('0844561f831f45f4acd554e8b11af432db0ca210309d7b2cb575883a452d7d60'),
    tagRes(NFT_A_RESTART_B),
    nftIdString('v042-restart-swap-b-f2a02'),
    tagRes(TTARI),
    100,
    tagComponent(ACCOUNT_A),
    11994,
    [0, []],
  ]);
  const facts = await decodeListing(reader(substates({ [LISTING_SOLD]: expiring })), LISTING_SOLD, TPL_LISTING);
  assert.equal(facts.listing.status, 'EXPIRED');
});

test('a listing decode refuses a component whose header names a different template', async () => {
  await assert.rejects(
    () => decodeListing(reader(substates()), LISTING_CANCELLED, TPL_OFFER),
    (e) => e instanceof MarketplaceDecodeError && /is template/.test(e.message),
  );
});

test('a listing decode refuses a component with no template address at all', async () => {
  const headerless = { Component: { header: {}, body: { state: [] } } };
  await assert.rejects(
    () => decodeListing(reader(substates({ [LISTING_CANCELLED]: headerless })), LISTING_CANCELLED, TPL_LISTING),
    (e) => e instanceof MarketplaceDecodeError && /cannot be established/.test(e.message),
  );
});

test('a listing decode refuses an escrow vault that holds a different resource than declared', async () => {
  const wrongVault = nftVault('a473310dcefbcfe7c46f9cecdefa3423d3236cff0c2bca65ea12707a98a1b985', []);
  await assert.rejects(
    () => decodeListing(reader(substates({ 'vault_ec6f5867cc06573d009c4c27ab1b5821c722f41e647cff2dbcf7b79e0840c47a': wrongVault })), LISTING_CANCELLED, TPL_LISTING),
    (e) => e instanceof MarketplaceDecodeError && /but the component declares/.test(e.message),
  );
});

test('a listing decode refuses a short state tuple rather than inventing fields', async () => {
  const short = component(TPL_LISTING, [tagRes(NFT_A_RESTART_B), nftIdString('x')]);
  await assert.rejects(
    () => decodeListing(reader(substates({ [LISTING_CANCELLED]: short })), LISTING_CANCELLED, TPL_LISTING),
    (e) => e instanceof MarketplaceDecodeError && /not the expected 8-field tuple/.test(e.message),
  );
});

test('an out-of-vocabulary listing status index is refused, not normalised to ACTIVE', async () => {
  const future = component(TPL_LISTING, [
    tagVault('ec6f5867cc06573d009c4c27ab1b5821c722f41e647cff2dbcf7b79e0840c47a'),
    tagRes(NFT_A_RESTART_B),
    nftIdString('v042-restart-swap-b-f2a02'),
    tagRes(TTARI),
    100,
    tagComponent(ACCOUNT_A),
    0,
    [9, []],
  ]);
  await assert.rejects(
    () => decodeListing(reader(substates({ [LISTING_CANCELLED]: future })), LISTING_CANCELLED, TPL_LISTING),
    (e) => e instanceof MarketplaceDecodeError && /outside the declared vocabulary/.test(e.message),
  );
});

// --- ItemOffer --------------------------------------------------------------

test('live cancelled offer decodes Cancelled with a refunded (empty) escrow', async () => {
  setMarketplaceCurrentEpoch(11993);
  const facts = await decodeItemOffer(reader(substates()), OFFER_CANCELLED, TPL_OFFER);
  assert.deepEqual(facts.itemOffer, {
    offerAddress: OFFER_CANCELLED,
    buyerAccount: `component_${ACCOUNT_A}`,
    collectionResource: `resource_${NFT_A_RESTART_B}`,
    nftId: 'str_v042-restart-swap-b-f2a02',
    quoteResource: `resource_${TTARI}`,
    amount: '100',
    createdAtEpoch: '11993',
    expiresAtEpoch: '0',
    status: 'CANCELLED',
  });
  assert.equal(facts.escrow.amount, '0');
  assert.equal(facts.escrow.empty, true);
});

test('live accepted offer decodes Accepted with no residual escrow', async () => {
  setMarketplaceCurrentEpoch(11993);
  const facts = await decodeItemOffer(reader(substates()), OFFER_ACCEPTED, TPL_OFFER);
  assert.equal(facts.itemOffer.status, 'ACCEPTED');
  assert.equal(facts.escrow.empty, true);
});

test('an Active offer reports the exact escrowed quote amount', async () => {
  setMarketplaceCurrentEpoch(11993);
  const map = substates({ [OFFER_CANCELLED]: OFFER_ACTIVE_SUBSTATE });
  const facts = await decodeItemOffer(reader(map), OFFER_CANCELLED, TPL_OFFER);
  assert.equal(facts.itemOffer.status, 'ACTIVE');
  assert.equal(facts.escrow.amount, '100');
  assert.equal(facts.escrow.empty, false);
});

test('an offer past its expiry is reported EXPIRED so a stale offer is never presented as live', async () => {
  setMarketplaceCurrentEpoch(30000);
  const expiring = component(TPL_OFFER, [
    tagVault('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
    tagComponent(ACCOUNT_A),
    tagRes(NFT_A_RESTART_B),
    nftIdString('v042-restart-swap-b-f2a02'),
    tagRes(TTARI),
    100,
    11993,
    11994,
    [0, []],
  ]);
  const facts = await decodeItemOffer(reader(substates({ [OFFER_CANCELLED]: expiring })), OFFER_CANCELLED, TPL_OFFER);
  assert.equal(facts.itemOffer.status, 'EXPIRED');
});

test('an offer decode refuses the wrong template', async () => {
  await assert.rejects(
    () => decodeItemOffer(reader(substates()), OFFER_CANCELLED, TPL_LISTING),
    (e) => e instanceof MarketplaceDecodeError && /is template/.test(e.message),
  );
});

test('an offer decode refuses a vault holding a resource other than the declared quote', async () => {
  const wrong = ttariVault('a4991893d4970b446ae86dcf6210212e3bcbef2b5499df8d1a10516f0add5a72', 100);
  await assert.rejects(
    () => decodeItemOffer(reader(substates({ 'vault_1ff74744068c77badf1d79fdd03e9f24b6c5b8bd55d334e74335dd4d7938820a': wrong })), OFFER_CANCELLED, TPL_OFFER),
    (e) => e instanceof MarketplaceDecodeError && /but the component declares/.test(e.message),
  );
});

test('an offer decode refuses a quote escrow whose declared amount is not an integer', async () => {
  const badAmount = { Vault: { freeze_flags: 0, resource_container: { Stealth: { address: `resource_${TTARI}`, locked_amount: '0', revealed_amount: 'lots' } } } };
  await assert.rejects(
    () => decodeItemOffer(reader(substates({ 'vault_1ff74744068c77badf1d79fdd03e9f24b6c5b8bd55d334e74335dd4d7938820a': badAmount })), OFFER_CANCELLED, TPL_OFFER),
    (e) => e instanceof MarketplaceDecodeError && /not a non-negative integer/.test(e.message),
  );
});

test('an offer decode refuses an NFT id it cannot name', async () => {
  const futureVariant = component(TPL_OFFER, [
    tagVault('1ff74744068c77badf1d79fdd03e9f24b6c5b8bd55d334e74335dd4d7938820a'),
    tagComponent(ACCOUNT_A),
    tagRes(NFT_A_RESTART_B),
    [7, [{ some: 'thing' }]],
    tagRes(TTARI),
    100,
    11993,
    0,
    [0, []],
  ]);
  await assert.rejects(
    () => decodeItemOffer(reader(substates({ [OFFER_CANCELLED]: futureVariant })), OFFER_CANCELLED, TPL_OFFER),
    (e) => e instanceof MarketplaceDecodeError && /unknown NonFungibleId variant 7/.test(e.message),
  );
});

// --- CollectionBid ----------------------------------------------------------

test('live filled bid decodes Filled with zero remaining quantity and zero escrow', async () => {
  setMarketplaceCurrentEpoch(11993);
  const facts = await decodeCollectionBid(reader(substates()), BID_FILLED, TPL_BID);
  assert.deepEqual(facts.collectionBid, {
    bidAddress: BID_FILLED,
    buyerAccount: `component_${ACCOUNT_A}`,
    collectionResource: `resource_${NFT_B_SOAK_A}`,
    quoteResource: `resource_${TTARI}`,
    pricePerNft: '100',
    originalQuantity: '1',
    remainingQuantity: '0',
    originalEscrow: '100',
    remainingEscrow: '0',
    createdAtEpoch: '11993',
    expiresAtEpoch: '0',
    status: 'FILLED',
  });
  assert.equal(facts.escrow.empty, true);
});

test('a cancelled bid keeps its original quantity while reporting zero remaining escrow', async () => {
  setMarketplaceCurrentEpoch(11993);
  const facts = await decodeCollectionBid(reader(substates()), BID_CANCELLED, TPL_BID);
  assert.equal(facts.collectionBid.status, 'CANCELLED');
  assert.equal(facts.collectionBid.remainingQuantity, '1');
  assert.equal(facts.collectionBid.remainingEscrow, '0');
  assert.equal(facts.collectionBid.originalEscrow, '100');
  assert.equal(facts.escrow.amount, '0');
});

test('an Active bid reports remaining escrow equal to price times remaining quantity', async () => {
  setMarketplaceCurrentEpoch(11993);
  const map = substates({
    [BID_FILLED]: BID_ACTIVE_SUBSTATE,
    'vault_3aca98669865d6318fa877a878379eab699c90d67d7abb38533aa7c750964940': ttariVault(TTARI, 100),
  });
  const facts = await decodeCollectionBid(reader(map), BID_FILLED, TPL_BID);
  assert.equal(facts.collectionBid.status, 'ACTIVE');
  assert.equal(facts.collectionBid.remainingEscrow, '100');
  assert.equal(
    BigInt(facts.collectionBid.remainingEscrow),
    BigInt(facts.collectionBid.pricePerNft) * BigInt(facts.collectionBid.remainingQuantity),
    'remaining escrow must equal price x remaining quantity',
  );
});

test('a bid whose escrow does not match price times remaining quantity is surfaced, not corrected', async () => {
  setMarketplaceCurrentEpoch(11993);
  const lying = component(TPL_BID, [
    tagVault('3aca98669865d6318fa877a878379eab699c90d67d7abb38533aa7c750964940'),
    tagComponent(ACCOUNT_A),
    tagRes(NFT_B_SOAK_A),
    tagRes(TTARI),
    100,
    1,
    1,
    100,
    7,
    11993,
    0,
    [0, []],
  ]);
  const facts = await decodeCollectionBid(reader(substates({ [BID_FILLED]: lying })), BID_FILLED, TPL_BID);
  // The decoder reports the chain's numbers verbatim; the UI, not the decoder, decides
  // what an inconsistent bid means. Asserting it here pins that the value is NOT fixed up.
  assert.equal(facts.collectionBid.remainingEscrow, '7');
  assert.notEqual(
    BigInt(facts.collectionBid.remainingEscrow),
    BigInt(facts.collectionBid.pricePerNft) * BigInt(facts.collectionBid.remainingQuantity),
  );
});

test('a partially filled bid decodes PARTIALLY_FILLED with its decremented quantity', async () => {
  setMarketplaceCurrentEpoch(11993);
  const partial = component(TPL_BID, [
    tagVault('3aca98669865d6318fa877a878379eab699c90d67d7abb38533aa7c750964940'),
    tagComponent(ACCOUNT_A),
    tagRes(NFT_B_SOAK_A),
    tagRes(TTARI),
    100,
    3,
    2,
    300,
    200,
    11993,
    0,
    [1, []],
  ]);
  const facts = await decodeCollectionBid(reader(substates({ [BID_FILLED]: partial })), BID_FILLED, TPL_BID);
  assert.equal(facts.collectionBid.status, 'PARTIALLY_FILLED');
  assert.equal(facts.collectionBid.remainingQuantity, '2');
  assert.equal(facts.collectionBid.remainingEscrow, '200');
});

test('a bid past its expiry is reported EXPIRED', async () => {
  setMarketplaceCurrentEpoch(30000);
  const expiring = component(TPL_BID, [
    tagVault('3aca98669865d6318fa877a878379eab699c90d67d7abb38533aa7c750964940'),
    tagComponent(ACCOUNT_A),
    tagRes(NFT_B_SOAK_A),
    tagRes(TTARI),
    100,
    1,
    1,
    100,
    100,
    11993,
    11994,
    [0, []],
  ]);
  const facts = await decodeCollectionBid(reader(substates({ [BID_FILLED]: expiring })), BID_FILLED, TPL_BID);
  assert.equal(facts.collectionBid.status, 'EXPIRED');
});

test('a bid decode refuses the wrong template', async () => {
  await assert.rejects(
    () => decodeCollectionBid(reader(substates()), BID_FILLED, TPL_OFFER),
    (e) => e instanceof MarketplaceDecodeError && /is template/.test(e.message),
  );
});

test('a bid decode refuses a short state tuple', async () => {
  const short = component(TPL_BID, [tagRes(NFT_B_SOAK_A)]);
  await assert.rejects(
    () => decodeCollectionBid(reader(substates({ [BID_FILLED]: short })), BID_FILLED, TPL_BID),
    (e) => e instanceof MarketplaceDecodeError && /not the expected 12-field tuple/.test(e.message),
  );
});

// --- escrow + header primitives --------------------------------------------

test('readEscrow reports a fungible amount and a non-fungible id list distinctly', async () => {
  const map = substates();
  const money = await readEscrow(reader(map), 'vault_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', `resource_${TTARI}`);
  assert.equal(money.amount, '100');
  assert.equal(money.empty, false);
  const item = await readEscrow(reader(map), 'vault_0844561f831f45f4acd554e8b11af432db0ca210309d7b2cb575883a452d7d60', `resource_${NFT_A_RESTART_B}`);
  assert.equal(item.amount, '0');
  assert.deepEqual(item.tokenIds, ['str_v042-restart-swap-b-f2a02']);
});

test('readEscrow refuses a vault that carries no resource address', async () => {
  const noAddress = { Vault: { freeze_flags: 0, resource_container: { Fungible: { amount: '5' } } } };
  await assert.rejects(
    () => readEscrow(reader(substates({ 'vault_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff': noAddress })), 'vault_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', `resource_${TTARI}`),
    (e) => e instanceof MarketplaceDecodeError && /cannot be proven/.test(e.message),
  );
});

test('readEscrow refuses an unrecognised container kind', async () => {
  const weird = { Vault: { freeze_flags: 0, resource_container: { Quantum: { amount: '1' } } } };
  await assert.rejects(
    () => readEscrow(reader(substates({ 'vault_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff': weird })), 'vault_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', `resource_${TTARI}`),
    (e) => e instanceof MarketplaceDecodeError && /unrecognised container kind/.test(e.message),
  );
});

test('the header read reports owner_rule None and the live method access map', () => {
  const header = decodeComponentHeader({
    Component: {
      header: {
        template_address: TPL_LISTING,
        owner_rule: 'None',
        access_rules: {
          default: 'DenyAll',
          method_access: { buy: 'AllowAll', cancel: { Restricted: { Require: { NonFungibleAddress: { resource_address: 'resource_0100' } } } }, listing: 'AllowAll' },
        },
      },
      body: { state: [] },
    },
  });
  assert.equal(header.templateAddress, TPL_LISTING);
  assert.equal(header.ownerRule, 'None');
  assert.equal(header.defaultRule, 'DenyAll');
  assert.equal(header.methodAccess.buy, 'AllowAll');
});

test('marketplaceTemplateAddress accepts a template_ prefixed header and normalises it', () => {
  assert.equal(marketplaceTemplateAddress(LISTING_CANCELLED_SUBSTATE), TPL_LISTING);
});

test('setMarketplaceCurrentEpoch refuses a non-integer epoch', () => {
  assert.throws(() => setMarketplaceCurrentEpoch('12a'), MarketplaceDecodeError);
  assert.throws(() => setMarketplaceCurrentEpoch('-1'), MarketplaceDecodeError);
});

// --- the readback provider wires the decoder for real -----------------------

test('the ootle readback provider decodes a real listing through the raw path with escrow', async () => {
  setMarketplaceCurrentEpoch(11993);
  const map = substates();
  const provider = createOotleReadbackProvider(
    {
      readComponent: async () => { throw new Error('the flat-field path must not be reached for a real component'); },
      readRaw: async (address) => map[address],
    },
    'WALLET_PROVIDER',
  );
  const read = await provider.readListing(LISTING_SOLD, { templateAddress: `template_${TPL_LISTING}`, epoch: 11993 });
  assert.equal(read.status, 'FOUND');
  assert.equal(read.value.status, 'SOLD');
  assert.equal(read.value.price, '100');
  assert.equal(read.escrow.empty, true);
  assert.equal(read.freshness.identity.epoch, '11993');
  assert.equal(read.freshness.identity.stateIdentity, `${LISTING_SOLD}@FixedPriceListing`);
});

test('the ootle readback provider decodes a real offer and a real bid', async () => {
  setMarketplaceCurrentEpoch(11993);
  const map = substates();
  const provider = createOotleReadbackProvider({ readComponent: async () => undefined, readRaw: async (a) => map[a] }, 'WALLET_PROVIDER');
  const offer = await provider.readItemOffer(OFFER_ACCEPTED, { templateAddress: TPL_OFFER, epoch: 11993 });
  assert.equal(offer.status, 'FOUND');
  assert.equal(offer.value.status, 'ACCEPTED');
  const bid = await provider.readCollectionBid(BID_CANCELLED, { templateAddress: TPL_BID, epoch: 11993 });
  assert.equal(bid.status, 'FOUND');
  assert.equal(bid.value.status, 'CANCELLED');
  assert.equal(bid.value.remainingEscrow, '0');
});

test('the ootle readback provider returns UNAVAILABLE, not a fallback, when the raw decode fails', async () => {
  const provider = createOotleReadbackProvider(
    { readComponent: async () => { throw new Error('must not be reached'); }, readRaw: async () => undefined },
    'WALLET_PROVIDER',
  );
  const read = await provider.readListing(LISTING_SOLD, { templateAddress: TPL_LISTING, epoch: 11993 });
  assert.equal(read.status, 'UNAVAILABLE');
  assert.match(read.reason, /does not exist or could not be read/);
});

test('the ootle readback provider refuses a component that is not the pinned template', async () => {
  const map = substates();
  const provider = createOotleReadbackProvider({ readComponent: async () => undefined, readRaw: async (a) => map[a] }, 'WALLET_PROVIDER');
  const read = await provider.readListing(LISTING_SOLD, { templateAddress: TPL_BID, epoch: 11993 });
  assert.equal(read.status, 'UNAVAILABLE');
  assert.match(read.reason, /is template/);
});
test('NonFungibleId: all four v0.48 variants decode to upstream canonical strings, in both renderings', async () => {
  const { decodeNonFungibleIdForTest } = require('../dist/marketplaceSubstate.js');
  const hex = 'ab'.repeat(32);
  const cases = [
    [[0, [{ '@cbor': 'bytes', hex }]], `uuid_${hex}`],
    [[1, ['art-1']], 'str_art-1'],
    [[2, [7]], 'u32_7'],
    [[3, ['18446744073709551615']], 'u64_18446744073709551615'],
    [{ U256: hex }, `uuid_${hex}`],
    [{ String: 'art-1' }, 'str_art-1'],
    [{ Uint32: 7 }, 'u32_7'],
    [{ Uint64: 7 }, 'u64_7'],
    [{ U64: 7 }, 'u64_7'],
  ];
  for (const [node, want] of cases) assert.equal(decodeNonFungibleIdForTest(node), want, JSON.stringify(node));
  for (const bad of [[4, [1]], [2, [4294967296]], [1, ['']], [1, ['x'.repeat(65)]], { Nope: 1 }, { String: 'a', U64: 1 }, [0, ['00']]]) {
    assert.throws(() => decodeNonFungibleIdForTest(bad), JSON.stringify(bad));
  }
});
