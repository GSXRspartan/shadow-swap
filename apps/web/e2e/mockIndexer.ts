/**
 * Indexer mock, applied as a request interceptor rather than a local server.
 *
 * This is deliberate. The app is built and served in its PRODUCTION
 * configuration, with the production CSP and the production endpoint list, and
 * the mock answers at `https://ootle-indexer-a.tari.com` — one of the two
 * origins the shipped policy allows. So the flows exercise the real discovery
 * path, the real strict parser, and the real network policy.
 *
 * The alternative, a localhost dev server, would require a development build
 * and would therefore test a different artifact than the one that ships.
 *
 * It serves the REAL `tari_indexer` REST surface at Ootle v0.42.0, read live
 * from that host on 2026-10-01. It previously answered an invented
 * `POST {base} {"query":"pool_discovery"}` envelope that a real indexer answers
 * with 404, so the browser flows were testing a protocol the network does not
 * speak.
 *
 * Division of labour, and it is a real one rather than a convenience:
 *   - the INDEXER says WHICH pool components exist;
 *   - the WALLET says WHAT each pool holds, because the indexer returns a
 *     component's state as raw tagged CBOR and cannot decode field names.
 * So the catalogue/receipt/substate endpoints below yield component ADDRESSES,
 * and the decoded `fields` come from the reference wallet provider.
 */
import type { Page, Route } from '@playwright/test';

export interface MockIndexerOptions {
  /** Return an HTTP error from the catalogue instead of a well-formed body. */
  failDiscovery?: boolean;
  /** Add hostile component substate ids alongside the real ones. */
  hostile?: boolean;
  /** Report our `Pool` template as unpublished (an empty deployment). */
  unpublished?: boolean;
  /**
   * How `GET /info` answers, which is the network-identity preflight the app
   * performs before it trusts any discovery content.
   *
   *  - `esmeralda` (default): the real live shape, `{ network: 'esmeralda', network_byte: 38 }`.
   *  - `wrong-network`: an endpoint that answers but reports a different chain.
   *  - `unidentified`: an endpoint that answers but says nothing about itself.
   *  - `garbage`: a 200 that is not JSON.
   */
  identity?: 'esmeralda' | 'wrong-network' | 'unidentified' | 'garbage';
}

/** The live post-reset `GET /info` body. */
export const ESMERALDA_IDENTITY = {
  version: '0.42.0',
  network: 'esmeralda',
  network_byte: 38,
  sidechain_id: null,
  current_epoch: 11714,
  transaction_retention_epochs: 50,
  index_gossiped_transactions: true,
  verify_substate_proofs: true,
  indexes_all_events: true,
};

/**
 * The address our `Pool` template would occupy once published.
 *
 * This is the REAL published Pool v2 template, not a placeholder: discovery reports it,
 * and the authoritative wallet read is pinned to it, so the two sources must agree the
 * same way they must on the live chain. A placeholder here would let a wallet that serves
 * a different template pass, which is exactly the drift the pin exists to catch.
 */
export const POOL_TEMPLATE_ADDRESS = 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab';

/** A DIFFERENT template whose name contains "Pool", to prove exact matching. */
export const OTHER_POOL_TEMPLATE = {
  template_address: '00'.repeat(31) + '02',
  template_name: 'TwoResourceLiquidityPool',
  author_public_key: '00'.repeat(32),
  binary_hash: '11'.repeat(32),
  at_epoch: 0,
};

export const POOL_COMPONENT = 'component_pool_tari_wstable_0001';
export const SAFE_POOL_COMPONENT = 'component_pool_a_b_0002';

/**
 * Hostile component ids. None is a well-formed substate id, so every one must be
 * dropped while the real pools still render. If any is ever accepted it must not
 * reach the DOM as markup.
 */
const HOSTILE_COMPONENT_IDS = ['<script>window.__pwned=1</script>', 'x'.repeat(500), 'pool_bad', 'component_' + '00'.repeat(31) + '99'];

function receipts(componentIds: string[]) {
  return {
    receipts: [
      [
        'ee'.repeat(32),
        {
          outcome: 'Commit',
          diff_summary: {
            upped: componentIds.map((substate_id) => ({ substate_id, version: 0, value_hash: '22'.repeat(32) })),
            // v0.42.0 added `downed`: substates a transaction SPENT. A spent
            // substate must never be presented as a live pool.
            downed: [{ substate_id: 'component_' + '00'.repeat(31) + '77', version: 9, value_hash: '33'.repeat(32) }],
          },
          fee_withdrawals: [],
          events: [],
          fee_receipt: { total_fee_payment: 13247, total_fees_paid: 13247 },
        },
      ],
    ],
  };
}

// v0.43 batch-read entry value: `{ version (a JSON number), substate: { Component } }`.
// The substate id is the MAP KEY in the response, not a field here (v0.42 carried a
// `substate_id` field and an array of these wrappers).
function componentSubstate(templateAddress: string) {
  return {
    version: 0,
    substate: {
      Component: {
        header: {
          template_address: templateAddress,
          owner_rule: { OwnedBySigner: null },
          access_rules: { method_access: {}, default: 'DenyAll' },
          entity_id: '1',
        },
        // Raw tagged CBOR, exactly as the real indexer serves it. This is WHY
        // reserves can only come from the wallet.
        body: { state: [{ '@cbor': 'map', entries: [] }, {}] },
      },
    },
  };
}

/**
 * Intercept the production indexer origin. `options` selects the behaviour under
 * test so a single flow can prove both the honest and the degraded path.
 */
export async function mockIndexer(page: Page, options: MockIndexerOptions = {}): Promise<void> {
  await page.route('https://ootle-indexer-a.tari.com/**', async (route: Route) => {
    const identity = options.identity ?? 'esmeralda';
    const url = new URL(route.request().url());

    // The identity preflight is a GET on /info and must be answered before any
    // discovery query is issued. Answering it here is what makes the production
    // discovery path exercisable without a real chain.
    if (url.pathname === '/info') {
      if (identity === 'garbage') {
        await route.fulfill({ status: 200, contentType: 'text/plain', body: 'not json at all' });
        return;
      }
      if (identity === 'unidentified') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: '0.42.0' }) });
        return;
      }
      if (identity === 'wrong-network') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...ESMERALDA_IDENTITY, network: 'igor', network_byte: 36 }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ESMERALDA_IDENTITY) });
      return;
    }

    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    // v0.42.0 REMOVED `/templates/cached`; the live host answers HTTP 400. A mock
    // that served it would hide the removal, so it is answered as the error it is.
    if (url.pathname === '/templates/cached') {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'removed in v0.42.0' }) });
      return;
    }

    // The replacement for `/templates/cached`.
    if (url.pathname === '/templates/catalogue') {
      if (options.failDiscovery) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'simulated indexer outage' }) });
        return;
      }
      const filter = url.searchParams.get('name_filter') ?? '';
      const entries = [
        // A different template whose name CONTAINS the filter. Only an exact
        // name match may be accepted, or this would masquerade as our pool.
        OTHER_POOL_TEMPLATE,
        ...(options.unpublished
          ? []
          : [{ template_address: POOL_TEMPLATE_ADDRESS, template_name: 'Pool', author_public_key: '00'.repeat(32), binary_hash: '44'.repeat(32), at_epoch: 11714 }]),
      ];
      await json({ entries: entries.filter((entry) => entry.template_name.includes(filter)) });
      return;
    }

    if (url.pathname === '/transaction-receipts') {
      if (options.unpublished) {
        // Published but never instantiated from.
        await json({ receipts: [] });
        return;
      }
      const ids = [POOL_COMPONENT, SAFE_POOL_COMPONENT];
      await json(receipts(options.hostile ? [...ids, ...HOSTILE_COMPONENT_IDS] : ids));
      return;
    }

    if (url.pathname === '/substates/fetch') {
      // v0.43 contract: body is `{ requests: [<id string>,…], cached_only }`, and
      // the response `substates` is a MAP keyed by substate id (v0.42 sent
      // `{ substate_id }` objects and an array response).
      let requested: string[] = [];
      try {
        const body = route.request().postDataJSON() as { requests?: string[] };
        requested = (body.requests ?? []).filter((id): id is string => typeof id === 'string');
      } catch {
        requested = [];
      }
      // Echo back ONLY the ids this mock knows. A durable-registry seed/cache entry
      // that this chain does not have is correctly dropped at reverification, rather
      // than being echoed back as a phantom pool.
      const known = new Set<string>([POOL_COMPONENT, SAFE_POOL_COMPONENT, ...(options.hostile ? HOSTILE_COMPONENT_IDS : [])]);
      const substates = Object.fromEntries(
        requested.filter((id) => known.has(id)).map((id) => [id, componentSubstate(POOL_TEMPLATE_ADDRESS)]),
      );
      await json({ substates });
      return;
    }

    // The marketplace surface keeps its older envelope; that query protocol is
    // unchanged by v0.42.0.
    let body: unknown = { data: [] };
    try {
      const payload = (route.request().postDataJSON() ?? {}) as { query?: string };
      if (options.failDiscovery && payload.query !== undefined) body = { errors: ['simulated indexer outage'] };
    } catch {
      body = { data: [] };
    }
    await json(body);
  });
}

/** Simulate a total indexer outage: every request fails at the transport. */
export async function simulateIndexerOutage(page: Page): Promise<void> {
  await page.route('https://ootle-indexer-a.tari.com/**', (route) => route.abort('failed'));
}