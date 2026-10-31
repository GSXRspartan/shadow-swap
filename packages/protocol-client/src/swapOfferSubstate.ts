/**
 * SwapOffer (templates/p2p_offer) component decoder: the ON-CHAIN terms of a P2P offer.
 *
 * A shareable invitation is untrusted text. Everything a taker relies on is derived here from
 * the component and its two vaults, as the official v0.48 decoder renders them
 * (`@tari-project/ootle-wasm-bor` -> JSON). The fixture this is tested against is the real
 * engine's bytes (audit_engine_tests/tests/swapoffer_wire_v048.rs).
 *
 *   state = [escrow: Vault, proceeds: Vault, offered_resource, want_resource, want_amount,
 *            want_nft: Option<NonFungibleId>, hash_lock: Option<Hash32>, expires_at_epoch: u64,
 *            status: Open | Filled | Cancelled]
 *
 * WHO may act is not in the state; it is in the component's access rules, written once by
 * `create` and immutable (OwnerRule::None):
 *   claim, cancel  rule!(public_key(maker))          -> the maker key
 *   fill           AllowAll | rule!(public_key(t))   -> no restriction | the designated taker
 *   offer          AllowAll;  default DenyAll
 * A component whose rules have any other shape is refused: its terms cannot be stated.
 *
 * What is escrowed is read from the ESCROW VAULT, whose resource must equal the declared
 * offered resource; the proceeds vault must hold the wanted resource. A component that
 * declares one asset while its vault holds another is refused.
 */

import { decodeComponentHeader, decodeNonFungibleId, MarketplaceDecodeError, readEscrow, type MarketplaceEscrow, type MarketplaceRawSubstateReader } from './marketplaceSubstate.js';

export type SwapOfferStatus = 'OPEN' | 'FILLED' | 'CANCELLED';

/** The public-key badge resource `rule!(public_key(..))` names (engine fixture). */
export const PUBLIC_IDENTITY_RESOURCE = 'resource_0100000000000000000000000000000000000000000000000000000000000000';

const HEX64 = /^[0-9a-f]{64}$/;
const STATUSES: readonly SwapOfferStatus[] = ['OPEN', 'FILLED', 'CANCELLED'];

export interface SwapOfferState {
  readonly component: string;
  readonly templateAddress: string;
  readonly status: SwapOfferStatus;
  /** What the maker escrowed, read from the escrow VAULT (empty after a fill or cancel). */
  readonly offered: MarketplaceEscrow;
  readonly requested: {
    readonly resource: string;
    /** Raw amount for a fungible request; '0' for an NFT request. */
    readonly amount: string;
    /** Canonical id of the one NFT wanted, or null for a fungible request. */
    readonly nftId: string | null;
  };
  /** What a fill paid in, waiting for the maker's claim. */
  readonly proceeds: MarketplaceEscrow;
  /** SHA-256 hash lock (64 hex) or null. */
  readonly hashLock: string | null;
  /** '0' = never expires. */
  readonly expiresAtEpoch: string;
  /** Maker public key (64 hex): the only key that can claim or cancel. */
  readonly maker: string;
  /** The only key that can fill, or null when anyone can. */
  readonly designatedTaker: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function fail(message: string): never {
  throw new MarketplaceDecodeError(`SwapOffer: ${message}`);
}

function tagged(node: unknown, tag: number, what: string): string {
  const bag = record(node);
  const hex = record(bag?.value)?.hex;
  if (bag?.['@cbor'] !== 'tag' || bag.tag !== tag || typeof hex !== 'string' || !HEX64.test(hex)) fail(`${what} is not a tag-${tag} object key`);
  return hex;
}

function uint(node: unknown, what: string): string {
  if (typeof node === 'number' && Number.isSafeInteger(node) && node >= 0) return String(node);
  if (typeof node === 'string' && /^(?:0|[1-9]\d*)$/.test(node)) return node;
  return fail(`${what} is not an exact non-negative integer (${JSON.stringify(node)})`);
}

/** `rule!(public_key(k))` as rendered by the official decoder -> k, else undefined. */
function publicKeyRule(rule: unknown): string | undefined {
  const nfa = record(record(record(record(rule)?.Restricted)?.Require)?.Require)?.NonFungibleAddress;
  const n = record(nfa);
  const id = record(n?.id);
  if (n === undefined || n.resource_address !== PUBLIC_IDENTITY_RESOURCE || id === undefined) return undefined;
  if (Object.keys(id).length !== 1 || typeof id.U256 !== 'string' || !HEX64.test(id.U256)) return undefined;
  if (Object.keys(record(record(record(rule)?.Restricted)?.Require) ?? {}).length !== 1) return undefined;
  return id.U256;
}

function rulesOf(substate: unknown): { maker: string; designatedTaker: string | null } {
  const header = decodeComponentHeader(substate);
  if (header.ownerRule !== 'None') fail(`owner rule is ${JSON.stringify(header.ownerRule)}, not None: someone could change its rules`);
  if (header.defaultRule !== 'DenyAll') fail('default access rule is not DenyAll');
  const methods = header.methodAccess;
  const names = Object.keys(methods).sort();
  if (names.join(',') !== 'cancel,claim,fill,offer') fail(`unexpected method rules (${names.join(',')})`);
  if (methods.offer !== 'AllowAll') fail('`offer` is not public');
  const claim = publicKeyRule(methods.claim);
  const cancel = publicKeyRule(methods.cancel);
  if (claim === undefined || cancel === undefined || claim !== cancel) fail('claim/cancel are not restricted to one maker key');
  let designatedTaker: string | null;
  if (methods.fill === 'AllowAll') designatedTaker = null;
  else {
    const taker = publicKeyRule(methods.fill);
    if (taker === undefined) fail('`fill` has an access rule whose terms cannot be stated');
    designatedTaker = taker;
  }
  return { maker: claim, designatedTaker };
}

/**
 * Reads and decodes one SwapOffer. `trustedTemplates` are the SwapOffer template addresses
 * RECORDED for the verified network generation; a component of any other template is refused
 * (an invitation naming a look-alike template proves nothing).
 */
export async function decodeSwapOffer(reader: MarketplaceRawSubstateReader, component: string, trustedTemplates: readonly string[]): Promise<SwapOfferState> {
  if (!/^component_[0-9a-f]{64}$/.test(component)) fail(`${JSON.stringify(component)} is not a component address`);
  const substate = await reader.read(component);
  if (substate === undefined || substate === null) fail(`component ${component} does not exist or could not be read`);
  const header = decodeComponentHeader(substate);
  const template = header.templateAddress;
  const trusted = trustedTemplates.map((t) => t.replace(/^template_/, ''));
  if (template === undefined || !trusted.includes(template)) {
    fail(`component ${component} is template ${template ?? '(none)'}, which is not a SwapOffer template recorded for this network`);
  }
  const comp = record(record(substate)?.Component) ?? record(substate);
  const state = record(comp?.body)?.state;
  if (!Array.isArray(state) || state.length !== 9) fail(`state is not the 9-field SwapOffer tuple (got ${Array.isArray(state) ? state.length : typeof state})`);
  const offeredResource = `resource_${tagged(state[2], 131, 'offered_resource')}`;
  const wantResource = `resource_${tagged(state[3], 131, 'want_resource')}`;
  if (offeredResource === wantResource) fail('offered and wanted resources are the same');
  const wantAmount = uint(state[4], 'want_amount');
  const wantNft = state[5] === null ? null : decodeNonFungibleId(state[5], 'want_nft');
  let hashLock: string | null = null;
  if (state[6] !== null) {
    const hex = record(state[6])?.hex;
    if (record(state[6])?.['@cbor'] !== 'bytes' || typeof hex !== 'string' || !HEX64.test(hex)) fail('hash_lock is not a 32-byte hash');
    hashLock = hex;
  }
  const expiresAtEpoch = uint(state[7], 'expires_at_epoch');
  const statusNode = state[8];
  if (!Array.isArray(statusNode) || statusNode.length !== 2 || !Array.isArray(statusNode[1]) || statusNode[1].length !== 0) fail('status is not a unit enum');
  const status = STATUSES[Number(statusNode[0])];
  if (status === undefined || !Number.isInteger(statusNode[0])) fail(`unknown status ${JSON.stringify(statusNode[0])}`);
  if (wantNft === null && BigInt(wantAmount) === 0n) fail('a fungible request with a zero amount');
  const { maker, designatedTaker } = rulesOf(substate);
  const offered = await readEscrow(reader, `vault_${tagged(state[0], 132, 'escrow')}`, offeredResource);
  const proceeds = await readEscrow(reader, `vault_${tagged(state[1], 132, 'proceeds')}`, wantResource);
  if (status === 'OPEN' && offered.empty) fail('an OPEN offer with an empty escrow');
  return {
    component,
    templateAddress: template,
    status,
    offered,
    requested: { resource: wantResource, amount: wantNft === null ? wantAmount : '0', nftId: wantNft },
    proceeds,
    hashLock,
    expiresAtEpoch,
    maker,
    designatedTaker,
  };
}

/** Whether `currentEpoch` is at/after a non-zero expiry (the template's own `is_expired`). */
export function swapOfferExpired(state: Pick<SwapOfferState, 'expiresAtEpoch'>, currentEpoch: string): boolean {
  return state.expiresAtEpoch !== '0' && BigInt(currentEpoch) >= BigInt(state.expiresAtEpoch);
}
