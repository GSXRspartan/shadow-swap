require('./bootstrap.cjs');
/**
 * Durable pool registry regressions.
 *
 * The registry lets a pool that has aged out of the receipt-scan window stay
 * discoverable by feeding its KNOWN component id back into the authoritative batch
 * substate read. The invariant under test: the registry contributes candidate
 * ADDRESSES only — every candidate is reverified from its own on-chain header, so a
 * stale, wrong-template, wrong-network, or corrupted-cache entry is dropped and can
 * never inject a displayed pool.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../build-test/services/poolRegistry.js');
const pools = require('../build-test/services/pools.js');

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

const POOL_TEMPLATE = 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab';
const OTHER_TEMPLATE = 'aa'.repeat(32);
const KNOWN_POOL = 'component_' + 'bc'.repeat(32);
const LIVE_BASE = 'https://ootle-indexer-a.tari.com';
const IDENTITY_OK = { version: '0.43.0', network: 'esmeralda', network_byte: 38, current_epoch: 11930 };

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    _dump: () => Object.fromEntries(map),
  };
}

function jsonResponse(payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { ok: true, status: 200, headers: new Headers(), text: async () => body };
}

/**
 * An indexer whose RECEIPTS are empty (so without the registry discovery is
 * DEPLOYED_EMPTY), but whose /substates/fetch answers for `presentComponents` with
 * the given template. This models a pool that aged out of the receipt window.
 */
function agedOutIndexer(presentComponents) {
  return async (url) => {
    const p = new URL(url).pathname;
    if (p === '/info') return jsonResponse(IDENTITY_OK);
    if (p === '/templates/catalogue') return jsonResponse({ entries: [{ template_address: POOL_TEMPLATE, template_name: 'Pool', author_public_key: '00'.repeat(32), binary_hash: '11'.repeat(32), at_epoch: 1 }] });
    if (p === '/transaction-receipts') return jsonResponse({ receipts: [] });
    if (p === '/substates/fetch') {
      const substates = {};
      for (const [id, tmpl] of Object.entries(presentComponents)) {
        substates[id] = { version: 3, substate: { Component: { header: { template_address: tmpl, owner_rule: 'None', access_rules: { method_access: {}, default: 'DenyAll' } }, body: { state: [{ '@cbor': 'map', entries: [] }, {}] } } } };
      }
      return jsonResponse({ substates });
    }
    return jsonResponse({});
  };
}

function discovery(storage) {
  // (url, expected, verify=default, transport=default(global fetch), storage)
  return new pools.IndexerPoolDiscovery(LIVE_BASE, { network: 'esmeralda', networkName: 'esmeralda' }, undefined, undefined, storage);
}

// --- pure registry functions ------------------------------------------------

test('registry: seed is a valid, network-scoped component set', () => {
  const seeds = registry.seedComponents('esmeralda');
  assert.ok(seeds.length >= 1);
  for (const s of seeds) assert.ok(registry.isComponentAddress(s));
  assert.deepEqual(registry.seedComponents('localnet'), []);
});

test('registry: corrupted or hostile cache yields only the valid subset, never throws', () => {
  const storage = fakeStorage({ 'ootle.poolRegistry.esmeralda': '{not json' });
  assert.deepEqual(registry.loadCachedComponents('esmeralda', storage), []);
  const storage2 = fakeStorage({ 'ootle.poolRegistry.esmeralda': JSON.stringify(['garbage', 123, KNOWN_POOL, '<script>']) });
  assert.deepEqual(registry.loadCachedComponents('esmeralda', storage2), [KNOWN_POOL]);
});

test('registry: cache is per-network (no cross-network leakage)', () => {
  const storage = fakeStorage({ 'ootle.poolRegistry.localnet': JSON.stringify([KNOWN_POOL]) });
  assert.deepEqual(registry.loadCachedComponents('esmeralda', storage), []);
  assert.deepEqual(registry.loadCachedComponents('localnet', storage), [KNOWN_POOL]);
});

test('registry: rememberDiscovered persists, dedups, and never stores the seed', () => {
  const storage = fakeStorage();
  const seed = registry.seedComponents('esmeralda')[0];
  registry.rememberDiscovered('esmeralda', [KNOWN_POOL, KNOWN_POOL, seed, 'bad'], storage);
  const cached = registry.loadCachedComponents('esmeralda', storage);
  assert.deepEqual(cached, [KNOWN_POOL], 'only the new valid non-seed component is cached');
});

// --- end-to-end discovery with the registry ---------------------------------

test('discovery: a known pool aged out of receipts is still found via the registry', async () => {
  globalThis.fetch = agedOutIndexer({ [KNOWN_POOL]: POOL_TEMPLATE });
  const storage = fakeStorage({ 'ootle.poolRegistry.esmeralda': JSON.stringify([KNOWN_POOL]) });
  const result = await discovery(storage).discover();
  assert.equal(result.state, 'PROTOCOL_AVAILABLE');
  assert.ok(result.candidates.some((c) => c.componentAddress === KNOWN_POOL), 'the aged-out known pool is rediscovered');
});

test('discovery: a stale known id that no longer exists on chain is dropped', async () => {
  globalThis.fetch = agedOutIndexer({}); // substates/fetch returns nothing for it
  const storage = fakeStorage({ 'ootle.poolRegistry.esmeralda': JSON.stringify([KNOWN_POOL]) });
  const result = await discovery(storage).discover();
  assert.equal(result.state, 'PROTOCOL_DEPLOYED_EMPTY');
  assert.deepEqual(result.candidates, []);
});

test('discovery: a known id whose on-chain template is not Pool is dropped', async () => {
  globalThis.fetch = agedOutIndexer({ [KNOWN_POOL]: OTHER_TEMPLATE });
  const storage = fakeStorage({ 'ootle.poolRegistry.esmeralda': JSON.stringify([KNOWN_POOL]) });
  const result = await discovery(storage).discover();
  assert.equal(result.state, 'PROTOCOL_DEPLOYED_EMPTY');
  assert.deepEqual(result.candidates, []);
});

test('discovery: a reverified pool is persisted back to the cache', async () => {
  globalThis.fetch = agedOutIndexer({ [KNOWN_POOL]: POOL_TEMPLATE });
  const storage = fakeStorage({ 'ootle.poolRegistry.esmeralda': JSON.stringify([KNOWN_POOL]) });
  await discovery(storage).discover();
  assert.ok(registry.loadCachedComponents('esmeralda', storage).includes(KNOWN_POOL));
});
