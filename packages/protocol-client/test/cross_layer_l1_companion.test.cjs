/**
 * The L1 companion: what must be true before an L1 leg is funded, and what must be checked after.
 *
 * The test that matters most here is the sync gap. `send_sha_atomic_swap` locks the refund branch
 * at the WALLET'S scanned height + 720 — not the chain tip — so a wallet that is behind produces
 * an output that refunds early, shortening the claimant's window by exactly the gap. The funder
 * is not the party who loses, nothing in the wallet reports it, and the L2 deadline derived from
 * the tip would be wrong in the dangerous direction. That is why it is a gate, not a warning.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const HASH = '11'.repeat(32);
const DEST = '22'.repeat(32);
const SENDER = '33'.repeat(32);
const OUT = '44'.repeat(32);

const facts = (over = {}) => ({
  network: 'esmeralda',
  methodsAnswered: ['send', 'claim', 'refund'],
  isLedger: false,
  isViewOnly: false,
  tipHeight: 1000,
  scannedHeight: 1000,
  spendableMicroRaw: '10000000',
  ...over,
});

const intent = (over = {}) => ({
  network: 'esmeralda',
  direction: 'L2_TO_L1',
  role: 'MAKER',
  destinationAddress: '12Ab'.repeat(8),
  amountMicroRaw: '1000000',
  feePerGramRaw: '5',
  ...over,
});

test('capabilities are what the wallet ANSWERED, and a missing refund blocks funding outright', () => {
  const full = pc.assessCapabilities(facts());
  assert.deepEqual([...full.can].sort(), ['CLAIM', 'FUND', 'OBSERVE', 'REFUND']);
  assert.equal(full.complete, true);
  assert.deepEqual(full.cannot, []);

  // A wallet that cannot refund must not fund: the refund is the only way back if the
  // counterparty never claims, and it is the capability a plan forgets because it is only
  // needed when something goes wrong.
  const noRefund = pc.assessCapabilities(facts({ methodsAnswered: ['send', 'claim'] }));
  assert.equal(noRefund.complete, false);
  assert.match(noRefund.cannot.join(' '), /Do not fund an L1 escrow through this wallet/);
  const plan = pc.planL1Funding(intent(), facts({ methodsAnswered: ['send', 'claim'] }));
  assert.equal(plan.ok, false);
  assert.match(plan.refusal, /would leave no way back/);

  // A Ledger wallet cannot fund but can still receive, so it is a destination not a funder.
  const ledger = pc.assessCapabilities(facts({ isLedger: true }));
  assert.equal(ledger.can.includes('FUND'), false);
  assert.equal(ledger.can.includes('CLAIM'), true);
  assert.match(ledger.cannot.join(' '), /not implemented for Ledger keys upstream/);

  // A view-only wallet signs nothing, but observation is still a real capability: it is enough
  // to VERIFY a counterparty's leg, which is most of what makes a trade safe to enter.
  const viewOnly = pc.assessCapabilities(facts({ isViewOnly: true }));
  assert.deepEqual(viewOnly.can, ['OBSERVE']);
  assert.match(viewOnly.cannot.join(' '), /can still observe and verify/);
});

test('mainnet is refused, and so is any network this companion does not drive', () => {
  const main = pc.assessCapabilities(facts({ network: 'mainnet' }));
  assert.deepEqual(main.can, []);
  assert.equal(main.cannot[0], pc.L1_MAINNET_REFUSAL);
  assert.match(pc.L1_MAINNET_REFUSAL, /disposable Esmeralda/);
  assert.equal(pc.L1_APPROVED_NETWORKS.includes('mainnet'), false);

  const other = pc.assessCapabilities(facts({ network: 'nextnet' }));
  assert.match(other.cannot[0], /not one this companion drives/);

  // And a wallet on a different network from the trade is refused even when both are approved.
  const crossed = pc.planL1Funding(intent({ network: 'igor' }), facts({ network: 'esmeralda' }));
  assert.equal(crossed.ok, false);
  assert.match(crossed.refusal, /not recoverable by the other side's refund either/);
  assert.deepEqual(pc.L1_COMPANION_NEVER.length > 0, true);
  assert.match(pc.L1_COMPANION_NEVER.join(' '), /seed phrase, spend key or view key/);
});

test('THE SYNC GAP: a wallet behind the tip refunds early, and funding is gated on it', () => {
  const synced = pc.assessSync({ tipHeight: 1000, scannedHeight: 1000 });
  assert.equal(synced.ok, true);
  assert.equal(synced.gapBlocks, 0);
  assert.equal(synced.actualRefundHeight, 1720, 'scanned + 720');
  assert.equal(synced.intendedRefundHeight, 1720);

  // Inside the bound: allowed, but the cost is still stated rather than rounded away.
  const slight = pc.assessSync({ tipHeight: 1005, scannedHeight: 1000 });
  assert.equal(slight.ok, true);
  assert.equal(slight.actualRefundHeight, 1720);
  assert.equal(slight.intendedRefundHeight, 1725);
  assert.equal(slight.windowLostBlocks, 5);
  assert.match(slight.reason, /5 block\(s\) earlier than a tip-derived estimate/);

  // Past the bound: refused, with the arithmetic.
  const behind = pc.assessSync({ tipHeight: 1200, scannedHeight: 1000 });
  assert.equal(behind.ok, false);
  assert.equal(behind.windowLostBlocks, 200);
  assert.match(behind.reason, /200 blocks of the claimant's window gone, silently/);
  assert.equal(pc.planL1Funding(intent(), facts({ tipHeight: 1200 })).ok, false);
  assert.equal(pc.MAX_SYNC_GAP_BLOCKS, 10);

  // A scanned height ABOVE the tip is two reads disagreeing, not a head start.
  const impossible = pc.assessSync({ tipHeight: 1000, scannedHeight: 1001 });
  assert.equal(impossible.ok, false);
  assert.match(impossible.reason, /One of the two reads is wrong/);
});

test('a funding plan is a request to approve, and it names everything the wallet decides alone', () => {
  const plan = pc.planL1Funding(intent({ counterpartyLegMemo: 'leg:component_abc' }), facts());
  assert.equal(plan.ok, true);
  assert.equal(plan.request.amountMicroRaw, '1000000');
  // The memo is hex-encoded UTF-8, without Buffer, because this module is in the browser bundle.
  assert.equal(plan.request.rawPaymentIdHex, Buffer.from('leg:component_abc', 'utf8').toString('hex'));
  // The three things a caller might think it controls, stated so it does not add them back.
  const says = plan.notControllable.join(' ');
  assert.match(says, /The hash lock is not an input/);
  assert.match(says, /refund height is not an input/);
  assert.match(says, /UTXO selection is not an input/);
  assert.match(plan.review, /You cannot recover it before that height/);
  assert.match(plan.review, /1720/);

  // The validation that cannot be undone after funding.
  assert.match(pc.planL1Funding(intent({ amountMicroRaw: '0' }), facts()).refusal, /cannot be claimed/);
  assert.match(pc.planL1Funding(intent({ feePerGramRaw: '0' }), facts()).refusal, /must be positive/);
  assert.match(pc.planL1Funding(intent({ destinationAddress: '  ' }), facts()).refusal, /destination address is required/);
  assert.match(pc.planL1Funding(intent({ amountMicroRaw: '10000001' }), facts()).refusal, /cannot fund/);
  assert.match(pc.planL1Funding(intent({ counterpartyLegMemo: 'x'.repeat(129) }), facts()).refusal, /at most 128 characters/);
  assert.match(pc.planL1Funding(intent({ amountMicroRaw: '1.5' }), facts()).refusal, /raw non-negative integer/);
});

test('the script is rendered as EXPECTED, never as evidence, and both outcomes are named', () => {
  const params = { hashLockHex: HASH, destinationPublicKeyHex: DEST, senderPublicKeyHex: SENDER, refundHeight: 1720 };
  const script = pc.expectedScript(params);
  // Exactly the shape send_sha_atomic_swap_transaction builds in tari 6.3.0-pre.2.
  assert.equal(
    script,
    `HashSha256 PushHash(${HASH}) Equal IfThen   PushPubKey(${DEST}) Else   CheckHeightVerify(1720)   PushPubKey(${SENDER}) EndIf`,
  );
  const line = pc.describeScript(params);
  assert.match(line, /CLAIM:/);
  assert.match(line, /REFUND: from height 1720/);
  // The L1 race is stated, because the L2 template deliberately does not have it.
  assert.match(line, /a late claim races the refund/);
  // A script with one party on both branches has only one outcome, so it is not an HTLC.
  assert.throws(() => pc.expectedScript({ ...params, destinationPublicKeyHex: SENDER }), /must be different keys/);
  assert.throws(() => pc.expectedScript({ ...params, hashLockHex: 'nope' }), /64 hex/);
});

test('an unreadable script field is UNVERIFIED, which is not the same as passing', () => {
  // The distinction this function exists for. A companion that cannot read an output's script
  // has not checked the hash lock, and calling that a pass would let a counterparty fund their
  // leg against an output whose claim branch commits to a different secret.
  const expected = { outputHashHex: OUT, amountMicroRaw: '1000000', hashLockHex: HASH, destinationPublicKeyHex: DEST, refundHeight: 1720, minConfirmations: 3 };
  const blind = pc.verifyFundedOutput({ outputHashHex: OUT, amountMicroRaw: '1000000', confirmations: 5 }, expected);
  assert.equal(blind.confirmed, false);
  assert.deepEqual(blind.mismatches, []);
  assert.equal(blind.unverified.length, 3);
  assert.match(blind.unverified.join(' '), /Do not fund the other leg on the strength of this read/);

  const full = pc.verifyFundedOutput(
    { outputHashHex: OUT, amountMicroRaw: '1000000', confirmations: 3, scriptHashLockHex: HASH, scriptDestinationPublicKeyHex: DEST, scriptRefundHeight: 1720 },
    expected,
  );
  assert.equal(full.confirmed, true);
  assert.match(full.reason, /has 3 confirmations/);

  // Too few confirmations is unverified, not confirmed: it can still be reorganised out.
  const shallow = pc.verifyFundedOutput(
    { outputHashHex: OUT, amountMicroRaw: '1000000', confirmations: 2, scriptHashLockHex: HASH, scriptDestinationPublicKeyHex: DEST, scriptRefundHeight: 1720 },
    expected,
  );
  assert.equal(shallow.confirmed, false);
  assert.match(shallow.unverified.join(' '), /can still be reorganised out/);
});

test('every way an observed output can be the wrong output is a mismatch with the reason', () => {
  const expected = { outputHashHex: OUT, amountMicroRaw: '1000000', hashLockHex: HASH, destinationPublicKeyHex: DEST, refundHeight: 1720, minConfirmations: 1 };
  const good = { outputHashHex: OUT, amountMicroRaw: '1000000', confirmations: 3, scriptHashLockHex: HASH, scriptDestinationPublicKeyHex: DEST, scriptRefundHeight: 1720 };

  assert.match(pc.verifyFundedOutput({ ...good, amountMicroRaw: '999999' }, expected).mismatches.join(' '), /A claim takes the whole output/);
  assert.match(pc.verifyFundedOutput({ ...good, scriptHashLockHex: '99'.repeat(32) }, expected).mismatches.join(' '), /does not open the other/);
  assert.match(pc.verifyFundedOutput({ ...good, scriptDestinationPublicKeyHex: '88'.repeat(32) }, expected).mismatches.join(' '), /pays somebody else/);
  assert.match(pc.verifyFundedOutput({ ...good, outputHashHex: '77'.repeat(32) }, expected).mismatches.join(' '), /not the .* the trade names/);
  assert.match(pc.verifyFundedOutput({ ...good, spent: true }, expected).mismatches.join(' '), /already been spent/);

  // An EARLIER refund height is the dangerous direction: the funder can take it back inside the
  // margin that was meant to protect the claimant. A later one is safe but still means the
  // deadlines were derived from a different output.
  assert.match(pc.verifyFundedOutput({ ...good, scriptRefundHeight: 1520 }, expected).mismatches.join(' '), /200 blocks EARLIER/);
  assert.match(pc.verifyFundedOutput({ ...good, scriptRefundHeight: 1800 }, expected).mismatches.join(' '), /lengthens the claim window/);

  // An output holding MORE than agreed is fine: a claim takes the whole output.
  assert.equal(pc.verifyFundedOutput({ ...good, amountMicroRaw: '1000001' }, expected).confirmed, true);
});

test('a refund is planned against the OBSERVED height, not the intended one', () => {
  const observed = { outputHashHex: OUT, amountMicroRaw: '1000000', confirmations: 10, scriptRefundHeight: 1720 };
  assert.match(pc.planRefund(observed, 1719, '5').refusal, /1 block\(s\) to go/);
  const ok = pc.planRefund(observed, 1720, '5');
  assert.equal(ok.ok, true);
  assert.equal(ok.request.outputHashHex, OUT);
  // The L1 race is stated here too: the claim branch has no height condition.
  assert.match(ok.review, /can still race this refund until it confirms/);

  // Without a readable refund height there is no way to tell whether a refund is accepted yet,
  // and a premature attempt tells the counterparty you are trying.
  assert.match(pc.planRefund({ outputHashHex: OUT, amountMicroRaw: '1', confirmations: 1 }, 99999, '5').refusal, /tells the counterparty you are trying/);
  assert.match(pc.planRefund({ ...observed, spent: true }, 1720, '5').refusal, /Read its spending transaction/);
  assert.match(pc.planRefund(observed, 1720, '0').refusal, /must be positive/);
});

test('a claim plan says what revealing the secret costs, and refuses a spent output', () => {
  const observed = { outputHashHex: OUT, amountMicroRaw: '1000000', confirmations: 5 };
  const plan = pc.planClaim(observed, '5');
  assert.equal(plan.ok, true);
  assert.match(plan.review, /Revealing it makes it public/);
  assert.match(plan.review, /Claim the LATER-expiring leg only once your own is safe/);
  assert.match(pc.planClaim({ ...observed, spent: true }, '5').refusal, /still yours to recover after its deadline/);
  // The plan carries no secret: the caller supplies it at the moment of signing.
  assert.deepEqual(Object.keys(plan.request).sort(), ['feePerGramRaw', 'outputHashHex']);
});

test('an ambiguous submission is UNKNOWN, and UNKNOWN forbids a retry before a chain read', () => {
  // The case that costs money. A transport that failed AFTER the wallet accepted a transaction
  // looks exactly like one that failed before; calling that "failed" and retrying spends twice.
  const accepted = pc.classifySubmission({ parsed: { transactionId: '7', isSuccess: true }, requestSent: true });
  assert.equal(accepted.outcome, 'CONFIRMED');
  assert.match(accepted.reason, /Accepted is not confirmed/);
  assert.equal(accepted.mustCheckChainBeforeRetry, false);

  const refused = pc.classifySubmission({ parsed: { transactionId: '0', isSuccess: false, failureMessage: 'insufficient funds' }, requestSent: true });
  assert.equal(refused.outcome, 'REFUSED');
  assert.equal(refused.mustCheckChainBeforeRetry, false);

  const neverSent = pc.classifySubmission({ transportError: 'ECONNREFUSED', requestSent: false });
  assert.equal(neverSent.outcome, 'REFUSED');
  assert.match(neverSent.reason, /never reached the wallet/);
  assert.equal(neverSent.mustCheckChainBeforeRetry, false);

  const ambiguous = pc.classifySubmission({ transportError: 'socket hang up', requestSent: true });
  assert.equal(ambiguous.outcome, 'UNKNOWN');
  assert.equal(ambiguous.mustCheckChainBeforeRetry, true);
  assert.match(ambiguous.reason, /UNKNOWN, not failed/);
  assert.match(ambiguous.reason, /spends twice/);

  const silent = pc.classifySubmission({ requestSent: true });
  assert.equal(silent.outcome, 'UNKNOWN');
  assert.equal(silent.mustCheckChainBeforeRetry, true);
});

test('settlement is a balance delta, never a transaction id', () => {
  const settled = pc.reconcileL1Settlement({ baselineMicroRaw: '500', observedMicroRaw: '1000500', expectedMicroRaw: '1000000' });
  assert.equal(settled.settled, true);
  assert.equal(settled.gainedMicroRaw, '1000000');

  const nothing = pc.reconcileL1Settlement({ baselineMicroRaw: '500', observedMicroRaw: '500', expectedMicroRaw: '1000000' });
  assert.equal(nothing.settled, false);
  assert.match(nothing.reason, /whatever any transaction id says/);

  // A partial arrival is a different payment: a claim takes a whole output.
  const partial = pc.reconcileL1Settlement({ baselineMicroRaw: '500', observedMicroRaw: '600500', expectedMicroRaw: '1000000' });
  assert.equal(partial.settled, false);
  assert.match(partial.reason, /partial arrival is not a settlement/);

  // A balance that FELL is not a negative gain to be reported as progress.
  const fell = pc.reconcileL1Settlement({ baselineMicroRaw: '1000', observedMicroRaw: '400', expectedMicroRaw: '100' });
  assert.equal(fell.settled, false);
  assert.equal(fell.gainedMicroRaw, '0');
});

test('what each role needs on L1 includes the refund, and the funder is forced by the direction', () => {
  // The L1 funder is always the secret holder, because L1 generates the preimage.
  assert.deepEqual([...pc.requiredL1Capabilities('L2_TO_L1', 'MAKER')].sort(), ['FUND', 'OBSERVE', 'REFUND']);
  assert.deepEqual([...pc.requiredL1Capabilities('L2_TO_L1', 'USER')].sort(), ['CLAIM', 'OBSERVE']);
  assert.deepEqual([...pc.requiredL1Capabilities('L1_TO_L2', 'USER')].sort(), ['FUND', 'OBSERVE', 'REFUND']);
  assert.deepEqual([...pc.requiredL1Capabilities('L1_TO_L2', 'MAKER')].sort(), ['CLAIM', 'OBSERVE']);
});

test('only the public parts of a funding are publishable', () => {
  const published = pc.publishableFunding(
    { transactionId: '7', preImageHex: 'ab'.repeat(32), outputHashHex: OUT },
    '1000000',
    1720,
  );
  assert.deepEqual(Object.keys(published).sort(), ['amountMicroRaw', 'outputHashHex', 'refundHeight']);
  // The whole protocol rests on the funder revealing the secret only by claiming.
  assert.equal(JSON.stringify(published).includes('ab'.repeat(32)), false);
  pc.assertNoPreimage(published);
});
