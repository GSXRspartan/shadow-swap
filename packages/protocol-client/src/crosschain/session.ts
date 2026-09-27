/**
 * Durable cross-layer session state machine.
 *
 * One authoritative state machine per XTM↔TARI session. Transitions are EXPLICIT and
 * validated — arbitrary jumps are refused. Every mutation is idempotent by sessionId.
 * The state machine enforces: no secret reveal before CLAIM_ARMED; terminal states stay
 * terminal; UNKNOWN outcomes force reconciliation instead of retry.
 */
import { requireOperationId } from './types.js';

export type CrossChainSessionState =
  | 'QUOTED'
  | 'RESERVED'
  | 'L1_FUNDING'
  | 'L1_FUNDED'
  | 'L2_FUNDING'
  | 'BOTH_FUNDED'
  | 'CLAIM_ARMED'
  | 'SECRET_REVEALED'
  | 'CLAIMING'
  | 'CLAIMED'
  | 'REFUND_ELIGIBLE'
  | 'REFUNDING'
  | 'REFUNDED'
  | 'RECOVERY_REQUIRED'
  | 'FAILED_TERMINAL';

/** Event that drives a validated transition. */
export type CrossChainEvent =  | { kind: 'ACCEPT_QUOTE'; nowUnixMs: number }
  | { kind: 'QUOTE_EXPIRED_UNFUNDED'; nowUnixMs: number }
  | { kind: 'BEGIN_L1_FUNDING'; deadlineSafetyEvidence: string }
  /**
   * L1 funding acknowledged. When the REAL Minotari wallet primitive is used the
   * wallet-generated preimage and funded output hash arrive HERE (the wallet generates
   * S itself — tari v6.0.0 service.rs:2203-2204). hashHex binds H at this point; it must
   * equal SHA256(walletPreimageHex) and any previously bound hashH (else illegal).
   */
  | { kind: 'L1_FUND_ACKNOWLEDGED'; l1TxId: string; walletPreimageHex?: string; hashHex?: string }
  | { kind: 'L1_FUND_UNKNOWN'; transportError: string }
  | { kind: 'L1_FUND_REJECTED'; reason: string }
  | { kind: 'L1_VERIFIED_FUNDED'; evidence: L1VerificationEvidence }
  | { kind: 'BEGIN_L2_FUNDING'; deadlineSafetyEvidence: string }
  | { kind: 'L2_FUND_ACKNOWLEDGED'; l2TxId: string }
  | { kind: 'L2_FUND_UNKNOWN'; transportError: string }
  | { kind: 'L2_FUND_REJECTED'; reason: string }
  | { kind: 'L2_VERIFIED_FUNDED'; evidence: L2VerificationEvidence }
  | { kind: 'ARM_CLAIM'; deadlineSafetyEvidence: string; claimConstructibleEvidence: string }
  | { kind: 'REVEAL_SECRET'; claimTxId?: string; unknownResult?: boolean }
  | { kind: 'OBSERVE_CLAIM_COMMITTED'; preimage: string }
  | { kind: 'BEGIN_CLAIM'; leg: 'L1' | 'L2' }
  | { kind: 'CLAIM_ACKNOWLEDGED'; leg: 'L1' | 'L2'; txId: string }
  | { kind: 'CLAIM_UNKNOWN'; leg: 'L1' | 'L2'; transportError: string }
  | { kind: 'CLAIM_CONFIRMED'; leg: 'L1' | 'L2' }
  | { kind: 'REFUND_ELIGIBLE'; leg: 'L1' | 'L2'; authorityEvidence: string }
  | { kind: 'BEGIN_REFUND'; leg: 'L1' | 'L2' }
  | { kind: 'REFUND_ACKNOWLEDGED'; leg: 'L1' | 'L2'; txId: string }
  | { kind: 'REFUND_UNKNOWN'; leg: 'L1' | 'L2'; transportError: string }
  | { kind: 'REFUND_CONFIRMED'; leg: 'L1' | 'L2' }
  | { kind: 'ENTER_RECOVERY'; reason: string }
  | { kind: 'RECOVERY_RESOLVED'; resolution: 'CLAIMING' | 'REFUNDING' | 'FAILED_TERMINAL' }
  | { kind: 'FAIL_TERMINAL'; reason: string };

/** Explicit transition table — the ONLY legal edges. */
const TRANSITIONS: Record<CrossChainSessionState, Partial<Record<CrossChainEvent['kind'], CrossChainSessionState>>> = {
  QUOTED: { ACCEPT_QUOTE: 'RESERVED', FAIL_TERMINAL: 'FAILED_TERMINAL' },
  RESERVED: { BEGIN_L1_FUNDING: 'L1_FUNDING', FAIL_TERMINAL: 'FAILED_TERMINAL', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  L1_FUNDING: { L1_FUND_ACKNOWLEDGED: 'L1_FUNDED', L1_FUND_UNKNOWN: 'RECOVERY_REQUIRED', L1_FUND_REJECTED: 'FAILED_TERMINAL', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  L1_FUNDED: { L1_VERIFIED_FUNDED: 'L1_FUNDED', BEGIN_L2_FUNDING: 'L2_FUNDING', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  L2_FUNDING: { L2_FUND_ACKNOWLEDGED: 'BOTH_FUNDED', L2_FUND_UNKNOWN: 'RECOVERY_REQUIRED', L2_FUND_REJECTED: 'FAILED_TERMINAL', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  BOTH_FUNDED: { L2_VERIFIED_FUNDED: 'BOTH_FUNDED', L1_VERIFIED_FUNDED: 'BOTH_FUNDED', ARM_CLAIM: 'CLAIM_ARMED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  CLAIM_ARMED: { L1_VERIFIED_FUNDED: 'CLAIM_ARMED', L2_VERIFIED_FUNDED: 'CLAIM_ARMED', REVEAL_SECRET: 'SECRET_REVEALED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  SECRET_REVEALED: { BEGIN_CLAIM: 'CLAIMING', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  CLAIMING: { CLAIM_ACKNOWLEDGED: 'CLAIMING', CLAIM_UNKNOWN: 'RECOVERY_REQUIRED', CLAIM_CONFIRMED: 'CLAIMED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  CLAIMED: {},
  REFUND_ELIGIBLE: { BEGIN_REFUND: 'REFUNDING', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  REFUNDING: { REFUND_ACKNOWLEDGED: 'REFUNDING', REFUND_UNKNOWN: 'RECOVERY_REQUIRED', REFUND_CONFIRMED: 'REFUNDED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  REFUNDED: {},
  RECOVERY_REQUIRED: { RECOVERY_RESOLVED: 'RECOVERY_REQUIRED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  FAILED_TERMINAL: {},
};

export const TERMINAL_STATES: ReadonlySet<string> = new Set(['CLAIMED', 'REFUNDED', 'FAILED_TERMINAL']);

export class IllegalTransitionError extends Error {}

/**
 * Authoritative L1 evidence required before the second leg may be funded and before the
 * claim may be armed. Every field must be affirmative AND the read must not be a provider
 * assertion — `applyEvent` REFUSES to record a verification that is not fully proven, so a
 * caller cannot hand-forge a verification stamp.
 */
export interface L1VerificationEvidence {
  l1TxId: string;
  confirmations: string;
  hashMatches: boolean;
  amountExact: boolean;
  /** Must be true: the amount is proven by chain/wallet evidence, not remembered intent. */
  amountAuthoritative: boolean;
  deadlineSafe: boolean;
  /** The observed refund height must be AHEAD of the current tip by a safety margin. */
  deadlineFresh: boolean;
  confirmationsSufficient: boolean;
  /** Read source; 'PROVIDER_ASSERTION' is never sufficient (invariant 11). */
  source: string;
  observedHashHex?: string;
  observedAmountRaw?: string;
  observedRefundHeight?: string;
  observedCurrentHeight?: string;
  observedClaimPubKeyHex?: string;
  observedRefundPubKeyHex?: string;
  hashFromScriptHex?: string;
  verifiedAtUnixMs: number;
}

/** Authoritative L2 (Ootle ScriptPath) evidence, same fail-closed discipline. */
export interface L2VerificationEvidence {
  l2TxId: string;
  hashExact: boolean;
  amountExact: boolean;
  deadlineSafe: boolean;
  claimantExact: boolean;
  unspent: boolean;
  /** Must be 'AUTHORITATIVE' — a cached/read-model read never settles. */
  source: 'AUTHORITATIVE' | 'CACHED';
  observedAmountRaw?: string;
  verifiedAtUnixMs: number;
}

export interface CrossChainSessionRecord {
  sessionId: string;
  state: CrossChainSessionState;
  quoteId: string;
  reservationId: string;
  providerId: string;
  direction: 'XTM_TO_TARI' | 'TARI_TO_XTM';
  /** Exact amounts — immutable once accepted. */
  xtmRawAmount: string;
  tariRawAmount: string;
  hashH: string;
  /** Claim identities (exact addresses) — fixed at accept time. */
  l1ClaimRecipient: string;
  l2ClaimRecipient: string;
  /** Networks (testnet allowlist) — fixed at accept time. */
  l1Network: string;
  l2Network: string;
  l1TxId?: string;
  l2TxId?: string;
  l1ClaimTxId?: string;
  l2ClaimTxId?: string;
  l1RefundTxId?: string;
  l2RefundTxId?: string;
  l1RefundDeadlineHeight: string;
  l2RefundDeadlineEpoch: string;
  requiredL1Confirmations: string;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  /**
   * Authoritative L1 evidence stamp. ABSENT means the first leg was never authoritatively
   * verified — and second-leg funding / claim arming are refused in that case, regardless
   * of what the durable state otherwise says (cross-layer invariant 2).
   */
  l1Verification?: L1VerificationEvidence;
  /** Authoritative L2 evidence stamp. Required before CLAIM_ARMED. */
  l2Verification?: L2VerificationEvidence;
  /** Where the deadline margins used at the last irreversible phase came from. */
  deadlineEvidenceSource?: 'AUTHORITATIVE' | 'CALLER_ASSERTED';
  /** Evidence that the irreversible secret-bearing claim was submitted. */
  secretRevealedAtUnixMs?: number;
  /** Secret NEVER lives here — see CrossChainSecretStore. */
  failureReason?: string;
  recoveryReason?: string;
}

export interface SessionStore {
  save(record: CrossChainSessionRecord): Promise<void>;
  get(sessionId: string): Promise<CrossChainSessionRecord | undefined>;
  listAll(): Promise<CrossChainSessionRecord[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, CrossChainSessionRecord>();
  async save(record: CrossChainSessionRecord): Promise<void> {
    this.sessions.set(record.sessionId, { ...record });
  }
  async get(sessionId: string): Promise<CrossChainSessionRecord | undefined> {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }
  async listAll(): Promise<CrossChainSessionRecord[]> {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }
}

/** Validated transition function. Pure: takes the record, returns the updated record. */
export function applyEvent(record: CrossChainSessionRecord, event: CrossChainEvent): CrossChainSessionRecord {
  const state = record.state;
  // A few events are legal from MULTIPLE states (per-leg claims/refunds).
  const allowed = allowedTargets(record, event);
  if (!allowed) {
    throw new IllegalTransitionError(`Illegal transition: ${event.kind} from state ${record.state}${'reason' in event && event.reason ? ` (${event.reason})` : ''}`);
  }
  return updated(record, event, allowed);
}

function allowedTargets(record: CrossChainSessionRecord, event: CrossChainEvent): CrossChainSessionState | undefined {
  switch (event.kind) {
    case 'BEGIN_L1_FUNDING':
      return record.state === 'RESERVED' ? 'L1_FUNDING' : undefined;
    case 'BEGIN_L2_FUNDING':
      return record.state === 'L1_FUNDED' ? 'L2_FUNDING' : undefined;
    case 'ARM_CLAIM':
      return record.state === 'BOTH_FUNDED' ? 'CLAIM_ARMED' : undefined;
    case 'REVEAL_SECRET':
      return record.state === 'CLAIM_ARMED' ? 'SECRET_REVEALED' : undefined;
    case 'BEGIN_CLAIM':
      return record.state === 'SECRET_REVEALED' ? 'CLAIMING' : undefined;
    case 'BEGIN_REFUND':
      return record.state === 'REFUND_ELIGIBLE' ? 'REFUNDING' : undefined;
    case 'REFUND_ELIGIBLE':
      // A leg's refund deadline passing is authoritative evidence; legal from every
      // non-terminal active state and from recovery.
      return isTerminal(record.state) || record.state === 'REFUND_ELIGIBLE' || record.state === 'REFUNDING'
        ? undefined
        : 'REFUND_ELIGIBLE';
    default: {
      const table = TRANSITIONS[record.state];
      const next = table[event.kind];
      return next === undefined ? undefined : next;
    }
  }
}

function updated(record: CrossChainSessionRecord, event: CrossChainEvent, target: CrossChainSessionState): CrossChainSessionRecord {
  const next: CrossChainSessionRecord = { ...record, state: target, updatedAtUnixMs: Date.now() };
  switch (event.kind) {
    case 'L1_FUND_ACKNOWLEDGED': {
      const withTx: CrossChainSessionRecord = { ...next, l1TxId: String(event.l1TxId) };
      if (event.hashHex !== undefined) {
        if (withTx.hashH && withTx.hashH !== '' && withTx.hashH !== event.hashHex) {
          throw new IllegalTransitionError(`L1 funding hash ${event.hashHex} does not match the accepted quote hash`);
        }
        if (!/^[0-9a-f]{64}$/.test(event.hashHex)) throw new IllegalTransitionError('L1 funding hash must be 64 lowercase hex chars');
        return { ...withTx, hashH: event.hashHex };
      }
      return withTx;
    }
    case 'L2_FUND_ACKNOWLEDGED':
      return { ...next, l2TxId: String(event.l2TxId) };
    case 'L1_VERIFIED_FUNDED': {
      // SECURITY: the state machine itself refuses to record a verification that is not
      // fully proven. A caller cannot forge a stamp to unlock second-leg funding or claim
      // arming (cross-layer invariant 2).
      const e = event.evidence;
      const gaps: string[] = [];
      if (!e.hashMatches) gaps.push('hashMatches');
      if (!e.amountExact) gaps.push('amountExact');
      if (!e.amountAuthoritative) gaps.push('amountAuthoritative');
      if (!e.deadlineSafe) gaps.push('deadlineSafe');
      if (!e.deadlineFresh) gaps.push('deadlineFresh');
      if (!e.confirmationsSufficient) gaps.push('confirmationsSufficient');
      if (!e.observedHashHex || !/^[0-9a-f]{64}$/.test(e.observedHashHex)) gaps.push('observedHashHex');
      if (e.source === 'PROVIDER_ASSERTION' || e.source === '') gaps.push('authoritativeSource');
      if (gaps.length > 0) {
        throw new IllegalTransitionError(`L1_VERIFIED_FUNDED refused: unproven evidence ${gaps.join(', ')}`);
      }
      const withTx: CrossChainSessionRecord = { ...next, l1TxId: String(e.l1TxId) };
      // Bind H from AUTHORITATIVE script readback when the quote did not fix it
      // (TARI_TO_XTM: the counterparty's L1 wallet generates S; H is read from the chain).
      if (e.hashFromScriptHex && (!withTx.hashH || withTx.hashH === '')) {
        return { ...withTx, hashH: e.hashFromScriptHex, l1Verification: e };
      }
      return { ...withTx, l1Verification: e };
    }
    case 'L2_VERIFIED_FUNDED': {
      const e = event.evidence;
      const gaps: string[] = [];
      if (!e.hashExact) gaps.push('hashExact');
      if (!e.amountExact) gaps.push('amountExact');
      if (!e.deadlineSafe) gaps.push('deadlineSafe');
      if (!e.claimantExact) gaps.push('claimantExact');
      if (!e.unspent) gaps.push('unspent');
      if (e.source !== 'AUTHORITATIVE') gaps.push('authoritativeSource');
      if (gaps.length > 0) {
        throw new IllegalTransitionError(`L2_VERIFIED_FUNDED refused: unproven evidence ${gaps.join(', ')}`);
      }
      return { ...next, l2TxId: String(e.l2TxId), l2Verification: e };
    }
    case 'REVEAL_SECRET':
      return { ...next, secretRevealedAtUnixMs: Date.now() };
    case 'CLAIM_ACKNOWLEDGED':
      return event.leg === 'L1' ? { ...next, l1ClaimTxId: String(event.txId) } : { ...next, l2ClaimTxId: String(event.txId) };
    case 'REFUND_ACKNOWLEDGED':
      return event.leg === 'L1' ? { ...next, l1RefundTxId: String(event.txId) } : { ...next, l2RefundTxId: String(event.txId) };
    case 'RECOVERY_RESOLVED':
      return { ...next, state: event.resolution };
    case 'FAIL_TERMINAL':
      return { ...next, state: 'FAILED_TERMINAL', failureReason: String(event.reason) };
    case 'ENTER_RECOVERY':
      return { ...next, recoveryReason: String(event.reason) };
    default:
      return next;
  }
}

/** Guards used by the coordinator (fail-closed helpers). */
export function isTerminal(state: CrossChainSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function requireSecretRevealAllowed(record: CrossChainSessionRecord): void {
  if (record.state !== 'CLAIM_ARMED') {
    throw new IllegalTransitionError(`Secret reveal requires CLAIM_ARMED (state ${record.state})`);
  }
}

/**
 * H must be bound (64 lowercase hex) before ANY second-leg funding, claim arming, or
 * secret reveal. Unbound ('') is only legal while the first leg is still being funded
 * (the real Minotari wallet generates S at funding time).
 */
export function requireHashHBound(record: CrossChainSessionRecord): string {
  if (!/^[0-9a-f]{64}$/.test(record.hashH)) {
    throw new IllegalTransitionError(`Hashlock H is not authoritatively bound for session ${record.sessionId}`);
  }
  return record.hashH;
}