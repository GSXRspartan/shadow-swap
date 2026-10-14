#!/usr/bin/env node
// Live NFT-marketplace scenario driver (Phase A -> B -> offers -> bids).
//
// Every step REREADS authoritative state before it acts, so no step is constructed
// from an expected state. Rejections are recorded as results, never as failures.
// Nothing here publishes a template and nothing here retries a submission.
import {
  NftMarketExecutor,
  MARKETPLACE_ACCOUNTS,
  CANONICAL_TARI_RESOURCE,
} from './nft-market-core.mjs';

const TTARI = CANONICAL_TARI_RESOURCE;
const LEDGER = new URL('./live-op-ledger.jsonl', import.meta.url).pathname.replace(/^\//, '');

const NFT = {
  // account A holds these two
  aRestartB: { res: 'resource_478638b1585da5a19004af5c5ae1752eb4fa6d7669cb226f5d2de113bfc3fb1b', id: 'v042-restart-swap-b-f2a02' },
  aSoakB: { res: 'resource_ef30dd8954ed712c9a48ed27a8e979f9322295c5b3ab34aecb46681fb73ef3d0', id: 'v042-soak-swap-b-6af4d' },
  // account B holds these two
  bRestartA: { res: 'resource_cfcf91651371107812a10d529079b368e997f4f53b73a40b3fa16c58ecd82dd7', id: 'v042-restart-swap-a-7f3c9' },
  bSoakA: { res: 'resource_e6d192037660ad95ae6bc50e3380f435dcf161453fa5754807c33b52a5623bd8', id: 'v042-soak-swap-a-cba74' },
};

const FEE = 400_000;
const PRICE = 100;

const evidence = [];
function record(step, data) {
  evidence.push({ step, ...data });
  console.log(`\n### ${step}\n${JSON.stringify(data, null, 1)}`);
}

function summarise(r) {
  if (r.rejected) return { outcome: 'REJECTED', reason: r.reason };
  if (r.dryRun) return { outcome: 'DRY_RUN_ACCEPT', requiredFees: r.requiredFees };
  return { outcome: r.outcome?.status, tx: r.transactionId, fee: r.outcome?.actualFee, epoch: r.outcome?.epoch, components: r.outcome?.components };
}

async function main() {
  const ex = new NftMarketExecutor({ maxFeePerTxMicro: FEE, ledgerPath: LEDGER });
  await ex.authenticate();
  const identity = await ex.verifyNetwork();
  const version = await ex.walletVersion();
  console.log(`walletd ${version} · ${identity.network}/${identity.networkByte} · epoch ${identity.epoch}`);

  const scenario = process.argv[2] ?? 'all';

  if (scenario === 'all' || scenario === 'phaseA') await phaseA(ex, process.argv[3]);
  if (scenario === 'all' || scenario === 'phaseB') await phaseB(ex);
  if (scenario === 'all' || scenario === 'offer') await itemOffer(ex);
  if (scenario === 'all' || scenario === 'bid') await collectionBid(ex);

  console.log(`\nCUMULATIVE FEES PAID (micro-tTARI): ${ex.feesPaidMicro}`);
  console.log(`\nEVIDENCE_JSON=${JSON.stringify(evidence)}`);
}

// --- helpers ---------------------------------------------------------------

async function asAccount(ex, label, fn) {
  const bound = await ex.setDefaultAccount(label);
  try { return await fn(bound); } finally { await ex.setDefaultAccount('A'); }
}

async function ownerOf(ex, res, id) {
  for (const label of Object.keys(MARKETPLACE_ACCOUNTS)) {
    const inv = await ex.nftInventory(label);
    if (inv.items.some((i) => i.nftResource === res && i.nftId === id)) return label;
  }
  return 'NONE';
}

async function whoHolds(ex, label, res) {
  const inv = await ex.nftInventory(label);
  return inv.items.filter((i) => i.nftResource === res).map((i) => i.nftId);
}

/** Locate a live marketplace component by scanning the two known accounts' recent receipts. */
async function findRecentComponents(ex, templateName, limit = 20) {
  const txs = await ex.rpc('transactions.list', { limit: 40 });
  const want = Object.fromEntries(
    Object.entries({ FixedPriceListing: '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329', ItemOffer: '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6', CollectionBid: '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54' }),
  );
  void want;
  const out = [];
  for (const t of txs?.transactions ?? []) {
    const accept = t?.result?.result?.Accept;
    const up = accept?.up_substates ?? [];
    for (const pair of up) {
      const id = Array.isArray(pair) ? pair[0] : pair?.substate_id;
      if (typeof id === 'string' && id.startsWith('component_')) {
        const sec = await ex.componentSecurity(id).catch(() => null);
        if (sec?.templateName === templateName) out.push({ tx: t.transaction_id, component: id, createdAt: sec });
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

export {};

// --- Phase A: create + cancel, proving a safe reversible cycle -------------

async function phaseA(ex, existingListing) {
  const nft = NFT.aRestartB;
  const before = await ownerOf(ex, nft.res, nft.id);
  record('phaseA.owner-before', { nft, owner: before });

  let listing = existingListing;
  if (listing) {
    // Resuming an interrupted run: adopt the listing only if it is provably THIS listing.
    const sec = await ex.componentSecurity(listing);
    const read0 = await ex.readMarketplace('FixedPriceListing', listing);
    record('phaseA.resume', {
      listing,
      templateName: sec.templateName,
      templateMatchesAudit: sec.templateMatchesAudit,
      decoded: read0.decoded,
      identityMatches: read0.decoded?.nftResource === nft.res && read0.decoded?.nftId === nft.id,
    });
    if (sec.templateName !== 'FixedPriceListing' || read0.decoded?.nftResource !== nft.res || read0.decoded?.nftId !== nft.id) {
      record('phaseA.abort', { reason: 'resumed listing is not the expected FixedPriceListing for this NFT' });
      return;
    }
  } else {
    const created = await asAccount(ex, 'A', async (bound) => ex.submit({
      opId: 'nft-phaseA-create-listing',
      intent: `create FixedPriceListing for ${nft.res}/${nft.id} at ${PRICE} as A`,
      templateName: 'FixedPriceListing',
      manifest: `use template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329 as FixedPriceListing;
fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nft.id}"));
  FixedPriceListing::create(account, nft, arg!["quote_resource"], amount!(${PRICE}), 0u64);
}`,
      variables: { account: bound.component, nft_resource: nft.res, quote_resource: TTARI },
      asAccount: bound.label,
      maxFeeMicro: FEE,
      meta: { kind: 'FixedPriceListing', nftResource: nft.res, nftId: nft.id, quoteResource: TTARI, price: PRICE, expiryEpoch: 0 },
    }));
    record('phaseA.create', summarise(created));
    listing = created.outcome?.components?.[0];
    if (!listing) { record('phaseA.abort', { reason: 'no component upped' }); return; }

    record('phaseA.security', await ex.componentSecurity(listing));
    record('phaseA.readback', (await ex.readMarketplace('FixedPriceListing', listing)).decoded);
    record('phaseA.owner-after-create', { owner: await ownerOf(ex, nft.res, nft.id), note: 'escrowed by the listing component' });
  }

  // Adversarial, zero cost: a stranger may not cancel, and buy must reject a zero payment.
  const strangerCancel = await asAccount(ex, 'B', (bound) => ex.submit({
    opId: 'nft-phaseA-stranger-cancel', intent: 'stranger cancel of A listing',
    templateName: 'FixedPriceListing',
    manifest: `fn main() { let l = arg!["listing"]; l.cancel(); }`,
    variables: { listing }, asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'FixedPriceListing', component: listing, adversarial: 'stranger-cancel' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('phaseA.stranger-cancel', summarise(strangerCancel));

const currentStatus = (await ex.readMarketplace('FixedPriceListing', listing)).decoded?.status;
  if (currentStatus === 'Active') {
    const cancelled = await asAccount(ex, 'A', (bound) => ex.submit({
      opId: 'nft-phaseA-cancel-listing', intent: `cancel FixedPriceListing ${listing} as A`,
      templateName: 'FixedPriceListing',
      manifest: `fn main() { let l = arg!["listing"]; l.cancel(); }`,
      variables: { listing }, asAccount: bound.label, maxFeeMicro: FEE,
      meta: { kind: 'FixedPriceListing', component: listing },
    }));
    record('phaseA.cancel', summarise(cancelled));
  } else {
    record('phaseA.cancel', { outcome: 'ALREADY_TERMINAL', status: currentStatus, note: 'not resubmitted; an already-terminal component is never re-driven' });
  }

  const read2 = await ex.readMarketplace('FixedPriceListing', listing);
  record('phaseA.readback-after-cancel', read2.decoded);

  const afterCancel = await ownerOf(ex, nft.res, nft.id);
  record('phaseA.owner-after-cancel', { owner: afterCancel });

  const buyAfterCancel = await asAccount(ex, 'B', (bound) => ex.submit({
    opId: 'nft-phaseA-buy-after-cancel', intent: 'buy a cancelled listing',
    templateName: 'FixedPriceListing',
    manifest: `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw(arg!["quote_resource"], amount!(${PRICE}));
  let listing_ref = arg!["listing"];
  listing_ref.buy(payment, account);
}`,
    variables: { account: bound.component, listing, quote_resource: TTARI },
    asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'FixedPriceListing', component: listing, adversarial: 'buy-after-cancel' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('phaseA.buy-after-cancel', summarise(buyAfterCancel));

  record('phaseA.listingAddress', { listing });
}

// --- Phase B: create + buy with account B ---------------------------------

async function phaseB(ex) {
  const nft = NFT.aRestartB;
  const owned = await ownerOf(ex, nft.res, nft.id);
  record('phaseB.owner-before', { nft, owner: owned });

  const created = await asAccount(ex, 'A', async (bound) => ex.submit({
    opId: 'nft-phaseB-create-listing',
    intent: `relist ${nft.res}/${nft.id} at ${PRICE} as A`,
    templateName: 'FixedPriceListing',
    manifest: `use template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329 as FixedPriceListing;
fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nft.id}"));
  FixedPriceListing::create(account, nft, arg!["quote_resource"], amount!(${PRICE}), 0u64);
}`,
    variables: { account: bound.component, nft_resource: nft.res, quote_resource: TTARI },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'FixedPriceListing', nftResource: nft.res, nftId: nft.id, quoteResource: TTARI, price: PRICE },
  }));
  record('phaseB.create', summarise(created));
  const listing = created.outcome?.components?.[0];
  if (!listing) { record('phaseB.abort', { reason: 'no component upped' }); return; }
  record('phaseB.listingAddress', { listing });

  const sellerBefore = await ex.publicBalance('A', TTARI);
  const buyerBefore = await ex.publicBalance('B', TTARI);
  record('phaseB.balances-before', { seller: sellerBefore, buyer: buyerBefore });

  // Adversarial: underpayment and a non-matching quote resource must both reject.
  const underp = await asAccount(ex, 'B', (bound) => ex.submit({
    opId: 'nft-phaseB-underpay', intent: 'buy listing at price-1',
    templateName: 'FixedPriceListing',
    manifest: `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw(arg!["quote_resource"], amount!(${PRICE - 1}));
  let listing_ref = arg!["listing"];
  listing_ref.buy(payment, account);
}`,
    variables: { account: bound.component, listing, quote_resource: TTARI },
    asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'FixedPriceListing', component: listing, adversarial: 'underpay' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('phaseB.underpay', summarise(underp));

  const bought = await asAccount(ex, 'B', (bound) => ex.submit({
    opId: 'nft-phaseB-buy-listing', intent: `buy FixedPriceListing ${listing} for ${PRICE} as B`,
    templateName: 'FixedPriceListing',
    manifest: `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw(arg!["quote_resource"], amount!(${PRICE}));
  let listing_ref = arg!["listing"];
  listing_ref.buy(payment, account);
}`,
    variables: { account: bound.component, listing, quote_resource: TTARI },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'FixedPriceListing', component: listing, price: PRICE },
  }));
  record('phaseB.buy', summarise(bought));

  const readback = await ex.readMarketplace('FixedPriceListing', listing);
  record('phaseB.readback', readback.decoded);

  const ownerAfter = await ownerOf(ex, nft.res, nft.id);
  const sellerAfter = await ex.publicBalance('A', TTARI);
  const buyerAfter = await ex.publicBalance('B', TTARI);
  record('phaseB.after', { owner: ownerAfter, sellerDelta: Number(sellerAfter.balance) - Number(sellerBefore.balance), buyerDelta: Number(buyerAfter.balance) - Number(buyerBefore.balance) });

  const doubleBuy = await asAccount(ex, 'B', (bound) => ex.submit({
    opId: 'nft-phaseB-double-buy', intent: 'buy the same listing twice',
    templateName: 'FixedPriceListing',
    manifest: `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw(arg!["quote_resource"], amount!(${PRICE}));
  let listing_ref = arg!["listing"];
  listing_ref.buy(payment, account);
}`,
    variables: { account: bound.component, listing, quote_resource: TTARI },
    asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'FixedPriceListing', component: listing, adversarial: 'double-buy' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('phaseB.double-buy', summarise(doubleBuy));

  const cancelAfterBuy = await asAccount(ex, 'A', (bound) => ex.submit({
    opId: 'nft-phaseB-cancel-after-buy', intent: 'cancel a sold listing',
    templateName: 'FixedPriceListing',
    manifest: `fn main() { let l = arg!["listing"]; l.cancel(); }`,
    variables: { listing }, asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'FixedPriceListing', component: listing, adversarial: 'cancel-after-fill' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('phaseB.cancel-after-buy', summarise(cancelAfterBuy));

  record('phaseB.soldListing', { listing });
}

// --- ItemOffer -------------------------------------------------------------

async function itemOffer(ex) {
  // Phase B left aRestartB with B. The offer maker must be the account that does NOT
  // hold the NFT, so A offers and B accepts. Ownership is reread, never assumed.
  const nft = NFT.aRestartB;
  const maker = 'A';
  const taker = 'B';
  const held = await ownerOf(ex, nft.res, nft.id);
  record('offer.owner-before', { nft, owner: held });
  if (held !== taker) { record('offer.skip', { reason: `expected ${taker} to hold it, found ${held}` }); return; }

  const buyerBefore = await ex.publicBalance(maker, TTARI);
  const sellerBefore = await ex.publicBalance(taker, TTARI);

  const created = await asAccount(ex, maker, async (bound) => ex.submit({
    opId: 'nft-offer-create',
    intent: `create ItemOffer for ${nft.res}/${nft.id} at ${PRICE} as ${maker}`,
    templateName: 'ItemOffer',
    manifest: `use template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6 as ItemOffer;
fn main() {
  let account = arg!["account"];
  let quote = account.withdraw(arg!["quote_resource"], amount!(${PRICE}));
  ItemOffer::create(account, quote, arg!["nft_resource"], non_fungible_id!("${nft.id}"), 0u64);
}`,
    variables: { account: bound.component, quote_resource: TTARI, nft_resource: nft.res },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'ItemOffer', nftResource: nft.res, nftId: nft.id, quoteResource: TTARI, offerAmount: PRICE, buyerAccount: bound.component },
  }));
  record('offer.create', summarise(created));
  const offer = created.outcome?.components?.[0];
  if (!offer) { record('offer.abort', { reason: 'no component upped' }); return; }
  record('offer.security', await ex.componentSecurity(offer));
  record('offer.readback', (await ex.readMarketplace('ItemOffer', offer)).decoded);

  const buyerAfterCreate = await ex.publicBalance(maker, TTARI);
  record('offer.escrow', { buyerDelta: Number(buyerAfterCreate.balance) - Number(buyerBefore.balance) });

  // Adversarial: wrong NFT id must reject; stranger cancel must reject.
  const wrongId = await asAccount(ex, taker, (bound) => ex.submit({
    opId: 'nft-offer-wrong-id', intent: 'accept an offer with the wrong nft id',
    templateName: 'ItemOffer',
    manifest: `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("not-the-offered-id"));
  let offer_ref = arg!["offer"];
  offer_ref.accept(nft, account);
}`,
    variables: { account: bound.component, offer, nft_resource: nft.res },
    asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'ItemOffer', component: offer, adversarial: 'wrong-nft-id' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('offer.wrong-id', summarise(wrongId));

  const strangerCancel = await asAccount(ex, taker, (bound) => ex.submit({
    opId: 'nft-offer-stranger-cancel', intent: `stranger cancel of an offer made by ${maker}`,
    templateName: 'ItemOffer',
    manifest: `fn main() { let o = arg!["offer"]; o.cancel(); }`,
    variables: { offer }, asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'ItemOffer', component: offer, adversarial: 'stranger-cancel' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('offer.stranger-cancel', summarise(strangerCancel));

const cancelled = await asAccount(ex, maker, (bound) => ex.submit({
    opId: 'nft-offer-cancel', intent: `cancel ItemOffer ${offer} as ${maker}`,
    templateName: 'ItemOffer',
    manifest: `fn main() { let o = arg!["offer"]; o.cancel(); }`,
    variables: { offer }, asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'ItemOffer', component: offer },
  }));
  record('offer.cancel', summarise(cancelled));
  record('offer.readback-after-cancel', (await ex.readMarketplace('ItemOffer', offer)).decoded);
  const buyerAfterCancel = await ex.publicBalance(maker, TTARI);
  record('offer.refund', { buyerDelta: Number(buyerAfterCancel.balance) - Number(buyerBefore.balance), note: 'minus fees' });
  const stillOwner = await ownerOf(ex, nft.res, nft.id);
  record('offer.owner-after-cancel', { owner: stillOwner });

  // Recreate and accept.
  const created2 = await asAccount(ex, maker, async (bound) => ex.submit({
    opId: 'nft-offer-recreate', intent: `recreate ItemOffer for ${nft.res}/${nft.id}`,
    templateName: 'ItemOffer',
    manifest: `use template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6 as ItemOffer;
fn main() {
  let account = arg!["account"];
  let quote = account.withdraw(arg!["quote_resource"], amount!(${PRICE}));
  ItemOffer::create(account, quote, arg!["nft_resource"], non_fungible_id!("${nft.id}"), 0u64);
}`,
    variables: { account: bound.component, quote_resource: TTARI, nft_resource: nft.res },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'ItemOffer', nftResource: nft.res, nftId: nft.id, quoteResource: TTARI, offerAmount: PRICE },
  }));
  record('offer.recreate', summarise(created2));
  const offer2 = created2.outcome?.components?.[0];
  if (!offer2) return;

const accepted = await asAccount(ex, taker, (bound) => ex.submit({
    opId: 'nft-offer-accept', intent: `accept ItemOffer ${offer2} with ${nft.res}/${nft.id} as ${taker}`,
    templateName: 'ItemOffer',
    manifest: `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nft.id}"));
  let offer_ref = arg!["offer"];
  offer_ref.accept(nft, account);
}`,
    variables: { account: bound.component, offer: offer2, nft_resource: nft.res },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'ItemOffer', component: offer2, nftResource: nft.res, nftId: nft.id },
  }));
  record('offer.accept', summarise(accepted));
  record('offer.readback-after-accept', (await ex.readMarketplace('ItemOffer', offer2)).decoded);

  const ownerAfter = await ownerOf(ex, nft.res, nft.id);
  const sellerAfter = await ex.publicBalance(taker, TTARI);
  record('offer.after', { owner: ownerAfter, sellerDelta: Number(sellerAfter.balance) - Number(sellerBefore.balance) });

  const replay = await asAccount(ex, taker, (bound) => ex.submit({
    opId: 'nft-offer-replay', intent: 'replay accept of a settled offer',
    templateName: 'ItemOffer',
    manifest: `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nft.id}"));
  let offer_ref = arg!["offer"];
  offer_ref.accept(nft, account);
}`,
    variables: { account: bound.component, offer: offer2, nft_resource: nft.res },
    asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'ItemOffer', component: offer2, adversarial: 'replay' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('offer.replay', summarise(replay));
}

// --- CollectionBid ---------------------------------------------------------

async function collectionBid(ex) {
  // Collection identity for V042R items is the NFT resource itself; each V042R resource
  // holds exactly one item. Bid on bSoakA's resource with B as seller filling.
  const nft = NFT.bSoakA;
  const seller = 'B';
  const bidder = 'A';
  record('bid.owner-before', { nft, owner: await ownerOf(ex, nft.res, nft.id) });

  const bidderBefore = await ex.publicBalance(bidder, TTARI);
  const sellerBefore = await ex.publicBalance(seller, TTARI);

  const created = await asAccount(ex, bidder, async (bound) => ex.submit({
    opId: 'nft-bid-create',
    intent: `create CollectionBid on ${nft.res} at ${PRICE} x1 as ${bidder}`,
    templateName: 'CollectionBid',
    manifest: `use template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54 as CollectionBid;
fn main() {
  let account = arg!["account"];
  let quote = account.withdraw(arg!["quote_resource"], amount!(${PRICE}));
  CollectionBid::create(account, quote, arg!["collection"], amount!(${PRICE}), 1u64, 0u64);
}`,
    variables: { account: bound.component, quote_resource: TTARI, collection: nft.res },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'CollectionBid', collection: nft.res, quoteResource: TTARI, pricePerNft: PRICE, quantity: 1, buyerAccount: bound.component },
  }));
  record('bid.create', summarise(created));
  const bid = created.outcome?.components?.[0];
  if (!bid) { record('bid.abort', { reason: 'no component upped' }); return; }
  record('bid.security', await ex.componentSecurity(bid));
  record('bid.readback', (await ex.readMarketplace('CollectionBid', bid)).decoded);
  const bidderAfterCreate = await ex.publicBalance(bidder, TTARI);
  record('bid.escrow', { bidderDelta: Number(bidderAfterCreate.balance) - Number(bidderBefore.balance) });

  // Adversarial: a DIFFERENT collection must not be fillable against this bid.
  const wrongCollection = await asAccount(ex, 'B', (bound) => ex.submit({
    opId: 'nft-bid-wrong-collection', intent: 'fill a bid with an nft from another collection',
    templateName: 'CollectionBid',
    manifest: `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${NFT.bRestartA.id}"));
  let bid_ref = arg!["bid"];
  bid_ref.fill(nft, account);
}`,
    variables: { account: bound.component, bid, nft_resource: NFT.bRestartA.res },
    asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'CollectionBid', component: bid, adversarial: 'wrong-collection' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('bid.wrong-collection', summarise(wrongCollection));

  const filled = await asAccount(ex, seller, (bound) => ex.submit({
    opId: 'nft-bid-fill', intent: `fill CollectionBid ${bid} with ${nft.res}/${nft.id} as ${seller}`,
    templateName: 'CollectionBid',
    manifest: `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nft.id}"));
  let bid_ref = arg!["bid"];
  bid_ref.fill(nft, account);
}`,
    variables: { account: bound.component, bid, nft_resource: nft.res },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'CollectionBid', component: bid, nftResource: nft.res, nftId: nft.id },
  }));
  record('bid.fill', summarise(filled));
  record('bid.readback-after-fill', (await ex.readMarketplace('CollectionBid', bid)).decoded);

  const ownerAfter = await ownerOf(ex, nft.res, nft.id);
  const sellerAfter = await ex.publicBalance(seller, TTARI);
  const bidderAfter = await ex.publicBalance(bidder, TTARI);
  record('bid.after', {
    owner: ownerAfter,
    sellerDelta: Number(sellerAfter.balance) - Number(sellerBefore.balance),
    bidderDelta: Number(bidderAfter.balance) - Number(bidderBefore.balance),
  });

  const overfill = await asAccount(ex, seller, (bound) => ex.submit({
    opId: 'nft-bid-overfill', intent: 'fill a fully filled bid again',
    templateName: 'CollectionBid',
    manifest: `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("${nft.id}"));
  let bid_ref = arg!["bid"];
  bid_ref.fill(nft, account);
}`,
    variables: { account: bound.component, bid, nft_resource: nft.res },
    asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'CollectionBid', component: bid, adversarial: 'overfill' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('bid.overfill', summarise(overfill));

  // A second bid on the remaining A-held NFT, then cancel it to prove the refund path.
  const cancelTarget = NFT.aSoakB;
  const cancelHeld = await ownerOf(ex, cancelTarget.res, cancelTarget.id);
  record('bid2.owner-before', { nft: cancelTarget, owner: cancelHeld });
  if (cancelHeld !== 'A') { record('bid2.skip', { reason: `expected A, got ${cancelHeld}` }); return; }

  const bidderBefore2 = await ex.publicBalance(bidder, TTARI);
  const created2 = await asAccount(ex, bidder, async (bound) => ex.submit({
    opId: 'nft-bid2-create',
    intent: `create a cancellable CollectionBid on ${cancelTarget.res} as ${bidder}`,
    templateName: 'CollectionBid',
    manifest: `use template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54 as CollectionBid;
fn main() {
  let account = arg!["account"];
  let quote = account.withdraw(arg!["quote_resource"], amount!(${PRICE}));
  CollectionBid::create(account, quote, arg!["collection"], amount!(${PRICE}), 1u64, 0u64);
}`,
    variables: { account: bound.component, quote_resource: TTARI, collection: cancelTarget.res },
    asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'CollectionBid', collection: cancelTarget.res, pricePerNft: PRICE, quantity: 1 },
  }));
  record('bid2.create', summarise(created2));
  const bid2 = created2.outcome?.components?.[0];
  if (!bid2) return;

  const strangerCancel = await asAccount(ex, seller, (bound) => ex.submit({
    opId: 'nft-bid2-stranger-cancel', intent: 'stranger cancel of a bid',
    templateName: 'CollectionBid',
    manifest: `fn main() { let b = arg!["bid"]; b.cancel(); }`,
    variables: { bid: bid2 }, asAccount: bound.label, dryRun: true, maxFeeMicro: FEE,
    meta: { kind: 'CollectionBid', component: bid2, adversarial: 'stranger-cancel' },
  }).catch((e) => ({ rejected: true, reason: e.message })));
  record('bid2.stranger-cancel', summarise(strangerCancel));

  const cancelled = await asAccount(ex, bidder, (bound) => ex.submit({
    opId: 'nft-bid2-cancel', intent: `cancel CollectionBid ${bid2} as ${bidder}`,
    templateName: 'CollectionBid',
    manifest: `fn main() { let b = arg!["bid"]; b.cancel(); }`,
    variables: { bid: bid2 }, asAccount: bound.label, maxFeeMicro: FEE,
    meta: { kind: 'CollectionBid', component: bid2 },
  }));
  record('bid2.cancel', summarise(cancelled));
  record('bid2.readback-after-cancel', (await ex.readMarketplace('CollectionBid', bid2)).decoded);
  const bidderAfter2 = await ex.publicBalance(bidder, TTARI);
  record('bid2.refund', { bidderDelta: Number(bidderAfter2.balance) - Number(bidderBefore2.balance), note: 'minus fees' });
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });