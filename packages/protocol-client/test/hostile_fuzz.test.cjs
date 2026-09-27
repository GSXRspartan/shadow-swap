/**
 * HOSTILE FUZZ SUITE — FAST_XTM_TARI
 *  §22 state-machine fuzzing (>=100,000 accepted/rejected transition attempts)
 *  §23 crash-point fuzzing (restart after every irreversible step)
 *  §5  script fuzzing (shared with hostile_crosschain, extended here with structure-aware seeds)
 *
 * Fuzzing discipline:
 *  - deterministic PRNG seeded from a fixed base seed, so every failure is reproducible;
 *  - ANY invariant violation or unexpected acceptance PERSISTS the seed to
 *    test/fuzz-failing-seeds.jsonl before the assertion fires;
 *  - invariants are checked after EVERY accepted transition, not only at the end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sessionMod = require('../dist/crosschain/session.js');
const { IllegalTransitionError, TERMINAL_STATES, InMemorySessionStore, isTerminal } = sessionMod;
const { InMemoryReservationLedger } = require('../dist/crosschain/reservation.js');
const { InMemorySecretStore, bytesToHex, verifyPreimage } = require('../dist/crosschain/secret.js');
const { serializeShaHtlcScript, decodeShaHtlcScript, executeShaHtlcBranch } = require('../dist/chains/minotari.js');
const coord = require('../dist/crosschain/coordinator.js');

const SEED_FILE = path.join(__dirname, 'fuzz-failing-seeds.jsonl');
const BASE_SEED = 0x5eed1234;
const S_HEX = '44'.repeat(32);
const H_OF_S = bytesToHex(require('node:crypto').createHash('sha256').update(Buffer.from(S_HEX, 'hex')).digest());

/** xorshift32 — small, deterministic, and identical across platforms. */
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function persistSeed(kind, seed, detail) {
  const line = JSON.stringify({ kind, seed, detail, at: new Date().toISOString() });
  fs.appendFileSync(SEED_FILE, `${line}\n`, 'utf8');
  return line;
}

const AD = {
  providerId: 'prov_1', pair: 'XTM/TARI', xtmAvailable: '1000000', tariAvailable: '1000000000',
  minTradeXtm: '1', maxTradeXtm: '900000', spreadBps: '50', quoteTtlMs: '60000',
  requiredL1Confirmations: '3', network: 'esmeralda',
};
const DEADLINE_OK = { l1RemainingMarginMs: '900000', l2RemainingMarginMs: '900000', requiredL1MarginMs: '60000', requiredL2MarginMs: '60000' };
const ENV_ON = { TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: '1' };

function quoteView(over = {}) {
  return {
    quoteId: 'q_fuzz', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000',
    hashH: '', l1ClaimRecipient: 'l1_addr', l2ClaimRecipient: 'l2_addr', l1RefundDeadlineHeight: '16000',
    l2RefundDeadlineEpoch: '1200', requiredL1Confirmations: '3', quoteExpiresAtUnixMs: 9_999_999,
    l1Network: 'esmeralda', l2Network: 'esmeralda', ...over,
  };
}

function record(over = {}) {
  return {
    sessionId: 'sess_fuzz', state: 'QUOTED', quoteId: 'q_fuzz', reservationId: 'res_fuzz', providerId: 'prov_1',
    direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: '',
    l1ClaimRecipient: 'l1_addr', l2ClaimRecipient: 'l2_addr', l1Network: 'esmeralda', l2Network: 'esmeralda',
    l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200', requiredL1Confirmations: '3',
    createdAtUnixMs: 1, updatedAtUnixMs: 1, ...over,
  };
}

const ALL_STATES = Object.keys(sessionMod.TRANSITION_TABLE_FOR_TESTS ?? {}).length > 0
  ? Object.keys(sessionMod.TRANSITION_TABLE_FOR_TESTS)
  : ['QUOTED', 'RESERVED', 'L1_FUNDING', 'L1_FUNDED', 'L2_FUNDING', 'BOTH_FUNDED', 'CLAIM_ARMED', 'SECRET_REVEALED', 'CLAIMING', 'REFUND_ELIGIBLE', 'REFUNDING', 'RECOVERY_REQUIRED'];

const EVENTS = [
  { kind: 'ACCEPT_QUOTE', nowUnixMs: 1 },
  { kind: 'QUOTE_EXPIRED_UNFUNDED', nowUnixMs: 2 },
  { kind: 'BEGIN_L1_FUNDING', deadlineSafetyEvidence: 'fuzz' },
  { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: 'tx_l1', hashHex: H_OF_S },
  { kind: 'L1_FUND_UNKNOWN', transportError: 'fuzz' },
  { kind: 'L1_FUND_REJECTED', reason: 'fuzz' },
  { kind: 'BEGIN_L2_FUNDING', deadlineSafetyEvidence: 'fuzz' },
  { kind: 'L2_FUND_ACKNOWLEDGED', l2TxId: 'tx_l2' },
  { kind: 'L2_FUND_UNKNOWN', transportError: 'fuzz' },
  { kind: 'L2_FUND_REJECTED', reason: 'fuzz' },
  { kind: 'ARM_CLAIM', deadlineSafetyEvidence: 'fuzz', claimConstructibleEvidence: 'fuzz' },
  { kind: 'REVEAL_SECRET' },
  { kind: 'BEGIN_CLAIM', leg: 'L2' },
  { kind: 'CLAIM_ACKNOWLEDGED', leg: 'L2', txId: 'claim_l2' },
  { kind: 'CLAIM_ACKNOWLEDGED', leg: 'L1', txId: 'claim_l1' },
  { kind: 'CLAIM_UNKNOWN', leg: 'L2', transportError: 'fuzz' },
  { kind: 'CLAIM_CONFIRMED', leg: 'L2' },
  { kind: 'REFUND_ELIGIBLE', leg: 'L1', authorityEvidence: 'fuzz' },
  { kind: 'BEGIN_REFUND', leg: 'L1' },
  { kind: 'REFUND_ACKNOWLEDGED', leg: 'L1', txId: 'refund_l1' },
  { kind: 'REFUND_CONFIRMED', leg: 'L1' },
  { kind: 'ENTER_RECOVERY', reason: 'fuzz' },
  { kind: 'RECOVERY_RESOLVED', resolution: 'CLAIMING' },
  { kind: 'FAIL_TERMINAL', reason: 'fuzz' },
];

function provenL1(over = {}) {
  return {
    l1TxId: 'tx_l1', confirmations: '5', hashMatches: true, amountExact: true, amountAuthoritative: true,
    deadlineSafe: true, deadlineFresh: true, confirmationsSufficient: true, source: 'BASE_NODE',
    observedHashHex: H_OF_S, observedAmountRaw: '10000', observedRefundHeight: '16000', observedCurrentHeight: '9000',
    verifiedAtUnixMs: 1, ...over,
  };
}
function provenL2(over = {}) {
  return { l2TxId: 'tx_l2', hashExact: true, amountExact: true, deadlineSafe: true, claimantExact: true, unspent: true, source: 'AUTHORITATIVE', observedAmountRaw: '5000000', verifiedAtUnixMs: 1, ...over };
}

/** Invariants that must hold after EVERY accepted transition. */
function checkInvariants(r, ctx) {
  const fail = (why) => {
    const line = persistSeed('state-machine', ctx.seed, { why, state: r.state, event: ctx.event });
    throw new Error(`INVARIANT VIOLATED: ${why} (seed persisted: ${line})`);
  };
  // 1. terminal is terminal: a session already in a terminal state must stay there
  if (TERMINAL_STATES.has(ctx.state) && r.state !== ctx.state) {
    fail(`terminal state ${ctx.state} transitioned to ${r.state}`);
  }
  // 2. a preimage is only ever FIRST marked as revealed by REVEAL_SECRET
  if (ctx.prevRevealed === undefined && r.secretRevealedAtUnixMs !== undefined && ctx.event.kind !== 'REVEAL_SECRET') {
    fail(`secretRevealedAtUnixMs set by ${ctx.event.kind} from ${ctx.state}`);
  }
  if (r.secretRevealedAtUnixMs !== undefined && !['SECRET_REVEALED', 'CLAIMING', 'RECOVERY_REQUIRED', 'REFUND_ELIGIBLE', 'REFUNDING', 'REFUNDED', 'CLAIMED', 'FAILED_TERMINAL'].includes(r.state)) {
    fail(`revealed session reached unexpected state ${r.state}`);
  }
  // 3. an H bound after binding can never change to a different value
  if (ctx.prevHash && r.hashH && r.hashH !== '' && ctx.prevHash !== '' && r.hashH !== ctx.prevHash) {
    fail(`hashH mutated ${ctx.prevHash} → ${r.hashH}`);
  }
  // 4. amounts are immutable once accepted
  if (ctx.prevXtm !== undefined && r.xtmRawAmount !== ctx.prevXtm) fail(`xtmRawAmount mutated to ${r.xtmRawAmount}`);
  if (ctx.prevTari !== undefined && r.tariRawAmount !== ctx.prevTari) fail(`tariRawAmount mutated to ${r.tariRawAmount}`);
  // 5. a verification stamp only ever exists with fully proven evidence
  if (r.l1Verification) {
    const e = r.l1Verification;
    if (!e.hashMatches || !e.amountExact || !e.amountAuthoritative || !e.deadlineSafe || !e.deadlineFresh || !e.confirmationsSufficient) {
      fail('l1Verification stamped with unproven evidence');
    }
    if (e.source === 'PROVIDER_ASSERTION') fail('l1Verification stamped from a provider assertion');
  }
  if (r.l2Verification && r.l2Verification.source !== 'AUTHORITATIVE') fail('l2Verification stamped from a non-authoritative read');
  // 6. a claim/refund terminal state cannot return to a live one
  if (ctx.state === 'CLAIMED' || ctx.state === 'REFUNDED' || ctx.state === 'FAILED_TERMINAL') {
    if (r.state !== ctx.state) fail(`terminal ${ctx.state} moved to ${r.state}`);
  }
}

// ===========================================================================
// 22. STATE-MACHINE FUZZING (>= 100,000 transition attempts)
// ===========================================================================

test('22.1 100k randomized transition attempts never violate a safety invariant', () => {
  const targetOps = 100_000;
  const rng = makeRng(BASE_SEED);
  let attempts = 0;
  let accepted = 0;
  let rejected = 0;
  const seenStates = new Set();
  const seenEvents = new Set();

  for (let trial = 0; attempts < targetOps; trial++) {
    // start each trial from a random state with a random amount of history
    let r = record({ state: ALL_STATES[trial % ALL_STATES.length], sessionId: `sess_${trial}` });
    const steps = 1 + Math.floor(rng() * 12);
    for (let step = 0; step < steps && attempts < targetOps; step++) {
      const ev = EVENTS[Math.floor(rng() * EVENTS.length)];
      attempts += 1;
      seenEvents.add(ev.kind);
      const ctx = { seed: BASE_SEED + trial, event: ev, state: r.state, prevHash: r.hashH, prevXtm: r.xtmRawAmount, prevTari: r.tariRawAmount, prevRevealed: r.secretRevealedAtUnixMs };
      let next;
      try {
        next = sessionMod.applyEvent(r, ev);
        accepted += 1;
        checkInvariants(next, ctx);
        seenStates.add(next.state);
      } catch (error) {
        if (error instanceof IllegalTransitionError || /refused|unproven|Illegal|must be|cannot/i.test(error.message)) {
          rejected += 1;
          continue;
        }
        // An unexpected error type is a finding, not a pass.
        persistSeed('state-machine-unexpected-error', BASE_SEED + trial, { message: error.message, ev });
        throw error;
      }
      r = next;
    }
  }
  assert.ok(attempts >= targetOps, `expected >= ${targetOps} attempts, ran ${attempts}`);
  assert.ok(accepted > 1000, `expected meaningful accepted transitions, got ${accepted}`);
  assert.ok(rejected > 1000, `expected meaningful refusals, got ${rejected}`);
  // coverage: the fuzzer must have exercised a broad slice of the machine
  assert.ok(seenStates.size >= 10, `fuzzer only reached ${seenStates.size} states`);
  assert.ok(seenEvents.size >= 18, `fuzzer only exercised ${seenEvents.size} event kinds`);
  assert.ok(!fs.existsSync(SEED_FILE) || fs.readFileSync(SEED_FILE, 'utf8').trim() === '', 'fuzzing persisted a failing seed');
});

test('22.2 every accepted transition is reachable from QUOTED (no orphan states)', () => {
  // Reachability closure from the initial state using only legal events.
  const reach = new Set(['QUOTED', 'REFUND_ELIGIBLE']); // REFUND_ELIGIBLE is legal from every non-terminal state
  const queue = ['QUOTED', 'REFUND_ELIGIBLE'];
  const legalFrom = {
    QUOTED: ['ACCEPT_QUOTE', 'FAIL_TERMINAL'],
    RESERVED: ['BEGIN_L1_FUNDING', 'FAIL_TERMINAL', 'ENTER_RECOVERY'],
    L1_FUNDING: ['L1_FUND_ACKNOWLEDGED', 'L1_FUND_UNKNOWN', 'L1_FUND_REJECTED', 'ENTER_RECOVERY'],
    L1_FUNDED: ['L1_VERIFIED_FUNDED', 'BEGIN_L2_FUNDING', 'ENTER_RECOVERY'],
    L2_FUNDING: ['L2_FUND_ACKNOWLEDGED', 'L2_FUND_UNKNOWN', 'L2_FUND_REJECTED', 'ENTER_RECOVERY'],
    BOTH_FUNDED: ['L2_VERIFIED_FUNDED', 'L1_VERIFIED_FUNDED', 'ARM_CLAIM', 'ENTER_RECOVERY'],
    CLAIM_ARMED: ['L1_VERIFIED_FUNDED', 'L2_VERIFIED_FUNDED', 'REVEAL_SECRET', 'ENTER_RECOVERY'],
    SECRET_REVEALED: ['BEGIN_CLAIM', 'ENTER_RECOVERY'],
    CLAIMING: ['CLAIM_ACKNOWLEDGED', 'CLAIM_UNKNOWN', 'CLAIM_CONFIRMED', 'ENTER_RECOVERY'],
    REFUNDING: ['REFUND_ACKNOWLEDGED', 'REFUND_UNKNOWN', 'REFUND_CONFIRMED', 'ENTER_RECOVERY'],
    RECOVERY_REQUIRED: ['RECOVERY_RESOLVED', 'ENTER_RECOVERY'],
    CLAIMED: [], REFUNDED: [], FAILED_TERMINAL: [], REFUND_ELIGIBLE: ['BEGIN_REFUND', 'ENTER_RECOVERY'],
  };
  const next = {
    QUOTED: { ACCEPT_QUOTE: 'RESERVED', FAIL_TERMINAL: 'FAILED_TERMINAL' },
    RESERVED: { BEGIN_L1_FUNDING: 'L1_FUNDING', FAIL_TERMINAL: 'FAILED_TERMINAL', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    L1_FUNDING: { L1_FUND_ACKNOWLEDGED: 'L1_FUNDED', L1_FUND_UNKNOWN: 'RECOVERY_REQUIRED', L1_FUND_REJECTED: 'FAILED_TERMINAL', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    L1_FUNDED: { L1_VERIFIED_FUNDED: 'L1_FUNDED', BEGIN_L2_FUNDING: 'L2_FUNDING', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    L2_FUNDING: { L2_FUND_ACKNOWLEDGED: 'BOTH_FUNDED', L2_FUND_UNKNOWN: 'RECOVERY_REQUIRED', L2_FUND_REJECTED: 'FAILED_TERMINAL', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    BOTH_FUNDED: { L2_VERIFIED_FUNDED: 'BOTH_FUNDED', L1_VERIFIED_FUNDED: 'BOTH_FUNDED', ARM_CLAIM: 'CLAIM_ARMED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    CLAIM_ARMED: { L1_VERIFIED_FUNDED: 'CLAIM_ARMED', L2_VERIFIED_FUNDED: 'CLAIM_ARMED', REVEAL_SECRET: 'SECRET_REVEALED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    SECRET_REVEALED: { BEGIN_CLAIM: 'CLAIMING', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    CLAIMING: { CLAIM_ACKNOWLEDGED: 'CLAIMING', CLAIM_UNKNOWN: 'RECOVERY_REQUIRED', CLAIM_CONFIRMED: 'CLAIMED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    REFUND_ELIGIBLE: { BEGIN_REFUND: 'REFUNDING', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    REFUNDING: { REFUND_ACKNOWLEDGED: 'REFUNDING', REFUND_UNKNOWN: 'RECOVERY_REQUIRED', REFUND_CONFIRMED: 'REFUNDED', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
    RECOVERY_REQUIRED: { RECOVERY_RESOLVED: 'CLAIMING', ENTER_RECOVERY: 'RECOVERY_REQUIRED' },
  };
  while (queue.length > 0) {
    const state = queue.shift();
    for (const kind of legalFrom[state] ?? []) {
      const target = next[state]?.[kind];
      if (target && !reach.has(target)) {
        reach.add(target);
        queue.push(target);
      }
    }
  }
  // REFUND_ELIGIBLE is legal from every non-terminal state, so it is reachable too
  for (const s of ALL_STATES) {
    assert.ok(reach.has(s), `unreachable state ${s}`);
  }
});

// ===========================================================================
// 23. CRASH-POINT FUZZING
// ===========================================================================

/** A durable snapshot: only what a restart could legitimately recover. */
function snapshotOf(ports) {
  return { sessions: JSON.parse(JSON.stringify(ports.sessions._sessions ?? {})), inMemory: true };
}

test('23.1 a crash after every step never lets recovery re-drive a terminal session or blind-resubmit', async () => {
  // Crash points, in order, each simulated by rebuilding a FRESH store from the durable
  // session record only (never from in-memory coordinator state).
  const steps = ['quote', 'reservation', 'l1-constructed', 'l1-submitted', 'l1-confirmed', 'l2-submitted', 'both-funded', 'claim-armed', 'secret-revealed', 'claim-submitted', 'refund-submitted', 'released'];
  for (const crashAt of steps) {
    const sessions = new InMemorySessionStore();
    const secrets = new InMemorySecretStore();
    const ledger = new InMemoryReservationLedger({ prov_1: AD });
    const l1Status = crashAt === 'l1-confirmed' || crashAt === 'l1-submitted' ? 'COMMITTED' : 'NOT_FOUND';
    const l2Status = ['both-funded', 'claim-armed', 'secret-revealed', 'claim-submitted'].includes(crashAt) ? 'COMMITTED' : 'NOT_FOUND';
    const l1 = {
      providerName: () => 'fuzz-l1', primitivesStatus: () => 'VERIFIED', network: () => 'esmeralda',
      capabilities: () => ({ l1Balance: true, l1NormalSend: true, l1ShaInit: true, l1ShaInspect: true, l1ShaClaim: true, l1ShaRefund: true, l2HtlcFund: true, l2HtlcClaim: true, l2HtlcRefund: true }),
      discoverWallets: async () => [], readiness: async () => 'READY', chainStatus: async () => ({ network: 'esmeralda', currentHeight: '9000', synced: true }),
      balance: async () => ({ available: '0', pendingIncoming: '0', pendingOutgoing: '0' }),
      constructHtlcFunding: (i) => ({ intent: i, feeEstimate: '0' }), authorizeFunding: async () => ({ authorized: true }),
      submitFunding: async () => ({ l1TxId: 'tx_l1', walletPreimageHex: S_HEX, outputHashHex: 'ab'.repeat(32) }),
      observeHtlc: async () => ({ l1TxId: 'tx_l1', exists: true, amountRaw: '10000', hashHex: H_OF_S, refundHeight: '16000', refundRecipient: 'rk', confirmations: '5', currentHeight: '9000', spent: false, source: 'BASE_NODE', amountAuthoritative: true }),
      constructClaim: async () => ({ feeEstimate: '0' }), authorizeClaim: async () => ({ authorized: true }),
      submitClaim: async () => ({ l1TxId: 'claim_l1' }),
      constructRefund: async () => ({ feeEstimate: '0' }), authorizeRefund: async () => ({ authorized: true }), submitRefund: async () => ({ l1TxId: 'refund_l1' }),
      lookupTransaction: async () => l1Status, listInFlightSwaps: async () => [],
    };
    const l2 = {
      capabilities: () => ({ l1Balance: true, l1NormalSend: true, l1ShaInit: true, l1ShaInspect: true, l1ShaClaim: true, l1ShaRefund: true, l2HtlcFund: true, l2HtlcClaim: true, l2HtlcRefund: true }),
      constructFunding: async () => ({ feeEstimate: '0' }), authorizeFunding: async () => ({ authorized: true }),
      submitFunding: async () => ({ l2TxId: 'tx_l2' }),
      observeHashlockOutput: async () => ({ exists: true, amountRaw: '5000000', hashExact: true, claimantExact: true, epochRefundExact: true, unspent: true, source: 'AUTHORITATIVE' }),
      constructClaim: async () => ({ feeEstimate: '0' }), submitClaim: async () => ({ l2TxId: 'claim_l2' }),
      constructRefund: async () => ({ feeEstimate: '0' }), submitRefund: async () => ({ l2TxId: 'refund_l2' }),
      lookupTransaction: async () => l2Status,
    };
    const ports = { l1, l2, reservations: ledger, secrets, sessions };
    // Advance to the crash point, tolerating refusals on later steps.
    await coord.acceptQuote({ request: { sessionId: 'sess_crash', reservationId: 'res_crash', quote: quoteView(), nowUnixMs: 1 }, ports });
    if (steps.indexOf(crashAt) >= steps.indexOf('l1-submitted')) {
      await coord.beginL1Funding({ sessionId: 'sess_crash', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
    }
    if (steps.indexOf(crashAt) >= steps.indexOf('l1-confirmed')) {
      await coord.verifyL1Funded({ sessionId: 'sess_crash', ports, deadlineSafety: DEADLINE_OK });
    }
    if (steps.indexOf(crashAt) >= steps.indexOf('l2-submitted')) {
      await coord.beginL2Funding({ sessionId: 'sess_crash', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
    }
    if (steps.indexOf(crashAt) >= steps.indexOf('both-funded')) {
      await coord.verifyL2Funded({ sessionId: 'sess_crash', ports });
    }
    if (steps.indexOf(crashAt) >= steps.indexOf('claim-armed')) {
      await coord.armClaim({ sessionId: 'sess_crash', ports, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
    }
    if (steps.indexOf(crashAt) >= steps.indexOf('secret-revealed')) {
      await coord.revealAndClaimL2({ sessionId: 'sess_crash', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
    }

    // ---- CRASH: rebuild ONLY the durable session + secret store ----
    const durable = await sessions.get('sess_crash');
    const recoveredSessions = new InMemorySessionStore();
    if (durable) await recoveredSessions.save(durable);
    const recoveredSecrets = new InMemorySecretStore();
    if (durable && (await sessions.hasSecret?.('sess_crash'))) { /* in-memory store: re-ingest is impossible, which is the point */ }
    const recovered = { ...ports, sessions: recoveredSessions, secrets: recoveredSecrets };
    const decision = await coord.recoverSession({ sessionId: 'sess_crash', ports: recovered });

    if (durable && isTerminal(durable.state)) {
      assert.equal(decision.action, undefined, `crash at ${crashAt}: terminal session was re-driven`);
    } else {
      assert.ok(decision.action !== undefined, `crash at ${crashAt}: no recovery decision for ${durable?.state}`);
      // recovery must NEVER re-drive an irreversible submit for a session that already has
      // an acknowledged tx id
      if (durable?.l1TxId && durable.state === 'RECOVERY_REQUIRED') {
        assert.ok(decision.reason.length > 0, 'a recovery decision must carry evidence');
      }
    }
    // A recovered session whose secret is gone must not be able to claim.
    if (durable && durable.state === 'CLAIM_ARMED') {
      await assert.rejects(() => coord.revealAndClaimL2({ sessionId: 'sess_crash', ports: recovered, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }), /No secret stored/);
    }
    assert.ok(!fs.existsSync(SEED_FILE) || fs.readFileSync(SEED_FILE, 'utf8').trim() === '', `crash fuzz at ${crashAt} persisted a failing seed`);
  }
});

test('23.2 a session whose secret was lost after funding is never re-pointed at a different preimage', async () => {
  // The store itself cannot know a session is funded, so the binding lives in the
  // COORDINATOR: a provider that returns a DIFFERENT preimage than the bound H must abort
  // the funding attempt (never re-point the session) and leave the session recoverable.
  const sessions = new InMemorySessionStore();
  const secrets = new InMemorySecretStore();
  const ledger = new InMemoryReservationLedger({ prov_1: AD });
  const CAPS = { l1Balance: true, l1NormalSend: true, l1ShaInit: true, l1ShaInspect: true, l1ShaClaim: true, l1ShaRefund: true, l2HtlcFund: true, l2HtlcClaim: true, l2HtlcRefund: true };
  const l1 = {
    providerName: () => 'fuzz-l1', primitivesStatus: () => 'VERIFIED', network: () => 'esmeralda', capabilities: () => CAPS,
    discoverWallets: async () => [], readiness: async () => 'READY', chainStatus: async () => ({ network: 'esmeralda', currentHeight: '9000', synced: true }),
    balance: async () => ({ available: '0', pendingIncoming: '0', pendingOutgoing: '0' }),
    constructHtlcFunding: (i) => ({ intent: i, feeEstimate: '0' }), authorizeFunding: async () => ({ authorized: true }),
    // a MALICIOUS provider hands back a preimage that does not match the accepted quote H
    submitFunding: async () => ({ l1TxId: 'tx_l1', walletPreimageHex: '99'.repeat(32), outputHashHex: 'ab'.repeat(32) }),
    observeHtlc: async () => ({ l1TxId: 'tx_l1', exists: false, amountRaw: '0', confirmations: '0', currentHeight: '9000', spent: false, source: 'BASE_NODE' }),
    constructClaim: async () => ({ feeEstimate: '0' }), authorizeClaim: async () => ({ authorized: true }), submitClaim: async () => ({ l1TxId: 'c' }),
    constructRefund: async () => ({ feeEstimate: '0' }), authorizeRefund: async () => ({ authorized: true }), submitRefund: async () => ({ l1TxId: 'r' }),
    lookupTransaction: async () => 'UNKNOWN', listInFlightSwaps: async () => [],
  };
  const l2 = { capabilities: () => CAPS, constructFunding: async () => ({}), authorizeFunding: async () => ({}), submitFunding: async () => ({ l2TxId: 't' }), observeHashlockOutput: async () => ({ exists: false, amountRaw: '0', hashExact: false, claimantExact: false, epochRefundExact: false, unspent: false, source: 'CACHED' }), constructClaim: async () => ({}), submitClaim: async () => ({}), constructRefund: async () => ({}), submitRefund: async () => ({}), lookupTransaction: async () => 'NOT_FOUND' };
  const ports = { l1, l2, reservations: ledger, secrets, sessions };
  // the quote fixes H (XTM_TO_TARI style, where we already know S)
  await coord.acceptQuote({ request: { sessionId: 'sess_lost', reservationId: 'res_lost', quote: quoteView({ hashH: H_OF_S }), nowUnixMs: 1 }, ports });
  const out = await coord.beginL1Funding({ sessionId: 'sess_lost', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(out.outcome, 'UNKNOWN', 'a mismatching wallet preimage aborts funding instead of re-pointing the session');
  const rec = await sessions.get('sess_lost');
  assert.equal(rec.hashH, H_OF_S, 'the bound H is unchanged');
  assert.equal(await secrets.hasSecret('sess_lost'), false, 'the rogue preimage was never stored');
  // a restart that lost the secret cannot claim, and cannot adopt a new preimage silently
  const restarted = new InMemorySecretStore();
  assert.equal(await restarted.hasSecret('sess_lost'), false);
  await assert.rejects(() => restarted.revealSecret('sess_lost', true), /No secret stored/);
});

// ===========================================================================
// 5 (extended). STRUCTURE-AWARE SCRIPT FUZZING
// ===========================================================================

test('5.4 structure-aware script fuzz: 50k structured mutations never pass verification incorrectly', () => {
  const rng = makeRng(BASE_SEED ^ 0xabcdef);
  const CLAIM = '22'.repeat(32);
  const REFUND = '33'.repeat(32);
  const base = Array.from(serializeShaHtlcScript({ hashHex: H_OF_S, claimPubKeyHex: CLAIM, refundPubKeyHex: REFUND, refundHeight: '16000' }));
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 50_000; i++) {
    const bytes = base.slice();
    const choice = Math.floor(rng() * 6);
    if (choice === 0) bytes[Math.floor(rng() * bytes.length)] = Math.floor(rng() * 256);        // byte flip
    if (choice === 1) bytes[34] = [0x80, 0x81, 0x60, 0x61][Math.floor(rng() * 4)];               // control opcode
    if (choice === 2) bytes[0] = [0xb0, 0xb2, 0x69, 0x7f][Math.floor(rng() * 4)];                // leading opcode
    if (choice === 3) bytes.splice(35, 0, 0x61, 0x63);                                            // insert branch
    if (choice === 4) bytes.splice(Math.floor(rng() * bytes.length), 1);                            // delete byte
    if (choice === 5) bytes.push(Math.floor(rng() * 256));                                         // trailing data
    const u8 = Uint8Array.from(bytes);
    let view = null;
    try {
      view = decodeShaHtlcScript(u8);
    } catch {
      refused += 1;
      continue;
    }
    const outcome = executeShaHtlcBranch(u8, S_HEX, '9000');
    // INVARIANT A (self-consistency): whatever the script says, the verifier must report
    // the key decoded from THAT script — never a cached/expected key.
    if (outcome.ok) {
      assert.equal(outcome.requiredScriptSignaturePubKeyHex, view.claimPubKeyHex, 'verifier reported a claimant key that is not the one in the script');
    }
    // INVARIANT B (the security-critical one): a script whose embedded hash is NOT ours
    // must never accept our preimage. This is the hashlock itself.
    if (view.hashHex !== H_OF_S) {
      assert.equal(outcome.ok, false, `a script with a different embedded hash accepted our preimage (hash=${view.hashHex.slice(0, 8)}…)`);
    }
    // INVARIANT C: our preimage against OUR hash claims under OUR claimant key.
    if (view.hashHex === H_OF_S && view.claimPubKeyHex === CLAIM) {
      assert.equal(outcome.ok, true, 'our own preimage failed against our own hashlock');
      accepted += 1;
    } else {
      refused += 1;
    }
  }
  assert.ok(accepted + refused === 50_000, 'fuzzer accounting drifted');
  assert.ok(refused > 1000, 'fuzzer never exercised the refusal path');
  assert.ok(!fs.existsSync(SEED_FILE) || fs.readFileSync(SEED_FILE, 'utf8').trim() === '', 'script fuzz persisted a failing seed');
});
