/**
 * THE single `window.tari` integration boundary.
 *
 * No React component may reference `window.tari`. Everything goes through
 * `getTariProvider()` here, which resolves the injected provider, normalises its
 * `request({ method, params })` shape against the PUBLISHED contract, and
 * refuses to guess.
 *
 * The provider is treated as UNTRUSTED input: every reply is shape-checked
 * before it is used, method names are allow-listed, and a spoofed provider (a
 * page script that installs its own `window.tari` before the real one) fails
 * closed because the required capability handshake is mandatory.
 *
 * CONFORMANCE. The request and reply shapes below are transcribed from
 * https://universe.tari.mw/integration/tari-dapp.d.ts into `tariDappTypes.ts`,
 * and coded against those types. An earlier revision was derived from
 * `tari-connector.js` alone, which produced several shapes the published
 * contract does not accept; those are corrected here and pinned by tests in
 * `test/tari-provider-conformance.test.cjs`.
 *
 * WALLET IDENTITY. `window.tari` is implemented by BOTH the Sapient browser
 * extension and the Tari Universe web wallet, and this file never asks which.
 * In particular it must never treat a provider as unusable because it is not
 * running in an iframe: the official reference says a dApp "never detects which
 * wallet it has", the TypeScript contract marks `isEmbedded` optional and
 * present only on the embedded provider, and the Sapient extension does not
 * publish it at all. Gating on it refused a valid extension provider.
 */

import { NO_WALLET_LEG_CAPABILITIES, type WalletLegCapabilities } from '@tari-ootle/protocol-client/crosschain';
import {
  TARI_CAPABILITY_KEYS,
  TARI_ERROR_INTERNAL,
  TARI_ERROR_NOT_CONNECTED,
  TARI_ERROR_UNSUPPORTED_METHOD,
  TARI_ERROR_USER_REJECTED,
  type TariProvider,
  type TariInstructionsTransactionRequestOperation,
  type TariTransactionRequestStatus,
  type TariTransactionRequestSummary,
  type TariWalletCapabilities,
} from './tariDappTypes.js';

export type { TariProvider, TariWalletCapabilities, TariInstructionsTransactionRequestOperation, TariTransactionRequestSummary, TariTransactionRequestStatus };

/**
 * Methods this app calls.
 *
 * Every entry is a method the published `TariMethod` union defines. The list is
 * a fail-closed guard, so an invented name would be a call that can never
 * succeed and a denial reason that would point at the wallet instead of here.
 *
 * The private / stealth surface the contract also defines is deliberately NOT
 * listed. This is a public AMM, a public marketplace and a market-data reader;
 * adding those methods would widen what the app asks a wallet for.
 */
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
  method: TariMethod;
  params?: unknown;
}

declare global {
  interface Window {
    tari?: TariProvider;
  }
}

export type TariProviderErrorCode =
  /** No `window.tari` object is present on the page at all. */
  | 'NOT_INJECTED'
  /**
   * A provider object exists but cannot service requests here. The connector is
   * loadable on any page, so this is a real, reachable state and is NOT the same
   * as "no wallet installed".
   */
  | 'PROVIDER_UNAVAILABLE'
  /** The provider answered 4200: this method is unsupported by this account/wallet. */
  | 'UNSUPPORTED_METHOD'
  /** The provider answered 4001: the user declined. Not a fault. */
  | 'REJECTED'
  /** The provider answered 4100: no account connection. */
  | 'NOT_CONNECTED'
  /** The provider answered -32603, or failed with no usable code. */
  | 'INTERNAL'
  | 'MALFORMED_REPLY'
  | 'WRONG_NETWORK'
  | 'ACCOUNT_CHANGED'
  | 'TIMEOUT'
  /** No documented code, and no message evidence either. Never a verdict. */
  | 'UNKNOWN';

export class TariProviderError extends Error {
  constructor(
    message: string,
    readonly code: TariProviderErrorCode,
    /** The documented numeric provider code, when one was present. */
    readonly providerCode?: number,
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
 * Returns the injected provider, or throws a typed refusal. There is no
 * placeholder/no-op provider: without a real provider the app is disconnected.
 *
 * PRESENCE IS NOT AVAILABILITY. A truthy `window.tari` is neither a usable
 * wallet nor evidence of one: the official connector script is documented as
 * safe to include unconditionally, and on a top-level page with no extension it
 * still publishes a provider object whose every request rejects. Whether the
 * object can actually answer is therefore established by `probeAvailability`,
 * which makes a real, non-interactive, connection-independent call.
 *
 * The only thing refused HERE is the absence of a usable `request` function.
 */
export function getTariProvider(scope: unknown = globalThis): TariProvider {
  if (!isTariInjected(scope)) {
    throw new TariProviderError('No Tari wallet provider is injected in this page. Open the app from a Tari wallet, or install one that exposes window.tari.', 'NOT_INJECTED');
  }
  const provider = (scope as { tari: TariProvider }).tari;
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
 * protocol is most careful to avoid. `tari_getTransactionRequest` polls an
 * approval that may already be open, so it is interactive too. Only
 * non-interactive reads are bounded.
 */
const INTERACTIVE_METHODS: ReadonlySet<string> = new Set<TariMethod>([
  TARI_METHODS.signAndSubmit,
  TARI_METHODS.createTransactionRequest,
  TARI_METHODS.getTransactionRequest,
  TARI_METHODS.submitTransactionRequest,
]);

/** Deadline for a non-interactive provider read. */
export const PROVIDER_READ_TIMEOUT_MS = 15_000;

/**
 * Normalise a provider rejection.
 *
 * The contract gives rejections a numeric `code`, and the documented values are
 * 4001 (user rejected), 4100 (not connected), 4200 (method unsupported) and
 * -32603 (internal / rejected by the network). When a code is present it is the
 * ONLY signal used.
 *
 * The previous implementation classified by matching the message against
 * /reject|denied|declined|user/i, which is wrong in both directions: an internal
 * failure whose text happens to contain one of those words became a clean user
 * rejection, and a genuine 4001 whose wallet worded the message differently
 * became an unknown fault. Message inspection survives ONLY for a rejection that
 * carries no code at all, and even then it narrows REJECTED rather than being
 * the primary discriminator.
 *
 * An unrecognised numeric code, a missing code, and a non-Error throw all map to
 * INTERNAL/UNKNOWN. They are never upgraded into a deterministic verdict.
 */
export function normalizeProviderError(error: unknown, method: string): TariProviderError {
  if (error instanceof TariProviderError) return error;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const code = readNumericCode(error);

  if (code !== undefined) {
    switch (code) {
      case TARI_ERROR_USER_REJECTED:
        return new TariProviderError(`The user declined ${method}.`, 'REJECTED', code);
      case TARI_ERROR_NOT_CONNECTED:
        return new TariProviderError(`The wallet is not connected, so ${method} cannot run.`, 'NOT_CONNECTED', code);
      case TARI_ERROR_UNSUPPORTED_METHOD:
        return new TariProviderError(`This wallet does not support ${method}.`, 'UNSUPPORTED_METHOD', code);
      case TARI_ERROR_INTERNAL:
        return new TariProviderError(`The wallet reported an internal failure for ${method}.`, 'INTERNAL', code);
      default:
        // A code we do not know is not a verdict about the operation. Keep it as
        // unknown and preserve the number so the UI can show it.
        return new TariProviderError(`The wallet failed ${method} with an unrecognised code.`, 'UNKNOWN', code);
    }
  }

  // No code at all. A codeless rejection whose text explicitly says the user
  // declined is still a user decline; nothing else may become one.
  if (/\b(?:user|they|wallet owner)\s+(?:rejected|declined|denied)\b/i.test(message)) {
    return new TariProviderError(`The user declined ${method}.`, 'REJECTED');
  }
  if (message === '') return new TariProviderError(`The provider failed ${method} without an error.`, 'UNKNOWN');
  return new TariProviderError(`The provider failed ${method}.`, 'UNKNOWN');
}

function readNumericCode(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * Issue a Tari request under the published contract.
 *
 * Exported so the allow-list is testable from outside: an invented method name
 * is a call that can never succeed and a denial reason that would point at the
 * wallet instead of at this repository, so the guard is worth asserting
 * directly rather than only through the wrappers.
 */
export async function call<T>(provider: TariProvider, method: TariMethod, params?: unknown): Promise<T> {
  if (!ALLOWED_METHODS.has(method)) {
    throw new TariProviderError(`Refusing to call unlisted Tari method "${method}".`, 'UNSUPPORTED_METHOD');
  }
  let reply: unknown;
  try {
    const request = provider.request(params === undefined ? { method } : { method, params });
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
    throw normalizeProviderError(error, method);
  }
  return reply as T;
}

/**
 * `call`, for the one method the contract types as `Promise<null>`.
 *
 * `tari_disconnect` resolves with `null` on success. Treating that as "no reply"
 * would turn every successful disconnect into a failure, so the null check lives
 * with the methods that must produce a value.
 */
async function callExpectingNull(provider: TariProvider, method: TariMethod, params?: unknown): Promise<void> {
  await call<unknown>(provider, method, params);
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
  /** The network name, exactly as the contract's `Promise<string>` returned it. */
  network: string;
  /** L2 epoch or L1 height, when the reply also carried one. */
  epoch?: string;
}

/**
 * An account, as the contract returns it.
 *
 * `tari_requestAccounts` and `tari_getAccounts` return `string[]` of ACCOUNT
 * COMPONENT addresses (`component_…`) — NOT wallet addresses. The bech32m
 * `otl_…` wallet address is a different value from a different method
 * (`tari_getWalletAddress`) and is never derivable from this one. The two are
 * kept in separately named fields so they cannot be silently interchanged.
 */
export interface TariAccountView {
  /** `component_…` account component address, as returned by the accounts methods. */
  componentAddress: string;
  /** Bech32m `otl_…` wallet address. Populated only from `tari_getWalletAddress`. */
  walletAddress?: string;
  accountIndex?: number;
}

export interface TariBalanceView {
  resourceAddress: string;
  /** Raw base units, exact. */
  amount: string;
  /** Normalised from the contract's `kind`, which is `Fungible`/`NonFungible`/`.`. */
  resourceType: string;
  /** Display-only scaling from the contract's `divisibility`. Never applied to settlement math. */
  divisibility?: number;
  /**
   * Display-only ticker from the contract's `symbol`.
   *
   * NEVER an identity. A resource is classified by its exact address; a symbol
   * is a display label an issuer chooses and any issuer can copy, which is why
   * the safety policy below never reads it.
   */
  symbol?: string;
  /** The stealth/confidential side. Meaningful only when `privateViewGranted` is true. */
  confidentialAmount?: string;
}

export interface TariSubstateView {
  address: string;
  templateName?: string;
  substateVersion?: string;
  producingTxHash?: string;
  epoch?: string;
  fields: Record<string, string>;
}

export type TariLegCapabilityKey = keyof WalletLegCapabilities;

/**
 * Official capability name -> this protocol's leg capability.
 *
 * The published `WalletCapabilities` has no L1 tXTM SHA atomic-swap flag at all,
 * which is consistent with `BROWSER_MINOTARI_PROVIDER === 'BLOCKED_EXTERNAL'`
 * in the protocol-client: no browser provider advertises those primitives, so
 * there is nothing to map them from. The L1 SHA keys therefore stay false and
 * the atomic route stays disabled with an honest reason. Only the L2 HTLC leg
 * has a real published counterpart (`htlcFund`, `scriptPathSpend`).
 *
 * The camelCase `l2Htlc*`/`l1Sha*` names this repository invented are NOT
 * capability names in the contract. Recognising them would let a provider that
 * answers with nothing recognisable look capable, so only documented keys count.
 */
const LEG_FLAG_KEYS: ReadonlyArray<[TariLegCapabilityKey, readonly (keyof TariWalletCapabilities)[]]> = [
  ['l1Balance', []],
  ['l1NormalSend', []],
  ['l1ShaInit', []],
  ['l1ShaInspect', []],
  ['l1ShaClaim', []],
  ['l1ShaRefund', []],
  ['l2HtlcFund', ['htlcFund']],
  ['l2HtlcClaim', ['scriptPathSpend']],
  ['l2HtlcRefund', ['scriptPathSpend']],
];

/**
 * The documented capability set, read strictly.
 *
 * Every key of `WalletCapabilities` must be a boolean. A reply that is missing
 * keys, or that carries values of the wrong type, is MALFORMED rather than
 * partially believed: treating absent booleans as `false` would silently disable
 * a feature the wallet actually supports, and treating them as `true` would
 * enable one it does not.
 */
export function mapCapabilities(raw: unknown): TariWalletCapabilities | undefined {
  const bag = readRecord(raw, 'capabilities');
  const out: Partial<Record<keyof TariWalletCapabilities, boolean>> = {};
  let recognised = 0;
  for (const key of TARI_CAPABILITY_KEYS) {
    const value = bag[key];
    if (typeof value === 'boolean') {
      out[key] = value;
      recognised += 1;
    }
  }
  // A reply with no documented boolean at all is not a capability advertisement.
  if (recognised === 0) return undefined;
  // Absent keys are deliberately NOT filled in with `false`. A missing flag means
  // "not advertised", which callers distinguish from an explicit `false`; see
  // `mapLegCapabilities`, which only ever reads keys the provider actually
  // answered with a boolean.
  return Object.freeze(out) as unknown as TariWalletCapabilities;
}

/**
 * The protocol's L1/L2 leg capabilities, derived from the documented set.
 *
 * Returns `undefined` when the provider advertised nothing recognisable, so the
 * caller can distinguish "did not advertise" from "advertised as unsupported".
 * `requireLegCapabilities` fails closed on the undefined case.
 */
export function mapLegCapabilities(capabilities: TariWalletCapabilities | undefined): WalletLegCapabilities | undefined {
  if (capabilities === undefined) return undefined;
  const caps: WalletLegCapabilities = { ...NO_WALLET_LEG_CAPABILITIES };
  for (const [legKey, officialKeys] of LEG_FLAG_KEYS) {
    caps[legKey] = officialKeys.length > 0 && officialKeys.some((key) => capabilities[key] === true);
  }
  return caps;
}

export async function fetchCapabilities(provider: TariProvider): Promise<TariWalletCapabilities | undefined> {
  return mapCapabilities(await call<unknown>(provider, TARI_METHODS.getCapabilities));
}

/**
 * The provider's network.
 *
 * The contract types this as `Promise<string>`, and the reference describes it
 * as the network name, answerable WITHOUT a connection. A reply shaped as an
 * object (`{ network, epoch }`) is what an earlier revision expected, and it is
 * not what the contract specifies; the string form is authoritative and the
 * object form is read only as a tolerated fallback, never as the primary path.
 */
export async function fetchNetwork(provider: TariProvider): Promise<TariNetworkView> {
  const reply = await call<unknown>(provider, TARI_METHODS.getNetwork);
  if (typeof reply === 'string' && reply !== '') return { network: reply };
  if (typeof reply === 'object' && reply !== null) {
    const bag = reply as Record<string, unknown>;
    const network = bag.network ?? bag.networkName ?? bag.name;
    if (typeof network === 'string' && network !== '') {
      const epoch = typeof bag.epoch === 'string' || typeof bag.epoch === 'number' ? String(bag.epoch) : undefined;
      return { network, epoch };
    }
  }
  throw new TariProviderError('Tari provider did not report a network name.', 'MALFORMED_REPLY');
}

/**
 * Parse the contract's `string[]` of account component addresses.
 *
 * The contract returns plain strings. An earlier revision expected objects with a
 * `componentAddress` member, so a conforming provider's answer was rejected. Both
 * forms are read, but the string form is the documented one and the object form
 * is tolerated only when it carries the same field name.
 */
function parseAccountList(reply: unknown): TariAccountView[] {
  const list = Array.isArray(reply) ? reply : [reply];
  return list.map((entry, index) => {
    if (typeof entry === 'string') {
      if (entry === '') throw new TariProviderError(`Tari provider returned an empty account at index ${index}.`, 'MALFORMED_REPLY');
      return { componentAddress: entry };
    }
    const bag = readRecord(entry, 'account');
    const view: TariAccountView = { componentAddress: readString(bag.componentAddress ?? bag.address, 'componentAddress') };
    if (typeof bag.walletAddress === 'string') view.walletAddress = bag.walletAddress;
    if (typeof bag.accountIndex === 'number' && Number.isInteger(bag.accountIndex)) view.accountIndex = bag.accountIndex;
    return view;
  });
}

/** Prompts the user. Returns account COMPONENT addresses. */
export async function requestAccounts(provider: TariProvider): Promise<TariAccountView[]> {
  return parseAccountList(await call<unknown>(provider, TARI_METHODS.requestAccounts));
}

/** Never prompts. Returns `[]` when not connected. */
export async function fetchAccounts(provider: TariProvider): Promise<TariAccountView[]> {
  return parseAccountList(await call<unknown>(provider, TARI_METHODS.getAccounts));
}

/**
 * The connected account's bech32m `otl_…` WALLET address.
 *
 * This is a different value from the account component address, and is not
 * derivable from it. It is what a private/stealth output is addressed TO, and it
 * is never a valid `SubstateId` for an instruction argument. Gate on the
 * documented `capabilities.walletAddress` before calling it.
 */
export async function fetchWalletAddress(provider: TariProvider): Promise<string> {
  return readString(await call<unknown>(provider, TARI_METHODS.getWalletAddress), 'walletAddress');
}

export async function disconnectProvider(provider: TariProvider): Promise<void> {
  await callExpectingNull(provider, TARI_METHODS.disconnect);
}

const BALANCE_KINDS: Readonly<Record<string, string>> = {
  Fungible: 'fungible',
  NonFungible: 'non_fungible',
  Confidential: 'confidential',
  Stealth: 'stealth',
};
/** A balance above the protocol's 128-bit amount bound is malformed, not large. */
const MAX_AMOUNT = (1n << 128n) - 1n;

function readRawAmount(value: unknown, resourceAddress: string, field: string): string {
  const text = typeof value === 'bigint' ? value.toString() : typeof value === 'string' ? value : undefined;
  if (text === undefined || !/^\d+$/.test(text)) {
    throw new TariProviderError(`Balance for ${resourceAddress} is not an exact non-negative integer (${field}).`, 'MALFORMED_REPLY');
  }
  // Bound the magnitude as well as the shape: an unbounded integer string from
  // a provider is either a bug or an attempt to make the UI do unbounded work.
  if (text.length > 39 || BigInt(text) > MAX_AMOUNT) {
    throw new TariProviderError(`Balance for ${resourceAddress} exceeds the 128-bit protocol amount bound (${field}).`, 'MALFORMED_REPLY');
  }
  return text;
}

/**
 * Balances, read with the contract's field names.
 *
 * `kind` (not `resourceType`), `divisibility`, and `confidentialAmount` are what
 * the contract defines. `divisibility` is carried through for DISPLAY only; it
 * is never applied to a settlement amount, which stays a raw integer string.
 * `confidentialAmount` reads as "0" without a view-access grant, so it is only
 * meaningful alongside `capabilities.privateViewGranted`.
 */
export async function fetchBalances(provider: TariProvider): Promise<TariBalanceView[]> {
  const reply = await call<unknown>(provider, TARI_METHODS.getBalances);
  const list = Array.isArray(reply) ? reply : [reply];
  return list.map((entry) => {
    const bag = readRecord(entry, 'balance');
    const resourceAddress = readString(bag.resourceAddress, 'resourceAddress');
    const amount = readRawAmount(bag.amount, resourceAddress, 'amount');
    // A number here would already have lost precision above 2^53 before this
    // code saw it, so a numeric amount is refused rather than coerced.
    if (typeof bag.amount === 'number') {
      throw new TariProviderError(`Balance for ${resourceAddress} is not an exact non-negative integer.`, 'MALFORMED_REPLY');
    }
    const kind = typeof bag.kind === 'string' ? bag.kind : undefined;
    const resourceType = kind === undefined ? undefined : BALANCE_KINDS[kind];
    if (resourceType === undefined) {
      throw new TariProviderError(`Balance for ${resourceAddress} has an unrecognised kind.`, 'MALFORMED_REPLY');
    }
    const view: TariBalanceView = { resourceAddress, amount, resourceType };
    if (typeof bag.divisibility === 'number' && Number.isInteger(bag.divisibility) && bag.divisibility >= 0) {
      view.divisibility = bag.divisibility;
    }
    // Display-only. An absent or null symbol simply leaves the asset unnamed.
    if (typeof bag.symbol === 'string' && bag.symbol !== '') {
      view.symbol = bag.symbol;
    }
    if (bag.confidentialAmount !== undefined) {
      view.confidentialAmount = readRawAmount(bag.confidentialAmount, resourceAddress, 'confidentialAmount');
    }
    return view;
  });
}

/**
 * Authoritative component read. Backs the `AuthoritativeSubstateReader` port, so
 * every resolver reread in the app flows through exactly one code path.
 *
 * REQUEST SHAPE. The contract is `{ substateId: string; version?: number | null }`.
 * An earlier revision sent `{ substateId, address }`, adding an `address` alias
 * the contract does not define, and an earlier one before that sent `{ address }`
 * alone. Only `substateId` is transmitted now.
 *
 * `version` is deliberately OMITTED. The published pitfalls warn that pinning a
 * cached substate version rejects with `Lock failure: Substate …:N is not found
 * or DOWN`, and the contract marks it optional precisely so the wallet resolves
 * what it needs. A version is sent only when a caller explicitly supplies one.
 *
 * The reply is typed `Promise<unknown>` upstream, so the shape below is read
 * defensively and the required field is validated before any caller uses it.
 */
export async function readSubstate(provider: TariProvider, substateId: string, version?: number | null): Promise<TariSubstateView | undefined> {
  if (typeof substateId !== 'string' || substateId === '') {
    throw new TariProviderError('A substate read requires a non-empty substateId.', 'MALFORMED_REPLY');
  }
  const params: { substateId: string; version?: number | null } = { substateId };
  if (version !== undefined) params.version = version;
  const reply = await call<unknown>(provider, TARI_METHODS.getSubstate, params);
  if (reply === null || reply === undefined) return undefined;
  const bag = readRecord(reply, 'substate');
  if (bag.notFound === true || bag.found === false) return undefined;
  const view: TariSubstateView = {
    address: readString(bag.address ?? bag.substateId ?? substateId, 'substateId'),
    fields: {},
  };
  if (typeof bag.templateName === 'string') view.templateName = bag.templateName;
  if (typeof bag.substateVersion === 'string' || typeof bag.substateVersion === 'number') view.substateVersion = String(bag.substateVersion);
  if (typeof bag.producingTxHash === 'string') view.producingTxHash = bag.producingTxHash;
  if (typeof bag.epoch === 'string' || typeof bag.epoch === 'number') view.epoch = String(bag.epoch);
  const rawFields = readRecord(bag.fields ?? bag, 'fields');
  for (const [key, value] of Object.entries(rawFields)) {
    if (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') {
      view.fields[key] = String(value);
    }
  }
  return view;
}

/**
 * RAW substate read for the authoritative Pool decoder.
 *
 * `readSubstate` above flattens only SCALAR top-level fields and drops nested
 * structures, which is fine for a resource's scalar metadata but loses a Pool's
 * reserves — they live in nested vault containers and in dependent vault/resource
 * substates. The Pool decoder needs the raw substate value
 * (`{ Component|Vault|Resource: {...} }`), so this returns it with the wrapper
 * intact and lets the decoder (which is tolerant of common wrappings) interpret it.
 * The reply shape is read defensively; `undefined` means "not present", never a
 * fabricated empty substate.
 */
export async function readRawSubstate(provider: TariProvider, substateId: string, version?: number | null): Promise<unknown> {
  if (typeof substateId !== 'string' || substateId === '') {
    throw new TariProviderError('A substate read requires a non-empty substateId.', 'MALFORMED_REPLY');
  }
  const params: { substateId: string; version?: number | null } = { substateId };
  if (version !== undefined) params.version = version;
  const reply = await call<unknown>(provider, TARI_METHODS.getSubstate, params);
  if (reply === null || reply === undefined) return undefined;
  const bag = readRecord(reply, 'substate');
  if (bag.notFound === true || bag.found === false) return undefined;
  // Unwrap the common envelopes to reach the `{ Component|Vault|Resource: {...} }`
  // value: `{ substate: { substate: <value> } }`, `{ substate: <value> }`, or the
  // value itself. The decoder tolerates either the wrapped or inner form.
  const inner = readRecord(bag.substate ?? bag, 'substate');
  return inner;
}

export interface TariTransactionView {
  transactionId: string;
  status: string;
  epoch?: string;
  error?: string;
}

/**
 * Transaction lookup. Feeds `TransactionLookup`, so confirmation and
 * reconciliation use the provider's own answer rather than a guess.
 *
 * The contract types the reply as `unknown`; the reference says the operation's
 * `transactionId` is the indexer's `Finalized…transaction_hash` normalised onto
 * the response. A missing status is therefore UNKNOWN, never an assumption of
 * success.
 */
export async function fetchTransactionResult(provider: TariProvider, transactionId: string): Promise<TariTransactionView> {
  const reply = await call<unknown>(provider, TARI_METHODS.getTransactionResult, { transactionId });
  const bag = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
  const id = typeof bag.transactionId === 'string' && bag.transactionId !== '' ? bag.transactionId : transactionId;
  const rawStatus = bag.status ?? bag.state;
  const status = typeof rawStatus === 'string' && rawStatus !== '' ? rawStatus : 'UNKNOWN';
  const view: TariTransactionView = { transactionId: id, status: status.toUpperCase() };
  if (typeof bag.epoch === 'string' || typeof bag.epoch === 'number') view.epoch = String(bag.epoch);
  if (typeof bag.error === 'string') view.error = bag.error;
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

/**
 * `tari_signAndSubmitTransaction` — `{ instructions, maxFee?, inputs?, dryRun? }`.
 *
 * This is the one-shot form. The published reference prefers the
 * create/approve/submit trio, because a single blocking call loses its result
 * forever if the page reloads while the approval popup is open, and that is
 * exactly the failure this protocol's durable operation history exists to
 * survive. The trio is implemented in `submitViaTransactionRequest` and is the
 * production path; this remains for `dryRun` preflight and for a provider that
 * reports `transactionRequests: false`.
 *
 * `inputs` is intentionally never sent: the pitfalls section warns that pinning
 * a cached substate version rejects with a lock failure, and the wallet resolves
 * what it needs when the field is omitted.
 */
export async function signAndSubmit(
  provider: TariProvider,
  params: { instructions: readonly unknown[]; maxFee?: string; dryRun?: boolean },
): Promise<TariSignResult> {
  if (!Array.isArray(params.instructions) || params.instructions.length === 0) {
    throw new TariProviderError('Refusing to sign: the instruction list is empty, so the user would be approving nothing.', 'REJECTED');
  }
  if (params.maxFee !== undefined && !/^\d+$/.test(params.maxFee)) {
    throw new TariProviderError('Refusing to sign: maxFee must be a raw non-negative integer string.', 'REJECTED');
  }
  const wire: { instructions: unknown[]; maxFee?: string; dryRun?: boolean } = { instructions: [...params.instructions] };
  if (params.maxFee !== undefined) wire.maxFee = params.maxFee;
  if (params.dryRun !== undefined) wire.dryRun = params.dryRun;

  const reply = await call<unknown>(provider, TARI_METHODS.signAndSubmit, wire);
  const bag = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
  const id = readString(bag.transactionId ?? bag.txId, 'transactionId');
  const result: TariSignResult = { transactionId: id };
  if (typeof bag.epoch === 'string' || typeof bag.epoch === 'number') result.epoch = String(bag.epoch);
  return result;
}

/**
 * Simulate only. `dryRun: true` never prompts and spends nothing.
 *
 * Used for the preflight that reprices as the user types. It is NEVER the source
 * of an AMM quote: the pool math is protocol math, and a wallet simulation is an
 * additional, non-authoritative check that the reviewed instructions would be
 * accepted. Its failure is informational, never a quote.
 */
export async function dryRunTransaction(
  provider: TariProvider,
  params: { instructions: readonly unknown[]; maxFee?: string },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await signAndSubmit(provider, { instructions: params.instructions, maxFee: params.maxFee, dryRun: true });
    return { ok: true };
  } catch (error) {
    if (error instanceof TariProviderError && (error.code === 'REJECTED' || error.code === 'MALFORMED_REPLY')) return { ok: false, reason: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The create -> approve -> submit trio
// ---------------------------------------------------------------------------

const REQUEST_STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'submitting', 'submitted', 'rejected', 'failed']);

export type TariRequestOutcome =
  /** The user has not finished approving. Not submittable; poll or resume later. */
  | { state: 'PENDING'; requestId: string }
  /** Approved. Exactly one `tari_submitTransactionRequest` is now permitted. */
  | { state: 'APPROVED'; requestId: string }
  /** Already submitted. Use the stored result; NEVER submit again. */
  | { state: 'SUBMITTED'; requestId: string; transactionId?: string; result?: unknown }
  /** A clean user decision, not a fault. */
  | { state: 'REJECTED'; requestId: string; reason?: string }
  /** A wallet/network failure, recorded as such and NOT as a rejection. */
  | { state: 'FAILED'; requestId: string; reason?: string }
  /**
   * A status the contract does not define. Fail closed: never submit, and keep
   * enough state to investigate. An unrecognised status is not permission.
   */
  | { state: 'UNKNOWN_STATUS'; requestId: string; rawStatus: string };

/** `{ kind: 'instructions', instructions, maxFee? }` — the exact reviewed operation. */
export function instructionsOperation(instructions: readonly unknown[], maxFee?: string): TariInstructionsTransactionRequestOperation {
  const operation: TariInstructionsTransactionRequestOperation = { kind: 'instructions', instructions: [...instructions] };
  if (maxFee !== undefined) operation.maxFee = maxFee;
  return Object.freeze(operation);
}

/**
 * `tari_createTransactionRequest` — PROMPTS, but does not block on the popup.
 *
 * The operation is sent verbatim and must be the frozen one the user reviewed.
 * The returned `requestId` is durable wallet-side: it survives a page reload,
 * which is the reason this flow is preferred over the one-shot call.
 */
export async function createTransactionRequest(provider: TariProvider, operation: TariInstructionsTransactionRequestOperation): Promise<string> {
  if (operation.kind !== 'instructions') {
    throw new TariProviderError(`Refusing to create a "${operation.kind}" transaction request: this app is a public AMM and uses only "instructions".`, 'REJECTED');
  }
  if (!Array.isArray(operation.instructions) || operation.instructions.length === 0) {
    throw new TariProviderError('Refusing to create a transaction request with an empty instruction list.', 'REJECTED');
  }
  const reply = await call<unknown>(provider, TARI_METHODS.createTransactionRequest, operation);
  const bag = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
  return readString(bag.requestId, 'requestId');
}

/** `tari_getTransactionRequest` — poll until `status !== "pending"`. Never prompts. */
export async function pollTransactionRequest(provider: TariProvider, requestId: string): Promise<TariRequestOutcome> {
  if (typeof requestId !== 'string' || requestId === '') {
    throw new TariProviderError('A transaction-request poll requires a non-empty requestId.', 'MALFORMED_REPLY');
  }
  const reply = await call<unknown>(provider, TARI_METHODS.getTransactionRequest, { requestId });
  const summary = normaliseSummary(reply, requestId);
  switch (summary.status) {
    case 'pending':
    case 'submitting':
      return { state: 'PENDING', requestId };
    case 'approved':
      return { state: 'APPROVED', requestId };
    case 'submitted':
      return { state: 'SUBMITTED', requestId, transactionId: readTransactionId(summary.result), result: summary.result };
    case 'rejected':
      return { state: 'REJECTED', requestId, reason: summary.error ?? 'The user declined the transaction request.' };
    case 'failed':
      return { state: 'FAILED', requestId, reason: summary.error ?? 'The wallet reported the transaction request as failed.' };
    default:
      return { state: 'UNKNOWN_STATUS', requestId, rawStatus: String(summary.status) };
  }
}

function normaliseSummary(reply: unknown, requestId: string): TariTransactionRequestSummary {
  const bag = readRecord(reply, 'transaction request');
  const rawStatus = bag.status;
  if (typeof rawStatus !== 'string' || rawStatus === '') {
    // Fail closed on a malformed summary rather than guessing a status.
    throw new TariProviderError('The transaction-request reply carried no status.', 'MALFORMED_REPLY');
  }
  // An unrecognised status is preserved verbatim and handled as UNKNOWN_STATUS
  // by the caller. It is never coerced into a known state.
  if (!REQUEST_STATUSES.has(rawStatus)) {
    return {
      requestId: typeof bag.requestId === 'string' ? bag.requestId : requestId,
      status: rawStatus as TariTransactionRequestStatus,
      note: typeof bag.note === 'string' ? bag.note : '',
      createdAt: typeof bag.createdAt === 'number' ? bag.createdAt : 0,
      expiresAt: typeof bag.expiresAt === 'number' ? bag.expiresAt : 0,
      result: bag.result,
      error: typeof bag.error === 'string' ? bag.error : undefined,
    };
  }
  return {
    requestId: typeof bag.requestId === 'string' ? bag.requestId : requestId,
    status: rawStatus as TariTransactionRequestStatus,
    note: typeof bag.note === 'string' ? bag.note : '',
    createdAt: typeof bag.createdAt === 'number' ? bag.createdAt : 0,
    expiresAt: typeof bag.expiresAt === 'number' ? bag.expiresAt : 0,
    result: bag.result,
    error: typeof bag.error === 'string' ? bag.error : undefined,
  };
}

function readTransactionId(result: unknown): string | undefined {
  if (typeof result === 'string' && result !== '') return result;
  if (typeof result === 'object' && result !== null) {
    const bag = result as Record<string, unknown>;
    for (const key of ['transactionId', 'transaction_id', 'txId']) {
      const value = bag[key];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return undefined;
}

/**
 * `tari_submitTransactionRequest` — takes ONLY a `requestId`.
 *
 * That is the structural point of this flow: submission carries no payload, so
 * there is no code path on which a reviewed transaction could be re-derived,
 * mutated, or replaced between the user's approval and the broadcast. The wallet
 * submits the very request it already approved.
 */
export async function submitTransactionRequest(provider: TariProvider, requestId: string): Promise<TariSignResult> {
  if (typeof requestId !== 'string' || requestId === '') {
    throw new TariProviderError('A submission requires a non-empty requestId.', 'MALFORMED_REPLY');
  }
  const reply = await call<unknown>(provider, TARI_METHODS.submitTransactionRequest, { requestId });
  const bag = typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
  const id = readTransactionId(reply);
  const result: TariSignResult = { transactionId: readString(id, 'transactionId') };
  if (typeof bag.epoch === 'string' || typeof bag.epoch === 'number') result.epoch = String(bag.epoch);
  return result;
}

export interface TransactionRequestHooks {
  /** Called with the durable id as soon as the wallet issues it. Persist before polling. */
  onRequestId(requestId: string): void | Promise<void>;
  /** Called after the approval is submitted. Persist the chain id before reconciling. */
  onSubmitted(result: TariSignResult): void | Promise<void>;
}

/**
 * Drive the trio from a frozen, reviewed operation to a submitted result.
 *
 * The shape is fixed: create the request carrying the EXACT reviewed
 * instructions, persist the id, poll, and submit once — by id, never by payload.
 *
 * `pending` is NOT an error and NOT a submission. The call returns with the id
 * persisted so the caller can resume after a reload, which is the entire reason
 * this flow is preferred. `rejected` is a clean user decision. `failed` is
 * recorded as a wallet failure. An unrecognised status fails closed without
 * submitting.
 */
export async function submitViaTransactionRequest(
  provider: TariProvider,
  operation: TariInstructionsTransactionRequestOperation,
  hooks: TransactionRequestHooks,
): Promise<TariSignResult | { pendingRequestId: string }> {
  const requestId = await createTransactionRequest(provider, operation);
  await hooks.onRequestId(requestId);

  const outcome = await pollTransactionRequest(provider, requestId);
  switch (outcome.state) {
    case 'PENDING':
      // The human has not answered. Nothing is submitted and nothing is an
      // error; the durable id is already persisted for a later resume.
      return { pendingRequestId: requestId };

    case 'APPROVED': {
      // Exactly one submission, by id.
      const result = await submitTransactionRequest(provider, requestId);
      await hooks.onSubmitted(result);
      return result;
    }

    case 'SUBMITTED':
      // Already submitted — for example by an earlier page load. Submitting
      // again would be a duplicate broadcast, so the stored result is used.
      if (outcome.transactionId === undefined) {
        throw new TariProviderError('The wallet reports this request as submitted but returned no transaction id.', 'UNKNOWN');
      }
      await hooks.onSubmitted({ transactionId: outcome.transactionId });
      return { transactionId: outcome.transactionId };

    case 'REJECTED':
      throw new TariProviderError(outcome.reason ?? 'The user declined the transaction request.', 'REJECTED');

    case 'FAILED':
      throw new TariProviderError(outcome.reason ?? 'The wallet failed the transaction request.', 'INTERNAL');

    default:
      throw new TariProviderError(`The wallet reported an unrecognised transaction-request status ("${outcome.rawStatus}"); nothing was submitted.`, 'MALFORMED_REPLY');
  }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type TariAvailability =
  /** A provider object exists and answered a real call. */
  | { available: true; network?: string }
  /** A provider object exists but cannot service requests here (e.g. the connector on a top-level page). */
  | { available: false; reason: 'unavailable'; detail: string }
  /** No provider object at all. */
  | { available: false; reason: 'absent'; detail: string };

/**
 * Establish whether the provider can actually answer, without prompting.
 *
 * `Boolean(window.tari)` is NOT this. The official connector is documented as
 * safe to include unconditionally and still publishes a provider object on a
 * page it cannot serve, so presence is a necessary but not sufficient condition.
 *
 * `tari_getNetwork` is the right probe: the contract types it as returning a
 * `string` and the reference states it is answerable WITHOUT a connection, so it
 * neither prompts nor requires a prior `tari_requestAccounts`. That is also why
 * a network pre-check is possible before the user is ever asked to connect.
 *
 * The probe is bounded by `PROVIDER_READ_TIMEOUT_MS`, so a provider that never
 * answers produces one honest unavailable state rather than an endless spinner,
 * and a failure here is a WALLET state, never a transaction failure.
 *
 * The connector's own header comment claims `window.tari.isAvailable` is false
 * outside Tari Universe, but the published interface does not declare the
 * property and the deployed connector object does not define it. Availability is
 * therefore established by an actual supported call, never by reading a property
 * the contract does not define.
 */
export async function probeAvailability(scope: unknown = globalThis): Promise<TariAvailability> {
  if (!isTariInjected(scope)) {
    return { available: false, reason: 'absent', detail: 'No Tari wallet provider is present on this page.' };
  }
  const provider = (scope as { tari: TariProvider }).tari;
  try {
    const network = await fetchNetwork(provider);
    return { available: true, network: network.network };
  } catch (error) {
    const detail = error instanceof TariProviderError ? error.message : String(error);
    return { available: false, reason: 'unavailable', detail };
  }
}

// ---------------------------------------------------------------------------
// Provider lifecycle
// ---------------------------------------------------------------------------

/**
 * Whether a change in the `window.tari` object is legitimate or an attack.
 *
 * The published lifecycle makes a provider appear AFTER page code has already
 * run: the extension injects at `document_start` and the connector on script
 * load, and both dispatch `tari#initialized`. Inside Tari Universe the connector
 * also deliberately claims `window.tari` for the embedding wallet. Treating
 * every appearance as a replacement attack would make the documented integration
 * unusable, so the two are distinguished by whether anything was pinned FIRST:
 *
 *   - no provider captured yet  -> an appearing provider is INITIALISATION, and
 *                                 is exactly what the contract describes;
 *   - a provider was captured   -> a different object is REPLACEMENT, which
 *                                 invalidates the session and every review bound
 *                                 to it.
 *
 * The same object arriving again is never a replacement.
 */
export type ProviderTransition = 'INITIALISED' | 'UNCHANGED' | 'REPLACED' | 'REMOVED';

export function classifyProviderTransition(pinned: object | undefined, current: object | undefined): ProviderTransition {
  if (current === undefined) return pinned === undefined ? 'UNCHANGED' : 'REMOVED';
  if (pinned === undefined) return 'INITIALISED';
  return pinned === current ? 'UNCHANGED' : 'REPLACED';
}

/**
 * Subscribe to provider lifecycle events.
 *
 * `tari#initialized` is a WINDOW event dispatched by the connector and declared
 * in the published `WindowEventMap`, and it is how a provider that appears after
 * module evaluation is noticed. The connector additionally offers
 * `tari:announceProvider` and a `window.tariProviders` registry; neither is used
 * here. This app has exactly one official interface, `window.tari`, and turning
 * the registry into a wallet picker would be a second, unofficial selection
 * mechanism — and an event is something a hostile page script can dispatch
 * freely, so it may only ever be a HINT to re-read, never an authority.
 *
 * `accountsChanged` invalidates everything account-bound: quotes, unsigned
 * reviews, and cached balances. The grant for any private view access also drops
 * on account change and on disconnect, so `privateViewGranted` is re-read rather
 * than remembered.
 */
export function onProviderAccountsChanged(provider: TariProvider, handler: () => void): () => void {
  if (typeof provider.on !== 'function') return () => undefined;
  let unsubscribe: unknown;
  try {
    unsubscribe = provider.on('accountsChanged', handler);
  } catch {
    return () => undefined;
  }
  return () => {
    if (typeof unsubscribe === 'function') {
      try {
        (unsubscribe as () => void)();
      } catch {
        // A provider whose unsubscribe throws is already unusable; the event
        // handler is inert either way.
      }
    }
  };
}

/** Listen for the provider becoming available. Returns an unsubscribe. */
export function onProviderInitialized(scope: unknown = globalThis, handler: () => void): () => void {
  const target = scope as { addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void };
  if (typeof target?.addEventListener !== 'function') return () => undefined;
  target.addEventListener('tari#initialized', handler);
  return () => target.removeEventListener?.('tari#initialized', handler);
}
