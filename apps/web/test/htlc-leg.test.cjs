/**
 * Tests for the production L2 HTLC leg adapter (services/ootleHtlcLeg.ts).
 *
 * No wallet is involved: the provider is a fake that records requests and answers
 * from scripted replies. What is pinned here is the adapter's own discipline:
 * strict validation before the wallet is asked, fail-closed observation parsing,
 * capability gating, testnet-only funding, and durable persistence that can never
 * carry the preimage.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const leg = require('../build-test/services/ootleHtlcLeg.js');

const RESOURCE = 'resource_' + 'a'.repeat(64);
const HASH = 'd'.repeat(64);
// Upstream's own localnet vector (crates/ootle_address/src/macros.rs): a REAL
// bech32m address with a valid checksum, so fund-time parsing and observation-time
// claimant comparison run against genuine address bytes on the localnet leg.
const WALLET_ADDR = 'otl_loc_1nsy5c5mfn7jgmg5nm3s3m4vr829tgpeehmymkme6k5wszde6wc7zcfwtyyxwn62tqefqyfyjangalt4zrygzwyf8c6c2jtfqyd8dk0gtwcv5x';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

function fakeProvider({ caps = null, replies = {} } = {}) {
  const seen = [];
  const provider = {
    isTariWallet: true,
    seen,
    request: async (envelope) => {
      seen.push({ method: envelope.method, params: envelope.params });
      if (Object.prototype.hasOwnProperty.call(replies, envelope.method)) {
        const reply = replies[envelope.method];
        return typeof reply === 'function' ? reply(envelope) : reply;
      }
      switch (envelope.method) {
        case 'tari_getCapabilities':
          return caps ?? {
            htlcFund: true,
            scriptPathSpend: true,
            transactionRequests: true,
            transactionResultLookup: true,
          };
        case 'tari_createTransactionRequest':
          return { requestId: 'req_fund_1' };
        case 'tari_submitTransactionRequest':
          return { transactionId: 'tx_fund_1' };
        case 'tari_getTransactionRequest':
          return { requestId: 'req_fund_1', status: 'submitted', result: { transactionId: 'tx_fund_1', ownCommitment: 'c'.repeat(64), conditions: [{ HashLock: HASH }, { AfterEpoch: '12000' }], outputMask: 'mask_1' } };
        default:
          throw new Error(`unexpected method ${envelope.method}`);
      }
    },
  };
  return provider;
}

function makeLeg(provider, { storage = memoryStorage(), substate = undefined } = {}) {
  return leg.createOotleHtlcLeg({
    provider,
    resourceAddress: RESOURCE,
    network: 'localnet',
    readSubstate: async () => substate,
    storage,
  });
}

test('htlc leg: funding constructs the wallet request with the exact public terms', async () => {
  const provider = fakeProvider();
  const storage = memoryStorage();
  const adapter = makeLeg(provider, { storage });
  const intent = {
    hashH: HASH,
    tariRawAmount: '5000000',
    claimRecipient: WALLET_ADDR,
    refundEpoch: '12000',
    network: 'localnet',
    operationId: 'fund_l2_sess1',
  };
  const out = await adapter.constructFunding(intent);
  assert.equal(typeof out.feeEstimate, 'string');
  const create = provider.seen.find((c) => c.method === 'tari_createTransactionRequest');
  assert.ok(create, 'the wallet must be asked to create the funding request');
  assert.equal(create.params.kind, 'htlcFund');
  assert.equal(create.params.resourceAddress, RESOURCE);
  assert.equal(create.params.amount, '5000000');
  assert.equal(create.params.claimantWalletAddress, WALLET_ADDR);
  assert.equal(create.params.hashLockHex, HASH);
  assert.equal(create.params.refundEpoch, '12000');
  // The binding is durably recorded with ONLY non-secret fields.
  const raw = storage.map.get('ootle.htlcLeg.v1');
  assert.ok(typeof raw === 'string' && raw.length > 0);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].operationId, 'fund_l2_sess1');
  assert.equal(parsed.records[0].fundRequestId, 'req_fund_1');
  for (const forbidden of leg.FORBIDDEN_LEG_FIELDS) {
    assert.equal(raw.includes(forbidden), false, `persisted binding must not carry "${forbidden}"`);
  }
});

test('htlc leg: funding validation refuses before the wallet is asked', async () => {
  const provider = fakeProvider();
  const adapter = makeLeg(provider);
  const base = {
    hashH: HASH,
    tariRawAmount: '5000000',
    claimRecipient: WALLET_ADDR,
    refundEpoch: '12000',
    network: 'localnet',
    operationId: 'fund_l2_sess1',
  };
  await assert.rejects(() => adapter.constructFunding({ ...base, hashH: 'xyz' }), /64-hex/);
  await assert.rejects(() => adapter.constructFunding({ ...base, tariRawAmount: '0' }), /positive raw amount/);
  await assert.rejects(() => adapter.constructFunding({ ...base, claimRecipient: 'component_' + 'a'.repeat(64) }), /otl_/);
  assert.equal(provider.seen.filter((c) => c.method === 'tari_createTransactionRequest').length, 0, 'invalid funding must never reach the wallet');
});

test('htlc leg: funding is refused without the L2 capabilities', async () => {
  const provider = fakeProvider({ caps: { htlcFund: false, scriptPathSpend: false } });
  const adapter = makeLeg(provider);
  await assert.rejects(
    () => adapter.constructFunding({ hashH: HASH, tariRawAmount: '1', claimRecipient: WALLET_ADDR, refundEpoch: '12000', network: 'localnet', operationId: 'op1' }),
    /missing capabilities/,
  );
  assert.equal(provider.seen.filter((c) => c.method === 'tari_createTransactionRequest').length, 0);
});

test('htlc leg: funding is refused off execution networks', async () => {
  const provider = fakeProvider();
  const adapter = leg.createOotleHtlcLeg({
    provider,
    resourceAddress: RESOURCE,
    network: 'mainnet',
    readSubstate: async () => undefined,
    storage: memoryStorage(),
  });
  await assert.rejects(
    () => adapter.constructFunding({ hashH: HASH, tariRawAmount: '1', claimRecipient: WALLET_ADDR, refundEpoch: '12000', network: 'mainnet', operationId: 'op1' }),
    /not an execution network/,
  );
});

test('htlc leg: submit funds once and records the wallet-returned commitment', async () => {
  const provider = fakeProvider();
  const storage = memoryStorage();
  const adapter = makeLeg(provider, { storage });
  await adapter.constructFunding({ hashH: HASH, tariRawAmount: '5000000', claimRecipient: WALLET_ADDR, refundEpoch: '12000', network: 'localnet', operationId: 'fund_l2_sess1' });
  const submitted = await adapter.submitFunding('fund_l2_sess1');
  assert.equal(submitted.l2TxId, 'tx_fund_1');
  const parsed = JSON.parse(storage.map.get('ootle.htlcLeg.v1'));
  assert.equal(parsed.records[0].l2TxId, 'tx_fund_1');
  assert.equal(parsed.records[0].commitment, 'c'.repeat(64));
  assert.equal(parsed.records[0].outputMask, 'mask_1');
  assert.ok(Array.isArray(parsed.records[0].conditions) && parsed.records[0].conditions.length > 0);
});

test('htlc leg: a funding result without a commitment is refused, not guessed', async () => {
  const provider = fakeProvider({
    replies: {
      tari_getTransactionRequest: { requestId: 'req_fund_1', status: 'submitted', result: { transactionId: 'tx_fund_1', conditions: [{ HashLock: HASH }], outputMask: 'mask_1' } },
    },
  });
  const adapter = makeLeg(provider);
  await adapter.constructFunding({ hashH: HASH, tariRawAmount: '1', claimRecipient: WALLET_ADDR, refundEpoch: '12000', network: 'localnet', operationId: 'op1' });
  await assert.rejects(() => adapter.submitFunding('op1'), /no ownCommitment/);
});

test('htlc leg: observation verifies hash, amount, expiry and claimant from chain values', () => {
  // Substate built to contain the exact expected scalars.
  const substate = {
    Utxo: {
      output: {
        auth: { Key: 'ff'.repeat(32) },
        conditions: [
          { HashLock: HASH },
          { ClaimPubKey: 'ff'.repeat(64) },
          { AfterEpoch: 12000 },
        ],
        amount: '5000000',
      },
    },
  };
  // The substate's claim key is deliberately NOT the address's pubkey here, so the
  // claimant check must fail (never pass on a wrong key).
  const expected = { hashH: HASH, amountRaw: '5000000', claimantWalletAddress: WALLET_ADDR, refundEpoch: '12000' };
  const parsed = leg.classifyHtlcObservation(substate, expected);
  assert.equal(parsed.exists, true);
  assert.equal(parsed.hashExact, true);
  assert.equal(parsed.claimantExact, false, 'a claim key that is not the claimant address\u2019s key must never verify');
  assert.equal(parsed.unspent, true);
  // Amount and expiry scalars are present in the substate.
  assert.equal(parsed.amountRaw, '5000000');
  assert.equal(parsed.epochRefundExact, true);
});

test('htlc leg: a missing observation fails closed on every check', () => {
  const expected = { hashH: HASH, amountRaw: '5000000', claimantWalletAddress: WALLET_ADDR, refundEpoch: '12000' };
  const parsed = leg.classifyHtlcObservation(undefined, expected);
  assert.deepEqual(parsed, { exists: false, amountRaw: '0', hashExact: false, claimantExact: false, epochRefundExact: false, unspent: false });
  const wrongHash = leg.classifyHtlcObservation({ output: { conditions: [{ HashLock: 'f'.repeat(64) }] } }, expected);
  assert.equal(wrongHash.hashExact, false);
  assert.equal(wrongHash.exists, true, 'present-but-wrong is still evidence-bearing, and still refused');
});

test('htlc leg: observing before funding reports absent, never fabricated', async () => {
  const provider = fakeProvider();
  const adapter = makeLeg(provider, { substate: { output: {} } });
  const obs = await adapter.observeHashlockOutput('tx_never_funded');
  assert.equal(obs.exists, false);
  assert.equal(obs.source, 'AUTHORITATIVE');
});

test('htlc leg: persisted bindings that carry secret-shaped fields are dropped', async () => {
  const storage = memoryStorage();
  storage.setItem(
    'ootle.htlcLeg.v1',
    JSON.stringify({
      version: 1,
      records: [
        { operationId: 'evil1', resourceAddress: RESOURCE, amountRaw: '1', hashH: HASH, claimantWalletAddress: WALLET_ADDR, refundEpoch: '1', network: 'localnet', preimageHex: 'f'.repeat(64) },
        { operationId: 'evil2', resourceAddress: RESOURCE, amountRaw: '1', hashH: HASH, claimantWalletAddress: WALLET_ADDR, refundEpoch: '1', network: 'localnet', extraField: 'x' },
        { operationId: 'good1', resourceAddress: RESOURCE, amountRaw: '1', hashH: HASH, claimantWalletAddress: WALLET_ADDR, refundEpoch: '1', network: 'localnet', fundRequestId: 'req_fund_1' },
      ],
    }),
  );
  const provider = fakeProvider();
  const adapter = makeLeg(provider, { storage });
  // good1 survives; evil1/evil2 are dropped. authorizeFunding with binding present works,
  // and the dropped ones have no binding to act on.
  await adapter.authorizeFunding('good1');
  await assert.rejects(() => adapter.authorizeFunding('evil1'), /No HTLC leg binding/);
  await assert.rejects(() => adapter.authorizeFunding('evil2'), /No HTLC leg binding/);
});

test('htlc leg: claim and refund require the recorded funding binding', async () => {
  const provider = fakeProvider();
  const adapter = makeLeg(provider);
  await assert.rejects(() => adapter.constructClaim('tx_x', 'a'.repeat(64), 'op_unknown'), /No HTLC leg binding/);
  await assert.rejects(() => adapter.constructRefund('tx_x', 'op_unknown'), /No HTLC leg binding/);
});


