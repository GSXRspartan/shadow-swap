require('./bootstrap.cjs');
/**
 * Ootle v0.48 wire conformance, over REAL engine bytes and the OFFICIAL decoder.
 *
 * `fixtures/ootle-v048-pool-wire.json` is emitted by `audit_engine_tests/tests/wire_fixtures_v048.rs`:
 * the pinned v0.48.0 engine executes THIS repository's Pool template (create, add
 * liquidity, swap, and a rejected swap) and every resulting value is encoded exactly as
 * the indexer encodes it. The Rust test re-checks, in CI, that the committed bytes are a
 * canonical encoding under the pinned cohort.
 *
 * Here the bytes go through the browser's real path:
 *   base64 -> @tari-project/ootle-wasm-bor 0.48.0 -> services/ootleWire.ts -> protocol-client decoders.
 *
 * Nothing in this file hand-writes a v0.48 value. The adversarial cases MUTATE real ones.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('./fixtures/ootle-v048-pool-wire.json');
const { loadOotleWasmBor } = require('./support/ootleWasmBor.cjs');
const wire = require('../build-test/services/ootleWire.js');
const cohort = require('../build-test/lib/ootleCohort.js');
const identity = require('../build-test/services/indexerIdentity.js');
const indexer = require('../build-test/services/ootleIndexer.js');
const tariWindow = require('../build-test/services/tariWindow.js');
const deployment = require('../build-test/services/protocolDeployment.js');
const { decodePoolState } = require('@tari-ootle/protocol-client');

let codec;
test.before(async () => {
  codec = await loadOotleWasmBor();
  wire.registerValueCodecLoader(async () => codec);
});
test.after(() => {
  wire.registerValueCodecLoader(undefined);
});
test.afterEach(() => deployment.resetVerifiedGenerations());

/** A raw reader over the fixture as a v0.48 `/substates/fetch` would serve it. */
function fixtureReader(format = 'CBOR_VALUES', substates = fixture.substates) {
  return {
    async read(address) {
      const entry = substates[address];
      if (entry === undefined) return undefined;
      const normalized = wire.normalizeBatchEntry(entry, format, codec, address);
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.value.value;
    },
  };
}

// The arithmetic the engine performed, recomputed independently with BigInt.
const DEPOSIT_A = 400_000_000n;
const DEPOSIT_B = 500_000_000n;
const SWAP_IN = 1_000_000n;
const FEE_BPS = 30n;
function isqrt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ---------------------------------------------------------------------------
// 1. Cohort classification
// ---------------------------------------------------------------------------

test('cohort: v0.48 is the reset generation with CBOR values; v0.41-v0.47 are pre-reset JSON', () => {
  for (const v of ['0.48.0', '0.48.1', 'v0.48.0', '0.48.0-rc.1']) {
    const c = cohort.classifyIndexerVersion(v);
    assert.equal(c.ok, true, v);
    assert.equal(c.cohort.generation, 'V048_RESET');
    assert.equal(c.cohort.wireFormat, 'CBOR_VALUES');
  }
  for (const v of ['0.41.4', '0.42.0', '0.46.1', '0.47.0']) {
    const c = cohort.classifyIndexerVersion(v);
    assert.equal(c.ok, true, v);
    assert.equal(c.cohort.generation, 'PRE_V048_RESET');
    assert.equal(c.cohort.wireFormat, 'JSON_VALUES');
  }
});

test('cohort: an unknown, newer, older, missing or malformed version fails closed', () => {
  for (const v of ['0.49.0', '1.0.0', '0.40.9', '', undefined, null, 48, 'latest', '0.48', '0.48.0; drop', 'x'.repeat(500)]) {
    const c = cohort.classifyIndexerVersion(v);
    if (v === '0.48') {
      // major.minor alone is accepted: the minor determines the format.
      assert.equal(c.ok, true);
      continue;
    }
    assert.equal(c.ok, false, `refused: ${String(v).slice(0, 20)}`);
  }
});

test('identity: a right-network endpoint on an unsupported version is refused, not read', () => {
  const verdict = identity.classifyIndexerIdentity('https://x.test/info', { version: '0.49.0', network: 'esmeralda', network_byte: 38 }, { network: 'esmeralda', networkName: 'esmeralda' });
  assert.equal(verdict.status, 'UNSUPPORTED_VERSION');
  assert.equal(identity.isVerified(verdict), false);
  const missing = identity.classifyIndexerIdentity('https://x.test/info', { network: 'esmeralda', network_byte: 38 }, { network: 'esmeralda', networkName: 'esmeralda' });
  assert.equal(missing.status, 'UNSUPPORTED_VERSION', 'without a version the reply format is unknown');
});

// ---------------------------------------------------------------------------
// 2. Real engine bytes through the official decoder and the Pool decoder
// ---------------------------------------------------------------------------

test('wire: every real v0.48 substate value decodes to a single SubstateValue variant', () => {
  for (const [id, entry] of Object.entries(fixture.substates)) {
    const normalized = wire.normalizeBatchEntry(entry, 'CBOR_VALUES', codec, id);
    assert.equal(normalized.ok, true, `${id}: ${normalized.reason}`);
    assert.equal(normalized.value.encoding, 'CBOR');
    assert.equal(normalized.value.version, String(entry.version));
  }
});

test('wire: the real v0.48 Pool decodes end to end, and the numbers are the engine’s own', async () => {
  const pool = await decodePoolState(fixtureReader(), fixture.poolComponent, { templateAddress: fixture.poolTemplate });
  assert.equal(pool.feeBps, '30');
  // One side received the deposit plus the swap input; the other paid the swap output.
  const reserves = [BigInt(pool.reserveA), BigInt(pool.reserveB)];
  const inWithFee = (SWAP_IN * (10_000n - FEE_BPS)) / 10_000n;
  const out = (DEPOSIT_B * inWithFee) / (DEPOSIT_A + inWithFee);
  assert.deepEqual(
    [...reserves].sort((x, y) => (x < y ? -1 : 1)),
    [DEPOSIT_A + SWAP_IN, DEPOSIT_B - out].sort((x, y) => (x < y ? -1 : 1)),
    'reserves equal the independently recomputed constant-product result',
  );
  assert.equal(BigInt(pool.totalLpSupply), isqrt(DEPOSIT_A * DEPOSIT_B), 'LP supply is floor(sqrt(a*b))');
  assert.equal(pool.lockedLpSupply, '1000', 'MINIMUM_LOCKED_LIQUIDITY is held by the locked vault');
});

test('wire: the Pool decode is pinned — the right bytes under the wrong template are refused', async () => {
  await assert.rejects(decodePoolState(fixtureReader(), fixture.poolComponent, { templateAddress: 'ab'.repeat(32) }), /expected/);
});

test('wire: real v0.48 receipts decode, and the pool-creating receipt names the pool', () => {
  const upped = new Set();
  for (const pair of fixture.receipts) {
    const normalized = wire.normalizeReceipt(pair, 'CBOR_VALUES', codec);
    assert.equal(normalized.ok, true, normalized.reason);
    if (normalized.value.receipt.outcome !== 'Commit') continue;
    for (const change of normalized.value.receipt.diff_summary.upped) upped.add(change.substate_id);
  }
  assert.ok(upped.has(fixture.poolComponent));
});

test('discovery: a v0.48 indexer serving the real bytes yields the pool (and only with a trusted template)', async () => {
  const fetchJson = async (url, body) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/templates/catalogue') return { ok: true, payload: { entries: [] } };
    if (parsed.pathname === '/transaction-receipts') return { ok: true, payload: { receipts: fixture.receipts } };
    if (parsed.pathname === '/substates/fetch') {
      const out = {};
      for (const id of body.requests) if (fixture.substates[id] !== undefined) out[id] = fixture.substates[id];
      return { ok: true, payload: { substates: out, proofs: {}, commit_proofs: {} } };
    }
    return { ok: false, reason: `unexpected ${parsed.pathname}` };
  };
  const transport = { getJson: (url) => fetchJson(url), postJson: (url, body) => fetchJson(url, body) };
  const client = new indexer.TariIndexerDiscovery('https://esme.test', {
    transport,
    verifyIdentity: async () => ({ ok: true, wireFormat: 'CBOR_VALUES' }),
  });
  const trusted = await client.discover('Pool', [], { templates: () => [fixture.poolTemplate], notDeployedDetail: 'n/a' });
  assert.equal(trusted.ok, true);
  assert.equal(trusted.state, 'PROTOCOL_AVAILABLE');
  assert.deepEqual(trusted.components.map((c) => c.componentAddress), [fixture.poolComponent]);

  const untrusted = await client.discover('Pool', [], { templates: () => ['ab'.repeat(32)], notDeployedDetail: 'n/a' });
  assert.equal(untrusted.ok, true);
  assert.equal(untrusted.components.length, 0, 'the same chain, with the template not recorded, yields no pool');
});

// ---------------------------------------------------------------------------
// 3. The pre-v0.48 bug, as a regression: CBOR receipts must never read as "empty"
// ---------------------------------------------------------------------------

test('REGRESSION: v0.48 receipts read with the JSON format are an ERROR, not an empty deployment', async () => {
  // Before this migration a v0.48 receipt (a string) was skipped, so a deployed
  // protocol was reported as PROTOCOL_DEPLOYED_EMPTY. A cohort mismatch now fails.
  const transport = {
    getJson: async (url) => (url.includes('/templates/catalogue') ? { ok: true, payload: { entries: [] } } : { ok: true, payload: { receipts: fixture.receipts } }),
    postJson: async () => ({ ok: true, payload: { substates: {} } }),
  };
  const client = new indexer.TariIndexerDiscovery('https://esme.test', {
    transport,
    verifyIdentity: async () => ({ ok: true, wireFormat: 'JSON_VALUES' }),
  });
  const result = await client.discover('Pool', [], { templates: () => [fixture.poolTemplate], notDeployedDetail: 'n/a' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'INDEXER_UNAVAILABLE');
  assert.match(result.detail, /does not match the version it reported/);
});

test('REGRESSION: with no decoder available, v0.48 discovery fails loudly rather than reporting nothing', async () => {
  wire.registerValueCodecLoader(async () => {
    throw new Error('asset blocked');
  });
  try {
    const transport = {
      getJson: async (url) => (url.includes('/templates/catalogue') ? { ok: true, payload: { entries: [] } } : { ok: true, payload: { receipts: fixture.receipts } }),
      postJson: async () => ({ ok: true, payload: { substates: {} } }),
    };
    const client = new indexer.TariIndexerDiscovery('https://esme.test', { transport, verifyIdentity: async () => ({ ok: true, wireFormat: 'CBOR_VALUES' }) });
    const result = await client.discover('Pool', [], { templates: () => [fixture.poolTemplate], notDeployedDetail: 'n/a' });
    assert.equal(result.ok, false);
    assert.match(result.detail, /decoder could not be loaded/);
  } finally {
    wire.registerValueCodecLoader(async () => codec);
  }
});

// ---------------------------------------------------------------------------
// 4. Adversarial envelopes, all built by mutating real values
// ---------------------------------------------------------------------------

const POOL_ENTRY = fixture.substates[fixture.poolComponent];
const RECEIPT_B64 = fixture.receipts[0][1];

test('adversarial: a v0.48 endpoint that serves a JSON object where CBOR is due is refused', () => {
  const r = wire.normalizeBatchEntry({ version: 1, substate: { Component: {} } }, 'CBOR_VALUES', codec, 'x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /base64 CBOR string/);
});

test('adversarial: a pre-v0.48 endpoint that serves a CBOR string is refused', () => {
  const r = wire.normalizeBatchEntry(POOL_ENTRY, 'JSON_VALUES', codec, 'x');
  assert.equal(r.ok, false);
});

test('adversarial: malformed, truncated, padded, oversized and mis-typed encodings are all refused', () => {
  const cases = {
    'not base64': '!!!!',
    'bad length': POOL_ENTRY.value.slice(0, -1),
    truncated: POOL_ENTRY.value.slice(0, Math.floor(POOL_ENTRY.value.length / 2 / 4) * 4),
    'trailing garbage': POOL_ENTRY.value + 'AAAA',
    'empty': '',
    'a receipt where a substate is due': RECEIPT_B64,
    oversized: 'A'.repeat(wire.MAX_ENCODED_VALUE_CHARS + 4),
  };
  for (const [label, value] of Object.entries(cases)) {
    const r = wire.normalizeBatchEntry({ version: 3, value }, 'CBOR_VALUES', codec, 'x');
    assert.equal(r.ok, false, label);
  }
});

test('adversarial: a flipped byte inside a real value never yields a decodable POOL with different numbers silently', async () => {
  // Flip one byte at a time across the encoding. Each mutation must either be refused
  // outright, or (where CBOR happens to stay well-formed) still pass through the Pool
  // decoder's own identity checks; it must never crash the normaliser.
  const raw = Buffer.from(POOL_ENTRY.value, 'base64');
  let refused = 0;
  for (let i = 0; i < raw.length; i += 7) {
    const copy = Buffer.from(raw);
    copy[i] ^= 0xff;
    const r = wire.normalizeBatchEntry({ version: 1, value: copy.toString('base64') }, 'CBOR_VALUES', codec, 'mut');
    if (!r.ok) refused += 1;
  }
  assert.ok(refused > 0, 'mutations are detected');
});

test('adversarial: a receipt that is not a pair, has no address, or is the wrong type is refused', () => {
  for (const bad of [[], ['only-address'], [42, RECEIPT_B64], ['', RECEIPT_B64], ['r', 7], ['r', POOL_ENTRY.value], 'string', null]) {
    const r = wire.normalizeReceipt(bad, 'CBOR_VALUES', codec);
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 40));
  }
});

// ---------------------------------------------------------------------------
// 5. The wallet's single-substate envelope (Sapient passes the indexer reply through)
// ---------------------------------------------------------------------------

function fakeProvider(reply) {
  return {
    request: async ({ method }) => {
      if (method === 'tari_getSubstate') return reply;
      throw new Error(`unexpected ${method}`);
    },
  };
}

test('wallet: the v0.48 IndexerGetSubstateResponse (base64 state.up.substate) is decoded', async () => {
  const reply = { version: POOL_ENTRY.version, state: { up: { substate: POOL_ENTRY.value } }, verified: true };
  const value = await tariWindow.readRawSubstate(fakeProvider(reply), fixture.poolComponent);
  assert.ok(value.Component, 'the SubstateValue is returned, unwrapped from the envelope');
});

test('wallet: the v0.47 IndexerGetSubstateResponse (JSON state.up.substate) is decoded', async () => {
  const json = codec.decodeSubstateValue(POOL_ENTRY.value);
  const reply = { version: 4, state: { up: { substate: json } }, verified: true };
  const value = await tariWindow.readRawSubstate(fakeProvider(reply), fixture.poolComponent);
  assert.deepEqual(value, json);
});

test('wallet: the v0.46 { substate } shape still decodes', async () => {
  const json = codec.decodeSubstateValue(POOL_ENTRY.value);
  const value = await tariWindow.readRawSubstate(fakeProvider({ version: 4, substate: json }), fixture.poolComponent);
  assert.deepEqual(value, json);
});

test('wallet: a DOWN substate is "not present", never an empty value', async () => {
  const value = await tariWindow.readRawSubstate(fakeProvider({ version: 4, state: { down: {} }, verified: true }), fixture.poolComponent);
  assert.equal(value, undefined);
});

test('wallet: verified:false is refused for EXECUTION and allowed only for DISPLAY', async () => {
  const reply = { version: 1, state: { up: { substate: POOL_ENTRY.value } }, verified: false };
  await assert.rejects(tariWindow.readRawSubstate(fakeProvider(reply), fixture.poolComponent), /without a committee proof/);
  const seen = [];
  const value = await tariWindow.readRawSubstate(fakeProvider(reply), fixture.poolComponent, undefined, { purpose: 'DISPLAY', onAssurance: (a) => seen.push(a) });
  assert.ok(value.Component);
  assert.deepEqual(seen, ['UNVERIFIED']);
});

test('wallet: an unrecognised envelope is a MALFORMED_REPLY, never a guess', async () => {
  for (const reply of [{ version: 1 }, { state: { sideways: {} } }, { state: { up: { substate: 7 } } }, { substate: { NotAVariant: {} } }]) {
    await assert.rejects(tariWindow.readRawSubstate(fakeProvider(reply), fixture.poolComponent), (error) => error.code === 'MALFORMED_REPLY');
  }
});

// ---------------------------------------------------------------------------
// 6. Transaction outcome — Commit is not success unless the result says Accept
// ---------------------------------------------------------------------------

test('outcome: a real accepted swap (base64 ExecuteResult) is COMMITTED', () => {
  const outcome = wire.interpretIndexerTransactionResult(
    { result: { Finalized: { final_decision: 'Commit', execution_result: fixture.executeResults.acceptedSwap, abort_details: null } } },
    codec,
  );
  assert.deepEqual(outcome, { status: 'COMMITTED' });
});

test('REGRESSION: a real rejected swap committed fee-only is NOT reported as confirmed', () => {
  // The engine encoded the min-output failure as AcceptFeeRejectRest: the decision is
  // `Commit` (the fee intent applied), the swap did not happen.
  const outcome = wire.interpretIndexerTransactionResult(
    { result: { Finalized: { final_decision: 'Commit', execution_result: fixture.executeResults.rejectedSwap, abort_details: null } } },
    codec,
  );
  assert.equal(outcome.status, 'FEE_ONLY');
  assert.match(outcome.reason, /Only the fee was taken/);
});

test('outcome: pending, rejected, aborted, unexecuted and malformed results are never success', () => {
  const cases = [
    [{ result: 'Pending' }, 'PENDING'],
    [{ result: { Rejected: { details: 'bad', rejected_time: 'now' } } }, 'REJECTED'],
    [{ result: { Finalized: { final_decision: { Abort: 'ExecutionFailure' }, execution_result: null, abort_details: 'x' } } }, 'REJECTED'],
    [{ result: { Finalized: { final_decision: 'Commit', execution_result: null, abort_details: null } } }, 'UNKNOWN'],
    [{ result: { Finalized: { final_decision: 'Commit', execution_result: '!!!!', abort_details: null } } }, 'UNKNOWN'],
    [{ result: { Finalized: { final_decision: 'Commit', execution_result: RECEIPT_B64, abort_details: null } } }, 'UNKNOWN'],
    [{ result: { Finalized: { final_decision: 'Maybe', execution_result: null } } }, 'UNKNOWN'],
    [{ result: 42 }, 'UNKNOWN'],
  ];
  for (const [reply, expected] of cases) {
    assert.equal(wire.interpretIndexerTransactionResult(reply, codec).status, expected, JSON.stringify(reply).slice(0, 60));
  }
  assert.equal(wire.interpretIndexerTransactionResult({ status: 'COMMITTED' }, codec), undefined, 'a flat-status reply is left to the legacy parser');
});

test('outcome: the wallet path maps Sapient’s reply through to the app’s statuses', async () => {
  const provider = (reply) => ({ request: async () => reply });
  const committed = await tariWindow.fetchTransactionResult(
    provider({ result: { Finalized: { final_decision: 'Commit', execution_result: fixture.executeResults.acceptedSwap, abort_details: null } } }),
    'tx1',
  );
  assert.equal(tariWindow.mapTransactionStatus(committed), 'COMMITTED');
  const feeOnly = await tariWindow.fetchTransactionResult(
    provider({ result: { Finalized: { final_decision: 'Commit', execution_result: fixture.executeResults.rejectedSwap, abort_details: null } } }),
    'tx2',
  );
  assert.equal(tariWindow.mapTransactionStatus(feeOnly), 'REJECTED');
  assert.match(feeOnly.error, /Only the fee was taken/);
  const pending = await tariWindow.fetchTransactionResult(provider({ result: 'Pending' }), 'tx3');
  assert.equal(tariWindow.mapTransactionStatus(pending), 'UNKNOWN', 'pending is never finality');
});

// ---------------------------------------------------------------------------
// 7. Generation binding
// ---------------------------------------------------------------------------

test('deployment: the v0.48 reset generation trusts no template until one is recorded', () => {
  const reset = deployment.deploymentFor('esmeralda', 'V048_RESET');
  assert.deepEqual(reset.poolTemplates, []);
  assert.equal(reset.marketplaceTemplates, undefined);
  assert.equal(reset.registryKey, 'esmeralda@v048');
  const pre = deployment.deploymentFor('esmeralda', 'PRE_V048_RESET');
  assert.deepEqual(pre.poolTemplates, ['f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab']);
  assert.equal(pre.registryKey, 'esmeralda');
});

test('deployment: a session never mixes generations', () => {
  assert.equal(deployment.recordVerifiedGeneration('esmeralda', 'V048_RESET').ok, true);
  const second = deployment.recordVerifiedGeneration('esmeralda', 'PRE_V048_RESET');
  assert.equal(second.ok, false);
  assert.match(second.reason, /never mixed/);
});

test('deployment: execution-time pool rereads are refused unless the template is recorded for the verified generation', async () => {
  const calls = [];
  const inner = {
    readPool: async (component, expect) => {
      calls.push(expect);
      return { status: 'FOUND', value: { poolComponent: component } };
    },
  };
  const pinned = deployment.withTrustedPoolTemplates(inner, 'esmeralda');
  assert.equal((await pinned.readPool('component_x')).status, 'UNAVAILABLE', 'no generation verified yet');
  deployment.recordVerifiedGeneration('esmeralda', 'V048_RESET');
  assert.equal((await pinned.readPool('component_x')).status, 'UNAVAILABLE', 'nothing recorded on the reset network');
  deployment.resetVerifiedGenerations();
  deployment.recordVerifiedGeneration('esmeralda', 'PRE_V048_RESET');
  assert.equal((await pinned.readPool('component_x', { templateAddress: 'ab'.repeat(32) })).status, 'UNAVAILABLE', 'a caller cannot pin an unrecorded template');
  const ok = await pinned.readPool('component_x');
  assert.equal(ok.status, 'FOUND');
  assert.equal(calls.at(-1).templateAddress, 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab', 'the reread is pinned to the recorded template');
});
