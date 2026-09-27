/**
 * Generic, chain-agnostic execution lifecycle shared by Ootle AMM/marketplace routes and
 * future cross-chain lanes (e.g. Minotari L1 XTM↔TARI atomic swaps).
 *
 * Layering contract:
 *   DISCOVER → AUTHORITATIVE REREAD → RESOLVE → CONSTRUCT → SIGN → SUBMIT → PERSIST
 *            → CONFIRM/RECONCILE
 *
 * Invariants:
 *  - Discovery (indexer/search) is advisory; execution decisions require authoritative
 *    chain state read immediately before construction.
 *  - A network timeout must NOT mean "submit again": the operation is persisted as
 *    UNKNOWN and reconciled by durable identifiers (see reconcileUnknownSubmission).
 *  - Skipping the authoritative reread is possible only by passing an explicit
 *    `unsafeAllowStaleConstruction: true` flag; no code path may do it silently.
 */

/** Which transport produced a read. Discovery sources must never gate settlement. */
export type ReadSource = 'CHAIN_NODE' | 'WALLET_PROVIDER' | 'INDEXER_SUBSTATE' | 'BROWSER_PROVIDER';

/** Authoritative = produced by CHAIN_NODE or WALLET_PROVIDER. */
export function isAuthoritativeSource(source: ReadSource): boolean {
  return source === 'CHAIN_NODE' || source === 'WALLET_PROVIDER';
}

/**
 * Freshness identity preserved from the authoritative read that a transaction was
 * constructed against. Any field the underlying chain exposes must be carried through;
 * consumers decide whether the state they built against is still current.
 */
export interface FreshnessIdentity {
  /** Component/substate version, state version, or equivalent monotonic version. */
  substateVersion?: string;
  /** Transaction hash that produced this state, when exposed. */
  producingTxHash?: string;
  /** Chain epoch at read time. */
  epoch?: string;
  /** Provider-defined opaque identity (e.g. full substate address + version). */
  stateIdentity?: string;
  readAtUnixMs: number;
}

export interface Freshness {
  source: ReadSource;
  identity: FreshnessIdentity;
}

/** Structured execution-readiness outcomes. */
export type ExecutionOutcomeStatus =
  | 'ACTIVE'
  | 'STALE'
  | 'UNAVAILABLE'
  | 'EXPIRED'
  | 'FILLED'
  | 'CANCELLED'
  | 'CONFLICTED';

export type ExecutionAuthoritativeRead<T> =
  | { status: 'FOUND'; value: T; freshness: Freshness }
  | { status: 'UNAVAILABLE'; reason: string };

export type Resolution<T> =
  | { status: 'ACTIVE'; value: T; freshness: Freshness }
  | { status: Exclude<ExecutionOutcomeStatus, 'ACTIVE'>; reason: string; freshness?: Freshness };

/** Result of handing a constructed transaction to a signer/transport. */
export type SubmissionState = 'SUBMITTED' | 'UNKNOWN';
export interface SubmissionReceipt {
  /** Durable client-side operation identifier (UUID-like), independent of chain tx id. */
  operationId: string;
  /** Chain transaction id when the transport acknowledged submission. */
  transactionId?: string;
  state: SubmissionReceiptState;
  submittedAtUnixMs: number;
  /** Transport error text when state is UNKNOWN. */
  transportError?: string;
}
export type SubmissionReceiptState = 'SUBMITTED' | 'UNKNOWN';

/** Authoritative transaction status for reconciliation. */
export type ChainTransactionStatus = 'COMMITTED' | 'REJECTED' | 'NOT_FOUND' | 'UNKNOWN';

/** A chain adapter must expose durable-id transaction lookup; used by reconciliation only. */
export interface TransactionLookup {
  statusByTransactionId(transactionId: string): Promise<ChainTransactionStatus>;
  /** Optional: epoch of the committing transaction, when the chain exposes it. */
  committedEpoch?(transactionId: string): Promise<string | undefined>;
}

export interface OperationRecord {
  /** Application-generated durable identifier (UUID). */
  operationId: string;
  operationKind: string;
  /** Chain transaction id, known only after an acknowledged submission. */
  transactionId?: string;
  state: OperationState;
  componentOrOrderId?: string;
  resources: string[];
  /** Raw on-chain amounts/quantities as decimal strings — never JS numbers. */
  amounts: Record<string, string>;
  /** Exact quoted output and the user-approved minimum, when the operation trades. */
  quote?: { quotedOutput: string; minOutput: string };
  epoch?: string;
  expiryEpoch?: string;
  createdAtUnixMs: number;
  submittedAtUnixMs?: number;
  confirmedAtUnixMs?: number;
  lastReadback?: Freshness;
  failureReason?: string;
}

export type OperationState = 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';

/** Application-owned durable persistence boundary. */
export interface HistoryStore {
  save(record: OperationRecord): Promise<void>;
  get(operationId: string): Promise<OperationRecord | undefined>;
  listByTransactionId?(transactionId: string): Promise<OperationRecord[]>;
  listUnknown?(): Promise<OperationRecord[]>;
}

/**
 * Reconciles a submission whose response was lost.
 *
 * NEVER resubmits on its own. Given durable identifiers it asks the authoritative
 * transaction lookup; only when the lookup authoritatively proves the transaction did NOT
 * commit (REJECTED or NOT_FOUND) may the caller rebuild and resubmit. When the transaction
 * id is unknown the record stays UNKNOWN — a network timeout is not evidence of failure.
 */
export async function reconcileUnknownSubmission(input: {
  record: OperationRecord;
  lookup: TransactionLookup;
}): Promise<Reconciliation> {
  const { record, lookup } = input;
  if (record.state !== 'UNKNOWN' && record.state !== 'SUBMITTED') {
    return { finalState: record.state, resubmissionAllowed: false, reason: 'Operation is not in a reconcilable state' };
  }
  if (!record.transactionId) {
    return {
      finalState: 'UNKNOWN',
      resubmissionAllowed: false,
      reason: 'No durable transaction id is known; a lost response is not evidence of failure. Recover the transaction id from the wallet/network before proceeding.',
    };
  }
  const status = await lookup.statusByTransactionId(record.transactionId);
  switch (status) {
    case 'COMMITTED':
      return { finalState: 'CONFIRMED', resubmissionAllowed: false, reason: 'Transaction committed; mark CONFIRMED with the recovered txid.' };
    case 'REJECTED':
      return { finalState: 'FAILED', resubmissionAllowed: true, reason: 'Authoritative lookup proves the transaction was rejected; resubmission is safe.' };
    case 'NOT_FOUND':
      return { finalState: 'FAILED', resubmissionAllowed: true, reason: 'Authoritative lookup proves no such transaction exists; resubmission is safe.' };
    case 'UNKNOWN':
    default:
      return { finalState: 'UNKNOWN', resubmissionAllowed: false, reason: 'Lookup has no authoritative answer yet; keep UNKNOWN and retry reconciliation later.' };
  }
}

export interface Reconciliation {
  finalState: OperationState;
  resubmissionAllowed: boolean;
  reason: string;
}

/** Guard against duplicate submission of an operation that already has a durable identity. */
export function assertSubmissionAllowed(record: OperationRecord): void {
  if (record.state === 'CONFIRMED') {
    throw new Error(`Operation ${record.operationId} is CONFIRMED; submitting it again would double-spend the intent`);
  }
  if (record.state === 'SUBMITTED' && record.transactionId) {
    throw new Error(`Operation ${record.operationId} already submitted (${record.transactionId}); reconcile instead of resubmitting`);
  }
  if (record.state === 'UNKNOWN') {
    throw new Error(`Operation ${record.operationId} is UNKNOWN; reconcile by durable identifier first`);
  }
}
