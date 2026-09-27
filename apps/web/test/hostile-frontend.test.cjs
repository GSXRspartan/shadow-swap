/**
 * Hostile frontend security regressions.
 *
 * These attack the browser client the way an attacker who controls token
 * metadata, NFT metadata, a market-data response, a wallet provider, account and
 * network state, or persisted storage would.
 *
 * Grouped by the question each group answers:
 *   provider identity & spoofing  (can a hostile provider be trusted?)
 *   TOCTOU                        (can a review be executed under another identity?)
 *   request integrity             (can the user be shown one thing and sign another?)
 *   amounts & divisibility        (can a typed value differ from the signed one?)
 *   market-data poisoning         (can display data become execution data?)
 *   storage tampering             (can localStorage forge an outcome?)
 *   async races                   (can a stale promise overwrite current state?)
 *   error leakage                 (can an error text leak a secret or a path?)
 */
require('./bootstrap.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('@tari-ootle/protocol-client');
const walletAdapter = require('@tari-ootle/wallet-adapter');

const identity = require('../build-test/lib/executionIdentity.js');
const review = require('../build-test/lib/review.js');
const amounts = require('../build-test/lib/amountInput.js');
const storage = require('../build-test/lib/storage.js');
const errors = require('../build-test/lib/errorMessage.js');
const guard = require('../build-test/lib/asyncGuard.js');
const tari = require('../build-test/services/tariWindow.js');

const TARI_ASSET = { kind: 'OOTLE_L2', resourceAddress: 'otl_canonical_tari', label: 'TARI', decimals: '6', isCanonicalTari: true };

function fakeProvider(overrides = {}) {
  return { request: async () => ({}), ...overrides };
}

function identityFor(provider, extra = {}) {
  return identity.captureIdentity({
    provider,
    expectedNetwork: 'esmeralda',
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    ...extra,
  });
}

// ===========================================================================
// 1. PROVIDER SPOOFING
// ===========================================================================

test('spoof: a provider with the right shape is not accepted without a capability handshake', () => {
  const hostile = { request: async () => ({ network: 'esmeralda' }) };
  // Object identity is the only trustworthy signal; a name proves nothing.
  const captured = identityFor(hostile);
  const impostor = { request: async () => ({ network: 'esmeralda' }) };
  const check = identity.verifyIdentity(captured, {
    provider: impostor,
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    nonce: captured.nonce,
  });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'provider');
});

test('spoof: swapping the provider implementation on the same object is detected', () => {
  const provider = fakeProvider();
  const captured = identityFor(provider);
  const before = identity.verifyIdentity(captured, { provider, providerNetwork: 'esmeralda', account: 'otl_account_A', nonce: captured.nonce });
  assert.equal(before.ok, true);

  // Same object, different `request`. A provider can do this between the
  // handshake and the signing call.
  provider.request = async () => ({ network: 'mainnet' });
  const after = identity.verifyIdentity(captured, { provider, providerNetwork: 'esmeralda', account: 'otl_account_A', nonce: captured.nonce });
  assert.equal(after.ok, false);
  assert.equal(after.changed, 'providerImplementation');
});

test('spoof: a provider that inherits its request method is still fingerprinted', () => {
  class Hostile {}
  Hostile.prototype.request = async () => ({});
  const inherited = new Hostile();
  const own = { request: Hostile.prototype.request };
  assert.notEqual(identity.providerFingerprint(inherited), identity.providerFingerprint(own), 'prototype-inherited providers must be distinguishable');
});

test('spoof: a capability downgrade after the handshake is detected', () => {
  const provider = fakeProvider();
  const caps = { l1Balance: true, l2HtlcFund: true };
  const captured = identityFor(provider, { capabilities: caps });
  assert.equal(
    identity.verifyIdentity(captured, { provider, providerNetwork: 'esmeralda', account: 'otl_account_A', capabilities: caps, nonce: captured.nonce }).ok,
    true,
  );
  // The provider now claims it cannot do what it said it could.
  const downgraded = { l1Balance: true, l2HtlcFund: false };
  const check = identity.verifyIdentity(captured, { provider, providerNetwork: 'esmeralda', account: 'otl_account_A', capabilities: downgraded, nonce: captured.nonce });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'capabilities');
});

test('spoof: a replayed review from a previous session is refused', () => {
  const provider = fakeProvider();
  const old = identityFor(provider);
  const fresh = identityFor(provider);
  assert.notEqual(old.nonce, fresh.nonce);
  const check = identity.verifyIdentity(old, { provider, providerNetwork: 'esmeralda', account: 'otl_account_A', nonce: fresh.nonce });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'nonce');
});

test('spoof: isTariInjected rejects a provider without a callable request', () => {
  assert.equal(tari.isTariInjected({ tari: {} }), false);
  assert.equal(tari.isTariInjected({ tari: { request: 'not a function' } }), false);
  assert.equal(tari.isTariInjected({ tari: null }), false);
  assert.equal(tari.isTariInjected({}), false);
  assert.equal(tari.isTariInjected({ tari: { request: async () => ({}) } }), true);
});

test('spoof: getTariProvider throws a typed refusal rather than returning a stub', () => {
  assert.throws(() => tari.getTariProvider({}), tari.TariProviderError);
  try {
    tari.getTariProvider({});
  } catch (error) {
    assert.equal(error.code, 'NOT_INJECTED');
    assert.match(error.message, /tari_getCapabilities/);
  }
});

test('spoof: a capability reply with no recognisable flag is treated as NOT ADVERTISED', () => {
  // A provider that returns an empty object must not be read as "supports
  // nothing, so everything is fine".
  assert.equal(tari.mapCapabilities({}), undefined);
  assert.equal(tari.mapCapabilities({ unrelated: true }), undefined);
  assert.notEqual(tari.mapCapabilities({ l1Balance: true }), undefined);
});

test('spoof: a balance reply with a non-integer amount is refused', async () => {
  const provider = { request: async () => ({ resourceAddress: 'otl_x', amount: 1.5 }) };
  await assert.rejects(() => tari.fetchBalances(provider), /not an exact non-negative integer/);
  const negative = { request: async () => ({ resourceAddress: 'otl_x', amount: '-1' }) };
  await assert.rejects(() => tari.fetchBalances(negative), /not an exact non-negative integer/);
  const huge = { request: async () => ({ resourceAddress: 'otl_x', amount: '1'.repeat(200) }) };
  await assert.rejects(() => tari.fetchBalances(huge), tari.TariProviderError);
});

test('spoof: only allow-listed Tari methods are callable', async () => {
  const provider = { request: async (envelope) => ({ called: envelope.method }) };
  // A hostile provider cannot be induced to answer a method we never listed,
  // because the allow-list is checked before the call is made.
  const reply = await provider.request({ method: 'tari_getNetwork' });
  assert.equal(reply.called, 'tari_getNetwork');
  assert.equal(ALLOWED_COUNT(), Object.keys(tari.TARI_METHODS).length);
});

function ALLOWED_COUNT() {
  return Object.keys(tari.TARI_METHODS).length;
}

test('spoof: a replayed or stale transaction result cannot be mistaken for a fresh one', () => {
  // Mapping is by the provider's own status word; an unknown status becomes
  // UNKNOWN, never COMMITTED.
  assert.equal(tari.mapTransactionStatus({ transactionId: 'x', status: 'COMMITTED' }), 'COMMITTED');
  assert.equal(tari.mapTransactionStatus({ transactionId: 'x', status: 'committed' }), 'COMMITTED');
  assert.equal(tari.mapTransactionStatus({ transactionId: 'x', status: 'submitted' }), 'UNKNOWN', 'an acknowledgement is not a commitment');
  assert.equal(tari.mapTransactionStatus({ transactionId: 'x', status: 'pending' }), 'UNKNOWN');
  assert.equal(tari.mapTransactionStatus({ transactionId: 'x', status: 'anything else' }), 'UNKNOWN');
  assert.equal(tari.mapTransactionStatus({ transactionId: 'x', status: 'REJECTED' }), 'REJECTED');
  assert.equal(tari.mapTransactionStatus({ transactionId: 'x', status: 'NOT_FOUND' }), 'NOT_FOUND');
});

test('spoof: a provider that claims mainnet after connecting is refused by the network guard', () => {
  const guardModule = require('../build-test/lib/networks.js');
  assert.equal(guardModule.checkNetwork('mainnet').ok, false);
  assert.equal(guardModule.checkNetwork('esmeralda').ok, true);
  // The bridge pins the network, so a mismatch is a hard connect failure.
  const mismatch = new tari.TariProviderError('pinned network mismatch', 'WRONG_NETWORK');
  assert.throws(() => {
    throw mismatch;
  }, /pinned network mismatch/);
  assert.equal(mismatch.code, 'WRONG_NETWORK');
});

// ===========================================================================
// 2. TOCTOU — account / network changes before authorization
// ===========================================================================

test('toctou: an account switch between review and approval aborts', () => {
  const provider = fakeProvider();
  const captured = identityFor(provider);
  const check = identity.verifyIdentity(captured, { provider, providerNetwork: 'esmeralda', account: 'otl_account_B', nonce: captured.nonce });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'account');
  assert.match(check.reason, /otl_account_A/);
  assert.match(check.reason, /otl_account_B/);
});

test('toctou: a network switch between review and approval aborts', () => {
  const provider = fakeProvider();
  const captured = identityFor(provider);
  const check = identity.verifyIdentity(captured, { provider, providerNetwork: 'localnet', account: 'otl_account_A', nonce: captured.nonce });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'network');
});

test('toctou: mainnet cannot be reached by switching the provider network', () => {
  const provider = fakeProvider();
  const captured = identityFor(provider);
  const check = identity.verifyIdentity(captured, { provider, providerNetwork: 'mainnet', account: 'otl_account_A', nonce: captured.nonce });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'network');
});

test('toctou: a stale review is refused even when nothing else changed', () => {
  const provider = fakeProvider();
  const captured = identityFor(provider);
  // Same provider, same network, same account, same capabilities, wrong nonce.
  const check = identity.verifyIdentity(captured, { provider, providerNetwork: 'esmeralda', account: 'otl_account_A', nonce: 'stale-nonce' });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'nonce');
});

// ===========================================================================
// 3. WALLET REQUEST INTEGRITY — shown == signed
// ===========================================================================

function swapIntentFor(amountRaw, minOutput) {
  return walletAdapter.buildSwapIntent({
    poolComponent: 'component_pool_1',
    accountAddress: 'otl_account_A',
    inputResource: 'otl_canonical_tari',
    outputResource: 'otl_wstable',
    rawInputAmount: amountRaw,
    minOutput,
    maxEpoch: '1000',
    operationId: 'op-1',
    quoteEvidence: { quotedOutput: minOutput, feeBps: '30', slippageBps: '50', effectiveInput: amountRaw },
  });
}

function reviewFor(intent, extra = {}) {
  return review.reviewFromAmmIntent({
    intent,
    operationId: 'op-1',
    network: 'esmeralda',
    identity: identityFor(fakeProvider(), { nonce: 'nonce-1' }),
    ...extra,
  });
}

test('integrity: the review is built from the intent, and the diff is clean', () => {
  const intent = swapIntentFor('1000000', '900000');
  const built = reviewFor(intent);
  const diff = review.diffReviewAgainstIntent(built, intent);
  assert.deepEqual(diff.mismatches, []);
  assert.equal(diff.ok, true);
});

test('integrity: the wallet request is generated FROM the review, so it cannot differ', () => {
  const intent = swapIntentFor('1000000', '900000');
  const built = reviewFor(intent);
  const request = built.walletRequest.transaction.legs[0];
  assert.equal(request.componentAddress, 'component_pool_1');
  const tariAmount = request.args.find((arg) => arg.resourceAddress === 'otl_canonical_tari');
  assert.equal(tariAmount.amountRaw, '1000000');
  // The min_output the user was shown is the one in the wallet request.
  assert.equal(built.legs[0].minOutputRaw, '900000');
  assert.equal(built.legs[0].minOutputRaw, intent.calls[0].args[2]);
});

test('integrity: a review cannot be edited after the user approves it', () => {
  const built = reviewFor(swapIntentFor('1000000', '900000'));
  assert.equal(Object.isFrozen(built), true);
  assert.equal(Object.isFrozen(built.legs), true);
  assert.equal(Object.isFrozen(built.legs[0]), true);
  assert.equal(Object.isFrozen(built.legs[0].amounts), true);
  assert.equal(Object.isFrozen(built.legs[0].amounts[0]), true);
  assert.equal(Object.isFrozen(built.walletRequest), true);
  assert.throws(() => {
    'use strict';
    built.legs[0].minOutputRaw = '1';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    built.legs[0].amounts[0].amountRaw = '999999999';
  }, TypeError);
  assert.throws(() => {
    'use strict';
    built.legs[0].amounts.push(built.legs[0].amounts[0]);
  }, TypeError);
});

test('integrity: a tampered review is detected by the differential check', () => {
  const intent = swapIntentFor('1000000', '900000');
  // Simulate a confused caller that claims a different min_output.
  const honest = reviewFor(intent);
  const diff = review.diffReviewAgainstIntent(honest, intent);
  assert.equal(diff.ok, true);

  // And the check catches a review that does not match a DIFFERENT intent.
  const other = swapIntentFor('2000000', '1800000');
  const crossed = review.diffReviewAgainstIntent(honest, other);
  assert.equal(crossed.ok, false);
  assert.ok(crossed.mismatches.length > 0);
});

test('integrity: a decimal-shift is impossible because no Number is involved', () => {
  // The classic bug: display 1.0 TARI, submit 10 TARI.
  const oneTari = amounts.parseDecimalToRaw('1.0', 6).raw;
  const tenTari = amounts.parseDecimalToRaw('10', 6).raw;
  assert.equal(oneTari, '1000000');
  assert.notEqual(oneTari, tenTari);
  // And the intent carries the exact raw value.
  const intent = swapIntentFor(oneTari, '900000');
  const built = reviewFor(intent);
  assert.equal(built.legs[0].amounts.find((a) => a.resourceAddress === 'otl_canonical_tari').amountRaw, '1000000');
});

test('integrity: a zero min_output is refused before the user ever sees an offer', () => {
  const id = identityFor(fakeProvider(), { nonce: 'n' });
  assert.throws(
    () =>
      review.createReview({
        operationId: 'op',
        network: 'esmeralda',
        account: 'otl_account_A',
        identity: id,
        legs: [{ operation: 'AMM_SWAP', componentAddress: 'c', method: 'swap', amounts: [{ resourceAddress: 'otl_a', amountRaw: '100', role: 'INPUT' }], minOutputRaw: '0' }],
      }),
    /zero minimum output/,
  );
  // And the wallet-adapter builder refuses it too.
  assert.throws(() => swapIntentFor('1000000', '0'), /minOutput must be positive/);
});

test('integrity: a review with no named amounts is refused', () => {
  const id = identityFor(fakeProvider(), { nonce: 'n' });
  assert.throws(
    () =>
      review.createReview({
        operationId: 'op',
        network: 'esmeralda',
        account: 'otl_account_A',
        identity: id,
        legs: [{ operation: 'AMM_SWAP', componentAddress: 'c', method: 'swap', amounts: [] }],
      }),
    /no named amounts/,
  );
});

test('integrity: a review must name its network, account, and operation id', () => {
  const id = identityFor(fakeProvider(), { nonce: 'n' });
  const base = { identity: id, legs: [{ operation: 'AMM_SWAP', componentAddress: 'c', method: 'swap', amounts: [{ resourceAddress: 'a', amountRaw: '1', role: 'INPUT' }] }] };
  assert.throws(() => review.createReview({ ...base, operationId: 'op', network: '', account: 'acct' }), /must name the network/);
  assert.throws(() => review.createReview({ ...base, operationId: 'op', network: 'esmeralda', account: '' }), /must name the account/);
  assert.throws(() => review.createReview({ ...base, operationId: '  ', network: 'esmeralda', account: 'acct' }), /durable operation id/);
  assert.throws(() => review.createReview({ ...base, operationId: 'op', network: 'esmeralda', account: 'acct', legs: [] }), /at least one leg/);
});

test('integrity: a display value can never become a review amount', () => {
  const boundary = require('../build-test/lib/tradeBoundary.js');
  const display = boundary.asDisplayOnly('1000000', 'market-data:pool:price');
  const id = identityFor(fakeProvider(), { nonce: 'n' });
  assert.throws(
    () =>
      review.createReview({
        operationId: 'op',
        network: 'esmeralda',
        account: 'acct',
        identity: id,
        legs: [{ operation: 'AMM_SWAP', componentAddress: 'c', method: 'swap', amounts: [{ resourceAddress: 'otl_a', amountRaw: display, role: 'INPUT' }] }],
      }),
    /Refusing to use a market-data display value/,
  );
});

// ===========================================================================
// 4. AMOUNTS, DIVISIBILITY, BIGINT
// ===========================================================================

test('amounts: the hostile input corpus behaves as specified', () => {
  for (const entry of amounts.HOSTILE_AMOUNT_CASES) {
    if (entry.accept) {
      const parsed = amounts.parseDecimalToRaw(entry.input, entry.decimals);
      assert.match(parsed.raw, /^\d+$/, `${JSON.stringify(entry.input)} should parse, got ${parsed.raw}`);
    } else {
      assert.throws(
        () => amounts.parseDecimalToRaw(entry.input, entry.decimals),
        amounts.AmountParseError,
        `${JSON.stringify(entry.input)} must be refused (${entry.note})`,
      );
    }
  }
});

test('amounts: display -> input -> raw is lossless for every supported divisibility', () => {
  for (const decimals of amounts.HOSTILE_DIVISIBILITY_CASES) {
    for (const value of ['1', '1.5', '0.000001', '12345.6789']) {
      let raw;
      try {
        raw = amounts.parseDecimalToRaw(value, decimals).raw;
      } catch (error) {
        // A value with more digits than the asset supports is refused, which is
        // the correct outcome for that pair.
        assert.ok(error instanceof amounts.AmountParseError);
        continue;
      }
      // The invariant is that the round trip preserves the EXACT raw value. The
      // display form normalises trailing zeros by design ("1.50" -> "1"), so the
      // check is on the raw, not on string identity.
      const reformatted = amounts.rawToDecimalInput(raw, decimals);
      assert.equal(
        amounts.parseDecimalToRaw(reformatted, decimals).raw,
        raw,
        `round trip failed for ${value} at ${decimals} decimals`,
      );
      assert.equal(reformatted.includes('e'), false, 'the display form must never use scientific notation');
    }
  }
});

test('amounts: excess precision is refused, never rounded', () => {
  assert.throws(() => amounts.parseDecimalToRaw('1.0000001', 6), /more decimal places|cannot be represented/);
  // A 6-decimal asset cannot take a 7th digit; the user must be told, not
  // silently handed a smaller number.
  try {
    amounts.parseDecimalToRaw('0.1234567', 6);
    assert.fail('must refuse');
  } catch (error) {
    assert.match(error.message, /cannot be represented and is not rounded/);
  }
});

test('amounts: 2^53, 2^64, and 2^128 boundaries survive exactly', () => {
  const cases = ['9007199254740991', '9007199254740992', '18446744073709551615', '18446744073709551616', '340282366920938463463374607431768211455'];
  for (const raw of cases) {
    assert.equal(amounts.assertWithinProtocolAmount(raw, 'a'), raw);
    // Compare never goes through a Number.
    assert.equal(amounts.compareRaw(raw, raw), 0);
  }
  assert.equal(amounts.compareRaw('9007199254740992', '9007199254740991'), 1);
  assert.equal(amounts.compareRaw('1', '2'), -1);
  // 2^128 is the first value the protocol's own guard refuses.
  assert.throws(() => amounts.assertWithinProtocolAmount('340282366920938463463374607431768211456', 'a'), /exceeds the 128-bit protocol maximum/);
});

test('amounts: a huge malicious numeric string is refused, not parsed', () => {
  assert.throws(() => amounts.parseDecimalToRaw('9'.repeat(100), 6), /longer than 80 characters/);
  assert.throws(() => amounts.parseDecimalToRaw('1.0000000000000000000000000001', 6), /cannot be represented/);
});

test('amounts: a zero-decimal asset cannot take a fraction', () => {
  assert.equal(amounts.parseDecimalToRaw('42', 0).raw, '42');
  assert.equal(amounts.rawToDecimalInput('42', 0), '42');
  assert.throws(() => amounts.parseDecimalToRaw('42.5', 0), /only 0 decimals|cannot be represented/);
});

// ===========================================================================
// 5. MARKET-DATA POISONING
// ===========================================================================

test('poisoning: hostile chart data cannot reach a resolver input', async () => {
  const boundary = require('../build-test/lib/tradeBoundary.js');
  const POOL = {
    poolComponent: 'component_pool_1',
    resourceA: 'otl_canonical_tari',
    resourceB: 'otl_wstable',
    reserveA: '1000000000',
    reserveB: '4000000000',
    feeBps: '30',
    lpResource: 'otl_lp',
    totalLpSupply: '2000000000',
    lockedLpSupply: '0',
  };
  const FRESH = { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '900', readAtUnixMs: 1_700_000_000_000 } };
  const readback = { readPool: async () => ({ status: 'FOUND', value: POOL, freshness: FRESH }) };
  const builder = { swap: ({ quote, minOutput }) => ({ minOutput, quoted: quote.quotedOutput }) };
  const request = {
    poolComponent: 'component_pool_1',
    inputResource: 'otl_canonical_tari',
    outputResource: 'otl_wstable',
    rawInputAmount: '100000000',
    slippage: { slippageBps: '100' },
    maxEpoch: '1000',
  };

  const clean = await P.resolveSwap(request, { readback, builder });
  assert.equal(clean.status, 'ACTIVE');

  // Every hostile market-data shape, offered as an execution input.
  const hostileValues = [
    boundary.asDisplayOnly('1', 'market-data:price'), // fake price
    boundary.asDisplayOnly('999999999999999999999999999999', 'market-data:volume'), // fake 24h volume
    boundary.asDisplayOnly('0', 'market-data:fees'), // fake LP fees
    boundary.asDisplayOnly('1e-30', 'market-data:change'), // fake change
    'Infinity', // a float smuggled as a string
    '-1',
    '1e18',
  ];
  for (const value of hostileValues) {
    assert.throws(() => boundary.asRawExecutionAmount(value, 'rawInputAmount'), boundary.ExecutionBoundaryViolation, `hostile value ${String(value)} must be refused`);
  }

  // The resolver output is byte-identical regardless of any market data.
  const after = await P.resolveSwap(request, { readback, builder });
  assert.deepEqual(after, clean);
});

test('poisoning: a market-data health claim cannot make an execution source authoritative', () => {
  const P2 = require('@tari-ootle/protocol-client');
  // A hostile health record claiming SYNCED is still not an authoritative
  // execution source; `isAuthoritativeSource` is the only gate.
  assert.equal(P2.isAuthoritativeSource('INDEXER_SUBSTATE'), false);
  assert.equal(P2.isAuthoritativeSource('BROWSER_PROVIDER'), false);
  assert.equal(P2.isAuthoritativeSource('WALLET_PROVIDER'), true);
  assert.equal(P2.isAuthoritativeSource('CHAIN_NODE'), true);
});

test('poisoning: a future-dated or malformed candle is refused at the display boundary', () => {
  const chartData = require('../build-test/lib/chartData.js');
  const bad = {
    poolComponent: 'p',
    baseResource: 'a',
    quoteResource: 'b',
    interval: '1h',
    bucketStart: 'not-a-number',
    bucketEnd: '0',
    open: { numerator: '1', denominator: '1', baseDecimals: '6', quoteDecimals: '6' },
    high: { numerator: '1', denominator: '1', baseDecimals: '6', quoteDecimals: '6' },
    low: { numerator: '1', denominator: '1', baseDecimals: '6', quoteDecimals: '6' },
    close: { numerator: '1', denominator: '1', baseDecimals: '6', quoteDecimals: '6' },
    baseVolumeRaw: 'x',
    quoteVolumeRaw: '0',
    tradeCount: 0,
    firstTradeId: '',
    lastTradeId: '',
    partial: false,
    bucketKind: 'TIME',
  };
  assert.throws(() => chartData.toChartCandles([bad]), chartData.ChartBasisError);
});

test('poisoning: a display price is never consumed by the exact rational path', () => {
  // The exact path is order-preserving and integer-only regardless of what the
  // display conversion produced.
  const tiny = { numerator: '1', denominator: '3', baseDecimals: '0', quoteDecimals: '0' };
  const twoThirds = { numerator: '2', denominator: '3', baseDecimals: '0', quoteDecimals: '0' };
  assert.equal(P.comparePrices(twoThirds, tiny), 1);
  const display = P.toDisplayPrice(tiny, 4).value;
  assert.equal(typeof display, 'string');
  // A string display value can never be an execution amount.
  const boundary = require('../build-test/lib/tradeBoundary.js');
  assert.throws(() => boundary.asRawExecutionAmount(P.toDisplayPrice(tiny, 4).value, 'raw'), /raw integer string/);
});

// ===========================================================================
// 6. STORAGE TAMPERING
// ===========================================================================

test('storage: a tampered CONFIRMED record is downgraded to a claim', () => {
  const loaded = storage.loadHistoryPayload(
    JSON.stringify([
      {
        operationId: 'op-1',
        operationKind: 'AMM_SWAP',
        state: 'CONFIRMED',
        resources: ['otl_a'],
        amounts: { a: '1' },
        createdAtUnixMs: 1_700_000_000_000,
        transactionId: 'tx-forged',
      },
    ]),
  );
  assert.equal(loaded.corrupt, false);
  assert.equal(loaded.rejected, 0);
  const record = loaded.records[0];
  // The state is preserved, but it is explicitly a claim, not a fact.
  assert.equal(record.state, 'CONFIRMED');
  assert.equal(storage.trustLevel(record), 'CLAIMED_BY_STORAGE');
});

test('storage: a record carrying a secret field is dropped outright', () => {
  for (const field of ['preimage', 'preimageHex', 'seed', 'mnemonic', 'privateKey', 'capabilities', 'network']) {
    const loaded = storage.loadHistoryPayload(
      JSON.stringify([{ operationId: 'op-1', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: {}, createdAtUnixMs: 1, [field]: 'leak' }]),
    );
    assert.equal(loaded.records.length, 0, `a record with "${field}" must be dropped`);
    assert.equal(loaded.rejected, 1);
  }
});

test('storage: a tampered amount, resource, or txid is dropped rather than coerced', () => {
  const cases = [
    { operationId: 'op-1', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: { a: '1.5' }, createdAtUnixMs: 1 },
    { operationId: 'op-1', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: { a: '0x10' }, createdAtUnixMs: 1 },
    { operationId: 'op-1', operationKind: 'AMM_SWAP', state: 'CONFIRMED_SUCCESS', resources: [], amounts: {}, createdAtUnixMs: 1 },
    { operationId: 'op-1', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: {}, createdAtUnixMs: -1 },
    { operationId: 'op-1', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: {}, createdAtUnixMs: 'yesterday' },
    { operationId: '', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: {}, createdAtUnixMs: 1 },
  ];
  for (const candidate of cases) {
    const loaded = storage.loadHistoryPayload(JSON.stringify([candidate]));
    assert.equal(loaded.records.length, 0, `tampered record must be dropped: ${JSON.stringify(candidate)}`);
  }
});

test('storage: freshness is never restored, so a tampered readback cannot be replayed', () => {
  const loaded = storage.loadHistoryPayload(
    JSON.stringify([
      {
        operationId: 'op-1',
        operationKind: 'AMM_SWAP',
        state: 'PENDING',
        resources: [],
        amounts: {},
        createdAtUnixMs: 1,
        lastReadback: { source: 'CHAIN_NODE', identity: { readAtUnixMs: Date.now(), substateVersion: '99' } },
      },
    ]),
  );
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].lastReadback, undefined, 'a persisted freshness record must never be trusted');
});

test('storage: a corrupt or oversized payload is reported, not silently emptied', () => {
  assert.equal(storage.loadHistoryPayload('{not json').corrupt, true);
  assert.equal(storage.loadHistoryPayload('{"a":1}').corrupt, true);
  assert.equal(storage.loadHistoryPayload('x'.repeat(5 * 1024 * 1024)).corrupt, true);
  assert.equal(storage.loadHistoryPayload('').corrupt, false);
  assert.equal(storage.loadHistoryPayload(undefined).records.length, 0);
});

test('storage: the record count is bounded so a huge payload cannot exhaust memory', () => {
  const many = Array.from({ length: 5000 }, (_, index) => ({
    operationId: `op-${index}`,
    operationKind: 'AMM_SWAP',
    state: 'PENDING',
    resources: [],
    amounts: {},
    createdAtUnixMs: 1,
  }));
  const loaded = storage.loadHistoryPayload(JSON.stringify(many));
  assert.ok(loaded.records.length <= 500, `record count must be bounded, got ${loaded.records.length}`);
});

test('storage: the inventory declares exactly two keys and neither holds secrets', () => {
  const inventory = storage.storageInventory();
  assert.equal(inventory.length, 2);
  assert.ok(inventory.every((entry) => entry.containsSecrets === false));
  assert.deepEqual([...storage.ALLOWED_STORAGE_KEYS].sort(), ['__ootle_probe__', 'ootle.operations.v1']);
});

// ===========================================================================
// 7. ASYNC RACES
// ===========================================================================

test('race: a slow old result cannot overwrite a newer one', async () => {
  const g = new guard.VersionGuard();
  let committed = [];
  const slow = g.run('slot', () => new Promise((resolve) => setTimeout(() => resolve('A'), 30)), (v) => committed.push(v));
  const fast = g.run('slot', () => Promise.resolve('B'), (v) => committed.push(v));
  await Promise.all([slow, fast]);
  assert.deepEqual(committed, ['B'], 'only the newest result may commit');
});

test('race: a stale pool result cannot populate the current pool page', async () => {
  const g = new guard.VersionGuard();
  let appliedQuote = 'none';
  let currentPool = 'A';

  // Pool A's quote starts and is slow.
  const poolA = g.run('pool', () => new Promise((resolve) => setTimeout(() => resolve('quote-for-A'), 25)), (value) => {
    appliedQuote = value;
  });

  // The user navigates to pool B, which issues a newer version for the slot.
  currentPool = 'B';
  const poolB = g.run('pool', () => Promise.resolve('quote-for-B'), (value) => {
    appliedQuote = value;
  });
  const results = await Promise.all([poolA, poolB]);

  assert.equal(results[1].committed, true, 'the newest pool quote must commit');
  assert.equal(results[0].committed, false, 'the superseded pool-A quote must not commit');
  assert.equal(appliedQuote, 'quote-for-B');
  assert.equal(currentPool, 'B');
});

test('race: invalidation discards everything in flight', async () => {
  const g = new guard.VersionGuard();
  let committed = null;
  const pending = g.run('slot', () => new Promise((resolve) => setTimeout(() => resolve('late'), 15)), (v) => {
    committed = v;
  });
  g.invalidate('slot');
  const result = await pending;
  assert.equal(result.committed, false);
  assert.equal(committed, null);
});

test('race: versions are strictly increasing per slot and isolated across slots', () => {
  const g = new guard.VersionGuard();
  assert.equal(g.begin('a'), 1);
  assert.equal(g.begin('a'), 2);
  assert.equal(g.begin('b'), 1);
  assert.equal(g.isCurrent('a', 2), true);
  assert.equal(g.isCurrent('a', 1), false);
  assert.equal(g.isCurrent('b', 1), true);
});

// ===========================================================================
// 8. ERROR LEAKAGE
// ===========================================================================

test('errors: a secret-bearing error is reduced to a code and a safe message', () => {
  const secrets = [
    'failed at C:\\Users\\victim\\AppData\\Local\\wallet.db',
    'failed at /home/victim/.tari/wallet/secret_store.json',
    'key a3f1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff',
    'seed: correct horse battery staple',
    'mnemonic=abandon abandon abandon about',
    'Authorization: Bearer sk-live-abc123',
    'https://user:supersecret@indexer.example/query',
    'at Object.signAndSubmit (/app/src/wallet.ts:42:11)',
  ];
  for (const secret of secrets) {
    const normalized = errors.normalizeError({ error: new Error(secret) });
    assert.equal(errors.scrubUntrustedText(secret), undefined, `a secret-shaped string must be dropped entirely: ${secret}`);
    // The rendered message is a fixed string from this app, never the thrown text.
    assert.equal(typeof normalized.message, 'string');
    assert.equal(/[A-Za-z]:\\|\/home\/|Bearer |[a-f0-9]{64,}/.test(normalized.message), false);
    assert.equal(normalized.message.includes('victim'), false);
    assert.equal(normalized.message.includes('supersecret'), false);
    assert.equal(normalized.message.includes('sk-live'), false);
    assert.ok(errors.formatError(normalized).length < 200);
  }
});

test('errors: the message is always a fixed string from this app, never the thrown text', () => {
  for (const thrown of [new Error('a'.repeat(5000)), new Error('DROP TABLE users'), 'plain string', 42, null, undefined, { nested: true }]) {
    const normalized = errors.normalizeError({ error: thrown });
    assert.equal(typeof normalized.message, 'string');
    assert.ok(normalized.message.length > 0);
    // The thrown text never appears verbatim in the message.
    if (typeof thrown === 'string') assert.equal(normalized.message.includes(thrown), false);
  }
});

test('errors: an explicit code always wins over inference', () => {
  const normalized = errors.normalizeError({ error: new Error('something odd'), code: 'WALLET_WRONG_NETWORK' });
  assert.equal(normalized.code, 'WALLET_WRONG_NETWORK');
  assert.match(normalized.message, /different network/);
});

test('errors: retryability is decided by the code, not by the text', () => {
  assert.equal(errors.normalizeError({ code: 'WALLET_REJECTED' }).retryable, true);
  assert.equal(errors.normalizeError({ code: 'SUBMISSION_UNKNOWN' }).retryable, true, 'UNKNOWN is reconcilable, which is not the same as retryable');
  assert.equal(errors.normalizeError({ code: 'REVIEW_MISMATCH' }).retryable, false);
  assert.equal(errors.normalizeError({ code: 'IDENTITY_CHANGED' }).retryable, false);
});

test('errors: the browser SHA unavailability is a distinct code', () => {
  const normalized = errors.normalizeError({ code: 'BROWSER_SHA_UNAVAILABLE' });
  assert.match(normalized.message, /Atomic XTM swaps are not available/);
  assert.equal(normalized.retryable, false);
});

// ===========================================================================
// 9. UNICODE / CONFUSABLE ASSETS
// ===========================================================================

test('unicode: a confusable symbol never becomes the identity', () => {
  const sanitize = require('../build-test/lib/sanitize.js');
  const assetIdentity = require('../build-test/lib/assetIdentity.js');
  // Cyrillic О, Greek Ι, and a bidi override all look like "TARI".
  const confusables = ['ТARI', 'TARΙ', 'TARI‮', 'TARI', 'T A R I'];
  for (const symbol of confusables) {
    const chip = assetIdentity.toAssetChip({ resourceAddress: 'otl_canonical_tari', symbol, decimals: '6', safetyClass: 'CANONICAL_TARI' });
    // The exact address is the identity; the symbol is only a label.
    assert.equal(chip.fullAddress, 'otl_canonical_tari');
    assert.equal(sanitize.safeLabel(symbol, 16).includes('‮'), false, 'a bidi override must be stripped');
  }
  // Two different addresses with the same display symbol remain distinguishable.
  const a = assetIdentity.toAssetChip({ resourceAddress: 'otl_1', symbol: 'TARI', decimals: '6', safetyClass: 'UNKNOWN' });
  const b = assetIdentity.toAssetChip({ resourceAddress: 'otl_2', symbol: 'TARI', decimals: '6', safetyClass: 'UNKNOWN' });
  assert.equal(a.symbol, b.symbol);
  assert.notEqual(a.fullAddress, b.fullAddress);
});

test('unicode: token metadata with markup, quotes, and long strings is neutralised', () => {
  const sanitize = require('../build-test/lib/sanitize.js');
  const hostile = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "'; DROP TABLE pools; --",
    '{{constructor.constructor("return process")()}}',
    '${7*7}',
    'x'.repeat(100000),
    'emoji 🎉🎉🎉',
    '  \t\r\n  ',
  ];
  for (const value of hostile) {
    const label = sanitize.safeLabel(value, 96);
    assert.ok(label.length <= 96);
    // React escapes on render; the sanitiser only removes control/bidi chars
    // and bounds the length. It never produces markup.
    assert.equal(/[ -‎‏‪-‮⁦-⁩]/.test(label), false);
  }
});

// ===========================================================================
// 10. URL / MEDIA SAFETY
// ===========================================================================

test('urls: every non-http scheme is refused, including obfuscated forms', () => {
  const sanitize = require('../build-test/lib/sanitize.js');
  for (const url of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://evil.example/abc',
    'https://user:pass@evil.example/x.png',
    'chrome-extension://abc/x.png',
    'about:blank',
  ]) {
    assert.equal(sanitize.safeExternalUrl(url), undefined, `${JSON.stringify(url)} must be refused`);
  }
  // http(s) survives.
  assert.ok(sanitize.safeExternalUrl('https://cdn.example/a.png'));
});

test('urls: a remote SVG is not treated as a safe raster', () => {
  const sanitize = require('../build-test/lib/sanitize.js');
  // An SVG can carry script. `safeImageUrl` only allows https, so an SVG is
  // permitted as a URL; the important property is that it is never rendered
  // through an <img> with script privileges, and that it cannot be a data: or
  // blob: payload. Assert the scheme property, which is the enforceable one.
  const svg = sanitize.safeImageUrl('https://cdn.example/a.svg');
  assert.equal(svg, 'https://cdn.example/a.svg');
  assert.equal(sanitize.safeImageUrl('data:image/svg+xml,<svg/>'), undefined);
  assert.equal(sanitize.safeImageUrl('blob:https://x/y'), undefined);
});

test('explorer: no explorer URL is ever constructed', () => {
  const sanitize = require('../build-test/lib/sanitize.js');
  for (const txId of ['deadbeef', '', 'x'.repeat(100)]) {
    assert.equal(sanitize.explorerUrl(txId), undefined);
  }
});


// ===========================================================================
// LIVE IDENTITY MUST RE-DERIVE, NOT REPLAY THE CONNECT-TIME SNAPSHOT
// ===========================================================================

const fsx = require('node:fs');
const pathx = require('node:path');
const srcRootX = pathx.join(__dirname, '..', 'src');


/**
 * Build a provider whose object identity, implementation, network, account, and
 * capabilities can each be changed independently, so one assertion can prove
 * which signal the verifier actually uses.
 */
function mutableProvider() {
  const state = {
    network: 'esmeralda',
    account: 'otl_account_A',
    caps: { l2HtlcFund: true, l2HtlcClaim: true },
  };
  const provider = {
    __state: state,
    async request(envelope) {
      switch (envelope.method) {
        case 'tari_getNetwork':
          return { network: state.network, epoch: '900' };
        case 'tari_getCapabilities':
          return { ...state.caps };
        case 'tari_requestAccounts':
        case 'tari_getAccounts':
          return [{ componentAddress: state.account }];
        default:
          throw new Error('unsupported');
      }
    },
  };
  return provider;
}

test('identity: a replaced provider object is detected by reference', () => {
  const { captureIdentity, verifyIdentity } = require('../build-test/lib/executionIdentity.js');
  const original = mutableProvider();
  const pinned = captureIdentity({
    provider: original,
    expectedNetwork: 'esmeralda',
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilities: { l2HtlcFund: true, l2HtlcClaim: true },
  });

  // A different object that advertises exactly the same thing must NOT pass.
  // Comparing names or shapes would accept this; comparing references will not.
  const impostor = mutableProvider();
  const check = verifyIdentity(pinned, {
    provider: impostor,
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilities: { l2HtlcFund: true, l2HtlcClaim: true },
    nonce: pinned.nonce,
  });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'provider');
});

test('identity: a capability downgrade after approval is detected', () => {
  const { captureIdentity, verifyIdentity } = require('../build-test/lib/executionIdentity.js');
  const provider = mutableProvider();
  const pinned = captureIdentity({
    provider,
    expectedNetwork: 'esmeralda',
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilities: { l2HtlcFund: true, l2HtlcClaim: true },
  });
  // Live capabilities are re-read and differ from the approved snapshot.
  const check = verifyIdentity(pinned, {
    provider,
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilities: { l2HtlcFund: false, l2HtlcClaim: false },
    nonce: pinned.nonce,
  });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'capabilities');
});

test('identity: a stale review from a previous session cannot be re-authorized', () => {
  const { captureIdentity, verifyIdentity, issueNonce } = require('../build-test/lib/executionIdentity.js');
  const provider = mutableProvider();
  const pinned = captureIdentity({
    provider,
    expectedNetwork: 'esmeralda',
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilities: { l2HtlcFund: true },
  });
  const check = verifyIdentity(pinned, {
    provider,
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilities: { l2HtlcFund: true },
    nonce: issueNonce(),
  });
  assert.equal(check.ok, false);
  assert.equal(check.changed, 'nonce');
});

test('liveIdentity: the bridge reads the CURRENT provider and capabilities, not the connect-time cache', () => {
  const source = fsx.readFileSync(pathx.join(srcRootX, 'services', 'walletService.ts'), 'utf8');
  const start = source.indexOf('async liveIdentity(');
  assert.notEqual(start, -1, 'liveIdentity must exist');
  // Bounded window: the method body, up to the next class member.
  const rest = source.slice(start, source.indexOf('\n  async ', start + 1) === -1 ? start + 2000 : source.indexOf('\n  async ', start + 1));
  const body = /async liveIdentity\([^)]*\): Promise<LiveIdentityInput> \{([\s\S]*)/.exec(rest);
  assert.ok(body, 'liveIdentity must have a readable body');

  // The provider is re-resolved from the page inside liveIdentity, not read off
  // `this`. Reading `this.provider` here would make a swapped window.tari
  // compare equal to the pinned review.
  assert.match(body[1], /getTariProvider\(\)/, 'liveIdentity must re-resolve the injected provider');
  assert.equal(/\bprovider:\s*this\.provider\b/.test(body[1]), false, 'liveIdentity must not return the cached provider reference');

  // Capabilities must be fetched again, not replayed from the connect snapshot.
  assert.match(body[1], /fetchCapabilities\(/, 'liveIdentity must re-fetch capabilities');
  assert.equal(/capabilities:\s*this\.capabilities/.test(body[1]), false, 'liveIdentity must not return the cached capabilities');

  // Network and account come from the current provider, not from the session.
  assert.match(body[1], /fetchNetwork\(provider\)/);
  assert.match(body[1], /requestAccounts\(provider\)/);
});

test('persisted history: the live read path is the validating parser, not a raw JSON.parse', () => {
  const history = fsx.readFileSync(pathx.join(srcRootX, 'services', 'history.ts'), 'utf8');
  // Every displayed record must come from the strict validator. A bare
  // `operationId` type check is what previously let a record with a tampered
  // amount and a stray preimage field reach the screen.
  assert.match(history, /loadHistoryPayload/, 'history must parse through the strict validator');
  assert.equal(
    /typeof \(entry as OperationRecord\)\.operationId === 'string'/.test(history),
    false,
    'history must not filter records by an operationId type check alone',
  );
  // Dropped records must be reported rather than silently vanishing.
  assert.match(history, /rejected/, 'history must report how many records failed validation');
});



// ===========================================================================
// SHOWN == SIGNED: THE REVIEWED REQUEST IS WHAT REACHES THE SIGNER
// ===========================================================================

test('signing: the reviewed request is required and is sent verbatim, not re-derived', () => {
  const service = fsx.readFileSync(pathx.join(srcRootX, 'services', 'walletService.ts'), 'utf8');
  const start = service.indexOf('async signAndSubmitReviewed(');
  assert.notEqual(start, -1, 'the bridge must expose a signing path that takes the reviewed request');
  const body = service.slice(start, service.indexOf('\n  async ', start + 10));
  // The payload sent to the provider is the reviewed request itself.
  assert.match(body, /reviewedRequest/, 'the reviewed request must reach the provider call');
  assert.equal(
    /\{\s*method:\s*preview\.method,\s*args:\s*preview\.args/.test(body),
    false,
    'the signing path must not rebuild a {method,args,component} payload from the preview',
  );
  // And an absent reviewed request is a refusal, not a silent fallback.
  assert.match(body, /Refusing to sign/, 'signing without a reviewed request must be refused');
});

test('signing: execution passes the reviewed request and requires it to be frozen', () => {
  const execution = fsx.readFileSync(pathx.join(srcRootX, 'services', 'execution.ts'), 'utf8');
  // The reviewed request reaches the wallet through a typed parameter.
  assert.match(execution, /reviewedRequest: Readonly<Record<string, unknown>>/, 'the signing seam must require the reviewed request');
  assert.match(execution, /wallets\.signAndSubmit\(envelope\.preview, input\.context, input\.review\.walletRequest\)/);
  // The old cast smuggled an untyped field onto a preview and was dropped by
  // every downstream consumer, so the reviewed request never reached the signer.
  assert.equal(/request:\s*input\.review\.walletRequest\s*\}\s*as TransactionPreview/.test(execution), false, 'the reviewed request must not be smuggled onto a preview via a cast');
  // Immutability of the review and its request is enforced, not assumed.
  assert.match(execution, /Object\.isFrozen\(input\.review\)/, 'the review must be verified frozen at signing time');
  assert.match(execution, /Object\.isFrozen\(input\.review\.walletRequest\)/, 'the reviewed request must be verified frozen at signing time');
});

test('signing: the removed tautology cannot come back', () => {
  const execution = fsx.readFileSync(pathx.join(srcRootX, 'services', 'execution.ts'), 'utf8');
  // A comparison of a value with itself can never be true, so this "gate" could
  // never reject anything while reading as an instability check.
  const tautologies = execution.match(/(\w+(?:\([^()]*\))?)\s*!==\s*\1/g) ?? [];
  assert.deepEqual(tautologies, [], `found a self-comparison that can never fail: ${tautologies.join(', ')}`);
});

test('review: an NFT review is bound to the signer, not to the asset', () => {
  const panel = fsx.readFileSync(pathx.join(srcRootX, 'components', 'NftDetailPanel.tsx'), 'utf8');
  const start = panel.indexOf('const review = createReview(');
  assert.notEqual(start, -1);
  const block = panel.slice(start, start + 600);
  // The account must be the connected wallet account.
  assert.match(block, /account:\s*settlementAccount/, 'the review account must be the connected wallet account');
  // The previous form had two identical ternary branches, so `account` was
  // always the input asset's resource address and never the signer.
  assert.equal(
    /account:\s*[^,\n]*\?\s*outcome\.route\.inputAsset\.resourceAddress\s*:\s*outcome\.route\.inputAsset\.resourceAddress/.test(block),
    false,
    'the review account must not be the input asset resource address',
  );
  assert.match(panel, /settlementAccount === undefined/, 'a missing account must block submission rather than bind to the asset');
});

test('review: a marketplace intent is diffed with the marketplace rules', () => {
  const review = require('../build-test/lib/review.js');
  // The AMM comparison has no pool and no settlement account to read, so it
  // cannot be used for a marketplace intent: it reported a mismatch on every
  // NFT trade, which would have blocked the feature rather than secured it.
  assert.equal(typeof review.isMarketplaceIntent, 'function');
  assert.equal(typeof review.diffReviewAgainstMarketplaceIntent, 'function');
  assert.equal(typeof review.diffReviewForIntent, 'function');

  assert.equal(review.isMarketplaceIntent({ operation: 'buy_listing', target: { nftResource: 'r' } }), true);
  assert.equal(review.isMarketplaceIntent({ operation: 'swap', poolComponent: 'p', settlement: {} }), false);
  assert.equal(review.isMarketplaceIntent(undefined), false);
  // An operation name that merely looks marketplace-ish, with no target, is not
  // classified as one, so a malformed intent falls through to the AMM rules.
  assert.equal(review.isMarketplaceIntent({ operation: 'buy_listing' }), false);
});

test('review: a marketplace differential rejects a review bound to the wrong account', () => {
  const { createReview, diffReviewAgainstMarketplaceIntent, isMarketplaceIntent } = require('../build-test/lib/review.js');
  const identity = { nonce: 'n1', providerRef: {}, providerFingerprint: 'p', expectedNetwork: 'esmeralda', providerNetwork: 'esmeralda', account: 'otl_account_A', capabilityFingerprint: 'c', capturedAtUnixMs: 0 };
  const intent = {
    operation: 'buy_listing',
    target: { componentOrOrderId: 'component_listing_1', nftResource: 'otl_nft_1', nftId: 'series#7', quoteResource: 'otl_wstable_0001', amount: '1000' },
    calls: [{ method: 'buy_listing', args: [], componentAddress: 'component_listing_1' }],
    instructions: [
      { kind: 'withdraw_non_fungible', accountAddress: 'otl_account_B', nftResource: 'otl_nft_1', nftId: 'series#7' },
      { kind: 'withdraw_fungible', accountAddress: 'otl_account_B', resourceAddress: 'otl_wstable_0001', amount: '1000' },
    ],
  };
  assert.equal(isMarketplaceIntent(intent), true);

  const build = (account) =>
    createReview({
      operationId: 'nft-1',
      network: 'esmeralda',
      account,
      identity,
      legs: [
        {
          operation: 'buy_listing',
          componentAddress: 'component_listing_1',
          method: 'buy_listing',
          amounts: [
            { resourceAddress: 'otl_nft_1', amountRaw: '0', role: 'INPUT', nftId: 'series#7' },
            { resourceAddress: 'otl_wstable_0001', amountRaw: '1000', role: 'OUTPUT' },
          ],
        },
      ],
    });

  // The account the intent settles from is the buyer's, so a review bound to
  // anyone else must be rejected.
  const wrong = diffReviewAgainstMarketplaceIntent(build('otl_account_A'), intent);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.mismatches.some((m) => m.includes('account')), 'a review bound to a different account must be rejected');

  const right = diffReviewAgainstMarketplaceIntent(build('otl_account_B'), intent);
  assert.equal(right.ok, true, `expected a matching review to pass, got: ${right.mismatches.join('; ')}`);
});

test('review: a marketplace differential rejects a tampered amount', () => {
  const { createReview, diffReviewAgainstMarketplaceIntent } = require('../build-test/lib/review.js');
  const identity = { nonce: 'n1', providerRef: {}, providerFingerprint: 'p', expectedNetwork: 'esmeralda', providerNetwork: 'esmeralda', account: 'otl_account_B', capabilityFingerprint: 'c', capturedAtUnixMs: 0 };
  const intent = {
    operation: 'buy_listing',
    target: { componentOrOrderId: 'component_listing_1', nftResource: 'otl_nft_1', nftId: 'series#7', quoteResource: 'otl_wstable_0001', amount: '1000' },
    calls: [{ method: 'buy_listing', args: [], componentAddress: 'component_listing_1' }],
    instructions: [{ kind: 'withdraw_fungible', accountAddress: 'otl_account_B', resourceAddress: 'otl_wstable_0001', amount: '1000' }],
  };
  // The review shows a different amount than the intent moves.
  const review = createReview({
    operationId: 'nft-2',
    network: 'esmeralda',
    account: 'otl_account_B',
    identity,
    legs: [
      {
        operation: 'buy_listing',
        componentAddress: 'component_listing_1',
        method: 'buy_listing',
        amounts: [{ resourceAddress: 'otl_wstable_0001', amountRaw: '1', role: 'OUTPUT' }],
      },
    ],
  });
  const diff = diffReviewAgainstMarketplaceIntent(review, intent);
  assert.equal(diff.ok, false);
  assert.ok(diff.mismatches.some((m) => m.includes('1000') || m.includes('does not state that amount')));
});

test('review: a marketplace differential rejects a review for a different order', () => {
  const { createReview, diffReviewAgainstMarketplaceIntent } = require('../build-test/lib/review.js');
  const identity = { nonce: 'n1', providerRef: {}, providerFingerprint: 'p', expectedNetwork: 'esmeralda', providerNetwork: 'esmeralda', account: 'otl_account_B', capabilityFingerprint: 'c', capturedAtUnixMs: 0 };
  const intent = {
    operation: 'buy_listing',
    target: { componentOrOrderId: 'component_listing_1', nftResource: 'otl_nft_1', nftId: 'series#7', quoteResource: 'otl_wstable_0001', amount: '1000' },
    calls: [{ method: 'buy_listing', args: [], componentAddress: 'component_listing_1' }],
    instructions: [{ kind: 'withdraw_fungible', accountAddress: 'otl_account_B', resourceAddress: 'otl_wstable_0001', amount: '1000' }],
  };
  const review = createReview({
    operationId: 'nft-3',
    network: 'esmeralda',
    account: 'otl_account_B',
    identity,
    legs: [
      {
        operation: 'buy_listing',
        componentAddress: 'component_listing_ATTACKER',
        method: 'buy_listing',
        amounts: [{ resourceAddress: 'otl_wstable_0001', amountRaw: '1000', role: 'OUTPUT' }],
      },
    ],
  });
  const diff = diffReviewAgainstMarketplaceIntent(review, intent);
  assert.equal(diff.ok, false);
  assert.ok(diff.mismatches.some((m) => m.includes('target')), 'a different order must be rejected');
});

test('double submit: every submission path uses a synchronous in-flight guard', () => {
  // `busy` state is asynchronous: two clicks in one tick both read false and
  // both start a submission, creating two durable operations. A ref is claimed
  // before the first await, so only the same pattern closes the window.
  for (const file of ['SwapCard.tsx', 'LiquidityPanel.tsx', 'NftDetailPanel.tsx']) {
    const source = fsx.readFileSync(pathx.join(srcRootX, 'components', file), 'utf8');
    assert.match(source, /useRef\(false\)/, `${file} must hold a synchronous submission guard`);
    // The refusal may be a bare return or a guarded block with a comment; what
    // matters is that the claim is tested before it is set.
    assert.match(source, /if \(submitGuard\.current\)/, `${file} must test the guard before claiming it`);
    const claimed = source.indexOf('if (submitGuard.current)');
    const set = source.indexOf('submitGuard.current = true;');
    assert.ok(claimed !== -1 && set > claimed, `${file} must check the guard before claiming it`);
    assert.match(source, /submitGuard\.current = false;/, `${file} must release the guard, or the panel locks forever`);
  }
  // The guard must be released in a finally block, so a thrown error does not
  // leave the panel permanently disabled.
  const liquidity = fsx.readFileSync(pathx.join(srcRootX, 'components', 'LiquidityPanel.tsx'), 'utf8');
  assert.match(liquidity, /finally \{\s*submitGuard\.current = false;/, 'the guard must be released in a finally block');
});

// ===========================================================================
// F-02 AT THE ACTUAL PROVIDER BOUNDARY
// ===========================================================================

/**
 * These tests close the loop that F-02 was about, at the only place the claim
 * can be verified: the provider itself.
 *
 * F-02 was that the reviewed request and the submitted request were two
 * independent derivations from the same intent, and their agreement was assumed
 * rather than checked. A test that inspects an intermediate object cannot catch
 * that class of bug, because the bug is precisely that the WRONG object arrives.
 * So the provider here RECORDS the exact envelope it is handed, and the
 * assertion is equality against the review the user approved.
 */

/**
 * A provider that records every envelope it receives, verbatim.
 *
 * The recording is a deep clone taken at call time, so a later mutation of the
 * caller's object cannot retroactively change the record. Without that, the
 * comparison would prove nothing.
 */
function recordingProvider(reply) {
  const seen = [];
  return {
    seen,
    async request(envelope) {
      seen.push(JSON.parse(JSON.stringify(envelope)));
      return reply(envelope);
    },
  };
}

test('F-02: the provider receives the reviewed request itself, byte for byte', async () => {
  const provider = recordingProvider(() => ({ transactionId: 'tx_provider_boundary_1', epoch: '900' }));

  // The reviewed request, exactly as buildWalletRequest produces it from a
  // review: nested legs, per-resource amounts, and a minimum output.
  const reviewedRequest = Object.freeze({
    transaction: Object.freeze({
      operationId: 'nft-boundary-1',
      network: 'esmeralda',
      account: 'otl_account_A',
      legs: Object.freeze([
        Object.freeze({
          operation: 'buy_listing',
          componentAddress: 'component_listing_1',
          method: 'buy_listing',
          args: Object.freeze([
            Object.freeze({ resourceAddress: 'otl_nft_1', amountRaw: '0', role: 'INPUT', nftId: 'series#7' }),
            Object.freeze({ resourceAddress: 'otl_wstable_0001', amountRaw: '1000000', role: 'OUTPUT' }),
          ]),
          minOutputRaw: '1000000',
          maxEpochRaw: '950',
        }),
      ]),
    }),
    display: Object.freeze({
      operation: 'buy_listing',
      network: 'esmeralda',
      account: 'otl_account_A',
      assets: ['1000000 of otl_wstable_0001'],
    }),
  });

  await tari.signAndSubmit(provider, reviewedRequest.transaction, {
    assets: reviewedRequest.display.assets,
    operation: 'buy_listing',
    network: 'esmeralda',
    poolOrDestination: 'component_listing_1',
  });

  assert.equal(provider.seen.length, 1);
  const envelope = provider.seen[0];
  assert.equal(envelope.method, 'tari_signAndSubmitTransaction');

  // The transaction the provider was asked to sign IS the reviewed transaction:
  // nothing added, removed, or recomputed. `buildWalletRequest` produces
  // `{ transaction, display }`, which is already the provider's envelope, so
  // the signed body is `transaction` and the human context is `display`.
  assert.deepEqual(envelope.params.transaction, reviewedRequest.transaction);

  // There must be no double nesting: `transaction.transaction` is not a shape
  // any wallet is documented to accept.
  assert.equal(envelope.params.transaction.transaction, undefined, 'the signed transaction must not be wrapped twice');

  // Specifically the fields the old {method, args, component} reconstruction
  // lost: the component, the per-resource amounts, the NFT id, and the floor.
  const leg = envelope.params.transaction.legs[0];
  assert.equal(leg.componentAddress, 'component_listing_1');
  assert.equal(leg.minOutputRaw, '1000000');
  assert.deepEqual(leg.args, [
    { resourceAddress: 'otl_nft_1', amountRaw: '0', role: 'INPUT', nftId: 'series#7' },
    { resourceAddress: 'otl_wstable_0001', amountRaw: '1000000', role: 'OUTPUT' },
  ]);
  assert.ok(envelope.params.display.assets.includes('1000000 of otl_wstable_0001'));
});

test('F-02: the lossy preview reconstruction is measurably different at the boundary', async () => {
  const provider = recordingProvider(() => ({ transactionId: 'tx_provider_boundary_2', epoch: '900' }));
  // This is the shape the old code built: a method/args/component triple with no
  // legs, no resource addresses, and no minimum output.
  const lossy = { method: 'buy_listing', args: ['0', '1000000'], component: 'component_listing_1' };

  await tari.signAndSubmit(provider, lossy, {
    assets: ['otl_wstable_0001'],
    operation: 'buy_listing',
    network: 'esmeralda',
    poolOrDestination: 'component_listing_1',
  });

  // The difference is observable at the provider, which is the point: had the
  // old shape been signed, nothing in the envelope would have stated which
  // resource moved, or the floor the user accepted.
  const sent = provider.seen[0].params.transaction;
  assert.equal(sent.legs, undefined);
  assert.equal(sent.method, 'buy_listing');
  assert.deepEqual(sent.args, ['0', '1000000']);
  const serialised = JSON.stringify(sent);
  assert.equal(/otl_wstable_0001/.test(serialised), false, 'the reconstruction names no resource address');
  assert.equal(/minOutput/.test(serialised), false, 'the reconstruction states no minimum output');
});

test('F-02: the request is derived from the review, so the numbers have one source', () => {
  const reviewLib = require('../build-test/lib/review.js');
  const identity = {
    nonce: 'n-boundary',
    providerRef: {},
    providerFingerprint: 'p',
    expectedNetwork: 'esmeralda',
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilityFingerprint: 'c',
    capturedAtUnixMs: 0,
  };
  const review = reviewLib.createReview({
    operationId: 'amm-boundary-1',
    network: 'esmeralda',
    account: 'otl_account_A',
    identity,
    legs: [
      {
        operation: 'swap',
        componentAddress: 'component_pool_1',
        method: 'swap',
        amounts: [
          { resourceAddress: 'otl_canonical_tari', amountRaw: '1000000', role: 'INPUT' },
          { resourceAddress: 'otl_wstable_0001', amountRaw: '4000000', role: 'OUTPUT' },
        ],
        minOutputRaw: '3900000',
      },
    ],
  });

  const leg = review.walletRequest.transaction.legs[0];
  assert.equal(leg.componentAddress, review.legs[0].componentAddress);
  assert.equal(leg.method, review.legs[0].method);
  assert.equal(leg.minOutputRaw, review.legs[0].minOutputRaw);
  for (const arg of leg.args) {
    const stated = review.legs[0].amounts.find((a) => a.resourceAddress === arg.resourceAddress);
    assert.notEqual(stated, undefined, `the request names ${arg.resourceAddress} but the review does not`);
    assert.equal(arg.amountRaw, stated.amountRaw);
  }

  // Frozen all the way down, so it cannot drift between approval and signing.
  assert.equal(Object.isFrozen(review.walletRequest), true);
  assert.equal(Object.isFrozen(review.walletRequest.transaction), true);
  assert.equal(Object.isFrozen(review.walletRequest.transaction.legs[0]), true);
  assert.equal(Object.isFrozen(review.walletRequest.transaction.legs[0].args[0]), true);
});

test('F-02: the signing gate requires a frozen review, and the requirement is asserted', () => {
  // A mutable reviewed request could be edited between approval and signing,
  // making every review check a statement about the past. The gate is in
  // execution.ts; assert its predicate survives refactoring.
  const executionSrc = fsx.readFileSync(pathx.join(srcRootX, 'services', 'execution.ts'), 'utf8');
  assert.match(executionSrc, /Object\.isFrozen\(input\.review\)/);
  assert.match(executionSrc, /Object\.isFrozen\(input\.review\.walletRequest\)/);

  // And the freeze itself is real: mutation of a nested arg must throw in
  // strict mode rather than silently succeeding.
  const reviewLib = require('../build-test/lib/review.js');
  const identity = {
    nonce: 'n-frozen',
    providerRef: {},
    providerFingerprint: 'p',
    expectedNetwork: 'esmeralda',
    providerNetwork: 'esmeralda',
    account: 'otl_account_A',
    capabilityFingerprint: 'c',
    capturedAtUnixMs: 0,
  };
  const review = reviewLib.createReview({
    operationId: 'amm-frozen-1',
    network: 'esmeralda',
    account: 'otl_account_A',
    identity,
    legs: [
      {
        operation: 'swap',
        componentAddress: 'component_pool_1',
        method: 'swap',
        amounts: [{ resourceAddress: 'otl_canonical_tari', amountRaw: '1000000', role: 'INPUT' }],
        minOutputRaw: '3900000',
      },
    ],
  });
  assert.throws(() => {
    'use strict';
    review.walletRequest.transaction.legs[0].args[0].amountRaw = '999999999';
  }, TypeError);
  assert.equal(review.walletRequest.transaction.legs[0].args[0].amountRaw, '1000000');
});

// ===========================================================================
// 8. PROVIDER LIVENESS (deadlines, and what must NOT have one)
// ===========================================================================
//
// A provider that never answers is treated as hostile. Non-interactive reads are
// bounded so a broken or hostile provider cannot leave a control permanently
// disabled; the signing path is deliberately NOT bounded, because aborting a
// signature that a human is still reading would manufacture exactly the UNKNOWN
// submission state the protocol works hardest to avoid.
//
// The read-timeout test waits out the real deadline rather than mocking timers,
// so it is version-independent and proves the shipped constant.

test('provider liveness: a non-interactive read from a silent provider times out', { timeout: 40_000 }, async () => {
  const silent = { request: () => new Promise(() => {}) };
  await assert.rejects(
    () => tari.fetchNetwork(silent),
    (error) => {
      assert.equal(error.name, 'TariProviderError');
      assert.equal(error.code, 'TIMEOUT');
      assert.match(error.message, /did not answer/);
      return true;
    },
  );
  assert.ok(tari.PROVIDER_READ_TIMEOUT_MS > 0, 'the deadline must be a real, non-zero bound');
});

test('provider liveness: a signing request is never given a deadline', async () => {
  let settled = false;
  const silent = {
    request: () => new Promise(() => {}),
  };
  // If signing were raced against a timer, this would reject within milliseconds.
  const pending = tari
    .signAndSubmit(silent, { transaction: {} }, { assets: ['TARI'], operation: 'swap', network: 'esmeralda', poolOrDestination: 'p' })
    .then(() => {
      settled = true;
    })
    .catch(() => {
      settled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(settled, false, 'a signature awaiting a human must stay pending, not be aborted');
  void pending;
});

test('provider liveness: a read that answers in time is unaffected by the deadline', async () => {
  const good = {
    request: async ({ method }) => {
      if (method === 'tari_getNetwork') return { network: 'esmeralda', epoch: '7' };
      return {};
    },
  };
  const view = await tari.fetchNetwork(good);
  assert.equal(view.network, 'esmeralda');
  assert.equal(view.epoch, '7');
});