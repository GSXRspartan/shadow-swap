/**
 * Execution service.
 *
 * The browser NEVER computes an execution result. This service is the only
 * place that drives the protocol-client pipeline:
 *
 *   DISCOVER (advisory)
 *     → resolveSwap / resolveAddLiquidity / resolveRemoveLiquidity
 *       (authoritative reread, exact quote, slippage, refusals)
 *     → executeResolved (persist PENDING → sign → submit → persist)
 *     → confirmSubmitted / reconcileOperation (poll by durable id)
 *
 * A React component receives the returned values and renders them. There is no
 * constant-product math, no reserve math, and no min_output derivation here.
 */

import {
  executeResolved,
  confirmSubmitted,
  reconcileOperation,
  requireFreshSubmissionAllowed,
  type FlowResult,
  type Freshness,
  type OperationRecord,
  type SigningTransport,
  type SwapIntentBuilder,
  type LiquidityIntentBuilder,
  type MarketplaceRouteBuilder,
  type TransactionLookup,
  type ChainTransactionStatus,
} from '@tari-ootle/protocol-client';
import type { TransactionPreview, TransactionResult } from '@tari-ootle/wallet-adapter';
import { toAmmPreview, toMarketplacePreview } from '@tari-ootle/wallet-adapter';
import { historyStore } from './history.js';
import { asRawExecutionAmount, asResourceAddress } from '../lib/tradeBoundary.js';
import { verifyIdentity, type ExecutionIdentity, type LiveIdentityInput, type IdentityCheck } from '../lib/executionIdentity.js';
import { diffReviewForIntent, type TransactionReview } from '../lib/review.js';

export interface ExecutionWallets {
  /** The generic wallet seam. */
  preview(preview: Partial<TransactionPreview>): Promise<TransactionPreview>;
  /**
   * `reviewedRequest` is the frozen request built from the review the user
   * approved. It is REQUIRED and is what the provider is asked to sign, so the
   * bytes that reach the signer are the bytes that were on screen. Re-deriving
   * the payload from a preview at this point would leave "shown == signed"
   * resting on two independent code paths happening to agree.
   */
  signAndSubmit(
    preview: TransactionPreview,
    context: SigningContext,
    reviewedRequest: Readonly<Record<string, unknown>>,
  ): Promise<TransactionResult>;
  getTransactionStatus(txId: string): Promise<{ status: string; epoch?: number; error?: string }>;
}

export interface SigningContext {
  /** Human-readable assets, so the wallet prompt is never opaque. */
  assets: string[];
  operation: string;
  network: string;
  poolOrDestination: string;
  privacyDisclosure: string;
}

function statusFrom(raw: string): ChainTransactionStatus {
  const upper = raw.toUpperCase();
  if (upper === 'COMMITTED' || upper === 'CONFIRMED' || upper === 'SUCCESS') return 'COMMITTED';
  if (upper === 'REJECTED' || upper === 'FAILED' || upper === 'ABORTED') return 'REJECTED';
  if (upper === 'NOT_FOUND') return 'NOT_FOUND';
  return 'UNKNOWN';
}

export function createTransactionLookup(wallets: ExecutionWallets): TransactionLookup {
  return {
    async statusByTransactionId(transactionId: string): Promise<ChainTransactionStatus> {
      const result = await wallets.getTransactionStatus(transactionId);
      return statusFrom(result.status);
    },
    async committedEpoch(transactionId: string): Promise<string | undefined> {
      const result = await wallets.getTransactionStatus(transactionId);
      return result.epoch === undefined ? undefined : String(result.epoch);
    },
  };
}

let operationCounter = 0;

/** Durable, client-generated operation identity. Not random-looking to the chain. */
export function newOperationId(prefix: string): string {
  operationCounter += 1;
  const random = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `${prefix}-${Date.now().toString(36)}-${operationCounter.toString(36)}-${random}`;
}

export interface ExecuteSwapInput<TIntent> {
  resolvedIntent: TIntent;
  recordInput: {
    operationId: string;
    operationKind: string;
    componentOrOrderId?: string;
    resources: string[];
    amounts: Record<string, string>;
    quote?: { quotedOutput: string; minOutput: string };
    epoch?: string;
    expiryEpoch?: string;
    lastReadback: Freshness;
  };
  toPreview: (intent: TIntent) => TransactionPreview;
  context: SigningContext;
  /**
   * The identity this review was built against, and the live identity re-derived
   * from the provider immediately before signing. Both are required: a caller
   * cannot skip the TOCTOU check.
   */
  identity: ExecutionIdentity;
  liveIdentity: LiveIdentityInput;
  /** The frozen review, so the wallet request is generated from it. */
  review: TransactionReview;
}

export class IdentityChangedError extends Error {
  constructor(readonly check: IdentityCheck) {
    super(check.reason ?? 'The wallet identity changed after this review was created.');
    this.name = 'IdentityChangedError';
  }
}

export class ReviewMismatchError extends Error {
  constructor(readonly mismatches: readonly string[]) {
    super(`The transaction under review does not match what will be submitted: ${mismatches.join('; ')}`);
    this.name = 'ReviewMismatchError';
  }
}

/**
 * Construct → verify identity → sign → submit → persist, via the
 * protocol-client's own flow.
 *
 * Two gates run immediately before the signing call:
 *
 *   1. IDENTITY. The provider object, its implementation fingerprint, the
 *      network, the account, and the advertised capabilities are all re-derived
 *      live and compared against the snapshot the user reviewed. Any change
 *      aborts, so an operation cannot be executed under a different identity
 *      than the one on screen.
 *   2. REVIEW. The review is re-diffed against the intent that will be signed.
 *      A mismatch aborts. This is the machine check behind "shown == signed".
 *
 * Both run on every submission, not once per session.
 */
export async function executeSwap<TIntent>(wallets: ExecutionWallets, input: ExecuteSwapInput<TIntent>): Promise<FlowResult> {
  input.recordInput.resources = input.recordInput.resources.map((resource, index) => asResourceAddress(resource, `resources[${index}]`));
  for (const [key, value] of Object.entries(input.recordInput.amounts)) asRawExecutionAmount(value, `amounts.${key}`);
  if (input.recordInput.quote !== undefined) {
    asRawExecutionAmount(input.recordInput.quote.quotedOutput, 'quote.quotedOutput');
    asRawExecutionAmount(input.recordInput.quote.minOutput, 'quote.minOutput');
  }

  // Gate 1: time-of-check / time-of-use.
  const check = verifyIdentity(input.identity, input.liveIdentity);
  if (!check.ok) throw new IdentityChangedError(check);

  // Gate 2: the review must describe the intent, using the differential that
  // matches the intent kind.
  const diff = diffReviewForIntent(input.review, input.resolvedIntent);
  if (!diff.ok) throw new ReviewMismatchError(diff.mismatches);

  // Gate 3: the request that will be signed must be derived from THIS review, and
  // it must be immutable. A review that is not deeply frozen can be mutated
  // between approval and signing, which would make every field checked above a
  // statement about the past rather than about what is about to be sent.
  if (!Object.isFrozen(input.review)) throw new ReviewMismatchError(['the review is not frozen and cannot be trusted at signing time']);
  if (!Object.isFrozen(input.review.walletRequest)) {
    throw new ReviewMismatchError(['the reviewed wallet request is not frozen and cannot be trusted at signing time']);
  }

  const transport: SigningTransport<WalletEnvelope> = {
    construct: (resolvedIntent: unknown) => ({ preview: input.toPreview(resolvedIntent as TIntent) }),
    async sign(envelope: WalletEnvelope) {
      // The provider receives the request generated from the frozen review, so
      // the amounts it is asked to sign are the amounts the user was shown.
      const result = await wallets.signAndSubmit(envelope.preview, input.context, input.review.walletRequest);
      return { ...envelope, transactionId: result.transactionId, epoch: result.epoch };
    },
    async submit(signed: WalletEnvelope) {
      if (signed.transactionId === undefined) {
        throw new Error('The wallet did not acknowledge a transaction id; the submission is recorded as UNKNOWN.');
      }
      return { transactionId: signed.transactionId };
    },
    lookup: createTransactionLookup(wallets),
  };

  return executeResolved<TIntent, WalletEnvelope>({
    resolvedIntent: input.resolvedIntent,
    recordInput: input.recordInput,
    history: historyStore,
    transport,
  });
}

export interface WalletEnvelope {
  preview: TransactionPreview;
  transactionId?: string;
  epoch?: number;
}

/** Poll the provider until the operation reaches a state the user can act on. */
export async function confirmOperation(record: OperationRecord, lookup: TransactionLookup): Promise<OperationRecord> {
  return confirmSubmitted({ record, history: historyStore, lookup });
}

/**
 * Reconcile a `PENDING` / `SUBMITTED` / `UNKNOWN` operation by durable id.
 *
 * There is deliberately no "retry" here. The protocol decides
 * `resubmissionAllowed` from an authoritative lookup, and the UI surfaces that
 * verdict.
 */
export async function reconcile(record: OperationRecord, lookup: TransactionLookup): Promise<{ record: OperationRecord; finalState: OperationRecord['state']; resubmissionAllowed: boolean; reason: string }> {
  const outcome = await reconcileOperation(record, lookup);
  // `reconcileOperation` does not persist; doing so here is the caller's job in
  // the protocol-client and the most common integration bug, so we do it once.
  await historyStore.save(outcome.record);
  return {
    record: outcome.record,
    finalState: outcome.finalState,
    resubmissionAllowed: outcome.resubmissionAllowed,
    reason: outcome.reason,
  };
}

export { requireFreshSubmissionAllowed };

/** Preview adapter for AMM intents built by the wallet-adapter wiring. */
export function ammPreview(preview: (intent: never) => TransactionPreview) {
  return (intent: unknown) => preview(intent as never);
}

export { toAmmPreview, toMarketplacePreview };
export type { SwapIntentBuilder, LiquidityIntentBuilder, MarketplaceRouteBuilder, FlowResult, OperationRecord };
