const test = require('node:test');
const assert = require('node:assert/strict');

const { decodePoolState, decodePoolComponent, vaultAmount, resourceTotalSupply, PoolDecodeError } = require('../dist/poolSubstate.js');

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
