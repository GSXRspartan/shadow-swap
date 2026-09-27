/**
 * Runtime configuration.
 *
 * Everything network- or provider-shaped is resolved here, once, from Vite env
 * vars with safe defaults. Two rules are enforced structurally:
 *
 *  1. Mainnet is never configurable. There is no mainnet key to set.
 *  2. Local (127.0.0.1 / localhost) endpoints are only honoured in a
 *     development build. A production build that is pointed at localhost is a
 *     hard error, not a silent fallback.
 */

import { DEFAULT_NETWORK, checkNetwork, isAllowedNetwork, localEndpointReason, looksLikeMainnet, type FrontendNetworkId } from '../lib/networks.js';
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
  /** Why a dev provider / fixture source is on, for the visible dev banner. */
  developmentReason?: string;
  /** Blocking problems that make the whole app unusable. */
  blocking: string[];
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
  if (looksLikeMainnet(requestedNetwork)) {
    blocking.push(`VITE_TARI_NETWORK="${requestedNetwork}" names a mainnet. Mainnet is disabled in this build.`);
  }
  if (!isAllowedNetwork(requestedNetwork)) {
    blocking.push(`VITE_TARI_NETWORK="${requestedNetwork}" is not in the allowlist (esmeralda, localnet).`);
  }
  const network: FrontendNetworkId = isAllowedNetwork(requestedNetwork) ? requestedNetwork : DEFAULT_NETWORK;
  const guard = checkNetwork(network);
  if (!guard.ok && guard.reason !== undefined) blocking.push(guard.reason);

  const defaultIndexers = network === 'localnet' ? ['http://127.0.0.1:9113'] : ['https://indexer.esmeralda.tari.com', 'https://indexer-fallback.tari.com'];
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

  return { network, indexerUrls, fixturesEnabled, devProvidersEnabled, walletdUrl, developmentReason, blocking };
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
  if (network !== 'esmeralda' && network !== 'localnet') {
    return { enabled: false, reason: 'Only test networks are permitted in this build.' };
  }
  const raw = env[REAL_CROSSCHAIN_SUBMIT_ENV];
  const enabled = raw === '1' || raw === 'true';
  if (!enabled) {
    return { enabled: false, reason: `Real cross-chain submission is gated OFF (set ${REAL_CROSSCHAIN_SUBMIT_ENV}=1 to enable testnet submission)` };
  }
  return { enabled: true, reason: 'Testnet real submission enabled by explicit gate.' };
}

