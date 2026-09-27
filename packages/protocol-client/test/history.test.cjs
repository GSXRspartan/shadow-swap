const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOperationRecord,
  markSubmitted,
  markUnknown,
  markConfirmed,
  reconcileOperation,
  requireFreshSubmissionAllowed,
  InMemoryHistoryStore,
  JsonHistoryStore,
} = require('../dist/history.js');
const { executeResolved, confirmSubmitted } = require('../dist/execution_flow.js');

const FRESH = { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', readAtUnixMs: 1 } };
const STALE_FRESH = { source: 'INDEXER_SUBSTATE', identity: { readAtUnixMs: 1 } };

function record(overrides = {}) {
  return createOperationRecord({
    operationId: 'op_1',
    operationKind: 'AMM_SWAP',
    componentOrOrderId: 'pool_comp',
    resources: ['res_a', 'res_b'],
    amounts: { input: '1000', quotedOutput: '900', minOutput: '895' },
    quote: { quotedOutput: '900', minOutput: '895' },
    expiryEpoch: '200',
    ...overrides,
  });
}

test('history persists and reloads records durably (injected IO)', async () => {
  const mem = new Map();
  const store = new JsonHistoryStore({ read: async () => mem.get('json'), write: async (text) => mem.set('json', text) });
  await store.save(record());
  const submitted = markSubmitted(await store.get('op_1'), 'tx_abc', '100');
  await store.save(submitted);
  // A brand-new store instance over the same durable IO recovers the exact state.
  const reloaded = new JsonHistoryStore({ read: async () => mem.get('json'), write: async () => {} });
  const reloadedRecord = await reloaded.get('op_1');
  assert.equal(reloadedRecord.state, 'SUBMITTED');
  assert.equal(reloadedRecord.transactionId, 'tx_abc');
  assert.equal((await reloaded.listByTransactionId('tx_abc')).length, 1);
});

test('UNKNOWN reconciliation never resubmits without durable evidence', async () => {
  const lost = markUnknown(record(), 'network timeout');
  const r1 = await reconcileOperation(lost, { statusByTransactionId: async () => { throw new Error('must not be queried without txid'); } });
  assert.equal(r1.finalState, 'UNKNOWN');
  assert.equal(r1.resubmissionAllowed, false);

  const withUnknownAnswer = markUnknown(markSubmitted(record(), 'tx_unknown'), 'lost');
  const r2 = await reconcileOperation(withUnknownAnswer, { statusByTransactionId: async () => 'UNKNOWN' });
  assert.equal(r2.finalState, 'UNKNOWN');
  assert.equal(r2.resubmissionAllowed, false);
});

test('authoritative NOT_FOUND/REJECTED evidence permits safe resubmission', async () => {
  const notFound = markUnknown(markSubmitted(record(), 'tx_404'), 'lost');
  const r = await reconcileOperation(notFound, { statusByTransactionId: async () => 'NOT_FOUND' });
  assert.equal(r.finalState, 'FAILED');
  assert.equal(r.resubmissionAllowed, true);
  const rejected = markUnknown(markSubmitted(record(), 'tx_rej'), 'lost');
  const r2 = await reconcileOperation(rejected, { statusByTransactionId: async () => 'REJECTED' });
  assert.equal(r2.finalState, 'FAILED');
  assert.equal(r2.resubmissionAllowed, true);
  const committed = markUnknown(markSubmitted(record(), 'tx_ok'), 'lost');
  const r3 = await reconcileOperation(committed, { statusByTransactionId: async () => 'COMMITTED' });
  assert.equal(r3.finalState, 'CONFIRMED');
  assert.equal(r3.resubmissionAllowed, false);
});

test('duplicate submission attempts fail closed', () => {
  assert.throws(() => requireFreshSubmissionAllowed(markConfirmed(record(), '150')), /CONFIRMED/);
  assert.throws(() => requireFreshSubmissionAllowed(markSubmitted(record(), 'tx_1')), /reconcile/);
  assert.throws(() => requireFreshSubmissionAllowed(markUnknown(record(), 'lost')), /UNKNOWN/);
  requireFreshSubmissionAllowed(record());
});

test('executeResolved persists UNKNOWN on lost submit response and refuses blind retry', async () => {
  const store = new InMemoryHistoryStore();
  const result = await executeResolved({
    resolvedIntent: { op: 'swap' },
    recordInput: { operationId: 'op_unknown', operationKind: 'AMM_SWAP', resources: ['r'], amounts: {}, lastReadback: FRESH },
    history: store,
    transport: {
      construct: () => ({ signed: true }),
      sign: async (envelope) => envelope,
      submit: async () => { throw new Error('connection reset during submit'); },
      lookup: { statusByTransactionId: async () => 'NOT_FOUND' },
    },
  });
  assert.equal(result.outcome, 'UNKNOWN');
  const persisted = await store.get('op_unknown');
  assert.equal(persisted.state, 'UNKNOWN');
  assert.throws(() => requireFreshSubmissionAllowed(persisted), /UNKNOWN/);
  // Without a durable txid, reconciliation correctly CANNOT prove non-commit:
  // the record must stay UNKNOWN and resubmission stays refused.
  const rec = await reconcileOperation(persisted, { statusByTransactionId: async () => 'NOT_FOUND' });
  assert.equal(rec.finalState, 'UNKNOWN');
  assert.equal(rec.resubmissionAllowed, false);
  // Recovery requires the durable identifier: with a txid, NOT_FOUND proves non-commit.
  const withTx = markUnknown(markSubmitted(record({ operationId: 'op_unknown' }), 'tx_lost'), 'lost');
  const rec2 = await reconcileOperation(withTx, { statusByTransactionId: async () => 'NOT_FOUND' });
  assert.equal(rec2.finalState, 'FAILED');
  assert.equal(rec2.resubmissionAllowed, true);
});

test('confirmed operation cannot be submitted twice', async () => {
  const store = new InMemoryHistoryStore();
  await store.save(markConfirmed(markSubmitted(record(), 'tx_done'), '200'));
  const stored = await store.get('op_1');
  assert.throws(() => requireFreshSubmissionAllowed(stored), /CONFIRMED/);
});

test('execution refuses construction without authoritative freshness unless explicitly overridden', async () => {
  const store = new InMemoryHistoryStore();
  const transport = {
    construct: () => ({}),
    sign: async (envelope) => envelope,
    submit: async () => ({ transactionId: 'tx_x' }),
    lookup: { statusByTransactionId: async () => 'COMMITTED' },
  };
  const refused = await executeResolved({
    resolvedIntent: { op: 'swap' },
    recordInput: { operationId: 'op_stale', operationKind: 'AMM_SWAP', resources: ['r'], amounts: {}, lastReadback: STALE_FRESH },
    history: store,
    transport,
  });
  assert.equal(refused.outcome, 'FAILED');
  assert.match(refused.reason, /authoritative read/);
  const allowed = await executeResolved({
    resolvedIntent: { op: 'swap' },
    recordInput: { operationId: 'op_stale2', operationKind: 'AMM_SWAP', resources: ['r'], amounts: {}, lastReadback: STALE_FRESH },
    history: store,
    transport,
    unsafe: { confirmUnsafeStaleConstruction: true, reason: 'operator override' },
  });
  assert.equal(allowed.outcome, 'SUBMITTED');
  const refusedSaved = await store.get('op_stale');
  assert.equal(refusedSaved.epoch, undefined, 'refused flow must not stamp the unsafe marker');
  const allowedSaved = await store.get('op_stale2');
  assert.equal(allowedSaved.epoch, 'UNSAFE_STALE_CONSTRUCTION');
});

test('confirm layer promotes SUBMITTED to CONFIRMED only on authoritative evidence', async () => {
  const store = new InMemoryHistoryStore();
  const submitted = markSubmitted(record(), 'tx_c');
  await store.save(submitted);
  const confirmed = await confirmSubmitted({ record: submitted, history: store, lookup: { statusByTransactionId: async () => 'COMMITTED' } });
  assert.equal(confirmed.state, 'CONFIRMED');
  const store2 = new InMemoryHistoryStore();
  const pendingRecord = markSubmitted(record(), 'tx_p');
  await store2.save(pendingRecord);
  const still = await confirmSubmitted({ record: pendingRecord, history: store2, lookup: { statusByTransactionId: async () => 'UNKNOWN' } });
  assert.equal(still.state, 'SUBMITTED');
});