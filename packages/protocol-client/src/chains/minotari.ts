/**
 * Minotari L1 SHA atomic-swap primitive — TRACED against tari-project/tari v6.0.0
 * (tag v6.0.0, commit 97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3, network Esmeralda).
 *
 * Every fact below is backed by exact source paths in the pinned revision. Nothing is
 * inferred from command names.
 *
 * SOURCE PIN (docs/MINOTARI_ATOMIC_SWAP_API.md):
 *  - `send_sha_atomic_swap_transaction`   base_layer/wallet/src/transaction_service/service.rs:2184
 *  - console command `init_sha_atomic_swap` applications/minotari_console_wallet/src/automation/commands.rs:263
 *  - `create_claim_sha_atomic_swap_transaction` base_layer/wallet/src/output_manager_service/service.rs:2841
 *    (fetches the UTXO from the base node first: service.rs:614 `claim_sha_atomic_swap_with_hash`)
 *  - `create_htlc_refund_transaction`      base_layer/wallet/src/output_manager_service/service.rs:2923
 *  - console command `claim_htlc_refund`   applications/minotari_console_wallet/src/automation/commands.rs:303
 *  - opcode semantics                      infrastructure/tari_script/src/{op_codes,script,stack}.rs
 *  - wallet gRPC surface                   applications/minotari_app_grpc/proto/wallet.proto
 *  - base-node wallet RPC                  base_layer/core/src/base_node/rpc/mod.rs (t/bnwallet/1)
 *
 * KEY SEMANTICS (verified from source, not documentation):
 *  - The INIT wallet generates the preimage internally: pre_image = CompressedPublicKey
 *    (Ristretto255, 32 bytes) from a random private key (service.rs:2203). Callers CANNOT
 *    supply S or H — neither the wallet API nor the gRPC request carries them.
 *  - H = SHA256(pre_image.as_bytes()) — the raw 32-byte compressed Ristretto point
 *    encoding, NO domain separation (service.rs:2204; tari_script script.rs:506 handle_hash
 *    hashes `k.as_bytes()` for PublicKey stack items).
 *  - Script (service.rs:2214):
 *      HashSha256 PushHash(H) Equal
 *        IfThen PushPubKey(claimant_spend_key)
 *        Else   CheckHeightVerify(tip + 720) PushPubKey(sender_spend_key)
 *      EndIf
 *    Opcodes: 0xb1 HashSha256, 0x7a PushHash(32B), 0x80 Equal, 0x61 IfThen, 0x62 Else,
 *    0x63 EndIf, 0x7e PushPubKey(32B), 0x66 CheckHeightVerify(u64 LEB128 varint).
 *  - Refund height is ABSOLUTE: tip + BLOCKS_PER_DAY (24*30 = 720 blocks ≈ 24h at 2min
 *    blocks). Hardcoded — not a caller parameter (service.rs:2210).
 *  - TxType::ClaimAtomicSwap; default covenant; default output features; the HTLC output's
 *    script key is RecipientScriptKey::OwnSpendKey (the SENDER's spend key, service.rs:2260)
 *    so the sender can execute the refund branch; the claimant signs the claim branch with
 *    the destination spend key (script signature verifies against the script's final
 *    PushPubKey value).
 *  - CLAIM: the claimant wallet fetches the full UTXO from the base node by output hash,
 *    decrypts EncryptedData via DH(view_key, sender_offset_pubkey) (so the claimant must be
 *    the intended recipient), builds a spend with input stack [pre_image] and submits.
 *  - REFUND: available ONLY from the sender's own wallet — the output was stored there at
 *    init time with SpendingPriority::HtlcSpendAsap (service.rs:2289).
 *  - Amounts are microMinotari (µT) uint64. All amounts are BigInt strings in this layer.
 *
 * INTEROP CONSTRAINT (digest equality proven at the byte level — see
 * packages/protocol-client/test/minotari.test.cjs; canonical-point acceptance is proven
 * only by the traced Rust `CompressedPublicKey::from_hex` parse, not by that suite):
 *  - Minotari H = SHA256(S) over the 32-byte point encoding == Ootle hashlock_digest
 *    (Sha256, no domain separation) for the SAME S bytes. The preimage MUST be a canonical
 *    valid Ristretto255 point (CompressedPublicKey::from_hex on the claim side), so a
 *    coordinator that generates S itself must generate a VALID ristretto point; the L1
 *    wallet always satisfies this because it derives S from its own key manager.
 */
import { TransactionLookup } from '../execution.js';

/** Traced upstream source pin — every adapter behavior must be re-verifiable against this. */
export const MINOTARI_L1_SOURCE = {
  repository: 'https://github.com/tari-project/tari',
  tag: 'v6.0.0',
  commit: '97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3',
  network: 'esmeralda',
  wallet: 'minotari_console_wallet',
  workspaceVersion: '6.0.0',
  scriptCrate: 'infrastructure/tari_script',
  grpcProto: 'applications/minotari_app_grpc/proto/wallet.proto',
  baseNodeRpc: 'base_layer/core/src/base_node/rpc/mod.rs',
} as const;

/** Minotari native unit — microMinotari (1 XTM = 1_000_000 µT), integer string only. */
export type MinotariRawAmount = string;

export interface MinotariWalletDiscovery {
  walletAddress: string;
  label?: string;
}

export interface MinotariBalance {
  available: MinotariRawAmount;
  pendingIncoming: MinotariRawAmount;
  pendingOutgoing: MinotariRawAmount;
}

/** The exact init request the REAL primitive accepts (µT amount; no caller S/H). */
export interface MinotariInitShaSwap {
  swapId: string;
  /**
   * SHA-256 preimage hash for verification only. The REAL wallet generates S itself and
   * refuses caller-supplied S/H; when the wallet returns its own preimage this field is
   * cross-checked against SHA256(S) and must match, otherwise the funding is refused.
   */
  hash: string;
  amount: MinotariRawAmount;
  counterpartyAddress: string;
  timeoutHeight: string;
}

export type MinotariSwapObservation =
  | { state: 'AWAITING_FUNDING'; fundingTxHash?: string }
  | { state: 'FUNDED'; fundingTxHash: string; blockHeight: string }
  | { state: 'CLAIMED'; claimTxHash: string }
  | { state: 'REFUNDED'; refundTxHash: string }
  | { state: 'TIMED_OUT' };

export type MinotariFinalityStatus = 'OBSERVED' | 'BLOCK_CONFIRMED' | 'FINALIZED' | 'REORGED';

/** The future adapter contract. Implementation phase: REAL MINOTARI L1 atomic liquidity. */
export interface MinotariAdapter {
  adapterName(): 'minotari';
  /** Wallet discovery / connection. */
  discoverWallets(): Promise<MinotariWalletDiscovery[]>;
  connect(address?: string): Promise<MinotariWalletDiscovery>;
  balance(walletAddress: string): Promise<MinotariBalance>;
  /** Init SHA-256 atomic swap (HTLC-style) on L1. */
  initShaAtomicSwap(request: MinotariInitShaSwap): Promise<{ txHash: string }>;
  /** Observe counterparty funding of the swap output. */
  observeFunding(swapId: string): Promise<MinotariSwapObservation>;
  /** Confirm/finality policy (height confirmations, reorg window). */
  confirmFinality(txHash: string, policy: { requiredConfirmations: string }): Promise<MinotariFinalityStatus>;
  /** Finalise/claim with the revealed preimage. */
  claim(swapId: string, preimageSha256: string): Promise<{ txHash: string }>;
  /** Refund after timeout without the counterparty claiming. */
  refund(swapId: string): Promise<{ txHash: string }>;
  /** Transaction lookup for reconciliation by durable id. */
  lookup: TransactionLookup;
  /** Restart recovery: enumerate in-flight swaps after a client crash. */
  listInFlightSwaps(walletAddress: string): Promise<Array<{ swapId: string; observation: MinotariSwapObservation }>>;
}

// ---------------------------------------------------------------------------
// Traced TariScript serialization (infrastructure/tari_script/src/op_codes.rs)
// ---------------------------------------------------------------------------

export const MINOTARI_OPCODES = {
  CheckHeightVerify: 0x66,
  PushHash: 0x7a,
  PushPubKey: 0x7e,
  Equal: 0x80,
  HashSha256: 0xb1,
  IfThen: 0x61,
  Else: 0x62,
  EndIf: 0x63,
} as const;

/**
 * Serializes the EXACT HTLC script emitted by `send_sha_atomic_swap_transaction`:
 *   HashSha256 PushHash(H) Equal IfThen PushPubKey(claim) Else CheckHeightVerify(h) PushPubKey(refund) EndIf
 * CheckHeightVerify height is u64 LEB128 varint (integer_encoding::VarInt, op_codes.rs:363).
 * PushPubKey payloads must be canonical Ristretto255 point encodings (op_codes.rs:384).
 */
export function serializeShaHtlcScript(script: { hashHex: string; claimPubKeyHex: string; refundPubKeyHex: string; refundHeight: string }): Uint8Array {
  const hash = require32Bytes(script.hashHex, 'hashHex');
  const claim = require32Bytes(script.claimPubKeyHex, 'claimPubKeyHex');
  const refund = require32Bytes(script.refundPubKeyHex, 'refundPubKeyHex');
  const height = parseU64(script.refundHeight, 'refundHeight');
  const out = new Array<number>();
  out.push(MINOTARI_OPCODES.HashSha256);
  out.push(MINOTARI_OPCODES.PushHash, ...hash);
  out.push(MINOTARI_OPCODES.Equal);
  out.push(MINOTARI_OPCODES.IfThen);
  out.push(MINOTARI_OPCODES.PushPubKey, ...claim);
  out.push(MINOTARI_OPCODES.Else);
  out.push(MINOTARI_OPCODES.CheckHeightVerify, ...encodeU64Varint(height));
  out.push(MINOTARI_OPCODES.PushPubKey, ...refund);
  out.push(MINOTARI_OPCODES.EndIf);
  return new Uint8Array(out);
}

/** Parsed shape of a funded L1 HTLC output script — what authoritative readback can verify. */
export interface ShaHtlcScriptView {
  hashHex: string;
  claimPubKeyHex: string;
  refundPubKeyHex: string;
  refundHeight: string;
}

/**
 * Decodes the traced HTLC script. Fails closed on ANY deviation: the coordinator only ever
 * expects the exact opcode sequence emitted by `send_sha_atomic_swap_transaction`.
 */
export function decodeShaHtlcScript(bytes: Uint8Array): ShaHtlcScriptView {
  let i = 0;
  const next = (n: number, what: string): Uint8Array => {
    if (i + n > bytes.length) throw new Error(`Truncated Minotari script at offset ${i}`);
    const slice = bytes.slice(i, i + n);
    i += n;
    return slice;
  };
  const op = (what: string): number => {
    const [b] = next(1, what);
    return b;
  };
  expect(op('HashSha256'), MINOTARI_OPCODES.HashSha256);
  expect(op('PushHash'), MINOTARI_OPCODES.PushHash);
  const hash = next(32, 'PushHash payload');
  expect(op('Equal'), MINOTARI_OPCODES.Equal);
  expect(op('IfThen'), MINOTARI_OPCODES.IfThen);
  expect(op('PushPubKey'), MINOTARI_OPCODES.PushPubKey);
  const claim = next(32, 'claim PushPubKey payload');
  expect(op('Else'), MINOTARI_OPCODES.Else);
  expect(op('CheckHeightVerify'), MINOTARI_OPCODES.CheckHeightVerify);
  const [height, size] = decodeU64Varint(bytes.subarray(i));
  next(size, 'CheckHeightVerify varint');
  expect(op('PushPubKey'), MINOTARI_OPCODES.PushPubKey);
  const refund = next(32, 'refund PushPubKey payload');
  expect(op('EndIf'), MINOTARI_OPCODES.EndIf);
  if (i !== bytes.length) throw new Error('Trailing bytes after HTLC script');
  return {
    hashHex: toHex(hash),
    claimPubKeyHex: toHex(claim),
    refundPubKeyHex: toHex(refund),
    refundHeight: height.toString(),
  };
}

export type ShaHtlcBranch = 'CLAIM' | 'REFUND';

export interface ShaHtlcExecutionResult {
  /** Script executed to a final PushPubKey — the key that must sign the script signature. */
  ok: boolean;
  /** Public key that must produce the script signature (traced final PushPubKey value). */
  requiredScriptSignaturePubKeyHex?: string;
  reason?: string;
}

/**
 * Executes the traced HTLC script against a preimage and block height — the REAL opcode
 * semantics from infrastructure/tari_script (handle_hash SHA-256 over raw bytes, Equal byte
 * comparison, IfThen branch selection on Number(1)/Number(0), CheckHeightVerify
 * block_height >= height). This is VERIFICATION tooling reconstructing consensus semantics;
 * the canonical engine remains the Minotari base node.
 *
 * - CLAIM: requires SHA256(preimage) == embedded H; fails closed on wrong preimage.
 * - REFUND: requires blockHeight >= refundHeight (CheckHeightVerify); fails otherwise.
 */
export function executeShaHtlcBranch(scriptBytes: Uint8Array, preimageHex: string, blockHeight: string): ShaHtlcBranchOutcomeSync {
  const view = decodeShaHtlcScript(scriptBytes);
  const preimage = require32Bytes(preimageHex, 'preimage');
  const claimDigest = sha256Sync(preimage);
  const height = parseU64(blockHeight, 'blockHeight');
  const refundReachable = height >= BigInt(view.refundHeight);
  if (toHex(claimDigest) !== view.hashHex) {
    return { ok: false, branch: 'CLAIM', refundReachable, reason: 'HashSha256(preimage) != embedded PushHash (hashlock refused)' };
  }
  // Claim branch is executable: final PushPubKey is the claimant key.
  return {
    ok: true,
    branch: 'CLAIM',
    requiredScriptSignaturePubKeyHex: view.claimPubKeyHex,
    refundReachable,
  };
}

export interface ShaHtlcBranchOutcomeSync {
  ok: boolean;
  branch: ShaHtlcBranch;
  requiredScriptSignaturePubKeyHex?: string;
  /** Whether the CheckHeightVerify refund branch is reachable at the given height. */
  refundReachable: boolean;
  reason?: string;
}

/** Refund branch alone (CheckHeightVerify(height) passes iff blockHeight >= height). */
export function refundBranchReachable(script: ShaHtlcScriptView, blockHeight: string): boolean {
  return BigInt(parseU64(blockHeight, 'blockHeight')) >= BigInt(script.refundHeight);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function expect(actual: number, wanted: number): void {
  if (actual !== wanted) throw new Error(`Unexpected Minotari script opcode 0x${actual.toString(16)} (expected 0x${wanted.toString(16)})`);
}

function require32Bytes(hex: string, what: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${what} must be 64 lowercase hex chars`);
  return hexToBytes(hex);
}

function parseU64(value: string, what: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${what} must be a non-negative integer string`);
  const v = BigInt(value);
  if (v > 0xffffffffffffffffn) throw new Error(`${what} exceeds u64`);
  return v;
}

function encodeU64Varint(value: bigint): number[] {
  // LEB128 unsigned — integer_encoding::VarInt for u64 (op_codes.rs:363).
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return out;
}

/**
 * Decodes the u64 LEB128 varint used by CheckHeightVerify, matching the ENGINE exactly.
 *
 * Traced engine behavior (integer-encoding 3.0.4 `u64::decode_var`, consumed by
 * `Opcode::from_bytes` at infrastructure/tari_script/src/op_codes.rs:363):
 *  - Non-minimal (overlong) encodings are ACCEPTED by the engine, so we accept them too
 *    (a stricter decoder would disagree with the chain on a script the chain accepts).
 *  - The accumulator is a `u64` and the loop breaks once `shift > 63`, so a 10th byte
 *    contributes ONLY bit 63: `(byte & 0x7f) << 63` silently DROPS the byte's upper six
 *    bits. A naive BigInt decoder returns a value ABOVE u64 and would disagree with the
 *    engine about the refund height — i.e. it could conclude "refund not reachable yet"
 *    for an output the chain WILL let the funder refund.
 *
 * SECURITY: an encoding whose true value is not representable in u64 is refused outright
 * rather than silently truncated, because we cannot model what the chain will do with it.
 */
function decodeU64Varint(bytes: Uint8Array): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let size = 0;
  for (const byte of bytes) {
    if (size >= 10) throw new Error('Minotari varint too long');
    result |= BigInt(byte & 0x7f) << shift;
    size += 1;
    if ((byte & 0x80) === 0) {
      if (result > 0xffffffffffffffffn) {
        throw new Error('Minotari varint exceeds u64 — cannot model engine truncation; refusing');
      }
      return [result, size];
    }
    shift += 7n;
  }
  throw new Error('Truncated Minotari varint');
}

function sha256Sync(bytes: Uint8Array): Uint8Array {
  // Pure synchronous SHA-256 keeps the script verifier deterministic (no async subtle).
  return sha256Pure(bytes);
}

/** Test/interop helper: synchronous SHA-256 identical to the Minotari script engine's
 * handle_hash<Sha256> (raw bytes, no domain separation) — exported for fixed-vector tests. */
export const sha256SyncExport = sha256Sync;

/** Minimal pure-JS SHA-256 (FIPS 180-4) — used ONLY by the deterministic script verifier. */
function sha256Pure(input: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const l = input.length;
  const withPadding = ((l + 9 + 63) & ~63);
  const msg = new Uint8Array(withPadding);
  msg.set(input);
  msg[l] = 0x80;
  const bitLenHi = Math.floor((l * 8) / 0x100000000);
  const bitLenLo = (l * 8) >>> 0;
  new DataView(msg.buffer).setUint32(withPadding - 8, bitLenHi);
  new DataView(msg.buffer).setUint32(withPadding - 4, bitLenLo);
  const w = new Uint32Array(64);
  for (let block = 0; block < msg.length; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = new DataView(msg.buffer, block + i * 4).getUint32(0);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) dv.setUint32(i * 4, H[i]);
  return out;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}