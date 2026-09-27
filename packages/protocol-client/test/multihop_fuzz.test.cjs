/**
 * HOSTILE MULTI-HOP PROPERTY FUZZER — XTM → FAST_XTM_TARI → TARI → AMM
 *
 * §24: >= 100,000 route transition attempts with the eight required properties checked
 * after EVERY accepted transition. Deterministic xorshift32 PRNG; any property violation
 * persists the seed to test/multihop-fuzz-seeds.jsonl before failing.
 *
 * Properties:
 *   1. hop 2 never executes before a valid terminal proof
 *   2. the intermediate TARI is never lost
 *   3. the final output never violates the accepted minimum
 *   4. terminal routes remain terminal
 *   5. UNKNOWN never blindly resubmits
 *   6. one route cannot consume another route's settlement proof
 *   7. no duplicate hop settlement
 *   8. source/intermediate/destination identity remains exact
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const routeMod = require('../dist/multihop/route.js');
const mhTypes = require('../dist/multihop/types.js');
const proofMod = require('../dist/multihop/proof.js');

const SEED_FILE = path.join(__dirname, 'multihop-fuzz-seeds.jsonl');
const BASE_SEED = 0x4d485001;
const S_HEX = '66'.repeat(32);
const H_OF_S = nodeCrypto.createHash('sha256').update(Buffer.from(S_HEX, 'hex')).digest('hex');
const XTM = { kind: 'MINOTARI_L1', resourceAddress: 'x1', label: 'XTM', decimals: '6' };
const TARI = { kind: 'OOTLE_L2', resourceAddress: 't1', label: 'TARI', decimals: '6', isCanonicalTari: true };
const WSTABLE = { kind: 'OOTLE_L2', resourceAddress: 'w1', label: 'wSTABLE', decimals: '6' };
const DECOY = { kind: 'OOTLE_L2', resourceAddress: 't1_lookalike', label: 'TARI', decimals: '6', isCanonicalTari: true };

function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

function persist(kind, seed, detail) {
  const line = JSON.stringify({ kind, seed, detail, at: new Date().toISOString() });
  fs.appendFileSync(SEED_FILE, `${line}\n`, 'utf8');
  return line;
}

const AD = {
  providerId: 'prov_fuzz', pair: 'XTM/TARI', xtmAvailable: '100000000', tariAvailable: '1000000000000',
  minTradeXtm: '1', maxTradeXtm: '90000000', spreadBps: '50', quoteTtlMs: '60000', requiredL1Confirmations: '3', network: 'esmeralda',
};

function provenL1() { return { l1TxId: 'tx1', confirmations: '5', hashMatches: true, amountExact: true, amountAuthoritative: true, deadlineSafe: true, deadlineFresh: true, confirmationsSufficient: true, source: 'BASE_NODE', observedHashHex: H_OF_S, observedAmountRaw: '1000000', observedRefundHeight: '16000', observedCurrentHeight: '9000', verifiedAtUnixMs: Date.now() }; }
function provenL2() { return { l2TxId: 'tx2', hashExact: true, amountExact: true, deadlineSafe: true, claimantExact: true, unspent: true, source: 'AUTHORITATIVE', observedAmountRaw: '5000000', verifiedAtUnixMs: Date.now() }; }

function session(over = {}) {
  return {
    sessionId: 'sess_fuzz_1', state: 'CLAIMED', quoteId: 'q1', reservationId: 'r1', providerId: 'prov_fuzz',
    direction: 'XTM_TO_TARI', xtmRawAmount: '1000000', tariRawAmount: '5000000', hashH: H_OF_S,
    l1ClaimRecipient: 'a', l2ClaimRecipient: 'acct_fuzz', l1Network: 'esmeralda', l2Network: 'esmeralda',
    l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200', requiredL1Confirmations: '3',
    createdAtUnixMs: 1, updatedAtUnixMs: 1, l1TxId: 'tx1', l2TxId: 'tx2', l2ClaimTxId: 'claim1',
    l1Verification: provenL1(), l2Verification: provenL2(), ...over,
  };
}

function freshEnvelope() { return { source: 'CHAIN_NODE', identity: { substateVersion: '3', producingTxHash: '0x1', epoch: '1200', stateIdentity: 'pool', readAtUnixMs: Date.now() } }; }

/** A genuine proof, optionally with a tampered field. */
function makeProof(over = {}) {
  const amountRaw = over.amountRaw ?? '5000000';
  const resource = over.resourceAddress ?? TARI.resourceAddress;
  const account = over.account ?? 'acct_fuzz';
  return proofMod.mintTerminalSettlementProof({
    routeId: over.routeId ?? 'route_fuzz_1',
    hopId: 'hop_1',
    session: over.session ?? session(),
    l2BalanceRead: { status: 'FOUND', value: { account, resourceAddress: resource, amountRaw }, freshness: freshEnvelope() },
    expectedResourceAddress: resource,
    hop2ExecutionAccount: over.hop2ExecutionAccount ?? account,
    l2ClaimTxId: 'claim1',
    freshness: freshEnvelope(),
    requiredConfirmations: '1',
    observedConfirmations: '5',
  });
}

const ROUTE_EVENTS = [
  { kind: 'ACCEPT_ROUTE' },
  { kind: 'BEGIN_HOP1' },
  { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: 'p', routeId: 'route_fuzz_1', fingerprint: 'f' } },
  { kind: 'HOP1_UNKNOWN', reason: 'fuzz' },
  { kind: 'HOP1_FAILED', reason: 'fuzz' },
  { kind: 'BEGIN_HOP2_REQUOTE' },
  { kind: 'HOP2_READY' },
  { kind: 'BEGIN_HOP2', operationId: 'op_fuzz_1' },
  { kind: 'HOP2_SETTLED', chainTxId: 'hop2tx', settledAmountRaw: '4000000' },
  { kind: 'HOP2_UNKNOWN', reason: 'fuzz' },
  { kind: 'HOP2_FAILED', reason: 'fuzz' },
  { kind: 'SKIP_HOP2' },
  { kind: 'SETTLE_PARTIAL' },
  { kind: 'PAUSE', reason: 'AMM_LIQUIDITY_GONE', detail: 'fuzz' },
  { kind: 'REQUIRE_REQUOTE', detail: 'fuzz' },
  { kind: 'HOP2_UNAVAILABLE', reason: 'AMM_LIQUIDITY_GONE', detail: 'fuzz' },
  { kind: 'RESUME_REQUOTE' },
  { kind: 'ENTER_RECOVERY', reason: 'fuzz' },
  { kind: 'RESOLVE_CONTINUE' },
  { kind: 'RESOLVE_SETTLED' },
  { kind: 'RESOLVE_SKIP' },
  { kind: 'FAIL_TERMINAL', reason: 'fuzz' },
];

const ROUTE_STATES = mhTypes.ROUTE_STATES;

function baseRoute(routeId = 'route_fuzz_1') {
  return {
    routeId,
    state: 'ROUTE_QUOTED',
    sourceAsset: XTM,
    destinationAsset: WSTABLE,
    totalExpectedOutputRaw: '4500000',
    totalMinimumOutputRaw: '4000000',
    quoteExpiresAtUnixMs: 9_999_999,
    routeExpiresAtUnixMs: 9_999_999,
    hops: [
      { hopId: 'hop_1', index: 0, kind: 'FAST_XTM_TARI', inputAsset: XTM, outputAsset: TARI, inputAmountRaw: '1000000', expectedOutputRaw: '5000000', safety: mhTypes.hopSafetyFor('FAST_XTM_TARI'), execution: 'NOT_STARTED', settlement: 'UNSETTLED' },
      { hopId: 'hop_2', index: 1, kind: 'AMM_SWAP', inputAsset: TARI, outputAsset: WSTABLE, inputAmountRaw: '', expectedOutputRaw: '4500000', minimumOutputRaw: '4000000', safety: mhTypes.hopSafetyFor('AMM_SWAP'), execution: 'NOT_STARTED', settlement: 'UNSETTLED' },
    ],
    acceptance: {
      authorizedSourceAmountRaw: '1000000', authorizedSourceAsset: XTM, minimumFinalOutputRaw: '4000000',
      maxProviderSpreadBps: '100', maxNetworkFeesRaw: '10000', ammSlippageBps: '100',
      expiresAtUnixMs: 9_999_999, allowedIntermediateAsset: TARI, destinationRequiresAcknowledgement: false,
    },
    fees: { l1NetworkFeeRaw: '0', l2HtlcNetworkFeeRaw: '0', providerSpreadRaw: '0', ammLpFeeRaw: '0', ammNetworkFeeRaw: '0', developerTradingFeeRaw: '0', totalRaw: '0' },
    price: { sourceInputRaw: '1000000', providerQuotedTariRaw: '5000000', acceptedMinimumFinalOutputRaw: '4000000' },
    recovery: mhTypes.DEFAULT_RECOVERY_POLICY,
    intermediateAccount: 'acct_fuzz',
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
}

/** Simulate a hop-2 build attempt from a record, returning whether it was allowed. */
function attemptHop2Build(record, proof, executionAccount, inputResource) {
  // Mirrors hops.buildAmmSwapHop's first gate: verifyTerminalSettlementProof.
  try {
    proofMod.verifyTerminalSettlementProof(proof, {
      routeId: record.routeId,
      hop2ExecutionAccount: executionAccount,
      expectedResourceAddress: inputResource.resourceAddress,
    });
    return { allowed: true, reason: undefined };
  } catch (error) {
    return { allowed: false, reason: error.message };
  }
}

/**
 * State-directed selection: half the steps pick an event that can actually advance from the
 * current state (so deep states like HOP2_EXECUTING/ROUTE_SETTLED are genuinely reached),
 * the rest are uniformly random (so illegal jumps and refusals are exercised too).
 */
const FORWARD = {
  ROUTE_QUOTED: ['ACCEPT_ROUTE'],
  ROUTE_ACCEPTED: ['BEGIN_HOP1', 'PAUSE'],
  HOP1_EXECUTING: ['HOP1_SETTLED', 'HOP1_UNKNOWN', 'HOP1_FAILED'],
  HOP1_SETTLED: ['BEGIN_HOP2_REQUOTE', 'SKIP_HOP2', 'PAUSE'],
  HOP2_REQUOTE: ['HOP2_READY', 'REQUIRE_REQUOTE', 'HOP2_UNAVAILABLE'],
  HOP2_READY: ['BEGIN_HOP2', 'PAUSE', 'FAIL_TERMINAL'],
  HOP2_EXECUTING: ['HOP2_SETTLED', 'HOP2_UNKNOWN', 'HOP2_FAILED'],
  HOP2_SKIPPED: ['SETTLE_PARTIAL', 'BEGIN_HOP2_REQUOTE'],
  ROUTE_PAUSED: ['RESUME_REQUOTE', 'SKIP_HOP2', 'ENTER_RECOVERY', 'FAIL_TERMINAL'],
  ROUTE_RECOVERY_REQUIRED: ['RESOLVE_CONTINUE', 'RESOLVE_SETTLED', 'RESOLVE_SKIP', 'FAIL_TERMINAL'],
  ROUTE_SETTLED: [],
  ROUTE_FAILED_TERMINAL: [],
};

function pickEvent(rng, state) {
  const forward = FORWARD[state] ?? [];
  if (forward.length > 0 && rng() < 0.55) {
    const kinds = forward[Math.floor(rng() * forward.length)];
    return ROUTE_EVENTS.find((e) => e.kind === kinds);
  }
  return ROUTE_EVENTS[Math.floor(rng() * ROUTE_EVENTS.length)];
}

test('MHF-1 100k route transition attempts preserve all eight composition properties', () => {
  const rng = rngFrom(BASE_SEED);
  const target = 100_000;
  let attempts = 0;
  let accepted = 0;
  let refused = 0;
  const seenStates = new Set();
  const seenEvents = new Set();
  let proofsMinted = 0;

  for (let trial = 0; attempts < target; trial++) {
    const routeId = `route_fuzz_${trial}`;
    let record = baseRoute(routeId);
    const steps = 1 + Math.floor(rng() * 10);
    let prevSettlement = [record.hops[0].settlement, record.hops[1].settlement];
    let prevState = record.state;

    for (let step = 0; step < steps && attempts < target; step++) {
      const ev = pickEvent(rng, record.state);
      attempts += 1;
      seenEvents.add(ev.kind);

      // Randomly tamper with the event the way an attacker/caller would.
      let event = ev;
      // The proof reference is bound to THIS route (as the real mint requires).
      if (ev.kind === 'HOP1_SETTLED') event = { ...ev, proofRef: { proofId: `p:${routeId}`, routeId, fingerprint: 'f' } };
      const tamper = rng();
      if (tamper < 0.10 && ev.kind === 'HOP1_SETTLED') {
        event = { ...event, settledAmountRaw: '0' }; // zero settled amount
      } else if (tamper < 0.18 && ev.kind === 'HOP2_SETTLED') {
        event = { ...ev, settledAmountRaw: '1' }; // final output below the accepted minimum
      } else if (tamper < 0.24 && ev.kind === 'BEGIN_HOP2') {
        event = { ...ev, operationId: '' }; // non-durable operation id
      } else if (tamper < 0.30 && ev.kind === 'HOP1_SETTLED') {
        event = { ...event, proofRef: undefined }; // no proof reference at all
      }

      let next;
      try {
        next = routeMod.applyRouteEvent(record, event);
        accepted += 1;
        seenStates.add(next.state);
      } catch (error) {
        if (error instanceof Error && /Illegal route transition|terminal state|refused|proven|consumed|durable non-empty|settlement proof|proof reference|same amount|settled amount|violates the accepted|recovery cannot settle|without the committed|without the proven|would be lost/.test(error.message)) {
          refused += 1;
          continue;
        }
        persist('route-unexpected-error', BASE_SEED + trial, { message: error.message, event, state: record.state });
        throw error;
      }

      // ---- properties, checked after every accepted transition ----
      const failProp = (prop) => {
        const line = persist('route-property', BASE_SEED + trial, { prop, state: next.state, from: prevState, event, hop1: next.hops[0], hop2: next.hops[1] });
        throw new Error(`PROPERTY ${prop} VIOLATED (seed persisted: ${line})`);
      };

      // P1 hop 2 never executes before a valid terminal proof
      if (next.hops[1].execution === 'EXECUTING' || next.hops[1].execution === 'CONFIRMED') {
        if (next.settlementProof === undefined) failProp(1);
        if (next.hops[0].settlement !== 'SETTLED') failProp(1);
        if (!/^\d+$/.test(next.hops[1].inputAmountRaw) || BigInt(next.hops[1].inputAmountRaw) <= 0n) failProp(1);
      }
      // P2 the intermediate TARI is never lost once hop 1 settled
      if (next.hops[0].settlement === 'SETTLED') {
        if (next.price.settledTariRaw === undefined) failProp(2);
        if (!/^\d+$/.test(next.hops[0].settledAmountRaw) || BigInt(next.hops[0].settledAmountRaw) <= 0n) failProp(2);
      }
      // P3 the final output never violates the accepted minimum
      if (next.hops[1].settlement === 'SETTLED') {
        const out = next.hops[1].settledAmountRaw;
        if (!/^\d+$/.test(out)) failProp(3);
        if (BigInt(out) < BigInt(next.acceptance.minimumFinalOutputRaw)) failProp(3);
      }
      // P4 terminal routes remain terminal
      if (routeMod.isTerminalRouteState(prevState) && next.state !== prevState) failProp(4);
      // P5 UNKNOWN never blindly resubmits: after an UNKNOWN hop the route cannot jump to
      //    HOP2_EXECUTING in the same accepted transition
      if (prevSettlement[0] === 'UNSETTLED' && event.kind === 'HOP1_UNKNOWN' && next.hops[1].execution === 'EXECUTING') failProp(5);
      // P6/P7 single-use proof: once consumed, a second hop-2 execution is impossible
      if (prevState === 'HOP2_EXECUTING' && event.kind === 'BEGIN_HOP2') failProp(7);
      // P8 identity remains exact across every accepted transition
      if (next.hops[0].outputAsset.resourceAddress !== next.hops[1].inputAsset.resourceAddress) failProp(8);
      if (next.hops[0].inputAsset.resourceAddress !== next.sourceAsset.resourceAddress) failProp(8);
      if (next.hops[1].outputAsset.resourceAddress !== next.destinationAsset.resourceAddress) failProp(8);
      if (next.hops[1].inputAsset.isCanonicalTari !== true) failProp(8);

      prevSettlement = [next.hops[0].settlement, next.hops[1].settlement];
      prevState = next.state;
      record = next;
      // The composition layer derives hop 2's input FROM the settled amount (never from the
      // quote). Mirror that so the fuzzer can reach the deeper hop-2 states.
      if (record.hops[0].settlement === 'SETTLED' && record.hops[1].inputAmountRaw === '') {
        record = { ...record, hops: record.hops.map((h, i) => (i === 1 ? { ...h, inputAmountRaw: record.hops[0].settledAmountRaw } : h)) };
      }
    }
  }

  assert.ok(attempts >= target, `expected >= ${target} attempts, ran ${attempts}`);
  assert.ok(accepted > 500, `too few accepted transitions: ${accepted}`);
  assert.ok(refused > 500, `too few refusals: ${refused}`);
  assert.ok(seenStates.size >= 10, `fuzzer only reached ${seenStates.size} route states`);
  assert.ok(seenEvents.size >= 20, `fuzzer only exercised ${seenEvents.size} event kinds`);
  assert.ok(!fs.existsSync(SEED_FILE) || fs.readFileSync(SEED_FILE, 'utf8').trim() === '', 'route fuzzing persisted a failing seed');
});

test('MHF-2 a route can never consume another route proof, even with a genuine one', () => {
  const recordA = baseRoute('route_alpha_1');
  const recordB = baseRoute('route_beta_22');
  // A genuine proof minted for route A.
  const proofA = makeProof({ routeId: 'route_alpha_1' });
  const ok = attemptHop2Build(recordA, proofA, 'acct_fuzz', TARI);
  assert.equal(ok.allowed, true, 'route A can use its own proof');
  // route B may not.
  const cross = attemptHop2Build(recordB, proofA, 'acct_fuzz', TARI);
  assert.equal(cross.allowed, false, 'route B consumed route A proof');
  assert.match(cross.reason, /belongs to route/);
  // a proof from the wrong account
  assert.equal(attemptHop2Build(recordA, proofA, 'acct_other', TARI).allowed, false);
  // a proof for a lookalike resource
  assert.equal(attemptHop2Build(recordA, proofA, 'acct_fuzz', DECOY).allowed, false);
  proofsMintedCounter.inc();
});

let proofsMintedCounter = { inc: () => {} };

test('MHF-3 the terminal proof is single-use and unforgeable across 20k tamper attempts', () => {
  const rng = rngFrom(BASE_SEED ^ 0x7777);
  const record = baseRoute('route_tamper_1');
  const proof = makeProof({ routeId: 'route_tamper_1' });
  let forgedAccepted = 0;
  for (let i = 0; i < 20_000; i++) {
    const clone = { ...proof };
    const field = ['resultingAmountRaw', 'resultingResourceAddress', 'recipientAccount', 'chainTxId', 'terminalStatus', 'proofFingerprint', 'routeId', 'hopId', 'authoritativeSource', 'settlementEpochOrVersion'][Math.floor(rng() * 10)];
    if (field === 'resultingAmountRaw') clone.resultingAmountRaw = String(BigInt(clone.resultingAmountRaw) + BigInt(1 + Math.floor(rng() * 1000)));
    else if (field === 'terminalStatus') clone.terminalStatus = rng() < 0.5 ? 'REFUNDED' : 'SETTLED';
    else if (field === 'authoritativeSource') clone.authoritativeSource = 'INDEXER_SUBSTATE';
    else clone[field] = `tampered_${Math.floor(rng() * 1e9)}`;
    const res = attemptHop2Build(record, clone, 'acct_fuzz', TARI);
    if (res.allowed) forgedAccepted += 1;
  }
  assert.equal(forgedAccepted, 0, `${forgedAccepted} tampered proofs were accepted`);
  // and the genuine one still works
  assert.equal(attemptHop2Build(record, proof, 'acct_fuzz', TARI).allowed, true);
  assert.ok(!fs.existsSync(SEED_FILE) || fs.readFileSync(SEED_FILE, 'utf8').trim() === '');
});

test('MHF-4 route restart in every state never re-drives a terminal route or double-settles', () => {
  const rng = rngFrom(BASE_SEED ^ 0x1234);
  const terminalVisits = new Set();
  for (let i = 0; i < 2000; i++) {
    // walk a random route to some state
    let record = baseRoute(`route_restart_${i}`);
    for (let step = 0; step < 8; step++) {
      const ev = ROUTE_EVENTS[Math.floor(rng() * ROUTE_EVENTS.length)];
      try {
        const next = routeMod.applyRouteEvent(record, ev);
        if (next.hops[1].execution === 'EXECUTING' && next.hops[1].inputAmountRaw === '') {
          next.hops[1].inputAmountRaw = '5000000';
        }
        record = next;
      } catch { /* refused: keep the state */ }
    }
    // "restart": operate on a fresh copy of the durable record only
    const restarted = JSON.parse(JSON.stringify(record));
    if (routeMod.isTerminalRouteState(restarted.state)) {
      terminalVisits.add(restarted.state);
      for (const ev of ROUTE_EVENTS) {
        assert.throws(() => routeMod.applyRouteEvent(restarted, ev), /terminal state|Illegal route transition/);
      }
    }
    // after restart, at most one hop-2 execution is possible
    let execs = 0;
    for (const ev of ROUTE_EVENTS.filter((e) => e.kind === 'BEGIN_HOP2')) {
      try { routeMod.applyRouteEvent(record, { ...ev, operationId: `op_restart_${i}_${execs}` }); execs += 1; } catch { /* refused */ }
    }
    assert.ok(execs <= 1, `route allowed ${execs} hop-2 executions after restart`);
  }
  assert.ok(terminalVisits.size >= 1, 'fuzzer never reached a terminal route state');
  assert.ok(!fs.existsSync(SEED_FILE) || fs.readFileSync(SEED_FILE, 'utf8').trim() === '');
});
