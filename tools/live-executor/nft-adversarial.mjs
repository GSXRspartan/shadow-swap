#!/usr/bin/env node
// Zero-cost adversarial dry-runs against the LIVE marketplace components this run created.
//
// Nothing here submits. Every case is a dry run whose purpose is to record the exact
// rejection the protocol produced, for the components created by nft-scenario.mjs.
import { NftMarketExecutor, MARKETPLACE_TEMPLATES, CANONICAL_TARI_RESOURCE } from './nft-market-core.mjs';

const TTARI = CANONICAL_TARI_RESOURCE;
const FEE = 400_000;

const CASES = [
  {
    name: 'listing/sold-buy-again',
    kind: 'FixedPriceListing',
    component: 'component_c17805be3d99e884544fb5dee33fd428ca3534a523d0b44bd56a41df33442da6',
    as: 'B',
    manifest: (c) => `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw(arg!["quote_resource"], amount!(100));
  let l = arg!["component"];
  l.buy(payment, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, quote_resource: TTARI }),
  },
  {
    name: 'listing/cancelled-buy',
    kind: 'FixedPriceListing',
    component: 'component_ecae9742ce3f299888a62e1e9404a3e13977dc8d801f972ebb73c27ec0a0bea5',
    as: 'B',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw(arg!["quote_resource"], amount!(100));
  let l = arg!["component"];
  l.buy(payment, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, quote_resource: TTARI }),
  },
  {
    name: 'listing/cancelled-cancel-again',
    kind: 'FixedPriceListing',
    component: 'component_ecae9742ce3f299888a62e1e9404a3e13977dc8d801f972ebb73c27ec0a0bea5',
    as: 'A',
    manifest: () => `fn main() { let l = arg!["component"]; l.cancel(); }`,
    vars: (a, c) => ({ account: a, component: c.component }),
  },
  {
    name: 'listing/wrong-payment-resource',
    kind: 'FixedPriceListing',
    component: 'component_c17805be3d99e884544fb5dee33fd428ca3534a523d0b44bd56a41df33442da6',
    as: 'B',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw(arg!["wrong_resource"], amount!(100));
  let l = arg!["component"];
  l.buy(payment, account);
}`,
    // A public fungible that is NOT the listing's quote resource.
    vars: (a, c) => ({ account: a, component: c.component, wrong_resource: 'resource_87385b51c57f8682ec2de4a0e590b17a56c7465c904552e80cabaeb467e70dfc' }),
  },
  {
    name: 'listing/nft-as-payment',
    kind: 'FixedPriceListing',
    component: 'component_c17805be3d99e884544fb5dee33fd428ca3534a523d0b44bd56a41df33442da6',
    as: 'B',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let payment = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-restart-swap-a-7f3c9"));
  let l = arg!["component"];
  l.buy(payment, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, nft_resource: 'resource_cfcf91651371107812a10d529079b368e997f4f53b73a40b3fa16c58ecd82dd7' }),
  },
  {
    name: 'listing/create-with-zero-price',
    kind: 'FixedPriceListing',
    component: null,
    as: 'A',
    manifest: () => `use template_${MARKETPLACE_TEMPLATES.FixedPriceListing} as FixedPriceListing;
fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-soak-swap-b-6af4d"));
  FixedPriceListing::create(account, nft, arg!["quote_resource"], amount!(0), 0u64);
}`,
    vars: (a) => ({ account: a, nft_resource: 'resource_ef30dd8954ed712c9a48ed27a8e979f9322295c5b3ab34aecb46681fb73ef3d0', quote_resource: TTARI }),
  },
  {
    name: 'listing/create-with-nft-quote',
    kind: 'FixedPriceListing',
    component: null,
    as: 'A',
    manifest: () => `use template_${MARKETPLACE_TEMPLATES.FixedPriceListing} as FixedPriceListing;
fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-soak-swap-b-6af4d"));
  FixedPriceListing::create(account, nft, arg!["quote_resource"], amount!(100), 0u64);
}`,
    vars: (a) => ({ account: a, nft_resource: 'resource_ef30dd8954ed712c9a48ed27a8e979f9322295c5b3ab34aecb46681fb73ef3d0', quote_resource: 'resource_cfcf91651371107812a10d529079b368e997f4f53b73a40b3fa16c58ecd82dd7' }),
  },
  {
    name: 'listing/create-with-past-expiry',
    kind: 'FixedPriceListing',
    component: null,
    as: 'A',
    manifest: () => `use template_${MARKETPLACE_TEMPLATES.FixedPriceListing} as FixedPriceListing;
fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-soak-swap-b-6af4d"));
  FixedPriceListing::create(account, nft, arg!["quote_resource"], amount!(100), 1u64);
}`,
    vars: (a) => ({ account: a, nft_resource: 'resource_ef30dd8954ed712c9a48ed27a8e979f9322295c5b3ab34aecb46681fb73ef3d0', quote_resource: TTARI }),
  },
  {
    name: 'listing/create-with-nft-holder-missing',
    kind: 'FixedPriceListing',
    component: null,
    as: 'B',
    manifest: () => `use template_${MARKETPLACE_TEMPLATES.FixedPriceListing} as FixedPriceListing;
fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-soak-swap-b-6af4d"));
  FixedPriceListing::create(account, nft, arg!["quote_resource"], amount!(100), 0u64);
}`,
    // B does NOT hold this NFT: the withdrawal must fail before the template is reached.
    vars: (a) => ({ account: a, nft_resource: 'resource_ef30dd8954ed712c9a48ed27a8e979f9322295c5b3ab34aecb46681fb73ef3d0', quote_resource: TTARI }),
  },
  {
    name: 'offer/accepted-accept-again',
    kind: 'ItemOffer',
    component: 'component_72f6d74a47415d44ed994d09dcfc3e4aef8bc8db7fde1aaf9a33b6182861b807',
    as: 'B',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-restart-swap-b-f2a02"));
  let o = arg!["component"];
  o.accept(nft, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, nft_resource: 'resource_478638b1585da5a19004af5c5ae1752eb4fa6d7669cb226f5d2de113bfc3fb1b' }),
  },
  {
    name: 'offer/accepted-cancel-after',
    kind: 'ItemOffer',
    component: 'component_72f6d74a47415d44ed994d09dcfc3e4aef8bc8db7fde1aaf9a33b6182861b807',
    as: 'A',
    manifest: () => `fn main() { let o = arg!["component"]; o.cancel(); }`,
    vars: (a, c) => ({ account: a, component: c.component }),
  },
  {
    name: 'offer/accepted-refund-expired',
    kind: 'ItemOffer',
    component: 'component_72f6d74a47415d44ed994d09dcfc3e4aef8bc8db7fde1aaf9a33b6182861b807',
    as: 'B',
    manifest: () => `fn main() { let o = arg!["component"]; o.refund_expired(); }`,
    vars: (a, c) => ({ account: a, component: c.component }),
  },
  {
    name: 'offer/cancelled-accept-after',
    kind: 'ItemOffer',
    component: 'component_1f99a8ef77885e14c5f7a541b94345c828dfa7468ab1f1a00fdf01e4c9b69c0e',
    as: 'A',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-restart-swap-b-f2a02"));
  let o = arg!["component"];
  o.accept(nft, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, nft_resource: 'resource_478638b1585da5a19004af5c5ae1752eb4fa6d7669cb226f5d2de113bfc3fb1b' }),
  },
  {
    name: 'bid/filled-fill-again',
    kind: 'CollectionBid',
    component: 'component_3ae55b9fbb867bc768205d9a32bb5226fc1b5c25c65d0e97b2028378ef0daaa4',
    as: 'B',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-soak-swap-a-cba74"));
  let b = arg!["component"];
  b.fill(nft, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, nft_resource: 'resource_e6d192037660ad95ae6bc50e3380f435dcf161453fa5754807c33b52a5623bd8' }),
  },
  {
    name: 'bid/filled-cancel-after',
    kind: 'CollectionBid',
    component: 'component_3ae55b9fbb867bc768205d9a32bb5226fc1b5c25c65d0e97b2028378ef0daaa4',
    as: 'A',
    manifest: () => `fn main() { let b = arg!["component"]; b.cancel(); }`,
    vars: (a, c) => ({ account: a, component: c.component }),
  },
  {
    name: 'bid/filled-refund-expired',
    kind: 'CollectionBid',
    component: 'component_3ae55b9fbb867bc768205d9a32bb5226fc1b5c25c65d0e97b2028378ef0daaa4',
    as: 'B',
    manifest: () => `fn main() { let b = arg!["component"]; b.refund_expired(); }`,
    vars: (a, c) => ({ account: a, component: c.component }),
  },
  {
    name: 'bid/cancelled-fill-after',
    kind: 'CollectionBid',
    component: 'component_d4571d92653d0e532e7a1e30a46461159bf0657b025125e09ceb4bb4250023f5',
    as: 'A',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-soak-swap-b-6af4d"));
  let b = arg!["component"];
  b.fill(nft, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, nft_resource: 'resource_ef30dd8954ed712c9a48ed27a8e979f9322295c5b3ab34aecb46681fb73ef3d0' }),
  },
  {
    name: 'bid/wrong-collection-fill-of-cancelled',
    kind: 'CollectionBid',
    component: 'component_d4571d92653d0e532e7a1e30a46461159bf0657b025125e09ceb4bb4250023f5',
    as: 'B',
    manifest: () => `fn main() {
  let account = arg!["account"];
  let nft = account.withdraw_non_fungible(arg!["nft_resource"], non_fungible_id!("v042-restart-swap-a-7f3c9"));
  let b = arg!["component"];
  b.fill(nft, account);
}`,
    vars: (a, c) => ({ account: a, component: c.component, nft_resource: 'resource_cfcf91651371107812a10d529079b368e997f4f53b73a40b3fa16c58ecd82dd7' }),
  },
];


async function main() {
  const ex = new NftMarketExecutor({ maxFeePerTxMicro: FEE });
  await ex.authenticate();
  const identity = await ex.verifyNetwork();
  console.log(`walletd ${await ex.walletVersion()} · ${identity.network}/${identity.networkByte} · epoch ${identity.epoch}`);
  console.log('ZERO-COST ADVERSARIAL DRY-RUNS — nothing below submits\n');

  const results = [];
  for (const c of CASES) {
    const bound = await ex.setDefaultAccount(c.as);
    let outcome;
    try {
      const dry = await ex.rpc('transactions.submit_manifest', {
        manifest: c.manifest(),
        variables: c.vars(bound.component, c),
        max_fee: FEE,
        dry_run: true,
        signing_key_ids: [],
      });
      outcome = { outcome: 'ACCEPTED', requiredFees: dry?.required_fees ?? null };
    } catch (e) {
      outcome = { outcome: 'REJECTED', reason: String(e.message).replace(/^walletd /, '') };
    } finally {
      await ex.setDefaultAccount('A');
    }
    results.push({ case: c.name, signer: c.as, ...outcome });
    console.log(`[${outcome.outcome}] ${c.name}  (signer ${c.as})`);
    if (outcome.reason) console.log(`    ${outcome.reason.split('\n').join('\n    ')}`);
  }

  console.log(`\naccepted=${results.filter((r) => r.outcome === 'ACCEPTED').length} rejected=${results.filter((r) => r.outcome === 'REJECTED').length}`);
  console.log(`\nADVERSARIAL_JSON=${JSON.stringify(results)}`);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });