/**
 * MARKETPLACE ACTIONS — one shared, template-pinned action layer.
 *
 * WHY THIS IS A SERVICE AND NOT PAGE LOGIC.
 *
 * Nine marketplace operations settle real money: create / buy / cancel a listing,
 * make / accept / cancel / refund an item offer, and create / fill / cancel / refund
 * a collection bid. Each one has to bind the same five things — the exact NFT
 * resource, the NFT id, the marketplace component, the payment resource, and the
 * wallet account — to the same network, review the same way, and be refused the same
 * way. Doing that per page component is how one of them ends up reviewing an amount
 * the intent does not move, or aimed at a template nobody pinned. So every action
 * is constructed, reviewed, and executed here, and a component supplies only the
 * facts it read.
 *
 * TEMPLATE PINNING IS NOT OPTIONAL.
 *
 * A create action names a template ADDRESS, and the component it produces has no
 * address until the receipt lands — there is nothing to reread before submission.
 * The only identity check available before signing is therefore the template address
 * itself, so these are compiled-in constants rather than anything a caller can pass
 * in. A caller-supplied template address would be a hole exactly where the user has
 * no other way to tell what they approved.
 *
 * THE REVIEW IS BUILT FROM THE INTENT, NEVER FROM A DISPLAY STRING.
 *
 * `reviewForIntent` derives its amounts by walking the intent's own instructions, so
 * the amounts shown are by construction the amounts signed. There is no path by which
 * a formatted label and an on-chain amount can disagree. `executeSwap` then re-diffs
 * the review against the intent and refuses on any mismatch, so "shown == signed" is
 * checked rather than assumed.
 */

import {
  cancelCollectionBid,
  cancelItemOffer,
  cancelListing,
  createCollectionBid,
  createItemOffer,
  createListing,
  refundExpiredCollectionBid,
  refundExpiredItemOffer,
  type MarketplaceTransactionIntent,
} from '@tari-ootle/wallet-adapter';
import type { ExecutionIdentity } from '../lib/executionIdentity.js';
import { createReview, type ReviewAmount, type ReviewOperation, type TransactionReview } from '../lib/review.js';
import { asRawExecutionAmount, asResourceAddress } from '../lib/tradeBoundary.js';

/**
 * The published v0.46 marketplace templates.
 *
 * These are the exact addresses whose three flows were settled live on Esmeralda
 * (FixedPriceListing SOLD, ItemOffer ACCEPTED, CollectionBid FILLED). They are
 * constants because a create action has no component address to verify before
 * signing — the template address is the entire pre-submission identity check.
 *
 * A rebrand does NOT change these. They are on-chain deployment identities, not
 * product names, and re-publishing under a new name would orphan every listing,
 * offer, and bid that already exists.
 */
export const MARKETPLACE_TEMPLATES = {
  FixedPriceListing: 'template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329',
  ItemOffer: 'template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6',
  CollectionBid: 'template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54',
} as const;

export type MarketplaceTemplateName = keyof typeof MARKETPLACE_TEMPLATES;

/** The durable record kind for each action. Matches `ProtocolOperationKind`. */
export type MarketplaceActionKind =
  | 'MARKET_CREATE_LISTING'
  | 'MARKET_CANCEL_LISTING'
  | 'MARKET_MAKE_ITEM_OFFER'
  | 'MARKET_CANCEL_ITEM_OFFER'
  | 'MARKET_REFUND_ITEM_OFFER'
  | 'MARKET_PLACE_COLLECTION_BID'
  | 'MARKET_CANCEL_COLLECTION_BID'
  | 'MARKET_REFUND_COLLECTION_BID';

/**
 * Every create/cancel/refund action the browser can reach.
 *
 * Buy, sell-into-bid, and accept-offer are deliberately ABSENT: they are already
 * driven by the protocol-client's authoritative resolvers
 * (`resolveBuyNow` / `resolveSellNow` / `resolveAcceptItemOffer`), which reread the
 * component from the chain first. This service covers only the operations with no
 * resolver, and refuses to reimplement the ones that do.
 */
export type MarketplaceAction =
  | {
      kind: 'CREATE_LISTING';
      sellerAccount: string;
      nftResource: string;
      nftId: string;
      quoteResource: string;
      priceRaw: string;
      expiryEpoch: number;
    }
  | { kind: 'CANCEL_LISTING'; listingAddress: string; sellerAccount: string; nftResource: string; nftId: string; quoteResource: string }
  | {
      kind: 'MAKE_ITEM_OFFER';
      buyerAccount: string;
      nftResource: string;
      nftId: string;
      quoteResource: string;
      offerAmountRaw: string;
      expiryEpoch: number;
    }
  | {
      kind: 'CANCEL_ITEM_OFFER';
      offerAddress: string;
      buyerAccount: string;
      nftResource: string;
      nftId: string;
      quoteResource: string;
      /** The escrowed amount the refund returns, from an authoritative reread. */
      refundAmountRaw: string;
    }
  | {
      kind: 'REFUND_ITEM_OFFER';
      offerAddress: string;
      buyerAccount: string;
      nftResource: string;
      nftId: string;
      quoteResource: string;
      refundAmountRaw: string;
    }
  | {
      kind: 'PLACE_COLLECTION_BID';
      buyerAccount: string;
      collectionResource: string;
      quoteResource: string;
      pricePerNftRaw: string;
      quantityRaw: string;
      expiryEpoch: number;
    }
  | {
      kind: 'CANCEL_COLLECTION_BID';
      bidAddress: string;
      buyerAccount: string;
      collectionResource: string;
      quoteResource: string;
      /** Remaining escrow the refund returns, from an authoritative reread. */
      refundAmountRaw: string;
    }
  | {
      kind: 'REFUND_COLLECTION_BID';
      bidAddress: string;
      buyerAccount: string;
      collectionResource: string;
      quoteResource: string;
      refundAmountRaw: string;
    };

const RECORD_KIND: Readonly<Record<MarketplaceAction['kind'], MarketplaceActionKind>> = {
  CREATE_LISTING: 'MARKET_CREATE_LISTING',
  CANCEL_LISTING: 'MARKET_CANCEL_LISTING',
  MAKE_ITEM_OFFER: 'MARKET_MAKE_ITEM_OFFER',
  CANCEL_ITEM_OFFER: 'MARKET_CANCEL_ITEM_OFFER',
  REFUND_ITEM_OFFER: 'MARKET_REFUND_ITEM_OFFER',
  PLACE_COLLECTION_BID: 'MARKET_PLACE_COLLECTION_BID',
  CANCEL_COLLECTION_BID: 'MARKET_CANCEL_COLLECTION_BID',
  REFUND_COLLECTION_BID: 'MARKET_REFUND_COLLECTION_BID',
};

/** The review's operation label for each action. Must stay inside the diff's allow-list. */
const REVIEW_OPERATION: Readonly<Record<MarketplaceAction['kind'], ReviewOperation>> = {
  CREATE_LISTING: 'NFT_BUY_NOW',
  CANCEL_LISTING: 'NFT_BUY_NOW',
  MAKE_ITEM_OFFER: 'NFT_BUY_NOW',
  CANCEL_ITEM_OFFER: 'NFT_BUY_NOW',
  REFUND_ITEM_OFFER: 'NFT_BUY_NOW',
  PLACE_COLLECTION_BID: 'NFT_SELL_NOW',
  CANCEL_COLLECTION_BID: 'NFT_SELL_NOW',
  REFUND_COLLECTION_BID: 'NFT_SELL_NOW',
};

export function recordKindFor(kind: MarketplaceAction['kind']): MarketplaceActionKind {
  return RECORD_KIND[kind];
}

export function reviewOperationFor(kind: MarketplaceAction['kind']): ReviewOperation {
  return REVIEW_OPERATION[kind];
}

/**
 * Construct the intent for an action, using the wallet-adapter's own builders.
 *
 * No business logic is duplicated here — this is a typed dispatch onto the builders
 * that the executor, the tests, and the resolvers already share, plus the identity
 * normalisation the review depends on. Every raw amount crosses `asRawExecutionAmount`
 * so a float can never enter a signed transaction, and every address crosses
 * `asResourceAddress`.
 */
export function buildMarketplaceIntent(
  action: MarketplaceAction,
  /**
   * The marketplace templates of the network generation this session VERIFIED
   * (`activeDeployment(network).marketplaceTemplates`). A create action calls a template
   * function, so it is refused when the generation has none: on the v0.48 reset network
   * the pre-reset template addresses identify nothing. Cancel/refund actions call a
   * method on an existing component and need no template address.
   */
  templates: Readonly<Record<'FixedPriceListing' | 'ItemOffer' | 'CollectionBid', string>> | undefined = MARKETPLACE_TEMPLATES,
): MarketplaceTransactionIntent {
  const template = (name: 'FixedPriceListing' | 'ItemOffer' | 'CollectionBid'): string => {
    if (templates === undefined) {
      throw new Error(`The ${name} template is not published on this network generation, so nothing can be created there yet.`);
    }
    return templates[name];
  };
  switch (action.kind) {
    case 'CREATE_LISTING':
      return createListing({
        templateAddress: template('FixedPriceListing'),
        sellerAccount: action.sellerAccount,
        nftResource: asResourceAddress(action.nftResource, 'nftResource'),
        nftId: action.nftId,
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
        price: asRawExecutionAmount(action.priceRaw, 'price'),
        expiryEpoch: action.expiryEpoch,
      });
    case 'CANCEL_LISTING':
      return cancelListing(action.listingAddress, {
        nftResource: asResourceAddress(action.nftResource, 'nftResource'),
        nftId: action.nftId,
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
      });
    case 'MAKE_ITEM_OFFER':
      return createItemOffer({
        templateAddress: template('ItemOffer'),
        buyerAccount: action.buyerAccount,
        nftResource: asResourceAddress(action.nftResource, 'nftResource'),
        nftId: action.nftId,
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
        offerAmount: asRawExecutionAmount(action.offerAmountRaw, 'offerAmount'),
        expiryEpoch: action.expiryEpoch,
      });
    case 'CANCEL_ITEM_OFFER':
      return cancelItemOffer(action.offerAddress, {
        nftResource: asResourceAddress(action.nftResource, 'nftResource'),
        nftId: action.nftId,
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
// The refund figure the caller read from the component. Carried on the target so
      // the human review can show it. It is NOT a transaction argument — the template
      // refunds whatever is actually left — so it must not reach the machine-checked
      // review amounts.
      amount: asRawExecutionAmount(action.refundAmountRaw, 'refundAmountRaw'),
    });
    case 'REFUND_ITEM_OFFER':
      return refundExpiredItemOffer(action.offerAddress, {
        nftResource: asResourceAddress(action.nftResource, 'nftResource'),
        nftId: action.nftId,
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
        amount: asRawExecutionAmount(action.refundAmountRaw, 'refundAmountRaw'),
      });
    case 'PLACE_COLLECTION_BID':
      return createCollectionBid({
        templateAddress: template('CollectionBid'),
        buyerAccount: action.buyerAccount,
        collectionResource: asResourceAddress(action.collectionResource, 'collectionResource'),
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
        pricePerNft: asRawExecutionAmount(action.pricePerNftRaw, 'pricePerNft'),
        quantity: asRawExecutionAmount(action.quantityRaw, 'quantity'),
        expiryEpoch: action.expiryEpoch,
      });
    case 'CANCEL_COLLECTION_BID':
      return cancelCollectionBid(action.bidAddress, {
        nftResource: asResourceAddress(action.collectionResource, 'collectionResource'),
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
        amount: asRawExecutionAmount(action.refundAmountRaw, 'refundAmountRaw'),
      });
    case 'REFUND_COLLECTION_BID':
      return refundExpiredCollectionBid(action.bidAddress, {
        nftResource: asResourceAddress(action.collectionResource, 'collectionResource'),
        quoteResource: asResourceAddress(action.quoteResource, 'quoteResource'),
        amount: asRawExecutionAmount(action.refundAmountRaw, 'refundAmountRaw'),
      });
    default: {
      const unreachable: never = action;
      throw new Error(`Refusing to build an unrecognised marketplace action: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Derive the review's amounts by walking the INTENT.
 *
 * This is the anti-drift mechanism. If the amounts were instead passed in by the
 * caller from a formatted display string, the review and the signed transaction
 * would be two independent descriptions of the same trade, and they would eventually
 * disagree — which is the specific defect `diffReviewAgainstMarketplaceIntent`
 * exists to catch. Reading them off the intent removes the second description.
 */
function amountsFromIntent(input: MarketplaceReviewInput): ReviewAmount[] {
  const { intent } = input;
  const amounts: ReviewAmount[] = [];
  for (const instruction of intent.instructions) {
    if (instruction.kind === 'withdraw_fungible') {
      amounts.push({
        resourceAddress: asResourceAddress(instruction.resourceAddress, 'instruction.resourceAddress'),
        amountRaw: asRawExecutionAmount(instruction.amount, 'instruction.amount'),
        role: 'INPUT',
      });
    }
    if (instruction.kind === 'withdraw_non_fungible') {
      amounts.push({
        resourceAddress: asResourceAddress(instruction.resourceAddress, 'instruction.resourceAddress'),
        amountRaw: '0',
        role: 'INPUT',
        nftId: instruction.nonFungibleId,
      });
    }
  }

  // A CANCEL or REFUND moves nothing OUT of the account by withdrawal — the template
  // releases the escrowed asset itself — so the withdrawal walk above finds nothing
  // and the review would be blank. That is not acceptable: the user still has to be
  // shown WHAT is being released, and the review differential independently requires
  // the NFT to be named whenever the intent targets one. The role says which way
  // the asset moves: INPUT when this transaction escrows it, OUTPUT when it returns.
  const nftId = intent.target.nftId;
  if (nftId !== undefined && !amounts.some((a) => a.nftId !== undefined)) {
    const escrows = intent.instructions.some((i) => i.kind === 'withdraw_non_fungible');
    amounts.push({
      resourceAddress: asResourceAddress(intent.target.nftResource, 'intent.target.nftResource'),
      amountRaw: '0',
      role: escrows ? 'INPUT' : 'OUTPUT',
      nftId,
    });
  }

  // A CANCEL or REFUND still has to name something, because `createReview` refuses a
  // review with no amounts and a signer must be told what the operation is about.
  // The figure is the escrow the component will return, read authoritatively by the
  // caller. It carries role REFUND precisely because the transaction does NOT pass
  // it as an argument — the template refunds whatever is left — so it is excluded
  // from the instruction carry check. It is never read as an economic term.
  if (isRefundOperation(intent.operation) && intent.target.amount !== undefined) {
    amounts.push({
      resourceAddress: asResourceAddress(intent.target.quoteResource, 'intent.target.quoteResource'),
      amountRaw: asRawExecutionAmount(intent.target.amount, 'refundAmountRaw'),
      role: 'REFUND',
    });
  }

  if (amounts.length === 0 && intent.target.nftId === undefined && intent.instructions.length === 0) {
    throw new Error('Refusing to build a marketplace review for an intent with no instructions and no subject: the user would approve nothing visible.');
  }
  return amounts;
}

function isRefundOperation(operation: string): boolean {
  return (
    operation === 'cancel_item_offer' ||
    operation === 'refund_expired_item_offer' ||
    operation === 'cancel_collection_bid' ||
    operation === 'refund_expired_collection_bid'
  );
}

export interface MarketplaceReviewInput {
  action: MarketplaceAction['kind'];
  operationId: string;
  network: string;
  account: string;
  identity: ExecutionIdentity;
  intent: MarketplaceTransactionIntent;
}

/**
 * Build the frozen review for an action.
 *
 * `maxEpoch` is carried so a signed transaction cannot outlive the listing it
 * settles — the expiry is part of what the user approved, so it is part of what gets
 * signed.
 */
export function reviewForIntent(input: MarketplaceReviewInput): TransactionReview {
  const { intent } = input;
  const expiry = intent.target.expiryEpoch;
  // The leg's method and its subject are read OFF THE INTENT, never supplied
  // alongside it. Two reasons, both learned from the differential failing on real
  // actions:
  //   - the review must name a method the intent actually calls (`create`, not
  //     `create_listing`; the operation label is not a contract method name);
  //   - a create has no component address yet, so its subject is the TEMPLATE its
  //     own `call_function` targets. Hard-coding either would make every create
  //     review disagree with the intent it describes.
  const call = intent.calls[0];
  const subject = intent.target.componentOrOrderId ?? intent.instructions.find((i) => i.kind === 'call_function')?.templateAddress ?? '';
  if (subject === '') {
    throw new Error('Refusing to build a marketplace review with no component or template to name.');
  }
  return createReview({
    operationId: input.operationId,
    network: input.network,
    account: input.account,
    identity: input.identity,
    instructions: intent.instructions,
    maxEpoch: expiry === undefined || expiry === 0 ? undefined : String(expiry),
    legs: [
      {
        operation: reviewOperationFor(input.action),
        componentAddress: subject,
        method: call?.method ?? intent.operation,
        amounts: amountsFromIntent(input),
      },
    ],
  });
}

/** What a UI needs to render a human summary of an action before signing it. */
export interface MarketplaceActionSummary {
  readonly title: string;
  readonly lines: ReadonlyArray<{ label: string; value: string }>;
}

const r = (raw: string): string => raw;

/**
 * A plain-language summary for the confirmation step.
 *
 * "Review" for a non-developer means naming the thing being moved and the thing
 * being paid, not printing raw instruction JSON. The values are raw integers taken
 * from the action, so this text cannot disagree with what is signed — formatting for
 * display is applied on top, never substituted for it.
 */
export function summarizeAction(action: MarketplaceAction): MarketplaceActionSummary {
  switch (action.kind) {
    case 'CREATE_LISTING':
      return {
        title: 'List this item for sale',
        lines: [
          { label: 'Item', value: action.nftId },
          { label: 'Collection', value: r(action.nftResource) },
          { label: 'Asking price', value: r(action.priceRaw) },
          { label: 'Paid in', value: r(action.quoteResource) },
        ],
      };
    case 'CANCEL_LISTING':
      return { title: 'Cancel this listing', lines: [{ label: 'Listing', value: r(action.listingAddress) }, { label: 'Item', value: action.nftId }] };
    case 'MAKE_ITEM_OFFER':
      return {
        title: 'Offer to buy this item',
        lines: [
          { label: 'Item', value: action.nftId },
          { label: 'Collection', value: r(action.nftResource) },
          { label: 'Your offer', value: r(action.offerAmountRaw) },
          { label: 'Paid in', value: r(action.quoteResource) },
        ],
      };
    case 'CANCEL_ITEM_OFFER':
      return {
        title: 'Cancel your offer',
        lines: [
          { label: 'Offer', value: r(action.offerAddress) },
          { label: 'Escrow to return', value: r(action.refundAmountRaw) },
          { label: 'Item', value: action.nftId },
        ],
      };
    case 'REFUND_ITEM_OFFER':
      return {
        title: 'Refund this expired offer',
        lines: [
          { label: 'Offer', value: r(action.offerAddress) },
          { label: 'Escrow to return', value: r(action.refundAmountRaw) },
          { label: 'Item', value: action.nftId },
        ],
      };
    case 'PLACE_COLLECTION_BID':
      return {
        title: 'Place a bid on this collection',
        lines: [
          { label: 'Collection', value: r(action.collectionResource) },
          { label: 'Price per item', value: r(action.pricePerNftRaw) },
          { label: 'Quantity', value: r(action.quantityRaw) },
          { label: 'Total escrow', value: 'price x quantity' },
        ],
      };
    case 'CANCEL_COLLECTION_BID':
      return {
        title: 'Cancel this bid',
        lines: [
          { label: 'Bid', value: r(action.bidAddress) },
          { label: 'Remaining escrow', value: r(action.refundAmountRaw) },
          { label: 'Refund', value: 'returns to your account' },
        ],
      };
    case 'REFUND_COLLECTION_BID':
      return {
        title: 'Refund this expired bid',
        lines: [
          { label: 'Bid', value: r(action.bidAddress) },
          { label: 'Remaining escrow', value: r(action.refundAmountRaw) },
          { label: 'Refund', value: 'returns to your account' },
        ],
      };
    default: {
      const unreachable: never = action;
      throw new Error(`Refusing to summarise an unrecognised marketplace action: ${JSON.stringify(unreachable)}`);
    }
  }
}