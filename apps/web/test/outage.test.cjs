require('./bootstrap.cjs');
/**
 * Outage-mode regressions (mission §34/§35/§38).
 *
 * Discovery is the only path from the browser to an operator-controlled host.
 * These tests pin the properties that decide whether an unavailable indexer
 * produces an honest "we could not read anything" state or an infinite spinner /
 * fabricated empty list:
 *
 *   - every request has a deadline and cannot hang the caller;
 *   - a response body is never buffered past a cap;
 *   - every failure yields a reason, and that reason never echoes the body;
 *   - a failure is never reported as a legitimate empty result.
 *
 * The fetch stub is a degraded as well as a hostile one: it hangs, lies about
 * content-length, returns HTML, returns huge bodies, and never resolves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const net = require('../build-test/services/net.js');
const pools = require('../build-test/services/pools.js');
const marketplace = require('../build-test/services/marketplace.js');
const identity = require('../build-test/services/indexerIdentity.js');

const HANG_URL = 'https://indexer.example.invalid/query';
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { ok: true, status: 200, headers: new Headers(headers), text: async () => body };
}

/**
 * A fetch stub that models the real endpoint shape rather than answering
 * everything with the same document.
 *
 * Discovery now performs a network-identity preflight (`GET {base}/info`) before
 * it will trust any discovery content, so a stub that returns the pool list to
 * every request no longer models an endpoint at all. These helpers keep the
 * outage tests testing what they mean to test.
 */
const IDENTITY_OK = { version: '0.42.0', network: 'esmeralda', network_byte: 38, current_epoch: 11714 };

/** Routes by URL: `/info` answers the identity, anything else answers `payload`. */
function endpointFetch(payload, identity = IDENTITY_OK) {
  return (url) => jsonResponse(new URL(url).pathname === '/info' ? identity : payload);
}

/** The production discovery base, so the identity path is `/info` on it. */
const LIVE_BASE = 'https://ootle-indexer-a.tari.com';
// Production passes the bare origin (`config.indexerUrls[0]`), so the identity
// preflight resolves to `{origin}/info` and discovery then reads the real
// `tari_indexer` REST endpoints under `{origin}`.
const DISCOVERY_URL = LIVE_BASE;

// ---------------------------------------------------------------------------
// Real v0.42.0 indexer protocol stubs.
//
// The shapes below are the responses read live from
// https://ootle-indexer-a.tari.com on 2026-10-01. Discovery used to speak an
// invented `POST {base} {"query":"pool_discovery"}` envelope that a real indexer
// answers with 404; these stubs replace it so the outage tests exercise the
// protocol the app actually sends.
// ---------------------------------------------------------------------------

/** A catalogue with `name` published at `templateAddress`. */
function catalogue(name, templateAddress) {
  return {
    entries: [
      {
        template_address: templateAddress ?? 'ab'.repeat(32),
        template_name: name,
        author_public_key: '00'.repeat(32),
        binary_hash: 'cd'.repeat(32),
        at_epoch: 11714,
      },
    ],
  };
}

/** Receipts carrying one committed component creation, in the real envelope. */
function receiptsWithComponent(substateId) {
  return {
    receipts: [
      [
        'ee'.repeat(32),
        {
          outcome: 'Commit',
          diff_summary: {
            upped: [{ substate_id: substateId, version: 0, value_hash: '11'.repeat(32) }],
            downed: [],
          },
          fee_withdrawals: [],
          events: [],
          fee_receipt: { total_fee_payment: 13247, total_fees_paid: 13247 },
        },
      ],
    ],
  };
}

/**
 * The batch substate read: a component's header names the template that made it.
 *
 * v0.43 shape (read live from https://ootle-indexer-a.tari.com, 2026-10-06):
 * `substates` is a MAP keyed by substate id, and each value is
 * `{ version, substate: { Component|… } }` with `version` as a JSON NUMBER. v0.42
 * sent `{ substate_ids: [...] }` requests and an ARRAY of `{ substate_id, … }`
 * wrappers; the live host now answers HTTP 422 to the v0.42 request shape, so this
 * stub models the current contract and guards the parser against regressing to it.
 */
function componentSubstates(substateId, templateAddress) {
  return {
    substates: {
      [substateId]: {
        version: 7,
        substate: {
          Component: {
            header: { template_address: templateAddress, owner_rule: { ByPublicKey: '22'.repeat(32) }, access_rules: { method_access: {}, default: 'DenyAll' }, entity_id: '1' },
            // `body.state` is raw tagged CBOR to the indexer, NOT decoded fields.
            // That is precisely why discovery cannot read a pool's reserves.
            body: { state: [{ '@cbor': 'map', entries: [] }, {}] },
          },
        },
      },
    },
  };
}

/**
 * A fetch stub modelling the real indexer across the three discovery endpoints.
 * `options.templateName`/`options.templateAddress`/`options.componentId` control
 * whether the deployment is empty or has a pool.
 */
function realIndexerFetch(options = {}) {
  const templateAddress = options.templateAddress ?? 'ab'.repeat(32);
  const componentId = options.componentId ?? 'component_ff'.repeat(1) + '00'.repeat(31);
  const seen = [];
  const stub = async (url) => {
    const parsed = new URL(url);
    seen.push(`${parsed.pathname}${parsed.search}`);
    if (parsed.pathname === '/info') return jsonResponse(options.identity ?? IDENTITY_OK);
    if (parsed.pathname === '/templates/catalogue') {
      if (options.templates === 'none') return jsonResponse({ entries: [] });
      return jsonResponse(catalogue(options.templateName ?? 'Pool', templateAddress));
    }
    if (parsed.pathname === '/transaction-receipts') {
      return jsonResponse(options.receipts ?? receiptsWithComponent(componentId));
    }
    if (parsed.pathname === '/substates/fetch') {
      return jsonResponse(componentSubstates(componentId, templateAddress));
    }
    return jsonResponse({}, { 'content-type': 'application/json' });
  };
  stub.seen = seen;
  return stub;
}

function hangingFetch() {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const abort = () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      };
      if (init && init.signal) {
        if (init.signal.aborted) abort();
        else init.signal.addEventListener('abort', abort, { once: true });
      }
    });
}

// ---------------------------------------------------------------------------
// 1. DEADLINE
// ---------------------------------------------------------------------------

test('outage: a host that accepts the request and never answers still resolves', async () => {
  globalThis.fetch = hangingFetch();
  const started = Date.now();
  const result = await net.postJson(HANG_URL, { query: 'pool_discovery' }, { timeoutMs: 60 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not answer within/);
  assert.ok(Date.now() - started < 5_000, 'the deadline must bound the call, not the socket');
});

test('outage: pool discovery reports unavailable instead of hanging or inventing pools', async () => {
  globalThis.fetch = hangingFetch();
  const source = new pools.IndexerPoolDiscovery(HANG_URL);
  const result = await source.discover();
  assert.deepEqual(result.pools, []);
  assert.ok(typeof result.unavailableReason === 'string' && result.unavailableReason.length > 0);
  assert.match(result.unavailableReason, /did not answer within/);
});

test('outage: a caller-owned abort signal cancels the request without a false success', async () => {
  globalThis.fetch = hangingFetch();
  const controller = new AbortController();
  const pending = net.postJson(HANG_URL, {}, { timeoutMs: 30_000, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// 2. SIZE CAPS
// ---------------------------------------------------------------------------

test('outage: a declared oversized body is refused before it is buffered', async () => {
  let read = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(200 * 1024 * 1024) }),
    text: async () => {
      read = true;
      return '[]';
    },
  });
  const result = await net.postJson(HANG_URL, {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /larger than this build will read/);
  assert.equal(read, false, 'the body must not be read at all when the declared size is unacceptable');
});

test('outage: an undeclared oversized body is refused after the cap', async () => {
  globalThis.fetch = async () => jsonResponse('x'.repeat(4096));
  const result = await net.postJson(HANG_URL, {}, { maxBytes: 256 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeded the 256 byte read limit/);
});

// ---------------------------------------------------------------------------
// 3. HONEST REASONS
// ---------------------------------------------------------------------------

test('outage: an HTTP error is reported with its status and never as an empty list', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: new Headers(), text: async () => '' });
  const result = await net.postJson(HANG_URL, {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 503/);
});

test('outage: a non-JSON body is refused and the body never reaches the reason', async () => {
  globalThis.fetch = async () => jsonResponse(`<html>preimage-deadbeef</html>`);
  const result = await net.postJson(HANG_URL, {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /not valid JSON/);
  assert.doesNotMatch(result.reason, /preimage-deadbeef/);
});

test('outage: a transport failure reason is sanitised and bounded', async () => {
  globalThis.fetch = async () => {
    throw new Error(`bad\u0000host ${'z'.repeat(500)}`);
  };
  const result = await net.postJson(HANG_URL, {});
  assert.equal(result.ok, false);
  assert.ok(result.reason.length <= 220, 'a reason must be bounded before it reaches the UI');
  assert.doesNotMatch(result.reason, /\u0000/);
});

test('outage: a payload without a record list is a mismatch, not an empty list', () => {
  assert.deepEqual(net.discoveryList([]), { ok: true, list: [] });
  assert.equal(net.discoveryList({ data: [1] }).ok, true);
  const missing = net.discoveryList({ unexpected: true });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /did not contain a record list/);
});

test('outage: a malformed configured endpoint fails closed instead of throwing', () => {
  const source = new pools.IndexerPoolDiscovery('not a url');
  assert.equal(source.name, 'indexer:invalid');
  const marketplaceSource = new marketplace.IndexerMarketplaceSource('not a url');
  assert.equal(marketplaceSource.name, 'indexer:invalid');
});

// ---------------------------------------------------------------------------
// 4. DISCOVERY INTEGRATION
// ---------------------------------------------------------------------------

test('outage: a healthy discovery response yields the pool component, and no fabricated pool', async () => {
  // Discovery establishes WHICH pools exist. It must NOT yield a decoded pool:
  // the indexer returns component state as raw tagged CBOR, so a pool whose pair
  // and reserves were never read authoritatively must not be described here.
  const stub = realIndexerFetch();
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'PROTOCOL_AVAILABLE');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].templateAddress, 'ab'.repeat(32));
  // v0.43 returns the substate version as a JSON number; it must be carried on as
  // a decimal string, not collapsed to the '0' fallback.
  assert.equal(result.candidates[0].version, '7');
  assert.equal(result.unavailableReason, undefined);
  assert.deepEqual(result.pools, [], 'no pool may be described from an unread component state');
  assert.equal(result.publishedTemplates[0].templateName, 'Pool');
});

// ---------------------------------------------------------------------------
// 5. NETWORK IDENTITY PREFLIGHT (fail closed on the wrong chain)
// ---------------------------------------------------------------------------

test('identity: a matching network name AND byte is accepted', () => {
  const verdict = identity.classifyIndexerIdentity(
    `${LIVE_BASE}/info`,
    { version: '0.41.4', network: 'esmeralda', network_byte: 38, current_epoch: 11602 },
    { network: 'esmeralda', networkName: 'esmeralda' },
  );
  assert.equal(verdict.status, 'VERIFIED');
  assert.equal(verdict.networkByte, 38);
  assert.equal(verdict.currentEpoch, '11602');
  assert.equal(identity.isVerified(verdict), true);
});

test('identity: a right name with the WRONG byte is refused, not accepted on the name alone', () => {
  // The name is a self-assertion any substituted endpoint can make. The byte is
  // the independent check, so agreeing on the name must not be enough.
  const verdict = identity.classifyIndexerIdentity(
    `${LIVE_BASE}/info`,
    { network: 'esmeralda', network_byte: 36 },
    { network: 'esmeralda', networkName: 'esmeralda' },
  );
  assert.equal(verdict.status, 'NETWORK_MISMATCH');
  assert.equal(identity.isVerified(verdict), false);
});

test('identity: a different network is refused and names both chains', () => {
  const verdict = identity.classifyIndexerIdentity(
    'https://somewhere.example/info',
    { network: 'mainnet', network_byte: 0 },
    { network: 'esmeralda', networkName: 'esmeralda' },
  );
  assert.equal(verdict.status, 'NETWORK_MISMATCH');
  assert.match(verdict.reason, /mainnet/);
  assert.match(verdict.reason, /esmeralda/);
});

test('identity: an endpoint that answers but names no network is UNIDENTIFIED, never verified', () => {
  const verdict = identity.classifyIndexerIdentity(
    `${LIVE_BASE}/info`,
    { version: '0.41.4' },
    { network: 'esmeralda', networkName: 'esmeralda' },
  );
  assert.equal(verdict.status, 'UNIDENTIFIED');
});

test('identity: a name with no byte is UNIDENTIFIED, because the byte is the independent evidence', () => {
  const verdict = identity.classifyIndexerIdentity(
    `${LIVE_BASE}/info`,
    { network: 'esmeralda' },
    { network: 'esmeralda', networkName: 'esmeralda' },
  );
  assert.equal(verdict.status, 'UNIDENTIFIED');
});

test('identity: a non-object or array reply is UNUSABLE, never verified', () => {
  const expected = { network: 'esmeralda', networkName: 'esmeralda' };
  for (const payload of [null, 'ok', 42, [{ network: 'esmeralda', network_byte: 38 }]]) {
    const verdict = identity.classifyIndexerIdentity(`${LIVE_BASE}/info`, payload, expected);
    assert.equal(verdict.status, 'UNUSABLE', `payload ${JSON.stringify(payload)} must be refused`);
  }
});

test('identity: a hostile /info cannot inject markup into the rendered reason', () => {
  const verdict = identity.classifyIndexerIdentity(
    `${LIVE_BASE}/info`,
    { network: '<img src=x onerror=alert(1)>', network_byte: -1 },
    { network: 'esmeralda', networkName: 'esmeralda' },
  );
  assert.notEqual(verdict.status, 'VERIFIED');
});

test('identity: UNREACHABLE says nothing about the network being down', async () => {
  globalThis.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND nowhere.example');
  };
  const verdict = await identity.verifyIndexerIdentity('https://nowhere.example', {
    network: 'esmeralda',
    networkName: 'esmeralda',
  });
  assert.equal(verdict.status, 'UNREACHABLE');
  // The distinction matters: an unreachable endpoint is an endpoint problem, and
  // must never be rendered as "the network is down".
  assert.match(identity.describeIdentity(verdict), /nothing about the network/i);
});

test('identity: a malformed configured origin is refused before any request is made', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({});
  };
  const verdict = await identity.verifyIndexerIdentity('not a url', {
    network: 'esmeralda',
    networkName: 'esmeralda',
  });
  assert.equal(verdict.status, 'UNUSABLE');
  assert.equal(called, false, 'a malformed origin must not produce a network request');
});

test('discovery: an endpoint that cannot answer at all is INDEXER_UNAVAILABLE', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return jsonResponse({ version: '0.42.0', network: 'esmeralda', network_byte: 36 });
  };
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'WRONG_NETWORK');
  assert.equal(result.pools.length, 0);
  assert.equal(result.candidates.length, 0);
  assert.match(result.unavailableReason, /restricted to "esmeralda"/);
  assert.deepEqual(seen, [`${LIVE_BASE}/info`], 'only the identity preflight may be issued');
});

test('discovery: a wrong-network endpoint is WRONG_NETWORK, a distinct state from an outage', async () => {
  const stub = realIndexerFetch({ identity: { version: '0.42.0', network: 'esmeralda', network_byte: 36 } });
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'WRONG_NETWORK');
  // The chain was READ and answered. No discovery content may have been requested.
  assert.deepEqual(stub.seen, ['/info']);
});

test('discovery: an unidentified endpoint is an explicit refusal, not an empty list', async () => {
  const stub = realIndexerFetch({ identity: { version: '0.42.0' } });
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'INDEXER_UNAVAILABLE');
  assert.equal(result.pools.length, 0);
  assert.match(result.unavailableReason, /could not be identified/i);
  assert.deepEqual(stub.seen, ['/info'], 'content must never be requested from an unidentified endpoint');
});

test('discovery: a 200 that is not JSON never reads as zero pools', async () => {
  globalThis.fetch = async (url) =>
    new URL(url).pathname === '/info'
      ? { ok: true, status: 200, headers: new Headers(), text: async () => '<html>captive portal</html>' }
      : jsonResponse({ entries: [] });
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'INDEXER_UNAVAILABLE');
  assert.equal(result.pools.length, 0);
  assert.match(result.unavailableReason, /not valid JSON/);
});

test('discovery: templates unpublished is PROTOCOL_NOT_DEPLOYED, NOT an outage', async () => {
  // This is the exact post-reset Esmeralda reality: the chain answers, reports
  // no published `Pool` template, and that is an EMPTY deployment. It must not
  // be rendered as "indexer down" and never as "no liquidity".
  const stub = realIndexerFetch({ templates: 'none' });
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'PROTOCOL_NOT_DEPLOYED');
  assert.equal(result.pools.length, 0);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.unavailableReason, undefined, 'a reachable network with nothing published is not a failure and must not be dressed as one');
  assert.match(result.detail, /network is reachable/i);
  assert.equal(stub.seen.includes('/transaction-receipts'), false, 'nothing is published, so no receipt scan may run');
});

test('discovery: published but never instantiated is PROTOCOL_DEPLOYED_EMPTY, distinct from unpublished', async () => {
  const stub = realIndexerFetch({ receipts: { receipts: [] } });
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'PROTOCOL_DEPLOYED_EMPTY');
  assert.equal(result.unavailableReason, undefined);
  assert.equal(result.publishedTemplates.length, 1, 'the published template must still be reported');
  assert.match(result.detail, /published/i);
});

test('discovery: the removed /templates/cached endpoint is never requested', async () => {
  // v0.42.0 removed it (`refactor!` in the changelog) and the live host answers
  // HTTP 400. Requesting it would make every deployment look unpublished.
  const stub = realIndexerFetch();
  globalThis.fetch = stub;
  await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(stub.seen.some((path) => path.startsWith('/templates/cached')), false);
  assert.equal(stub.seen.some((path) => path.startsWith('/templates/catalogue')), true);
});

test('discovery: a substring catalogue match does not admit a different template', async () => {
  // `name_filter` is a SUBSTRING filter. The builtin `TwoResourceLiquidityPool`
  // contains "Pool", so an exact-name requirement is what stops it being mistaken
  // for our `Pool` template.
  const stub = realIndexerFetch({ templateName: 'TwoResourceLiquidityPool' });
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.state, 'PROTOCOL_NOT_DEPLOYED');
  assert.equal(result.publishedTemplates.length, 0);
});

test('discovery: only components whose own header names our template are kept', async () => {
  const otherTemplate = '9f'.repeat(32);
  const stub = realIndexerFetch({ receipts: receiptsWithComponent('component_' + 'ab'.repeat(32)) });
  const inner = stub;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/info') return jsonResponse(IDENTITY_OK);
    if (parsed.pathname === '/templates/catalogue') return jsonResponse(catalogue('Pool', 'ab'.repeat(32)));
    if (parsed.pathname === '/transaction-receipts') return jsonResponse(receiptsWithComponent('component_' + 'ab'.repeat(32)));
    if (parsed.pathname === '/substates/fetch') return jsonResponse(componentSubstates('component_' + 'ab'.repeat(32), otherTemplate));
    void init;
    return inner(url);
  };
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.candidates.length, 0, 'a component from another template must not be presented as a pool');
  assert.equal(result.state, 'PROTOCOL_DEPLOYED_EMPTY');
});

test('discovery: a downed substate is not a live pool component', async () => {
  // v0.42.0 added `diff_summary.downed` for substates a transaction SPENT. A
  // spent substate must never be surfaced as a live pool.
  const stub = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/info') return jsonResponse(IDENTITY_OK);
    if (parsed.pathname === '/templates/catalogue') return jsonResponse(catalogue('Pool', 'ab'.repeat(32)));
    if (parsed.pathname === '/transaction-receipts') {
      return jsonResponse({
        receipts: [['ee'.repeat(32), { outcome: 'Commit', diff_summary: { upped: [], downed: [{ substate_id: 'component_' + 'ab'.repeat(32), version: 3 }] }, fee_withdrawals: [], events: [] }]],
      });
    }
    return jsonResponse({ substates: [] });
  };
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.candidates.length, 0);
});

test('discovery: an aborted transaction contributes no components', async () => {
  const stub = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/info') return jsonResponse(IDENTITY_OK);
    if (parsed.pathname === '/templates/catalogue') return jsonResponse(catalogue('Pool', 'ab'.repeat(32)));
    if (parsed.pathname === '/transaction-receipts') {
      const committed = receiptsWithComponent('component_' + 'ab'.repeat(32));
      committed.receipts[0][1].outcome = 'Abort';
      return jsonResponse(committed);
    }
    return jsonResponse({ substates: [] });
  };
  globalThis.fetch = stub;
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.candidates.length, 0);
});

test('outage: a failed marketplace query is distinguishable from zero collections', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 502, headers: new Headers(), text: async () => '' });
  const source = new marketplace.IndexerMarketplaceSource(HANG_URL);
  assert.equal(await source.listCollections(), undefined);
  assert.match(String(source.unavailableReason), /HTTP 502/);

  globalThis.fetch = async () => jsonResponse([]);
  const healthy = new marketplace.IndexerMarketplaceSource(HANG_URL);
  assert.equal(await healthy.listCollections(), undefined);
  assert.equal(healthy.unavailableReason, undefined, 'a genuinely empty endpoint has no failure reason');
});

test('outage: records that are all unreadable are reported as unreadable, not as empty', async () => {
  globalThis.fetch = async () => jsonResponse([{ nonsense: true }, { alsoNonsense: 1 }]);
  const source = new marketplace.IndexerMarketplaceSource(HANG_URL);
  assert.equal(await source.listCollections(), undefined);
  assert.match(String(source.unavailableReason), /none of which this build could read/);
});
