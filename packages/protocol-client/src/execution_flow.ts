/**
 * Generic execution/reconciliation lifecycle: construct → sign → submit → confirm.
 * This is the reusable spine for Ootle AMM/marketplace routes today and for a future
 * Minotari L1 adapter (interfaces in chains/minotari.ts). It is deliberately NOT
 * Ootle-specific beyond the injected ports.
 *
 * Unsafe-override policy: constructing against state that was NOT freshly re-read
 * authoritatively is possible only by passing explicit flags — never silently.
 */
import { Freshness, OperationRecord, TransactionLookup } from './execution.js';
import { ProtocolHistoryStore } from './history.js';

/** Layers are separate: a signer is injected; nothing here requires walletd specifically. */
export interface SigningTransport<TEnvelope> {
  /** Layer 1 — CONSTRUCT: wrap a resolver-produced intent into a signable envelope. */
  construct(resolvedIntent: unknown): TEnvelope;
  /** Layer 2 — SIGN (may prompt the user/wallet). */
  sign(envelope: TEnvelope, freshness: Freshness): Promise<TEnvelope>;
  /** Layer 3 — SUBMIT. Returns the durable chain tx id when the transport ACKS. */
  submit(signed: TEnvelope): Promise<{ transactionId?: string }>;
  /** Authoritative transaction lookup for confirm/reconcile. */
  lookup: TransactionLookup;
}

export interface ExecutionRecordInput {
  operationId: string;
  operationKind: string;
  componentOrOrderId?: string;
  resources: string[];
  amounts: Record<string, string>;
  quote?: { quotedOutput: string; minOutput: string };
  epoch?: string;
  expiryEpoch?: string;
  /** Freshness of the authoritative read the intent was constructed against. */
  lastReadback: Freshness;
}

export type FlowResult =
  | { outcome: 'SUBMITTED'; transactionId: string; record: OperationRecord }
  | { outcome: 'UNKNOWN'; record: OperationRecord; transportError: string }
  | { outcome: 'FAILED'; record: OperationRecord; reason: string };

/**
 * Explicitly-unsafe stale-construction override. Frontends cannot skip the authoritative
 * reread by accident: they must construct this flags object themselves — grep-able and
 * auditable, never silent.
 */
export interface UnsafeConstructionFlags {
  confirmUnsafeStaleConstruction: true;
  reason: string;
}

function isAuthoritativeFreshness(freshness: Freshness): boolean {
  return (
    freshness.source === 'CHAIN_NODE' ||
    freshness.source === 'WALLET_PROVIDER' ||
    freshness.identity.stateIdentity !== undefined ||
    freshness.identity.substateVersion !== undefined
  );
}

/**
 * AWAITING-APPROVAL IS NOT A FAILURE — AND MUST NOT BE PERMITTED TO BECOME ONE.
 *
 * A wallet that offers durable transaction requests issues a `requestId` and then
 * waits for a human. If the human has not answered, NOTHING was submitted, the
 * wallet request still EXISTS, and the operation is recoverable by that id.
 *
 * The defect this type exists to prevent: the sign layer reports "still awaiting
 * approval" as an error, and a generic catch records the durable operation as
 * `FAILED`. That is a lie with a financial consequence. The user is shown a
 * failure, the pending wallet request is out of sight, and the natural next action
 * — press the button again — mints a SECOND durable request. If the user then
 * answers both popups, TWO financial submissions broadcast for one intent. That is
 * exactly the duplicate-submission outcome the durable-record design exists to
 * make impossible, and it was reachable because a non-error was typed as an error.
 *
 * The rule this encodes: `AWAITING_APPROVAL` is recorded as recoverable `PENDING`,
 * and `requireFreshSubmissionAllowed` refuses a fresh submission for such a record.
 * The user must approve, cancel, or explicitly discard the existing request first.
 *
 * `Symbol.for` is deliberate: the marker must survive being observed across a
 * bundler chunk boundary or a duplicated module instance, so the two sides of the
 * `instanceof`-free check cannot disagree merely because they are different objects.
 */
export const AWAITING_APPROVAL: symbol = Symbol.for('tari.ootle.awaitingWalletApproval');

/** The exact `failureReason` stamped on a record that is recoverable by a durable request id. */
export const AWAITING_APPROVAL_REASON = 'AWAITING_WALLET_APPROVAL';

export type AwaitingApprovalError = Error & { readonly [AWAITING_APPROVAL]: true };

/**
 * Build the typed "the human has not answered yet" signal.
 *
 * This is an `Error` so it travels through ordinary `throw`/`catch` and cannot be
 * mistaken for a value, but its brand is what callers must branch on — never its
 * message text, which a provider is free to word however it likes.
 */
export function awaitingApproval(message: string): AwaitingApprovalError {
  const error = new Error(message) as AwaitingApprovalError;
  Object.defineProperty(error, AWAITING_APPROVAL, { value: true, enumerable: false, writable: false, configurable: false });
  return error;
}

/** True only for the brand above. A same-worded error from anywhere else is NOT awaiting approval. */
export function isAwaitingApproval(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[AWAITING_APPROVAL] === true;
}

/** True for the `failureReason` this module stamps on a recoverable pending record. */
export function isAwaitingApprovalReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(AWAITING_APPROVAL_REASON);
}

/** Creates the durable record and runs the submit layers with UNKNOWN-safe handling. */
export async function executeResolved<TIntent, TEnvelope>(input: {
  resolvedIntent: TIntent;
  recordInput: ExecutionRecordInput;
  history: ProtocolHistoryStore;
  transport: SigningTransport<TEnvelope>;
  /** Omit to enforce the authoritative-freshness requirement; pass deliberately to override. */
  unsafe?: UnsafeConstructionFlags;
}): Promise<FlowResult> {
  if (input.unsafe) {
    // The caller explicitly chose to construct against possibly-stale state. Persist the
    // choice so it is auditable rather than invisible.
    input.recordInput.epoch = input.recordInput.epoch ?? 'UNSAFE_STALE_CONSTRUCTION';
  }
  let record: OperationRecord = {
    operationId: input.recordInput.operationId,
    operationKind: input.recordInput.operationKind,
    state: 'PENDING',
    componentOrOrderId: input.recordInput.componentOrOrderId,
    resources: [...input.recordInput.resources],
    amounts: { ...input.recordInput.amounts },
    quote: input.recordInput.quote ? { ...input.recordInput.quote } : undefined,
    epoch: input.recordInput.epoch,
    expiryEpoch: input.recordInput.expiryEpoch,
    createdAtUnixMs: Date.now(),
    lastReadback: input.recordInput.lastReadback,
  };
  await input.history.save(record);

  // Layer 1: CONSTRUCT was performed by the resolver. Without an explicit unsafe flag,
  // the freshness carried by the record must come from an authoritative read.
  if (input.unsafe?.confirmUnsafeStaleConstruction !== true) {
    if (!isAuthoritativeFreshness(input.recordInput.lastReadback)) {
      const reason = 'Execution refused: intent was not constructed from an authoritative read (pass unsafe.confirmUnsafeStaleConstruction deliberately to override)';
      record = { ...record, state: 'FAILED', failureReason: reason };
      await input.history.save(record);
      return { outcome: 'FAILED', record, reason };
    }
  }

  // Layer 2: SIGN
  let signed: TEnvelope;
  try {
    const envelope = input.transport.construct(input.resolvedIntent);
    signed = await input.transport.sign(envelope, input.recordInput.lastReadback);
  } catch (error) {
    const reason = `SIGN failed: ${(error as Error).message}`;
    // "The wallet is still waiting for the human" is NOT a failure. Recording it as
    // FAILED would hide a live durable wallet request behind a red state and invite
    // the user to start a second one. The record stays PENDING so it remains
    // recoverable, and `requireFreshSubmissionAllowed` then blocks a resubmission.
    if (isAwaitingApproval(error)) {
      record = { ...record, state: 'PENDING', failureReason: `${AWAITING_APPROVAL_REASON}: ${(error as Error).message}` };
      await input.history.save(record);
      return { outcome: 'UNKNOWN', record, transportError: reason };
    }
    record = { ...record, state: 'FAILED', failureReason: reason };
    await input.history.save(record);
    return { outcome: 'FAILED', record, reason };
  }

  // Duplicate-submission guard on the persisted identity.
  if (record.state === 'UNKNOWN') {
    return { outcome: 'UNKNOWN', record, transportError: 'record is UNKNOWN; reconcile first' };
  }
  if (record.state === 'CONFIRMED' || (record.state === 'SUBMITTED' && record.transactionId)) {
    return { outcome: 'FAILED', record, reason: 'Duplicate submission refused; reconcile the existing operation instead' };
  }

  // Layer 3: SUBMIT — a lost response becomes UNKNOWN, never an automatic retry.
  let submitResponse: { transactionId?: string };
  try {
    submitResponse = await input.transport.submit(signed);
  } catch (error) {
    record = { ...record, state: 'UNKNOWN', submittedAtUnixMs: Date.now(), failureReason: `TRANSPORT_UNKNOWN: ${(error as Error).message}` };
    await input.history.save(record);
    return { outcome: 'UNKNOWN', record, transportError: (error as Error).message };
  }
  if (!submitResponse.transactionId) {
    record = { ...record, state: 'UNKNOWN', submittedAtUnixMs: Date.now(), failureReason: 'TRANSPORT_UNKNOWN: submit returned no transaction id' };
    await input.history.save(record);
    return { outcome: 'UNKNOWN', record, transportError: 'submit returned no transaction id' };
  }
  record = { ...record, state: 'SUBMITTED', transactionId: submitResponse.transactionId, submittedAtUnixMs: Date.now() };
  await input.history.save(record);
  return { outcome: 'SUBMITTED', transactionId: submitResponse.transactionId, record };
}

/** Layer 4: CONFIRM via authoritative lookup (never the UI). */
export async function confirmSubmitted(input: { record: OperationRecord; history: ProtocolHistoryStore; lookup: TransactionLookup }): Promise<OperationRecord> {
  if (!input.record.transactionId) return input.record;
  const status = await input.lookup.statusByTransactionId(input.record.transactionId);
  if (status === 'COMMITTED') {
    const confirmed = { ...input.record, state: 'CONFIRMED' as const, confirmedAtUnixMs: Date.now() };
    await input.history.save(confirmed);
    return confirmed;
  }
  if (status === 'REJECTED') {
    const failed = { ...input.record, state: 'FAILED' as const, failureReason: 'Transaction rejected on-chain' };
    await input.history.save(failed);
    return failed;
  }
  return input.record; // stays SUBMITTED until an authoritative answer exists
}
