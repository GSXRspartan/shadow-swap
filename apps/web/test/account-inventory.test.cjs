require('./bootstrap.cjs');
/**
 * What an account holds, read from ENGINE-PRODUCED vault bytes through the official v0.48
 * decoder: the NFT ids a picker lists, the revealed amounts a payment check uses, and the
 * container kind that decides whether a revealed-value mechanism may touch a holding.
 *
 * Fixture: audit_engine_tests/tests/account_inventory_v048.rs — one account holding a public
 * fungible, a created-Stealth revealed balance, a Confidential revealed balance, two NFTs of
 * one collection and one numeric-id NFT of another.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ootle-v048-account-inventory.json');
const { loadOotleWasmBor } = require('./support/ootleWasmBor.cjs');
const pc = require('@tari-ootle/protocol-client');

async function reader(mutate) {
  const d = await loadOotleWasmBor();
  const map = new Map(Object.entries(fixture.substates).map(([id, e]) => [id, d.decodeSubstateValue(e.value)]));
  if (mutate) mutate(map);
  return { read: async (id) => map.get(id) };
}

const expected = (resource) => fixture.expect.find((e) => e.resource === resource);

test('fixture: engine-produced, covers every container kind', () => {
  assert.match(fixture.cohort, /v0\.48\.0 \(6a25dbc5/);
  const kinds = new Set(fixture.expect.map((e) => e.containerKind));
  assert.deepEqual([...kinds].sort(), ['Confidential', 'Fungible', 'NonFungible', 'Stealth']);
});

test('inventory: every holding is found from the account\'s own vaults, with exact amounts and ids', async () => {
  const inv = await pc.readAccountInventory(await reader(), fixture.account);
  assert.equal(inv.account, fixture.account);
  assert.deepEqual(inv.unreadable, [], 'every vault the account references decoded');
  assert.equal(inv.holdings.length, fixture.expect.length);
  for (const want of fixture.expect) {
    const got = inv.holdings.find((h) => h.resourceAddress === want.resource);
    assert.ok(got, `holding ${want.resource}`);
    assert.equal(got.containerKind, want.containerKind, want.resource);
    assert.equal(got.amount, want.amount, want.resource);
    assert.deepEqual([...got.tokenIds].sort(), [...want.tokenIds].sort(), want.resource);
  }
  // Sorted by resource address, so a picker's order is a function of chain state.
  assert.deepEqual([...inv.holdings].map((h) => h.resourceAddress), [...inv.holdings].map((h) => h.resourceAddress).sort());
});

test('inventory: NFT ids come back in upstream canonical form, including the numeric variant', async () => {
  const inv = await pc.readAccountInventory(await reader(), fixture.account);
  const nfts = pc.ownedNfts(inv);
  const ids = nfts.map((n) => n.nftId).sort();
  assert.deepEqual(ids, ['str_art-1', 'str_art-2', 'u64_77'], 'both collections, canonical ids, no fungible holdings');
  // Each id is paired with the collection that actually holds it.
  for (const { resource, nftId } of nfts) {
    assert.ok(expected(resource).tokenIds.includes(nftId), `${nftId} belongs to ${resource}`);
    assert.equal(pc.ownsNft(inv, resource, nftId), true);
  }
  assert.equal(pc.ownsNft(inv, nfts[0].resource, 'str_not-mine'), false, 'an id the account does not hold is not owned');
  const [a, b] = [nfts.find((n) => n.nftId === 'str_art-1'), nfts.find((n) => n.nftId === 'u64_77')];
  assert.notEqual(a.resource, b.resource);
  assert.equal(pc.ownsNft(inv, a.resource, 'u64_77'), false, 'an id is never credited to the wrong collection');
});

test('inventory: revealed balances are exact; an NFT collection reports no spendable amount', async () => {
  const inv = await pc.readAccountInventory(await reader(), fixture.account);
  for (const want of fixture.expect) {
    assert.equal(pc.revealedBalance(inv, want.resource), want.containerKind === 'NonFungible' ? '0' : want.amount, want.resource);
  }
  assert.equal(pc.revealedBalance(inv, `resource_${'ff'.repeat(32)}`), '0', 'a resource the account does not hold is zero, never undefined');
});

test('inventory: a Stealth holding is revealed-only by construction; a Confidential one only while it carries no commitments', async () => {
  const inv = await pc.readAccountInventory(await reader(), fixture.account);
  const stealth = inv.holdings.find((h) => h.containerKind === 'Stealth');
  const confidential = inv.holdings.find((h) => h.containerKind === 'Confidential');
  // A Stealth container has no commitments field at all upstream, so its revealed amount is
  // the whole holding and it is always usable by an exact-integer mechanism.
  assert.equal(stealth.confidentialCommitments, 0);
  assert.equal(stealth.revealedOnly, true);
  assert.equal(confidential.confidentialCommitments, 0, 'this fixture mints revealed-only');
  assert.equal(confidential.revealedOnly, true);

  // With a blinded commitment beside the revealed amount, `amount` is no longer the whole
  // holding: the reader must say so rather than let a revealed-value mechanism use it.
  const withCommitment = await reader((map) => {
    for (const [, v] of map) {
      const c = v.Vault?.resource_container?.Confidential;
      if (c) c.commitments = ['ab'.repeat(32)];
    }
  });
  const tainted = await pc.readAccountInventory(withCommitment, fixture.account);
  const now = tainted.holdings.find((h) => h.containerKind === 'Confidential');
  assert.equal(now.confidentialCommitments, 1);
  assert.equal(now.revealedOnly, false);
  assert.equal(now.amount, confidential.amount, 'the revealed figure itself is unchanged and never inflated by a commitment');
});

test('inventory: a vault that cannot be read is reported, never silently dropped', async () => {
  const some = Object.keys(fixture.substates).find((id) => id.startsWith('vault_'));
  const missing = await reader((map) => map.delete(some));
  const inv = await pc.readAccountInventory(missing, fixture.account);
  assert.equal(inv.holdings.length, fixture.expect.length - 1);
  assert.deepEqual(inv.unreadable.map((u) => u.vaultAddress), [some]);
  const garbled = await reader((map) => map.set(some, { Vault: { resource_container: { Nonsense: {} } } }));
  const inv2 = await pc.readAccountInventory(garbled, fixture.account);
  assert.match(inv2.unreadable[0].reason, /unrecognised container kind/);
});

test('inventory: a malformed account address or missing component is refused', async () => {
  const r = await reader();
  await assert.rejects(pc.readAccountInventory(r, 'not-an-account'), /is not an account component address/);
  await assert.rejects(pc.readAccountInventory(r, `component_${'ab'.repeat(32)}`), /does not exist or could not be read/);
  await assert.rejects(pc.readAccountInventory({ read: async () => ({ Vault: {} }) }, fixture.account), /carries no component state/);
});
