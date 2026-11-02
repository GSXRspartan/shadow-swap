/**
 * Versioned deployment manifests: where this build believes a network's contracts and assets
 * live, and the conditions under which it will act on that belief.
 *
 * WHAT A MANIFEST IS FOR
 *
 * An Ootle testnet reset invalidates templates, components, accounts, resource addresses, LP
 * positions and history in one step. Everything observed before a reset identifies nothing
 * afterwards. A manifest is therefore keyed by NETWORK and GENERATION together, and consulted
 * only when a live read reports that same pair — so a pre-reset address can never be used on a
 * post-reset chain, and a testnet address can never be used on mainnet.
 *
 * WHAT A MANIFEST IS NOT
 *
 * **It is not transaction authorization.** This is the rule the module is built around, because
 * the attractive shortcut here is dangerous: fetch a manifest from a URL, trust its addresses,
 * build transactions against them. An editable URL, a stale cache or a downloaded file is
 * attacker-influenced, so a manifest is only ever a CANDIDATE. `validateManifest` makes it
 * usable solely when the live chain identity it names matches what was actually observed, and
 * even then an individual address is trusted only for the feature it is recorded under.
 *
 * MONOTONIC VERSIONS. An older manifest may never replace a newer validated one. Downgrade is
 * the cheapest attack on a registry like this: re-serve yesterday's manifest, and a template
 * that has since been found wrong becomes trusted again. `adoptManifest` refuses it.
 *
 * ONE MISSING ENTRY DISABLES ONE FEATURE. A manifest with no `offerTemplates` disables P2P offers
 * and nothing else. Features are independent so that a partial deployment is usable for what it
 * actually covers, rather than all-or-nothing in either direction.
 */

import { type TariNetwork, networkFromName } from './chainIdentity.js';

export class ManifestError extends Error {}

/**
 * Which incarnation of a network a manifest belongs to. A reset produces a new generation, and
 * addresses never cross one.
 */
export type NetworkGenerationId = string;

/** The features a manifest can enable. Each is independently gated by its own entry. */
export type DeploymentFeature =
  | 'AMM_POOLS'
  | 'REVEALED_POOLS'
  | 'NFT_MARKETPLACE'
  | 'P2P_OFFERS'
  | 'CROSS_LAYER_HTLC';

export const DEPLOYMENT_FEATURES: readonly DeploymentFeature[] = [
  'AMM_POOLS',
  'REVEALED_POOLS',
  'NFT_MARKETPLACE',
  'P2P_OFFERS',
  'CROSS_LAYER_HTLC',
];

/** A resource this build is willing to name, with the classification it was verified under. */
export interface ResourceEntry {
  /** `resource_<64 hex>`. */
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /**
   * How the resource's value is represented. This is NOT cosmetic: a Stealth-typed resource is
   * not "confidential support", and a revealed-value venue is the only one that may hold it.
   */
  readonly kind: 'public_fungible' | 'stealth' | 'confidential' | 'non_fungible';
  /** Why this build trusts the entry. Empty is not allowed. */
  readonly provenance: string;
}

export interface DeploymentManifest {
  /** Monotonic within one (network, generation). A lower version never replaces a higher one. */
  readonly version: number;
  readonly network: TariNetwork;
  readonly generation: NetworkGenerationId;
  /**
   * The network byte this manifest expects the chain to report. Recorded so a manifest cannot be
   * re-pointed at another network by editing its name alone.
   */
  readonly expectNetworkByte: number;
  /** Bare 64-hex template addresses per feature. An absent or empty list disables that feature. */
  readonly templates: Readonly<Partial<Record<DeploymentFeature, readonly string[]>>>;
  /** Resources this build will name in a UI. Anything else is "unknown", never assumed. */
  readonly resources: readonly ResourceEntry[];
  /** Published component addresses (pools and the like), per feature. */
  readonly components: Readonly<Partial<Record<DeploymentFeature, readonly string[]>>>;
  /** Free text for the UI and the docs. */
  readonly status: string;
}

/** Live facts a manifest is checked against. Every field comes from an authoritative read. */
export interface ObservedChain {
  readonly network: TariNetwork;
  readonly networkByte: number;
  readonly generation: NetworkGenerationId;
  /** The software version the endpoint reported, for the record. */
  readonly version: string;
}

/**
 * The explicit error taxonomy. Each case names one thing that is wrong, because "configuration
 * error" tells an operator nothing about which configuration or how to fix it.
 */
export type ManifestRejection =
  | 'UNSUPPORTED_NETWORK'
  | 'MISMATCHED_CHAIN_IDENTITY'
  | 'UNSUPPORTED_NETWORK_GENERATION'
  | 'STALE_MANIFEST_VERSION'
  | 'MALFORMED_MANIFEST';

export type ManifestVerdict =
  | { readonly ok: true; readonly manifest: DeploymentManifest; readonly enabled: readonly DeploymentFeature[]; readonly disabled: readonly string[] }
  | { readonly ok: false; readonly rejection: ManifestRejection; readonly reason: string };

const HEX64 = /^[0-9a-f]{64}$/i;
const RESOURCE = /^resource_[0-9a-f]{64}$/i;
const COMPONENT = /^component_[0-9a-f]{64}$/i;

function bareTemplate(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new ManifestError(`${where} must be a string`);
  const bare = value.replace(/^template_/, '');
  if (!HEX64.test(bare)) throw new ManifestError(`${where} must be a 64-hex template address; got "${String(value).slice(0, 24)}"`);
  return bare.toLowerCase();
}

/**
 * Structural validation of a candidate manifest, with no chain involved.
 *
 * Separate from `validateManifest` on purpose: a malformed manifest is a different problem from a
 * well-formed manifest for the wrong chain, and conflating them would hide which one happened.
 */
export function parseManifest(value: unknown): DeploymentManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestError('A manifest must be a JSON object');
  }
  const raw = value as Record<string, unknown>;
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ManifestError('version must be a positive integer');
  }
  const network = networkFromName(raw['network']);
  if (network === undefined) throw new ManifestError(`network "${String(raw['network']).slice(0, 32)}" is not a Tari network`);
  const generation = raw['generation'];
  if (typeof generation !== 'string' || generation.length === 0 || generation.length > 128) {
    throw new ManifestError('generation must be a non-empty string of at most 128 characters');
  }
  const expectNetworkByte = raw['expectNetworkByte'];
  if (typeof expectNetworkByte !== 'number' || !Number.isInteger(expectNetworkByte) || expectNetworkByte < 0 || expectNetworkByte > 255) {
    throw new ManifestError('expectNetworkByte must be an integer 0..255');
  }
  const status = raw['status'];
  if (typeof status !== 'string' || status.length === 0 || status.length > 512) {
    throw new ManifestError('status must be a non-empty string of at most 512 characters');
  }

  const readFeatureMap = (field: string, check: (value: unknown, where: string) => string): Readonly<Partial<Record<DeploymentFeature, readonly string[]>>> => {
    const source = raw[field];
    if (source === undefined) return {};
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new ManifestError(`${field} must be an object keyed by feature`);
    }
    const out: Partial<Record<DeploymentFeature, readonly string[]>> = {};
    for (const [key, list] of Object.entries(source)) {
      if (!(DEPLOYMENT_FEATURES as readonly string[]).includes(key)) {
        throw new ManifestError(`${field} names unknown feature "${key.slice(0, 32)}"`);
      }
      if (!Array.isArray(list) || list.length > 64) {
        throw new ManifestError(`${field}.${key} must be an array of at most 64 entries`);
      }
      out[key as DeploymentFeature] = list.map((entry, index) => check(entry, `${field}.${key}[${index}]`));
    }
    return out;
  };

  const componentAddress = (entry: unknown, where: string): string => {
    if (typeof entry !== 'string' || !COMPONENT.test(entry)) {
      throw new ManifestError(`${where} must be component_<64 hex>`);
    }
    return entry.toLowerCase();
  };

  const resourcesRaw = raw['resources'];
  if (resourcesRaw !== undefined && (!Array.isArray(resourcesRaw) || resourcesRaw.length > 256)) {
    throw new ManifestError('resources must be an array of at most 256 entries');
  }
  const resources: ResourceEntry[] = (Array.isArray(resourcesRaw) ? resourcesRaw : []).map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new ManifestError(`resources[${index}] must be an object`);
    const r = entry as Record<string, unknown>;
    if (typeof r['address'] !== 'string' || !RESOURCE.test(r['address'])) {
      throw new ManifestError(`resources[${index}].address must be resource_<64 hex>`);
    }
    if (typeof r['symbol'] !== 'string' || r['symbol'].length === 0 || r['symbol'].length > 32) {
      throw new ManifestError(`resources[${index}].symbol must be a non-empty string of at most 32 characters`);
    }
    const decimals = r['decimals'];
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      throw new ManifestError(`resources[${index}].decimals must be an integer 0..18`);
    }
    const kind = r['kind'];
    if (kind !== 'public_fungible' && kind !== 'stealth' && kind !== 'confidential' && kind !== 'non_fungible') {
      throw new ManifestError(`resources[${index}].kind is not a known resource kind`);
    }
    const provenance = r['provenance'];
    if (typeof provenance !== 'string' || provenance.length === 0 || provenance.length > 512) {
      throw new ManifestError(`resources[${index}].provenance must say why this entry is trusted`);
    }
    return { address: r['address'].toLowerCase(), symbol: r['symbol'], decimals, kind, provenance };
  });

  return {
    version,
    network,
    generation,
    expectNetworkByte,
    templates: readFeatureMap('templates', bareTemplate),
    components: readFeatureMap('components', componentAddress),
    resources,
    status,
  };
}

/**
 * Validates a manifest against what the chain ACTUALLY reported, and says which features that
 * leaves enabled.
 *
 * The order of checks is the order of severity: a manifest for the wrong network is a different
 * and worse problem than one for the right network's previous generation.
 */
export function validateManifest(candidate: unknown, observed: ObservedChain): ManifestVerdict {
  let manifest: DeploymentManifest;
  try {
    manifest = parseManifest(candidate);
  } catch (error) {
    return { ok: false, rejection: 'MALFORMED_MANIFEST', reason: (error as Error).message };
  }

  if (manifest.network !== observed.network) {
    return {
      ok: false,
      rejection: 'MISMATCHED_CHAIN_IDENTITY',
      reason: `This manifest is for ${manifest.network} and the chain reports ${observed.network}. Addresses do not cross networks, and this build will not use one network's deployment on another.`,
    };
  }
  if (manifest.expectNetworkByte !== observed.networkByte) {
    return {
      ok: false,
      rejection: 'MISMATCHED_CHAIN_IDENTITY',
      reason: `This manifest expects network byte 0x${manifest.expectNetworkByte.toString(16).padStart(2, '0')} and the chain reports 0x${observed.networkByte.toString(16).padStart(2, '0')}. An endpoint that answers for a different chain is refused, not read.`,
    };
  }
  if (manifest.generation !== observed.generation) {
    return {
      ok: false,
      rejection: 'UNSUPPORTED_NETWORK_GENERATION',
      reason: `This manifest records generation "${manifest.generation}" and the chain is running "${observed.generation}". A reset invalidates every address, so none of these entries identifies anything on the live chain.`,
    };
  }

  const enabled: DeploymentFeature[] = [];
  const disabled: string[] = [];
  for (const feature of DEPLOYMENT_FEATURES) {
    const templates = manifest.templates[feature];
    if (templates !== undefined && templates.length > 0) enabled.push(feature);
    else disabled.push(`${feature}: no template is recorded for ${manifest.network} generation ${manifest.generation}, so this feature is unavailable. Nothing else is affected.`);
  }
  return { ok: true, manifest, enabled, disabled };
}

/**
 * Adopts a validated manifest over whatever is currently held, refusing a downgrade.
 *
 * `current` is the manifest already validated for this (network, generation) — the thing an
 * attacker would want to replace with an older one.
 */
export function adoptManifest(
  current: DeploymentManifest | undefined,
  candidate: unknown,
  observed: ObservedChain,
): ManifestVerdict {
  const verdict = validateManifest(candidate, observed);
  if (!verdict.ok) return verdict;
  if (current !== undefined && current.network === verdict.manifest.network && current.generation === verdict.manifest.generation) {
    if (verdict.manifest.version < current.version) {
      return {
        ok: false,
        rejection: 'STALE_MANIFEST_VERSION',
        reason: `This manifest is version ${verdict.manifest.version} and version ${current.version} is already in use for ${current.network} generation ${current.generation}. An older manifest is refused: re-serving a previous version is how a template that has since been withdrawn would become trusted again.`,
      };
    }
  }
  return verdict;
}

/** Whether a specific template address is trusted for a feature on a validated manifest. */
export function isTrustedTemplate(manifest: DeploymentManifest, feature: DeploymentFeature, address: string): boolean {
  const list = manifest.templates[feature];
  if (list === undefined || list.length === 0) return false;
  const bare = address.replace(/^template_/, '').toLowerCase();
  return list.includes(bare);
}

/** Whether a component is one this manifest records for a feature. */
export function isTrustedComponent(manifest: DeploymentManifest, feature: DeploymentFeature, address: string): boolean {
  const list = manifest.components[feature];
  if (list === undefined || list.length === 0) return false;
  return list.includes(address.toLowerCase());
}

/**
 * Whether a resource is one this manifest names.
 *
 * Returns the entry rather than a boolean so a caller shows the symbol and classification the
 * manifest recorded, never one read from token metadata — which is attacker-supplied and is
 * exactly how a substituted symbol would get in front of a user.
 */
export function trustedResource(manifest: DeploymentManifest, address: string): ResourceEntry | undefined {
  const wanted = address.toLowerCase();
  return manifest.resources.find((entry) => entry.address === wanted);
}

export type FeatureAvailability =
  | { readonly available: true; readonly templates: readonly string[] }
  | { readonly available: false; readonly reason: string };

/** Whether a feature can be used, with the reason when it cannot. */
export function featureAvailability(manifest: DeploymentManifest | undefined, feature: DeploymentFeature): FeatureAvailability {
  if (manifest === undefined) {
    return { available: false, reason: 'No deployment manifest has been validated against the live chain in this session, so no template is trusted yet.' };
  }
  const templates = manifest.templates[feature];
  if (templates === undefined || templates.length === 0) {
    return {
      available: false,
      reason: `No ${feature} template is recorded for ${manifest.network} generation ${manifest.generation}. This feature is unavailable here; the rest of the application is unaffected.`,
    };
  }
  return { available: true, templates };
}
