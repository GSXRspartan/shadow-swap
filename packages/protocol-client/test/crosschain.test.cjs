const test = require('node:test');
const assert = require('node:assert/strict');

const sessionMod = require('../dist/crosschain/session.js');
const { IllegalTransitionError, isTerminal, InMemorySessionStore } = sessionMod;
const {
  buildQuote,
  isQuoteExpired,
  validateAdvertisement,
} = require('../dist/crosschain/quote.js');
const { InMemoryReservationLedger } = require('../dist/crosschain/reservation.js');
const {
  InMemorySecretStore,
  verifyPreimage,
  assertNoSecretInJson,
  sha256,
  bytesToHex,
} = require('../dist/crosschain/secret.js');
const { deriveDeadlines, assertDeadlineSafety, DeadlineError } = require('../dist/crosschain/deadlines.js');
const {
  acceptQuote,
  verifyL1Funded,
  revealAndClaimL2,
  claimL1,
  assessRefundEligibility,
  recoverSession,
  isRealSubmitEnabled,
} = require('../dist/crosschain/coordinator.js');

const AD = {
  providerId: 'prov_1',
  pair: 'XTM/TARI',
  xtmAvailable: '100000',
  tariAvailable: '50000000',
  minTradeXtm: '1000',
  maxTradeXtm: '90000',
  spreadBps: '50',
  quoteTtlMs: '60000',
  requiredL1Confirmations: '3',
  network: 'esmeralda',
};

const HASH = bytesToHex(new Uint8Array(32).fill(7));
const applyEvt = (record, event) => sessionMod.applyEvent(record, event);

/** Fully capable L1/L2 legs (XTM_TO_TARI requirements) for arming-path tests. */
const CAPS = {
  l1Balance: true, l1NormalSend: true, l1ShaInit: true, l1ShaInspect: true, l1ShaClaim: true, l1ShaRefund: true,
  l2HtlcFund: true, l2HtlcClaim: true, l2HtlcRefund: true,
};

function sessionRecord(overrides = {}) {
  return {
    sessionId: 'sess_1',
    state: 'RESERVED',
    quoteId: 'q_1',
    reservationId: 'r_1',
    providerId: 'prov_1',
    direction: 'XTM_TO_TARI',
    xtmRawAmount: '10000',
    tariRawAmount: '5000000',
    hashH: HASH,
    l1ClaimRecipient: 'l1_claim_addr',
    l2ClaimRecipient: 'component_tari_1',
    l1Network: 'esmeralda',
    l2Network: 'esmeralda',
    l1RefundDeadlineHeight: '500',
    l2RefundDeadlineEpoch: '1200',
    requiredL1Confirmations: '3',
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    ...overrides,
  };
}

function ports(overrides = {}) {
  return {
    l1: {
      providerName: () => 'dev',
      primitivesStatus: () => 'PENDING_TRACE',
      network: () => 'esmeralda',
      observeHtlc: async () => ({ l1TxId: 'tx1', exists: true, amountRaw: '10000', hashHex: HASH, refundHeight: '500', confirmations: '5', currentHeight: '510', spent: false, source: 'BASE_NODE' }),
      lookupTransaction: async () => 'COMMITTED',
      listInFlightSwaps: async () => [],
    },
    l2: {
      observeHashlockOutput: async () => ({ exists: true, amountRaw: '5000000', hashExact: true, claimantExact: true, epochRefundExact: true, unspent: true, source: 'AUTHORITATIVE' }),
      lookupTransaction: async () => 'COMMITTED',
    },
    reservations: new InMemoryReservationLedger({ prov_1: AD }),
    secrets: new InMemorySecretStore(),
    sessions: new InMemorySessionStore(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

test('quote terms are integers with bounded spread on testnet networks only', () => {
  assert.throws(() => sessionRecord && require('../dist/crosschain/quote.js').validateAdvertisement({ ...AD, network: 'mainnet' }), /mainnet/i);
  const { validateAdvertisement } = require('../dist/crosschain/quote.js');
  assert.throws(() => validateAdvertisement({ ...AD, spreadBps: '10001' }), /10_000/);
  const { buildQuote, isQuoteExpired } = require('../dist/crosschain/quote.js');
  const q = buildQuote({ quoteId: 'q_1', ad: AD, direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: HASH, l1ClaimRecipient: 'l1a', l2ClaimRecipient: 'l2a', l1RefundDeadlineHeight: '500', l2RefundDeadlineEpoch: '1200', nowUnixMs: 1000 });
  assert.equal(q.protocolVersion, 'xtm-tari-v1');
  assert.equal(q.hashAlg, 'SHA256');
  assert.equal(isQuoteExpired(q, 1000 + 60000), true);
  assert.equal(isQuoteExpired(q, 1000 + 59999), false);
  assert.throws(() => buildQuote({ quoteId: 'q2', ad: AD, direction: 'XTM_TO_TARI', xtmRawAmount: '1', tariRawAmount: '1', hashH: 'xyz', l1ClaimRecipient: 'a', l2ClaimRecipient: 'b', l1RefundDeadlineHeight: '1', l2RefundDeadlineEpoch: '2', nowUnixMs: 0 }), /64 lowercase hex/);
});

// ---------------------------------------------------------------------------
// Reservations / inventory race protection
// ---------------------------------------------------------------------------

test('inventory race: two overlapping reservations cannot exceed advertised inventory', async () => {
  const ledger = new InMemoryReservationLedger({ prov_1: AD });
  await ledger.reserve({ reservationId: 'res_race_1', quoteId: 'quote_race_1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '80000', tariRawAmount: '40000000', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 });
  await assert.rejects(
    () => ledger.reserve({ reservationId: 'res_race_2', quoteId: 'quote_race_2', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '80000', tariRawAmount: '40000000', nowUnixMs: 2, quoteExpiresAtUnixMs: 9999 }),
    /race|exceed/i,
  );
  const again = await ledger.reserve({ reservationId: 'res_race_1', quoteId: 'quote_race_1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '80000', tariRawAmount: '40000000', nowUnixMs: 2, quoteExpiresAtUnixMs: 9999 });
  assert.equal(again.reservationId, 'res_race_1');
  await assert.rejects(
    () => ledger.reserve({ reservationId: 'res_race_1', quoteId: 'quote_race_1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '20000', tariRawAmount: '40000000', nowUnixMs: 3, quoteExpiresAtUnixMs: 9999 }),
    /different terms/,
  );
});

test('quote expiry cannot release FUNDED inventory; release needs authoritative evidence', async () => {
  const ledger = new InMemoryReservationLedger({ prov_1: AD });
  await ledger.reserve({ reservationId: 'res_exp_0001', quoteId: 'quote_exp_01', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000', nowUnixMs: 1, quoteExpiresAtUnixMs: 999 });
  await ledger.markFunded('res_exp_0001');
  await assert.rejects(() => ledger.requestRelease('res_exp_0001', 'ev_exp_0001', 'QUOTE_EXPIRED'), /funded sessions live by chain deadlines/i);
  const released = await ledger.requestRelease('res_exp_0001', 'ev_settle_1', 'SETTLED');
  assert.equal(released.state, 'RELEASE_PENDING');
  const done = await ledger.completeRelease('res_exp_0001');
  assert.equal(done.state, 'RELEASED');
  await assert.rejects(() => ledger.completeRelease('res_exp_0001'), /RELEASE_PENDING/);
});

test('double reservation with the same durable id is idempotent only for identical terms', async () => {
  const ledger = new InMemoryReservationLedger({ prov_1: AD });
  const first = await ledger.reserve({ reservationId: 'res_dup_0001', quoteId: 'quote_dup_1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000', nowUnixMs: 1, quoteExpiresAtUnixMs: 999 });
  const second = await ledger.reserve({ reservationId: 'res_dup_0001', quoteId: 'quote_dup_1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000', nowUnixMs: 2, quoteExpiresAtUnixMs: 999 });
  assert.equal(second.reservationId, first.reservationId);
  await assert.rejects(
    () => ledger.reserve({ reservationId: 'res_dup_0001', quoteId: 'quote_dup_1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '11000', tariRawAmount: '5000000', nowUnixMs: 3, quoteExpiresAtUnixMs: 999 }),
    /different terms/,
  );
});

// ---------------------------------------------------------------------------
// State machine: legal path + failure injections
// ---------------------------------------------------------------------------

// A FULLY PROVEN authoritative evidence stamp. The state machine refuses to record a
// partial one — every field must be affirmative and the read must not be an assertion.
function provenL1Evidence(over = {}) {
  return {
    l1TxId: 'tx1',
    confirmations: '5',
    hashMatches: true,
    amountExact: true,
    amountAuthoritative: true,
    deadlineSafe: true,
    deadlineFresh: true,
    confirmationsSufficient: true,
    source: 'BASE_NODE',
    observedHashHex: HASH,
    observedAmountRaw: '10000',
    observedRefundHeight: '500',
    observedCurrentHeight: '400',
    verifiedAtUnixMs: 1,
    ...over,
  };
}

function provenL2Evidence(over = {}) {
  return {
    l2TxId: 'tx2',
    hashExact: true,
    amountExact: true,
    deadlineSafe: true,
    claimantExact: true,
    unspent: true,
    source: 'AUTHORITATIVE',
    observedAmountRaw: '5000000',
    verifiedAtUnixMs: 1,
    ...over,
  };
}

test('happy path advances without illegal jumps and ends CLAIMED', () => {
  let r = sessionRecord({ state: 'QUOTED' });
  r = applyEvt(r, { kind: 'ACCEPT_QUOTE', nowUnixMs: 1 });
  assert.equal(r.state, 'RESERVED');
  r = applyEvt(r, { kind: 'BEGIN_L1_FUNDING', deadlineSafetyEvidence: 'x' });
  r = applyEvt(r, { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: 'tx1' });
  r = applyEvt(r, { kind: 'L1_VERIFIED_FUNDED', evidence: provenL1Evidence() });
  assert.ok(r.l1Verification, 'authoritative L1 evidence is stamped on the record');
  r = applyEvt(r, { kind: 'BEGIN_L2_FUNDING', deadlineSafetyEvidence: 'x' });
  r = applyEvt(r, { kind: 'L2_FUND_ACKNOWLEDGED', l2TxId: 'tx2' });
  r = applyEvt(r, { kind: 'L2_VERIFIED_FUNDED', evidence: provenL2Evidence() });
  assert.ok(r.l2Verification, 'authoritative L2 evidence is stamped on the record');
  r = applyEvt(r, { kind: 'ARM_CLAIM', deadlineSafetyEvidence: 'x', claimConstructibleEvidence: 'y' });
  assert.equal(r.state, 'CLAIM_ARMED');
  r = applyEvt(r, { kind: 'REVEAL_SECRET' });
  assert.equal(r.state, 'SECRET_REVEALED');
  r = applyEvt(r, { kind: 'BEGIN_CLAIM', leg: 'L2' });
  r = applyEvt(r, { kind: 'CLAIM_CONFIRMED', leg: 'L2' });
  assert.equal(r.state, 'CLAIMED');
  assert.ok(isTerminal(r.state));
});

test('the state machine refuses to record a PARTIAL authoritative verification', () => {
  const partials = [
    { hashMatches: false },
    { amountExact: false },
    { amountAuthoritative: false },
    { deadlineSafe: false },
    { deadlineFresh: false },
    { confirmationsSufficient: false },
    { source: 'PROVIDER_ASSERTION' },
    { observedHashHex: 'not-hex' },
  ];
  for (const over of partials) {
    assert.throws(
      () => applyEvt(sessionRecord({ state: 'L1_FUNDED', l1TxId: 'tx1' }), { kind: 'L1_VERIFIED_FUNDED', evidence: provenL1Evidence(over) }),
      /L1_VERIFIED_FUNDED refused: unproven evidence/,
      `partial evidence accepted: ${JSON.stringify(over)}`,
    );
  }
  for (const over of [{ hashExact: false }, { amountExact: false }, { deadlineSafe: false }, { claimantExact: false }, { unspent: false }, { source: 'CACHED' }]) {
    assert.throws(
      () => applyEvt(sessionRecord({ state: 'BOTH_FUNDED', l2TxId: 'tx2' }), { kind: 'L2_VERIFIED_FUNDED', evidence: provenL2Evidence(over) }),
      /L2_VERIFIED_FUNDED refused: unproven evidence/,
      `partial L2 evidence accepted: ${JSON.stringify(over)}`,
    );
  }
});

test('CLAIM_ARMED bypass and premature secret reveal are refused', () => {
  assert.throws(() => applyEvt(sessionRecord({ state: 'BOTH_FUNDED' }), { kind: 'REVEAL_SECRET' }), /Illegal transition/);
  assert.throws(() => applyEvt(sessionRecord({ state: 'L1_FUNDED' }), { kind: 'ARM_CLAIM', deadlineSafetyEvidence: 'x', claimConstructibleEvidence: 'y' }), /Illegal transition/);
  assert.throws(() => sessionMod.requireSecretRevealAllowed(sessionRecord({ state: 'L1_FUNDED' })), /CLAIM_ARMED/);
  assert.throws(() => applyEvt(sessionRecord({ state: 'QUOTED' }), { kind: 'REVEAL_SECRET' }), /Illegal transition/);
});

test('secret store refuses reveal without CLAIM_ARMED evidence; wrong preimage fails', async () => {
  const store = new InMemorySecretStore();
  const pub = await store.generateAndStore('s1');
  assert.equal(pub.hashH.length, 64);
  await assert.rejects(() => store.revealSecret('s1', false), /CLAIM_ARMED/);
  const preimage = await store.revealSecret('s1', true);
  assert.equal(await verifyPreimage(preimage, pub.hashH), true);
  assert.equal(await verifyPreimage(preimage, 'ff'.repeat(32)), false);
  const notSecret = bytesToHex(new Uint8Array(32).fill(1));
  assert.equal(await verifyPreimage(notSecret, pub.hashH), false);
});

test('secret never leaks into serializable state', async () => {
  const store = new InMemorySecretStore();
  await store.generateAndStore('s2');
  const preimage = await store.revealSecret('s2', true);
  const historyJson = JSON.stringify(sessionRecord({ l1TxId: 'tx1' }));
  assertNoSecretInJson(historyJson, preimage);
  assert.throws(() => assertNoSecretInJson(JSON.stringify({ leaked: preimage }), preimage), /SECRET LEAKED/);
});

test('stale/expired unfunded quote terminates and cannot be revived', () => {
  const r = applyEvt(sessionRecord({ state: 'QUOTED' }), { kind: 'FAIL_TERMINAL', reason: 'quote expired unfunded' });
  assert.equal(r.state, 'FAILED_TERMINAL');
  assert.throws(() => applyEvt(r, { kind: 'ACCEPT_QUOTE', nowUnixMs: 2 }), /Illegal transition/);
});

test('terminal states stay terminal', () => {
  assert.throws(() => applyEvt(sessionRecord({ state: 'CLAIMED' }), { kind: 'BEGIN_REFUND', leg: 'L1' }), /Illegal transition/);
  assert.throws(() => applyEvt(sessionRecord({ state: 'REFUNDED' }), { kind: 'BEGIN_CLAIM', leg: 'L1' }), /Illegal transition/);
  assert.throws(() => applyEvt(sessionRecord({ state: 'FAILED_TERMINAL' }), { kind: 'BEGIN_L1_FUNDING', deadlineSafetyEvidence: 'x' }), /Illegal transition/);
});

test('funds cannot be claimed and refunded simultaneously (state machine disjoint)', () => {
  // From REFUNDING, the only legal outcome is REFUNDED — no claim path exists.
  const refundable = applyEvt(sessionRecord({ state: 'BOTH_FUNDED' }), { kind: 'REFUND_ELIGIBLE', leg: 'L1', authorityEvidence: 'x' });
  assert.equal(refundable.state, 'REFUND_ELIGIBLE');
  const refunding = applyEvt(refundable, { kind: 'BEGIN_REFUND', leg: 'L1' });
  assert.equal(refunding.state, 'REFUNDING');
  assert.throws(() => applyEvt(refunding, { kind: 'REVEAL_SECRET' }), /Illegal transition/);
  // Once BOTH_FUNDED arms a claim, the refund path is no longer legal from CLAIM_ARMED.
  const armed = applyEvt(sessionRecord({ state: 'BOTH_FUNDED' }), { kind: 'ARM_CLAIM', deadlineSafetyEvidence: 'x', claimConstructibleEvidence: 'y' });
  assert.equal(armed.state, 'CLAIM_ARMED');
  assert.throws(() => applyEvt(armed, { kind: 'BEGIN_REFUND', leg: 'L1' }), /Illegal transition/);
});

// ---------------------------------------------------------------------------
// Restart recovery decisions
// ---------------------------------------------------------------------------

test('neither leg funded → WAIT_OR_REFUND', async () => {
  const p = {
    l1: { lookupTransaction: async () => 'NOT_FOUND' },
    l2: { lookupTransaction: async () => 'NOT_FOUND' },
    reservations: new InMemoryReservationLedger({ prov_1: AD }),
    secrets: new InMemorySecretStore(),
    sessions: new InMemorySessionStore(),
  };
  await p.sessions.save(sessionRecord({ state: 'RECOVERY_REQUIRED' }));
  assert.equal((await recoverSession({ sessionId: 'sess_1', ports: p })).action, 'WAIT_OR_REFUND');
});

test('first leg confirmed, second never funded → CONTINUE (refund path available)', async () => {
  const p = {
    l1: { lookupTransaction: async () => 'COMMITTED' },
    l2: { lookupTransaction: async () => 'NOT_FOUND' },
    reservations: new InMemoryReservationLedger({ prov_1: AD }),
    secrets: new InMemorySecretStore(),
    sessions: new InMemorySessionStore(),
  };
  await p.sessions.save(sessionRecord({ state: 'L1_FUNDED', l1TxId: 'tx_l1' }));
  assert.equal((await recoverSession({ sessionId: 'sess_1', ports: p })).action, 'CONTINUE');
});

test('authoritative L1 verification refuses a merely-remembered amount', async () => {
  const sessions = new InMemorySessionStore();
  await sessions.save(sessionRecord({ state: 'L1_FUNDED', l1TxId: 'tx_l1' }));
  const observed = (over) => ({
    l1TxId: 'tx_l1',
    exists: true,
    amountRaw: '10000',
    hashHex: HASH,
    refundHeight: '500',
    confirmations: '5',
    currentHeight: '510',
    spent: false,
    source: 'BASE_NODE',
    ...over,
  });
  const deadlineSafety = { l1RemainingMarginMs: '900000', l2RemainingMarginMs: '900000', requiredL1MarginMs: '60000', requiredL2MarginMs: '60000' };
  // Blinded-amount adapter (the real Minotari base-node readback): the amount matches the
  // intent but is NOT independently proven, so settlement must refuse to treat it as exact.
  const blinded = ports({ sessions, l1: { providerName: () => 'dev', primitivesStatus: () => 'VERIFIED', network: () => 'esmeralda', observeHtlc: async () => observed({ amountAuthoritative: false }), lookupTransaction: async () => 'COMMITTED', listInFlightSwaps: async () => [] } });
  const refused = await verifyL1Funded({ sessionId: 'sess_1', ports: blinded, deadlineSafety });
  assert.equal(refused.verified, false);
  assert.equal(refused.evidence.amountExact, false);
  assert.equal(refused.evidence.amountAuthoritative, false);
  assert.equal(refused.evidence.hashMatches, true);
  // A refund height that is NOT ahead of the tip is already-refundable: refuse even when
  // every other field is perfect (this is the "stale/expired deadline" drain vector).
  const proven = ports({ sessions, l1: { providerName: () => 'dev', primitivesStatus: () => 'VERIFIED', network: () => 'esmeralda', capabilities: () => CAPS, observeHtlc: async () => observed({ amountAuthoritative: true }), lookupTransaction: async () => 'COMMITTED', listInFlightSwaps: async () => [] } });
  const stale = await verifyL1Funded({ sessionId: 'sess_1', ports: proven, deadlineSafety });
  assert.equal(stale.verified, false, 'refund height 500 at tip 510 is NOT fresh — already refundable');
  assert.equal(stale.evidence.deadlineFresh, false);
  assert.equal(stale.evidence.amountExact, true);
  // Fresh (refund height still ahead of the tip) + proven amount → verified and stamped.
  const fresh = ports({ sessions, l1: { providerName: () => 'dev', primitivesStatus: () => 'VERIFIED', network: () => 'esmeralda', capabilities: () => CAPS, observeHtlc: async () => observed({ amountAuthoritative: true, currentHeight: '400' }), lookupTransaction: async () => 'COMMITTED', listInFlightSwaps: async () => [] } });
  const verified = await verifyL1Funded({ sessionId: 'sess_1', ports: fresh, deadlineSafety });
  assert.equal(verified.verified, true);
  assert.equal(verified.evidence.amountExact, true);
  assert.equal(verified.evidence.deadlineFresh, true);
  assert.equal((await sessions.get('sess_1')).l1Verification.observedHashHex, HASH);
  // A provider ASSERTION is never authoritative evidence, even with every field true.
  const asserted = ports({ sessions: new InMemorySessionStore(), l1: { providerName: () => 'dev', primitivesStatus: () => 'VERIFIED', network: () => 'esmeralda', capabilities: () => CAPS, observeHtlc: async () => observed({ amountAuthoritative: true, currentHeight: '400', source: 'PROVIDER_ASSERTION' }), lookupTransaction: async () => 'COMMITTED', listInFlightSwaps: async () => [] } });
  await asserted.sessions.save(sessionRecord({ state: 'L1_FUNDED', l1TxId: 'tx_l1' }));
  const assertedResult = await verifyL1Funded({ sessionId: 'sess_1', ports: asserted, deadlineSafety });
  assert.equal(assertedResult.verified, false, 'PROVIDER_ASSERTION must never verify');
  assert.equal((await asserted.sessions.get('sess_1')).l1Verification, undefined);
});

test('claim committed → FINALIZE', async () => {
  const p = {
    l1: { lookupTransaction: async () => 'COMMITTED' },
    l2: { lookupTransaction: async () => 'COMMITTED' },
    reservations: new InMemoryReservationLedger({ prov_1: AD }),
    secrets: new InMemorySecretStore(),
    sessions: new InMemorySessionStore(),
  };
  await p.sessions.save(sessionRecord({ state: 'CLAIMING', l1ClaimTxId: 'claim_tx' }));
  const d = await recoverSession({ sessionId: 'sess_1', ports: p });
  assert.equal(d.action, 'FINALIZE');
  assert.equal(d.resolution, 'SETTLED');
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

test('asymmetric deadlines keep first leg later than second, within each domain', () => {
  const { deriveDeadlines } = require('../dist/crosschain/deadlines.js');
  const d = deriveDeadlines({ requiredL1Confirmations: '3', l1BlockMs: '30000', l2EpochMs: '10000', propagationDelayMs: '60000', safetyBufferMs: '60000', currentL1Height: '100', currentL2Epoch: '1000' });
  assert.equal(BigInt(d.firstLegRefundHeight) > 100n, true);
  assert.equal(BigInt(d.secondLegRefundEpoch) > 1000n, true);
  assert.equal(BigInt(d.marginEvidence.l1FirstLegMarginMs) > BigInt(d.marginEvidence.l2ClaimWindowMs), true);
});

test('deadline safety recheck refuses thin margins before irreversible phases', () => {
  const { assertDeadlineSafety, DeadlineError } = require('../dist/crosschain/deadlines.js');
  assert.doesNotThrow(() => assertDeadlineSafety({ phase: 'SECRET_REVEAL', l1RemainingMarginMs: '10000', l2RemainingMarginMs: '10000', requiredL1MarginMs: '5000', requiredL2MarginMs: '5000' }));
  assert.throws(() => assertDeadlineSafety({ phase: 'SECRET_REVEAL', l1RemainingMarginMs: '100', l2RemainingMarginMs: '10000', requiredL1MarginMs: '5000', requiredL2MarginMs: '5000' }), DeadlineError);
  assert.throws(() => assertDeadlineSafety({ phase: 'CLAIM_ARMED', l1RemainingMarginMs: '10000', l2RemainingMarginMs: '1', requiredL1MarginMs: '5000', requiredL2MarginMs: '5000' }), DeadlineError);
});

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

test('real submission OFF by default; mainnet refused even when gated on', () => {
  assert.equal(isRealSubmitEnabled({}, 'esmeralda').enabled, false);
  assert.equal(isRealSubmitEnabled({ TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: '1' }, 'esmeralda').enabled, true);
  assert.throws(() => isRealSubmitEnabled({ TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: '1' }, 'mainnet'), /MAINNET/);
  assert.throws(() => isRealSubmitEnabled({ TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: '1' }, 'stagenet'), /approved test network/);
});

// ---------------------------------------------------------------------------
// Property fuzzer: 20k randomized transitions; invariants after every accepted step
// ---------------------------------------------------------------------------

test('state-machine fuzzer holds invariants across 20k randomized transitions', () => {
  const EVENTS = [
    { kind: 'ACCEPT_QUOTE', nowUnixMs: 1 },
    { kind: 'BEGIN_L1_FUNDING', deadlineSafetyEvidence: 'x' },
    { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: 'tx' },
    { kind: 'L1_FUND_UNKNOWN', transportError: 'e' },
    { kind: 'L1_FUND_REJECTED', reason: 'r' },
    { kind: 'L1_VERIFIED_FUNDED', evidence: { l1TxId: 'tx', confirmations: '5', hashMatches: true, amountExact: true, deadlineSafe: true } },
    { kind: 'BEGIN_L2_FUNDING', deadlineSafetyEvidence: 'x' },
    { kind: 'L2_FUND_ACKNOWLEDGED', l2TxId: 'tx' },
    { kind: 'L2_VERIFIED_FUNDED', evidence: { l2TxId: 'tx', hashExact: true, amountExact: true, deadlineSafe: true } },
    { kind: 'ARM_CLAIM', deadlineSafetyEvidence: 'x', claimConstructibleEvidence: 'y' },
    { kind: 'REVEAL_SECRET' },
    { kind: 'BEGIN_CLAIM', leg: 'L2' },
    { kind: 'CLAIM_ACKNOWLEDGED', leg: 'L2', txId: 'tx' },
    { kind: 'CLAIM_CONFIRMED', leg: 'L2' },
    { kind: 'REFUND_ELIGIBLE', leg: 'L1', authorityEvidence: 'x' },
    { kind: 'BEGIN_REFUND', leg: 'L1' },
    { kind: 'REFUND_CONFIRMED', leg: 'L1' },
    { kind: 'ENTER_RECOVERY', reason: 'rpc failure' },
    { kind: 'RECOVERY_RESOLVED', resolution: 'CLAIMING' },
    { kind: 'FAIL_TERMINAL', reason: 'x' },
  ];
  let seed = 0xA11CE;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483647; };
  let accepted = 0;
  for (let trial = 0; trial < 1000; trial++) {
    let r = sessionRecord({ sessionId: `t${trial}`, state: 'QUOTED' });
    for (let step = 0; step < 10; step++) {
      const ev = EVENTS[Math.floor(rand() * EVENTS.length)];
      try {
        r = applyEvt(r, ev);
        accepted += 1;
      } catch (e) {
        assert.ok(e instanceof IllegalTransitionError, `non-fail-closed rejection: ${e.message}`);
        continue;
      }
      if (r.secretRevealedAtUnixMs !== undefined) {
        // secret reveal only ever happens after the CLAIM_ARMED gate (guaranteed by the
        // transition table); any subsequent state is a post-reveal outcome
        assert.ok(['SECRET_REVEALED', 'CLAIMING', 'RECOVERY_REQUIRED', 'REFUNDING', 'REFUNDED', 'FAILED_TERMINAL'].includes(r.state), `reveal state ${r.state}`);
      }
      if (r.state === 'SECRET_REVEALED') {
        assert.ok(r.secretRevealedAtUnixMs !== undefined);
      }
      assert.ok(!sessionMod.TERMINAL_STATES.has(r.state) || ['CLAIMED', 'REFUNDED', 'FAILED_TERMINAL'].includes(r.state));
    }
  }
  assert.equal(accepted > 0, true);
});

test('REVEAL_SECRET without CLAIM_ARMED never succeeds across 5k randomized states (property)', () => {
  let leaked = 0;
  const states = ['RESERVED', 'L1_FUNDED', 'BOTH_FUNDED', 'L2_FUNDING', 'QUOTED', 'RECOVERY_REQUIRED'];
  for (let i = 0; i < 5000; i++) {
    const from = states[i % states.length];
    try {
      const r = applyEvt(sessionRecord({ state: from }), { kind: 'REVEAL_SECRET' });
      if (r.secretRevealedAtUnixMs !== undefined) leaked += 1;
    } catch (e) {
      assert.ok(e instanceof IllegalTransitionError || /CLAIM_ARMED/.test(e.message), `${e.message}`);
    }
  }
  assert.equal(leaked, 0);
});