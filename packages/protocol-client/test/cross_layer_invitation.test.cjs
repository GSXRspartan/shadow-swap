/**
 * Direct-invitation discovery, and the property that makes it safe to accept one from anyone:
 * an invitation is UNTRUSTED INPUT and is never the source of terms. The taker acts on a chain
 * read, so a forged invitation can waste their time but must never move their funds.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const HASH = 'cc'.repeat(32);
const INV = {
  v: 1,
  swapId: 'swap-abc',
  direction: 'L2_TO_L1',
  network: 'esmeralda',
  generation: 'V048_RESET',
  makerL2PublicKey: 'bb'.repeat(32),
  makerL1Address: 'tari1maker',
  fundedLeg: 'aa'.repeat(32),
  hashLockHex: HASH,
  l2RawAmount: '1000000',
  l1MicroAmount: '1010000',
  minFillRaw: '1000',
  maxFillRaw: '1000000',
  l2ExpiresAtEpoch: 54,
  l1RefundHeight: 100720,
};
const inv = (over = {}) => ({ ...INV, ...over });
const CHAIN = {
  leg: 'aa'.repeat(32),
  chain: 'L1',
  hashLockHex: HASH,
  amountRaw: '1010000',
  claimantOrDestination: 'tari1user',
  refundHeight: 100720,
  settled: false,
};
const chain = (over = {}) => ({ ...CHAIN, ...over });
const ctx = (over = {}) => ({ network: 'esmeralda', generation: 'V048_RESET', ...over });

test('an invitation round-trips through its own text form, and nothing else is accepted', () => {
  const text = pc.encodeCrossLayerInvitation(INV);
  assert.ok(text.startsWith(pc.CROSS_LAYER_INVITATION_PREFIX));
  assert.deepEqual(pc.parseCrossLayerInvitation(text), INV);
  assert.deepEqual(pc.parseCrossLayerInvitation(`  ${text}\n`), INV, 'surrounding whitespace is tolerated');

  for (const [what, bad] of [
    ['no prefix', JSON.stringify(INV)],
    ['wrong prefix', 'shadowswap-offer:v1:' + JSON.stringify(INV)],
    ['prefix with no JSON', pc.CROSS_LAYER_INVITATION_PREFIX + 'not json'],
    ['empty', ''],
  ]) {
    assert.throws(() => pc.parseCrossLayerInvitation(bad), pc.CrossLayerInvitationError, what);
  }
  // Bounded, so an import cannot push an unbounded blob into storage or a UI.
  assert.throws(
    () => pc.parseCrossLayerInvitation(pc.CROSS_LAYER_INVITATION_PREFIX + 'x'.repeat(pc.CROSS_LAYER_INVITATION_MAX_CHARS)),
    /at most 4096 characters/,
  );
});

test('a funded leg and a hash lock must come together — one without the other proves nothing', () => {
  // A funded leg with no hash cannot be bound to; a hash with no funded leg is a promise.
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ hashLockHex: undefined })), /must be given together/);
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ fundedLeg: undefined })), /must be given together/);
  // Neither is the indicative case, which is allowed but not actionable (asserted below).
  const indicative = pc.validateCrossLayerInvitation(inv({ fundedLeg: undefined, hashLockHex: undefined }));
  assert.equal(indicative.fundedLeg, undefined);
});

test('an indicative invitation is never actionable, however well-formed', () => {
  const v = pc.verifyCrossLayerInvitation(
    pc.validateCrossLayerInvitation(inv({ fundedLeg: undefined, hashLockHex: undefined })),
    chain(),
    ctx(),
  );
  assert.equal(v.actionable, false);
  assert.match(v.blockers.join(' '), /names no funded escrow, so nothing on chain backs it/);
});

test('the chain read wins: every way a maker could forge the invitation is caught', () => {
  const good = pc.verifyCrossLayerInvitation(INV, chain(), ctx());
  assert.equal(good.actionable, true);
  assert.deepEqual(good.mismatches, []);
  // The terms to act on are the chain's, returned so a UI cannot accidentally show the invitation's.
  assert.deepEqual(good.chain, chain());

  // A hash the maker's preimage would not open.
  const wrongHash = pc.verifyCrossLayerInvitation(inv({ hashLockHex: '99'.repeat(32) }), chain(), ctx());
  assert.equal(wrongHash.actionable, false);
  assert.match(wrongHash.mismatches.join(' '), /would not open this escrow/);

  // Promising more than the escrow holds.
  const short = pc.verifyCrossLayerInvitation(INV, chain({ amountRaw: '1009999' }), ctx());
  assert.match(short.mismatches.join(' '), /below the 1010000 this invitation promises/);

  // Funding the wrong chain for the direction: for an exit the maker must fund L1.
  const wrongChain = pc.verifyCrossLayerInvitation(INV, chain({ chain: 'L2' }), ctx());
  assert.match(wrongChain.mismatches.join(' '), /must fund on L1/);

  // Naming a leg other than the one actually read.
  const otherLeg = pc.verifyCrossLayerInvitation(inv({ fundedLeg: 'ee'.repeat(32) }), chain(), ctx());
  assert.match(otherLeg.mismatches.join(' '), /names leg/);

  // Deadlines that disagree with the escrow's own.
  assert.match(
    pc.verifyCrossLayerInvitation(inv({ l1RefundHeight: 99999 }), chain(), ctx()).mismatches.join(' '),
    /L1 refund height/,
  );
});

test('network and generation are bound: an invitation never crosses either', () => {
  assert.match(
    pc.verifyCrossLayerInvitation(inv({ network: 'localnet' }), chain(), ctx()).mismatches.join(' '),
    /is for network localnet, your wallet is on esmeralda/,
  );
  assert.match(
    pc.verifyCrossLayerInvitation(inv({ generation: 'PRE_V048_RESET' }), chain(), ctx()).mismatches.join(' '),
    /deployment generation PRE_V048_RESET/,
  );
});

test('spent, expired and already-acted-on offers are blocked', () => {
  assert.match(pc.verifyCrossLayerInvitation(INV, chain({ settled: true }), ctx()).blockers.join(' '), /already been claimed or refunded/);

  // Past the L2 deadline, funding would create an escrow refundable before claimable.
  const late = pc.verifyCrossLayerInvitation(INV, chain(), ctx({ l2CurrentEpoch: 54 }));
  assert.equal(late.actionable, false);
  assert.match(late.blockers.join(' '), /refundable before it could be claimed/);

  // The maker's own L1 escrow already refundable means they could pull it at any moment.
  assert.match(
    pc.verifyCrossLayerInvitation(INV, chain(), ctx({ l1TipHeight: 100720 })).blockers.join(' '),
    /could recover it at any moment/,
  );

  // Duplicate-fill prevention by identity.
  const dup = pc.verifyCrossLayerInvitation(INV, chain(), ctx({ seenSwapIds: ['swap-abc'] }));
  assert.equal(dup.actionable, false);
  assert.match(dup.blockers.join(' '), /already acted on swap swap-abc/);
  assert.match(dup.blockers.join(' '), /could fund or claim twice/);
});

test('an L2-funded entry offer must name THIS taker as its claimant', () => {
  const entry = inv({ direction: 'L1_TO_L2' });
  const l2Leg = chain({ chain: 'L2', claimantOrDestination: 'dd'.repeat(32), expiresAtEpoch: 54, refundHeight: undefined, amountRaw: '1000000' });
  // A maker who escrowed to someone else's key has given the taker nothing they can claim.
  const wrong = pc.verifyCrossLayerInvitation(entry, l2Leg, ctx({ takerL2PublicKey: 'ff'.repeat(32) }));
  assert.equal(wrong.actionable, false);
  assert.match(wrong.mismatches.join(' '), /not your account key. You could not claim it/);
  // The matching key verifies.
  const right = pc.verifyCrossLayerInvitation(entry, l2Leg, ctx({ takerL2PublicKey: 'dd'.repeat(32) }));
  assert.equal(right.actionable, true);
});

test('an unsigned invitation warns, and the four-transaction reality is always stated', () => {
  const unsigned = pc.verifyCrossLayerInvitation(INV, chain(), ctx());
  assert.match(unsigned.warnings.join(' '), /unsigned, so it proves nothing about who wrote it/);
  assert.match(unsigned.warnings.join(' '), /What protects you is the chain read/);
  // Signed or not, the taker is told what they are entering.
  assert.match(unsigned.warnings.join(' '), /four transactions across two chains/);
  assert.match(unsigned.warnings.join(' '), /recoverable only AFTER its deadline/);
  const signed = pc.verifyCrossLayerInvitation(inv({ signature: 'abcd' }), chain(), ctx());
  assert.doesNotMatch(signed.warnings.join(' '), /unsigned/);
  // A signature covers a canonical form with sorted keys, so it is over stable bytes.
  const a = pc.canonicalInvitationJson(inv({ signature: 'x' }));
  const b = pc.canonicalInvitationJson(inv({ signature: 'y' }));
  assert.equal(a, b, 'the signature itself is excluded from what it signs');
});

test('amounts are raw integers and sizes are coherent', () => {
  for (const bad of [{ l2RawAmount: '1.5' }, { l1MicroAmount: '-1' }, { minFillRaw: 'x' }]) {
    assert.throws(() => pc.validateCrossLayerInvitation(inv(bad)), /raw non-negative integer/);
  }
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ l2RawAmount: '0' })), /must be positive/);
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ minFillRaw: '0' })), /minFillRaw must be positive/);
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ maxFillRaw: '10', minFillRaw: '20' })), /at least minFillRaw/);
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ l2ExpiresAtEpoch: 0 })), /positive integer/);
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ direction: 'SIDEWAYS' })), /L2_TO_L1 or L1_TO_L2/);
  assert.throws(() => pc.validateCrossLayerInvitation(inv({ v: 2 })), /Unsupported invitation version/);
  for (const bad of [null, [], 'text', 42]) {
    assert.throws(() => pc.validateCrossLayerInvitation(bad), /must be a JSON object/);
  }
});
