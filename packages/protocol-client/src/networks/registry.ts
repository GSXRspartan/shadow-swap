/**
 * The verified network registry: what is known about each chain on each network, and what is
 * deliberately absent.
 *
 * THE FINDING THAT SHAPES THIS WHOLE FILE
 *
 * **Ootle L2 mainnet does not exist yet.** This is not an inference. Upstream's own SDK says so
 * in code — `crates/wallet/ootle-rs/src/helpers.rs` at cohort `6a25dbc`:
 *
 *     Network::MainNet => unimplemented!("MainNet indexer URL is not set"),
 *
 * and upstream's exchange-integration guide says it in prose: *"Ootle mainnet has not launched
 * yet"*, listing MainNet (prefix `otl_`) as "Not launched yet" and noting that public indexer
 * URLs and fee tables are placeholders that will change before launch. A launch date of
 * 2026-11-11 has been announced publicly; as of this commit it is in the future.
 *
 * So the honest representation of Ootle mainnet is a network whose IDENTITY is fully known (its
 * byte is 0x00, its address prefix is `otl_`) and whose ENDPOINTS do not exist. This registry
 * says exactly that, and `l2Endpoints` returns an empty list rather than a guess. No URL is
 * invented here, and when one is published it becomes a reviewed one-line addition — not a code
 * change.
 *
 * Minotari **L1** mainnet, by contrast, is live. That asymmetry is the central fact about
 * Shadow Swap's mainnet readiness: the L1 side of a cross-layer trade has a real network to
 * settle on, and the L2 side does not yet.
 *
 * WHAT THIS REGISTRY IS NOT
 *
 * It is not an authorization to execute. A profile existing means "this build knows what this
 * network is", never "trading is on". That decision lives in `readiness.ts`, which requires
 * evidence this file cannot provide.
 */

import { NETWORK_BYTES, OOTLE_ADDRESS_HRP, type TariNetwork, isTestnet } from './chainIdentity.js';

export class NetworkRegistryError extends Error {}

export type Layer = 'L1_MINOTARI' | 'L2_OOTLE';

/** How a chain decides a transaction is final. The two layers do this differently. */
export type FinalityModel =
  /** Proof of work: a transaction is settled after N confirmations, and a reorg can undo it. */
  | { readonly kind: 'CONFIRMATIONS'; readonly required: number }
  /**
   * BFT consensus: upstream's guide is explicit — "Once a transaction has been committed it is
   * final." There is no confirmation count to wait for, and waiting longer proves nothing.
   */
  | { readonly kind: 'BFT_COMMITTED' };

export interface FeeProfile {
  /** Smallest unit per whole token. TARI and XTM are both divisible by 1e6. */
  readonly unitsPerToken: number;
  /** The unit's name, for display. */
  readonly smallestUnit: string;
  /**
   * An upper bound on one transaction's fee, in the smallest unit, where the chain or its wallet
   * defines one. `undefined` means this build has not verified a bound for this network and must
   * not invent one.
   */
  readonly maxFeeLimit?: string;
  /** What the fee is paid in. */
  readonly feeAsset: string;
  readonly note: string;
}

export interface LayerProfile {
  readonly layer: Layer;
  readonly network: TariNetwork;
  readonly networkByte: number;
  readonly displayName: string;
  readonly isTestnet: boolean;
  /**
   * Public read endpoints. EMPTY means no endpoint is published for this network and nothing may
   * be read from it — which is the state of Ootle mainnet, and of L1 on every network, because
   * a Minotari wallet is reachable only over local gRPC.
   */
  readonly endpoints: readonly string[];
  /** Why the endpoint list is empty, when it is. Shown verbatim in a refusal. */
  readonly endpointReason?: string;
  readonly finality: FinalityModel;
  readonly fees: FeeProfile;
  /** The native asset's ticker on this layer. XTM and TARI are DIFFERENT assets. */
  readonly nativeAsset: string;
  /** Bech32m prefix (L2) or a note that L1 uses base58 (L1). */
  readonly addressForm: string;
  /** A block explorer, where this build has verified one exists. Absent is not "none exists". */
  readonly explorerUrl?: string;
  /** True only when this build has verified the network is reachable and running. */
  readonly launched: boolean;
  readonly launchNote: string;
}

/**
 * Ootle TARI's divisibility, from `template_lib_types::constants`: "It is a fungible resource
 * with a divisibility of 6, meaning that the smallest unit is 0.000001 TARI."
 */
const TARI_UNITS_PER_TOKEN = 1_000_000;
/** Minotari XTM is likewise 1e6 µXTM per XTM. */
const XTM_UNITS_PER_TOKEN = 1_000_000;

/**
 * Esmeralda's L2 indexers, from the v0.48.0 config presets and
 * `default_indexer_url(Network::Esmeralda)`. Read from pinned upstream source; this build does
 * not assume they answer, and verifies network, byte and version on every load.
 */
export const ESMERALDA_L2_ENDPOINTS: readonly string[] = [
  'https://esme-indexer-a.ootle.tari.com',
  'https://esme-indexer-b.ootle.tari.com',
];

/**
 * Esmeralda's PRE-v0.48-RESET indexers. Not a default: kept so an operator can point a build at
 * the pre-reset network while it is still served, in which case the reported version selects the
 * pre-reset generation and its templates.
 */
export const LEGACY_ESMERALDA_L2_ENDPOINTS: readonly string[] = [
  'https://ootle-indexer-a.tari.com',
  'https://ootle-indexer-b.tari.com',
];

const L2_FEES: FeeProfile = {
  unitsPerToken: TARI_UNITS_PER_TOKEN,
  smallestUnit: 'µT',
  // `max_fee_limit`, from upstream's exchange-integration guide: "Upper bound on the fee of any
  // single transaction, in µT. Default 100 TARI."
  maxFeeLimit: '100000000',
  feeAsset: 'TARI',
  note: 'Fees are paid in TARI and the amount is public. For a stealth transfer, max_fee is the fee PAID rather than a ceiling, and the surplus is not refunded — so a dry run first, then submit with that run\'s final_fee.',
};

const L1_FEES: FeeProfile = {
  unitsPerToken: XTM_UNITS_PER_TOKEN,
  smallestUnit: 'µXTM',
  feeAsset: 'XTM',
  note: 'Fees are set per gram of transaction weight; the wallet builds the transaction and the fee is not a fixed figure this build can state in advance.',
};

/** `num_confirmations_required: 3` in the Minotari wallet's transaction-service defaults. */
const L1_FINALITY: FinalityModel = { kind: 'CONFIRMATIONS', required: 3 };
const L2_FINALITY: FinalityModel = { kind: 'BFT_COMMITTED' };

function l2Profile(
  network: TariNetwork,
  displayName: string,
  endpoints: readonly string[],
  launched: boolean,
  launchNote: string,
  endpointReason?: string,
): LayerProfile {
  return {
    layer: 'L2_OOTLE',
    network,
    networkByte: NETWORK_BYTES[network],
    displayName,
    isTestnet: isTestnet(network),
    endpoints,
    ...(endpointReason === undefined ? {} : { endpointReason }),
    finality: L2_FINALITY,
    fees: L2_FEES,
    nativeAsset: 'TARI',
    addressForm: `bech32m, prefix ${OOTLE_ADDRESS_HRP[network]}`,
    launched,
    launchNote,
  };
}

function l1Profile(network: TariNetwork, displayName: string, launched: boolean, launchNote: string): LayerProfile {
  return {
    layer: 'L1_MINOTARI',
    network,
    networkByte: NETWORK_BYTES[network],
    displayName,
    isTestnet: isTestnet(network),
    // A Minotari wallet's gRPC is local-only, by design. There is no public read endpoint for a
    // browser to use, on any network, which is why every L1 operation needs a local companion.
    endpoints: [],
    endpointReason:
      'A Minotari wallet is reachable only over local gRPC, so no public endpoint exists for any network. Every L1 read and every L1 signature needs a wallet running beside the user.',
    finality: L1_FINALITY,
    fees: L1_FEES,
    nativeAsset: 'XTM',
    addressForm: 'base58, three-part, with a network byte, a features byte and a DammSum checksum',
    launched,
    launchNote,
  };
}

/**
 * Every profile this build knows. A network absent from a layer's table is one this build has no
 * verified facts about, and `profileFor` refuses it rather than defaulting.
 */
export const LAYER_PROFILES: Readonly<Record<Layer, Readonly<Partial<Record<TariNetwork, LayerProfile>>>>> = {
  L1_MINOTARI: {
    mainnet: l1Profile('mainnet', 'Minotari Mainnet', true, 'Live. This is where real XTM exists, and the only network on which a mainnet XTM address can receive.'),
    esmeralda: l1Profile('esmeralda', 'Minotari Esmeralda Testnet', true, 'Live testnet. Disposable assets only.'),
    igor: l1Profile('igor', 'Minotari Igor Testnet', true, 'Live testnet. Disposable assets only.'),
    stagenet: l1Profile('stagenet', 'Minotari Stagenet', true, 'Live. Treated as a test network by this build.'),
    nextnet: l1Profile('nextnet', 'Minotari Nextnet', true, 'Live. Treated as a test network by this build.'),
    localnet: l1Profile('localnet', 'Minotari Localnet', true, 'A network the developer runs. Nothing about it is assumed.'),
  },
  L2_OOTLE: {
    mainnet: l2Profile(
      'mainnet',
      'Ootle Mainnet',
      [],
      false,
      'NOT LAUNCHED. Upstream\'s SDK has no mainnet indexer URL — `default_indexer_url(Network::MainNet)` is `unimplemented!("MainNet indexer URL is not set")` at cohort 6a25dbc — and upstream\'s exchange-integration guide states "Ootle mainnet has not launched yet". A launch date of 2026-11-11 has been announced publicly. This build therefore knows mainnet\'s identity and has no endpoint for it.',
      'No public Ootle mainnet indexer has been published. This build will not guess one: a wrong endpoint for a mainnet with real value is worse than no endpoint.',
    ),
    esmeralda: l2Profile('esmeralda', 'Ootle Esmeralda Testnet', ESMERALDA_L2_ENDPOINTS, true, 'Live testnet, and the only Ootle network this build has ever read. Reset at v0.48.0.'),
    localnet: l2Profile('localnet', 'Ootle Localnet', ['http://127.0.0.1:9113'], true, 'A network the developer runs with tari_swarm_daemon. Only a development build may reach it.'),
  },
};

export type ProfileLookup =
  | { readonly ok: true; readonly profile: LayerProfile }
  | { readonly ok: false; readonly reason: string };

/**
 * The profile for one layer of one network, or a refusal naming what is known.
 *
 * FAILS CLOSED, and this is the whole contract of this module: an unknown or unconfigured
 * network does not fall back to a default, to the previous selection, or to a testnet. A caller
 * that cannot get a profile must stop.
 */
export function profileFor(layer: Layer, network: TariNetwork): ProfileLookup {
  const table = LAYER_PROFILES[layer];
  const profile = table[network];
  if (profile === undefined) {
    const known = Object.keys(table).join(', ');
    return {
      ok: false,
      reason: `This build has no verified facts about ${network} on ${layer === 'L1_MINOTARI' ? 'Minotari (L1)' : 'Ootle (L2)'}. Known: ${known}. Nothing is assumed for an unlisted network.`,
    };
  }
  return { ok: true, profile };
}

/** Read endpoints for a layer/network, or an empty list with the reason it is empty. */
export function endpointsFor(layer: Layer, network: TariNetwork): { readonly endpoints: readonly string[]; readonly reason?: string } {
  const lookup = profileFor(layer, network);
  if (!lookup.ok) return { endpoints: [], reason: lookup.reason };
  const { endpoints, endpointReason } = lookup.profile;
  return endpointReason === undefined ? { endpoints } : { endpoints, reason: endpointReason };
}

/**
 * The chain PAIR a cross-layer trade runs across.
 *
 * Deliberately explicit rather than derived from a single network name: the two layers are
 * separate networks, and nothing guarantees that an operator running Ootle Esmeralda is also
 * pointed at Minotari Esmeralda. A pair must be stated and checked, never inferred.
 */
export interface ChainPair {
  readonly l1: TariNetwork;
  readonly l2: TariNetwork;
  readonly label: string;
  /** True only when both layers are launched and this build has facts about both. */
  readonly usable: boolean;
  readonly reason: string;
}

export const SUPPORTED_CHAIN_PAIRS: readonly ChainPair[] = [
  {
    l1: 'esmeralda',
    l2: 'esmeralda',
    label: 'Minotari Esmeralda ⇄ Ootle Esmeralda',
    usable: true,
    reason: 'Both layers are live testnets. This is the pair every cross-layer acceptance step uses.',
  },
  {
    l1: 'localnet',
    l2: 'localnet',
    label: 'Minotari Localnet ⇄ Ootle Localnet',
    usable: true,
    reason: 'Both run locally under the developer\'s control.',
  },
  {
    l1: 'mainnet',
    l2: 'mainnet',
    label: 'Minotari Mainnet ⇄ Ootle Mainnet',
    usable: false,
    reason: 'Minotari L1 mainnet is live, but Ootle L2 mainnet has not launched and has no published indexer. A cross-layer trade needs both legs, so this pair cannot settle.',
  },
];

export function chainPair(l1: TariNetwork, l2: TariNetwork): ChainPair | undefined {
  return SUPPORTED_CHAIN_PAIRS.find((pair) => pair.l1 === l1 && pair.l2 === l2);
}

/**
 * Refuses a cross-layer pairing that is not a recorded, usable pair.
 *
 * A MIXED pair is the dangerous case and gets its own message: Minotari mainnet with Ootle
 * Esmeralda would put real XTM on one side of a trade against testnet TARI on the other.
 */
export function checkChainPair(l1: TariNetwork, l2: TariNetwork): { readonly ok: boolean; readonly reason: string } {
  const pair = chainPair(l1, l2);
  if (pair === undefined) {
    const mixedValue = (l1 === 'mainnet') !== (l2 === 'mainnet');
    return {
      ok: false,
      reason: mixedValue
        ? `Refusing to pair Minotari ${l1} with Ootle ${l2}: one side carries real value and the other does not. A trade across that pair would exchange real assets for test assets.`
        : `Minotari ${l1} with Ootle ${l2} is not a recorded chain pair. The two layers are separate networks and a pairing is never inferred.`,
    };
  }
  return { ok: pair.usable, reason: pair.reason };
}
