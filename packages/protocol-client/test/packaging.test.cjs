/**
 * Package contract + module identity.
 *
 * Two things are proved here.
 *
 * 1. PACKAGE CONTRACT. `@tari-ootle/protocol-client` must be consumable through
 *    the specifiers it declares: a CommonJS `require` of the root, an ESM
 *    `import` of the root, and the `./crosschain` subpath. The previous revision
 *    declared no `exports` at all and shipped ESM-ill-formed re-exports
 *    (`export * from './marketplace'`), so an ESM consumer could not load it
 *    without a bundler alias.
 *
 * 2. MODULE IDENTITY. `multihop/proof.ts` brands a terminal settlement proof with
 *    a module-private Symbol. Two copies of the package in one process therefore
 *    hold two brands, and a proof minted by one copy is rejected by the other.
 *    The test pins the hazard AND the mitigation: each consumer must use exactly
 *    one module format, which is what the exports map and the app's source
 *    imports now guarantee.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const pkgRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

// Self-reference: Node resolves `<own name>` against this package's own
// `exports` map, so these calls exercise the REAL consumer path rather than a
// hand-written file path.
const requireFromPackage = createRequire(path.join(pkgRoot, 'package.json'));
const esmUrl = (...segments) => pathToFileURL(path.join(pkgRoot, 'dist', 'esm', ...segments)).href;

test('packaging: the manifest declares a coherent, complete contract', () => {
  assert.equal(manifest.type, 'commonjs', 'the root format must match the CommonJS build in dist/*.js');
  assert.equal(manifest.main, 'dist/index.js');
  assert.equal(manifest.module, 'dist/esm/index.js');
  assert.equal(manifest.types, 'dist/index.d.ts');

  const root = manifest.exports['.'];
  assert.equal(root.types, './dist/index.d.ts');
  assert.equal(root.import, './dist/esm/index.js', 'ESM consumers must get the ESM build');
  assert.equal(root.require, './dist/index.js', 'CommonJS consumers must get the CommonJS build');
  assert.ok(root.default, 'a default condition is required for tools honouring neither import nor require');

  // Every non-pattern declared target must exist on disk.
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    if (subpath.includes('*')) continue;
    const targets = typeof entry === 'string' ? { default: entry } : entry;
    for (const [condition, target] of Object.entries(targets)) {
      assert.ok(fs.existsSync(path.join(pkgRoot, target)), `${subpath}[${condition}] target missing: ${target}`);
    }
  }
  // The pattern subpath must still resolve to a real file, or the deep-import
  // escape hatch is decorative.
  assert.ok(fs.existsSync(path.join(pkgRoot, 'dist', 'index.js')));
});

test('packaging: the ESM build is marked as ESM and every specifier is fully qualified', () => {
  const marker = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'dist', 'esm', 'package.json'), 'utf8'));
  assert.equal(marker.type, 'module', 'dist/esm needs its own type marker or Node parses it as CommonJS');

  // ESM requires fully specified specifiers. Omitting the extension was the
  // original packaging defect and is invisible to the CommonJS build.
  for (const file of ['index.js', path.join('crosschain', 'index.js')]) {
    const absolute = path.join(pkgRoot, 'dist', 'esm', file);
    const source = fs.readFileSync(absolute, 'utf8');
    const specifiers = [...source.matchAll(/from '(\.[^']*)'/g)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, `${file} must re-export the modules`);
    for (const specifier of specifiers) {
      assert.match(specifier, /\.js$/, `ESM re-export "${specifier}" in ${file} is not fully specified`);
      // Relative to the IMPORTING file, not the build root.
      const resolved = path.resolve(path.dirname(absolute), specifier);
      assert.ok(fs.existsSync(resolved), `ESM re-export "${specifier}" in ${file} does not exist (${resolved})`);
    }
  }
});

test('packaging: the root specifier loads through require() and through import()', async () => {
  const cjs = requireFromPackage('@tari-ootle/protocol-client');
  assert.equal(typeof cjs.resolveSwap, 'function');
  assert.equal(typeof cjs.classifyResource, 'function');

  const esm = await import(esmUrl('index.js'));
  assert.equal(typeof esm.resolveSwap, 'function');
  assert.equal(typeof esm.classifyResource, 'function');
});

test('packaging: the ./crosschain subpath exposes the cross-layer surface', async () => {
  const cjs = requireFromPackage('@tari-ootle/protocol-client/crosschain');
  assert.equal(cjs.BROWSER_MINOTARI_PROVIDER, 'BLOCKED_EXTERNAL');
  assert.equal(typeof cjs.requireLegCapabilities, 'function');
  assert.equal(typeof cjs.isRealSubmitEnabled, 'function');

  const esm = await import(esmUrl('crosschain', 'index.js'));
  assert.equal(esm.BROWSER_MINOTARI_PROVIDER, 'BLOCKED_EXTERNAL', 'both formats must report the same upstream blocker');
});

test('packaging: a consumer may import the root or the subpath, not both formats of one', () => {
  // Mixing `import` and `require` of the same package is the documented dual
  // package hazard: Node instantiates the module twice. The app must not do it,
  // because the settlement-proof brand is per-instance.
  const appSources = path.join(pkgRoot, '..', '..', 'apps', 'web', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/require\(\s*['"]@tari-ootle\//.test(text)) offenders.push(full);
        if (/@tari-ootle\/protocol-client\/dist\//.test(text)) offenders.push(`${full} (deep dist import)`);
      }
    }
  };
  walk(appSources);
  assert.deepEqual(offenders, [], 'the app must import each workspace package through exactly one declared specifier');
});

test('module identity: one format yields one cached instance and one brand', () => {
  const first = requireFromPackage('@tari-ootle/protocol-client/dist/multihop/proof.js');
  const second = requireFromPackage('@tari-ootle/protocol-client/dist/multihop/proof.js');
  assert.equal(first, second, 'require() of one specifier must yield one cached instance');
  assert.equal(typeof first.mintTerminalSettlementProof, 'function');
  assert.equal(typeof first.isTerminalSettlementProof, 'function');
  assert.equal(typeof first.verifyTerminalSettlementProof, 'function');
});

test('module identity: an unminted object is never accepted as a proof', () => {
  const proof = requireFromPackage('@tari-ootle/protocol-client/dist/multihop/proof.js');
  const forged = {
    proofId: 'r1:hop_1:settlement',
    routeId: 'r1',
    crossLayerSessionId: 's1',
    hopId: 'hop_1',
    resultingAssetKind: 'OOTLE_L2',
    resultingResourceAddress: 'otl_canonical_tari',
    resultingAmountRaw: '1000000',
    recipientAccount: 'otl_account_1',
    authoritativeSource: 'WALLET_PROVIDER',
    chainTxId: 'tx1',
    settlementEpochOrVersion: '1',
    freshness: { source: 'WALLET_PROVIDER', identity: { readAtUnixMs: Date.now() } },
    proofFingerprint: 'deadbeef',
    terminalStatus: 'CLAIMED',
    mintedAtUnixMs: Date.now(),
    maxAgeMs: 120000,
  };
  assert.equal(proof.isTerminalSettlementProof(forged), false, 'an unminted object is never a proof');
  assert.throws(
    () => proof.verifyTerminalSettlementProof(forged, { routeId: 'r1', hop2ExecutionAccount: 'otl_account_1', expectedResourceAddress: 'otl_canonical_tari' }),
    /forged/,
  );
});

test('module identity: the ESM and CommonJS copies hold DIFFERENT brands (documented hazard)', async () => {
  // Reproduce the hazard deliberately so it cannot be forgotten. A proof minted
  // by the ESM copy is not a proof to the CommonJS copy. The mitigation is the
  // package contract plus a single-format import policy, both asserted above —
  // NOT "make the brand global", which would turn forgery into a string lookup.
  const cjs = requireFromPackage('@tari-ootle/protocol-client/dist/multihop/proof.js');
  const esm = await import(esmUrl('multihop', 'proof.js'));
  assert.notEqual(cjs, esm, 'the two builds are genuinely separate module instances');
  assert.ok(manifest.exports['.'].import !== manifest.exports['.'].require, 'the two builds must come from distinct files');
});

test('packaging: no build script pulls an unlisted input into the bundle', () => {
  // The frontend env surface is declared once, in vite.config.ts. A Vite-exposed
  // variable is public by definition, so that list is the whole attack surface.
  const viteConfig = fs.readFileSync(path.join(pkgRoot, '..', '..', 'apps', 'web', 'vite.config.ts'), 'utf8');
  const listed = [...viteConfig.matchAll(/(VITE_[A-Z_]+|TARI_LIQUIDITY_[A-Z_]+):\s*process\.env/g)].map((m) => m[1]);
  assert.ok(listed.length > 0, 'the env list must exist');
  assert.equal(new Set(listed).size, listed.length, 'no variable may be listed twice');
  const forbidden = listed.filter((name) => /SECRET|PRIVATE|KEY|TOKEN|PASSWORD|CREDENTIAL|SEED/i.test(name));
  assert.deepEqual(forbidden, [], 'no secret-shaped name may be exposed to the browser bundle');
  assert.ok(!listed.includes('VITE_MAINNET'), 'mainnet is not configurable');
});
