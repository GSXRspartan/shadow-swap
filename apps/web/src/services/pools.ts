/**
 * Pool discovery.
 *
 * Pools are DISCOVERY data. A discovered pool is a candidate for viewing, never
 * an authority: the pool's reserves, fee, and LP supply always come from the
 * authoritative readback that the protocol-client's resolvers perform.
 *
 * Discovery speaks the REAL `tari_indexer` REST API at Ootle v0.42.0 (see
 * `./ootleIndexer.ts` for the endpoints, read live). It establishes WHICH pools
 * exist. It deliberately cannot say WHAT they hold: the indexer returns a
 * component's state as raw tagged CBOR, so only the wallet's `tari_getSubstate`
 * decodes the pool's fields. Nothing here is permitted to authorise execution.
 *
 * With no configured discovery endpoint the registry is empty and the UI shows
 * an explicit unavailable state. It never synthesises a pool.
 */

import type { PoolPair, AssetSafetyClass, ResourceRoutingClass } from '@tari-ootle/protocol-client';
import { safetyFromPairClass, weakestClassification, toAssetChip, type AssetChip } from '../lib/assetIdentity.js';
import { DEFAULT_NETWORK, type FrontendNetworkId } from '../lib/networks.js';
import { getJson, postJson } from './net.js';
import { describeIdentity, isVerified, verifyIndexerIdentity } from './indexerIdentity.js';
import { TariIndexerDiscovery, CANONICAL_TARI_RESOURCE, type DiscoveredComponent, type IndexerTransport, type ProtocolDeploymentState, type TemplateCatalogueEntry } from './ootleIndexer.js';
import type { AppConfig } from './config.js';

/**
 * The published template names of our four templates.
 *
 * A template's published name is its COMPONENT STRUCT's identifier, not its
 * module's. Cross-checked against v0.42.0: the builtin `account_template` module
 * publishes as `Account` and `template` (liquidity pool) publishes as
 * `TwoResourceLiquidityPool`, i.e. the struct. These four MUST stay equal to
 * the struct names in each `templates/.../src/lib.rs`; `templateNameContract.test.cjs`
 * fails the build if a struct is renamed without updating the readback.
 *
 * They are also what `packages/protocol-client/src/ootle.ts` asserts on an
 * authoritative read, so a mismatch is not cosmetic: it makes every pool read
 * refuse.
 */
export const PROTOCOL_TEMPLATE_NAMES: Readonly<Record<'pool' | 'marketplace' | 'itemOffer' | 'collectionBid', string>> = {
  pool: 'Pool',
  marketplace: 'FixedPriceListing',
  itemOffer: 'ItemOffer',
  collectionBid: 'CollectionBid',
};

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
  /**
   * The deployment state, kept separate from `pools.length` because "no pools"
   * and "no indexer" are different facts with different fixes. A page that
   * renders both as an empty table is lying about a network it could not read.
   */
  state: ProtocolDeploymentState;
  /** Pool components found on chain, WITHOUT decoded pair or reserve fields. */
  candidates: readonly DiscoveredComponent[];
  /** Our templates the network's catalogue reports as published. */
  publishedTemplates: readonly TemplateCatalogueEntry[];
  /** Present when discovery could not run or failed. Rendered verbatim. */
  unavailableReason?: string;
  /**
   * Present when discovery SUCCEEDED and the honest answer is "there is nothing
   * here yet". This is not an outage, so it must not ride on `unavailableReason`.
   */
  detail?: string;
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

/** The minimum a decoded pool needs to be described honestly. */
export interface DecodedPoolFacts {
  readonly poolComponent: string;
  readonly resourceA: string;
  readonly resourceB: string;
  readonly feeBps?: string;
}

/** One balance as the wallet reports it: the only source of symbol/divisibility. */
export interface BalanceFacts {
  readonly resourceAddress: string;
  readonly amount: string;
  readonly divisibility?: number;
  readonly symbol?: string;
}

/**
 * Builds a describable pool from an AUTHORITATIVE read plus wallet balances.
 *
 * Split of responsibilities, and it is a strict one:
 *
 *  - The indexer said WHICH component exists. Nothing more.
 *  - The wallet's `tari_getSubstate` decoded the pool's state, because the
 *    indexer returns component state as raw tagged CBOR and cannot.
 *  - The symbol and divisibility come from the wallet's own balance record for
 *    that resource, because they are resource metadata the pool does not hold.
 *
 * A resource with no balance record is still describable, with the conservative
 * defaults (`0` decimals, no symbol). What it never gets is a guess.
 *
 * SAFETY: the canonical class is bound to the exact address, never to a symbol.
 * A token printing `tTARI` is not canonical TARI and is not treated as one.
 */
export function descriptorFromAuthoritativeRead(facts: DecodedPoolFacts, balances: readonly BalanceFacts[]): PoolDescriptor | undefined {
  if (facts.poolComponent === '' || facts.resourceA === '' || facts.resourceB === '') return undefined;
  const byAddress = new Map<string, BalanceFacts>();
  for (const balance of balances) byAddress.set(balance.resourceAddress, balance);

  const safetyOf = (address: string): ResourceRoutingClass => {
    if (address === CANONICAL_TARI_RESOURCE) return 'CANONICAL_TARI';
    // Present in the wallet's balances: the wallet can already hold it, so it
    // is at minimum the issuer's doing. Still not asserted as canonical.
    return byAddress.has(address) ? 'ISSUER_CONTROLLED' : 'UNKNOWN';
  };

  const sideOf = (address: string) => {
    const balance = byAddress.get(address);
    return {
      resourceAddress: address,
      symbol: balance?.symbol,
      // Raw units are authoritative; the display divisor is metadata only, and
      // an absent divisor renders as 0 rather than being invented.
      decimals: balance?.divisibility !== undefined && Number.isInteger(balance.divisibility) && balance.divisibility >= 0 ? String(balance.divisibility) : '0',
      safetyClass: safetyOf(address),
    } satisfies PoolAssetInfo;
  };

  const base = sideOf(facts.resourceA);
  const quote = sideOf(facts.resourceB);
  const safetyClass: AssetSafetyClass = weakestClassification(base.safetyClass, quote.safetyClass) as AssetSafetyClass;

  const pair: PoolPair = {
    poolComponent: facts.poolComponent,
    resourceA: facts.resourceA,
    resourceB: facts.resourceB,
    baseResource: base.resourceAddress,
    quoteResource: quote.resourceAddress,
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
    safetyClass,
  };
  if (base.symbol !== undefined) pair.labelA = base.symbol;
  if (quote.symbol !== undefined) pair.labelB = quote.symbol;

  const descriptor: PoolDescriptor = {
    poolComponent: facts.poolComponent,
    pair,
    base,
    quote,
    weakestSafety: weakestClassification(base.safetyClass, quote.safetyClass),
  };
  if (facts.feeBps !== undefined) descriptor.feeBps = facts.feeBps;
  return descriptor;
}

export interface PoolDiscoverySource {
  readonly name: string;
  discover(): Promise<PoolDiscoveryResult>;
}

/** The real indexer REST calls, expressed through the bounded transport. */
const REAL_INDEXER_TRANSPORT: IndexerTransport = {
  async getJson(url) {
    return getJson(url);
  },
  async postJson(url, body) {
    return postJson(url, body);
  },
};

/**
 * Indexer-backed discovery against the real `tari_indexer` REST API.
 *
 * The endpoint's network identity is verified FIRST, on every call, and a
 * refusal to establish that identity stops discovery before the discovery query
 * is even sent. That ordering is the point: an endpoint that cannot say which
 * chain it is, or that says a different one, must not get to answer "here are
 * your pools". This is discovery-only evidence — it never authorises execution
 * and never substitutes for the authoritative reread the resolvers perform.
 *
 * NOTE ON `pools` vs `candidates`: this returns pool COMPONENT ADDRESSES, not
 * decoded pools. The indexer exposes a component's state as raw tagged CBOR, so
 * the pair, reserves, fee and LP supply are genuinely not available here. They
 * are read from the wallet at the authoritative reread, where
 * `packages/protocol-client` checks the component really is template `Pool`.
 */
export class IndexerPoolDiscovery implements PoolDiscoverySource {
  readonly name: string;
  /** Set when the configured URL is unusable. Discovery then fails closed. */
  private readonly invalid: string | undefined;
  private readonly client: TariIndexerDiscovery;

  constructor(
    indexerUrl: string,
    /** The network this build permits. Identity verification compares against it. */
    private readonly expected: { readonly network: FrontendNetworkId; readonly networkName: string } = {
      network: DEFAULT_NETWORK,
      networkName: DEFAULT_NETWORK,
    },
    /** Injected in tests; defaults to a real bounded fetch. */
    private readonly verify: typeof verifyIndexerIdentity = verifyIndexerIdentity,
    /** Injected in tests; defaults to the real REST calls. */
    transport: IndexerTransport = REAL_INDEXER_TRANSPORT,
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
    this.client = new TariIndexerDiscovery(indexerUrl, {
      transport,
      verifyIdentity: async (url) => {
        const identity = await this.verify(url, this.expected);
        if (isVerified(identity)) return { ok: true };
        return {
          ok: false,
          reason: describeIdentity(identity),
          // `NETWORK_MISMATCH` is the one verified-identity failure that is NOT
          // an outage: the endpoint answered, and said it is a different chain.
          wrongNetwork: identity.status === 'NETWORK_MISMATCH',
        };
      },
    });
  }

  async discover(): Promise<PoolDiscoveryResult> {
    if (this.invalid !== undefined) {
      return {
        pools: [],
        candidates: [],
        publishedTemplates: [],
        state: 'INDEXER_UNAVAILABLE',
        source: this.name,
        unavailableReason: this.invalid,
      };
    }
    const result = await this.client.discover(PROTOCOL_TEMPLATE_NAMES.pool);
    if (!result.ok) {
      return {
        pools: [],
        candidates: [],
        publishedTemplates: [],
        state: result.state,
        source: this.name,
        unavailableReason: result.detail,
      };
    }
    return {
      // No pool is decoded here. Only the wallet can decode component state, and
      // a pool whose pair and reserves have not been read authoritatively is not
      // yet a pool this app may describe.
      pools: [],
      candidates: result.components,
      publishedTemplates: result.publishedTemplates,
      state: result.state,
      source: this.name,
      // A "nothing to show" answer is still an ANSWER, so it must not be dressed up
      // as an outage. Only the two failure states carry an `unavailableReason`.
      unavailableReason: result.state === 'INDEXER_UNAVAILABLE' || result.state === 'WRONG_NETWORK' ? result.detail : undefined,
      ...(result.state === 'PROTOCOL_NOT_DEPLOYED' || result.state === 'PROTOCOL_DEPLOYED_EMPTY' ? { detail: result.detail } : {}),
    };
  }
}

/** No discovery endpoint configured. The registry is legitimately empty. */
export class UnavailablePoolDiscovery implements PoolDiscoverySource {
  readonly name = 'unconfigured';

  async discover(): Promise<PoolDiscoveryResult> {
    return {
      pools: [],
      candidates: [],
      publishedTemplates: [],
      state: 'INDEXER_UNAVAILABLE',
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
        return {
          pools: fixtures,
          candidates: [],
          publishedTemplates: [],
          state: 'PROTOCOL_AVAILABLE',
          source: 'development-fixture',
        };
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
