require('./bootstrap.cjs');
/**
 * The Support Development surface, as a visitor actually sees it.
 *
 * `renderToStaticMarkup` runs no effects, which suits this screen exactly: the whole claim being
 * tested is that the first frame is complete and inert. No wallet, no transaction, no amount
 * field, no network request — just two addresses, one of which is not configured, and the copy
 * that says so.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement: h } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');

const { AppProvider } = require('../build-test/state/AppContext.js');
const { SupportDevelopmentPanel } = require('../build-test/components/SupportDevelopmentPanel.js');
const { SupportPage } = require('../build-test/pages/SupportPage.js');
const { resolveConfig } = require('../build-test/services/config.js');
const qr = require('../build-test/lib/qr.js');
const pc = require('@tari-ootle/protocol-client');

const CONFIG = resolveConfig({ MODE: 'test', DEV: false, VITE_TARI_NETWORK: 'esmeralda' });

function render(element) {
  return renderToStaticMarkup(h(MemoryRouter, null, h(AppProvider, { config: CONFIG }, element)));
}

const panel = (l2Network) => render(h(SupportDevelopmentPanel, { l2Network }));

test('the heading and the required copy are present, verbatim', () => {
  const html = panel('esmeralda');
  assert.match(html, /Support Shadow Swap Development/);
  assert.match(html, /Shadow Swap is a public, noncustodial exchange/);
  assert.match(html, /you can make a voluntary donation/);
  assert.match(html, /Donations are optional and are not required to trade, provide liquidity, or withdraw funds\./);
});

test('THE FULL XTM ADDRESS IS SHOWN, labelled L1 Mainnet, with a copy control', () => {
  const html = panel('esmeralda');
  // The whole address, not a truncation: a donor has to be able to check it character by
  // character against whatever the operator published elsewhere.
  assert.ok(html.includes(pc.XTM_DONATION_ADDRESS_MAINNET), 'the full address appears');
  assert.match(html, /Minotari L1 Mainnet/);
  assert.match(html, /XTM \(Minotari L1\)/);
  assert.match(html, /Copy address/);
  // A live region for the copy acknowledgement, so the confirmation is announced and not just
  // coloured.
  assert.match(html, /role="status" aria-live="polite"/);
  // Selectable text, so a browser that blocks the clipboard API still leaves a way to copy.
  assert.match(html, /user-select:all/);
});

test('the XTM section warns to send only compatible mainnet XTM, and that it is not an L2 address', () => {
  const html = panel('esmeralda');
  assert.match(html, /Send only XTM on the Minotari base layer \(L1\)/);
  assert.match(html, /not an Ootle \(L2\) address and cannot receive Ootle TARI/);
  assert.match(html, /one-sided \(non-interactive\) payments/);
});

test('THE QR PAYLOAD IS THE ADDRESS, and the symbol is rendered as a real matrix', () => {
  const html = panel('esmeralda');
  // The rendered path must be exactly the one the encoder produces for the configured address —
  // so the QR cannot drift from the text beside it.
  const matrix = qr.encodeQr(pc.XTM_DONATION_ADDRESS_MAINNET);
  const expectedPath = qr.qrSvgPath(matrix);
  assert.ok(html.includes(expectedPath), 'the SVG path encodes the configured donation address');
  assert.ok(html.includes(`viewBox="${qr.qrViewBox(matrix)}"`), 'the view box includes the quiet zone');
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="QR code for the XTM donation address on Minotari L1 Mainnet"/);
  assert.match(html, new RegExp(`QR version ${matrix.version}, error correction level M`));
});

test('THE OOTLE SECTION IS DISABLED WITH ITS REASON, and shows no other network\'s address', () => {
  const html = panel('esmeralda');
  assert.match(html, /TARI \(Ootle L2\)/);
  assert.match(html, /Not available yet/);
  assert.match(html, /test currency with no value/);
  // Both controls are disabled, and announced as disabled.
  assert.match(html, /<button[^>]*disabled[^>]*aria-disabled="true"[^>]*>Copy address<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*aria-disabled="true"[^>]*>Show QR code<\/button>/);
  assert.match(html, /No other network&#x27;s\s*address is shown in its place/);
  // Critically: the L1 address must NOT appear inside the L2 section as a fallback. It appears
  // exactly once on the page, in the XTM card.
  const occurrences = html.split(pc.XTM_DONATION_ADDRESS_MAINNET).length - 1;
  assert.equal(occurrences, 1, 'the XTM address appears once, and never as the L2 destination');
});

test('switching the configured L2 network changes which unavailable reason is shown', () => {
  // §10: mainnet and Esmeralda are distinct entries. A mainnet build must not be told the
  // Esmeralda reason, because the remedies are different — one waits for a launch, the other
  // never gets an address at all.
  assert.match(panel('esmeralda'), /test currency with no value/);
  const mainnet = panel('mainnet');
  assert.match(mainnet, /has not launched/);
  assert.match(mainnet, /A placeholder would be worse than nothing/);
  assert.equal(/test currency with no value/.test(mainnet), false);
  // A network with no entry at all still refuses rather than inheriting.
  assert.match(panel('localnet'), /no other network&#x27;s address is ever used in its place/i);
});

test('NO WALLET IS REQUIRED and NO TRANSACTION IS PREPARED', () => {
  const html = panel('esmeralda');
  // The config used here has no wallet connected at all, and the page is complete.
  assert.ok(html.includes(pc.XTM_DONATION_ADDRESS_MAINNET));
  assert.match(html, /No wallet connection is needed to view or copy these addresses/);
  assert.match(html, /opening this panel prepares no transaction/);
  assert.equal(/Connect wallet/i.test(html), false, 'no connect prompt');
  // No amount input, no send control: there is nothing to submit from this screen.
  assert.equal(/<input/.test(html), false, 'no input fields at all');
  // Scoped to CONTROLS rather than prose: the safety note legitimately says "Send only XTM...",
  // and the thing that must not exist is a button that sends.
  const controlLabels = (html.match(/<button[^>]*>([^<]*)</g) || []).map((match) => match.replace(/.*>/, ''));
  assert.ok(controlLabels.length > 0, 'there are controls to check');
  for (const label of controlLabels) {
    assert.equal(/send|donate|submit|sign|approve/i.test(label), false, 'no control may offer to send: ' + label);
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SupportDevelopmentPanel.tsx'), 'utf8');
  for (const name of ['buildTransaction', 'submitTransaction', 'signTransaction', 'walletBridge', 'useApp']) {
    assert.equal(source.includes(name), false, `the donation panel must not reference ${name}`);
  }
});

test('the donation surface is a page in the footer, not a modal over trading', () => {
  const html = render(h(SupportPage, null));
  assert.match(html, /Support Shadow Swap Development/);
  // Not a dialog: nothing here traps focus or overlays the app.
  assert.equal(/role="dialog"/.test(html), false);
  assert.equal(/class="overlay"/.test(html), false);
});

test('the panel adds no fee and claims no privilege', () => {
  const html = panel('esmeralda');
  assert.match(html, /A donation is separate from exchange fees/);
  assert.match(html, /nothing is deducted from a trade, a liquidity position or a withdrawal/);
  assert.match(html, /no fee discount, no priority, no special access to liquidity, no\s*share of trading fees/);
  assert.match(html, /Liquidity provider fees go entirely\s*to liquidity providers/);
  assert.doesNotMatch(html, /guaranteed|refundable in|投/);
  assert.match(html, /not refundable and not a payment for a service/);
});

test('keyboard and mobile affordances: real buttons, labelled regions, no fixed widths', () => {
  const html = panel('esmeralda');
  // Every control is a real <button type="button"> with a text label — reachable by Tab and
  // announced by a screen reader, with no icon-only affordance.
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length >= 3, 'there are controls');
  for (const button of buttons) assert.match(button, /type="button"/);
  assert.equal(/<div[^>]*role="button"/.test(html), false, 'no fake buttons');
  // The address is a labelled region rather than bare text.
  assert.match(html, /aria-labelledby="addr-label-XTM"/);
  // Mobile: the QR scales with the viewport and the address wraps instead of overflowing.
  assert.match(html, /width:min\(200px, 60vw\)/);
  assert.match(html, /word-break:break-all/);
  assert.equal(/width:\s*\d{3,}px/.test(html.replace(/width="200"|height="200"/g, '')), false, 'no fixed pixel widths that would overflow a phone');
});

test('a donation address that failed its own network check would not be rendered at all', () => {
  // The read path validates on every call, so a future bad edit produces a refusal rather than a
  // quietly wrong address. Driven here through the module's own guard.
  assert.throws(() => pc.assertDonationIsolation('otl_esm_1whatever'), /never comes from token metadata/);
  // And the panel's catch path renders a refusal rather than an address.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SupportDevelopmentPanel.tsx'), 'utf8');
  assert.match(source, /Donation configuration is not valid/);
  assert.match(source, /assertDonationIsolation\(destination\.address\)/);
});
