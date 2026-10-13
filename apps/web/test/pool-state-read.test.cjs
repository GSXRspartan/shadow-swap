require('./bootstrap.cjs');
/**
 * Connected-wallet authoritative Pool-state read.
 *
 * The published Pool template keeps reserves in VAULT substates and total LP supply
 * in the LP RESOURCE substate, so the wallet read path must do a multi-substate decode
 * (component -> reserve vaults + LP resource + locked vault), NOT a flat-field read, and
 * must NOT call the DenyAll get_a_resource/get_b_resource methods.
 *
 * This drives the exact wiring the wallet uses — `readRawSubstate` (tari_getSubstate)
 * feeding `decodePoolState` — with a mock provider that returns the REAL Pool v2
 * substate bytes captured from the live chain. The decoded result must equal the
 * independently live-verified numbers. (The real wallet reply shape is UNVERIFIED here
 * because no provider is available; this pins the decode + adapter logic.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const tari = require('../build-test/services/tariWindow.js');
const { decodePoolState } = require('@tari-ootle/protocol-client');

const POOL = 'component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2';
const TTARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
const LPTESTA = 'resource_87385b51c57f8682ec2de4a0e590b17a56c7465c904552e80cabaeb467e70dfc';
const LP = 'resource_8c69acbc731c626fdd37557653ab1133b548fee654e14bbbfc747f1bcf7a3281';
const V_TTARI = 'vault_8c53108d6dc567b2adfeac1db840056504b18f89b2e4005663f3dbfb5ee6da49';
const V_LPTESTA = 'vault_8cf3e5b742f49a2e773af904bfdf3f40aa4c26eb93e5e9887303424a662c0c10';
const V_LOCKED = 'vault_8cd9f81d4c365cd3b87dece223f15ae773a52f38a88199767ab326a99c8b9460';

const tagRes = (hex) => ({ '@cbor': 'tag', tag: 131, value: { '@cbor': 'bytes', hex } });
const tagVault = (hex) => ({ '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex } });

const RAW = {
  [POOL]: { Component: { header: { template_address: 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab', owner_rule: 'None' }, body: { state: [
    { '@cbor': 'map', entries: [
      [tagRes('0101010101010101010101010101010101010101010101010101010101010101'), tagVault('8c53108d6dc567b2adfeac1db840056504b18f89b2e4005663f3dbfb5ee6da49')],
      [tagRes('87385b51c57f8682ec2de4a0e590b17a56c7465c904552e80cabaeb467e70dfc'), tagVault('8cf3e5b742f49a2e773af904bfdf3f40aa4c26eb93e5e9887303424a662c0c10')],
    ] },
    tagRes('8c69acbc731c626fdd37557653ab1133b548fee654e14bbbfc747f1bcf7a3281'), 30,
    tagVault('8cd9f81d4c365cd3b87dece223f15ae773a52f38a88199767ab326a99c8b9460'),
  ] } } },
  [V_TTARI]: { Vault: { resource_container: { Stealth: { address: TTARI, revealed_amount: '595664', locked_amount: '0' } }, freeze_flags: 0 } },
  [V_LPTESTA]: { Vault: { resource_container: { Fungible: { address: LPTESTA, amount: '604684', locked_amount: '0' } }, freeze_flags: 0 } },
  [LP]: { Resource: { resource_type: 'Fungible', owner_rule: 'None', total_supply: '600000' } },
  [V_LOCKED]: { Vault: { resource_container: { Fungible: { address: LP, amount: '1000', locked_amount: '0' } }, freeze_flags: 0 } },
};

// A provider that answers tari_getSubstate with the real substate wrapped as the
// contract delivers it: { substate: <rawValue> }.
function provider() {
  return {
    isTariWallet: true,
    async request(envelope) {
      if (envelope.method === 'tari_getSubstate') {
        const id = envelope.params.substateId;
        const raw = RAW[id];
        return raw === undefined ? { substate: { notFound: true } } : { substate: raw };
      }
      throw new Error(`unexpected method ${envelope.method}`);
    },
  };
}

test('wallet readPoolState wiring decodes the exact live Pool v2 state via tari_getSubstate', async () => {
  const p = provider();
  const state = await decodePoolState({ read: (addr) => tari.readRawSubstate(p, addr) }, POOL);
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

test('wallet read fails closed when the component substate is absent (never fabricated)', async () => {
  const empty = { isTariWallet: true, async request() { return { substate: { notFound: true } }; } };
  await assert.rejects(decodePoolState({ read: (addr) => tari.readRawSubstate(empty, addr) }, POOL));
});
