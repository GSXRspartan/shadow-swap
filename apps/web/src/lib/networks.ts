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

/**
 * Public Esmeralda indexer origins for the network this build targets.
 *
 * Ootle v0.48.0 (2026-10-29, `6a25dbc`) is a TESTNET RESET release and moves the
 * official Esmeralda defaults to the `esme-indexer` hosts (#3027):
 *
 *   - `applications/tari_ootle_app_utilities/config_presets/e_wallet_daemon.toml`:
 *     `indexer_api_url = ["https://esme-indexer-a.ootle.tari.com/", "https://esme-indexer-b.ootle.tari.com/"]`
 *   - `crates/wallet/ootle-rs/src/helpers.rs`: `Network::Esmeralda => "https://esme-indexer-a.ootle.tari.com/"`
 *   - `applications/tari_walletd/src/config.rs`: test `esmeralda_defaults_to_both_tari_indexers`
 *
 * These are taken from the pinned upstream SOURCE. They could NOT be read live from the
 * environment that made this change (its egress policy denies the host), so the first
 * live `GET /info` against them is an operator acceptance step
 * (docs/SHADOW_SWAP_V047_RELEASE_READINESS.md). The app does not need them to be right
 * to be safe: identity, network byte and version are verified on every load, and an
 * endpoint that fails any of them is refused, never read.
 */
export const ESMERALDA_INDEXER_URLS: readonly string[] = [
  'https://esme-indexer-a.ootle.tari.com',
  'https://esme-indexer-b.ootle.tari.com',
];

/**
 * The PRE-v0.48-RESET Esmeralda indexers (`ootle-indexer-{a,b}.tari.com`), the v0.41–v0.47
 * defaults, read live repeatedly between 2026-09-28 and 2026-10-16 (docs/LIVE_TESTNET_EVIDENCE.md).
 *
 * Not a default any more. They stay permitted by `connect-src` so an operator can point a
 * build at the pre-reset network with `VITE_INDEXER_URL` while it is still served; the
 * reported version then selects the pre-reset generation, its seeds and its templates.
 */
export const LEGACY_ESMERALDA_INDEXER_URLS: readonly string[] = [
  'https://ootle-indexer-a.tari.com',
  'https://ootle-indexer-b.tari.com',
];

/**
 * Public content gateways the app may READ NFT metadata documents from.
 *
 * WHY THESE EXIST — this is a functional fix, not a hardening change.
 *
 * NFT metadata is fetched with `fetch()`, and `fetch()` is governed by
 * `connect-src`, NOT by `img-src`. Before these origins were listed,
 * `connect-src` permitted only `'self'` plus the two indexers, so **every**
 * collection whose `metadataUri` lived anywhere else — an IPFS gateway, Arweave,
 * or the collection's own CDN — was blocked by the browser. The fetch threw, the
 * catch returned a fallback with no image, and every card rendered a flat grey
 * square reading "No media supplied".
 *
 * That is the actual root cause of "the images disappeared": not a deleted asset,
 * not a broken path, but a Content Security Policy that made the fetch impossible.
 * `img-src 'self' data: https:` was always permissive enough to render a remote
 * image — the document simply never arrived.
 *
 * THE TRADEOFF, stated honestly.
 *
 * Widening `connect-src` for READ-ONLY JSON fetches does widen the app's network
 * surface. What it does NOT do, and this is the part that matters:
 *
 *   - `default-src` stays `'self'`; `script-src` stays `'self'` plus the single
 *     wallet connector origin; `object-src` and `frame-src` stay `'none'`.
 *     Nothing here permits a remote origin to execute a line of script.
 *   - The fetches are `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`,
 *     so no cookie, token, or session is ever attached to them, and no wallet
 *     secret can be read by the responding host.
 *   - Responses are bounded (`MAX_METADATA_BYTES`) and timeout-bounded, and are
 *     parsed as inert JSON whose text is sanitised before rendering.
 *
 * The genuinely important security properties — the signer origin, the review gate,
 * the authoritative reads — are all untouched by this list.
 *
 * KEEP IN SYNC. `connect-src` is derived from this table in `deploymentHeaders.ts`
 * and asserted against it in `test/deployment.test.cjs`, so an origin added here
 * cannot silently miss the shipped header, and an origin in the header that is not
 * here fails the suite.
 */
export const NFT_METADATA_GATEWAY_URLS: readonly string[] = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://cloudflare-ipfs.com',
  'https://gateway.pinata.cloud',
  'https://arweave.net',
];

/** Everything `connect-src` is allowed to reach. One table, two consumers. */
export const CONNECT_ALLOWED_ORIGINS: readonly string[] = [...ESMERALDA_INDEXER_URLS, ...LEGACY_ESMERALDA_INDEXER_URLS, ...NFT_METADATA_GATEWAY_URLS];

/**
 * `Network.Esmeralda` in the official Tari SDKs, as a decimal byte.
 *
 * Cross-checked against `GET /info` `network_byte` so a substituted endpoint
 * that happens to answer HTTP 200 cannot be mistaken for the right chain.
 */
export const NETWORK_BYTES: Readonly<Record<FrontendNetworkId, number>> = {
  esmeralda: 0x26,
  localnet: 0x10,
};

export const FRONTEND_NETWORKS: Readonly<Record<FrontendNetworkId, FrontendNetwork>> = {
  esmeralda: {
    id: 'esmeralda',
    displayName: 'Esmeralda Testnet',
    badge: 'TESTNET',
    indexerUrls: [...ESMERALDA_INDEXER_URLS],
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
