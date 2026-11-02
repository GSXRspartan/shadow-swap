/**
 * The cross-layer exchange lifecycle and its recovery.
 *
 * A trade spans two chains and four transactions, so a browser closing must never destroy the
 * ability to recover funds. The properties under test are the ones that cost money if wrong:
 * where the preimage is allowed to live, what each party may do at each stage, and that an
 * ambiguous submission is never retried.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const BASE = {
  swapId: 'swap-1',
  direction: 'L2_TO_L1',
  network: 'esmeralda@v048',
  stage: 'QUOTED',
  role: 'USER',
  l2Account: 'component_' + 'aa'.repeat(32),
  l1Address: 'tari1user',
  counterpartyL2PublicKey: 'bb'.repeat(32),
  counterpartyL1Address: 'tari1maker',
  hashLockHex: 'cc'.repeat(32),
  l2ResourceAddress: 'resource_' + 'dd'.repeat(32),
  l2RawAmount: '1000000',
  l1MicroAmount: '1000000',
  l2ExpiresAtEpoch: 54,
  l1RefundHeight: 100720,
  updatedAtUnixMs: 1,
};
const rec = (over = {}) => ({ ...BASE, ...over });
const at = (epoch, height) => ({ l2CurrentEpoch: epoch, l1TipHeight: height });

test('the preimage may never be persisted — its home is the local companion, not the browser', () => {
  // The hash lock IS allowed: it is committed in both escrows and public on both chains.
  assert.ok(pc.serializeSwap(rec()).includes(BASE.hashLockHex));
  for (const field of ['preImageHex', 'pre_image', 'swapSecret', 'spendKey', 'seedWords', 'viewKey', 'mask']) {
    assert.throws(() => pc.serializeSwap(rec({ [field]: 'x' })), /may never carry/, field);
    // And refused on READ as well, in case an older build or a hand edit wrote one.
    assert.equal(
      pc.restoreSwap(JSON.stringify(rec({ [field]: 'x' })), { network: BASE.network, l2Account: BASE.l2Account }),
      undefined,
      field,
    );
  }
  // The refusal explains where it should live, so the reader is not left guessing.
  assert.throws(() => pc.serializeSwap(rec({ preImageHex: 'x' })), /local companion beside the L1 wallet/);
});

test('recovery: a swap survives a reload, and untrusted storage degrades to nothing recovered', () => {
  const saved = rec({ stage: 'BOTH_FUNDED', l2EscrowComponent: 'component_' + 'ee'.repeat(32) });
  const expect = { network: BASE.network, l2Account: BASE.l2Account };
  assert.deepEqual(pc.restoreSwap(pc.serializeSwap(saved), expect), saved);

  // Browser storage is attacker-writable in a shared browser, so none of these may throw.
  for (const raw of [null, undefined, '', 'not json', '[]', 'null', '42', '"str"']) {
    assert.equal(pc.restoreSwap(raw, expect), undefined, JSON.stringify(raw));
  }
  // Another account or network must never resurrect someone else's trade as this one.
  assert.equal(pc.restoreSwap(pc.serializeSwap(saved), { ...expect, l2Account: 'component_' + 'ff'.repeat(32) }), undefined);
  assert.equal(pc.restoreSwap(pc.serializeSwap(saved), { ...expect, network: 'localnet' }), undefined);
  // An unknown stage or a non-finite timestamp cannot be rendered honestly.
  assert.equal(pc.restoreSwap(JSON.stringify(rec({ stage: 'ALMOST' })), expect), undefined);
  assert.equal(pc.restoreSwap(JSON.stringify(rec({ updatedAtUnixMs: 'soon' })), expect), undefined);
  assert.equal(pc.restoreSwap(JSON.stringify(rec({ swapId: '' })), expect), undefined);
});

test('an ambiguous submission is UNKNOWN and demands a chain read, never a retry', () => {
  const unknown = pc.markSwapUnknown(rec({ stage: 'L2_FUNDING_SUBMITTED' }), 'The L2 escrow funding');
  assert.equal(unknown.stage, 'UNKNOWN');
  assert.match(unknown.blockers.join(' '), /could not be established/);
  assert.match(unknown.blockers.join(' '), /a retry could fund or claim twice/);

  const verdict = pc.nextAction(unknown, at(50, 100000));
  assert.equal(verdict.action, 'RESOLVE_UNKNOWN');
  assert.match(verdict.reason, /Read the chain for this escrow before doing anything else/);
  assert.match(verdict.reason, /would not be recoverable/);
});

test('the L1 funder is the secret holder, so the roles get different actions at every stage', () => {
  // Exit route: the MAKER funds L1 (and holds the secret); the USER funds L2.
  const user = rec({ role: 'USER' });
  const maker = rec({ role: 'MAKER' });
  const live = at(50, 100000);

  assert.equal(pc.nextAction(maker, live).action, 'FUND_L1');
  assert.match(pc.nextAction(maker, live).reason, /LATER deadline/);
  // The user is not exposed yet and is told so.
  assert.equal(pc.nextAction(user, live).action, 'WAIT');
  assert.match(pc.nextAction(user, live).reason, /walk away at no cost/);

  // Entry route inverts who funds L1, because the L1 funder is always the secret holder.
  const entryUser = rec({ direction: 'L1_TO_L2', role: 'USER' });
  assert.equal(pc.nextAction(entryUser, live).action, 'FUND_L1');
  const entryMaker = rec({ direction: 'L1_TO_L2', role: 'MAKER' });
  assert.equal(pc.nextAction(entryMaker, live).action, 'WAIT');
});

test('the L2 leg is never funded against an unverified or expired L1 leg', () => {
  const user = rec({ role: 'USER', stage: 'L1_FUNDED' });
  // Before the deadline, funding is the action — and the reason states the commitment.
  const ok = pc.nextAction(user, at(50, 100000));
  assert.equal(ok.action, 'FUND_L2');
  assert.match(ok.reason, /recover it only after its deadline/i);

  // At or past the L2 deadline, funding would create an escrow refundable before claimable.
  const late = pc.nextAction(user, at(54, 100000));
  assert.equal(late.action, 'NOTHING');
  assert.match(late.reason, /Do not fund/);

  // While the L1 leg is only submitted, the answer is wait — not fund.
  assert.equal(pc.nextAction(rec({ role: 'USER', stage: 'L1_FUNDING_SUBMITTED' }), at(50, 100000)).action, 'WAIT');
});

test('L1 funding is confirmed only on a read that reconciles BOTH amount and hash lock', () => {
  const submitted = rec({ role: 'USER', stage: 'L1_FUNDING_SUBMITTED' });
  const good = { outputHashHex: '11'.repeat(32), microAmount: '1000000', hashLockHex: BASE.hashLockHex, confirmations: 3 };

  assert.equal(pc.confirmL1Funding(submitted, good, 3).stage, 'L1_FUNDED');
  assert.equal(pc.confirmL1Funding(submitted, good, 3).l1OutputHashHex, '11'.repeat(32));
  // Not yet confirmed enough: it stays submitted rather than advancing.
  assert.equal(pc.confirmL1Funding(submitted, { ...good, confirmations: 2 }, 3).stage, 'L1_FUNDING_SUBMITTED');

  // A hash that does not match means a preimage for it would not open the user's escrow.
  const wrongHash = pc.confirmL1Funding(submitted, { ...good, hashLockHex: '99'.repeat(32) }, 3);
  assert.equal(wrongHash.stage, 'BLOCKED');
  assert.match(wrongHash.blockers.join(' '), /would not open your escrow/);
  // The right hash for the wrong amount is equally fatal, and separately reported.
  const short = pc.confirmL1Funding(submitted, { ...good, microAmount: '999999' }, 3);
  assert.equal(short.stage, 'BLOCKED');
  assert.match(short.blockers.join(' '), /below the 1000000 agreed/);
  // A BLOCKED swap offers no action.
  assert.equal(pc.nextAction(short, at(50, 100000)).action, 'NOTHING');
});

test('claim ordering: the secret holder claims L2 first, and the other side is warned about the race', () => {
  const maker = rec({ role: 'MAKER', stage: 'BOTH_FUNDED' });
  assert.equal(pc.nextAction(maker, at(50, 100000)).action, 'CLAIM_L2');
  // Past the L2 deadline the maker cannot claim and is told the counterparty will recover it.
  assert.equal(pc.nextAction(maker, at(54, 100000)).action, 'WAIT');
  assert.match(pc.nextAction(maker, at(54, 100000)).reason, /no longer be claimed/);

  // The user waits, then claims L1 once the preimage is public.
  const waiting = rec({ role: 'USER', stage: 'BOTH_FUNDED' });
  assert.equal(pc.nextAction(waiting, at(50, 100000)).action, 'WAIT');
  // Unclaimed past its deadline, the user recovers their own escrow.
  assert.equal(pc.nextAction(waiting, at(54, 100000)).action, 'REFUND_L2');

  const revealed = rec({ role: 'USER', stage: 'PREIMAGE_REVEALED' });
  const before = pc.nextAction(revealed, at(55, 100000));
  assert.equal(before.action, 'CLAIM_L1');
  assert.match(before.reason, /before height 100720/);
  // Past the L1 refund height the claim still exists but the urgency is stated honestly: the
  // L1 claim branch has no height condition, so it becomes a race against the funder's refund.
  const racing = pc.nextAction(revealed, at(55, 100720));
  assert.equal(racing.action, 'CLAIM_L1');
  assert.match(racing.reason, /racing them/);
});

test('settlement is recorded from a balance delta, not from a transaction id', () => {
  // In the exit route the USER receives L1 XTM, so their settlement is an L1 balance rise.
  const user = rec({ role: 'USER', stage: 'PREIMAGE_REVEALED', l1BaselineMicro: '500' });
  assert.equal(pc.reconcileSettlement(user, { l1BalanceMicro: '500' }).stage, 'PREIMAGE_REVEALED', 'no gain is not settlement');
  assert.equal(pc.reconcileSettlement(user, { l1BalanceMicro: '1000499' }).stage, 'PREIMAGE_REVEALED', 'a short gain is not settlement');
  assert.equal(pc.reconcileSettlement(user, { l1BalanceMicro: '1000500' }).stage, 'SETTLED');
  // Without a baseline there is nothing to compare, so nothing is claimed.
  assert.equal(pc.reconcileSettlement(rec({ role: 'USER', stage: 'PREIMAGE_REVEALED' }), { l1BalanceMicro: '9999999' }).stage, 'PREIMAGE_REVEALED');

  // The MAKER receives L2 TARI in that same route.
  const maker = rec({ role: 'MAKER', stage: 'BOTH_FUNDED', l2BaselineRaw: '0' });
  assert.equal(pc.reconcileSettlement(maker, { l2BalanceRaw: '1000000' }).stage, 'SETTLED');
  assert.equal(pc.reconcileSettlement(maker, { l2BalanceRaw: '999999' }).stage, 'BOTH_FUNDED');
});

test('terminal stages offer nothing further, and every stage describes itself', () => {
  for (const stage of pc.TERMINAL_STAGES) {
    const v = pc.nextAction(rec({ stage }), at(50, 100000));
    assert.equal(v.action, 'NOTHING', stage);
    assert.match(v.reason, /finished/);
    // A settled swap is never re-reconciled into a different stage.
    assert.equal(pc.reconcileSettlement(rec({ stage, l2BaselineRaw: '0' }), { l2BalanceRaw: '9' }).stage, stage);
  }
  // Every stage the machine can hold produces a non-empty description, so none renders blank.
  for (const stage of pc.SWAP_STAGES) {
    assert.ok(pc.describeSwap(rec({ stage }), at(50, 100000)).length > 0, stage);
  }
});
