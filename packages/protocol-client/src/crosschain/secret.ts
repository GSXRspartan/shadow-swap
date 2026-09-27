/**
 * CrossChainSecretStore — dedicated storage for the atomic-swap preimage S.
 *
 * S must NEVER be serialized into ordinary history, debug logs, telemetry, or URLs, and
 * must never be exposed before CLAIM_ARMED. Production restart-safe storage requires
 * encryption or wallet/device-backed protection; plain browser localStorage is explicitly
 * NOT acceptable. Testnet development storage is provided but marked unsafe/test-only.
 */
import { SecretHex, HashHex } from './types.js';

/** The ONLY value that may be persisted/displayed: SHA256(S) + length evidence. */
export interface SecretPublicPart {
  hashH: HashHex;
  /** Length of S in bytes (32) — evidence the preimage exists without revealing it. */
  secretLengthBytes: number;
}

export interface CrossChainSecretStore {
  /** Generates S, stores it under sessionId, returns ONLY the public hash part. */
  generateAndStore(sessionId: string): Promise<SecretPublicPart>;
  /**
   * TESTNET_REFERENCE path: ingest an EXTERNALLY generated preimage (the real Minotari
   * wallet generates S inside SendShaAtomicSwapTransaction and returns it to the
   * initiator — tari v6.0.0 service.rs:2203). Stored under the same CLAIM_ARMED-only
   * reveal discipline. Optional: coordinators must handle stores without ingestion.
   */
  ingestExternalSecret?(sessionId: string, secretHex: SecretHex): Promise<SecretPublicPart>;
  /** Returns S ONLY when the caller passes CLAIM_ARMED evidence. */
  revealSecret(sessionId: string, claimArmed: boolean): Promise<SecretHex>;
  hasSecret(sessionId: string): Promise<boolean>;
  /** Destroys S after both legs are claimed/refunded. */
  destroySecret(sessionId: string): Promise<void>;
  /** Safe public projection (hash + length) for display/history. */
  publicPart(sessionId: string): Promise<SecretPublicPart>;
}

/** SHA-256 via WebCrypto (browser + Node ≥ 20). */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return new Uint8Array(digest);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Memory implementation for tests and the current dev/testnet flow. The store is the ONLY
 * component that ever sees S. NOT restart-safe — production needs EncryptedSecretPersistence
 * below (documented blocker; testnet dev may not bypass this interface).
 */
export class InMemorySecretStore implements CrossChainSecretStore {
  private readonly secrets = new Map<string, Uint8Array>();
  private readonly hashes = new Map<string, HashHex>();

  async generateAndStore(sessionId: string): Promise<SecretPublicPart> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // KNOWN LIMITATION (not a defect in this store, and deliberately not "fixed"
    // here): the Minotari script engine's `handle_hash` requires the preimage to
    // be a CANONICAL Ristretto255 point encoding, and roughly one random 32-byte
    // string in eight is non-canonical. Detecting canonicity needs curve
    // arithmetic, which this package deliberately does not implement (and pulling
    // a curve library into a browser client to guard a development store would
    // be a worse trade than the limitation). The reference/production path is
    // therefore `ingestExternalSecret`, where the Minotari wallet itself
    // generates S inside `send_sha_atomic_swap_transaction`. Do not treat this
    // store as a source of claimable production secrets.
    this.secrets.set(sessionId, bytes);
    const hashH = bytesToHex(await sha256(bytes));
    this.hashes.set(sessionId, hashH);
    return { hashH, secretLengthBytes: bytes.length };
  }

  async revealSecret(sessionId: string, claimArmed: boolean): Promise<SecretHex> {
    if (!claimArmed) throw new Error('Secret reveal refused: CLAIM_ARMED evidence required');
    const bytes = this.secrets.get(sessionId);
    if (!bytes) throw new Error(`No secret stored for session ${sessionId}`);
    return bytesToHex(bytes);
  }

  async ingestExternalSecret(sessionId: string, secretHex: SecretHex): Promise<SecretPublicPart> {
    if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('external preimage must be 64 lowercase hex chars');
    const bytes = hexToBytes(secretHex);
    const hashH = bytesToHex(await sha256(bytes));
    // SECURITY (duplicate-secret-id attack): a session that already holds a preimage may
    // NEVER be silently overwritten with a different one. A provider that returned a second,
    // different S on a retry would otherwise re-point an already-funded HTLC at a preimage
    // nobody else can satisfy, permanently stranding the funds. Re-ingesting the IDENTICAL
    // secret is idempotent and allowed.
    const existingHash = this.hashes.get(sessionId);
    if (existingHash !== undefined && existingHash !== hashH) {
      throw new Error(
        `Refusing to replace an existing preimage for session ${sessionId} (stored ${existingHash.slice(0, 8)}…, offered ${hashH.slice(0, 8)}…) — a funded session's preimage is immutable`,
      );
    }
    this.secrets.set(sessionId, bytes);
    this.hashes.set(sessionId, hashH);
    return { hashH, secretLengthBytes: bytes.length };
  }

  async hasSecret(sessionId: string): Promise<boolean> {
    return this.secrets.has(sessionId);
  }

  async destroySecret(sessionId: string): Promise<void> {
    this.secrets.delete(sessionId);
    this.hashes.delete(sessionId);
  }

  async publicPart(sessionId: string): Promise<SecretPublicPart> {
    const h = this.hashes.get(sessionId);
    if (!h) throw new Error(`No secret stored for session ${sessionId}`);
    const s = this.secrets.get(sessionId)!;
    return { hashH: h, secretLengthBytes: s.length };
  }
}

/**
 * INTERFACE for production restart-safe storage. The concrete implementation MUST encrypt
 * or delegate to wallet/device-backed key material. NOT IMPLEMENTED in this phase —
 * production restart-safe secret storage is a documented blocker. No plaintext-browser-
 * storage shortcut is provided.
 */
export interface EncryptedSecretPersistence {
  /** Encrypt-then-persist (opaque to the application). */
  persistEncrypted(sessionId: string, encryptedBlob: Uint8Array): Promise<void>;
  loadEncrypted(sessionId: string): Promise<Uint8Array | undefined>;
  /** KMS/device/wallet-held wrapping key handle; platform-specific. */
  wrappingKeyContext: string;
}

/**
 * TEST-ONLY: a coordinator gate that refuses any persistence path carrying plaintext S.
 * Used in tests to prove ordinary history/JSON serialization never contains S.
 *
 * SECURITY: matching is case-insensitive and also covers the common re-encodings a leak
 * would take (uppercase hex, 0x-prefixed hex, base64 of the raw bytes, and the base64 of
 * the hex string). Matching only the exact lowercase hex would let a case-flip or a base64
 * serialization slip through while still being a complete disclosure of the preimage.
 */
export function assertNoSecretInJson(json: string, secretHex: SecretHex): void {
  if (secretHex.length === 0) throw new Error('empty secret');
  const lower = secretHex.toLowerCase();
  const raw = hexToBytes(lower);
  const candidates = new Set<string>([lower, lower.toUpperCase(), `0x${lower}`, `0x${lower.toUpperCase()}`]);
  // base64 of the raw bytes and of the hex text (two classic serialization mistakes).
  const asText = new TextEncoder().encode(lower);
  for (const bytes of [raw, asText]) {
    const asBase64 = base64Encode(bytes);
    candidates.add(asBase64);
    candidates.add(asBase64.replace(/=+$/, ''));
  }
  const haystack = json.toLowerCase();
  for (const candidate of candidates) {
    if (candidate.length >= 8 && haystack.includes(candidate.toLowerCase())) {
      throw new Error('SECRET LEAKED into serializable state');
    }
  }
}

/** Dependency-free base64 (this module is browser-targeted; no Node Buffer). */
function base64Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : alphabet[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : alphabet[b2 & 0x3f];
  }
  return out;
}

/**
 * Coordinator guard: verify SHA256(S) === H before using any preimage (never trust peer
 * messaging alone).
 */
export async function verifyPreimage(secretHex: string, hashH: HashHex): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('preimage must be 64 lowercase hex chars');
  const digest = bytesToHex(await sha256(hexToBytes(secretHex)));
  return digest === hashH;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}