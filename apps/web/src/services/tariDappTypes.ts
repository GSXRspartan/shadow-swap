/**
 * The published Tari dApp provider contract, transcribed.
 *
 * Source of truth: https://universe.tari.mw/integration/tari-dapp.d.ts
 *
 * This file exists so the outbound request types and the inbound reply types
 * are checked against the PUBLISHED interface rather than against a
 * reverse-engineered copy of one wallet's bridge script. The previous
 * implementation was derived from `tari-connector.js` alone, and that produced
 * concrete, non-conforming wire shapes:
 *
 *   - `tari_getSubstate` was sent `{ address }`, plus a `substateId` alias,
 *     instead of the documented `{ substateId, version? }`;
 *   - `tari_getNetwork` was parsed as an object instead of the documented
 *     `string`;
 *   - `tari_requestAccounts` / `tari_getAccounts` were parsed as objects
 *     instead of the documented `string[]`;
 *   - `tari_getBalances` was read with a `resourceType` key the contract does
 *     not define, instead of `kind` / `divisibility` / `confidentialAmount`;
 *   - `tari_signAndSubmitTransaction` was sent `{ transaction, display }`,
 *     which is not `{ instructions, maxFee?, inputs?, dryRun? }` at all;
 *   - `tari_disconnect` was treated as "must not return null", while the
 *     contract types it as `Promise<null>`.
 *
 * The transcribed types are the contract this repository codes against. Where
 * the connector and the published types disagree, the published types win and
 * the disagreement is recorded in
 * `docs/TARI_WALLET_INTEGRATION_CONFORMANCE.md`.
 *
 * The `instructions` payloads this repository sends are produced by
 * `buildSignableInstructions` in `lib/instructions.ts` from the wallet-adapter
 * intents, and are deliberately typed `unknown[]` here, exactly as upstream
 * declares them: the contract does not enumerate the instruction grammar, so
 * inventing a narrower local type would be a second, unofficial contract.
 */

export type TariMethod =
  | 'tari_requestAccounts'
  | 'tari_getAccounts'
  | 'tari_getNetwork'
  | 'tari_getWalletAddress'
  | 'tari_getBalances'
  | 'tari_getSubstate'
  | 'tari_getCapabilities'
  | 'tari_getTransactionResult'
  | 'tari_signAndSubmitTransaction'
  | 'tari_withdrawStealthAndExecute'
  | 'tari_htlcFund'
  | 'tari_createTransactionRequest'
  | 'tari_getTransactionRequest'
  | 'tari_submitTransactionRequest'
  | 'tari_requestViewAccess'
  | 'tari_getViewAccess'
  | 'tari_revokeViewAccess'
  | 'tari_getPrivateBalances'
  | 'tari_getShieldedOutputs'
  | 'tari_scanForPrivatePayments'
  | 'tari_scanForResourceUtxos'
  | 'tari_claimPrivatePayment'
  | 'tari_signOwnershipChallenge'
  | 'tari_signWalletOwnershipChallenge'
  | 'tari_disconnect';

/** Raw units. Divide by `10 ** divisibility` to display — never assume 6. */
export interface TariTokenBalance {
  resourceAddress: string;
  kind: 'Fungible' | 'NonFungible' | 'Confidential' | 'Stealth';
  symbol: string | null;
  name: string | null;
  divisibility: number;
  /** The revealed (publicly spendable) balance. */
  amount: string | bigint;
  /** The stealth/confidential balance. "0" when the site lacks view access. */
  confidentialAmount: string | bigint;
}

/** Feature detection. Branch on these, never on wallet identity. */
export interface TariWalletCapabilities {
  exactInputSelection: boolean;
  stealthWithdraw: boolean;
  stealthRedeem: boolean;
  stealthRedeemPrivateFee: boolean;
  htlcFund: boolean;
  scriptPathSpend: boolean;
  privateSpend: boolean;
  minimumValuePromise: boolean;
  ownershipProof: boolean;
  walletOwnershipProof: boolean;
  privateBalanceView: boolean;
  privateViewGranted: boolean;
  transactionResultLookup: boolean;
  transactionRequests: boolean;
  walletAddress: boolean;
  dryRunIsLocal: boolean;
}

export interface TariSignAndSubmitParams {
  instructions: unknown[];
  /** Raw units, as a string. Defaults to the wallet's own limit when omitted. */
  maxFee?: string;
  /** Substates to pin. Optional — the wallet resolves what it needs. */
  inputs?: Array<{ substate_id: string; version: number | null }>;
  /** Simulate only. Never prompts, spends nothing — use for quotes. */
  dryRun?: boolean;
}

/**
 * The `{ kind: 'instructions', … }` transaction-request operation, which is the
 * only kind this app creates.
 *
 * The published union also has `shield`, `unshield`, `sendPrivately`,
 * `withdrawStealthAndExecute`, `redeemStealthOutputAndExecute`,
 * `redeemStealthOutputWithPrivateFee`, and the HTLC kinds. They are deliberately
 * NOT transcribed here, for two independent reasons.
 *
 * First, scope: this is a public AMM, an LP protocol, a public NFT marketplace,
 * and a multi-asset market-data reader. It has no private/stealth feature, and
 * adding a wallet method merely because the API exposes it would widen what the
 * app asks a wallet for. `createTransactionRequest` refuses any kind other than
 * `instructions` at runtime, and the type here means a private kind is not
 * expressible in the first place.
 *
 * Second, safety: the documented reason those kinds exist is that a stealth
 * transfer needs a balance proof and per-input one-time authorizations only the
 * wallet's own signer can produce — they "cannot be hand-built". Transcribing
 * the fields would put a constructible-looking shape for secret material into
 * this repository, which is exactly the shape a future edit could start
 * populating. The public documentation remains the reference for that surface.
 */
export interface TariInstructionsTransactionRequestOperation {
  kind: 'instructions';
  instructions: unknown[];
  maxFee?: string;
  inputs?: Array<{ substate_id: string; version: number | null }>;
}

export type TariTransactionRequestStatus = 'pending' | 'approved' | 'submitting' | 'submitted' | 'rejected' | 'failed';

export interface TariTransactionRequestSummary {
  requestId: string;
  status: TariTransactionRequestStatus;
  note: string;
  createdAt: number;
  expiresAt: number;
  result?: unknown;
  error?: string;
}

/** 4001 rejected · 4100 not connected · 4200 unsupported · -32603 internal. */
export interface TariProviderError extends Error {
  code?: number;
}

export interface TariProvider {
  isTariWallet: true;
  /**
   * Only on the embedded (iframe) provider: true when running inside a wallet.
   *
   * Declared so the property is visible to the type system, and documented so
   * nobody gates on it: upstream marks it optional and explicitly says a dApp
   * never detects which wallet it has. It is NOT a security or availability
   * signal — the Sapient extension does not publish it at all, so treating
   * `isEmbedded === false` as "no wallet" refuses a perfectly good provider.
   */
  isEmbedded?: boolean;
  request(args: { method: 'tari_requestAccounts' }): Promise<string[]>;
  request(args: { method: 'tari_getAccounts' }): Promise<string[]>;
  request(args: { method: 'tari_getNetwork' }): Promise<string>;
  request(args: { method: 'tari_getWalletAddress' }): Promise<string>;
  request(args: { method: 'tari_getBalances' }): Promise<TariTokenBalance[]>;
  request(args: { method: 'tari_getCapabilities' }): Promise<TariWalletCapabilities>;
  request(args: { method: 'tari_getSubstate'; params: { substateId: string; version?: number | null } }): Promise<unknown>;
  request(args: { method: 'tari_getTransactionResult'; params: { transactionId: string } }): Promise<unknown>;
  request(args: { method: 'tari_signAndSubmitTransaction'; params: TariSignAndSubmitParams }): Promise<unknown>;
  request(args: { method: 'tari_createTransactionRequest'; params: TariInstructionsTransactionRequestOperation }): Promise<{ requestId: string }>;
  request(args: { method: 'tari_getTransactionRequest'; params: { requestId: string } }): Promise<TariTransactionRequestSummary>;
  request(args: { method: 'tari_submitTransactionRequest'; params: { requestId: string } }): Promise<unknown>;
  request(args: { method: 'tari_disconnect' }): Promise<null>;
  request(args: { method: TariMethod; params?: unknown }): Promise<unknown>;
  on?(event: 'accountsChanged', handler: (accounts: string[]) => void): () => void;
}

/** Documented provider error codes. Anything else is unknown, never a verdict. */
export const TARI_ERROR_USER_REJECTED = 4001;
export const TARI_ERROR_NOT_CONNECTED = 4100;
export const TARI_ERROR_UNSUPPORTED_METHOD = 4200;
export const TARI_ERROR_INTERNAL = -32603;

/** The full published capability set. Unlisted keys are not capabilities. */
export const TARI_CAPABILITY_KEYS = [
  'exactInputSelection',
  'stealthWithdraw',
  'stealthRedeem',
  'stealthRedeemPrivateFee',
  'htlcFund',
  'scriptPathSpend',
  'privateSpend',
  'minimumValuePromise',
  'ownershipProof',
  'walletOwnershipProof',
  'privateBalanceView',
  'privateViewGranted',
  'transactionResultLookup',
  'transactionRequests',
  'walletAddress',
  'dryRunIsLocal',
] as const satisfies readonly (keyof TariWalletCapabilities)[];
