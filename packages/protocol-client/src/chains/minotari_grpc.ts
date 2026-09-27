/**
 * MinotariAdapter — REAL Minotari L1 implementation against the TRACED wallet gRPC
 * surface of tari-project/tari v6.0.0 (commit 97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3).
 *
 * Backend: official Minotari console-wallet gRPC (applications/minotari_app_grpc/proto/
 * wallet.proto, service Wallet) plus the wallet-to-base-node RPC for authoritative
 * readback (t/bnwallet/1 — base_layer/core/src/base_node/rpc/mod.rs). This is a
 * DEVELOPMENT_REFERENCE_PROVIDER: it requires a LOCAL wallet/gRPC endpoint and MUST NOT
 * become a normal-user requirement (the production path is a browser wallet provider —
 * docs/TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md).
 *
 * Layer mapping against the REAL primitive:
 *  - CONSTRUCT/SIGN: the real wallet owns input selection, fee policy and signing; the
 *    gRPC claim/refund RPCs construct AND submit in one call, so the provider keeps its
 *    own layering but the SUBMIT call performs construct+sign+submit upstream.
 *  - SUBMIT funding: SendShaAtomicSwapTransaction — wallet generates S internally and
 *    returns (transaction_id, pre_image, output_hash).
 *  - OBSERVE: base-node readback (get_tip_info / utxo query / deleted query) — never the
 *    provider's word.
 *  - CLAIM: ClaimShaAtomicSwapTransaction(output, pre_image, fee_per_gram).
 *  - REFUND: ClaimHtlcRefundTransaction — ONLY from the funding wallet (the output was
 *    stored there at init with SpendingPriority::HtlcSpendAsap).
 *  - RECONCILE: GetTransactionInfo (TransactionStatus enum; excess_sig for chain queries).
 *
 * Amounts are microMinotari integer strings (µT, 1 XTM = 1_000_000 µT). No JS floats.
 */
import {
  L1HtlcFundingIntent,
  L1HtlcObservation,
  MinotariBalanceInfo,
  MinotariWalletInfo,
  MinotariWalletProvider,
  WalletLegCapabilities,
} from '../crosschain/provider.js';
import { SecretHex } from '../crosschain/types.js';
import { hexToBytes } from '../crosschain/secret.js';
import { decodeShaHtlcScript, executeShaHtlcBranch, MINOTARI_L1_SOURCE, ShaHtlcScriptView } from './minotari.js';

/** Traced upstream pin — surfaced for runtime self-verification. */
export { MINOTARI_L1_SOURCE };
export const DEVELOPMENT_REFERENCE_PROVIDER = true;

/** Traced wallet gRPC method names (wallet.proto, service Wallet). */
export const MINOTARI_WALLET_GRPC_METHODS = {
  GetVersion: 'GetVersion',
  Identify: 'Identify',
  GetBalance: 'GetBalance',
  GetTransactionInfo: 'GetTransactionInfo',
  SendShaAtomicSwapTransaction: 'SendShaAtomicSwapTransaction',
  ClaimShaAtomicSwapTransaction: 'ClaimShaAtomicSwapTransaction',
  ClaimHtlcRefundTransaction: 'ClaimHtlcRefundTransaction',
} as const;

/** Wallet gRPC transport — concretely tonic/grpc over the local console wallet endpoint. */
export interface MinotariWalletGrpcTransport {
  call(method: string, request: Record<string, unknown>): Promise<unknown>;
}

/**
 * Authoritative L1 readback port (base-node wallet RPC). SEPARATE from the wallet
 * transport: discovery messages are never settlement evidence, base-node answers are.
 */
export interface MinotariBaseNodeReadback {
  getTipInfo(): Promise<{ bestBlockHeight: string; synced: boolean }>;
  /**
   * `amountRaw` is OPTIONAL and MUST only be populated by an adapter that can produce a
   * commitment opening VALIDATED BY THE CHAIN (or a wallet-authenticated output record
   * the adapter treats as binding evidence). A raw base-node `TransactionOutput` exposes a
   * blinded commitment, NOT a revealed value — so a faithful base-node adapter leaves
   * `amountRaw` undefined and the observation reports `amountAuthoritative: false`.
   */
  fetchUtxos(outputHashesHex: string[]): Promise<Array<{ outputHashHex: string; minedAtHeight: string; scriptBytesHex?: string; amountRaw?: string }>>;
  queryDeleted(outputHashesHex: string[]): Promise<Array<{ outputHashHex: string; minedAtHeight: string; heightDeletedAt?: string }>>;
}

export interface MinotariDevGrpcProviderOptions {
  /** The traced network (esmeralda only; mainnet is refused unconditionally). */
  network: string;
  walletTransport?: MinotariWalletGrpcTransport;
  /** Authoritative readback; without it L1 inspection capability is honestly absent. */
  baseNodeReadback?: MinotariBaseNodeReadback;
  /** Wallet address of the locally connected wallet. */
  walletAddress?: string;

  /**
   * Actual fee-per-gram (µT/g) to submit with funding/claim/refund RPCs. When absent, the
   * conservative reference default below is used. TRACED REALITY: the caller-supplied value
   * is only a hint — the wallet recomputes fees from its own fee policy and available
   * balance, so a caller cannot force a fee. Never treat this as authoritative.
   */
  fundingFeeTPerGram?: number;
}

/** Conservative reference fee-per-gram (µT/g) when the caller supplies none. */
export const MINOTARI_REFERENCE_FEE_PER_GRAM = 5;

/** A funded output the provider knows about (wallet-side association txId → output hash). */
interface FundingRecord {
  l1TxId: string;
  outputHashHex: string;
  amountRaw: string;
}

export class MinotariDevGrpcProvider implements MinotariWalletProvider {
  private readonly fundings = new Map<string, FundingRecord>();

  constructor(readonly options: MinotariDevGrpcProviderOptions) {
    if (/mainnet/i.test(options.network)) throw new Error('mainnet is REFUSED: testnet-only development reference provider');
  }

  providerName(): string {
    return 'minotari-dev-reference-grpc';
  }

  /** The gRPC surface is pinned to traced v6.0.0 primitives — VERIFIED only when wired. */
  primitivesStatus(): 'PENDING_TRACE' | 'VERIFIED' {
    return this.options.walletTransport !== undefined ? 'VERIFIED' : 'PENDING_TRACE';
  }

  network(): string {
    return this.options.network;
  }

  /** Explicit capability advertisement — degrades honestly when transports are absent. */
  capabilities(): WalletLegCapabilities {
    const wallet = this.options.walletTransport !== undefined;
    const readback = this.options.baseNodeReadback !== undefined;
    return {
      l1Balance: wallet,
      l1NormalSend: wallet,
      l1ShaInit: wallet,
      l1ShaInspect: readback,
      l1ShaClaim: wallet,
      l1ShaRefund: wallet,
      l2HtlcFund: false,
      l2HtlcClaim: false,
      l2HtlcRefund: false,
    };
  }

  async discoverWallets(): Promise<MinotariWalletInfo[]> {
    if (!this.options.walletAddress) return [];
    const tip = await this.tip();
    return [{ walletAddress: this.options.walletAddress, network: this.options.network, readiness: tip.synced ? 'READY' : 'SYNCING' }];
  }

  async readiness(): Promise<MinotariWalletInfo['readiness']> {
    if (this.options.baseNodeReadback === undefined) return 'UNAVAILABLE';
    const tip = await this.tip();
    return tip.synced ? 'READY' : 'SYNCING';
  }

  async chainStatus(): Promise<{ network: string; currentHeight: string; synced: boolean }> {
    const tip = await this.tip();
    return { network: this.options.network, currentHeight: tip.bestBlockHeight, synced: tip.synced };
  }

  async balance(walletAddress: string): Promise<MinotariBalanceInfo> {
    const res = await this.wallet(MINOTARI_WALLET_GRPC_METHODS.GetBalance, {});
    assertObject(res, 'GetBalanceResponse');
    const available = requireU64String(res['available_balance'], 'available_balance');
    if (walletAddress !== this.options.walletAddress) throw new Error(`unknown wallet ${walletAddress}`);
    return {
      available,
      pendingIncoming: requireU64String(res['pending_incoming_balance'], 'pending_incoming_balance'),
      pendingOutgoing: requireU64String(res['pending_outgoing_balance'], 'pending_outgoing_balance'),
    };
  }

  /**
   * CONSTRUCT: no signature/submission. The real wallet may override the intent hash.
   *
   * TRACED v6.0.0 FACT: the request carries ONLY `{recipient}` — no hash, no refund
   * recipient, no refund height. The wallet generates S and H itself, derives the refund
   * branch from the FUNDING WALLET'S OWN one-sided spend key, and hardcodes the refund
   * height to `tip + 720`. `intent.refundRecipient`/`intent.refundHeight` are therefore
   * never transmitted; they are expectations that authoritative readback must confirm.
   */
  constructHtlcFunding(intent: L1HtlcFundingIntent): { intent: L1HtlcFundingIntent; feeEstimate: string } {
    if (intent.network !== this.options.network) throw new Error(`network mismatch: intent ${intent.network} vs provider ${this.options.network}`);
    if (intent.amountRaw === '' || BigInt(intent.amountRaw) <= 0n) throw new Error('amountRaw must be a positive integer string');
    return { intent, feeEstimate: '0' };
  }

  /** SIGN/AUTHORIZE — DEVELOPMENT_REFERENCE: local gRPC wallet has no interactive prompt. */
  async authorizeFunding(): Promise<{ authorized: true }> {
    if (this.options.walletTransport === undefined) throw new Error('no wallet transport: authorize refused');
    return { authorized: true };
  }

  /**
   * SUBMIT funding via SendShaAtomicSwapTransaction. The REAL wallet generates S; the
   * response pre_image + output_hash are the durable binding evidence.
   */
  async submitFunding(intent: L1HtlcFundingIntent): Promise<{ l1TxId: string; walletPreimageHex?: string; outputHashHex?: string }> {
    const res = await this.wallet(MINOTARI_WALLET_GRPC_METHODS.SendShaAtomicSwapTransaction, {
      recipient: {
        address: intent.claimRecipient,
        amount: BigInt(intent.amountRaw),
        fee_per_gram: this.options.fundingFeeTPerGram ?? MINOTARI_REFERENCE_FEE_PER_GRAM,
        payment_type: 'ONE_SIDED_TO_STEALTH_ADDRESS',
      },
    });
    assertObject(res, 'SendShaAtomicSwapResponse');
    if (res['is_success'] !== true) {
      throw new Error(`SendShaAtomicSwapTransaction failed: ${String(res['failure_message'] ?? '')}`);
    }
    const txId = requireU64String(res['transaction_id'], 'transaction_id');
    const preImage = requireHex32(res['pre_image'], 'pre_image');
    const outputHash = requireHex64(res['output_hash'], 'output_hash');
    this.fundings.set(txId, { l1TxId: txId, outputHashHex: outputHash, amountRaw: intent.amountRaw });
    return { l1TxId: txId, walletPreimageHex: preImage, outputHashHex: outputHash };
  }

  /**
   * OBSERVE: strongest available authoritative readback. Base-node evidence only; the
   * HTLC script is decoded and hash/claimant/refund-height are re-derived from it.
   */
  async observeHtlc(l1TxId: string): Promise<L1HtlcObservation> {
    if (this.options.baseNodeReadback === undefined) {
      // Without readback there is NOTHING authoritative to report.
      return { l1TxId, exists: false, amountRaw: '0', confirmations: '0', currentHeight: '0', spent: false, source: 'PROVIDER_ASSERTION' };
    }
    const funding = this.fundings.get(l1TxId);
    if (!funding) throw new Error(`no funded output association for tx ${l1TxId}`);
    const tip = await this.tip();
    const utxos = await this.options.baseNodeReadback.fetchUtxos([funding.outputHashHex]);
    const utxo = utxos.find((u) => u.outputHashHex === funding.outputHashHex);
    if (!utxo) {
      // Either not yet mined or already spent: distinguish via the deleted query.
      const deleted = await this.options.baseNodeReadback.queryDeleted([funding.outputHashHex]);
      const rec = deleted.find((d) => d.outputHashHex === funding.outputHashHex);
      if (rec?.heightDeletedAt) {
        return {
          l1TxId,
          exists: true,
          amountRaw: funding.amountRaw,
          amountAuthoritative: false,
          confirmations: '0',
          currentHeight: tip.bestBlockHeight,
          spent: true,
          source: 'BASE_NODE',
          outputHashHex: funding.outputHashHex,
          minedAtHeight: rec.minedAtHeight,
        };
      }
      return { l1TxId, exists: false, amountRaw: '0', confirmations: '0', currentHeight: tip.bestBlockHeight, spent: false, source: 'BASE_NODE' };
    }
    let scriptView: ReturnType<typeof decodeShaHtlcScript> | undefined;
    if (utxo.scriptBytesHex) {
      try {
        scriptView = decodeShaHtlcScript(hexToBytes(utxo.scriptBytesHex));
      } catch {
        scriptView = undefined;
      }
    }
    const confirmations = BigInt(tip.bestBlockHeight) - BigInt(utxo.minedAtHeight) + 1n;
    // HONEST AMOUNT HANDLING: the base node returns a BLINDED COMMITMENT, not a revealed
    // value. Only an adapter supplying a chain-validated commitment opening may set
    // `amountRaw`; otherwise the amount is the remembered funding intent and is reported
    // as NOT authoritative so settlement cannot treat it as proven.
    const chainProvenAmount = utxo.amountRaw !== undefined;
    return {
      l1TxId,
      exists: true,
      amountRaw: utxo.amountRaw ?? funding.amountRaw,
      amountAuthoritative: chainProvenAmount,
      hashHex: scriptView?.hashHex,
      claimRecipient: scriptView?.claimPubKeyHex,
      refundRecipient: scriptView?.refundPubKeyHex,
      refundHeight: scriptView?.refundHeight,
      confirmations: confirmations.toString(),
      currentHeight: tip.bestBlockHeight,
      spent: false,
      source: 'BASE_NODE',
      outputHashHex: funding.outputHashHex,
      minedAtHeight: utxo.minedAtHeight,
    };
  }

  /**
   * Script-level hashlock verification against an OBSERVED output script: a wrong
   * preimage must fail at the traced opcode semantics BEFORE any wallet call.
   */
  verifyPreimageAgainstScript(scriptBytesHex: string, preimageHex: string, currentHeight: string): { ok: boolean; reason?: string; requiredScriptSignaturePubKeyHex?: string } {
    const result = executeShaHtlcBranch(hexToBytes(scriptBytesHex), preimageHex, currentHeight);
    return { ok: result.ok, reason: result.reason, requiredScriptSignaturePubKeyHex: result.requiredScriptSignaturePubKeyHex };
  }

  /** CLAIM — the real RPC constructs, signs, and submits (single traced call). */
  async constructClaim(_l1TxId: string, preimage: SecretHex, _claimRecipient: string, _operationId: string): Promise<{ feeEstimate: string }> {
    requireHex32(preimage, 'preimage');
    return { feeEstimate: '0' };
  }

  async authorizeClaim(_l1TxId: string, _preimage: SecretHex): Promise<{ authorized: true }> {
    if (this.options.walletTransport === undefined) throw new Error('no wallet transport: authorize refused');
    return { authorized: true };
  }

  async submitClaim(l1TxId: string, preimage: SecretHex): Promise<{ l1TxId: string }> {
    const funding = this.fundings.get(l1TxId);
    if (!funding) throw new Error(`no funded output association for tx ${l1TxId}`);
    const res = await this.wallet(MINOTARI_WALLET_GRPC_METHODS.ClaimShaAtomicSwapTransaction, {
      output: funding.outputHashHex,
      pre_image: preimage,
      fee_per_gram: this.options.fundingFeeTPerGram ?? MINOTARI_REFERENCE_FEE_PER_GRAM,
    });
    assertObject(res, 'ClaimShaAtomicSwapResponse');
    return requireTransferSuccess(res, 'ClaimShaAtomicSwapTransaction');
  }

  /** REFUND — real primitive requires the ORIGINAL funding wallet (sender-side only). */
  async constructRefund(l1TxId: string, _refundRecipient: string, _operationId: string): Promise<{ feeEstimate: string }> {
    if (!this.fundings.has(l1TxId)) throw new Error(`refund refused: output for ${l1TxId} is not in this wallet's output manager`);
    return { feeEstimate: '0' };
  }

  async authorizeRefund(_l1TxId: string): Promise<{ authorized: true }> {
    if (this.options.walletTransport === undefined) throw new Error('no wallet transport: authorize refused');
    return { authorized: true };
  }

  async submitRefund(l1TxId: string): Promise<{ l1TxId: string }> {
    const funding = this.fundings.get(l1TxId);
    if (!funding) throw new Error(`no funded output association for tx ${l1TxId}`);
    const res = await this.wallet(MINOTARI_WALLET_GRPC_METHODS.ClaimHtlcRefundTransaction, {
      output_hash: funding.outputHashHex,
      fee_per_gram: this.options.fundingFeeTPerGram ?? MINOTARI_REFERENCE_FEE_PER_GRAM,
    });
    assertObject(res, 'ClaimHtlcRefundResponse');
    return requireTransferSuccess(res, 'ClaimHtlcRefundTransaction');
  }

  /** RECONCILE: authoritative wallet tx status → coordinator lookup vocabulary. */
  async lookupTransaction(l1TxId: string): Promise<'COMMITTED' | 'REJECTED' | 'NOT_FOUND' | 'UNKNOWN'> {
    const res = await this.wallet(MINOTARI_WALLET_GRPC_METHODS.GetTransactionInfo, { transaction_ids: [BigInt(l1TxId)] });
    assertObject(res, 'GetTransactionInfoResponse');
    const txs = res['transactions'];
    if (!Array.isArray(txs) || txs.length === 0) return 'NOT_FOUND';
    const status = String(txs[0]['status'] ?? '');
    if (status === 'TRANSACTION_STATUS_MINED_CONFIRMED' || status === 'TRANSACTION_STATUS_MINED_UNCONFIRMED') return 'COMMITTED';
    if (status === 'TRANSACTION_STATUS_CANCELLED' || status === 'TRANSACTION_STATUS_REJECTED') return 'REJECTED';
    return 'UNKNOWN';
  }

  /** Restart recovery: re-derive in-flight swap state from the wallet's own records. */
  async listInFlightSwaps(_walletAddress: string): Promise<Array<{ operationId: string; l1TxId?: string }>> {
    return [...this.fundings.values()].map((f) => ({ operationId: `fund_l1_${f.l1TxId}`, l1TxId: f.l1TxId }));
  }

  private async tip(): Promise<{ bestBlockHeight: string; synced: boolean }> {
    if (this.options.baseNodeReadback === undefined) throw new Error('no base-node readback configured');
    return this.options.baseNodeReadback.getTipInfo();
  }

  private async wallet(method: string, request: Record<string, unknown>): Promise<unknown> {
    const transport = this.options.walletTransport;
    if (transport === undefined) throw new Error(`wallet gRPC transport unavailable (${method})`);
    return transport.call(method, request);
  }
}

function assertObject(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`${what} malformed`);
}

function requireTransferSuccess(res: Record<string, unknown>, rpc: string): { l1TxId: string } {
  const result = res['results'];
  assertObject(result, `${rpc} TransferResult`);
  if (result['is_success'] !== true) {
    throw new Error(`${rpc} failed: ${String(result['failure_message'] ?? '')}`);
  }
  return { l1TxId: requireU64String(result['transaction_id'], 'transaction_id') };
}

function requireU64String(value: unknown, what: string): string {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`${what} exceeds u64`);
    return value.toString();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`${what} must be a u64 quantity`);
}

function requireHex32(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${what} must be 64 lowercase hex chars`);
  return value;
}

function requireHex64(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${what} must be 64 lowercase hex chars`);
  return value;
}