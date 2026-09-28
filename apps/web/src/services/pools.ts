/**
 * Pool discovery.
 *
 * Pools are DISCOVERY data. A discovered pool is a candidate for viewing, never
 * an authority: the pool's reserves, fee, and LP supply always come from the
 * authoritative readback that the protocol-client's resolvers perform.
 *
 * With no configured discovery endpoint the registry is empty and the UI shows
 * an explicit unavailable state. It never synthesises a pool.
 */

import type { PoolPair, AssetSafetyClass, ResourceRoutingClass } from '@tari-ootle/protocol-client';
import { safetyFromPairClass, weakestClassification, toAssetChip, type AssetChip } from '../lib/assetIdentity.js';
import { DEFAULT_NETWORK, type FrontendNetworkId } from '../lib/networks.js';
import { discoveryList, postJson } from './net.js';
import { describeIdentity, isVerified, verifyIndexerIdentity } from './indexerIdentity.js';
import type { AppConfig } from './config.js';

export interface PoolDescriptor {
  poolComponent: string;
  pair: PoolPair;
  base: PoolAssetInfo;
  quote: PoolAssetInfo;
  feeBps?: string;
  /** The weakest classification across both assets; drives the pool's warning. */
  weakestSafety: ResourceRoutingClass;
}

export interface PoolAssetInfo {
  resourceAddress: string;
  symbol?: string;
  decimals: string;
  safetyClass: ResourceRoutingClass;
}

export interface PoolDiscoveryResult {
  pools: PoolDescriptor[];
  /** Present when discovery could not run or failed. Rendered verbatim. */
  unavailableReason?: string;
  source: string;
}

const SAFETY_VALUES: ReadonlySet<string> = new Set(['CANONICAL_TARI', 'PUBLIC_IMMUTABLE_OR_VETTED', 'ISSUER_CONTROLLED', 'UNKNOWN']);

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readRaw(value: unknown): string | undefined {
  const text = readString(value);
  return text !== undefined && /^\d+$/.test(text) ? text : undefined;
}

/** Strictly validates one discovery record. A malformed record is dropped, not coerced. */
export function parsePoolDescriptor(raw: unknown): PoolDescriptor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const poolComponent = readString(record.poolComponent ?? record.componentAddress);
  const resourceA = readString(record.resourceA);
  const resourceB = readString(record.resourceB);
  if (poolComponent === undefined || resourceA === undefined || resourceB === undefined) return undefined;

  const baseDecimals = readRaw(record.baseDecimals) ?? '0';
  const quoteDecimals = readRaw(record.quoteDecimals) ?? '0';
  const safetyClass: AssetSafetyClass = SAFETY_VALUES.has(String(record.safetyClass)) ? (record.safetyClass as AssetSafetyClass) : 'UNKNOWN';

  const baseSafety: ResourceRoutingClass =
    SAFETY_VALUES.has(String(record.baseSafetyClass)) ? (record.baseSafetyClass as ResourceRoutingClass) : safetyFromPairClass(safetyClass);
  const quoteSafety: ResourceRoutingClass =
    SAFETY_VALUES.has(String(record.quoteSafetyClass)) ? (record.quoteSafetyClass as ResourceRoutingClass) : safetyFromPairClass(safetyClass);

  const base: PoolAssetInfo = {
    resourceAddress: readString(record.baseResource) ?? resourceA,
    symbol: readString(record.baseSymbol),
    decimals: readRaw(record.baseDecimals) ?? baseDecimals,
    safetyClass: baseSafety,
  };
  const quote: PoolAssetInfo = {
    resourceAddress: readString(record.quoteResource) ?? resourceB,
    symbol: readString(record.quoteSymbol),
    decimals: readRaw(record.quoteDecimals) ?? quoteDecimals,
    safetyClass: quoteSafety,
  };

  const pair: PoolPair = {
    poolComponent,
    resourceA,
    resourceB,
    baseResource: base.resourceAddress,
    quoteResource: quote.resourceAddress,
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
    safetyClass,
  };
  const labelA = readString(record.baseSymbol);
  const labelB = readString(record.quoteSymbol);
  if (labelA !== undefined) pair.labelA = labelA;
  if (labelB !== undefined) pair.labelB = labelB;

  return {
    poolComponent,
    pair,
    base,
    quote,
    feeBps: readRaw(record.feeBps),
    weakestSafety: weakestClassification(baseSafety, quoteSafety),
  };
}

export function assetChipsOf(pool: PoolDescriptor): { base: AssetChip; quote: AssetChip } {
  return { base: toAssetChip(pool.base), quote: toAssetChip(pool.quote) };
}

export interface PoolDiscoverySource {
  readonly name: string;
  discover(): Promise<PoolDiscoveryResult>;
}

/**
 * Indexer-backed discovery. The expected payload is a JSON array (or
 * `{ data: [...] }`) of pool records. Anything else is reported as unavailable
 * rather than half-parsed.
 *
 * The endpoint's network identity is verified FIRST, on every call, and a
 * refusal to establish that identity stops discovery before the discovery query
 * is even sent. That ordering is the point: an endpoint that cannot say which
 * chain it is, or that says a different one, must not get to answer "here are
 * your pools". This is discovery-only evidence — it never authorises execution
 * and never substitutes for the authoritative reread the resolvers perform.
 */
export class IndexerPoolDiscovery implements PoolDiscoverySource {
  readonly name: string;
  /** Set when the configured URL is unusable. Discovery then fails closed. */
  private readonly invalid: string | undefined;

  constructor(
    private readonly indexerUrl: string,
    /** The network this build permits. Identity verification compares against it. */
    private readonly expected: { readonly network: FrontendNetworkId; readonly networkName: string } = {
      network: DEFAULT_NETWORK,
      networkName: DEFAULT_NETWORK,
    },
    /** Injected in tests; defaults to a real bounded fetch. */
    private readonly verify: typeof verifyIndexerIdentity = verifyIndexerIdentity,
  ) {
    let host: string | undefined;
    try {
      host = new URL(indexerUrl).host;
    } catch {
      // A malformed VITE_INDEXER_URL must not throw during render: that would
      // take the whole application down with a blank page instead of showing a
      // configuration error the operator can act on.
      host = undefined;
    }
    this.invalid = host === undefined ? `The configured pool discovery endpoint is not a valid URL: ${indexerUrl}` : undefined;
    this.name = host === undefined ? 'indexer:invalid' : `indexer:${host}`;
  }

  async discover(): Promise<PoolDiscoveryResult> {
    if (this.invalid !== undefined) {
      return { pools: [], source: this.name, unavailableReason: this.invalid };
    }
    // Identity before content. A refusal here is reported as itself and never
    // collapsed into "no pools".
    const identity = await this.verify(this.indexerUrl, this.expected);
    if (!isVerified(identity)) {
      return { pools: [], source: this.name, unavailableReason: `Pool discovery is unavailable. ${describeIdentity(identity)}` };
    }
    // Bounded transport: a hung or oversized endpoint produces an unavailable
    // result within a fixed deadline instead of a permanently loading list.
    const result = await postJson(this.indexerUrl, { query: 'pool_discovery' });
    if (!result.ok) {
      return { pools: [], source: this.name, unavailableReason: `Pool discovery is unavailable. ${result.reason}` };
    }
    const list = discoveryList(result.payload);
    if (!list.ok) {
      return { pools: [], source: this.name, unavailableReason: list.reason };
    }
    const pools = list.list.map(parsePoolDescriptor).filter((pool): pool is PoolDescriptor => pool !== undefined);
    return { pools, source: this.name };
  }
}

/** No discovery endpoint configured. The registry is legitimately empty. */
export class UnavailablePoolDiscovery implements PoolDiscoverySource {
  readonly name = 'unconfigured';

  async discover(): Promise<PoolDiscoveryResult> {
    return {
      pools: [],
      source: this.name,
      unavailableReason: 'No pool discovery endpoint is configured for this build. Deployments must provide one; no pool list is invented.',
    };
  }
}

export function createPoolDiscovery(config: AppConfig, fixtures: PoolDescriptor[] | undefined): PoolDiscoverySource {
  if (fixtures !== undefined) {
    return {
      name: 'development-fixture',
      async discover() {
        return { pools: fixtures, source: 'development-fixture' };
      },
    };
  }
  const url = config.indexerUrls[0];
  // The provider-reported network name is the id itself for both allowlisted
  // testnets, which is exactly what `GET /info` `network` returns on Esmeralda.
  return url === undefined
    ? new UnavailablePoolDiscovery()
    : new IndexerPoolDiscovery(url, { network: config.network, networkName: config.network });
}
