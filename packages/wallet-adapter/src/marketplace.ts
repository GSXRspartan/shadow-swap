import { TransactionPreview } from './interface.js';

/**
 * Signer-agnostic marketplace transaction description. Wallet adapters translate these
 * instructions into their own manifest/SDK format, then sign and submit separately.
 *
 * The marketplace templates consume buckets, not resource-address/amount placeholders. Keeping
 * the withdrawal instructions explicit prevents an adapter from accidentally building a call
 * which cannot execute on-chain.
 */
export type MarketplaceOperation =
  | 'create_listing'
  | 'cancel_listing'
  | 'buy_listing'
  | 'create_item_offer'
  | 'cancel_item_offer'
  | 'accept_item_offer'
  | 'refund_expired_item_offer'
  | 'create_collection_bid'
  | 'fill_collection_bid'
  | 'cancel_collection_bid'
  | 'refund_expired_collection_bid';

export type MarketplaceTemplate = 'FixedPriceListing' | 'ItemOffer' | 'CollectionBid';

export interface WorkspaceBucket {
  kind: 'workspace_bucket';
  name: string;
}

export interface MarketplaceCall {
  componentAddress?: string;
  templateAddress?: string;
  templateName?: MarketplaceTemplate;
  method: string;
  args: Array<string | number | WorkspaceBucket>;
  resourcesInvolved: string[];
}

export type MarketplaceInstruction =
  | {
      kind: 'withdraw_fungible';
      accountAddress: string;
      resourceAddress: string;
      amount: string;
      output: WorkspaceBucket;
    }
  | {
      kind: 'withdraw_non_fungible';
      accountAddress: string;
      resourceAddress: string;
      nonFungibleId: string;
      output: WorkspaceBucket;
    }
  | ({ kind: 'call_function' } & MarketplaceCall)
  | ({ kind: 'call_method' } & MarketplaceCall);

/** Settlement facts known at construction time. Component IDs for creates are receipt-derived. */
export interface MarketplaceOrderTarget {
  componentOrOrderId?: string;
  nftResource: string;
  nftId?: string;
  quoteResource: string;
  amount?: string;
  expiryEpoch?: number;
}

export interface MarketplaceTransactionIntent {
  operation: MarketplaceOperation;
  target: MarketplaceOrderTarget;
  calls: MarketplaceCall[];
  instructions: MarketplaceInstruction[];
  /** Readbacks an adapter/router must obtain from chain state immediately before settlement. */
  requiredReadbacks: Array<'listing' | 'offer' | 'bid'>;
  privacyDisclosure: 'PUBLIC_NFT_PUBLIC_MARKET';
}

/** Durable, UI-independent status payload that an adapter/indexer can persist after submission. */
export interface MarketplaceTransactionResult {
  operation: MarketplaceOperation;
  componentOrOrderId?: string;
  nftResource: string;
  nftId?: string;
  quoteResource: string;
  amount?: string;
  transactionId: string;
  submittedState: 'SUBMITTED';
  finalState: 'PENDING' | 'FINALIZED' | 'REJECTED';
  failureReason?: string;
  creationEpoch?: number;
  submissionEpoch?: number;
}

export interface CreateListingInput {
  templateAddress: string;
  sellerAccount: string;
  nftResource: string;
  nftId: string;
  quoteResource: string;
  price: string;
  expiryEpoch: number;
}

export interface CreateItemOfferInput {
  templateAddress: string;
  buyerAccount: string;
  nftResource: string;
  nftId: string;
  quoteResource: string;
  offerAmount: string;
  expiryEpoch: number;
}

export interface CreateCollectionBidInput {
  templateAddress: string;
  buyerAccount: string;
  collectionResource: string;
  quoteResource: string;
  pricePerNft: string;
  /** Decimal u64 string; never pass an on-chain quantity through JavaScript number. */
  quantity: string;
  expiryEpoch: number;
}

function bucket(name: string): WorkspaceBucket {
  return { kind: 'workspace_bucket', name };
}

function functionCall(templateAddress: string, templateName: MarketplaceTemplate, method: string, args: MarketplaceCall['args'], resourcesInvolved: string[]): MarketplaceInstruction {
  return { kind: 'call_function', templateAddress, templateName, method, args, resourcesInvolved };
}

function methodCall(componentAddress: string, method: string, args: MarketplaceCall['args'], resourcesInvolved: string[]): MarketplaceInstruction {
  return { kind: 'call_method', componentAddress, method, args, resourcesInvolved };
}

function callsFrom(instructions: MarketplaceInstruction[]): MarketplaceCall[] {
  return instructions.filter(
    (instruction): instruction is Extract<MarketplaceInstruction, { kind: 'call_function' | 'call_method' }> =>
      instruction.kind === 'call_function' || instruction.kind === 'call_method',
  );
}

function intent(
  operation: MarketplaceOperation,
  target: MarketplaceOrderTarget,
  instructions: MarketplaceInstruction[],
  requiredReadbacks: MarketplaceTransactionIntent['requiredReadbacks'] = [],
): MarketplaceTransactionIntent {
  return {
    operation,
    target,
    calls: callsFrom(instructions),
    instructions,
    requiredReadbacks,
    privacyDisclosure: 'PUBLIC_NFT_PUBLIC_MARKET',
  };
}

function preview(intentValue: MarketplaceTransactionIntent): TransactionPreview {
  const first = intentValue.calls[0];
  return {
    componentAddress: first?.componentAddress ?? first?.templateAddress,
    method: first?.method,
    args: intentValue.instructions,
    resourcesInvolved: [...new Set(intentValue.calls.flatMap((call) => call.resourcesInvolved))],
    estimatedOutputs: [],
    fee: 0,
    maxEpoch: intentValue.target.expiryEpoch ?? 0,
    privacyDisclosure:
      'PUBLIC NFT / PUBLIC MARKET BOUNDARY: NFT identities, order amounts, and settlement are revealed.',
    networkName: '',
  };
}

function positiveDecimal(value: string, field: string): void {
  if (!/^\d+(?:\.\d+)?$/.test(value) || /^0+(?:\.0+)?$/.test(value)) {
    throw new Error(`${field} must be a positive decimal string`);
  }
}

function multiplyDecimal(value: string, multiplier: string): string {
  positiveDecimal(value, 'pricePerNft');
  if (!/^[1-9]\d*$/.test(multiplier)) {
    throw new Error('quantity must be a positive integer string');
  }
  const [whole, fraction = ''] = value.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(whole) * scale + BigInt(fraction || '0');
  const product = scaled * BigInt(multiplier);
  const productWhole = product / scale;
  const productFraction = (product % scale).toString().padStart(fraction.length, '0').replace(/0+$/, '');
  return productFraction ? `${productWhole}.${productFraction}` : productWhole.toString();
}

export function createListing(input: CreateListingInput): MarketplaceTransactionIntent {
  positiveDecimal(input.price, 'price');
  const nft = bucket('listing_nft');
  return intent(
    'create_listing',
    { nftResource: input.nftResource, nftId: input.nftId, quoteResource: input.quoteResource, amount: input.price, expiryEpoch: input.expiryEpoch },
    [
      { kind: 'withdraw_non_fungible', accountAddress: input.sellerAccount, resourceAddress: input.nftResource, nonFungibleId: input.nftId, output: nft },
      functionCall(input.templateAddress, 'FixedPriceListing', 'create', [input.sellerAccount, nft, input.quoteResource, input.price, input.expiryEpoch], [input.nftResource, input.quoteResource]),
    ],
  );
}

export function cancelListing(listingAddress: string, target: MarketplaceOrderTarget): MarketplaceTransactionIntent {
  return intent('cancel_listing', { ...target, componentOrOrderId: listingAddress }, [methodCall(listingAddress, 'cancel', [], [])], ['listing']);
}

export function buyListing(listingAddress: string, buyerAccount: string, quoteResource: string, amount: string, target: Omit<MarketplaceOrderTarget, 'componentOrOrderId' | 'quoteResource' | 'amount'>): MarketplaceTransactionIntent {
  positiveDecimal(amount, 'amount');
  const payment = bucket('listing_payment');
  return intent(
    'buy_listing',
    { ...target, componentOrOrderId: listingAddress, quoteResource, amount },
    [
      { kind: 'withdraw_fungible', accountAddress: buyerAccount, resourceAddress: quoteResource, amount, output: payment },
      methodCall(listingAddress, 'buy', [payment, buyerAccount], [quoteResource]),
    ],
    ['listing'],
  );
}

export function createItemOffer(input: CreateItemOfferInput): MarketplaceTransactionIntent {
  positiveDecimal(input.offerAmount, 'offerAmount');
  const quote = bucket('item_offer_quote');
  return intent(
    'create_item_offer',
    { nftResource: input.nftResource, nftId: input.nftId, quoteResource: input.quoteResource, amount: input.offerAmount, expiryEpoch: input.expiryEpoch },
    [
      { kind: 'withdraw_fungible', accountAddress: input.buyerAccount, resourceAddress: input.quoteResource, amount: input.offerAmount, output: quote },
      functionCall(input.templateAddress, 'ItemOffer', 'create', [input.buyerAccount, quote, input.nftResource, input.nftId, input.expiryEpoch], [input.nftResource, input.quoteResource]),
    ],
  );
}

export function cancelItemOffer(offerAddress: string, target: MarketplaceOrderTarget): MarketplaceTransactionIntent {
  return intent('cancel_item_offer', { ...target, componentOrOrderId: offerAddress }, [methodCall(offerAddress, 'cancel', [], [])], ['offer']);
}

export function acceptItemOffer(offerAddress: string, sellerAccount: string, nftResource: string, nftId: string, target: Omit<MarketplaceOrderTarget, 'componentOrOrderId' | 'nftResource' | 'nftId'>): MarketplaceTransactionIntent {
  const nft = bucket('item_offer_nft');
  return intent(
    'accept_item_offer',
    { ...target, componentOrOrderId: offerAddress, nftResource, nftId },
    [
      { kind: 'withdraw_non_fungible', accountAddress: sellerAccount, resourceAddress: nftResource, nonFungibleId: nftId, output: nft },
      methodCall(offerAddress, 'accept', [nft, sellerAccount], [nftResource]),
    ],
    ['offer'],
  );
}

export function refundExpiredItemOffer(offerAddress: string, target: MarketplaceOrderTarget): MarketplaceTransactionIntent {
  return intent('refund_expired_item_offer', { ...target, componentOrOrderId: offerAddress }, [methodCall(offerAddress, 'refund_expired', [], [])], ['offer']);
}

export function createCollectionBid(input: CreateCollectionBidInput): MarketplaceTransactionIntent {
  const escrowAmount = multiplyDecimal(input.pricePerNft, input.quantity);
  const quote = bucket('collection_bid_quote');
  return intent(
    'create_collection_bid',
    { nftResource: input.collectionResource, quoteResource: input.quoteResource, amount: escrowAmount, expiryEpoch: input.expiryEpoch },
    [
      { kind: 'withdraw_fungible', accountAddress: input.buyerAccount, resourceAddress: input.quoteResource, amount: escrowAmount, output: quote },
      functionCall(input.templateAddress, 'CollectionBid', 'create', [input.buyerAccount, quote, input.collectionResource, input.pricePerNft, input.quantity, input.expiryEpoch], [input.collectionResource, input.quoteResource]),
    ],
  );
}

export function fillCollectionBid(bidAddress: string, sellerAccount: string, nftResource: string, nftId: string, target: Omit<MarketplaceOrderTarget, 'componentOrOrderId' | 'nftResource' | 'nftId'>): MarketplaceTransactionIntent {
  const nft = bucket('collection_bid_nft');
  return intent(
    'fill_collection_bid',
    { ...target, componentOrOrderId: bidAddress, nftResource, nftId },
    [
      { kind: 'withdraw_non_fungible', accountAddress: sellerAccount, resourceAddress: nftResource, nonFungibleId: nftId, output: nft },
      methodCall(bidAddress, 'fill', [nft, sellerAccount], [nftResource]),
    ],
    ['bid'],
  );
}

export function cancelCollectionBid(bidAddress: string, target: MarketplaceOrderTarget): MarketplaceTransactionIntent {
  return intent('cancel_collection_bid', { ...target, componentOrOrderId: bidAddress }, [methodCall(bidAddress, 'cancel', [], [])], ['bid']);
}

export function refundExpiredCollectionBid(bidAddress: string, target: MarketplaceOrderTarget): MarketplaceTransactionIntent {
  return intent('refund_expired_collection_bid', { ...target, componentOrOrderId: bidAddress }, [methodCall(bidAddress, 'refund_expired', [], [])], ['bid']);
}

/** Creates the adapter/indexer persistence record after a transaction has actually been submitted. */
export function submittedMarketplaceResult(intentValue: MarketplaceTransactionIntent, transactionId: string, submissionEpoch?: number): MarketplaceTransactionResult {
  return {
    operation: intentValue.operation,
    componentOrOrderId: intentValue.target.componentOrOrderId,
    nftResource: intentValue.target.nftResource,
    nftId: intentValue.target.nftId,
    quoteResource: intentValue.target.quoteResource,
    amount: intentValue.target.amount,
    transactionId,
    submittedState: 'SUBMITTED',
    finalState: 'PENDING',
    submissionEpoch,
  };
}

/** Converts an intent into the existing adapter preview seam without selecting a wallet. */
export function toMarketplacePreview(intentValue: MarketplaceTransactionIntent): TransactionPreview {
  return preview(intentValue);
}
