/**
 * Which wallet can sign which leg — the capability finding in executable form.
 *
 * A cross-layer trade needs FOUR signatures across two chains, and no single wallet produces all
 * four today. A UI that offered a trade it could not finish would strand a user mid-settlement
 * with an irreversible funded leg, so refusing is the behaviour under test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

test('Universe reaches BOTH layers — and can sign NEITHER HTLC leg', () => {
  // The correction worth pinning: the richer application has the narrower surface here.
  const u = pc.WALLET_SURFACES.UNIVERSE_TAPPLET;
  assert.ok(u.can.includes('L1_READ'), 'Universe does reach L1 from a web page');
  assert.ok(u.can.includes('L2_READ'), 'and L2');
  for (const op of ['L1_FUND_HTLC', 'L1_CLAIM_HTLC', 'L1_REFUND_HTLC', 'L2_FUND_HTLC', 'L2_CLAIM_HTLC', 'L2_REFUND_HTLC']) {
    assert.ok(!u.can.includes(op), `Universe cannot ${op}`);
  }
  // And the reasons are specific enough to act on, not just "unsupported".
  const limits = u.limits.join(' ');
  assert.match(limits, /sendOneSided.*cannot carry a custom TariScript/);
  assert.match(limits, /sendOotleStealth.*rather than a template method call/);
  assert.match(limits, /ONE generic L2 transaction-request method/, 'names the single upstream change needed');
});

test('Sapient is L2-only but CAN drive the L2 HTLC; local gRPC is the only L1 HTLC surface', () => {
  const s = pc.WALLET_SURFACES.SAPIENT;
  assert.deepEqual([...s.can].sort(), ['L2_CLAIM_HTLC', 'L2_FUND_HTLC', 'L2_READ', 'L2_REFUND_HTLC']);
  assert.equal(s.requiresLocalEndpoint, false, 'it is a browser provider');
  assert.match(s.limits.join(' '), /no Minotari L1 surface at all/);

  const l = pc.WALLET_SURFACES.LOCAL_WALLETD_GRPC;
  assert.deepEqual([...l.can].sort(), ['L1_CLAIM_HTLC', 'L1_FUND_HTLC', 'L1_READ', 'L1_REFUND_HTLC']);
  assert.equal(l.requiresLocalEndpoint, true);
  assert.match(l.limits.join(' '), /Ledger/, 'records that Ledger cannot fund an HTLC');
  assert.match(l.limits.join(' '), /tip \+ 720 blocks/, 'records the fixed timeout');
});

test('every surface records the revision it was read from, so a stale entry is visible', () => {
  for (const kind of ['LOCAL_WALLETD_GRPC', 'SAPIENT', 'UNIVERSE_TAPPLET']) {
    assert.match(pc.WALLET_SURFACES[kind].readFrom, /\S/, kind);
  }
  assert.match(pc.WALLET_SURFACES.LOCAL_WALLETD_GRPC.readFrom, /6\.3\.0-pre\.2/);
  assert.match(pc.WALLET_SURFACES.UNIVERSE_TAPPLET.readFrom, /universe 22366ad/);
});

test('a route is refused unless EVERY operation has a signer — refunds included', () => {
  // Refunds are required, not optional: a route whose refund cannot be signed can strand funds.
  const needed = pc.requiredOperations('L2_TO_L1');
  for (const op of ['L1_REFUND_HTLC', 'L2_REFUND_HTLC']) {
    assert.ok(needed.includes(op), `${op} is required`);
  }

  // Universe alone: reads both layers, signs nothing. The most important refusal, because it is
  // the configuration a user is most likely to arrive in.
  const universeOnly = pc.planSigners('L2_TO_L1', ['UNIVERSE_TAPPLET']);
  assert.equal(universeOnly.ok, false);
  assert.deepEqual([...universeOnly.missing].sort(), [
    'L1_CLAIM_HTLC', 'L1_FUND_HTLC', 'L1_REFUND_HTLC',
    'L2_CLAIM_HTLC', 'L2_FUND_HTLC', 'L2_REFUND_HTLC',
  ]);
  assert.match(universeOnly.reason, /can strand funds/);
  assert.match(universeOnly.reason, /ONE generic L2 transaction-request method/);

  // Sapient alone: the L2 leg only.
  const sapientOnly = pc.planSigners('L2_TO_L1', ['SAPIENT']);
  assert.equal(sapientOnly.ok, false);
  assert.deepEqual([...sapientOnly.missing].sort(), ['L1_CLAIM_HTLC', 'L1_FUND_HTLC', 'L1_READ', 'L1_REFUND_HTLC']);

  // Local wallet alone: the L1 leg only.
  const localOnly = pc.planSigners('L2_TO_L1', ['LOCAL_WALLETD_GRPC']);
  assert.equal(localOnly.ok, false);
  assert.deepEqual([...localOnly.missing].sort(), ['L2_CLAIM_HTLC', 'L2_FUND_HTLC', 'L2_READ', 'L2_REFUND_HTLC']);

  // Nothing connected at all.
  const none = pc.planSigners('L2_TO_L1', []);
  assert.equal(none.ok, false);
  assert.match(none.reason, /wallets available \(none\)/);
});

test('local gRPC + Sapient is the one working combination, and it says a local wallet is needed', () => {
  for (const direction of ['L2_TO_L1', 'L1_TO_L2']) {
    const plan = pc.planSigners(direction, ['LOCAL_WALLETD_GRPC', 'SAPIENT']);
    assert.equal(plan.ok, true, direction);
    assert.equal(plan.assignment.L1_FUND_HTLC, 'LOCAL_WALLETD_GRPC');
    assert.equal(plan.assignment.L1_REFUND_HTLC, 'LOCAL_WALLETD_GRPC');
    assert.equal(plan.assignment.L2_FUND_HTLC, 'SAPIENT');
    assert.equal(plan.assignment.L2_REFUND_HTLC, 'SAPIENT');
    // The user must be told up front that a browser alone will not finish this.
    assert.equal(plan.needsLocalWallet, true);
    assert.match(plan.summary, /a browser alone cannot complete it/);
  }
});

test('adding Universe to a working pair changes nothing it cannot sign, but takes the reads', () => {
  // A browser-reachable surface is preferred for operations it CAN do, so a user with Universe
  // connected reads through it rather than depending on the local endpoint for everything.
  const plan = pc.planSigners('L2_TO_L1', ['LOCAL_WALLETD_GRPC', 'SAPIENT', 'UNIVERSE_TAPPLET']);
  assert.equal(plan.ok, true);
  assert.equal(plan.assignment.L1_READ, 'UNIVERSE_TAPPLET', 'a browser surface is preferred for reads');
  // But the signing assignment is unchanged: Universe cannot sign an HTLC leg.
  assert.equal(plan.assignment.L1_FUND_HTLC, 'LOCAL_WALLETD_GRPC');
  assert.equal(plan.assignment.L2_FUND_HTLC, 'SAPIENT');
  assert.equal(plan.needsLocalWallet, true, 'still needs the local wallet for the L1 legs');
});

test('capabilityGaps answers "what still cannot be done" for an honest capability screen', () => {
  assert.deepEqual([...pc.capabilityGaps(['UNIVERSE_TAPPLET'])].sort(), [
    'L1_CLAIM_HTLC', 'L1_FUND_HTLC', 'L1_REFUND_HTLC',
    'L2_CLAIM_HTLC', 'L2_FUND_HTLC', 'L2_REFUND_HTLC',
  ]);
  assert.deepEqual(pc.capabilityGaps(['LOCAL_WALLETD_GRPC', 'SAPIENT']), [], 'nothing missing');
  assert.deepEqual([...pc.capabilityGaps([])].length, 8);
});

test('an unknown wallet kind or direction is an error, not a silently empty plan', () => {
  assert.throws(() => pc.planSigners('L2_TO_L1', ['SOME_FUTURE_WALLET']), /unknown wallet kind/);
  assert.throws(() => pc.requiredOperations('L2_TO_L3'), /unknown direction/);
});
