require('./bootstrap.cjs');
/**
 * DURABLE WALLET APPROVAL — the security suite for the reload-safe request path.
 *
 * Every test here maps to a failure the browser could actually produce, and every
 * assertion is about what must NOT happen rather than about a happy path. The
 * central hazard is duplicate financial submission:
 *
 *   The wallet mints a durable `requestId`, then waits for a human. If the app
 *   treats "still waiting" as a failure, the user is shown a red state for a
 *   request that is still live, the natural next action is to press the button
 *   again, a SECOND request is minted for the same intent, and approving both
 *   popups executes the trade twice.
 *
 * That hazard is reachable from three directions, and each has its own test:
 *
 *   1. The sign layer must brand "awaiting approval" rather than throw it as a
 *      generic failure, so `executeResolved` records PENDING and not FAILED.
 *   2. A fresh submission must be refused while an unresolved request exists.
 *   3. The durable ledger must survive a reload, and must be UNTRUSTED when it
 *      comes back: forged state may DENY a user's money moving, never allow it.
 *
 * The asymmetry asserted throughout is deliberate and is the whole design: a
 * tampered `localStorage` must be able to stop a resume, and must never be able to
 * cause one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  awaitingApproval,
  isAwaitingApproval,
  isAwaitingApprovalReason,
  AWAITING_APPROVAL_REASON,
  executeResolved,
  requireFreshSubmissionAllowed,
  InMemoryHistoryStore,
  createOperationRecord,
} = require('@tari-ootle/protocol-client');

const pending = require('../build-test/lib/pendingRequests.js');
const execution = require('../build-test/services/execution.js');
const tari = require('../build-test/services/tariWindow.js');

const ACCOUNT_A = 'component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b';
const ACCOUNT_B = 'component_b510055406cbe43325aa7790a38f980eb03d354f525b0acc7c59461b07dde77d';
const NETWORK = 'esmeralda';
const FINGERPRINT = 'fp:9f2c1a';

// ---------------------------------------------------------------------------
// 1. AWAITING APPROVAL IS NOT A FAILURE
// ---------------------------------------------------------------------------

test('awaiting-approval: the brand is set and is not spoofable by message text', () => {
  const branded = awaitingApproval('nothing happened yet');
  assert.equal(isAwaitingApproval(branded), true);
  // A same-worded error from anywhere else must NOT be treated as awaiting
  // approval, or an unrelated failure could be silently reclassified as
  // recoverable and left dangling.
  assert.equal(isAwaitingApproval(new Error('nothing happened yet')), false);
  assert.equal(isAwaitingApproval({ message: 'nothing happened yet' }), false);
  assert.equal(isAwaitingApproval(undefined), false);
});

test('awaiting-approval: the brand survives a structured clone boundary', () => {
  // `Symbol.for` is deliberate: the marker must still be recognised if the error
  // crosses a bundler chunk boundary or a duplicated module instance, so the two
  // sides of the check cannot disagree merely because they are different objects.
  const branded = awaitingApproval('x');
  assert.equal(branded[AWAITING_APPROVAL_SYM()], true);
});

function AWAITING_APPROVAL_SYM() {
  return Symbol.for('tari.ootle.awaitingWalletApproval');
}

test('awaiting-approval: the brand is not enumerable, so it cannot leak into logs or JSON', () => {
  const branded = awaitingApproval('secret-free message');
  assert.deepEqual(Object.keys(branded), []);
  assert.equal(JSON.parse(JSON.stringify(branded)).AWAITING_APPROVAL, undefined);
});

test('regression: awaiting approval records PENDING, never FAILED', async () => {
  // THE DEFECT THIS FIXES. Before, a pending request was reported as a generic
  // sign error and `executeResolved`'s Layer-2 catch stamped the durable record
  // FAILED. A FAILED record tells the user nothing is pending, so they start
  // again — and two live requests exist for one intent.
  const history = new InMemoryHistoryStore();
  let sawRequestId = false;

  const result = await executeResolved({
    resolvedIntent: { kind: 'swap' },
    recordInput: {
      operationId: 'op-awaiting',
      operationKind: 'AMM_SWAP',
      resources: ['resource_aa'],
      amounts: { amountIn: '1000' },
      lastReadback: { source: 'WALLET_PROVIDER', identity: {} },
    },
    history,
    transport: {
      construct: () => ({ preview: {} }),
      // The wallet minted a durable request and the human has not answered.
      sign: async () => {
        throw awaitingApproval('Operation op-awaiting is awaiting wallet approval of request req-1.');
      },
      submit: async () => ({ transactionId: 'never' }),
      lookup: { async statusByTransactionId() { return 'UNKNOWN'; } },
    },
  });

  assert.equal(sawRequestId, false, 'the sign layer throws before submit, so nothing was broadcast');
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.record.state, 'PENDING', 'a live wallet request must never be recorded as FAILED');
  assert.ok(isAwaitingApprovalReason(result.record.failureReason), 'the reason must be the recoverable marker');
  assert.equal(result.record.transactionId, undefined, 'nothing was submitted, so there is no transaction id');

  const stored = await history.get('op-awaiting');
  assert.equal(stored.state, 'PENDING', 'the persisted record must agree with the returned one');
});

test('regression: awaiting approval BLOCKS a resubmission of the same operation', async () => {
  // Without this, "PENDING" was an explicitly permitted state to submit again from,
  // which is precisely the duplicate-broadcast window.
  const record = createOperationRecord({
    operationId: 'op-1',
    operationKind: 'AMM_SWAP',
    resources: [],
    amounts: {},
    lastReadback: { source: 'WALLET_PROVIDER', identity: {} },
  });
  record.failureReason = `${AWAITING_APPROVAL_REASON}: awaiting wallet approval of request req-1`;
  assert.throws(() => requireFreshSubmissionAllowed(record), /awaiting approval/);

  // A plain PENDING with no approval marker is still permitted: an operation that
  // was constructed but never reached a signer has nothing outstanding in the
  // wallet, and refusing it would strand the user with no way to try again.
  const plain = { ...record, failureReason: undefined };
  assert.doesNotThrow(() => requireFreshSubmissionAllowed(plain));
});

test('a genuine sign failure is still FAILED, and is still resumable', async () => {
  // The fix must not have swallowed real failures into a vague "pending".
  const history = new InMemoryHistoryStore();
  const result = await executeResolved({
    resolvedIntent: { kind: 'swap' },
    recordInput: {
      operationId: 'op-real-failure',
      operationKind: 'AMM_SWAP',
      resources: [],
      amounts: {},
      lastReadback: { source: 'WALLET_PROVIDER', identity: {} },
    },
    history,
    transport: {
      construct: () => ({ preview: {} }),
      sign: async () => {
        throw new Error('the wallet rejected the transaction request');
      },
      submit: async () => ({ transactionId: 'never' }),
      lookup: { async statusByTransactionId() { return 'UNKNOWN'; } },
    },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.record.state, 'FAILED');
  assert.equal(isAwaitingApprovalReason(result.record.failureReason), false);
});

// ---------------------------------------------------------------------------
// 2. NO SECOND SUBMISSION WHILE ONE IS PENDING
// ---------------------------------------------------------------------------

function fakeWallets(blocking) {
  return {
    preview: async (p) => p,
    signAndSubmit: async () => {
      throw new Error('the signer must never be reached in these tests');
    },
    getTransactionStatus: async () => ({ status: 'UNKNOWN' }),
    blockingPendingRequest: () => blocking,
  };
}

test('duplicate-submit: a second operation is refused while one awaits approval', async () => {
  const blocking = { operationId: 'op-first', operation: 'AMM_SWAP' };
  await assert.rejects(
    () =>
      execution.executeSwap(fakeWallets(blocking), {
        resolvedIntent: { operation: 'AMM_SWAP' },
        recordInput: {
          operationId: 'op-second',
          operationKind: 'AMM_SWAP',
          resources: ['resource_0101010101010101010101010101010101010101010101010101010101010101'],
          amounts: { amountIn: '1000' },
          lastReadback: { source: 'WALLET_PROVIDER', identity: {} },
        },
        toPreview: () => ({ componentAddress: 'component_x' }),
        context: { assets: ['tTARI'], operation: 'AMM_SWAP', network: NETWORK, poolOrDestination: 'component_x', privacyDisclosure: '' },
        identity: {},
        liveIdentity: {},
        review: {},
      }),
    (error) => error instanceof execution.PendingApprovalError && /would execute both/.test(error.message),
  );
});

test('duplicate-submit: re-submitting the SAME operation is not self-blocked', async () => {
  // The gate must key on "a DIFFERENT request is outstanding", otherwise an
  // idempotent retry of one operation would refuse itself and the user could never
  // make progress.
  const blocking = { operationId: 'op-same', operation: 'AMM_SWAP' };
  let reachedSigner = false;
  const wallets = {
    preview: async (p) => p,
    signAndSubmit: async () => {
      reachedSigner = true;
      return { transactionId: 'tx-1', status: 'pending' };
    },
    getTransactionStatus: async () => ({ status: 'COMMITTED' }),
    blockingPendingRequest: () => blocking,
  };
  // The review gates fail first with an empty review object, which is the point:
  // the pending-request gate ran BEFORE them and did not throw.
  await assert.rejects(() =>
    execution.executeSwap(wallets, {
      resolvedIntent: { operation: 'AMM_SWAP' },
      recordInput: {
        operationId: 'op-same',
        operationKind: 'AMM_SWAP',
        resources: ['resource_0101010101010101010101010101010101010101010101010101010101010101'],
        amounts: {},
        lastReadback: { source: 'WALLET_PROVIDER', identity: {} },
      },
      toPreview: () => ({ componentAddress: 'component_x' }),
      context: { assets: ['tTARI'], operation: 'AMM_SWAP', network: NETWORK, poolOrDestination: 'component_x', privacyDisclosure: '' },
      identity: {},
      liveIdentity: {},
      review: {},
    }),
  );
  assert.equal(reachedSigner, false);
});

test('duplicate-submit: the gate is absent-safe for a wallet with no ledger', () => {
  const wallets = { preview: async (p) => p, signAndSubmit: async () => ({}), getTransactionStatus: async () => ({ status: 'UNKNOWN' }) };
  assert.equal(wallets.blockingPendingRequest, undefined, 'a legacy wallet seam simply does not expose the gate');
});

// ---------------------------------------------------------------------------
// 3. THE DURABLE LEDGER
// ---------------------------------------------------------------------------

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

const validRequest = (over = {}) => ({
  operationId: 'op-1',
  requestId: 'req-abc',
  reviewFingerprint: FINGERPRINT,
  operation: 'AMM_SWAP',
  approvedAccount: ACCOUNT_A,
  approvedNetwork: NETWORK,
  destination: 'component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2',
  createdAtUnixMs: 1758000000000,
  state: 'AWAITING_APPROVAL',
  ...over,
});

test('ledger: a valid request round-trips through storage', () => {
  const storage = memoryStorage();
  pending.rememberPendingRequest(storage, validRequest());
  const [record] = pending.listPendingRequests(storage);
  assert.equal(record.operationId, 'op-1');
  assert.equal(record.requestId, 'req-abc');
  assert.equal(record.reviewFingerprint, FINGERPRINT);
  assert.equal(record.state, 'AWAITING_APPROVAL');
});

test('ledger: a reload preserves the request (this is the recovery guarantee)', () => {
  const first = memoryStorage();
  pending.rememberPendingRequest(first, validRequest());
  // A reload is a NEW storage handle over the SAME bytes. Nothing is in memory.
  const afterReload = memoryStorage(Object.fromEntries(first.map));
  const [record] = pending.listPendingRequests(afterReload);
  assert.ok(record, 'a reload must not lose an approval the user already gave');
  assert.equal(record.requestId, 'req-abc');
});

test('ledger: it holds no instructions, amounts, nonce, or signature', () => {
  const storage = memoryStorage();
  pending.rememberPendingRequest(storage, validRequest());
  const raw = storage.map.get(pending.PENDING_REQUEST_STORAGE_KEY);
  for (const forbidden of ['instructions', 'amountIn', 'amountOut', 'nonce', 'signature', 'preimage']) {
    assert.equal(raw.includes(forbidden), false, `the ledger must not persist ${forbidden}; it is not replayable`);
  }
});

test('ledger: a request carrying a secret field is REJECTED, not sanitised', () => {
  for (const field of ['preimageHex', 'seedPhrase', 'mnemonic', 'privateKey', 'signature', 'nonce', 'instructions']) {
    const storage = memoryStorage();
    pending.rememberPendingRequest(storage, validRequest({ [field]: 'anything' }));
    assert.deepEqual(
      pending.listPendingRequests(storage),
      [],
      `a record carrying ${field} must be dropped whole rather than stored with the field stripped`,
    );
  }
});

test('ledger: a tampered payload yields ZERO records, never a best-effort subset', () => {
  for (const corrupt of ['not json', '[]', '{}', '{"requests":"nope"}', 'null']) {
    const loaded = pending.loadPendingRequests(corrupt);
    assert.equal(loaded.records.length, 0, `payload ${corrupt} must yield nothing`);
  }
});

test('ledger: an oversized payload is refused rather than parsed', () => {
  const huge = JSON.stringify({ requests: Array.from({ length: 50000 }, () => validRequest()) });
  const loaded = pending.loadPendingRequests(huge);
  assert.equal(loaded.records.length, 0);
  assert.equal(loaded.corrupt, true);
});

test('ledger: the record count is bounded', () => {
  const storage = memoryStorage();
  for (let i = 0; i < 200; i += 1) pending.rememberPendingRequest(storage, validRequest({ operationId: `op-${i}` }));
  assert.ok(pending.listPendingRequests(storage).length <= 50, 'a hostile writer must not make the scan unbounded');
});

test('ledger: a record missing its requestId is dropped', () => {
  for (const field of ['operationId', 'requestId', 'reviewFingerprint', 'approvedAccount', 'approvedNetwork', 'state']) {
    const bad = validRequest();
    delete bad[field];
    assert.equal(pending.validatePendingRequest(bad), undefined, `a record without ${field} is not resumable`);
  }
});

test('ledger: an unrecognised state is dropped rather than coerced', () => {
  assert.equal(pending.validatePendingRequest(validRequest({ state: 'DEFINITELY_SETTLED' })), undefined);
  assert.equal(pending.validatePendingRequest(validRequest({ state: 'approved' })), undefined, 'states are matched exactly');
});

test('ledger: storage that throws degrades to no ledger instead of breaking approval', () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.deepEqual(pending.listPendingRequests(hostile), []);
  assert.doesNotThrow(() => pending.rememberPendingRequest(hostile, validRequest()));
  assert.doesNotThrow(() => pending.forgetPendingRequest(hostile, 'op-1'));
  // Undefined storage (a server render, or private mode) is equally non-fatal.
  assert.deepEqual(pending.listPendingRequests(undefined), []);
});

test('ledger: a request is forgotten only for a settled operation', () => {
  const storage = memoryStorage();
  pending.rememberPendingRequest(storage, validRequest());
  assert.equal(pending.needsAttention(pending.listPendingRequests(storage)[0]), true, 'AWAITING_APPROVAL still needs attention');
  assert.equal(pending.needsAttention(validRequest({ state: 'SUBMITTED' })), true, 'submitted is not settled until the chain agrees');
  assert.equal(pending.needsAttention(validRequest({ state: 'REJECTED' })), false);
  assert.equal(pending.needsAttention(validRequest({ state: 'FAILED' })), false);
  assert.equal(pending.needsAttention(validRequest({ state: 'UNKNOWN' })), true, 'UNKNOWN is never treated as settled');
});

// ---------------------------------------------------------------------------
// 4. THE ANTI-SUBSTITUTION BINDINGS — a forged ledger may only DENY
// ---------------------------------------------------------------------------

test('resume: a matching live session is permitted', () => {
  assert.equal(
    pending.resumeBlockReason(validRequest(), { account: ACCOUNT_A, network: NETWORK, reviewFingerprint: FINGERPRINT }),
    undefined,
  );
});

test('resume: a switched ACCOUNT refuses', () => {
  assert.equal(
    pending.resumeBlockReason(validRequest(), { account: ACCOUNT_B, network: NETWORK, reviewFingerprint: FINGERPRINT }),
    'ACCOUNT_CHANGED',
  );
});

test('resume: a switched NETWORK refuses', () => {
  assert.equal(
    pending.resumeBlockReason(validRequest(), { account: ACCOUNT_A, network: 'localnet', reviewFingerprint: FINGERPRINT }),
    'NETWORK_CHANGED',
  );
});

test('resume: a substituted REVIEW refuses', () => {
  // The transaction on screen is not the transaction that was approved. Submitting
  // it would break "shown == signed" across a reload.
  assert.equal(
    pending.resumeBlockReason(validRequest(), { account: ACCOUNT_A, network: NETWORK, reviewFingerprint: 'fp:DIFFERENT' }),
    'REVIEW_SUBSTITUTED',
  );
});

test('resume: no live review at all refuses', () => {
  // A resume cannot re-derive the transaction to prove anything, so with nothing
  // on screen to compare against there is nothing to authorise.
  assert.equal(
    pending.resumeBlockReason(validRequest(), { account: ACCOUNT_A, network: NETWORK }),
    'NO_LIVE_REVIEW',
  );
});

test('resume: forging the persisted network/account can only DENY, never ALLOW', () => {
  // The direction of every comparison is the point. Storage supplies only the
  // left-hand side of an inequality, so tampering with it can flip a refusal on,
  // but flipping a persisted value to the live one only unblocks something the live
  // session already permits. What it can never do is widen the live session.
  const live = { account: ACCOUNT_B, network: 'localnet', reviewFingerprint: 'fp:DIFFERENT' };
  const forged = validRequest({ approvedAccount: ACCOUNT_B, approvedNetwork: 'localnet', reviewFingerprint: 'fp:DIFFERENT' });
  assert.equal(pending.resumeBlockReason(forged, live), undefined);

  // Flip the persisted account back to something else: refuses.
  assert.equal(pending.resumeBlockReason({ ...forged, approvedAccount: ACCOUNT_A }, live), 'ACCOUNT_CHANGED');
  // Flip the persisted fingerprint to anything at all while the live one differs: refuses.
  for (const forgedFp of ['', 'x', FINGERPRINT, 'fp:'.repeat(200)]) {
    const candidate = { ...forged, reviewFingerprint: forgedFp };
    assert.equal(
      pending.resumeBlockReason(candidate, live),
      candidate.reviewFingerprint === live.reviewFingerprint ? undefined : 'REVIEW_SUBSTITUTED',
    );
  }
});

test('resume: an already-settled request is not blocking', () => {
  assert.equal(
    pending.resumeBlockReason(validRequest({ state: 'REJECTED' }), { account: ACCOUNT_A, network: NETWORK, reviewFingerprint: FINGERPRINT }),
    'NOT_BLOCKING',
  );
});

test('resume: the blocking lookup is scoped to the live account AND network', () => {
  const mine = validRequest();
  const theirs = validRequest({ operationId: 'op-2', approvedAccount: ACCOUNT_B });
  const elsewhere = validRequest({ operationId: 'op-3', approvedNetwork: 'localnet' });
  assert.equal(pending.blockingPendingRequest([mine, theirs, elsewhere], ACCOUNT_A, NETWORK)?.operationId, 'op-1');
  assert.equal(pending.blockingPendingRequest([theirs, elsewhere], ACCOUNT_A, NETWORK), undefined, 'another account does not block me');
  assert.equal(pending.blockingPendingRequest([mine], undefined, NETWORK)?.operationId, 'op-1', 'unknown account must not under-block');
});

test('resume: provider statuses map, and an unknown status is never terminal', () => {
  assert.equal(pending.mapRequestStatus('pending'), 'AWAITING_APPROVAL');
  assert.equal(pending.mapRequestStatus('approved'), 'APPROVED');
  assert.equal(pending.mapRequestStatus('submitted'), 'SUBMITTED');
  assert.equal(pending.mapRequestStatus('rejected'), 'REJECTED');
  assert.equal(pending.mapRequestStatus('failed'), 'FAILED');
  // A provider that grows a new status must not have it silently treated as
  // settled: that would make a request whose fate is unknown disappear.
  for (const unknown of ['expired', 'cancelled', '', 'weird', 42, null, undefined, {}]) {
    assert.equal(pending.mapRequestStatus(unknown), 'UNKNOWN', `${String(unknown)} must map to UNKNOWN`);
  }
});

// ---------------------------------------------------------------------------
// 5. THE PROVIDER-LEVEL RESUME PRIMITIVE
// ---------------------------------------------------------------------------

function providerWith(handler) {
  return { isTariWallet: true, request: async (envelope) => handler(envelope) };
}

test('resume primitive: a pending request is returned, never thrown', async () => {
  const provider = providerWith(({ method, params }) => {
    assert.equal(method, 'tari_getTransactionRequest');
    assert.equal(params.requestId, 'req-abc');
    return { requestId: 'req-abc', status: 'pending' };
  });
  const outcome = await tari.resumeTransactionRequest(provider, 'req-abc', { onRequestId() {}, onSubmitted() {} });
  assert.deepEqual(outcome, { pendingRequestId: 'req-abc' });
});

test('resume primitive: approved submits EXACTLY ONCE, by id, with no payload', async () => {
  const calls = [];
  const provider = providerWith(({ method, params }) => {
    calls.push({ method, params });
    if (method === 'tari_getTransactionRequest') return { requestId: 'req-abc', status: 'approved' };
    if (method === 'tari_submitTransactionRequest') return { transactionId: 'tx-1' };
    throw new Error(`unexpected method ${method}`);
  });
  const outcome = await tari.resumeTransactionRequest(provider, 'req-abc', { onRequestId() {}, onSubmitted() {} });
  assert.equal(outcome.transactionId, 'tx-1');
  const submits = calls.filter((c) => c.method === 'tari_submitTransactionRequest');
  assert.equal(submits.length, 1, 'exactly one submission');
  // The structural guarantee: the submit carries an ID and nothing else, so there
  // is no payload on which a reviewed transaction could be mutated.
  assert.deepEqual(submits[0].params, { requestId: 'req-abc' });
});

test('resume primitive: an ALREADY-submitted request is not submitted again', async () => {
  const calls = [];
  const provider = providerWith(({ method }) => {
    calls.push(method);
    return { requestId: 'req-abc', status: 'submitted', result: { transactionId: 'tx-earlier' } };
  });
  const outcome = await tari.resumeTransactionRequest(provider, 'req-abc', { onRequestId() {}, onSubmitted() {} });
  assert.equal(outcome.transactionId, 'tx-earlier');
  assert.equal(calls.filter((m) => m === 'tari_submitTransactionRequest').length, 0, 'a reload must not re-broadcast');
});

test('resume primitive: rejected and failed are refused without submitting', async () => {
  // REJECTED uses code 'REJECTED' (user declined, explicit).
  // FAILED uses code 'WALLET_FAILED' (wallet verdict, distinct from transport INTERNAL).
  const cases = [
    { status: 'rejected', expectedCode: 'REJECTED' },
    { status: 'failed',   expectedCode: 'WALLET_FAILED' },
  ];
  for (const { status, expectedCode } of cases) {
    const calls = [];
    const provider = providerWith(({ method }) => {
      calls.push(method);
      return { requestId: 'req-abc', status };
    });
    await assert.rejects(
      () => tari.resumeTransactionRequest(provider, 'req-abc', { onRequestId() {}, onSubmitted() {} }),
      (error) => error.code === expectedCode,
      `status "${status}" must throw with code "${expectedCode}"`,
    );
    assert.equal(calls.includes('tari_submitTransactionRequest'), false, `${status} must never submit`);
  }
});

test('resume primitive: an UNRECOGNISED status fails closed without submitting', async () => {
  const calls = [];
  const provider = providerWith(({ method }) => {
    calls.push(method);
    return { requestId: 'req-abc', status: 'quiescent' };
  });
  await assert.rejects(
    () => tari.resumeTransactionRequest(provider, 'req-abc', { onRequestId() {}, onSubmitted() {} }),
    (error) => error.code === 'MALFORMED_REPLY',
  );
  assert.equal(calls.includes('tari_submitTransactionRequest'), false);
});

test('resume primitive: a submitted status with no transaction id fails closed', async () => {
  const provider = providerWith(({ method }) =>
    method === 'tari_getTransactionRequest' ? { requestId: 'req-abc', status: 'submitted' } : { transactionId: 'x' },
  );
  await assert.rejects(
    () => tari.resumeTransactionRequest(provider, 'req-abc', { onRequestId() {}, onSubmitted() {} }),
    (error) => error.code === 'UNKNOWN',
  );
});

test('resume primitive: an empty requestId is refused before any call', async () => {
  let called = false;
  const provider = providerWith(() => {
    called = true;
    return {};
  });
  await assert.rejects(() => tari.resumeTransactionRequest(provider, '', { onRequestId() {}, onSubmitted() {} }));
  assert.equal(called, false, 'a resume without a durable id must not reach the wallet at all');
});

test('resume primitive: the requestId is persisted BEFORE approval is polled', async () => {
  // Ordering is the recovery guarantee: once the wallet has minted an id, the app
  // can find it again even if the tab dies while the popup is open.
  const order = [];
  const provider = providerWith(({ method }) => {
    order.push(method);
    return { requestId: 'req-abc', status: 'pending' };
  });
  await tari.submitViaTransactionRequest(provider, { kind: 'instructions', instructions: [{ a: 1 }] }, {
    onRequestId: () => order.push('persist'),
    onSubmitted: () => order.push('submitted'),
  });
  assert.deepEqual(order, ['tari_createTransactionRequest', 'persist', 'tari_getTransactionRequest']);
});

// ---------------------------------------------------------------------------
// 6. SUBMITEXACT PENDING-ENTRY CLEANUP — only terminal verdicts clear the ledger
//
// submitExact writes an AWAITING_APPROVAL entry via onRequestId, then calls
// submitViaTransactionRequest.  When the wallet immediately returns a verdict:
//
//   FAILED / REJECTED  — terminal: the wallet has closed the request.  The
//                        ledger entry MUST be cleared so Gate 0 does not block
//                        future submissions of the same operation forever.
//
//   MALFORMED_REPLY    — non-terminal: the wallet returned something
//                        unrecognised; the request may still be live and the
//                        entry MUST be preserved so the Activity page can resume.
//
//   UNKNOWN_STATUS     — non-terminal: same reasoning.
//
//   Network/non-TariProviderError — non-terminal: the request is definitely
//                        still live (we never reached the wallet's reply).
//
// These tests simulate the hook+storage pattern that submitExact uses,
// exercising the cleanup policy independently of the private method.
// ---------------------------------------------------------------------------

function submitExactCleanupHarness(storage, provider, operationId = 'op-cleanup-test') {
  // Mirrors submitExact's onRequestId + catch pattern precisely.
  return new Promise((resolve, reject) => {
    tari.submitViaTransactionRequest(
      provider,
      { kind: 'instructions', instructions: [{ CallMethod: { component_address: 'x', method: 'swap', args: [] } }] },
      {
        onRequestId(requestId) {
          pending.rememberPendingRequest(storage, {
            operationId,
            requestId,
            reviewFingerprint: FINGERPRINT,
            operation: 'AMM_SWAP',
            approvedAccount: ACCOUNT_A,
            approvedNetwork: NETWORK,
            destination: 'component_x',
            createdAtUnixMs: Date.now(),
            state: 'AWAITING_APPROVAL',
          });
        },
        onSubmitted() {},
      },
    ).then(resolve).catch((e) => {
      // ---- The correct submitExact cleanup policy ----
      // Only REJECTED and WALLET_FAILED are unambiguous terminal wallet verdicts.
      // INTERNAL covers transport errors and must NOT clear the durable entry.
      const isTerminalVerdict =
        e && e.name === 'TariProviderError' && (e.code === 'REJECTED' || e.code === 'WALLET_FAILED');
      if (isTerminalVerdict) pending.forgetPendingRequest(storage, operationId);
      reject(e);
    });
  });
}

test('submitExact cleanup: immediate FAILED clears the pending entry (Gate 0 unblocked)', async () => {
  // The production scenario: Sapient immediately returns status "failed" from
  // tari_getTransactionRequest (e.g., "capability not supported").
  // resumeTransactionRequest throws TariProviderError(reason, 'WALLET_FAILED').
  // submitExact's catch must retire the entry so Gate 0 does not block forever.
  const storage = memoryStorage();
  const provider = providerWith(({ method }) => {
    if (method === 'tari_createTransactionRequest') return { requestId: 'req-failed' };
    // Sapient immediately returns failed — simulates the production behaviour.
    return { requestId: 'req-failed', status: 'failed', error: 'capability not supported' };
  });
  await assert.rejects(() => submitExactCleanupHarness(storage, provider), (e) => e.code === 'WALLET_FAILED');
  assert.deepEqual(
    pending.listPendingRequests(storage),
    [],
    'a WALLET_FAILED verdict must retire the pending entry so Gate 0 is unblocked',
  );
});

test('submitExact cleanup: immediate REJECTED clears the pending entry', async () => {
  const storage = memoryStorage();
  const provider = providerWith(({ method }) => {
    if (method === 'tari_createTransactionRequest') return { requestId: 'req-rejected' };
    return { requestId: 'req-rejected', status: 'rejected', error: 'User cancelled' };
  });
  await assert.rejects(() => submitExactCleanupHarness(storage, provider), (e) => e.code === 'REJECTED');
  assert.deepEqual(
    pending.listPendingRequests(storage),
    [],
    'a REJECTED verdict from the wallet must retire the pending entry',
  );
});

test('submitExact cleanup: AWAITING_APPROVAL (pending) keeps the entry for Activity-page resume', async () => {
  const storage = memoryStorage();
  const provider = providerWith(({ method }) => {
    if (method === 'tari_createTransactionRequest') return { requestId: 'req-pending' };
    return { requestId: 'req-pending', status: 'pending' };
  });
  // submitViaTransactionRequest returns a value (not throws) for pending.
  const outcome = await tari.submitViaTransactionRequest(
    provider,
    { kind: 'instructions', instructions: [{ a: 1 }] },
    {
      onRequestId(requestId) {
        pending.rememberPendingRequest(storage, {
          operationId: 'op-pending',
          requestId,
          reviewFingerprint: FINGERPRINT,
          operation: 'AMM_SWAP',
          approvedAccount: ACCOUNT_A,
          approvedNetwork: NETWORK,
          destination: 'component_x',
          createdAtUnixMs: Date.now(),
          state: 'AWAITING_APPROVAL',
        });
      },
      onSubmitted() {},
    },
  );
  assert.ok('pendingRequestId' in outcome, 'pending outcome must carry the requestId');
  const records = pending.listPendingRequests(storage);
  assert.equal(records.length, 1, 'pending entry must be preserved for Activity-page resume');
  assert.equal(records[0].state, 'AWAITING_APPROVAL');
});

test('submitExact cleanup: MALFORMED_REPLY keeps the entry (request fate unknown)', async () => {
  const storage = memoryStorage();
  const provider = providerWith(({ method }) => {
    if (method === 'tari_createTransactionRequest') return { requestId: 'req-malformed' };
    // No status field — normaliseSummary will throw MALFORMED_REPLY.
    return { requestId: 'req-malformed' };
  });
  await assert.rejects(
    () => submitExactCleanupHarness(storage, provider, 'op-malformed'),
    (e) => e.code === 'MALFORMED_REPLY',
  );
  const records = pending.listPendingRequests(storage);
  assert.equal(records.length, 1, 'MALFORMED_REPLY must NOT clear the entry — request may still be live');
});

test('submitExact cleanup: UNKNOWN status keeps the entry (new wallet status must not disappear)', async () => {
  const storage = memoryStorage();
  const provider = providerWith(({ method }) => {
    if (method === 'tari_createTransactionRequest') return { requestId: 'req-unknown-status' };
    // A wallet that grew a new status code: must fail closed, entry preserved.
    return { requestId: 'req-unknown-status', status: 'queued' };
  });
  await assert.rejects(
    () => submitExactCleanupHarness(storage, provider, 'op-unknown'),
    (e) => e.code === 'MALFORMED_REPLY',
  );
  const records = pending.listPendingRequests(storage);
  assert.equal(records.length, 1, 'an unrecognised wallet status must preserve the entry');
});

test('submitExact cleanup: a transport/network error (INTERNAL) keeps the entry', async () => {
  // When the provider throws a plain Error from tari_getTransactionRequest,
  // call() wraps it as TariProviderError('The provider failed...', 'INTERNAL').
  // INTERNAL is NOT cleared by submitExact — it cannot be distinguished from a
  // network failure vs. a wallet -32603 response without 'WALLET_FAILED'.
  // The durable entry must be preserved so the Activity page can resume it once
  // connectivity is restored.
  const storage = memoryStorage();
  let onRequestIdCalled = false;
  const provider = providerWith(({ method }) => {
    if (method === 'tari_createTransactionRequest') return { requestId: 'req-network-error' };
    throw new Error('fetch failed: ERR_CONNECTION_REFUSED');
  });
  await assert.rejects(
    () => {
      return new Promise((resolve, reject) => {
        tari.submitViaTransactionRequest(
          provider,
          { kind: 'instructions', instructions: [{ a: 1 }] },
          {
            onRequestId(requestId) {
              onRequestIdCalled = true;
              pending.rememberPendingRequest(storage, {
                operationId: 'op-network-error',
                requestId,
                reviewFingerprint: FINGERPRINT,
                operation: 'AMM_SWAP',
                approvedAccount: ACCOUNT_A,
                approvedNetwork: NETWORK,
                destination: 'component_x',
                createdAtUnixMs: Date.now(),
                state: 'AWAITING_APPROVAL',
              });
            },
            onSubmitted() {},
          },
        ).then(resolve).catch((e) => {
          // Transport error: code is 'UNKNOWN' (plain Error, no numeric code),
          // NOT 'WALLET_FAILED', so must NOT clear.
          const isTerminalVerdict =
            e && e.name === 'TariProviderError' && (e.code === 'REJECTED' || e.code === 'WALLET_FAILED');
          if (isTerminalVerdict) pending.forgetPendingRequest(storage, 'op-network-error');
          reject(e);
        });
      });
    },
    // A plain Error with no numeric code: normalizeProviderError assigns 'UNKNOWN' (not 'INTERNAL').
    // 'INTERNAL' is reserved for Sapient's -32603 JSON-RPC code.
    (e) => e && e.name === 'TariProviderError' && e.code === 'UNKNOWN',
  );
  assert.ok(onRequestIdCalled, 'onRequestId must have fired before the transport error');
  assert.equal(
    pending.listPendingRequests(storage).length,
    1,
    'a transport/network error (INTERNAL) must NOT clear the entry — the wallet request is still live',
  );
});

test('submitExact cleanup: browser reload finds the preserved entry for AWAITING_APPROVAL', () => {
  // If submitExact leaves an AWAITING_APPROVAL entry (pending), a reload must
  // find it intact so the Activity page can offer Resume.
  const storage = memoryStorage();
  pending.rememberPendingRequest(storage, {
    operationId: 'op-reload',
    requestId: 'req-reload',
    reviewFingerprint: FINGERPRINT,
    operation: 'AMM_SWAP',
    approvedAccount: ACCOUNT_A,
    approvedNetwork: NETWORK,
    destination: 'component_x',
    createdAtUnixMs: Date.now(),
    state: 'AWAITING_APPROVAL',
  });
  // Simulate a reload: new storage handle over the same bytes.
  const afterReload = memoryStorage(Object.fromEntries(storage.map));
  const records = pending.listPendingRequests(afterReload);
  assert.equal(records.length, 1, 'AWAITING_APPROVAL entry must survive a browser reload');
  assert.equal(records[0].operationId, 'op-reload');
  assert.equal(records[0].requestId, 'req-reload');
  // Gate 0: the entry blocks a fresh submission.
  assert.ok(
    pending.blockingPendingRequest(records, ACCOUNT_A, NETWORK),
    'a preserved AWAITING_APPROVAL entry must block duplicate submissions via Gate 0',
  );
});

test('submitExact cleanup: cleanup is idempotent — forgetPendingRequest twice is safe', () => {
  const storage = memoryStorage();
  pending.rememberPendingRequest(storage, {
    operationId: 'op-idempotent',
    requestId: 'req-x',
    reviewFingerprint: FINGERPRINT,
    operation: 'AMM_SWAP',
    approvedAccount: ACCOUNT_A,
    approvedNetwork: NETWORK,
    destination: 'component_x',
    createdAtUnixMs: Date.now(),
    state: 'AWAITING_APPROVAL',
  });
  assert.doesNotThrow(() => {
    pending.forgetPendingRequest(storage, 'op-idempotent');
    pending.forgetPendingRequest(storage, 'op-idempotent'); // second call must be a no-op
  });
  assert.deepEqual(pending.listPendingRequests(storage), []);
});

test('submitExact cleanup: error evidence preserved — TariProviderError message carries Sapient reason', () => {
  // The cleanup must happen BEFORE rethrow, but the reason string must be in the
  // thrown error so the UI can show it. This checks the error is not discarded.
  const sapientReason = 'capability not supported: stealthWithdraw requires Confidential-aware account';
  const error = new tari.TariProviderError(sapientReason, 'WALLET_FAILED');
  assert.equal(error.message, sapientReason, 'the Sapient reason must survive in .message');
  assert.equal(error.code, 'WALLET_FAILED', 'the TariProviderError code must be preserved');
  assert.equal(error.name, 'TariProviderError', 'name must be TariProviderError for the instanceof check');
});

test('submitExact cleanup: successful submission does not leave a dangling AWAITING_APPROVAL', async () => {
  const storage = memoryStorage();
  const provider = providerWith(({ method }) => {
    if (method === 'tari_createTransactionRequest') return { requestId: 'req-success' };
    if (method === 'tari_getTransactionRequest') return { requestId: 'req-success', status: 'approved' };
    if (method === 'tari_submitTransactionRequest') return { transactionId: 'tx-abc123' };
    throw new Error(`unexpected: ${method}`);
  });
  const outcome = await tari.submitViaTransactionRequest(
    provider,
    { kind: 'instructions', instructions: [{ a: 1 }] },
    {
      onRequestId(requestId) {
        pending.rememberPendingRequest(storage, {
          operationId: 'op-success',
          requestId,
          reviewFingerprint: FINGERPRINT,
          operation: 'AMM_SWAP',
          approvedAccount: ACCOUNT_A,
          approvedNetwork: NETWORK,
          destination: 'component_x',
          createdAtUnixMs: Date.now(),
          state: 'AWAITING_APPROVAL',
        });
      },
      onSubmitted(result) {
        // Caller (submitExact) transitions state to SUBMITTED.
        pending.rememberPendingRequest(storage, {
          operationId: 'op-success',
          requestId: 'req-success',
          reviewFingerprint: FINGERPRINT,
          operation: 'AMM_SWAP',
          approvedAccount: ACCOUNT_A,
          approvedNetwork: NETWORK,
          destination: 'component_x',
          createdAtUnixMs: Date.now(),
          state: 'SUBMITTED',
          transactionId: result.transactionId,
        });
      },
    },
  );
  assert.equal(outcome.transactionId, 'tx-abc123');
  const records = pending.listPendingRequests(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'SUBMITTED', 'a successful swap must transition to SUBMITTED, not remain AWAITING_APPROVAL');
  assert.equal(records[0].transactionId, 'tx-abc123');
});

test('audit EIGHT-PASS P4-L1: a non-definitive submit failure durably records UNKNOWN, so a reload cannot offer a fresh submit', async () => {
  const storage = memoryStorage();
  pending.rememberPendingRequest(storage, {
    operationId: 'op-unknown-submit',
    requestId: 'req-unknown-submit',
    reviewFingerprint: FINGERPRINT,
    operation: 'AMM_SWAP',
    approvedAccount: ACCOUNT_A,
    approvedNetwork: NETWORK,
    destination: 'component_x',
    createdAtUnixMs: Date.now(),
    state: 'APPROVED',
  });
  const previousTari = globalThis.tari;
  // The realistic "RPC returned an error after the submit may have landed": the
  // provider throws a plain error, which normalizeProviderError codes as UNKNOWN.
  globalThis.tari = {
    isTariWallet: true,
    request: async ({ method }) => {
      if (method === 'tari_submitTransactionRequest') throw new Error('the connection was lost mid-submit');
      throw new Error(`unexpected method: ${method}`);
    },
  };
  try {
    const serviceMod = require('../build-test/services/walletService.js');
    const svc = serviceMod.createWalletService('esmeralda', storage);
    const bridge = svc.bridge();
    assert.ok(bridge, 'a provider is injected, so the bridge resolves');
    const record = pending.listPendingRequests(storage)[0];
    const live = { account: ACCOUNT_A, network: NETWORK, reviewFingerprint: FINGERPRINT };
    await assert.rejects(() => bridge.submitApprovedRequest(record, live), /failed tari_submitTransactionRequest/);
    const after = pending.listPendingRequests(storage);
    assert.equal(after.length, 1, 'the entry is kept, not forgotten');
    assert.equal(after[0].state, 'UNKNOWN', 'the durable record must not still claim APPROVED after an unknown-outcome submit');
    assert.ok(pending.needsAttention(after[0]), 'UNKNOWN keeps blocking a fresh submission');
    assert.equal(after[0].requestId, 'req-unknown-submit', 'the wallet remains the only authority: resume polls by requestId');
  } finally {
    globalThis.tari = previousTari;
  }
});

test('audit EIGHT-PASS P4-L1: a definitive wallet verdict still clears the guard without an UNKNOWN record', async () => {
  const storage = memoryStorage();
  pending.rememberPendingRequest(storage, {
    operationId: 'op-rejected-submit',
    requestId: 'req-rejected-submit',
    reviewFingerprint: FINGERPRINT,
    operation: 'AMM_SWAP',
    approvedAccount: ACCOUNT_A,
    approvedNetwork: NETWORK,
    destination: 'component_x',
    createdAtUnixMs: Date.now(),
    state: 'APPROVED',
  });
  const previousTari = globalThis.tari;
  globalThis.tari = {
    isTariWallet: true,
    request: async ({ method }) => {
      if (method === 'tari_submitTransactionRequest') throw new tari.TariProviderError('the user declined this request', 'REJECTED');
      throw new Error(`unexpected method: ${method}`);
    },
  };
  try {
    const serviceMod = require('../build-test/services/walletService.js');
    const svc = serviceMod.createWalletService('esmeralda', storage);
    const bridge = svc.bridge();
    const record = pending.listPendingRequests(storage)[0];
    const live = { account: ACCOUNT_A, network: NETWORK, reviewFingerprint: FINGERPRINT };
    await assert.rejects(() => bridge.submitApprovedRequest(record, live), /declined/);
    const after = pending.listPendingRequests(storage);
    assert.equal(after.length, 1, 'REJECTED keeps the entry for the UI to explain');
    assert.equal(after[0].state, 'APPROVED', 'a definitive REJECTED verdict must not be recorded as UNKNOWN');
    // A definitive REJECTED verdict cleared the in-session guard: a second submit
    // attempt re-asks the wallet, which refuses again with the same terminal verdict.
    const secondRecord = pending.listPendingRequests(storage)[0];
    await assert.rejects(() => bridge.submitApprovedRequest(secondRecord, live), /declined/);
  } finally {
    globalThis.tari = previousTari;
  }
});