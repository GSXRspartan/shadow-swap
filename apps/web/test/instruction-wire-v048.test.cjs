require('./bootstrap.cjs');
/**
 * Browser instruction JSON == the JSON the REAL v0.48 engine executed.
 *
 * `ootle-v048-instructions.json` is written by audit_engine_tests/tests/instruction_wire_v048.rs,
 * which builds every browser operation with the upstream Rust builder, serialises it with
 * upstream serde, deserialises it again and EXECUTES the deserialised list (balances are
 * asserted there). Here the same parameters go through this app's own builders
 * (@tari-ootle/wallet-adapter) and serializer (lib/instructions.ts), and the output must be
 * the identical JSON. If both hold, what the browser hands a wallet is a transaction the
 * engine runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ootle-v048-instructions.json');
const w = require('@tari-ootle/wallet-adapter');
const { buildSignableInstructions } = require('../build-test/lib/instructions.js');
const { encodeLiteral, LiteralEncodingError } = require('../build-test/lib/instructionArgs.js');
const review = require('../build-test/lib/review.js');

const scenario = (name) => {
  const s = fixture.scenarios.find((x) => x.name === name);
  assert.ok(s, `fixture scenario ${name}`);
  return s;
};
const wire = (intent) => buildSignableInstructions({ instructions: intent.instructions ?? intent, maxEpoch: '10' });
const evidence = { quotedOutput: '1', feeBps: '30', slippageBps: '50', effectiveInput: '1' };

test('fixture: produced by the pinned v0.48.0 engine', () => {
  assert.match(fixture.cohort, /v0\.48\.0 \(6a25dbc5/);
  assert.ok(fixture.literals.length >= 30);
  assert.ok(fixture.scenarios.length >= 16);
});

test('literals: every engine-produced CBOR encoding is reproduced byte for byte', () => {
  for (const { type, value, hex } of fixture.literals) {
    assert.equal(encodeLiteral(type, value), hex, `${type} ${JSON.stringify(value)}`);
  }
});

test('literals: out-of-range and malformed values are refused, never truncated or guessed', () => {
  const bad = [
    ['Amount', '-1'], ['Amount', '1.5'], ['Amount', '01'], ['Amount', (1n << 128n).toString()],
    ['u16', '65536'], ['u64', (1n << 64n).toString()], ['bool', 'true'],
    ['ResourceAddress', 'component_' + '0'.repeat(64)], ['ResourceAddress', 'resource_abc'],
    ['ComponentAddress', 'resource_' + '0'.repeat(64)], ['Hash32', 'ab'], ['PublicKey', 'XY'.repeat(32)],
    ['Bytes', 'abc'], ['NonFungibleId', 'art-1'], ['NonFungibleId', 'str_'], ['NonFungibleId', 'u32_4294967296'],
    ['NonFungibleId', 'uuid_00'], ['NonFungibleId', 'u64:5'], ['NonFungibleId', 'str_' + 'x'.repeat(65)],
    ['Amount', null], ['Bucket', 'x'],
  ];
  for (const [type, value] of bad) assert.throws(() => encodeLiteral(type, value), LiteralEncodingError, `${type} ${value}`);
});

test('probe: bare-hex CallFunction address, integer workspace keys, Address call reference', () => {
  assert.equal(fixture.probe[0].CallFunction.address.length, 64);
  assert.deepEqual(fixture.probe[1], { PutLastInstructionOutputOnWorkspace: { key: 0 } });
});

test('wire == engine: create_pool (Pool::new by template hash, add_liquidity on the workspace component)', () => {
  const { params, instructions } = scenario('create_pool');
  const intent = w.buildCreatePoolIntent({ ...params, maxEpoch: '10', operationId: 'op' });
  assert.deepEqual(wire(intent), instructions);
});

test('wire == engine: add_liquidity', () => {
  const { params, instructions } = scenario('add_liquidity');
  assert.deepEqual(wire(w.buildAddLiquidityIntent({ ...params, maxEpoch: '10', operationId: 'op' })), instructions);
});

test('wire == engine: swap', () => {
  const { params, instructions } = scenario('swap');
  assert.deepEqual(wire(w.buildSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence })), instructions);
});

test('wire == engine: multi_hop_swap (intermediate min 1, route min on the last hop)', () => {
  const { params, instructions } = scenario('multi_hop_swap');
  const intent = w.buildMultiHopSwapIntent({
    accountAddress: params.accountAddress,
    rawInputAmount: params.rawInputAmount,
    minOutput: params.minOutput,
    hops: params.hops.map((h) => ({ ...h, quotedOutput: '1000000', feeBps: '30' })),
    maxEpoch: '10',
    operationId: 'op',
    slippageBps: '50',
  });
  assert.deepEqual(wire(intent), instructions);
});

test('wire == engine: mixed_multi_hop_swap crosses a revealed pool and a public pool in ONE transaction', () => {
  // The decisive property: naming the venues changes the OPERATION and the DISCLOSURE but
  // not a single instruction. The engine executed this exact list across both templates, so
  // a mixed route is a real atomic transaction rather than two submissions dressed as one.
  const { params, instructions } = scenario('mixed_multi_hop_swap');
  const hops = params.hops.map((h) => ({ ...h, quotedOutput: '1000000', feeBps: '30' }));
  const intent = w.buildMultiHopSwapIntent({
    accountAddress: params.accountAddress,
    rawInputAmount: params.rawInputAmount,
    minOutput: params.minOutput,
    hops,
    maxEpoch: '10',
    operationId: 'op',
    slippageBps: '50',
  });
  assert.deepEqual(wire(intent), instructions);
  assert.equal(intent.operation, 'mixed_multi_hop_swap');
  assert.deepEqual(
    intent.route.map((h) => h.venue),
    ['REVEALED', 'PUBLIC'],
    'each hop carries the venue it actually traded at, as evidence',
  );
  // The same hops with the venues stripped produce the SAME wire and the public name: proof
  // that the venue is metadata the browser must supply, never something the wire reveals.
  const unnamed = w.buildMultiHopSwapIntent({
    accountAddress: params.accountAddress,
    rawInputAmount: params.rawInputAmount,
    minOutput: params.minOutput,
    hops: hops.map(({ venue: _venue, ...rest }) => rest),
    maxEpoch: '10',
    operationId: 'op',
    slippageBps: '50',
  });
  assert.deepEqual(wire(unnamed), instructions);
  assert.equal(unnamed.operation, 'multi_hop_swap');
});

test('mixed route naming: a partially classified route is refused, and the disclosure follows the venues', () => {
  assert.equal(w.multiHopOperationFor([undefined, undefined]), 'multi_hop_swap');
  assert.equal(w.multiHopOperationFor(['PUBLIC', 'PUBLIC']), 'multi_hop_swap');
  assert.equal(w.multiHopOperationFor(['REVEALED', 'REVEALED']), 'revealed_multi_hop_swap');
  assert.equal(w.multiHopOperationFor(['REVEALED', 'PUBLIC']), 'mixed_multi_hop_swap');
  assert.equal(w.multiHopOperationFor(['PUBLIC', 'REVEALED']), 'mixed_multi_hop_swap');
  // A route that can only name SOME of its venues cannot be disclosed, so it is refused
  // rather than described by its less revealing half.
  assert.throws(() => w.multiHopOperationFor(['REVEALED', undefined]), /every hop must name its venue/);
  assert.throws(() => w.multiHopOperationFor([undefined, 'PUBLIC']), /every hop must name its venue/);

  // Each disclosure must state that the amounts are revealed, and none may claim privacy.
  for (const op of ['mixed_multi_hop_swap', 'revealed_multi_hop_swap']) {
    const text = w.multiHopDisclosureFor(op);
    assert.match(text, /revealed/i);
    assert.doesNotMatch(text, /confidential|private|hidden/i);
  }
  assert.match(w.multiHopDisclosureFor('mixed_multi_hop_swap'), /transparent/i);
  assert.match(w.multiHopDisclosureFor('multi_hop_swap'), /PUBLIC AMM BOUNDARY/);
});

test('wire == engine: remove_liquidity (both tuple elements deposited)', () => {
  const { params, instructions } = scenario('remove_liquidity');
  assert.deepEqual(wire(w.buildRemoveLiquidityIntent({ ...params, maxEpoch: '10', operationId: 'op' })), instructions);
});

test('wire == engine: marketplace create_listing withdraws the NFT with withdraw_non_fungible', () => {
  const { params, instructions } = scenario('create_listing');
  const intent = w.createListing({ ...params, expiryEpoch: Number(params.expiryEpoch) });
  assert.deepEqual(wire(intent), instructions);
  assert.equal(instructions[0].CallMethod.method, 'withdraw_non_fungible');
});

test('wire == engine: marketplace buy_listing', () => {
  const { params, instructions } = scenario('buy_listing');
  const intent = w.buyListing(params.listingAddress, params.buyerAccount, params.quoteResource, params.amount, { quantity: '1', expiryEpoch: 0 });
  assert.deepEqual(wire(intent), instructions);
});

test('wire: no instruction kind outside upstream Instruction is ever emitted (no WithMaxEpoch)', () => {
  const allowed = new Set(['CallMethod', 'CallFunction', 'PutLastInstructionOutputOnWorkspace']);
  for (const s of fixture.scenarios) for (const i of s.instructions) assert.ok(allowed.has(Object.keys(i)[0]), `${s.name}: ${Object.keys(i)[0]}`);
  const { params } = scenario('swap');
  const out = wire(w.buildSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence }));
  for (const i of out) assert.ok(allowed.has(Object.keys(i)[0]), Object.keys(i)[0]);
});

test('wire: a call whose argument types are not declared is refused, not guessed', () => {
  const { params } = scenario('swap');
  const intent = w.buildSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence });
  const stripped = intent.instructions.map((i) => (i.kind === 'call_method' ? { ...i, argTypes: undefined } : i));
  assert.throws(() => wire(stripped), /declared type/);
  const mistyped = intent.instructions.map((i) => (i.kind === 'call_method' ? { ...i, argTypes: ['Bucket', 'Amount', 'Amount'] } : i));
  assert.throws(() => wire(mistyped), LiteralEncodingError);
});

// ---------------------------------------------------------------------------
// RevealedAssetPool: AMM liquidity for revealed-value private-typed assets. The engine
// scenarios below executed with a created-Stealth resource on one side, which Pool v2 refuses.
// ---------------------------------------------------------------------------

test('wire == engine: create_revealed_pool (new -> workspace -> add_liquidity -> deposit all three)', () => {
  const { params, instructions } = scenario('create_revealed_pool');
  const intent = w.buildCreateRevealedPoolIntent({ ...params, maxEpoch: '10', operationId: 'op' });
  assert.deepEqual(wire(intent), instructions);
  // The LP and BOTH refunds are deposited: leaving any on the workspace fails the transaction.
  assert.equal(instructions.filter((i) => i.CallMethod?.method === 'deposit').length, 3);
});

test('wire == engine: revealed_swap', () => {
  const { params, instructions } = scenario('revealed_swap');
  assert.deepEqual(wire(w.buildRevealedSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence })), instructions);
});

test('wire == engine: revealed_add_liquidity (three outputs deposited)', () => {
  const { params, instructions } = scenario('revealed_add_liquidity');
  assert.deepEqual(wire(w.buildRevealedAddLiquidityIntent({ ...params, maxEpoch: '10', operationId: 'op' })), instructions);
});

test('wire == engine: revealed_remove_liquidity (on-chain exit minimums)', () => {
  const { params, instructions } = scenario('revealed_remove_liquidity');
  const intent = w.buildRevealedRemoveLiquidityIntent({ ...params, maxEpoch: '10', operationId: 'op' });
  assert.deepEqual(wire(intent), instructions);
  // min_a and min_b are real call arguments, not UI-side checks.
  const call = instructions.find((i) => i.CallMethod?.method === 'remove_liquidity');
  assert.equal(call.CallMethod.args.length, 3);
});

test('revealed pool: the first-deposit share policy is previewed before anything is signed', () => {
  const { params } = scenario('create_revealed_pool');
  const preview = w.revealedInitialLiquidityPreview(params.rawAmountA, params.rawAmountB);
  assert.equal(BigInt(preview.lockedShares), w.REVEALED_POOL_LOCKED_LIQUIDITY);
  assert.equal(BigInt(preview.totalShares) - BigInt(preview.lockedShares), BigInt(preview.creatorShares));
  assert.ok(BigInt(preview.totalShares) >= w.REVEALED_POOL_MIN_FIRST_SHARES);
  // A dust first deposit is refused with the template's own policy, in the browser, before a
  // wallet is asked to sign a transaction the engine would reject (engine: r08).
  assert.throws(() => w.revealedInitialLiquidityPreview('1000', '1000'), /at least 100000/);
  assert.throws(() => w.buildCreateRevealedPoolIntent({ ...params, rawAmountA: '1000', rawAmountB: '1000', maxEpoch: '10', operationId: 'op' }), /at least 100000/);
});

test('revealed pool: a review names the revealed-pool operation, never the public AMM one', () => {
  const { params } = scenario('revealed_swap');
  const intent = w.buildRevealedSwapIntent({ ...params, maxEpoch: '10', operationId: 'op', quoteEvidence: evidence });
  const identity = require('../build-test/lib/executionIdentity.js').captureIdentity({ provider: {}, expectedNetwork: 'esmeralda', providerNetwork: 'esmeralda', account: params.accountAddress, capabilities: { transactionRequests: true }, nonce: 'n1' });
  const r = review.reviewFromAmmIntent({ intent, operationId: 'op', network: 'esmeralda', identity, maxEpochRaw: '10' });
  assert.equal(r.legs[0].operation, 'REVEALED_POOL_SWAP');
  const diff = review.diffReviewForIntent(r, intent);
  assert.equal(diff.ok, true, diff.mismatches.join('; '));
});

// ---------------------------------------------------------------------------------------------
// Cross-layer HTLC: the L2 leg of an exchange against existing L1 XTM.
//
// An advertised wallet capability is not evidence that a transaction executes. These compare the
// browser's instruction JSON byte for byte against instructions the real v0.48 engine ran.
// ---------------------------------------------------------------------------------------------

test('wire == engine: cross_layer_fund (withdraw -> fund, NO deposit — the escrow is a component)', () => {
  const { params, instructions } = scenario('cross_layer_fund');
  const intent = w.buildCrossLayerFundIntent({
    templateAddress: params.templateAddress,
    accountAddress: params.accountAddress,
    resourceAddress: params.resourceAddress,
    rawAmount: params.rawAmount,
    hashLockHex: params.hashLockHex,
    claimantPublicKeyHex: params.claimantPublicKeyHex,
    expiresAtEpoch: String(params.expiresAtEpoch),
    counterpartyLeg: params.counterpartyLeg,
    maxEpoch: '10',
    operationId: 'op',
  });
  assert.deepEqual(wire(intent), instructions);
  // `fund` returns a Component, so there is nothing to deposit. A deposit_all here would be a
  // bug that the engine would reject for spending a bucket that does not exist.
  assert.deepEqual(intent.settlement.outputBuckets, []);
  assert.equal(intent.instructions.filter((i) => i.kind === 'deposit_all').length, 0);
  // Every binding the protocol rests on is an explicit argument, so a review card can show it.
  assert.deepEqual(intent.terms, {
    resourceAddress: params.resourceAddress,
    rawAmount: params.rawAmount,
    hashLockHex: params.hashLockHex.toLowerCase(),
    claimantPublicKeyHex: params.claimantPublicKeyHex.toLowerCase(),
    expiresAtEpoch: String(params.expiresAtEpoch),
    counterpartyLeg: params.counterpartyLeg,
  });
});

test('wire == engine: cross_layer_claim (claim -> deposit, the preimage as a Vec<u8>)', () => {
  const { params, instructions } = scenario('cross_layer_claim');
  const intent = w.buildCrossLayerClaimIntent({
    htlcComponent: params.htlcComponent,
    accountAddress: params.accountAddress,
    preimageHex: params.preimageHex,
    maxEpoch: '10',
    operationId: 'op',
  });
  assert.deepEqual(wire(intent), instructions);
  // The returned bucket MUST be deposited or the engine rejects a dangling output.
  assert.deepEqual(intent.settlement.outputBuckets, ['cross_layer_claim']);
});

test('wire == engine: cross_layer_refund (refund -> deposit, no arguments)', () => {
  const { params, instructions } = scenario('cross_layer_refund');
  const intent = w.buildCrossLayerRefundIntent({
    htlcComponent: params.htlcComponent,
    accountAddress: params.accountAddress,
    maxEpoch: '10',
    operationId: 'op',
  });
  assert.deepEqual(wire(intent), instructions);
  assert.deepEqual(intent.settlement.outputBuckets, ['cross_layer_refund']);
  // `refund()` takes nothing: authority is the signer's key, timing is consensus'.
  assert.deepEqual(w.CROSS_LAYER_REFUND_ARG_TYPES, []);
});

test('cross-layer builders refuse terms that cannot settle, before a wallet is asked', () => {
  const good = {
    templateAddress: 'ab'.repeat(32),
    accountAddress: 'component_' + 'cd'.repeat(32),
    resourceAddress: 'resource_' + 'ef'.repeat(32),
    rawAmount: '1000',
    hashLockHex: '11'.repeat(32),
    claimantPublicKeyHex: '22'.repeat(32),
    expiresAtEpoch: '50',
    counterpartyLeg: 'ab'.repeat(32),
    maxEpoch: '100',
    operationId: 'op',
  };
  assert.ok(w.buildCrossLayerFundIntent(good));

  // An empty escrow could never be claimed.
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, rawAmount: '0' }), /must be positive/);
  // The hash and claimant are 32-byte values; a wrong length means a wrong binding.
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, hashLockHex: '11'.repeat(31) }), /64 hex characters/);
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, claimantPublicKeyHex: 'zz'.repeat(32) }), /64 hex characters/);
  // An escrow already past its deadline could be refunded before it could ever be claimed.
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, expiresAtEpoch: '50', readEpoch: '50' }), /already expired/);
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, expiresAtEpoch: '40', readEpoch: '45' }), /not after the epoch/);
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, expiresAtEpoch: '0' }), /positive absolute L2 epoch/);
  // Without a counterparty leg recorded, a preimage from one trade could be replayed on another.
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, counterpartyLeg: '' }), /required/);
  assert.throws(() => w.buildCrossLayerFundIntent({ ...good, counterpartyLeg: 'z'.repeat(129) }), /at most 128 characters/);

  const claim = { htlcComponent: 'component_' + 'aa'.repeat(32), accountAddress: good.accountAddress, maxEpoch: '100', operationId: 'op' };
  assert.throws(() => w.buildCrossLayerClaimIntent({ ...claim, preimageHex: '' }), /even-length hex/);
  assert.throws(() => w.buildCrossLayerClaimIntent({ ...claim, preimageHex: 'abc' }), /even-length hex/);
  assert.throws(() => w.buildCrossLayerClaimIntent({ ...claim, preimageHex: 'aa'.repeat(65) }), /at most 64 bytes/);
});

test('a cross-layer escrow is never presented as a same-chain swap', () => {
  // The disclosure has to say that this funds ONE side, that settlement spans four transactions,
  // and that a refund is only available AFTER the deadline — none of which is true of an AMM swap.
  assert.match(w.CROSS_LAYER_DISCLOSURE, /NOT A SWAP IN ONE TRANSACTION/);
  assert.match(w.CROSS_LAYER_DISCLOSURE, /four transactions across two chains/);
  assert.match(w.CROSS_LAYER_DISCLOSURE, /only AFTER its deadline/);
  // And its operations are distinct from every AMM operation, so history and review cannot
  // conflate them.
  for (const op of ['cross_layer_fund', 'cross_layer_claim', 'cross_layer_refund']) {
    const intent = op === 'cross_layer_fund'
      ? w.buildCrossLayerFundIntent({ templateAddress: 'ab'.repeat(32), accountAddress: 'component_' + 'cd'.repeat(32), resourceAddress: 'resource_' + 'ef'.repeat(32), rawAmount: '1', hashLockHex: '11'.repeat(32), claimantPublicKeyHex: '22'.repeat(32), expiresAtEpoch: '9', counterpartyLeg: 'x', maxEpoch: '10', operationId: 'o' })
      : op === 'cross_layer_claim'
        ? w.buildCrossLayerClaimIntent({ htlcComponent: 'component_' + 'aa'.repeat(32), accountAddress: 'component_' + 'cd'.repeat(32), preimageHex: 'aabb', maxEpoch: '10', operationId: 'o' })
        : w.buildCrossLayerRefundIntent({ htlcComponent: 'component_' + 'aa'.repeat(32), accountAddress: 'component_' + 'cd'.repeat(32), maxEpoch: '10', operationId: 'o' });
    assert.equal(intent.kind, 'cross_layer_htlc');
    assert.equal(intent.operation, op);
    assert.equal(intent.privacyDisclosure, w.CROSS_LAYER_DISCLOSURE);
  }
});
