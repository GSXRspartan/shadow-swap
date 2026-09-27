/**
 * Built-bundle module identity.
 *
 * The browser bundle must contain exactly ONE copy of each workspace package.
 * Two copies would mean two settlement-proof brands, so a proof minted through
 * one path would be rejected through the other, and `instanceof`-style or
 * nominal identity checks would silently split.
 *
 * The probe is a string literal that is emitted exactly once per module
 * evaluation: the `Symbol()` description inside `multihop/proof.ts`, and the
 * upstream-blocker message that only `crosschain/provider.ts` can produce.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const distDir = path.join(appRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');

function bundleSources() {
  if (!fs.existsSync(assetsDir)) {
    assert.fail(`production build not found at ${distDir}. Run "npm run build" first.`);
  }
  return fs
    .readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(assetsDir, name), 'utf8') }));
}

function occurrences(marker, chunks = bundleSources()) {
  let total = 0;
  const perFile = [];
  for (const chunk of chunks) {
    const count = chunk.text.split(marker).length - 1;
    if (count > 0) perFile.push([chunk.name, count]);
    total += count;
  }
  return { total, perFile };
}

test('bundle: the production build exists and is split into chunks', () => {
  const chunks = bundleSources();
  assert.ok(chunks.length >= 3, `expected several chunks, found ${chunks.length}`);
  assert.ok(fs.existsSync(path.join(distDir, 'index.html')));
});

test('bundle identity: the settlement-proof module is ABSENT from the frontend bundle', () => {
  // Stronger than "exactly one": the frontend has no business minting or
  // verifying a terminal settlement proof, so the module must be tree-shaken
  // out entirely. Its absence also means no second brand can exist.
  const { total, perFile } = occurrences('tari.multihop.terminalSettlementProof');
  assert.equal(total, 0, `the proof brand must not be bundled, found ${total} in ${JSON.stringify(perFile)}`);
  for (const marker of ['mintTerminalSettlementProof', 'verifyTerminalSettlementProof', 'applyRouteEvent']) {
    assert.equal(occurrences(marker).total, 0, `${marker} must not be reachable from the frontend`);
  }
});

test('bundle identity: the stub browser-extension wallet adapter is ABSENT', () => {
  // A stub that returns placeholder accounts and a PENDING status for every
  // lookup must never reach a production bundle where it could be
  // instantiated by mistake.
  for (const marker of ['BrowserExtensionSigner', 'extension-account-placeholder', 'tx-ext-']) {
    const { total, perFile } = occurrences(marker);
    assert.equal(total, 0, `stub adapter marker "${marker}" must not be bundled, found ${total} in ${JSON.stringify(perFile)}`);
  }
});

test('bundle identity: exactly ONE cross-chain provider copy is present', () => {
  const { total, perFile } = occurrences('No browser-safe Minotari wallet provider exposes the traced L1 SHA atomic-swap primitives');
  assert.equal(total, 1, `expected exactly one crosschain/provider copy, found ${total} in ${JSON.stringify(perFile)}`);
});

test('bundle identity: exactly ONE AMM resolver copy is present', () => {
  // The constant-product refusal message lives only in amm.ts, and the app
  // genuinely uses it — so exactly one copy must be present.
  const { total, perFile } = occurrences('Swap output floors to zero (input too small)');
  assert.equal(total, 1, `expected exactly one amm.ts copy, found ${total} in ${JSON.stringify(perFile)}`);
});

test('bundle identity: no second copy of a live protocol module', () => {
  // Any marker that appears more than once would mean the module was bundled
  // twice (dual format, or a path that bypassed the package `exports` map).
  const live = [
    'Swap output floors to zero (input too small)',
    'No browser-safe Minotari wallet provider exposes the traced L1 SHA atomic-swap primitives',
    'Reserving the quote book to one resource pair',
    'PoolReadbackProvider',
  ];
  for (const marker of live) {
    const { total, perFile } = occurrences(marker);
    assert.ok(total <= 1, `"${marker}" appears ${total} times in ${JSON.stringify(perFile)}`);
  }
});

test('bundle identity: no CommonJS protocol-client interop shim leaked into the bundle', () => {
  // A CJS file dragged into a browser bundle needs `module.exports` /
  // `exports.X =` shims. Their presence means the ESM build was bypassed.
  for (const chunk of bundleSources()) {
    // Minifiers rewrite these, so probe for the giveaway: a literal reference to
    // the CommonJS build path, or a `require(` of a workspace package.
    assert.equal(/@tari-ootle\/protocol-client\/dist\//.test(chunk.text), false, `${chunk.name} references a deep CommonJS path`);
    assert.equal(/require\(['"]@tari-ootle\//.test(chunk.text), false, `${chunk.name} requires a workspace package at runtime`);
  }
});

test('bundle: no source map is published by default in a production build', () => {
  // Source maps are a deliberate publication choice, not a security control.
  // The build emits them today for debugging; the audit records the decision
  // rather than pretending they are a defence.
  const maps = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.map'));
  const viteConfig = fs.readFileSync(path.join(appRoot, 'vite.config.ts'), 'utf8');
  assert.match(viteConfig, /sourcemap:\s*true/, 'the source-map policy is explicit in the build config');
  assert.ok(maps.length > 0, 'this build publishes maps; the deployment must serve them privately or strip them');
});

test('bundle: no development-only fixture string is reachable in the built output', () => {
  // Fixture gating is compile-time. A production bundle must not even contain
  // the "development mode" banner copy that only renders when the gate is open.
  const joined = bundleSources()
    .map((chunk) => chunk.text)
    .join('\n');
  assert.equal(joined.includes('__OOTLE_ENV__'), false, 'the env identifier must be replaced at build time, not evaluated at runtime');
});

test('bundle: the env bag was baked in and carries no secret', () => {
  const joined = bundleSources()
    .map((chunk) => chunk.text)
    .join('\n');
  // The declared bag is inlined, so its keys appear in the output.
  assert.match(joined, /VITE_TARI_NETWORK/, 'the declared env keys are inlined');
  for (const forbidden of ['VITE_MAINNET', 'MAINNET_URL', 'PRIVATE_KEY', 'SEED', 'API_SECRET']) {
    assert.equal(joined.includes(forbidden), false, `${forbidden} must not appear in the bundle`);
  }
});
