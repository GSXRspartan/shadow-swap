/**
 * Typed adapter for the Minotari L1 atomic-swap gRPC surface.
 *
 * TRANSPORT-AGNOSTIC BY DESIGN. This module defines the CONTRACT — request shapes, response
 * validation, and what each field does and does not control — and nothing here opens a socket.
 * The L1 wallet is reachable only over local gRPC, so the transport belongs to whatever runs
 * beside the wallet; this is the part that can be unit-tested, and the part that must not drift
 * from the proto.
 *
 * Read from `tari-project/tari` 6.3.0-pre.2 (`3994846`):
 *   * `applications/minotari_app_grpc/proto/wallet.proto` for the messages,
 *   * `applications/minotari_console_wallet/src/grpc/wallet_grpc_server.rs` for what the handler
 *     ACTUALLY reads, which is narrower than the proto allows.
 *
 * THE PREIMAGE IS A SECRET, AND IT ARRIVES HERE. `send_sha_atomic_swap` generates it and returns
 * it in the response. Whoever funds the L1 leg therefore holds the secret for the whole swap.
 * `SendResult.preImageHex` must be kept where the funder keeps secrets — never persisted by the
 * browser, never sent to a discovery service, never logged. `redactSendResult` exists so the
 * parts that ARE public can be shared without the part that is not.
 */

/** Exactly the fields the handler reads from `PaymentRecipient` for an atomic swap. */
export interface L1SendAtomicSwapRequest {
  /** Base58 Tari address. The handler rejects a malformed one before anything is selected. */
  readonly address: string;
  /** microMinotari, as a raw integer string (the proto is uint64). */
  readonly amountMicroRaw: string;
  readonly feePerGramRaw: string;
  /**
   * Optional memo bytes. The handler wraps them as `MemoField::new_open(bytes,
   * TxType::ClaimAtomicSwap)`, or an empty memo when absent.
   */
  readonly rawPaymentIdHex?: string;
}

/**
 * What the request deliberately does NOT carry, and why — so a future adapter does not add it
 * back and imply control that does not exist.
 *
 * `payment_type` is in the proto's `PaymentRecipient` but the atomic-swap handler never reads it;
 * the script is the HTLC, not a payment type. UTXO selection is likewise fixed:
 * `UtxoSelectionCriteria::default()`. And neither the hash nor the timeout is an input at all.
 */
export const L1_SEND_UNCONTROLLABLE: readonly string[] = [
  'payment_type: present in the proto but ignored by the atomic-swap handler.',
  'UTXO selection: fixed to UtxoSelectionCriteria::default(); a range limit is explicitly refused.',
  'hash: not an input. The wallet generates the preimage itself and returns it.',
  'timeout: not an input. Fixed at the wallet\'s last scanned height + 720 blocks.',
];

export interface L1SendResult {
  readonly transactionId: string;
  /** SECRET until the counterparty's leg is claimed. 64 hex characters (a 32-byte key). */
  readonly preImageHex: string;
  /** Public. Identifies the funded output, and is what the counterparty binds their leg to. */
  readonly outputHashHex: string;
}

export interface L1ClaimRequest {
  /** The funded output's hash, as `output` in `ClaimShaAtomicSwapRequest`. */
  readonly outputHashHex: string;
  readonly preImageHex: string;
  readonly feePerGramRaw: string;
}

export interface L1RefundRequest {
  readonly outputHashHex: string;
  readonly feePerGramRaw: string;
}

/** `TransferResult`, which both claim and refund return. */
export interface L1TransferResult {
  readonly transactionId: string;
  readonly isSuccess: boolean;
  readonly failureMessage: string;
}

/**
 * The surface a local adapter must implement. Deliberately mirrors the gRPC method set rather
 * than inventing a friendlier one: a wrapper that smoothed over these four calls would hide
 * which operations are actually available.
 */
export interface L1AtomicSwapTransport {
  sendShaAtomicSwap(request: L1SendAtomicSwapRequest): Promise<unknown>;
  claimShaAtomicSwap(request: L1ClaimRequest): Promise<unknown>;
  claimHtlcRefund(request: L1RefundRequest): Promise<unknown>;
}

export class L1AdapterError extends Error {}

const HEX64 = /^[0-9a-f]{64}$/i;
const RAW_UINT = /^\d+$/;

function requireRaw(value: string, field: string): string {
  if (!RAW_UINT.test(value)) throw new L1AdapterError(`${field} must be a raw non-negative integer string (the proto field is uint64)`);
  return value;
}

function requireHex64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    throw new L1AdapterError(`${field} must be 64 hex characters; got ${typeof value === 'string' ? `${value.length} characters` : typeof value}`);
  }
  return value.toLowerCase();
}

/** Validates a send request before it reaches a wallet, so a bad call fails locally. */
export function validateSendRequest(request: L1SendAtomicSwapRequest): L1SendAtomicSwapRequest {
  if (request.address.trim().length === 0) throw new L1AdapterError('address must be a base58 Tari address');
  requireRaw(request.amountMicroRaw, 'amountMicroRaw');
  if (BigInt(request.amountMicroRaw) === 0n) throw new L1AdapterError('amountMicroRaw must be positive');
  requireRaw(request.feePerGramRaw, 'feePerGramRaw');
  if (BigInt(request.feePerGramRaw) === 0n) throw new L1AdapterError('feePerGramRaw must be positive, or the wallet cannot build a transaction');
  if (request.rawPaymentIdHex !== undefined && !/^([0-9a-f]{2})*$/i.test(request.rawPaymentIdHex)) {
    throw new L1AdapterError('rawPaymentIdHex must be an even-length hex string');
  }
  return request;
}

/**
 * Reads a `SendShaAtomicSwapResponse`.
 *
 * `is_success` is checked explicitly: the response carries a boolean and a `failure_message`, so
 * the wallet can report failure WITHOUT a transport error. Treating a 200 as success is the
 * mistake this function exists to prevent.
 */
export function parseSendResponse(response: unknown): L1SendResult {
  if (typeof response !== 'object' || response === null) {
    throw new L1AdapterError('SendShaAtomicSwapResponse must be an object');
  }
  const r = response as Record<string, unknown>;
  if (r.is_success !== true) {
    const why = typeof r.failure_message === 'string' && r.failure_message.length > 0 ? r.failure_message : 'no reason given';
    throw new L1AdapterError(`The wallet refused the atomic swap: ${why}`);
  }
  const transactionId = r.transaction_id;
  if (typeof transactionId !== 'string' && typeof transactionId !== 'number' && typeof transactionId !== 'bigint') {
    throw new L1AdapterError('transaction_id is missing from the response');
  }
  return {
    transactionId: String(transactionId),
    // The handler returns `pre_image.to_hex()` of a CompressedPublicKey: exactly 32 bytes.
    preImageHex: requireHex64(r.pre_image, 'pre_image'),
    outputHashHex: requireHex64(r.output_hash, 'output_hash'),
  };
}

/** Reads a `TransferResult`, which both claim and refund return under `results`. */
export function parseTransferResponse(response: unknown, what: 'claim' | 'refund'): L1TransferResult {
  if (typeof response !== 'object' || response === null) {
    throw new L1AdapterError(`The ${what} response must be an object`);
  }
  const outer = response as Record<string, unknown>;
  const inner = (typeof outer.results === 'object' && outer.results !== null ? outer.results : outer) as Record<string, unknown>;
  const isSuccess = inner.is_success === true;
  const failureMessage = typeof inner.failure_message === 'string' ? inner.failure_message : '';
  if (!isSuccess) {
    throw new L1AdapterError(`The wallet refused the ${what}: ${failureMessage.length > 0 ? failureMessage : 'no reason given'}`);
  }
  const id = inner.transaction_id;
  if (typeof id !== 'string' && typeof id !== 'number' && typeof id !== 'bigint') {
    throw new L1AdapterError(`transaction_id is missing from the ${what} response`);
  }
  return { transactionId: String(id), isSuccess: true, failureMessage };
}

/** Validates a claim before it is sent. The preimage must be the 32-byte shape L1 produced. */
export function validateClaimRequest(request: L1ClaimRequest): L1ClaimRequest {
  requireHex64(request.outputHashHex, 'outputHashHex');
  requireHex64(request.preImageHex, 'preImageHex');
  requireRaw(request.feePerGramRaw, 'feePerGramRaw');
  return request;
}

export function validateRefundRequest(request: L1RefundRequest): L1RefundRequest {
  requireHex64(request.outputHashHex, 'outputHashHex');
  requireRaw(request.feePerGramRaw, 'feePerGramRaw');
  return request;
}

/**
 * The parts of a send result that may be shared, with the preimage removed.
 *
 * The counterparty needs the output hash to bind their own leg; they must NOT get the preimage,
 * because the whole protocol rests on the funder revealing it only by claiming. Anything that
 * publishes a send result — a discovery service, an invitation, a log — publishes this.
 */
export function redactSendResult(result: L1SendResult): { readonly transactionId: string; readonly outputHashHex: string } {
  return { transactionId: result.transactionId, outputHashHex: result.outputHashHex };
}

/** Throws if an object about to leave the local machine still carries preimage-shaped material. */
export function assertNoPreimage(payload: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(payload)) {
    if (/pre.?image|secret|spend.?key|seed/i.test(key)) {
      throw new L1AdapterError(`A payload leaving this machine may never carry "${key}".`);
    }
  }
}

/**
 * Drives one funding call end to end against a caller-supplied transport.
 *
 * The transport is injected rather than constructed, which is what keeps this testable with no
 * wallet and makes it impossible for this module to reach the network by itself.
 */
export async function fundL1Htlc(
  transport: L1AtomicSwapTransport,
  request: L1SendAtomicSwapRequest,
): Promise<L1SendResult> {
  return parseSendResponse(await transport.sendShaAtomicSwap(validateSendRequest(request)));
}

export async function claimL1Htlc(
  transport: L1AtomicSwapTransport,
  request: L1ClaimRequest,
): Promise<L1TransferResult> {
  return parseTransferResponse(await transport.claimShaAtomicSwap(validateClaimRequest(request)), 'claim');
}

export async function refundL1Htlc(
  transport: L1AtomicSwapTransport,
  request: L1RefundRequest,
): Promise<L1TransferResult> {
  return parseTransferResponse(await transport.claimHtlcRefund(validateRefundRequest(request)), 'refund');
}
