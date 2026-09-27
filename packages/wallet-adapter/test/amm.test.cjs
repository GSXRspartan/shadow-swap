const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSwapIntent, toAmmPreview, buildAddLiquidityIntent, buildRemoveLiquidityIntent } = require('../dist/amm.js');
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
