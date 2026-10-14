#!/usr/bin/env node
// Guarded Esmeralda testnet NFT-marketplace CLI over the PUBLISHED marketplace templates.
//
// This tool never publishes a template. It drives the three already-published
// FixedPriceListing / ItemOffer / CollectionBid components, dry-runs every mutation
// before submitting it, binds the acting account explicitly, submits at most once per
// operation, and reconciles by authoritative reread rather than blind retry.
//
// Usage:
//   node nft-market.mjs inventory  --as A
//   node nft-market.mjs security   --component <component_...>
//   node nft-market.mjs read       --kind FixedPriceListing --component <component_...>
//   node nft-market.mjs create-listing --as A --nft-resource <r> --nft-id <id> [--quote <r>] [--price 100] [--expiry 0]
//   node nft-market.mjs cancel-listing  --as A --component <component_...>
//   node nft-market.mjs buy-listing     --as B --component <component_...> [--price 100] [--quote <r>]
//   node nft-market.mjs create-offer    --as B --nft-resource <r> --nft-id <id> [--quote <r>] [--amount 100] [--expiry 0]
//   node nft-market.mjs cancel-offer    --as B --component <component_...>
//   node nft-market.mjs accept-offer    --as A --component <component_...> --nft-resource <r> --nft-id <id>
//   node nft-market.mjs refund-offer    --as A --component <component_...>
//   node nft-market.mjs create-bid      --as A --collection <r> [--quote <r>] [--price 100] [--qty 1] [--expiry 0]
//   node nft-market.mjs fill-bid        --as B --component <component_...> --nft-resource <r> --nft-id <id>
//   node nft-market.mjs cancel-bid      --as A --component <component_...>
//   node nft-market.mjs refund-bid      --as A --component <component_...>
// Global flags: --dry-run, --max-fee <micro>, --url <loopback>, --json, --ledger <path>
//
// Testnet only. No mainnet. No key export. No L1. No cross-chain.

import {
  NftMarketExecutor,
  MARKETPLACE_ACCOUNTS,
  MARKETPLACE_TEMPLATES,
  CANONICAL_TARI_RESOURCE,
  FEE_BUDGET_TOTAL_MICRO,
  MAX_FEE_PER_MARKETPLACE_TX_MICRO,
  createListingManifest,
  buyListingManifest,
  cancelListingManifest,
  createItemOfferManifest,
  acceptItemOfferManifest,
  cancelItemOfferManifest,
  refundExpiredItemOfferManifest,
  createCollectionBidManifest,
  fillCollectionBidManifest,
  cancelCollectionBidManifest,
  refundExpiredCollectionBidManifest,
} from './nft-market-core.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function req(flags, name) {
  if (flags[name] === undefined || flags[name] === true) throw new Error(`missing required --${name}`);
  return String(flags[name]);
}

function opt(flags, name, fallback) {
  return flags[name] === undefined || flags[name] === true ? fallback : String(flags[name]);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const json = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const maxFeeMicro = flags['max-fee'] !== undefined && flags['max-fee'] !== true ? Number(flags['max-fee']) : undefined;

  const ex = new NftMarketExecutor({
    url: flags.url && flags.url !== true ? String(flags.url) : undefined,
    maxFeePerTxMicro: maxFeeMicro,
    ledgerPath: flags.ledger && flags.ledger !== true ? String(flags.ledger) : undefined,
  });
  await ex.authenticate();
  const identity = await ex.verifyNetwork();
  const version = await ex.walletVersion();
  const quote = opt(flags, 'quote', CANONICAL_TARI_RESOURCE);
  const emit = (obj) => console.log(json ? JSON.stringify(obj, null, 2) : render(command, obj, { identity, version }));

  /**
   * Binds the acting account for the duration of `fn`, then always restores A as the
   * fee-paying default. `fn` receives the bound account; every submission inside must
   * carry `asAccount: bound.label`, so the signed account can never drift from the
   * account the operator selected.
   */
  const withAccount = async (label, fn) => {
    const bound = await ex.setDefaultAccount(label);
    try {
      return await fn(bound);
    } finally {
      await ex.setDefaultAccount('A');
    }
  };

  switch (command) {
    case 'inventory': {
      const out = {};
      for (const label of Object.keys(MARKETPLACE_ACCOUNTS)) out[label] = await ex.nftInventory(label);
      emit({ walletd: version, identity, inventory: out });
      break;
    }
    case 'security': {
      const component = req(flags, 'component');
      emit({ security: await ex.componentSecurity(component) });
      break;
    }
    case 'read': {
      const kind = req(flags, 'kind');
      const component = req(flags, 'component');
      emit(await ex.readMarketplace(kind, component));
      break;
    }
    case 'create-listing': {
      const label = req(flags, 'as');
      const nftResource = req(flags, 'nft-resource');
      const nftId = req(flags, 'nft-id');
      const price = opt(flags, 'price', '100');
      const expiry = Number(opt(flags, 'expiry', '0'));
      const acct = MARKETPLACE_ACCOUNTS[label.toUpperCase()];
      const before = await ex.findNft(label, nftResource, nftId);
      if (!before.held) {
        emit({ refused: `account ${label.toUpperCase()} does not authoritatively hold ${nftResource}/${nftId}` });
        break;
      }
      const built = createListingManifest({ sellerAccount: acct.component, nftResource, nftId, quoteResource: quote, priceMicro: price, expiryEpoch: expiry });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `create-listing-${nftResource.slice(9, 17)}-${dryRun ? 'dry' : 'live'}`,
        intent: `create FixedPriceListing for ${nftResource}/${nftId} at ${price} ${quote} as ${bound.label}`,
        ...built,
        asAccount: bound.label,
        dryRun,
        maxFeeMicro,
        meta: { kind: 'FixedPriceListing', nftResource, nftId, quoteResource: quote, price, expiryEpoch: expiry, sellerAccount: bound.component },
      }));
      emit({ ...r, heldBefore: before.item });
      break;
    }
    case 'cancel-listing': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const built = cancelListingManifest({ listing: component });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `cancel-listing-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `cancel FixedPriceListing ${component} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro,
        meta: { kind: 'FixedPriceListing', component },
      }));
      emit(r);
      break;
    }
    case 'buy-listing': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const readback = await ex.readMarketplace('FixedPriceListing', component);
      const price = opt(flags, 'price', readback.decoded?.price ?? '100');
      const built = buyListingManifest({ buyerAccount: MARKETPLACE_ACCOUNTS[label.toUpperCase()].component, listing: component, quoteResource: readback.decoded?.quoteResource ?? quote, priceMicro: price });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `buy-listing-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `buy FixedPriceListing ${component} for ${price} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro,
        meta: { kind: 'FixedPriceListing', component, price, readback: readback.decoded },
      }));
      emit({ ...r, readback: readback.decoded });
      break;
    }
    case 'create-offer': {
      const label = req(flags, 'as');
      const nftResource = req(flags, 'nft-resource');
      const nftId = req(flags, 'nft-id');
      const amount = opt(flags, 'amount', '100');
      const expiry = Number(opt(flags, 'expiry', '0'));
      const acct = MARKETPLACE_ACCOUNTS[label.toUpperCase()];
      const built = createItemOfferManifest({ buyerAccount: acct.component, quoteResource: quote, offerMicro: amount, nftResource, nftId, expiryEpoch: expiry });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `create-offer-${nftResource.slice(9, 17)}-${dryRun ? 'dry' : 'live'}`,
        intent: `create ItemOffer for ${nftResource}/${nftId} at ${amount} ${quote} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro,
        meta: { kind: 'ItemOffer', nftResource, nftId, quoteResource: quote, offerAmount: amount, expiryEpoch: expiry, buyerAccount: bound.component },
      }));
      emit(r);
      break;
    }
    case 'cancel-offer': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const built = cancelItemOfferManifest({ offer: component });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `cancel-offer-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `cancel ItemOffer ${component} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro, meta: { kind: 'ItemOffer', component },
      }));
      emit(r);
      break;
    }
    case 'refund-offer': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const built = refundExpiredItemOfferManifest({ offer: component });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `refund-offer-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `refund expired ItemOffer ${component} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro, meta: { kind: 'ItemOffer', component },
      }));
      emit(r);
      break;
    }
    case 'accept-offer': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const nftResource = req(flags, 'nft-resource');
      const nftId = req(flags, 'nft-id');
      const acct = MARKETPLACE_ACCOUNTS[label.toUpperCase()];
      const before = await ex.findNft(label, nftResource, nftId);
      const built = acceptItemOfferManifest({ sellerAccount: acct.component, offer: component, nftResource, nftId });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `accept-offer-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `accept ItemOffer ${component} with ${nftResource}/${nftId} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro,
        meta: { kind: 'ItemOffer', component, nftResource, nftId, sellerAccount: bound.component, sellerHeldNftBefore: before.held },
      }));
      emit({ ...r, sellerHeldNftBefore: before.held });
      break;
    }
    case 'create-bid': {
      const label = req(flags, 'as');
      const collection = req(flags, 'collection');
      const price = opt(flags, 'price', '100');
      const qty = opt(flags, 'qty', '1');
      const expiry = Number(opt(flags, 'expiry', '0'));
      const acct = MARKETPLACE_ACCOUNTS[label.toUpperCase()];
      const built = createCollectionBidManifest({ buyerAccount: acct.component, quoteResource: quote, pricePerNftMicro: price, quantity: qty, collectionResource: collection, expiryEpoch: expiry });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `create-bid-${collection.slice(9, 17)}-${dryRun ? 'dry' : 'live'}`,
        intent: `create CollectionBid on ${collection} at ${price} x${qty} ${quote} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro,
        meta: { kind: 'CollectionBid', collection, quoteResource: quote, pricePerNft: price, quantity: qty, expiryEpoch: expiry, buyerAccount: bound.component },
      }));
      emit(r);
      break;
    }
    case 'fill-bid': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const nftResource = req(flags, 'nft-resource');
      const nftId = req(flags, 'nft-id');
      const acct = MARKETPLACE_ACCOUNTS[label.toUpperCase()];
      const before = await ex.findNft(label, nftResource, nftId);
      const built = fillCollectionBidManifest({ sellerAccount: acct.component, bid: component, nftResource, nftId });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `fill-bid-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `fill CollectionBid ${component} with ${nftResource}/${nftId} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro,
        meta: { kind: 'CollectionBid', component, nftResource, nftId, sellerAccount: bound.component, sellerHeldNftBefore: before.held },
      }));
      emit({ ...r, sellerHeldNftBefore: before.held });
      break;
    }
    case 'cancel-bid': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const built = cancelCollectionBidManifest({ bid: component });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `cancel-bid-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `cancel CollectionBid ${component} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro, meta: { kind: 'CollectionBid', component },
      }));
      emit(r);
      break;
    }
    case 'refund-bid': {
      const label = req(flags, 'as');
      const component = req(flags, 'component');
      const built = refundExpiredCollectionBidManifest({ bid: component });
      const r = await withAccount(label, (bound) => ex.submit({
        opId: `refund-bid-${component.slice(10, 18)}-${dryRun ? 'dry' : 'live'}`,
        intent: `refund expired CollectionBid ${component} as ${bound.label}`,
        ...built, asAccount: bound.label, dryRun, maxFeeMicro, meta: { kind: 'CollectionBid', component },
      }));
      emit(r);
      break;
    }
    case 'templates': {
      emit({ publishedTemplates: MARKETPLACE_TEMPLATES, feeBudgetTotalMicro: FEE_BUDGET_TOTAL_MICRO, maxFeePerTxMicro: MAX_FEE_PER_MARKETPLACE_TX_MICRO, walletd: version });
      break;
    }
    default:
      console.error('unknown command. See the header of nft-market.mjs for usage.');
      process.exit(2);
  }
  emitBudget();
}

function emitBudget() {
  // The run's cumulative fee attribution is printed by the driver, not re-derived here.
}

function render(command, obj, ctx) {
  if (obj.refused) return `REFUSED ${obj.refused}`;
  if (obj.inventory) {
    const lines = [];
    for (const [label, inv] of Object.entries(obj.inventory)) {
      lines.push(`${label} ${inv.account.name} ${inv.account.component}`);
      for (const row of inv.resources) {
        lines.push(`  ${row.nftResource} symbol=${row.symbol} ids=[${row.tokenIds.join(', ')}] reported=${row.reportedBalance} consistent=${row.consistent}`);
      }
    }
    return lines.join('\n');
  }
  if (obj.security) {
    const s = obj.security;
    return `component ${s.componentAddress}\n  template      ${s.templateName} (${s.templateAddress})\n  owner_rule   ${JSON.stringify(s.ownerRule)}\n  default      ${s.defaultRule}\n  method_access ${JSON.stringify(s.methodAccess)}`;
  }
  if (obj.decoded) return `${command} ${JSON.stringify(obj.decoded)}`;
  if (obj.dryRun) return `DRY RUN ${command}: required_fees=${obj.requiredFees} signer=${obj.signer?.label}`;
  if (obj.transactionId) {
    const o = obj.outcome ?? {};
    return `${command}: ${o.status} tx=${obj.transactionId} fee=${o.actualFee} epoch=${o.epoch} signer=${obj.signer?.label}\n  components=${(o.components ?? []).join(',') || '-'}\n  resources=${(o.resources ?? []).join(',') || '-'}\n  feesPaidTotal=${obj.feesPaidMicroTotal}`;
  }
  return JSON.stringify(obj);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});