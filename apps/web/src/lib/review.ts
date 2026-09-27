/**
 * TRANSACTION REVIEW MODEL (mission §10, §11, §38).
 *
 * The primary security question is: **can the user be shown one thing but
 * authorize or execute something else?**
 *
 * The previous shape answered "no" by convention: the UI rendered fields from
 * component state, the intent was built separately by the resolver, and
 * `executeResolved` sent the intent. Nothing forced those two to agree, so any
 * future edit that mixed a display value into a builder argument would silently
 * produce approval confusion.
 *
 * This inverts the direction. The review is built FROM the immutable intent that
 * will be signed — never from component state — and the wallet request is built
 * FROM the review. Display and submission are therefore two views of one frozen
 * object. `diffReviewAgainstIntent` is the differential test: it compares every
 * security-relevant field of the review against the intent it claims to
 * describe, and any mismatch is a failure.
 *
 * Amounts are raw integer strings throughout. No `Number` ever carries one.
 */

import type { ExecutionIdentity } from './executionIdentity.js';
import { asRawExecutionAmount, asResourceAddress } from './tradeBoundary.js';

export type ReviewOperation = 'AMM_SWAP' | 'AMM_ADD_LIQUIDITY' | 'AMM_REMOVE_LIQUIDITY' | 'NFT_BUY_NOW' | 'NFT_SELL_NOW' | 'NFT_ACCEPT_ITEM_OFFER';

export interface ReviewAmount {
  /** EXACT resource identity. A symbol is never used here. */
  resourceAddress: string;
  /** Raw base units. Exact, non-negative integer string. */
  amountRaw: string;
  role: 'INPUT' | 'OUTPUT' | 'MINIMUM' | 'ESCROW' | 'FEE';
  /** Present for NFT legs, where the quantity is an identifier, not an amount. */
  nftId?: string;
}

export interface ReviewLeg {
  operation: ReviewOperation;
  componentAddress: string;
  method: string;
  amounts: readonly ReviewAmount[];
  /** On-chain bound. Present whenever the underlying operation has one. */
  minOutputRaw?: string;
  maxEpochRaw?: string;
}

/**
 * The frozen object the user reviews AND the object the wallet request is built
 * from. Deep-frozen, so nothing can adjust an approved amount.
 */
export interface TransactionReview {
  readonly operationId: string;
  readonly network: string;
  readonly account: string;
  readonly identity: ExecutionIdentity;
  readonly legs: readonly ReviewLeg[];
  readonly createdAtUnixMs: number;
  /**
   * The exact serialized payload handed to the provider. Built from the review,
   * so it cannot describe a different transaction.
   */
  readonly walletRequest: Readonly<Record<string, unknown>>;
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) freezeDeep((value as Record<string, unknown>)[key]);
  return value;
}

export class ReviewViolationError extends Error {
  constructor(message: string) {
    super(`Transaction review refused: ${message}`);
    this.name = 'ReviewViolationError';
  }
}

function validateAmounts(amounts: readonly ReviewAmount[], operation: string): readonly ReviewAmount[] {
  if (amounts.length === 0) throw new ReviewViolationError(`${operation} has no named amounts, so a signer could not be told what is being spent.`);
  const out = amounts.map((amount) => {
    asResourceAddress(amount.resourceAddress, `${operation}.resourceAddress`);
    asRawExecutionAmount(amount.amountRaw, `${operation}.amountRaw`);
    return Object.freeze({ ...amount, resourceAddress: amount.resourceAddress, amountRaw: amount.amountRaw });
  });
  return Object.freeze(out);
}

/**
 * Build the wallet request FROM the review. The provider sees exactly the
 * amounts the user was shown, because both come from the same object.
 */
export function buildWalletRequest(review: Omit<TransactionReview, 'walletRequest'>): Readonly<Record<string, unknown>> {
  const transaction = {
    operationId: review.operationId,
    network: review.network,
    account: review.account,
    legs: review.legs.map((leg) => ({
      operation: leg.operation,
      componentAddress: leg.componentAddress,
      method: leg.method,
      args: leg.amounts.map((amount) => ({
        resourceAddress: amount.resourceAddress,
        amountRaw: amount.amountRaw,
        role: amount.role,
        nftId: amount.nftId,
      })),
      minOutputRaw: leg.minOutputRaw,
      maxEpochRaw: leg.maxEpochRaw,
    })),
  };
  // Machine-readable context for a wallet that supports it, so a signing prompt
  // can be more than an opaque blob.
  const display = {
    operation: review.legs.map((leg) => `${leg.operation} on ${leg.componentAddress}`).join('; '),
    network: review.network,
    account: review.account,
    assets: review.legs.flatMap((leg) => leg.amounts.map((amount) => `${amount.amountRaw} of ${amount.resourceAddress}`)),
  };
  return Object.freeze({ transaction: freezeDeep(transaction), display: freezeDeep(display) });
}

export function createReview(input: {
  operationId: string;
  network: string;
  account: string;
  identity: ExecutionIdentity;
  legs: ReviewLeg[];
  createdAtUnixMs?: number;
}): TransactionReview {
  if (input.network.trim() === '') throw new ReviewViolationError('a review must name the network it is bound to');
  if (input.account.trim() === '') throw new ReviewViolationError('a review must name the account it is bound to');
  if (input.operationId.trim() === '') throw new ReviewViolationError('a review must carry a durable operation id');
  if (input.legs.length === 0) throw new ReviewViolationError('a review must contain at least one leg');

  const legs = Object.freeze(
    input.legs.map((leg) => {
      const amounts = validateAmounts(leg.amounts, leg.operation);
      if (leg.minOutputRaw !== undefined) asRawExecutionAmount(leg.minOutputRaw, `${leg.operation}.minOutputRaw`);
      if (leg.maxEpochRaw !== undefined) asRawExecutionAmount(leg.maxEpochRaw, `${leg.operation}.maxEpochRaw`);
      if (leg.minOutputRaw !== undefined && BigInt(leg.minOutputRaw) === 0n) {
        // A zero min_output disables on-chain slippage protection for a positive
        // trade. The builder refuses it too; the review refuses it first so the
        // user never sees an offer the executor will reject.
        throw new ReviewViolationError(`${leg.operation} has a zero minimum output, which would disable on-chain slippage protection`);
      }
      return Object.freeze({ ...leg, amounts });
    }),
  );

  const base: Omit<TransactionReview, 'walletRequest'> = {
    operationId: input.operationId,
    network: input.network,
    account: input.account,
    identity: input.identity,
    legs,
    createdAtUnixMs: input.createdAtUnixMs ?? Date.now(),
  };
  return Object.freeze({ ...base, walletRequest: buildWalletRequest(base) });
}

// ---------------------------------------------------------------------------
// Intent -> review
// ---------------------------------------------------------------------------

interface AmmIntentLike {
  operation: 'swap' | 'add_liquidity' | 'remove_liquidity';
  poolComponent: string;
  instructions: Array<{
    kind: string;
    accountAddress?: string;
    componentAddress?: string;
    resourceAddress?: string;
    amount?: string;
    nftResource?: string;
    nftId?: string;
  }>;
  settlement: { accountAddress: string; outputBuckets: string[] };
  // `componentAddress` is optional on the adapter's own call type, so the
  // structural shape here keeps it optional and the code below narrows it.
  calls: Array<{ componentAddress?: string; method: string; args: unknown[]; resourcesInvolved?: string[] }>;
}

const AMM_OPERATION: Record<AmmIntentLike['operation'], ReviewOperation> = {
  swap: 'AMM_SWAP',
  add_liquidity: 'AMM_ADD_LIQUIDITY',
  remove_liquidity: 'AMM_REMOVE_LIQUIDITY',
};

/**
 * Build a review from a wallet-adapter AMM intent.
 *
 * Every amount is read from the INTENT, not from the form or from any display
 * state. That is the whole point: if the intent says 100, the review says 100,
 * and the wallet request is generated from the review.
 */
export function reviewFromAmmIntent(input: {
  intent: AmmIntentLike;
  operationId: string;
  network: string;
  identity: ExecutionIdentity;
  minOutputRaw?: string;
  maxEpochRaw?: string;
}): TransactionReview {
  const intent = input.intent;
  const amounts: ReviewAmount[] = [];

  for (const instruction of intent.instructions) {
    const resource = instruction.resourceAddress ?? instruction.nftResource;
    if (resource === undefined) continue;
    if (instruction.amount !== undefined) {
      amounts.push({ resourceAddress: resource, amountRaw: instruction.amount, role: instruction.kind.includes('withdraw') ? 'INPUT' : 'OUTPUT' });
    } else if (instruction.nftId !== undefined) {
      amounts.push({ resourceAddress: resource, amountRaw: '0', role: 'INPUT', nftId: instruction.nftId });
    }
  }

  // The call arguments are the authoritative economic terms; assert the review
  // agrees with them rather than trusting the instruction list alone.
  const swapCall = intent.calls.find((call) => call.method === 'swap');
  if (swapCall !== undefined) {
    const minOutputArg = swapCall.args[2];
    if (typeof minOutputArg === 'string') {
      if (input.minOutputRaw !== undefined && input.minOutputRaw !== minOutputArg) {
        throw new ReviewViolationError(`the swap call requests min_output ${minOutputArg} but the review states ${input.minOutputRaw}`);
      }
      input = { ...input, minOutputRaw: minOutputArg };
    }
  }

  return createReview({
    operationId: input.operationId,
    network: input.network,
    account: intent.settlement.accountAddress,
    identity: input.identity,
    legs: [
      {
        operation: AMM_OPERATION[intent.operation],
        componentAddress: intent.poolComponent,
        method: intent.calls[0]?.method ?? intent.operation,
        amounts: amounts.length > 0 ? amounts : [{ resourceAddress: intent.poolComponent, amountRaw: '0', role: 'INPUT' }],
        minOutputRaw: input.minOutputRaw,
        maxEpochRaw: input.maxEpochRaw,
      },
    ],
  });}

// ---------------------------------------------------------------------------
// Differential test helper
// ---------------------------------------------------------------------------

export interface ReviewDiff {
  ok: boolean;
  mismatches: string[];
}

/**
 * Compare every security-relevant field of a review against the intent it
 * claims to describe.
 *
 * This is the machine check behind the invariant "shown == signed". It is
 * exported so the regression suite can run it over every executable intent type.
 */
export function diffReviewAgainstIntent(review: TransactionReview, intent: AmmIntentLike): ReviewDiff {
  const mismatches: string[] = [];
  if (review.legs.length !== 1) {
    mismatches.push(`expected exactly one leg for an AMM intent, found ${review.legs.length}`);
  }
  const leg = review.legs[0];
  if (leg === undefined) return { ok: false, mismatches };
  if (leg.componentAddress !== intent.poolComponent) mismatches.push(`component: review ${leg.componentAddress} != intent ${intent.poolComponent}`);
  if (review.account !== intent.settlement.accountAddress) mismatches.push(`account: review ${review.account} != intent ${intent.settlement.accountAddress}`);
  if (leg.operation !== AMM_OPERATION[intent.operation]) mismatches.push(`operation: review ${leg.operation} != intent ${intent.operation}`);

  // Every amount the intent moves must appear in the review with the same value.
  for (const instruction of intent.instructions) {
    const resource = instruction.resourceAddress ?? instruction.nftResource;
    if (resource === undefined) continue;
    if (instruction.amount === undefined) continue;
    const match = leg.amounts.find((amount) => amount.resourceAddress === resource && amount.amountRaw === instruction.amount);
    if (match === undefined) {
      mismatches.push(`the intent moves ${instruction.amount} of ${resource} but the review does not state that amount`);
    }
  }

  // The min_output shown must be the one in the call arguments.
  const swapCall = intent.calls.find((call) => call.method === 'swap');
  if (swapCall !== undefined && typeof swapCall.args[2] === 'string') {
    if (leg.minOutputRaw !== swapCall.args[2]) {
      mismatches.push(`minOutput: review ${String(leg.minOutputRaw)} != call argument ${swapCall.args[2]}`);
    }
  }

  // And the wallet request must be generated from the review, not beside it.
  const request = review.walletRequest as { transaction?: { legs?: Array<{ componentAddress?: string; args?: Array<{ resourceAddress?: string; amountRaw?: string }> }> } };
  const requestLeg = request.transaction?.legs?.[0];
  if (requestLeg === undefined) {
    mismatches.push('the wallet request has no leg');
  } else {
    if (requestLeg.componentAddress !== leg.componentAddress) mismatches.push('the wallet request names a different component than the review');
    for (const amount of leg.amounts) {
      const sent = requestLeg.args?.find((arg) => arg.resourceAddress === amount.resourceAddress);
      if (sent === undefined || sent.amountRaw !== amount.amountRaw) {
        mismatches.push(`the wallet request does not carry ${amount.amountRaw} of ${amount.resourceAddress}`);
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

// ===========================================================================
// MARKETPLACE / NFT INTENT
// ===========================================================================

/** The subset of a marketplace intent the review must agree with. */
export interface MarketplaceIntentLike {
  operation: string;
  target: { componentOrOrderId?: string; nftResource: string; nftId?: string; quoteResource: string; amount?: string };
  calls: Array<{ componentAddress?: string; method: string; args: Array<string | number | unknown> }>;
  instructions: Array<{ kind: string; accountAddress?: string; resourceAddress?: string; nftResource?: string; nftId?: string; amount?: string }>;
}

const MARKETPLACE_OPERATION_PREFIX: ReadonlySet<string> = new Set([
  'create_listing',
  'cancel_listing',
  'buy_listing',
  'create_item_offer',
  'cancel_item_offer',
  'accept_item_offer',
  'refund_expired_item_offer',
  'create_collection_bid',
  'fill_collection_bid',
  'cancel_collection_bid',
]);

/** True when the intent is a marketplace intent rather than an AMM intent. */
export function isMarketplaceIntent(intent: unknown): boolean {
  const record = intent as { operation?: unknown; target?: unknown } | undefined;
  if (record === undefined || record === null) return false;
  if (typeof record.operation !== 'string') return false;
  if (!MARKETPLACE_OPERATION_PREFIX.has(record.operation)) return false;
  return typeof record.target === 'object' && record.target !== null;
}

/**
 * Differential review for a marketplace intent.
 *
 * The AMM differential cannot be reused here: a marketplace intent has no pool
 * and no settlement account, so an AMM comparison would report a mismatch on
 * every single NFT trade and block the feature outright. The invariants are the
 * same in spirit - the review must name the same order, the same NFT, the same
 * amount, and the wallet request must carry them.
 */
export function diffReviewAgainstMarketplaceIntent(review: TransactionReview, intent: MarketplaceIntentLike): ReviewDiff {
  const mismatches: string[] = [];
  if (review.legs.length !== 1) {
    mismatches.push(`expected exactly one leg for a marketplace intent, found ${review.legs.length}`);
  }
  const leg = review.legs[0];
  if (leg === undefined) return { ok: false, mismatches };

  // The leg must name the order or listing the intent targets.
  if (leg.componentAddress !== intent.target.componentOrOrderId) {
    mismatches.push(`target: review ${String(leg.componentAddress)} != intent ${String(intent.target.componentOrOrderId)}`);
  }

  // The signed-in account must be the account the intent settles from. This is
  // the check that catches a review bound to an asset address instead of the
  // signer, which would let any review "match" an unrelated account.
  for (const instruction of intent.instructions) {
    if (instruction.accountAddress !== undefined && instruction.accountAddress !== review.account) {
      mismatches.push(`account: review ${review.account} != intent settlement account ${instruction.accountAddress}`);
    }
  }

  // The NFT the intent moves must be the NFT the user was shown.
  const nftLeg = leg.amounts.find((amount) => amount.nftId !== undefined);
  if (intent.target.nftId !== undefined) {
    if (nftLeg === undefined) {
      mismatches.push(`the intent moves NFT ${intent.target.nftId} but the review shows no NFT`);
    } else if (nftLeg.nftId !== intent.target.nftId) {
      mismatches.push(`nftId: review ${String(nftLeg.nftId)} != intent ${intent.target.nftId}`);
    } else if (nftLeg.resourceAddress !== intent.target.nftResource) {
      mismatches.push(`nftResource: review ${nftLeg.resourceAddress} != intent ${intent.target.nftResource}`);
    }
  }

  // Every fungible amount the intent moves must appear in the review unchanged.
  for (const instruction of intent.instructions) {
    if (instruction.kind !== 'withdraw_fungible' && instruction.kind !== 'deposit_fungible') continue;
    const resource = instruction.resourceAddress;
    const amount = instruction.amount;
    if (resource === undefined || amount === undefined) continue;
    const stated = leg.amounts.some((entry) => entry.resourceAddress === resource && entry.amountRaw === amount);
    if (!stated) {
      mismatches.push(`the intent moves ${amount} of ${resource} but the review does not state that amount`);
    }
  }

  // The method must be one the intent actually calls.
  const methods = new Set(intent.calls.map((call) => call.method));
  if (methods.size > 0 && !methods.has(leg.method)) {
    mismatches.push(`method: the review shows "${leg.method}" but the intent calls ${[...methods].join(', ')}`);
  }

  // And the wallet request must carry the reviewed leg, not merely resemble it.
  const request = review.walletRequest as {
    transaction?: { legs?: Array<{ componentAddress?: string; method?: string; args?: Array<{ resourceAddress?: string; amountRaw?: string; nftId?: string }> }> };
  };
  const requestLeg = request.transaction?.legs?.[0];
  if (requestLeg === undefined) {
    mismatches.push('the wallet request has no leg');
  } else {
    if (requestLeg.componentAddress !== leg.componentAddress) {
      mismatches.push('the wallet request names a different order than the review');
    }
    if (requestLeg.method !== leg.method) {
      mismatches.push('the wallet request calls a different method than the review');
    }
    for (const amount of leg.amounts) {
      const sent = requestLeg.args?.find((arg) => arg.resourceAddress === amount.resourceAddress);
      if (sent === undefined || sent.amountRaw !== amount.amountRaw) {
        mismatches.push(`the wallet request does not carry ${amount.amountRaw} of ${amount.resourceAddress}`);
      }
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Dispatch to the differential that matches the intent.
 *
 * Guessing wrong here is not cosmetic: running the AMM comparison against a
 * marketplace intent blocks every NFT trade, and running the marketplace
 * comparison against an AMM intent would skip the min_output and pool checks.
 */
export function diffReviewForIntent(review: TransactionReview, intent: unknown): ReviewDiff {
  if (isMarketplaceIntent(intent)) {
    return diffReviewAgainstMarketplaceIntent(review, intent as MarketplaceIntentLike);
  }
  return diffReviewAgainstIntent(review, intent as AmmIntentLike);
}


/** A stable digest of the review, used to detect a change across a modal. */
export function reviewFingerprint(review: TransactionReview): string {
  const material = JSON.stringify({
    operationId: review.operationId,
    network: review.network,
    account: review.account,
    nonce: review.identity.nonce,
    legs: review.legs,
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < material.length; i += 1) {
    const c = material.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}


