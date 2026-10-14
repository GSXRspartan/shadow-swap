#!/usr/bin/env node
// Read the live marketplace components this run created: component body state (for the
// protocol-client decoder work), escrow vault contents, and header identity.
import { NftMarketExecutor } from './nft-market-core.mjs';

const COMPONENTS = [
  ['FixedPriceListing cancelled', 'component_ecae9742ce3f299888a62e1e9404a3e13977dc8d801f972ebb73c27ec0a0bea5'],
  ['FixedPriceListing sold', 'component_c17805be3d99e884544fb5dee33fd428ca3534a523d0b44bd56a41df33442da6'],
  ['ItemOffer cancelled', 'component_1f99a8ef77885e14c5f7a541b94345c828dfa7468ab1f1a00fdf01e4c9b69c0e'],
  ['ItemOffer accepted', 'component_72f6d74a47415d44ed994d09dcfc3e4aef8bc8db7fde1aaf9a33b6182861b807'],
  ['CollectionBid filled', 'component_3ae55b9fbb867bc768205d9a32bb5226fc1b5c25c65d0e97b2028378ef0daaa4'],
  ['CollectionBid cancelled', 'component_d4571d92653d0e532e7a1e30a46461159bf0657b025125e09ceb4bb4250023f5'],
];

const ex = new NftMarketExecutor();
await ex.authenticate();
await ex.verifyNetwork();

for (const [label, c] of COMPONENTS) {
  console.log(`\n================ ${label} ${c}`);
  const s = await ex.rpc('substates.get', { substate_id: c });
  const comp = s?.substate_from_remote?.substate?.Component;
  console.log('header.template_address =', JSON.stringify(comp?.header?.template_address));
  console.log('header.owner_rule       =', JSON.stringify(comp?.header?.owner_rule));
  const state = comp?.body?.state;
  console.log('body.state              =', JSON.stringify(state));
  const vaultRef = state?.[0];
  if (vaultRef && typeof vaultRef === 'object' && vaultRef.value?.hex) {
    const vault = `vault_${vaultRef.value.hex}`;
    const vs = await ex.rpc('substates.get', { substate_id: vault }).catch((e) => ({ err: e.message }));
    console.log(`escrow ${vault} =`, JSON.stringify(vs?.substate_from_remote?.substate ?? vs?.err));
  }
}