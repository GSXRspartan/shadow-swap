/**
 * Network allowlist.
 *
 * This phase is TESTNET ONLY. Mainnet is not selectable, not defaulted, and not
 * hinted at. `assertAllowedNetwork` mirrors the protocol-client's own
 * `assertTestnetNetwork` so the browser can never offer something the execution
 * layer would refuse.
 */

export type FrontendNetworkId = 'esmeralda' | 'localnet';

export interface FrontendNetwork {
  id: FrontendNetworkId;
  /** Long form used in the UI. */
  displayName: string;
  /** Always rendered next to the name so testnet never reads as mainnet. */
  badge: 'TESTNET' | 'DEVNET';
  indexerUrls: string[];
  /** Only localnet may talk to a locally running wallet/indexer. */
  allowsLocalEndpoints: boolean;
}

export const FRONTEND_NETWORKS: Readonly<Record<FrontendNetworkId, FrontendNetwork>> = {
  esmeralda: {
    id: 'esmeralda',
    displayName: 'Esmeralda Testnet',
    badge: 'TESTNET',
    indexerUrls: ['https://indexer.esmeralda.tari.com', 'https://indexer-fallback.tari.com'],
    allowsLocalEndpoints: false,
  },
  localnet: {
    id: 'localnet',
    displayName: 'Localnet',
    badge: 'DEVNET',
    indexerUrls: ['http://127.0.0.1:9113'],
    allowsLocalEndpoints: true,
  },
};

export const DEFAULT_NETWORK: FrontendNetworkId = 'esmeralda';

export function isAllowedNetwork(id: string): id is FrontendNetworkId {
  return id === 'esmeralda' || id === 'localnet';
}

/** Any string containing "mainnet" is refused, regardless of how it was spelled. */
export function looksLikeMainnet(id: string): boolean {
  return /mainnet/i.test(id);
}

export function networkOf(id: string): FrontendNetwork | undefined {
  return isAllowedNetwork(id) ? FRONTEND_NETWORKS[id] : undefined;
}

export interface NetworkGuard {
  ok: boolean;
  reason?: string;
}

/**
 * Blocking-state generator. Anything other than the allowlisted testnet is a
 * hard stop: the shell renders a blocking banner and every execution control is
 * disabled.
 */
export function checkNetwork(id: string | null | undefined): NetworkGuard {
  if (id === null || id === undefined || id === '') {
    return { ok: false, reason: 'No network reported by the connected provider.' };
  }
  if (looksLikeMainnet(id)) {
    return { ok: false, reason: `Mainnet is disabled in this build. The provider reports "${id}".` };
  }
  if (!isAllowedNetwork(id)) {
    return { ok: false, reason: `Network "${id}" is not in this build's allowlist. Allowed: esmeralda, localnet.` };
  }
  return { ok: true };
}

/**
 * Reject a configured endpoint that would put a localhost dependency into a
 * non-dev build. Returns undefined when the endpoint is acceptable.
 */
export function localEndpointReason(url: string, buildIsDevelopment: boolean): string | undefined {
  if (!/^https?:\/\//i.test(url)) return `Endpoint "${url}" is not an http(s) URL.`;
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(url);
  if (isLocal && !buildIsDevelopment) {
    return `Refusing to use the local endpoint "${url}" in a non-development build.`;
  }
  return undefined;
}
