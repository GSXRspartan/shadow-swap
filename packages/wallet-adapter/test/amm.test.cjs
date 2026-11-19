const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSwapIntent, toAmmPreview, buildAddLiquidityIntent, buildAddLiquidityExactIntent, buildRemoveLiquidityIntent } = require('../dist/amm.js');
const { ammSwapIntentBuilder, ammLiquidityIntentBuilder } = require('../dist/amm_wiring.js');
const { marketplaceRouteBuilder, toWiredMarketplacePreview } = require('../dist/marketplace_wiring.js');

const QUOTE = {
  poolComponent: 'pool_comp',
  inputResource: 'res_a',
  outputResource: 'res_b',
  rawInputAmount: '100000000',
  feeBps: '30',
  quotedOutput: '90661089',
  minOutput: '89754478',
  slippageBps: '100',
  effectiveInput: '99700000',
  readEpoch: '100',
};

test('swap intent binds exact input, on-chain min_output, and max epoch expiry', () => {
  const intent = buildSwapIntent({
    poolComponent: 'pool_comp',
    accountAddress: 'acct_1',
    inputResource: 'res_a',
    outputResource: 'res_b',
    rawInputAmount: '100000000',
    minOutput: '89754478',
    maxEpoch: '200',
    operationId: 'op_1',
    quoteEvidence: { quotedOutput: '90661089', feeBps: '30', slippageBps: '100', effectiveInput: '99700000', readEpoch: '100' },
  });
assert.equal(intent.operation, 'swap');
  assert.deepEqual(intent.requiredReadbacks, ['pool']);
  const withdraw = intent.instructions[0];
  assert.equal(withdraw.kind, 'withdraw_fungible');
  assert.equal(withdraw.resourceAddress, 'res_a');
  assert.equal(withdraw.amount, '100000000');
  const call = intent.calls[0];
  assert.equal(call.method, 'swap');
  assert.equal(call.args[1], 'res_b');
  assert.equal(call.args[2], '89754478');
  assert.equal(intent.evidence.maxEpoch, '200');
  assert.equal(intent.evidence.quote.quotedOutput, '90661089');
});

test('swap intent rejects zero min_output (on-chain slippage protection disabled)', () => {
  assert.throws(
    () => buildSwapIntent({ poolComponent: 'p', accountAddress: 'a', inputResource: 'i', outputResource: 'o', rawInputAmount: '10', minOutput: '0', maxEpoch: '9', operationId: 'op', quoteEvidence: { quotedOutput: '5', feeBps: '30', slippageBps: '10000', effectiveInput: '9' } }),
    /minOutput must be positive/,
  );
  assert.throws(() => buildSwapIntent({ poolComponent: 'p', accountAddress: 'a', inputResource: 'i', outputResource: 'o', rawInputAmount: '-5', minOutput: '1', maxEpoch: '9', operationId: 'op', quoteEvidence: { quotedOutput: '5', feeBps: '30', slippageBps: '30', effectiveInput: '4' } }), /raw non-negative integer/);
});

test('resolver-to-builder wiring preserves quote evidence and identity end to end', async () => {
  // Direct construction of the wiring shape used by the flow (resolver output → builder).
  const builder = ammSwapIntentBuilder('acct_1', () => 'op_wire_1');
  const intent = builder.swap({ quote: QUOTE, minOutput: QUOTE.minOutput, maxEpoch: '200' });
  assert.equal(intent.evidence.quote.quotedOutput, '90661089');
  assert.equal(intent.evidence.quote.effectiveInput, '99700000');
  assert.equal(intent.evidence.maxEpoch, '200');
  assert.equal(intent.poolComponent, 'pool_comp');
  // No floats anywhere: amounts are strings
  assert.equal(typeof intent.instructions[0].amount, 'string');
});

test('liquidity builders enforce exact resource identity and positivity', () => {
  assert.throws(() => buildAddLiquidityIntent({ poolComponent: 'p', accountAddress: 'a', resourceA: 'r', resourceB: 'r', rawAmountA: '1', rawAmountB: '1', maxEpoch: '9', operationId: 'op' }), /distinct/);
  assert.throws(() => buildAddLiquidityIntent({ poolComponent: 'p', accountAddress: 'a', resourceA: 'r1', resourceB: 'r2', rawAmountA: '0', rawAmountB: '1', maxEpoch: '9', operationId: 'op' }), /positive/);
  const add = buildAddLiquidityIntent({ poolComponent: 'p', accountAddress: 'a', resourceA: 'r1', resourceB: 'r2', rawAmountA: '10', rawAmountB: '20', maxEpoch: '9', operationId: 'op' });
  assert.equal(add.instructions.filter((i) => i.kind === 'withdraw_fungible').length, 2);
  const remove = buildRemoveLiquidityIntent({ poolComponent: 'p', accountAddress: 'a', lpResource: 'lp_r', rawLpAmount: '500', maxEpoch: '9', operationId: 'op' });
  assert.equal(remove.calls[0].method, 'remove_liquidity');
  assert.equal(remove.instructions[0].resourceAddress, 'lp_r');
});

test('liquidity wiring produces both withdrawals with exact amounts (BigInt boundary)', () => {
  const b = ammLiquidityIntentBuilder('acct_1', () => 'op_liq');
  const add = b.addLiquidity({ poolComponent: 'p', resourceA: 'r1', resourceB: 'r2', rawAmountA: '18446744073709551615', rawAmountB: '18446744073709551615', maxEpoch: '9' });
  assert.equal(add.instructions[0].amount, '18446744073709551615');
  assert.equal(BigInt(add.instructions[0].amount) > Number.MAX_SAFE_INTEGER, true);
  const remove = b.removeLiquidity({ poolComponent: 'p', lpResource: 'lp', rawLpAmount: '18446744073709551615', maxEpoch: '9' });
  assert.equal(remove.instructions[0].amount, '18446744073709551615');
});

test('audit EIGHT-PASS P1-H1: a funded-pool deposit builds add_liquidity_exact with an on-chain min_lp_out and three deposited outputs', () => {
  const intent = buildAddLiquidityExactIntent({
    poolComponent: 'p', accountAddress: 'a', resourceA: 'r1', resourceB: 'r2',
    rawAmountA: '10000000', rawAmountB: '30000000', minLpOut: '5000000', maxEpoch: '9', operationId: 'op_exact',
  });
  assert.equal(intent.operation, 'add_liquidity', 'review classification stays AMM_ADD_LIQUIDITY');
  const call = intent.calls[0];
  assert.equal(call.method, 'add_liquidity_exact');
  assert.deepEqual(call.argTypes, ['Bucket', 'Bucket', 'Amount']);
  assert.equal(call.args[2], '5000000', 'the quote hint is the on-chain minimum');
  // (lp, refund_a, refund_b) — all three tuple elements deposited, nothing left on the workspace.
  const deposits = intent.instructions.filter((i) => i.kind === 'deposit_all');
  assert.deepEqual(deposits.map((d) => d.bucket.offset), [0, 1, 2]);
  assert.equal(deposits.every((d) => d.accountAddress === 'a'), true);
  assert.equal(intent.evidence.quote.minOutput, '5000000');
  // Refusals: the guard must be positive (a '0' minimum would disable the protection).
  assert.throws(() => buildAddLiquidityExactIntent({ poolComponent: 'p', accountAddress: 'a', resourceA: 'r1', resourceB: 'r2', rawAmountA: '1', rawAmountB: '1', minLpOut: '0', maxEpoch: '9', operationId: 'op' }), /positive/);
  assert.throws(() => buildAddLiquidityExactIntent({ poolComponent: 'p', accountAddress: 'a', resourceA: 'r1', resourceB: 'r2', rawAmountA: '1', rawAmountB: '1', minLpOut: '-2', maxEpoch: '9', operationId: 'op' }), /non-negative integer/);
});

test('audit EIGHT-PASS P1-H1: the wiring picks add_liquidity_exact only when a minimum is supplied', () => {
  const b = ammLiquidityIntentBuilder('acct_1', () => 'op_liq_exact');
  const exact = b.addLiquidity({ poolComponent: 'p', resourceA: 'r1', resourceB: 'r2', rawAmountA: '10', rawAmountB: '10', maxEpoch: '9', minLpOut: '7' });
  assert.equal(exact.calls[0].method, 'add_liquidity_exact');
  assert.equal(exact.calls[0].args[2], '7');
  const legacy = b.addLiquidity({ poolComponent: 'p', resourceA: 'r1', resourceB: 'r2', rawAmountA: '10', rawAmountB: '10', maxEpoch: '9' });
  assert.equal(legacy.calls[0].method, 'add_liquidity');
  assert.equal(legacy.calls[0].args.length, 2);
});

test('marketplace wiring constructs from authoritative readback objects only', () => {
  const { marketplaceRouteBuilder } = require('../dist/marketplace_wiring.js');
  const wired = marketplaceRouteBuilder();
  const listing = { listingAddress: 'l1', sellerAccount: 's', collectionResource: 'c', nftId: 'n1', quoteResource: 'q', price: '40', expiresAtEpoch: '18446744073709551615', status: 'ACTIVE' };
  const intent = wired.buyListing(listing, 'buyer_1');
  assert.equal(intent.operation, 'buy_listing');
  assert.equal(intent.calls[0].componentAddress, 'l1');
  // amount passes through as the exact decimal string from the authoritative readback
  assert.equal(intent.target.amount, '40');
  // expiry above Number.MAX_SAFE_INTEGER must not corrupt the target (shim clamps to 0)
  assert.equal(intent.target.expiryEpoch, 0);
  // preview stays a numeric shim; on-chain amounts in the intent remain strings
  const preview = toWiredMarketplacePreview(intent);
  assert.equal(typeof preview.maxEpoch, 'number');
});
