/**
 * Application state.
 *
 * Three deliberately separate stores rather than one monolith:
 *   - `WalletState`      wallet/provider identity, network, capabilities
 *   - `MarketDataState`  pool discovery, per-pool market data, health
 *   - local React state  everything else (form fields, dialogs, tabs)
 *
 * Protocol state is never mirrored. The context holds only what the UI must
 * render and the service handles that produced it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Balance, NetworkInfo, WalletSession } from '@tari-ootle/wallet-adapter';
import type { OotleReadbackProvider } from '@tari-ootle/protocol-client';
import { resolveConfig, realSubmitGate, type AppConfig, type RealSubmitGate } from '../services/config.js';
import { readBrowserEnv } from '../services/envSource.js';
import { createWalletService, type WalletBridge } from '../services/walletService.js';
import { captureIdentity, type ExecutionIdentity, type ProviderCapabilities } from '../lib/executionIdentity.js';
import { createPoolDiscovery, descriptorFromAuthoritativeRead, type PoolDescriptor, type PoolDiscoveryResult } from '../services/pools.js';
import { seededTemplateFor } from '../services/poolRegistry.js';
import { createOotleReadbackProvider } from '@tari-ootle/protocol-client';
import { MarketDataService, type MarketDataBundle } from '../services/marketData.js';
import type { WalletLegCapabilities } from '../lib/capabilities.js';
import { presentHealth, aggregateHealth, type HealthPresentation } from '../lib/health.js';
import { TariProviderError, isTariInjected, onProviderInitialized, probeAvailability } from '../services/tariWindow.js';
import type { TariWalletCapabilities } from '../services/tariDappTypes.js';
import { UNAVAILABLE } from '../lib/format.js';

export type WalletStatus =
  /** No `window.tari` object at all: no wallet is installed for this origin. */
  | 'UNAVAILABLE'
  /**
   * A provider object exists but cannot service requests here — for example the
   * Tari Universe connector loaded on a top-level page with no wallet frame, and
   * no extension either. This is a DISTINCT state from `UNAVAILABLE`, because the
   * fix is different: the user needs to open the app from a wallet, not install
   * one.
   */
  | 'PROVIDER_UNAVAILABLE'
  /** A provider is present and answered; no account is connected yet. */
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ERROR';

export interface WalletState {
  status: WalletStatus;
  session?: WalletSession;
  account?: string;
  network?: NetworkInfo;
  networkId?: string;
  capabilities?: WalletLegCapabilities;
  /** The published `tari_getCapabilities` advertisement, for feature gating. */
  walletCapabilities?: TariWalletCapabilities;
  balances: Balance[];
  error?: string;
  /** Bumped whenever the provider reports an identity change. */
  identityEpoch: number;
}

export interface MarketDataState {
  loading: boolean;
  discovery: PoolDiscoveryResult;
  pools: PoolDescriptor[];
  health: HealthPresentation;
}

interface AppContextValue {
  config: AppConfig;
  realSubmit: RealSubmitGate;
  wallet: WalletState;
  market: MarketDataState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  refreshPools(): Promise<void>;
  bundleFor(poolComponent: string, pool: PoolDescriptor): MarketDataBundle | undefined;
  balanceOf(resourceAddress: string): string | undefined;
  /** Authoritative pool readback from the wallet. Undefined until connected. */
  readback(): OotleReadbackProvider | undefined;
  /** The wallet bridge, for identity pinning. Undefined until injected. */
  walletBridge(): WalletBridge | undefined;
  /**
   * The execution identity for the current session, or undefined when no
   * verified identity exists. Callers must fail closed when it is undefined.
   */
  liveExecutionIdentity(): ExecutionIdentity | undefined;
  /** Wallets seam for the execution service. Undefined until connected. */
  executionWallets(): ExecutionWalletsLike | undefined;
}

export interface ExecutionWalletsLike {
  preview(preview: Partial<import('@tari-ootle/wallet-adapter').TransactionPreview>): Promise<import('@tari-ootle/wallet-adapter').TransactionPreview>;
  signAndSubmit(
    preview: import('@tari-ootle/wallet-adapter').TransactionPreview,
    context: { assets: string[]; operation: string; network: string; poolOrDestination: string; privacyDisclosure: string; operationId?: string },
    reviewedRequest: Readonly<Record<string, unknown>>,
  ): Promise<import('@tari-ootle/wallet-adapter').TransactionResult>;
  getTransactionStatus(txId: string): Promise<{ status: string; epoch?: number; error?: string }>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

const INITIAL_WALLET: WalletState = { status: 'DISCONNECTED', balances: [], identityEpoch: 0 };

const UNAVAILABLE_MARKET: MarketDataState = {
  loading: true,
  discovery: {
    pools: [],
    candidates: [],
    publishedTemplates: [],
    state: 'INDEXER_UNAVAILABLE',
    source: 'pending',
    unavailableReason: 'Pool discovery has not run yet.',
  },
  pools: [],
  health: presentHealth({ status: 'UNAVAILABLE', source: 'pending', reason: 'Pool discovery has not run yet.' }),
};

export function AppProvider({
  children,
  config: providedConfig,
  pools: providedPools,
}: {
  children: ReactNode;
  config?: AppConfig;
  /**
   * Pre-seeded pool list. Used by the isolated development fixture path and by
   * the render tests; when absent, discovery is the only source.
   */
  pools?: PoolDescriptor[];
}) {
  const config = useMemo(() => providedConfig ?? resolveConfig(readBrowserEnv()), [providedConfig]);
  const realSubmit = useMemo<RealSubmitGate>(() => realSubmitGate(readBrowserEnv(), config.network), [config.network]);

  const walletService = useMemo(() => createWalletService(config.network), [config.network]);
  const bridgeRef = useRef<WalletBridge | undefined>(undefined);
  /** The identity bound to the current session. Re-issued on any change. */
  const identityRef = useRef<ExecutionIdentity | null>(null);

  const [wallet, setWallet] = useState<WalletState>(() => {
    // Deliberately NOT `Boolean(window.tari)`. A truthy `window.tari` is neither
    // a usable wallet nor evidence of one: the Tari Universe connector is
    // documented as safe to include unconditionally, and on a top-level page with
    // no wallet frame it still publishes a provider object whose every request
    // rejects. Availability is established below by an actual call, and the two
    // failure modes get different states.
    if (isTariInjected()) return INITIAL_WALLET;
    return { ...INITIAL_WALLET, status: 'UNAVAILABLE', error: 'No Tari wallet provider is present on this page.' };
  });

  const [market, setMarket] = useState<MarketDataState>(() =>
    providedPools === undefined
      ? UNAVAILABLE_MARKET
      : {
          loading: false,
          discovery: { pools: providedPools, candidates: [], publishedTemplates: [], state: 'PROTOCOL_AVAILABLE', source: 'injected' },
          pools: providedPools,
          health: presentHealth({ status: 'SYNCED', source: 'injected', reason: 'Pool list supplied by the host application.' }),
        },
  );

  const marketData = useMemo(
    () =>
      new MarketDataService({
        pools: [],
        // A pool-authoritative readback is only available once a wallet is
        // connected. Until then the indexer refuses to store any trade, which is
        // the correct behaviour: an unverified chart is worse than no chart.
        readback: undefined,
        readbackIsAuthoritative: false,
      }),
    [],
  );

  const discovery = useMemo(() => createPoolDiscovery(config, undefined), [config]);

  // ---- wallet -------------------------------------------------------------

  /**
   * Resolve the wallet, and keep resolving it.
   *
   * The published lifecycle makes `window.tari` appear AFTER this app's module
   * has been evaluated: the Sapient extension injects at `document_start` and the
   * Tari Universe connector on script load, and both dispatch `tari#initialized`.
   * Deciding once, at mount, whether a provider existed made a documented
   * integration look permanently broken for anyone whose wallet initialised
   * later, so the listener re-runs the same resolution.
   *
   * The event is only ever a HINT to re-read. It is not an authority: a hostile
   * page script can dispatch any event it likes, so identity is always
   * re-established by comparing the live `window.tari` OBJECT against the one
   * pinned at connect, which is what `verifyIdentity` does at authorization time.
   */
  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      if (cancelled) return;
      const bridge = walletService.bridge();
      bridgeRef.current = bridge;
      if (bridge === undefined) {
        setWallet((previous) => ({ ...previous, status: 'UNAVAILABLE', error: 'No Tari wallet provider is present on this page.' }));
        return;
      }
      try {
        // Mandatory capability handshake, and a real availability probe. The
        // handshake asks the account what it can do; the probe asks whether the
        // provider can answer at all. Neither asks which wallet is present.
        const availability = await probeAvailability();
        if (cancelled) return;
        if (!availability.available) {
          setWallet((previous) => ({
            ...previous,
            status: availability.reason === 'absent' ? 'UNAVAILABLE' : 'PROVIDER_UNAVAILABLE',
            error:
              availability.reason === 'absent'
                ? 'No Tari wallet provider is present on this page.'
                : 'A Tari provider is present but cannot answer here. Open this app from inside a Tari wallet, or install a browser wallet extension.',
          }));
          return;
        }
        const supported = await bridge.isSupported();
        if (cancelled) return;
        if (!supported) {
          setWallet((previous) => ({ ...previous, status: 'PROVIDER_UNAVAILABLE', error: 'The Tari provider did not answer the capability handshake, so it is not being used.' }));
          return;
        }
        // `tari_getNetwork` is documented as answerable WITHOUT a connection, so
        // the network is validated here, before the user is ever prompted to
        // connect. That is what makes a wrong-network refusal distinct from an
        // absent wallet and from an unconnected one.
        const network = await bridge.getNetwork().catch(() => undefined);
        if (cancelled) return;
        setWallet((previous) => ({
          ...previous,
          status: previous.status === 'UNAVAILABLE' || previous.status === 'PROVIDER_UNAVAILABLE' ? 'DISCONNECTED' : previous.status,
          network,
          networkId: network?.name,
        }));
      } catch (error) {
        if (!cancelled) {
          setWallet((previous) => ({ ...previous, status: 'PROVIDER_UNAVAILABLE', error: error instanceof TariProviderError ? error.message : (error as Error).message }));
        }
      }
    };

    void resolve();
    const detach = onProviderInitialized(globalThis, () => {
      void resolve();
    });
    return () => {
      cancelled = true;
      detach();
    };
  }, [walletService]);

  const connect = useCallback(async () => {
    const bridge = bridgeRef.current ?? walletService.bridge();
    if (bridge === undefined) {
      setWallet((previous) => ({ ...previous, status: 'UNAVAILABLE', error: 'No Tari wallet provider is present on this page.' }));
      return;
    }
    setWallet((previous) => ({ ...previous, status: 'CONNECTING', error: undefined }));
    try {
      const session = await bridge.connect();
      const [balances, network] = await Promise.all([bridge.getBalances(), bridge.getNetwork()]);
      setWallet({
        status: 'CONNECTED',
        session,
        account: session.account.address,
        network,
        networkId: network.name,
        capabilities: bridge.legCapabilities(),
        walletCapabilities: bridge.walletCapabilities(),
        balances,
        identityEpoch: 0,
      });
    } catch (error) {
      const message = error instanceof TariProviderError ? error.message : (error as Error).message;
      const status: WalletStatus = error instanceof TariProviderError && error.code === 'REJECTED' ? 'DISCONNECTED' : 'ERROR';
      setWallet((previous) => ({ ...previous, status, error: message, session: undefined, account: undefined, balances: [] }));
    }
  }, [walletService]);

  const disconnect = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (bridge !== undefined) {
      try {
        await bridge.disconnect();
      } catch {
        // Already gone.
      }
    }
    setWallet({ ...INITIAL_WALLET, status: 'DISCONNECTED', identityEpoch: 1 });
  }, []);

  /**
   * React to the wallet's own lifecycle events.
   *
   * `accountsChanged` invalidates every account-bound thing: the identity
   * (cleared below, so any review issued for the previous account is refused at
   * authorization), the account, the cached balances, and the capability
   * advertisement. Capabilities are re-read rather than remembered because a
   * private view-access grant also drops when the account changes, and a view
   * capability that survives a switch is a capability this app would wrongly
   * assume.
   *
   * An approval that is already in progress is NOT rebound to the new account.
   * The identity reset is what makes that fail closed: the outstanding operation
   * cannot be re-authorized under the new account and is reconciled instead.
   */
  useEffect(() => {
    const bridge = walletService.bridge();
    if (bridge === undefined) return undefined;
    return bridge.on((event) => {
      if (event.kind === 'accountsChanged' || event.kind === 'networkChanged') {
        setWallet((previous) =>
          previous.status === 'CONNECTED'
            ? { ...previous, status: 'DISCONNECTED', session: undefined, account: undefined, balances: [], capabilities: undefined, walletCapabilities: undefined, networkId: event.kind === 'networkChanged' ? event.network : previous.networkId, error: 'The wallet changed account or network. Review again before submitting.' }
            : previous,
        );
        return;
      }
      if (event.kind === 'disconnected') {
        setWallet((previous) => ({ ...INITIAL_WALLET, status: 'DISCONNECTED', identityEpoch: previous.identityEpoch + 1 }));
      }
    });
  }, [walletService]);

  // ---- pool discovery + health -------------------------------------------

  const refreshPools = useCallback(async () => {
    setMarket((previous) => ({ ...previous, loading: true }));
    if (providedPools !== undefined) {
      setMarket({
        loading: false,
        discovery: { pools: providedPools, candidates: [], publishedTemplates: [], state: 'PROTOCOL_AVAILABLE', source: 'injected' },
        pools: providedPools,
        health: presentHealth({ status: 'SYNCED', source: 'injected', reason: 'Pool list supplied by the host application.' }),
      });
      return;
    }
    let result: PoolDiscoveryResult;
    try {
      result = await discovery.discover();
    } catch (error) {
      // A discovery source that throws must never leave the UI in its loading
      // state: an honest "unavailable" is always better than an endless spinner.
      result = {
        pools: [],
        candidates: [],
        publishedTemplates: [],
        state: 'INDEXER_UNAVAILABLE',
        source: discovery.name,
        unavailableReason: `Pool discovery failed unexpectedly: ${(error as Error).message}`,
      };
    }
    // The deployment state, not `pools.length`, drives the badge. A network that
    // is perfectly reachable but has no templates published yet is NOT an
    // outage, and a network we cannot read is NOT an empty market. Collapsing
    // either pair is the dishonest-empty-state bug this app exists to avoid.
    const health =
      result.state === 'INDEXER_UNAVAILABLE' || result.state === 'WRONG_NETWORK'
        ? presentHealth({ status: 'UNAVAILABLE', source: result.source, reason: result.unavailableReason ?? 'The indexer could not be read.' })
        : result.state === 'PROTOCOL_AVAILABLE'
          ? presentHealth({ status: 'SYNCED', source: result.source, reason: undefined })
          : presentHealth({ status: 'UNAVAILABLE', source: result.source, reason: result.detail ?? 'No pools are published for this deployment.' });
    setMarket({ loading: false, discovery: result, pools: result.pools, health });
  }, [discovery, providedPools]);

  useEffect(() => {
    void refreshPools();
  }, [refreshPools]);

  /**
   * Turn discovered pool COMPONENTS into describable pools.
   *
   * This is the join between the two halves of the architecture, and it runs
   * only over the wallet-backed authoritative read:
   *
   *   indexer  -> WHICH pool components exist   (raw CBOR state, no fields)
   *   wallet   -> WHAT each pool holds           (decoded `fields`, template-checked)
   *
   * It re-runs when the wallet connects, because that is the first moment an
   * authoritative read exists. Before then `pools` stays EMPTY while
   * `candidates` still lists what was found: showing an undecodable component
   * as a pool with no numbers would be a pool the user cannot act on.
   */
  useEffect(() => {
    let cancelled = false;
    const candidates = market.discovery.candidates;
    const bridge = bridgeRef.current;
    if (candidates.length === 0 || bridge === undefined || wallet.status !== 'CONNECTED') {
      // No wallet, so no authoritative read: nothing may be described.
      if (candidates.length === 0) setMarket((previous) => (previous.pools.length === 0 ? previous : { ...previous, pools: [] }));
      return undefined;
    }
    void (async () => {
      const decoded: PoolDescriptor[] = [];
      for (const candidate of candidates) {
        if (cancelled) return;
        try {
          // `WALLET_PROVIDER` is an authoritative source; an indexer read is
          // never substituted for it.
          const readback = createOotleReadbackProvider(bridge.substateReader(), 'WALLET_PROVIDER');
          // The read is PINNED to the template this component is supposed to be. A
          // protocol-verified seed wins when there is one; otherwise discovery's own
          // verified header claim is the pin. Either way the wallet's bytes must name
          // the same template discovery found, so a provider that serves a look-alike
          // component is refused rather than displayed.
          const template = seededTemplateFor(config.network, candidate.componentAddress) ?? candidate.templateAddress;
          const read = await readback.readPool(candidate.componentAddress, { templateAddress: template });
          if (read.status !== 'FOUND') continue;
          const state = read.value;
          const descriptor = descriptorFromAuthoritativeRead(
            {
              poolComponent: state.poolComponent,
              resourceA: state.resourceA,
              resourceB: state.resourceB,
              ...(state.feeBps === undefined ? {} : { feeBps: state.feeBps }),
            },
            wallet.balances,
          );
          if (descriptor !== undefined) decoded.push(descriptor);
        } catch {
          // A component whose authoritative read fails is simply not described.
          // It stays in `candidates`, where it is shown as an address and no
          // more, which is the truthful outcome.
        }
      }
      if (!cancelled) setMarket((previous) => ({ ...previous, pools: decoded }));
    })();
    return () => {
      cancelled = true;
    };
    // `wallet.balances` is a member of `wallet`; re-decoding on every balance
    // change is what lets a newly-seen resource gain its symbol and divisor.
  }, [market.discovery.candidates, wallet.status, wallet.balances]);

  const bundleFor = useCallback(
    (poolComponent: string, pool: PoolDescriptor): MarketDataBundle | undefined => {
      const bridge = bridgeRef.current;
      const connected = wallet.status === 'CONNECTED';
      if (bridge === undefined || !connected) return undefined;
      return marketData.bundleFor(poolComponent, pool);
    },
    [marketData, wallet.status],
  );

  const balanceOf = useCallback(
    (resourceAddress: string): string | undefined => wallet.balances.find((balance) => balance.resourceAddress === resourceAddress)?.amount,
    [wallet.balances],
  );

  const executionWallets = useCallback((): ExecutionWalletsLike | undefined => {
    const bridge = bridgeRef.current;
    if (bridge === undefined || wallet.status !== 'CONNECTED') return undefined;
    return {
      preview: (preview) => bridge.previewTransaction(preview),
      signAndSubmit: (preview, context, reviewedRequest) =>
        // The reviewed request is forwarded, not re-derived, so the payload the
        // provider signs is the one the user approved. `operationId` is threaded
        // through so the wallet's durable transaction-request id can be bound to
        // the durable operation record before any further progress is assumed.
        bridge.signAndSubmitReviewed(
          {
            ...preview,
            networkName: context.network,
            privacyDisclosure: context.privacyDisclosure,
          },
          reviewedRequest,
          { ...context, operationId: context.operationId },
        ),
      getTransactionStatus: (txId) => bridge.getTransactionStatus(txId),
    };
  }, [wallet.status]);

  const readback = useCallback((): OotleReadbackProvider | undefined => {
    const bridge = bridgeRef.current;
    if (bridge === undefined || wallet.status !== 'CONNECTED') return undefined;
    // `WALLET_PROVIDER`-backed. An indexer read is never substituted here.
    return bridge.readbackProvider();
  }, [wallet.status]);

  const walletBridge = useCallback((): WalletBridge | undefined => {
    const bridge = bridgeRef.current;
    if (bridge === undefined || wallet.status !== 'CONNECTED') return undefined;
    return bridge;
  }, [wallet.status]);

  /**
   * The execution identity, captured when a session is established.
   *
   * A new identity is issued on connect, on disconnect, and whenever the
   * network or account changes, which invalidates every review bound to the
   * previous one. `verifyIdentity` re-derives the live state and compares, so a
   * change the app did not observe is still caught at authorization time.
   */
  const liveExecutionIdentity = useCallback((): ExecutionIdentity | undefined => {
    const bridge = bridgeRef.current;
    if (bridge === undefined || wallet.status !== 'CONNECTED' || wallet.account === undefined || wallet.networkId === undefined) return undefined;
    if (identityRef.current === null) {
      identityRef.current = captureIdentity({
        provider: bridge.providerObject(),
        expectedNetwork: config.network,
        providerNetwork: wallet.networkId,
        account: wallet.account,
        capabilities: wallet.capabilities as ProviderCapabilities | undefined,
      });
    }
    return identityRef.current;
  }, [wallet.status, wallet.account, wallet.networkId, wallet.capabilities, config.network]);

  // Any identity change must invalidate outstanding reviews.
  useEffect(() => {
    identityRef.current = null;
  }, [wallet.account, wallet.networkId, wallet.status]);

  const value = useMemo<AppContextValue>(
    () => ({ config, realSubmit, wallet, market, connect, disconnect, refreshPools, bundleFor, balanceOf, readback, walletBridge, liveExecutionIdentity, executionWallets }),
    [config, realSubmit, wallet, market, connect, disconnect, refreshPools, bundleFor, balanceOf, readback, walletBridge, liveExecutionIdentity, executionWallets],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === undefined) throw new Error('useApp must be used inside <AppProvider>.');
  return value;
}

/** Aggregate health across every discovered pool. */
export function useAggregateHealth(): HealthPresentation {
  const { market } = useApp();
  return useMemo(() => aggregateHealth([market.health]), [market.health]);
}

export { UNAVAILABLE };

