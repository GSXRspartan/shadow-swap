/**
 * Deployment hardening: CSP, clickjacking, headers, source maps, fixture
 * contamination, and secret leakage in the built artifact.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(appRoot, 'src');
const distDir = path.join(appRoot, 'dist');
const built = require('../build-test/lib/deploymentHeaders.js');
const networks = require('../build-test/lib/networks.js');
const config = require('../build-test/services/config.js');

function sourceFiles(dir, extensions) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function bundleText() {
  const assets = path.join(distDir, 'assets');
  if (!fs.existsSync(assets)) assert.fail('production build not found; run "npm run build"');
  return fs
    .readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(assets, name), 'utf8'))
    .join('\n');
}

// ===========================================================================
// CSP
// ===========================================================================

test('csp: connect-src cannot be widened to a wildcard or a private address', () => {
  const csp = built.CONTENT_SECURITY_POLICY;
  const connect = /connect-src ([^;]+)/.exec(csp);
  assert.ok(connect, 'connect-src must be declared');
  for (const origin of connect[1].split(/\s+/).filter((entry) => entry !== "'self'")) {
    assert.match(origin, /^https:\/\/[a-z0-9.-]+(?::\d+)?$/, `connect-src origin must be an explicit https host, got ${origin}`);
    assert.equal(/^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|10\.|192\.168\.)/.test(origin), false, `private address in connect-src: ${origin}`);
    assert.equal(/mainnet/.test(origin), false);
  }
});

test('csp: connect-src covers exactly the configured esmeralda indexer origins', () => {
  // The regression this guards is real: `connect-src` and the configured endpoint
  // used to be two independent hand-written strings, and when the configured
  // hosts were replaced on 2026-09-28 the CSP would have kept allowing the dead
  // origins and blocked the live ones. They are now derived from one table.
  const connect = /connect-src ([^;]+)/.exec(built.CONTENT_SECURITY_POLICY);
  assert.ok(connect, 'connect-src must be declared');
  const allowed = connect[1].split(/\s+/).filter((entry) => entry !== "'self'").sort();
  assert.deepEqual(allowed, [...networks.ESMERALDA_INDEXER_URLS].sort());
  // And the resolved production config must not name an origin outside it.
  const resolved = config.resolveConfig({ MODE: 'production', DEV: false });
  assert.deepEqual(resolved.blocking, []);
  for (const url of resolved.indexerUrls) {
    assert.ok(allowed.includes(url.replace(/\/+$/, '')), `configured origin ${url} is not permitted by connect-src`);
  }
});

test('csp: every configured esmeralda origin is https and non-local', () => {
  for (const url of networks.ESMERALDA_INDEXER_URLS) {
    assert.match(url, /^https:\/\//, `production indexer origin must be https: ${url}`);
    assert.equal(networks.localEndpointReason(url, false), undefined, `${url} must be usable outside a development build`);
  }
  assert.equal(networks.NETWORK_BYTES.esmeralda, 0x26, 'Esmeralda is network byte 38, matching the live /info');
});

test('csp: the meta tag and the response header name the SAME connect origins', () => {
  // A browser enforces the meta policy AND the response policy, and the
  // effective policy is their intersection. So this is a second independent copy
  // of `connect-src`, and a stale one silently blocks a correct deployment.
  //
  // That is not hypothetical: when the indexer origins changed on 2026-09-28 the
  // response header was updated and this meta tag was missed. The header was
  // right, the browser suite went red, and every cross-origin discovery read
  // failed with `TypeError: Failed to fetch`.
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(meta, 'index.html must declare a CSP');

  const originsOf = (policy) => {
    const match = /connect-src ([^;]+)/.exec(policy);
    assert.ok(match, `connect-src must be declared in: ${policy.slice(0, 60)}`);
    return match[1].trim().split(/\s+/).sort();
  };
  assert.deepEqual(
    originsOf(meta[1]),
    originsOf(built.CONTENT_SECURITY_POLICY),
    'the meta CSP and the response CSP must name identical connect origins, or the effective policy is the intersection of the two',
  );

  // And the shipped artifact must carry the same list as the source, so a stale
  // dist cannot pass a test that only reads index.html.
  const builtHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const builtMeta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(builtHtml);
  assert.ok(builtMeta, 'the built index.html must carry the meta CSP');
  assert.deepEqual(originsOf(builtMeta[1]), originsOf(built.CONTENT_SECURITY_POLICY));
});

test('csp: the meta tag and the response header name the SAME script origins', () => {
  // The same intersection trap, for the wallet connector. The response header
  // carried `script-src 'self' https://universe.tari.mw` while the meta tag said
  // `script-src 'self'`, so the EFFECTIVE policy blocked the connector and the
  // Tari Universe iframe placement could never have connected — the header being
  // correct is not sufficient when a second, narrower policy is also enforced.
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(meta, 'index.html must declare a CSP');

  const sourcesOf = (policy) => {
    const match = /script-src ([^;]+)/.exec(policy);
    assert.ok(match, `script-src must be declared in: ${policy.slice(0, 60)}`);
    return match[1].trim().split(/\s+/).sort();
  };
  assert.deepEqual(
    sourcesOf(meta[1]),
    sourcesOf(built.CONTENT_SECURITY_POLICY),
    'the meta CSP and the response CSP must name identical script sources, or the narrower one silently blocks the wallet connector',
  );

  const builtHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const builtMeta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(builtHtml);
  assert.ok(builtMeta, 'the built index.html must carry the meta CSP');
  assert.deepEqual(sourcesOf(builtMeta[1]), sourcesOf(built.CONTENT_SECURITY_POLICY));
});

test('the wallet connector is included unconditionally, as the official model requires', () => {
  // The published integration model says to include it always: it is what makes
  // the wallet reachable when the dApp is embedded in Tari Universe, and it
  // stands aside when an extension already owns `window.tari` in a tab.
  //
  // Two things are therefore wrong and both are checked here:
  //   - the script tag being ABSENT, which makes the embedded placement unable
  //     to connect at all;
  //   - the tag being CONDITIONAL (behind a wallet check, a user agent test, or
  //     a runtime branch), which is the wallet-detection the documentation
  //     forbids and would race the provider's own initialisation.
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  const tags = html.match(/<script\b[^>]*>/g) ?? [];
  const connectors = tags.filter((tag) => tag.includes('universe.tari.mw/tari-connector.js'));

  assert.equal(connectors.length, 1, 'the connector must be included exactly once');
  const [connector] = connectors;
  assert.match(connector, /src="https:\/\/universe\.tari\.mw\/tari-connector\.js"/, 'the connector origin must be exact, not interpolated');
  assert.equal(/async|defer/.test(connector), false, 'the connector must not be deferred; it publishes the provider on script load');
  assert.equal(/type="module"/.test(connector), false, 'the connector is a classic script');
  // No `data-tari-*` / `id` gate or inline conditional wrapper.
  assert.equal(/<script[^>]*\bif\b/i.test(connector), false, 'the connector tag must be unconditional');
  assert.equal(tags.filter((tag) => /if\s*\(/.test(tag)).length, 0, 'no script tag may be wrapped in a wallet-detection conditional');

  // The same must be true of the SHIPPED artifact, not only the source.
  const builtHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const builtConnectors = (builtHtml.match(/<script\b[^>]*>/g) ?? []).filter((tag) => tag.includes('universe.tari.mw/tari-connector.js'));
  assert.equal(builtConnectors.length, 1, 'the built page must include the connector exactly once');
});

test('csp: the meta policy in index.html carries the load-bearing directives', () => {
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(meta, 'index.html must declare a CSP');
  const csp = meta[1];
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", "frame-src 'none'"]) {
    assert.ok(csp.includes(directive), `the meta CSP must contain "${directive}"`);
  }
  // The wallet connector origin must be permitted by the meta policy too, since
  // the effective policy is the intersection of the meta and header policies.
  assert.match(csp, /script-src[^;]*https:\/\/universe\.tari\.mw/, 'the meta CSP must allow the wallet connector origin');
  assert.equal(/\*/.test(csp), false, 'the meta CSP must not use a wildcard source');
  // Inline script and eval must be absent, or the meta policy is theatre.
  assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false, 'no inline script may be permitted');
  assert.equal(/script-src[^;]*'unsafe-eval'/.test(csp), false, 'no eval may be permitted');
});

test('csp: no retired indexer host survives anywhere in the shipped frontend', () => {
  // Both of the pre-2026-09-28 origins are authoritative NXDOMAIN. Leaving one
  // in a policy or a permission list is not harmless: an allow-list that names
  // only dead hosts fails closed, and one that names both dead and live hosts
  // is misleading to whoever reads it during an incident.
  const retired = ['indexer.esmeralda.tari.com', 'indexer-fallback.tari.com'];
  const files = sourceFiles(appRoot, ['.ts', '.tsx', '.html', '.mjs', '.cjs']);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const host of retired) {
      // Comments and evidence documents may name them historically; a policy,
      // a permission list, or a fetch target may not. Identify those by shape.
      assert.equal(
        /["'`][^"'`\n]*(?:connect-src|host_permissions|page\.route|fetch\()[^"'`\n]*["'`][^"'`\n]*" ?\+? ?[^\n]*https?:\/\/[^"'`\n]*\/[^"'`\n]*$/.test(text) && text.includes(host),
        false,
        `${path.relative(appRoot, file)} appears to reference the retired origin ${host}`,
      );
    }
  }
  // The two policy strings themselves must not contain it, checked directly
  // rather than by the heuristic above.
  assert.equal(/indexer\.esmeralda\.tari\.com/.test(built.CONTENT_SECURITY_POLICY), false);
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  assert.equal(/indexer\.esmeralda\.tari\.com/.test(html), false);
  assert.equal(/indexer-fallback\.tari\.com/.test(html), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, '..', 'extension', 'manifest.json'), 'utf8'));
  for (const pattern of manifest.host_permissions ?? []) {
    assert.equal(/indexer\.esmeralda\.tari\.com|indexer-fallback\.tari\.com/.test(pattern), false, `extension host permission still names a retired origin: ${pattern}`);
  }
});

test('csp: frame-ancestors is in the response header, not the meta tag', () => {
  // A meta CSP ignores frame-ancestors, so declaring it there would be false
  // assurance. It must appear in the generated response header instead. Only
  // the `content=` attribute is examined: the HTML comment explains WHY it is
  // absent, and that explanation must not be mistaken for the directive.
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  assert.ok(meta, 'index.html must declare a CSP');
  assert.equal(/frame-ancestors/.test(meta[1]), false, 'frame-ancestors must not be declared in a meta CSP');
  // The explanation must be present, so a future reader knows it is deliberate.
  assert.match(html, /frame-ancestors[\s\S]{0,400}NOT SET HERE|frame-ancestors is ignored|ignores\s+frame-ancestors/);
  assert.match(built.CONTENT_SECURITY_POLICY, /frame-ancestors 'self'/);
});

test('csp: the generated response headers include the clickjacking and sniffing defences', () => {
  const names = built.SECURITY_HEADERS.map((header) => header.name);
  for (const required of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy']) {
    assert.ok(names.includes(required), `the deployment must send ${required}`);
  }
  // Every header must state why it exists, so a future removal is deliberate.
  for (const header of built.SECURITY_HEADERS) {
    assert.ok(header.why.length > 20, `${header.name} must document its purpose`);
  }
  const permissions = built.SECURITY_HEADERS.find((header) => header.name === 'Permissions-Policy');
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
    assert.match(permissions.value, new RegExp(`${feature}=\(\)`), `${feature} must be denied`);
  }
});

test('csp: X-Frame-Options is omitted deliberately, because it cannot express the policy', () => {
  // The app must be framable by the wallet's dApp frame
  // (docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md), so frame-ancestors names
  // that origin. X-Frame-Options has no way to express a cross-origin
  // allow-list: SAMEORIGIN would block the wallet outright, and ALLOW-FROM is
  // obsolete and unsupported everywhere. Emitting it would contradict the
  // frame-ancestors policy it is supposed to back up, so it is omitted and the
  // omission is asserted.
  const names = built.SECURITY_HEADERS.map((header) => header.name);
  assert.equal(names.includes('X-Frame-Options'), false, 'X-Frame-Options must not be emitted alongside a permissive frame-ancestors');
  const omitted = built.DELIBERATELY_OMITTED_HEADERS.find((header) => header.name === 'X-Frame-Options');
  assert.ok(omitted, 'the omission must be recorded with a reason');
  assert.ok(omitted.why.length > 40, 'the omission reason must be substantive');
  // And it must be absent from the generated file too, not merely unused code.
  const text = fs.readFileSync(path.join(distDir, '_headers'), 'utf8');
  assert.equal(/X-Frame-Options/i.test(text), false, 'dist/_headers must not contain X-Frame-Options');
  // The policy that does the work must still be present and must name the frame origin.
  assert.match(built.CONTENT_SECURITY_POLICY, /frame-ancestors 'self' https:\/\/universe\.tari\.mw/);
});

test('csp: CORP is not same-origin, or the wallet cannot frame the app', () => {
  const corp = built.SECURITY_HEADERS.find((header) => header.name === 'Cross-Origin-Resource-Policy');
  assert.ok(corp, 'CORP must be present and deliberate');
  assert.notEqual(corp.value, 'same-origin', 'CORP same-origin is enforced on cross-origin document loads and would block the wallet iframe');
  assert.ok(corp.why.length > 40, 'the CORP value must explain the trade-off');
});

test('csp: the script policy names the wallet connector origin and nothing wider', () => {
  // The documented dApp model loads https://universe.tari.mw/tari-connector.js
  // into this document. `script-src 'self'` alone would block it and the app
  // could never obtain `window.tari`. The allowance must be that exact origin.
  assert.match(built.CONTENT_SECURITY_POLICY, /script-src 'self' https:\/\/universe\.tari\.mw/);
  // No wildcard, and no bare Tari domain that would admit every Tari property.
  assert.equal(/script-src[^;]*\*/.test(built.CONTENT_SECURITY_POLICY), false, 'script-src must contain no wildcard');
  assert.equal(/script-src[^;]*https:\/\/tari\./.test(built.CONTENT_SECURITY_POLICY), false, 'script-src must not admit a bare Tari domain');
  assert.equal(/frame-ancestors[^;]*\*/.test(built.CONTENT_SECURITY_POLICY), false, 'frame-ancestors must contain no wildcard');
  // Allowing a script origin must never have relaxed the rest of script-src.
  assert.equal(/'unsafe-eval'/.test(built.CONTENT_SECURITY_POLICY), false, 'unsafe-eval must never be introduced');
});

test('headers file: the emitted syntax is what Cloudflare Pages actually parses', () => {
  // This file was previously emitted in a non-host syntax: descriptive prose as
  // an indented line, and headers left unindented. Nothing detected it, because
  // the then-target host ignored the file entirely, so it was never parsed by
  // anything. The grammar is: `#` comments, a non-indented path rule, and
  // indented headers beneath it.
  const text = fs.readFileSync(path.join(distDir, '_headers'), 'utf8');
  const lines = text.split(/\r?\n/);
  let current = null;
  let ruleCount = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      assert.notEqual(current, null, `_headers line ${i + 1} is indented with no rule above it: ${JSON.stringify(line)}`);
      assert.ok(line.includes(':'), `_headers line ${i + 1} is not "Name: value": ${JSON.stringify(line)}`);
    } else {
      current = line.trim();
      ruleCount += 1;
      assert.match(current, /^(\/\*|\/|\/assets\/\*|\*)$/, `unexpected path rule: ${current}`);
    }
  }
  // The catch-all rule is what protects the SPA document on every route.
  assert.ok(ruleCount >= 2, 'the file must declare the catch-all rule and the asset cache rule');
  // Every security header must be under an indented rule, i.e. actually bound
  // to a path, rather than floating as an unbound line.
  for (const header of built.SECURITY_HEADERS) {
    const pattern = new RegExp(`^\\s{2}${header.name}: `, 'm');
    assert.match(text, pattern, `${header.name} must be indented beneath a path rule`);
  }
});

test('csp: the build emitted the headers and the source-map policy', () => {
  if (!fs.existsSync(distDir)) assert.fail('production build not found');
  const headers = path.join(distDir, '_headers');
  assert.ok(fs.existsSync(headers), 'the build must emit dist/_headers');
  const text = fs.readFileSync(headers, 'utf8');
  assert.match(text, /Content-Security-Policy:/);
  assert.match(text, /frame-ancestors/);
  assert.ok(fs.existsSync(path.join(distDir, 'SOURCE_MAP_POLICY.txt')), 'the source-map decision must be recorded');
});

// ===========================================================================
// SPA routing
// ===========================================================================

test('spa: the build emits an explicit SPA fallback as a 200 rewrite, not a redirect', () => {
  // A 30x here would be a functional bug rather than a security one: the browser
  // URL would change, so reloading /pools would land on / and a deep link pasted
  // into the wallet's dApp frame would not round-trip. That is exactly the deep
  // route the clickjacking test relies on existing, so it is asserted.
  if (!fs.existsSync(distDir)) assert.fail('production build not found');
  const redirects = path.join(distDir, '_redirects');
  assert.ok(fs.existsSync(redirects), 'the build must emit dist/_redirects');
  const rules = fs
    .readFileSync(redirects, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  assert.deepEqual(rules, ['/*  /index.html  200']);
  for (const rule of rules) {
    assert.equal(/\s3\d\d\s/.test(rule), false, `the SPA fallback must not be a redirect: ${rule}`);
  }
});

test('spa: the redirects file carries no header rules, so it cannot weaken the policy', () => {
  // `_redirects` and `_headers` are separate grammars. A header smuggled into
  // `_redirects` would either be silently ignored by the host or, worse, be read
  // as a rule that changes which asset a path resolves to. The security policy
  // must live in exactly one file.
  const text = built.renderRedirectsFile();
  assert.doesNotMatch(text, /content-security-policy/i);
  assert.doesNotMatch(text, /x-frame-options/i);
  assert.doesNotMatch(text, /cross-origin/i);
  assert.doesNotMatch(text, /permissions-policy/i);
  assert.match(text, /#/, 'the generated file must explain itself in comments');
});

test('live-headers verifier: it refuses a non-https origin, because R-1 needs HTTPS', () => {
  // The verifier is the instrument used to close R-1. If it silently accepted an
  // http:// origin it would produce evidence that does not satisfy the risk.
  const script = path.join(appRoot, 'scripts', 'verify-live-headers.mjs');
  assert.ok(fs.existsSync(script), 'the live-header verifier must exist');
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /\/\^https:\\\/\\\/\/i\.test\(base\)/, 'the verifier must require an https origin');
  assert.match(text, /\/pools/, 'the verifier must probe a deep client-side route, not only /');
  assert.match(text, /X-Frame-Options|DELIBERATELY_OMITTED_HEADERS/, 'the verifier must check the deliberate omissions');
  assert.doesNotMatch(text, /method:\s*'POST'/, 'the verifier must stay read-only');
});

test('csp: no untrusted value can reach a style attribute', () => {
  // `style-src 'unsafe-inline'` is required because React sets layout styles.
  // That is only safe if no untrusted value ever becomes a style value, so the
  // only dynamic style values must be a bounded set of literals.
  const files = sourceFiles(srcRoot, ['.tsx']);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // Interpolations inside a style object must not reference a raw prop.
    const interpolations = [...text.matchAll(/style=\{\{[^}]*\}\}/gs)].flatMap((m) => [...m[0].matchAll(/\{([^{}]+)\}/g)].map((x) => x[1].trim()));
    for (const expression of interpolations) {
      assert.equal(
        /dangerouslySetInnerHTML|url\(|expression\(|javascript:/i.test(expression),
        false,
        `${path.relative(appRoot, file)} must not interpolate untrusted text into a style value: ${expression}`,
      );
    }
  }
});

// ===========================================================================
// SOURCE MAPS
// ===========================================================================

test('sourcemap: the publication decision is explicit and nothing depends on hiding source', () => {
  const viteConfig = fs.readFileSync(path.join(appRoot, 'vite.config.ts'), 'utf8');
  assert.match(viteConfig, /sourcemap:\s*true/, 'the source-map decision must be explicit in the build config');
  const policy = fs.readFileSync(path.join(distDir, 'SOURCE_MAP_POLICY.txt'), 'utf8');
  assert.match(policy, /not a security control/);
  assert.match(policy, /No security property in apps\/web relies on source obfuscation/);
  // And no code may try to hide behaviour behind minification.
  const files = sourceFiles(srcRoot, ['.ts', '.tsx']);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\beval\s*\(/.test(text), false, `${path.relative(appRoot, file)} must not use eval`);
    assert.equal(/new\s+Function\s*\(/.test(text), false, `${path.relative(appRoot, file)} must not construct functions from strings`);
  }
});

// ===========================================================================
// FIXTURE CONTAMINATION
// ===========================================================================

test('fixtures: the development gates are compile-time, not runtime-settable', () => {
  const config = fs.readFileSync(path.join(srcRoot, 'services', 'config.ts'), 'utf8');
  const code = config
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.match(code, /if \(wantsFixtures && !development\)/);
  assert.match(code, /if \(wantsDevProviders && !development\)/);
  // A production build cannot have `development === true`, because the value
  // is replaced from the build mode rather than read from the environment.
  const envSource = fs.readFileSync(path.join(srcRoot, 'services', 'envSource.ts'), 'utf8');
  assert.match(envSource, /declare const __OOTLE_ENV__/, 'the env bag must be injected at build time');
  assert.equal(/import\.meta\.env/.test(envSource), false, 'the env bag must not be read from the live environment');
});

test('fixtures: the production bundle cannot silently load fake data', () => {
  const text = bundleText();
  // The injected-pools path exists for the dev harness; it must be gated on a
  // value the app only receives when a host explicitly supplies pools.
  assert.equal(text.includes('__OOTLE_ENV__'), false, 'the env identifier must be replaced at build time');
  // And no fixture data literal may be baked into the bundle.
  for (const marker of ['FIXTURE_POOLS', 'FIXTURE_TRADES', 'FIXTURE_NFTS', 'mockCandles', 'demoTrades']) {
    assert.equal(text.includes(marker), false, `${marker} must not exist in the production bundle`);
  }
});

test('fixtures: with no discovery endpoint the app reports unavailable rather than empty-success', () => {
  const pools = fs.readFileSync(path.join(srcRoot, 'services', 'pools.ts'), 'utf8');
  assert.match(pools, /not fabricated|no pool list is invented|are not fabricated/i);
  const marketplace = fs.readFileSync(path.join(srcRoot, 'services', 'marketplace.ts'), 'utf8');
  assert.match(marketplace, /not fabricated/);
});

// ===========================================================================
// SECRET LEAKAGE IN THE BUILT ARTIFACT
// ===========================================================================

test('secrets: the built bundle contains no secret-bearing protocol code', () => {
  const text = bundleText();
  // The secret machinery is unreachable from the frontend and must not ship.
  for (const field of ['mintTerminalSettlementProof', 'verifyTerminalSettlementProof', 'CrossChainSecretStore']) {
    assert.equal(text.includes(field), false, `${field} must not appear in the built bundle`);
  }
  // The coordination entry points are likewise unreachable.
  for (const entry of ['revealAndClaim', 'beginL1Funding', 'acceptQuote', 'applyRouteEvent']) {
    assert.equal(text.includes(entry), false, `${entry} must not be reachable from the frontend`);
  }
});

test('secrets: preimage names may appear only as rejection rules, never with a value', () => {
  const text = bundleText();
  // `src/lib/storage.ts` ships in the bundle because it validates persisted
  // records, and validating a record means naming the fields it refuses. The
  // presence of the NAME is the defence working, not a leak. What must never
  // appear is the name together with secret MATERIAL, so the rule is checked
  // against the value rather than against the identifier.
  for (const name of ['preimageHex', 'walletPreimageHex']) {
    const occurrences = text.split(name).length - 1;
    assert.ok(occurrences <= 2, `${name} appears ${occurrences} times in the bundle; expected at most the denylist entries`);
  }
  // A denylist entry is a bare string. A value would be a hex secret, and no
  // 32-byte hex literal may be compiled into the artifact at all.
  const hexSecret = /[0-9a-fA-F]{64}/.exec(text);
  assert.equal(hexSecret, null, 'no 32-byte hex literal may be baked into the bundle');
  const barePreimageAssignment = /preimage\w*\s*[:=]\s*["'][0-9a-zA-Z]{16,}["']/.exec(text);
  assert.equal(barePreimageAssignment, null, 'a preimage field must never be initialised with a literal value');
});

test('secrets: no secret-shaped value is written to storage or a URL', () => {
  const files = sourceFiles(srcRoot, ['.ts', '.tsx']);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(appRoot, file).split(path.sep).join('/');
    // Only the detector/inventory modules may name these fields: one strips them
    // from error text, the other rejects records that carry them.
    if (relative === 'src/lib/storage.ts' || relative === 'src/lib/errorMessage.ts') continue;
    for (const forbidden of ['preimage', 'seedPhrase', 'mnemonic', 'privateKey']) {
      const hit = text
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
        .find((line) => line.includes(forbidden));
      assert.equal(hit, undefined, `${relative} must not reference ${forbidden}: ${hit ?? ''}`);
    }
    // No secret may reach a query string.
    assert.equal(/[?&](preimage|seed|mnemonic|privateKey)=/.test(text), false, `${relative} must not put a secret in a URL`);
  }
});

test('secrets: the history store writes only the declared key', () => {
  const history = fs.readFileSync(path.join(srcRoot, 'services', 'history.ts'), 'utf8');
  const storage = fs.readFileSync(path.join(srcRoot, 'lib', 'storage.ts'), 'utf8');
  // The key is declared once, in the inventory, and the store must use exactly it.
  assert.match(storage, /ootle\.operations\.v1/);
  assert.match(history, /ootle\.operations\.v1/);
  // Any other literal storage key would be an unreviewed write.
  const literalKeys = [...history.matchAll(/['"]([a-zA-Z0-9_.-]{3,})['"]\s*,\s*['"]ootle\.|\.([a-zA-Z0-9_.-]{3,})\s*$/gm)].length;
  assert.equal(literalKeys, 0, 'no undeclared storage key may appear in the history store');
  // sessionStorage must not be used at all.
  assert.equal(/sessionStorage/.test(history), false, 'operation state must not live in sessionStorage');
  assert.equal(/sessionStorage/.test(storage), false);
});

// ===========================================================================
// MULTI-TAB
// ===========================================================================

test('multi-tab: the client relies on durable protocol protections, not one tab', () => {
  // Two tabs submitting the same operation both create a durable record, so the
  // protection has to be the on-chain min_output / settlement proof, not a
  // client-side lock. Assert the app does not pretend otherwise: there is no
  // cross-tab lock, and the history store is the durable record.
  const files = sourceFiles(srcRoot, ['.ts', '.tsx']);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/BroadcastChannel|navigator\.locks|localStorage\.setItem\(['"]ootle\.lock/.test(text), false, 'no cross-tab lock is claimed');
  }
  const history = fs.readFileSync(path.join(srcRoot, 'services', 'history.ts'), 'utf8');
  assert.match(history, /operationId/, 'the durable identity is the operation id, which survives a reload and a second tab');
});

// ===========================================================================
// QUERY PARAMETERS AND DEEP LINKS
// ===========================================================================

test('deep-link: no query parameter or route param can enable a gate', () => {
  const files = sourceFiles(srcRoot, ['.ts', '.tsx']);
  const banned = /searchParams|useSearchParams|URLSearchParams|new URL\(.*location/;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const hit = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .find((line) => banned.test(line));
    assert.equal(hit, undefined, `${path.relative(appRoot, file)} must not read gate state from the URL: ${hit ?? ''}`);
  }
  // The submit gate is read only from the build-time env bag.
  const config = fs.readFileSync(path.join(srcRoot, 'services', 'config.ts'), 'utf8');
  assert.match(config, /export function realSubmitGate\(env: EnvBag/);
});

test('deep-link: a malformed route parameter fails cleanly rather than throwing', () => {
  // Route params are decoded by the router and reach components as strings; the
  // components must pass them through validation rather than trusting them.
  const render = fs.readFileSync(path.join(srcRoot, 'pages', 'PoolPage.tsx'), 'utf8');
  assert.match(render, /Pool not found/, 'an unknown pool must render a not-found state');
  // The page itself is a router; the identity boundary lives in the detail panel
  // that actually constructs actions.
  const detail = fs.readFileSync(path.join(srcRoot, 'components', 'NftDetailPanel.tsx'), 'utf8');
  assert.match(detail, /asRawExecutionAmount/, 'NFT identities are funnelled through the execution boundary');
  assert.match(detail, /createReview\(/, 'an NFT action must build a validated review');
  assert.match(detail, /liveIdentity/, 'an NFT action must re-verify the wallet identity before signing');
});

// ===========================================================================
// QUANTUM OF CONFIGURATION
// ===========================================================================

test('config: no user-controllable value can select mainnet', () => {
  const networks = fs.readFileSync(path.join(srcRoot, 'lib', 'networks.ts'), 'utf8');
  const code = networks
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n');
  // Mainnet appears only as a refusal.
  assert.match(code, /looksLikeMainnet/);
  assert.equal(/['"]mainnet['"]\s*:/.test(code), false, 'mainnet must not be a member of the network registry');
  const config = fs.readFileSync(path.join(srcRoot, 'services', 'config.ts'), 'utf8');
  assert.equal(/VITE_[A-Z_]*MAINNET/.test(config), false);
  // The only network source is the build-time env bag.
  const envSource = fs.readFileSync(path.join(srcRoot, 'services', 'envSource.ts'), 'utf8');
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(envSource), false, 'network selection must not be readable from storage');
});

test('manifest: the app ships an icon, so no browser gets a 404 for it', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'public', 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'the manifest must declare at least one icon');
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('http'), 'icons must be same-origin; a remote icon is a third-party fetch');
    const shipped = path.join(appRoot, 'public', icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(shipped), `${icon.src} is declared but not shipped`);
  }
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  assert.match(html, /rel="icon"/, 'index.html must declare a favicon');
  assert.match(html, /rel="manifest"/);
  assert.ok(fs.existsSync(path.join(distDir, 'icon.svg')), 'the icon must be present in the built artifact');
});

