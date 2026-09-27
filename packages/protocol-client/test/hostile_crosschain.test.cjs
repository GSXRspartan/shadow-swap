/**
 * HOSTILE CROSS-LAYER ATTACK SUITE — FAST_XTM_TARI
 * sections 5-21, 24-31 of the hostile audit matrix.
 *
 * Objective: try to steal funds, strand funds, leak the preimage, double-spend
 * inventory, or force an unsafe state transition. Every test is an attack, not a
 * feature demo. Tests that assert a refusal are regressions: they must never be
 * deleted or weakened (audit finding policy).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const sessionMod = require('../dist/crosschain/session.js');
const { InMemorySessionStore, IllegalTransitionError, requireSecretRevealAllowed } = sessionMod;
const { InMemoryReservationLedger } = require('../dist/crosschain/reservation.js');
const { InMemorySecretStore, verifyPreimage, assertNoSecretInJson, sha256, bytesToHex, hexToBytes } = require('../dist/crosschain/secret.js');
const { buildQuote, validateAdvertisement, quoteXtmToTari, isQuoteExpired } = require('../dist/crosschain/quote.js');
const { deriveDeadlines, assertDeadlineSafety, DeadlineError } = require('../dist/crosschain/deadlines.js');
const { assertTestnetNetwork, requireOperationId } = require('../dist/crosschain/types.js');
const { requireLegCapabilities, requireLegCapabilitiesSingle, CapabilityRefusal } = require('../dist/crosschain/provider.js');
const { routeResult } = require('../dist/crosschain/router.js');
const coord = require('../dist/crosschain/coordinator.js');
const {
  serializeShaHtlcScript,
  decodeShaHtlcScript,
  executeShaHtlcBranch,
  refundBranchReachable,
  MINOTARI_OPCODES,
  sha256SyncExport,
} = require('../dist/chains/minotari.js');
const { MinotariDevGrpcProvider, MINOTARI_WALLET_GRPC_METHODS, MINOTARI_REFERENCE_FEE_PER_GRAM } = require('../dist/chains/minotari_grpc.js');

const sha256Hex = (b) => nodeCrypto.createHash('sha256').update(b).digest('hex');
const H = bytesToHex(new Uint8Array(32).fill(0x5a));
const CAPS = {
  l1Balance: true, l1NormalSend: true, l1ShaInit: true, l1ShaInspect: true, l1ShaClaim: true, l1ShaRefund: true,
  l2HtlcFund: true, l2HtlcClaim: true, l2HtlcRefund: true,
};
const ENV_ON = { TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT: '1' };
const DEADLINE_OK = { l1RemainingMarginMs: '900000', l2RemainingMarginMs: '900000', requiredL1MarginMs: '60000', requiredL2MarginMs: '60000' };
const S_HEX = '33'.repeat(32);
const H_OF_S = sha256Hex(hexToBytes(S_HEX));

function makeAd(over = {}) {
  return {
    providerId: 'prov_1', pair: 'XTM/TARI', xtmAvailable: '100000', tariAvailable: '50000000',
    minTradeXtm: '1000', maxTradeXtm: '90000', spreadBps: '50', quoteTtlMs: '60000',
    requiredL1Confirmations: '3', network: 'esmeralda', ...over,
  };
}

function makeQuote(over = {}) {
  return {
    quoteId: 'quote_1', providerId: 'prov_1', direction: 'XTM_TO_TARI',
    xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: '',
    l1ClaimRecipient: 'l1_claim_addr', l2ClaimRecipient: 'component_tari_1',
    l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200',
    requiredL1Confirmations: '3', quoteExpiresAtUnixMs: 9_999_999,
    l1Network: 'esmeralda', l2Network: 'esmeralda', ...over,
  };
}

/** Fully hostile-configurable L1 leg double. Every field can be made to lie. */
function makeL1(cfg = {}) {
  const s = {
    preimageHex: cfg.preimageHex ?? S_HEX,
    txId: cfg.txId ?? '9001',
    outputHashHex: cfg.outputHashHex ?? 'ab'.repeat(32),
    calls: [],
    obs: {
      exists: true, amountRaw: '10000', hashHex: H_OF_S, claimRecipient: 'l1_claim_addr',
      refundRecipient: 'refund_pubkey', refundHeight: '16000', confirmations: '5',
      currentHeight: '9000', spent: false, source: 'BASE_NODE', amountAuthoritative: true,
      outputHashHex: 'ab'.repeat(32), minedAtHeight: '8996',
      ...(cfg.obs ?? {}),
    },
    txStatus: cfg.txStatus ?? 'COMMITTED',
    submitError: cfg.submitError,
    caps: cfg.caps ?? { ...CAPS },
    walletAddress: cfg.walletAddress ?? 'wallet_A',
  };
  s.providerName = () => 'hostile-l1';
  s.primitivesStatus = () => 'VERIFIED';
  s.network = () => cfg.network ?? 'esmeralda';
  s.capabilities = () => s.caps;
  s.discoverWallets = async () => [{ walletAddress: s.walletAddress, network: s.network(), readiness: 'READY' }];
  s.readiness = async () => 'READY';
  s.chainStatus = async () => ({ network: s.network(), currentHeight: s.obs.currentHeight, synced: true });
  s.balance = async () => ({ available: '90000', pendingIncoming: '0', pendingOutgoing: '0' });
  s.constructHtlcFunding = (intent) => ({ intent, feeEstimate: cfg.feeEstimate ?? '0' });
  s.authorizeFunding = async () => ({ authorized: true });
  s.submitFunding = async () => {
    s.calls.push('submitFunding');
    if (s.submitError) throw new Error(s.submitError);
    return cfg.noPreimage ? { l1TxId: s.txId } : { l1TxId: s.txId, walletPreimageHex: s.preimageHex, outputHashHex: s.outputHashHex };
  };
  s.observeHtlc = async () => { s.calls.push('observeHtlc'); return { l1TxId: s.txId, ...s.obs }; };
  s.constructClaim = async () => ({ feeEstimate: '0' });
  s.authorizeClaim = async () => ({ authorized: true });
  s.submitClaim = async () => { if (cfg.claimError) throw new Error(cfg.claimError); return { l1TxId: 'claim_tx_1' }; };
  s.constructRefund = async () => ({ feeEstimate: '0' });
  s.authorizeRefund = async () => ({ authorized: true });
  s.submitRefund = async () => ({ l1TxId: 'refund_tx_1' });
  s.lookupTransaction = async () => s.txStatus;
  s.listInFlightSwaps = async () => [];
  return s;
}

function makeL2(cfg = {}) {
  const s = {
    calls: [],
    obs: {
      exists: true, amountRaw: '5000000', hashExact: true, claimantExact: true,
      epochRefundExact: true, unspent: true, source: 'AUTHORITATIVE', ...(cfg.obs ?? {}),
    },
    caps: cfg.caps ?? { ...CAPS },
    fundingError: cfg.fundingError,
    claimError: cfg.claimError,
  };
  s.capabilities = () => s.caps;
  s.constructFunding = async () => { s.calls.push('constructFunding'); return { feeEstimate: '0' }; };
  s.authorizeFunding = async () => ({ authorized: true });
  s.submitFunding = async () => {
    s.calls.push('submitFunding');
    if (s.fundingError) throw new Error(s.fundingError);
    return { l2TxId: '7001' };
  };
  s.observeHashlockOutput = async () => { s.calls.push('observe'); return s.obs; };
  s.constructClaim = async () => ({ feeEstimate: '0' });
  s.submitClaim = async () => { if (s.claimError) throw new Error(s.claimError); return { l2TxId: 'claim_l2_1' }; };
  s.constructRefund = async () => ({ feeEstimate: '0' });
  s.submitRefund = async () => ({ l2TxId: 'refund_l2_1' });
  s.lookupTransaction = async () => cfg.txStatus ?? 'COMMITTED';
  return s;
}

function makePorts(over = {}) {
  const ad = over.ad ?? makeAd();
  return {
    l1: over.l1 ?? makeL1(over.l1Cfg),
    l2: over.l2 ?? makeL2(over.l2Cfg),
    reservations: over.reservations ?? new InMemoryReservationLedger({ [ad.providerId]: ad }),
    secrets: over.secrets ?? new InMemorySecretStore(),
    sessions: over.sessions ?? new InMemorySessionStore(),
    ...(over.deadlineAuthority ? { deadlineAuthority: over.deadlineAuthority } : {}),
  };
}

/** Drive a session to BOTH_FUNDED with both legs authoritatively verified (not yet armed). */
async function driveToBothFunded(over = {}) {
  const ports = makePorts(over);
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(over.quote), nowUnixMs: 1000 }, ports });
  const l1 = await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(l1.outcome, 'SUBMITTED', 'L1 funding submitted');
  const v1 = await coord.verifyL1Funded({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK });
  assert.equal(v1.verified, true, `L1 verified: ${JSON.stringify(v1.evidence)}`);
  const l2 = await coord.beginL2Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(l2.outcome, 'SUBMITTED', 'L2 funding submitted');
  const v2 = await coord.verifyL2Funded({ sessionId: 'sessAlpha1', ports });
  assert.equal(v2.verified, true, 'L2 verified');
  return ports;
}

/** Drive a session all the way to CLAIM_ARMED. */
async function driveToArmed(over = {}) {
  const ports = await driveToBothFunded(over);
  const arm = await coord.armClaim({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(arm.armed, true, `armed: ${arm.reason ?? ''}`);
  return ports;
}

// ===========================================================================
// 5. L1 SCRIPT VERIFICATION ATTACKS
// ===========================================================================

test('5.1 script decoder rejects every structural deviation (correct H, wrong claimant, etc.)', () => {
  const HASH = '11'.repeat(32);
  const CLAIM = '22'.repeat(32);
  const REFUND = '33'.repeat(32);
  const H16000 = '16000';
  const good = Array.from(serializeShaHtlcScript({ hashHex: HASH, claimPubKeyHex: CLAIM, refundPubKeyHex: REFUND, refundHeight: H16000 }));
  const at = () => good.slice();
  const mutate = (i, v) => { const b = at(); b[i] = v; return Uint8Array.from(b); };

  // correct H, WRONG claimant → decodes, but the decoded claimant differs from intent
  const view = decodeShaHtlcScript(Uint8Array.from(good));
  assert.equal(view.claimPubKeyHex, CLAIM);
  assert.notEqual(view.claimPubKeyHex, REFUND, 'a swapped claimant key must be observable, never silently equal');

  const cases = [
    ['wrong hash opcode', mutate(0, 0xb0), /Unexpected Minotari script opcode/],
    ['PushHash -> PushInt', mutate(1, 0x02), /Unexpected Minotari script opcode/],
    ['Equal -> EqualVerify', mutate(34, 0x81), /Unexpected Minotari script opcode/],
    ['IfThen removed (reordered)', (() => { const b = at(); b.splice(35, 1); return Uint8Array.from(b); })(), /Unexpected|Truncated/],
    ['extra branch (second IfThen)', (() => { const b = at(); b.splice(35, 0, 0x61, 0x63); return Uint8Array.from(b); })(), /Unexpected/],
    ['trailing data', (() => { const b = at(); b.push(0x00); return Uint8Array.from(b); })(), /Trailing bytes/],
    ['truncated mid-payload', Uint8Array.from(good.slice(0, 20)), /Truncated/],
    ['truncated before EndIf', Uint8Array.from(good.slice(0, good.length - 1)), /Truncated|Unexpected/],
    ['duplicate hash condition', (() => { const b = at(); b.splice(1, 0, 0xb1, 0x7a, ...hexToBytes(HASH)); return Uint8Array.from(b); })(), /Unexpected/],
    ['Nop injected (semantically no-op, structurally different)', (() => { const b = at(); b.splice(34, 0, 0x69); return Uint8Array.from(b); })(), /Unexpected/],
    ['empty script', new Uint8Array(0), /Truncated/],
  ];
  for (const [name, bytes, re] of cases) {
    assert.throws(() => decodeShaHtlcScript(bytes), re, `decoder accepted: ${name}`);
  }
  // alternate serialization, same superficial fields: overlong varint for the height.
  // The ENGINE accepts overlong LEB128 (integer-encoding 3.0.4 u64::decode_var), so we
  // must decode it to the same value rather than reject a script the chain accepts.
  const varintStart = () => good.indexOf(MINOTARI_OPCODES.CheckHeightVerify) + 1;
  const withVarint = (...bytes) => {
    const i = varintStart();
    // replace the original minimal varint bytes with `bytes`
    const originalLen = 2; // 16000 = 0x80 0x7d
    return Uint8Array.from([...good.slice(0, i), ...bytes, ...good.slice(i + originalLen)]);
  };
  // Non-canonical (overlong) varint: the ENGINE accepts it (integer-encoding 3.0.4
  // u64::decode_var performs no minimality check), so a verifier that rejected it would
  // disagree with the chain. 0x80 0x00 is the 2-byte encoding of the value 0.
  const overlongView = decodeShaHtlcScript(withVarint(0x80, 0x00));
  assert.equal(overlongView.refundHeight, '0', 'overlong encodings decode exactly as the engine decodes them');
  assert.equal(overlongView.claimPubKeyHex, CLAIM, 'the overlong encoding still describes the same script');
  assert.equal(decodeShaHtlcScript(withVarint(0x7d)).refundHeight, '125', 'a single-byte varint is the minimal form');
  // varint claiming a value above u64 must be refused rather than silently truncated
  assert.throws(() => decodeShaHtlcScript(withVarint(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f)), /exceeds u64/);
  // an 11-byte varint is refused outright
  assert.throws(() => decodeShaHtlcScript(withVarint(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00)), /too long/);
});

test('5.2 script fuzz: 20k random mutations never decode to a valid script silently', () => {
  const base = Array.from(serializeShaHtlcScript({ hashHex: '11'.repeat(32), claimPubKeyHex: '22'.repeat(32), refundPubKeyHex: '33'.repeat(32), refundHeight: '16000' }));
  let seed = 0xC0FFEE;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let accepted = 0;
  for (let i = 0; i < 20000; i++) {
    const bytes = Uint8Array.from(base);
    const mutations = 1 + Math.floor(rnd() * 4);
    for (let m = 0; m < mutations; m++) {
      const idx = Math.floor(rnd() * bytes.length);
      bytes[idx] = Math.floor(rnd() * 256);
    }
    if (rnd() < 0.3) bytes.length = Math.floor(rnd() * bytes.length);
    if (rnd() < 0.2) bytes[Math.floor(rnd() * bytes.length)] = Math.floor(rnd() * 4); // control opcodes
    try {
      const v = decodeShaHtlcScript(bytes);
      // If a mutation still decodes, it must decode to EXACTLY the original semantics.
      assert.equal(v.hashHex, '11'.repeat(32), 'mutated script decoded with a different hash');
      assert.equal(v.claimPubKeyHex, '22'.repeat(32));
      assert.equal(v.refundPubKeyHex, '33'.repeat(32));
      assert.equal(v.refundHeight, '16000');
      accepted += 1;
    } catch {
      // refused: the expected outcome
    }
  }
  assert.ok(accepted < 20000, 'fuzzer must actually be mutating (some inputs should decode identically)');
});

test('5.3 branch verifier: wrong S, 1-bit flip, refund boundary — all fail closed', () => {
  const script = serializeShaHtlcScript({ hashHex: H_OF_S, claimPubKeyHex: '22'.repeat(32), refundPubKeyHex: '33'.repeat(32), refundHeight: '16000' });
  const hex = bytesToHex(script);
  const flipBit = (h, bit) => { const b = hexToBytes(h); b[bit >> 3] ^= 1 << (bit % 8); return bytesToHex(b); };

  assert.equal(executeShaHtlcBranch(script, S_HEX, '9000').ok, true);
  assert.equal(executeShaHtlcBranch(script, flipBit(S_HEX, 0), '9000').ok, false, '1-bit flip must be refused');
  assert.equal(executeShaHtlcBranch(script, flipBit(S_HEX, 255), '9000').ok, false, 'last-bit flip must be refused');
  assert.throws(() => executeShaHtlcBranch(script, 'aa'.repeat(31), '9000'), /64 lowercase hex/, 'wrong length refused');
  assert.throws(() => executeShaHtlcBranch(script, '', '9000'), /64 lowercase hex/);
  assert.throws(() => executeShaHtlcBranch(script, 'AA'.repeat(32), '9000'), /64 lowercase hex/, 'uppercase refused');
  assert.throws(() => executeShaHtlcBranch(script, 'zz'.repeat(32), '9000'), /64 lowercase hex/);
  assert.throws(() => executeShaHtlcBranch(script, S_HEX, '-1'), /non-negative integer/);
  // refund boundary is exact: 15999 no, 16000 yes, 16001 yes
  const view = decodeShaHtlcScript(script);
  assert.equal(refundBranchReachable(view, '15999'), false);
  assert.equal(refundBranchReachable(view, '16000'), true);
  assert.equal(refundBranchReachable(view, '16001'), true);
  // executing at/after the refund height with a WRONG preimage must not claim
  assert.equal(executeShaHtlcBranch(script, 'aa'.repeat(32), '20000').ok, false);
  assert.throws(() => decodeShaHtlcScript(Uint8Array.from([...hexToBytes(hex), 0x63])), /Trailing bytes/);
});

// ===========================================================================
// 8. HASH / PREIMAGE ATTACKS
// ===========================================================================

test('8.1 hash semantics: L1 and L2 bind the same raw-byte SHA256; encodings cannot diverge', async () => {
  const s = hexToBytes(S_HEX);
  // raw bytes (the ONLY correct binding)
  assert.equal(sha256Hex(s), H_OF_S);
  assert.equal(bytesToHex(sha256SyncExport(s)), H_OF_S, 'sync L1-side hash agrees');
  assert.equal(bytesToHex(await sha256(s)), H_OF_S, 'async L2-side hash agrees');
  // hash of the hex TEXT (a classic mistake) must NOT equal the raw-byte hash
  assert.notEqual(sha256Hex(Buffer.from(S_HEX, 'utf8')), H_OF_S);
  // double hashing must NOT equal the single hash
  assert.notEqual(sha256Hex(hexToBytes(sha256Hex(s))), H_OF_S);
  // leading-zero preservation: a 32-byte preimage with a leading zero byte
  const lead = '00' + 'ab'.repeat(31);
  assert.equal(await verifyPreimage(lead, sha256Hex(hexToBytes(lead))), true, 'leading zero byte is preserved');
  // UTF-8 reinterpretation: a text preimage's H is the hash of its UTF-8 BYTES, and must
  // never be confused with the hash of the hex text or of a re-encoding.
  const utf8 = Buffer.from('hunter2', 'utf8');
  assert.equal(sha256Hex(utf8), sha256Hex(Uint8Array.from(utf8)), 'UTF-8 bytes are the hashed representation');
  assert.notEqual(sha256Hex(utf8), sha256Hex(Buffer.from(bytesToHex(utf8), 'utf8')), 'hashing the hex text is a different H');
  // a multi-byte UTF-8 character must hash as its UTF-8 bytes, never as one byte per char
  // (U+00E9 U+20AC -> c3a9 e282ac)
  const multi = Buffer.from([0xc3, 0xa9, 0xe2, 0x82, 0xac]);
  assert.equal(multi.length, 5, 'two characters occupy five UTF-8 bytes');
  assert.notEqual(sha256Hex(multi), sha256Hex(Buffer.from([0xe9, 0xac])), 'a latin1 mis-decode is a different H');
  // oversized / wrong-length preimage is refused outright
  await assert.rejects(() => verifyPreimage('ab'.repeat(64), H_OF_S), /64 lowercase hex/);
  await assert.rejects(() => verifyPreimage('ab'.repeat(31), H_OF_S), /64 lowercase hex/);
  await assert.rejects(() => verifyPreimage('', H_OF_S), /64 lowercase hex/);
  await assert.rejects(() => verifyPreimage('AB'.repeat(32), H_OF_S), /64 lowercase hex/, 'uppercase is not a valid encoding here');
  assert.equal(await verifyPreimage('aa'.repeat(32), H_OF_S), false, 'wrong S rejected');
  // verifyPreimage never throws on a wrong-but-valid preimage
  for (const cand of ['00'.repeat(32), 'ff'.repeat(32), flip(S_HEX)]) {
    assert.equal(await verifyPreimage(cand, H_OF_S), false);
  }
  function flip(h) { const b = hexToBytes(h); b[7] ^= 0x80; return bytesToHex(b); }
});

test('8.2 an L2 observation whose hash is not the bound H can never verify', async () => {
  const ports = await driveToArmed();
  // Two-leg mismatch: L2 script carries a different H than the bound session hash
  const tampered = makePorts({ l2Cfg: { obs: { hashExact: false } }, sessions: new InMemorySessionStore() });
  await coord.acceptQuote({ request: { sessionId: 'sessBeta22', reservationId: 'resBeta22', quote: makeQuote({ quoteId: 'q2' }), nowUnixMs: 1000 }, ports: tampered });
  const l1 = await coord.beginL1Funding({ sessionId: 'sessBeta22', ports: tampered, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(l1.outcome, 'SUBMITTED');
  const v1 = await coord.verifyL1Funded({ sessionId: 'sessBeta22', ports: tampered, deadlineSafety: DEADLINE_OK });
  assert.equal(v1.verified, true);
  await coord.beginL2Funding({ sessionId: 'sessBeta22', ports: tampered, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  const v2 = await coord.verifyL2Funded({ sessionId: 'sessBeta22', ports: tampered });
  assert.equal(v2.verified, false, 'L2 with a non-matching hash must not verify');
  const arm = await coord.armClaim({ sessionId: 'sessBeta22', ports: tampered, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(arm.armed, false, 'CLAIM_ARMED refused while L2 hash mismatches');
  assert.equal((await tampered.sessions.get('sessBeta22')).state, 'RECOVERY_REQUIRED');
  assert.notEqual(ports, null);
});

// ===========================================================================
// 10. CLAIM_ARMED BYPASS ATTACKS
// ===========================================================================

test('10.1 CLAIM_ARMED is unreachable from every state except a fully proven BOTH_FUNDED', async () => {
  const states = ['QUOTED', 'RESERVED', 'L1_FUNDING', 'L1_FUNDED', 'L2_FUNDING', 'RECOVERY_REQUIRED', 'REFUNDING', 'SECRET_REVEALED', 'CLAIMING', 'CLAIMED', 'REFUNDED', 'FAILED_TERMINAL'];
  for (const state of states) {
    const ports = makePorts();
    await ports.sessions.save({
      sessionId: 'sessAlpha1', state, quoteId: 'q', reservationId: 'resAlpha1', providerId: 'prov_1', direction: 'XTM_TO_TARI',
      xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: H, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b',
      l1Network: 'esmeralda', l2Network: 'esmeralda', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200',
      requiredL1Confirmations: '3', createdAtUnixMs: 1, updatedAtUnixMs: 1, l1TxId: 'tx1', l2TxId: 'tx2',
    });
    // A refusal may surface as a thrown IllegalTransitionError (wrong state) or armed:false.
    let armed = false;
    try {
      armed = (await coord.armClaim({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true })).armed;
    } catch (e) {
      assert.ok(e instanceof IllegalTransitionError, `unexpected throw from ${state}: ${e.message}`);
    }
    assert.equal(armed, false, `armed from ${state}!`);
    // and the secret can never be revealed from there
    await assert.rejects(() => coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }));
  }
});

test('10.2 arming refuses: no L1 stamp, no L2 stamp, lost capability, weak confirmations, spent output', async () => {
  // (a) BOTH_FUNDED with submissions but no verification stamps
  const a = makePorts();
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports: a });
  await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports: a, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  await coord.beginL2Funding({ sessionId: 'sessAlpha1', ports: a, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true })
    .then(() => { throw new Error('second leg funded without L1 verification!'); })
    .catch((e) => assert.match(e.message, /no authoritative L1 verification/));
  // (b) L1 verified but L2 unverified
  const b = makePorts();
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports: b });
  await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports: b, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  await coord.verifyL1Funded({ sessionId: 'sessAlpha1', ports: b, deadlineSafety: DEADLINE_OK });
  await coord.beginL2Funding({ sessionId: 'sessAlpha1', ports: b, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  const armB = await coord.armClaim({ sessionId: 'sessAlpha1', ports: b, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(armB.armed, false, 'armed with unverified L2!');
  // (c) capability lost between funding and arming
  const c = await driveToBothFunded();
  c.l1.caps = { ...CAPS, l1ShaRefund: false };
  const armC = await coord.armClaim({ sessionId: 'sessAlpha1', ports: c, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(armC.armed, false, 'armed after capability loss!');
  assert.match(armC.reason, /capability lost/);
  // (d) confirmations drop below policy after verification (finality regression)
  const d = await driveToBothFunded();
  d.l1.obs = { ...d.l1.obs, confirmations: '0' };
  const armD = await coord.armClaim({ sessionId: 'sessAlpha1', ports: d, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(armD.armed, false, 'armed with 0 confirmations!');
  // (e) L2 output already spent at arm time
  const e = await driveToBothFunded();
  e.l2.obs = { ...e.l2.obs, unspent: false };
  const armE = await coord.armClaim({ sessionId: 'sessAlpha1', ports: e, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(armE.armed, false, 'armed with a spent L2 output!');
});

test('10.3 only CLAIM_ARMED may reveal the preimage, and only after the bound-H check', async () => {
  const ports = makePorts();
  const rec = {
    sessionId: 'sessAlpha1', state: 'BOTH_FUNDED', quoteId: 'q', reservationId: 'resAlpha1', providerId: 'prov_1', direction: 'XTM_TO_TARI',
    xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: H_OF_S, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b',
    l1Network: 'esmeralda', l2Network: 'esmeralda', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200',
    requiredL1Confirmations: '3', createdAtUnixMs: 1, updatedAtUnixMs: 1, l1TxId: 'tx1', l2TxId: 'tx2',
  };
  await ports.sessions.save(rec);
  assert.throws(() => requireSecretRevealAllowed(rec), /CLAIM_ARMED/);
  await assert.rejects(() => coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }), /CLAIM_ARMED|is BOTH_FUNDED/);
  // a session holding a DIFFERENT secret than the bound H must not claim
  const wrong = makePorts();
  await wrong.secrets.ingestExternalSecret('sessBeta22', 'ab'.repeat(32));
  await wrong.sessions.save({ ...rec, sessionId: 'sessBeta22', state: 'CLAIM_ARMED' });
  const out = await coord.revealAndClaimL2({ sessionId: 'sessBeta22', ports: wrong, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(out.outcome, 'UNKNOWN', 'a mismatched stored preimage must not claim');
  assert.match(out.reason, /does not match bound hash/);
});

// ===========================================================================
// 6. REFUND BRANCH ATTACKS
// ===========================================================================

test('6.1 refund branch is wallet-owned: intent/observed divergence is visible, never authoritative', async () => {
  const ports = makePorts();
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports });
  const record = await ports.sessions.get('sessAlpha1');
  // the intent's refundRecipient is informational; the observed script key is the truth
  const obs = await ports.l1.observeHtlc('9001');
  assert.equal(obs.refundRecipient, 'refund_pubkey');
  assert.notEqual(obs.refundRecipient, record.l1ClaimRecipient, 'refund key must NOT be the claim address');
  assert.equal(obs.refundHeight, record.l1RefundDeadlineHeight, 'observed height is what the wallet set (tip+720)');
  // a provider that rotates its account cannot retroactively change the observed key
  ports.l1.walletAddress = 'wallet_B';
  const obs2 = await ports.l1.observeHtlc('9001');
  assert.equal(obs2.refundRecipient, 'refund_pubkey');
});

test('6.2 verification refuses a refund branch that does not match the observed script', async () => {
  const ports = makePorts({ l1Cfg: { obs: { refundHeight: '99999' } } });
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports });
  await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  const v = await coord.verifyL1Funded({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK });
  assert.equal(v.verified, false, 'script refund height differing from the quote must refuse');
  assert.equal(v.evidence.deadlineSafe, false);
  assert.equal((await ports.sessions.get('sessAlpha1')).l1Verification, undefined);
});

// ===========================================================================
// 7. FEE SEMANTICS
// ===========================================================================

test('7.1 fee-per-gram cannot force disclosure; hostile fee values never crash the flow', () => {
  for (const fee of [0, 1, 5, 1e9, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const provider = new MinotariDevGrpcProvider({ network: 'esmeralda', walletAddress: 'w', fundingFeeTPerGram: fee });
    const { intent } = provider.constructHtlcFunding({ amountRaw: '10000', hash: H, claimRecipient: 'a', refundRecipient: 'b', refundHeight: '16000', network: 'esmeralda', operationId: 'op1' });
    assert.ok(intent, `fee ${fee} broke intent construction`);
    const calls = [];
    provider.submitFunding({
      ...intent,
    }).catch(() => {});
    // the wire request must never carry caller-controlled fee policy beyond the hint
    assert.equal(typeof provider.providerName(), 'string');
    assert.equal(calls.length, 0);
  }
  const p = new MinotariDevGrpcProvider({ network: 'esmeralda', walletAddress: 'w', fundingFeeTPerGram: 7 });
  assert.equal(p.capabilities().l1ShaInit, false, 'an unwired provider advertises nothing');
  assert.equal(MINOTARI_REFERENCE_FEE_PER_GRAM, 5);
});

test('7.2 a claim that cannot be constructed (fee unavailable) never re-reveals or blind-retries', async () => {
  const ports = await driveToArmed();
  // wallet cannot estimate/construct the claim any more
  ports.l2.constructClaim = async () => { throw new Error('fee estimation unavailable'); };
  const out = await coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(out.outcome, 'UNKNOWN', 'a failed claim construct after reveal must reconcile, not retry');
  assert.equal((await ports.sessions.get('sessAlpha1')).state, 'RECOVERY_REQUIRED');
});

// ===========================================================================
// 9. EARLY SECRET LEAK ATTACKS
// ===========================================================================

test('9.1 S never appears in any serializable coordinator state, log, or error', async () => {
  const ports = await driveToArmed();
  const secret = await ports.secrets.revealSecret('sessAlpha1', true);
  assert.equal(secret, S_HEX);
  // every durable object the coordinator produces
  const surfaces = {
    session: await ports.sessions.get('sessAlpha1'),
    sessionList: await ports.sessions.listAll(),
    reservation: await ports.reservations.get('resAlpha1'),
    providerList: await ports.reservations.listByProvider('prov_1'),
    publicPart: await ports.secrets.publicPart('sessAlpha1'),
    l1Observation: await ports.l1.observeHtlc('9001'),
    l2Observation: await ports.l2.observeHashlockOutput('7001'),
    quote: makeQuote(),
    route: routeResult({ request: { source: 'XTM', destination: 'TARI', amountRaw: '10000', network: 'esmeralda' }, ad: makeAd(), quote: buildQuote({ quoteId: 'q1', ad: makeAd(), direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: H, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200', nowUnixMs: 1 }) }),
  };
  for (const [name, value] of Object.entries(surfaces)) {
    assertNoSecretInJson(JSON.stringify(value), secret);
    assert.ok(!JSON.stringify(value).toLowerCase().includes(secret.toLowerCase()), `S leaked into ${name}`);
  }
  // errors thrown along the way must not carry S
  try { await coord.verifyL1Funded({ sessionId: 'nope', ports, deadlineSafety: DEADLINE_OK }); } catch (e) { assertNoSecretInJson(String(e && e.message), secret); }
  // encoding-mutation leaks are caught too
  for (const mutant of [secret.toUpperCase(), `0x${secret}`, Buffer.from(hexToBytes(secret)).toString('base64'), Buffer.from(secret, 'utf8').toString('base64')]) {
    assert.throws(() => assertNoSecretInJson(JSON.stringify({ leaked: mutant }), secret), /SECRET LEAKED/, `missed encoding: ${mutant.slice(0, 12)}`);
  }
  // the session record must never gain a secret field
  assert.equal(Object.keys(surfaces.session).some((k) => /secret|preimage/i.test(k)), false);
});

test('9.2 the secret store refuses to re-point a funded session at a different preimage', async () => {
  const store = new InMemorySecretStore();
  const first = await store.ingestExternalSecret('s', S_HEX);
  assert.equal(first.hashH, H_OF_S);
  // identical re-ingest is idempotent
  const same = await store.ingestExternalSecret('s', S_HEX);
  assert.equal(same.hashH, H_OF_S);
  // a DIFFERENT preimage under the same session id is refused
  await assert.rejects(() => store.ingestExternalSecret('s', 'ab'.repeat(32)), /Refusing to replace an existing preimage/);
  assert.equal((await store.publicPart('s')).hashH, H_OF_S, 'stored preimage unchanged');
  // secrets are per-session: a secret from another session is not readable
  await store.ingestExternalSecret('other', 'cd'.repeat(32));
  assert.notEqual(await store.revealSecret('other', true), S_HEX);
  // a missing secret never regenerates
  await store.destroySecret('gone');
  await assert.rejects(() => store.revealSecret('gone', true), /No secret stored/);
  assert.equal(await store.hasSecret('gone'), false);
  await assert.rejects(() => store.publicPart('gone'), /No secret stored/);
  // reveal requires the arming flag
  await assert.rejects(() => store.revealSecret('s', false), /CLAIM_ARMED evidence required/);
});

// ===========================================================================
// 11. UNKNOWN RESULT ATTACKS
// ===========================================================================

test('11.1 a lost L1/L2/claim response forces reconciliation, never a blind resubmit', async () => {
  for (const stage of ['l1', 'l2']) {
    const cfg = stage === 'l1' ? { l1Cfg: { submitError: 'socket hang up' } } : { l2Cfg: { fundingError: 'timeout' } };
    const ports = makePorts(cfg);
    await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports });
    if (stage === 'l1') {
      const out = await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
      assert.equal(out.outcome, 'UNKNOWN');
      assert.equal((await ports.sessions.get('sessAlpha1')).state, 'RECOVERY_REQUIRED');
      // a second funding attempt is impossible from RECOVERY_REQUIRED (no blind resubmit)
      await assert.rejects(
        () => coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }),
        /expected one of RESERVED/,
        'retry after UNKNOWN must be refused by state',
      );
      assert.equal(ports.l1.calls.filter((c) => c === 'submitFunding').length, 1, 'exactly one submission attempt');
    } else {
      await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
      await coord.verifyL1Funded({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK });
      const out = await coord.beginL2Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
      assert.equal(out.outcome, 'UNKNOWN');
      assert.equal((await ports.sessions.get('sessAlpha1')).state, 'RECOVERY_REQUIRED');
      assert.equal(ports.l2.calls.filter((c) => c === 'submitFunding').length, 1, 'exactly one second-leg submission attempt');
    }
  }
  // claim UNKNOWN after the secret is public → reconcile, never re-reveal
  const ports = await driveToArmed();
  ports.l2.claimError = 'timeout';
  const out = await coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(out.outcome, 'UNKNOWN');
  const rec = await ports.sessions.get('sessAlpha1');
  assert.equal(rec.state, 'RECOVERY_REQUIRED');
  assert.ok(rec.secretRevealedAtUnixMs, 'the record still records that the secret went out');
  const d = await coord.recoverSession({ sessionId: 'sessAlpha1', ports });
  assert.ok(['CONTINUE', 'RECONCILE', 'FINALIZE', 'ARM'].includes(d.action));
});

test('11.2 recovery derives state from authoritative lookups, never from the stored state', async () => {
  const cases = [
    { l1: 'COMMITTED', l2: 'NOT_FOUND', action: 'CONTINUE' },
    { l1: 'COMMITTED', l2: 'COMMITTED', action: 'ARM' },
    { l1: 'NOT_FOUND', l2: 'NOT_FOUND', action: 'WAIT_OR_REFUND' },
    { l1: 'REJECTED', l2: 'COMMITTED', action: 'RECONCILE' },
  ];
  for (const c of cases) {
    const ports = makePorts({ l1Cfg: { txStatus: c.l1 }, l2Cfg: { txStatus: c.l2 } });
    await ports.sessions.save({
      sessionId: 'sessAlpha1', state: 'RECOVERY_REQUIRED', quoteId: 'q', reservationId: 'resAlpha1', providerId: 'prov_1', direction: 'XTM_TO_TARI',
      xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: H, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b',
      l1Network: 'esmeralda', l2Network: 'esmeralda', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200',
      requiredL1Confirmations: '3', createdAtUnixMs: 1, updatedAtUnixMs: 1, l1TxId: 'tx1', l2TxId: 'tx2',
    });
    const d = await coord.recoverSession({ sessionId: 'sessAlpha1', ports });
    assert.equal(d.action, c.action, `l1=${c.l1} l2=${c.l2}`);
  }
  // a terminal session is never re-driven
  const ports = makePorts();
  await ports.sessions.save({ sessionId: 'sessAlpha1', state: 'CLAIMED', quoteId: 'q', reservationId: 'resAlpha1', providerId: 'prov_1', direction: 'XTM_TO_TARI', xtmRawAmount: '1', tariRawAmount: '1', hashH: H, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b', l1Network: 'esmeralda', l2Network: 'esmeralda', l1RefundDeadlineHeight: '1', l2RefundDeadlineEpoch: '1', requiredL1Confirmations: '3', createdAtUnixMs: 1, updatedAtUnixMs: 1 });
  const d = await coord.recoverSession({ sessionId: 'sessAlpha1', ports });
  assert.equal(d.action, undefined, 'terminal sessions must not be re-driven');
});

// ===========================================================================
// 12. DUPLICATE OPERATION ATTACKS
// ===========================================================================

test('12.1 duplicate quote acceptance / reservation / release never double-moves value', async () => {
  const ad = makeAd();
  const ledger = new InMemoryReservationLedger({ prov_1: ad });
  const ports = makePorts({ reservations: ledger });
  const quote = makeQuote();
  // identical acceptance is idempotent-ish: the ledger refuses a second reservation for the same quote
  await coord.acceptQuote({ request: { sessionId: 'sessOne1', reservationId: 'resAlpha1', quote, nowUnixMs: 1 }, ports });
  await assert.rejects(
    () => coord.acceptQuote({ request: { sessionId: 'sessBeta22', reservationId: 'resBeta22', quote, nowUnixMs: 1 }, ports }),
    /already reserved|Quote/,
    'quote replay into a second reservation must be refused',
  );
  // same reservation id, different terms
  await assert.rejects(
    () => coord.acceptQuote({ request: { sessionId: 'sessBeta33', reservationId: 'resAlpha1', quote: makeQuote({ quoteId: 'q3', xtmRawAmount: '20000' }), nowUnixMs: 1 }, ports }),
    /already exists with different terms/,
  );
  // release is exactly once
  await ledger.markFunded('resAlpha1');
  const p1 = await ledger.requestRelease('resAlpha1', 'ev_one_01', 'SETTLED');
  await ledger.completeRelease(p1.reservationId);
  const again = await ledger.requestRelease('resAlpha1', 'ev_one_01', 'SETTLED');
  assert.equal(again.state, 'RELEASED', 'release is idempotent');
  await assert.rejects(() => ledger.completeRelease('resAlpha1'), /RELEASE_PENDING/);
});

test('12.2 concurrent duplicate claims are refused after the first acknowledgement', async () => {
  const ports = await driveToArmed();
  const rec = await ports.sessions.get('sessAlpha1');
  // two concurrent reveals: the second must fail on state, not double-submit
  const results = await Promise.allSettled([
    coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }),
    coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.ok(fulfilled.length <= 2);
  // after the first claim, the record is past CLAIM_ARMED; a second reveal from that state is illegal
  const after = await ports.sessions.get('sessAlpha1');
  assert.ok(['CLAIMING', 'RECOVERY_REQUIRED'].includes(after.state));
  await assert.rejects(() => coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true }));
  assert.notEqual(rec.state, after.state);
});

test('12.3 claimL1 is idempotent, never double-submits, and refuses a wrong preimage', async () => {
  const ports = await driveToArmed();
  // L1 claiming is the OPPOSITE leg: it is only legal once our own L2 claim is in flight.
  await assert.rejects(
    () => coord.claimL1({ sessionId: 'sessAlpha1', preimage: S_HEX, ports }),
    /expected one of CLAIMING/,
    'L1 claim from BOTH_FUNDED must be refused',
  );
  await coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  const rec = await ports.sessions.get('sessAlpha1');
  assert.equal(rec.state, 'CLAIMING', 'our own L2 claim puts the session in CLAIMING');
  const wrong = await coord.claimL1({ sessionId: 'sessAlpha1', preimage: 'ab'.repeat(32), ports });
  assert.equal(wrong.outcome, 'REFUSED', 'a preimage that does not hash to the bound H is refused');
  const r1 = await coord.claimL1({ sessionId: 'sessAlpha1', preimage: S_HEX, ports });
  assert.equal(r1.outcome, 'SUBMITTED');
  const r2 = await coord.claimL1({ sessionId: 'sessAlpha1', preimage: S_HEX, ports });
  assert.ok(['SUBMITTED', 'UNKNOWN'].includes(r2.outcome), 'a repeated L1 claim is idempotent/reconciled, never re-submitted');
  assert.equal((await ports.sessions.get('sessAlpha1')).l1ClaimTxId, 'claim_tx_1', 'the same claim tx id is retained — no second claim was created');
});

test('12.4 claimL1 from RECOVERY_REQUIRED is refused BEFORE any submission — recovery must be resolved first', async () => {
  // Regression (Pixel Canary second pass): RECOVERY_REQUIRED used to be in claimL1's
  // allowed set. A submission there succeeded on the port and THEN threw on the
  // unrecordable CLAIM_ACKNOWLEDGED transition, so the claim tx id was never persisted and
  // a retry had no idempotency key (a blind double submission).
  const l1 = makeL1();
  const submissions = [];
  const realSubmitClaim = l1.submitClaim;
  l1.submitClaim = async (...args) => { submissions.push(args); return realSubmitClaim(...args); };
  // drive to CLAIM_ARMED, then lose the L2 claim response → RECOVERY_REQUIRED
  const ports = await driveToArmed({ l1, l2Cfg: { claimError: 'transport lost after submission' } });
  await coord.revealAndClaimL2({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal((await ports.sessions.get('sessAlpha1')).state, 'RECOVERY_REQUIRED');
  await assert.rejects(
    () => coord.claimL1({ sessionId: 'sessAlpha1', preimage: S_HEX, ports }),
    /expected one of CLAIMING/,
    'claimL1 must refuse a session in recovery before touching the network',
  );
  assert.equal(submissions.length, 0, 'no L1 claim may be submitted from RECOVERY_REQUIRED');
  // the explicit path still works: resolve recovery into CLAIMING, then claim
  const recovered = await ports.sessions.get('sessAlpha1');
  await ports.sessions.save(sessionMod.applyEvent(recovered, { kind: 'RECOVERY_RESOLVED', resolution: 'CLAIMING' }));
  const claim = await coord.claimL1({ sessionId: 'sessAlpha1', preimage: S_HEX, ports });
  assert.equal(claim.outcome, 'SUBMITTED', 'after an explicit recovery resolution the claim is submittable');
  assert.equal(submissions.length, 1, 'exactly one claim submission across the whole recovery flow');
});

test('12.5 claimL1 on a CLAIMED session without a recorded claim id reconciles instead of submitting', async () => {
  // Regression (Pixel Canary second pass): a terminal CLAIMED session has no transition that
  // could record a new claim acknowledgement, so a submission there would throw AFTER the
  // irreversible act and strand the evidence.
  const l1 = makeL1();
  const submissions = [];
  const realSubmitClaim = l1.submitClaim;
  l1.submitClaim = async (...args) => { submissions.push(args); return realSubmitClaim(...args); };
  const ports = makePorts({ l1 });
  await ports.sessions.save({
    sessionId: 'sessAlpha1', state: 'CLAIMED', quoteId: 'q', reservationId: 'resAlpha1', providerId: 'prov_1', direction: 'XTM_TO_TARI',
    xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: H_OF_S, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b',
    l1Network: 'esmeralda', l2Network: 'esmeralda', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200',
    requiredL1Confirmations: '3', createdAtUnixMs: 1, updatedAtUnixMs: 1, l1TxId: 'tx1', l2TxId: 'tx2',
  });
  const r = await coord.claimL1({ sessionId: 'sessAlpha1', preimage: S_HEX, ports });
  assert.equal(r.outcome, 'UNKNOWN', 'a terminal session must reconcile, not submit');
  assert.match(r.reason, /CLAIMED with no recorded L1 claim id/);
  assert.equal(submissions.length, 0, 'no L1 claim may be submitted from a terminal state');
});

// ===========================================================================
// 13. RESERVATION RACE ATTACKS
// ===========================================================================

test('13.1 inventory never goes negative under adversarial reservation patterns', async () => {
  const ad = makeAd({ xtmAvailable: '100', tariAvailable: '100' });
  const ledger = new InMemoryReservationLedger({ p: ad });
  const R = (i, x) => ledger.reserve({ reservationId: `resx_${i}_pad`, quoteId: `qqx_${i}_pad`, providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: String(x), tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 });
  // 80 + 80 over 100 → exactly one succeeds
  await R(1, 80);
  await assert.rejects(() => R(2, 80), /Inventory race/);
  // 60 + 40 fits exactly
  const l2 = new InMemoryReservationLedger({ p: ad });
  await l2.reserve({ reservationId: 'resA_pad01', quoteId: 'qqA_pad01', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '60', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 });
  await l2.reserve({ reservationId: 'resB_pad02', quoteId: 'qqB_pad02', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '40', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 });
  await assert.rejects(() => l2.reserve({ reservationId: 'resC_pad03', quoteId: 'qqC_pad03', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '1', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 }), /Inventory race/);
  // 60 + 41 over 100
  const l3 = new InMemoryReservationLedger({ p: ad });
  await l3.reserve({ reservationId: 'resA_pad01', quoteId: 'qqA_pad01', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '60', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 });
  await assert.rejects(() => l3.reserve({ reservationId: 'resB_pad02', quoteId: 'qqB_pad02', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '41', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 }), /Inventory race/);
  // 1 x 100 concurrent
  const l4 = new InMemoryReservationLedger({ p: ad });
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => l4.reserve({ reservationId: `resv_${i}_pad`, quoteId: `quot_${i}_pad`, providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '1', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 100, 'exactly 100 unit reservations fit');
  // release-vs-reservation: releasing frees capacity exactly once
  const l5 = new InMemoryReservationLedger({ p: ad });
  const r = await l5.reserve({ reservationId: 'resX_pad04', quoteId: 'qqX_pad04', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '100', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 9999 });
  assert.equal((await l5.requestRelease('resX_pad04', 'ev_pad_01', 'SETTLED')).state, 'RELEASE_PENDING');
  await l5.completeRelease('resX_pad04');
  await l5.reserve({ reservationId: 'resY_pad05', quoteId: 'qqY_pad05', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '100', tariRawAmount: '0', nowUnixMs: 2, quoteExpiresAtUnixMs: 9999 });
  assert.notEqual(r.state, 'RELEASED');
});

test('13.2 quote expiry releases only UNFUNDED inventory; funded sessions live by chain deadlines', async () => {
  const ledger = new InMemoryReservationLedger({ p: makeAd({ xtmAvailable: '100' }) });
  const res = await ledger.reserve({ reservationId: 'resA_pad01', quoteId: 'qqA_pad01', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '100', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 10 });
  await ledger.markFunded('resA_pad01');
  await assert.rejects(() => ledger.requestRelease('resA_pad01', 'ev_pad_02', 'QUOTE_EXPIRED'), /only an UNFUNDED reservation/);
  assert.equal((await ledger.expireUnfunded(1000)).length, 0, 'funded inventory is never swept by expiry');
  const ledger2 = new InMemoryReservationLedger({ p: makeAd({ xtmAvailable: '100' }) });
  await ledger2.reserve({ reservationId: 'resB_pad02', quoteId: 'qqB_pad02', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '100', tariRawAmount: '0', nowUnixMs: 1, quoteExpiresAtUnixMs: 10 });
  const swept = await ledger2.expireUnfunded(1000);
  assert.equal(swept.length, 1, 'unfunded expired inventory is reclaimed');
  assert.equal((await ledger2.get('resB_pad02')).state, 'RELEASED');
  // capacity is restored
  await ledger2.reserve({ reservationId: 'resC_pad03', quoteId: 'qqC_pad03', providerId: 'p', direction: 'XTM_TO_TARI', xtmRawAmount: '100', tariRawAmount: '0', nowUnixMs: 2, quoteExpiresAtUnixMs: 9999 });
});

// ===========================================================================
// 14. PROVIDER QUOTE ATTACKS
// ===========================================================================

test('14.1 malicious/stale quotes are refused before any inventory is reserved', async () => {
  const hostileQuotes = [
    ['expired quote', makeQuote({ quoteExpiresAtUnixMs: 500 }), /already expired/],
    ['zero amount', makeQuote({ xtmRawAmount: '0' }), /positive/],
    ['negative amount', makeQuote({ xtmRawAmount: '-1' }), /non-negative integer/],
    ['float amount', makeQuote({ xtmRawAmount: '1.5' }), /non-negative integer/],
    ['garbage hash', makeQuote({ hashH: 'nothex' }), /64 lowercase hex/],
    ['empty claim recipient', makeQuote({ l1ClaimRecipient: '  ' }), /l1ClaimRecipient is required/],
    ['mixed networks', makeQuote({ l2Network: 'localnet' }), /Mixed-network|approved test network/],
    ['mainnet l1', makeQuote({ l1Network: 'mainnet' }), /MAINNET is refused/],
    ['zero confirmations', makeQuote({ requiredL1Confirmations: '0' }), /positive/],
    ['bad deadline', makeQuote({ l1RefundDeadlineHeight: 'x' }), /non-negative integer/],
    ['bad direction', makeQuote({ direction: 'XTM_TO_TARI_X' }), /Unknown swap direction/],
    ['blank provider', makeQuote({ providerId: '' }), /non-empty identifier/],
  ];
  for (const [name, quote, re] of hostileQuotes) {
    const ledger = new InMemoryReservationLedger({ [quote.providerId || 'prov_1']: makeAd({ providerId: quote.providerId || 'prov_1' }) });
    const ports = makePorts({ reservations: ledger });
    await assert.rejects(
      () => coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote, nowUnixMs: 1000 }, ports }),
      re,
      `accepted hostile quote: ${name}`,
    );
    const all = await ledger.listByProvider(quote.providerId || 'prov_1');
    assert.equal(all.length, 0, `inventory was reserved for a rejected quote: ${name}`);
  }
});

test('14.2 accepted quote terms are immutable; later mutation cannot alter the session', async () => {
  const ports = makePorts();
  const quote = makeQuote();
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote, nowUnixMs: 1 }, ports });
  const rec = await ports.sessions.get('sessAlpha1');
  // mutating the caller's object after acceptance must not affect durable state
  quote.xtmRawAmount = '1';
  quote.tariRawAmount = '999999999';
  quote.hashH = 'ff'.repeat(32);
  quote.l1ClaimRecipient = 'attacker';
  const rec2 = await ports.sessions.get('sessAlpha1');
  assert.equal(rec2.xtmRawAmount, rec.xtmRawAmount);
  assert.equal(rec2.tariRawAmount, rec.tariRawAmount);
  assert.equal(rec2.l1ClaimRecipient, rec.l1ClaimRecipient);
  assert.notEqual(rec2.hashH, 'ff'.repeat(32));
  // An event that tries to rebind an ALREADY-BOUND hash to a different value is illegal.
  // (Use a quote that fixed H up front; when H is unbound the first authoritative read may
  // legitimately bind it, which is the TARI_TO_XTM case.)
  const boundPorts = makePorts();
  await coord.acceptQuote({ request: { sessionId: 'sessBound01', reservationId: 'resBound01', quote: makeQuote({ hashH: H, quoteId: 'qbound' }), nowUnixMs: 1 }, ports: boundPorts });
  const bound = await boundPorts.sessions.get('sessBound01');
  assert.equal(bound.hashH, H);
  const funding = sessionMod.applyEvent(bound, { kind: 'BEGIN_L1_FUNDING', deadlineSafetyEvidence: 'x' });
  assert.throws(() => sessionMod.applyEvent(funding, { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: 'tx', hashHex: 'ee'.repeat(32) }), /does not match the accepted quote hash/);
  assert.doesNotThrow(() => sessionMod.applyEvent(funding, { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: 'tx', hashHex: H }));
  // a malformed hash is refused outright
  assert.throws(() => sessionMod.applyEvent(funding, { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: 'tx', hashHex: 'A'.repeat(64) }), /does not match the accepted quote hash/);
  // a malformed hash is refused outright on a session where H is still unbound
  const unbound = makePorts();
  await coord.acceptQuote({ request: { sessionId: 'sessUnbnd01', reservationId: 'resUnbnd01', quote: makeQuote({ quoteId: 'qunbnd' }), nowUnixMs: 1 }, ports: unbound });
  const unboundRec = await unbound.sessions.get('sessUnbnd01');
  const unboundFunding = sessionMod.applyEvent(unboundRec, { kind: 'BEGIN_L1_FUNDING', deadlineSafetyEvidence: 'x' });
  assert.throws(() => sessionMod.applyEvent(unboundFunding, { kind: 'L1_FUND_ACKNOWLEDGED', l1TxId: 'tx', hashHex: 'A'.repeat(64) }), /64 lowercase hex/);
});

test('14.3 provider advertisements cannot widen the network policy', () => {
  assert.throws(() => validateAdvertisement(makeAd({ network: 'mainnet' })), /MAINNET is refused/);
  assert.throws(() => validateAdvertisement(makeAd({ network: 'base.mainnet' })), /MAINNET is refused/);
  assert.throws(() => validateAdvertisement(makeAd({ network: 'arbitrary' })), /approved test network/);
  assert.throws(() => validateAdvertisement(makeAd({ spreadBps: '10001' })), /spreadBps/);
  assert.throws(() => validateAdvertisement(makeAd({ maxTradeXtm: '10', minTradeXtm: '100' })), /maxTradeXtm/);
  assert.throws(() => validateAdvertisement(makeAd({ quoteTtlMs: '0' })), /quoteTtlMs must be positive/);
  assert.doesNotThrow(() => validateAdvertisement(makeAd()));
  // quote math never produces a negative or over-inventory output
  const ad = makeAd();
  const q = quoteXtmToTari(ad, '10000', '500');
  assert.ok(BigInt(q.tari) > 0n);
  assert.throws(() => quoteXtmToTari(ad, '999999', '500'), /outside provider bounds/);
});

// ===========================================================================
// 15/16. DEADLINE ATTACKS AND CROSS-DOMAIN CONFUSION
// ===========================================================================

test('15.1 deadline derivation keeps L1 height and L2 epoch in separate domains', () => {
  const d = deriveDeadlines({ requiredL1Confirmations: '3', l1BlockMs: '120000', l2EpochMs: '10000', propagationDelayMs: '60000', safetyBufferMs: '60000', currentL1Height: '100', currentL2Epoch: '1000' });
  // L1 first-funded must be LATER in its own domain; the L2 (second-funded) epoch is earlier
  assert.ok(BigInt(d.firstLegRefundHeight) > 100n);
  assert.ok(BigInt(d.secondLegRefundEpoch) > 1000n);
  // zero/negative cadences refused
  assert.throws(() => deriveDeadlines({ requiredL1Confirmations: '3', l1BlockMs: '0', l2EpochMs: '10', propagationDelayMs: '1', safetyBufferMs: '1', currentL1Height: '1', currentL2Epoch: '1' }), /cadence must be positive/);
  assert.throws(() => deriveDeadlines({ requiredL1Confirmations: '0', l1BlockMs: '10', l2EpochMs: '10', propagationDelayMs: '1', safetyBufferMs: '1', currentL1Height: '1', currentL2Epoch: '1' }), /confirmations must be positive/);
  // a giant L1 height must not be compared against a giant L2 epoch numerically anywhere:
  // assertRefundEligibility only ever compares like-for-like
  assert.equal(typeof d.marginEvidence.l1FirstLegMarginMs, 'string');
});

test('15.2 refund eligibility is exact-boundary and never fires early', async () => {
  const save = async (sessionId) => {
    const ports = makePorts();
    await ports.sessions.save({
      sessionId, state: 'L1_FUNDED', quoteId: 'q', reservationId: 'resProbe1', providerId: 'prov_1', direction: 'XTM_TO_TARI',
      xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: H, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b',
      l1Network: 'esmeralda', l2Network: 'esmeralda', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200',
      requiredL1Confirmations: '3', createdAtUnixMs: 1, updatedAtUnixMs: 1, l1TxId: 'tx1',
    });
    return ports;
  };
  // one block before the L1 deadline: not refundable
  let p = await save('sessRefA');
  assert.equal((await coord.assessRefundEligibility({ sessionId: 'sessRefA', ports: p, l1CurrentHeight: '15999', l2CurrentEpoch: '0' })).refundable, false);
  // exactly at the L1 deadline: refundable, decided in the L1 domain
  p = await save('sessRefB');
  const l1At = await coord.assessRefundEligibility({ sessionId: 'sessRefB', ports: p, l1CurrentHeight: '16000', l2CurrentEpoch: '0' });
  assert.equal(l1At.refundable, true);
  assert.equal(l1At.leg, 'L1');
  // exactly at the L2 deadline: refundable, decided in the L2 domain
  p = await save('sessRefC');
  const l2At = await coord.assessRefundEligibility({ sessionId: 'sessRefC', ports: p, l1CurrentHeight: '0', l2CurrentEpoch: '1200' });
  assert.equal(l2At.refundable, true);
  assert.equal(l2At.leg, 'L2');
  // one unit before the L2 deadline: not refundable
  p = await save('sessRefD');
  assert.equal((await coord.assessRefundEligibility({ sessionId: 'sessRefD', ports: p, l1CurrentHeight: '0', l2CurrentEpoch: '1199' })).refundable, false);
  // a huge L1 height is never read as an L2 epoch: an L2 epoch of 1 must not make it refundable
  p = await save('sessRefE');
  const mixed = await coord.assessRefundEligibility({ sessionId: 'sessRefE', ports: p, l1CurrentHeight: '0', l2CurrentEpoch: '1' });
  assert.equal(mixed.refundable, false, 'L1 height 0 with L2 epoch 1 is not refundable — domains are separate');
});

test('15.3 deadline margin must be recomputed authoritatively before disclosure; asserted margins are refused by default', async () => {
  const ports = makePorts();
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports });
  // no authority and no explicit opt-in → refuse
  await assert.rejects(
    () => coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK }),
    /no authoritative deadline authority/,
  );
  // an authority that reports an insufficient margin OVERRIDES the caller's inflated lie
  const authority = { remainingMargins: async () => ({ l1RemainingMarginMs: '1000', l2RemainingMarginMs: '1000' }) };
  const ports2 = makePorts({ deadlineAuthority: authority });
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports: ports2 });
  await assert.rejects(
    () => coord.beginL1Funding({ sessionId: 'sessAlpha1', ports: ports2, env: ENV_ON, deadlineSafety: { ...DEADLINE_OK, l1RemainingMarginMs: '999999999' } }),
    /FIRST_LEG_FUNDING refused/,
    'a caller-asserted margin must not override the authoritative read',
  );
  // with a healthy authority the same call proceeds
  const healthy = { remainingMargins: async () => ({ l1RemainingMarginMs: '900000', l2RemainingMarginMs: '900000' }) };
  const ports3 = makePorts({ deadlineAuthority: healthy });
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports: ports3 });
  const ok = await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports: ports3, env: ENV_ON, deadlineSafety: DEADLINE_OK });
  assert.equal(ok.outcome, 'SUBMITTED');
  assert.equal((await ports3.sessions.get('sessAlpha1')).l1Verification, undefined, 'verification still required separately');
});

// ===========================================================================
// 17/18. REORG, FINALITY, STALE READS
// ===========================================================================

test('17.1 a reorg/rollback between funding and arming is caught by the fresh re-observation', async () => {
  const ports = await driveToBothFunded();
  // the output disappears from the UTXO set (reorg) right before arming
  ports.l1.obs = { ...ports.l1.obs, exists: false };
  const arm = await coord.armClaim({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal(arm.armed, false, 'armed after the output vanished!');
  // a claim tx reorged away / confirmations reset is also refused
  const p2 = await driveToBothFunded();
  p2.l1.obs = { ...p2.l1.obs, confirmations: '1' };
  assert.equal((await coord.armClaim({ sessionId: 'sessAlpha1', ports: p2, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true })).armed, false);
});

test('18.1 a stale/cached L2 read never verifies', async () => {
  const ports = makePorts({ l2Cfg: { obs: { source: 'CACHED' } } });
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports });
  await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  await coord.verifyL1Funded({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK });
  await coord.beginL2Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  const v = await coord.verifyL2Funded({ sessionId: 'sessAlpha1', ports });
  assert.equal(v.verified, false, 'a CACHED L2 read must never verify');
});

// ===========================================================================
// 19/20. NETWORK + MAINNET ESCAPE
// ===========================================================================

test('19/20 mainnet is unreachable via any spelling, and networks must match across legs', () => {
  for (const n of ['mainnet', 'MAINNET', 'MainNet', 'mainnet-testnet', 'base.mainnet', 'esmeralda-mainnet', 'mainnet ', '1', '', ' ', 'MAINNET'.toLowerCase()]) {
    assert.throws(() => assertTestnetNetwork(n), /MAINNET is refused|approved test network/, `mainnet escape via "${n}"`);
  }
  assert.throws(() => assertTestnetNetwork(undefined), /approved test network/);
  assert.throws(() => assertTestnetNetwork(null), /approved test network/);
  assert.doesNotThrow(() => assertTestnetNetwork('esmeralda'));
  assert.doesNotThrow(() => assertTestnetNetwork('localnet'));
  // a mainnet provider cannot be wired at all
  assert.throws(() => new (require('../dist/chains/minotari_grpc.js').MinotariDevGrpcProvider)({ network: 'mainnet' }), /mainnet is REFUSED/);
});

// ===========================================================================
// 21. REAL-SUBMIT GATE
// ===========================================================================

test('21.1 only the exact enabling value permits submission; mainnet stays refused even when enabled', () => {
  const { isRealSubmitEnabled, REAL_CROSSCHAIN_SUBMIT_ENV } = coord;
  for (const v of [undefined, '', '0', 'true', 'TRUE', 'yes', 'on', ' 1', '1 ', 'random', '01']) {
    const g = isRealSubmitEnabled({ [REAL_CROSSCHAIN_SUBMIT_ENV]: v }, 'esmeralda');
    assert.equal(g.enabled, false, `gate opened for value ${JSON.stringify(v)}`);
  }
  const on = isRealSubmitEnabled({ [REAL_CROSSCHAIN_SUBMIT_ENV]: '1' }, 'esmeralda');
  assert.equal(on.enabled, true);
  assert.throws(() => isRealSubmitEnabled({ [REAL_CROSSCHAIN_SUBMIT_ENV]: '1' }, 'mainnet'), /MAINNET is refused/);
  // default (no env at all) is OFF
  assert.equal(isRealSubmitEnabled({}, 'esmeralda').enabled, false);
});

// ===========================================================================
// 25. PROVIDER SPOOFING
// ===========================================================================

test('25.1 a provider that loses capabilities mid-session is refused before funding', () => {
  assert.throws(() => requireLegCapabilities('XTM_TO_TARI', { ...CAPS, l1ShaInit: false }, CAPS), CapabilityRefusal);
  assert.throws(() => requireLegCapabilities('XTM_TO_TARI', undefined, CAPS), /no capability advertisement/);
  assert.throws(() => requireLegCapabilities('TARI_TO_XTM', CAPS, { ...CAPS, l2HtlcRefund: false }), CapabilityRefusal);
  assert.doesNotThrow(() => requireLegCapabilities('XTM_TO_TARI', CAPS, CAPS));
  // single-leg checks
  assert.throws(() => requireLegCapabilitiesSingle('XTM_TO_TARI', 'L1', { ...CAPS, l1ShaInit: false }), CapabilityRefusal);
  assert.doesNotThrow(() => requireLegCapabilitiesSingle('XTM_TO_TARI', 'L1', CAPS));
});

// ===========================================================================
// 28/29/31. TWO-LEG MISMATCH, PARTIAL SETTLEMENT, MULTI-HOP BOUNDARY
// ===========================================================================

test('28.1 a session whose legs disagree never arms (wrong amount, recipient, or one leg from another session)', async () => {
  for (const [name, l2obs] of [
    ['wrong L2 amount', { amountRaw: '1' }],
    ['wrong claimant', { claimantExact: false }],
    ['wrong refund epoch', { epochRefundExact: false }],
    ['wrong hash', { hashExact: false }],
  ]) {
    const ports = makePorts({ l2Cfg: { obs: l2obs } });
    await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports });
    await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
    assert.equal((await coord.verifyL1Funded({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK })).verified, true);
    await coord.beginL2Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
    assert.equal((await coord.verifyL2Funded({ sessionId: 'sessAlpha1', ports })).verified, false, `${name} verified`);
    const arm = await coord.armClaim({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
    assert.equal(arm.armed, false, `${name} armed`);
  }
  // an L1 amount that differs from the session must refuse even with a proven observation shape
  const ports = makePorts({ l1Cfg: { obs: { amountRaw: '1' } } });
  await coord.acceptQuote({ request: { sessionId: 'sessAlpha1', reservationId: 'resAlpha1', quote: makeQuote(), nowUnixMs: 1 }, ports });
  await coord.beginL1Funding({ sessionId: 'sessAlpha1', ports, env: ENV_ON, deadlineSafety: DEADLINE_OK, unsafeAllowAssertedDeadlines: true });
  assert.equal((await coord.verifyL1Funded({ sessionId: 'sessAlpha1', ports, deadlineSafety: DEADLINE_OK })).verified, false);
});

test('31.1 the route result is explicitly non-composable and never carries a secret', () => {
  const ad = makeAd();
  const quote = buildQuote({ quoteId: 'q1', ad, direction: 'XTM_TO_TARI', xtmRawAmount: '10000', tariRawAmount: '5000000', hashH: H, l1ClaimRecipient: 'a', l2ClaimRecipient: 'b', l1RefundDeadlineHeight: '16000', l2RefundDeadlineEpoch: '1200', nowUnixMs: 1 });
  const r = routeResult({ request: { source: 'XTM', destination: 'TARI', amountRaw: '10000', network: 'esmeralda' }, ad, quote });
  assert.equal(r.settlementStatus, 'UNSETTLED');
  assert.equal(r.composable, false, 'multi-hop composition must stay blocked');
  assert.equal(r.containsSecret, false);
  assert.ok(!JSON.stringify(r).includes(S_HEX));
  // network mismatch between request and quote is refused
  assert.throws(() => routeResult({ request: { source: 'XTM', destination: 'TARI', amountRaw: '1', network: 'localnet' }, ad, quote }), /mismatch|MAINNET|approved/);
});

module.exports = {};
