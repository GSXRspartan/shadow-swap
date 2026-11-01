/**
 * The Swap page's asset catalog: which resources the picker offers, and under
 * what label.
 *
 * Extraction of the pure decision from the component so it is testable
 * without a DOM. Pool-known assets and wallet-owned assets merge on the
 * EXACT resource address; a ticker is display metadata an issuer chooses and
 * any issuer can copy, so the address — never the symbol — decides identity.
 * A wallet-owned asset without any pool still appears: holding an asset is
 * exactly when the user needs to see it and why it cannot trade yet.
 */
import { CANONICAL_TARI as NATIVE_TARI } from './routeResolver.js';

export interface CatalogBalance {
  resourceAddress: string;
  amount: string;
  resourceType: string;
  divisibility?: number;
  symbol?: string;
}

export interface CatalogPoolSide {
  resourceAddress: string;
  symbol?: string;
  decimals: string | number;
}

export interface CatalogAsset {
  resource: string;
  name: string;
  /** The wallet's actual holding, display-formatted; only when the wallet holds the resource. */
  heldDisplay?: string;
  kind: string;
  decimals: number;
}

/** Canonical Ootle resource address shape. Everything else is refused. */
export function isResourceAddress(address: string): boolean {
  return /^resource_[0-9a-f]{64}$/.test(address);
}

/** Display form of an exact raw integer at a divisibility. */
export function formatHolding(amount: string, divisibility: number): string {
  if (!/^\d+$/.test(amount)) return amount;
  const scale = 10n ** BigInt(Math.max(0, divisibility));
  const whole = BigInt(amount) / scale;
  if (scale === 1n || divisibility === 0) return whole.toString();
  const frac = (BigInt(amount) % scale).toString().padStart(divisibility, '0').replace(/0+$/, '');
  return `${whole.toString()}${frac.length > 0 ? `.${frac}` : ''}`;
}

function short(address: string): string {
  return `${address.slice(0, 13)}…${address.slice(-6)}`;
}

export function swapAssetCatalog(input: {
  pools: readonly { base: CatalogPoolSide; quote: CatalogPoolSide }[];
  balances: readonly CatalogBalance[];
}): CatalogAsset[] {
  const byResource = new Map<string, CatalogAsset>();
  for (const pool of input.pools) {
    for (const side of [pool.base, pool.quote]) {
      if (!isResourceAddress(side.resourceAddress)) continue;
      const name = side.symbol === undefined || side.symbol === '' ? short(side.resourceAddress) : side.symbol;
      byResource.set(side.resourceAddress, {
        resource: side.resourceAddress,
        name,
        kind: side.resourceAddress === NATIVE_TARI ? 'stealth' : 'fungible',
        decimals: Number(side.decimals) || 0,
      });
    }
  }
  for (const b of input.balances) {
    if (!isResourceAddress(b.resourceAddress)) continue;
    const existing = byResource.get(b.resourceAddress);
    const heldDisplay = formatHolding(b.amount, b.divisibility ?? 0);
    if (existing !== undefined) {
      existing.heldDisplay = heldDisplay;
      continue;
    }
    byResource.set(b.resourceAddress, {
      resource: b.resourceAddress,
      name: b.symbol === undefined ? short(b.resourceAddress) : b.symbol,
      heldDisplay,
      kind: b.resourceType,
      decimals: b.divisibility ?? 0,
    });
  }
  return [...byResource.values()];
}

export const CANONICAL_TARI = NATIVE_TARI;
