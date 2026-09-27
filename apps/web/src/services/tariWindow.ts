/**
 * THE single `window.tari` integration boundary.
 *
 * No React component may reference `window.tari`. Everything goes through
 * `getTariProvider()` here, which feature-detects the injected provider,
 * normalises its `request({ method, params })` shape, and refuses to guess.
 *
 * The provider is treated as UNTRUSTED input: every reply is shape-checked
 * before it is used, method names are allow-listed, and a spoofed provider (a
 * page script that installs its own `window.tari` before the real one) fails
 * closed because the required capability handshake is mandatory.
 */

import { NO_WALLET_LEG_CAPABILITIES, type WalletLegCapabilities } from '@tari-ootle/protocol-client/crosschain';

/** Verified method surface of the Tari dApp provider (docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md). */
export const TARI_METHODS = {
  getNetwork: 'tari_getNetwork',
  requestAccounts: 'tari_requestAccounts',
  getAccounts: 'tari_getAccounts',
  getWalletAddress: 'tari_getWalletAddress',
  getCapabilities: 'tari_getCapabilities',
  disconnect: 'tari_disconnect',
  getBalances: 'tari_getBalances',
  getSubstate: 'tari_getSubstate',
  getTransactionResult: 'tari_getTransactionResult',
  signAndSubmit: 'tari_signAndSubmitTransaction',
  createTransactionRequest: 'tari_createTransactionRequest',
  getTransactionRequest: 'tari_getTransactionRequest',
  submitTransactionRequest: 'tari_submitTransactionRequest',
} as const;

export type TariMethod = (typeof TARI_METHODS)[keyof typeof TARI_METHODS];

const ALLOWED_METHODS: ReadonlySet<string> = new Set(Object.values(TARI_METHODS));

export interface TariRequestEnvelope {
  method: string;
  params?: unknown;
}

export interface TariProvider {
  request<T = unknown>(envelope: TariRequestEnvelope): Promise<T>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    tari?: TariProvider;
  }
}

export class TariProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_INJECTED' | 'UNSUPPORTED_METHOD' | 'REJECTED' | 'MALFORMED_REPLY' | 'WRONG_NETWORK' | 'ACCOUNT_CHANGED' | 'TIMEOUT' | 'UNKNOWN',
  ) {
    super(message);
    this.name = 'TariProviderError';
  }
}

export function isTariInjected(scope: unknown = globalThis): boolean {
  if (typeof scope !== 'object' || scope === null) return false;
  const candidate = (scope as { tari?: unknown }).tari;
  return typeof candidate === 'object' && candidate !== null && typeof (candidate as TariProvider).request === 'function';
}

/**
 * The provider object currently injected, for identity comparison.
 *
 * Returned by reference: the caller compares it with the object it captured at
 * connect, which is the only comparison that cannot be spoofed by a provider
 * that merely claims the right name.
 */
export function currentProviderObject(scope: unknown = globalThis): object | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined;
  const candidate = (scope as { tari?: unknown }).tari;
  return typeof candidate === 'object' && candidate !== null ? (candidate as object) : undefined;
}

/**
 * Returns the injected provider or throws a typed refusal. There is no
 * placeholder/no-op provider: without a real provider the app is disconnected.
 */
export function getTariProvider(scope: unknown = globalThis): TariProvider {
  if (!isTariInjected(scope)) {
    throw new TariProviderError(
      'No Tari wallet provider is injected in this page. Open the app from inside the wallet dApp frame, or install a provider that exposes tari_getCapabilities.',
      'NOT_INJECTED',
    );
  }
  const provider = (scope as { tari: TariProvider }).tari;
  // Fail closed on a provider that cannot answer the capability handshake.
  if (typeof provider.request !== 'function') {
    throw new TariProviderError('The injected Tari provider does not implement request().', 'MALFORMED_REPLY');
  }
  return provider;
}

/**
 * Methods that wait on a human, and must therefore NEVER be given a deadline.
 *
 * A signing request can legitimately sit unanswered for minutes while the user
 * reads it. Aborting one on a timer would manufacture an `UNKNOWN` submission
 * for a transaction the wallet may still be about to sign — the exact state the
 * protocol is most careful to avoid. Only non-interactive reads are bounded.
 */
const INTERACTIVE_METHODS: ReadonlySet<string> = new Set<string>([
  TARI_METHODS.signAndSubmit,
  TARI_METHODS.createTransactionRequest,
  TARI_METHODS.getTransactionRequest,
  TARI_METHODS.submitTransactionRequest,
]);

/** Deadline for a non-interactive provider read. */
export const PROVIDER_READ_TIMEOUT_MS = 15_000;

async function call<T>(provider: TariProvider, method: TariMethod, params?: unknown): Promise<T> {
  if (!ALLOWED_METHODS.has(method)) {
    throw new TariProviderError(`Refusing to call unlisted Tari method "${method}".`, 'UNSUPPORTED_METHOD');
  }
  let reply: unknown;
  try {
    const request = provider.request<T>(params === undefined ? { method } : { method, params });
    reply = INTERACTIVE_METHODS.has(method)
      ? await request
      : await Promise.race([
          request,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new TariProviderError(`Tari provider did not answer ${method} within ${PROVIDER_READ_TIMEOUT_MS}ms.`, 'TIMEOUT')),
              PROVIDER_READ_TIMEOUT_MS,
            );
            // Never hold the event loop open for a timer whose request already settled.
            void request.then(
              () => clearTimeout(timer),
              () => clearTimeout(timer),
            );
          }),
        ]);
  } catch (error) {
    if (error instanceof TariProviderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const code: TariProviderError['code'] = /reject|denied|declined|user/i.test(message) ? 'REJECTED' : 'UNKNOWN';
    throw new TariProviderError(`Tari provider rejected ${method}: ${message}`, code);
  }
  if (reply === undefined || reply === null) {
    throw new TariProviderError(`Tari provider returned no reply for ${method}.`, 'MALFORMED_REPLY');
  }
  return reply as T;
}

function readString(value: unknown, field: string): string {
  if (typeof value === 'string' && value !== '') return value;
  throw new TariProviderError(`Tari provider reply is missing a valid ${field}.`, 'MALFORMED_REPLY');
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new TariProviderError(`Tari provider reply is missing a valid ${field}.`, 'MALFORMED_REPLY');
}

// ---------------------------------------------------------------------------
// Normalised, shape-checked views
// ---------------------------------------------------------------------------

export interface TariNetworkView {
  network: string;
  /** L2 epoch or L1 height when the provider exposes it. */
  epoch?: string;
}

export interface TariAccountView {
  componentAddress: string;
  walletAddress?: string;
  accountIndex?: number;
}

export interface TariBalanceView {
  resourceAddress: string;
  /** Raw base units, exact. */
  amount: string;
  resourceType: string;
}

export interface TariSubstateView {
  address: string;
  templateName?: string;
  substateVersion?: string;
  producingTxHash?: string;
  epoch?: string;
  fields: Record<string, string>;
}

const LEG_FLAG_KEYS: ReadonlyArray<[keyof WalletLegCapabilities, string[]]> = [
  ['l1Balance', ['l1Balance', 'l1_balance', 'minotariBalance', 'l1_getBalance']],
  ['l1NormalSend', ['l1NormalSend', 'l1_normal_send', 'l1Send', 'minotariSend']],
  ['l1ShaInit', ['l1ShaInit', 'l1_sha_init', 'l1InitShaAtomicSwap', 'l1_atomic_swap_init']],
  ['l1ShaInspect', ['l1ShaInspect', 'l1_sha_inspect', 'inspectShaAtomicSwap', 'l1_atomic_swap_inspect']],
  ['l1ShaClaim', ['l1ShaClaim', 'l1_sha_claim', 'claimShaAtomicSwap', 'l1_atomic_swap_claim']],
  ['l1ShaRefund', ['l1ShaRefund', 'l1_sha_refund', 'refundShaAtomicSwap', 'l1_atomic_swap_refund']],
  ['l2HtlcFund', ['l2HtlcFund', 'l2_htlc_fund', 'htlcFund', 'scriptPathHtlcFund']],
  ['l2HtlcClaim', ['l2HtlcClaim', 'l2_htlc_claim', 'htlcClaim', 'scriptPathHtlcClaim']],
  ['l2HtlcRefund', ['l2HtlcRefund', 'l2_htlc_refund', 'htlcRefund', 'scriptPathHtlcRefund']],
];

/**
 * Capability mapping.
 *
 * When the provider exposes no recognisable capability advertisement at all we
 * return `undefined` (not "everything false") so the caller can distinguish
 * "not advertised" from "advertised as unsupported". The protocol's
 * `requireLegCapabilities` already fails closed on the undefined case.
 */
export function mapCapabilities(raw: unknown): WalletLegCapabilities | undefined {
  const bag = readRecord(raw, 'capabilities');
  let recognised = 0;
  const caps: WalletLegCapabilities = { ...NO_WALLET_LEG_CAPABILITIES };
  for (const [key, aliases] of LEG_FLAG_KEYS) {
    for (const alias of aliases) {
      const value = bag[alias];
      if (typeof value === 'boolean') {
        caps[key] = value;
        recognised += 1;
        break;
      }
    }
  }
  if (recognised === 0) return undefined;
  return caps;
}

export async function fetchNetwork(provider: TariProvider): Promise<TariNetworkView> {
  const reply = await call<Record<string, unknown>>(provider, TARI_METHODS.getNetwork);
  const network = readString(reply.network ?? reply.networkName ?? reply.name, 'network');
  const epoch = typeof reply.epoch === 'string' || typeof reply.epoch === 'number' ? String(reply.epoch) : undefined;
  return { network, epoch };
}

export async function fetchCapabilities(provider: TariProvider): Promise<WalletLegCapabilities | undefined> {
  return mapCapabilities(await call<unknown>(provider, TARI_METHODS.getCapabilities));
}

export async function requestAccounts(provider: TariProvider): Promise<TariAccountView[]> {
  const reply = await call<unknown>(provider, TARI_METHODS.requestAccounts);
  const list = Array.isArray(reply) ? reply : [reply];
  return list.map((entry) => {
    const bag = readRecord(entry, 'account');
    const view: TariAccountView = { componentAddress: readString(bag.componentAddress ?? bag.address, 'componentAddress') };
    if (typeof bag.walletAddress === 'string') view.walletAddress = bag.walletAddress;
    if (typeof bag.accountIndex === 'number' && Number.isInteger(bag.accountIndex)) view.accountIndex = bag.accountIndex;
    return view;
  });
}

export async function fetchAccounts(provider: TariProvider): Promise<TariAccountView[]> {
  const reply = await call<unknown>(provider, TARI_METHODS.getAccounts);
  const list = Array.isArray(reply) ? reply : [reply];
  return list.map((entry) => {
    const bag = readRecord(entry, 'account');
    const view: TariAccountView = { componentAddress: readString(bag.componentAddress ?? bag.address, 'componentAddress') };
    if (typeof bag.walletAddress === 'string') view.walletAddress = bag.walletAddress;
    return view;
  });
}

export async function disconnectProvider(provider: TariProvider): Promise<void> {
  await call<unknown>(provider, TARI_METHODS.disconnect);
}

const BALANCE_RESOURCE_TYPES = new Set(['fungible', 'confidential', 'stealth', 'non_fungible']);
/** A balance above the protocol's 128-bit amount bound is malformed, not large. */
const MAX_AMOUNT = (1n << 128n) - 1n;

export async function fetchBalances(provider: TariProvider): Promise<TariBalanceView[]> {
  const reply = await call<unknown>(provider, TARI_METHODS.getBalances);
  const list = Array.isArray(reply) ? reply : [reply];
  return list.map((entry) => {
    const bag = readRecord(entry, 'balance');
    const resourceAddress = readString(bag.resourceAddress, 'resourceAddress');
    const amount = bag.amount;
    const amountText = typeof amount === 'bigint' ? amount.toString() : typeof amount === 'string' ? amount : typeof amount === 'number' ? String(amount) : undefined;
    if (amountText === undefined || !/^\d+$/.test(amountText)) {
      throw new TariProviderError(`Balance for ${resourceAddress} is not an exact non-negative integer.`, 'MALFORMED_REPLY');
    }
    // Bound the magnitude as well as the shape: an unbounded integer string from
    // a provider is either a bug or an attempt to make the UI do unbounded work.
    if (amountText.length > 39 || BigInt(amountText) > MAX_AMOUNT) {
      throw new TariProviderError(`Balance for ${resourceAddress} exceeds the 128-bit protocol amount bound.`, 'MALFORMED_REPLY');
    }
    const resourceType = typeof bag.resourceType === 'string' && BALANCE_RESOURCE_TYPES.has(bag.resourceType) ? bag.resourceType : 'fungible';
    return { resourceAddress, amount: amountText, resourceType };
  });
}

/**
 * Authoritative component read. Used as the `AuthoritativeSubstateReader` port
 * for the protocol-client's readback providers, so every resolver reread in the
 * app flows through exactly one code path.
 */
export async function readSubstate(provider: TariProvider, address: string): Promise<TariSubstateView | undefined> {
  const reply = await call<Record<string, unknown>>(provider, TARI_METHODS.getSubstate, { address });
  if (reply.notFound === true || reply.found === false) return undefined;
  const view: TariSubstateView = {
    address: readString(reply.address ?? address, 'address'),
    fields: {},
  };
  if (typeof reply.templateName === 'string') view.templateName = reply.templateName;
  if (typeof reply.substateVersion === 'string' || typeof reply.substateVersion === 'number') view.substateVersion = String(reply.substateVersion);
  if (typeof reply.producingTxHash === 'string') view.producingTxHash = reply.producingTxHash;
  if (typeof reply.epoch === 'string' || typeof reply.epoch === 'number') view.epoch = String(reply.epoch);
  const rawFields = readRecord(reply.fields ?? reply, 'fields');
  for (const [key, value] of Object.entries(rawFields)) {
    if (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
      view.fields[key] = String(value);
    }
  }
  return view;
}

export interface TariTransactionView {
  transactionId: string;
  status: string;
  epoch?: string;
  error?: string;
}

/**
 * Transaction lookup. Feeds `TransactionLookup` so confirmation and
 * reconciliation use the provider's own answer rather than a guess.
 */
export async function fetchTransactionResult(provider: TariProvider, transactionId: string): Promise<TariTransactionView> {
  const reply = await call<Record<string, unknown>>(provider, TARI_METHODS.getTransactionResult, { transactionId });
  const id = readString(reply.transactionId ?? transactionId, 'transactionId');
  const status = readString(reply.status ?? reply.state, 'status');
  const view: TariTransactionView = { transactionId: id, status: status.toUpperCase() };
  if (typeof reply.epoch === 'string' || typeof reply.epoch === 'number') view.epoch = String(reply.epoch);
  if (typeof reply.error === 'string') view.error = reply.error;
  return view;
}

export function mapTransactionStatus(view: TariTransactionView): 'COMMITTED' | 'REJECTED' | 'NOT_FOUND' | 'UNKNOWN' {
  // Case-insensitive, because providers are inconsistent about casing and a
  // lowercase "committed" must not be silently downgraded to UNKNOWN.
  const status = view.status.toUpperCase();
  if (/^(COMMITTED|SUCCESS|CONFIRMED|APPLIED|EXECUTED)$/.test(status)) return 'COMMITTED';
  if (/^(REJECTED|FAILED|ABORTED|REVERTED)$/.test(status)) return 'REJECTED';
  if (/^(NOT_FOUND|UNKNOWN_TX|UNKNOWN_TXID)$/.test(status)) return 'NOT_FOUND';
  // Anything else — including an acknowledgement such as "submitted" or
  // "pending" — is UNKNOWN, because a submission ACK is never finality.
  return 'UNKNOWN';
}

export interface TariSignResult {
  transactionId: string;
  epoch?: string;
}

/** Sign + submit a prepared transaction request. */
export async function signAndSubmit(
  provider: TariProvider,
  payload: unknown,
  expectation: { assets: string[]; operation: string; network: string; poolOrDestination: string },
): Promise<TariSignResult> {
  // The pre-flight assertion documents the human-readable context the wallet
  // should surface. It is a developer-side guard: a payload that does not name
  // its assets/network is not presented to a signer.
  if (expectation.assets.length === 0) {
    throw new TariProviderError('Refusing to present a signing request with no named assets.', 'REJECTED');
  }
  if (expectation.operation.trim() === '' || expectation.network.trim() === '') {
    throw new TariProviderError('Refusing to present a signing request with no operation or network context.', 'REJECTED');
  }
  if (expectation.poolOrDestination.trim() === '') {
    throw new TariProviderError('Refusing to present a signing request with no pool or destination context.', 'REJECTED');
  }
  const reply = await call<Record<string, unknown>>(provider, TARI_METHODS.signAndSubmit, { transaction: payload, display: expectation });
  const id = readString(reply.transactionId ?? reply.txId, 'transactionId');
  const result: TariSignResult = { transactionId: id };
  if (typeof reply.epoch === 'string' || typeof reply.epoch === 'number') result.epoch = String(reply.epoch);
  return result;
}

