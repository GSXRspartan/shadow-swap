// Unit tests for the guarded executor's pure logic and safety guards.
// These need no wallet daemon: they pin the refusal guards and the result parser
// against the REAL v0.43 walletd response shapes captured on 2026-10-06.
//
// Run: node --test tools/live-executor/walletd.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletdExecutor, ExecutorError, summariseResult, MAX_FEE_PER_TX_MICRO, EXPECTED_NETWORK, EXPECTED_NETWORK_BYTE } from './walletd.mjs';

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
