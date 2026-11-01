require('./bootstrap.cjs');
/**
 * The maker surface, as a user actually sees it before anything is read.
 *
 * `renderToStaticMarkup` runs no effects, so this is the first frame: no wallet, no balance
 * read, nothing promised. That frame is where a liquidity venue is most tempted to lie — a
 * plausible inventory figure, a tradeable-looking offer, a yield — so these assert that the
 * first frame says exactly what is true and offers nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement: h } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');

const { AppProvider } = require('../build-test/state/AppContext.js');
const { MakerInventoryPanel } = require('../build-test/components/MakerInventoryPanel.js');
const { CrossLayerMarketPage } = require('../build-test/pages/CrossLayerMarketPage.js');
const { resolveConfig } = require('../build-test/services/config.js');
const pc = require('@tari-ootle/protocol-client');

const CONFIG = resolveConfig({ MODE: 'test', DEV: false, VITE_TARI_NETWORK: 'esmeralda' });

function render(element) {
  return renderToStaticMarkup(h(MemoryRouter, null, h(AppProvider, { config: CONFIG }, element)));
}

test('the first frame says publishing escrows nothing, and promises no return', () => {
  const html = render(h(MakerInventoryPanel, null));
  // The structural fact that shapes the whole surface: an escrow names its claimant at fund
  // time, so a published offer cannot be backed by one.
  assert.match(html, /Publishing an offer escrows nothing/);
  assert.match(html, /no pre-funded escrow waiting for whoever turns up/);
  assert.match(html, /remain yours to spend/);
  // No yield, no APY, no automatic access to anything the operator holds.
  assert.match(html, /Nothing here guarantees you a return/);
  assert.match(html, /no yield, no APY and no automatic access/);
  assert.doesNotMatch(html, /guaranteed (profit|return|yield)/i);
  assert.doesNotMatch(html, /\bAPY of\b/i);
});

test('inventory reads as UNKNOWN before any chain read, never as a zero or an estimate', () => {
  const html = render(h(MakerInventoryPanel, null));
  assert.match(html, /never read &#x27;?|never read — unknown/, 'the balance is reported as never read');
  assert.match(html, /Unpromised \(available to quote\)/);
  assert.match(html, /unknown/);
  // And the publish control is not offered: there is nothing verified to advertise.
  assert.match(html, /Publish this advertisement/);
  assert.match(html, /<button[^>]*disabled[^>]*>Publish this advertisement<\/button>/);
});

test('the panel never renders a tradeable-looking offer or promise on its first frame', () => {
  const html = render(h(MakerInventoryPanel, null));
  assert.match(html, /An offer here is an advertisement of a price. It moves nothing and escrows nothing/);
  assert.match(html, /Nothing promised/);
  assert.match(html, /Nothing to recover/);
  assert.match(html, /Nothing has settled yet/);
  // The recovery distinction a maker most needs: an expired escrow is not available inventory.
  assert.match(html, /does not return to your available inventory/);
  assert.match(html, /until a refund transaction is signed and lands/);
});

test('both sides of the market are reachable, and they are separate surfaces', () => {
  const html = render(h(CrossLayerMarketPage, null));
  assert.match(html, /Take an offer/);
  assert.match(html, /Provide liquidity/);
  // The taker side is the default, and the burn route is never offered as a fallback here.
  assert.match(html, /This is an exchange, not a swap in one transaction/);
  assert.doesNotMatch(html, /burn-and-claim conversion, which is one-way[^<]*<\/strong>\s*fallback/i);
});

test('the maker panel gates on the SAME predicate the ledger refuses on', () => {
  // The gate is not a separate UI rule that could drift: the panel publishes only when the book
  // reports available inventory, and the book reports it only from a chain read.
  const book = pc.emptyBook('esmeralda');
  assert.equal(pc.uncommittedRaw(book, 'L2'), undefined);
  assert.equal(pc.chainSummary(book, 'L2', { l2CurrentEpoch: 100, l1TipHeight: 0 }).availableRaw, undefined);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MakerInventoryPanel.tsx'), 'utf8');
  // Publishing is refused when available is unknown, and refused again when the advertised
  // figure exceeds it. Both are the lie this surface exists to avoid.
  assert.match(source, /if \(available === undefined\)/);
  assert.match(source, /BigInt\(advertised\) > BigInt\(available\)/);
  assert.match(source, /Advertising more than you hold is the one thing this screen will not do/);
  // The exit direction is refused outright rather than published on an unverifiable balance.
  assert.match(source, /an exit offer cannot be published here/);
  assert.match(source, /payOutChain === 'L1'/);
});

test('the exit direction pays out on L1, which the browser cannot read or sign', () => {
  // Derived from the direction, so the panel cannot be pointed at the chain it has more of.
  assert.equal(pc.makerEscrowChain('L2_TO_L1'), 'L1');
  assert.equal(pc.makerEscrowChain('L1_TO_L2'), 'L2');
  // And no browser wallet can complete an L1 leg, refunds included.
  assert.equal(pc.planSigners('L2_TO_L1', ['UNIVERSE_CONNECTOR']).ok, false);
  assert.equal(pc.planSigners('L1_TO_L2', ['UNIVERSE_CONNECTOR']).ok, false);
  assert.equal(pc.planSigners('L2_TO_L1', ['UNIVERSE_CONNECTOR', 'LOCAL_WALLETD_GRPC']).ok, true);
});
