/**
 * Deployment response headers.
 *
 * A meta CSP silently ignores `frame-ancestors`, so the clickjacking protection
 * has to come from a real response header. This file is the single source of
 * truth for those headers, it is asserted by the test suite, and it is written
 * to `dist/_headers` by a post-build step for a static host that actually
 * consumes that file (Cloudflare Pages).
 *
 * EMBEDDING MODEL — why `frame-ancestors` is not `'none'`.
 *
 * This app is NOT a top-level page in its intended deployment. Per
 * docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md, which records the wallet's
 * observed architecture:
 *
 *   "`window.tari` is NOT injected into arbitrary pages: dApps run in a
 *    cross-origin iframe inside the wallet and load
 *    `https://universe.tari.mw/tari-connector.js` (same-page wallet model)."
 *
 * Two consequences follow, and both are load-bearing:
 *
 *   1. The app MUST be framable by the wallet. `frame-ancestors 'none'` or
 *      `'self'` would make the product non-functional, so the wallet origin is
 *      an exact, non-wildcard allowance.
 *   2. The wallet's connector is a CROSS-ORIGIN script loaded into THIS
 *      document. `script-src 'self'` alone would block it, and with no
 *      `window.tari` the app cannot connect at all. The exact origin is
 *      therefore allowed in `script-src` — narrowly, with no wildcard, and
 *      with no `unsafe-inline` or `unsafe-eval` accepted in exchange.
 *
 * The exact injection mechanism (a script element inserted by the frame, versus
 * a postMessage-only bridge) was not observable in this environment, so the
 * `script-src` allowance is a documented requirement of the recorded
 * architecture rather than an observed fact. It is tracked as R-13.
 *
 * `X-Frame-Options` is deliberately ABSENT. It cannot express a cross-origin
 * allow-list: `SAMEORIGIN` would block the wallet, and `ALLOW-FROM` is obsolete
 * and unsupported in every current browser. Emitting it alongside a permissive
 * `frame-ancestors` would be an inconsistent, misleading policy, so CSP is the
 * single clickjacking control and this header is omitted on purpose.
 */

/** The wallet dApp frame origin, pinned exactly. Never a wildcard. */
export const WALLET_DAPP_ORIGIN = 'https://universe.tari.mw';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // The wallet connector is cross-origin and injected into this document. See
  // the embedding note above. This is the one non-'self' script source.
  `script-src 'self' ${WALLET_DAPP_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://indexer.esmeralda.tari.com https://indexer-fallback.tari.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  `frame-ancestors 'self' ${WALLET_DAPP_ORIGIN}`,
  'upgrade-insecure-requests',
].join('; ');

export const SECURITY_HEADERS: ReadonlyArray<{ name: string; value: string; why: string }> = [
  {
    name: 'Content-Security-Policy',
    value: CONTENT_SECURITY_POLICY,
    why: 'The script and connect policy is the real control. frame-ancestors lives here, not in a meta tag, because a meta CSP ignores it.',
  },
  {
    name: 'X-Content-Type-Options',
    value: 'nosniff',
    why: 'Stops a browser from re-interpreting a response as a script type it was not served as.',
  },
  {
    name: 'Referrer-Policy',
    value: 'no-referrer',
    why: 'Pool and NFT URLs carry resource addresses; a referrer must not leak them to a third party.',
  },
  {
    name: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
    why: 'This app requests none of these. Denying them removes a permission-prompt phishing surface.',
  },
  {
    name: 'Cross-Origin-Opener-Policy',
    value: 'same-origin-allow-popups',
    why: 'Isolates the browsing context from an opener while still allowing a user-initiated popup, so window.opener cannot be used to reach this app. This governs top-level browsing contexts only and does not interfere with the wallet framing this app.',
  },
  {
    name: 'Cross-Origin-Resource-Policy',
    // NOT `same-origin`. CORP is enforced on cross-origin document loads, so
    // `same-origin` would prevent the wallet's iframe from framing this app at
    // all. The built assets are public static files with no per-user content, so
    // permitting cross-origin loading costs nothing here.
    value: 'cross-origin',
    why: 'The assets are public and carry no per-user state, while the wallet must be able to frame the document. `same-origin` would break the documented dApp deployment model.',
  },
];

/**
 * Headers intentionally NOT emitted, recorded so their absence is a decision
 * rather than an oversight.
 */
export const DELIBERATELY_OMITTED_HEADERS: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: 'X-Frame-Options',
    why: 'Cannot express a cross-origin allow-list. SAMEORIGIN would block the wallet iframe; ALLOW-FROM is obsolete and unsupported. CSP frame-ancestors is the single clickjacking control.',
  },
  {
    name: 'Cross-Origin-Embedder-Policy',
    why: 'Not enabled. COEP would require every cross-origin subresource to opt in via CORP/CORS, which would break the wallet connector script and NFT media. Isolating this app from cross-origin isolation buys nothing here, because it holds no secrets and performs no sensitive cross-origin reads.',
  },
];

/**
 * Render the headers in the `_headers` format consumed by Cloudflare Pages
 * (and Netlify).
 *
 * The syntax matters and was previously wrong. The `_headers` grammar is:
 *
 *   - `#` begins a comment, to end of line;
 *   - a NON-indented, non-comment line is a path rule (`/`, `/*`, `/assets/*`);
 *   - every header belonging to that rule is INDENTED beneath it.
 *
 * Emitting descriptive prose as an indented line, or a header unindented, is not
 * a comment and not a valid header; the host either rejects the file or ignores
 * the malformed entries. That defect was invisible while the target host
 * (GitHub Pages) ignored the file entirely, so it was never parsed by anything.
 * `test/deployment.test.cjs` now validates the rendered syntax.
 */
export function renderHeadersFile(): string {
  const lines = [
    '# Security response headers for the Ootle Liquidity testnet frontend.',
    '# Generated by apps/web/scripts/write-deployment-headers.mjs from',
    '# apps/web/src/lib/deploymentHeaders.ts. Do not edit dist/_headers by hand.',
    '#',
    '# The /* rule applies to EVERY response this host serves, including the SPA',
    '# HTML document at / and at any deep client-side route. That is what makes',
    '# the clickjacking policy effective on /pools and every other route, not',
    '# just on the entry point.',
    '',
    '/*',
  ];
  for (const header of SECURITY_HEADERS) {
    lines.push(`  ${header.name}: ${header.value}`);
  }
  lines.push('', '/assets/*', '  Cache-Control: public, max-age=31536000, immutable');
  return `${lines.join('\n')}\n`;
}
