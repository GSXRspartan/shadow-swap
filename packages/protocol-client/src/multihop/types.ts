/**
 * Composed multi-hop route model — FAST_XTM_TARI (hop 1) → AMM (hop 2).
 *
 * This phase supports exactly one shape: XTM → TARI → AMM output. It is deliberately NOT a
 * general graph router: a generic route engine would erase hop-specific safety requirements
 * (SHA hashlock semantics, min_output, max_epoch), which is precisely what must not happen.
 *
 * Two independent state machines:
 *   - the ROUTE machine (this file's `RouteState`) tracks the composition;
 *   - each HOP keeps its own machine and its own vocabulary
 *     (`HopExecutionState`, `HopSettlementState`).
 * They are never collapsed: a hop can be SETTLED while the route is PAUSED, and a route can
 * be RECOVERY_REQUIRED while a hop is still executing.
 *
 * All monetary values are raw integer strings (BigInt domain). No float ever carries value.
 */
import { SwapQuote } from '../amm.js';

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Exact resource identity is a ResourceAddress string — never a symbol or name. */
export type RouteAssetKind = 'MINOTARI_L1' | 'OOTLE_L2';

export interface RouteAsset {
  kind: RouteAssetKind;
  /** Exact raw resource address / address identity as the chain knows it. */
  resourceAddress: string;
  /** Human label for display only. NEVER used for identity or routing decisions. */
  label: string;
  decimals: string;
  /** True only for the canonical TARI resource, established by exact address equality. */
  isCanonicalTari?: boolean;
}

// ---------------------------------------------------------------------------
// Route events
// ---------------------------------------------------------------------------

export type RouteEvent =
  | { kind: 'ACCEPT_ROUTE' }
  | { kind: 'BEGIN_HOP1' }
  /** Settling hop 1 REQUIRES the proven amount and the proof reference. */
  | { kind: 'HOP1_SETTLED'; settledAmountRaw: string; proofRef: TerminalSettlementProofRef }
  | { kind: 'HOP1_UNKNOWN'; reason: string }
  | { kind: 'HOP1_FAILED'; reason: string }
  | { kind: 'BEGIN_HOP2_REQUOTE' }
  | { kind: 'HOP2_READY' }
  | { kind: 'BEGIN_HOP2'; operationId: string }
  | { kind: 'HOP2_SETTLED'; chainTxId: string; settledAmountRaw: string }
  | { kind: 'HOP2_UNKNOWN'; reason: string }
  | { kind: 'HOP2_FAILED'; reason: string }
  | { kind: 'SKIP_HOP2' }
  | { kind: 'SETTLE_PARTIAL' }
  | { kind: 'PAUSE'; reason: RoutePauseReason; detail: string }
  | { kind: 'REQUIRE_REQUOTE'; detail: string }
  | { kind: 'HOP2_UNAVAILABLE'; reason: RoutePauseReason; detail: string }
  | { kind: 'RESUME_REQUOTE' }
  | { kind: 'ENTER_RECOVERY'; reason: string }
  | { kind: 'RESOLVE_CONTINUE' }
  | { kind: 'RESOLVE_SETTLED' }
  | { kind: 'RESOLVE_SKIP' }
  | { kind: 'FAIL_TERMINAL'; reason: string };

// ---------------------------------------------------------------------------
// Hops
// ---------------------------------------------------------------------------

export type HopKind = 'FAST_XTM_TARI' | 'AMM_SWAP';

export type HopExecutionState = 'NOT_STARTED' | 'EXECUTING' | 'SUBMITTED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED';
export type HopSettlementState = 'UNSETTLED' | 'SETTLED' | 'REFUNDED' | 'FAILED_TERMINAL';

/** Per-hop safety requirements that generic route logic must never weaken. */
export interface HopSafetyRequirements {
  /**
   * Does this hop require a chain-proven TERMINAL SETTLEMENT PROOF from the previous hop
   * before it may construct anything? Only a hop that consumes another hop's OUTPUT asset
   * needs this. Set at construction and never relaxed.
   */
  requiresSettlementProof: boolean;
  /** Must re-read authoritative chain state immediately before construction. */
  requiresAuthoritativeReread: boolean;
  /** Hard on-chain output bound (AMM min_output) or HTLC deadline (cross-layer). */
  hasHardOutputBound: boolean;
  /** Must not be retried blindly after an UNKNOWN submission. */
  reconcileUnknownBeforeRetry: true;
}

export interface RouteHop {
  hopId: string;
  index: number;
  kind: HopKind;
  inputAsset: RouteAsset;
  outputAsset: RouteAsset;
  /** Raw integer input to THIS hop (never the route's original input). */
  inputAmountRaw: string;
  /** Expected output of this hop at quote time. */
  expectedOutputRaw: string;
  /** Hard minimum output for this hop, where the underlying primitive supports one. */
  minimumOutputRaw?: string;
  /** Hop-local freshness/expiry (AMM max epoch, cross-layer refund height). */
  expiresAtEpochOrHeight?: string;
  safety: HopSafetyRequirements;
  execution: HopExecutionState;
  settlement: HopSettlementState;
  /** Durable ids assigned once execution begins. */
  operationId?: string;
  chainTxId?: string;
  failureReason?: string;
  /** Amount actually settled by this hop (from a proof, never from a quote). */
  settledAmountRaw?: string;
}

// ---------------------------------------------------------------------------
// Route-level state machine
// ---------------------------------------------------------------------------

export const ROUTE_STATES = [
  'ROUTE_QUOTED',
  'ROUTE_ACCEPTED',
  'HOP1_EXECUTING',
  'HOP1_SETTLED',
  'HOP2_REQUOTE',
  'HOP2_READY',
  'HOP2_EXECUTING',
  /** Hop 2 deliberately skipped; the intermediate asset stays under user control. */
  'HOP2_SKIPPED',
  'ROUTE_SETTLED',
  'ROUTE_PAUSED',
  'ROUTE_RECOVERY_REQUIRED',
  'ROUTE_FAILED_TERMINAL',
] as const;

export type RouteState = (typeof ROUTE_STATES)[number];

export const TERMINAL_ROUTE_STATES: ReadonlySet<RouteState> = new Set<RouteState>([
  'ROUTE_SETTLED',
  'ROUTE_FAILED_TERMINAL',
]);

/** Why a route paused. Partial completion is a first-class, non-failure outcome. */
export type RoutePauseReason =
  | 'INTERMEDIATE_SETTLED_REQUOTE_REQUIRED'
  | 'AMM_LIQUIDITY_GONE'
  | 'AMM_MIN_OUTPUT_BELOW_ACCEPTED_MINIMUM'
  | 'AMM_QUOTE_EXPIRED'
  | 'AMM_PRICE_OUT_OF_ACCEPTED_BOUNDS'
  | 'INTERMEDIATE_AMOUNT_MISMATCH'
  | 'AMM_DUST_INPUT'
  /** The AMM execution itself failed; the settled intermediate is safe and unspent. */
  | 'AMM_EXECUTION_FAILED'
  | 'WALLET_PROVIDER_UNAVAILABLE';

export interface RoutePauseRecord {
  reason: RoutePauseReason;
  detail: string;
  atUnixMs: number;
}

// ---------------------------------------------------------------------------
// User acceptance boundary (§10)
// ---------------------------------------------------------------------------

/**
 * What the user agreed to BEFORE the route started. Every refreshed hop-2 quote must still
 * satisfy these, or the route pauses instead of proceeding.
 */
export interface RouteAcceptance {
  /** Exact source input the user authorised. */
  authorizedSourceAmountRaw: string;
  authorizedSourceAsset: RouteAsset;
  /** Hard floor on the FINAL asset. Never lowered by a requote. */
  minimumFinalOutputRaw: string;
  /** Maximum provider spread the user will accept (bps of 10_000). */
  maxProviderSpreadBps: string;
  /** Maximum total network fees the user will accept, where enforceable. */
  maxNetworkFeesRaw: string;
  /** AMM execution slippage tolerance (bps of 10_000). */
  ammSlippageBps: string;
  /** Route-level deadline. */
  expiresAtUnixMs: number;
  /** The only permitted intermediate asset: canonical TARI, by exact identity. */
  allowedIntermediateAsset: RouteAsset;
  /** The user must see and accept a non-canonical (issuer-controlled) destination. */
  destinationRequiresAcknowledgement: boolean;
  destinationAcknowledged?: boolean;
}

// ---------------------------------------------------------------------------
// Fees and price (§18, §19) — kept strictly separate, developer fee is always ZERO
// ---------------------------------------------------------------------------

export interface RouteFeeBreakdown {
  l1NetworkFeeRaw: string;
  l2HtlcNetworkFeeRaw: string;
  /** Provider economic margin (NOT a protocol fee). */
  providerSpreadRaw: string;
  ammLpFeeRaw: string;
  ammNetworkFeeRaw: string;
  /** Always exactly "0" — this protocol has no developer rake, by design. */
  developerTradingFeeRaw: '0';
  totalRaw: string;
}

export interface RoutePriceModel {
  sourceInputRaw: string;
  /** Provider's exact quoted TARI output (cross-layer leg). */
  providerQuotedTariRaw: string;
  /** ACTUAL settled TARI, from a terminal settlement proof. Never the quote. */
  settledTariRaw?: string;
  ammExpectedOutputRaw?: string;
  ammMinimumOutputRaw?: string;
  /** Hard floor the user accepted, applied AFTER the AMM min_output. */
  acceptedMinimumFinalOutputRaw: string;
  /** effective total route price = final output per unit source input (raw, scaled 1e18). */
  effectiveRoutePriceX18?: string;
}

// ---------------------------------------------------------------------------
// Settlement evidence
// ---------------------------------------------------------------------------

/**
 * The single artifact hop 2 may consume. It is produced ONLY by
 * `mintTerminalSettlementProof` (../multihop/proof.js) from authoritative evidence, is
 * branded with a module-private symbol, and must be re-verified before every use.
 */
export interface TerminalSettlementProofRef {
  readonly proofId: string;
  readonly routeId: string;
  readonly fingerprint: string;
}

// ---------------------------------------------------------------------------
// Recovery policy (§15)
// ---------------------------------------------------------------------------

export interface RouteRecoveryPolicy {
  /** After a restart, re-read both chains before deciding anything. */
  requiresAuthoritativeRereadOnRestart: true;
  /** Never resubmit a hop whose outcome is UNKNOWN. */
  neverBlindResubmit: true;
  /** The intermediate asset always remains under user control. */
  intermediateAssetRemainsUserControlled: true;
}

// ---------------------------------------------------------------------------
// Market data seam (§32) — emitted on successful hop-2 settlement, no aggregation here
// ---------------------------------------------------------------------------

export interface MarketDataEvent {
  poolComponent: string;
  inputResource: string;
  outputResource: string;
  inputAmountRaw: string;
  outputAmountRaw: string;
  /** Exact price inputs so candles can be recomputed without re-reading the pool. */
  reserveInBefore: string;
  reserveOutBefore: string;
  reserveInAfter: string;
  reserveOutAfter: string;
  feeBps: string;
  chainTxId: string;
  epoch: string;
  substateVersion?: string;
  routeId: string;
  emittedAtUnixMs: number;
}

// ---------------------------------------------------------------------------
// The route record
// ---------------------------------------------------------------------------

export interface RouteRecord {
  routeId: string;
  state: RouteState;
  sourceAsset: RouteAsset;
  destinationAsset: RouteAsset;
  /** Raw integer total expected output, and the hard minimum. */
  totalExpectedOutputRaw: string;
  totalMinimumOutputRaw: string;
  quoteExpiresAtUnixMs: number;
  routeExpiresAtUnixMs: number;
  hops: RouteHop[];
  acceptance: RouteAcceptance;
  fees: RouteFeeBreakdown;
  price: RoutePriceModel;
  /** Set only when hop 1 produced a chain-proven terminal settlement. */
  settlementProof?: TerminalSettlementProofRef;
  /** Single-use binding: recorded once hop 2 has consumed the proof. */
  proofConsumedByHop2?: boolean;
  pause?: RoutePauseRecord;
  recovery: RouteRecoveryPolicy;
  /** The account that receives the intermediate TARI AND executes hop 2 — must be identical. */
  intermediateAccount: string;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  failureReason?: string;
}

export const DEFAULT_RECOVERY_POLICY: RouteRecoveryPolicy = {
  requiresAuthoritativeRereadOnRestart: true,
  neverBlindResubmit: true,
  intermediateAssetRemainsUserControlled: true,
};

/** Hop-2 must be gated on a settlement proof; hop 1 is the producer. */
export function hopSafetyFor(kind: HopKind): HopSafetyRequirements {
  if (kind === 'AMM_SWAP') {
    return {
      requiresSettlementProof: true,
      requiresAuthoritativeReread: true,
      hasHardOutputBound: true,
      reconcileUnknownBeforeRetry: true,
    };
  }
  return {
    requiresSettlementProof: false,
    requiresAuthoritativeReread: true,
    hasHardOutputBound: true,
    reconcileUnknownBeforeRetry: true,
  };
}

/** Re-exported so hop code never has to import the AMM module's internals. */
export type { SwapQuote };
