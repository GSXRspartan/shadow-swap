const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const { sha256, bytesToHex, hexToBytes, verifyPreimage, InMemorySecretStore } = require('../dist/crosschain/secret.js');
const {
  serializeShaHtlcScript,
  decodeShaHtlcScript,
  executeShaHtlcBranch,
  refundBranchReachable,
  sha256SyncExport,
} = require('../dist/chains/minotari.js');
const {
  MinotariDevGrpcProvider,
  MINOTARI_WALLET_GRPC_METHODS,
  MINOTARI_REFERENCE_FEE_PER_GRAM,
  DEVELOPMENT_REFERENCE_PROVIDER,
} = require('../dist/chains/minotari_grpc.js');
const { requireLegCapabilitiesSingle, CapabilityRefusal } = require('../dist/crosschain/provider.js');

// ---------------------------------------------------------------------------
// Phase 5 — SHA256 interop: Minotari H == Ootle H for identical S
//
// Traced facts (C:\tmp-tari-l1 @ tari v6.0.0, commit 97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3):
//  - Minotari init: H = Sha256::digest(pre_image.as_bytes()) (transaction_service/service.rs:2204)
//    — plain SHA-256 over the raw 32-byte compressed Ristretto point, NO domain separation.
//  - Ootle hashlock: hashlock_digest(Sha256, preimage) = plain SHA-256 over the bytes,
//    "no domain separation so a hashlock can interoperate with an external chain's HTLC"
//    (engine_types/src/stealth/hashlock.rs).
// => both sides compute plain SHA-256 over identical 32-byte input: byte-for-byte equal H.
// Vectors are checked against node:crypto (independent of our implementation).
// ---------------------------------------------------------------------------

function nodeSha256Hex(bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}

const VECTORS = [
  { name: '32 zero bytes', input: new Uint8Array(32) },
  { name: 'incrementing 0x00..0x1f', input: new Uint8Array(32).map((_, i) => i) },
  {
    name: 'random-looking fixed vector',
    input: hexToBytes('a3f29d5c8146b7e0f1c2d3e4a5b6c7d8091a2b3c4d5e6f708192a3b4c5d6e7f0'),
  },
];

test('SHA256 interop: fixed vectors agree with node:crypto on both sync + async paths', async () => {
  for (const v of VECTORS) {
    const expected = nodeSha256Hex(v.input);
    assert.equal(expected.length, 64);
    // Minotari-side sync verifier (mirrors handle_hash<Sha256> semantics)
    assert.equal(bytesToHex(sha256SyncExport(v.input)), expected, v.name);
    // Ootle/coordinator-side WebCrypto path
    assert.equal(bytesToHex(await sha256(v.input)), expected, v.name);
  }
});

test('SHA256("abc") matches the NIST vector the Ootle engine test enforces', async () => {
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const input = hexToBytes('616263'); // "abc"
  assert.equal(bytesToHex(sha256SyncExport(input)), expected);
  assert.equal(bytesToHex(await sha256(input)), expected);
});

test('wallet-generated preimage: SHA256(S) binds identically to the ingested store', async () => {
  const store = new InMemorySecretStore();
  const s = hexToBytes('11'.repeat(32));
  const h = nodeSha256Hex(s);
  const stored = await store.ingestExternalSecret('sess_x', bytesToHex(s));
  assert.equal(stored.hashH, h);
  const revealed = await store.revealSecret('sess_x', true);
  assert.equal(await verifyPreimage(revealed, stored.hashH), true);
  await assert.rejects(() => store.ingestExternalSecret('sess_y', 'zz'), /64 lowercase hex/);
});

// ---------------------------------------------------------------------------
// Traced TariScript serialization + execution
// (opcodes: 0xb1 HashSha256, 0x7a PushHash, 0x80 Equal, 0x61 IfThen, 0x62 Else,
//  0x63 EndIf, 0x7e PushPubKey, 0x66 CheckHeightVerify — u64 LEB128 varint)
// ---------------------------------------------------------------------------

// The L1 wallet itself generates S; the harness fixes one 32-byte value and derives H.
const SECRET_S = bytesToHex(new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff));
const HASH64 = nodeSha256Hex(hexToBytes(SECRET_S));
const CLAIM_PK = '11'.repeat(32);
const REFUND_PK = '22'.repeat(32);
const REFUND_HEIGHT = '16000';
const CURRENT_HEIGHT = '10000';
const MINED_HEIGHT = '10000';

function htlcFixture() {
  return { hashHex: HASH64, claimPubKeyHex: CLAIM_PK, refundPubKeyHex: REFUND_PK, refundHeight: REFUND_HEIGHT };
}

test('script serialization emits the exact traced opcode layout', () => {
  const bytes = Array.from(serializeShaHtlcScript(htlcFixture()));
  const expected = [
    0xb1,
    0x7a, ...Array.from(hexToBytes(HASH64)),
    0x80,
    0x61,
    0x7e, ...Array.from(hexToBytes(CLAIM_PK)),
    0x62,
    0x66, 0x80, 0x7d, // CheckHeightVerify(16000) — LEB128 varint: 16000 = 0x80 0x7d
    0x7e, ...Array.from(hexToBytes(REFUND_PK)),
    0x63,
  ];
  assert.deepEqual(bytes, expected);
});

test('decode round-trips hash/claimant/refund-identity/refund-height', () => {
  const bytes = serializeShaHtlcScript(htlcFixture());
  const view = decodeShaHtlcScript(bytes);
  assert.equal(view.hashHex, HASH64);
  assert.equal(view.claimPubKeyHex, CLAIM_PK);
  assert.equal(view.refundPubKeyHex, REFUND_PK);
  assert.equal(view.refundHeight, REFUND_HEIGHT);
});

test('decode fails closed on truncated scripts, bad opcodes, and trailing bytes', () => {
  const bytes = serializeShaHtlcScript(htlcFixture());
  assert.throws(() => decodeShaHtlcScript(bytes.subarray(0, 10)), /Truncated/);
  assert.throws(() => decodeShaHtlcScript(new Uint8Array([0x00, 0x01])), /Unexpected Minotari script opcode/);
  // trailing byte after EndIf
  const trailing = new Uint8Array(bytes.length + 1);
  trailing.set(bytes);
  trailing[bytes.length] = 0x7b;
  assert.throws(() => decodeShaHtlcScript(trailing), /Trailing bytes/);
  // corrupted control opcode (Equal → EqualVerify)
  const bad = bytes.slice();
  bad[34] = 0x81;
  assert.throws(() => decodeShaHtlcScript(bad), /Unexpected Minotari script opcode/);
});

// ---------------------------------------------------------------------------
// Real hashlock boundary: wrong preimage must fail at the traced script semantics
// ---------------------------------------------------------------------------

test('wrong preimage (correct length) refused by hashlock; correct S executes the claim branch', () => {
  const bytes = serializeShaHtlcScript(htlcFixture());
  const wrongS = bytesToHex(new Uint8Array(32).fill(0x99));
  const wrong = executeShaHtlcBranch(bytes, wrongS, CURRENT_HEIGHT);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /hashlock refused/);
  const right = executeShaHtlcBranch(bytes, SECRET_S, CURRENT_HEIGHT);
  assert.equal(right.ok, true);
  assert.equal(right.requiredScriptSignaturePubKeyHex, CLAIM_PK);
  assert.equal(right.refundReachable, false);
});

test('refund branch: CheckHeightVerify passes only at/after the refund height', () => {
  const view = decodeShaHtlcScript(serializeShaHtlcScript(htlcFixture()));
  assert.equal(refundBranchReachable(view, '15999'), false);
  assert.equal(refundBranchReachable(view, '16000'), true);
  assert.equal(refundBranchReachable(view, '16001'), true);
});

// ---------------------------------------------------------------------------
// MinotariDevGrpcProvider — capability advertisement + traced RPC mapping
// ---------------------------------------------------------------------------

function fakeTransport(handlers, calls) {
  return {
    call: async (method, request) => {
      calls.push({ method, request });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler(request);
    },
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const harness = {
    calls,
    markUtxoSpent: false,
    tipHeight: '10010',
    handlers: {},
    readbackCalls: 0,
  };
  const provider = new MinotariDevGrpcProvider({
    network: 'esmeralda',
    walletAddress: 'w1',
    walletTransport: fakeTransport(harness.handlers, calls),
    baseNodeReadback: {
      getTipInfo: async () => ({ bestBlockHeight: harness.tipHeight, synced: true }),
      fetchUtxos: async (hashes) => {
        harness.readbackCalls = (harness.readbackCalls || 0) + 1;
        if (harness.markUtxoSpent) return [];
        return [
          {
            outputHashHex: harness.outputHashHex,
            minedAtHeight: MINED_HEIGHT,
            scriptBytesHex: bytesToHex(serializeShaHtlcScript(htlcFixture())),
            // Only present when the adapter can produce a chain-validated opening.
            ...(harness.provenAmountRaw !== undefined ? { amountRaw: harness.provenAmountRaw } : {}),
          },
        ];
      },
      queryDeleted: async (hashes) => {
        harness.readbackCalls = (harness.readbackCalls || 0) + 1;
        if (harness.markUtxoSpent) {
          return [{ outputHashHex: harness.outputHashHex, minedAtHeight: MINED_HEIGHT, heightDeletedAt: '10005' }];
        }
        return [];
      },
    },
    ...overrides,
  });
  harness.handlers[MINOTARI_WALLET_GRPC_METHODS.SendShaAtomicSwapTransaction] = async (req) => ({
    transaction_id: 777n,
    pre_image: SECRET_S,
    output_hash: 'cd'.repeat(32),
    is_success: true,
    failure_message: '',
  });
  harness.handlers[MINOTARI_WALLET_GRPC_METHODS.GetTransactionInfo] = async (req) => ({
    transactions: [{ tx_id: req.transaction_ids[0], status: harness.txStatus ?? 'TRANSACTION_STATUS_MINED_CONFIRMED' }],
  });
  harness.handlers[MINOTARI_WALLET_GRPC_METHODS.GetBalance] = async () => ({
    available_balance: 90000n,
    pending_incoming_balance: 1000n,
    pending_outgoing_balance: 0n,
    timelocked_balance: 0n,
  });
  harness.handlers[MINOTARI_WALLET_GRPC_METHODS.ClaimShaAtomicSwapTransaction] = async () => ({
    results: { transaction_id: 888n, is_success: true, failure_message: '' },
  });
  harness.handlers[MINOTARI_WALLET_GRPC_METHODS.ClaimHtlcRefundTransaction] = async () => ({
    results: { transaction_id: 999n, is_success: true, failure_message: '' },
  });
  harness.provider = provider;
  return harness;
}

function fundingIntent(provider) {
  const { intent } = provider.constructHtlcFunding({
    amountRaw: '10000',
    hash: HASH64,
    claimRecipient: 'l1claim',
    refundRecipient: 'l1refund',
    refundHeight: REFUND_HEIGHT,
    network: 'esmeralda',
    operationId: 'op1',
  });
  return intent;
}

test('provider refuses mainnet and degrades capabilities honestly', () => {
  assert.throws(() => new MinotariDevGrpcProvider({ network: 'mainnet' }), /mainnet/i);
  const bare = new MinotariDevGrpcProvider({ network: 'esmeralda' });
  assert.equal(bare.primitivesStatus(), 'PENDING_TRACE');
  assert.equal(bare.capabilities().l1ShaInit, false);
  assert.equal(bare.capabilities().l1ShaInspect, false);
  assert.equal(bare.capabilities().l2HtlcFund, false);
  assert.equal(DEVELOPMENT_REFERENCE_PROVIDER, true);
  const wired = makeHarness();
  assert.equal(wired.provider.primitivesStatus(), 'VERIFIED');
  assert.equal(wired.provider.capabilities().l1ShaInit, true);
  assert.equal(wired.provider.capabilities().l1ShaInspect, true);
});

test('capability negotiation fails closed per leg before any funding', () => {
  const allFalse = { l1Balance: false, l1ShaInit: false, l1ShaInspect: false, l1ShaRefund: false, l2HtlcFund: false, l2HtlcClaim: false, l2HtlcRefund: false };
  assert.throws(() => requireLegCapabilitiesSingle('XTM_TO_TARI', 'L1', allFalse), CapabilityRefusal);
  assert.doesNotThrow(() =>
    requireLegCapabilitiesSingle('XTM_TO_TARI', 'L1', {
      l1Balance: true,
      l1ShaInit: true,
      l1ShaInspect: true,
      l1ShaRefund: true,
      l2HtlcFund: false,
      l2HtlcClaim: false,
      l2HtlcRefund: false,
    }),
  );
  assert.throws(() => requireLegCapabilitiesSingle('XTM_TO_TARI', 'L2', undefined), /no capability advertisement/);
});

test('funding maps onto SendShaAtomicSwapTransaction and returns wallet-generated S', async () => {
  const h = makeHarness(); const provider = h.provider;
  const { intent } = provider.constructHtlcFunding({ amountRaw: '10000', hash: HASH64, claimRecipient: 'l1claim', refundRecipient: 'l1refund', refundHeight: REFUND_HEIGHT, network: 'esmeralda', operationId: 'op1' });
  const submitted = await provider.submitFunding(intent);
  assert.equal(submitted.l1TxId, '777');
  assert.equal(submitted.walletPreimageHex, SECRET_S);
  assert.match(submitted.outputHashHex, /^[0-9a-f]{64}$/);
  h.outputHashHex = submitted.outputHashHex;
  const call = h.calls.find((c) => c.method === MINOTARI_WALLET_GRPC_METHODS.SendShaAtomicSwapTransaction);
  assert.equal(call.request.recipient.amount, 10000n);
  assert.equal(call.request.recipient.payment_type, 'ONE_SIDED_TO_STEALTH_ADDRESS');
  // The intent carries NO hash/refund-recipient/refund-height on the wire: the traced RPC
  // request is `{recipient}` only — the wallet generates S/H, the refund key, and tip+720.
  assert.deepEqual(Object.keys(call.request), ['recipient']);
  assert.deepEqual(Object.keys(call.request.recipient).sort(), ['address', 'amount', 'fee_per_gram', 'payment_type']);
  assert.equal(call.request.recipient.fee_per_gram, MINOTARI_REFERENCE_FEE_PER_GRAM);
  // A caller-supplied fee hint is forwarded (the wallet still recomputes it upstream).
  const feeHarness = makeHarness({ fundingFeeTPerGram: 25 });
  const feeIntent = fundingIntent(feeHarness.provider);
  await feeHarness.provider.submitFunding(feeIntent);
  const feeCall = feeHarness.calls.find((c) => c.method === MINOTARI_WALLET_GRPC_METHODS.SendShaAtomicSwapTransaction);
  assert.equal(feeCall.request.recipient.fee_per_gram, 25);
  // failed RPC refuses
  const rejected = new MinotariDevGrpcProvider({
    network: 'esmeralda',
    walletTransport: { call: async () => ({ is_success: false, failure_message: 'insufficient funds' }) },
  });
  await assert.rejects(() => rejected.submitFunding(intent), /insufficient/);
});

test('observeHtlc re-derives hash/claimant/refund-height from the AUTHORITATIVE script', async () => {
  const h = makeHarness();
  const submitted = await h.provider.submitFunding({ amountRaw: '10000', hash: HASH64, claimRecipient: 'l1claim', refundRecipient: 'l1refund', refundHeight: REFUND_HEIGHT, network: 'esmeralda', operationId: 'op' });
  h.outputHashHex = submitted.outputHashHex;
  const obs = await h.provider.observeHtlc('777');
  assert.equal(obs.exists, true);
  assert.equal(obs.source, 'BASE_NODE');
  assert.equal(obs.hashHex, HASH64);
  assert.equal(obs.claimRecipient, CLAIM_PK);
  assert.equal(obs.refundHeight, REFUND_HEIGHT);
  assert.equal(obs.confirmations, '11'); // tip 10010, mined 10000
  assert.equal(obs.spent, false);
  assert.equal(obs.outputHashHex, 'cd'.repeat(32));
});

test('observeHtlc re-derives the WALLET-OWNED refund key and refuses to call a blinded amount authoritative', async () => {
  const h = makeHarness();
  const submitted = await h.provider.submitFunding({ amountRaw: '10000', hash: HASH64, claimRecipient: 'l1claim', refundRecipient: 'l1refund', refundHeight: REFUND_HEIGHT, network: 'esmeralda', operationId: 'op' });
  h.outputHashHex = submitted.outputHashHex;
  const obs = await h.provider.observeHtlc('777');
  // The refund branch is the funding wallet's OWN spend key, re-derived from the script —
  // NOT the claim address the intent passed as refundRecipient.
  assert.equal(obs.refundRecipient, REFUND_PK);
  assert.notEqual(obs.refundRecipient, 'l1refund');
  // A base-node TransactionOutput carries a blinded commitment, not a revealed value.
  assert.equal(obs.amountRaw, '10000');
  assert.equal(obs.amountAuthoritative, false);
});

test('a readback adapter that CAN prove the amount reports it as authoritative', async () => {
  const h = makeHarness();
  h.provenAmountRaw = '10000';
  const submitted = await h.provider.submitFunding({ amountRaw: '10000', hash: HASH64, claimRecipient: 'l1claim', refundRecipient: 'l1refund', refundHeight: REFUND_HEIGHT, network: 'esmeralda', operationId: 'op' });
  h.outputHashHex = submitted.outputHashHex;
  const obs = await h.provider.observeHtlc('777');
  assert.equal(obs.amountAuthoritative, true);
  assert.equal(obs.amountRaw, h.provenAmountRaw);
});

test('observeHtlc reports SPENT via the deleted query; preimage verified against the script', async () => {
  const h = makeHarness();
  h.markUtxoSpent = true;
  const submitted = await h.provider.submitFunding({ amountRaw: '10000', hash: HASH64, claimRecipient: 'l1claim', refundRecipient: 'l1refund', refundHeight: REFUND_HEIGHT, network: 'esmeralda', operationId: 'op' });
  h.outputHashHex = submitted.outputHashHex;
  const obs = await h.provider.observeHtlc('777');
  assert.equal(obs.spent, true);
  assert.equal(obs.source, 'BASE_NODE');

  const p2 = makeHarness();
  const submitted2 = await p2.provider.submitFunding({ amountRaw: '10000', hash: HASH64, claimRecipient: 'l1claim', refundRecipient: 'l1refund', refundHeight: REFUND_HEIGHT, network: 'esmeralda', operationId: 'op' });
  p2.outputHashHex = submitted2.outputHashHex;
  const scriptHex = bytesToHex(serializeShaHtlcScript(htlcFixture()));
  const wrong = p2.provider.verifyPreimageAgainstScript(scriptHex, bytesToHex(new Uint8Array(32).fill(0x99)), CURRENT_HEIGHT);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /hashlock refused/);
  const right = p2.provider.verifyPreimageAgainstScript(scriptHex, SECRET_S, CURRENT_HEIGHT);
  assert.equal(right.ok, true);
  assert.equal(right.requiredScriptSignaturePubKeyHex, CLAIM_PK);
});

test('RECONCILE maps wallet TransactionStatus onto the coordinator vocabulary', async () => {
  const h = makeHarness();
  assert.equal(await h.provider.lookupTransaction('1234'), 'COMMITTED');
  h.txStatus = 'TRANSACTION_STATUS_CANCELLED';
  assert.equal(await h.provider.lookupTransaction('1234'), 'REJECTED');
  h.txStatus = 'TRANSACTION_STATUS_BROADCAST';
  assert.equal(await h.provider.lookupTransaction('1234'), 'UNKNOWN');
});

test('balance and u64 validation fail closed on malformed responses', async () => {
  const h = makeHarness(); const provider = h.provider;
  const bal = await provider.balance('w1');
  assert.deepEqual(bal, { available: '90000', pendingIncoming: '1000', pendingOutgoing: '0' });
  await assert.rejects(() => provider.balance('other'), /unknown wallet/);
  const bad = new MinotariDevGrpcProvider({
    network: 'esmeralda',
    walletTransport: { call: async () => ({ available_balance: 'not-a-number' }) },
  });
  await assert.rejects(() => bad.balance('w1'), /u64/);
});