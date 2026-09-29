// Verify the security response headers on a REAL deployed HTTPS origin.
//
// WHY THIS EXISTS
//
// Audit item R-1 is: the headers are authored, generated, syntactically valid,
// and proven semantically in a real browser against a local server that enforces
// `dist/_headers` — but they have never been observed coming from a live HTTPS
// URL. `npm run test:e2e` proves the policy works. It cannot prove delivery.
// Only this script, pointed at a deployed origin, can.
//
// It is deliberately read-only: it issues GET/HEAD requests and asserts on the
// response headers. It deploys nothing, changes nothing, and sends no
// credentials.
//
// USAGE
//
//   node apps/web/scripts/verify-live-headers.mjs https://<deployment-host>
//   node apps/web/scripts/verify-live-headers.mjs https://<host> --json
//
// It exits non-zero when a required header is missing or wrong, so it is usable
// directly as a deployment gate and as evidence for closing R-1.
//
// WHAT IT CHECKS
//
//   1. `/` carries the CSP, and the CSP contains `frame-ancestors` naming the
//      wallet origin (a meta CSP silently ignores frame-ancestors, so a response
//      header is the only thing that counts).
//   2. A deep client-side route (`/pools`) carries it too. A host protecting
//      only `/` would pass a shallow check and would leave every real route
//      unclickjacked-proof.
//   3. A hashed asset loads, is immutable-cacheable, and is NOT rewritten to the
//      SPA document.
//   4. nosniff, Referrer-Policy, Permissions-Policy, COOP, CORP are present and
//      have the intended values.
//   5. X-Frame-Options is absent, and CORP is not `same-origin` — either would
//      silently break the wallet dApp iframe.
//   6. No wildcard source in the policy and no mixed content in the document.
//   7. No `http://` subresource URL in the served HTML (mixed content).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const compiled = join(appRoot, 'build-test', 'lib', 'deploymentHeaders.js');

if (!existsSync(compiled)) {
  console.error('build-test/lib/deploymentHeaders.js is missing. Run "pnpm --filter @tari-ootle/web run build:test" first.');
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, DELIBERATELY_OMITTED_HEADERS } = require(compiled);

const args = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');
const base = (args[0] ?? '').replace(/\/+$/, '');

if (!/^https:\/\//i.test(base)) {
  console.error('usage: node apps/web/scripts/verify-live-headers.mjs https://<deployment-host> [--json]');
  console.error('R-1 is only closable by an observed HTTPS response. An http:// origin cannot close it.');
  process.exit(2);
}

const failures = [];
const checks = [];
function record(ok, label, detail) {
  checks.push({ ok, label, detail });
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

/** Fetch a URL and return { status, headers, body }. Redirects are followed by fetch(). */
async function probe(path, method = 'GET') {
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { method, redirect: 'follow', signal: controller.signal });
    const body = method === 'GET' ? await response.text() : '';
    return { status: response.status, headers: response.headers, body, url: response.url };
  } finally {
    clearTimeout(timer);
  }
}

function header(headers, name) {
  return headers.get(name) ?? headers.get(name.toLowerCase());
}

const root = await probe('/');
record(root.status === 200, 'GET / returns 200', `status ${root.status}`);

const csp = header(root.headers, 'content-security-policy');
record(csp !== null, 'CSP is a real response header on /', 'absent — a meta CSP silently ignores frame-ancestors');
if (csp !== null) {
  record(csp.includes('frame-ancestors'), 'CSP on / contains frame-ancestors', csp.slice(0, 200));
  record(
    csp.includes('frame-ancestors') && csp.includes("'self'") && csp.includes('https://universe.tari.mw'),
    "frame-ancestors allows the wallet origin (https://universe.tari.mw)",
    csp,
  );
  record(!/(^|[;\s])\*/.test(csp), 'CSP contains no wildcard source', csp);
  record(!csp.includes('unsafe-eval'), 'CSP does not permit unsafe-eval', csp);
  record(csp.includes('object-src \'none\''), "CSP contains object-src 'none'", csp);
  // The origin must be HTTPS on a real deployment: `upgrade-insecure-requests`
  // is a browser-side repair, not evidence that the origin itself is HTTPS.
  record(!/(^|[;\s])http:\/\//i.test(csp), 'CSP names no http:// source', csp);
}

for (const required of SECURITY_HEADERS) {
  const value = header(root.headers, required.name);
  record(value !== null, `${required.name} is present on /`, 'absent');
  if (value !== null && required.name !== 'Content-Security-Policy') {
    record(value === required.value, `${required.name} has the authored value`, `expected ${required.value}, got ${value}`);
  }
}

for (const omitted of DELIBERATELY_OMITTED_HEADERS) {
  const value = header(root.headers, omitted.name);
  record(value === null, `${omitted.name} is absent as designed`, value ?? '');
}

const corp = header(root.headers, 'cross-origin-resource-policy');
if (corp !== null) {
  record(
    corp !== 'same-origin',
    'CORP is not same-origin (same-origin would break the wallet dApp iframe)',
    corp,
  );
}

const deep = await probe('/pools');
record(deep.status === 200, 'Deep SPA route /pools returns 200 directly (no client-side redirect)', `status ${deep.status}`);
const deepCsp = header(deep.headers, 'content-security-policy');
record(deepCsp !== null, 'CSP is present on the deep route /pools too', 'a host protecting only / would fail here');
if (deepCsp !== null && csp !== null) {
  record(deepCsp === csp, 'CSP on /pools is identical to the one on /', `/${csp} vs /pools ${deepCsp}`);
}

// An asset must be served AS an asset. If the SPA rewrite shadowed /assets, the
// app would still "work" in the sense of returning 200 while loading HTML as JS.
const assetMatch = /src="([^"]*\/assets\/[^"]+\.js)"/.exec(root.body);
if (assetMatch === null) {
  record(false, 'the served HTML references a hashed /assets/ script', 'no <script src=.../assets/...> found');
} else {
  const assetPath = assetMatch[1];
  const asset = await probe(assetPath, 'HEAD');
  record(asset.status === 200, `Asset ${assetPath} is served directly`, `status ${asset.status}`);
  const contentType = header(asset.headers, 'content-type') ?? '';
  record(
    /javascript|ecmascript/i.test(contentType),
    `Asset ${assetPath} is served with a JavaScript content-type`,
    contentType,
  );
  const assetCsp = header(asset.headers, 'content-security-policy');
  record(assetCsp !== null, `Asset ${assetPath} also carries the CSP`, 'absent');
  const cache = header(asset.headers, 'cache-control') ?? '';
  record(/immutable/.test(cache), `Asset ${assetPath} is immutable-cacheable`, cache);
}

// Mixed content: an http:// subresource on an https origin is blocked by the
// browser, so it would be a silent functional break rather than a warning.
const httpRefs = [...root.body.matchAll(/(?:src|href)="(http:\/\/[^"]+)"/g)].map((m) => m[1]);
record(httpRefs.length === 0, 'the served document contains no http:// subresource (no mixed content)', httpRefs.join(', '));

// Secrets must never reach the bundle.
const suspicious = /(?:"(?:api[_-]?key|secret|private[_-]?key|bearer)"\s*:\s*"(?!\$\{)[A-Za-z0-9_\-]{16,})/i;
record(!suspicious.test(root.body), 'the served document embeds no API-key-shaped literal', 'a credential-shaped literal was found in the HTML');

// Optional: check a bundle for embedded credentials too, when reachable.
if (checks.some((c) => c.ok && c.label.includes('/assets/'))) {
  // Deliberately no further network work: the HTML scan above is the gate, and
  // the repository's own deployment suite already scans every emitted bundle.
}

const result = {
  base,
  checkedAt: new Date().toISOString(),
  expectedPolicy: CONTENT_SECURITY_POLICY,
  passed: failures.length === 0,
  failures,
  checks,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}${check.ok ? '' : ` — ${check.detail}`}`);
  console.log('');
  console.log(`origin:   ${base}`);
  console.log(`checked:  ${result.checkedAt}`);
  if (result.passed) {
    console.log('');
    console.log('All live-header checks passed. This is the evidence that closes R-1 — record the URL, this');
    console.log('timestamp, and the git SHA of the deployed build in security/FRONTEND_RESIDUAL_RISKS.md.');
  } else {
    console.log('');
    console.log(`${failures.length} live-header check(s) FAILED. R-1 stays OPEN.`);
  }
}

process.exit(result.passed ? 0 : 1);
