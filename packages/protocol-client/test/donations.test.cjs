/**
 * Donation destinations.
 *
 * A donation address is the only address in this application that is a destination for value and
 * is not derived from the user, the chain, or a transaction they are building. That makes it the
 * most attractive thing to substitute — change one string and donations go elsewhere, with no
 * wallet compromised and nothing else visibly wrong. These tests are about that one risk.
 *
 * The XTM address below is verified rather than assumed: it is parsed with the real Minotari
 * format (three-part base58, DammSum, network byte, feature bits), not matched against a regex.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const L2_LOCALNET =
  'otl_loc_1nsy5c5mfn7jgmg5nm3s3m4vr829tgpeehmymkme6k5wszde6wc7zcfwtyyxwn62tqefqyfyjangalt4zrygzwyf8c6c2jtfqyd8dk0gtwcv5x';

test('THE XTM DONATION ADDRESS IS A VERIFIED MAINNET MINOTARI ADDRESS', () => {
  const parsed = pc.parseMinotariAddress(pc.XTM_DONATION_ADDRESS_MAINNET);
  assert.equal(parsed.network, 'mainnet', 'it must be a MAINNET address: real XTM exists nowhere else');
  assert.equal(parsed.networkByte, 0x00);
  assert.equal(parsed.kind, 'dual');
  assert.equal(parsed.paymentIdBytes, 0);
  // ONE_SIDED means a donor can send without an interactive exchange with the recipient, which is
  // what a public receive-only address needs. It is NOT interactive-only.
  assert.deepEqual(parsed.features, ['ONE_SIDED']);
  assert.equal(pc.XTM_DONATION_NETWORK, 'mainnet');

  const status = pc.xtmDonation('mainnet');
  assert.equal(status.configured, true);
  assert.equal(status.destination.asset, 'XTM');
  assert.equal(status.destination.layer, 'L1_MINOTARI');
  assert.equal(status.destination.networkLabel, 'Minotari L1 Mainnet');
  assert.equal(status.destination.realValue, true);
  assert.match(status.destination.safetyNote, /Send only XTM on the Minotari base layer/);
  assert.match(status.destination.safetyNote, /not an Ootle \(L2\) address/);
  assert.match(status.destination.safetyNote, /one-sided \(non-interactive\) payments/);
});

test('MISSING OOTLE DONATION ADDRESSES REPORT UNAVAILABLE WITH A REASON, and never fall back', () => {
  // Isolation test 9 and the §10 requirements. The fallback is the dangerous feature: a mainnet
  // donor shown a testnet address sends real intent to a worthless destination.
  const mainnet = pc.ootleDonation('mainnet');
  assert.equal(mainnet.configured, false);
  assert.equal(mainnet.asset, 'TARI');
  assert.match(mainnet.reason, /No Ootle mainnet donation address has been supplied yet/);
  assert.match(mainnet.reason, /A placeholder would be worse than nothing/);

  const esmeralda = pc.ootleDonation('esmeralda');
  assert.equal(esmeralda.configured, false);
  assert.match(esmeralda.reason, /test currency with no value/);

  // A network with no entry at all is still unavailable, not inherited from another.
  const localnet = pc.ootleDonation('localnet');
  assert.equal(localnet.configured, false);
  assert.match(localnet.reason, /no other network's address is ever used in its place/);

  // Mainnet and Esmeralda are DISTINCT entries, so one can never be the other.
  assert.equal(pc.OOTLE_DONATION_ADDRESSES.mainnet, undefined);
  assert.equal(pc.OOTLE_DONATION_ADDRESSES.esmeralda, undefined);
  assert.notEqual(Object.prototype.hasOwnProperty.call(pc.OOTLE_DONATION_ADDRESSES, 'mainnet'), false, 'the gap is recorded, not merely omitted');
});

test('A TESTNET XTM ADDRESS IS NOT OFFERED, because a test-currency donation is not a donation', () => {
  const esmeralda = pc.xtmDonation('esmeralda');
  assert.equal(esmeralda.configured, false);
  assert.match(esmeralda.reason, /costs the donor their time/);
  assert.equal(pc.XTM_DONATION_ADDRESSES.esmeralda, undefined);
});

test('a configured address that is wrong for its network is REFUSED, not displayed', () => {
  // The guarantee that makes a future edit safe: the check is in the read path, so the next
  // person to touch the tables gets a refusal rather than a quietly broken address.
  //
  // Driven through the shared validator with the exact substitutions an edit could make.
  assert.equal(pc.requireAddressFor(pc.XTM_DONATION_ADDRESS_MAINNET, { layer: 'L1_MINOTARI', network: 'esmeralda' }).ok, false);
  assert.equal(pc.requireAddressFor(L2_LOCALNET, { layer: 'L2_OOTLE', network: 'mainnet' }).ok, false);
  assert.equal(pc.requireAddressFor(L2_LOCALNET, { layer: 'L1_MINOTARI', network: 'localnet' }).ok, false);
  assert.equal(pc.requireAddressFor(pc.XTM_DONATION_ADDRESS_MAINNET, { layer: 'L2_OOTLE', network: 'mainnet' }).ok, false);
  // And the one correct pairing passes.
  assert.equal(pc.requireAddressFor(pc.XTM_DONATION_ADDRESS_MAINNET, { layer: 'L1_MINOTARI', network: 'mainnet' }).ok, true);
});

test('a donation destination comes from this module and nowhere else', () => {
  // §11: a compromised metadata feed, token symbol, pool registry or URL parameter must not be
  // able to substitute a destination.
  pc.assertDonationIsolation(pc.XTM_DONATION_ADDRESS_MAINNET);
  for (const impostor of [
    L2_LOCALNET,
    `component_${'ab'.repeat(32)}`,
    `resource_${'01'.repeat(32)}`,
    'TARI',
    '',
    pc.XTM_DONATION_ADDRESS_MAINNET.slice(0, -1),
    `${pc.XTM_DONATION_ADDRESS_MAINNET} `,
  ]) {
    assert.throws(
      () => pc.assertDonationIsolation(impostor),
      /never comes from token metadata, a pool registry, a URL parameter, a deployment manifest or the connected account/,
      `must refuse ${JSON.stringify(impostor.slice(0, 24))}`,
    );
  }
});

test('both destinations are returned in display order, with the L2 one network-scoped', () => {
  const [xtm, tari] = pc.donationDestinations('mainnet', 'esmeralda');
  assert.equal(xtm.configured, true);
  assert.equal(xtm.destination.asset, 'XTM');
  assert.equal(tari.configured, false);
  assert.equal(tari.asset, 'TARI');
  assert.match(tari.reason, /test currency/);

  // An Esmeralda build asks about Esmeralda's L2 entry, and a mainnet build about mainnet's. The
  // two give different reasons, which is the point of keeping them separate.
  const [, mainnetTari] = pc.donationDestinations('mainnet', 'mainnet');
  assert.match(mainnetTari.reason, /has not launched/);
});

test('the required disclosures are in the reviewed module, beside the addresses they describe', () => {
  assert.equal(pc.DONATION_DISCLOSURE.heading, 'Support Shadow Swap Development');
  assert.match(pc.DONATION_DISCLOSURE.body, /public, noncustodial exchange/);
  assert.match(pc.DONATION_DISCLOSURE.body, /voluntary donation/);
  assert.equal(
    pc.DONATION_DISCLOSURE.optional,
    'Donations are optional and are not required to trade, provide liquidity, or withdraw funds.',
  );
  assert.match(pc.DONATION_DISCLOSURE.notFees, /separate from exchange fees/);
  assert.match(pc.DONATION_DISCLOSURE.notFees, /nothing is deducted from a trade/);
  assert.match(pc.DONATION_DISCLOSURE.noWallet, /No wallet connection is needed/);
  assert.match(pc.DONATION_DISCLOSURE.noWallet, /prepares no transaction/);
});
