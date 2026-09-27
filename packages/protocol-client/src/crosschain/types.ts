/**
 * Cross-layer XTM(Tari L1) ↔ TARI(Ootle L2) liquidity route — shared primitives.
 *
 * TESTNET-FIRST: this module is EXPERIMENTAL and does NOT certify atomicity; a dedicated
 * hostile cross-layer audit follows. Real submission is gated OFF by default
 * (see coordinator.ts) and MAINNET is refused unconditionally in this phase.
 *
 * All raw chain amounts are decimal integer strings (BigInt domain). No floats.
 */

export type ChainId = 'MINOTARI_L1' | 'OOTLE_L2';
export type SwapDirection = 'XTM_TO_TARI' | 'TARI_TO_XTM';
export const SHA256_ALG = 'SHA256';

/** Raw chain amounts are decimal integer strings (BigInt domain). */
export function requireRawAmount(value: string, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a raw non-negative integer string, got ${String(value)}`);
  }
  return BigInt(value);
}

export function requirePositiveAmount(value: string, field: string): bigint {
  const v = requireRawAmount(value, field);
  if (v === 0n) throw new Error(`${field} must be positive`);
  return v;
}

/** SHA256(S) as lowercase 32-byte hex (64 chars). This is the PUBLIC value both legs bind. */
export type HashHex = string;

export function validateHashHex(h: HashHex): void {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`hash must be 64 lowercase hex chars, got ${h}`);
}

/** 32-byte secret/preimage in hex; handled ONLY by CrossChainSecretStore. */
export type SecretHex = string;

/** Plain resource-address identity (exact address; never symbol/name). */
export type ResourceAddress = string;

/** L1 block height (decimal string) and L2 epoch (decimal string) are DISTINCT domains. */
export type L1BlockHeight = string;
export type L2Epoch = string;

/** Network allowlist for this phase. Mainnet is refused by policy. */
export function assertTestnetNetwork(network: string): void {
  if (network === 'mainnet' || /mainnet/i.test(network)) {
    throw new Error(`MAINNET is refused in this phase (testnet-first policy): ${network}`);
  }
  if (network !== 'esmeralda' && network !== 'localnet') {
    throw new Error(`Network ${network} is not an approved test network (esmeralda|localnet)`);
  }
}

/** Protocol version tag bound into quotes/sessions. */
export const CROSS_LAYER_PROTOCOL_VERSION = 'xtm-tari-v1';

/** Durable operation id helper: callers supply UUIDs; this enforces non-emptiness. */
export function requireOperationId(operationId: string): string {
  if (typeof operationId !== 'string' || operationId.length < 8) {
    throw new Error('operationId must be a durable non-empty identifier');
  }
  return operationId;
}

/**
 * External identifier (provider id, quote id): a non-empty, bounded, printable string
 * with no control characters. Deliberately NOT `requireOperationId` — peer-chosen
 * identifiers legitimately differ in length, but they still must not be blank, unbounded,
 * or able to smuggle control characters into logs, filenames, or URLs.
 */
export function requireIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty identifier`);
  if (value.length > 128) throw new Error(`${field} exceeds 128 characters`);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new Error(`${field} must not contain control characters`);
  }
  return value;
}