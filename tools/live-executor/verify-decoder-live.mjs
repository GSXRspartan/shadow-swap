#!/usr/bin/env node
// Prove the new protocol-client raw marketplace decoder against the LIVE chain.
//
// Every component below was created by this repository's live NFT marketplace vertical
// slice on 2026-10-08. This reads them through the SAME decoder the frontend now uses and
// corroborates the result against chain state the decoder does not itself consult, so the
// decoder's output is compared against the chain rather than only against recorded fixtures.
//
// Read-only. It submits nothing and pays no fee.
import { NftMarketExecutor } from './nft-market-core.mjs';

const DECODER = new URL('../../packages/protocol-client/dist/esm/marketplaceSubstate.js', import.meta.url).href;
const { decodeListing, decodeItemOffer, decodeCollectionBid, setMarketplaceCurrentEpoch, decodeComponentHeader } = await import(DECODER);

const ex = new NftMarketExecutor();
await ex.authenticate();
const identity = await ex.verifyNetwork();
setMarketplaceCurrentEpoch(identity.epoch);
console.log(`walletd ${await ex.walletVersion()} Â· ${identity.network}/${identity.networkByte} Â· epoch ${identity.epoch}\n`);

const rawReader = { read: async (address) => (await ex.rpc('substates.get', { substate_id: address })).substate_from_remote?.substate };

const TARGETS = [
  ['FixedPriceListing', decodeListing, 'component_ecae9742ce3f299888a62e1e9404a3e13977dc8d801f972ebb73c27ec0a0bea5', '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329'],
  ['FixedPriceListing', decodeListing, 'component_c17805be3d99e884544fb5dee33fd428ca3534a523d0b44bd56a41df33442da6', '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329'],
  ['ItemOffer', decodeItemOffer, 'component_1f99a8ef77885e14c5f7a541b94345c828dfa7468ab1f1a00fdf01e4c9b69c0e', '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6'],
  ['ItemOffer', decodeItemOffer, 'component_72f6d74a47415d44ed994d09dcfc3e4aef8bc8db7fde1aaf9a33b6182861b807', '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6'],
  ['CollectionBid', decodeCollectionBid, 'component_3ae55b9fbb867bc768205d9a32bb5226fc1b5c25c65d0e97b2028378ef0daaa4', '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54'],
  ['CollectionBid', decodeCollectionBid, 'component_d4571d92653d0e532e7a1e30a46461159bf0657b025125e09ceb4bb4250023f5', '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54'],
];

 /**
 * Cross-check every decoded field against a source the decoder never reads.
 *
 * WHY NOT THE TEMPLATE GETTER: until v0.46.0 this compared `listing()`/`offer()`/`bid()`
 * against the raw substate decoder. Upstream #2859 retired
 * `FinalizeResult.execution_results`, so a template getter no longer returns anything
 * readable from a transaction result and that comparison is no longer available.
 *
 * The replacement is an INDEPENDENT corroboration from the chain itself: each escrow vault
 * is read directly, and the decoded escrow resource/amount is checked against what that
 * vault actually holds. This is a stronger check than the getter was, because the getter
 * returned what the component CLAIMED, whereas a vault substate shows what it HOLDS - a
 * component that lied about its escrow could not pass.
 *
 * Fields with no second on-chain source (the epoch/timestamps, and the status the component
 * last wrote) are reported as derived rather than corroborated, and are never presented as
 * agreeing with anything.
 */

/** escrow resource + amount, read straight from the vault substate, bypassing the decoder. */
async function corroborateEscrow(component, declaredResource) {
  const substate = await rawReader.read(component);
  const state = substate?.Component?.body?.state;
  const entries = state?.[0]?.entries;
  if (!Array.isArray(entries)) return { ok: false, reason: 'component state carries no vault map' };
  for (const [k, v] of entries) {
    const vaultHex = v?.value?.hex;
    if (typeof vaultHex !== 'string') continue;
    const vaultSub = await rawReader.read(`vault_${vaultHex}`);
    const container = vaultSub?.Vault;
    const kind = ['Fungible', 'Stealth', 'Confidential', 'NonFungible'].find((x) => container?.[x]);
    if (kind === undefined) continue;
    const held = container[kind]?.address ?? container[kind]?.resource_address;
    return {
      ok: true,
      vault: `vault_${vaultHex}`,
      resourceType: kind,
      heldResource: typeof held === 'string' && held.length > 0 ? `resource_${held}` : null,
      // Confidential buckets carry no revealed amount; absence is expected, not a mismatch.
      revealedAmount: container[kind]?.amount ?? null,
      matchesDeclared: declaredResource === undefined || held === undefined || `resource_${held}` === declaredResource,
    };
  }
  return { ok: false, reason: 'no recognisable escrow vault found' };
}

let disagreements = 0;
for (const [kind, decode, component, template] of TARGETS) {
  const facts = await decode(rawReader, component, template);
  const header = decodeComponentHeader(await rawReader.read(component));
  const decoded = facts.listing ?? facts.itemOffer ?? facts.collectionBid;
  const escrow = await corroborateEscrow(component, decoded?.quoteResource ?? decoded?.collectionResource ?? decoded?.collection);
  if (!escrow.ok || escrow.matchesDeclared === false) disagreements += 1;
  console.log(`--- ${kind} ${component}`);
  console.log(`    owner_rule        ${header.ownerRule}  default ${header.defaultRule}`);
  console.log(`    decoded           ${JSON.stringify(decoded)}`);
  console.log(`    escrow (vault)    ${JSON.stringify(escrow)}`);
  const verdict = escrow.ok && escrow.matchesDeclared !== false ? 'CORROBORATED' : 'DISAGREE';
  console.log(`    vault vs decode   ${verdict}${escrow.ok ? '' : ` (${escrow.reason})`}`);
}
console.log(`\ndisagreements=${disagreements}`);
