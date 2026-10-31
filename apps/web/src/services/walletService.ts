/**
 * Wallet/provider service.
 *
 * Implements the generic `WalletAdapter` seam on top of the single
 * `window.tari` boundary, and exposes the session model the React layer
 * consumes. Wallet brand never appears in trading logic: everything downstream
 * is capability-driven, per the published rule "Never branch on which wallet is
 * present. Call `tari_getCapabilities` and branch on the answer."
 *
 * Account / network / capability changes are pushed as events so the UI can
 * pause execution rather than continue under a silently changed identity.
 */

import type { WalletAdapter, WalletSession, NetworkInfo, AccountInfo, Balance, ResourceInfo, TransactionPreview, TransactionResult } from '@tari-ootle/wallet-adapter';
import type { PoolState, OotleReadbackProvider, AuthoritativeSubstateReader } from '@tari-ootle/protocol-client';
import { createOotleReadbackProvider, decodePoolState } from '@tari-ootle/protocol-client';
import type { WalletLegCapabilities } from '@tari-ootle/protocol-client/crosschain';
import {
  TariProviderError,
  assertStealthWithdrawOperation,
  classifyProviderTransition,
  currentProviderObject,
  disconnectProvider,
  dryRunTransaction,
  fetchAccounts,
  fetchBalances,
  fetchCapabilities,
  fetchCreatedComponents,
  fetchNetwork,
  fetchTransactionResult,
  fetchWalletAddress,
  getTariProvider,
  instructionsOperation,
  isTariInjected,
  mapLegCapabilities,
  mapTransactionStatus,
  onProviderAccountsChanged,
  readSubstate,
  readRawSubstate,
  requestAccounts,
  resumeTransactionRequest,
  signAndSubmit,
  submitViaTransactionRequest,
  type TariProvider,
  type TariSignResult,
} from './tariWindow.js';
import type { TariWalletCapabilities, TariWithdrawStealthAndExecuteOperation } from './tariDappTypes.js';
import { checkNetwork } from '../lib/networks.js';
import { requireAccountComponent } from '../lib/addressDomain.js';
import type { LiveIdentityInput } from '../lib/executionIdentity.js';
import {
  blockingPendingRequest,
  describeResumeRefusal,
  forgetPendingRequest,
  listPendingRequests,
  rememberPendingRequest,
  resumeBlockReason,
  type PendingRequestStorage,
  type PendingWalletRequest,
  type ResumeBinding,
  type ResumeRefusal,
} from '../lib/pendingRequests.js';
import { awaitingApproval } from '@tari-ootle/protocol-client';

export type WalletEvent =
  | { kind: 'accountsChanged' }
  | { kind: 'networkChanged'; network: string }
  | { kind: 'capabilitiesChanged' }
  | { kind: 'disconnected' };

export type WalletEventListener = (event: WalletEvent) => void;

export interface WalletBridge extends WalletAdapter {
  /**
   * The published `tari_getCapabilities` advertisement, exactly as the provider
   * returned it. This is THE feature-selection mechanism: a dApp never asks
   * which wallet it has, only what the account can do.
   */
  walletCapabilities(): TariWalletCapabilities | undefined;
  /** The L1/L2 leg view derived from the published set. Fails closed. */
  legCapabilities(): WalletLegCapabilities | undefined;
  /** Substate reader for the protocol-client's authoritative readback. */
  /**
   * `EXECUTION` (default) refuses a value the wallet's indexer explicitly reported as
   * unverified; `DISPLAY` accepts it for a display-only view. See `readRawSubstate`.
   */
  substateReader(purpose?: 'EXECUTION' | 'DISPLAY'): AuthoritativeSubstateReader;
  /** Ootle readback provider bound to this wallet. Never uses an indexer. */
  readbackProvider(): OotleReadbackProvider;
  /** Components `templateHex` created in a committed transaction, from the receipt. */
  createdComponents(transactionId: string, templateHex: string): Promise<string[] | undefined>;
  on(listener: WalletEventListener): () => void;
  /** The provider object, for reference-identity pinning. */
  providerObject(): object;
  /** A live identity snapshot, for TOCTOU verification before authorization. */
  liveIdentity(sessionNonce: string): Promise<LiveIdentityInput>;
  /**
   * Persist a wallet transaction-request id against the durable operation, so a
   * reload can resume by id instead of losing the outcome.
   */
  bindRequestId(operationId: string, requestId: string): void | Promise<void>;
  /** Point the bridge at the durable ledger. Injected so the store stays testable. */
  setPendingRequestStorage(storage: PendingRequestStorage | undefined): void;
  /**
   * Every durable request this app knows about, across reloads.
   *
   * The ledger is UNTRUSTED input and is never consulted for authority: it can only
   * tell the UI what to go and ASK the wallet about.
   */
  pendingRequests(): readonly PendingWalletRequest[];
  /**
   * The unresolved request that must be dealt with before a new financial
   * operation may start, for this account on this network.
   */
  blockingPendingRequest(): PendingWalletRequest | undefined;
  /**
   * Resume a durable request BY ID.
   *
   * There is no payload argument, by construction: submission takes only the
   * `requestId` the wallet already approved. There is therefore no code path on
   * which a reviewed transaction is reconstructed, mutated, or replaced between
   * approval and broadcast.
   */
  resumePendingRequest(
    record: PendingWalletRequest,
    live: ResumeBinding,
  ): Promise<{ submitted: true; transactionId: string } | { submitted: false; state: 'AWAITING_APPROVAL' | 'REJECTED' | 'FAILED' | 'UNKNOWN'; detail?: string }>;
  /**
   * Forget a durable request. Only ever called on a verdict the WALLET gave, never
   * because time passed or the user navigated away.
   */
  forgetPendingRequest(operationId: string): void;
  /**
   * Sign the exact request that was reviewed. Preferred over `signAndSubmit`
   * for any financial operation, because it does not re-derive the payload from
   * a preview and therefore cannot drift from what the user approved.
   */
  signAndSubmitReviewed(
    preview: TransactionPreview,
    reviewedRequest: Readonly<Record<string, unknown>>,
    context: { assets: string[]; operation: string; network: string; poolOrDestination: string; privacyDisclosure: string; operationId?: string },
  ): Promise<TransactionResult>;
  /** Simulate without prompting. Never the source of an AMM quote. */
  preflight(reviewedRequest: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; reason?: string }>;
}

function toNetworkInfo(view: { network: string; epoch?: string }, previous?: NetworkInfo): NetworkInfo {
  return {
    name: view.network,
    indexerUrls: previous?.indexerUrls ?? [],
    nativeResourceAddress: previous?.nativeResourceAddress ?? null,
  };
}

class TariBridgeWalletAdapter implements WalletBridge {
  private provider: TariProvider;
  private capabilities: TariWalletCapabilities | undefined;
  private session: WalletSession | undefined;
  private listeners = new Set<WalletEventListener>();
  private balances: Balance[] = [];
  private resources: ResourceInfo[] = [];
  /** Durable operation id -> wallet transaction-request id, for reload resume. */
  private readonly requestIds = new Map<string, string>();
  /**
   * Durable ledger backing `requestIds`.
   *
   * The in-memory map is a fast path for this tab. This is what survives a reload,
   * which is the whole point of the create/approve/submit split. Injected rather than
   * reaching for `localStorage` directly so the whole store is testable and so a
   * storage failure is a single contained degradation rather than a thrown error on
   * the approval path.
   */
  private pendingStorage: PendingRequestStorage | undefined;
  private detachAccounts: (() => void) | undefined;
  /**
   * The provider object this session was established against, if any.
   *
   * Assigned by `createWalletService` once the bridge is built. Its only use is
   * to tell a legitimate late INITIALISATION (no provider existed when the app
   * started) apart from a REPLACEMENT (a different object appeared while a
   * session was live). Undefined means "nothing was pinned", which is the
   * initialisation case and is never a fault.
   */
  pinnedProvider?: object;

  constructor(private readonly allowedNetworkId: string) {
    this.provider = getTariProvider();
  }

  adapterName(): string {
    return 'TariBrowserProvider';
  }

  adapterType(): 'extension' {
    return 'extension';
  }

  async isSupported(): Promise<boolean> {
    try {
      this.provider = getTariProvider();
    } catch {
      return false;
    }
    try {
      // Mandatory capability handshake. A provider that cannot answer is not a
      // provider we will drive. This is a CAPABILITY question, never a question
      // about which wallet is present.
      this.capabilities = await fetchCapabilities(this.provider);
      return this.capabilities !== undefined;
    } catch {
      return false;
    }
  }

  async connect(networkHint?: NetworkInfo): Promise<WalletSession> {
    this.provider = getTariProvider();
    const network = await fetchNetwork(this.provider);
    const guard = checkNetwork(network.network);
    if (!guard.ok) {
      throw new TariProviderError(guard.reason ?? `Network "${network.network}" is not allowed.`, 'WRONG_NETWORK');
    }
    // The page is pinned to one network; a provider that silently reports a
    // different one is treated as an account/network change, not a mismatch to
    // paper over.
    if (network.network !== this.allowedNetworkId) {
      throw new TariProviderError(
        `This page is pinned to "${this.allowedNetworkId}" but the wallet reports "${network.network}". Switch the wallet network, then reconnect.`,
        'WRONG_NETWORK',
      );
    }
    const accounts = await requestAccounts(this.provider);
    if (accounts.length === 0) throw new TariProviderError('The wallet returned no account after an explicit connect request.', 'MALFORMED_REPLY');
    // The account that settles a public AMM / NFT trade is the ACCOUNT COMPONENT
    // address from the accounts method, never the bech32m wallet address. The two
    // are different values and the component is not derivable from the wallet
    // address by this app.
    const account = accounts[0];
    requireAccountComponent(account.componentAddress, 'accounts[0].componentAddress');

    this.capabilities = await fetchCapabilities(this.provider);
    this.balances = await this.readBalances();
    this.watchAccounts();

    const info: NetworkInfo = toNetworkInfo(network, networkHint);
    this.session = {
      adapterType: 'extension',
      connectedAt: new Date().toISOString(),
      network: info,
      account: { address: account.componentAddress, accountIndex: account.accountIndex ?? 0, label: 'Tari' },
      supportedFeatures: this.capabilities === undefined ? [] : Object.entries(this.capabilities).filter(([, v]) => v).map(([k]) => k),
      permissions: ['readBalances', 'signTransactions'],
    };
    this.listeners.forEach((listener) => listener({ kind: 'capabilitiesChanged' }));
    return this.session;
  }

  /**
   * React to `accountsChanged`.
   *
   * The event invalidates everything bound to the previous account: cached
   * balances, the stored network, and the capability advertisement. It does NOT
   * attempt to re-bind an in-flight approval to the new account — an approval
   * that was granted for one account must not be continued under another, so the
   * event tells the UI to fail closed and reconcile.
   *
   * Any private view-access grant also drops on an account change and on
   * disconnect, which is why capabilities are re-read here rather than cached.
   */
  private watchAccounts(): void {
    this.detachAccounts?.();
    this.detachAccounts = onProviderAccountsChanged(this.provider, () => {
      this.balances = [];
      this.resources = [];
      void (async () => {
        try {
          this.capabilities = await fetchCapabilities(this.provider);
        } catch {
          this.capabilities = undefined;
        }
        try {
          const network = await fetchNetwork(this.provider);
          this.listeners.forEach((listener) => listener({ kind: 'networkChanged', network: network.network }));
        } catch {
          // A network that cannot be read is not silently treated as unchanged.
          this.listeners.forEach((listener) => listener({ kind: 'disconnected' }));
          return;
        }
        this.listeners.forEach((listener) => listener({ kind: 'accountsChanged' }));
      })();
    });
  }

  async disconnect(): Promise<void> {
    this.session = undefined;
    this.balances = [];
    this.resources = [];
    this.capabilities = undefined;
    this.detachAccounts?.();
    this.detachAccounts = undefined;
    try {
      const provider = this.provider;
      await fetchAccounts(provider); // cheap liveness probe before revoking
      await disconnectProvider(provider);
    } catch {
      // A provider that refuses or has gone away is already disconnected.
    }
    this.listeners.forEach((listener) => listener({ kind: 'disconnected' }));
  }

  async getNetwork(): Promise<NetworkInfo> {
    const view = await fetchNetwork(this.provider);
    const guard = checkNetwork(view.network);
    if (!guard.ok) throw new TariProviderError(guard.reason ?? 'Disallowed network.', 'WRONG_NETWORK');
    return toNetworkInfo(view, this.session?.network);
  }

  async getAccounts(): Promise<AccountInfo[]> {
    const accounts = await fetchAccounts(this.provider);
    return accounts.map((account, index) => ({ address: account.componentAddress, accountIndex: account.accountIndex ?? index }));
  }

  async getSelectedAccount(): Promise<AccountInfo> {
    const [first] = await this.getAccounts();
    if (first === undefined) throw new TariProviderError('The wallet reported no accounts.', 'MALFORMED_REPLY');
    return first;
  }

  private async readBalances(): Promise<Balance[]> {
    const raw = await fetchBalances(this.provider);
    this.balances = raw.map((entry) => ({
      resourceAddress: entry.resourceAddress,
      amount: entry.amount,
      resourceType: entry.resourceType as Balance['resourceType'],
      // Display metadata only. The exact raw `amount` above is what settlement
      // uses; neither of these is ever read to decide identity or safety.
      ...(entry.divisibility === undefined ? {} : { divisibility: entry.divisibility }),
      ...(entry.symbol === undefined ? {} : { symbol: entry.symbol }),
    }));
    this.resources = this.balances.map((balance) => ({ address: balance.resourceAddress, type: balance.resourceType }));
    return this.balances;
  }

  async getBalances(): Promise<Balance[]> {
    return this.readBalances();
  }

  async getResources(): Promise<ResourceInfo[]> {
    return this.resources;
  }

  async previewTransaction(preview: Partial<TransactionPreview>): Promise<TransactionPreview> {
    const full: TransactionPreview = {
      componentAddress: preview.componentAddress ?? '',
      method: preview.method ?? '',
      args: preview.args ?? [],
      resourcesInvolved: preview.resourcesInvolved ?? [],
      estimatedOutputs: preview.estimatedOutputs ?? [],
      fee: preview.fee ?? 0,
      maxEpoch: preview.maxEpoch ?? 0,
      privacyDisclosure: preview.privacyDisclosure ?? 'Pool reserves and amounts are revealed at the AMM boundary.',
      networkName: (await this.getNetwork()).name,
    };
    return { ...preview, ...full };
  }

  /**
   * Sign and submit the request the user actually reviewed.
   *
   * The reviewed request is sent VERBATIM. An older shape rebuilt a
   * `{ method, args, component }` payload from the preview, which silently
   * discarded the reviewed legs, the minimum output, and the per-resource
   * amounts. A reviewed request is now mandatory for a financial operation, and
   * there is deliberately no fallback to a preview-derived payload: a signer
   * that cannot be handed the exact reviewed request must not be driven at all.
   *
   * FLOW. The published reference prefers the create -> approve -> submit trio
   * over the one-shot call, because the single call "loses its result forever if
   * the page reloads while the approval popup is open", and this protocol's whole
   * durable-operation design depends on surviving exactly that. The trio is
   * therefore the production path whenever the account advertises
   * `capabilities.transactionRequests`, which is a CAPABILITY check and never a
   * wallet-brand check.
   *
   * With the trio, the reviewed operation is sent ONCE as
   * `{ kind: 'instructions', instructions }`, the wallet's durable `requestId` is
   * persisted, and submission carries that id and nothing else. There is
   * therefore no code path on which a payload is reconstructed between the user's
   * approval and the broadcast, which is a structural strengthening of
   * "shown == signed" over the one-shot form: the one-shot still depends on the
   * caller passing the right object, while the trio's submit takes only an id.
   *
   * `pending` is not an error and not a submission. It returns so the caller can
   * resume by the persisted id. `rejected` is a clean user decision. `failed` is
   * recorded as a wallet failure. An unrecognised status fails closed without
   * submitting.
   *
   * WHEN THE WALLET IS STILL WAITING, the thrown error carries the
   * awaiting-approval brand from the protocol client rather than being a bare
   * failure. That distinction is load-bearing: an unbranded throw is recorded as
   * `FAILED`, which hides a live durable wallet request from the user and invites
   * them to press the button again — minting a second request for the same intent,
   * so that approving both popups executes the trade twice. See
   * `lib/pendingRequests.ts`.
   */
  async signAndSubmitReviewed(
    preview: TransactionPreview,
    reviewedRequest: Readonly<Record<string, unknown>>,
    context: { assets: string[]; operation: string; network: string; poolOrDestination: string; privacyDisclosure: string; operationId?: string; reviewFingerprint?: string },
  ): Promise<TransactionResult> {
    const instructions = requireReviewedInstructions(reviewedRequest);
    // A signing request that names no asset, operation, network, or destination
    // cannot be shown to the user in a comprehensible way, so it is refused
    // before it is handed to a signer.
    if (context.assets.length === 0) {
      throw new TariProviderError('Refusing to present a signing request with no named assets.', 'REJECTED');
    }
    if (context.operation.trim() === '' || context.network.trim() === '') {
      throw new TariProviderError('Refusing to present a signing request with no operation or network context.', 'REJECTED');
    }
    if (context.poolOrDestination.trim() === '') {
      throw new TariProviderError('Refusing to present a signing request with no pool or destination context.', 'REJECTED');
    }

    const stealth = reviewedStealthOperation(reviewedRequest);
    const result = stealth !== undefined ? await this.submitStealth(stealth, context) : await this.submitExact(instructions, context);
    void preview;
    return { transactionId: result.transactionId, epoch: result.epoch === undefined ? 0 : Number(result.epoch), status: 'pending' };
  }

  /**
   * Send the reviewed instructions, by the preferred flow where supported.
   *
   * The capability that selects the flow is `transactionRequests` from
   * `tari_getCapabilities`. There is deliberately no brand test anywhere on this
   * path: a dApp must not detect which wallet it has.
   *
   * The durable request id is written to the pending-request ledger BEFORE the
   * approval is polled, and before any await that could be interrupted by a reload.
   * That ordering is the entire recovery guarantee: once the wallet has minted an
   * id, this app is able to find it again even if the tab dies mid-approval.
   */
  private async submitExact(
    instructions: readonly unknown[],
    context: { operation: string; network: string; poolOrDestination: string; operationId?: string; reviewFingerprint?: string },
  ): Promise<TariSignResult> {
    const capabilities = this.capabilities;
    const operationId = context.operationId;
    const account = this.session?.account?.address;
    // An approval can only be recorded against the identity it was actually given
    // to. Without an operation id or a review fingerprint there is nothing durable to
    // bind the request to, so the durable path is not offered rather than offered
    // un-bound.
    const bindable = operationId !== undefined && context.reviewFingerprint !== undefined && account !== undefined;

    if (capabilities !== undefined && capabilities.transactionRequests === true && bindable) {
      const outcome = await submitViaTransactionRequest(this.provider, instructionsOperation(instructions), {
        onRequestId: (requestId) => {
          this.requestIds.set(operationId, requestId);
          rememberPendingRequest(this.pendingStorage, {
            operationId,
            requestId,
            reviewFingerprint: context.reviewFingerprint as string,
            operation: context.operation,
            approvedAccount: account as string,
            approvedNetwork: context.network,
            destination: context.poolOrDestination,
            createdAtUnixMs: Date.now(),
            state: 'AWAITING_APPROVAL',
          });
        },
        onSubmitted: (result) => {
          rememberPendingRequest(this.pendingStorage, {
            operationId,
            requestId: this.requestIds.get(operationId) ?? '',
            reviewFingerprint: context.reviewFingerprint as string,
            operation: context.operation,
            approvedAccount: account as string,
            approvedNetwork: context.network,
            destination: context.poolOrDestination,
            createdAtUnixMs: Date.now(),
            state: 'SUBMITTED',
            transactionId: result.transactionId,
          });
        },
      });
      if ('pendingRequestId' in outcome) {
        // The human has not answered yet. Nothing was submitted, and this is NOT
        // a failure: the durable id is already in the ledger and the caller — and
        // the next page load — can resume it. The branded error is what stops the
        // execution flow from recording this as FAILED.
        throw awaitingApproval(`Operation ${operationId} is awaiting wallet approval of request ${outcome.pendingRequestId}. It was not submitted.`);
      }
      return outcome;
    }
    // Capability-gated fallback. Reached when the account reports
    // `transactionRequests: false` (or advertised nothing), or when the call could
    // not be durably bound. The one-shot form is still given the EXACT reviewed
    // instructions, so "shown == signed" is preserved; what is lost is the
    // reload-survival of the request id.
    return signAndSubmit(this.provider, { instructions });
  }

  /**
   * A reviewed `withdrawStealthAndExecute` operation, sent ONLY through the durable
   * transaction-request trio and ONLY when the account advertises both
   * `transactionRequests` and `stealthWithdraw`. There is no one-shot fallback: the deprecated
   * single-call method would lose the durable request id, and a plain instruction list cannot
   * express this operation at all.
   */
  private async submitStealth(
    operation: TariWithdrawStealthAndExecuteOperation,
    context: { operation: string; network: string; poolOrDestination: string; operationId?: string; reviewFingerprint?: string },
  ): Promise<TariSignResult> {
    const capabilities = this.capabilities;
    const operationId = context.operationId;
    const account = this.session?.account?.address;
    if (capabilities?.stealthWithdraw !== true || capabilities.transactionRequests !== true) {
      throw new TariProviderError('Refusing to sign: this account does not advertise stealthWithdraw with transaction requests, so it cannot move a Stealth-typed input into a contract.', 'REJECTED');
    }
    if (operationId === undefined || context.reviewFingerprint === undefined || account === undefined) {
      throw new TariProviderError('Refusing to sign: a Stealth withdrawal must be bound to a durable operation id and review fingerprint.', 'REJECTED');
    }
    assertStealthWithdrawOperation(operation);
    const remember = (state: 'AWAITING_APPROVAL' | 'SUBMITTED', transactionId?: string) =>
      rememberPendingRequest(this.pendingStorage, {
        operationId,
        requestId: this.requestIds.get(operationId) ?? '',
        reviewFingerprint: context.reviewFingerprint as string,
        operation: context.operation,
        approvedAccount: account,
        approvedNetwork: context.network,
        destination: context.poolOrDestination,
        createdAtUnixMs: Date.now(),
        state,
        ...(transactionId !== undefined ? { transactionId } : {}),
      });
    const outcome = await submitViaTransactionRequest(this.provider, operation, {
      onRequestId: (requestId) => {
        this.requestIds.set(operationId, requestId);
        remember('AWAITING_APPROVAL');
      },
      onSubmitted: (result) => remember('SUBMITTED', result.transactionId),
    });
    if ('pendingRequestId' in outcome) {
      throw awaitingApproval(`Operation ${operationId} is awaiting wallet approval of request ${outcome.pendingRequestId}. It was not submitted.`);
    }
    return outcome;
  }

  async preflight(reviewedRequest: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; reason?: string }> {
    if (reviewedStealthOperation(reviewedRequest) !== undefined) {
      // The follow-ups alone are not a transaction (their input bucket is created by the
      // wallet's StealthTransfer), so a dry run of them would be meaningless.
      return { ok: false, reason: 'A Stealth withdrawal is simulated by the wallet itself, not by a dApp dry run.' };
    }
    // `dryRun: true` never prompts and spends nothing, per the published
    // contract. This is a NON-AUTHORITATIVE check that the reviewed instructions
    // would be accepted; the AMM quote remains protocol math and is never
    // replaced by a wallet simulation.
    return dryRunTransaction(this.provider, { instructions: requireReviewedInstructions(reviewedRequest) });
  }

  bindRequestId(operationId: string, requestId: string): void {
    this.requestIds.set(operationId, requestId);
  }

  /** The persisted wallet request id for an operation, if one was issued. */
  requestIdFor(operationId: string): string | undefined {
    return this.requestIds.get(operationId);
  }

  /** Seed the durable ledger. Set once by `createWalletService`; injectable for tests. */
  setPendingRequestStorage(storage: PendingRequestStorage | undefined): void {
    this.pendingStorage = storage;
  }

  pendingRequests(): readonly PendingWalletRequest[] {
    return listPendingRequests(this.pendingStorage);
  }

  blockingPendingRequest(): PendingWalletRequest | undefined {
    const account = this.session?.account?.address;
    const network = this.session?.network?.name ?? this.allowedNetworkId;
    return blockingPendingRequest(listPendingRequests(this.pendingStorage), account, network);
  }

  forgetPendingRequest(operationId: string): void {
    this.requestIds.delete(operationId);
    forgetPendingRequest(this.pendingStorage, operationId);
  }

  /**
   * Resume, or explain why not.
   *
   * The order of the two checks is the security property:
   *
   *   1. `resumeBlockReason` compares the PERSISTED account/network/fingerprint
   *      against the LIVE session. Every mismatch refuses. Note the direction:
   *      storage supplies only the left-hand side, so a tampered ledger can cause a
   *      refusal but can never cause a submission.
   *   2. Only then is the wallet asked what happened to the request. The wallet's
   *      answer — never the ledger's `state` field — decides what happens next.
   *
   * `AWAITING_APPROVAL` comes back as a value, not a throw: the human still has not
   * answered, nothing was broadcast, and the entry stays in the ledger for later.
   * `UNKNOWN` is likewise never treated as success.
   */
  async resumePendingRequest(
    record: PendingWalletRequest,
    live: ResumeBinding,
  ): Promise<{ submitted: true; transactionId: string } | { submitted: false; state: 'AWAITING_APPROVAL' | 'REJECTED' | 'FAILED' | 'UNKNOWN'; detail?: string }> {
    const refusal: ResumeRefusal | undefined = resumeBlockReason(record, live);
    if (refusal !== undefined && refusal !== 'NOT_BLOCKING') {
      throw new TariProviderError(describeResumeRefusal(refusal), refusal === 'NETWORK_CHANGED' ? 'WRONG_NETWORK' : 'ACCOUNT_CHANGED');
    }
    this.provider = getTariProvider();
    try {
      const outcome = await resumeTransactionRequest(this.provider, record.requestId, {
        onRequestId: () => undefined,
        onSubmitted: () => undefined,
      });
      if ('pendingRequestId' in outcome) {
        return { submitted: false, state: 'AWAITING_APPROVAL' };
      }
      // Remember which id produced which transaction, so a reload can still
      // reconcile this operation even after the ledger entry is retired.
      this.requestIds.set(record.operationId, record.requestId);
      return { submitted: true, transactionId: outcome.transactionId };
    } catch (error) {
      const code = error instanceof TariProviderError ? error.code : 'UNKNOWN';
      if (code === 'REJECTED') {
        this.forgetPendingRequest(record.operationId);
        return { submitted: false, state: 'REJECTED', detail: (error as Error).message };
      }
      if (code === 'INTERNAL') {
        this.forgetPendingRequest(record.operationId);
        return { submitted: false, state: 'FAILED', detail: (error as Error).message };
      }
      // TIMEOUT, MALFORMED_REPLY, UNKNOWN, and anything else: the request's fate is
      // genuinely unknown. It is reported as UNKNOWN and KEPT in the ledger, because
      // the request may well be approvable later and must not be treated as settled.
      return { submitted: false, state: 'UNKNOWN', detail: (error as Error).message };
    }
  }

  async signAndSubmit(preview: TransactionPreview): Promise<TransactionResult> {
    // The preview-derived path is retained only for the adapter seam. The
    // instructions come from the preview's own args, which the resolvers
    // populate from the intent, and the review path above is what every
    // financial operation uses.
    const instructions = Array.isArray(preview.args) ? preview.args : [];
    if (instructions.length === 0) {
      throw new TariProviderError('Refusing to sign: no instructions were supplied.', 'REJECTED');
    }
    const result = await this.submitExact(instructions, {
      operation: 'ADAPTER_SEAM',
      network: this.session?.network?.name ?? this.allowedNetworkId,
      poolOrDestination: preview.componentAddress ?? 'UNSPECIFIED',
    });
    return { transactionId: result.transactionId, epoch: result.epoch === undefined ? 0 : Number(result.epoch), status: 'pending' };
  }

  async getTransactionStatus(txId: string): Promise<{ status: string; epoch?: number; error?: string }> {
    const view = await fetchTransactionResult(this.provider, txId);
    const mapped = mapTransactionStatus(view);
    return { status: mapped, epoch: view.epoch === undefined ? undefined : Number(view.epoch), error: view.error };
  }

  walletCapabilities(): TariWalletCapabilities | undefined {
    return this.capabilities;
  }

  legCapabilities(): WalletLegCapabilities | undefined {
    return mapLegCapabilities(this.capabilities);
  }

  /**
   * The connected account's bech32m wallet address, for addressing a
   * private/stealth output. Gated on the published `capabilities.walletAddress`.
   *
   * It is NOT used anywhere in the public AMM / NFT path, and must never be
   * substituted for the account component address there: the reference is
   * explicit that passing an `otl_…` where a `SubstateId` belongs fails deep in
   * deserialization without naming the field.
   */
  async walletAddress(): Promise<string> {
    if (this.capabilities !== undefined && this.capabilities.walletAddress === false) {
      throw new TariProviderError('This account does not expose a wallet address.', 'UNSUPPORTED_METHOD');
    }
    return fetchWalletAddress(this.provider);
  }

  substateReader(purpose: 'EXECUTION' | 'DISPLAY' = 'EXECUTION'): AuthoritativeSubstateReader {
    const provider = this.provider;
    return {
      async readComponent(address: string) {
        const view = await readSubstate(provider, address);
        if (view === undefined) return undefined;
        return {
          address: view.address,
          templateName: view.templateName,
          substateVersion: view.substateVersion,
          producingTxHash: view.producingTxHash,
          epoch: view.epoch,
          fields: view.fields,
        };
      },
      async readResource(address: string) {
        const view = await readSubstate(provider, address);
        if (view === undefined) return undefined;
        return { address: view.address, templateName: view.templateName, epoch: view.epoch, fields: view.fields };
      },
      // RAW read for the authoritative Pool decoder (reserves live in vault substates).
      async readRaw(address: string) {
        return readRawSubstate(provider, address, undefined, { purpose });
      },
    };
  }

  async createdComponents(transactionId: string, templateHex: string): Promise<string[] | undefined> {
    return fetchCreatedComponents(this.provider, transactionId, templateHex);
  }

  readbackProvider(): OotleReadbackProvider {
    // `WALLET_PROVIDER` is an authoritative read source in the protocol-client.
    // An indexer is never substituted here.
    return createOotleReadbackProvider(this.substateReader(), 'WALLET_PROVIDER');
  }

  /**
   * Authoritative Pool state via the wallet's `tari_getSubstate`.
   *
   * The published Pool template stores reserves in VAULT substates and total LP
   * supply in the LP RESOURCE substate (not as flat component fields), so this uses
   * the multi-substate `decodePoolState` decoder over a RAW substate reader. It reads
   * the resource pair from the component body, so it never calls the DenyAll
   * `get_a_resource`/`get_b_resource` methods (which an ownerless v2 pool refuses).
   */
  async readPoolState(poolComponent: string): Promise<PoolState> {
    const provider = this.provider;
    return decodePoolState({ read: (address) => readRawSubstate(provider, address) }, poolComponent);
  }

  on(listener: WalletEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  providerObject(): object {
    return this.provider;
  }

  /**
   * Re-derive the live identity from the page RIGHT NOW.
   *
   * Called immediately before every financial authorization. Nothing here may
   * come from the connect-time snapshot:
   *
   *  - the provider object is re-resolved from `window`, so a page script that
   *    replaced `window.tari` is caught by reference comparison. Returning the
   *    cached `this.provider` would make a replaced provider compare EQUAL to
   *    the pinned review and defeat the check entirely;
   *  - capabilities are re-fetched, so a provider that downgrades its
   *    advertisement after the handshake is caught;
   *  - network and account are read from the current provider.
   *
   * A provider that has been removed or that stops answering is a failure, not
   * an empty identity: it must never authorize anything.
   */
  async liveIdentity(sessionNonce: string): Promise<LiveIdentityInput> {
    // `getTariProvider` throws when the provider is absent or malformed. A
    // provider that has gone away is a failure, and it must never reach an
    // authorization path — so the throw is the correct outcome, not a fallback.
    const provider = getTariProvider();

    // Lifecycle-aware replacement check. A provider appearing when nothing was
    // pinned yet is the documented INITIALISATION case (the extension injects at
    // `document_start` and the connector on script load, both after this app's
    // module has been evaluated), and inside Tari Universe the connector
    // deliberately claims `window.tari` for the embedding wallet. Only a change
    // from an ALREADY-PINNED object is a replacement.
    const transition = classifyProviderTransition(this.pinnedProvider, currentProviderObject());
    if (transition === 'REPLACED') {
      throw new TariProviderError('The injected Tari provider object was replaced after this review was created. Nothing was signed.', 'ACCOUNT_CHANGED');
    }
    if (transition === 'REMOVED') {
      throw new TariProviderError('The Tari provider disappeared after this review was created. Nothing was signed.', 'ACCOUNT_CHANGED');
    }

    const network = await fetchNetwork(provider);
    const guard = checkNetwork(network.network);
    if (!guard.ok) {
      throw new TariProviderError(guard.reason ?? `Network "${network.network}" is not allowed.`, 'WRONG_NETWORK');
    }
    const [accounts, capabilities] = await Promise.all([requestAccounts(provider), fetchCapabilities(provider)]);
    const account = accounts[0];
    if (account === undefined) {
      throw new TariProviderError('The wallet reported no account, so this review cannot be authorized.', 'MALFORMED_REPLY');
    }
    // The account bound to the review is the account COMPONENT address. A wallet
    // address in this position would produce a review bound to the wrong domain.
    requireAccountComponent(account.componentAddress, 'accounts[0].componentAddress');
    return {
      // Deliberately the CURRENT object, not the connect-time reference.
      provider,
      providerNetwork: network.network,
      account: account.componentAddress,
      // The published capability advertisement, captured live. A capability the
      // provider withdraws after the handshake invalidates the review, because
      // the fingerprint is taken over exactly these keys.
      capabilities: capabilities === undefined ? undefined : ({ ...capabilities } as Readonly<Record<string, boolean>>),
      nonce: sessionNonce,
    };
  }
}

/**
 * The exact reviewed instruction list.
 *
 * `buildWalletRequest` puts the official `instructions` array on the request.
 * Nothing else is ever handed to a signer: the `transaction`/`display` members
 * beside it are this app's review record and are not contract parameters, so
 * sending them would be transmitting undocumented fields.
 */
/** The frozen reviewed Stealth operation, when the review produced one. */
function reviewedStealthOperation(reviewedRequest: Readonly<Record<string, unknown>>): TariWithdrawStealthAndExecuteOperation | undefined {
  const operation = (reviewedRequest as { operation?: unknown }).operation;
  if (operation === undefined) return undefined;
  if (typeof operation !== 'object' || operation === null || (operation as { kind?: unknown }).kind !== 'withdrawStealthAndExecute') {
    throw new TariProviderError('Refusing to sign: the reviewed request carries an operation of an unsupported kind.', 'REJECTED');
  }
  if (!Object.isFrozen(operation)) throw new TariProviderError('Refusing to sign: the reviewed Stealth operation is not frozen.', 'REJECTED');
  return operation as TariWithdrawStealthAndExecuteOperation;
}

function requireReviewedInstructions(reviewedRequest: Readonly<Record<string, unknown>>): readonly unknown[] {
  if (reviewedRequest === undefined || reviewedRequest === null || typeof reviewedRequest !== 'object') {
    throw new TariProviderError('Refusing to sign: no reviewed transaction request was supplied.', 'REJECTED');
  }
  const instructions = (reviewedRequest as { instructions?: unknown }).instructions;
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new TariProviderError('Refusing to sign: the reviewed request carries no instructions to sign.', 'REJECTED');
  }
  if (!Object.isFrozen(reviewedRequest)) {
    throw new TariProviderError('Refusing to sign: the reviewed request is not frozen and cannot be trusted at signing time.', 'REJECTED');
  }
  return instructions as readonly unknown[];
}

export interface WalletService {
  bridge(): WalletBridge | undefined;
  allowedNetworkId: string;
}

/**
 * Build the wallet service for the current page.
 *
 * The service is LAZY rather than eager about the provider, because the
 * published lifecycle makes `window.tari` appear after page code has already
 * run: the extension injects at `document_start` and the connector on script
 * load, and both dispatch `tari#initialized`. Deciding once, at module
 * evaluation, whether a provider existed made a documented integration look
 * broken for anyone whose wallet initialised later.
 *
 * `bridge()` resolves the provider at call time and returns undefined only while
 * no provider object is present. A provider that is present but CANNOT answer is
 * a different state, established by `probeAvailability` and surfaced as such —
 * `Boolean(window.tari)` is never treated as "a usable wallet is available".
 */
export function createWalletService(allowedNetworkId: string, pendingStorage?: PendingRequestStorage): WalletService {
  let bridge: WalletBridge | undefined;
  let bridgedTo: object | undefined;
  const resolve = (): WalletBridge | undefined => {
    if (!isTariInjected()) return undefined;
    const provider = currentProviderObject();
    // Rebuild only when the provider OBJECT changed, so a stable provider keeps
    // its session and a replaced one cannot inherit it.
    if (bridge !== undefined && provider === bridgedTo) return bridge;
    try {
      bridge = new TariBridgeWalletAdapter(allowedNetworkId);
      (bridge as { pinnedProvider?: object }).pinnedProvider = provider;
      bridge.setPendingRequestStorage(pendingStorage);
      bridgedTo = provider;
      return bridge;
    } catch {
      bridge = undefined;
      bridgedTo = undefined;
      return undefined;
    }
  };
  return { bridge: resolve, allowedNetworkId };
}


