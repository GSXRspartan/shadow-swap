/**
 * Where Shadow Swap's templates are TRUSTED, per network generation.
 *
 * TWO SECURITY PROPERTIES LIVE HERE.
 *
 * 1. TEMPLATE IDENTITY IS AN ADDRESS, NEVER A NAME.
 *
 *    The indexer's template catalogue is open: anyone can publish a template and call
 *    its struct `Pool`. Pool discovery used to accept every catalogue entry whose name
 *    was exactly `Pool`, and the authoritative reread of a non-seeded candidate was then
 *    pinned to the candidate's OWN template. A third-party template named `Pool` whose
 *    state happened to decode — `[pools map, lp resource, fee, locked vault]` — would have
 *    been listed and tradable as a Shadow Swap pool, and nothing obliges a hostile
 *    template's `swap` to honour `min_output`. A published template address is
 *    `H(author public key, binary hash)` (`PublishedTemplateAddress::from_author_and_binary_hash`
 *    at v0.48.0), so pinning the ADDRESS pins both the code and its publisher.
 *
 * 2. ADDRESSES DO NOT SURVIVE A RESET.
 *
 *    Ootle v0.48.0 restarts Esmeralda from a fresh genesis. Every template, component and
 *    vault observed before it identifies nothing afterwards, so every address below is
 *    recorded against the GENERATION it was observed on and is consulted only when the
 *    verified indexer reports that same generation (`lib/ootleCohort.ts`).
 *
 * THE v0.48 ROWS ARE EMPTY ON PURPOSE. This campaign does not publish templates. Until the
 * operator publishes the v0.48 builds and records the resulting addresses here, discovery
 * on the reset network truthfully reports that the protocol is not deployed there, and
 * marketplace actions refuse to build a call to a template that does not exist.
 */

import type { OotleReadbackProvider } from '@tari-ootle/protocol-client';
import type { FrontendNetworkId } from '../lib/networks.js';
import type { NetworkGeneration } from '../lib/ootleCohort.js';

export type MarketplaceTemplateName = 'FixedPriceListing' | 'ItemOffer' | 'CollectionBid';

export interface ProtocolDeployment {
  readonly network: FrontendNetworkId;
  readonly generation: NetworkGeneration;
  /**
   * Registry/cache key. The pre-reset key is the bare network id, which keeps every
   * existing seed and browser cache entry addressable exactly as before; the reset
   * network gets its own key so a cached pre-reset address is never mixed in.
   */
  readonly registryKey: string;
  /** Bare 64-hex template addresses trusted as Shadow Swap's Pool. */
  readonly poolTemplates: readonly string[];
  /** Bare 64-hex marketplace template addresses, or `undefined` when not published. */
  readonly marketplaceTemplates: Readonly<Record<MarketplaceTemplateName, string>> | undefined;
  /**
   * Bare 64-hex SwapOffer (templates/p2p_offer) addresses trusted for P2P offers. Empty =
   * not published on this generation, and every P2P route is unavailable. An invitation that
   * names any other template is refused by `decodeSwapOffer`.
   */
  readonly offerTemplates: readonly string[];
  /** One line for the UI and the docs. */
  readonly status: string;
}

/** Pre-reset Esmeralda: Pool v2 and the three marketplace templates, live-verified 2026-10-13..16. */
const ESMERALDA_PRE_V048: ProtocolDeployment = {
  network: 'esmeralda',
  generation: 'PRE_V048_RESET',
  registryKey: 'esmeralda',
  poolTemplates: ['f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab'],
  marketplaceTemplates: {
    FixedPriceListing: '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329',
    ItemOffer: '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6',
    CollectionBid: '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54',
  },
  // SwapOffer was never published before the reset, and is not published after it.
  offerTemplates: [],
  status: 'Pool v2 and the three marketplace templates were published and live-verified on this generation (2026-10-13 to 2026-10-16).',
};

/** The v0.48 reset network. Nothing is published yet: see the module comment. */
const ESMERALDA_V048: ProtocolDeployment = {
  network: 'esmeralda',
  generation: 'V048_RESET',
  registryKey: 'esmeralda@v048',
  poolTemplates: [],
  marketplaceTemplates: undefined,
  offerTemplates: [],
  status:
    'Shadow Swap templates have not been published on the v0.48 reset network. The v0.48 builds exist and are tested, but publishing them is an operator decision outside this release candidate.',
};

const LOCALNET: ProtocolDeployment = {
  network: 'localnet',
  generation: 'V048_RESET',
  registryKey: 'localnet',
  poolTemplates: [],
  marketplaceTemplates: undefined,
  offerTemplates: [],
  status: 'Localnet has no recorded deployment. Record a locally published template address here to use it.',
};

export function deploymentFor(network: FrontendNetworkId, generation: NetworkGeneration): ProtocolDeployment {
  if (network === 'localnet') return generation === 'V048_RESET' ? LOCALNET : { ...LOCALNET, generation, registryKey: 'localnet@pre-v048' };
  return generation === 'V048_RESET' ? ESMERALDA_V048 : ESMERALDA_PRE_V048;
}

function bare(address: string): string {
  return address.startsWith('template_') ? address.slice('template_'.length) : address;
}

export function isTrustedPoolTemplate(deployment: ProtocolDeployment, templateAddress: string): boolean {
  return deployment.poolTemplates.includes(bare(templateAddress));
}

export function marketplaceTemplateNameFor(deployment: ProtocolDeployment, templateAddress: string): MarketplaceTemplateName | undefined {
  const templates = deployment.marketplaceTemplates;
  if (templates === undefined) return undefined;
  const key = bare(templateAddress);
  for (const name of Object.keys(templates) as MarketplaceTemplateName[]) {
    if (templates[name] === key) return name;
  }
  return undefined;
}

/* ------------------------------------------------------------------------- *
 * The generation this session has VERIFIED, per network.
 *
 * Set only from a verified indexer identity. Marketplace actions consult it before
 * building a call to a template address, so a pre-reset template is never offered on
 * the reset network. Unset means "not yet established", which actions treat as a
 * refusal, not as a default.
 * ------------------------------------------------------------------------- */

const verifiedGeneration = new Map<FrontendNetworkId, NetworkGeneration>();

/**
 * Record the generation an indexer verified. A session that has already verified one
 * generation and then meets an indexer of another is NOT silently switched: the first
 * answer wins and the caller is told, so two generations are never mixed in one view.
 */
export function recordVerifiedGeneration(network: FrontendNetworkId, generation: NetworkGeneration): { ok: true } | { ok: false; reason: string } {
  const existing = verifiedGeneration.get(network);
  if (existing !== undefined && existing !== generation) {
    return {
      ok: false,
      reason: `This session already reads the ${existing === 'V048_RESET' ? 'v0.48 reset' : 'pre-reset'} ${network} network; an indexer on the other generation was refused so the two are never mixed. Reload to start over.`,
    };
  }
  verifiedGeneration.set(network, generation);
  return { ok: true };
}

export function activeDeployment(network: FrontendNetworkId): ProtocolDeployment | undefined {
  const generation = verifiedGeneration.get(network);
  return generation === undefined ? undefined : deploymentFor(network, generation);
}

/** Test seam. */
export function resetVerifiedGenerations(): void {
  verifiedGeneration.clear();
}

/* ------------------------------------------------------------------------- *
 * Execution-time enforcement.
 *
 * Display is not the only door to a trade: the AMM resolvers in
 * `packages/protocol-client/src/amm.ts` reread the pool with `readPool(component)` and
 * NO template pin, immediately before building the swap / add / remove instructions.
 * This wrapper makes that reread fail closed unless the component's own header names a
 * template recorded for the session's VERIFIED generation, so a deep link or a stale
 * candidate can never route funds into an unrecorded template.
 * ------------------------------------------------------------------------- */


export function withTrustedPoolTemplates(readback: OotleReadbackProvider, network: FrontendNetworkId): OotleReadbackProvider {
  const pinned: OotleReadbackProvider = Object.create(readback) as OotleReadbackProvider;
  pinned.readPool = async (poolComponent, expect) => {
    const deployment = activeDeployment(network);
    if (deployment === undefined) {
      return { status: 'UNAVAILABLE', reason: 'The network generation has not been verified in this session, so no pool template is trusted yet.' };
    }
    if (deployment.poolTemplates.length === 0) {
      return { status: 'UNAVAILABLE', reason: `No Shadow Swap pool template is recorded for this network generation. ${deployment.status}` };
    }
    if (expect?.templateAddress !== undefined && !isTrustedPoolTemplate(deployment, expect.templateAddress)) {
      return { status: 'UNAVAILABLE', reason: `Template ${expect.templateAddress} is not a recorded Shadow Swap pool template on this network generation.` };
    }
    const candidates = expect?.templateAddress !== undefined ? [expect.templateAddress] : deployment.poolTemplates;
    let last: Awaited<ReturnType<OotleReadbackProvider['readPool']>> = { status: 'UNAVAILABLE', reason: 'No trusted template matched.' };
    for (const templateAddress of candidates) {
      last = await readback.readPool(poolComponent, { ...expect, templateAddress });
      if (last.status === 'FOUND') return last;
    }
    return last;
  };
  return pinned;
}
