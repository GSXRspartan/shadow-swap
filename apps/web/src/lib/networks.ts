/**
 * The frontend's network table, and the one place real-money execution is authorized.
 *
 * WHAT CHANGED, AND WHY IT IS NOT A LOOSENING
 *
 * This module used to say "mainnet is not selectable, not defaulted, and not hinted at", and
 * `looksLikeMainnet` refused any string containing "mainnet". That was honest for a build that
 * could never go to mainnet, and it became dishonest the moment mainnet was the goal: a build
 * that structurally cannot represent mainnet cannot be *made* ready for it, so "not ready" and
 * "never" become indistinguishable — and the fix, when someone finally needs it, is a scramble
 * through every file that assumed two testnets.
 *
 * So mainnet is now a KNOWN network with a full identity, and the gate moved to where the risk
 * actually is: `MAINNET_EXECUTION_AUTHORIZED`. One reviewed constant, consulted by
 * `checkNetwork`, which every wallet connection and every execution path already goes through.
 * Nothing about a date, a build flag or a successful read moves it.
 *
 * THE STATE TODAY, and it is not a policy choice:
 *
 *   * Minotari **L1** mainnet is live. It is where the XTM donation address receives, and that
 *     path needs no execution authorization because this application never spends on L1.
 *   * Ootle **L2** mainnet has not launched. Upstream's SDK has no mainnet indexer URL —
 *     `default_indexer_url(Network::MainNet)` is `unimplemented!()` at cohort `6a25dbc` — and
 *     upstream's own guide says "Ootle mainnet has not launched yet". So `mainnet`'s indexer list
 *     below is EMPTY, and a build pointed at it can read nothing. That is the truth, not a
 *     placeholder, and no URL is invented to fill the gap.
 *
 * The authoritative identity table lives in `@tari-ootle/protocol-client`'s `chainIdentity`,
 * read from upstream source. This module re-exports from it rather than keeping a second copy,
 * because two tables of network bytes is one table too many.
 */

import { NETWORK_BYTES as CHAIN_NETWORK_BYTES, type TariNetwork } from '@tari-ootle/protocol-client';

/**
 * Networks this frontend can be configured for.
 *
 * A subset of `TariNetwork`: igor, stagenet and nextnet are real networks this build has no
 * verified facts about, so they are not offered rather than being half-supported.
 */
export type FrontendNetworkId = 'mainnet' | 'esmeralda' | 'localnet';

export interface FrontendNetwork {
  id: FrontendNetworkId;
  /** Long form used in the UI. */
  displayName: string;
  /** Always rendered next to the name, so a network's nature is never implied by its absence. */
  badge: 'MAINNET' | 'TESTNET' | 'DEVNET';
  /** Ootle L2 read endpoints. EMPTY means nothing can be read from this network. */
  indexerUrls: string[];
  /** Why the endpoint list is empty, when it is. */
  indexerReason?: string;
  /** Only localnet may talk to a locally running wallet/indexer. */
  allowsLocalEndpoints: boolean;
  /** True only for a network carrying real value. */
  realValue: boolean;
}

/**
 * **THE AUTHORIZATION POINT FOR REAL-MONEY EXECUTION.**
 *
 * `false` means: this build may be configured for mainnet, may know its identity, and may show
 * mainnet-related read-only information — and will refuse every wallet connection and every
 * transaction on it.
 *
 * Setting this to `true` is the operator's decision and is not sufficient on its own: the
 * readiness ladder in `@tari-ootle/protocol-client`'s `assessReadiness` still requires a reachable
 * chain, a compatible wallet, a validated deployment manifest and working market data. This
 * constant is the rung that cannot be earned by passing a check.
 *
 * It is deliberately NOT an environment variable. A `VITE_*` value is public, set at build time
 * by whoever runs the build, and would make "is mainnet live" a property of a CI configuration
 * rather than of a reviewed commit.
 */
export const MAINNET_EXECUTION_AUTHORIZED = false;

/** Ootle Esmeralda's L2 indexers for the v0.48.0 cohort, from pinned upstream source. */
export const ESMERALDA_INDEXER_URLS: readonly string[] = [
  'https://esme-indexer-a.ootle.tari.com',
  'https://esme-indexer-b.ootle.tari.com',
];

/**
 * The PRE-v0.48-RESET Esmeralda indexers, the v0.41–v0.47 defaults, read live repeatedly between
 * 2026-09-28 and 2026-10-16 (docs/LIVE_TESTNET_EVIDENCE.md).
 *
 * Not a default any more. They stay permitted by `connect-src` so an operator can point a build
 * at the pre-reset network with `VITE_INDEXER_URL` while it is still served; the reported version
 * then selects the pre-reset generation, its seeds and its templates.
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
 * NFT metadata is fetched with `fetch()`, and `fetch()` is governed by `connect-src`, NOT by
 * `img-src`. Before these origins were listed, `connect-src` permitted only `'self'` plus the two
 * indexers, so **every** collection whose `metadataUri` lived anywhere else — an IPFS gateway,
 * Arweave, or the collection's own CDN — was blocked by the browser. The fetch threw, the catch
 * returned a fallback with no image, and every card rendered a flat grey square reading "No media
 * supplied".
 *
 * That is the actual root cause of "the images disappeared": not a deleted asset, not a broken
 * path, but a Content Security Policy that made the fetch impossible. `img-src 'self' data: https:`
 * was always permissive enough to render a remote image — the document simply never arrived.
 *
 * THE TRADEOFF, stated honestly. Widening `connect-src` for READ-ONLY JSON fetches does widen the
 * app's network surface. What it does NOT do:
 *
 *   - `default-src` stays `'self'`; `script-src` stays `'self'` plus the single wallet connector
 *     origin; `object-src` and `frame-src` stay `'none'`. Nothing here permits a remote origin to
 *     execute a line of script.
 *   - The fetches are `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`, so no cookie,
 *     token or session is ever attached, and no wallet secret can be read by the responding host.
 *   - Responses are bounded (`MAX_METADATA_BYTES`) and timeout-bounded, and are parsed as inert
 *     JSON whose text is sanitised before rendering.
 *
 * KEEP IN SYNC. `connect-src` is derived from this table in `deploymentHeaders.ts` and asserted
 * against it in `test/deployment.test.cjs`, so an origin added here cannot silently miss the
 * shipped header, and an origin in the header that is not here fails the suite.
 */
export const NFT_METADATA_GATEWAY_URLS: readonly string[] = [
  'https://ipfs.io',
  'https://dweb.link',
  'https://cloudflare-ipfs.com',
  'https://gateway.pinata.cloud',
  'https://arweave.net',
];

/**
 * Everything `connect-src` is allowed to reach. One table, two consumers.
 *
 * No mainnet origin appears, and cannot: there is no published Ootle mainnet indexer to list. When
 * one exists, adding it here is the same reviewed change as adding it to the network table, and
 * the deployment test fails until both agree.
 */
export const CONNECT_ALLOWED_ORIGINS: readonly string[] = [
  ...ESMERALDA_INDEXER_URLS,
  ...LEGACY_ESMERALDA_INDEXER_URLS,
  ...NFT_METADATA_GATEWAY_URLS,
];

/**
 * Network discriminant bytes for the networks this frontend offers, taken from the authoritative
 * table rather than restated. Cross-checked against `GET /info`'s `network_byte`, so a substituted
 * endpoint that happens to answer HTTP 200 cannot be mistaken for the right chain.
 */
export const NETWORK_BYTES: Readonly<Record<FrontendNetworkId, number>> = {
  mainnet: CHAIN_NETWORK_BYTES.mainnet,
  esmeralda: CHAIN_NETWORK_BYTES.esmeralda,
  localnet: CHAIN_NETWORK_BYTES.localnet,
};

export const FRONTEND_NETWORKS: Readonly<Record<FrontendNetworkId, FrontendNetwork>> = {
  mainnet: {
    id: 'mainnet',
    displayName: 'Mainnet',
    badge: 'MAINNET',
    // Empty because no Ootle mainnet indexer has been published. See this module's header.
    indexerUrls: [],
    indexerReason:
      'Ootle L2 mainnet has not launched and no public indexer has been published for it. This build will not guess an endpoint for a network carrying real value.',
    allowsLocalEndpoints: false,
    realValue: true,
  },
  esmeralda: {
    id: 'esmeralda',
    displayName: 'Esmeralda Testnet',
    badge: 'TESTNET',
    indexerUrls: [...ESMERALDA_INDEXER_URLS],
    allowsLocalEndpoints: false,
    realValue: false,
  },
  localnet: {
    id: 'localnet',
    displayName: 'Localnet',
    badge: 'DEVNET',
    indexerUrls: ['http://127.0.0.1:9113'],
    allowsLocalEndpoints: true,
    realValue: false,
  },
};

export const DEFAULT_NETWORK: FrontendNetworkId = 'esmeralda';

/** Every network this frontend can be configured for, mainnet included. */
export function isKnownNetwork(id: string): id is FrontendNetworkId {
  return id === 'mainnet' || id === 'esmeralda' || id === 'localnet';
}

/**
 * Networks on which this build will connect a wallet and build transactions.
 *
 * Mainnet is included only when `MAINNET_EXECUTION_AUTHORIZED` is set. This is the predicate the
 * execution gate uses, and it is deliberately separate from `isKnownNetwork`: knowing what a
 * network is and being willing to spend on it are different questions.
 */
export function isExecutionNetwork(id: string): id is FrontendNetworkId {
  if (!isKnownNetwork(id)) return false;
  return id === 'mainnet' ? MAINNET_EXECUTION_AUTHORIZED : true;
}

/**
 * Retained from the previous shape of this module, with a narrower job.
 *
 * `'mainnet'` is now a legitimate configured value, so this no longer refuses it. What it still
 * refuses is a string that merely LOOKS like mainnet without being it — `mainnet-2`, `fakemainnet`,
 * `MainNet copy` — which is the shape a typo or a substitution takes, and which must never be
 * resolved to the real mainnet or quietly to a testnet.
 */
export function looksLikeMainnet(id: string): boolean {
  const name = id.trim().toLowerCase();
  return /mainnet/.test(name) && name !== 'mainnet';
}

/** Normalises a configured value: case-insensitive, no aliases invented. */
export function normalizeNetworkId(id: string): FrontendNetworkId | undefined {
  const name = id.trim().toLowerCase();
  return isKnownNetwork(name) ? name : undefined;
}

export function networkOf(id: string): FrontendNetwork | undefined {
  const normalized = normalizeNetworkId(id);
  return normalized === undefined ? undefined : FRONTEND_NETWORKS[normalized];
}

/** A frontend network id as the shared `TariNetwork` type. Every id here is one of those. */
export function toTariNetwork(id: FrontendNetworkId): TariNetwork {
  return id;
}

export interface NetworkGuard {
  ok: boolean;
  reason?: string;
}

/**
 * THE EXECUTION GATE. Anything this refuses means: no wallet connection, no transaction, and a
 * blocking banner in the shell.
 *
 * Three distinct refusals, because they need three different responses from whoever reads them:
 * an unknown network is a misconfiguration, a mainnet-shaped impostor is a substitution, and
 * mainnet itself is a deliberate hold with a named way to lift it.
 */
export function checkNetwork(id: string | null | undefined): NetworkGuard {
  if (id === null || id === undefined || id === '') {
    return { ok: false, reason: 'No network reported by the connected provider.' };
  }
  if (looksLikeMainnet(id)) {
    return {
      ok: false,
      reason: `Network "${id}" resembles mainnet without being it. A name this close to a real network is refused rather than resolved, in either direction.`,
    };
  }
  const normalized = normalizeNetworkId(id);
  if (normalized === undefined) {
    return { ok: false, reason: `Network "${id}" is not one this build knows. Known: mainnet, esmeralda, localnet.` };
  }
  if (normalized === 'mainnet' && !MAINNET_EXECUTION_AUTHORIZED) {
    return {
      ok: false,
      reason:
        'Mainnet is configured and its identity is known, but real-money execution on it has not been authorized in this build. Reading and discovery are permitted where an endpoint exists; no wallet is connected and no transaction is built. Authorization is a reviewed change to MAINNET_EXECUTION_AUTHORIZED, not a setting.',
    };
  }
  return { ok: true };
}

/**
 * Reject a configured endpoint that would put a localhost dependency into a non-dev build.
 * Returns undefined when the endpoint is acceptable.
 */
export function localEndpointReason(url: string, buildIsDevelopment: boolean): string | undefined {
  if (!/^https?:\/\//i.test(url)) return `Endpoint "${url}" is not an http(s) URL.`;
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i.test(url);
  if (isLocal && !buildIsDevelopment) {
    return `Refusing to use the local endpoint "${url}" in a non-development build.`;
  }
  return undefined;
}

/**
 * Retained for callers that predate `isKnownNetwork`.
 *
 * Deliberately an alias of the EXECUTION predicate rather than the knowledge one: every existing
 * call site used it to decide whether to proceed with real work, and silently widening those to
 * include an unauthorized mainnet is exactly the mistake this refactor must not make.
 */
export function isAllowedNetwork(id: string): id is FrontendNetworkId {
  return isExecutionNetwork(id);
}
