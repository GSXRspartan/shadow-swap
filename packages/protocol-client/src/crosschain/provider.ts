/**
 * Minotari wallet provider boundary (L1 leg).
 *
 * The protocol consumes ONLY this typed interface. The three SHA atomic-swap primitives
 * are now TRACED against tari-project/tari v6.0.0 (commit 97aa59ec…; see
 * docs/MINOTARI_ATOMIC_SWAP_API.md and src/chains/minotari.ts for exact source paths).
 * A browser-capable provider still does not exist: the traced primitives are reachable
 * from a local Minotari console wallet / walletd gRPC (DEVELOPMENT_REFERENCE_PROVIDER
 * only) or from upstream browser wallet work (docs/TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md).
 *
 * Layers are separate: CONSTRUCT / SIGN-AUTHORIZE / SUBMIT / OBSERVE / CLAIM / REFUND /
 * RECONCILE. No opaque swap().
 */
import { HashHex, SecretHex } from './types.js';

export const BROWSER_MINOTARI_PROVIDER: 'READY' | 'BLOCKED_EXTERNAL' = 'BLOCKED_EXTERNAL';
export const BROWSER_PROVIDER_BLOCKER =
  'No browser-safe Minotari wallet provider exposes the traced L1 SHA atomic-swap primitives yet; the required window.tari provider extension is specified in docs/TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md.';

/** Whether the backing implementation is wired to VERIFIED L1 primitives. */
export type L1PrimitiveStatus = 'PENDING_TRACE' | 'VERIFIED';

export interface MinotariWalletInfo {
  walletAddress: string;
  network: string;
  readiness: 'READY' | 'SYNCING' | 'UNAVAILABLE';
}

export interface MinotariChainStatus {
  network: string;
  currentHeight: string;
  /** Authoritative chain tip info from the base node / wallet sync. */
  synced: boolean;
}

export interface MinotariBalanceInfo {
  available: string;
  pendingIncoming: string;
  pendingOutgoing: string;
}

/** CONSTRUCT: an L1 HTLC funding intent (never signed or submitted here). */
export interface L1HtlcFundingIntent {
  amountRaw: string;
  /**
   * SHA256(S) — 32-byte hex, byte-for-byte compatible with the Ootle Hash32.
   *
   * TRACED REALITY (tari v6.0.0 `send_sha_atomic_swap_transaction`): the real wallet
   * generates S internally and CANNOT be given H. The intent hash is used for
   * cross-checking ONLY when the provider can honor an external hash; the real Minotari
   * wallet ignores it and returns the wallet-generated preimage in submitFunding.
   */
  hash: HashHex;
  claimRecipient: string;
  /**
   * TRACED REALITY (tari v6.0.0 `send_sha_atomic_swap_transaction`): the refund branch of
   * the real Minotari script is the FUNDING WALLET'S OWN one-sided spend key
   * (`RecipientScriptKey::OwnSpendKey`) — it is wallet-derived, NOT caller-supplied, and
   * `SendShaAtomicSwapTransaction` carries no refund recipient at all. This field is
   * therefore INFORMATIONAL for the Minotari leg: a provider that honors the traced
   * primitive MUST ignore it and must instead re-derive the refund key from the
   * authoritative script at readback (`L1HtlcObservation.refundRecipient`).
   */
  refundRecipient: string;
  /**
   * Absolute L1 block height after which the funder can refund. TRACED REALITY: the real
   * Minotari wallet hardcodes `tip + 720` (`BLOCKS_PER_DAY = 24*30`) and the RPC exposes
   * no caller parameter, so this is a coordinator-side EXPECTATION that authoritative
   * readback must confirm — it is never transmitted to the wallet.
   */
  refundHeight: string;
  network: string;
  operationId: string;
}

/** OBSERVE: authoritative view of an L1 HTLC output. */
export interface L1HtlcObservation {
  l1TxId: string;
  exists: boolean;
  amountRaw: string;
  hashHex?: HashHex;
  claimRecipient?: string;
  refundHeight?: string;
  confirmations: string;
  currentHeight: string;
  /** Whether the output has been spent (claimed or refunded). */
  spent: boolean;
  spentByTxId?: string;
  /**
   * Authoritative source marker. Only BASE_NODE evidence settles; WALLET_OUTPUT_MANAGER is
   * the sender's own view (sufficient for refund construction, never for counterparty
   * funding proof); PROVIDER_ASSERTION is never settlement evidence.
   */
  source: 'BASE_NODE' | 'WALLET_OUTPUT_MANAGER' | 'PROVIDER_ASSERTION';
  /** Raw serialized TariScript of the HTLC output — decodable via decodeShaHtlcScript. */
  scriptHex?: string;
  /** UTXO id (output hash) — the key used for base-node UTXO/deleted queries. */
  outputHashHex?: string;
  /** Mined height from the base node (authoritative inclusion evidence). */
  minedAtHeight?: string;
  /**
   * Whether `amountRaw` is INDEPENDENTLY PROVEN by authoritative chain evidence rather
   * than merely remembered from the funding intent.
   *
   * TRACED REALITY (tari v6.0.0): a stealth one-sided output stores its value inside a
   * blinded commitment; the base-node wallet RPC returns the `TransactionOutput` with the
   * commitment, NOT a revealed amount. An adapter that cannot produce a commitment
   * opening validated by the chain MUST set this to `false` — settlement then refuses to
   * treat the amount as proven. `undefined` means "provider makes no claim", which is
   * treated as authoritative only for backward compatibility with test doubles.
   */
  amountAuthoritative?: boolean;
  /**
   * Refund-branch public key RE-DERIVED from the authoritative output script. This is the
   * only trustworthy refund identity: the funding wallet's own spend key, which for
   * Minotari equals the wallet that called `SendShaAtomicSwapTransaction`.
   */
  refundRecipient?: string;
}

/**
 * Provider capability negotiation (phase requirement): a wallet/provider EXPLICITLY
 * advertises each primitive. Quote acceptance and every funding/claim/refund entry point
 * MUST fail BEFORE any funding when a required capability is unavailable — missing
 * functionality must never be discovered mid-swap with one leg already funded.
 */
export interface WalletLegCapabilities {
  l1Balance: boolean;
  l1NormalSend: boolean;
  l1ShaInit: boolean;
  l1ShaInspect: boolean;
  l1ShaClaim: boolean;
  l1ShaRefund: boolean;
  l2HtlcFund: boolean;
  l2HtlcClaim: boolean;
  l2HtlcRefund: boolean;
}

export const NO_WALLET_LEG_CAPABILITIES: WalletLegCapabilities = {
  l1Balance: false,
  l1NormalSend: false,
  l1ShaInit: false,
  l1ShaInspect: false,
  l1ShaClaim: false,
  l1ShaRefund: false,
  l2HtlcFund: false,
  l2HtlcClaim: false,
  l2HtlcRefund: false,
};

export type SwapDirectionKind = 'XTM_TO_TARI' | 'TARI_TO_XTM';

/**
 * Capabilities the CLIENT-side wallet needs for a given direction.
 * - XTM_TO_TARI: the client funds L1 (init), inspects it, may refund it.
 * - TARI_TO_XTM: the client funds L2 and later claims L1 with the revealed S.
 */
export function requiredCapabilitiesFor(direction: SwapDirectionKind): { l1: Array<keyof WalletLegCapabilities>; l2: Array<keyof WalletLegCapabilities> } {
  if (direction === 'XTM_TO_TARI') {
    return { l1: ['l1Balance', 'l1ShaInit', 'l1ShaInspect', 'l1ShaRefund'], l2: ['l2HtlcFund', 'l2HtlcClaim'] };
  }
  return { l1: ['l1Balance', 'l1ShaInspect', 'l1ShaClaim', 'l1ShaRefund'], l2: ['l2HtlcFund', 'l2HtlcClaim', 'l2HtlcRefund'] };
}

export class CapabilityRefusal extends Error {}

type WalletLeg = 'L1' | 'L2';

function missingKeys(caps: WalletLegCapabilities | undefined, keys: Array<keyof WalletLegCapabilities>): string[] {
  if (!caps) return keys.map((k) => `${k} (no capability advertisement)`);
  return keys.filter((k) => !caps[k]);
}

/** Fails closed BEFORE any funding when required capabilities are unavailable/unknown. */
export function requireLegCapabilities(
  direction: SwapDirectionKind,
  l1?: WalletLegCapabilities,
  l2?: WalletLegCapabilities,
): void {
  const required = requiredCapabilitiesFor(direction);
  const fail = (leg: WalletLeg, missingList: string[]): never => {
    throw new CapabilityRefusal(
      `${leg} wallet cannot execute FAST_XTM_TARI (${direction}): missing capabilities ${missingList.join(', ')} — refusing before any funding`,
    );
  };
  const missingL1 = missingKeys(l1, required.l1);
  if (missingL1.length > 0) fail('L1', missingL1);
  const missingL2 = missingKeys(l2, required.l2);
  if (missingL2.length > 0) fail('L2', missingL2);
}

/**
 * Single-leg capability check — used at each leg's own funding/claim entry point, where
 * only THAT leg's wallet is in play (both legs were already checked at quote acceptance).
 */
export function requireLegCapabilitiesSingle(
  direction: SwapDirectionKind,
  leg: WalletLeg,
  caps?: WalletLegCapabilities,
): void {
  const required = requiredCapabilitiesFor(direction)[leg === 'L1' ? 'l1' : 'l2'];
  const missing = missingKeys(caps, required);
  if (missing.length > 0) {
    throw new CapabilityRefusal(
      `${leg} wallet cannot execute FAST_XTM_TARI (${direction}): missing capabilities ${missing.join(', ')} — refusing before any funding`,
    );
  }
}

export interface MinotariWalletProvider {
  /** Unique backend id (e.g. 'minotari-dev-reference-grpc'). */
  providerName(): string;
  /** True only when the implementation is wired to VERIFIED L1 primitives. */
  primitivesStatus(): L1PrimitiveStatus;
  network(): string;
  /** Explicit capability advertisement; quote acceptance fails closed when absent. */
  capabilities(): WalletLegCapabilities;
  discoverWallets(): Promise<MinotariWalletInfo[]>;
  readiness(): Promise<MinotariWalletInfo['readiness']>;
  chainStatus(): Promise<MinotariChainStatus>;
  balance(walletAddress: string): Promise<MinotariBalanceInfo>;
  /** Layer 1 — CONSTRUCT the funding intent (no signature, no submission). */
  constructHtlcFunding(intent: L1HtlcFundingIntent): { intent: L1HtlcFundingIntent; feeEstimate: string };
  /** Layer 2 — SIGN/AUTHORIZE (may prompt a user). */
  authorizeFunding(signedIntent: { intent: L1HtlcFundingIntent; feeEstimate: string }): Promise<{ authorized: true }>;
  /**
   * Layer 3 — SUBMIT. MUST reject (not throw-and-forget) on transport loss so the
   * coordinator persists UNKNOWN via its own handling.
   * The REAL wallet primitive generates S internally: on success it returns the
   * wallet-generated preimage (hex) and the funded output hash alongside the tx id.
   */
  submitFunding(intent: L1HtlcFundingIntent): Promise<{ l1TxId: string; walletPreimageHex?: string; outputHashHex?: string }>;
  /** OBSERVE: authoritative readback of the HTLC output. */
  observeHtlc(l1TxId: string): Promise<L1HtlcObservation>;
  /** CLAIM (counterparty side): finalise with the revealed preimage. */
  constructClaim(l1TxId: string, preimage: SecretHex, claimRecipient: string, operationId: string): Promise<{ feeEstimate: string }>;
  authorizeClaim(l1TxId: string, preimage: SecretHex): Promise<{ authorized: true }>;
  submitClaim(l1TxId: string, preimage: SecretHex): Promise<{ l1TxId: string }>;
  /** REFUND after the refund height, per the real refund primitive. */
  constructRefund(l1TxId: string, refundRecipient: string, operationId: string): Promise<{ feeEstimate: string }>;
  authorizeRefund(l1TxId: string): Promise<{ authorized: true }>;
  submitRefund(l1TxId: string): Promise<{ l1TxId: string }>;
  /** RECONCILE: authoritative tx lookup for UNKNOWN outcomes. */
  lookupTransaction(l1TxId: string): Promise<'COMMITTED' | 'REJECTED' | 'NOT_FOUND' | 'UNKNOWN'>;
  /** Restart/recovery: enumerate in-flight swap outputs after a crash. */
  listInFlightSwaps(walletAddress: string): Promise<Array<{ operationId: string; l1TxId?: string }>>;
}

/**
 * L2 (Ootle) leg port. The REAL primitives are the verified stealth ScriptPath
 * `PayTo::Conditions` outputs (HashLock Sha256 + AfterEpoch) and the WASM
 * `build_script_path_witness` witness builder; the adapter maps this port onto the
 * wallet-adapter builders + authoritative Ootle readback already implemented.
 */
export interface OotleScriptPathLegPort {
  /** Explicit L2 wallet capability advertisement (HTLC fund/claim/refund). */
  capabilities?(): WalletLegCapabilities;
  /** CONSTRUCT the L2 stealth HTLC funding (withdraw stealth TARI → PayTo::Conditions). */
  constructFunding(intent: { hashH: HashHex; tariRawAmount: string; claimRecipient: string; refundEpoch: string; network: string; operationId: string }): Promise<{ feeEstimate: string }>;
  authorizeFunding(operationId: string): Promise<{ authorized: true }>;
  submitFunding(operationId: string): Promise<{ l2TxId: string }>;
  /** OBSERVE: authoritative L2 readback of the hashlock output. */
  observeHashlockOutput(l2TxId: string): Promise<{ exists: boolean; amountRaw: string; hashExact: boolean; claimantExact: boolean; epochRefundExact: boolean; unspent: boolean; source: 'AUTHORITATIVE' | 'CACHED' }>;
  constructClaim(l2TxId: string, preimage: string, operationId: string): Promise<{ feeEstimate: string }>;
  submitClaim(l2TxId: string, preimage: string): Promise<{ l2TxId: string }>;
  constructRefund(l2TxId: string, operationId: string): Promise<{ feeEstimate: string }>;
  submitRefund(l2TxId: string): Promise<{ l2TxId: string }>;
  lookupTransaction(l2TxId: string): Promise<'COMMITTED' | 'REJECTED' | 'NOT_FOUND' | 'UNKNOWN'>;
}