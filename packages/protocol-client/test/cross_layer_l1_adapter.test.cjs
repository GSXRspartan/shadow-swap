/**
 * The L1 atomic-swap gRPC contract.
 *
 * Two classes of mistake are under test. First, treating a transport success as an operation
 * success: `SendShaAtomicSwapResponse` carries `is_success` and `failure_message`, so the wallet
 * can refuse WITHOUT a transport error. Second, leaking the preimage — which arrives in the send
 * response and is the secret the whole swap rests on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const PREIMAGE = 'a1'.repeat(32);
const OUTPUT = 'b2'.repeat(32);
const send = (over = {}) => ({ address: 'tari1recipient', amountMicroRaw: '1000000', feePerGramRaw: '5', ...over });

test('a refusal carried in the RESPONSE is a failure, not a success', () => {
  // The mistake this prevents: a 200 with is_success=false read as a funded HTLC, which would
  // have the caller wait forever for a leg that does not exist.
  assert.throws(
    () => pc.parseSendResponse({ is_success: false, failure_message: 'Not enough funds' }),
    /refused the atomic swap: Not enough funds/,
  );
  assert.throws(() => pc.parseSendResponse({ is_success: false }), /no reason given/);
  // Absent is_success is also a failure: the field is required, not optional.
  assert.throws(() => pc.parseSendResponse({ pre_image: PREIMAGE, output_hash: OUTPUT }), /refused/);
  for (const bad of [null, 'ok', 42, undefined]) {
    assert.throws(() => pc.parseSendResponse(bad), /must be an object/);
  }
});

test('the preimage and output hash are validated as the 32-byte shapes L1 actually returns', () => {
  const ok = pc.parseSendResponse({ is_success: true, transaction_id: 77, pre_image: PREIMAGE, output_hash: OUTPUT });
  assert.equal(ok.transactionId, '77', 'a uint64 arrives as a number and is kept as a string');
  assert.equal(ok.preImageHex, PREIMAGE);
  assert.equal(ok.outputHashHex, OUTPUT);

  // The handler returns `pre_image.to_hex()` of a CompressedPublicKey: exactly 64 hex chars.
  for (const [field, value] of [['pre_image', 'a1'.repeat(31)], ['pre_image', 'zz'.repeat(32)], ['output_hash', ''], ['output_hash', 123]]) {
    assert.throws(
      () => pc.parseSendResponse({ is_success: true, transaction_id: 1, pre_image: PREIMAGE, output_hash: OUTPUT, [field]: value }),
      /64 hex characters/,
      `${field}=${String(value).slice(0, 8)}`,
    );
  }
  assert.throws(() => pc.parseSendResponse({ is_success: true, pre_image: PREIMAGE, output_hash: OUTPUT }), /transaction_id is missing/);
});

test('the request carries only the fields the handler reads, and records what it cannot control', () => {
  // Verified against the console wallet's gRPC handler: it reads address, amount, fee_per_gram
  // and the payment id, and nothing else from PaymentRecipient.
  const gaps = pc.L1_SEND_UNCONTROLLABLE.join(' ');
  assert.match(gaps, /payment_type: present in the proto but ignored/);
  assert.match(gaps, /UtxoSelectionCriteria::default/);
  assert.match(gaps, /hash: not an input/);
  assert.match(gaps, /timeout: not an input.*720 blocks/);

  assert.deepEqual(pc.validateSendRequest(send()), send());
  assert.throws(() => pc.validateSendRequest(send({ address: '  ' })), /base58 Tari address/);
  assert.throws(() => pc.validateSendRequest(send({ amountMicroRaw: '0' })), /must be positive/);
  assert.throws(() => pc.validateSendRequest(send({ amountMicroRaw: '1.5' })), /uint64/);
  // A zero fee cannot build a transaction, so it fails locally rather than at the wallet.
  assert.throws(() => pc.validateSendRequest(send({ feePerGramRaw: '0' })), /cannot build a transaction/);
  assert.throws(() => pc.validateSendRequest(send({ rawPaymentIdHex: 'abc' })), /even-length hex/);
});

test('claim and refund read TransferResult, nested or flat, and refuse a failed one', () => {
  const ok = pc.parseTransferResponse({ results: { is_success: true, transaction_id: 5, failure_message: '' } }, 'claim');
  assert.equal(ok.transactionId, '5');
  // Flat shape too, since gRPC clients differ in whether they unwrap `results`.
  assert.equal(pc.parseTransferResponse({ is_success: true, transaction_id: 6 }, 'refund').transactionId, '6');

  assert.throws(
    () => pc.parseTransferResponse({ results: { is_success: false, failure_message: 'No output found for hash' } }, 'claim'),
    /refused the claim: No output found for hash/,
  );
  assert.throws(() => pc.parseTransferResponse({ results: { is_success: false } }, 'refund'), /refused the refund: no reason given/);
  assert.throws(() => pc.parseTransferResponse({ results: { is_success: true } }, 'claim'), /transaction_id is missing/);
});

test('the preimage never leaves the machine in a shareable payload', () => {
  const result = { transactionId: '9', preImageHex: PREIMAGE, outputHashHex: OUTPUT };
  const shareable = pc.redactSendResult(result);
  // The counterparty needs the output hash to bind their leg; the preimage is what the funder
  // reveals only by claiming, so publishing it would hand away the swap.
  assert.deepEqual(shareable, { transactionId: '9', outputHashHex: OUTPUT });
  assert.equal(JSON.stringify(shareable).includes(PREIMAGE), false);
  pc.assertNoPreimage(shareable);

  for (const field of ['preImageHex', 'pre_image', 'secret', 'spendKey', 'seedWords']) {
    assert.throws(() => pc.assertNoPreimage({ [field]: 'x' }), /may never carry/, field);
  }
});

test('the transport is injected, so the contract is testable with no wallet and cannot self-dial', () => {
  const calls = [];
  const transport = {
    sendShaAtomicSwap: async (r) => { calls.push(['send', r]); return { is_success: true, transaction_id: 1, pre_image: PREIMAGE, output_hash: OUTPUT }; },
    claimShaAtomicSwap: async (r) => { calls.push(['claim', r]); return { results: { is_success: true, transaction_id: 2 } }; },
    claimHtlcRefund: async (r) => { calls.push(['refund', r]); return { results: { is_success: true, transaction_id: 3 } }; },
  };
  return (async () => {
    const funded = await pc.fundL1Htlc(transport, send());
    assert.equal(funded.preImageHex, PREIMAGE);
    const claimed = await pc.claimL1Htlc(transport, { outputHashHex: OUTPUT, preImageHex: PREIMAGE, feePerGramRaw: '5' });
    assert.equal(claimed.transactionId, '2');
    const refunded = await pc.refundL1Htlc(transport, { outputHashHex: OUTPUT, feePerGramRaw: '5' });
    assert.equal(refunded.transactionId, '3');
    assert.deepEqual(calls.map((c) => c[0]), ['send', 'claim', 'refund']);
    // Validation runs BEFORE the transport, so a bad request never reaches a wallet.
    await assert.rejects(pc.claimL1Htlc(transport, { outputHashHex: 'short', preImageHex: PREIMAGE, feePerGramRaw: '5' }), /64 hex/);
    assert.equal(calls.length, 3, 'the rejected call did not reach the transport');
  })();
});
