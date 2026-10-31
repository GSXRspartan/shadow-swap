require('./bootstrap.cjs');
/**
 * Marketplace discovery over the real Ootle indexer.
 *
 * WHY THIS FILE EXISTS.
 *
 * The previous default discovery source POSTed a `{query, params}` document to the
 * bare indexer ORIGIN. The Ootle indexer serves no such route: `POST /` answers 404
 * with no CORS headers, so every marketplace query failed, and the page rendered
 * "no collections" on a network where all three marketplace templates are published
 * and readable. Those tests could not have caught it, because every one of them
 * stubbed a protocol the live host does not speak.
 *
 * So the stub here models the routes the indexer ACTUALLY serves —
 * `GET /info`, `GET /templates/{address}`, `GET /transaction-receipts`,
 * `POST /substates/fetch` — and the assertions are about the properties that
 * actually matter to a user:
 *
 *   1. a wrong network is refused before any state is read;
 *   2. a component is only ever shown once its OWN header names one of the three
 *      marketplace templates (a receipt's claim is never trusted);
 *   3. an undecodable component is COUNTED, so "no listings" cannot quietly mean
 *      "no listings plus N broken states";
 *   4. a transport failure is distinguishable from an empty chain;
 *   5. the durable cache is untrusted input and cannot inject a component;
 *   6. an expired listing reads as EXPIRED once the indexer's epoch is known.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const marketplace = require('../build-test/services/marketplace.js');
const registry = require('../build-test/services/marketplaceRegistry.js');

const BASE = 'https://ootle-indexer.example.test';
const LISTING_TEMPLATE = registry.MARKETPLACE_TEMPLATES.FixedPriceListing;
const OFFER_TEMPLATE = registry.MARKETPLACE_TEMPLATES.ItemOffer;
const BID_TEMPLATE = registry.MARKETPLACE_TEMPLATES.CollectionBid;
const OTHER_TEMPLATE = 'ab'.repeat(32);

const originalFetch = globalThis.fetch;
const protocolDeployment = require('../build-test/services/protocolDeployment.js');
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  // Each test is its own session: the verified-generation lock must not leak between them.
  protocolDeployment.resetVerifiedGenerations();
});

function jsonResponse(payload, headers = {}) {
  return { ok: true, status: 200, headers: new Headers(headers), text: async () => JSON.stringify(payload) };
}

/** 32 zero bytes as an object key, the shape the decoder requires for a CBOR tag. */
function objectKey(seed) {
  const pairs = seed
    .split('')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return pairs.padEnd(64, '0');
}

/** A `{"@cbor":"tag","tag":N,"value":{"@cbor":"bytes","hex":…}}` node. */
function tagged(tag, hex) {
  return { '@cbor': 'tag', tag, value: { '@cbor': 'bytes', hex } };
}

/** `resource_…` / `vault_…` / `component_…` as a tagged node. */
const res = (hex) => tagged(131, hex);
const vault = (hex) => tagged(132, hex);
const unit = (index) => [index, []];

/**
 * A FixedPriceListing component body in the 8-field layout `decodeListing` expects:
 * [nft_vault, nft_resource, nft_id, quote_resource, price, seller_account,
 *  expires_at_epoch, status].
 */
function listingBody({ collection, nftId, quote, price, expiresAt, status = 0 }) {
  return [
    vault(objectKey('a1')),
    res(collection),
    [1, [nftId]],
    res(quote),
    price,
    tagged(128, objectKey('b2')),
    expiresAt,
    unit(status),
  ];
}

function emptyNftVault(resourceHex) {
  return {
    Vault: {
      resource_container: {
        NonFungible: { address: `resource_${resourceHex}`, token_ids: [] },
      },
    },
  };
}

function componentSubstate(templateAddress, body) {
  return {
    Component: {
      header: { template_address: templateAddress, owner_rule: 'None', entity_id: 'aa' },
      body: { state: body },
    },
  };
}

/**
 * The real pre-v0.48 `POST /substates/fetch` entry shape is `{ version, substate: <value> }`
 * (bindings `Substate` at v0.47.0). The fixtures below are written as bare values for
 * readability; this wraps them exactly as the indexer does, so the production parser is
 * tested against the real envelope and is not loosened to accept a shape no indexer sends.
 */
async function asRealBatchEnvelope(response) {
  if (!response.ok) return response;
  const payload = JSON.parse(await response.text());
  const substates = payload && payload.substates;
  if (substates && typeof substates === 'object') {
    for (const [id, entry] of Object.entries(substates)) {
      if (entry && typeof entry === 'object' && !('substate' in entry) && !('value' in entry)) {
        substates[id] = { version: 0, substate: entry };
      }
    }
  }
  return jsonResponse(payload);
}

/**
 * A stub that serves the four real routes and lets a test override any of them.
 */
function ootleIndexerStub(overrides = {}) {
  const routes = {
    info: () => jsonResponse({ version: '0.46.1', network: 'esmeralda', network_byte: 38, current_epoch: 5000 }),
    receipts: () => jsonResponse({ receipts: [] }),
    substates: () => jsonResponse({ substates: {} }),
    ...overrides,
  };
  return async (url) => {
    const href = String(url);
    if (href.includes('/info')) return routes.info();
    if (href.includes('/transaction-receipts')) return routes.receipts();
    if (href.includes('/substates/fetch')) return asRealBatchEnvelope(await routes.substates(href));
    return jsonResponse({ error: 'not found' }, { status: 404 });
  };
}

function baseConfig(overrides = {}) {
  return {
    network: 'esmeralda',
    indexerUrls: [BASE],
    fixturesEnabled: false,
    devProvidersEnabled: false,
    blocking: [],
    ...overrides,
  };
}

const STORAGE_KEY = 'ootle.marketplaceRegistry.esmeralda';

// ---------------------------------------------------------------------------
// 1. The templates this build pins are the ones on the record.
// ---------------------------------------------------------------------------

test('registry: exactly the three verified marketplace templates are pinned', () => {
  assert.deepEqual(
    [...registry.MARKETPLACE_TEMPLATE_ADDRESSES].sort(),
    [
      '083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6',
      '612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329',
      '999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54',
    ].sort(),
  );
  for (const address of registry.MARKETPLACE_TEMPLATE_ADDRESSES) {
    assert.match(address, /^[0-9a-f]{64}$/, 'the indexer serves the BARE hex form');
    assert.equal(address.startsWith('template_'), false, 'the template_ prefix makes the route 400');
  }
});

test('registry: the esmeralda seed is empty and is documented as a chain fact', () => {
  // Not an oversight. See the MARKETPLACE_REGISTRY_SEED comment: the templates are
  // published, but no instantiated marketplace component is discoverable today.
  assert.deepEqual(registry.seedComponents('esmeralda'), []);
  assert.deepEqual(registry.seedComponents('localnet'), []);
});

// ---------------------------------------------------------------------------
// 2. The cache is untrusted input.
// ---------------------------------------------------------------------------

test('registry: a corrupted or hostile cache yields only validated component ids', () => {
  const hostile = {
    getItem: () => JSON.stringify(['not-a-component', 'component_zz', `component_${'0'.repeat(64)}`, { evil: true }]),
    setItem: () => {},
  };
  const known = registry.knownComponents('esmeralda', hostile);
  assert.deepEqual(known, [`component_${'0'.repeat(64)}`], 'only a well-formed component id survives');
});

test('registry: a cache entry that is not JSON, or the wrong shape, is ignored', () => {
  for (const raw of ['{', 'null', '"a string"', '{"component":"x"}']) {
    const store = { getItem: () => raw, setItem: () => {} };
    assert.deepEqual(registry.knownComponents('esmeralda', store), []);
  }
});

test('registry: a throwing storage object never throws at the caller', () => {
  const hostile = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(registry.knownComponents('esmeralda', hostile), []);
  assert.doesNotThrow(() => registry.rememberDiscovered('esmeralda', [`component_${'1'.repeat(64)}`], hostile));
});

test('registry: the cache is per-network, so an entry written for one chain is not loaded for another', () => {
  const store = { getItem: (key) => (key === STORAGE_KEY ? JSON.stringify([`component_${'2'.repeat(64)}`]) : null), setItem: () => {} };
  assert.deepEqual(registry.knownComponents('esmeralda', store), [`component_${'2'.repeat(64)}`]);
  assert.deepEqual(registry.knownComponents('localnet', store), []);
});

test('registry: discovery cannot widen the cache past its cap', () => {
  const written = [];
  const store = { getItem: () => null, setItem: (_key, value) => written.push(value) };
  const many = Array.from({ length: 500 }, (_unused, index) => `component_${String(index).padStart(64, '0')}`);
  registry.rememberDiscovered('esmeralda', many, store);
  const persisted = JSON.parse(written[written.length - 1]);
  assert.equal(persisted.length, 100);
});

// ---------------------------------------------------------------------------
// 3. Discovery reads the chain and fails closed.
// ---------------------------------------------------------------------------

test('discovery: the default source is the chain reader, not the operator JSON-RPC source', () => {
  // This is the regression the whole file exists for. A bare indexer origin must
  // NOT be handed to the `{query, params}` source.
  const chained = marketplace.createMarketplaceSource(baseConfig());
  assert.match(chained.name, /^ootle-indexer:/);

  const dedicated = marketplace.createMarketplaceSource(baseConfig({ nftDiscoveryUrl: 'https://discovery.example.test' }));
  assert.equal(dedicated.name, 'indexer:discovery.example.test');

  assert.equal(marketplace.createMarketplaceSource(baseConfig({ indexerUrls: [] })).name, 'unconfigured');
});

test('discovery: a wrong network is refused before any substate is read', async () => {
  let substateReads = 0;
  globalThis.fetch = ootleIndexerStub({
    info: () => jsonResponse({ version: '0.46.1', network: 'mainnet', network_byte: 1, current_epoch: 5000 }),
    substates: () => {
      substateReads += 1;
      return jsonResponse({ substates: {} });
    },
  });
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.deepEqual(await source.listCollections(), undefined);
  assert.equal(substateReads, 0, 'no state may be read from a chain whose identity was not established');
  assert.match(String(source.unavailableReason), /network identity/i);
});

test('discovery: an unreachable indexer is a failure, not an empty marketplace', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    headers: new Headers(),
    text: async () => '',
  });
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.equal(await source.listCollections(), undefined, 'undefined means "no answer", never "no collections"');
  assert.ok(String(source.unavailableReason).length > 0, 'a failure always carries a reason');
});

test('discovery: a healthy but empty chain reports no reason at all', async () => {
  globalThis.fetch = ootleIndexerStub();
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.equal(await source.listCollections(), undefined);
  assert.equal(source.unavailableReason, undefined, 'a genuinely empty chain is not an outage');
});

// ---------------------------------------------------------------------------
// 4. A component is shown only when its OWN header names a marketplace template.
// ---------------------------------------------------------------------------

test('discovery: a component from an unrelated template is never shown', async () => {
  const collection = objectKey('c3');
  const foreign = objectKey('d4');
  globalThis.fetch = ootleIndexerStub({
    receipts: () =>
      jsonResponse({
        receipts: [
          [
            'tx00000000000000000000000000000000000000000000000000000000000000ff',
            {
              outcome: 'Commit',
              diff_summary: {
                upped: [{ substate_id: `component_${foreign}` }, { substate_id: `component_${collection}` }],
              },
            },
          ],
        ],
      }),
    substates: () =>
      jsonResponse({
        substates: {
          // A receipt said it was created. The header says it is NOT ours.
          [`component_${foreign}`]: componentSubstate(OTHER_TEMPLATE, listingBody({
            collection,
            nftId: 'should-not-appear',
            quote: objectKey('e5'),
            price: '1000',
            expiresAt: '0',
          })),
        },
      }),
  });
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.equal(await source.listCollections(), undefined, 'an unrelated component must not create a collection');
});

test('discovery: a listing from the pinned template is decoded and listed', async () => {
  const collection = objectKey('1a');
  const quote = objectKey('2b');
  const component = objectKey('3c');
  globalThis.fetch = ootleIndexerStub({
    receipts: () =>
      jsonResponse({
        receipts: [
          [
            'tx00000000000000000000000000000000000000000000000000000000000000ff',
            {
              outcome: 'Commit',
              diff_summary: { upped: [{ substate_id: `component_${component}` }] },
            },
          ],
        ],
      }),
    substates: () =>
      jsonResponse({
        substates: {
          [`component_${component}`]: componentSubstate(LISTING_TEMPLATE, listingBody({
            collection,
            nftId: 'item-1',
            quote,
            price: '2500000',
            expiresAt: '0',
          })),
          // The escrow the component declared: an NFT collection vault, empty
          // because nobody has bought the item yet.
          [`vault_${objectKey('a1')}`]: emptyNftVault(collection),
        },
      }),
  });
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.deepEqual(await source.listCollections(), [`resource_${collection}`]);

  const items = await source.listItems(`resource_${collection}`);
  assert.equal(items.length, 1);
  assert.equal(items[0].nftId, 'str_item-1', 'a String-variant id is reported in upstream canonical form');
  assert.equal(items[0].listingAddress, `component_${component}`);
  assert.equal(items[0].priceRaw, '2500000');
  assert.equal(items[0].quoteResource, `resource_${quote}`);

  const listing = await source.readListing(`component_${component}`);
  assert.ok(listing, 'the listing must be readable by address');
  assert.equal(listing.status, 'ACTIVE');
  assert.equal(listing.price, '2500000');
  assert.equal(listing.collectionResource, `resource_${collection}`);
});

test('discovery: expiry is judged against the epoch the indexer reported', async () => {
  const collection = objectKey('4d');
  const component = objectKey('5e');
  const body = (expiresAt) =>
    ootleIndexerStub({
      receipts: () =>
        jsonResponse({
          receipts: [
            [
              'tx00000000000000000000000000000000000000000000000000000000000000ff',
              { outcome: 'Commit', diff_summary: { upped: [{ substate_id: `component_${component}` }] } },
            ],
          ],
        }),
      substates: () =>
        jsonResponse({
          substates: {
            [`component_${component}`]: componentSubstate(LISTING_TEMPLATE, listingBody({
              collection,
              nftId: 'expiring',
              quote: objectKey('6f'),
              price: '1',
              expiresAt,
            })),
            [`vault_${objectKey('a1')}`]: emptyNftVault(collection),
          },
        }),
    });

  // Reported epoch 5000; the listing claims to expire at 4999 → already expired.
  globalThis.fetch = body('4999');
  const expired = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  const expiredListing = await expired.readListing(`component_${component}`);
  assert.equal(expiredListing.status, 'EXPIRED', 'an expired order must never be offered as fillable');

  // Reported epoch 5000; expiry 9001 → still live.
  globalThis.fetch = body('9001');
  const live = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  const liveListing = await live.readListing(`component_${component}`);
  assert.equal(liveListing.status, 'ACTIVE');
});

// ---------------------------------------------------------------------------
// 5. Undecodable components are counted, not hidden.
// ---------------------------------------------------------------------------

test('discovery: components that cannot be decoded are counted and reported', async () => {
  const component = objectKey('7a');
  globalThis.fetch = ootleIndexerStub({
    receipts: () =>
      jsonResponse({
        receipts: [
          [
            'tx00000000000000000000000000000000000000000000000000000000000000ff',
            { outcome: 'Commit', diff_summary: { upped: [{ substate_id: `component_${component}` }] } },
          ],
        ],
      }),
    // Right template, wrong body length — exactly the shape a decoder must refuse.
    substates: () =>
      jsonResponse({
        substates: {
          [`component_${component}`]: componentSubstate(LISTING_TEMPLATE, [vault(objectKey('a1'))]),
        },
      }),
  });
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.equal(await source.listCollections(), undefined);
  assert.match(String(source.unavailableReason), /none could be decoded/);
});

test('discovery: an escrow holding the wrong resource is refused, not reported', async () => {
  const collection = objectKey('8b');
  const declared = objectKey('9c');
  const component = objectKey('0d');
  globalThis.fetch = ootleIndexerStub({
    receipts: () =>
      jsonResponse({
        receipts: [
          [
            'tx00000000000000000000000000000000000000000000000000000000000000ff',
            { outcome: 'Commit', diff_summary: { upped: [{ substate_id: `component_${component}` }] } },
          ],
        ],
      }),
    substates: () =>
      jsonResponse({
        substates: {
          [`component_${component}`]: componentSubstate(LISTING_TEMPLATE, listingBody({
            collection: declared,
            nftId: 'mismatch',
            quote: objectKey('1e'),
            price: '1',
            expiresAt: '0',
          })),
          // The vault holds a DIFFERENT collection than the component declared.
          [`vault_${objectKey('a1')}`]: emptyNftVault(collection),
        },
      }),
  });
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.equal(await source.listCollections(), undefined, 'a component whose escrow disagrees with it is not shown');
});

// ---------------------------------------------------------------------------
// 6. Recent sales are not invented.
// ---------------------------------------------------------------------------

test('discovery: recent sales are empty because a receipt carries no price', async () => {
  globalThis.fetch = ootleIndexerStub();
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  assert.deepEqual(await source.recentSales('resource_x', 'resource_y'), []);
});

test('discovery: concurrent callers share one discovery pass', async () => {
  let infoCalls = 0;
  globalThis.fetch = ootleIndexerStub({
    info: () => {
      infoCalls += 1;
      return jsonResponse({ version: '0.46.1', network: 'esmeralda', network_byte: 38, current_epoch: 5000 });
    },
  });
  const source = new marketplace.OotleIndexerMarketplaceSource(baseConfig(), undefined);
  const [a, b, c] = await Promise.all([source.listCollections(), source.listCollections(), source.listItems('resource_x')]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);
  assert.deepEqual(c, []);
  assert.equal(infoCalls, 1, 'the identity preflight runs once per source, not once per caller');
});
