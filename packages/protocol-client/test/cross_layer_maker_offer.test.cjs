/**
 * Advertised liquidity vs executable liquidity.
 *
 * The failure this guards against: a venue showing a user available inventory when nothing is
 * escrowed, at the exact moment the user decides to lock their own funds — which in a
 * cross-layer trade is irreversible once the counterparty claims. So `isExecutable` is a claim
 * about on-chain reality, and every test here is about keeping it one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const EXIT_TERMS = {
  offerId: 'offer-1',
  direction: 'L2_TO_L1',
  network: 'esmeralda@v048',
  inventoryRaw: '1000000',
  minFillRaw: '1000',
  maxFillRaw: '500000',
  makerL1Address: 'tari1maker',
  makerL2PublicKey: 'aa'.repeat(32),
  expiresAtEpoch: 100,
};

const evidence = (over = {}) => ({
  leg: 'component_' + 'cd'.repeat(32),
  escrowedRaw: '1000000',
  chain: 'L1',
  readAtEpoch: 50,
  ...over,
});

test('an unfunded offer is NEVER executable, whatever else is true of it', () => {
  // The whole point of the module. An indicative price and a signed price are both unfunded,
  // and a signature is the more dangerous of the two because it looks like a commitment.
  const ind = pc.indicative(EXIT_TERMS);
  assert.equal(ind.state, 'INDICATIVE');
  assert.equal(pc.isExecutable(ind, 50), false);
  assert.equal(pc.availableRaw(ind, 50), '0', 'an unfunded offer shows zero available');
  assert.match(ind.reason, /nothing is escrowed/);

  const sgn = pc.signed(ind, 'sig-deadbeef');
  assert.equal(sgn.state, 'SIGNED');
  assert.equal(pc.isExecutable(sgn, 50), false);
  assert.equal(pc.availableRaw(sgn, 50), '0');
  assert.match(sgn.reason, /not that any asset is escrowed/);
  // And the description never implies tradeability.
  assert.doesNotMatch(pc.describeOffer(sgn, 50), /^Executable/);
});

test('FUNDED requires evidence read from chain, on the right chain for the direction', () => {
  const sgn = pc.signed(pc.indicative(EXIT_TERMS), 'sig');
  // For an exit (L2 -> L1) the MAKER must escrow the XTM on L1; the chain is derived, not taken.
  assert.equal(pc.makerEscrowChain('L2_TO_L1'), 'L1');
  assert.equal(pc.makerEscrowChain('L1_TO_L2'), 'L2');

  const ok = pc.funded(sgn, evidence());
  assert.equal(ok.state, 'FUNDED');
  assert.equal(pc.isExecutable(ok, 50), true);
  assert.match(pc.describeOffer(ok, 50), /^Executable/);
  assert.match(pc.describeOffer(ok, 50), /read from chain at epoch 50/);

  // Each way a maker could be wrong in their own favour:
  const wrongChain = pc.funded(sgn, evidence({ chain: 'L2' }));
  assert.equal(wrongChain.state, 'SIGNED');
  assert.match(wrongChain.reason, /must escrow on L1/);
  assert.equal(pc.isExecutable(wrongChain, 50), false);

  const noLeg = pc.funded(sgn, evidence({ leg: '' }));
  assert.equal(noLeg.state, 'SIGNED');
  assert.match(noLeg.reason, /names no escrow/);

  const tooSmall = pc.funded(sgn, evidence({ escrowedRaw: '999' }));
  assert.equal(tooSmall.state, 'SIGNED');
  assert.match(tooSmall.reason, /below the offer's own minimum fill/);

  const stale = pc.funded(sgn, evidence({ readAtEpoch: 100 }));
  assert.equal(stale.state, 'SIGNED');
  assert.match(stale.reason, /expired at epoch 100/);
});

test('an escrow smaller than advertised DEMOTES the inventory rather than being rejected', () => {
  // A maker partially filling their own offer is normal. The honest response is the smaller
  // number, not a refusal — but the advertised figure must never survive.
  const sgn = pc.signed(pc.indicative(EXIT_TERMS), 'sig');
  const partial = pc.funded(sgn, evidence({ escrowedRaw: '250000' }));
  assert.equal(partial.state, 'FUNDED');
  assert.equal(partial.terms.inventoryRaw, '250000', 'the chain read wins over the advertisement');
  assert.equal(pc.availableRaw(partial, 50), '250000');
});

test('reservations are bounded by the offer and never outlive it', () => {
  const f = pc.funded(pc.signed(pc.indicative(EXIT_TERMS), 'sig'), evidence());

  for (const [what, amount] of [['below the minimum', '999'], ['above the maximum', '500001']]) {
    const r = pc.reserve(f, { takerId: 't1', amountRaw: amount, expiresAtEpoch: 60 });
    assert.equal(r.state, 'FUNDED', `a fill ${what} must not reserve`);
    assert.match(r.reason, /A fill must be between/);
  }
  const outlives = pc.reserve(f, { takerId: 't1', amountRaw: '1000', expiresAtEpoch: 101 });
  assert.equal(outlives.state, 'FUNDED');
  assert.match(outlives.reason, /cannot outlive its offer/);

  const held = pc.reserve(f, { takerId: 't1', amountRaw: '400000', expiresAtEpoch: 60 });
  assert.equal(held.state, 'RESERVED');
  // Still executable (the reservation is a settlement in progress), but the reserved part is
  // not available to a second taker — that is what prevents double fulfilment at the venue.
  assert.equal(pc.isExecutable(held, 50), true);
  assert.equal(pc.availableRaw(held, 50), '600000');

  // A lapsed reservation returns the offer to FUNDED; it never silently extends.
  assert.equal(pc.expireReservation(held, 59).state, 'RESERVED');
  const lapsed = pc.expireReservation(held, 60);
  assert.equal(lapsed.state, 'FUNDED');
  assert.equal(lapsed.reservation, undefined);
  assert.equal(pc.availableRaw(lapsed, 60), '1000000');
});

test('expiry and settlement are both absolute: nothing executable survives them', () => {
  const f = pc.funded(pc.signed(pc.indicative(EXIT_TERMS), 'sig'), evidence());
  assert.equal(pc.isExecutable(f, 99), true);
  assert.equal(pc.isExecutable(f, 100), false, 'at the expiry epoch, not before it');
  assert.equal(pc.availableRaw(f, 100), '0');

  for (const outcome of ['CLAIMED', 'REFUNDED']) {
    const s = pc.settle(f, outcome);
    assert.equal(s.state, 'SETTLED');
    assert.equal(pc.isExecutable(s, 50), false, `a ${outcome} offer is never executable again`);
    assert.equal(pc.availableRaw(s, 50), '0');
    // And a settled offer cannot be reserved or re-funded back into life.
    assert.equal(pc.reserve(s, { takerId: 't', amountRaw: '1000', expiresAtEpoch: 60 }).state, 'SETTLED');
    assert.equal(pc.funded(s, evidence()).state, 'SETTLED');
  }
});

test('state transitions only ever move forward through the five declared states', () => {
  assert.deepEqual(pc.OFFER_STATES, ['INDICATIVE', 'SIGNED', 'FUNDED', 'RESERVED', 'SETTLED']);
  // Skipping SIGNED, or re-signing something already funded, must not work: each promotion
  // requires the evidence of the step below it.
  const ind = pc.indicative(EXIT_TERMS);
  assert.equal(pc.funded(ind, evidence()).state, 'INDICATIVE', 'INDICATIVE cannot jump to FUNDED');
  const f = pc.funded(pc.signed(ind, 'sig'), evidence());
  assert.equal(pc.signed(f, 'sig2').state, 'FUNDED', 'a funded offer does not go back to SIGNED');
  assert.throws(() => pc.signed(ind, ''), /signature is required/);
});

test('offer terms are validated as raw integers, because two chains\' units are being compared', () => {
  // A float here would turn a rounding error into a loss one side absorbs silently.
  for (const bad of [
    { inventoryRaw: '1.5' },
    { inventoryRaw: '-1' },
    { minFillRaw: '1e3' },
    { maxFillRaw: 'lots' },
  ]) {
    assert.throws(() => pc.indicative({ ...EXIT_TERMS, ...bad }), /raw non-negative integer/);
  }
  assert.throws(() => pc.indicative({ ...EXIT_TERMS, minFillRaw: '0' }), /must be positive/);
  assert.throws(() => pc.indicative({ ...EXIT_TERMS, maxFillRaw: '100', minFillRaw: '200' }), /at least minFillRaw/);
  assert.throws(() => pc.indicative({ ...EXIT_TERMS, inventoryRaw: '10', minFillRaw: '100' }), /cover at least one minimum fill/);
  assert.throws(() => pc.indicative({ ...EXIT_TERMS, expiresAtEpoch: 0 }), /positive absolute L2 epoch/);
  // An offer must name its network, so it cannot replay onto another generation.
  assert.throws(() => pc.indicative({ ...EXIT_TERMS, network: '' }), /name the network/);
});

test('the entry direction escrows on L2, and the same rules apply', () => {
  // For L1 -> L2 the maker pays out TARI they already hold, so their escrow is the L2 one.
  const terms = { ...EXIT_TERMS, offerId: 'offer-2', direction: 'L1_TO_L2' };
  const sgn = pc.signed(pc.indicative(terms), 'sig');
  assert.equal(pc.funded(sgn, evidence({ chain: 'L1' })).state, 'SIGNED', 'L1 escrow is wrong here');
  const ok = pc.funded(sgn, evidence({ chain: 'L2' }));
  assert.equal(ok.state, 'FUNDED');
  assert.match(pc.describeOffer(ok, 50), /L2 escrow component/);
});
