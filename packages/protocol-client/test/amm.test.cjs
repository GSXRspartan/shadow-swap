const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveSwap,
  resolveAddLiquidity,
  resolveRemoveLiquidity,
  quoteSwapOutput,
  deriveMinOutput,
  validateSlippage,
  classifyResourceForRouting,
  applyRoutingPolicy,
} = require('../dist/amm.js');
const { classifyResource } = require('../dist/index.js');
const { createOotleReadbackProvider } = require('../dist/ootle.js');

const FRESHNESS = { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } };

function poolState(overrides = {}) {
  return {
    poolComponent: 'pool_comp_1',
    resourceA: 'resource_aaaa',
    resourceB: 'resource_bbbb',
    reserveA: '1000000000',
    reserveB: '1000000000',
    feeBps: '30',
    lpResource: 'lp_eeee',
    totalLpSupply: '1000000000',
    lockedLpSupply: '1000',
    ...overrides,
  };
}

function readbackOf(state) {
  return { readPool: async () => ({ status: 'FOUND', value: state, freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) };
}

function builderCapture() {
  const calls = [];
  return { calls, swap: (intent) => { calls.push(intent); return { intent }; } };
}

const SLIP = { slippageBps: '50' };

// ---------------------------------------------------------------------------
// Happy path + exact quote math
// ---------------------------------------------------------------------------

test('resolver quotes exactly and derives min_output on-chain-bounded', async () => {
  const b = builderCapture();
  const result = await resolveSwap(
    { poolComponent: 'pool_comp', inputResource: 'resource_aaaa', outputResource: 'resource_bbbb', rawInputAmount: '100000000', slippage: { slippageBps: '100' }, maxEpoch: '200' },
    { readback: { readPool: async () => ({ status: 'FOUND', value: poolState(), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) }, builder: b },
  );
  assert.equal(result.status, 'ACTIVE');
  // Independent reference: eff = 1e8*9970/10000 = 99_700_000; out = 1e9*eff/(1e9+eff) = 90661089
  assert.equal(result.resolved.quote.quotedOutput, '90661089');
  // min_output = floor(90661089 * 9900 / 10000) = 89754477
  assert.equal(result.resolved.quote.minOutput, '89754478');
  assert.equal(BigInt(result.resolved.quote.minOutput) <= BigInt(result.resolved.quote.quotedOutput), true);
  assert.equal(result.resolved.quote.effectiveInput, '99700000');
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].minOutput, '89754478');
  assert.equal(b.calls[0].maxEpoch, '200');
});

test('quote matches the independent floor formula across randomized inputs (property)', () => {
  // Deterministic LCG, mirroring the rust pool_ref_model seeds
  let state = 0x5eed1234n;
  const next = () => { state ^= state << 13n; state &= 0xffffffffffffffffn; state ^= state >> 7n; state ^= state << 17n; state &= 0xffffffffffffffffn; return state; };
  for (let i = 0; i < 5000; i++) {
    const rIn = (next() % (1n << 90n)) + 1n;
    const rOut = (next() % (1n << 90n)) + 1n;
    const input = (next() % (1n << 90n)) + 1n;
    const fee = (next() % 1000n) + 1n;
    try {
      const { output, effectiveInput } = quoteSwapOutput(rIn.toString(), rOut.toString(), input.toString(), fee.toString());
      const eff = (input * (10000n - fee)) / 10000n;
      const expect = (rOut * eff) / (rIn + eff);
      assert.equal(BigInt(output), expect);
      assert.equal(BigInt(effectiveInput), (input * (10000n - fee)) / 10000n);
      assert.equal(BigInt(output) < rOut, true);
      assert.equal(BigInt(output) > 0n, true);
    } catch (e) {
      // only the documented abort classes may throw
      assert.match(e.message, /too small|reserve is empty/);
    }
  }
});

// ---------------------------------------------------------------------------
// RR-05 client attack cases
// ---------------------------------------------------------------------------

test('stale reserve snapshot is rejected explicitly (STALE)', async () => {
  const result = await resolveSwap(
    { poolComponent: 'pool_comp', inputResource: 'resource_aaaa', outputResource: 'resource_bbbb', rawInputAmount: '1000', slippage: { slippageBps: '100' }, maxEpoch: '200', expectedReserves: { a: '900000000', b: '1000000000' } },
    { readback: { readPool: async () => ({ status: 'FOUND', value: poolState(), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) }, builder: builderCapture() },
  );
  assert.equal(result.status, 'STALE');
});

test('wrong pool component is UNAVAILABLE, never constructed', async () => {
  const result = await resolveSwap(
    { poolComponent: 'evil_pool', inputResource: 'resource_aaaa', outputResource: 'resource_bbbb', rawInputAmount: '1000', slippage: { slippageBps: '100' }, maxEpoch: '200' },
    { readback: { readPool: async () => ({ status: 'UNAVAILABLE', reason: 'Component evil_pool does not exist' }) }, builder: builderCapture() },
  );
  assert.equal(result.status, 'UNAVAILABLE');
});

test('wrong input / output resource and A/B reversal are CONFLICTED', async () => {
  const deps = { readback: { readPool: async () => ({ status: 'FOUND', value: poolState(), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) }, builder: builderCapture() };
  const mk = (inputResource, outputResource) => ({ poolComponent: 'pool_comp', inputResource, outputResource, rawInputAmount: '1000', slippage: { slippageBps: '100' }, maxEpoch: '200' });
  assert.equal((await resolveSwap(mk('resource_cccc', 'resource_bbbb'), { readback: deps.readback, builder: builderCapture() })).status, 'CONFLICTED');
  assert.equal((await resolveSwap(mk('resource_aaaa', 'resource_cccc'), { readback: deps.readback, builder: builderCapture() })).status, 'CONFLICTED');
  // A/A same-resource
  assert.equal((await resolveSwap(mk('resource_aaaa', 'resource_aaaa'), { readback: deps.readback, builder: builderCapture() })).status, 'CONFLICTED');
  // Reversal: B→A is valid only when requested as the pool's actual pair; a reversed
  // request against the wrong leg identity is refused
  const reversed = await resolveSwap({ ...mk('resource_bbbb', 'resource_aaaa') }, { readback: deps.readback, builder: builderCapture() });
  assert.equal(reversed.status, 'ACTIVE'); // B→A is a legitimate leg
  const fakeSymbol = await resolveSwap(mk('resource_fake_same_symbol', 'resource_aaaa'), { readback: deps.readback, builder: builderCapture() });
  assert.equal(fakeSymbol.status, 'CONFLICTED'); // identity is address, never symbol
});

test('malicious discovery data cannot influence resolution (no discovery input exists)', async () => {
  // resolveSwap takes NO discovery provider: indexer data cannot enter the quote path.
  const result = await resolveSwap(
    { poolComponent: 'pool_comp', inputResource: 'resource_aaaa', outputResource: 'resource_bbbb', rawInputAmount: '100000000', slippage: { slippageBps: '0', allowZeroMinOutput: false }, maxEpoch: '200' },
    { readback: { readPool: async () => ({ status: 'FOUND', value: poolState(), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) }, builder: builderCapture() },
  );
  assert.equal(result.status, 'ACTIVE');
  // The quote derives ONLY from authoritative reserves, fee, and input.
  assert.equal(result.resolved.quote.quotedOutput, '90661089');
});

test('zero min_output requires explicit justification; missing min_output cannot happen', async () => {
  assert.throws(() => deriveMinOutput('1000', { slippageBps: '10000' }), /unsafe/);
  assert.throws(() => validateSlippage({ slippageBps: '10001' }), /exceeds 100%/);
  assert.throws(() => deriveMinOutput('1000', { slippageBps: '5001' }), /unsafe/);
  assert.throws(() => deriveMinOutput('1000', { slippageBps: '-5' }), /non-negative integer/);
  // 100% slippage would floor to 0 → refused without explicit allowZeroMinOutput
  assert.throws(() => deriveMinOutput('3', { slippageBps: '10000', allowZeroMinOutput: false }));
  const zero = deriveMinOutput('3', { slippageBps: '3000' });
  assert.equal(BigInt(zero) <= 3n, true);
  // 30 bps fee vs slippage are separate denominators — both 10_000 but independent fields
  assert.equal(validateSlippage({ slippageBps: '50' }), 50n);
});

test('expired transaction policy: current epoch at/after max epoch is EXPIRED', async () => {
  const readback = { readPool: async () => ({ status: 'FOUND', value: poolState(), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '150', readAtUnixMs: 1 } } }) };
  const result = await resolveSwap(
    { poolComponent: 'pool_comp', inputResource: 'resource_aaaa', outputResource: 'resource_bbbb', rawInputAmount: '1000', slippage: { slippageBps: '100' }, maxEpoch: '150' },
    { readback, builder: builderCapture(), currentEpoch: '150' },
  );
  assert.equal(result.status, 'EXPIRED');
});

test('BigInt above Number.MAX_SAFE_INTEGER stays exact (no number conversion)', async () => {
  const big = '18446744073709551615'; // > 2^53
  const { output, effectiveInput } = quoteSwapOutput(big, big, big, '30');
  // exact: eff = big*9970/10000
  const effExpect = (BigInt(big) * 9970n) / 10000n;
  assert.equal(BigInt(effectiveInput), effExpect);
  const outExpect = (BigInt(big) * effExpect) / (BigInt(big) + effExpect);
  assert.equal(BigInt(output), outExpect);
  assert.equal(Number(output) > Number.MAX_SAFE_INTEGER || !Number.isFinite(Number(output)), true);
});

test('resolver refuses the bootstrap path (first deposit) for add liquidity', async () => {
  const result = await resolveAddLiquidity(
    { poolComponent: 'pool_comp', rawAmountA: '1000000', rawAmountB: '1000000', maxEpoch: '200' },
    { readback: { readPool: async () => ({ status: 'FOUND', value: poolState({ reserveA: '0', reserveB: '0', totalLpSupply: '0' }), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) }, builder: { addLiquidity: () => { throw new Error('must not be called'); }, removeLiquidity: () => { throw new Error('must not be called'); } } },
  );
  assert.equal(result.status, 'UNAVAILABLE');
  assert.match(result.reason, /bootstrap/i);
});

test('remove liquidity floors are computed exactly and dust redemptions refuse', async () => {
  const deps = { readback: { readPool: async () => ({ status: 'FOUND', value: poolState(), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) }, builder: { addLiquidity: () => ({}), removeLiquidity: () => ({}) } };
  const ok = await resolveRemoveLiquidity({ poolComponent: 'pool_comp', rawLpAmount: '999000000', maxEpoch: '200' }, deps);
  assert.equal(ok.status, 'ACTIVE');
  assert.equal(ok.resolved.expectedA, '999000000');
  const dust = await resolveRemoveLiquidity({ poolComponent: 'pool_comp', rawLpAmount: '1', maxEpoch: '200' }, deps);
  // 1 * 1e9 / 1e9 = 1 → not dust here; force real dust via tiny reserves
  const dustDeps = { ...deps, readback: { readPool: async () => ({ status: 'FOUND', value: poolState({ reserveA: '1', reserveB: '1', totalLpSupply: '1000000000000' }), freshness: { source: 'WALLET_PROVIDER', identity: { substateVersion: '7', epoch: '100', readAtUnixMs: 1 } } }) } };
  const dusted = await resolveRemoveLiquidity({ poolComponent: 'pool_comp', rawLpAmount: '1', maxEpoch: '200' }, dustDeps);
  assert.equal(dusted.status, 'UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Readback provider hardening
// ---------------------------------------------------------------------------

test('readback provider refuses non-authoritative sources', () => {
  assert.throws(() => createOotleReadbackProvider({ readComponent: async () => undefined }, 'INDEXER_SUBSTATE'), /authoritative/i);
});

test('readback provider rejects wrong template component (fake pool)', async () => {
  const provider = createOotleReadbackProvider({ readComponent: async (address) => ({ address, templateName: 'EvilPool', fields: {}, substateVersion: '1' }) }, 'WALLET_PROVIDER');
  const read = await provider.readPool('pool_comp');
  assert.equal(read.status, 'UNAVAILABLE');
  assert.match(read.reason, /template/);
});

test('readback provider surfaces missing components and missing fields fail-closed', async () => {
  const provider = createOotleReadbackProvider({ readComponent: async () => undefined }, 'WALLET_PROVIDER');
  assert.equal((await provider.readPool('nope')).status, 'UNAVAILABLE');
  const partial = createOotleReadbackProvider({ readComponent: async (address) => ({ address, templateName: 'Pool', fields: { resource_a: 'a' } }) }, 'WALLET_PROVIDER');
  const bad = await partial.readPool('pool_comp');
  assert.equal(bad.status, 'UNAVAILABLE');
  assert.match(bad.reason, /missing field/);
});

test('readback provider refuses an unrecognized status instead of normalizing it toward execution', async () => {
  // Regression (Pixel Canary fourth pass): an unrecognized status string used to
  // normalize to the most permissive value ('ACTIVE'), so a malformed, future, or
  // tampered readback presented an unknown component state as executable.
  const marketplaceEnvelope = (templateName, status) => ({
    address: 'component_1',
    templateName,
    substateVersion: '1',
    fields: {
      seller_account: 'seller_1', buyer_account: 'buyer_1', collection_resource: 'collection_1', nft_id: 'nft_1',
      quote_resource: 'quote_1', price: '10', amount: '10', price_per_nft: '10', original_quantity: '1',
      remaining_quantity: '1', original_escrow: '10', remaining_escrow: '10', created_at_epoch: '1',
      expires_at_epoch: '2', status,
    },
  });
  for (const status of ['active', 'OPEN', 'PENDING_SETTLEMENT', '', 'SOLD_PENDING']) {
    const provider = createOotleReadbackProvider(
      { readComponent: async (address) => marketplaceEnvelope('FixedPriceListing', status) },
      'WALLET_PROVIDER',
    );
    const listing = await provider.readListing('component_1');
    assert.equal(listing.status, 'UNAVAILABLE', `a listing with status ${JSON.stringify(status)} must not parse as ACTIVE`);
    assert.match(listing.reason, /unrecognized .* status/);
    const offerReader = createOotleReadbackProvider(
      { readComponent: async () => marketplaceEnvelope('ItemOffer', status) },
      'WALLET_PROVIDER',
    );
    const offer = await offerReader.readItemOffer('component_1');
    assert.equal(offer.status, 'UNAVAILABLE', `an offer with status ${JSON.stringify(status)} must not parse as ACTIVE`);
    const bidReader = createOotleReadbackProvider(
      { readComponent: async () => marketplaceEnvelope('CollectionBid', status) },
      'WALLET_PROVIDER',
    );
    const bid = await bidReader.readCollectionBid('component_1');
    assert.equal(bid.status, 'UNAVAILABLE', `a bid with status ${JSON.stringify(status)} must not parse as ACTIVE`);
  }
  // every legitimate status still parses
  for (const [templateName, reader, statuses] of [
    ['FixedPriceListing', 'readListing', ['ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED']],
    ['ItemOffer', 'readItemOffer', ['ACTIVE', 'ACCEPTED', 'CANCELLED', 'EXPIRED']],
    ['CollectionBid', 'readCollectionBid', ['ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED']],
  ]) {
    for (const status of statuses) {
      const provider = createOotleReadbackProvider(
        { readComponent: async () => marketplaceEnvelope(templateName, status) },
        'WALLET_PROVIDER',
      );
      const read = await provider[reader]('component_1');
      assert.equal(read.status, 'FOUND', `${templateName} status ${status} must parse`);
      assert.equal(read.value.status, status);
    }
  }
});

// ---------------------------------------------------------------------------
// Resource routing policy
// ---------------------------------------------------------------------------

test('routing classification refuses or gates issuer-controlled and unknown assets', () => {
  assert.equal(classifyResourceForRouting({ isCanonicalTari: true, resourceType: 'fungible' }), 'CANONICAL_TARI');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: false, resourceType: 'fungible', recallPossible: false, freezePossible: false, securityRulesMutable: false }), 'PUBLIC_IMMUTABLE_OR_VETTED');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: false, resourceType: 'fungible', recallPossible: true }), 'ISSUER_CONTROLLED');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: false, resourceType: 'fungible' }), 'UNKNOWN');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: false, resourceType: 'non_fungible' }), 'UNSUPPORTED');
  const policy = { allow: ['CANONICAL_TARI', 'PUBLIC_IMMUTABLE_OR_VETTED'], requireAcknowledgement: ['UNKNOWN'], refuse: ['ISSUER_CONTROLLED', 'UNSUPPORTED'] };
  assert.equal(applyRoutingPolicy('CANONICAL_TARI', policy).verdict, 'ALLOW');
  assert.equal(applyRoutingPolicy('ISSUER_CONTROLLED', policy).verdict, 'REFUSE');
  assert.equal(applyRoutingPolicy('UNKNOWN', policy).verdict, 'REQUIRE_ACKNOWLEDGEMENT');
});

// Real Esmeralda wallet-asset shapes, characterized LIVE DRY-RUN on 2026-10-06 against
// the published Pool v1 (template_ef2bc1...). Each shape is sanitized to the on-chain
// facts that drive classification (type + canonical-ness + advisory safety), with NO
// wallet balances. The expected verdict is the one the live dry-run matrix produced, so
// the classifier can never silently drift from the contract's real resource policy.
//
//   Pool::new dry-run results: LPTESTA x LPTESTB/PTEST/tTARI -> ACCEPT;
//   LPTESTA x STEST (stealth) -> REJECT (template); LPTESTA x TNFTA (nft) -> REJECT.
test('classification matches the live Esmeralda wallet inventory (incl. created-stealth)', () => {
  // tTARI: canonical native (Stealth-typed, but canonical identity wins).
  assert.equal(classifyResource({ address: 'resource_0101', isCanonicalTari: true, kind: 'stealth' }), 'canonical_tari');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: true, resourceType: 'stealth' }), 'CANONICAL_TARI');

  // STEST: a CREATED-STEALTH fungible (non-canonical Stealth). Pool-ineligible, and
  // revealing it does not help — the resource TYPE is what the template rejects.
  assert.equal(classifyResource({ address: 'resource_e0158c30', isCanonicalTari: false, kind: 'stealth' }), 'unsupported_resource_type');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: false, resourceType: 'stealth' }), 'UNSUPPORTED');

  // PTEST / LPTESTA: ordinary public fungibles with recall/freeze/mutability known-false.
  const publicFungible = { address: 'resource_87385b51', isCanonicalTari: false, kind: 'fungible', recallPossible: false, freezePossible: false, securityRulesMutable: false };
  assert.equal(classifyResource(publicFungible), 'eligible_public_fungible');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: false, resourceType: 'fungible', recallPossible: false, freezePossible: false, securityRulesMutable: false }), 'PUBLIC_IMMUTABLE_OR_VETTED');

  // TNFTA/TNFTB: NFT collection resources — pool-ineligible.
  assert.equal(classifyResource({ address: 'resource_51e2234a', isCanonicalTari: false, kind: 'non_fungible' }), 'unsupported_resource_type');
  assert.equal(classifyResourceForRouting({ isCanonicalTari: false, resourceType: 'non_fungible' }), 'UNSUPPORTED');
});


