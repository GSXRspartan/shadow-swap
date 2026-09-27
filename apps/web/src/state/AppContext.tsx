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
import { createPoolDiscovery, type PoolDescriptor, type PoolDiscoveryResult } from '../services/pools.js';
import { MarketDataService, type MarketDataBundle } from '../services/marketData.js';
import type { WalletLegCapabilities } from '../lib/capabilities.js';
import { presentHealth, aggregateHealth, type HealthPresentation } from '../lib/health.js';
import { TariProviderError } from '../services/tariWindow.js';
import { UNAVAILABLE } from '../lib/format.js';

export type WalletStatus = 'UNAVAILABLE' | 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR';

export interface WalletState {
  status: WalletStatus;
  session?: WalletSession;
  account?: string;
  network?: NetworkInfo;
  networkId?: string;
  capabilities?: WalletLegCapabilities;
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
    context: { assets: string[]; operation: string; network: string; poolOrDestination: string; privacyDisclosure: string },
    reviewedRequest: Readonly<Record<string, unknown>>,
  ): Promise<import('@tari-ootle/wallet-adapter').TransactionResult>;
  getTransactionStatus(txId: string): Promise<{ status: string; epoch?: number; error?: string }>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

const INITIAL_WALLET: WalletState = { status: 'DISCONNECTED', balances: [], identityEpoch: 0 };

const UNAVAILABLE_MARKET: MarketDataState = {
  loading: true,
  discovery: { pools: [], source: 'pending', unavailableReason: 'Pool discovery has not run yet.' },
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
    const bridge = walletService.bridge();
    if (bridge === undefined) {
      return { ...INITIAL_WALLET, status: 'UNAVAILABLE', error: 'No Tari wallet provider is injected in this page. Open the app from the wallet dApp frame, or install a provider that exposes tari_getCapabilities.' };
    }
    return INITIAL_WALLET;
  });

  const [market, setMarket] = useState<MarketDataState>(() =>
    providedPools === undefined
      ? UNAVAILABLE_MARKET
      : {
          loading: false,
          discovery: { pools: providedPools, source: 'injected' },
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

  useEffect(() => {
    const bridge = walletService.bridge();
    bridgeRef.current = bridge;
    if (bridge === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const supported = await bridge.isSupported();
        if (cancelled) return;
        if (!supported) {
          setWallet((previous) => ({ ...previous, status: 'UNAVAILABLE', error: 'The injected provider did not answer the capability handshake, so it is not being used.' }));
        }
        const network = await bridge.getNetwork().catch(() => undefined);
        if (cancelled) return;
        setWallet((previous) => ({ ...previous, network, networkId: network?.name }));
      } catch (error) {
        if (!cancelled) setWallet((previous) => ({ ...previous, status: 'UNAVAILABLE', error: (error as Error).message }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletService]);

  const connect = useCallback(async () => {
    const bridge = bridgeRef.current ?? walletService.bridge();
    if (bridge === undefined) {
      setWallet((previous) => ({ ...previous, status: 'UNAVAILABLE', error: 'No Tari wallet provider is injected in this page.' }));
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
        balances,
        identityEpoch: 0,
      });
    } catch (error) {
      const message = error instanceof TariProviderError ? error.message : (error as Error).message;
      setWallet((previous) => ({ ...previous, status: 'ERROR', error: message, session: undefined, account: undefined, balances: [] }));
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

  // ---- pool discovery + health -------------------------------------------

  const refreshPools = useCallback(async () => {
    setMarket((previous) => ({ ...previous, loading: true }));
    if (providedPools !== undefined) {
      setMarket({
        loading: false,
        discovery: { pools: providedPools, source: 'injected' },
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
        source: discovery.name,
        unavailableReason: `Pool discovery failed unexpectedly: ${(error as Error).message}`,
      };
    }
    const health =
      result.unavailableReason !== undefined
        ? presentHealth({ status: 'UNAVAILABLE', source: result.source, reason: result.unavailableReason })
        : presentHealth({ status: result.pools.length > 0 ? 'SYNCED' : 'UNAVAILABLE', source: result.source, reason: result.pools.length > 0 ? undefined : 'Discovery returned no pools.' });
    setMarket({ loading: false, discovery: result, pools: result.pools, health });
  }, [discovery, providedPools]);

  useEffect(() => {
    void refreshPools();
  }, [refreshPools]);

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
        // provider signs is the one the user approved.
        bridge.signAndSubmitReviewed(
          {
            ...preview,
            networkName: context.network,
            privacyDisclosure: context.privacyDisclosure,
          },
          reviewedRequest,
          context,
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

