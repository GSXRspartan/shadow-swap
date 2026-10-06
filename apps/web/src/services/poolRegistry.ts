/**
 * Durable pool registry.
 *
 * WHY THIS EXISTS.
 *
 * Pool discovery scans recent transaction receipts to find component-creation
 * events. On a busy testnet a pool that was created a while ago scrolls out of the
 * bounded receipt window and silently stops being discovered, even though it is
 * perfectly live. This registry makes a pool that is KNOWN (seeded by the protocol,
 * or discovered once before) remain discoverable without rescanning an arbitrarily
 * deep receipt history: its component address is fed back into the authoritative
 * batch substate read.
 *
 * THE TRUST MODEL — READ THIS.
 *
 * The registry NEVER makes a pool appear on its own. It only contributes candidate
 * component ADDRESSES; every candidate is then re-read from the chain and its
 * template is re-confirmed from the component's own header (in
 * `ootleIndexer.componentsOfTemplates`). So:
 *   - a seed/cache entry that no longer exists, is on the wrong network, or whose
 *     template is not one of the protocol's Pool templates is DROPPED at reverify;
 *   - `localStorage` is treated as UNTRUSTED input — a corrupted or hostile cache
 *     can at worst name component ids that fail reverification and are discarded. It
 *     can never inject a displayed pool, a reserve, or a template identity.
 * The cache is per-network, so a cache written against one network is never loaded
 * for another, and discovery only runs after the network-identity preflight passes.
 */

/** A protocol-owned, verified-on-chain pool. Still reverified against chain before trust. */
export interface KnownPoolEntry {
  readonly component: string;
  readonly templateAddress: string;
  readonly note?: string;
}

/**
 * Seed of protocol-owned pools, keyed by frontend network id. These are real,
 * on-chain, verified components (not fixtures) and are reverified before display.
 * Pool v2 (`OwnerRule::None`) is CURRENT; Pool v1 is superseded and intentionally
 * NOT seeded as a place to send new liquidity, though a v1 component that is still
 * discovered on chain is shown like any other (its template id identifies it).
 */
export const POOL_REGISTRY_SEED: Readonly<Record<string, readonly KnownPoolEntry[]>> = {
  esmeralda: [
    {
      component: 'component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2',
      templateAddress: 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab',
      note: 'Pool v2 (OwnerRule::None) native-tTARI / LPTESTA test market',
    },
  ],
};

const STORAGE_PREFIX = 'ootle.poolRegistry.';
/** Cap the cache so a hostile writer cannot make discovery read an unbounded batch. */
const MAX_CACHED = 100;

const COMPONENT_RE = /^component_[0-9a-f]{64}$/;
export function isComponentAddress(value: unknown): value is string {
  return typeof value === 'string' && COMPONENT_RE.test(value);
}

/** Minimal storage shape (a `Storage`-like object). Everything is wrapped in try/catch. */
export interface RegistryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storageKey(network: string): string {
  return `${STORAGE_PREFIX}${network}`;
}

/** The seed component addresses for a network (validated). */
export function seedComponents(network: string): string[] {
  return (POOL_REGISTRY_SEED[network] ?? []).map((e) => e.component).filter(isComponentAddress);
}

/** The cached (previously-discovered) component addresses for a network. UNTRUSTED. */
export function loadCachedComponents(network: string, storage: RegistryStorage | undefined): string[] {
  if (storage === undefined) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(network));
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Deduped, validated, bounded — a corrupted array yields only the valid subset.
  return [...new Set(parsed.filter(isComponentAddress))].slice(0, MAX_CACHED);
}

/**
 * All component addresses to feed into the authoritative reverify: seed ∪ cache,
 * deduped and bounded. Never a source of truth on its own.
 */
export function knownComponents(network: string, storage: RegistryStorage | undefined): string[] {
  return [...new Set([...seedComponents(network), ...loadCachedComponents(network, storage)])].slice(0, MAX_CACHED);
}

/**
 * Persist newly reverified pool components so they remain discoverable after they
 * age out of the receipt window. Only valid component ids are stored; the seed is
 * never written (it is compiled in), and the set is deduped and bounded.
 */
export function rememberDiscovered(network: string, components: readonly string[], storage: RegistryStorage | undefined): void {
  if (storage === undefined) return;
  const seeds = new Set(seedComponents(network));
  const incoming = components.filter(isComponentAddress).filter((c) => !seeds.has(c));
  if (incoming.length === 0 && loadCachedComponents(network, storage).length === 0) return;
  const merged = [...new Set([...loadCachedComponents(network, storage), ...incoming])];
  // Keep the most-recent MAX_CACHED (append order ~ recency).
  const bounded = merged.slice(-MAX_CACHED);
  try {
    storage.setItem(storageKey(network), JSON.stringify(bounded));
  } catch {
    // Best-effort cache. A storage failure never breaks discovery.
  }
}
