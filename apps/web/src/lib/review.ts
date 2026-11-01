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
import { buildSignableInstructions, type TariInstruction } from './instructions.js';
import { encodeLiteral } from './instructionArgs.js';
import { buildStealthWithdrawOperation } from '../services/stealthWithdraw.js';

/** The intent's first instruction withdraws this Stealth-typed resource via the wallet's native path. */
export interface StealthInput {
  readonly resourceAddress: string;
}

export type ReviewOperation =
  | 'AMM_SWAP'
  | 'AMM_ADD_LIQUIDITY'
  | 'AMM_REMOVE_LIQUIDITY'
  | 'NFT_BUY_NOW'
  | 'NFT_SELL_NOW'
  | 'NFT_ACCEPT_ITEM_OFFER'
  | 'P2P_OFFER_CREATE'
  | 'P2P_OFFER_FILL'
  | 'P2P_OFFER_CLAIM'
  | 'P2P_OFFER_CANCEL'
  // RevealedAssetPool: named apart from the public AMM so a review can never present a
  // transparent trade of a privacy-typed asset as an ordinary public-pool trade.
  | 'REVEALED_POOL_SWAP'
  | 'REVEALED_POOL_ADD_LIQUIDITY'
  | 'REVEALED_POOL_REMOVE_LIQUIDITY';

export interface ReviewAmount {
  /** EXACT resource identity. A symbol is never used here. */
  resourceAddress: string;
  /** Raw base units. Exact, non-negative integer string. */
  amountRaw: string;
  /**
   * What the figure means.
   *
   * `REFUND` is deliberately distinct from the value-moving roles. A cancel or a
   * refund calls `cancel` on a component and the template returns whatever is
   * actually left — the figure is NOT a transaction argument, so it cannot be checked
   * against the instruction list and must not be. It exists because a review with no
   * named amounts is refused outright (correctly: a signer must be told what is being
   * spent), and because the user is entitled to see the escrow that will come back.
   *
   * It is deliberately NOT usable to claim value: nothing reads it as an economic
   * term, it is excluded from the carry check because it is not carried, and the
   * "intent moves X but the review does not state X" check is independent of it.
   *
   * `RECEIVE` is what a P2P escrow RELEASES to this account (a fill receives the escrow, a
   * claim receives the proceeds). Like REFUND it is not an argument -- the component returns
   * what it holds -- so it is not carry-checked; the figure is read authoritatively from
   * chain state (decodeSwapOffer), never from an invitation.
   */
  role: 'INPUT' | 'OUTPUT' | 'MINIMUM' | 'ESCROW' | 'FEE' | 'REFUND' | 'RECEIVE';
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
   * The EXACT operation handed to the provider.
   *
   * Built from the review, so it cannot describe a different transaction. The
   * `instructions` member is the official `TariSignAndSubmitParams.instructions`
   * payload — the array the wallet is asked to sign — and it is frozen, so the
   * object that was reviewed is byte-for-byte the object that is submitted.
   */
  readonly walletRequest: Readonly<Record<string, unknown>>;
}

/** The reviewed, frozen instruction list. This is what the wallet signs. */
export function reviewedInstructions(review: TransactionReview): readonly unknown[] {
  const request = review.walletRequest as { instructions?: unknown };
  if (!Array.isArray(request.instructions)) {
    throw new ReviewViolationError('the reviewed request carries no instruction list');
  }
  return request.instructions;
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
 * Build the wallet request FROM the review.
 *
 * The provider sees exactly the amounts the user was shown, because both come
 * from the same object.
 *
 * The `instructions` member is what actually crosses the wallet boundary. The
 * official contract types it `unknown[]`; `buildSignableInstructions` turns the
 * adapter's signer-agnostic intent into the externally-tagged Ootle form the
 * reference documents, resolving symbolic buckets to the integer workspace ids
 * the contract requires for instructions we build ourselves. The intent's expiry is
 * review evidence: Ootle has no max-epoch instruction, and the wallet sets the
 * transaction's `max_epoch` when it signs.
 *
 * The `transaction`/`display` members remain as the human-readable review
 * record. They are NOT sent to the provider: the contract defines no such
 * parameters, and adding undocumented fields to an outbound request is exactly
 * the kind of thing that works by accident against one bridge and breaks against
 * another.
 */
export function buildWalletRequest(
  review: Omit<TransactionReview, 'walletRequest'> & { instructions?: readonly unknown[]; maxEpoch?: string; stealthInput?: StealthInput },
): Readonly<Record<string, unknown>> {
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
  // Machine-readable context for a signing prompt to be more than an opaque blob.
  // This is a REVIEW record for this app, not a wire parameter.
  const display = {
    operation: review.legs.map((leg) => `${leg.operation} on ${leg.componentAddress}`).join('; '),
    network: review.network,
    account: review.account,
    assets: review.legs.flatMap((leg) => leg.amounts.map((amount) => `${amount.amountRaw} of ${amount.resourceAddress}`)),
  };

  if (review.instructions === undefined) {
    // No instructions to sign. Refuse rather than hand a wallet an empty request,
    // which would let a user "approve" a transaction that does nothing.
    throw new ReviewViolationError('a review must carry the instruction list that will be signed');
  }
  if (review.stealthInput !== undefined) {
    // Sapient local account + Stealth-typed input: the wallet withdraws through its own
    // StealthTransfer and runs these follow-ups (services/stealthWithdraw.ts). Built from the
    // SAME intent instructions; `instructions` carries the follow-ups for the carry check.
    if (review.maxEpoch !== undefined && review.maxEpoch !== '') asRawExecutionAmount(review.maxEpoch, 'maxEpoch');
    const { operation, followUps } = buildStealthWithdrawOperation(review.instructions, review.account);
    if (operation.resourceAddress !== review.stealthInput.resourceAddress) {
      throw new ReviewViolationError('the Stealth input is not the resource the intent withdraws first');
    }
    return Object.freeze({ operation: freezeDeep(operation), instructions: freezeDeep(followUps), transaction: freezeDeep(transaction), display: freezeDeep(display) });
  }
  const instructions: TariInstruction[] = buildSignableInstructions({
    instructions: review.instructions,
    maxEpoch: review.maxEpoch,
  });

  return Object.freeze({ instructions: freezeDeep(instructions), transaction: freezeDeep(transaction), display: freezeDeep(display) });
}

export function createReview(input: {
  operationId: string;
  network: string;
  account: string;
  identity: ExecutionIdentity;
  legs: ReviewLeg[];
  /** The signer-agnostic intent, serialised into the official instructions form. */
  instructions: readonly unknown[];
  /** Expiry evidence (raw epoch). Validated; the wallet sets the transaction's real max_epoch. */
  maxEpoch?: string;
  /** Present when the input must go through the wallet's native Stealth withdrawal. */
  stealthInput?: StealthInput;
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

  const base: Omit<TransactionReview, 'walletRequest'> & { instructions: readonly unknown[]; maxEpoch?: string; stealthInput?: StealthInput } = {
    operationId: input.operationId,
    network: input.network,
    account: input.account,
    identity: input.identity,
    legs,
    instructions: input.instructions,
    maxEpoch: input.maxEpoch,
    ...(input.stealthInput !== undefined ? { stealthInput: input.stealthInput } : {}),
    createdAtUnixMs: input.createdAtUnixMs ?? Date.now(),
  };
  return Object.freeze({ ...base, walletRequest: buildWalletRequest(base) });
}

// ---------------------------------------------------------------------------
// Intent -> review
// ---------------------------------------------------------------------------

interface AmmIntentLike {
  operation:
    | 'swap'
    | 'add_liquidity'
    | 'remove_liquidity'
    | 'multi_hop_swap'
    | 'create_pool'
    | 'revealed_swap'
    | 'revealed_add_liquidity'
    | 'revealed_remove_liquidity'
    | 'create_revealed_pool';
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
  // A multi-hop route is a sequence of AMM swaps in ONE transaction; its reviewed bound is
  // the whole-route minimum carried by the final hop (see `finalSwapCall`).
  multi_hop_swap: 'AMM_SWAP',
  // Creating a pool funds its first liquidity in the same transaction.
  create_pool: 'AMM_ADD_LIQUIDITY',
  revealed_swap: 'REVEALED_POOL_SWAP',
  revealed_add_liquidity: 'REVEALED_POOL_ADD_LIQUIDITY',
  revealed_remove_liquidity: 'REVEALED_POOL_REMOVE_LIQUIDITY',
  create_revealed_pool: 'REVEALED_POOL_ADD_LIQUIDITY',
};

/**
 * The swap call whose `min_output` is the user's bound. For one hop it is the only swap;
 * for a route it is the LAST hop (intermediate hops carry min_output = 1, which must never
 * be shown to a signer as their protection).
 */
function finalSwapCall(intent: AmmIntentLike): AmmIntentLike['calls'][number] | undefined {
  const swaps = intent.calls.filter((call) => call.method === 'swap');
  return swaps[swaps.length - 1];
}

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
  /** Present when the swap input must go through the wallet's native Stealth withdrawal. */
  stealthInput?: StealthInput;
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
  const swapCall = finalSwapCall(intent);
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
    // The intent's own signer-agnostic instructions are what gets signed. The
    // max_epoch bound the adapter attached is carried with it, so the signed
    // transaction cannot outlive its own validity window.
    instructions: intent.instructions,
    maxEpoch: input.maxEpochRaw,
    ...(input.stealthInput !== undefined ? { stealthInput: input.stealthInput } : {}),
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
  });
}

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

  // The min_output shown must be the one in the (final) swap call's arguments.
  const swapCall = finalSwapCall(intent);
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
  mismatches.push(...checkInstructionsCarryAmounts(review, leg.amounts));

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * The reviewed amounts must appear in the SERIALISED instruction list, not only
 * in the human-readable record beside it.
 *
 * This is the check that actually closes "shown == signed" at the wallet
 * boundary. `review.walletRequest.instructions` is the array the provider is
 * asked to sign; if an amount the user approved is absent from it, the
 * transaction that reaches the wallet is not the one that was reviewed, however
 * consistent the display record is. The display record is a by-product; the
 * instruction list is the payload.
 *
 * Every match is an exact comparison of the value's v0.48 `Literal` encoding (the tari_bor
 * CBOR bytes the engine decodes) against the literal arguments actually present, so neither
 * display scaling nor an incidental substring can satisfy it: the amount must be an Amount
 * argument, the NFT a NonFungibleId argument, the resource a ResourceAddress argument.
 */
function checkInstructionsCarryAmounts(review: TransactionReview, amounts: readonly ReviewAmount[]): string[] {
  const mismatches: string[] = [];
  const request = review.walletRequest as { instructions?: unknown };
  if (!Array.isArray(request.instructions) || request.instructions.length === 0) {
    return ['the reviewed request carries no instruction list for the provider to sign'];
  }
  const literals = collectLiterals(request.instructions);
  // A Stealth input is carried by the wallet operation itself, not by a literal.
  const stealthOp = (review.walletRequest as { operation?: { kind?: string; resourceAddress?: string; amount?: string } }).operation;
  const stealthCarried = (amount: ReviewAmount): boolean =>
    stealthOp?.kind === 'withdrawStealthAndExecute' && amount.role === 'INPUT' && amount.nftId === undefined && amount.resourceAddress === stealthOp.resourceAddress && amount.amountRaw === stealthOp.amount;
  const carries = (type: 'Amount' | 'ResourceAddress' | 'NonFungibleId', value: string): boolean => {
    try {
      return literals.has(encodeLiteral(type, value));
    } catch {
      return false;
    }
  };
  for (const amount of amounts) {
    // FEE is the network charge, which is not an instruction argument either.
    // REFUND is the remaining escrow a cancel returns, computed on-chain by the
    // template rather than passed in. Neither is claimed to be carried by the
    // transaction, so neither is checked for it. See ReviewAmount['role'].
    if (amount.role === 'FEE' || amount.role === 'REFUND' || amount.role === 'RECEIVE') continue;
    // An NFT the template itself RETURNS (a cancelled listing) is not an argument either:
    // `cancel()` takes none. The marketplace differential still requires the review to name it.
    if (amount.role === 'OUTPUT' && amount.nftId !== undefined && !carries('NonFungibleId', amount.nftId)) continue;
    if (stealthCarried(amount)) continue;
    if (amount.nftId !== undefined) {
      if (!carries('NonFungibleId', amount.nftId)) {
        mismatches.push(`the instructions the provider will sign do not carry NFT ${amount.nftId} of ${amount.resourceAddress}`);
      }
    } else if (!carries('Amount', amount.amountRaw)) {
      mismatches.push(`the instructions the provider will sign do not carry ${amount.amountRaw} of ${amount.resourceAddress}`);
    }
    if (amount.resourceAddress.startsWith('resource_') && !carries('ResourceAddress', amount.resourceAddress)) {
      mismatches.push(`the instructions the provider will sign never name ${amount.resourceAddress}`);
    }
  }
  if (legMentionsComponent(request.instructions, review.legs[0]?.componentAddress) === false) {
    mismatches.push('the instructions the provider will sign do not name the reviewed component');
  }
  return mismatches;
}

/** Every `{ Literal: hex }` argument anywhere in the serialised list. */
function collectLiterals(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const x of node) collectLiterals(x, into);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'Literal' && typeof value === 'string') into.add(value);
      else collectLiterals(value, into);
    }
  }
  return into;
}

/** Whether any `CallMethod` in the serialised list targets this component. */
function legMentionsComponent(instructions: readonly unknown[], componentAddress: string | undefined): boolean | undefined {
  if (componentAddress === undefined) return undefined;
  for (const entry of instructions) {
    if (entry === null || typeof entry !== 'object') continue;
    const bag = entry as Record<string, Record<string, unknown>>;
    const call = bag.CallMethod;
    if (call !== undefined) {
      const address = (call.call as { Address?: unknown } | undefined)?.Address;
      if (address === componentAddress) return true;
    }
    // A CREATE has no component address until its receipt lands — it calls a
    // template FUNCTION instead. The leg then names the TEMPLATE, and the check has
    // to look for it in `CallFunction.address`. Without this branch every create
    // action (listing, item offer, collection bid) would fail this gate with a
    // correct review, because the only address such a transaction carries is the
    // template's. On the wire a TemplateAddress is the bare 64-hex hash; the review
    // names it `template_<hash>`.
    const create = bag.CallFunction;
    if (create !== undefined && typeof create.address === 'string' && create.address === componentAddress.replace(/^template_/, '')) return true;
  }
  return false;
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
  //
  // A CREATE has no `componentOrOrderId` — the component does not exist until its
  // receipt lands — so there is nothing on the target to compare. In that case the
  // leg is required to name the TEMPLATE the intent's own `call_function` targets,
  // which is the only identity such a transaction carries before submission. That
  // is checked rather than skipped: it is precisely the field a substituted template
  // would attack, and there is no reread that would catch it later.
  const templateAddresses = new Set(
    intent.calls.map((call) => (call as { templateAddress?: string }).templateAddress).filter((a): a is string => typeof a === 'string'),
  );
  if (intent.target.componentOrOrderId === undefined) {
    if (!templateAddresses.has(leg.componentAddress)) {
      mismatches.push(`create: review names "${String(leg.componentAddress)}" but the intent calls template ${[...templateAddresses].join(', ') || '(none)'}`);
    }
  } else if (leg.componentAddress !== intent.target.componentOrOrderId) {
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
  mismatches.push(...checkInstructionsCarryAmounts(review, leg.amounts));

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
  if (isSwapOfferIntentLike(intent)) return diffReviewAgainstSwapOfferIntent(review, intent);
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



// ===========================================================================
// P2P escrow offers (templates/p2p_offer)
// ===========================================================================

type OfferAssetLike = { kind: 'fungible'; resource: string; amount: string } | { kind: 'nft'; resource: string; nftId: string };

export interface SwapOfferIntentLike {
  kind: 'swap_offer';
  operation: 'swap_offer_create' | 'swap_offer_fill' | 'swap_offer_claim' | 'swap_offer_cancel';
  accountAddress: string;
  target: string;
  instructions: readonly unknown[];
  spends?: OfferAssetLike;
  terms?: { requested: OfferAssetLike };
}

const SWAP_OFFER_OPERATION: Record<SwapOfferIntentLike['operation'], ReviewOperation> = {
  swap_offer_create: 'P2P_OFFER_CREATE',
  swap_offer_fill: 'P2P_OFFER_FILL',
  swap_offer_claim: 'P2P_OFFER_CLAIM',
  swap_offer_cancel: 'P2P_OFFER_CANCEL',
};

const SWAP_OFFER_METHOD: Record<SwapOfferIntentLike['operation'], string> = {
  swap_offer_create: 'create',
  swap_offer_fill: 'fill',
  swap_offer_claim: 'claim',
  swap_offer_cancel: 'cancel',
};

export function isSwapOfferIntentLike(intent: unknown): intent is SwapOfferIntentLike {
  return typeof intent === 'object' && intent !== null && (intent as { kind?: unknown }).kind === 'swap_offer';
}

function assetAmount(asset: OfferAssetLike, role: ReviewAmount['role']): ReviewAmount {
  return asset.kind === 'fungible'
    ? { resourceAddress: asset.resource, amountRaw: asset.amount, role }
    : { resourceAddress: asset.resource, amountRaw: '0', role, nftId: asset.nftId };
}

function sameAsset(a: ReviewAmount, b: ReviewAmount): boolean {
  return a.resourceAddress === b.resourceAddress && a.amountRaw === b.amountRaw && a.role === b.role && a.nftId === b.nftId;
}

/**
 * The amounts a SwapOffer review states.
 *
 * `chainReceive` is what the escrow will RELEASE, read from chain state by the caller
 * (decodeSwapOffer): the escrow for a fill or cancel, the proceeds for a claim. A fill, claim
 * or cancel cannot be reviewed without it, because "what do I get" is the whole question.
 */
function swapOfferAmounts(intent: SwapOfferIntentLike, chainReceive?: OfferAssetLike): ReviewAmount[] {
  const amounts: ReviewAmount[] = [];
  if (intent.spends !== undefined) amounts.push(assetAmount(intent.spends, 'INPUT'));
  if (intent.operation === 'swap_offer_create') {
    if (intent.terms === undefined) throw new ReviewViolationError('a SwapOffer create must state the requested asset');
    amounts.push(assetAmount(intent.terms.requested, 'OUTPUT'));
  } else {
    if (chainReceive === undefined) throw new ReviewViolationError(`a SwapOffer ${SWAP_OFFER_METHOD[intent.operation]} must state what the escrow releases, read from chain`);
    amounts.push(assetAmount(chainReceive, intent.operation === 'swap_offer_cancel' ? 'REFUND' : 'RECEIVE'));
  }
  return amounts;
}

export function reviewFromSwapOfferIntent(input: {
  intent: SwapOfferIntentLike;
  operationId: string;
  network: string;
  identity: ExecutionIdentity;
  /** What the escrow releases, from decodeSwapOffer (required for fill/claim/cancel). */
  chainReceive?: OfferAssetLike;
  maxEpochRaw?: string;
  stealthInput?: StealthInput;
}): TransactionReview {
  const { intent } = input;
  return createReview({
    operationId: input.operationId,
    network: input.network,
    account: intent.accountAddress,
    identity: input.identity,
    instructions: intent.instructions,
    maxEpoch: input.maxEpochRaw,
    ...(input.stealthInput !== undefined ? { stealthInput: input.stealthInput } : {}),
    legs: [
      {
        operation: SWAP_OFFER_OPERATION[intent.operation],
        componentAddress: intent.target,
        method: SWAP_OFFER_METHOD[intent.operation],
        amounts: swapOfferAmounts(intent, input.chainReceive),
        maxEpochRaw: input.maxEpochRaw,
      },
    ],
  });
}

/**
 * The SwapOffer differential: the review must be bound to the intent's account, name the
 * offer (or template), state exactly what leaves the account and what is requested, and --
 * the strongest check -- its wallet instructions must be byte-identical to a fresh
 * serialisation of the intent's own instructions.
 */
export function diffReviewAgainstSwapOfferIntent(review: TransactionReview, intent: SwapOfferIntentLike): ReviewDiff {
  const mismatches: string[] = [];
  if (review.legs.length !== 1) mismatches.push(`expected exactly one leg for a SwapOffer intent, found ${review.legs.length}`);
  const leg = review.legs[0];
  if (leg === undefined) return { ok: false, mismatches };
  if (review.account !== intent.accountAddress) mismatches.push(`account: review ${review.account} != intent ${intent.accountAddress}`);
  if (leg.componentAddress !== intent.target) mismatches.push(`component: review ${leg.componentAddress} != intent ${intent.target}`);
  if (leg.operation !== SWAP_OFFER_OPERATION[intent.operation]) mismatches.push(`operation: review ${leg.operation} != intent ${intent.operation}`);
  if (intent.spends !== undefined && !leg.amounts.some((a) => sameAsset(a, assetAmount(intent.spends!, 'INPUT')))) {
    mismatches.push('the review does not state exactly what leaves the account');
  }
  if (intent.terms !== undefined && !leg.amounts.some((a) => sameAsset(a, assetAmount(intent.terms!.requested, 'OUTPUT')))) {
    mismatches.push('the review does not state exactly what the offer requests');
  }
  if (intent.operation !== 'swap_offer_create' && !leg.amounts.some((a) => a.role === 'RECEIVE' || a.role === 'REFUND')) {
    mismatches.push('the review does not state what the escrow releases');
  }
  let fresh: string;
  try {
    const stealth = (review.walletRequest as { operation?: { kind?: string } }).operation?.kind === 'withdrawStealthAndExecute';
    fresh = JSON.stringify(stealth ? buildStealthWithdrawOperation(intent.instructions, intent.accountAddress).followUps : buildSignableInstructions({ instructions: intent.instructions }));
  } catch (error) {
    mismatches.push(`the intent does not serialise: ${(error as Error).message}`);
    return { ok: false, mismatches };
  }
  if (JSON.stringify(reviewedInstructions(review)) !== fresh) mismatches.push('the reviewed instructions differ from the intent\'s own instructions');
  mismatches.push(...checkInstructionsCarryAmounts(review, leg.amounts));
  return { ok: mismatches.length === 0, mismatches };
}
