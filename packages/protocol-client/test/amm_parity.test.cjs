const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSwap, resolveAddLiquidity, resolveRemoveLiquidity, quoteSwapOutput, MAX_FEE_BPS } = require('../dist/amm.js');
const { parsePoolState } = require('../dist/ootle.js');

/**
 * AMM impossible-state and client/chain parity regressions.
 *
 * Every case here is a pool state the on-chain `fungible_pool` template cannot
 * produce, or an operation the chain can only abort. The resolver's contract is
 * that such input yields a typed, explained outcome — never a quote, never a
 * builder intent, and never an unhandled throw out of the async function.
 *
 * What counts as impossible is derived from `templates/fungible_pool/src/lib.rs`
 * (fee tier range, `check_pool_resources` asserting distinct resources, non-empty
 * reserves, non-zero LP supply), NOT from the TypeScript implementation.
 */

const HEALTHY_POOL = {
  poolComponent: 'pool_comp_1',
  resourceA: 'resource_aaaa',
  resourceB: 'resource_bbbb',
  reserveA: '1000000000',
  reserveB: '4000000000',
  feeBps: '30',
  lpResource: 'lp_eeee',
  totalLpSupply: '2000000000',
  lockedLpSupply: '1000',
};

const FRESHNESS = { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } };

function readbackFor(overrides = {}) {
  const pool = { ...HEALTHY_POOL, ...overrides };
  return {
    async readPool() {
      return { status: 'FOUND', value: pool, freshness: FRESHNESS };
    },
  };
}

const BUILDER = {
  swap: (intent) => ({ ...intent, kind: 'swap' }),
  addLiquidity: (intent) => ({ ...intent, kind: 'add_liquidity' }),
  removeLiquidity: (intent) => ({ ...intent, kind: 'remove_liquidity' }),
};

const SWAP = {
  poolComponent: HEALTHY_POOL.poolComponent,
  inputResource: HEALTHY_POOL.resourceA,
  outputResource: HEALTHY_POOL.resourceB,
  rawInputAmount: '1000000',
  slippage: { slippageBps: '50' },
  maxEpoch: '1000',
};

const ADD = { poolComponent: HEALTHY_POOL.poolComponent, rawAmountA: '1000000', rawAmountB: '1000000', maxEpoch: '1000' };
const REMOVE = { poolComponent: HEALTHY_POOL.poolComponent, rawLpAmount: '1000000', maxEpoch: '1000' };

// ---------------------------------------------------------------------------
// 1. Fee tier parity with the chain
// ---------------------------------------------------------------------------

test('amm: the client refuses fee tiers the chain can never have created', async () => {
  for (const feeBps of ['0', '1001', '9999', '10000']) {
    const result = await resolveSwap({ ...SWAP }, { readback: readbackFor({ feeBps }), builder: BUILDER });
    assert.equal(result.status, 'UNAVAILABLE', `fee ${feeBps} must not be quoted`);
    assert.match(result.reason, /fee tier/i);
  }
});

test('amm: the highest fee tier the chain permits is still quotable', async () => {
  const result = await resolveSwap({ ...SWAP }, { readback: readbackFor({ feeBps: '1000' }), builder: BUILDER });
  assert.equal(result.status, 'ACTIVE');
  // A 10% fee must actually cost ~10%: the effective input is 90% of the raw input.
  assert.equal(result.resolved.quote.effectiveInput, '900000');
});

test('amm: fee parity is enforced by the quote helper itself', () => {
  // The chain refuses to create a pool outside 1..=MAX_FEE_BPS, so the quote helper
  // must refuse the same range at its own boundary — never price impossible state.
  assert.throws(() => quoteSwapOutput('1000', '1000', '100', '0'), /fee tier/);
  assert.throws(() => quoteSwapOutput('1000', '1000', '100', '1001'), /fee tier/i);
  assert.throws(() => quoteSwapOutput('1000', '1000', '100', '9999'), /fee tier/i);
  assert.equal(MAX_FEE_BPS, 1000n);
});

// ---------------------------------------------------------------------------
// 2. Same-resource (A/A) refusal
// ---------------------------------------------------------------------------

test('amm: a swap of a resource into itself is refused before anything is built', async () => {
  const result = await resolveSwap({ ...SWAP, outputResource: SWAP.inputResource }, { readback: readbackFor(), builder: BUILDER });
  assert.equal(result.status, 'CONFLICTED');
  assert.match(result.reason, /into itself/);
  assert.equal(result.resolved, undefined, 'no builder intent may exist for a refused swap');
});

test('amm: a pool whose two legs are the same resource is refused', async () => {
  const result = await resolveSwap(
    { ...SWAP, inputResource: 'resource_same', outputResource: 'resource_same' },
    { readback: readbackFor({ resourceA: 'resource_same', resourceB: 'resource_same' }), builder: BUILDER },
  );
  assert.equal(result.status, 'CONFLICTED');
});

// ---------------------------------------------------------------------------
// 3. Impossible reserve / supply states fail closed with a typed outcome
// ---------------------------------------------------------------------------

test('amm: a half-initialised pool is refused instead of dividing by zero', async () => {
  for (const reserves of [{ reserveA: '0' }, { reserveB: '0' }]) {
    const result = await resolveAddLiquidity(ADD, { readback: readbackFor(reserves), builder: BUILDER });
    assert.equal(result.status, 'UNAVAILABLE', `${JSON.stringify(reserves)} must be refused`);
    assert.match(result.reason, /empty reserve/);
  }
});

test('amm: reserves with zero LP supply are refused as impossible', async () => {
  const result = await resolveAddLiquidity(ADD, { readback: readbackFor({ totalLpSupply: '0' }), builder: BUILDER });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.match(result.reason, /LP supply of zero/);
});

test('amm: burning more LP than exists is refused rather than quoted', async () => {
  const result = await resolveRemoveLiquidity({ ...REMOVE, rawLpAmount: '2000000001' }, { readback: readbackFor(), builder: BUILDER });
  assert.equal(result.status, 'UNAVAILABLE');
  assert.match(result.reason, /total supply/);
});

test('amm: burning the entire supply is still allowed and returns both sides', async () => {
  const result = await resolveRemoveLiquidity({ ...REMOVE, rawLpAmount: '2000000000' }, { readback: readbackFor(), builder: BUILDER });
  assert.equal(result.status, 'ACTIVE');
  assert.equal(result.resolved.expectedA, '1000000000');
  assert.equal(result.resolved.expectedB, '4000000000');
});

// ---------------------------------------------------------------------------
// 4. Malformed authoritative numbers never reach BigInt
// ---------------------------------------------------------------------------

function envelope(overrides = {}) {
  // The transport stringifies template fields, so the envelope carries the
  // chain's own field names -- not the normalised PoolState shape.
  return {
    address: 'pool_comp_1',
    templateName: 'Pool',
    source: 'WALLET_PROVIDER',
    fields: {
      resource_a: HEALTHY_POOL.resourceA,
      resource_b: HEALTHY_POOL.resourceB,
      reserve_a: HEALTHY_POOL.reserveA,
      reserve_b: HEALTHY_POOL.reserveB,
      fee_bps: HEALTHY_POOL.feeBps,
      lp_resource: HEALTHY_POOL.lpResource,
      total_lp_supply: HEALTHY_POOL.totalLpSupply,
      locked_lp_supply: HEALTHY_POOL.lockedLpSupply,
      ...overrides,
    },
  };
}

test('amm: a malformed reserve string is rejected at the readback boundary', () => {
  assert.throws(() => parsePoolState(envelope({ reserve_a: 'not-a-number' })), /malformed reserve_a/);
});

test('amm: a negative or fractional supply is rejected at the readback boundary', () => {
  for (const bad of ['-1', '1.5', '0x10', '1e3', ' 1']) {
    assert.throws(() => parsePoolState(envelope({ total_lp_supply: bad })), /malformed total_lp_supply/, `"${bad}" must be rejected`);
  }
});

test('amm: a hostile readback that returns garbage numbers yields UNAVAILABLE, not a throw', async () => {
  const result = await resolveAddLiquidity(ADD, {
    readback: {
      async readPool() {
        return { status: 'FOUND', value: { ...HEALTHY_POOL, reserveA: 'oops' }, freshness: FRESHNESS };
      },
    },
    builder: BUILDER,
  });
  assert.equal(result.status, 'UNAVAILABLE');
});
