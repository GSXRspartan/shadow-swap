/**
 * The maker's inventory ledger, and the one rule it exists to enforce: two matched takers are
 * never promised the same coins.
 *
 * The failure this guards against is specific to a cross-layer trade. A taker who is promised a
 * payout funds their own leg first — on L1, irreversibly, because the L1 wallet generates the
 * preimage and therefore goes first. If the maker then cannot pay, the taker's funds sit behind
 * a 720-block refund branch. So "the maker promised more than they hold" is not an accounting
 * inconvenience; it is somebody else's money locked up for hours.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const NETWORK = 'esmeralda@v048';
const TAKER_A = 'aa'.repeat(32);
const TAKER_B = 'bb'.repeat(32);

const EXIT_TERMS = {
  offerId: 'exit-1',
  direction: 'L2_TO_L1',
  network: NETWORK,
  inventoryRaw: '1000000',
  minFillRaw: '1000',
  maxFillRaw: '600000',
  makerL1Address: 'tari1maker',
  makerL2PublicKey: 'cc'.repeat(32),
  expiresAtEpoch: 100,
};

const AT = (l2CurrentEpoch, l1TipHeight = 1000) => ({ l2CurrentEpoch, l1TipHeight });

function ok(result) {
  assert.equal(result.ok, true, result.ok === false ? result.refusal : 'expected ok');
  return result.book;
}

function refused(result, pattern) {
  assert.equal(result.ok, false, 'expected a refusal');
  assert.match(result.refusal, pattern);
  return result;
}

/** A book with an offer published and an L1 balance read at epoch 50. */
function seeded(balanceRaw = '1000000', readAtEpoch = 50) {
  let book = pc.emptyBook(NETWORK);
  book = ok(pc.publishOffer(book, EXIT_TERMS));
  book = ok(
    pc.observeInventory(book, {
      chain: 'L1',
      reference: 'local walletd 127.0.0.1:18143',
      balanceRaw,
      readAtEpoch,
    }),
  );
  return book;
}

const commitReq = (over = {}) => ({
  commitmentId: 'c1',
  offerId: 'exit-1',
  takerL2PublicKey: TAKER_A,
  takerL1Address: 'tari1taker',
  payOutRaw: '400000',
  takeInRaw: '400000',
  expiresAtEpoch: 60,
  ...over,
});

const escrowReport = (over = {}) => ({
  commitmentId: 'c1',
  evidence: {
    leg: 'ab'.repeat(32),
    escrowedRaw: '400000',
    chain: 'L1',
    boundClaimant: TAKER_A,
    readAtEpoch: 50,
  },
  escrowedAtEpoch: 50,
  escrowDeadline: 1720,
  ...over,
});

test('inventory is UNKNOWN until a balance is read, and unknown is never rendered as a number', () => {
  const book = ok(pc.publishOffer(pc.emptyBook(NETWORK), EXIT_TERMS));
  assert.equal(pc.uncommittedRaw(book, 'L1'), undefined, 'no read means unknown, not zero');
  const summary = pc.chainSummary(book, 'L1', AT(50));
  assert.equal(summary.availableRaw, undefined);
  assert.equal(summary.observation, undefined);
  assert.equal(summary.readIsStale, true);
  // And nothing can be promised from an unknown balance.
  refused(pc.commit(book, commitReq(), AT(50)), /No L1 balance has been read/);
  // A read must say what was read; an unattributed figure is not evidence.
  refused(pc.observeInventory(book, { chain: 'L1', reference: '', balanceRaw: '1', readAtEpoch: 50 }), /must say what was read/);
});

test('publishing an offer escrows NOTHING, and the maker-facing line says so', () => {
  // The central honesty requirement on this surface. A cross-layer escrow names its claimant at
  // fund time, so a published offer cannot be backed by one.
  const book = seeded();
  assert.equal(pc.displayState(book, 'exit-1', AT(50)), 'INDICATIVE');
  const line = pc.describeOfferForMaker(book, 'exit-1', AT(50));
  assert.match(line, /Nothing is escrowed/);
  assert.match(line, /only once a specific taker is matched, and it names that taker/);

  const sgnBook = ok(pc.signOffer(book, 'exit-1', 'sig-1'));
  assert.equal(pc.displayState(sgnBook, 'exit-1', AT(50)), 'SIGNED');
  assert.match(pc.describeOfferForMaker(sgnBook, 'exit-1', AT(50)), /Nothing is escrowed/);
});

test('THE DOUBLE-PROMISE GUARD: a second promise the read balance cannot cover is refused', () => {
  let book = seeded('1000000');
  book = ok(pc.commit(book, commitReq({ commitmentId: 'c1', payOutRaw: '600000' }), AT(50)));
  assert.equal(pc.uncommittedRaw(book, 'L1'), '400000');

  // 600,000 of 1,000,000 is promised. A second 600,000 cannot be.
  const second = refused(
    pc.commit(book, commitReq({ commitmentId: 'c2', takerL2PublicKey: TAKER_B, payOutRaw: '600000' }), AT(50)),
    /only 400000 is unpromised/,
  );
  assert.match(second.refusal, /promising the same coins to two takers/);
  // The refusal shows the arithmetic, so the maker can see which limit spoke.
  assert.match(second.refusal, /read 1000000 at epoch 50/);

  // What DOES fit is accepted, and the inventory goes to zero rather than negative.
  book = ok(pc.commit(book, commitReq({ commitmentId: 'c3', takerL2PublicKey: TAKER_B, payOutRaw: '400000' }), AT(50)));
  assert.equal(pc.uncommittedRaw(book, 'L1'), '0');
  refused(pc.commit(book, commitReq({ commitmentId: 'c4', payOutRaw: '1000' }), AT(50)), /only 0 is unpromised/);
});

test('an escrowed payout is not counted twice when a fresh read already excludes it', () => {
  // The trap: once an escrow is funded the coins have LEFT the wallet, so a balance read taken
  // afterwards no longer counts them. Subtracting them again would hide inventory the maker
  // really has. Subtracting them never would promise coins that are already gone.
  let book = seeded('1000000', 50);
  book = ok(pc.commit(book, commitReq({ payOutRaw: '400000' }), AT(50)));
  book = ok(pc.recordEscrow(book, escrowReport({ escrowedAtEpoch: 51 })));

  // The read (epoch 50) predates the escrow (epoch 51), so it still counts the escrowed coins
  // and they must be subtracted.
  assert.equal(pc.uncommittedRaw(book, 'L1'), '600000');

  // A fresh read AFTER the escrow already excludes them, so nothing is subtracted.
  const fresh = ok(pc.observeInventory(book, { chain: 'L1', reference: 'local walletd', balanceRaw: '600000', readAtEpoch: 52 }));
  assert.equal(pc.uncommittedRaw(fresh, 'L1'), '600000', 'not 200000: the escrow is not deducted twice');

  // Within ONE epoch the order is unknown, so the conservative reading applies.
  const sameEpoch = ok(pc.observeInventory(book, { chain: 'L1', reference: 'local walletd', balanceRaw: '1000000', readAtEpoch: 51 }));
  assert.equal(pc.uncommittedRaw(sameEpoch, 'L1'), '600000', 'same-epoch read is assumed to predate the escrow');
});

test('a stale balance read cannot support a new promise, and an older read cannot replace a newer one', () => {
  const book = seeded('1000000', 50);
  assert.equal(pc.MAX_READ_AGE_EPOCHS, 1);
  // One epoch old still counts; two does not. A maker can spend their own balance at any moment.
  assert.equal(pc.commit(book, commitReq(), AT(51)).ok, true);
  refused(pc.commit(book, commitReq(), AT(52)), /2 epochs old is not evidence/);
  assert.equal(pc.chainSummary(book, 'L1', AT(52)).readIsStale, true);
  assert.equal(pc.chainSummary(book, 'L1', AT(51)).readIsStale, false);

  refused(
    pc.observeInventory(book, { chain: 'L1', reference: 'local walletd', balanceRaw: '9999999', readAtEpoch: 49 }),
    /older than the one already held/,
  );
});

test('an escrow is recorded only when it names the right claimant, chain and amount', () => {
  let book = seeded();
  book = ok(pc.commit(book, commitReq(), AT(50)));

  refused(pc.recordEscrow(book, escrowReport({ evidence: { ...escrowReport().evidence, boundClaimant: TAKER_B } })), /pays a stranger/);
  refused(pc.recordEscrow(book, escrowReport({ evidence: { ...escrowReport().evidence, chain: 'L2' } })), /pays out on L1/);
  refused(pc.recordEscrow(book, escrowReport({ evidence: { ...escrowReport().evidence, escrowedRaw: '399999' } })), /An under-funded escrow cannot settle/);
  refused(pc.recordEscrow(book, escrowReport({ evidence: { ...escrowReport().evidence, leg: '' } })), /names no escrow/);
  refused(pc.recordEscrow(book, escrowReport({ escrowDeadline: 0 })), /record its own deadline/);
  refused(pc.recordEscrow(book, escrowReport({ commitmentId: 'nope' })), /No commitment nope/);

  // An escrow holding MORE than promised is fine: the surplus is the maker's own problem and
  // comes back to them on refund, and the taker can still only claim the whole escrow.
  const over = ok(pc.recordEscrow(book, escrowReport({ evidence: { ...escrowReport().evidence, escrowedRaw: '400001' } })));
  assert.equal(pc.displayState(over, 'exit-1', AT(50)), 'FUNDED');
  // A second escrow for the same commitment is refused rather than overwriting the first.
  refused(pc.recordEscrow(over, escrowReport()), /is ESCROWED; only a COMMITTED promise can be escrowed/);
});

test('an EXPIRED escrow is recoverable, NOT returned to available inventory', () => {
  // The distinction that matters most to a maker. A lapsed promise frees coins immediately
  // because they never moved. An expired escrow does not: the coins are on chain behind a refund
  // branch and nothing returns them until a refund transaction is signed and lands.
  let book = seeded('1000000', 50);
  book = ok(pc.commit(book, commitReq({ payOutRaw: '400000' }), AT(50)));
  book = ok(pc.recordEscrow(book, escrowReport({ escrowedAtEpoch: 50, escrowDeadline: 1720 })));

  const before = pc.chainSummary(book, 'L1', AT(50, 1719));
  assert.equal(before.escrowedRaw, '400000');
  assert.equal(before.recoverableRaw, '0');
  assert.equal(pc.recoverable(book, AT(50, 1719)).length, 0);

  const after = pc.chainSummary(book, 'L1', AT(50, 1720));
  assert.equal(after.recoverableRaw, '400000', 'at the deadline height, not before');
  assert.equal(after.availableRaw, '600000', 'still not available: a refund has to actually land');
  const list = pc.recoverable(book, AT(50, 1720));
  assert.equal(list.length, 1);
  assert.equal(list[0].commitmentId, 'c1');

  // Refunding before the deadline is refused: until then it is the claimant's to take.
  refused(pc.settleCommitment(book, 'c1', 'REFUNDED', 'escrow status Refunded', AT(50, 1719)), /cannot have been refunded yet/);
  // And a settlement needs evidence of chain state, not of a submission.
  refused(pc.settleCommitment(book, 'c1', 'REFUNDED', '   ', AT(50, 1720)), /Record what was read/);

  const done = ok(pc.settleCommitment(book, 'c1', 'REFUNDED', 'escrow 0xab… status Refunded, balance +400000', AT(50, 1720)));
  assert.equal(pc.chainSummary(done, 'L1', AT(50, 1720)).refundedRaw, '400000');
  assert.equal(pc.chainSummary(done, 'L1', AT(50, 1720)).recoverableRaw, '0');
  // The refunded coins are back, so the stale epoch-50 read is right again and nothing is
  // subtracted for them.
  assert.equal(pc.uncommittedRaw(done, 'L1'), '1000000');
  assert.equal(pc.displayState(done, 'exit-1', AT(50)), 'REFUNDED');
  assert.equal(done.history.length, 1);
  assert.equal(done.history[0].outcome, 'REFUNDED');
});

test('a lapsed promise frees its inventory immediately, because nothing ever left the wallet', () => {
  let book = seeded('1000000', 50);
  book = ok(pc.commit(book, commitReq({ payOutRaw: '400000', expiresAtEpoch: 60 }), AT(50)));
  assert.equal(pc.uncommittedRaw(book, 'L1'), '600000');

  assert.equal(pc.lapseExpired(book, AT(59)).commitments[0].state, 'COMMITTED', 'not before its deadline');
  const lapsed = pc.lapseExpired(book, AT(60));
  assert.equal(lapsed.commitments[0].state, 'LAPSED');
  assert.equal(pc.uncommittedRaw(lapsed, 'L1'), '1000000');
  assert.equal(lapsed.history.length, 1);
  assert.match(lapsed.history[0].evidence, /nothing left the wallet/);
  // Idempotent: a second sweep does not duplicate the history line.
  assert.equal(pc.lapseExpired(lapsed, AT(61)).history.length, 1);
});

test('a settled payout stays subtracted while the read predates the escrow', () => {
  let book = seeded('1000000', 50);
  book = ok(pc.commit(book, commitReq({ payOutRaw: '400000' }), AT(50)));
  book = ok(pc.recordEscrow(book, escrowReport({ escrowedAtEpoch: 51 })));
  book = ok(pc.settleCommitment(book, 'c1', 'SETTLED', 'escrow status Claimed; preimage published on L2', AT(52, 1800)));

  // The taker claimed it. Those coins are gone for good, and the epoch-50 read still counts them.
  assert.equal(pc.uncommittedRaw(book, 'L1'), '600000');
  assert.equal(pc.chainSummary(book, 'L1', AT(52)).paidOutRaw, '400000');
  assert.equal(pc.displayState(book, 'exit-1', AT(52)), 'COMPLETED');
  // Receiving the counter-asset is a fact about the OTHER chain, and only a read of it counts.
  assert.equal(pc.uncommittedRaw(book, 'L2'), undefined, 'settlement never credits inventory');
});

test('pause and withdraw stop new promises and touch nothing already promised', () => {
  let book = seeded();
  book = ok(pc.commit(book, commitReq({ payOutRaw: '400000' }), AT(50)));
  book = ok(pc.recordEscrow(book, escrowReport()));

  const paused = ok(pc.setOfferAvailability(book, 'exit-1', { paused: true }));
  refused(pc.commit(paused, commitReq({ commitmentId: 'c2' }), AT(50)), /is paused and is not quoting/);
  assert.equal(paused.commitments[0].state, 'ESCROWED', 'the live escrow is untouched');
  assert.equal(pc.displayState(paused, 'exit-1', AT(50)), 'FUNDED', 'a live escrow outranks the pause flag');

  const withdrawn = ok(pc.setOfferAvailability(paused, 'exit-1', { withdrawn: true }));
  refused(pc.commit(withdrawn, commitReq({ commitmentId: 'c3' }), AT(50)), /has been withdrawn/);
  assert.equal(withdrawn.commitments[0].state, 'ESCROWED');
  refused(pc.setOfferAvailability(withdrawn, 'exit-1', { withdrawn: true }), /already withdrawn/);

  // With no live commitment, the flags show through.
  let plain = seeded();
  plain = ok(pc.setOfferAvailability(plain, 'exit-1', { paused: true }));
  assert.equal(pc.displayState(plain, 'exit-1', AT(50)), 'PAUSED');
  assert.match(pc.describeOfferForMaker(plain, 'exit-1', AT(50)), /Nothing is escrowed by an advertisement/);
});

test('commitments are bounded by the offer, unique, and named on both chains', () => {
  const book = seeded();
  refused(pc.commit(book, commitReq({ payOutRaw: '999' }), AT(50)), /A fill must be between/);
  refused(pc.commit(book, commitReq({ payOutRaw: '600001' }), AT(50)), /A fill must be between/);
  refused(pc.commit(book, commitReq({ payOutRaw: '0' }), AT(50)), /zero is not a trade/);
  refused(pc.commit(book, commitReq({ payOutRaw: '1.5' }), AT(50)), /raw non-negative integer/);
  refused(pc.commit(book, commitReq({ expiresAtEpoch: 101 }), AT(50)), /cannot outlive its offer/);
  refused(pc.commit(book, commitReq({ expiresAtEpoch: 50 }), AT(50)), /not after the current epoch/);
  refused(pc.commit(book, commitReq({ takerL1Address: '' }), AT(50)), /name the taker on both chains/);
  refused(pc.commit(book, commitReq({ takerL2PublicKey: '' }), AT(50)), /name the taker on both chains/);
  refused(pc.commit(book, commitReq({ offerId: 'nope' }), AT(50)), /No offer nope/);
  refused(pc.commit(book, commitReq(), AT(100)), /expired at epoch 100/);

  const once = ok(pc.commit(book, commitReq(), AT(50)));
  refused(pc.commit(once, commitReq(), AT(50)), /already exists/);
});

test('an offer cannot cross networks or reuse an id, and the book names its own network', () => {
  const book = pc.emptyBook(NETWORK);
  refused(pc.publishOffer(book, { ...EXIT_TERMS, network: 'mainnet@v048' }), /must never cross a network generation/);
  const once = ok(pc.publishOffer(book, EXIT_TERMS));
  refused(pc.publishOffer(once, EXIT_TERMS), /already exists/);
  // The underlying term validation still applies, surfaced as a refusal rather than a throw.
  refused(pc.publishOffer(book, { ...EXIT_TERMS, minFillRaw: '0' }), /must be positive/);
  assert.throws(() => pc.emptyBook(''), /must name the network/);
});

test('the entry direction escrows on L2, and the guard follows the direction not the caller', () => {
  // For L1 -> L2 the maker pays TARI they already hold, so their inventory is the L2 one. The
  // chain is derived from the direction, so a caller cannot nominate the chain they have more of.
  const terms = { ...EXIT_TERMS, offerId: 'entry-1', direction: 'L1_TO_L2' };
  let book = ok(pc.publishOffer(pc.emptyBook(NETWORK), terms));
  book = ok(pc.observeInventory(book, { chain: 'L1', reference: 'local walletd', balanceRaw: '9999999', readAtEpoch: 50 }));
  refused(pc.commit(book, commitReq({ offerId: 'entry-1' }), AT(50)), /No L2 balance has been read/);

  book = ok(pc.observeInventory(book, { chain: 'L2', reference: 'component_' + 'de'.repeat(32), balanceRaw: '500000', readAtEpoch: 50 }));
  const committed = ok(pc.commit(book, commitReq({ offerId: 'entry-1', payOutRaw: '400000' }), AT(50)));
  assert.equal(pc.uncommittedRaw(committed, 'L2'), '100000');
  assert.equal(pc.uncommittedRaw(committed, 'L1'), '9999999', 'the L1 balance is untouched by an L2 payout');
  assert.equal(committed.commitments[0].payOutChain, 'L2');
});

test('a restored book keeps its promises and DROPS every balance read', () => {
  // Persisted state is attacker-modifiable. Every other field is a record of something that
  // already happened and is caught by the chain read any action requires; a balance is the
  // INPUT to the double-promise guard, so a forged one would let a maker promise coins they do
  // not have. The only safe treatment is to make the wallet answer again.
  let book = seeded('1000000', 50);
  book = ok(pc.commit(book, commitReq({ payOutRaw: '400000' }), AT(50)));
  book = ok(pc.recordEscrow(book, escrowReport()));
  book = ok(pc.signOffer(book, 'exit-1', 'sig-1'));

  const restored = pc.restoreBook(pc.serializeBook(book), { network: NETWORK });
  assert.equal(restored.commitments.length, 1);
  assert.equal(restored.commitments[0].state, 'ESCROWED');
  assert.equal(restored.commitments[0].escrow.boundClaimant, TAKER_A);
  assert.equal(restored.entries[0].offer.state, 'SIGNED');
  assert.deepEqual(restored.observations, []);
  assert.equal(pc.uncommittedRaw(restored, 'L1'), undefined, 'inventory is unknown until re-read');
  refused(pc.commit(restored, commitReq({ commitmentId: 'c2' }), AT(50)), /No L1 balance has been read/);

  // A forged balance in storage is therefore worth nothing.
  const forged = JSON.parse(pc.serializeBook(book));
  forged.observations = [{ chain: 'L1', reference: 'local walletd', balanceRaw: '999999999999', readAtEpoch: 50 }];
  assert.deepEqual(pc.restoreBook(JSON.stringify(forged), { network: NETWORK }).observations, []);

  // Another network's book is not this book.
  assert.equal(pc.restoreBook(pc.serializeBook(book), { network: 'mainnet@v048' }), undefined);
  assert.equal(pc.restoreBook(null, { network: NETWORK }), undefined);
});

test('a tampered stored book is refused with a reason, never silently emptied', () => {
  // A maker whose stored commitments cannot be validated has to be told: those promises may
  // still be live on chain, and showing an empty book would imply they are not.
  let book = seeded();
  book = ok(pc.commit(book, commitReq(), AT(50)));
  const good = JSON.parse(pc.serializeBook(book));

  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(good));
    fn(copy);
    return JSON.stringify(copy);
  };

  assert.throws(() => pc.restoreBook('{not json', { network: NETWORK }), /not valid JSON/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.commitments[0].payOutRaw = '-1'; }), { network: NETWORK }), /raw non-negative integer/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.commitments[0].payOutRaw = '4e5'; }), { network: NETWORK }), /raw non-negative integer/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.commitments[0].state = 'FREE_MONEY'; }), { network: NETWORK }), /not a known commitment state/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.commitments[0].offerId = 'ghost'; }), { network: NETWORK }), /not in this book/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.commitments.push(b.commitments[0]); }), { network: NETWORK }), /appears twice/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.commitments[0].payOutChain = 'L3'; }), { network: NETWORK }), /must be L1 or L2/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.commitments[0].commitmentId = 'a\u0000b'; }), { network: NETWORK }), /control characters/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.entries[0].offer.terms.direction = 'SIDEWAYS'; }), { network: NETWORK }), /not a known direction/);
  assert.throws(() => pc.restoreBook(mutate((b) => { b.entries = {}; }), { network: NETWORK }), /must be an array/);
  assert.throws(() => pc.restoreBook('x'.repeat(pc.MAKER_BOOK_MAX_CHARS + 1), { network: NETWORK }), /over its size bound/);

  // A restored commitment's network comes from the BOOK, so a per-offer network cannot disagree.
  const crossed = pc.restoreBook(mutate((b) => { b.entries[0].offer.terms.network = 'mainnet@v048'; }), { network: NETWORK });
  assert.equal(crossed.entries[0].offer.terms.network, NETWORK);
});
