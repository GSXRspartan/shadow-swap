/**
 * Minotari L1 -> Ootle L2 conversion by the upstream BURN-AND-CLAIM protocol.
 *
 * WHAT THIS IS AND IS NOT
 *
 * A user burns XTM on the base layer naming an L2 account, then claims the equivalent XTR on
 * L2. It is a one-way, MULTI-STAGE conversion, not an atomic swap: the L1 burn is irreversible
 * the moment it confirms, and every later step can fail, be delayed or need recovery. Nothing
 * in this module may be presented as atomic or as reversible.
 *
 * WHY THE CLAIM ITSELF CANNOT BE BUILT HERE (measured against v0.48.0, 6a25dbc)
 *
 * `applications/tari_walletd/src/handlers/accounts.rs::build_claim_burn_transaction` needs,
 * from the account's SECRET key:
 *   * the stealth spend secret `s = H(R·p) + p`, where `R` is the burn output's sender offset
 *     public key — and the claim transaction must be SIGNED BY `s`, not by the account key;
 *   * decryption of the burn output's `encrypted_data` to recover its mask and value;
 *   * a fresh stealth output (mask, nonce, tag) for the claimed funds.
 *
 * None of that is expressible as an instruction list, so no dApp can construct a claim, and
 * `Instruction::ClaimBurn` cannot be assembled from public data alone. Sapient advertises no
 * burn or claim capability at all (its `WalletCapabilities` has no such field), so the claim
 * is performed BY THE USER'S OWN WALLET — `walletd` exposes `accounts.claim_burn`. Shadow Swap
 * therefore does the parts it honestly can:
 *
 *   1. state the correct L2 destination for the burn (the connected account's public key, read
 *      from that account's own component header on chain);
 *   2. validate a burn proof file's PUBLIC structure and tell the user whether it is even
 *      intended for the account they have connected, before they attempt a claim;
 *   3. say whether L2 has synced past the proof's `mined_in_epoch`, because a claim submitted
 *      earlier is permanently rejected;
 *   4. track the conversion in evidence-based states, persisting only non-secret identifiers;
 *   5. confirm receipt from an AUTHORITATIVE balance read, after which the existing AMM and
 *      P2P routes can trade the claimed XTR.
 *
 * NO L2 -> L1 ROUTE EXISTS. The complete v0.48 instruction set is CreateAccount, CallFunction,
 * CallMethod, PutLastInstructionOutputOnWorkspace, ClaimBurn, ClaimValidatorFees,
 * DropAllProofsInWorkspace, Assert, TakeFromBucket, PublishTemplate, AllocateAddress,
 * StealthTransfer, PayFeeFromBucket, UpdateComponentTemplate and PutIntoBucket. `ClaimBurn` is
 * strictly one-way; there is no L2-side burn or exit instruction, and no L1-side verifier that
 * would accept an L2 commitment proof. The missing primitives are exactly those two, and until
 * both exist an L2 -> L1 route cannot be built without an operator holding the L1 funds, which
 * this project will not do.
 */

const HEX64 = /^[0-9a-f]{64}$/i;
const HEX_ANY = /^(?:[0-9a-fA-F]{2})*$/;
const U64 = /^(?:0|[1-9]\d*)$/;

/** Upstream caps (crates/engine_types/src/confidential/claim.rs). Enforced before a file is trusted. */
const MAX_SCRIPT_BYTES = 4098;
const MAX_COVENANT_BYTES = 4098;
const MAX_ENCRYPTED_DATA_BYTES = 340;
const MAX_METADATA_SIGNATURE_BYTES = 256;
const MAX_MMR_PROOF_HASHES = 64;
/** walletd's own file-size ceiling, so a browser refuses what walletd would refuse. */
export const MAX_BURN_PROOF_CHARS = 512 * 1024;

export class BurnProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BurnProofError';
  }
}

export interface MmrInclusionProofShape {
  readonly leafIndex: string;
  readonly mmrSize: string;
  readonly pathLength: number;
  readonly peaksLength: number;
}

/**
 * The PUBLIC facts of a burn proof file, as `crates/sidechain/src/burn_proof.rs`
 * (`CompleteClaimBurnProof`) defines them. Deliberately not a re-implementation of the proof:
 * nothing here verifies the ownership proof or the MMR path, because only the engine (and the
 * wallet that signs with the claim key) can do that. These are the facts a user can be shown
 * and checked against their own account before they attempt an irreversible claim.
 */
export interface BurnClaimProofFacts {
  /** The L2 account public key the burn is intended for, 64 hex. */
  readonly burnPublicKey: string;
  /** Burned value in the base layer's smallest unit, exact. */
  readonly value: string;
  /** The burn output's commitment, 64 hex. Identifies the burn. */
  readonly commitment: string;
  /** The L1 block the output was mined in. */
  readonly blockHash: string;
  readonly blockHeight: string;
  /** L2 must have synced past this epoch or a claim is permanently rejected. */
  readonly minedInEpoch: string;
  /** The burn output's sender offset public key (`R` in the stealth derivation). */
  readonly senderOffsetPublicKey: string;
  readonly normalOutputProof: MmrInclusionProofShape;
  readonly blockOutputProof: MmrInclusionProofShape;
  /**
   * True when the file carried `encrypted_data`. The bytes themselves are deliberately NOT
   * returned or stored: they are the user's own output data and this app never needs them.
   */
  readonly hasEncryptedData: boolean;
}

function obj(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BurnProofError(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function hex(value: unknown, what: string, max?: number): string {
  if (typeof value !== 'string' || !HEX_ANY.test(value)) throw new BurnProofError(`${what} is not a hex string`);
  if (max !== undefined && value.length > max * 2) throw new BurnProofError(`${what} is longer than ${max} bytes`);
  return value.toLowerCase();
}

function hex32(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new BurnProofError(`${what} is not 32 bytes of hex`);
  return value.toLowerCase();
}

function u64(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && U64.test(value)) return value;
  throw new BurnProofError(`${what} is not an exact non-negative integer`);
}

function mmr(value: unknown, what: string): MmrInclusionProofShape {
  const bag = obj(value, what);
  const path = bag.path;
  const peaks = bag.peaks;
  if (!Array.isArray(path) || !Array.isArray(peaks)) throw new BurnProofError(`${what} carries no path and peaks`);
  if (path.length > MAX_MMR_PROOF_HASHES || peaks.length > MAX_MMR_PROOF_HASHES) {
    throw new BurnProofError(`${what} has more than ${MAX_MMR_PROOF_HASHES} hashes, which the engine would refuse`);
  }
  for (const [i, h] of [...path, ...peaks].entries()) hex32(h, `${what} hash ${i}`);
  return { leafIndex: u64(bag.leaf_index, `${what}.leaf_index`), mmrSize: u64(bag.mmr_size, `${what}.mmr_size`), pathLength: path.length, peaksLength: peaks.length };
}

/**
 * Parse a burn proof file. STRUCTURE ONLY: a file that parses here is well-formed and
 * self-consistent, which is not the same as valid — only the engine verifies the ownership
 * proof and the MMR inclusion, and only the user's wallet can sign the claim.
 */
export function parseBurnClaimProof(text: string): BurnClaimProofFacts {
  if (typeof text !== 'string' || text.trim() === '') throw new BurnProofError('No burn proof was supplied.');
  if (text.length > MAX_BURN_PROOF_CHARS) throw new BurnProofError('That file is larger than any burn proof walletd would accept.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BurnProofError('That is not a JSON burn proof file.');
  }
  const root = obj(parsed, 'the burn proof');
  const claim = obj(root.claim_proof, 'claim_proof');
  const output = obj(claim.output_proof, 'claim_proof.output_proof');
  const out = obj(output.output, 'claim_proof.output_proof.output');
  // Every field the engine's own claim path reads, with upstream's length caps.
  hex(out.features, 'output.features');
  hex(out.script, 'output.script', MAX_SCRIPT_BYTES);
  hex(out.covenant, 'output.covenant', MAX_COVENANT_BYTES);
  hex(out.encrypted_data, 'output.encrypted_data', MAX_ENCRYPTED_DATA_BYTES);
  if (out.metadata_signature === undefined || out.metadata_signature === null) throw new BurnProofError('output.metadata_signature is missing');
  if (typeof out.metadata_signature === 'string') hex(out.metadata_signature, 'output.metadata_signature', MAX_METADATA_SIGNATURE_BYTES);
  // The ownership proof is present and hex-shaped, and that is ALL that is checked here: only
  // the engine verifies it, against a claim key derived from the account's secret.
  if (typeof claim.ownership_proof !== 'string' || !HEX_ANY.test(claim.ownership_proof) || claim.ownership_proof.length < 64) {
    throw new BurnProofError('claim_proof.ownership_proof is missing or is not a hex signature');
  }
  const facts: BurnClaimProofFacts = {
    burnPublicKey: hex32(claim.burn_public_key, 'claim_proof.burn_public_key'),
    value: u64(claim.value, 'claim_proof.value'),
    commitment: hex32(out.commitment, 'output.commitment'),
    blockHash: hex32(output.block_hash, 'output_proof.block_hash'),
    blockHeight: u64(output.block_height, 'output_proof.block_height'),
    minedInEpoch: u64(root.mined_in_epoch, 'mined_in_epoch'),
    senderOffsetPublicKey: hex32(out.sender_offset_public_key, 'output.sender_offset_public_key'),
    normalOutputProof: mmr(output.normal_output_proof, 'output_proof.normal_output_proof'),
    blockOutputProof: mmr(output.block_output_proof, 'output_proof.block_output_proof'),
    hasEncryptedData: typeof root.encrypted_data === 'string' && root.encrypted_data.length > 0,
  };
  if (BigInt(facts.value) === 0n) throw new BurnProofError('The proof states a burned value of zero.');
  return facts;
}

/**
 * The L2 account public key, read from that account's OWN component header
 * (`owner_rule: { ByPublicKey }`). This is the key a burn must be made out to, and reading it
 * from chain means a user is never asked to copy it from somewhere else.
 */
export function accountOwnerPublicKey(componentSubstate: unknown): string {
  const bag = obj(componentSubstate, 'the account substate');
  const comp = obj((bag.Component as unknown) ?? bag, 'the account component');
  const header = obj(comp.header, 'the account component header');
  const rule = header.owner_rule;
  const byKey = typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>).ByPublicKey : undefined;
  if (typeof byKey !== 'string' || !HEX64.test(byKey)) {
    throw new BurnProofError('This account does not state an owner public key, so a burn destination cannot be derived from it.');
  }
  return byKey.toLowerCase();
}

export interface BurnClaimVerdict {
  /** Every term that can be checked agrees, and L2 has synced far enough to claim. */
  readonly claimable: boolean;
  /** True when the proof names THIS account. A burn for another account can never be claimed here. */
  readonly intendedForThisAccount: boolean;
  /** Reasons the claim cannot proceed. Shown verbatim. */
  readonly blockers: readonly string[];
  /** True facts the user must know that do not block. */
  readonly warnings: readonly string[];
  readonly facts: BurnClaimProofFacts;
}

/**
 * Check a parsed proof against the connected account and the L2 chain's own epoch.
 *
 * `currentEpoch` comes from the verified indexer identity. Without it the epoch condition
 * cannot be evaluated, which is a blocker rather than an assumption: a claim submitted before
 * `mined_in_epoch` is permanently rejected, and the burn is already irreversible.
 */
export function verifyBurnClaim(
  facts: BurnClaimProofFacts,
  ctx: { readonly accountOwnerPublicKey: string; readonly currentEpoch?: string },
): BurnClaimVerdict {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const intendedForThisAccount = facts.burnPublicKey === ctx.accountOwnerPublicKey.toLowerCase();
  if (!intendedForThisAccount) {
    blockers.push(
      `This burn is made out to L2 account key ${facts.burnPublicKey}, not the connected account's key ${ctx.accountOwnerPublicKey.toLowerCase()}. Only the wallet holding that key can claim it; claiming is not possible from this account.`,
    );
  }
  if (ctx.currentEpoch === undefined) {
    blockers.push("The L2 network's current epoch is unknown, so whether this burn can be claimed yet cannot be established. A claim submitted too early is permanently rejected.");
  } else if (BigInt(ctx.currentEpoch) <= BigInt(facts.minedInEpoch)) {
    blockers.push(
      `L2 is at epoch ${ctx.currentEpoch} and this burn was mined in L1 epoch ${facts.minedInEpoch}. Wait until L2 has synced past it: a claim submitted earlier is permanently rejected, and the burn cannot be undone.`,
    );
  }
  if (!facts.hasEncryptedData) {
    blockers.push('The proof file carries no encrypted_data, which the claiming wallet needs to recover the output. This file is incomplete.');
  }
  warnings.push('The L1 burn is irreversible. Nothing in Shadow Swap can return burned XTM, and this conversion is not an atomic swap.');
  warnings.push('The claim itself is performed by your own wallet: no browser wallet exposes a burn claim. Shadow Swap can only check the proof and confirm the funds once they arrive.');
  return { claimable: blockers.length === 0, intendedForThisAccount, blockers, warnings, facts };
}

/**
 * Where a conversion has got to. Each state is reached from EVIDENCE, and the one state that
 * rests on the user's word says so in its name, so the UI can never present an unverified
 * claim as a completed one.
 */
export type CrossLayerStage =
  | 'NOT_STARTED'
  /** The L2 destination is known: the connected account's own public key, read from chain. */
  | 'DESTINATION_READY'
  /** A structurally valid proof for THIS account has been loaded. */
  | 'BURN_PROOF_LOADED'
  /** Valid, but L2 has not synced past the burn's L1 epoch yet. */
  | 'AWAITING_L2_EPOCH'
  /** Everything checkable agrees; the claim must now be made in the user's own wallet. */
  | 'CLAIM_READY'
  /** The user says they submitted a claim. NOT evidence that it settled. */
  | 'CLAIM_REPORTED_BY_USER'
  /** An authoritative balance read shows the claimed value arrived. */
  | 'CLAIMED_CONFIRMED_ON_CHAIN'
  /** Something checkable disagrees; the reasons are in `blockers`. */
  | 'BLOCKED';

/**
 * The durable record. ONLY non-secret identifiers: a commitment, a value, a block hash and an
 * epoch are all public chain data. The proof's `encrypted_data` and anything key-shaped are
 * never stored, never transmitted and never put in a URL.
 */
export interface CrossLayerRecord {
  readonly stage: CrossLayerStage;
  readonly network: string;
  readonly account: string;
  readonly accountOwnerPublicKey?: string;
  readonly commitment?: string;
  readonly value?: string;
  readonly blockHash?: string;
  readonly minedInEpoch?: string;
  /** Raw revealed balance of the claimed resource when the proof was loaded, for the delta check. */
  readonly baselineBalance?: string;
  readonly blockers?: readonly string[];
  readonly updatedAtUnixMs: number;
}

/**
 * Field names that may never be persisted. Matched as substrings, so `seedPhrase`,
 * `walletSeed` and `ownership_proof_hex` are all caught; `accountOwnerPublicKey` is not,
 * because an account's own public key is public chain data and is the burn destination.
 */
const SECRET_KEY_PATTERN = /(encrypted.?data|mnemonic|seed|secret|private.?key|view.?key|spend.?key|signing.?key|mask|ownership.?proof|preimage)/i;

/** Refuses to persist anything secret-shaped, whatever a caller passes. */
export function assertNoSecrets(record: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(record)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new BurnProofError(`A cross-layer record may never carry "${key}".`);
  }
}

export function startCrossLayer(network: string, account: string, ownerPublicKey: string, now = Date.now()): CrossLayerRecord {
  return { stage: 'DESTINATION_READY', network, account, accountOwnerPublicKey: ownerPublicKey.toLowerCase(), updatedAtUnixMs: now };
}

/**
 * Fold a verified proof into the record. A proof that disagrees with the account or the epoch
 * yields `BLOCKED` or `AWAITING_L2_EPOCH` with the reasons, never `CLAIM_READY`.
 */
export function withBurnProof(record: CrossLayerRecord, verdict: BurnClaimVerdict, baselineBalance: string | undefined, now = Date.now()): CrossLayerRecord {
  const { facts } = verdict;
  const base: CrossLayerRecord = {
    ...record,
    commitment: facts.commitment,
    value: facts.value,
    blockHash: facts.blockHash,
    minedInEpoch: facts.minedInEpoch,
    ...(baselineBalance === undefined ? {} : { baselineBalance }),
    updatedAtUnixMs: now,
  };
  if (!verdict.intendedForThisAccount || !facts.hasEncryptedData) {
    return { ...base, stage: 'BLOCKED', blockers: verdict.blockers };
  }
  if (!verdict.claimable) {
    return { ...base, stage: 'AWAITING_L2_EPOCH', blockers: verdict.blockers };
  }
  const { blockers: _drop, ...rest } = base;
  void _drop;
  return { ...rest, stage: 'CLAIM_READY' };
}

/** The user reports having submitted a claim in their wallet. Recorded as their word, not as settlement. */
export function reportClaimSubmitted(record: CrossLayerRecord, now = Date.now()): CrossLayerRecord {
  if (record.stage !== 'CLAIM_READY' && record.stage !== 'CLAIM_REPORTED_BY_USER') return record;
  return { ...record, stage: 'CLAIM_REPORTED_BY_USER', updatedAtUnixMs: now };
}

/**
 * Confirm receipt from an AUTHORITATIVE balance read: the claimed resource's revealed balance
 * must have risen by at least the burned value since the baseline. Anything less leaves the
 * stage alone, so a conversion is never reported as complete on a hopeful read.
 */
export function confirmClaimReceipt(record: CrossLayerRecord, currentBalance: string, now = Date.now()): CrossLayerRecord {
  if (record.value === undefined || record.baselineBalance === undefined) return record;
  if (record.stage === 'CLAIMED_CONFIRMED_ON_CHAIN') return record;
  const gained = BigInt(currentBalance) - BigInt(record.baselineBalance);
  if (gained < BigInt(record.value)) return record;
  return { ...record, stage: 'CLAIMED_CONFIRMED_ON_CHAIN', updatedAtUnixMs: now };
}

/** One line for the UI, and the exact truth about what is known. */
export function describeCrossLayer(record: CrossLayerRecord): string {
  switch (record.stage) {
    case 'NOT_STARTED':
      return 'No conversion has been started.';
    case 'DESTINATION_READY':
      return 'Ready: burn on the base layer naming this account, then load the proof the burn produced.';
    case 'BURN_PROOF_LOADED':
      return 'A burn proof is loaded.';
    case 'AWAITING_L2_EPOCH':
      return `Not claimable yet: L2 must sync past L1 epoch ${record.minedInEpoch ?? '?'}. The burn is already irreversible; waiting is the only correct action.`;
    case 'CLAIM_READY':
      return 'Everything checkable agrees. Claim it in your own wallet; Shadow Swap cannot submit a claim.';
    case 'CLAIM_REPORTED_BY_USER':
      return 'You reported submitting a claim. This is not confirmation: the funds are confirmed only by an on-chain balance read.';
    case 'CLAIMED_CONFIRMED_ON_CHAIN':
      return `Confirmed on chain: at least ${record.value ?? '?'} units arrived. The claimed XTR can now be traded by any ordinary route.`;
    case 'BLOCKED':
      return (record.blockers ?? ['This conversion cannot proceed.']).join(' ');
  }
}

/**
 * The walletd call that actually performs the claim, for the user to run against THEIR OWN
 * wallet. Never sent anywhere by this app: Shadow Swap has no access to a local wallet daemon
 * and must not be given any.
 */
export function claimBurnInstructions(record: CrossLayerRecord): { readonly method: string; readonly params: Readonly<Record<string, unknown>>; readonly note: string } {
  return {
    method: 'accounts.claim_burn',
    params: {
      account: record.account,
      claim_proof: { FromFile: { file_name: '<the burn proof file, in walletd\'s burn proof directory>' } },
      max_fee: '<fee cap in XTR>',
      dry_run: true,
    },
    note: 'Run this against your own walletd (dry_run first, then false). It needs a token with the account\'s own authority, because the claim is signed by a key derived from your account secret. Shadow Swap never sees it.',
  };
}
