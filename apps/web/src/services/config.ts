/**
 * Runtime configuration.
 *
 * Everything network- or provider-shaped is resolved here, once, from Vite env
 * vars with safe defaults. Two rules are enforced structurally:
 *
 *  1. Mainnet is CONFIGURABLE but not EXECUTABLE. `VITE_TARI_NETWORK=mainnet`
 *     resolves, so the app can know and display mainnet's identity, and
 *     `checkNetwork` still refuses every wallet connection and transaction on it
 *     until `MAINNET_EXECUTION_AUTHORIZED` is set in a reviewed commit. A build
 *     that could not be configured for mainnet at all could not be made ready
 *     for it either, which is why the gate moved rather than being removed.
 *  2. Local (127.0.0.1 / localhost) endpoints are only honoured in a
 *     development build. A production build that is pointed at localhost is a
 *     hard error, not a silent fallback.
 */

import {
  DEFAULT_NETWORK,
  FRONTEND_NETWORKS,
  checkNetwork,
  isExecutionNetwork,
  isKnownNetwork,
  localEndpointReason,
  looksLikeMainnet,
  normalizeNetworkId,
  type FrontendNetworkId,
} from '../lib/networks.js';
import type { EnvBag } from './envSource.js';

export type { EnvBag };

export interface AppConfig {
  network: FrontendNetworkId;
  indexerUrls: string[];
  /** Whether fixture-backed development data may be used. Never true in a production build. */
  fixturesEnabled: boolean;
  /** Whether the walletd reference provider may be offered. Never true in a production build. */
  devProvidersEnabled: boolean;
  walletdUrl?: string;
  /**
   * OPTIONAL operator-run NFT discovery service speaking the `{query, params}`
   * JSON-RPC-style protocol.
   *
   * Unset by default, and that is the correct default: the Ootle indexer serves no
   * such route, so pointing this at an indexer origin would make every marketplace
   * query 404. When it is unset, discovery reads the chain directly through
   * `OotleIndexerMarketplaceSource`. Set it only when a real service is deployed.
   */
  nftDiscoveryUrl?: string;
  /** Why a dev provider / fixture source is on, for the visible dev banner. */
  developmentReason?: string;
  /** Blocking problems that make the whole app unusable. */
  blocking: string[];
  /**
   * True when transactions may be built and signed on the configured network.
   *
   * Separate from `blocking` on purpose: a network can be perfectly well configured, readable and
   * displayable while execution on it is deliberately held. Collapsing the two would make "not
   * authorized yet" indistinguishable from "misconfigured".
   */
  executionEnabled: boolean;
  /** Why execution is disabled, when it is. Shown verbatim. */
  executionReason?: string;
}

function readString(env: EnvBag, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readBoolean(env: EnvBag, key: string): boolean {
  const value = env[key];
  return value === true || value === 'true' || value === '1';
}

/**
 * `env.DEV === true || env.MODE === 'development'`. Vite replaces these at build
 * time, so a plain `true` is impossible in a production bundle: fixtures and
 * development providers cannot be enabled by shipping a flag.
 */
export function isDevelopmentBuild(env: EnvBag): boolean {
  return env.DEV === true || env.MODE === 'development';
}

export function resolveConfig(env: EnvBag): AppConfig {
  const blocking: string[] = [];
  const development = isDevelopmentBuild(env);

  const requestedNetwork = readString(env, 'VITE_TARI_NETWORK') ?? DEFAULT_NETWORK;
  // A name that merely RESEMBLES mainnet is refused and does not fall back: resolving
  // "mainnet-2" to either the real mainnet or a testnet would both be wrong, in opposite and
  // equally expensive directions.
  if (looksLikeMainnet(requestedNetwork)) {
    blocking.push(
      `VITE_TARI_NETWORK="${requestedNetwork}" resembles mainnet without being it. This build refuses a name that close to a real network rather than guessing which was meant.`,
    );
  } else if (!isKnownNetwork(requestedNetwork.trim().toLowerCase())) {
    blocking.push(`VITE_TARI_NETWORK="${requestedNetwork}" is not a network this build knows (mainnet, esmeralda, localnet).`);
  }
  // An unrecognised value does NOT silently become the default network: it blocks above, and the
  // default here only keeps the rest of the configuration computable for the error screen.
  const recognised = normalizeNetworkId(requestedNetwork);
  const network: FrontendNetworkId = recognised ?? DEFAULT_NETWORK;

  // The execution gate is reported separately from `blocking`. A build configured for mainnet is
  // not broken — it is held, and the UI needs to say which.
  //
  // `recognised === undefined` must disable execution on its own. Falling back to the default
  // network for computability would otherwise make an unrecognised setting execute as esmeralda:
  // the configuration is blocked on screen while the gate quietly says yes, which is the worst
  // of both. The gate is therefore computed from the REQUESTED value, not the fallback.
  const guard = checkNetwork(network);
  const executionEnabled = recognised !== undefined && isExecutionNetwork(network) && guard.ok;
  const executionReason = executionEnabled
    ? undefined
    : recognised === undefined
      ? `VITE_TARI_NETWORK="${requestedNetwork}" is not a network this build knows, so nothing may be executed. No fallback network is used for execution.`
      : guard.reason ?? `Execution is not enabled on ${network}.`;

  // The per-network default origins come from the single network table, not from
  // a second copy here: a second copy is exactly how the configured indexer and
  // the CSP `connect-src` list drifted apart and left this app pointed at hosts
  // that no longer resolve.
  const defaultIndexers = FRONTEND_NETWORKS[network].indexerUrls;
  const configuredIndexer = readString(env, 'VITE_INDEXER_URL');
  const indexerUrls: string[] = [];
  for (const url of [configuredIndexer, ...defaultIndexers]) {
    if (url === undefined || indexerUrls.includes(url)) continue;
    const reason = localEndpointReason(url, development);
    if (reason !== undefined) {
      blocking.push(reason);
      continue;
    }
    indexerUrls.push(url);
  }

  const wantsDevProviders = readBoolean(env, 'VITE_ENABLE_DEV_PROVIDERS');
  const devProvidersEnabled = development && wantsDevProviders;
  if (wantsDevProviders && !development) {
    blocking.push('VITE_ENABLE_DEV_PROVIDERS was set but this is not a development build. Development providers are disabled.');
  }

  const walletdRaw = readString(env, 'VITE_WALLETD_URL');
  let walletdUrl: string | undefined;
  if (walletdRaw !== undefined) {
    const reason = localEndpointReason(walletdRaw, development);
    if (reason !== undefined) blocking.push(reason);
    else if (!devProvidersEnabled) blocking.push(`VITE_WALLETD_URL is set but development providers are not enabled. Ignored: ${walletdRaw}`);
    else walletdUrl = walletdRaw;
  }

  const nftDiscoveryRaw = readString(env, 'VITE_NFT_DISCOVERY_URL');
  let nftDiscoveryUrl: string | undefined;
  if (nftDiscoveryRaw !== undefined) {
    const reason = localEndpointReason(nftDiscoveryRaw, development);
    if (reason !== undefined) blocking.push(reason);
    else nftDiscoveryUrl = nftDiscoveryRaw;
  }

  const wantsFixtures = readBoolean(env, 'VITE_USE_FIXTURE_DATA');
  if (wantsFixtures && !development) {
    blocking.push('VITE_USE_FIXTURE_DATA was set but this is not a development build. Fixture data is disabled.');
  }
  const fixturesEnabled = development && wantsFixtures;

  const developmentReason =
    fixturesEnabled || devProvidersEnabled
      ? [
          fixturesEnabled ? 'fixture market data' : undefined,
          devProvidersEnabled ? 'development wallet providers' : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(' + ')
      : undefined;

  // A network with no endpoint is reported as a blocking problem for READS, which is the honest
  // state of Ootle mainnet: its identity is known and there is nothing to read from it.
  if (indexerUrls.length === 0) {
    blocking.push(
      FRONTEND_NETWORKS[network].indexerReason ??
        `No indexer endpoint is configured for ${FRONTEND_NETWORKS[network].displayName}, so nothing can be read from it.`,
    );
  }

  return {
    network,
    indexerUrls,
    fixturesEnabled,
    devProvidersEnabled,
    walletdUrl,
    nftDiscoveryUrl,
    developmentReason,
    blocking,
    executionEnabled,
    ...(executionReason === undefined ? {} : { executionReason }),
  };
}

/**
 * Real cross-chain submission is governed by the protocol-client's environment
 * gate, which is authoritative. The frontend only mirrors the gate for
 * display and never attempts to bypass it.
 */
export const REAL_CROSSCHAIN_SUBMIT_ENV = 'TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT';

export interface RealSubmitGate {
  enabled: boolean;
  reason: string;
}

export function realSubmitGate(env: EnvBag, network: FrontendNetworkId = DEFAULT_NETWORK): RealSubmitGate {
  // NOTE: the authoritative check lives in the protocol-client coordinator
  // (`isRealSubmitEnabled`). This mirrors it purely so the UI can state the
  // capability honestly; the coordinator still enforces it at execution time.
  // Mainnet is refused here independently of the execution gate, and stays refused even if
  // MAINNET_EXECUTION_AUTHORIZED is set: real cross-chain submission is an L1-spending path, and
  // enabling it on mainnet is a separate decision from enabling L2 trading.
  if (!isExecutionNetwork(network) || network === 'mainnet') {
    return {
      enabled: false,
      reason:
        network === 'mainnet'
          ? 'Real cross-chain submission on mainnet is not enabled by this build. It spends base-layer XTM, so it is authorized separately from L2 execution and is not implied by it.'
          : `Execution is not enabled on ${network} in this build.`,
    };
  }
  const raw = env[REAL_CROSSCHAIN_SUBMIT_ENV];
  const enabled = raw === '1' || raw === 'true';
  if (!enabled) {
    return { enabled: false, reason: `Real cross-chain submission is gated OFF (set ${REAL_CROSSCHAIN_SUBMIT_ENV}=1 to enable testnet submission)` };
  }
  return { enabled: true, reason: 'Testnet real submission enabled by explicit gate.' };
}

