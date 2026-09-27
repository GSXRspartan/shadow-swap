/**
 * Route-level state machine for composed routes.
 *
 * SEPARATE from the cross-layer session machine and from the AMM primitives on purpose: a
 * route is NOT a cross-layer session, and collapsing them is how composition bugs hide.
 *
 * Rules enforced here:
 *  - hop 2 may only become READY from a settlement proof (checked by hops.ts, required here
 *    as a state precondition);
 *  - a terminal route is terminal (no transition out);
 *  - a settled hop is never un-settled;
 *  - partial completion (hop 2 skipped) is a first-class outcome, not a failure.
 */
import { IllegalTransitionError } from '../crosschain/session.js';
import { requireIdentifier, requireOperationId } from '../crosschain/types.js';
import { RouteEvent, RouteRecord, RouteState, TERMINAL_ROUTE_STATES } from './types.js';

/** Legal route transitions. Everything else is an IllegalTransitionError. */
const TRANSITIONS: Record<RouteState, Partial<Record<RouteEvent['kind'], RouteState>>> = {
  ROUTE_QUOTED: { ACCEPT_ROUTE: 'ROUTE_ACCEPTED', FAIL_TERMINAL: 'ROUTE_FAILED_TERMINAL' },
  ROUTE_ACCEPTED: { BEGIN_HOP1: 'HOP1_EXECUTING', PAUSE: 'ROUTE_PAUSED', FAIL_TERMINAL: 'ROUTE_FAILED_TERMINAL' },
  HOP1_EXECUTING: { HOP1_SETTLED: 'HOP1_SETTLED', HOP1_UNKNOWN: 'ROUTE_RECOVERY_REQUIRED', HOP1_FAILED: 'ROUTE_FAILED_TERMINAL' },
  HOP1_SETTLED: { BEGIN_HOP2_REQUOTE: 'HOP2_REQUOTE', SKIP_HOP2: 'HOP2_SKIPPED', PAUSE: 'ROUTE_PAUSED' },
  HOP2_REQUOTE: { HOP2_READY: 'HOP2_READY', REQUIRE_REQUOTE: 'ROUTE_PAUSED', HOP2_UNAVAILABLE: 'ROUTE_PAUSED', PAUSE: 'ROUTE_PAUSED' },
  HOP2_READY: { BEGIN_HOP2: 'HOP2_EXECUTING', PAUSE: 'ROUTE_PAUSED', FAIL_TERMINAL: 'ROUTE_FAILED_TERMINAL' },
  HOP2_EXECUTING: { HOP2_SETTLED: 'ROUTE_SETTLED', HOP2_UNKNOWN: 'ROUTE_RECOVERY_REQUIRED', HOP2_FAILED: 'ROUTE_PAUSED' },
  HOP2_SKIPPED: { SETTLE_PARTIAL: 'ROUTE_SETTLED', BEGIN_HOP2_REQUOTE: 'HOP2_REQUOTE' },
  ROUTE_SETTLED: {},
  ROUTE_PAUSED: { RESUME_REQUOTE: 'HOP2_REQUOTE', SKIP_HOP2: 'HOP2_SKIPPED', ENTER_RECOVERY: 'ROUTE_RECOVERY_REQUIRED', FAIL_TERMINAL: 'ROUTE_FAILED_TERMINAL' },
  ROUTE_RECOVERY_REQUIRED: { RESOLVE_CONTINUE: 'HOP2_REQUOTE', RESOLVE_SETTLED: 'ROUTE_SETTLED', RESOLVE_SKIP: 'HOP2_SKIPPED', FAIL_TERMINAL: 'ROUTE_FAILED_TERMINAL' },
  ROUTE_FAILED_TERMINAL: {},
};

export function isTerminalRouteState(state: RouteState): boolean {
  return TERMINAL_ROUTE_STATES.has(state);
}

export function allowedRouteTargets(record: RouteRecord, event: RouteEvent): RouteState | undefined {
  if (isTerminalRouteState(record.state)) return undefined;
  return TRANSITIONS[record.state][event.kind];
}

/** Pure validated transition. */
/**
 * Deep-copy a route record.
 *
 * The previous implementation used `{ ...record }`, which shares the `hops`
 * ARRAY and every hop OBJECT, plus `acceptance`, `fees`, `price`, and `pause`.
 * Every `hop.execution = ...` assignment therefore also mutated the caller's
 * previous record. Consequences, in order of severity:
 *
 *   - a UI snapshot of "quote ready" retroactively becomes "hop 1 executing",
 *     so the review the user approved no longer matches the record;
 *   - two consumers (UI and executor) holding the same record observe each
 *     other's transitions, and a comparison that says "nothing changed" can be
 *     wrong;
 *   - a persisted record captured before an event changes after the fact, which
 *     destroys the audit trail that recovery depends on;
 *   - `next.price.settledTariRaw = ...` mutated the ORIGINAL record's price
 *     model, so a pre-settlement snapshot reported a settled amount it had never
 *     observed.
 *
 * Every nested object is copied, and the result is deep-frozen so that a holder
 * of a snapshot cannot mutate it after the fact. Freezing turns a silent aliasing
 * bug into a loud TypeError.
 */
export function cloneRouteRecord(record: RouteRecord): RouteRecord {
  return {
    ...record,
    hops: record.hops.map((hop) => ({ ...hop, safety: { ...hop.safety }, inputAsset: { ...hop.inputAsset }, outputAsset: { ...hop.outputAsset } })),
    acceptance: { ...record.acceptance, authorizedSourceAsset: { ...record.acceptance.authorizedSourceAsset }, allowedIntermediateAsset: { ...record.acceptance.allowedIntermediateAsset } },
    fees: { ...record.fees },
    price: { ...record.price },
    sourceAsset: { ...record.sourceAsset },
    destinationAsset: { ...record.destinationAsset },
    recovery: { ...record.recovery },
    ...(record.pause === undefined ? {} : { pause: { ...record.pause } }),
    ...(record.settlementProof === undefined ? {} : { settlementProof: { ...record.settlementProof } }),
  };
}

/** Recursively freeze a route record and everything reachable from it. */
export function deepFreezeRouteRecord<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreezeRouteRecord((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function applyRouteEvent(record: RouteRecord, event: RouteEvent): RouteRecord {
  if (isTerminalRouteState(record.state)) {
    throw new IllegalTransitionError(`Illegal route transition: ${event.kind} from terminal state ${record.state}`);
  }
  const target = allowedRouteTargets(record, event);
  if (target === undefined) {
    throw new IllegalTransitionError(`Illegal route transition: ${event.kind} from ${record.state}`);
  }
  // Deep copy, never a shallow spread: see `cloneRouteRecord`.
  const next: RouteRecord = cloneRouteRecord(record);
  next.state = target;
  next.updatedAtUnixMs = Date.now();
  switch (event.kind) {
    case 'ACCEPT_ROUTE':
      return deepFreezeRouteRecord(next);
    case 'BEGIN_HOP1': {
      const [hop1] = next.hops;
      if (!hop1) throw new IllegalTransitionError('route has no hop 1');
      hop1.execution = 'EXECUTING';
      return deepFreezeRouteRecord(next);
    }
    case 'HOP1_SETTLED': {
      const [hop1] = next.hops;
      // Settling hop 1 REQUIRES the proven amount, and that amount must be a POSITIVE
      // integer. Accepting "0" (or a malformed value) would mark the cross-layer trade
      // settled while the intermediate TARI does not exist — silently losing the user's
      // money. Found by the route fuzzer; enforced here so no caller can skip it.
      if (event.settledAmountRaw === undefined) throw new IllegalTransitionError('hop 1 settlement must carry the PROVEN settled amount');
      if (!/^\d+$/.test(event.settledAmountRaw)) throw new IllegalTransitionError(`hop 1 settled amount ${event.settledAmountRaw} must be a raw non-negative integer string`);
      if (BigInt(event.settledAmountRaw) === 0n) throw new IllegalTransitionError('hop 1 settled amount is zero — the intermediate TARI would be lost');
      if (event.proofRef === undefined || event.proofRef.routeId !== next.routeId) {
        throw new IllegalTransitionError('hop 1 settlement must carry a proof reference bound to this route');
      }
      hop1.settlement = 'SETTLED';
      hop1.execution = 'CONFIRMED';
      hop1.settledAmountRaw = event.settledAmountRaw;
      next.settlementProof = event.proofRef;
      next.price.settledTariRaw = event.settledAmountRaw;
      return deepFreezeRouteRecord(next);
    }
    case 'HOP1_UNKNOWN': {
      const [hop1] = next.hops;
      hop1.execution = 'UNKNOWN';
      hop1.failureReason = event.reason;
      return deepFreezeRouteRecord(next);
    }
    case 'HOP1_FAILED': {
      const [hop1] = next.hops;
      hop1.execution = 'FAILED';
      hop1.settlement = 'FAILED_TERMINAL';
      hop1.failureReason = event.reason;
      next.failureReason = event.reason;
      return deepFreezeRouteRecord(next);
    }
    case 'BEGIN_HOP2_REQUOTE':
      return deepFreezeRouteRecord(next);
    case 'HOP2_READY': {
      const hop2 = next.hops[1];
      if (!hop2) throw new IllegalTransitionError('route has no hop 2');
      if (!hop2.safety.requiresSettlementProof) throw new IllegalTransitionError('hop 2 is not marked as requiring a settlement proof');
      if (next.settlementProof === undefined) {
        throw new IllegalTransitionError('hop 2 may not be READY without a hop-1 terminal settlement proof');
      }
      if (hop2.inputAmountRaw === undefined || hop2.inputAmountRaw === '' || BigInt(hop2.inputAmountRaw) <= 0n) {
        throw new IllegalTransitionError('hop 2 input amount must be the proven settled amount');
      }
      // The single-use binding: a proof may back exactly ONE hop-2 execution.
      if (next.proofConsumedByHop2 === true) {
        throw new IllegalTransitionError('hop-1 settlement proof has already been consumed by hop 2');
      }
      hop2.execution = 'NOT_STARTED';
      return deepFreezeRouteRecord(next);
    }
    case 'BEGIN_HOP2': {
      const hop2 = next.hops[1];
      if (next.settlementProof === undefined) throw new IllegalTransitionError('hop 2 may not execute without a settlement proof');
      if (next.proofConsumedByHop2 === true) throw new IllegalTransitionError('hop 2 already consumed the settlement proof — double execution refused');
      // The durable operation id is what makes a retry idempotent and what reconciliation
      // keys on, so it is validated here rather than trusted from the caller.
      requireOperationId(event.operationId);
      hop2.execution = 'EXECUTING';
      hop2.operationId = event.operationId;
      next.proofConsumedByHop2 = true;
      return deepFreezeRouteRecord(next);
    }
    case 'HOP2_SETTLED': {
      const hop2 = next.hops[1];
      // The FINAL output may never violate the user's accepted minimum, even if a buggy or
      // hostile caller reports a smaller settlement. The AMM hop enforces this at build
      // time; the route machine enforces it again so the invariant cannot be bypassed.
      if (!/^\d+$/.test(event.settledAmountRaw)) throw new IllegalTransitionError(`hop 2 settled amount ${event.settledAmountRaw} must be a raw non-negative integer string`);
      if (BigInt(event.settledAmountRaw) < BigInt(next.acceptance.minimumFinalOutputRaw)) {
        throw new IllegalTransitionError(`hop 2 settled amount ${event.settledAmountRaw} violates the accepted minimum final output ${next.acceptance.minimumFinalOutputRaw}`);
      }
      hop2.execution = 'CONFIRMED';
      hop2.settlement = 'SETTLED';
      hop2.chainTxId = event.chainTxId;
      hop2.settledAmountRaw = event.settledAmountRaw;
      next.price.ammExpectedOutputRaw = event.settledAmountRaw;
      return deepFreezeRouteRecord(next);
    }
    case 'HOP2_UNKNOWN': {
      const hop2 = next.hops[1];
      hop2.execution = 'UNKNOWN';
      hop2.failureReason = event.reason;
      return deepFreezeRouteRecord(next);
    }
    case 'HOP2_FAILED': {
      const hop2 = next.hops[1];
      hop2.execution = 'FAILED';
      hop2.failureReason = event.reason;
      // A failed hop 2 does NOT lose the intermediate TARI and does NOT fail the whole
      // route: hop 1 already settled for the user. The route PAUSES so the user can
      // requote, retry deliberately, or simply keep the TARI. A terminal failure here
      // would misreport a completed cross-layer trade as a total loss.
      next.pause = { reason: 'AMM_EXECUTION_FAILED', detail: event.reason, atUnixMs: Date.now() };
      return deepFreezeRouteRecord(next);
    }
    case 'SKIP_HOP2':
      return deepFreezeRouteRecord(next);
    case 'SETTLE_PARTIAL':
      return deepFreezeRouteRecord(next);
    case 'PAUSE':
      next.pause = { reason: event.reason, detail: event.detail, atUnixMs: Date.now() };
      return deepFreezeRouteRecord(next);
    case 'REQUIRE_REQUOTE':
      next.pause = { reason: 'INTERMEDIATE_SETTLED_REQUOTE_REQUIRED', detail: event.detail, atUnixMs: Date.now() };
      return deepFreezeRouteRecord(next);
    case 'HOP2_UNAVAILABLE':
      next.pause = { reason: event.reason, detail: event.detail, atUnixMs: Date.now() };
      return deepFreezeRouteRecord(next);
    case 'RESUME_REQUOTE':
      next.pause = undefined;
      return deepFreezeRouteRecord(next);
    case 'ENTER_RECOVERY':
      next.pause = { reason: 'AMM_QUOTE_EXPIRED', detail: event.reason, atUnixMs: Date.now() };
      return deepFreezeRouteRecord(next);
    case 'RESOLVE_CONTINUE':
      next.pause = undefined;
      return deepFreezeRouteRecord(next);
    case 'RESOLVE_SETTLED': {
      const hop2 = next.hops[1];
      // Recovery may only MARK a hop settled when durable evidence already proves what
      // committed. Without a hop-1 settlement proof and a known hop-2 transaction id, this
      // event would be a bypass: it could settle hop 2 (and the whole route) while hop 1
      // never settled at all. Found by the route fuzzer; the same preconditions as
      // HOP2_SETTLED are enforced here.
      if (next.settlementProof === undefined) {
        throw new IllegalTransitionError('recovery cannot settle hop 2 without a hop-1 terminal settlement proof');
      }
      if (next.hops[0].settlement !== 'SETTLED') {
        throw new IllegalTransitionError('recovery cannot settle hop 2 while hop 1 is unsettled');
      }
      if (hop2.chainTxId === undefined || hop2.chainTxId === '') {
        throw new IllegalTransitionError('recovery cannot settle hop 2 without the committed chain transaction id');
      }
      if (hop2.settledAmountRaw === undefined || !/^\d+$/.test(hop2.settledAmountRaw)) {
        throw new IllegalTransitionError('recovery cannot settle hop 2 without the proven output amount');
      }
      if (BigInt(hop2.settledAmountRaw) < BigInt(next.acceptance.minimumFinalOutputRaw)) {
        throw new IllegalTransitionError(`recovery output ${hop2.settledAmountRaw} violates the accepted minimum ${next.acceptance.minimumFinalOutputRaw}`);
      }
      hop2.settlement = 'SETTLED';
      hop2.execution = 'CONFIRMED';
      return deepFreezeRouteRecord(next);
    }
    case 'RESOLVE_SKIP':
      return deepFreezeRouteRecord(next);
    case 'FAIL_TERMINAL':
      next.failureReason = event.reason;
      return deepFreezeRouteRecord(next);
    default:
      return deepFreezeRouteRecord(next);
  }
}

/** Validate a newly constructed route record before it can be used. */
export function validateRouteRecord(record: RouteRecord): void {
  requireIdentifier(record.routeId, 'routeId');
  if (record.hops.length !== 2) throw new IllegalTransitionError('this phase supports exactly 2 hops (FAST_XTM_TARI + AMM_SWAP)');
  const [hop1, hop2] = record.hops;
  if (hop1.kind !== 'FAST_XTM_TARI') throw new IllegalTransitionError('hop 1 must be FAST_XTM_TARI');
  if (hop2.kind !== 'AMM_SWAP') throw new IllegalTransitionError('hop 2 must be AMM_SWAP');
  if (hop1.index !== 0 || hop2.index !== 1) throw new IllegalTransitionError('hop indexes must be 0 and 1');
  if (hop1.outputAsset.resourceAddress !== hop2.inputAsset.resourceAddress) {
    throw new IllegalTransitionError('hop 1 output asset must equal hop 2 input asset (exact identity)');
  }
  if (hop1.inputAsset.resourceAddress !== record.sourceAsset.resourceAddress) {
    throw new IllegalTransitionError('hop 1 input asset must equal the route source asset');
  }
  if (hop2.outputAsset.resourceAddress !== record.destinationAsset.resourceAddress) {
    throw new IllegalTransitionError('hop 2 output asset must equal the route destination asset');
  }
  // The intermediate asset must be canonical TARI by exact identity.
  if (!hop2.inputAsset.isCanonicalTari || hop2.inputAsset.kind !== 'OOTLE_L2') {
    throw new IllegalTransitionError('the intermediate asset must be canonical TARI on Ootle L2');
  }
  if (hop2.safety.requiresSettlementProof !== true) {
    throw new IllegalTransitionError('hop 2 must require a settlement proof');
  }
  for (const raw of [record.totalExpectedOutputRaw, record.totalMinimumOutputRaw, record.acceptance.minimumFinalOutputRaw, record.acceptance.authorizedSourceAmountRaw]) {
    if (!/^\d+$/.test(raw)) throw new IllegalTransitionError(`amount ${raw} must be a raw non-negative integer string`);
  }
  if (BigInt(record.totalMinimumOutputRaw) > BigInt(record.totalExpectedOutputRaw)) {
    throw new IllegalTransitionError('total minimum output cannot exceed total expected output');
  }
  if (record.fees.developerTradingFeeRaw !== '0') {
    throw new IllegalTransitionError('developer trading fee must be exactly zero — this protocol has no rake');
  }
  // The hard floor is non-negotiable: the route minimum may not exceed the accepted minimum.
  if (BigInt(record.totalMinimumOutputRaw) < BigInt(record.acceptance.minimumFinalOutputRaw)) {
    throw new IllegalTransitionError('route minimum output is below the user-accepted minimum final output');
  }
}

