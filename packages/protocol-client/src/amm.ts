/**
 * Safe AMM swap/liquidity resolution.
 *
 * Mirrors the on-chain template semantics EXACTLY with BigInt integer arithmetic (fee in
 * basis points out of 10_000, floor division, multiply-before-divide). No floats. No JS
 * Number carries an on-chain value.
 *
 * Flow: DISCOVER (indexer, advisory) → AUTHORITATIVE REREAD (mandatory) → SAFE QUOTE →
 * USER SLIPPAGE → RESOLVE → CONSTRUCT. There is no indexer-only execution path.
 */
import { Freshness } from './execution.js';
import { PoolState, PoolReadbackProvider } from './ootle.js';

export const FEE_DENOMINATOR = 10_000n;
export const SLIPPAGE_DENOMINATOR = 10_000n;

/**
 * The maximum fee tier the on-chain template will accept at pool creation.
 *
 * `templates/fungible_pool/src/lib.rs` asserts `fee_bps > 0 && fee_bps <= MAX_FEE_BPS`
 * with `MAX_FEE_BPS = 1_000` (10.00%). A pool reporting a larger fee is therefore an
 * impossible state, and a quote built on one would be a quote for a pool that cannot
 * exist. The client refuses anything outside the chain's own range instead of
 * accepting the whole 1..=9999 space.
 */
export const MAX_FEE_BPS = 1_000n;

/** Exact integer quote, independently derived (mirrors template + pool_ref_model). */
export function quoteSwapOutput(reserveIn: string, reserveOut: string, input: string, feeBps: string): { output: string; effectiveInput: string } {
  const rIn = BigInt(reserveIn);
  const rOut = BigInt(reserveOut);
  const amountIn = BigInt(input);
  const fee = BigInt(feeBps);
  if (rIn === 0n || rOut === 0n) throw new Error('Pool reserve is empty');
  if (amountIn === 0n) throw new Error('Swap input must be non-zero');
  // The chain refuses to create a pool outside 1..=MAX_FEE_BPS, so a readback
  // outside that range is impossible state and must not be quoted.
  if (fee === 0n || fee > MAX_FEE_BPS) throw new Error(`Invalid fee tier: ${feeBps} bps (the pool template permits only 1..=${MAX_FEE_BPS} bps)`);
  const effective = (amountIn * (FEE_DENOMINATOR - fee)) / FEE_DENOMINATOR;
  if (effective === 0n) throw new Error('Swap input too small to yield any output after fee');
  const output = (rOut * effective) / (rIn + effective);
  if (output === 0n) throw new Error('Swap output floors to zero (input too small)');
  return { output: output.toString(), effectiveInput: effective.toString() };
}

/**
 * Explicit slippage policy in basis points (denominator 10_000). Fully independent of the
 * LP fee variable. There is NO implicit default; callers must pass a tolerance.
 */
export interface SlippagePolicy {
  slippageBps: string;
  /** Justifies min_output === 0 for dust trades; must be an explicit, auditable choice. */
  allowZeroMinOutput?: boolean;
}

export function validateSlippage(policy: SlippagePolicy): bigint {
  const raw = policy.slippageBps;
  if (!/^\d+$/.test(raw)) throw new Error(`slippageBps must be a non-negative integer string, got ${raw}`);
  const bps = BigInt(raw);
  if (bps > SLIPPAGE_DENOMINATOR) throw new Error(`slippageBps ${raw} exceeds 100% (${SLIPPAGE_DENOMINATOR} bps)`);
  if (bps > 5_000n) throw new Error(`slippageBps ${raw} is economically unsafe (>50%); tighten the tolerance`);
  return bps;
}

/** minimum_output = quoted_output * (10_000 - slippage_bps) / 10_000 (floor). */
export function deriveMinOutput(quotedOutput: string, policy: SlippagePolicy): string {
  const bps = validateSlippage(policy);
  const out = BigInt(quotedOutput);
  if (out === 0n) throw new Error('Cannot derive min_output from a zero quote');
  const min = (out * (SLIPPAGE_DENOMINATOR - bps)) / SLIPPAGE_DENOMINATOR;
  if (min === 0n && !policy.allowZeroMinOutput) {
    throw new Error('Slippage tolerance floors min_output to zero; set allowZeroMinOutput deliberately or tighten the tolerance');
  }
  return min.toString();
}

function decimalAmount(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a non-negative integer string, got ${value}`);
  return BigInt(value);
}

/**
 * The first numeric field of a pool state that is not a raw integer string.
 *
 * `parsePoolState` already validates these at the readback boundary, but a
 * resolver must not depend on that: an integration that supplies its own
 * readback, or a test double, can hand over a state object directly. Without
 * this check a malformed reserve reaches `BigInt()` and the resolver throws
 * instead of returning the typed outcome its callers are written to handle.
 */
function malformedNumericField(pool: PoolState): string | undefined {
  for (const name of ['reserveA', 'reserveB', 'feeBps', 'totalLpSupply', 'lockedLpSupply'] as const) {
    if (!/^\d+$/.test(pool[name])) return name;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Swap resolution
// ---------------------------------------------------------------------------

export interface SwapQuote {
  poolComponent: string;
  inputResource: string;
  outputResource: string;
  rawInputAmount: string;
  feeBps: string;
  quotedOutput: string;
  minOutput: string;
  slippageBps: string;
  effectiveInput: string;
  readEpoch?: string;
}

export interface SwapRequest {
  poolComponent: string;
  inputResource: string;
  outputResource: string;
  /** Raw integer input amount (smallest unit). Never a float. */
  rawInputAmount: string;
  slippage: SlippagePolicy;
  /** Mandatory transaction validity bound (with_max_epoch on-chain). No infinite validity. */
  maxEpoch: string;
  /** Caller expectations; a mismatch is an explicit STALE/CONFLICTED, never silent. */
  expectedReserves?: { a: string; b: string };
  expectedFeeBps?: string;
}

export interface SwapIntentBuilder<TIntent> {
  swap(intent: { poolComponent: string; quote: SwapQuote; minOutput: string; maxEpoch: string }): TIntent;
}

export interface SwapResolution<TIntent> {
  poolComponent: string;
  quote: SwapQuote;
  pool: PoolState;
  freshness: Freshness;
  builderOperation: 'swap';
  builderIntent: TIntent;
}

export type SwapOutcome<TIntent> =
  | { status: 'ACTIVE'; resolved: SwapResolution<TIntent> }
  | { status: 'STALE' | 'UNAVAILABLE' | 'EXPIRED' | 'CONFLICTED'; reason: string };

/**
 * Authoritative swap resolution. Discovery data is never trusted: the pool is re-read by
 * the authoritative provider and every identity/derivation is re-checked at read time.
 */
export async function resolveSwap<TIntent>(
  request: SwapRequest,
  deps: { readback: PoolReadbackProvider; builder: SwapIntentBuilder<TIntent>; currentEpoch?: string },
): Promise<SwapOutcome<TIntent>> {
  let input: bigint;
  try {
    input = decimalAmount(request.rawInputAmount, 'rawInputAmount');
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: (error as Error).message };
  }
  if (input === 0n) return { status: 'UNAVAILABLE', reason: 'rawInputAmount must be positive' };

  const read = await deps.readback.readPool(request.poolComponent);
  if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: read.reason };
  const pool = read.value;
  const malformed = malformedNumericField(pool);
  if (malformed !== undefined) {
    return { status: 'UNAVAILABLE', reason: `Pool ${request.poolComponent} reports a malformed ${malformed}` };
  }
  const freshness = read.freshness;

  if (request.expectedReserves && (pool.reserveA !== request.expectedReserves.a || pool.reserveB !== request.expectedReserves.b)) {
    return { status: 'STALE', reason: `Reserves changed since the caller's snapshot (expected ${request.expectedReserves.a}/${request.expectedReserves.b}, read ${pool.reserveA}/${pool.reserveB})` };
  }
  if (request.expectedFeeBps !== undefined && pool.feeBps !== request.expectedFeeBps) {
    return { status: 'CONFLICTED', reason: `Pool fee changed since discovery (expected ${request.expectedFeeBps} bps, read ${pool.feeBps} bps)` };
  }

  // Exact ResourceAddress identity — never symbol/name. Direction must be one of the two
  // canonical pool legs; anything else (including A/A) is refused.
  //
  // A/A is refused here as well as on-chain (`check_pool_resources` asserts
  // `a != b`). The chain check alone is not enough: refusing before the user
  // reviews a nonsense trade is the difference between a clear reason and a
  // signed transaction that can only abort.
  if (request.inputResource === request.outputResource) {
    return { status: 'CONFLICTED', reason: `Refusing a swap of ${request.inputResource} into itself: a pool's two resources are always distinct` };
  }
  if (pool.resourceA === pool.resourceB) {
    return { status: 'CONFLICTED', reason: `Pool ${request.poolComponent} reports the same resource on both legs (${pool.resourceA}); this state is impossible` };
  }
  const isAToB = request.inputResource === pool.resourceA && request.outputResource === pool.resourceB;
  const isBToA = request.inputResource === pool.resourceB && request.outputResource === pool.resourceA;
  if (!isAToB && !isBToA) {
    return { status: 'CONFLICTED', reason: `Requested direction (${request.inputResource} → ${request.outputResource}) is not this pool's pair (${pool.resourceA} → ${pool.resourceB})` };
  }
  const reserveIn = isAToB ? pool.reserveA : pool.reserveB;
  const reserveOut = isAToB ? pool.reserveB : pool.reserveA;

  let quoted: string;
  let effective: string;
  try {
    const q = quoteSwapOutput(reserveIn, reserveOut, request.rawInputAmount, pool.feeBps);
    quoted = q.output;
    effective = q.effectiveInput;
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: (error as Error).message };
  }

  let minOutput: string;
  try {
    minOutput = deriveMinOutput(quoted, request.slippage);
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: (error as Error).message };
  }

  if (deps.currentEpoch !== undefined) {
    const now = BigInt(deps.currentEpoch);
    const max = BigInt(request.maxEpoch);
    if (now >= max) return { status: 'EXPIRED', reason: `Current epoch ${deps.currentEpoch} is at/after the caller's max epoch ${request.maxEpoch}` };
  }

  const quote: SwapQuote = {
    poolComponent: request.poolComponent,
    inputResource: request.inputResource,
    outputResource: request.outputResource,
    rawInputAmount: request.rawInputAmount,
    feeBps: pool.feeBps,
    quotedOutput: quoted,
    minOutput,
    slippageBps: request.slippage.slippageBps,
    effectiveInput: effective,
    readEpoch: read.freshness.identity.epoch,
  };
  return {
    status: 'ACTIVE',
    resolved: {
      poolComponent: request.poolComponent,
      quote,
      pool,
      freshness: read.freshness,
      builderOperation: 'swap',
      builderIntent: deps.builder.swap({ poolComponent: request.poolComponent, quote, minOutput, maxEpoch: request.maxEpoch }),
    },
  };
}

// ---------------------------------------------------------------------------
// Add / remove liquidity resolution
// ---------------------------------------------------------------------------

export interface AddLiquidityRequest {
  poolComponent: string;
  /** Raw amounts for each side; both must be positive (the pool rejects one-sided adds). */
  rawAmountA: string;
  rawAmountB: string;
  maxEpoch: string;
}

export interface LiquidityIntentBuilder<TIntent> {
  addLiquidity(intent: { poolComponent: string; resourceA: string; resourceB: string; rawAmountA: string; rawAmountB: string; maxEpoch: string }): TIntent;
  removeLiquidity(intent: { poolComponent: string; lpResource: string; rawLpAmount: string; maxEpoch: string }): TIntent;
}

export interface AddLiquidityResolution<TIntent> {
  request: AddLiquidityRequest;
  pool: PoolState;
  /** Proportional LP the deposit SHOULD mint against pre-deposit reserves (advisory; pool enforces). */
  expectedLpMintHint: string;
  freshness: Freshness;
  builderIntent: TIntent;
  builderOperation: 'add_liquidity';
}

export type AddLiquidityOutcome<TIntent> =
  | { status: 'ACTIVE'; resolved: AddLiquidityResolution<TIntent> }
  | { status: 'UNAVAILABLE' | 'CONFLICTED'; reason: string };

/** First deposit (both reserves zero) is bootstrap-only on-chain; the resolver refuses it. */
export async function resolveAddLiquidity<TIntent>(
  request: AddLiquidityRequest,
  deps: { readback: PoolReadbackProvider; builder: LiquidityIntentBuilder<TIntent> },
): Promise<AddLiquidityOutcome<TIntent>> {
  try {
    if (decimalAmount(request.rawAmountA, 'rawAmountA') === 0n || decimalAmount(request.rawAmountB, 'rawAmountB') === 0n) {
      return { status: 'UNAVAILABLE', reason: 'Both raw amounts must be positive' };
    }
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: (error as Error).message };
  }
  const read = await deps.readback.readPool(request.poolComponent);
  if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: read.reason };
  const pool = read.value;
  const malformed = malformedNumericField(pool);
  if (malformed !== undefined) {
    return { status: 'UNAVAILABLE', reason: `Pool ${request.poolComponent} reports a malformed ${malformed}` };
  }
  if (BigInt(pool.reserveA) === 0n && BigInt(pool.reserveB) === 0n) {
    return { status: 'UNAVAILABLE', reason: 'Pool is empty; first deposit is the on-chain bootstrap path (geometric mean + locked LP) and is deliberately not constructed by this resolver' };
  }
  // Either reserve being zero is an impossible half-initialised pool. Refusing it
  // here also removes a BigInt division-by-zero from this path, so the resolver
  // keeps returning a typed outcome instead of throwing into the caller.
  if (BigInt(pool.reserveA) === 0n || BigInt(pool.reserveB) === 0n) {
    return { status: 'UNAVAILABLE', reason: `Pool ${request.poolComponent} has an empty reserve (${pool.reserveA}/${pool.reserveB}); this state is impossible` };
  }
  if (BigInt(pool.totalLpSupply) === 0n) {
    return { status: 'UNAVAILABLE', reason: `Pool ${request.poolComponent} has LP supply of zero while holding reserves; this state is impossible` };
  }
  // Proportional hint against PRE-deposit reserves (advisory display value only; the pool
  // enforces the min-side proportional mint authoritatively).
  const total = BigInt(pool.totalLpSupply);
  const hintA = (BigInt(request.rawAmountA) * total) / BigInt(pool.reserveA);
  const hintB = (BigInt(request.rawAmountB) * total) / BigInt(pool.reserveB);
  const builderIntent = deps.builder.addLiquidity({
    poolComponent: request.poolComponent,
    resourceA: pool.resourceA,
    resourceB: pool.resourceB,
    rawAmountA: request.rawAmountA,
    rawAmountB: request.rawAmountB,
    maxEpoch: request.maxEpoch,
  });
  return {
    status: 'ACTIVE',
    resolved: {
      request,
      pool,
      expectedLpMintHint: (hintA < hintB ? hintA : hintB).toString(),
      freshness: read.freshness,
      builderIntent,
      builderOperation: 'add_liquidity',
    },
  };
}

export interface RemoveLiquidityRequest {
  poolComponent: string;
  /** Raw LP amount to burn. */
  rawLpAmount: string;
  maxEpoch: string;
}

export interface RemoveLiquidityResolution<TIntent> {
  request: RemoveLiquidityRequest;
  pool: PoolState;
  /** Proportional redemption floors at read-time reserves. */
  expectedA: string;
  expectedB: string;
  freshness: Freshness;
  builderIntent: TIntent;
  builderOperation: 'remove_liquidity';
}

export type RemoveLiquidityOutcome<TIntent> =
  | { status: 'ACTIVE'; resolved: RemoveLiquidityResolution<TIntent> }
  | { status: 'UNAVAILABLE' | 'CONFLICTED'; reason: string };

export async function resolveRemoveLiquidity<TIntent>(
  request: RemoveLiquidityRequest,
  deps: { readback: PoolReadbackProvider; builder: LiquidityIntentBuilder<TIntent> },
): Promise<RemoveLiquidityOutcome<TIntent>> {
  let lp: bigint;
  try {
    lp = decimalAmount(request.rawLpAmount, 'rawLpAmount');
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: (error as Error).message };
  }
  if (lp === 0n) return { status: 'UNAVAILABLE', reason: 'LP amount must be positive' };
  const read = await deps.readback.readPool(request.poolComponent);
  if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: read.reason };
  const pool = read.value;
  const malformed = malformedNumericField(pool);
  if (malformed !== undefined) {
    return { status: 'UNAVAILABLE', reason: `Pool ${request.poolComponent} reports a malformed ${malformed}` };
  }
  const total = BigInt(pool.totalLpSupply);
  if (total === 0n) return { status: 'UNAVAILABLE', reason: 'Pool LP supply is zero' };
  // Burning more LP than exists is impossible, and the proportional amounts it
  // would imply exceed the reserves themselves. Refusing it keeps the displayed
  // redemption inside what the pool can actually pay.
  if (lp > total) {
    return { status: 'UNAVAILABLE', reason: `Cannot burn ${request.rawLpAmount} LP: the pool's total supply is ${pool.totalLpSupply}` };
  }
  const expectedA = (lp * BigInt(pool.reserveA)) / total;
  const expectedB = (lp * BigInt(pool.reserveB)) / total;
  if (expectedA === 0n || expectedB === 0n) {
    return { status: 'UNAVAILABLE', reason: 'Redemption would floor to zero reserves on-chain and abort; reduce the burn' };
  }
  const builderIntent = deps.builder.removeLiquidity({
    poolComponent: request.poolComponent,
    lpResource: pool.lpResource,
    rawLpAmount: request.rawLpAmount,
    maxEpoch: request.maxEpoch,
  });
  return {
    status: 'ACTIVE',
    resolved: {
      request,
      pool,
      expectedA: expectedA.toString(),
      expectedB: expectedB.toString(),
      freshness: read.freshness,
      builderIntent,
      builderOperation: 'remove_liquidity',
    },
  };
}

// ---------------------------------------------------------------------------
// Resource safety classification (RR-01 operationalization)
// ---------------------------------------------------------------------------

export type ResourceRoutingClass = 'CANONICAL_TARI' | 'PUBLIC_IMMUTABLE_OR_VETTED' | 'ISSUER_CONTROLLED' | 'UNKNOWN' | 'UNSUPPORTED';

export interface ResourceFactsForRouting {
  isCanonicalTari: boolean;
  resourceType: 'fungible' | 'confidential' | 'stealth' | 'non_fungible';
  /** Advisory (indexer-sourced) issuer-authority facts; undefined when uninspected. */
  recallPossible?: boolean;
  freezePossible?: boolean;
  securityRulesMutable?: boolean;
}

/** Issuer-controlled is never CLAIMED safe: the Ootle ABI cannot prove absence of authority. */
export function classifyResourceForRouting(facts: ResourceFactsForRouting): ResourceRoutingClass {
  if (facts.isCanonicalTari) return 'CANONICAL_TARI';
  if (facts.resourceType !== 'fungible') return 'UNSUPPORTED';
  if (facts.recallPossible === true || facts.freezePossible === true || facts.securityRulesMutable === true) return 'ISSUER_CONTROLLED';
  if (facts.recallPossible === undefined && facts.freezePossible === undefined && facts.securityRulesMutable === undefined) return 'UNKNOWN';
  return 'PUBLIC_IMMUTABLE_OR_VETTED';
}

export interface RoutingPolicySpec {
  /** Verdicts that pass without friction. */
  allow: ResourceRoutingClass[];
  /** Verdicts that require an explicit user acknowledgement string. */
  requireAcknowledgement?: ResourceRoutingClass[];
  /** Verdicts hard-refused. */
  refuse: ResourceRoutingClass[];
}

export type RoutingVerdict =
  | { verdict: 'ALLOW' }
  | { verdict: 'REQUIRE_ACKNOWLEDGEMENT'; acknowledgementText: string }
  | { verdict: 'REFUSE'; reason: string };

export function applyRoutingPolicy(resourceClass: ResourceRoutingClass, policy: RoutingPolicySpec): RoutingVerdict {
  if (policy.refuse.includes(resourceClass)) {
    return { verdict: 'REFUSE', reason: `Resource class ${resourceClass} is refused by routing policy` };
  }
  if (policy.requireAcknowledgement?.includes(resourceClass)) {
    return {
      verdict: 'REQUIRE_ACKNOWLEDGEMENT',
      acknowledgementText: `This asset (${resourceClass}) is controlled by its issuer, which can recall, freeze, or change its rules after pooling. Continue only with explicit acknowledgement.`,
    };
  }
  if (policy.allow.includes(resourceClass)) return { verdict: 'ALLOW' };
  return { verdict: 'REFUSE', reason: `Resource class ${resourceClass} is not covered by routing policy` };
}