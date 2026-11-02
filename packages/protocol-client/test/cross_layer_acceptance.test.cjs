/**
 * TWO-CHAIN ACCEPTANCE: every cross-layer scenario, driven end to end through the whole client
 * stack, against SIMULATED chains.
 *
 * Read the first paragraph of `acceptanceHarness.ts` before trusting anything here: both chains
 * are simulated, and no result in this file is evidence that anything executed on Minotari or on
 * Ootle. What it does prove is that the modules agree with each other and with the rules both
 * chains enforce — which is the part that cannot be checked by running one module at a time,
 * because this protocol's failure modes are sequences rather than states.
 *
 * The scenario ids below are the ones the acceptance document and the readiness table refer to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const NETWORK = 'esmeralda';
const GENERATION = '6a25dbc524581bfaa0a3c6ef120f8d59cc827572';
const RESOURCE = 'resource_' + '01'.repeat(32);

const KEYS = {
  userL1PublicKeyHex: 'aa'.repeat(32),
  userL2PublicKeyHex: 'bb'.repeat(32),
  makerL1PublicKeyHex: 'cc'.repeat(32),
  makerL2PublicKeyHex: 'dd'.repeat(32),
};

const L1_AMOUNT = '1000000';
const L2_AMOUNT = '1000000';

function chains(over = {}) {
  return new pc.SimulatedChains({
    network: NETWORK,
    keys: KEYS,
    l1TipHeight: 10000,
    l1ScannedHeight: 10000,
    l2CurrentEpoch: 100,
    ...over,
  });
}

const l1KeyOf = (party) => (party === 'USER' ? KEYS.userL1PublicKeyHex : KEYS.makerL1PublicKeyHex);
const l2KeyOf = (party) => (party === 'USER' ? KEYS.userL2PublicKeyHex : KEYS.makerL2PublicKeyHex);

/**
 * Funds both legs in the only order the protocol allows: L1 first, because the L1 wallet
 * generates the secret, and L2 second, bound to the hash the L1 output actually carries.
 */
function fundBothLegs(c, direction, over = {}) {
  const r = pc.roles(direction);
  const timeouts = pc.scenarioTimeouts(c);
  const l1 = c.fundL1({
    by: r.l1Funder,
    destinationPublicKeyHex: l1KeyOf(r.l1Claimant),
    amountMicroRaw: over.l1AmountMicroRaw ?? L1_AMOUNT,
  });
  // The hash comes from the OUTPUT, not from what the funder says it used. That is what stops a
  // counterparty being induced to lock funds against a hash no L1 output commits to.
  const observed = c.l1Output(l1.outputHashHex);
  const component = c.fundL2({
    by: r.l2Funder,
    resourceAddress: RESOURCE,
    amountRaw: over.l2AmountRaw ?? L2_AMOUNT,
    hashLockHex: over.hashLockHex ?? observed.hashLockHex,
    claimantPublicKeyHex: l2KeyOf(r.l2Claimant),
    expiresAtEpoch: over.l2ExpiresAtEpoch ?? timeouts.l2ExpiresAtEpoch,
    counterpartyLeg: l1.outputHashHex,
  });
  return { roles: r, timeouts, l1, component, observed };
}

// ---------------------------------------------------------------------------------------------
// A01–A02: both happy paths
// ---------------------------------------------------------------------------------------------

test('A01 exit (L2 TARI -> L1 XTM) settles on both chains', () => {
  const c = chains();
  const { roles: r, l1, component, timeouts } = fundBothLegs(c, 'L2_TO_L1');
  assert.equal(r.l1Funder, 'MAKER');
  assert.equal(r.secretHolder, 'MAKER', 'the L1 funder holds the secret, because L1 generates it');
  assert.equal(l1.refundHeight, 10720, 'scanned 10000 + 720');
  assert.equal(timeouts.l2ExpiresAtEpoch, 104, 'four 40-minute epochs inside a six-hour window with half reserved');

  // The secret holder claims the leg that expires FIRST, publishing the secret there.
  c.claimL2({ component, secretHex: l1.secretHex, by: r.l2Claimant });
  assert.equal(c.l2Escrow(component).status, 'Claimed');
  // The other party learns it from L2 state, not from the counterparty.
  const learned = c.revealedSecret(component);
  assert.equal(learned, l1.secretHex);
  c.claimL1({ outputHashHex: l1.outputHashHex, secretHex: learned, by: r.l1Claimant });
  assert.equal(c.l1Output(l1.outputHashHex).spentBy, 'CLAIM');
});

test('A02 entry (L1 XTM -> L2 TARI) settles on both chains', () => {
  const c = chains();
  const { roles: r, l1, component } = fundBothLegs(c, 'L1_TO_L2');
  assert.equal(r.l1Funder, 'USER');
  assert.equal(r.l2Funder, 'MAKER');
  assert.equal(r.secretHolder, 'USER');

  c.claimL2({ component, secretHex: l1.secretHex, by: r.l2Claimant });
  c.claimL1({ outputHashHex: l1.outputHashHex, secretHex: c.revealedSecret(component), by: r.l1Claimant });
  assert.equal(c.l1Output(l1.outputHashHex).spentBy, 'CLAIM');
  assert.equal(c.l2Escrow(component).status, 'Claimed');
});

// ---------------------------------------------------------------------------------------------
// A03–A06: abandonment and recovery
// ---------------------------------------------------------------------------------------------

test('A03 L1 funded, counterparty never funds L2: the L1 funder recovers at the refund height', () => {
  const c = chains();
  const r = pc.roles('L2_TO_L1');
  const l1 = c.fundL1({ by: r.l1Funder, destinationPublicKeyHex: l1KeyOf(r.l1Claimant), amountMicroRaw: L1_AMOUNT });

  // Not a block early. The whole point of the window is that the funder cannot change their mind.
  c.advanceL1(719);
  assert.throws(() => c.refundL1({ outputHashHex: l1.outputHashHex, by: r.l1Funder }), /until then the output is the claimant's to take/);
  c.advanceL1(1);
  c.refundL1({ outputHashHex: l1.outputHashHex, by: r.l1Funder });
  assert.equal(c.l1Output(l1.outputHashHex).spentBy, 'REFUND');
});

test('A04 L2 funded, claimant never claims: the L2 funder recovers at the expiry epoch', () => {
  const c = chains();
  const { roles: r, component, timeouts } = fundBothLegs(c, 'L2_TO_L1');
  c.advanceL2(timeouts.l2ExpiresAtEpoch - c.l2CurrentEpoch - 1);
  assert.throws(() => c.refundL2({ component, by: r.l2Funder }), /until then it is the claimant's to take/);
  c.advanceL2(1);
  c.refundL2({ component, by: r.l2Funder });
  assert.equal(c.l2Escrow(component).status, 'Refunded');
});

test('A05 the L2 claim and refund windows never overlap, so the L2 leg has no race to lose', () => {
  // The deliberate difference from L1. On L2 a claim is refused at/after expiry and a refund
  // before it, so the outcome never depends on which transaction lands first.
  const c = chains();
  const { roles: r, l1, component, timeouts } = fundBothLegs(c, 'L2_TO_L1');
  c.advanceL2(timeouts.l2ExpiresAtEpoch - c.l2CurrentEpoch);
  assert.throws(() => c.claimL2({ component, secretHex: l1.secretHex, by: r.l2Claimant }), /can now only be refunded to the funder/);
  c.refundL2({ component, by: r.l2Funder });
  assert.throws(() => c.refundL2({ component, by: r.l2Funder }), /already been settled/);
});

test('A06 the L1 claim branch has NO height condition, so a late L1 claim races the refund', () => {
  // This is the asymmetry a cross-layer trade has to survive, and the reason the L2 deadline is
  // the earlier one: the party who must act second acts on L1, where being late is survivable
  // only until the funder's refund actually confirms.
  const c = chains();
  const { roles: r, l1, component } = fundBothLegs(c, 'L2_TO_L1');
  c.claimL2({ component, secretHex: l1.secretHex, by: r.l2Claimant });
  // Far past the L1 refund height. The claim still succeeds, because nothing stops it.
  c.advanceL1(1000);
  c.claimL1({ outputHashHex: l1.outputHashHex, secretHex: c.revealedSecret(component), by: r.l1Claimant });
  assert.equal(c.l1Output(l1.outputHashHex).spentBy, 'CLAIM');

  // But if the funder's refund lands first, the claimant has lost the leg entirely — and has
  // already given up their own. That is the one-sided loss the margin exists to prevent.
  const c2 = chains();
  const second = fundBothLegs(c2, 'L2_TO_L1');
  c2.claimL2({ component: second.component, secretHex: second.l1.secretHex, by: second.roles.l2Claimant });
  c2.advanceL1(720);
  c2.refundL1({ outputHashHex: second.l1.outputHashHex, by: second.roles.l1Funder });
  assert.throws(
    () => c2.claimL1({ outputHashHex: second.l1.outputHashHex, secretHex: second.l1.secretHex, by: second.roles.l1Claimant }),
    /already spent by REFUND/,
  );
});

// ---------------------------------------------------------------------------------------------
// A07–A11: binding the two legs together
// ---------------------------------------------------------------------------------------------

test('A07 a wrong secret opens neither leg', () => {
  const c = chains();
  const { roles: r, l1, component } = fundBothLegs(c, 'L2_TO_L1');
  // Well-formed but wrong: the shape passes, the lock does not open. A malformed secret is
  // rejected earlier still, by the shape check, which is also what a chain would do.
  const wrong = '9e'.repeat(32);
  assert.notEqual(wrong, l1.secretHex);
  assert.throws(() => c.claimL2({ component, secretHex: wrong, by: r.l2Claimant }), /does not match this escrow's hash lock/);
  assert.throws(() => c.claimL1({ outputHashHex: l1.outputHashHex, secretHex: wrong, by: r.l1Claimant }), /does not open this output's hash lock/);
  assert.throws(() => c.claimL2({ component, secretHex: 'not-it', by: r.l2Claimant }), /64 hex characters/);
});

test('A08 an escrow names ONE claimant, so a stranger cannot claim it and is never offered it', () => {
  const c = chains();
  const { l1, component } = fundBothLegs(c, 'L2_TO_L1');
  // The escrow names the maker's L2 key (the maker is the L2 claimant for an exit).
  assert.throws(() => c.claimL2({ component, secretHex: l1.secretHex, by: 'USER' }), /Only the claimant key may call claim/);

  // And the offer layer must not present it as tradeable to anybody else, because a taker who
  // funds their own leg against an escrow they cannot claim loses it outright.
  const offer = pc.funded(
    pc.signed(
      pc.indicative({
        offerId: 'a08',
        direction: 'L2_TO_L1',
        network: `${NETWORK}@v048`,
        inventoryRaw: L1_AMOUNT,
        minFillRaw: '1000',
        maxFillRaw: L1_AMOUNT,
        makerL1Address: 'tari1maker',
        makerL2PublicKey: KEYS.makerL2PublicKeyHex,
        expiresAtEpoch: 200,
      }),
      'sig',
    ),
    { leg: l1.outputHashHex, escrowedRaw: L1_AMOUNT, chain: 'L1', boundClaimant: KEYS.userL2PublicKeyHex, readAtEpoch: 100 },
  );
  assert.equal(pc.isOfferableTo(offer, 100, KEYS.userL2PublicKeyHex), true);
  assert.equal(pc.isOfferableTo(offer, 100, 'ee'.repeat(32)), false, 'open inventory to nobody but the key it names');
});

test('A09 an L2 escrow bound to a hash no L1 output carries is caught by reading the output', () => {
  // The attack: a counterparty claims a hash, induces the other side to escrow against it, and
  // can then never be forced to reveal anything — because no output of theirs commits to it.
  const c = chains();
  const r = pc.roles('L2_TO_L1');
  const l1 = c.fundL1({ by: r.l1Funder, destinationPublicKeyHex: l1KeyOf(r.l1Claimant), amountMicroRaw: L1_AMOUNT });
  const observed = c.l1Output(l1.outputHashHex);

  const verdict = pc.verifyFundedOutput(
    {
      outputHashHex: observed.outputHashHex,
      amountMicroRaw: observed.amountMicroRaw,
      confirmations: 3,
      scriptHashLockHex: '99'.repeat(32),
      scriptDestinationPublicKeyHex: observed.destinationPublicKeyHex,
      scriptRefundHeight: observed.refundHeight,
    },
    {
      outputHashHex: observed.outputHashHex,
      amountMicroRaw: L1_AMOUNT,
      // What the counterparty SAID the hash was.
      hashLockHex: '99'.repeat(32),
      destinationPublicKeyHex: observed.destinationPublicKeyHex,
      refundHeight: observed.refundHeight,
      minConfirmations: 3,
    },
  );
  // Against the claimed hash it passes — which is exactly why the hash must come from the read,
  // not from the claim. Checked against the OUTPUT's real lock, it fails.
  assert.equal(verdict.confirmed, true);
  const honest = pc.verifyFundedOutput(
    {
      outputHashHex: observed.outputHashHex,
      amountMicroRaw: observed.amountMicroRaw,
      confirmations: 3,
      scriptHashLockHex: observed.hashLockHex,
      scriptDestinationPublicKeyHex: observed.destinationPublicKeyHex,
      scriptRefundHeight: observed.refundHeight,
    },
    {
      outputHashHex: observed.outputHashHex,
      amountMicroRaw: L1_AMOUNT,
      hashLockHex: '99'.repeat(32),
      destinationPublicKeyHex: observed.destinationPublicKeyHex,
      refundHeight: observed.refundHeight,
      minConfirmations: 3,
    },
  );
  assert.equal(honest.confirmed, false);
  assert.match(honest.mismatches.join(' '), /does not open the other/);
});

test('A10 an L1 output whose script cannot be read is UNVERIFIED, and the second leg is not funded', () => {
  const c = chains();
  const r = pc.roles('L2_TO_L1');
  const l1 = c.fundL1({ by: r.l1Funder, destinationPublicKeyHex: l1KeyOf(r.l1Claimant), amountMicroRaw: L1_AMOUNT });
  const observed = c.l1Output(l1.outputHashHex);
  const blind = pc.verifyFundedOutput(
    { outputHashHex: observed.outputHashHex, amountMicroRaw: observed.amountMicroRaw, confirmations: 10 },
    { outputHashHex: observed.outputHashHex, amountMicroRaw: L1_AMOUNT, hashLockHex: observed.hashLockHex, destinationPublicKeyHex: observed.destinationPublicKeyHex, refundHeight: observed.refundHeight, minConfirmations: 3 },
  );
  assert.equal(blind.confirmed, false);
  assert.match(blind.unverified.join(' '), /Do not fund the other leg/);
});

test('A11 an under-funded leg is refused on both sides rather than settled for less', () => {
  const c = chains();
  const r = pc.roles('L2_TO_L1');
  const l1 = c.fundL1({ by: r.l1Funder, destinationPublicKeyHex: l1KeyOf(r.l1Claimant), amountMicroRaw: '999999' });
  const observed = c.l1Output(l1.outputHashHex);
  const verdict = pc.verifyFundedOutput(
    { outputHashHex: observed.outputHashHex, amountMicroRaw: observed.amountMicroRaw, confirmations: 3, scriptHashLockHex: observed.hashLockHex, scriptDestinationPublicKeyHex: observed.destinationPublicKeyHex, scriptRefundHeight: observed.refundHeight },
    { outputHashHex: observed.outputHashHex, amountMicroRaw: L1_AMOUNT, hashLockHex: observed.hashLockHex, destinationPublicKeyHex: observed.destinationPublicKeyHex, refundHeight: observed.refundHeight, minConfirmations: 3 },
  );
  assert.equal(verdict.confirmed, false);
  assert.match(verdict.mismatches.join(' '), /A claim takes the whole output/);

  // And the maker's ledger refuses to record an under-funded escrow against a promise.
  let book = pc.emptyBook(`${NETWORK}@v048`);
  book = pc.publishOffer(book, {
    offerId: 'a11',
    direction: 'L1_TO_L2',
    network: `${NETWORK}@v048`,
    inventoryRaw: L2_AMOUNT,
    minFillRaw: '1000',
    maxFillRaw: L2_AMOUNT,
    makerL1Address: 'tari1maker',
    makerL2PublicKey: KEYS.makerL2PublicKeyHex,
    expiresAtEpoch: 200,
  }).book;
  book = pc.observeInventory(book, { chain: 'L2', reference: 'account', balanceRaw: L2_AMOUNT, readAtEpoch: 100 }).book;
  book = pc.commit(book, { commitmentId: 'c', offerId: 'a11', takerL2PublicKey: KEYS.userL2PublicKeyHex, takerL1Address: 'tari1user', payOutRaw: L2_AMOUNT, takeInRaw: L1_AMOUNT, expiresAtEpoch: 104 }, { l2CurrentEpoch: 100, l1TipHeight: 10000 }).book;
  const short = pc.recordEscrow(book, {
    commitmentId: 'c',
    evidence: { leg: 'component_x', escrowedRaw: '999999', chain: 'L2', boundClaimant: KEYS.userL2PublicKeyHex, readAtEpoch: 100 },
    escrowedAtEpoch: 100,
    escrowDeadline: 104,
  });
  assert.equal(short.ok, false);
  assert.match(short.refusal, /An under-funded escrow cannot settle/);
});

// ---------------------------------------------------------------------------------------------
// A12–A14: the sync gap and timeout ordering
// ---------------------------------------------------------------------------------------------

test('A12 a funding wallet behind the tip is refused, because its output would refund early', () => {
  const behind = chains({ l1ScannedHeight: 9800 });
  const timeouts = pc.scenarioTimeouts(behind);
  assert.equal(timeouts.syncOk, false);
  assert.match(timeouts.syncReason, /200 blocks of the claimant's window gone/);
  // And the refund height really is the wallet's, not the tip's: funding it anyway produces an
  // output that refunds 200 blocks sooner than a tip-derived deadline assumed.
  const r = pc.roles('L2_TO_L1');
  const l1 = behind.fundL1({ by: r.l1Funder, destinationPublicKeyHex: l1KeyOf(r.l1Claimant), amountMicroRaw: L1_AMOUNT });
  assert.equal(l1.refundHeight, 10520);
  assert.equal(behind.l1TipHeight + 720, 10720, 'what a tip-derived estimate would have said');
});

test('A13 the L2 deadline always comes strictly before the L1 refund height, in wall-clock terms', () => {
  const c = chains();
  const timeouts = pc.scenarioTimeouts(c);
  // Esmeralda: ~30s blocks, so 720 blocks is six hours; one epoch is forty minutes.
  const l1WindowSeconds = 720 * 30;
  const l2WindowSeconds = (timeouts.l2ExpiresAtEpoch - c.l2CurrentEpoch) * 2400;
  assert.ok(l2WindowSeconds < l1WindowSeconds, 'the L2 leg must expire first');
  assert.equal(timeouts.claimMarginSeconds, l1WindowSeconds - l2WindowSeconds);
  assert.equal(timeouts.claimMarginSeconds, 12000, 'over three hours for the second claimant');
  // A counterparty's proposal is untrusted, so the margin is recomputed rather than accepted.
  const check = pc.checkProposedTimeouts(
    { l1RefundHeight: timeouts.l1RefundHeight, l2ExpiresAtEpoch: timeouts.l2ExpiresAtEpoch + 3 },
    { network: 'esmeralda', l1TipHeight: c.l1ScannedHeight, l2CurrentEpoch: c.l2CurrentEpoch },
  );
  assert.equal(check.safe, false, 'an L2 deadline pushed out past the margin is refused');
  assert.match(check.reason, /observe the preimage, broadcast an L1 claim/);
  assert.equal(
    pc.checkProposedTimeouts(
      { l1RefundHeight: timeouts.l1RefundHeight, l2ExpiresAtEpoch: timeouts.l2ExpiresAtEpoch },
      { network: 'esmeralda', l1TipHeight: c.l1ScannedHeight, l2CurrentEpoch: c.l2CurrentEpoch },
    ).safe,
    true,
    "the harness's own derivation passes its own check",
  );
});

test('A14 a claim one epoch late loses the leg, which is what the margin exists to prevent', () => {
  const c = chains();
  const { roles: r, l1, component, timeouts } = fundBothLegs(c, 'L2_TO_L1');
  // The secret holder is late on L2. They can no longer claim, and the other party never learns
  // the secret — so both legs refund and nobody is paid. A stalemate, not a loss.
  c.advanceL2(timeouts.l2ExpiresAtEpoch - c.l2CurrentEpoch);
  assert.throws(() => c.claimL2({ component, secretHex: l1.secretHex, by: r.l2Claimant }), /can now only be refunded/);
  c.refundL2({ component, by: r.l2Funder });
  assert.equal(c.revealedSecret(component), undefined, 'the secret was never published');
  c.advanceL1(720);
  c.refundL1({ outputHashHex: l1.outputHashHex, by: r.l1Funder });
  assert.equal(c.l1Output(l1.outputHashHex).spentBy, 'REFUND');
});

// ---------------------------------------------------------------------------------------------
// A15–A18: the maker's ledger under load
// ---------------------------------------------------------------------------------------------

test('A15 two takers are never promised the same coins', () => {
  const at = { l2CurrentEpoch: 100, l1TipHeight: 10000 };
  let book = pc.emptyBook(`${NETWORK}@v048`);
  book = pc.publishOffer(book, {
    offerId: 'a15',
    direction: 'L1_TO_L2',
    network: `${NETWORK}@v048`,
    inventoryRaw: L2_AMOUNT,
    minFillRaw: '1000',
    maxFillRaw: L2_AMOUNT,
    makerL1Address: 'tari1maker',
    makerL2PublicKey: KEYS.makerL2PublicKeyHex,
    expiresAtEpoch: 200,
  }).book;
  book = pc.observeInventory(book, { chain: 'L2', reference: 'account', balanceRaw: L2_AMOUNT, readAtEpoch: 100 }).book;
  book = pc.commit(book, { commitmentId: 'first', offerId: 'a15', takerL2PublicKey: KEYS.userL2PublicKeyHex, takerL1Address: 'tari1user', payOutRaw: '700000', takeInRaw: '700000', expiresAtEpoch: 102 }, at).book;
  const second = pc.commit(book, { commitmentId: 'second', offerId: 'a15', takerL2PublicKey: 'ee'.repeat(32), takerL1Address: 'tari1other', payOutRaw: '700000', takeInRaw: '700000', expiresAtEpoch: 102 }, at);
  assert.equal(second.ok, false);
  assert.match(second.refusal, /promising the same coins to two takers/);
});

test('A16 a promise that lapses frees its inventory; an escrow past its deadline does not', () => {
  const at = (epoch) => ({ l2CurrentEpoch: epoch, l1TipHeight: 10000 });
  let book = pc.emptyBook(`${NETWORK}@v048`);
  book = pc.publishOffer(book, {
    offerId: 'a16',
    direction: 'L1_TO_L2',
    network: `${NETWORK}@v048`,
    inventoryRaw: L2_AMOUNT,
    minFillRaw: '1000',
    maxFillRaw: L2_AMOUNT,
    makerL1Address: 'tari1maker',
    makerL2PublicKey: KEYS.makerL2PublicKeyHex,
    expiresAtEpoch: 200,
  }).book;
  book = pc.observeInventory(book, { chain: 'L2', reference: 'account', balanceRaw: L2_AMOUNT, readAtEpoch: 100 }).book;
  book = pc.commit(book, { commitmentId: 'lapses', offerId: 'a16', takerL2PublicKey: KEYS.userL2PublicKeyHex, takerL1Address: 'tari1user', payOutRaw: '400000', takeInRaw: '400000', expiresAtEpoch: 102 }, at(100)).book;
  assert.equal(pc.uncommittedRaw(book, 'L2'), '600000');
  const swept = pc.lapseExpired(book, at(102));
  assert.equal(pc.uncommittedRaw(swept, 'L2'), L2_AMOUNT, 'nothing ever left the wallet');

  // Escrowed instead: the coins are on chain, and a passed deadline makes them recoverable, not
  // available. Nothing returns them until a refund transaction lands.
  let escrowed = pc.commit(book, { commitmentId: 'escrowed', offerId: 'a16', takerL2PublicKey: 'ee'.repeat(32), takerL1Address: 'tari1other', payOutRaw: '300000', takeInRaw: '300000', expiresAtEpoch: 104 }, at(100)).book;
  escrowed = pc.recordEscrow(escrowed, {
    commitmentId: 'escrowed',
    evidence: { leg: 'component_e', escrowedRaw: '300000', chain: 'L2', boundClaimant: 'ee'.repeat(32), readAtEpoch: 100 },
    escrowedAtEpoch: 100,
    escrowDeadline: 104,
  }).book;
  const past = pc.chainSummary(escrowed, 'L2', at(104));
  assert.equal(past.recoverableRaw, '300000');
  assert.equal(past.availableRaw, '300000', 'the escrowed 300000 is still out, and the lapsing 400000 is still promised');
  assert.equal(pc.recoverable(escrowed, at(104)).length, 1);
});

test('A17 an offer cannot be quoted against a stale balance read', () => {
  let book = pc.emptyBook(`${NETWORK}@v048`);
  book = pc.publishOffer(book, {
    offerId: 'a17',
    direction: 'L1_TO_L2',
    network: `${NETWORK}@v048`,
    inventoryRaw: L2_AMOUNT,
    minFillRaw: '1000',
    maxFillRaw: L2_AMOUNT,
    makerL1Address: 'tari1maker',
    makerL2PublicKey: KEYS.makerL2PublicKeyHex,
    expiresAtEpoch: 200,
  }).book;
  book = pc.observeInventory(book, { chain: 'L2', reference: 'account', balanceRaw: L2_AMOUNT, readAtEpoch: 100 }).book;
  const stale = pc.commit(book, { commitmentId: 'late', offerId: 'a17', takerL2PublicKey: KEYS.userL2PublicKeyHex, takerL1Address: 'tari1user', payOutRaw: '1000', takeInRaw: '1000', expiresAtEpoch: 110 }, { l2CurrentEpoch: 103, l1TipHeight: 10000 });
  assert.equal(stale.ok, false);
  assert.match(stale.refusal, /epochs old is not evidence/);
});

test('A18 an exit bonus stops when its budget runs out, and never becomes a yield', () => {
  const pricing = {
    referenceRatioNum: '1',
    referenceRatioDen: '1',
    baseSpreadBps: 30,
    fixedNetworkCostRaw: '0',
    variableCostBps: 0,
    exitBonusBps: 100,
    maxSubsidyRaw: '2000',
    perTradeMaxRaw: '10000000',
    minOrderRaw: '1000',
    maxOrderRaw: '100000',
    committedInventoryRaw: '10000000',
    maxDailyVolumeRaw: '10000000',
    // A promoting maker's proceeds are negative by construction, so the floor must allow it.
    minMakerProceedsRaw: '-1000',
    maxExposurePerCounterpartyRaw: '10000000',
  };
  const state = { filledTodayRaw: '0', subsidySpentRaw: '0', exposureByCounterparty: {}, availableInventoryRaw: '10000000', paused: false };
  const run = pc.simulate(pricing, state, Array.from({ length: 4 }, (_, i) => ({ direction: 'L2_TO_L1', amountInRaw: '100000', counterpartyId: `t${i}` })));
  // 1% of 100000 is 1000, so a 2000 budget funds exactly two bonused trades.
  assert.equal(run.totalBonusRaw, '2000');
  assert.equal(run.filled, 4, 'the later trades still price — at the unbonused rate');
  assert.match(pc.BONUS_IS_NOT_YIELD, /not interest, not a yield, not an APY/);
  // The arithmetic says so too: a 100bps bonus against a 30bps spread loses 70bps per trade.
  const q = pc.quote(pricing, state, { direction: 'L2_TO_L1', amountInRaw: '100000', counterpartyId: 't' });
  assert.equal(q.ok, true);
  assert.equal(q.breakdown.makerProceedsRaw, '-700');
});

// ---------------------------------------------------------------------------------------------
// A19–A21: invitations and replay
// ---------------------------------------------------------------------------------------------

function invitation(over = {}) {
  return {
    v: 1,
    swapId: 'swap-a19',
    direction: 'L1_TO_L2',
    network: NETWORK,
    generation: GENERATION,
    makerL2PublicKey: KEYS.makerL2PublicKeyHex,
    makerL1Address: 'tari1maker',
    l2RawAmount: L2_AMOUNT,
    l1MicroAmount: L1_AMOUNT,
    minFillRaw: '1000',
    maxFillRaw: L2_AMOUNT,
    l2ExpiresAtEpoch: 104,
    l1RefundHeight: 10720,
    ...over,
  };
}

const ESCROW_COMPONENT = 'component_' + 'c0de' + '1'.padStart(60, '0');

const fundedLeg = (over = {}) => ({
  chain: 'L2',
  leg: ESCROW_COMPONENT,
  amountRaw: L2_AMOUNT,
  hashLockHex: '77'.repeat(32),
  claimantOrDestination: KEYS.userL2PublicKeyHex,
  expiresAtEpoch: 104,
  settled: false,
  ...over,
});

test('A19 an invitation cannot be replayed onto another network or generation', () => {
  const inv = invitation({ fundedLeg: ESCROW_COMPONENT, hashLockHex: '77'.repeat(32) });
  const context = { network: NETWORK, generation: GENERATION, takerL2PublicKey: KEYS.userL2PublicKeyHex };
  assert.equal(pc.verifyCrossLayerInvitation(inv, fundedLeg(), context).actionable, true);
  const other = pc.verifyCrossLayerInvitation(inv, fundedLeg(), { ...context, network: 'igor' });
  assert.equal(other.actionable, false);
  const olderGeneration = pc.verifyCrossLayerInvitation(inv, fundedLeg(), { ...context, generation: 'deadbeef' });
  assert.equal(olderGeneration.actionable, false);
});

test('A20 an invitation addressed to someone else is not actionable by this taker', () => {
  const inv = invitation({ fundedLeg: ESCROW_COMPONENT, hashLockHex: '77'.repeat(32) });
  const verdict = pc.verifyCrossLayerInvitation(inv, fundedLeg(), {
    network: NETWORK,
    generation: GENERATION,
    takerL2PublicKey: 'ee'.repeat(32),
  });
  assert.equal(verdict.actionable, false);
});

test('A21 an invitation whose terms disagree with chain state loses to the chain', () => {
  const inv = invitation({ fundedLeg: ESCROW_COMPONENT, hashLockHex: '77'.repeat(32) });
  const context = { network: NETWORK, generation: GENERATION, takerL2PublicKey: KEYS.userL2PublicKeyHex };
  // Less escrowed than advertised.
  const short = pc.verifyCrossLayerInvitation(inv, fundedLeg({ amountRaw: '1' }), context);
  assert.equal(short.actionable, false);
  // A different hash lock than the invitation named.
  const wrongHash = pc.verifyCrossLayerInvitation(inv, fundedLeg({ hashLockHex: '88'.repeat(32) }), context);
  assert.equal(wrongHash.actionable, false);
  // Already settled.
  const settled = pc.verifyCrossLayerInvitation(inv, fundedLeg({ settled: true }), context);
  assert.equal(settled.actionable, false);
  // And whatever the invitation says, the terms a UI acts on are the chain's.
  assert.equal(pc.verifyCrossLayerInvitation(inv, fundedLeg(), context).chain.amountRaw, L2_AMOUNT);
});

// ---------------------------------------------------------------------------------------------
// A22–A23: ambiguity and missing capability
// ---------------------------------------------------------------------------------------------

test('A22 an ambiguous submission is UNKNOWN and is reconciled against chain state, not retried', () => {
  const c = chains();
  const r = pc.roles('L2_TO_L1');
  // The wallet accepted a funding but the transport died before the answer arrived.
  const report = pc.classifySubmission({ transportError: 'socket hang up', requestSent: true });
  assert.equal(report.outcome, 'UNKNOWN');
  assert.equal(report.mustCheckChainBeforeRetry, true);

  // It HAD committed. A retry would have funded a second escrow out of the same inventory.
  const l1 = c.fundL1({ by: r.l1Funder, destinationPublicKeyHex: l1KeyOf(r.l1Claimant), amountMicroRaw: L1_AMOUNT });
  const observed = c.l1Output(l1.outputHashHex);
  assert.notEqual(observed, undefined, 'the chain read is what resolves an UNKNOWN');

  // The lifecycle records the same thing on the L2 side, and never as a failure.
  const record = {
    swapId: 'a22',
    direction: 'L2_TO_L1',
    network: NETWORK,
    stage: 'L2_FUNDED',
    role: 'USER',
    l2Account: 'component_' + 'ab'.repeat(32),
    l1Address: 'tari1user',
    counterpartyL2PublicKey: KEYS.makerL2PublicKeyHex,
    counterpartyL1Address: 'tari1maker',
    hashLockHex: observed.hashLockHex.length === 64 ? observed.hashLockHex : '77'.repeat(32),
    l2ResourceAddress: RESOURCE,
    l2RawAmount: L2_AMOUNT,
    l1MicroAmount: L1_AMOUNT,
    l2ExpiresAtEpoch: 104,
    l1RefundHeight: 10720,
    updatedAtUnixMs: 1,
  };
  const unknown = pc.markSwapUnknown(record, 'the L2 claim submission timed out');
  assert.equal(unknown.stage, 'UNKNOWN');
  const verdict = pc.nextAction(unknown, { l2CurrentEpoch: 100, l1TipHeight: 10000 });
  assert.equal(verdict.action, 'RESOLVE_UNKNOWN');
  assert.match(verdict.reason, /may have committed|read the chain|chain state/i);
});

test('A23 a route no available wallet can finish is refused, refunds included', () => {
  // The capability a plan forgets, because it is only needed when something goes wrong. A wallet
  // that can fund but not refund must not fund at all.
  const noRefund = pc.assessCapabilities({
    network: NETWORK,
    methodsAnswered: ['send', 'claim'],
    isLedger: false,
    isViewOnly: false,
    tipHeight: 10000,
    scannedHeight: 10000,
    spendableMicroRaw: L1_AMOUNT,
  });
  assert.equal(noRefund.complete, false);
  const plan = pc.planL1Funding(
    { network: NETWORK, direction: 'L2_TO_L1', role: 'MAKER', destinationAddress: 'tari1user', amountMicroRaw: L1_AMOUNT, feePerGramRaw: '5' },
    { network: NETWORK, methodsAnswered: ['send', 'claim'], isLedger: false, isViewOnly: false, tipHeight: 10000, scannedHeight: 10000, spendableMicroRaw: '10000000' },
  );
  assert.equal(plan.ok, false);

  // The browser-side planner says the same thing about the L2 side: with no local L1 wallet, no
  // direction is completable, and the refusal names the operations nothing can sign.
  const l2Only = pc.planSigners('L2_TO_L1', ['UNIVERSE_CONNECTOR']);
  assert.equal(l2Only.ok, false);
  assert.ok(pc.capabilityGaps(['UNIVERSE_CONNECTOR']).length > 0);
});

test('the harness states its own limits, and refuses to simulate mainnet', () => {
  assert.match(pc.HARNESS_FACTS.join(' '), /Both chains here are SIMULATED/);
  assert.throws(
    () => new pc.SimulatedChains({ network: 'mainnet', keys: KEYS, l1TipHeight: 1, l1ScannedHeight: 1, l2CurrentEpoch: 1 }),
    /not a test fixture/,
  );
});
