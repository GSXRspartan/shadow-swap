/**
 * Browser transaction builders for the Ootle L2 leg of a cross-layer exchange
 * (`templates/cross_layer_htlc`).
 *
 * WHAT THESE SETTLE. A user exchanges existing L2 TARI for existing L1 XTM that a counterparty
 * already holds. No burn, no mint, no bridge, no custodian. The L1 leg is Minotari's own SHA
 * atomic swap; this is the other half.
 *
 * WHY THE WIRE FORMAT IS THE WHOLE POINT. An advertised wallet capability is not evidence that a
 * transaction executes — that lesson is already written into this repository's history. So every
 * instruction list these builders produce is compared BYTE FOR BYTE against instructions the real
 * v0.48 engine executed, captured in `apps/web/test/fixtures/ootle-v048-instructions.json` by
 * `audit_engine_tests/tests/instruction_wire_v048.rs` (`cross_layer_fund`, `cross_layer_claim`,
 * `cross_layer_refund`). If those tests pass, what the browser hands a wallet is a transaction the
 * engine runs.
 *
 * THE ABI, from the template:
 *
 *   fund(asset: Bucket, hash_lock: Hash32, claimant: RistrettoPublicKeyBytes,
 *        expires_at_epoch: u64, counterparty_leg: String) -> Component
 *   claim(preimage: Vec<u8>) -> Bucket
 *   refund() -> Bucket
 *
 * `fund` produces a COMPONENT, not a bucket, so there is nothing to deposit: the escrow holds the
 * asset until a claim or a refund. `claim` and `refund` each return a bucket that MUST be
 * deposited, or the engine rejects the transaction for a dangling output.
 */

/**
 * Its OWN intent type, as `swapOffer.ts` does for the same reason: a one-sided cross-chain escrow
 * is not an AMM trade, and forcing it into `AmmTransactionIntent` would mean widening the AMM arg
 * types and inventing a quote for operations that have none.
 */
export type CrossLayerArgType = 'Bucket' | 'Hash32' | 'PublicKey' | 'u64' | 'String' | 'Bytes';

/** `fund` — the hash and claimant are inputs, never generated here (L1 picks the preimage). */
export const CROSS_LAYER_FUND_ARG_TYPES: readonly CrossLayerArgType[] = ['Bucket', 'Hash32', 'PublicKey', 'u64', 'String'];
/** `claim(preimage: Vec<u8>)` — a generic `Vec<u8>`, which the engine encodes as a CBOR array. */
export const CROSS_LAYER_CLAIM_ARG_TYPES: readonly CrossLayerArgType[] = ['Bytes'];
/** `refund()` takes nothing: authority comes from the signer, and timing from consensus. */
export const CROSS_LAYER_REFUND_ARG_TYPES: readonly CrossLayerArgType[] = [];

export type CrossLayerOperationKind = 'cross_layer_fund' | 'cross_layer_claim' | 'cross_layer_refund';

interface WorkspaceBucket {
  readonly kind: 'workspace_bucket';
  readonly name: string;
}

export type CrossLayerInstruction =
  | { kind: 'withdraw_fungible'; accountAddress: string; resourceAddress: string; amount: string; output: WorkspaceBucket }
  | { kind: 'call_function'; templateAddress: string; method: 'fund'; args: Array<string | WorkspaceBucket>; argTypes: readonly CrossLayerArgType[] }
  | { kind: 'call_method'; componentAddress: string; method: 'claim' | 'refund'; args: Array<string | WorkspaceBucket>; argTypes: readonly CrossLayerArgType[]; resourcesInvolved: string[]; output: WorkspaceBucket }
  | { kind: 'deposit_all'; accountAddress: string; bucket: WorkspaceBucket };

/** The terms a `fund` writes into the escrow, shown verbatim on the review card. */
export interface CrossLayerTerms {
  readonly resourceAddress: string;
  readonly rawAmount: string;
  readonly hashLockHex: string;
  readonly claimantPublicKeyHex: string;
  readonly expiresAtEpoch: string;
  readonly counterpartyLeg: string;
}

export interface CrossLayerTransactionIntent {
  readonly kind: 'cross_layer_htlc';
  readonly operation: CrossLayerOperationKind;
  readonly accountAddress: string;
  /** fund: the template; claim/refund: the escrow component. */
  readonly target: string;
  readonly instructions: readonly CrossLayerInstruction[];
  /** fund only: exactly what this transaction commits, for the review card. */
  readonly terms?: CrossLayerTerms;
  /** What leaves or arrives in the account. `fund` deposits nothing: the escrow is a component. */
  readonly settlement: { readonly accountAddress: string; readonly outputBuckets: readonly string[] };
  readonly evidence: { readonly operationId: string; readonly maxEpoch: string; readonly readEpoch?: string };
  readonly privacyDisclosure: string;
}

/**
 * What a signer must be told before authorising either escrow. A cross-layer trade reveals more
 * than a same-chain one — the counterparty learns an L1 address and an L2 account — and the first
 * leg is irreversible once the counterparty claims it.
 */
export const CROSS_LAYER_DISCLOSURE =
  'CROSS-LAYER EXCHANGE, NOT A SWAP IN ONE TRANSACTION: this funds ONE side on ONE chain. Your counterparty funds the other side on the other chain, and settlement takes four transactions across two chains. Amounts, both accounts and the timing are public on both chains. If the counterparty does not complete, you recover your own escrow only AFTER its deadline — not before.';

const HEX64 = /^[0-9a-f]{64}$/i;
const EVEN_HEX = /^([0-9a-f]{2})+$/i;
const RAW_UINT = /^\d+$/;

export class CrossLayerBuildError extends Error {}

function bucket(name: string) {
  return { kind: 'workspace_bucket' as const, name };
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CrossLayerBuildError(`${field} is required`);
  return value;
}

function requireHex64(value: string, field: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new CrossLayerBuildError(`${field} must be 64 hex characters (32 bytes)`);
  }
  return value.toLowerCase();
}

function requireRaw(value: string, field: string): bigint {
  if (!RAW_UINT.test(value)) throw new CrossLayerBuildError(`${field} must be a raw non-negative integer string`);
  return BigInt(value);
}

export interface CrossLayerFundInput {
  /** A `CrossLayerHtlc` template RECORDED for the verified network generation. */
  readonly templateAddress: string;
  readonly accountAddress: string;
  readonly resourceAddress: string;
  readonly rawAmount: string;
  /** SHA-256 of the preimage, taken from the counterparty's ALREADY FUNDED leg. */
  readonly hashLockHex: string;
  /** The counterparty's L2 account public key: the only key that may claim. */
  readonly claimantPublicKeyHex: string;
  /** Absolute L2 epoch. Must come from `deriveTimeouts`, never a browser clock. */
  readonly expiresAtEpoch: string;
  /** Identifies the other chain's leg — for Minotari, its output hash. */
  readonly counterpartyLeg: string;
  readonly maxEpoch: string;
  readonly operationId: string;
  /** The epoch the terms were derived against, kept as evidence of freshness. */
  readonly readEpoch?: string;
}

/**
 * `withdraw -> fund`. No deposit: `fund` returns a Component, and the asset stays in the escrow.
 *
 * Every binding the protocol depends on is an explicit argument — resource, amount, hash lock,
 * claimant and expiry — so a review card shows the signer exactly what they are committing to.
 */
export function buildCrossLayerFundIntent(input: CrossLayerFundInput): CrossLayerTransactionIntent {
  requireNonEmpty(input.templateAddress, 'templateAddress');
  requireNonEmpty(input.accountAddress, 'accountAddress');
  requireNonEmpty(input.resourceAddress, 'resourceAddress');
  if (requireRaw(input.rawAmount, 'rawAmount') <= 0n) {
    throw new CrossLayerBuildError('rawAmount must be positive: an empty escrow cannot be claimed');
  }
  requireHex64(input.hashLockHex, 'hashLockHex');
  requireHex64(input.claimantPublicKeyHex, 'claimantPublicKeyHex');
  const expiry = requireRaw(input.expiresAtEpoch, 'expiresAtEpoch');
  if (expiry === 0n) throw new CrossLayerBuildError('expiresAtEpoch must be a positive absolute L2 epoch');
  if (input.readEpoch !== undefined && requireRaw(input.readEpoch, 'readEpoch') >= expiry) {
    throw new CrossLayerBuildError(
      `expiresAtEpoch ${input.expiresAtEpoch} is not after the epoch the terms were read at (${input.readEpoch}); an escrow that is already expired could be refunded before it could ever be claimed`,
    );
  }
  requireNonEmpty(input.counterpartyLeg, 'counterpartyLeg');
  if (input.counterpartyLeg.length > 128) {
    throw new CrossLayerBuildError('counterpartyLeg must be at most 128 characters, matching the template bound');
  }

  const escrow = bucket('cross_layer_escrow');
  return {
    kind: 'cross_layer_htlc',
    operation: 'cross_layer_fund',
    accountAddress: input.accountAddress,
    target: `template_${input.templateAddress}`,
    instructions: [
      { kind: 'withdraw_fungible', accountAddress: input.accountAddress, resourceAddress: input.resourceAddress, amount: input.rawAmount, output: escrow },
      {
        kind: 'call_function',
        templateAddress: `template_${input.templateAddress}`,
        method: 'fund',
        args: [escrow, input.hashLockHex, input.claimantPublicKeyHex, input.expiresAtEpoch, input.counterpartyLeg],
        argTypes: CROSS_LAYER_FUND_ARG_TYPES,
      },
    ],
    terms: {
      resourceAddress: input.resourceAddress,
      rawAmount: input.rawAmount,
      hashLockHex: input.hashLockHex.toLowerCase(),
      claimantPublicKeyHex: input.claimantPublicKeyHex.toLowerCase(),
      expiresAtEpoch: input.expiresAtEpoch,
      counterpartyLeg: input.counterpartyLeg,
    },
    // Nothing is deposited: `fund` returns a Component, and the asset stays in the escrow.
    settlement: { accountAddress: input.accountAddress, outputBuckets: [] },
    evidence: {
      operationId: input.operationId,
      maxEpoch: input.maxEpoch,
      ...(input.readEpoch === undefined ? {} : { readEpoch: input.readEpoch }),
    },
    privacyDisclosure: CROSS_LAYER_DISCLOSURE,
  };
}

export interface CrossLayerClaimInput {
  readonly htlcComponent: string;
  readonly accountAddress: string;
  /** The preimage, as even-length hex. Secret until this transaction publishes it. */
  readonly preimageHex: string;
  readonly maxEpoch: string;
  readonly operationId: string;
}

/** `claim -> deposit`. The returned bucket must be deposited or the engine rejects the output. */
export function buildCrossLayerClaimIntent(input: CrossLayerClaimInput): CrossLayerTransactionIntent {
  requireNonEmpty(input.htlcComponent, 'htlcComponent');
  requireNonEmpty(input.accountAddress, 'accountAddress');
  if (!EVEN_HEX.test(input.preimageHex)) {
    throw new CrossLayerBuildError('preimageHex must be a non-empty even-length hex string');
  }
  if (input.preimageHex.length / 2 > 64) {
    throw new CrossLayerBuildError('preimageHex must be at most 64 bytes, matching the template bound');
  }
  const out = bucket('cross_layer_claim');
  return {
    kind: 'cross_layer_htlc',
    operation: 'cross_layer_claim',
    accountAddress: input.accountAddress,
    target: input.htlcComponent,
    instructions: [
      { kind: 'call_method', componentAddress: input.htlcComponent, method: 'claim', args: [input.preimageHex], argTypes: CROSS_LAYER_CLAIM_ARG_TYPES, resourcesInvolved: [], output: out },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: out },
    ],
    settlement: { accountAddress: input.accountAddress, outputBuckets: [out.name] },
    evidence: { operationId: input.operationId, maxEpoch: input.maxEpoch },
    privacyDisclosure: CROSS_LAYER_DISCLOSURE,
  };
}

export interface CrossLayerRefundInput {
  readonly htlcComponent: string;
  readonly accountAddress: string;
  readonly maxEpoch: string;
  readonly operationId: string;
}

/** `refund -> deposit`. Only the funder's key passes the component's access rule. */
export function buildCrossLayerRefundIntent(input: CrossLayerRefundInput): CrossLayerTransactionIntent {
  requireNonEmpty(input.htlcComponent, 'htlcComponent');
  requireNonEmpty(input.accountAddress, 'accountAddress');
  const out = bucket('cross_layer_refund');
  return {
    kind: 'cross_layer_htlc',
    operation: 'cross_layer_refund',
    accountAddress: input.accountAddress,
    target: input.htlcComponent,
    instructions: [
      { kind: 'call_method', componentAddress: input.htlcComponent, method: 'refund', args: [], argTypes: CROSS_LAYER_REFUND_ARG_TYPES, resourcesInvolved: [], output: out },
      { kind: 'deposit_all', accountAddress: input.accountAddress, bucket: out },
    ],
    settlement: { accountAddress: input.accountAddress, outputBuckets: [out.name] },
    evidence: { operationId: input.operationId, maxEpoch: input.maxEpoch },
    privacyDisclosure: CROSS_LAYER_DISCLOSURE,
  };
}
