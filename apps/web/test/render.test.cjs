require('./bootstrap.cjs');
/**
 * Server-render tests.
 *
 * `renderToString` does not run effects, so these assert what a user actually
 * sees for each state: pool discovery, the pool page, the swap card, the route
 * panel, the activity page, and the shell. They are the closest thing to a
 * screenshot in a build with no browser dependency.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createElement: h, Fragment } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter, Route, Routes } = require('react-router-dom');

const { AppProvider } = require('../build-test/state/AppContext.js');
const { AppShell, OutageNotice } = require('../build-test/components/AppShell.js');
const { PoolsPage } = require('../build-test/pages/PoolsPage.js');
const { PoolPage } = require('../build-test/pages/PoolPage.js');
const { ActivityPage } = require('../build-test/pages/ActivityPage.js');
const { SwapCard } = require('../build-test/components/SwapCard.js');
const { RoutePanel } = require('../build-test/components/RoutePanel.js');
const { resolveConfig } = require('../build-test/services/config.js');
const { parsePoolDescriptor } = require('../build-test/services/pools.js');

const TEST_CONFIG = resolveConfig({ MODE: 'test', DEV: false, VITE_TARI_NETWORK: 'esmeralda' });

const POOL_RAW = {
  poolComponent: 'component_pool_tari_wstable_0001',
  resourceA: 'otl_canonical_tari',
  resourceB: 'otl_wstable_0001',
  baseResource: 'otl_canonical_tari',
  quoteResource: 'otl_wstable_0001',
  baseSymbol: 'TARI',
  quoteSymbol: 'wSTABLE',
  baseDecimals: '6',
  quoteDecimals: '6',
  safetyClass: 'ISSUER_CONTROLLED',
  baseSafetyClass: 'CANONICAL_TARI',
  quoteSafetyClass: 'ISSUER_CONTROLLED',
  feeBps: '30',
};

const ISSUER_CONTROLLED_POOL = parsePoolDescriptor(POOL_RAW);
const SAFE_POOL = parsePoolDescriptor({ ...POOL_RAW, poolComponent: 'component_pool_a_b_0002', baseSymbol: 'AAA', quoteSymbol: 'BBB', baseSafetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED', quoteSafetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED', safetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED' });

function renderWithProviders(element, { pools = [], path = '/', route = '*' } = {}) {
  return renderToStaticMarkup(
    h(
      MemoryRouter,
      { initialEntries: [path] },
      h(
        AppProvider,
        { config: TEST_CONFIG, pools },
        h(
          Routes,
          null,
          h(Route, { path: route, element }),
          h(Route, { path: '*', element: h(Fragment, null) }),
        ),
      ),
    ),
  );
}

function renderShell(element, { pools = [] } = {}) {
  return renderToStaticMarkup(
    h(MemoryRouter, { initialEntries: ['/'] }, h(AppProvider, { config: TEST_CONFIG, pools }, h(AppShell, null, element))),
  );
}

test('pools page: renders discovered pools with the full metric set and honest gaps', () => {
  const html = renderWithProviders(h(PoolsPage, null), { pools: [ISSUER_CONTROLLED_POOL, SAFE_POOL] });
  assert.match(html, /Pools/);
  assert.match(html, /TARI \/ wSTABLE/);
  assert.match(html, /AAA \/ BBB/);
  // Column headers the mission requires.
  for (const column of ['Pair', 'Price', '24h change', '24h volume', 'Liquidity', '24h LP fees', 'Market data', 'Asset safety']) {
    assert.ok(html.includes(column), `column "${column}" must be present`);
  }
  // No market data is connected, so every metric is the explicit unavailable
  // marker, never a fabricated zero.
  assert.ok(html.includes('—'), 'unavailable metrics render as an em dash');
  assert.equal(/<td class="right num">0<\/td>/.test(html), false, 'no metric is fabricated as zero');
  // The weakest classification of each pair drives the safety badge.
  assert.match(html, /Issuer controlled/);
  assert.match(html, /Public \/ immutable/);
});

test('pools page: an unavailable discovery is stated, not papered over', () => {
  const html = renderWithProviders(h(PoolsPage, null), { pools: [] });
  // No injected pools and no configured discovery endpoint.
  assert.match(html, /Pool discovery unavailable|No pools to show/);
});

test('pool page: read-only mode is announced and the swap control is disabled', () => {
  const html = renderWithProviders(h(PoolPage, null), { pools: [ISSUER_CONTROLLED_POOL], path: `/pools/${ISSUER_CONTROLLED_POOL.poolComponent}`, route: '/pools/:poolComponent' });
  assert.match(html, /Read-only mode/);
  assert.match(html, /Connect wallet to swap/);
  assert.match(html, /disabled/);
  // Header metrics are unavailable without market data, and marked as such.
  assert.match(html, /Informational|—/);
});

test('pool page: an issuer-controlled asset triggers an explicit warning', () => {
  const html = renderWithProviders(h(PoolPage, null), { pools: [ISSUER_CONTROLLED_POOL], path: `/pools/${ISSUER_CONTROLLED_POOL.poolComponent}`, route: '/pools/:poolComponent' });
  assert.match(html, /Issuer controlled asset in this pool/);
  assert.match(html, /recall, freeze, or change/);
  // A chart or a listing never implies vetting.
  assert.equal(/is vetted|is safe|guaranteed safe/i.test(html), false);
});

test('pool page: a fully public pair shows no issuer warning', () => {
  const html = renderWithProviders(h(PoolPage, null), { pools: [SAFE_POOL], path: `/pools/${SAFE_POOL.poolComponent}`, route: '/pools/:poolComponent' });
  assert.equal(html.includes('Issuer controlled asset in this pool'), false);
  assert.match(html, /Public \/ immutable/);
});

test('pool page: an unknown pool address is a not-found state, not a blank page', () => {
  const html = renderWithProviders(h(PoolPage, null), { pools: [SAFE_POOL], path: '/pools/does_not_exist', route: '/pools/:poolComponent' });
  assert.match(html, /Pool not found/);
});

test('swap card: shows the atomic-swap blocker instead of a working button', () => {
  const html = renderWithProviders(h(SwapCard, { pool: ISSUER_CONTROLLED_POOL }), { pools: [ISSUER_CONTROLLED_POOL] });
  assert.match(html, /Wallet upgrade required for atomic XTM swaps/);
  assert.match(html, /does not fall back to a local wallet service/);
  assert.match(html, /Real cross-chain submit/);
  assert.match(html, /gated OFF/);
  // Slippage presets are present and the protocol ceiling is documented.
  for (const preset of ['0.1%', '0.5%', '1.0%']) assert.match(html, new RegExp(preset.replace('.', '\\.')));
  assert.match(html, /refuses any tolerance above 50%/);
});

test('swap card: no quote is invented without an authoritative reread', () => {
  const html = renderWithProviders(h(SwapCard, { pool: ISSUER_CONTROLLED_POOL }), { pools: [ISSUER_CONTROLLED_POOL] });
  assert.match(html, /Connect a wallet to quote/);
  assert.equal(/value="[0-9]"/.test(html), false, 'no expected output is displayed without a resolver result');
});

test('route panel: capability-blocked state lists the hops and the gate', () => {
  const html = renderShell(
    h(RoutePanel, {
      headline: 'XTM → stablecoin, two hops',
      description: 'Hop 1 then hop 2.',
      available: false,
      unavailableHeadline: 'Wallet upgrade required for atomic XTM swaps',
      unavailableReason: 'No browser-safe Minotari wallet provider exposes the traced L1 SHA atomic-swap primitives yet.',
      realSubmit: { enabled: false, reason: 'Real cross-chain submission is gated OFF' },
    }),
  );
  for (const node of ['XTM', 'Fast XTM / TARI', 'TARI', 'AMM', 'Destination asset']) {
    assert.ok(html.includes(node), `route node "${node}" must be rendered`);
  }
  assert.match(html, /Wallet upgrade required/);
  assert.match(html, /gated OFF/);
});

test('activity page: all five operation states are defined, including UNKNOWN', () => {
  const html = renderWithProviders(h(ActivityPage, null), { path: '/activity', route: '/activity' });
  for (const state of ['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN']) {
    assert.ok(html.includes(state), `state ${state} must be documented in the UI`);
  }
  assert.match(html, /being reconciled by durable identifier/);
  assert.equal(/Retry/i.test(html), false, 'there is no blind retry control');
  assert.match(html, /No operations recorded/);
});

test('shell: testnet is always visible and mainnet is never selectable', () => {
  const html = renderShell(h('div', null, 'content'), { pools: [SAFE_POOL] });
  assert.match(html, /Esmeralda Testnet/);
  assert.match(html, />TESTNET</);
  // Mainnet may only appear in the sentence that says it is disabled — never as
  // a network that can be chosen.
  assert.match(html, /Mainnet is not selectable/);
  assert.equal(/<option[^>]*mainnet/i.test(html), false, 'no network selector offers mainnet');
  const { FRONTEND_NETWORKS } = require('../build-test/lib/networks.js');
  assert.deepEqual(Object.keys(FRONTEND_NETWORKS).sort(), ['esmeralda', 'localnet']);
  // TradingView attribution is present and links out.
  assert.match(html, /TradingView Lightweight Charts/);
  assert.match(html, /https:\/\/www\.tradingview\.com\//);
  assert.match(html, /Copyright 2023 TradingView/);
  // No developer fee is claimed.
  assert.match(html, /no developer trading fee/i);
  // Accessibility affordances.
  assert.match(html, /Skip to main content/);
  assert.match(html, /<main id="main"/);
});

test('shell: an issuer-free pool list still renders the navigation and status', () => {
  const html = renderShell(h('div', null, 'x'), { pools: [] });
  assert.match(html, /Pools/);
  assert.match(html, /NFTs/);
  assert.match(html, /Activity/);
  assert.match(html, /No wallet/);
});

test('render: pages never force a fixed width that would break a narrow viewport', () => {
  const html = renderWithProviders(h(PoolsPage, null), { pools: [ISSUER_CONTROLLED_POOL] });
  assert.equal(html.includes(ISSUER_CONTROLLED_POOL.poolComponent), true);
  // Widths in the markup may only shrink-wrap (`max-width`); a bare `width` in
  // pixels would force horizontal overflow on a 360px phone. The table itself
  // lives inside a scroll container instead of being squeezed.
  const bareWidths = html.match(/(?<!max-)width:\s*\d+px/g) ?? [];
  assert.deepEqual(bareWidths, [], 'no bare pixel width may be set on an element');
  assert.match(html, /class="table-wrap"/, 'wide tables scroll instead of overflowing the page');
  // The narrow-viewport rules live in the stylesheet; see test/security.test.cjs.
});

test('accessibility: icon-only and status controls carry accessible names', () => {
  const html = renderWithProviders(h(SwapCard, { pool: ISSUER_CONTROLLED_POOL }), { pools: [ISSUER_CONTROLLED_POOL] });
  assert.match(html, /aria-label="Reverse swap direction"/);
  assert.match(html, /aria-label="Estimated output"/);
  assert.match(html, /aria-invalid|aria-describedby/);
  // A status badge carries a text label, never colour alone.
  assert.match(html, /class="badge[^"]*"[^>]*>.*?Issuer controlled/s);
});




// ---------------------------------------------------------------------------
// Outage surface (mission §35): the app must say it is degraded, globally,
// rather than leaving the user to infer an outage from empty tables.
// ---------------------------------------------------------------------------

const { presentHealth } = require('../build-test/lib/health.js');

function outageState(overrides = {}) {
  return {
    loading: false,
    discovery: { pools: [], source: 'indexer:example.invalid', unavailableReason: 'Pool discovery is unavailable. The discovery endpoint did not answer within 12s.' },
    pools: [],
    health: presentHealth({ status: 'UNAVAILABLE', source: 'indexer:example.invalid', reason: 'The discovery endpoint did not answer within 12s.' }),
    ...overrides,
  };
}

test('outage: the shell states the outage globally instead of only showing empty tables', () => {
  const html = renderToStaticMarkup(h(OutageNotice, { state: outageState() }));
  assert.match(html, /Market data is unavailable/);
  assert.match(html, /did not answer within 12s/);
  // It must be honest about what is and is not affected.
  assert.match(html, /Nothing is being fabricated/);
  assert.match(html, /authoritative rereads.*are unaffected|Wallet signing and authoritative rereads/);
});

test('outage: no banner is rendered while discovery is still running', () => {
  const html = renderToStaticMarkup(h(OutageNotice, { state: outageState({ loading: true }) }));
  assert.equal(html, '', 'a loading state is not an outage yet');
});

test('outage: a healthy source never renders the outage banner', () => {
  const html = renderToStaticMarkup(
    h(OutageNotice, {
      state: {
        loading: false,
        discovery: { pools: [], source: 'indexer:example.invalid' },
        pools: [],
        health: presentHealth({ status: 'SYNCED', source: 'indexer:example.invalid' }),
      },
    }),
  );
  assert.equal(html, '', 'an empty-but-healthy list is not an outage');
});

