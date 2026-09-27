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

const HANG_URL = 'https://indexer.example.invalid/query';
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { ok: true, status: 200, headers: new Headers(headers), text: async () => body };
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

test('outage: a healthy discovery response is still parsed into pools', async () => {
  globalThis.fetch = async () =>
    jsonResponse([
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
  const source = new pools.IndexerPoolDiscovery(HANG_URL);
  const result = await source.discover();
  assert.equal(result.pools.length, 1);
  assert.equal(result.unavailableReason, undefined);
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
