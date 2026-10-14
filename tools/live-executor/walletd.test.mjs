// Unit tests for the guarded executor's pure logic and safety guards.
// These need no wallet daemon: they pin the refusal guards and the result parser
// against the REAL v0.43 walletd response shapes captured on 2026-10-06.
//
// Run: node --test tools/live-executor/walletd.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletdExecutor, ExecutorError, summariseResult, describeRejectReason, MAX_FEE_PER_TX_MICRO, EXPECTED_NETWORK, EXPECTED_NETWORK_BYTE, assertAuditedPoolTemplate, CURRENT_POOL_TEMPLATE } from './walletd.mjs';

test('pool instantiation refuses every template except the audited Pool v2', () => {
  // The shipped default used to be the SUPERSEDED v1 template (ef2bc1b0…), so this guard
  // is the thing that stops a "current-looking" command creating an owner-controlled pool.
  assert.throws(() => assertAuditedPoolTemplate('ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649'), ExecutorError);
  assert.throws(() => assertAuditedPoolTemplate('template_93aa539e3a59bd9e45db35f88ec733a40d493223b5892d8724fbfe198831b692'), ExecutorError);
  assert.throws(() => assertAuditedPoolTemplate(undefined), ExecutorError);
  assert.throws(() => assertAuditedPoolTemplate(''), ExecutorError);
  // Both transport spellings of the audited template are accepted, bare form returned.
  assert.equal(assertAuditedPoolTemplate(CURRENT_POOL_TEMPLATE), CURRENT_POOL_TEMPLATE);
  assert.equal(assertAuditedPoolTemplate(`template_${CURRENT_POOL_TEMPLATE}`), CURRENT_POOL_TEMPLATE);
});

test('constructor refuses a non-loopback walletd URL', () => {
  assert.throws(() => new WalletdExecutor({ url: 'http://8.8.8.8:5100' }), ExecutorError);
  assert.throws(() => new WalletdExecutor({ url: 'https://evil.example/json_rpc' }), ExecutorError);
  // Loopback forms are accepted.
  for (const url of ['http://127.0.0.1:5100', 'http://localhost:5100', 'http://[::1]:5100']) {
    assert.doesNotThrow(() => new WalletdExecutor({ url }));
  }
});

test('constructor clamps the per-tx fee ceiling to the hard maximum', () => {
  const ex = new WalletdExecutor({ url: 'http://127.0.0.1:5100', maxFeePerTxMicro: 999_999_999 });
  assert.equal(ex.maxFeePerTxMicro, MAX_FEE_PER_TX_MICRO);
  const ex2 = new WalletdExecutor({ url: 'http://127.0.0.1:5100', maxFeePerTxMicro: 1_000_000 });
  assert.equal(ex2.maxFeePerTxMicro, 1_000_000);
});

test('expected network identity is esmeralda / byte 38', () => {
  assert.equal(EXPECTED_NETWORK, 'esmeralda');
  assert.equal(EXPECTED_NETWORK_BYTE, 38);
});

test('summariseResult parses a committed v0.43 result (status + fee + up substates)', () => {
  // Shape captured live from transactions.get_result on 2026-10-06.
  const committed = {
    status: 'Accepted',
    transaction_id: 'abc',
    result: {
      fee_receipt: { total_fees_paid: 3010, total_fee_payment: 1_000_000, exhaust_burn: 3010 },
      result: {
        Accept: {
          up_substates: [
            ['component_329d4ef20fe6803ca499db7f923b0d1773d1f72e38d76cfcbe351327d6304169', {}],
            ['resource_32a6a6b0869a9cc28be2df45baf8b0b70855d2a8ec57f1c3236fd53ad16bb6e9', {}],
            ['vault_deadbeef', {}],
          ],
          down_substates: [],
        },
      },
    },
  };
  const out = summariseResult(committed);
  assert.equal(out.status, 'COMMITTED');
  assert.equal(out.actualFee, 3010);
  assert.deepEqual(out.components, ['component_329d4ef20fe6803ca499db7f923b0d1773d1f72e38d76cfcbe351327d6304169']);
  assert.deepEqual(out.resources, ['resource_32a6a6b0869a9cc28be2df45baf8b0b70855d2a8ec57f1c3236fd53ad16bb6e9']);
});

test('summariseResult extracts a published template address from up substates', () => {
  // A publish commits a `template_...` up-substate; publishTemplate() reads it from here.
  const committed = {
    status: 'Accepted',
    result: {
      fee_receipt: { total_fees_paid: 1_240_083 },
      result: { Accept: { up_substates: [['template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab', {}]], down_substates: [] } },
    },
  };
  const out = summariseResult(committed);
  assert.equal(out.status, 'COMMITTED');
  assert.deepEqual(out.templates, ['template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab']);
});

test('summariseResult reports REJECTED for a rejected result', () => {
  const rejected = { status: 'Rejected', result: { fee_receipt: { total_fees_paid: 0 }, result: { Reject: { reason: 'nope' } } } };
  assert.equal(summariseResult(rejected).status, 'REJECTED');
});

test('summariseResult is UNKNOWN for an unrecognised shape, never a false COMMITTED', () => {
  assert.equal(summariseResult(undefined).status, 'UNKNOWN');
  assert.equal(summariseResult({}).status, 'UNKNOWN');
  assert.equal(summariseResult({ status: 'Pending' }).status, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// Ootle v0.46.0 regressions.
//
// v0.46.0 (upstream #2859) retired FinalizeResult.execution_results, so the getter-based
// readback path is gone and the wire gained fields this executor must not misread.
// ---------------------------------------------------------------------------

test('summariseResult classifies every v0.46 RejectReason as REJECTED, never COMMITTED', () => {
  // The OUTER TransactionResult variant set is unchanged in v0.46, so `Reject` still keys
  // the verdict. These are the reasons v0.46 added or reshaped. Two of them are UNIT
  // variants and arrive as a BARE STRING, which is the shape a naive reader gets wrong.
  const reasons = [
    'FeePaymentInMainIntent',                                        // NEW unit variant
    { Abort: { reason: 'LockInputsFailed' } },                       // NEW struct variant
    { ForeignShardGroupDecidedToAbort: { start_shard: 0, end_shard: 1, abort_reason: 'ExecutionFailure' } },
    { ExecutionFailure: { code: 'InsufficientFunds', message: 'vault short' } },
    { InsufficientFeesPaid: 'short' },
  ];
  for (const reason of reasons) {
    const res = { status: 'Rejected', result: { fee_receipt: { total_fees_paid: 0 }, result: { Reject: reason } } };
    const out = summariseResult(res);
    assert.equal(out.status, 'REJECTED', `reason ${JSON.stringify(reason)} must be REJECTED`);
    assert.notEqual(out.rejectReason, null, `reason ${JSON.stringify(reason)} must be labelled`);
  }
});

test('describeRejectReason prefers the structured code over the free-text message', () => {
  // v0.46 gives ExecutionFailure a stable `code`. The rendered message reaches consensus
  // as prose, so branching on it would be reading a string that is not a contract.
  // (Argument is an ExecuteResult, the shape summariseResult passes in.)
  const exec = { result: { Reject: { ExecutionFailure: { code: 'OutOfCompute', message: 'execution ran past the fee' } } } };
  assert.equal(describeRejectReason(exec), 'ExecutionFailure:OutOfCompute');
});

test('describeRejectReason handles a unit RejectReason delivered as a bare string', () => {
  assert.equal(describeRejectReason({ result: { Reject: 'FeePaymentInMainIntent' } }), 'FeePaymentInMainIntent');
});

test('describeRejectReason reads the reason out of AcceptFeeRejectRest too', () => {
  // The fee intent committed but the main intent did not: money moved, so this must be
  // reported as REJECTED and must still carry a reason.
  const res = {
    status: 'Rejected',
    result: { result: { AcceptFeeRejectRest: [{ up_substates: [], down_substates: [] }, { Abort: { reason: 'LockInputsFailed' } }] } },
  };
  const out = summariseResult(res);
  assert.equal(out.status, 'REJECTED');
  assert.equal(out.rejectReason, 'Abort');
});

test('describeRejectReason returns null for an accepted result and UNRECOGNISED never silently', () => {
  assert.equal(describeRejectReason({ result: { Accept: { up_substates: [] } } }), null);
  // A reason that is neither a string nor a recognised object must surface, not vanish.
  assert.equal(describeRejectReason({ result: { Reject: 42 } }), 'UNRECOGNISED');
});
