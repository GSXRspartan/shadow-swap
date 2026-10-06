/**
 * Authoritative Pool state decode from RAW on-chain substates.
 *
 * The published `Pool` template stores its state as a struct, NOT as flat fields:
 *
 *   state = [ pools: BTreeMap<ResourceAddress, Vault>,   // reserves live in VAULTS
 *             lp_resource: ResourceAddress,
 *             fee_bps: u16,
 *             locked_lp_vault: Vault ]
 *
 * So a single component read cannot give reserves or LP supply — the reserves are
 * in the two reserve VAULT substates, the total LP supply is in the LP RESOURCE
 * substate, and the permanently-locked LP is the balance of the `locked_lp_vault`.
 * This module reads the component and then those dependent substates and assembles a
 * `PoolState`. It reads the resource pair directly from the component body, so it
 * NEVER calls `get_a_resource`/`get_b_resource` — which are `DenyAll` on an ownerless
 * (v2) pool and would fail without a creator-owner bypass.
 *
 * Everything is raw-integer (decimal strings); no floating point. The decode is
 * fail-closed: a malformed or missing substate throws rather than inventing a field.
 *
 * The CBOR-tagged wire shapes (as served by the indexer substate API and by the
 * wallet's `tari_getSubstate`) are:
 *   ResourceAddress  { "@cbor":"tag", "tag":131, "value":{ "@cbor":"bytes","hex":<64hex> } }
 *   Vault (id)       { "@cbor":"tag", "tag":132, "value":{ "@cbor":"bytes","hex":<64hex> } }
 *   Vault substate   { "Vault": { "resource_container": { <Stealth|Fungible|Confidential>:
 *                        { "amount"?:"N", "revealed_amount"?:"N" } } } }
 *   Resource substate{ "Resource": { "total_supply":"N", ... } }
 */

import type { PoolState } from './ootle.js';

/** Returns the raw substate value, e.g. `{ Component|Vault|Resource: {...} }`, or undefined if absent. */
export interface RawSubstateReader {
  read(address: string): Promise<unknown>;
}

const TAG_RESOURCE = 131;
const TAG_VAULT = 132;
const HEX64 = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Decimal non-negative integer as a string, from a JSON string or a safe-integer number. */
function intString(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new PoolDecodeError(`${what} is not a non-negative integer: ${JSON.stringify(value)}`);
}

export class PoolDecodeError extends Error {}

/** Extract the 64-hex object key from a `{@cbor:tag, tag, value:{@cbor:bytes, hex}}` node. */
function taggedHex(node: unknown, expectedTag: number, what: string): string {
  const bag = record(node);
  if (bag === undefined || bag['@cbor'] !== 'tag' || bag.tag !== expectedTag) {
    throw new PoolDecodeError(`${what} is not a CBOR tag ${expectedTag} node`);
  }
  const inner = record(bag.value);
  const hex = inner?.hex;
  if (typeof hex !== 'string' || !HEX64.test(hex)) {
    throw new PoolDecodeError(`${what} does not carry a 32-byte object key`);
  }
  return hex;
}

/** The component body, decoded into addresses/ids (reserves still need vault reads). */
export interface PoolComponentShape {
  resourceA: string;
  resourceB: string;
  reserveVaultA: string;
  reserveVaultB: string;
  lpResource: string;
  feeBps: string;
  lockedVault: string;
}

/**
 * Decode the Pool component body `state` tuple. Fail-closed: the tuple must be
 * exactly `[poolsMap, lpResource, feeBps, lockedVault]` with a 2-entry pools map.
 */
export function decodePoolComponent(componentSubstate: unknown): PoolComponentShape {
  const comp = record(record(componentSubstate)?.Component) ?? record(componentSubstate);
  const body = record(comp?.body);
  const state = body?.state;
  if (!Array.isArray(state) || state.length < 4) {
    throw new PoolDecodeError('Pool component state is not the expected [pools, lp_resource, fee_bps, locked_lp_vault] tuple');
  }
  const poolsMap = record(state[0]);
  const entries = poolsMap?.entries;
  if (poolsMap?.['@cbor'] !== 'map' || !Array.isArray(entries) || entries.length !== 2) {
    throw new PoolDecodeError('Pool component pools map must have exactly two reserve entries');
  }
  const pairs = entries.map((e, i) => {
    if (!Array.isArray(e) || e.length < 2) throw new PoolDecodeError(`pools entry ${i} is malformed`);
    return { resource: 'resource_' + taggedHex(e[0], TAG_RESOURCE, `pools[${i}].resource`), vault: 'vault_' + taggedHex(e[1], TAG_VAULT, `pools[${i}].vault`) };
  });
  return {
    resourceA: pairs[0].resource,
    reserveVaultA: pairs[0].vault,
    resourceB: pairs[1].resource,
    reserveVaultB: pairs[1].vault,
    lpResource: 'resource_' + taggedHex(state[1], TAG_RESOURCE, 'lp_resource'),
    feeBps: intString(state[2], 'fee_bps'),
    lockedVault: 'vault_' + taggedHex(state[3], TAG_VAULT, 'locked_lp_vault'),
  };
}

/** The spendable balance in a vault substate, across Stealth/Fungible/Confidential containers. */
export function vaultAmount(vaultSubstate: unknown, what = 'vault'): string {
  const container = record(record(record(vaultSubstate)?.Vault)?.resource_container) ?? record(record(vaultSubstate)?.resource_container);
  if (container === undefined) throw new PoolDecodeError(`${what}: no resource_container`);
  // Exactly one of Stealth/Fungible/Confidential.
  for (const kind of ['Fungible', 'Stealth', 'Confidential'] as const) {
    const inner = record(container[kind]);
    if (inner !== undefined) {
      const amt = inner.amount ?? inner.revealed_amount;
      return intString(amt, `${what}.${kind}.amount`);
    }
  }
  throw new PoolDecodeError(`${what}: unrecognised resource container kind (${Object.keys(container).join(',')})`);
}

/** The total supply from a resource substate. */
export function resourceTotalSupply(resourceSubstate: unknown, what = 'resource'): string {
  const res = record(record(resourceSubstate)?.Resource) ?? record(resourceSubstate);
  return intString(res?.total_supply, `${what}.total_supply`);
}

/**
 * Read and assemble the authoritative Pool state. `reader.read` must return the raw
 * substate value (the `{ Component|Vault|Resource: {...} }` object) for an address.
 */
export async function decodePoolState(reader: RawSubstateReader, poolComponent: string): Promise<PoolState> {
  const componentSubstate = await reader.read(poolComponent);
  if (componentSubstate === undefined || componentSubstate === null) {
    throw new PoolDecodeError(`Pool component ${poolComponent} does not exist or could not be read`);
  }
  const shape = decodePoolComponent(componentSubstate);
  const [reserveAVault, reserveBVault, lpResourceSubstate, lockedVaultSubstate] = await Promise.all([
    reader.read(shape.reserveVaultA),
    reader.read(shape.reserveVaultB),
    reader.read(shape.lpResource),
    reader.read(shape.lockedVault),
  ]);
  return {
    poolComponent,
    resourceA: shape.resourceA,
    resourceB: shape.resourceB,
    reserveA: vaultAmount(reserveAVault, 'reserveA'),
    reserveB: vaultAmount(reserveBVault, 'reserveB'),
    feeBps: shape.feeBps,
    lpResource: shape.lpResource,
    totalLpSupply: resourceTotalSupply(lpResourceSubstate, 'lpResource'),
    lockedLpSupply: vaultAmount(lockedVaultSubstate, 'lockedLpVault'),
  };
}
