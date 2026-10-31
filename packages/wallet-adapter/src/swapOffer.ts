/**
 * Signer-agnostic SwapOffer intents (templates/p2p_offer): create, fill, claim, cancel.
 *
 * Every builder emits the exact instruction shape the real v0.48 engine executed in
 * audit_engine_tests/tests/instruction_wire_v048.rs (swap_offer_* scenarios), and every bucket
 * a call returns is deposited into the caller's account in the same transaction (the engine
 * rejects a dangling bucket, multihop_routes.rs m05):
 *
 *   create  withdraw(offered) -> SwapOffer::create(bucket, want_resource, want_amount,
 *           want_nft, designated_taker, hash_lock, expires_at_epoch)
 *   fill    withdraw(payment) -> offer.fill(bucket, preimage) -> deposit(received)
 *   claim   offer.claim() -> deposit(proceeds)
 *   cancel  offer.cancel() -> deposit(refund)
 *
 * The asset's type is never changed: a fungible is withdrawn with `withdraw`, an NFT with
 * `withdraw_non_fungible` and its exact canonical id, and what comes back is deposited as is.
 * A Stealth-typed asset (native tTARI or a created-Stealth resource) cannot be withdrawn this
 * way at all; it goes through the wallet's own stealth withdrawal (see the web app's
 * `stealthWithdraw` service), with the SAME follow-up instructions these builders produce.
 */

export type SwapOfferOperation = 'swap_offer_create' | 'swap_offer_fill' | 'swap_offer_claim' | 'swap_offer_cancel';

export type SwapOfferArgType = 'Bucket' | 'ResourceAddress' | 'Amount' | 'Option<NonFungibleId>' | 'Option<PublicKey>' | 'Option<Hash32>' | 'u64' | 'Option<Bytes>';

interface WorkspaceBucket {
  kind: 'workspace_bucket';
  name: string;
}

/** SwapOffer::create(offer, want_resource, want_amount, want_nft, designated_taker, hash_lock, expires_at_epoch) */
export const SWAP_OFFER_CREATE_ARG_TYPES: readonly SwapOfferArgType[] = ['Bucket', 'ResourceAddress', 'Amount', 'Option<NonFungibleId>', 'Option<PublicKey>', 'Option<Hash32>', 'u64'];
/** SwapOffer::fill(payment, preimage) -> Bucket */
export const SWAP_OFFER_FILL_ARG_TYPES: readonly SwapOfferArgType[] = ['Bucket', 'Option<Bytes>'];

export type OfferAsset =
  | { kind: 'fungible'; resource: string; amount: string }
  | { kind: 'nft'; resource: string; nftId: string };

export type SwapOfferInstruction =
  | { kind: 'withdraw_fungible'; accountAddress: string; resourceAddress: string; amount: string; output: WorkspaceBucket }
  | { kind: 'withdraw_non_fungible'; accountAddress: string; resourceAddress: string; nonFungibleId: string; output: WorkspaceBucket }
  | { kind: 'call_function'; templateAddress: string; method: 'create'; args: Array<string | WorkspaceBucket | null>; argTypes: readonly SwapOfferArgType[]; output?: WorkspaceBucket }
  | { kind: 'call_method'; componentAddress: string; method: 'fill' | 'claim' | 'cancel'; args: Array<string | WorkspaceBucket | null>; argTypes: readonly SwapOfferArgType[]; resourcesInvolved: string[]; output: WorkspaceBucket }
  | { kind: 'deposit_all'; accountAddress: string; bucket: WorkspaceBucket };

export interface SwapOfferTransactionIntent {
  readonly kind: 'swap_offer';
  readonly operation: SwapOfferOperation;
  readonly accountAddress: string;
  /** create: the template; others: the offer component. */
  readonly target: string;
  readonly instructions: readonly SwapOfferInstruction[];
  /** What leaves the account in this transaction (create: the offer; fill: the payment). */
  readonly spends?: OfferAsset;
  /** create only: the terms written into the escrow. */
  readonly terms?: SwapOfferTerms;
  readonly evidence: { readonly operationId: string; readonly maxEpoch: string };
  readonly privacyDisclosure: string;
}

export interface SwapOfferTerms {
  readonly offered: OfferAsset;
  readonly requested: OfferAsset;
  /** 64-hex public key, or null for anyone. */
  readonly designatedTaker: string | null;
  /** 64-hex SHA-256 of the preimage, or null. */
  readonly hashLock: string | null;
  /** Decimal epoch; '0' = never. */
  readonly expiresAtEpoch: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const RAW = /^(?:0|[1-9]\d*)$/;

function bucket(name: string): WorkspaceBucket {
  return { kind: 'workspace_bucket', name };
}

function requireComponent(value: string, field: string): void {
  if (!/^component_[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be component_<64 hex>`);
}

function requireResource(value: string, field: string): void {
  if (!/^resource_[0-9a-f]{64}$/.test(value)) throw new Error(`${field} must be resource_<64 hex>`);
}

function requireCanonicalNftId(value: string, field: string): void {
  if (!/^(?:uuid_[0-9a-f]{64}|str_.{1,64}|u32_(?:0|[1-9]\d*)|u64_(?:0|[1-9]\d*))$/su.test(value)) {
    throw new Error(`${field} must be a canonical NonFungibleId (uuid_<hex>, str_<text>, u32_<n>, u64_<n>)`);
  }
}

export function assertOfferAsset(asset: OfferAsset, field: string): void {
  requireResource(asset.resource, `${field}.resource`);
  if (asset.kind === 'fungible') {
    if (!RAW.test(asset.amount) || BigInt(asset.amount) === 0n) throw new Error(`${field}.amount must be a positive raw integer`);
  } else if (asset.kind === 'nft') {
    requireCanonicalNftId(asset.nftId, `${field}.nftId`);
  } else {
    throw new Error(`${field} has an unknown kind`);
  }
}

function withdraw(account: string, asset: OfferAsset, output: WorkspaceBucket): SwapOfferInstruction {
  return asset.kind === 'fungible'
    ? { kind: 'withdraw_fungible', accountAddress: account, resourceAddress: asset.resource, amount: asset.amount, output }
    : { kind: 'withdraw_non_fungible', accountAddress: account, resourceAddress: asset.resource, nonFungibleId: asset.nftId, output };
}

const DISCLOSURE = 'PUBLIC P2P ESCROW: the offered asset, the requested asset and their amounts or NFT ids are visible on-chain.';

export interface CreateSwapOfferInput extends SwapOfferTerms {
  /** The SwapOffer template RECORDED for the verified network generation (64 hex, optional template_ prefix). */
  offerTemplateAddress: string;
  accountAddress: string;
  maxEpoch: string;
  operationId: string;
}

export function buildCreateSwapOfferIntent(input: CreateSwapOfferInput): SwapOfferTransactionIntent {
  const template = input.offerTemplateAddress.replace(/^template_/, '');
  if (!HEX64.test(template)) throw new Error('offerTemplateAddress must be a 64-hex template address');
  requireComponent(input.accountAddress, 'accountAddress');
  assertOfferAsset(input.offered, 'offered');
  assertOfferAsset(input.requested, 'requested');
  if (input.offered.resource === input.requested.resource) throw new Error('an offer must exchange two different resources');
  if (input.designatedTaker !== null && !HEX64.test(input.designatedTaker)) throw new Error('designatedTaker must be a 64-hex public key or null');
  if (input.hashLock !== null && !HEX64.test(input.hashLock)) throw new Error('hashLock must be a 64-hex SHA-256 digest or null');
  if (!RAW.test(input.expiresAtEpoch)) throw new Error('expiresAtEpoch must be a raw integer (0 = never)');
  const escrow = bucket('offer_escrow');
  const want = input.requested;
  return {
    kind: 'swap_offer',
    operation: 'swap_offer_create',
    accountAddress: input.accountAddress,
    target: `template_${template}`,
    spends: input.offered,
    terms: { offered: input.offered, requested: want, designatedTaker: input.designatedTaker, hashLock: input.hashLock, expiresAtEpoch: input.expiresAtEpoch },
    instructions: [
      withdraw(input.accountAddress, input.offered, escrow),
      {
        kind: 'call_function',
        templateAddress: `template_${template}`,
        method: 'create',
        args: [escrow, want.resource, want.kind === 'fungible' ? want.amount : '0', want.kind === 'nft' ? want.nftId : null, input.designatedTaker, input.hashLock, input.expiresAtEpoch],
        argTypes: SWAP_OFFER_CREATE_ARG_TYPES,
      },
    ],
    evidence: { operationId: input.operationId, maxEpoch: input.maxEpoch },
    privacyDisclosure: DISCLOSURE,
  };
}

export interface FillSwapOfferInput {
  offerComponent: string;
  accountAddress: string;
  /** EXACTLY what the on-chain offer wants (from decodeSwapOffer, never from an invitation). */
  payment: OfferAsset;
  /** Hex preimage for a hash-locked offer, else null. Supplied by the taker; never in an invitation. */
  preimage: string | null;
  maxEpoch: string;
  operationId: string;
}

export function buildFillSwapOfferIntent(input: FillSwapOfferInput): SwapOfferTransactionIntent {
  requireComponent(input.offerComponent, 'offerComponent');
  requireComponent(input.accountAddress, 'accountAddress');
  assertOfferAsset(input.payment, 'payment');
  if (input.preimage !== null && (!/^(?:[0-9a-f]{2})+$/.test(input.preimage) || input.preimage.length > 512)) {
    throw new Error('preimage must be 1..256 bytes of lowercase hex, or null');
  }
  const pay = bucket('offer_payment');
  const got = bucket('offer_received');
  return {
    kind: 'swap_offer',
    operation: 'swap_offer_fill',
    accountAddress: input.accountAddress,
    target: input.offerComponent,
    spends: input.payment,
    instructions: [
      withdraw(input.accountAddress, input.payment, pay),
      { kind: 'call_method', componentAddress: input.offerComponent, method: 'fill', args: [pay, input.preimage], argTypes: SWAP_OFFER_FILL_ARG_TYPES, resourcesInvolved: [input.payment.resource], output: got },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: got },
    ],
    evidence: { operationId: input.operationId, maxEpoch: input.maxEpoch },
    privacyDisclosure: DISCLOSURE,
  };
}

function makerAction(operation: 'swap_offer_claim' | 'swap_offer_cancel', input: { offerComponent: string; accountAddress: string; maxEpoch: string; operationId: string }): SwapOfferTransactionIntent {
  requireComponent(input.offerComponent, 'offerComponent');
  requireComponent(input.accountAddress, 'accountAddress');
  const method = operation === 'swap_offer_claim' ? 'claim' : 'cancel';
  const out = bucket(operation === 'swap_offer_claim' ? 'offer_proceeds' : 'offer_refund');
  return {
    kind: 'swap_offer',
    operation,
    accountAddress: input.accountAddress,
    target: input.offerComponent,
    instructions: [
      { kind: 'call_method', componentAddress: input.offerComponent, method, args: [], argTypes: [], resourcesInvolved: [], output: out },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: out },
    ],
    evidence: { operationId: input.operationId, maxEpoch: input.maxEpoch },
    privacyDisclosure: DISCLOSURE,
  };
}

/** The maker collects a filled offer's proceeds into their account. */
export function buildClaimSwapOfferIntent(input: { offerComponent: string; accountAddress: string; maxEpoch: string; operationId: string }): SwapOfferTransactionIntent {
  return makerAction('swap_offer_claim', input);
}

/** The maker recovers an open (or expired) offer's escrow into their account. */
export function buildCancelSwapOfferIntent(input: { offerComponent: string; accountAddress: string; maxEpoch: string; operationId: string }): SwapOfferTransactionIntent {
  return makerAction('swap_offer_cancel', input);
}

export function isSwapOfferIntent(value: unknown): value is SwapOfferTransactionIntent {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'swap_offer';
}
