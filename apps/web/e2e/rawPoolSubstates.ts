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

/**
 * The REAL published Pool v2 template address, so the double serves the same header the
 * live chain serves. A placeholder here would let the browser tests pass a decoder that
 * production would reject, which is exactly the class of drift this fixture exists to
 * prevent.
 */
export const POOL_V2_TEMPLATE = 'f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab';

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

/**
 * Raw Pool component body: the `[pools, lp_resource, fee_bps, locked_lp_vault]` tuple.
 *
 * The header carries the real Pool v2 template and the vault containers carry the
 * `address` field the live wire shape always includes — the decoder now refuses a vault
 * that does not hold the resource the component declares, so a double that omitted it
 * would be testing a weaker reader than production.
 */
function componentState(resourceA: string, resourceB: string, vaultA: string, vaultB: string, lpResource: string, feeBps: number, lockedVault: string) {
  return {
    Component: {
      header: { template_address: POOL_V2_TEMPLATE, owner_rule: 'None', access_rules: { method_access: {}, default: 'DenyAll' } },
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

/** A vault substate in the live wire shape: the container names the resource it holds. */
const vault = (amount: string, resourceHex: string) => ({
  Vault: { resource_container: { Fungible: { address: 'resource_' + resourceHex, amount } }, freeze_flags: 0 },
});
const resource = (totalSupply: string) => ({ Resource: { resource_type: 'Fungible', owner_rule: 'None', total_supply: totalSupply } });

/**
 * Every substate the Pool decoder can request, keyed by the address it will ask
 * for. The component is named by discovery; the vault/resource ids are DERIVED
 * from the tagged hexes in the component body.
 */
export const RAW_POOL_SUBSTATES: Record<string, unknown> = {
  [POOL_COMPONENT]: componentState(TARI_HEX, WSTABLE_HEX, VAULT_A1, VAULT_B1, LP1_HEX, 30, LOCKED_1),
  ['vault_' + VAULT_A1]: vault('1000000000', TARI_HEX),
  ['vault_' + VAULT_B1]: vault('4000000000', WSTABLE_HEX),
  ['resource_' + LP1_HEX]: resource('2000000000'),
  ['vault_' + LOCKED_1]: vault('0', LP1_HEX),

  [SAFE_POOL_COMPONENT]: componentState(AAA_HEX, BBB_HEX, VAULT_A2, VAULT_B2, LP2_HEX, 5, LOCKED_2),
  ['vault_' + VAULT_A2]: vault('5000000000', AAA_HEX),
  ['vault_' + VAULT_B2]: vault('7000000000', BBB_HEX),
  ['resource_' + LP2_HEX]: resource('3000000000'),
  ['vault_' + LOCKED_2]: vault('0', LP2_HEX),
};

/**
 * A hostile variant of the substate map, BAKED INTO the provider script rather than
 * transformed at request time.
 *
 * Each mode models a wallet that advertises raw substates but does not deliver the real
 * wire shape:
 *   'noAddress'     the vault containers omit the resource `address`, so what a vault
 *                   holds cannot be proven
 *   'wrongTemplate' the component header names a different template, so the component is
 *                   a look-alike rather than the pool discovery found
 *   'missingVault'  a reserve vault is reported absent, so a reserve would have to be
 *                   invented to display one
 *
 * Serving these as DATA keeps the double deterministic: the very first reply is already
 * hostile, which is both closer to a real broken wallet and immune to any ordering or
 * state-toggling question in a test.
 */
export type HostilePoolMode = 'noAddress' | 'wrongTemplate' | 'missingVault';

export function hostileRawPoolSubstates(mode: HostilePoolMode): Record<string, unknown> {
  const clone: Record<string, unknown> = structuredClone(RAW_POOL_SUBSTATES);
  if (mode === 'missingVault') {
    delete clone['vault_' + VAULT_A1];
    return clone;
  }
  if (mode === 'wrongTemplate') {
    for (const entry of Object.values(clone)) {
      const header = (entry as { Component?: { header?: { template_address?: string } } }).Component?.header;
      if (header !== undefined) header.template_address = '00'.repeat(32);
    }
    return clone;
  }
  for (const entry of Object.values(clone)) {
    const container = (entry as { Vault?: { resource_container?: Record<string, { address?: string }> } }).Vault?.resource_container;
    if (container === undefined) continue;
    for (const kind of Object.keys(container)) delete container[kind].address;
  }
  return clone;
}

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
