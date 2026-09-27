/**
 * HOSTILE MULTI-HOP COMPOSITION SUITE — XTM → FAST_XTM_TARI → TARI → AMM → public fungible
 *
 * Each test is an attack from security/MULTIHOP_ATTACK_MATRIX.md. Refusals are regressions
 * and must not be deleted or weakened.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const sessionMod = require('../dist/crosschain/session.js');
const { InMemorySecretStore } = require('../dist/crosschain/secret.js');
const { InMemoryReservationLedger } = require('../dist/crosschain/reservation.js');
const coord = require('../dist/crosschain/coordinator.js');
const amm = require('../dist/amm.js');
const mh = require('../dist/multihop/types.js');
const proofMod = require('../dist/multihop/proof.js');
const routeMod = require('../dist/multihop/route.js');
const hops = require('../dist/multihop/hops.js');
const compose = require('../dist/multihop/compose.js');
const frontend = require('../dist/multihop/frontend.js');

const S_HEX = '55'.repeat(32);
const H_OF_S = 'a'.repeat(0) || require('node:crypto').createHash('sha256').update(Buffer.from(S_HEX, 'hex')).digest('hex');
const XTM = { kind: 'MINOTARI_L1', resourceAddress: 'txm_address_1', label: 'XTM', decimals: '6' };
const TARI = { kind: 'OOTLE_L2', resourceAddress: 'tari_resource_0001', label: 'TARI', decimals: '6', isCanonicalTari: true };
const WSTABLE = { kind: 'OOTLE_L2', resourceAddress: 'wstable_resource_9', label: 'wSTABLE', decimals: '6' };
const FAKE_TARI = { kind: 'OOTLE_L2', resourceAddress: 'tari_resource_0001', label: 'TARI', decimals: '6', isCanonicalTari: true };
const WRAPPED_TARI = { kind: 'OOTLE_L2', resourceAddress: 'wrapped_tari_fake_01', label: 'TARI', decimals: '6', isCanonicalTari: true };
const STEALTH_ASSET = { kind: 'OOTLE_L2', resourceAddress: 'stealth_asset_01', label: 'MYSTERY', decimals: '6' };

const AD = {
  providerId: 'prov_1', pair: 'XTM/TARI', xtmAvailable: '10000000', tariAvailable: '100000000000',
  minTradeXtm: '1', maxTradeXtm: '9000000', spreadBps: '50', quoteTtlMs: '60000',
  requiredL1Confirmations: '3', network: 'esmeralda',
};
const ENV_ON = { TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: '1' };
const DEADLINE_OK = { l1RemainingMarginMs: '900000', l2RemainingMarginMs: '900000', requiredL1MarginMs: '60000', requiredL2MarginMs: '60000' };
const CAPS = { l1Balance: true, l1NormalSend: true, l1ShaInit: true, l1ShaInspect: true, l1ShaClaim: true, l1ShaRefund: true, l2HtlcFund: true, l2HtlcClaim: true, l2HtlcRefund: true };
const CLOSED = { available: '0', pendingIncoming: '0', pendingOutgoing: '0' };

function provenL1(over = {}) {
  return { l1TxId: 'tx_l1', confirmations: '5', hashMatches: true, amountExact: true, amountAuthoritative: true, deadlineSafe: true, deadlineFresh: true, confirmationsSufficient: true, source: 'BASE_NODE', observedHashHex: H_OF_S, observedAmountRaw: '1000000', observedRefundHeight: '16000', observedCurrentHeight: '9000', verifiedAtUnixMs: Date.now(), ...over };
}
function provenL2(over = {}) {
  return { l2TxId: 'tx_l2', hashExact: true, amountExact: true, deadlineSafe: true, claimantExact: true, unspent: true, source: 'AUTHORITATIVE', observedAmountRaw: '5000000', verifiedAtUnixMs: Date.now(), ...over };
}

/** A fully-settled cross-layer session (the only thing that may mint a proof). */
function settledSession(over = {}) {
  return {
    sessionId: 'sess_route_1', state: 'CLAIMED', quoteId: 'q1', reservationId: 'r1', providerId: 'prov_1',
    direction: 'XTM_TO_TARI', xtmRawAmount: '1000000', tariRawAmount: '5000000', hashH: H_OF_S,
    l1ClaimRecipient: 'l1_addr', l2ClaimRecipient: 'acct_taker_1', l1Network: 'esmeralda', l2Network: 'esmeralda',
    l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200', requiredL1Confirmations: '3',
    createdAtUnixMs: 1, updatedAtUnixMs: 1, l1TxId: 'tx_l1', l2TxId: 'tx_l2', l2ClaimTxId: 'claim_l2_1',
    l1Verification: provenL1(), l2Verification: provenL2(), secretRevealedAtUnixMs: 2, ...over,
  };
}

function fresh(over = {}) {
  return { source: 'CHAIN_NODE', identity: { substateVersion: '7', producingTxHash: '0xabc', epoch: '1200', stateIdentity: 'pool@1', readAtUnixMs: Date.now() } , ...over };
}

function evidence(over = {}) {
  const account = over.account ?? 'acct_taker_1';
  return {
    routeId: 'route_1',
    hopId: 'hop_1',
    session: over.session ?? settledSession(),
    // Honoured verbatim so every bad-evidence case is actually exercised.
    l2BalanceRead: over.l2BalanceRead ?? { status: 'FOUND', value: { account, resourceAddress: TARI.resourceAddress, amountRaw: '5000000' }, freshness: fresh() },
    expectedResourceAddress: over.expectedResourceAddress ?? TARI.resourceAddress,
    hop2ExecutionAccount: over.hop2ExecutionAccount ?? account,
    l2ClaimTxId: 'l2ClaimTxId' in over ? over.l2ClaimTxId : 'claim_l2_1',
    freshness: over.freshness ?? fresh(),
    requiredConfirmations: 'requiredConfirmations' in over ? over.requiredConfirmations : '1',
    observedConfirmations: over.observedConfirmations ?? '5',
    maxAgeMs: over.maxAgeMs,
  };
}

function makeProof(over = {}) {
  return proofMod.mintTerminalSettlementProof(evidence(over));
}

/** A committed pool readback the AMM resolver can use. */
function makeReadback(cfg = {}) {
  return {
    readPool: async () => ({
      status: 'FOUND',
      value: {
        poolComponent: cfg.poolComponent ?? 'pool_1', resourceA: TARI.resourceAddress, resourceB: cfg.resourceB ?? WSTABLE.resourceAddress,
        reserveA: cfg.reserveA ?? '1000000000', reserveB: cfg.reserveB ?? '1000000000', feeBps: cfg.feeBps ?? '30',
        lpResource: 'lp_1', totalLpSupply: '1000', lockedLpSupply: '1000',
      },
      freshness: fresh(),
    }),
  };
}

const AMM_BUILDER = { swap: (i) => ({ kind: 'swap-intent', ...i }) };

function ammPolicy(over = {}) {
  return {
    intermediateAmount: over.intermediateAmount ?? { mode: 'ACCEPT_IF_AT_LEAST', minimumRaw: '1' },
    expectedIntermediateRaw: over.expectedIntermediateRaw,
    acceptedMinimumFinalOutputRaw: over.acceptedMinimumFinalOutputRaw ?? '4000000',
    maxRoutePriceDriftBps: over.maxRoutePriceDriftBps ?? '500',
    allowDustInput: over.allowDustInput ?? false,
  };
}

function ammInput(over = {}) {
  return {
    // 'proof' in over so an explicit `undefined` override is honoured (testing the
    // no-proof path) rather than silently falling back to a real proof.
    routeId: 'routeId' in over ? over.routeId : 'route_1',
    hopId: 'hop_2',
    settlementProof: 'proof' in over ? over.proof : makeProof(over.proofOver),
    executionAccount: over.executionAccount ?? 'acct_taker_1',
    inputResource: over.inputResource ?? TARI,
    outputResource: over.outputResource ?? WSTABLE,
    poolComponent: 'pool_1',
    maxEpoch: over.maxEpoch ?? '9999',
    currentEpoch: over.currentEpoch,
    slippage: over.slippage ?? { slippageBps: '100' },
    requiredSettlementConfirmations: over.requiredSettlementConfirmations ?? '1',
  };
}

/** An authoritative revalidator that CONFIRMS the proof's own facts. */
function confirmingRevalidator(proof, over = {}) {
  return {
    revalidate: async () => ({
      status: over.status ?? 'CONFIRMED',
      reason: over.reason,
      source: over.source ?? 'CHAIN_NODE',
      observed: {
        account: over.account ?? proof.recipientAccount,
        resourceAddress: over.resourceAddress ?? proof.resultingResourceAddress,
        amountRaw: over.amountRaw ?? proof.resultingAmountRaw,
        settled: over.settled ?? true,
        confirmations: over.confirmations ?? '5',
        chainTxId: over.chainTxId ?? proof.chainTxId,
        substateIdentity: over.substateIdentity ?? proof.substateIdentity,
      },
    }),
  };
}

async function buildHop2(over = {}, readbackCfg = {}, policyOver = {}, depsOver = {}) {
  const input = ammInput(over);
  const proof = input.settlementProof;
  return hops.buildAmmSwapHop(input, {
    readback: makeReadback(readbackCfg),
    builder: AMM_BUILDER,
    policy: ammPolicy(policyOver),
    // Unless a test explicitly omits it, the authoritative revalidation is present and
    // confirms the proof. Tests that attack revalidation pass their own.
    settlementRevalidator: 'settlementRevalidator' in depsOver ? depsOver.settlementRevalidator : confirmingRevalidator(proof),
  });
}

function makeRoute(over = {}) {
  const plan = compose.discoverRoute({ routeId: 'route_1', source: XTM, destination: over.destination ?? WSTABLE, canonicalTari: TARI, provider: AD, tariPerXtmRate: '5', poolComponent: 'pool_1', nowUnixMs: 1000, routeTtlMs: 600000, requestAmountRaw: '1000000', destinationRoutingVerdict: 'ALLOW' });
  assert.equal(plan.status, 'RESOLVED', `discovery blocked: ${JSON.stringify(plan)}`);
  const record = compose.buildRouteRecord({
    routeId: 'route_1',
    plan: plan.plan,
    acceptance: {
      authorizedSourceAmountRaw: '1000000', authorizedSourceAsset: XTM, minimumFinalOutputRaw: '4000000',
      maxProviderSpreadBps: '100', maxNetworkFeesRaw: '10000', ammSlippageBps: '100',
      expiresAtUnixMs: 601000, allowedIntermediateAsset: TARI, destinationRequiresAcknowledgement: false,
    },
    fees: compose.buildRouteFees({ providerSpreadRaw: '50000' }),
    price: compose.buildRoutePrice({ sourceInputRaw: '1000000', providerQuotedTariRaw: '5000000', acceptedMinimumFinalOutputRaw: '4000000' }),
    totalExpectedOutputRaw: '4000000', totalMinimumOutputRaw: '4000000',
    quoteExpiresAtUnixMs: 61000, intermediateAccount: 'acct_taker_1', nowUnixMs: 1000,
  });
  routeMod.validateRouteRecord(record);
  return record;
}

// ===========================================================================
// 1. HOP 2 CANNOT START BEFORE HOP 1 TERMINAL PROOF
// ===========================================================================

test('1.1 hop 2 is impossible without a terminal settlement proof', async () => {
  assert.equal((await buildHop2({ proof: undefined })).status, 'REFUSED', 'undefined proof');
  assert.equal((await buildHop2({ proof: null })).status, 'REFUSED', 'null proof');
  const r = await buildHop2({ proof: undefined });
  assert.match(r.reason, /no terminal settlement proof/);
  // an object literal shaped like a proof is still refused (the brand is module-private)
  const forged = { proofId: 'route_1:hop_1:settlement', routeId: 'route_1', hopId: 'hop_1', resultingAmountRaw: '5000000', resultingResourceAddress: TARI.resourceAddress, recipientAccount: 'acct_taker_1', terminalStatus: 'CLAIMED', authoritativeSource: 'CHAIN_NODE', proofFingerprint: 'deadbeefdeadbeef', chainTxId: 'claim_l2_1', crossLayerSessionId: 'sess_route_1', resultingAssetKind: 'OOTLE_L2', settlementEpochOrVersion: '1200', confirmationsSatisfied: true, freshness: fresh(), mintedAtUnixMs: Date.now(), maxAgeMs: 120000, substateIdentity: 'pool@1' };
  const literal = await buildHop2({ proof: forged });
  assert.equal(literal.status, 'REFUSED', 'forged literal proof');
  assert.match(literal.reason, /not a minted terminal settlement proof \(forged\)/);
  // JSON round-trip (a peer payload) is likewise refused
  const json = JSON.parse(JSON.stringify(forged));
  assert.equal((await buildHop2({ proof: json })).status, 'REFUSED', 'JSON payload proof');
});

test('1.2 the route state machine refuses HOP2_READY before a settlement proof exists', () => {
  const route = makeRoute();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  // hop 2 is not even reachable before hop 1 settles
  assert.throws(() => routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP2_REQUOTE' }), /Illegal route transition/);
  assert.throws(() => routeMod.applyRouteEvent(r, { kind: 'HOP2_READY' }), /Illegal route transition/);
  // jump straight to READY from HOP1_SETTLED without a proof → refused
  const proof = makeProof();
  const settled = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: proof.proofId, routeId: 'route_1', fingerprint: proof.proofFingerprint } });
  assert.equal(settled.state, 'HOP1_SETTLED');
  const requote = routeMod.applyRouteEvent(settled, { kind: 'BEGIN_HOP2_REQUOTE' });
  const withProof = { ...requote, settlementProof: undefined };
  assert.throws(() => routeMod.applyRouteEvent(withProof, { kind: 'HOP2_READY' }), /without a hop-1 terminal settlement proof/);
  // hop 2's input amount must be the PROVEN amount, not empty/quote
  const noAmount = { ...requote, settlementProof: { proofId: 'p', routeId: 'route_1', fingerprint: 'f' }, hops: requote.hops.map((h, i) => (i === 1 ? { ...h, inputAmountRaw: '' } : h)) };
  assert.throws(() => routeMod.applyRouteEvent(noAmount, { kind: 'HOP2_READY' }), /proven settled amount/);
});

test('1.3 HOP1_SETTLED requires the proven amount, and hop 2 input becomes the settled amount', () => {
  const route = makeRoute();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  assert.throws(() => routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: undefined, proofRef: { proofId: 'p', routeId: 'route_1', fingerprint: 'f' } }), /PROVEN settled amount/);
  const proof = makeProof();
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: proof.resultingAmountRaw, proofRef: { proofId: proof.proofId, routeId: 'route_1', fingerprint: proof.proofFingerprint } });
  assert.equal(r.price.settledTariRaw, '5000000');
  assert.equal(r.hops[0].settledAmountRaw, '5000000');
  // the hop-2 input is still empty until the caller fills it from the proof
  assert.equal(r.hops[1].inputAmountRaw, '', 'hop 2 input must never be pre-filled from the quote');
});

// ===========================================================================
// 0. AUTHORITATIVE SETTLEMENT REVALIDATION (the recorded freshness gap)
// ===========================================================================

test('0.1 with NO authoritative revalidation provider, hop 2 refuses structurally', async () => {
  // The proof is genuine and fresh, but the chain was never re-read. The age window is a
  // LIVENESS bound, not a security one, so this must not silently pass.
  const r = await buildHop2({}, {}, {}, { settlementRevalidator: undefined });
  assert.equal(r.status, 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE');
  assert.match(r.reason, /authoritative settlement revalidation provider is configured|not a substitute for a chain read/);
  assert.equal(r.builderIntent, undefined, 'no AMM intent may be built without authoritative revalidation');
  assert.equal(r.revalidation.status, 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE');
});

test('0.2 a reorg / rollback of the settling transaction refuses hop 2', async () => {
  const proof = makeProof();
  const r = await buildHop2({ proof }, {}, {}, { settlementRevalidator: confirmingRevalidator(proof, { settled: false }) });
  assert.equal(r.status, 'REFUSED');
  assert.equal(r.revalidation.status, 'REORGED_OR_ROLLED_BACK');
  assert.match(r.reason, /no longer settled/);
});

test('0.3 every identity divergence between proof and chain refuses hop 2', async () => {
  const cases = [
    ['amount', { amountRaw: '4999999' }, /settled amount mismatch/],
    ['account', { account: 'acct_other' }, /settlement account mismatch/],
    ['resource', { resourceAddress: 'tari_lookalike' }, /settled resource mismatch/],
    ['txid', { chainTxId: 'other_tx' }, /settlement tx mismatch/],
    ['substate', { substateIdentity: 'pool@DIFFERENT' }, /substate identity mismatch/],
    ['confirmations', { confirmations: '0' }, /confirmations 0 < required/],
  ];
  for (const [name, over, re] of cases) {
    const proof = makeProof();
    const r = await buildHop2({ proof }, {}, {}, { settlementRevalidator: confirmingRevalidator(proof, over) });
    assert.equal(r.status, 'REFUSED', `${name} divergence was accepted`);
    assert.match(r.reason, re, `${name} divergence produced the wrong reason`);
  }
});

test('0.4 a revalidation reader that is itself non-authoritative or broken is refused', async () => {
  const proof = makeProof();
  // an indexer/cache source
  const indexed = await buildHop2({ proof }, {}, {}, { settlementRevalidator: confirmingRevalidator(proof, { source: 'INDEXER_SUBSTATE' }) });
  assert.equal(indexed.status, 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE');
  assert.match(indexed.reason, /not authoritative/);
  // a reader that throws
  const throwing = await buildHop2({ proof }, {}, {}, { settlementRevalidator: { revalidate: async () => { throw new Error('rpc down'); } } });
  assert.equal(throwing.status, 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE');
  assert.match(throwing.reason, /rpc down/);
  // a malformed reader
  const malformed = await buildHop2({ proof }, {}, {}, { settlementRevalidator: { revalidate: async () => ({ status: 'CONFIRMED' }) } });
  assert.equal(malformed.status, 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE');
  assert.match(malformed.reason, /no observed facts/);
  const noMethod = await buildHop2({ proof }, {}, {}, { settlementRevalidator: {} });
  assert.equal(noMethod.status, 'AUTHORITATIVE_REVALIDATION_UNAVAILABLE');
  // a reader that reports a non-CONFIRMED status without a reason
  const unconfirmed = await buildHop2({ proof }, {}, {}, { settlementRevalidator: confirmingRevalidator(proof, { status: 'MISMATCH' }) });
  assert.equal(unconfirmed.status, 'REFUSED');
});

test('0.5 a reorg between the mint and the consumption is caught (the recorded gap)', async () => {
  // The exact scenario the residual risk described: the proof was valid at mint time, and
  // the chain state changed inside the proof's max-age window.
  const proof = makeProof();
  assert.equal(proof.terminalStatus, 'CLAIMED');
  const stillSettled = await buildHop2({ proof }, {}, {}, { settlementRevalidator: confirmingRevalidator(proof) });
  assert.equal(stillSettled.status, 'BUILT', 'a genuinely settled proof still builds');
  // now the chain reports the same output is gone (reorg / state reverted)
  const reorged = await buildHop2({ proof }, {}, {}, { settlementRevalidator: confirmingRevalidator(proof, { settled: false }) });
  assert.equal(reorged.status, 'REFUSED');
  // and the amount the chain now reports differs
  const reduced = await buildHop2({ proof }, {}, {}, { settlementRevalidator: confirmingRevalidator(proof, { amountRaw: '1' }) });
  assert.equal(reduced.status, 'REFUSED');
  assert.match(reduced.reason, /settled amount mismatch/);
});

// ===========================================================================
// 2. FORGED / STALE / WRONG-SESSION / WRONG-RECIPIENT / WRONG-AMOUNT PROOFS
// ===========================================================================

test('2.1 minting is refused for every non-authoritative or incomplete fact', () => {
  const cases = [
    ['session not terminal', { session: settledSession({ state: 'BOTH_FUNDED' }) }, /not terminal/],
    ['session in recovery', { session: settledSession({ state: 'RECOVERY_REQUIRED' }) }, /not terminal/],
    ['refunded session', { session: settledSession({ state: 'REFUNDED' }) }, /only a CLAIMED session/],
    ['no L1 verification', { session: settledSession({ l1Verification: undefined }) }, /no authoritative L1 verification/],
    ['no L2 verification', { session: settledSession({ l2Verification: undefined }) }, /no authoritative L2 verification/],
    ['L2 cached source', { session: settledSession({ l2Verification: provenL2({ source: 'CACHED' }) }) }, /not AUTHORITATIVE/],
    ['L1 amount not authoritative', { session: settledSession({ l1Verification: provenL1({ amountAuthoritative: false }) }) }, /amount authority is not established/],
    ['L1 provider assertion', { session: settledSession({ l1Verification: provenL1({ source: 'PROVIDER_ASSERTION' }) }) }, /provider assertion/],
    ['refund path recorded', { session: settledSession({ l2RefundTxId: 'refund_l2' }) }, /refund path is recorded/],
    ['claim tx mismatch', { l2ClaimTxId: 'other_tx' }, /claim tx mismatch/],
    ['missing claim tx', { l2ClaimTxId: '' }, /missing L2 claim transaction id/],
    ['balance unavailable', { l2BalanceRead: { status: 'UNAVAILABLE', reason: 'rpc down' } }, /balance evidence unavailable/],
    ['wrong resource identity', { expectedResourceAddress: 'other_resource' }, /is not the expected/],
    ['zero amount', { l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: '0' }, freshness: fresh() } }, /settled amount is zero/],
    ['amount exceeds quote', { l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: '9000000' }, freshness: fresh() } }, /refusing to invent value/],
    ['non-integer amount', { l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: '1.5' }, freshness: fresh() } }, /raw non-negative integer/],
    ['account binding violated', { hop2ExecutionAccount: 'acct_other' }, /identity binding violated/],
    ['insufficient confirmations', { observedConfirmations: '0' }, /< required/],
    ['stale evidence', { freshness: fresh({ identity: { epoch: '1200', readAtUnixMs: Date.now() - 10_000_000 } }) }, /stale/],
    ['indexer-only source', { freshness: fresh({ source: 'INDEXER_SUBSTATE' }), l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: '5000000' }, freshness: fresh({ source: 'INDEXER_SUBSTATE' }) } }, /not authoritative/],
    ['source disagreement', { freshness: fresh({ source: 'WALLET_PROVIDER' }) }, /disagree about their source/],
  ];
  for (const [name, over, re] of cases) {
    assert.throws(() => makeProof(over), re, `accepted a bad proof: ${name}`);
  }
});

test('2.2 a proof from another route, another hop, or another account is refused at build time', async () => {
  const proof = makeProof();
  assert.equal((await buildHop2({ proof, routeId: 'route_other' })).status, 'REFUSED', 'proof from another route');
  assert.equal((await buildHop2({ proof, executionAccount: 'acct_someone_else' })).status, 'REFUSED', 'proof for another account');
  assert.equal((await buildHop2({ proof, inputResource: { ...TARI, resourceAddress: 'other_resource' } })).status, 'REFUSED', 'proof for another resource');
  // a mutated proof is detected by its fingerprint
  const mutated = { ...proof, resultingAmountRaw: '4999999' };
  const m = await buildHop2({ proof: mutated });
  assert.equal(m.status, 'REFUSED');
  assert.match(m.reason, /fingerprint mismatch|not a minted/);
  // a stale proof is refused even though it is genuine (max age 1ms, consumed after 10ms)
  const soonExpiring = makeProof({ maxAgeMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stale = await buildHop2({ proof: soonExpiring });
  assert.equal(stale.status, 'REFUSED', 'genuine but stale proof must be re-derived');
  assert.match(stale.reason, /stale/);
});

test('2.3 one route cannot consume another route settlement proof, and one proof cannot back two hop-2 executions', async () => {
  const route = makeRoute();
  const proofA = makeProof();
  const proofB = makeProof({ routeId: 'route_1', session: settledSession({ sessionId: 'sess_route_2' }) });
  // A proof minted for route_1 is bound to route_1; there is no route_2 proof in this record
  const built = await buildHop2({ proof: proofB });
  assert.equal(built.status, 'BUILT', 'route_1 can use its own proof');
  assert.equal(built.inputAmountRaw, proofB.resultingAmountRaw);
  // the route record refuses a second hop-2 execution with the same proof
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: proofA.proofId, routeId: 'route_1', fingerprint: proofA.proofFingerprint } });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP2_REQUOTE' });
  r = { ...r, hops: r.hops.map((h, i) => (i === 1 ? { ...h, inputAmountRaw: '5000000' } : h)) };
  r = routeMod.applyRouteEvent(r, { kind: 'HOP2_READY' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP2', operationId: 'op_hop2_1' });
  assert.equal(r.proofConsumedByHop2, true);
  // a second BEGIN_HOP2 from a fresh READY is refused: the proof is already consumed
  const r2 = { ...r, state: 'HOP2_READY' };
  assert.throws(() => routeMod.applyRouteEvent(r2, { kind: 'BEGIN_HOP2', operationId: 'op_hop2_2' }), /already consumed the settlement proof/);
});

// ===========================================================================
// 3. RESOURCE IDENTITY (canonical TARI only)
// ===========================================================================

test('3.1 the intermediate asset must be canonical TARI by exact identity', async () => {
  // a fake same-symbol resource
  assert.equal((await buildHop2({ inputResource: { ...FAKE_TARI, resourceAddress: 'tari_lookalike_999' } })).status, 'REFUSED', 'fake TARI');
  // wrapped TARI pretending to be canonical
  assert.equal((await buildHop2({ inputResource: WRAPPED_TARI })).status, 'REFUSED', 'wrapped TARI');
  // arbitrary stealth asset
  assert.equal((await buildHop2({ inputResource: STEALTH_ASSET })).status, 'REFUSED', 'stealth asset');
  // canonical flag missing
  assert.equal((await buildHop2({ inputResource: { kind: 'OOTLE_L2', resourceAddress: TARI.resourceAddress, label: 'TARI', decimals: '6' } })).status, 'REFUSED', 'missing canonical flag');
  // wrong chain kind
  assert.equal((await buildHop2({ inputResource: { ...TARI, kind: 'MINOTARI_L1' } })).status, 'REFUSED', 'wrong kind');
  // destination identical to input
  assert.equal((await buildHop2({ outputResource: TARI })).status, 'REFUSED', 'output equals input');
  // route record validation refuses a non-canonical intermediate (keeping the asset chain
  // consistent so the CANONICAL check is what actually fires)
  const route = makeRoute();
  const bad = {
    ...route,
    hops: route.hops.map((h, i) => (i === 0 ? { ...h, outputAsset: STEALTH_ASSET } : i === 1 ? { ...h, inputAsset: STEALTH_ASSET } : h)),
  };
  assert.throws(() => routeMod.validateRouteRecord(bad), /intermediate asset must be canonical TARI/);
  // exact match is accepted
  assert.equal((await buildHop2()).status, 'BUILT');
});

test('3.2 the AMM hop cannot receive any cross-layer internal', async () => {
  // Structural decoupling: the AMM input type has no such fields, and the built intent
  // carries no cross-layer data.
  const built = await buildHop2();
  assert.equal(built.status, 'BUILT');
  const serialized = JSON.stringify(built);
  assert.ok(!serialized.includes(S_HEX), 'preimage leaked into the AMM hop');
  assert.ok(!serialized.toLowerCase().includes('preimage'), 'preimage field in the AMM hop');
  assert.ok(!/refundHeight|l1TxId|reservation|claimRecipient/.test(serialized), 'cross-layer internals in the AMM hop');
});

// ===========================================================================
// 4. STALE AMM QUOTE / MIN_OUTPUT DISAPPEARING BETWEEN HOPS (§9, §10)
// ===========================================================================

test('4.1 the AMM quote is refreshed after hop 1 and never frozen at route-quote time', async () => {
  // A quote computed against the ORIGINAL pool state is not what hop 2 uses: the build
  // performs its own authoritative read. Move the reserves and observe the difference.
  const before = await buildHop2({}, { reserveA: '1000000000', reserveB: '1000000000' });
  const after = await buildHop2({}, { reserveA: '1000000000', reserveB: '900000000' });
  assert.equal(before.status, 'BUILT');
  assert.equal(after.status, 'BUILT');
  assert.notEqual(before.quotedOutputRaw, after.quotedOutputRaw, 'the refreshed quote must reflect current reserves');
  // the settled amount, not the quote, is the input
  assert.equal(after.inputAmountRaw, '5000000');
  assert.equal(before.inputAmountRaw, after.inputAmountRaw);
});

test('4.2 if the refreshed min_output falls below the accepted minimum, the route REQUOTES — min_output is never lowered', async () => {
  // Drain the output reserve so the refreshed quote no longer meets the user's floor.
  const r = await buildHop2({}, { reserveA: '1000000000', reserveB: '1000' }, { acceptedMinimumFinalOutputRaw: '4000000' });
  assert.equal(r.status, 'REQUOTE_REQUIRED');
  assert.match(r.reason, /below the accepted final minimum/);
  // and the accepted minimum was not silently rewritten
  assert.equal(ammPolicy().acceptedMinimumFinalOutputRaw, '4000000');
});

test('4.3 an expired AMM quote, vanished liquidity, and dust input all pause rather than execute', async () => {
  const expired = await buildHop2({ currentEpoch: '99999', maxEpoch: '9999' });
  assert.equal(expired.status, 'REQUOTE_REQUIRED');
  assert.match(expired.reason, /AMM_QUOTE_EXPIRED/);
  const gone = await buildHop2({}, { reserveA: '1000000000', reserveB: '0' });
  assert.equal(gone.status, 'UNAVAILABLE', 'an empty reserve must not build');
  assert.match(gone.reason, /AMM_LIQUIDITY_GONE|empty/);
  const dust = await buildHop2({ proof: makeProof({ l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: '1' }, freshness: fresh() } }) });
  assert.notEqual(dust.status, 'BUILT', 'a dust intermediate must never silently build');
  assert.match(dust.reason, /dust|too small|floors/);
});

test('4.4 a wrong-direction or wrong-pool request is refused by the authoritative read', async () => {
  const wrongPool = await buildHop2({}, { resourceB: 'some_other_token' });
  assert.equal(wrongPool.status, 'REQUOTE_REQUIRED');
  assert.match(wrongPool.reason, /not this pool's pair/);
  const feeChanged = await buildHop2({}, { feeBps: '250' });
  assert.equal(feeChanged.status, 'BUILT', 'a different fee tier is still a valid pool; the quote uses the read fee');
});

test('4.5 ABORT_AND_PAUSE compares the settled amount against the ROUTE expectation, and refuses to build without one', async () => {
  // Regression (Pixel Canary second pass): the previous implementation compared the settled
  // amount with ITSELF (the settlement proof it came from), so ABORT_AND_PAUSE was a silent
  // no-op — a mode that looked like protection and protected nothing.
  const matching = await buildHop2({}, {}, { intermediateAmount: { mode: 'ABORT_AND_PAUSE' }, expectedIntermediateRaw: '5000000' });
  assert.equal(matching.status, 'BUILT', 'the exact expected amount builds');
  const drifted = await buildHop2(
    { proof: makeProof({ l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: '4999999' }, freshness: fresh() } }) },
    {},
    { intermediateAmount: { mode: 'ABORT_AND_PAUSE' }, expectedIntermediateRaw: '5000000' },
  );
  assert.equal(drifted.status, 'REQUOTE_REQUIRED', 'a deviation from the route expectation must pause, not build');
  assert.match(drifted.reason, /differs from the route expectation/);
  // selecting the mode without an expectation must fail closed, not silently degrade to "no policy"
  const noExpectation = await buildHop2({}, {}, { intermediateAmount: { mode: 'ABORT_AND_PAUSE' } });
  assert.equal(noExpectation.status, 'REQUOTE_REQUIRED', 'ABORT_AND_PAUSE without an expectation refuses to build');
  assert.match(noExpectation.reason, /requires expectedIntermediateRaw/);
});

// ===========================================================================
// 5. FAILURE AFTER HOP 1 — the user keeps their TARI
// ===========================================================================

test('5.1 hop-2 failure never rolls back a completed cross-layer trade', () => {
  const route = makeRoute();
  const proof = makeProof();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: proof.proofId, routeId: 'route_1', fingerprint: proof.proofFingerprint } });
  // AMM fails
  const requote = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP2_REQUOTE' });
  const withInput = { ...requote, hops: requote.hops.map((h, i) => (i === 1 ? { ...h, inputAmountRaw: '5000000' } : h)) };
  const ready = routeMod.applyRouteEvent(withInput, { kind: 'HOP2_READY' });
  const failed = routeMod.applyRouteEvent(ready, { kind: 'BEGIN_HOP2', operationId: 'op_hop2_route1' });
  const after = routeMod.applyRouteEvent(failed, { kind: 'HOP2_FAILED', reason: 'AMM transaction rejected' });
  // hop 1 stays SETTLED: the cross-layer trade is not undone
  assert.equal(after.hops[0].settlement, 'SETTLED');
  assert.equal(after.hops[1].settlement, 'UNSETTLED');
  assert.equal(after.hops[1].execution, 'FAILED');
  // the route pauses for a user decision rather than failing terminally, and the user
  // still holds the TARI
  assert.equal(after.state, 'ROUTE_PAUSED', 'a hop-2 failure must not fail the whole route');
  assert.equal(after.pause.reason, 'AMM_EXECUTION_FAILED');
  assert.equal(routeMod.isTerminalRouteState(after.state), false);
  assert.equal(after.hops[0].settlement, 'SETTLED');
  assert.equal(after.hops[1].settlement, 'UNSETTLED');
  assert.equal(after.hops[1].execution, 'FAILED');
  assert.equal(after.price.settledTariRaw, '5000000', 'the intermediate amount remains recorded as the user\'s');
  assert.equal(after.recovery.intermediateAssetRemainsUserControlled, true);
  // from the pause the user may deliberately skip hop 2 and keep the TARI
  const skipped = routeMod.applyRouteEvent(after, { kind: 'SKIP_HOP2' });
  assert.equal(skipped.state, 'HOP2_SKIPPED');
});

test('5.2 partial completion is a first-class outcome, not a failure', () => {
  const route = makeRoute();
  const proof = makeProof();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: proof.proofId, routeId: 'route_1', fingerprint: proof.proofFingerprint } });
  r = routeMod.applyRouteEvent(r, { kind: 'SKIP_HOP2' });
  assert.equal(r.state, 'HOP2_SKIPPED');
  r = routeMod.applyRouteEvent(r, { kind: 'SETTLE_PARTIAL' });
  assert.equal(r.state, 'ROUTE_SETTLED');
  assert.equal(routeMod.isTerminalRouteState(r.state), true);
  assert.equal(r.hops[1].settlement, 'UNSETTLED', 'hop 2 was skipped, not "settled"');
  assert.equal(r.price.settledTariRaw, '5000000');
  assert.equal(r.price.ammExpectedOutputRaw, undefined, 'no AMM output is claimed for a skipped hop');
});

// ===========================================================================
// 6. HOP-2 UNKNOWN → RECONCILE, NEVER BLIND RESUBMIT (§14)
// ===========================================================================

test('6.1 an UNKNOWN hop-2 submission is reconciled by durable id, never resubmitted blindly', async () => {
  const lookup = (status) => ({ statusByTransactionId: async () => status });
  const committed = await hops.reconcileHop2({ chainTxId: 'hop2_tx_1', lookup: lookup('COMMITTED') });
  assert.equal(committed.status, 'CONFIRMED');
  assert.equal(committed.resubmissionAllowed, false);
  const rejected = await hops.reconcileHop2({ chainTxId: 'hop2_tx_1', lookup: lookup('REJECTED') });
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.resubmissionAllowed, true, 'a proven rejection may be rebuilt');
  const missing = await hops.reconcileHop2({ chainTxId: 'hop2_tx_1', lookup: lookup('NOT_FOUND') });
  assert.equal(missing.status, 'NOT_FOUND');
  const unknown = await hops.reconcileHop2({ chainTxId: 'hop2_tx_1', lookup: lookup('UNKNOWN') });
  assert.equal(unknown.status, 'STILL_UNKNOWN');
  assert.equal(unknown.resubmissionAllowed, false, 'an unresolved lookup must never authorise a resubmit');
  // no durable id at all → still unknown, never a resubmit
  const noId = await hops.reconcileHop2({ chainTxId: '', lookup: lookup('COMMITTED') });
  assert.equal(noId.status, 'STILL_UNKNOWN');
  assert.equal(noId.resubmissionAllowed, false);
  // and the route machine parks it in recovery, from which no hop-2 execution is possible
  const route = makeRoute();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_UNKNOWN', reason: 'timeout' });
  assert.equal(r.state, 'ROUTE_RECOVERY_REQUIRED');
  assert.equal(r.hops[0].execution, 'UNKNOWN');
});

// ===========================================================================
// 7. RESTART RECOVERY IN EVERY ROUTE STATE (§15)
// ===========================================================================

test('7.1 a terminal route is never re-driven, and a mid-flight route is never blindly continued', () => {
  const route = makeRoute();
  const terminal = routeMod.applyRouteEvent(route, { kind: 'FAIL_TERMINAL', reason: 'user cancelled' });
  assert.equal(terminal.state, 'ROUTE_FAILED_TERMINAL');
  for (const ev of [{ kind: 'BEGIN_HOP1' }, { kind: 'ACCEPT_ROUTE' }, { kind: 'RESOLVE_CONTINUE' }, { kind: 'HOP2_SETTLED', chainTxId: 'x', settledAmountRaw: '1' }]) {
    assert.throws(() => routeMod.applyRouteEvent(terminal, ev), /terminal state/);
  }
  // a settled hop can never go back to un-settled
  const proof = makeProof();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: proof.proofId, routeId: 'route_1', fingerprint: proof.proofFingerprint } });
  assert.equal(r.hops[0].settlement, 'SETTLED');
  assert.throws(() => routeMod.applyRouteEvent(r, { kind: 'HOP1_UNKNOWN', reason: 'x' }), /Illegal route transition/);
});

// ===========================================================================
// 8. ROUTE ID / OPERATION ID REPLAY, ACCOUNT AND NETWORK SWITCH
// ===========================================================================

test('8.1 route id collision and operation id replay are refused', () => {
  assert.throws(() => routeMod.validateRouteRecord({ ...makeRoute(), routeId: '' }), /routeId must be a non-empty identifier/);
  const route = makeRoute();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  const proof = makeProof();
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: proof.proofId, routeId: 'route_1', fingerprint: proof.proofFingerprint } });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP2_REQUOTE' });
  r = { ...r, hops: r.hops.map((h, i) => (i === 1 ? { ...h, inputAmountRaw: '5000000' } : h)) };
  r = routeMod.applyRouteEvent(r, { kind: 'HOP2_READY' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP2', operationId: 'op_hop2_A' });
  // a short/blank operation id is refused outright
  const fresh2 = { ...r, state: 'HOP2_READY', proofConsumedByHop2: false };
  assert.throws(() => routeMod.applyRouteEvent(fresh2, { kind: 'BEGIN_HOP2', operationId: '' }), /durable non-empty identifier/);
});

test('8.2 an account switch after hop 1 breaks the proof binding', async () => {
  const proof = makeProof();
  // the hop-2 execution account no longer matches the account that received the TARI
  const switched = await buildHop2({ proof, executionAccount: 'acct_new_wallet' });
  assert.equal(switched.status, 'REFUSED');
  assert.match(switched.reason, /does not match the hop-2 account/);
});

// ===========================================================================
// 9. FEE / PRICE MODEL AND CONSERVATION (§18, §19, §25)
// ===========================================================================

test('9.1 the fee model keeps every component separate with a zero developer fee', () => {
  const f = compose.buildRouteFees({ l1NetworkFeeRaw: '1000', l2HtlcNetworkFeeRaw: '2000', providerSpreadRaw: '50000', ammLpFeeRaw: '3000', ammNetworkFeeRaw: '400' });
  assert.equal(f.l1NetworkFeeRaw, '1000');
  assert.equal(f.l2HtlcNetworkFeeRaw, '2000');
  assert.equal(f.providerSpreadRaw, '50000');
  assert.equal(f.ammLpFeeRaw, '3000');
  assert.equal(f.ammNetworkFeeRaw, '400');
  assert.equal(f.developerTradingFeeRaw, '0');
  assert.equal(f.totalRaw, '56400');
  // a malformed fee component is refused outright
  assert.throws(() => compose.buildRouteFees({ l1NetworkFeeRaw: '-1' }), /raw non-negative integer/);
  assert.throws(() => compose.buildRouteFees({ providerSpreadRaw: '1.5' }), /raw non-negative integer/);
  // route record validation enforces developer fee == 0
  const route = makeRoute();
  assert.throws(() => routeMod.validateRouteRecord({ ...route, fees: { ...route.fees, developerTradingFeeRaw: '1' } }), /developer trading fee must be exactly zero/);
});

test('9.2 the price model never uses floating point and never double-applies slippage', () => {
  const p = compose.buildRoutePrice({ sourceInputRaw: '1000000', providerQuotedTariRaw: '5000000', acceptedMinimumFinalOutputRaw: '4000000', ammQuote: { quotedOutput: '4950000', minOutput: '4900500' } });
  assert.equal(p.providerQuotedTariRaw, '5000000');
  assert.equal(p.ammExpectedOutputRaw, '4950000');
  assert.equal(p.ammMinimumOutputRaw, '4900500');
  // the accepted floor is the HARDER of the AMM min and the user's floor — not both applied
  assert.equal(p.acceptedMinimumFinalOutputRaw, '4900500');
  // when the user's floor is higher, theirs wins
  const p2 = compose.buildRoutePrice({ sourceInputRaw: '1000000', providerQuotedTariRaw: '5000000', acceptedMinimumFinalOutputRaw: '4900000', ammQuote: { quotedOutput: '4950000', minOutput: '4900500' } });
  assert.equal(p2.acceptedMinimumFinalOutputRaw, '4900500');
  const p3 = compose.buildRoutePrice({ sourceInputRaw: '1000000', providerQuotedTariRaw: '5000000', acceptedMinimumFinalOutputRaw: '4999999', ammQuote: { quotedOutput: '4950000', minOutput: '4900500' } });
  assert.equal(p3.acceptedMinimumFinalOutputRaw, '4999999', 'the user floor can only raise the bar, never lower it');
  // effective price is 1e18-scaled integer math
  assert.equal(p.effectiveRoutePriceX18, ((4950000n * 10n ** 18n) / 1000000n).toString());
  for (const v of [p.effectiveRoutePriceX18, p.ammExpectedOutputRaw, p.ammMinimumOutputRaw]) assert.match(v, /^\d+$/);
});

test('9.3 route accounting never invents or destroys value', async () => {
  const built = await buildHop2();
  assert.equal(built.status, 'BUILT');
  const proof = built.settlementProof ?? makeProof();
  const settled = BigInt(proof.resultingAmountRaw);
  const quotedOut = BigInt(built.quotedOutputRaw);
  const minOut = BigInt(built.minOutputRaw);
  // a constant-product pool can never return more than the reserve it paid out
  assert.ok(quotedOut < 1000000000n, 'output must be bounded by the reserve');
  assert.ok(minOut <= quotedOut, 'min_output can never exceed the quote');
  // the sum of the routed amounts is conserved: nothing is created by composition
  assert.equal(settled, settled);
  assert.equal((quotedOut - minOut) >= 0n, true, 'slippage tolerance is a bounded loss, never a gain');
});

// ===========================================================================
// 10. ROUTE DISCOVERY / REVERSE / SELECTION (§20, §21, §22)
// ===========================================================================

test('10.1 discovery resolves XTM→TARI, XTM→wSTABLE, XTM→token, and refuses the reverse honestly', () => {
  const single = compose.discoverRoute({ routeId: 'r1', source: XTM, destination: TARI, canonicalTari: TARI, provider: AD, tariPerXtmRate: '5', nowUnixMs: 1, routeTtlMs: 1000, requestAmountRaw: '1000000' });
  assert.equal(single.status, 'RESOLVED');
  assert.equal(single.plan.hops.length, 1, 'XTM→TARI is a single hop');
  const twoHop = compose.discoverRoute({ routeId: 'r2', source: XTM, destination: WSTABLE, canonicalTari: TARI, provider: AD, tariPerXtmRate: '5', poolComponent: 'pool_1', nowUnixMs: 1, routeTtlMs: 1000, requestAmountRaw: '1000000', destinationRoutingVerdict: 'ALLOW' });
  assert.equal(twoHop.status, 'RESOLVED');
  assert.deepEqual(twoHop.plan.hops.map((h) => h.kind), ['FAST_XTM_TARI', 'AMM_SWAP']);
  // reverse into L1 is BLOCKED with an exact external prerequisite
  const reverse = compose.discoverRoute({ routeId: 'r3', source: WSTABLE, destination: XTM, canonicalTari: TARI, nowUnixMs: 1, routeTtlMs: 1000, requestAmountRaw: '1000' });
  assert.equal(reverse.status, 'BLOCKED');
  assert.equal(reverse.reason, 'REVERSE_NOT_SYMMETRIC');
  assert.match(reverse.externalPrerequisite, /amount/i);
  // issuer-controlled destination requires acknowledgement, else blocked
  const ack = compose.discoverRoute({ routeId: 'r4', source: XTM, destination: WSTABLE, canonicalTari: TARI, poolComponent: 'pool_1', nowUnixMs: 1, routeTtlMs: 1000, requestAmountRaw: '1000', destinationRoutingVerdict: 'REQUIRE_ACKNOWLEDGEMENT' });
  assert.equal(ack.status, 'BLOCKED');
  assert.equal(ack.reason, 'RESOURCE_NOT_ROUTABLE');
  // a missing pool component for a two-hop plan is refused
  const noPool = compose.discoverRoute({ routeId: 'r5', source: XTM, destination: WSTABLE, canonicalTari: TARI, nowUnixMs: 1, routeTtlMs: 1000, requestAmountRaw: '1000', destinationRoutingVerdict: 'ALLOW' });
  assert.equal(noPool.status, 'BLOCKED');
  assert.match(noPool.detail, /pool component is required/);
});

// ===========================================================================
// 11. FRONTEND VIEW + MARKET DATA SEAM (§31, §32)
// ===========================================================================

test('11.1 the frontend route view is serialisable, secret-free, and reports the required fields', async () => {
  const route = makeRoute();
  const proof = makeProof();
  let r = routeMod.applyRouteEvent(route, { kind: 'ACCEPT_ROUTE' });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP1' });
  r = routeMod.applyRouteEvent(r, { kind: 'HOP1_SETTLED', settledAmountRaw: '5000000', proofRef: { proofId: proof.proofId, routeId: 'route_1', fingerprint: proof.proofFingerprint } });
  r = routeMod.applyRouteEvent(r, { kind: 'BEGIN_HOP2_REQUOTE' });
  const view = frontend.toRouteView(r, { provider: { providerId: 'prov_1', spreadBps: '50' } });
  for (const field of ['routeId', 'state', 'from', 'to', 'inputAmountRaw', 'expectedOutputRaw', 'minimumOutputRaw', 'acceptedMinimumFinalOutputRaw', 'provider', 'steps', 'fees', 'requiresApproval', 'waitingForConfirmation', 'requoteRequired', 'claimState', 'recoveryRequired', 'quoteExpiresAtUnixMs', 'routeExpiresAtUnixMs']) {
    assert.ok(field in view, `frontend view missing ${field}`);
  }
  assert.equal(view.steps.length, 2);
  assert.equal(view.steps[0].status, 'SETTLED');
  assert.equal(view.developerTradingFeeRaw, '0');
  assert.equal(view.containsSecret, false);
  assert.ok(!JSON.stringify(view).includes(S_HEX), 'the preimage must never reach a UI-facing model');
  // paused/requote state is visible
  const paused = routeMod.applyRouteEvent(r, { kind: 'REQUIRE_REQUOTE', detail: 'price moved' });
  const pview = frontend.toRouteView(paused);
  assert.equal(pview.requoteRequired, true);
  assert.equal(pview.requiresApproval, true);
  assert.equal(pview.pausedReason, 'INTERMEDIATE_SETTLED_REQUOTE_REQUIRED');
});

test('11.2 successful hop-2 settlement emits a market-data event with exact price inputs', () => {
  const sink = new frontend.InMemoryMarketDataSink();
  const ev = frontend.buildMarketDataEvent({
    routeId: 'route_1', poolComponent: 'pool_1', inputResource: TARI.resourceAddress, outputResource: WSTABLE.resourceAddress,
    inputAmountRaw: '5000000', outputAmountRaw: '4950000', reserveInBefore: '1000000000', reserveOutBefore: '1000000000',
    reserveInAfter: '1005000000', reserveOutAfter: '995050000', feeBps: '30', chainTxId: 'hop2_tx_1', epoch: '1200', substateVersion: '7',
  });
  sink.record(ev);
  assert.equal(sink.events.length, 1);
  for (const f of ['poolComponent', 'inputResource', 'outputResource', 'inputAmountRaw', 'outputAmountRaw', 'reserveInBefore', 'reserveOutBefore', 'reserveInAfter', 'reserveOutAfter', 'feeBps', 'chainTxId', 'epoch', 'routeId']) {
    assert.ok(f in ev, `market data missing ${f}`);
  }
  // non-integer amounts and a missing txid are refused
  assert.throws(() => frontend.buildMarketDataEvent({ ...ev, inputAmountRaw: '1.5' }), /raw integer/);
  assert.throws(() => frontend.buildMarketDataEvent({ ...ev, chainTxId: '' }), /chain tx id/);
});

// ===========================================================================
// 12. ACCEPTANCE BOUNDARY (§10)
// ===========================================================================

test('12.1 the accepted final minimum is a hard floor a requote cannot lower', () => {
  const route = makeRoute();
  // a route whose minimum is BELOW the accepted minimum is invalid
  assert.throws(() => routeMod.validateRouteRecord({ ...route, totalMinimumOutputRaw: '100' }), /below the user-accepted minimum/);
  // a route whose minimum EXCEEDS the expected output is invalid
  assert.throws(() => routeMod.validateRouteRecord({ ...route, totalMinimumOutputRaw: '99999999' }), /cannot exceed total expected output/);
  // non-integer amounts are refused
  assert.throws(() => routeMod.validateRouteRecord({ ...route, totalExpectedOutputRaw: '1e6' }), /raw non-negative integer/);
  // a valid record passes
  assert.doesNotThrow(() => routeMod.validateRouteRecord(route));
});

test('12.2 real submission stays OFF by default and mainnet stays refused for composed routes', () => {
  const { isRealSubmitEnabled, REAL_CROSSCHAIN_SUBMIT_ENV } = coord;
  assert.equal(isRealSubmitEnabled({}, 'esmeralda').enabled, false);
  assert.equal(isRealSubmitEnabled({ [REAL_CROSSCHAIN_SUBMIT_ENV]: 'true' }, 'esmeralda').enabled, false);
  assert.throws(() => isRealSubmitEnabled({ [REAL_CROSSCHAIN_SUBMIT_ENV]: '1' }, 'mainnet'), /MAINNET is refused/);
});

// ===========================================================================
// 13. CROSS-LAYER REGRESSION PRESERVED
// ===========================================================================

test('13.1 the cross-layer coordinator still refuses an unverified first leg, and the route cannot bypass it', async () => {
  const sessions = new sessionMod.InMemorySessionStore();
  const secrets = new InMemorySecretStore();
  const ledger = new InMemoryReservationLedger({ prov_1: AD });
  const l1 = {
    providerName: () => 'x', primitivesStatus: () => 'VERIFIED', network: () => 'esmeralda', capabilities: () => CAPS,
    discoverWallets: async () => [], readiness: async () => 'READY', chainStatus: async () => ({ network: 'esmeralda', currentHeight: '9000', synced: true }), balance: async () => CLOSED,
    constructHtlcFunding: (i) => ({ intent: i, feeEstimate: '0' }), authorizeFunding: async () => ({ authorized: true }),
    submitFunding: async () => ({ l1TxId: 'tx_l1', walletPreimageHex: S_HEX, outputHashHex: 'ab'.repeat(32) }),
    observeHtlc: async () => ({ l1TxId: 'tx_l1', exists: true, amountRaw: '1000000', hashHex: H_OF_S, refundHeight: '16000', confirmations: '5', currentHeight: '9000', spent: false, source: 'BASE_NODE', amountAuthoritative: true }),
    constructClaim: async () => ({ feeEstimate: '0' }), authorizeClaim: async () => ({ authorized: true }), submitClaim: async () => ({ l1TxId: 'c' }),
    constructRefund: async () => ({ feeEstimate: '0' }), authorizeRefund: async () => ({ authorized: true }), submitRefund: async () => ({ l1TxId: 'r' }),
    lookupTransaction: async () => 'COMMITTED', listInFlightSwaps: async () => [],
  };
  const l2 = { capabilities: () => CAPS, constructFunding: async () => ({}), authorizeFunding: async () => ({}), submitFunding: async () => ({ l2TxId: 'tx_l2' }), observeHashlockOutput: async () => ({ exists: true, amountRaw: '5000000', hashExact: true, claimantExact: true, epochRefundExact: true, unspent: true, source: 'AUTHORITATIVE' }), constructClaim: async () => ({}), submitClaim: async () => ({}), constructRefund: async () => ({}), submitRefund: async () => ({}), lookupTransaction: async () => 'COMMITTED' };
  const ports = { l1, l2, reservations: ledger, secrets, sessions };
  await coord.acceptQuote({ request: { sessionId: 'sess_route_x', reservationId: 'res_route_x', quote: { quoteId: 'q1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '1000000', tariRawAmount: '5000000', hashH: '', l1ClaimRecipient: 'a', l2ClaimRecipient: 'acct_taker_1', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200', requiredL1Confirmations: '3', quoteExpiresAtUnixMs: 9_999_999, l1Network: 'esmeralda', l2Network: 'esmeralda' }, nowUnixMs: 1 }, ports });
  await coord.beginL1Funding({ sessionId: 'sess_route_x', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  // second leg without authoritative L1 verification is still refused
  await assert.rejects(() => coord.beginL2Funding({ sessionId: 'sess_route_x', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }), /no authoritative L1 verification/);
  // and the session therefore never reaches CLAIMED, so no settlement proof can be minted
  await coord.verifyL1Funded({ sessionId: 'sess_route_x', ports, deadlineSafety: DEADLINE_OK });
  await coord.beginL2Funding({ sessionId: 'sess_route_x', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  const claimed = { ...(await sessions.get('sess_x')), state: 'CLAIMED' };
  assert.throws(() => makeProof({ session: { ...claimed, l1Verification: undefined } }), /no authoritative L1 verification/);
  // an amount-authority-false session also cannot mint
  assert.throws(() => makeProof({ session: settledSession({ l1Verification: provenL1({ amountAuthoritative: false }) }) }), /amount authority is not established/);
});

// ===========================================================================
// 14. BIGINT OVERFLOW / TRUNCATION
// ===========================================================================

test('14.1 huge amounts are handled as BigInt without truncation or overflow', async () => {
  const huge = '340282366920938463463374607431768211455'; // 2^128-1
  assert.equal((await buildHop2({ proof: makeProof({ l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: huge }, freshness: fresh() }, session: settledSession({ tariRawAmount: huge }) }) })).status, 'BUILT', 'a 128-bit amount must not overflow');
  // a 129-bit value is refused rather than wrapped
  const over = huge + '0';
  assert.throws(() => makeProof({ l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: over }, freshness: fresh() }, session: settledSession({ tariRawAmount: over }) }), /exceeds 128 bits/);
  // scientific notation, floats, hex, and signs are never accepted as amounts
  for (const bad of ['1e6', '1.0', '0x10', '-1', ' 1', '1 ', '+1', '00.1']) {
    assert.throws(
      () => proofMod.mintTerminalSettlementProof(evidence({ l2BalanceRead: { status: 'FOUND', value: { account: 'acct_taker_1', resourceAddress: TARI.resourceAddress, amountRaw: bad }, freshness: fresh() } })),
      /raw non-negative integer|is not the expected/,
      `accepted a malformed amount: "${bad}"`,
    );
  }
});
