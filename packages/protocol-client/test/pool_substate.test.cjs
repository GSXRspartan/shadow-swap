const test = require('node:test');
const assert = require('node:assert/strict');

const { decodePoolState, decodePoolComponent, vaultAmount, resourceTotalSupply, PoolDecodeError } = require('../dist/poolSubstate.js');
const { createOotleReadbackProvider } = require('../dist/ootle.js');

// REAL Pool v2 substates, captured from the live Esmeralda chain (indexer substate
// API) on 2026-10-06 for component_8c20c644... . These are the exact bytes the wallet's
// tari_getSubstate returns for the same substates. The decoded values must equal the
// numbers independently verified live via the executor (reserves 595664/604684,
// LP supply 600000, locked 1000, fee 30) — so this is LIVE CHAIN READ VERIFIED.
const POOL = 'component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2';
const TTARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
const LPTESTA = 'resource_87385b51c57f8682ec2de4a0e590b17a56c7465c904552e80cabaeb467e70dfc';
const LP = 'resource_8c69acbc731c626fdd37557653ab1133b548fee654e14bbbfc747f1bcf7a3281';
const VAULT_TTARI = 'vault_8c53108d6dc567b2adfeac1db840056504b18f89b2e4005663f3dbfb5ee6da49';
const VAULT_LPTESTA = 'vault_8cf3e5b742f49a2e773af904bfdf3f40aa4c26eb93e5e9887303424a662c0c10';
const VAULT_LOCKED = 'vault_8cd9f81d4c365cd3b87dece223f15ae773a52f38a88199767ab326a99c8b9460';

function tagRes(hex) { return { '@cbor': 'tag', tag: 131, value: { '@cbor': 'bytes', hex } }; }
function tagVault(hex) { return { '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex } }; }

const COMPONENT_SUBSTATE = {
  Component: {
    header: { template_address: 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab', owner_rule: 'None' },
    body: {
      state: [
        { '@cbor': 'map', entries: [
          [tagRes('0101010101010101010101010101010101010101010101010101010101010101'), tagVault('8c53108d6dc567b2adfeac1db840056504b18f89b2e4005663f3dbfb5ee6da49')],
          [tagRes('87385b51c57f8682ec2de4a0e590b17a56c7465c904552e80cabaeb467e70dfc'), tagVault('8cf3e5b742f49a2e773af904bfdf3f40aa4c26eb93e5e9887303424a662c0c10')],
        ] },
        tagRes('8c69acbc731c626fdd37557653ab1133b548fee654e14bbbfc747f1bcf7a3281'),
        30,
        tagVault('8cd9f81d4c365cd3b87dece223f15ae773a52f38a88199767ab326a99c8b9460'),
      ],
    },
  },
};
const SUBSTATES = {
  [POOL]: COMPONENT_SUBSTATE,
  [VAULT_TTARI]: { Vault: { resource_container: { Stealth: { address: TTARI, revealed_amount: '595664', locked_amount: '0' } }, freeze_flags: 0 } },
  [VAULT_LPTESTA]: { Vault: { resource_container: { Fungible: { address: LPTESTA, amount: '604684', locked_amount: '0' } }, freeze_flags: 0 } },
  [LP]: { Resource: { resource_type: 'Fungible', owner_rule: 'None', total_supply: '600000' } },
  [VAULT_LOCKED]: { Vault: { resource_container: { Fungible: { address: LP, amount: '1000', locked_amount: '0' } }, freeze_flags: 0 } },
};

function reader(store) {
  return { async read(addr) { return store[addr]; } };
}

/** A raw-capable reader over an arbitrary store (the production read shape). */
function rawReader(store) {
  return {
    async readComponent() { return undefined; },
    async readRaw(addr) { return store[addr]; },
  };
}

/** Deep-ish clone so a hostile-fixture edit cannot leak into the shared fixture. */
function withStore(overrides) {
  return { ...SUBSTATES, ...overrides };
}

test('decodePoolComponent reads the pair, lp resource, fee and vault ids from the body (no get_a/b_resource)', () => {
  const shape = decodePoolComponent(COMPONENT_SUBSTATE);
  assert.equal(shape.resourceA, TTARI);
  assert.equal(shape.resourceB, LPTESTA);
  assert.equal(shape.reserveVaultA, VAULT_TTARI);
  assert.equal(shape.reserveVaultB, VAULT_LPTESTA);
  assert.equal(shape.lpResource, LP);
  assert.equal(shape.feeBps, '30');
  assert.equal(shape.lockedVault, VAULT_LOCKED);
});

test('vaultAmount decodes Stealth (revealed_amount) and Fungible (amount) containers', () => {
  assert.equal(vaultAmount(SUBSTATES[VAULT_TTARI]), '595664');
  assert.equal(vaultAmount(SUBSTATES[VAULT_LPTESTA]), '604684');
  assert.equal(resourceTotalSupply(SUBSTATES[LP]), '600000');
});

test('decodePoolState assembles the exact LIVE-VERIFIED Pool v2 state from real substates', async () => {
  const state = await decodePoolState(reader(SUBSTATES), POOL);
  assert.deepEqual(state, {
    poolComponent: POOL,
    resourceA: TTARI,
    resourceB: LPTESTA,
    reserveA: '595664',
    reserveB: '604684',
    feeBps: '30',
    lpResource: LP,
    totalLpSupply: '600000',
    lockedLpSupply: '1000',
  });
});

test('decodePoolState fails closed on a missing component or malformed body', async () => {
  await assert.rejects(decodePoolState(reader({}), POOL), PoolDecodeError);
  await assert.rejects(decodePoolState(reader({ [POOL]: { Component: { body: { state: [1, 2] } } } }), POOL), PoolDecodeError);
});

test('decodePoolState fails closed when a dependent vault/resource is missing (never invents a reserve)', async () => {
  const partial = { [POOL]: COMPONENT_SUBSTATE, [VAULT_TTARI]: SUBSTATES[VAULT_TTARI] }; // vaults B/locked + LP resource absent
  await assert.rejects(decodePoolState(reader(partial), POOL), PoolDecodeError);
});

test('readback readPool uses decodePoolState via readRaw (quote-path migration) and is fail-closed', async () => {
  // The quote/readback provider must decode the REAL multi-substate pool, not the
  // obsolete flat-field parsePoolState. With a readRaw-capable reader it returns the
  // exact live state; the legacy flat-field path is only for readers without readRaw.
  const reader = { async readComponent() { return undefined; }, async readRaw(addr) { return SUBSTATES[addr]; } };
  const rb = createOotleReadbackProvider(reader, 'WALLET_PROVIDER');
  const read = await rb.readPool(POOL);
  assert.equal(read.status, 'FOUND');
  assert.equal(read.value.reserveA, '595664');
  assert.equal(read.value.reserveB, '604684');
  assert.equal(read.value.totalLpSupply, '600000');
  assert.equal(read.value.lockedLpSupply, '1000');
  assert.equal(read.value.feeBps, '30');

  // Fail-closed: a missing dependent substate yields UNAVAILABLE, never a fabricated pool.
  const partial = { async readComponent() { return undefined; }, async readRaw(addr) { return addr === POOL ? SUBSTATES[POOL] : undefined; } };
  const bad = await createOotleReadbackProvider(partial, 'WALLET_PROVIDER').readPool(POOL);
  assert.equal(bad.status, 'UNAVAILABLE');
});

test('readback readPool never downgrades a raw-capable reader to the legacy flat-field decode', async () => {
  // HARDENED: the flat-field `parsePoolState` is ONLY for readers that do not
  // implement `readRaw` (test doubles that supply a pre-decoded envelope). A reader
  // that advertises raw substates is on the production path and MUST stay fail-closed:
  // if its raw pool cannot be decoded there is no downgrade to a flattened envelope,
  // so a transport bug (or a hostile provider) can never fabricate a reserve.

  // (a) A raw-capable reader whose raw pool is undecodable but whose flattened
  // envelope looks plausible yields UNAVAILABLE — the flat fields are ignored.
  const downgradeReader = {
    async readComponent(addr) {
      if (addr !== POOL) return undefined;
      return { address: POOL, templateName: 'Pool', fields: { resource_a: TTARI, resource_b: LPTESTA, reserve_a: '11', reserve_b: '22', fee_bps: '30', lp_resource: LP, total_lp_supply: '33', locked_lp_supply: '0' } };
    },
    async readRaw() { return { substateId: POOL, fields: {} }; },
  };
  const downgraded = await createOotleReadbackProvider(downgradeReader, 'WALLET_PROVIDER').readPool(POOL);
  assert.equal(downgraded.status, 'UNAVAILABLE');

  // (b) A pre-decoded reader WITHOUT readRaw is the sole legacy path and still decodes.
  const flatReader = {
    async readComponent(addr) {
      if (addr !== POOL) return undefined;
      return { address: POOL, templateName: 'Pool', fields: { resource_a: TTARI, resource_b: LPTESTA, reserve_a: '11', reserve_b: '22', fee_bps: '30', lp_resource: LP, total_lp_supply: '33', locked_lp_supply: '0' } };
    },
  };
  const read = await createOotleReadbackProvider(flatReader, 'WALLET_PROVIDER').readPool(POOL);
  assert.equal(read.status, 'FOUND');
  assert.equal(read.value.reserveA, '11');
  assert.equal(read.value.reserveB, '22');

  // (c) Real-shape-but-broken raw with NO legacy envelope → UNAVAILABLE (fail-closed).
  const brokenReader = { async readComponent() { return undefined; }, async readRaw() { return { substateId: POOL, fields: {} }; } };
  const bad = await createOotleReadbackProvider(brokenReader, 'WALLET_PROVIDER').readPool(POOL);
  assert.equal(bad.status, 'UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Downgrade / identity matrix.
//
// Every case below is a way a raw-capable reader could be talked into yielding a
// reserve it did not actually read. All of them must be UNAVAILABLE.
// ---------------------------------------------------------------------------

test('decodePoolState refuses a reserve vault that does not hold the declared pair leg', async () => {
  // The component body claims (tTARI, LPTESTA) but reserve A's vault actually holds
  // something else. Shape checks alone cannot see this; the container address can.
  const hostile = withStore({
    [VAULT_TTARI]: { Vault: { resource_container: { Fungible: { address: LPTESTA, amount: '595664', locked_amount: '0' } }, freeze_flags: 0 } },
  });
  await assert.rejects(decodePoolState(reader(hostile), POOL), /reserveA vault holds/);

  // And the same trap through the readback provider.
  const viaProvider = await createOotleReadbackProvider(rawReader(hostile), 'WALLET_PROVIDER').readPool(POOL);
  assert.equal(viaProvider.status, 'UNAVAILABLE');
});

test('decodePoolState refuses a locked-LP vault that is not the declared LP resource', async () => {
  const hostile = withStore({
    [VAULT_LOCKED]: { Vault: { resource_container: { Fungible: { address: LPTESTA, amount: '1000', locked_amount: '0' } }, freeze_flags: 0 } },
  });
  await assert.rejects(decodePoolState(reader(hostile), POOL), /lockedLp vault holds/);
});

test('decodePoolState refuses a component that is not a Pool template when a template is pinned', async () => {
  // A different component whose body happens to have the same shape must not be
  // accepted for a read that asked for the published Pool template.
  const impostor = {
    Component: {
      ...COMPONENT_SUBSTATE.Component,
      header: { ...COMPONENT_SUBSTATE.Component.header, template_address: 'ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649' },
    },
  };
  const store = withStore({ [POOL]: impostor });
  await assert.rejects(
    decodePoolState(reader(store), POOL, { templateAddress: 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab' }),
    /is template ef2bc1b0/,
  );
  // `template_`-prefixed and bare forms are the same identity.
  const ok = await decodePoolState(reader(SUBSTATES), POOL, {
    templateAddress: 'template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab',
  });
  assert.equal(ok.reserveA, '595664');
  // A component with no template header at all is refused even WITHOUT a pin:
  // every transport that serves raw substates carries it, so its absence is a stale
  // or hand-made payload, never a pool.
  const headerless = { Component: { body: COMPONENT_SUBSTATE.Component.body } };
  await assert.rejects(decodePoolState(reader(withStore({ [POOL]: headerless })), POOL), /does not name its template/);
  await assert.throws(() => decodePoolComponent(headerless), /does not name its template/);
});

test('decodePoolState refuses a wrong pair when the caller pinned the expected pair', async () => {
  await assert.rejects(decodePoolState(reader(SUBSTATES), POOL, { resourceA: LPTESTA }), /declares resourceA=/);
  await assert.rejects(decodePoolState(reader(SUBSTATES), POOL, { lpResource: TTARI }), /declares lpResource=/);
});

test('decodePoolState refuses an incorrect substate type for every dependent read', async () => {
  // A Vault substate where the LP resource should be.
  const wrongType = withStore({ [LP]: SUBSTATES[VAULT_TTARI] });
  await assert.rejects(decodePoolState(reader(wrongType), POOL), PoolDecodeError);
  // A Resource substate where a reserve vault should be.
  const swapped = withStore({ [VAULT_TTARI]: SUBSTATES[LP] });
  await assert.rejects(decodePoolState(reader(swapped), POOL), PoolDecodeError);
});

test('decodePoolState refuses a vault whose container omits the resource address', async () => {
  // The live wire always names what a vault holds. A container without an address
  // cannot prove it holds the declared pair, so the read must fail closed rather than
  // accept a reserve it cannot attribute.
  const noAddress = { Vault: { resource_container: { Fungible: { amount: '604684' } }, freeze_flags: 0 } };
  await assert.rejects(decodePoolState(reader(withStore({ [VAULT_LPTESTA]: noAddress })), POOL), /reserveB vault carries no resource address/);
  await assert.rejects(decodePoolState(reader(withStore({ [VAULT_LOCKED]: noAddress })), POOL), /lockedLp vault carries no resource address/);
});

test('decodePoolState refuses a vault with an unrecognised container and a non-integer amount', async () => {
  // An unrecognised container kind surfaces as "cannot prove what it holds" on the
  // composite read (the address check runs first), and as the kind error on the raw helper.
  await assert.throws(() => vaultAmount({ Vault: { resource_container: { Something: { address: TTARI, amount: '1' } } } }), /unrecognised resource container/);
  await assert.rejects(decodePoolState(reader(withStore({ [VAULT_TTARI]: { Vault: { resource_container: { Something: { address: TTARI, amount: '1' } } } } })), POOL), /reserveA vault carries no resource address/);
  await assert.rejects(decodePoolState(reader(withStore({ [VAULT_LPTESTA]: { Vault: { resource_container: { Fungible: { address: LPTESTA, amount: '-5' } } } } })), POOL), /not a non-negative integer/);
  await assert.rejects(decodePoolState(reader(withStore({ [LP]: { Resource: { total_supply: '1.5' } } })), POOL), /not a non-negative integer/);
});

test('decodePoolState refuses a component whose pools map is not exactly two entries', async () => {
  const three = { Component: { header: COMPONENT_SUBSTATE.Component.header, body: { state: [
    { '@cbor': 'map', entries: [
      [tagRes('01'.repeat(32)), tagVault('11'.repeat(32))],
      [tagRes('22'.repeat(32)), tagVault('33'.repeat(32))],
      [tagRes('44'.repeat(32)), tagVault('55'.repeat(32))],
    ] },
    tagRes('66'.repeat(32)), 30, tagVault('77'.repeat(32)),
  ] } } };
  await assert.rejects(decodePoolState(reader({ [POOL]: three }), POOL), /exactly two reserve entries/);
});

test('decodePoolState fails closed when any single dependent substate is absent', async () => {
  for (const missing of [VAULT_TTARI, VAULT_LPTESTA, LP, VAULT_LOCKED]) {
    const store = { ...SUBSTATES };
    delete store[missing];
    await assert.rejects(decodePoolState(reader(store), POOL), PoolDecodeError, `missing ${missing}`);
  }
});

test('readback readPool applies the pinned identity on BOTH the raw and legacy paths', async () => {
  // Raw path: an impostor template is refused rather than decoded.
  const impostor = {
    Component: {
      ...COMPONENT_SUBSTATE.Component,
      header: { ...COMPONENT_SUBSTATE.Component.header, template_address: '00'.repeat(32) },
    },
  };
  const rawBad = await createOotleReadbackProvider(rawReader(withStore({ [POOL]: impostor })), 'WALLET_PROVIDER')
    .readPool(POOL, { templateAddress: 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab' });
  assert.equal(rawBad.status, 'UNAVAILABLE');
  assert.match(rawBad.reason, /is template/);

  // Legacy path: a well-formed flat envelope for the wrong pair is equally refused.
  const flatWrongPair = {
    async readComponent(addr) {
      if (addr !== POOL) return undefined;
      return { address: POOL, templateName: 'Pool', fields: { resource_a: TTARI, resource_b: LPTESTA, reserve_a: '1', reserve_b: '1', fee_bps: '30', lp_resource: LP, total_lp_supply: '1', locked_lp_supply: '0' } };
    },
  };
  const legacyBad = await createOotleReadbackProvider(flatWrongPair, 'WALLET_PROVIDER')
    .readPool(POOL, { lpResource: 'resource_' + 'ab'.repeat(32) });
  assert.equal(legacyBad.status, 'UNAVAILABLE');
  assert.match(legacyBad.reason, /declares lpResource=/);

  // And the matching pin still succeeds on both paths.
  const rawOk = await createOotleReadbackProvider(rawReader(SUBSTATES), 'WALLET_PROVIDER')
    .readPool(POOL, { templateAddress: 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab', resourceA: TTARI, resourceB: LPTESTA, lpResource: LP });
  assert.equal(rawOk.status, 'FOUND');
  assert.equal(rawOk.value.reserveA, '595664');

  const legacyOk = await createOotleReadbackProvider(flatWrongPair, 'WALLET_PROVIDER')
    .readPool(POOL, { resourceA: TTARI, resourceB: LPTESTA, lpResource: LP });
  assert.equal(legacyOk.status, 'FOUND');
});

test('a hostile raw reader that ALSO throws cannot reach the legacy flat-field path', async () => {
  const throwing = {
    async readComponent(addr) {
      if (addr !== POOL) return undefined;
      return { address: POOL, templateName: 'Pool', fields: { resource_a: TTARI, resource_b: LPTESTA, reserve_a: '999999', reserve_b: '999999', fee_bps: '30', lp_resource: LP, total_lp_supply: '1', locked_lp_supply: '0' } };
    },
    async readRaw() { throw new Error('provider hostile: readRaw refused'); },
  };
  const result = await createOotleReadbackProvider(throwing, 'WALLET_PROVIDER').readPool(POOL);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.match(result.reason, /hostile/);
});
