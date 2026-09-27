/**
 * Hop adapters for the composed route.
 *
 * §6 of the mandate: the AMM resolver consumes the SETTLED TARI amount plus the
 * AUTHORITATIVE current AMM state, and must know NOTHING about the cross-layer trade. The
 * `AmmSwapHopInput` type below is the enforcement: it has no field for a preimage, an L1
 * refund height, a reservation, or a script. A cross-layer internal cannot be passed here
 * even by mistake.
 */
import { resolveSwap, SlippagePolicy, SwapOutcome } from '../amm.js';
import { PoolReadbackProvider } from '../ootle.js';
import { TransactionLookup } from '../execution.js';
import { SettlementRevalidation, SettlementRevalidator, TerminalSettlementProof, revalidateTerminalSettlementProof, verifyTerminalSettlementProof } from './proof.js';
import { RouteAsset } from './types.js';

// ---------------------------------------------------------------------------
// Hop 1 — FAST_XTM_TARI (the producer)
// ---------------------------------------------------------------------------

/** What hop 1 must hand to the composition layer once it settles. */
export interface Hop1SettlementOutcome {
  proof: TerminalSettlementProof;
  settledAmountRaw: string;
}

export interface FastXtmTariHopInput {
  routeId: string;
  hopId: string;
  /** Durable cross-layer session that executed hop 1. */
  crossLayerSessionId: string;
}

// ---------------------------------------------------------------------------
// Hop 2 — AMM_SWAP (the consumer)
// ---------------------------------------------------------------------------

/**
 * STRUCTURAL DECOUPLING: nothing cross-layer appears in this type by construction.
 * The SHA preimage, the L1 script, the refund height and the provider reservation are
 * unreachable from the AMM hop — the type system is the control.
 */
export interface AmmSwapHopInput {
  routeId: string;
  hopId: string;
  /** The verified terminal settlement proof. Required — hop 2 cannot exist without it. */
  settlementProof: TerminalSettlementProof;
  /** The account hop 2 executes from. Must equal the proof's recipient. */
  executionAccount: string;
  /** Exact identity of the asset being swapped in (canonical TARI). */
  inputResource: RouteAsset;
  /** Exact identity of the asset being received. */
  outputResource: RouteAsset;
  poolComponent: string;
  /** Maximum epoch for the on-chain transaction validity bound. */
  maxEpoch: string;
  currentEpoch?: string;
  slippage: SlippagePolicy;
  /** Confirmations the settlement must still satisfy at consumption time. */
  requiredSettlementConfirmations: string;
}

export interface AmmSwapBuildResult {
  status: 'BUILT' | 'REFUSED' | 'REQUOTE_REQUIRED' | 'UNAVAILABLE' | 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE';
  reason?: string;
  /** Raw input actually used — always the PROVEN settled amount. */
  inputAmountRaw: string;
  quotedOutputRaw?: string;
  minOutputRaw?: string;
  readEpoch?: string;
  readSubstateVersion?: string;
  reserveInBefore?: string;
  reserveOutBefore?: string;
  feeBps?: string;
  builderIntent?: unknown;
  /** Settlement revalidation outcome, recorded for the route/frontend. */
  revalidation?: SettlementRevalidation;
}

/** Policy for what to do when the settled amount differs from the route expectation. */
export type IntermediateAmountPolicy =
  | { mode: 'ABORT_AND_PAUSE' }
  | { mode: 'ACCEPT_IF_AT_LEAST'; minimumRaw: string };

export interface AmmSwapPolicy {
  intermediateAmount: IntermediateAmountPolicy;
  /**
   * The route's expectation for the intermediate amount (the route-quote hop-2 input).
   *
   * ABORT_AND_PAUSE is defined against THIS expectation. Without it the mode would be
   * vacuous — the settled amount always trivially equals the settlement proof it came from,
   * so a previous implementation's self-comparison never fired and the mode silently
   * protected nothing. When ABORT_AND_PAUSE is selected without an expectation the build is
   * refused (fail closed) rather than allowed to look like protection it does not provide.
   */
  expectedIntermediateRaw?: string;
  /** The user's accepted final minimum. A refreshed quote below this forces a requote. */
  acceptedMinimumFinalOutputRaw: string;
  /** Refreshed quote above this relative to the original expected output forces a requote. */
  maxRoutePriceDriftBps: string;
  /** Whether to allow hop 2 when the settled amount is dust for the pool. */
  allowDustInput: boolean;
}

/**
 * Build hop 2. The ONLY ordering: verify the proof → derive the input from the PROOF →
 * authoritatively reread the AMM → derive min_output → check the accepted bounds.
 * There is no path that reaches a builder intent without a verified proof.
 */
export async function buildAmmSwapHop(
  input: AmmSwapHopInput,
  deps: {
    readback: PoolReadbackProvider;
    builder: { swap(i: { poolComponent: string; quote: unknown; minOutput: string; maxEpoch: string }): unknown };
    policy: AmmSwapPolicy;
    /**
     * MANDATORY authoritative settlement revalidation. Its absence is a structured refusal,
     * not a silent pass: the proof's max-age window is a liveness bound, not a security one,
     * so a reorg inside that window must not escape notice.
     */
    settlementRevalidator?: SettlementRevalidator;
  },
): Promise<AmmSwapBuildResult> {
  // 1. HARD DEPENDENCY. A forged, stale, wrong-session, wrong-recipient, wrong-resource or
  //    wrong-route proof stops here, before any AMM read or construction.
  let proofRef;
  try {
    proofRef = verifyTerminalSettlementProof(input.settlementProof, {
      routeId: input.routeId,
      hop2ExecutionAccount: input.executionAccount,
      expectedResourceAddress: input.inputResource.resourceAddress,
    });
  } catch (error) {
    return { status: 'REFUSED', reason: (error as Error).message, inputAmountRaw: '0' };
  }

  // 2. AUTHORITATIVE REVALIDATION of the settlement itself. A proof is an in-process
  //    capability; the chain is the authority. Every identity field is compared, the settled
  //    state must still hold, and confirmations must still satisfy policy.
  const revalidation = await revalidateTerminalSettlementProof(input.settlementProof, deps.settlementRevalidator, {
    requiredConfirmations: input.requiredSettlementConfirmations,
  });
  if (revalidation.status === 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE') {
    return { status: 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE', reason: revalidation.reason, inputAmountRaw: input.settlementProof.resultingAmountRaw, revalidation };
  }
  if (revalidation.status !== 'CONFIRMED') {
    return { status: 'REFUSED', reason: revalidation.reason, inputAmountRaw: input.settlementProof.resultingAmountRaw, revalidation };
  }

  // 2. The AMM input is the ACTUAL settled amount from the proof. Never the quote, never a
  //    cached amount, never the advertised amount.
  const settled = input.settlementProof.resultingAmountRaw;
  if (!/^\d+$/.test(settled) || BigInt(settled) <= 0n) {
    return { status: 'REFUSED', reason: 'settled intermediate amount is not a positive integer', inputAmountRaw: '0' };
  }

  // 3. Resource identity must be exact on BOTH legs, and the input must be canonical TARI.
  if (!input.inputResource.isCanonicalTari || input.inputResource.kind !== 'OOTLE_L2') {
    return { status: 'REFUSED', reason: 'AMM input asset is not canonical TARI (exact identity required)', inputAmountRaw: settled };
  }
  if (input.outputResource.kind !== 'OOTLE_L2' || input.outputResource.resourceAddress === input.inputResource.resourceAddress) {
    return { status: 'REFUSED', reason: 'AMM output asset is invalid or identical to the input', inputAmountRaw: settled };
  }

  // 4. Route-level policy on the intermediate amount, BEFORE spending a read.
  const policy = deps.policy.intermediateAmount;
  if (policy.mode === 'ABORT_AND_PAUSE') {
    if (deps.policy.expectedIntermediateRaw === undefined) {
      return {
        status: 'REQUOTE_REQUIRED',
        reason: 'ABORT_AND_PAUSE requires expectedIntermediateRaw (the route-quote hop-2 input); without it the mode protects nothing',
        inputAmountRaw: settled,
      };
    }
    if (BigInt(settled) !== BigInt(deps.policy.expectedIntermediateRaw)) {
      return {
        status: 'REQUOTE_REQUIRED',
        reason: `settled intermediate ${settled} differs from the route expectation ${deps.policy.expectedIntermediateRaw} (ABORT_AND_PAUSE)`,
        inputAmountRaw: settled,
      };
    }
  } else if (BigInt(settled) < BigInt(policy.minimumRaw)) {
    return { status: 'REQUOTE_REQUIRED', reason: `settled intermediate ${settled} below the accepted minimum ${policy.minimumRaw}`, inputAmountRaw: settled };
  }

  // 5. AUTHORITATIVE REREAD of the AMM. Discovery/cached state is never used.
  const outcome: SwapOutcome<unknown> = await resolveSwap(
    {
      poolComponent: input.poolComponent,
      inputResource: input.inputResource.resourceAddress,
      outputResource: input.outputResource.resourceAddress,
      rawInputAmount: settled,
      slippage: input.slippage,
      maxEpoch: input.maxEpoch,
    },
    { readback: deps.readback, builder: deps.builder as never, currentEpoch: input.currentEpoch },
  );
  if (outcome.status !== 'ACTIVE') {
    const reason = outcome.status === 'EXPIRED' ? 'AMM_QUOTE_EXPIRED' : outcome.status === 'UNAVAILABLE' ? 'AMM_LIQUIDITY_GONE' : 'AMM_PRICE_OUT_OF_ACCEPTED_BOUNDS';
    return { status: outcome.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'REQUOTE_REQUIRED', reason: `${reason}: ${outcome.reason}`, inputAmountRaw: settled };
  }

  const { quote, pool, freshness } = outcome.resolved;

  // 6. The hard output bound. min_output comes from the AMM slippage policy ONCE (it is
  //    never re-applied on top of the route minimum).
  const minOutput = BigInt(quote.minOutput);

  // 7. The user's accepted final minimum is a HARD FLOOR. If the refreshed AMM quote cannot
  //    still deliver it, we do NOT lower min_output — we refuse and require a requote/user
  //    decision. An intermediate conversion must never erase final-output protection.
  if (minOutput < BigInt(deps.policy.acceptedMinimumFinalOutputRaw)) {
    return {
      status: 'REQUOTE_REQUIRED',
      reason: `refreshed AMM min_output ${quote.minOutput} is below the accepted final minimum ${deps.policy.acceptedMinimumFinalOutputRaw} — user decision required`,
      inputAmountRaw: settled,
      quotedOutputRaw: quote.quotedOutput,
      minOutputRaw: quote.minOutput,
    };
  }

  // 8. Dust guard: a dust input can floor to zero output and is refused explicitly.
  if (minOutput === 0n && !deps.policy.allowDustInput) {
    return { status: 'REQUOTE_REQUIRED', reason: 'settled intermediate amount is dust for this pool', inputAmountRaw: settled, quotedOutputRaw: quote.quotedOutput, minOutputRaw: quote.minOutput };
  }

  return {
    status: 'BUILT',
    inputAmountRaw: settled,
    quotedOutputRaw: quote.quotedOutput,
    minOutputRaw: quote.minOutput,
    readEpoch: quote.readEpoch,
    readSubstateVersion: freshness.identity.substateVersion,
    reserveInBefore: input.inputResource.resourceAddress === pool.resourceA ? pool.reserveA : pool.reserveB,
    reserveOutBefore: input.inputResource.resourceAddress === pool.resourceA ? pool.reserveB : pool.reserveA,
    feeBps: pool.feeBps,
    builderIntent: outcome.resolved.builderIntent,
    revalidation,
    // proofRef is intentionally not returned to the caller as authority; the route record
    // holds the single-use binding.
    ...(proofRef ? {} : {}),
  };
}

// ---------------------------------------------------------------------------
// Hop-2 UNKNOWN reconciliation (§14) — never a blind resubmit
// ---------------------------------------------------------------------------

export interface Hop2ReconcileOutcome {
  status: 'CONFIRMED' | 'REJECTED' | 'NOT_FOUND' | 'STILL_UNKNOWN';
  /** Only true when the chain authoritatively proves the swap did NOT happen. */
  resubmissionAllowed: boolean;
  reason: string;
}

/**
 * Reconcile an UNKNOWN hop-2 submission by durable id. Mirrors execution.ts: a lookup miss
 * is evidence only when the chain authoritatively answers NOT_FOUND/REJECTED; an unresolved
 * lookup stays UNKNOWN.
 */
export async function reconcileHop2(input: { chainTxId: string; lookup: TransactionLookup }): Promise<Hop2ReconcileOutcome> {
  if (input.chainTxId === '') return { status: 'STILL_UNKNOWN', resubmissionAllowed: false, reason: 'no durable hop-2 transaction id — a lost response is not evidence of failure' };
  const status = await input.lookup.statusByTransactionId(input.chainTxId);
  switch (status) {
    case 'COMMITTED':
      return { status: 'CONFIRMED', resubmissionAllowed: false, reason: 'hop-2 transaction committed' };
    case 'REJECTED':
      return { status: 'REJECTED', resubmissionAllowed: true, reason: 'authoritative lookup proves the hop-2 transaction was rejected' };
    case 'NOT_FOUND':
      return { status: 'NOT_FOUND', resubmissionAllowed: true, reason: 'authoritative lookup proves no such hop-2 transaction exists' };
    default:
      return { status: 'STILL_UNKNOWN', resubmissionAllowed: false, reason: 'no authoritative answer yet — keep UNKNOWN and reconcile later; never resubmit blindly' };
  }
}
