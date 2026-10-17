/**
 * Durable marketplace component registry.
 *
 * WHY THIS EXISTS — the same problem `poolRegistry.ts` solves, for the same reason.
 *
 * The public Ootle indexer has NO "list components by template" route. The only way
 * to learn which components exist is to read transaction receipts and look at what
 * they created, and that window is finite: on a busy testnet a marketplace component
 * created a while ago scrolls out of the bounded receipt scan even though it is
 * perfectly live. So a component address that has been confirmed once is fed back
 * in, and re-read from the chain every time.
 *
 * WHY A SEPARATE FILE, AND WHY IT IS NOT MERGED WITH THE POOL REGISTRY.
 *
 * The marketplace registry is keyed by a SET of templates (three settlement
 * lifecycles), not one, and its entries must be reverified against the template that
 * matches the component's own recorded kind. A pool entry reverified against a
 * marketplace template, or the reverse, must be dropped rather than coerced. Keeping
 * the seeds, the storage key, and the validation in their own module makes that
 * separation structural instead of a convention someone can forget.
 *
 * THE TRUST MODEL — IDENTICAL TO THE POOL REGISTRY, AND THE SAME LIMIT.
 *
 * This registry NEVER makes a listing, offer, or bid appear on its own. It only
 * contributes candidate component ADDRESSES. Every candidate is then read from the
 * chain and re-confirmed against the component's OWN `header.template_address` by
 * `TariIndexerDiscovery.componentsOfTemplates`, so:
 *   - a seed or cache entry that no longer exists, is on another network, or whose
 *     template is not one of the three marketplace templates is DROPPED at reverify;
 *   - `localStorage` is UNTRUSTED input. A corrupted or hostile cache can at worst
 *     name component ids that fail reverification and are discarded. It can never
 *     inject a displayed item, a price, or a template identity;
 *   - the cache is per-network, so an entry written against one network is never
 *     loaded for another.
 *
 * Note what the registry does NOT do: it does not decide that a component is
 * *active*. Status, expiry, and settlement state come from the decoded component
 * body on every read, never from this file.
 */

import { isComponentAddress, type RegistryStorage } from './poolRegistry.js';

/**
 * The three published marketplace templates, verified present on Esmeralda.
 *
 * `GET /templates/{bare-hex}` answers 200 for all three. Note the BARE hex form:
 * that is the route the indexer serves. The `template_`-prefixed form returns 400,
 * and the catalogue listing is NOT consulted here — see `templateAvailability`.
 */
export const MARKETPLACE_TEMPLATES = {
  FixedPriceListing: '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329',
  ItemOffer: '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6',
  CollectionBid: '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54',
} as const;

export type MarketplaceTemplateName = keyof typeof MARKETPLACE_TEMPLATES;

export const MARKETPLACE_TEMPLATE_ADDRESSES: readonly string[] = Object.values(MARKETPLACE_TEMPLATES);

/** A protocol-verified marketplace component. Still reverified against chain before trust. */
export interface KnownMarketplaceEntry {
  readonly component: string;
  readonly templateName: MarketplaceTemplateName;
  readonly note?: string;
}

/**
 * Seed of protocol-verified marketplace components, keyed by frontend network id.
 *
 * ESMERALDA IS INTENTIONALLY EMPTY, and that is a fact about the chain rather than
 * an oversight. A component only appears here once it has been instantiated FROM
 * one of the three published templates AND its address recorded. As of the
 * 2026-10-16 audit, all three templates are published and readable on Esmeralda,
 * but a bounded receipt scan (4 000 receipts, 2 142 distinct components, back to
 * epoch 12 212) surfaced NO component carrying any of the three template addresses.
 *
 * The three settlement lifecycles that `docs/OOTLE_V046_MIGRATION.md` records were
 * exercised against a LOCAL wallet daemon; they are real committed transactions, but
 * the resulting components are not discoverable from the public indexer today. So
 * the seed stays empty rather than carrying an address that nothing can reverify.
 *
 * ADDING AN ENTRY: paste the `component_<64 hex>` the transaction receipt recorded
 * and the template it was instantiated from. It is reverified on every read, so a
 * wrong or stale entry degrades to "ignored", never to a wrong listing.
 */
export const MARKETPLACE_REGISTRY_SEED: Readonly<Record<string, readonly KnownMarketplaceEntry[]>> = {
  esmeralda: [],
};

/** Storage key prefix. Deliberately distinct from the pool registry's. */
const STORAGE_PREFIX = 'ootle.marketplaceRegistry.';

/** Cap the cache so a hostile writer cannot make discovery read an unbounded batch. */
const MAX_CACHED = 100;

function storageKey(network: string): string {
  return `${STORAGE_PREFIX}${network}`;
}

/** The seed component addresses for a network (validated). */
export function seedComponents(network: string): string[] {
  return (MARKETPLACE_REGISTRY_SEED[network] ?? []).map((e) => e.component).filter(isComponentAddress);
}

/**
 * The protocol-VERIFIED template for a seeded marketplace component, or `undefined`.
 *
 * Used to PIN the decode (`decodeListing` and friends refuse a component whose own
 * header names a different template). That is strictly stronger than trusting the
 * discovery result's own claim, so a component that is not a seed still has to pass
 * the decoder's intrinsic identity checks with no pin at all.
 */
export function seededTemplateFor(network: string, component: string): MarketplaceTemplateName | undefined {
  if (!isComponentAddress(component)) return undefined;
  return (MARKETPLACE_REGISTRY_SEED[network] ?? []).find((e) => e.component === component)?.templateName;
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
  return [...new Set(parsed.filter(isComponentAddress))].slice(0, MAX_CACHED);
}

/** seed ∪ cache, deduped and bounded. Never a source of truth on its own. */
export function knownComponents(network: string, storage: RegistryStorage | undefined): string[] {
  return [...new Set([...seedComponents(network), ...loadCachedComponents(network, storage)])].slice(0, MAX_CACHED);
}

/**
 * Persist newly reverified marketplace components so they survive the receipt window.
 * Only valid component ids are stored; seeds are compiled in and never written.
 */
export function rememberDiscovered(network: string, components: readonly string[], storage: RegistryStorage | undefined): void {
  if (storage === undefined) return;
  const seeds = new Set(seedComponents(network));
  const incoming = components.filter(isComponentAddress).filter((c) => !seeds.has(c));
  if (incoming.length === 0 && loadCachedComponents(network, storage).length === 0) return;
  const merged = [...new Set([...loadCachedComponents(network, storage), ...incoming])];
  try {
    storage.setItem(storageKey(network), JSON.stringify(merged.slice(-MAX_CACHED)));
  } catch {
    // Best-effort cache. A storage failure never breaks discovery.
  }
}
