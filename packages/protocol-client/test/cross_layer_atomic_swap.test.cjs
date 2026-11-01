/**
 * Cross-layer atomic exchange: the timeout derivation and the direction mapping.
 *
 * These are the two places a cross-chain HTLC is usually got wrong, and both are forced by facts
 * about the real chains rather than chosen:
 *
 *   * the L1 wallet GENERATES the preimage inside `send_sha_atomic_swap` and exposes no hash
 *     parameter, so the L1 funder is always the secret holder — which fixes the funding order
 *     and which leg must expire first;
 *   * the L1 refund height is hardcoded at tip + 720 blocks, so the only adjustable deadline is
 *     the L2 one, and 720 blocks is a DIFFERENT wall-clock duration on each network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

test('direction mapping: the L1 funder is the secret holder in BOTH directions', () => {
  // Not a design preference. `SendShaAtomicSwapRequest` has no hash field and the response
  // returns `pre_image`, so whoever funds L1 learns the secret from their own wallet.
  for (const d of ['L2_TO_L1', 'L1_TO_L2']) {
    const shape = pc.DIRECTIONS[d];
    assert.equal(shape.secretHeldBy, shape.l1FundedBy, `${d}: the L1 funder holds the secret`);
    assert.deepEqual(shape.fundingOrder, ['L1', 'L2'], `${d}: the secret holder funds first`);
    // The secret becomes public on L2, where it is readable from component state rather than
    // having to be recovered from an L1 script input.
    assert.equal(shape.revealedOn, 'L2', `${d}`);
  }
});

test('direction mapping: the priority route sends the user real L1 XTM for L2 TARI', () => {
  const exit = pc.DIRECTIONS.L2_TO_L1;
  assert.equal(exit.userGives, 'L2_TARI');
  assert.equal(exit.userGets, 'L1_XTM');
  // The maker must put up the XTM, because the user cannot: there is no peg-out.
  assert.equal(exit.l1FundedBy, 'MAKER');
  assert.equal(exit.l2FundedBy, 'USER');
  // The maker reveals by claiming the user's L2 escrow; the user then takes the XTM.
  assert.deepEqual(exit.claimOrder, ['L2_BY_MAKER', 'L1_BY_USER']);

  const enter = pc.DIRECTIONS.L1_TO_L2;
  assert.equal(enter.l1FundedBy, 'USER');
  assert.equal(enter.l2FundedBy, 'MAKER', 'the maker pays out TARI they already hold — no mint');
  assert.deepEqual(enter.claimOrder, ['L2_BY_USER', 'L1_BY_MAKER']);
});

test('chain timing: the effective block interval is the dual-PoW combination, checked against mainnet', () => {
  // Mainnet's block time is known to be 2 minutes, and its constants say target_time 240 for
  // each of two algorithms. Any formula that does not reproduce 120s from that is wrong, so this
  // is the test that keeps the Esmeralda number honest too.
  assert.equal(pc.l1BlockSeconds(pc.CHAIN_TIMING.mainnet), 120);
  assert.equal(pc.l1BlockSeconds(pc.CHAIN_TIMING.esmeralda), 30);

  // 720 blocks is a FIXED block count, so it is a different duration per network.
  assert.equal(pc.l1RefundWindowSeconds(pc.CHAIN_TIMING.mainnet), 720 * 120); // 24 h
  assert.equal(pc.l1RefundWindowSeconds(pc.CHAIN_TIMING.esmeralda), 720 * 30); // 6 h
  // One L2 epoch = vn_epoch_length L1 blocks.
  assert.equal(pc.l2EpochSeconds(pc.CHAIN_TIMING.mainnet), 60 * 120); // 2 h
  assert.equal(pc.l2EpochSeconds(pc.CHAIN_TIMING.esmeralda), 80 * 30); // 40 min
});

test('derived timeouts: the L2 deadline is strictly earlier, with a justified margin', () => {
  const d = pc.deriveTimeouts({ network: 'esmeralda', l1TipHeight: 100_000, l2CurrentEpoch: 50 });
  assert.equal(d.l1RefundHeight, 100_720, 'the wallet will use tip + 720; it is not settable');
  // Esmeralda: 6 h window, 40 min epochs, half reserved as margin -> 3 h = 4.5 epochs -> 4.
  assert.equal(d.l2ExpiresAtEpoch, 54);
  // Rounding DOWN to a whole epoch may only enlarge the margin, so it exceeds the bare half.
  assert.ok(d.claimMarginSeconds >= pc.l1RefundWindowSeconds(pc.CHAIN_TIMING.esmeralda) * 0.5);
  assert.equal(d.claimMarginSeconds, 720 * 30 - 4 * 80 * 30);
  // The justification has to contain the numbers a reviewer would otherwise have to recompute.
  for (const needle of ['720 blocks', 'esmeralda', 'epoch 54', 'tip 100000']) {
    assert.ok(d.justification.includes(needle), `justification mentions ${needle}: ${d.justification}`);
  }

  const m = pc.deriveTimeouts({ network: 'mainnet', l1TipHeight: 1_000, l2CurrentEpoch: 7 });
  // Mainnet: 24 h window, 2 h epochs, half reserved -> 12 h = 6 epochs exactly.
  assert.equal(m.l2ExpiresAtEpoch, 13);
  assert.equal(m.claimMarginSeconds, 720 * 120 - 6 * 60 * 120);
});

test('derived timeouts: live readings are required, and a window too short to split is refused', () => {
  for (const bad of [
    { network: 'esmeralda', l1TipHeight: -1, l2CurrentEpoch: 0 },
    { network: 'esmeralda', l1TipHeight: 1.5, l2CurrentEpoch: 0 },
    { network: 'esmeralda', l1TipHeight: 1, l2CurrentEpoch: -3 },
  ]) {
    assert.throws(() => pc.deriveTimeouts(bad), /live read/);
  }
  assert.throws(() => pc.deriveTimeouts({ network: 'nosuchnet', l1TipHeight: 1, l2CurrentEpoch: 1 }), /no chain timing/);
});

test('a counterparty\'s proposed deadlines are recomputed, not trusted', () => {
  const live = { network: 'esmeralda', l1TipHeight: 100_000, l2CurrentEpoch: 50 };
  const good = pc.deriveTimeouts(live);
  assert.deepEqual(
    pc.checkProposedTimeouts({ l1RefundHeight: good.l1RefundHeight, l2ExpiresAtEpoch: good.l2ExpiresAtEpoch }, live),
    { safe: true },
  );

  // The dangerous proposal is a PLAUSIBLE one that leaves too little margin, not an absurd one.
  const tight = pc.checkProposedTimeouts({ l1RefundHeight: 100_720, l2ExpiresAtEpoch: 58 }, live);
  assert.equal(tight.safe, false);
  assert.match(tight.reason, /remain after the L2 deadline|not earlier than/);

  // An L2 leg that outlives the L1 leg: the preimage would appear with no time left to use it.
  const inverted = pc.checkProposedTimeouts({ l1RefundHeight: 100_100, l2ExpiresAtEpoch: 60 }, live);
  assert.equal(inverted.safe, false);
  assert.match(inverted.reason, /not earlier than the L1 one/);

  // Already-expired or already-refundable legs.
  assert.match(pc.checkProposedTimeouts({ l1RefundHeight: 100_720, l2ExpiresAtEpoch: 50 }, live).reason, /not in the future/);
  assert.match(pc.checkProposedTimeouts({ l1RefundHeight: 99_999, l2ExpiresAtEpoch: 54 }, live).reason, /already refundable/);
});

test('the L1 block count is a protocol constant, not a tunable', () => {
  // If upstream ever makes the HTLC height configurable, this is the test that should fail and
  // force the derivation to be revisited rather than silently keeping a stale assumption.
  assert.equal(pc.L1_HTLC_REFUND_BLOCKS, 720);
  assert.equal(pc.CLAIM_MARGIN_FRACTION, 0.5);
});
