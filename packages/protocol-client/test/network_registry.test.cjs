/**
 * The registry, manifests and readiness: the machinery that turns "which network is this" into
 * "may I act".
 *
 * The finding these tests pin down is that **Ootle L2 mainnet does not exist yet.** Upstream's
 * SDK has no mainnet indexer URL (`unimplemented!("MainNet indexer URL is not set")` at cohort
 * `6a25dbc`) and upstream's exchange-integration guide says "Ootle mainnet has not launched yet".
 * So the registry must know mainnet's identity and have no endpoint for it, and every layer above
 * must behave correctly in that state rather than treating an empty endpoint list as a bug.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const GEN = 'V048_RESET';

const manifest = (over = {}) => ({
  version: 2,
  network: 'esmeralda',
  generation: GEN,
  expectNetworkByte: 0x26,
  templates: { AMM_POOLS: ['ab'.repeat(32)] },
  components: {},
  resources: [],
  status: 'test fixture',
  ...over,
});

const observed = (over = {}) => ({
  network: 'esmeralda',
  networkByte: 0x26,
  generation: GEN,
  version: '0.48.0',
  ...over,
});

test('MINOTARI L1 MAINNET IS LIVE AND OOTLE L2 MAINNET IS NOT, which is the central asymmetry', () => {
  const l1 = pc.profileFor('L1_MINOTARI', 'mainnet');
  assert.equal(l1.ok, true);
  assert.equal(l1.profile.launched, true);
  assert.equal(l1.profile.nativeAsset, 'XTM');
  assert.equal(l1.profile.isTestnet, false);
  // No public L1 endpoint on ANY network: a Minotari wallet is reachable only over local gRPC.
  assert.deepEqual(l1.profile.endpoints, []);
  assert.match(l1.profile.endpointReason, /only over local gRPC/);
  assert.deepEqual(l1.profile.finality, { kind: 'CONFIRMATIONS', required: 3 });

  const l2 = pc.profileFor('L2_OOTLE', 'mainnet');
  assert.equal(l2.ok, true, 'mainnet is a KNOWN network; its identity is not hidden');
  assert.equal(l2.profile.launched, false);
  assert.equal(l2.profile.nativeAsset, 'TARI');
  assert.deepEqual(l2.profile.endpoints, [], 'no mainnet indexer is published, and none is invented');
  assert.match(l2.profile.endpointReason, /will not guess one/);
  assert.match(l2.profile.launchNote, /has not launched yet/);
  assert.match(l2.profile.launchNote, /unimplemented/);
  // Ootle is BFT-final, not confirmation-counted. The two layers settle differently.
  assert.deepEqual(l2.profile.finality, { kind: 'BFT_COMMITTED' });
  assert.equal(l2.profile.addressForm, 'bech32m, prefix otl_');

  // Esmeralda L2 is the one network with real endpoints.
  const esme = pc.profileFor('L2_OOTLE', 'esmeralda');
  assert.equal(esme.ok, true);
  assert.deepEqual(esme.profile.endpoints, [...pc.ESMERALDA_L2_ENDPOINTS]);
  assert.equal(esme.profile.launched, true);
});

test('a mixed-value chain pair is refused with its own reason', () => {
  assert.equal(pc.checkChainPair('esmeralda', 'esmeralda').ok, true);
  assert.equal(pc.checkChainPair('localnet', 'localnet').ok, true);

  // Both mainnet: a recorded pair, correctly unusable, because the L2 leg has nowhere to settle.
  const both = pc.checkChainPair('mainnet', 'mainnet');
  assert.equal(both.ok, false);
  assert.match(both.reason, /Ootle L2 mainnet has not launched/);

  // One side real, one side not: the worst case, and it gets its own message.
  const mixed = pc.checkChainPair('mainnet', 'esmeralda');
  assert.equal(mixed.ok, false);
  assert.match(mixed.reason, /one side carries real value and the other does not/);
  assert.match(pc.checkChainPair('esmeralda', 'mainnet').reason, /one side carries real value/);

  // An unrecorded, same-value pair is still refused: a pairing is never inferred.
  assert.equal(pc.checkChainPair('igor', 'esmeralda').ok, false);
  assert.match(pc.checkChainPair('igor', 'esmeralda').reason, /never inferred/);
});

test('A MANIFEST IS NOT AUTHORIZATION: chain identity is checked before anything is trusted', () => {
  const good = pc.validateManifest(manifest(), observed());
  assert.equal(good.ok, true);
  assert.deepEqual(good.enabled, ['AMM_POOLS']);

  // MISMATCHED CHAIN IDENTITY — isolation test 13, and the one that stops a testnet manifest
  // being used on mainnet.
  const wrongNetwork = pc.validateManifest(manifest({ network: 'mainnet', expectNetworkByte: 0x00 }), observed());
  assert.equal(wrongNetwork.rejection, 'MISMATCHED_CHAIN_IDENTITY');
  assert.match(wrongNetwork.reason, /Addresses do not cross networks/);

  // A manifest renamed but not re-pointed: the byte catches it.
  const wrongByte = pc.validateManifest(manifest({ expectNetworkByte: 0x00 }), observed());
  assert.equal(wrongByte.rejection, 'MISMATCHED_CHAIN_IDENTITY');
  assert.match(wrongByte.reason, /network byte 0x00 and the chain reports 0x26/);

  // UNSUPPORTED NETWORK GENERATION — a reset invalidates every address.
  const oldGeneration = pc.validateManifest(manifest({ generation: 'PRE_V048_RESET' }), observed());
  assert.equal(oldGeneration.rejection, 'UNSUPPORTED_NETWORK_GENERATION');
  assert.match(oldGeneration.reason, /none of these entries identifies anything on the live chain/);

  // MALFORMED is a different problem from "for the wrong chain", and is reported as such.
  assert.equal(pc.validateManifest({ version: 0 }, observed()).rejection, 'MALFORMED_MANIFEST');
  assert.equal(pc.validateManifest(manifest({ network: 'nope' }), observed()).rejection, 'MALFORMED_MANIFEST');
  assert.equal(pc.validateManifest(manifest({ templates: { NOT_A_FEATURE: [] } }), observed()).rejection, 'MALFORMED_MANIFEST');
  assert.equal(pc.validateManifest(manifest({ templates: { AMM_POOLS: ['nothex'] } }), observed()).rejection, 'MALFORMED_MANIFEST');
  assert.equal(pc.validateManifest('a string', observed()).rejection, 'MALFORMED_MANIFEST');
});

test('AN OLDER MANIFEST CANNOT SILENTLY OVERRIDE A NEWER VERIFIED ONE', () => {
  // Isolation test 4. Downgrade is the cheapest attack on a registry: re-serve yesterday's
  // manifest and a template that has since been withdrawn becomes trusted again.
  const current = pc.validateManifest(manifest({ version: 5 }), observed()).manifest;

  const older = pc.adoptManifest(current, manifest({ version: 4 }), observed());
  assert.equal(older.ok, false);
  assert.equal(older.rejection, 'STALE_MANIFEST_VERSION');
  assert.match(older.reason, /would become trusted again/);

  // Same version is accepted (an idempotent re-read), and newer is accepted.
  assert.equal(pc.adoptManifest(current, manifest({ version: 5 }), observed()).ok, true);
  assert.equal(pc.adoptManifest(current, manifest({ version: 6 }), observed()).ok, true);
  // A manifest for a DIFFERENT generation is not a downgrade of this one, so the version rule
  // does not apply across generations — it is caught by the generation check instead.
  assert.equal(pc.adoptManifest(current, manifest({ version: 1, generation: 'OTHER' }), observed()).rejection, 'UNSUPPORTED_NETWORK_GENERATION');
});

test('A MISSING TEMPLATE DISABLES ONLY THE AFFECTED FEATURE', () => {
  // Isolation test 5.
  const verdict = pc.validateManifest(manifest({ templates: { AMM_POOLS: ['ab'.repeat(32)], NFT_MARKETPLACE: ['cd'.repeat(32)] } }), observed());
  assert.equal(verdict.ok, true);
  assert.deepEqual([...verdict.enabled].sort(), ['AMM_POOLS', 'NFT_MARKETPLACE']);
  assert.equal(verdict.disabled.length, 3);
  assert.ok(verdict.disabled.every((line) => /Nothing else is affected/.test(line)));

  const m = verdict.manifest;
  assert.equal(pc.featureAvailability(m, 'AMM_POOLS').available, true);
  const missing = pc.featureAvailability(m, 'CROSS_LAYER_HTLC');
  assert.equal(missing.available, false);
  assert.match(missing.reason, /This feature is unavailable here; the rest of the application is unaffected/);
  // And with no manifest at all, nothing is trusted.
  assert.equal(pc.featureAvailability(undefined, 'AMM_POOLS').available, false);
  assert.match(pc.featureAvailability(undefined, 'AMM_POOLS').reason, /No deployment manifest has been validated/);

  assert.equal(pc.isTrustedTemplate(m, 'AMM_POOLS', 'ab'.repeat(32)), true);
  assert.equal(pc.isTrustedTemplate(m, 'AMM_POOLS', `template_${'ab'.repeat(32)}`), true, 'the prefix is optional');
  assert.equal(pc.isTrustedTemplate(m, 'AMM_POOLS', 'cd'.repeat(32)), false, 'a template trusted for one feature is not trusted for another');
  assert.equal(pc.isTrustedTemplate(m, 'CROSS_LAYER_HTLC', 'ab'.repeat(32)), false);
});

test('A DONATION ADDRESS CANNOT BE SUBSTITUTED THROUGH TOKEN METADATA', () => {
  // Isolation test 12. A manifest names resources with a provenance; a UI shows the manifest's
  // symbol and classification, never one read from a metadata document. And no manifest field is
  // ever a donation destination.
  const withResource = pc.validateManifest(
    manifest({
      resources: [
        { address: `resource_${'11'.repeat(32)}`, symbol: 'wSTABLE', decimals: 6, kind: 'public_fungible', provenance: 'live-verified 2026-10-13' },
      ],
    }),
    observed(),
  );
  assert.equal(withResource.ok, true);
  const entry = pc.trustedResource(withResource.manifest, `resource_${'11'.repeat(32)}`);
  assert.equal(entry.symbol, 'wSTABLE');
  assert.equal(entry.kind, 'public_fungible');
  // An unnamed resource is unknown, not assumed.
  assert.equal(pc.trustedResource(withResource.manifest, `resource_${'22'.repeat(32)}`), undefined);
  // A resource entry without provenance is malformed: "why is this trusted" is not optional.
  assert.equal(
    pc.validateManifest(
      manifest({ resources: [{ address: `resource_${'11'.repeat(32)}`, symbol: 'X', decimals: 6, kind: 'public_fungible', provenance: '' }] }),
      observed(),
    ).rejection,
    'MALFORMED_MANIFEST',
  );
  // The donation module refuses anything that is not one of its own configured destinations,
  // whatever a manifest or a metadata feed says.
  assert.throws(() => pc.assertDonationIsolation(`resource_${'11'.repeat(32)}`), /never comes from token metadata/);
  assert.throws(() => pc.assertDonationIsolation('wSTABLE'), /never comes from token metadata/);
  pc.assertDonationIsolation(pc.XTM_DONATION_ADDRESS_MAINNET);
});

test('MAINNET EXECUTION STAYS DISABLED WITHOUT EXPLICIT AUTHORIZATION', () => {
  // Isolation test 10, and the ladder's whole point: every check can pass and execution stays off.
  const everythingVerified = {
    layer: 'L2_OOTLE',
    network: 'esmeralda',
    chainIdentityVerified: true,
    walletNetwork: 'esmeralda',
    manifest: pc.validateManifest(manifest(), observed()).manifest,
    marketDataAvailable: true,
    tradingAuthorized: false,
  };
  const held = pc.assessReadiness(everythingVerified);
  assert.equal(held.stage, 'MARKET_DATA_READY');
  assert.equal(held.canExecute, false);
  assert.equal(held.canRead, true);
  assert.match(held.summary, /Execution is NOT enabled/);

  const authorized = pc.assessReadiness({ ...everythingVerified, tradingAuthorized: true });
  assert.equal(authorized.stage, 'TRADING_AUTHORIZED');
  assert.equal(authorized.canExecute, true);
  assert.deepEqual(authorized.blockers, []);

  // The requirement for the top rung says in so many words that it is not earned by a check.
  const top = pc.READINESS_REQUIREMENTS.find((row) => row.stage === 'TRADING_AUTHORIZED');
  assert.match(top.requires, /Not a date, not a build flag, not implied by any check above/);
});

test('the readiness ladder cannot be skipped: a later piece of evidence never covers a missing earlier one', () => {
  const validated = pc.validateManifest(manifest(), observed()).manifest;
  // A validated manifest and authorization, with nothing reachable: still the bottom rung.
  const unreachable = pc.assessReadiness({
    layer: 'L2_OOTLE',
    network: 'esmeralda',
    chainIdentityVerified: false,
    walletNetwork: 'esmeralda',
    manifest: validated,
    marketDataAvailable: true,
    tradingAuthorized: true,
  });
  assert.equal(unreachable.stage, 'NETWORK_CONFIGURED');
  assert.equal(unreachable.canExecute, false);
  assert.equal(unreachable.canRead, false);

  // A wallet on the wrong network stops the ladder, and the refusal says why it matters.
  const wrongWallet = pc.assessReadiness({
    layer: 'L2_OOTLE',
    network: 'esmeralda',
    chainIdentityVerified: true,
    walletNetwork: 'localnet',
    manifest: validated,
    marketDataAvailable: true,
    tradingAuthorized: true,
  });
  assert.equal(wrongWallet.stage, 'CHAIN_REACHABLE');
  assert.equal(wrongWallet.canExecute, false);
  assert.ok(wrongWallet.blockers.some((line) => /rejected at best and misdirected at worst/.test(line)));

  // Ootle mainnet: identity known, nothing readable, so it never leaves NETWORK_CONFIGURED even
  // with authorization set.
  const mainnet = pc.assessReadiness({
    layer: 'L2_OOTLE',
    network: 'mainnet',
    chainIdentityVerified: true,
    walletNetwork: 'mainnet',
    marketDataAvailable: true,
    tradingAuthorized: true,
  });
  assert.equal(mainnet.stage, 'NETWORK_CONFIGURED');
  assert.equal(mainnet.canExecute, false);
  assert.equal(mainnet.realValue, true);
  assert.ok(mainnet.blockers.some((line) => /has not launched/.test(line)));

  // An unknown network is the floor, and says so.
  const unknown = pc.assessReadiness({
    layer: 'L2_OOTLE',
    network: 'igor',
    chainIdentityVerified: true,
    marketDataAvailable: true,
    tradingAuthorized: true,
  });
  assert.equal(unknown.stage, 'NETWORK_UNKNOWN');
  assert.equal(unknown.canRead, false);

  assert.deepEqual(pc.READINESS_STAGES, [
    'NETWORK_UNKNOWN',
    'NETWORK_CONFIGURED',
    'CHAIN_REACHABLE',
    'WALLET_COMPATIBLE',
    'CONTRACTS_VERIFIED',
    'MARKET_DATA_READY',
    'TRADING_AUTHORIZED',
  ]);
});

test('an economic operation needs BOTH authorization and a deployed feature', () => {
  const validated = pc.validateManifest(manifest(), observed()).manifest;
  const authorized = pc.assessReadiness({
    layer: 'L2_OOTLE',
    network: 'esmeralda',
    chainIdentityVerified: true,
    walletNetwork: 'esmeralda',
    manifest: validated,
    marketDataAvailable: true,
    tradingAuthorized: true,
  });
  assert.equal(pc.canExecuteFeature(authorized, validated, 'AMM_POOLS').ok, true);
  // Authorized, but the feature is not deployed: a caller checking only authorization would
  // happily build a call to a template that does not exist.
  const noFeature = pc.canExecuteFeature(authorized, validated, 'CROSS_LAYER_HTLC');
  assert.equal(noFeature.ok, false);
  assert.match(noFeature.reason, /No CROSS_LAYER_HTLC template is recorded/);

  const held = pc.assessReadiness({
    layer: 'L2_OOTLE',
    network: 'esmeralda',
    chainIdentityVerified: true,
    walletNetwork: 'esmeralda',
    manifest: validated,
    marketDataAvailable: true,
    tradingAuthorized: false,
  });
  assert.equal(pc.canExecuteFeature(held, validated, 'AMM_POOLS').ok, false);
});

test('A TESTNET RESET DOES NOT CORRUPT MAINNET SETTINGS', () => {
  // Isolation test 6. A manifest is keyed by (network, generation), so an Esmeralda reset cannot
  // reach a mainnet entry: the two never share a key, and adopting one never consults the other.
  const esmeraldaV1 = pc.validateManifest(manifest({ version: 9 }), observed()).manifest;
  const mainnetManifest = manifest({ version: 1, network: 'mainnet', expectNetworkByte: 0x00, generation: 'MAINNET_GENESIS' });
  const mainnetObserved = observed({ network: 'mainnet', networkByte: 0x00, generation: 'MAINNET_GENESIS' });

  // Holding a version-9 Esmeralda manifest does not make a version-1 mainnet manifest stale: the
  // version rule applies only within one (network, generation).
  const adopted = pc.adoptManifest(esmeraldaV1, mainnetManifest, mainnetObserved);
  assert.equal(adopted.ok, true);
  assert.equal(adopted.manifest.network, 'mainnet');

  // And the reset Esmeralda generation cannot use the pre-reset one's entries.
  const preReset = pc.validateManifest(manifest({ generation: 'PRE_V048_RESET' }), observed({ generation: 'V048_RESET' }));
  assert.equal(preReset.rejection, 'UNSUPPORTED_NETWORK_GENERATION');
  // Mainnet's profile is unaffected by anything Esmeralda did.
  assert.equal(pc.profileFor('L2_OOTLE', 'mainnet').profile.launched, false);
});

test('MAINNET LP OPERATIONS CANNOT USE TESTNET POOL ADDRESSES', () => {
  // Isolation test 7. A component is trusted only through the manifest validated for the live
  // chain, so a pool recorded on Esmeralda is not a trusted component on mainnet.
  const pool = `component_${'ee'.repeat(32)}`;
  const esmeralda = pc.validateManifest(manifest({ components: { AMM_POOLS: [pool] } }), observed()).manifest;
  assert.equal(pc.isTrustedComponent(esmeralda, 'AMM_POOLS', pool), true);

  const mainnetManifest = pc.validateManifest(
    manifest({ network: 'mainnet', expectNetworkByte: 0x00, generation: 'MAINNET_GENESIS', components: {} }),
    observed({ network: 'mainnet', networkByte: 0x00, generation: 'MAINNET_GENESIS' }),
  ).manifest;
  assert.equal(pc.isTrustedComponent(mainnetManifest, 'AMM_POOLS', pool), false, 'an Esmeralda pool is not a mainnet pool');
  // And the Esmeralda manifest cannot be validated against mainnet at all.
  assert.equal(
    pc.validateManifest(manifest({ components: { AMM_POOLS: [pool] } }), observed({ network: 'mainnet', networkByte: 0x00 })).rejection,
    'MISMATCHED_CHAIN_IDENTITY',
  );
});
