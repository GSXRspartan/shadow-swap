/**
 * Provider advertisement and immutable accepted-quote model (FAST_XTM_TARI).
 *
 * Providers advertise SEPARATE inventories (L1 XTM, L2 TARI) and retain custody of their
 * own wallets. There is NO pooled custodial cross-chain vault. Market depth displays may
 * aggregate advertisements, but actual inventory is provider-specific.
 *
 * All integer terms use decimal strings/BigInt. No floating point anywhere.
 */
import {
  CROSS_LAYER_PROTOCOL_VERSION,
  HashHex,
  SHA256_ALG,
  SwapDirection,
  validateHashHex,
  requirePositiveAmount,
  requireRawAmount,
  assertTestnetNetwork,
  requireIdentifier,
} from './types.js';

export interface ProviderAdvertisement {
  providerId: string;
  pair: 'XTM/TARI';
  /** Raw smallest-unit integer strings. Providers retain custody of their own wallets. */
  xtmAvailable: string;
  tariAvailable: string;
  minTradeXtm: string;
  maxTradeXtm: string;
  /** Provider spread in basis points out of 10_000 — NOT a protocol developer fee. */
  spreadBps: string;
  /** Quote time-to-live in milliseconds (wall clock governs ONLY the unfunded quote). */
  quoteTtlMs: string;
  requiredL1Confirmations: string;
  network: string;
}

export function validateAdvertisement(ad: ProviderAdvertisement): void {
  requirePositiveAmount(ad.xtmAvailable, 'xtmAvailable');
  requireRawAmount(ad.tariAvailable, 'tariAvailable');
  const min = requireRawAmount(ad.minTradeXtm, 'minTradeXtm');
  const max = requireRawAmount(ad.maxTradeXtm, 'maxTradeXtm');
  if (max < min) throw new Error('maxTradeXtm must be >= minTradeXtm');
  requireRawAmount(ad.spreadBps, 'spreadBps');
  if (BigInt(ad.spreadBps) > 10_000n) throw new Error('spreadBps cannot exceed 10_000');
  requirePositiveAmount(ad.requiredL1Confirmations, 'requiredL1Confirmations');
  requirePositiveAmount(ad.quoteTtlMs, 'quoteTtlMs');
  requireIdentifier(ad.providerId, 'providerId');
  // SECURITY: use the SAME allowlist as the rest of the cross-layer stack. A substring
  // mainnet check alone let an advertisement on an arbitrary network name pass here and
  // only fail later at accept time; policy must be identical at every entry point.
  assertTestnetNetwork(ad.network);
}

/** Deterministic quote side (BigInt only): out = in * rate * (10_000 - spread) / 10_000. */
export function quoteXtmToTari(ad: ProviderAdvertisement, xtmInput: string, tariPerXtmRate: string): { xtm: string; tari: string } {
  validateAdvertisement(ad);
  const input = requirePositiveAmount(xtmInput, 'xtmInput');
  const rate = requireRawAmount(tariPerXtmRate, 'tariPerXtmRate');
  if (input < BigInt(ad.minTradeXtm) || input > BigInt(ad.maxTradeXtm)) {
    throw new Error(`XTM amount ${xtmInput} outside provider bounds ${ad.minTradeXtm}..${ad.maxTradeXtm}`);
  }
  if (input > BigInt(ad.xtmAvailable)) throw new Error('XTM amount exceeds advertised inventory');
  const spread = BigInt(ad.spreadBps);
  const output = (input * rate * (10_000n - spread)) / 10_000n;
  if (output > BigInt(ad.tariAvailable)) throw new Error('Quoted TARI output exceeds advertised inventory');
  return { xtm: input.toString(), tari: output.toString() };
}

export interface CrossChainQuote {
  quoteId: string;
  providerId: string;
  direction: SwapDirection;
  /** Exact raw XTM amount. */
  xtmRawAmount: string;
  /** Exact raw TARI amount (what the counterparty will receive). */
  tariRawAmount: string;
  spreadBps: string;
  hashAlg: typeof SHA256_ALG;
  /** H = SHA256(S) — the SAME hash binds BOTH legs. */
  hashH: HashHex;
  /** Claim/refund identities (exact addresses, never symbols). */
  l1ClaimRecipient: string;
  l2ClaimRecipient: string;
  /** Deadlines in their OWN domains (never numerically compared). */
  l1RefundDeadlineHeight: string;
  l2RefundDeadlineEpoch: string;
  requiredL1Confirmations: string;
  l1Network: string;
  l2Network: string;
  createdAtUnixMs: number;
  /** Wall-clock quote expiry — governs ONLY the unfunded reservation (see session rules). */
  quoteExpiresAtUnixMs: number;
  protocolVersion: string;
}

/**
 * Freezes an accepted quote. There is NO provider-signature implementation yet (no
 * verifiable provider key API is available in the current stack): ProviderAuthenticationSeam
 * is an explicit seam rather than invented cryptography.
 */
export interface ProviderAuthenticationSeam {
  /** Present when the provider stack can produce verifiable bindings; else undefined. */
  scheme?: string;
  /** Opaque provider attestation (e.g. signature over quote bytes) — verified elsewhere. */
  attestation?: string;
}

export function buildQuote(input: {
  quoteId: string;
  ad: ProviderAdvertisement;
  direction: SwapDirection;
  xtmRawAmount: string;
  tariRawAmount: string;
  hashH: HashHex;
  l1ClaimRecipient: string;
  l2ClaimRecipient: string;
  l1RefundDeadlineHeight: string;
  l2RefundDeadlineEpoch: string;
  nowUnixMs: number;
}): CrossChainQuote {
  validateAdvertisement(input.ad);
  validateHashHex(input.hashH);
  requirePositiveAmount(input.xtmRawAmount, 'xtmRawAmount');
  requirePositiveAmount(input.tariRawAmount, 'tariRawAmount');
  return {
    quoteId: input.quoteId,
    providerId: input.ad.providerId,
    direction: input.direction,
    xtmRawAmount: input.xtmRawAmount,
    tariRawAmount: input.tariRawAmount,
    spreadBps: input.ad.spreadBps,
    hashAlg: SHA256_ALG,
    hashH: input.hashH,
    l1ClaimRecipient: input.l1ClaimRecipient,
    l2ClaimRecipient: input.l2ClaimRecipient,
    l1RefundDeadlineHeight: input.l1RefundDeadlineHeight,
    l2RefundDeadlineEpoch: input.l2RefundDeadlineEpoch,
    requiredL1Confirmations: input.ad.requiredL1Confirmations,
    l1Network: input.ad.network,
    l2Network: input.ad.network,
    createdAtUnixMs: input.nowUnixMs,
    quoteExpiresAtUnixMs: input.nowUnixMs + Number(input.ad.quoteTtlMs),
    protocolVersion: CROSS_LAYER_PROTOCOL_VERSION,
  };
}

export function isQuoteExpired(quote: CrossChainQuote, nowUnixMs: number): boolean {
  return nowUnixMs >= quote.quoteExpiresAtUnixMs;
}