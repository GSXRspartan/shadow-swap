require('./bootstrap.cjs');
/**
 * SwapOffer terms are read from CHAIN STATE: engine bytes -> official v0.48 decoder ->
 * protocol-client `decodeSwapOffer`. The fixture is produced by the real engine
 * (audit_engine_tests/tests/swapoffer_wire_v048.rs) for open (fungible, with designated taker,
 * hash lock and expiry), open NFT barter, filled and cancelled offers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ootle-v048-swapoffer-wire.json');
const { loadOotleWasmBor } = require('./support/ootleWasmBor.cjs');
const pc = require('@tari-ootle/protocol-client');

async function readerFor(offer, mutate) {
  const d = await loadOotleWasmBor();
  const map = new Map(Object.entries(offer.substates).map(([id, e]) => [id, d.decodeSubstateValue(e.value)]));
  if (mutate) mutate(map, offer);
  return { read: async (id) => map.get(id) };
}

const offer = (name) => fixture.offers.find((o) => o.name === name);

test('decoder: every engine-produced offer state decodes to exactly the terms the engine was given', async () => {
  for (const o of fixture.offers) {
    const s = await pc.decodeSwapOffer(await readerFor(o), o.component, [fixture.template]);
    const e = o.expect;
    assert.equal(s.status, e.status.toUpperCase(), o.name);
    assert.equal(s.offered.resourceAddress, e.offered.resource, o.name);
    if (e.offered.kind === 'fungible') assert.equal(s.offered.amount, e.offered.amount, o.name);
    else assert.deepEqual(s.offered.tokenIds, e.offered.nftIds, o.name);
    assert.equal(s.requested.resource, e.requested.resource, o.name);
    if (e.requested.kind === 'fungible') {
      assert.equal(s.requested.amount, e.requested.amount, o.name);
      assert.equal(s.requested.nftId, null);
    } else assert.equal(s.requested.nftId, e.requested.nftId, o.name);
    assert.equal(s.maker, e.maker, `${o.name}: maker key comes from the claim/cancel access rule`);
    assert.equal(s.designatedTaker, e.designatedTaker, `${o.name}: taker comes from the fill access rule`);
    assert.equal(s.hashLock, e.hashLock, o.name);
    assert.equal(s.expiresAtEpoch, e.expiresAtEpoch, o.name);
    assert.equal(s.proceeds.amount === '0' && s.proceeds.tokenIds.length === 0 ? '0' : s.proceeds.amount, e.proceeds, o.name);
  }
});

test('decoder: expiry follows the template (0 never expires; expired at/after the epoch)', async () => {
  const s = await pc.decodeSwapOffer(await readerFor(offer('open_fungible')), offer('open_fungible').component, [fixture.template]);
  assert.equal(pc.swapOfferExpired(s, '999999'), false);
  assert.equal(pc.swapOfferExpired(s, '1000000'), true);
  assert.equal(pc.swapOfferExpired({ expiresAtEpoch: '0' }, '99999999'), false);
});

test('decoder: a component of an unrecorded template is refused, however SwapOffer-shaped', async () => {
  const o = offer('open_fungible');
  await assert.rejects(pc.decodeSwapOffer(await readerFor(o), o.component, ['ab'.repeat(32)]), /not a SwapOffer template recorded/);
  await assert.rejects(pc.decodeSwapOffer(await readerFor(o), o.component, []), /not a SwapOffer template recorded/);
});

test('decoder: an escrow vault holding a different resource than declared is refused', async () => {
  const o = offer('open_fungible');
  const reader = await readerFor(o, (map) => {
    for (const [id, v] of map) if (id.startsWith('vault_') && v.Vault.resource_container.Fungible?.amount === '1000') v.Vault.resource_container.Fungible.address = `resource_${'ee'.repeat(32)}`;
  });
  await assert.rejects(pc.decodeSwapOffer(reader, o.component, [fixture.template]), /holds resource_(ee){32}/);
});

test('decoder: rules that are not exactly the SwapOffer rules are refused (owner, default, extra method, odd fill rule)', async () => {
  const o = offer('open_fungible');
  const cases = [
    (c) => { c.header.owner_rule = 'OwnedBySigner'; },
    (c) => { c.header.access_rules.default = 'AllowAll'; },
    (c) => { c.header.access_rules.method_access.drain = 'AllowAll'; },
    (c) => { c.header.access_rules.method_access.fill = { Restricted: { Require: { AnyOf: [] } } }; },
    (c) => { c.header.access_rules.method_access.claim = 'AllowAll'; },
    (c) => { c.header.access_rules.method_access.cancel = c.header.access_rules.method_access.fill; },
  ];
  for (const mutate of cases) {
    const reader = await readerFor(o, (map) => mutate(map.get(o.component).Component));
    await assert.rejects(pc.decodeSwapOffer(reader, o.component, [fixture.template]), pc.MarketplaceDecodeError, mutate.toString());
  }
});

test('decoder: an OPEN offer with an empty escrow, a bad status or a malformed state is refused', async () => {
  const o = offer('open_fungible');
  const cases = [
    (map) => { for (const [id, v] of map) if (id.startsWith('vault_') && v.Vault.resource_container.Fungible?.amount === '1000') v.Vault.resource_container.Fungible.amount = '0'; },
    (map) => { map.get(o.component).Component.body.state[8] = [7, []]; },
    (map) => { map.get(o.component).Component.body.state.pop(); },
    (map) => { map.get(o.component).Component.body.state[4] = 1.5; },
    (map) => { map.get(o.component).Component.body.state[6] = { '@cbor': 'bytes', hex: 'ab' }; },
  ];
  for (const mutate of cases) {
    await assert.rejects(pc.decodeSwapOffer(await readerFor(o, mutate), o.component, [fixture.template]), pc.MarketplaceDecodeError, mutate.toString());
  }
});
