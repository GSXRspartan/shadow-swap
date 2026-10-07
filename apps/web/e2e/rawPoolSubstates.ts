/**
 * RAW Pool substates for the browser doubles.
 *
 * The published `Pool` template stores its state as a struct, not flat fields:
 *
 *   state = [ pools: BTreeMap<ResourceAddress, Vault>,   // reserves live in VAULTS
 *             lp_resource: ResourceAddress,
 *             fee_bps: u16,
 *             locked_lp_vault: Vault ]
 *
 * so the wallet's `tari_getSubstate` must answer with the real substate VALUES
 * (`{ Component|Vault|Resource: {...} }`), NOT a pre-decoded field map. The
 * production read path (`readRawSubstate` -> `decodePoolState`) decodes these,
 * and a double that answered flat fields would only pass through a downgrade the
 * protocol-client forbids.
 *
 * The addresses are the canonical `resource_<64hex>` form so the decoded pair
 * matches the wallet's own balance records (which is where symbol/divisibility
 * come from). TARI's object key is all `0x01`, matching
 * `CANONICAL_TARI_RESOURCE` in `src/services/ootleIndexer.ts`.
 */

const h = (byte: string): string => byte.repeat(32);

/** Canonical resource object keys (32 bytes, 64 hex). */
export const TARI_HEX = h('01');
export const WSTABLE_HEX = h('02');
export const AAA_HEX = h('03');
export const BBB_HEX = h('04');

const LP1_HEX = h('05');
const LP2_HEX = h('06');
const VAULT_A1 = h('a1');
const VAULT_B1 = h('b1');
const LOCKED_1 = h('c1');
const VAULT_A2 = h('a2');
const VAULT_B2 = h('b2');
const LOCKED_2 = h('c2');

/** The exact resource identity the app compares against for canonical TARI. */
export const TARI_RESOURCE = 'resource_' + TARI_HEX;
export const WSTABLE_RESOURCE = 'resource_' + WSTABLE_HEX;
export const AAA_RESOURCE = 'resource_' + AAA_HEX;
export const BBB_RESOURCE = 'resource_' + BBB_HEX;

export const POOL_COMPONENT = 'component_pool_tari_wstable_0001';
export const SAFE_POOL_COMPONENT = 'component_pool_a_b_0002';

/** Wallet balances: the only source of a resource's symbol and divisibility. */
export const REFERENCE_BALANCES = [
  { resourceAddress: TARI_RESOURCE, kind: 'Fungible', symbol: 'TARI', name: 'Tari', divisibility: 6, amount: '10000000000', confidentialAmount: '0' },
  { resourceAddress: WSTABLE_RESOURCE, kind: 'Fungible', symbol: 'wSTABLE', name: 'Wrapped USDT', divisibility: 6, amount: '25000000000', confidentialAmount: '0' },
  { resourceAddress: AAA_RESOURCE, kind: 'Fungible', symbol: 'AAA', name: 'AAA', divisibility: 6, amount: '40000000000', confidentialAmount: '0' },
  { resourceAddress: BBB_RESOURCE, kind: 'Fungible', symbol: 'BBB', name: 'BBB', divisibility: 6, amount: '80000000000', confidentialAmount: '0' },
];

const tagResource = (hex: string) => ({ '@cbor': 'tag', tag: 131, value: { '@cbor': 'bytes', hex } });
const tagVault = (hex: string) => ({ '@cbor': 'tag', tag: 132, value: { '@cbor': 'bytes', hex } });

/** Raw Pool component body: the `[pools, lp_resource, fee_bps, locked_lp_vault]` tuple. */
function componentState(resourceA: string, resourceB: string, vaultA: string, vaultB: string, lpResource: string, feeBps: number, lockedVault: string) {
  return {
    Component: {
      header: { template_address: 'ab'.repeat(32), owner_rule: 'None', access_rules: { method_access: {}, default: 'DenyAll' } },
      body: {
        state: [
          {
            '@cbor': 'map',
            entries: [
              [tagResource(resourceA), tagVault(vaultA)],
              [tagResource(resourceB), tagVault(vaultB)],
            ],
          },
          tagResource(lpResource),
          feeBps,
          tagVault(lockedVault),
        ],
      },
    },
  };
}

const vault = (amount: string) => ({ Vault: { resource_container: { Fungible: { amount } }, freeze_flags: 0 } });
const resource = (totalSupply: string) => ({ Resource: { resource_type: 'Fungible', owner_rule: 'None', total_supply: totalSupply } });

/**
 * Every substate the Pool decoder can request, keyed by the address it will ask
 * for. The component is named by discovery; the vault/resource ids are DERIVED
 * from the tagged hexes in the component body.
 */
export const RAW_POOL_SUBSTATES: Record<string, unknown> = {
  [POOL_COMPONENT]: componentState(TARI_HEX, WSTABLE_HEX, VAULT_A1, VAULT_B1, LP1_HEX, 30, LOCKED_1),
  ['vault_' + VAULT_A1]: vault('1000000000'),
  ['vault_' + VAULT_B1]: vault('4000000000'),
  ['resource_' + LP1_HEX]: resource('2000000000'),
  ['vault_' + LOCKED_1]: vault('0'),

  [SAFE_POOL_COMPONENT]: componentState(AAA_HEX, BBB_HEX, VAULT_A2, VAULT_B2, LP2_HEX, 5, LOCKED_2),
  ['vault_' + VAULT_A2]: vault('5000000000'),
  ['vault_' + VAULT_B2]: vault('7000000000'),
  ['resource_' + LP2_HEX]: resource('3000000000'),
  ['vault_' + LOCKED_2]: vault('0'),
};

/**
 * The `tari_getSubstate` reply for an id, as the published contract delivers it:
 * the raw substate wrapped in `{ substate: <value> }`, or an explicit `notFound`
 * so the app can tell "absent" from "read failed".
 */
export function substateReply(substateId: string): unknown {
  const raw = RAW_POOL_SUBSTATES[substateId];
  if (raw === undefined) return { substateId, notFound: true, fields: {} };
  return { substate: raw };
}
