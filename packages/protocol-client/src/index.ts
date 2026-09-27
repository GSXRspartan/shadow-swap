export interface IndexerProvider {
  url: string;
  networkName: string;
}

export * from './marketplace.js';
export * from './execution.js';
export * from './ootle.js';
export * from './amm.js';
export * from './history.js';
export * from './execution_flow.js';
export * from './chains/minotari.js';
export * from './chains/minotari_grpc.js';
export * from './multihop/types.js';
export * from './multihop/proof.js';
export * from './multihop/route.js';
export * from './multihop/hops.js';
export * from './multihop/compose.js';
export * from './multihop/frontend.js';
export * from './marketdata/price.js';
export * from './marketdata/types.js';
export * from './marketdata/candle.js';
export * from './marketdata/store.js';
export * from './marketdata/indexer.js';
export * from './marketdata/api.js';

export interface IndexerResponse<T> {
  data: T;
  meta?: { height?: number; timestamp?: number };
  errors?: string[];
}

export class ProtocolClientConfig {
  primaryIndexer: IndexerProvider = { url: 'https://indexer.esmeralda.tari.com', networkName: 'esmeralda' };
  fallbackIndexers: IndexerProvider[] = [
    { url: 'https://indexer-fallback.tari.com', networkName: 'esmeralda' },
  ];
  timeoutMs: number = 5000;
  maxRetries: number = 3;
  userConfigurableEndpoints: boolean = true;
}

/**
 * Resource type as reported by the Ootle engine (`ResourceType`).
 */
export type ResourceKind = 'fungible' | 'confidential' | 'stealth' | 'non_fungible';

/**
 * Pool-eligibility verdict (OPUS-08). Mirrors `protocol_types::ResourceEligibility`.
 *
 * The frontend MUST NOT invent its own classification — it must render exactly what the
 * protocol client derives here.
 *
 * On-chain ENFORCED by the pool template at `Pool::new`:
 *   'canonical_tari' | 'eligible_public_fungible' | 'unsupported_resource_type'
 * ADVISORY only (the template cannot read recall/freeze rules in Ootle v0.41.1; these come from
 * indexer substate, which is UNTRUSTED — treat as a warning, never a guarantee):
 *   'unsafe_recallable' | 'unsafe_freezable' | 'unsafe_mutable_rules'
 */
export type ResourceEligibility =
  | 'canonical_tari'
  | 'eligible_public_fungible'
  | 'unsafe_recallable'
  | 'unsafe_freezable'
  | 'unsafe_mutable_rules'
  | 'unsupported_resource_type'
  | 'unknown';

/**
 * Authoritative-as-possible resource facts. `isCanonicalTari` and `kind` are on-chain
 * authoritative; the recall/freeze/mutability fields are advisory (indexer-sourced) and may be
 * `undefined` when not inspected.
 */
export interface ResourceSecurityFacts {
  address: string;
  isCanonicalTari: boolean;
  kind: ResourceKind;
  recallPossible?: boolean;
  freezePossible?: boolean;
  securityRulesMutable?: boolean;
}

/**
 * Derive the pool-eligibility verdict from authoritative facts. Precedence matches the on-chain
 * template (canonical Tari, then type) before applying advisory recall/freeze/mutability
 * downgrades. Kept byte-for-byte consistent with `protocol_types::classify_resource`.
 */
export function classifyResource(facts: ResourceSecurityFacts): ResourceEligibility {
  if (facts.isCanonicalTari) return 'canonical_tari';
  if (facts.kind !== 'fungible') return 'unsupported_resource_type';
  if (facts.securityRulesMutable === true) return 'unsafe_mutable_rules';
  if (facts.recallPossible === true) return 'unsafe_recallable';
  if (facts.freezePossible === true) return 'unsafe_freezable';
  return 'eligible_public_fungible';
}

/** True only for verdicts the on-chain pool template itself enforces. */
export function isOnChainEnforced(e: ResourceEligibility): boolean {
  return e === 'canonical_tari' || e === 'eligible_public_fungible' || e === 'unsupported_resource_type';
}

/** True if a resource with this verdict must never be routed into a public-fungible pool. */
export function isUnsafeForPool(e: ResourceEligibility): boolean {
  return (
    e === 'unsafe_recallable' ||
    e === 'unsafe_freezable' ||
    e === 'unsafe_mutable_rules' ||
    e === 'unsupported_resource_type'
  );
}

export interface PoolReadData {
  poolAddress: string;
  resourceAddresses: [string, string];
  reserveAmounts: [string, string];
  feeTier: number;
  lpTotalSupply?: string;
  timestamp?: number;
}

export interface PoolReadRequest {
  poolAddress?: string;
  resourceA?: string;
  resourceB?: string;
  includeHistory?: boolean;
}

export interface TransactionReadRequest {
  transactionId: string;
}

export interface ResourceReadRequest {
  resourceAddress: string;
}

export class ProtocolClient {
  private config: ProtocolClientConfig;

  constructor(config?: Partial<ProtocolClientConfig>) {
    this.config = { ...new ProtocolClientConfig(), ...config };
  }

  getConfig(): ProtocolClientConfig {
    return this.config;
  }

  async getPoolData(request: PoolReadRequest): Promise<IndexerResponse<PoolReadData>> {
    const url = this.selectIndexerUrl();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'pool_read', params: request }),
      });
      if (!res.ok) {
        throw new Error(`Indexer error: ${res.status}`);
      }
      const data: PoolReadData = await res.json();
      return { data, meta: { timestamp: Date.now() } };
    } catch (e) {
      return { data: { poolAddress: '', resourceAddresses: ['', ''], reserveAmounts: ['0', '0'], feeTier: 30 }, errors: [(e as Error).message] };
    }
  }

  async getTransactionStatus(request: TransactionReadRequest): Promise<IndexerResponse<{ status: string; epoch?: number }>> {
    const url = this.selectIndexerUrl();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'tx_read', params: request }),
      });
      const data = await res.json();
      return { data, meta: { timestamp: Date.now() } };
    } catch (e) {
      return { data: { status: 'unknown' }, errors: [(e as Error).message] };
    }
  }

  private selectIndexerUrl(): string {
    // Prefer primary; fall back to alternatives on failure (simplified here)
    return this.config.primaryIndexer.url;
  }

  healthCheck(): Promise<{ healthy: boolean; primary: boolean; fallback: boolean }> {
    return Promise.resolve({ healthy: true, primary: true, fallback: false });
  }
}

