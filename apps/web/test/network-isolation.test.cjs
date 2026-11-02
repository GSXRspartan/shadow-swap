require('./bootstrap.cjs');
/**
 * NETWORK ISOLATION, on the frontend side.
 *
 * The brief's thirteen isolation requirements split across two suites. The protocol-client ones
 * (identity, manifests, readiness, donation destinations) live in
 * `packages/protocol-client/test/network_identity.test.cjs`, `network_registry.test.cjs` and
 * `donations.test.cjs`. The ones that depend on this app's own wiring are here.
 *
 * The hazard they exist for is specific and was real: making mainnet representable means every
 * place that previously had "the two testnets" as an exhaustive set becomes a place where mainnet
 * can fall through to a testnet's configuration. One of those was `deploymentFor`, which returned
 * Esmeralda's recorded template addresses for any network that was not localnet.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const networks = require('../build-test/lib/networks.js');
const config = require('../build-test/services/config.js');
const deployment = require('../build-test/services/protocolDeployment.js');
const pc = require('@tari-ootle/protocol-client');

test('A MAINNET SESSION IS NEVER HANDED A TESTNET DEPLOYMENT', () => {
  // Isolation tests 1, 7 and 6, at the point they would actually have broken.
  const esmeralda = deployment.deploymentFor('esmeralda', 'PRE_V048_RESET');
  assert.ok(esmeralda.poolTemplates.length > 0, 'the pre-reset Esmeralda pool template is recorded');

  const mainnet = deployment.deploymentFor('mainnet', 'PRE_V048_RESET');
  assert.equal(mainnet.network, 'mainnet');
  assert.deepEqual(mainnet.poolTemplates, [], 'no mainnet pool template is recorded');
  assert.equal(mainnet.marketplaceTemplates, undefined);
  assert.deepEqual(mainnet.offerTemplates, []);
  assert.deepEqual(mainnet.revealedPoolTemplates, []);
  assert.match(mainnet.status, /has not launched/);
  // The registry key is distinct, so no cache entry is shared with a testnet.
  assert.notEqual(mainnet.registryKey, esmeralda.registryKey);
  assert.match(deployment.deploymentFor('mainnet', 'V048_RESET').registryKey, /^mainnet$/);

  // And Esmeralda's recorded template is NOT trusted on mainnet.
  for (const generation of ['PRE_V048_RESET', 'V048_RESET']) {
    const row = deployment.deploymentFor('mainnet', generation);
    for (const template of esmeralda.poolTemplates) {
      assert.equal(deployment.isTrustedPoolTemplate(row, template), false, `Esmeralda's pool template must not be trusted on mainnet (${generation})`);
    }
    assert.equal(deployment.poolKindOf(row, esmeralda.poolTemplates[0]), undefined);
  }
});

test('MAINNET LP OPERATIONS CANNOT USE TESTNET POOL ADDRESSES, through the execution seam', () => {
  // Isolation test 7. Nothing is trusted until a generation is verified for that network, and a
  // verification on one network does not verify another.
  deployment.resetVerifiedGenerations();
  assert.equal(deployment.activeDeployment('mainnet'), undefined, 'no generation verified for mainnet');
  assert.equal(deployment.activeDeployment('esmeralda'), undefined, 'nor for esmeralda');
});

test('AN UNKNOWN NETWORK FAILS CLOSED and never becomes a working default', () => {
  // Isolation test 3, with the specific bug this suite caught: falling back to the default
  // network for computability must not make an unrecognised setting EXECUTE as that default.
  const resolved = config.resolveConfig({ MODE: 'production', DEV: false, VITE_TARI_NETWORK: 'some-new-chain' });
  assert.ok(resolved.blocking.some((line) => /not a network this build knows/.test(line)), resolved.blocking.join(' | '));
  assert.equal(resolved.executionEnabled, false);
  assert.match(resolved.executionReason, /No fallback network is used for execution/);

  for (const bad of ['', '   ', 'esme', 'ESMERALDA_2', 'mainnet-2', 'tari-mainnet']) {
    const guard = networks.checkNetwork(bad);
    assert.equal(guard.ok, false, `"${bad}" must be refused`);
    assert.ok(typeof guard.reason === 'string' && guard.reason.length > 0);
  }
});

test('A MAINNET WALLET CANNOT SUBMIT A TESTNET TRANSACTION, nor the reverse', () => {
  // Isolation test 2 and 13: the wallet's reported network and the build's must agree before any
  // economic transaction is built, and a mismatch is refused with the reason stated.
  const validated = pc.validateManifest(
    {
      version: 1,
      network: 'esmeralda',
      generation: 'V048_RESET',
      expectNetworkByte: 0x26,
      templates: { AMM_POOLS: ['ab'.repeat(32)] },
      components: {},
      resources: [],
      status: 'fixture',
    },
    { network: 'esmeralda', networkByte: 0x26, generation: 'V048_RESET', version: '0.48.0' },
  ).manifest;

  const mismatched = pc.assessReadiness({
    layer: 'L2_OOTLE',
    network: 'esmeralda',
    chainIdentityVerified: true,
    walletNetwork: 'mainnet',
    manifest: validated,
    marketDataAvailable: true,
    tradingAuthorized: true,
  });
  assert.equal(mismatched.canExecute, false);
  assert.ok(mismatched.blockers.some((line) => /connected wallet reports mainnet/.test(line)));

  // The frontend's own wallet gate refuses a mainnet provider outright while execution is held.
  assert.equal(networks.checkNetwork('mainnet').ok, false);
  assert.equal(networks.isExecutionNetwork('mainnet'), false);
});

test('NETWORK CHANGES INVALIDATE STALE PREPARED TRANSACTION REVIEWS', () => {
  // Isolation test 11. Two independent mechanisms have to hold, and both are already load-bearing
  // in this app: the review's own fingerprint includes the network it was prepared for, and
  // `verifyIdentity` re-derives the wallet's identity at approval time and refuses a change.
  const review = require('../build-test/lib/review.js');
  const identity = require('../build-test/lib/executionIdentity.js');

  const base = {
    operationId: 'op-1',
    account: 'component_' + 'ab'.repeat(32),
    identity: { nonce: 'nonce-1' },
    legs: [{ kind: 'send', label: 'x' }],
    createdAtUnixMs: 1,
    walletRequest: {},
  };
  const onEsmeralda = review.reviewFingerprint({ ...base, network: 'esmeralda' });
  const onMainnet = review.reviewFingerprint({ ...base, network: 'mainnet' });
  assert.notEqual(onEsmeralda, onMainnet, 'the fingerprint binds a review to its network');
  // Same inputs, same fingerprint: the check is deterministic rather than merely noisy.
  assert.equal(onEsmeralda, review.reviewFingerprint({ ...base, network: 'esmeralda' }));

  // And at approval time, a wallet that has changed network voids the review by name.
  const provider = { tari_getAccounts: () => [] };
  const captured = identity.captureIdentity({
    provider,
    providerNetwork: 'esmeralda',
    expectedNetwork: 'esmeralda',
    account: base.account,
    nonce: 'nonce-1',
  });
  const unchanged = identity.verifyIdentity(captured, {
    provider,
    providerNetwork: 'esmeralda',
    account: base.account,
    nonce: 'nonce-1',
  });
  assert.equal(unchanged.ok, true, 'an unchanged wallet still approves');
  const moved = identity.verifyIdentity(captured, {
    provider,
    providerNetwork: 'mainnet',
    account: base.account,
    nonce: 'nonce-1',
  });
  assert.equal(moved.ok, false);
  assert.equal(moved.changed, 'network');
  assert.match(moved.reason, /network changed from "esmeralda" to "mainnet"/);
});

test('TESTNET RESETS DO NOT CORRUPT MAINNET SETTINGS', () => {
  // Isolation test 6, at the frontend's registry keys.
  const preReset = deployment.deploymentFor('esmeralda', 'PRE_V048_RESET');
  const postReset = deployment.deploymentFor('esmeralda', 'V048_RESET');
  assert.notEqual(preReset.registryKey, postReset.registryKey, 'each generation has its own key');
  assert.deepEqual(postReset.poolTemplates, [], 'the reset network starts with nothing recorded');
  assert.ok(preReset.poolTemplates.length > 0, 'and the pre-reset record is untouched');

  const mainnetKeys = new Set([
    deployment.deploymentFor('mainnet', 'PRE_V048_RESET').registryKey,
    deployment.deploymentFor('mainnet', 'V048_RESET').registryKey,
  ]);
  for (const key of [preReset.registryKey, postReset.registryKey]) {
    assert.equal(mainnetKeys.has(key), false, 'no key is shared between mainnet and a testnet');
  }
});

test('the CSP origin list contains no mainnet endpoint, because none is published', () => {
  // Ootle mainnet has no indexer, so `connect-src` cannot list one. This also keeps the shipped
  // header and the network table in agreement, which `deployment.test.cjs` asserts separately.
  for (const origin of networks.CONNECT_ALLOWED_ORIGINS) {
    assert.equal(/mainnet/i.test(origin), false, `${origin} must not be a mainnet origin`);
  }
  assert.deepEqual(networks.FRONTEND_NETWORKS.mainnet.indexerUrls, []);
  const resolved = config.resolveConfig({ MODE: 'production', DEV: false, VITE_TARI_NETWORK: 'mainnet' });
  assert.deepEqual(resolved.indexerUrls, [], 'a mainnet build reads from nothing');
});

test('a mainnet build is configured, held, and honest about both', () => {
  const resolved = config.resolveConfig({ MODE: 'production', DEV: false, VITE_TARI_NETWORK: 'mainnet' });
  assert.equal(resolved.network, 'mainnet');
  assert.equal(resolved.executionEnabled, false);
  assert.match(resolved.executionReason, /real-money execution on it has not been authorized/);
  assert.equal(networks.FRONTEND_NETWORKS.mainnet.badge, 'MAINNET');
  assert.equal(networks.FRONTEND_NETWORKS.mainnet.realValue, true);
  assert.equal(networks.FRONTEND_NETWORKS.esmeralda.realValue, false);
  // Real cross-chain submission is separately refused on mainnet, and stays refused even with the
  // environment gate set.
  assert.equal(config.realSubmitGate({ TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: '1' }, 'mainnet').enabled, false);
});
