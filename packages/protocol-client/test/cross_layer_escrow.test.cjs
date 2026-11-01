/**
 * Reading a CrossLayerHtlc escrow from chain — the step that turns "a maker says they funded X"
 * into "the component at this address holds X". Without it an offer can be displayed but never
 * verified, and displaying an unverified offer as tradeable is the failure the whole design is
 * arranged to avoid.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const TEMPLATE = 'ab'.repeat(32);
const VAULT = 'cd'.repeat(32);
const RESOURCE = 'ef'.repeat(32);
const HASH = '11'.repeat(32);
const CLAIMANT = '22'.repeat(32);
const FUNDER = '33'.repeat(32);
const COMPONENT = 'component_' + '44'.repeat(32);

/** The engine's own shape: tagged object keys, a byte-string hash, an enum as [index, []]. */
function escrowSubstate(over = {}) {
  const base = {
    vaultTag: VAULT,
    resourceTag: RESOURCE,
    amount: 1000000,
    hash: HASH,
    claimant: CLAIMANT,
    funder: FUNDER,
    expires: 54,
    leg: 'aa'.repeat(32),
    status: [0, []],
    revealed: [0, []],
    ...over,
  };
  return {
    Component: {
      header: { template_address: 'template_' + TEMPLATE, owner_rule: 'None' },
      body: {
        state: [
          { '@cbor': 'tag', value: { hex: base.vaultTag } },
          { '@cbor': 'tag', value: { hex: base.resourceTag } },
          base.amount,
          { hex: base.hash },
          { hex: base.claimant },
          { hex: base.funder },
          base.expires,
          base.leg,
          base.status,
          base.revealed,
        ],
      },
    },
  };
}

function vaultSubstate(amount, resource = 'resource_' + RESOURCE, kind = 'Fungible') {
  return { Vault: { resource_container: { [kind]: { address: resource, amount } } } };
}

const reader = (store) => ({ read: async (address) => store[address] });

test('an escrow decodes into exactly what a taker must check before committing', async () => {
  const store = { [COMPONENT]: escrowSubstate(), ['vault_' + VAULT]: vaultSubstate(1000000) };
  const e = await pc.decodeCrossLayerEscrow(reader(store), COMPONENT);
  assert.equal(e.templateAddress, TEMPLATE, 'the prefix is stripped so it compares to a registry');
  assert.equal(e.resourceAddress, 'resource_' + RESOURCE);
  assert.equal(e.amountRaw, '1000000');
  assert.equal(e.balanceRaw, '1000000');
  assert.equal(e.hashLockHex, HASH);
  assert.equal(e.claimantPublicKeyHex, CLAIMANT);
  assert.equal(e.funderPublicKeyHex, FUNDER);
  assert.equal(e.expiresAtEpoch, 54);
  assert.equal(e.status, 'Funded');
  assert.equal(e.revealedPreimageHex, undefined);
});

test('the LIVE balance is what backs an offer, not the amount the escrow remembers', async () => {
  // A claimed escrow still records what it held but holds nothing. A taker told that the
  // recorded amount backs an offer would be told something false at the worst moment.
  const store = {
    [COMPONENT]: escrowSubstate({ status: [1, []], revealed: [1, [[1, 2, 3, 255]]] }),
    ['vault_' + VAULT]: vaultSubstate(0),
  };
  const e = await pc.decodeCrossLayerEscrow(reader(store), COMPONENT);
  assert.equal(e.amountRaw, '1000000', 'what it promised');
  assert.equal(e.balanceRaw, '0', 'what is actually there');
  assert.equal(e.status, 'Claimed');
  // A claim publishes the secret, which is how the other leg gets completed.
  assert.equal(e.revealedPreimageHex, '010203ff');

  const leg = pc.escrowAsFundedLeg(e);
  assert.equal(leg.amountRaw, '0', 'the funded-leg view reports the live balance');
  assert.equal(leg.settled, true);
});

test('a refunded escrow is settled too, so it can never back a new offer', async () => {
  const store = { [COMPONENT]: escrowSubstate({ status: [2, []] }), ['vault_' + VAULT]: vaultSubstate(0) };
  const e = await pc.decodeCrossLayerEscrow(reader(store), COMPONENT);
  assert.equal(e.status, 'Refunded');
  assert.equal(pc.escrowAsFundedLeg(e).settled, true);
});

test('the decoder fails closed on anything it cannot read, and never defaults', async () => {
  const good = { [COMPONENT]: escrowSubstate(), ['vault_' + VAULT]: vaultSubstate(1000000) };

  await assert.rejects(pc.decodeCrossLayerEscrow(reader({}), COMPONENT), /does not exist or could not be read/);
  // A component with no template cannot be checked against a recorded registry.
  const noTemplate = { ...good, [COMPONENT]: { Component: { header: {}, body: { state: escrowSubstate().Component.body.state } } } };
  await assert.rejects(pc.decodeCrossLayerEscrow(reader(noTemplate), COMPONENT), /carries no template address/);
  // A different component that merely decodes like one.
  const shortState = { ...good, [COMPONENT]: { Component: { header: { template_address: TEMPLATE }, body: { state: [1, 2, 3] } } } };
  await assert.rejects(pc.decodeCrossLayerEscrow(reader(shortState), COMPONENT), /not a CrossLayerHtlc of this build/);
  // An unknown status variant means this build cannot describe the escrow honestly.
  const future = { ...good, [COMPONENT]: escrowSubstate({ status: [7, []] }) };
  await assert.rejects(pc.decodeCrossLayerEscrow(reader(future), COMPONENT), /not one this build knows/);
  // A vault holding something other than the declared resource would make every later check
  // be against the wrong asset.
  const wrongAsset = { ...good, ['vault_' + VAULT]: vaultSubstate(1000000, 'resource_' + '99'.repeat(32)) };
  await assert.rejects(pc.decodeCrossLayerEscrow(reader(wrongAsset), COMPONENT), /but its vault holds/);
  // A missing vault is never treated as a zero balance.
  await assert.rejects(pc.decodeCrossLayerEscrow(reader({ [COMPONENT]: escrowSubstate() }), COMPONENT), /no resource_container/);
});

test('a Stealth-held escrow reads too: the escrowed asset keeps its type', async () => {
  const store = {
    [COMPONENT]: escrowSubstate(),
    ['vault_' + VAULT]: vaultSubstate(2500, 'resource_' + RESOURCE, 'Stealth'),
  };
  const e = await pc.decodeCrossLayerEscrow(reader(store), COMPONENT);
  assert.equal(e.balanceRaw, '2500');
});

test('which maker leg a browser can verify is derived, and the asymmetry is stated', () => {
  // An entry offer's maker escrow is on L2 and readable here; an exit offer's is an L1 output.
  const entry = pc.escrowChainForOffer('L1_TO_L2');
  assert.equal(entry.chain, 'L2');
  assert.equal(entry.browserVerifiable, true);
  assert.match(entry.reason, /verified in the browser before you commit/);

  const exit = pc.escrowChainForOffer('L2_TO_L1');
  assert.equal(exit.chain, 'L1');
  assert.equal(exit.browserVerifiable, false);
  assert.match(exit.reason, /only your own wallet can do/);
  // And it must say what follows: such an offer is shown but never offered as tradeable.
  assert.match(exit.reason, /never offered as tradeable/);
});

test('a verified L2 escrow feeds straight into invitation verification', async () => {
  const store = { [COMPONENT]: escrowSubstate(), ['vault_' + VAULT]: vaultSubstate(1000000) };
  const e = await pc.decodeCrossLayerEscrow(reader(store), COMPONENT);
  const invitation = pc.validateCrossLayerInvitation({
    v: 1,
    swapId: 'swap-1',
    direction: 'L1_TO_L2',
    network: 'esmeralda',
    generation: 'V048_RESET',
    makerL2PublicKey: FUNDER,
    makerL1Address: 'tari1maker',
    fundedLeg: COMPONENT,
    hashLockHex: HASH,
    l2RawAmount: '1000000',
    l1MicroAmount: '1000000',
    minFillRaw: '1000',
    maxFillRaw: '1000000',
    l2ExpiresAtEpoch: 54,
    l1RefundHeight: 100720,
  });
  const verdict = pc.verifyCrossLayerInvitation(invitation, pc.escrowAsFundedLeg(e), {
    network: 'esmeralda',
    generation: 'V048_RESET',
    takerL2PublicKey: CLAIMANT,
  });
  assert.equal(verdict.actionable, true, verdict.mismatches.concat(verdict.blockers).join(' '));
  // And a taker who is NOT the named claimant is refused, from the same read.
  const other = pc.verifyCrossLayerInvitation(invitation, pc.escrowAsFundedLeg(e), {
    network: 'esmeralda',
    generation: 'V048_RESET',
    takerL2PublicKey: 'ee'.repeat(32),
  });
  assert.equal(other.actionable, false);
  assert.match(other.mismatches.join(' '), /You could not claim it/);
});
