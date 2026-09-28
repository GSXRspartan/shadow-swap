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
const IDENTITY_OK = { version: '0.41.4', network: 'esmeralda', network_byte: 38, current_epoch: 11602 };

/** Routes by URL: `/info` answers the identity, anything else answers `payload`. */
function endpointFetch(payload, identity = IDENTITY_OK) {
  return (url) => jsonResponse(new URL(url).pathname === '/info' ? identity : payload);
}

/** The production discovery base, so the identity path is `/info` on it. */
const LIVE_BASE = 'https://ootle-indexer-a.tari.com';
// Production passes the bare origin (`config.indexerUrls[0]`), so the identity
// preflight resolves to `{origin}/info` and the discovery query POSTs to `{origin}`.
const DISCOVERY_URL = LIVE_BASE;

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

test('outage: a healthy discovery response is still parsed into pools', async () => {
  globalThis.fetch = endpointFetch([
    {
      poolComponent: 'component_pool_1',
      resourceA: 'otl_canonical_tari',
      resourceB: 'otl_wstable_1',
      baseSymbol: 'TARI',
      quoteSymbol: 'wSTABLE',
      baseDecimals: '6',
      quoteDecimals: '6',
      safetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED',
    },
  ]);
  const source = new pools.IndexerPoolDiscovery(DISCOVERY_URL);
  const result = await source.discover();
  assert.equal(result.pools.length, 1);
  assert.equal(result.unavailableReason, undefined);
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

test('discovery: a wrong-network endpoint never reaches the discovery query', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (new URL(url).pathname === '/info') {
      return jsonResponse({ version: '0.41.4', network: 'esmeralda', network_byte: 36 });
    }
    // If this is ever reached the test fails, because the discovery query must
    // not be issued against an endpoint whose identity could not be established.
    return jsonResponse({ data: [{ poolComponent: 'component_pool_1' }] });
  };
  const source = new pools.IndexerPoolDiscovery(DISCOVERY_URL);
  const result = await source.discover();
  assert.equal(result.pools.length, 0);
  assert.match(result.unavailableReason, /restricted to "esmeralda"/);
  assert.deepEqual(seen, [`${LIVE_BASE}/info`], 'only the identity preflight may be issued');
});

test('discovery: an unidentified endpoint is an explicit refusal, not an empty list', async () => {
  globalThis.fetch = endpointFetch({ data: [{ poolComponent: 'component_pool_1' }] }, { version: '0.41.4' });
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.pools.length, 0);
  assert.match(result.unavailableReason, /could not be identified/i);
});

test('discovery: a 200 that is not JSON never reads as zero pools', async () => {
  globalThis.fetch = async (url) =>
    new URL(url).pathname === '/info'
      ? { ok: true, status: 200, headers: new Headers(), text: async () => '<html>captive portal</html>' }
      : jsonResponse([]);
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.pools.length, 0);
  assert.match(result.unavailableReason, /not valid JSON/);
});

test('discovery: a verified endpoint returning a real empty list is an empty list, not a refusal', async () => {
  // The distinction the endpoint evidence requires: our templates are
  // unpublished on Esmeralda, which is an EMPTY deployment, not an indexer
  // outage. The gate must not flatten those two into the same state.
  globalThis.fetch = endpointFetch({ data: [] });
  const result = await new pools.IndexerPoolDiscovery(DISCOVERY_URL).discover();
  assert.equal(result.pools.length, 0);
  assert.equal(result.unavailableReason, undefined, 'a verified empty list is not a failure and must not be dressed as one');
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
