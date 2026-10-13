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
  /** The published template the component itself claims to be. REQUIRED on the wire. */
  templateAddress: string;
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
 * exactly `[poolsMap, lpResource, feeBps, lockedVault]` with a 2-entry pools map, and the
 * component header must name the template it was published as.
 *
 * The template address is REQUIRED, not advisory: every transport that serves raw
 * substates (the indexer batch API and `tari_getSubstate`) carries it, so a header without
 * one is a stale or hand-made payload, not a pool this client may quote against.
 */
export function decodePoolComponent(componentSubstate: unknown): PoolComponentShape {
  const comp = record(record(componentSubstate)?.Component) ?? record(componentSubstate);
  const body = record(comp?.body);
  const state = body?.state;
  if (!Array.isArray(state) || state.length < 4) {
    throw new PoolDecodeError('Pool component state is not the expected [pools, lp_resource, fee_bps, locked_lp_vault] tuple');
  }
  const header = record(comp?.header);
  const template = header?.template_address;
  if (typeof template !== 'string' || template.length === 0) {
    throw new PoolDecodeError('Pool component header does not name its template; identity cannot be established');
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
    templateAddress: bareObjectKey(template),
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
/**
 * Identity constraints a caller can pin ON TOP of the intrinsic decode.
 *
 * `decodePoolState` already refuses a self-inconsistent payload (a reserve vault that
 * holds something other than the declared pair leg, a locked vault that is not the LP
 * resource). These are the constraints only the CALLER can know: which template and
 * which pair the component is supposed to be. Passing them turns a "this looked like a
 * pool" read into a "this IS the pool we asked for" read.
 */
export interface PoolIdentityExpectations {
  /** Published Pool template address; accepts `template_<hex>` or a bare 64-hex key. */
  templateAddress?: string;
  resourceA?: string;
  resourceB?: string;
  lpResource?: string;
}

/** Strip an optional `template_` prefix so both transport forms compare equal. */
function bareObjectKey(address: string): string {
  return address.startsWith('template_') ? address.slice('template_'.length) : address;
}

/** The published template address carried by a Component substate header, if present. */
function componentTemplateAddress(componentSubstate: unknown): string | undefined {
  const comp = record(record(componentSubstate)?.Component) ?? record(componentSubstate);
  const header = record(comp?.header);
  const value = header?.template_address;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The resource a vault's container holds. REQUIRED on the wire.
 *
 * The live shape always includes it (`{Fungible|Stealth|Confidential:{address,…}}`), on
 * every transport that serves raw substates. A container that omits it cannot prove what
 * it holds, so a reserve read over such a payload would be a guess — and a guess is what
 * this decoder exists to prevent.
 */
function vaultResourceAddress(vaultSubstate: unknown, what: string): string {
  const container =
    record(record(record(vaultSubstate)?.Vault)?.resource_container) ?? record(record(vaultSubstate)?.resource_container);
  for (const kind of ['Fungible', 'Stealth', 'Confidential'] as const) {
    const address = record(container?.[kind])?.address;
    if (typeof address === 'string' && address.length > 0) return address;
  }
  throw new PoolDecodeError(`${what} vault carries no resource address in its container; what it holds cannot be proven`);
}

/**
 * Read and assemble the authoritative Pool state. `reader.read` must return the raw
 * substate value (the `{ Component|Vault|Resource: {...} }` object) for an address.
 *
 * Fail-closed. The component must name its published template, each reserve vault must
 * actually hold the declared pair leg, the locked vault must hold the LP resource, and
 * (when `expect` is supplied) the component must be the requested template/pair.
 */
export async function decodePoolState(reader: RawSubstateReader, poolComponent: string, expect?: PoolIdentityExpectations): Promise<PoolState> {
  const componentSubstate = await reader.read(poolComponent);
  if (componentSubstate === undefined || componentSubstate === null) {
    throw new PoolDecodeError(`Pool component ${poolComponent} does not exist or could not be read`);
  }
  if (expect?.templateAddress !== undefined) {
    const actual = componentTemplateAddress(componentSubstate);
    if (actual === undefined) {
      throw new PoolDecodeError(`Pool component ${poolComponent} carries no template address; its identity cannot be established`);
    }
    if (bareObjectKey(actual) !== bareObjectKey(expect.templateAddress)) {
      throw new PoolDecodeError(`Pool component ${poolComponent} is template ${actual}, expected ${expect.templateAddress}`);
    }
  }
  const shape = decodePoolComponent(componentSubstate);
  const declaredPair: readonly [keyof PoolComponentShape, string, string | undefined][] = [
    ['resourceA', shape.resourceA, expect?.resourceA],
    ['resourceB', shape.resourceB, expect?.resourceB],
    ['lpResource', shape.lpResource, expect?.lpResource],
  ];
  for (const [field, actual, expected] of declaredPair) {
    if (expected !== undefined && actual !== expected) {
      throw new PoolDecodeError(`Pool ${poolComponent} declares ${field}=${actual}, expected ${expected}`);
    }
  }
  const [reserveAVault, reserveBVault, lpResourceSubstate, lockedVaultSubstate] = await Promise.all([
    reader.read(shape.reserveVaultA),
    reader.read(shape.reserveVaultB),
    reader.read(shape.lpResource),
    reader.read(shape.lockedVault),
  ]);
  // Intrinsic identity: the vaults the component points at must actually hold the
  // declared resources. Without this a component could name (tTARI, LPTESTA) while its
  // vaults held something else entirely, and every downstream quote would price the
  // wrong assets.
  const actualVaults: readonly [string, string][] = [
    ['reserveA', vaultResourceAddress(reserveAVault, 'reserveA')],
    ['reserveB', vaultResourceAddress(reserveBVault, 'reserveB')],
    ['lockedLp', vaultResourceAddress(lockedVaultSubstate, 'lockedLp')],
  ];
  for (const [index, [what, actual]] of actualVaults.entries()) {
    if (actual !== declaredPair[index][1]) {
      throw new PoolDecodeError(`Pool ${poolComponent} ${what} vault holds ${actual}, but the component declares ${declaredPair[index][1]}`);
    }
  }
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
