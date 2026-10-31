/**
 * Authoritative NFT-marketplace state decode from RAW on-chain substates.
 *
 * WHY THIS EXISTS, and what it corrects.
 *
 * The three published marketplace templates store their state as a STRUCT, not as flat
 * named fields:
 *
 *   FixedPriceListing.state = [ nft_vault, nft_resource, nft_id, quote_resource,
 *                               price, seller_account, expires_at_epoch, status ]
 *   ItemOffer.state         = [ quote_vault, buyer_account, nft_resource, nft_id,
 *                               quote_resource, offer_amount, created_at_epoch,
 *                               expires_at_epoch, status ]
 *   CollectionBid.state     = [ quote_vault, buyer_account, collection, quote_resource,
 *                               price_per_nft, original_quantity, remaining_quantity,
 *                               original_escrow, remaining_escrow, created_at_epoch,
 *                               expires_at_epoch, status ]
 *
 * A flat-field read (`readComponent(...).fields.nft_resource`) therefore returns
 * nothing at all for a real marketplace component. That is the same class of defect the
 * Pool readback already had, and it was fixed there by decoding the raw substates.
 * Reading a real component through the flat path cannot succeed, so this module
 * decodes the actual struct tuples, and also reads each component's ESCROW VAULT so a
 * caller can tell "settled" from "still holding something".
 *
 * Fail-closed throughout:
 *   - the component header MUST name its published template;
 *   - the state tuple length and field shapes are exact, and a malformed field throws
 *     rather than being defaulted;
 *   - the escrow vault's declared resource MUST match the resource the component says it
 *     escrows, so a component cannot be described as holding something it does not;
 *   - an unknown status index is `undefined`, never normalised toward "fillable".
 *
 * All amounts are raw-integer decimal strings. No JS number carries an on-chain value.
 */

import type { CollectionBid, ItemOffer, Listing } from './marketplace.js';

/**
 * Raw substate transport. Deliberately a distinct interface from the Pool one: this
 * decoder's reader only ever needs a raw value, and a Pool-specific reader must not be
 * silently reusable as a marketplace reader.
 */
export interface MarketplaceRawSubstateReader {
  read(address: string): Promise<unknown>;
}

const TAG_COMPONENT = 128;
const TAG_RESOURCE = 131;
const TAG_VAULT = 132;
const HEX64 = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function intString(value: unknown, what: string): string {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new MarketplaceDecodeError(`${what} is not a non-negative integer: ${JSON.stringify(value)}`);
}

export class MarketplaceDecodeError extends Error {}

function taggedHex(node: unknown, expectedTag: number, what: string): string {
  const bag = record(node);
  if (bag === undefined || bag['@cbor'] !== 'tag' || bag.tag !== expectedTag) {
    throw new MarketplaceDecodeError(`${what} is not a CBOR tag ${expectedTag} node`);
  }
  const hex = record(bag.value)?.hex;
  if (typeof hex !== 'string' || !HEX64.test(hex)) {
    throw new MarketplaceDecodeError(`${what} does not carry a 32-byte object key`);
  }
  return hex;
}

function bareObjectKey(address: string): string {
  return address.startsWith('template_') ? address.slice('template_'.length) : address;
}

/** The published template a component's own header claims. `undefined` when absent. */
export function marketplaceTemplateAddress(componentSubstate: unknown): string | undefined {
  const comp = record(record(componentSubstate)?.Component) ?? record(componentSubstate);
  const value = record(comp?.header)?.template_address;
  return typeof value === 'string' && value.length > 0 ? bareObjectKey(value) : undefined;
}

function componentHeader(componentSubstate: unknown): Record<string, unknown> | undefined {
  const comp = record(record(componentSubstate)?.Component) ?? record(componentSubstate);
  return record(comp?.header);
}

function componentState(componentSubstate: unknown): unknown[] {
  const comp = record(record(componentSubstate)?.Component) ?? record(componentSubstate);
  const state = record(comp?.body)?.state;
  if (!Array.isArray(state)) throw new MarketplaceDecodeError('Marketplace component body carries no state tuple');
  return state;
}

/**
 * `NonFungibleId` reaches this decoder in TWO different renderings, and both are real.
 *
 * Inside a component's own `body.state` it is CBOR, so it arrives as the positional enum
 * `[variantIndex, [payload]]`. The variant indices are upstream's minicbor tags
 * (crates/template_lib_types/src/substates/non_fungible.rs at v0.48.0):
 *   0 U256([u8; 32])   1 String   2 Uint32   3 Uint64
 *
 * Inside a vault's `resource_container` it is a serde-derived substate, so the same type
 * arrives as a NAMED variant object: `{"U256": "<64 hex>"}`, `{"String": "..."}`,
 * `{"Uint32": n}`, `{"Uint64": n}` (`{"U64": n}` is also accepted: it is what the v0.46
 * indexers were observed to serve).
 *
 * Both are returned as upstream's CANONICAL string (`NonFungibleId::to_canonical_string`):
 * `uuid_<hex>`, `str_<text>`, `u32_<n>`, `u64_<n>`. That is the one form the instruction
 * encoder accepts, so an id read from chain is exactly the id a withdrawal will name; two
 * different ids can never collapse to the same string (`u64_7` is not `str_7`). Anything
 * else is refused: a token id we cannot name is a token id we cannot settle.
 */
const U32_MAX = 4_294_967_295n;
const U64_MAX = 18_446_744_073_709_551_615n;

function boundedUint(value: unknown, max: bigint, what: string): string {
  const text = intString(value, what);
  if (BigInt(text) > max) throw new MarketplaceDecodeError(`${what} exceeds ${max}`);
  return String(BigInt(text));
}

function stringId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || new TextEncoder().encode(value).length > 64) {
    throw new MarketplaceDecodeError(`${what} is not a 1..64 byte string NonFungibleId`);
  }
  return `str_${value}`;
}

function u256Id(value: unknown, what: string): string {
  const hex = typeof value === 'string' ? value : record(value)?.hex;
  if (typeof hex !== 'string' || !HEX64.test(hex)) throw new MarketplaceDecodeError(`${what} is not a 32-byte U256 NonFungibleId`);
  return `uuid_${hex}`;
}

function nonFungibleId(node: unknown, what: string): string {
  const named = record(node);
  if (named !== undefined) {
    const keys = Object.keys(named);
    if (keys.length === 1) {
      if (named.String !== undefined) return stringId(named.String, what);
      if (named.U256 !== undefined) return u256Id(named.U256, what);
      if (named.Uint32 !== undefined) return `u32_${boundedUint(named.Uint32, U32_MAX, what)}`;
      if (named.Uint64 !== undefined) return `u64_${boundedUint(named.Uint64, U64_MAX, what)}`;
      if (named.U64 !== undefined) return `u64_${boundedUint(named.U64, U64_MAX, what)}`;
    }
    throw new MarketplaceDecodeError(`${what} is not a NonFungibleId variant`);
  }
  if (!Array.isArray(node) || node.length !== 2 || !Array.isArray(node[1]) || node[1].length !== 1) {
    throw new MarketplaceDecodeError(`${what} is not a NonFungibleId enum`);
  }
  const payload = node[1][0];
  switch (node[0]) {
    case 0:
      return u256Id(payload, what);
    case 1:
      return stringId(payload, what);
    case 2:
      return `u32_${boundedUint(payload, U32_MAX, what)}`;
    case 3:
      return `u64_${boundedUint(payload, U64_MAX, what)}`;
    default:
      throw new MarketplaceDecodeError(`${what} has unknown NonFungibleId variant ${JSON.stringify(node[0])}`);
  }
}

/** A decoded `NonFungibleId` node (either rendering) as upstream's canonical string. */
export const decodeNonFungibleId = (node: unknown, what = 'NonFungibleId'): string => nonFungibleId(node, what);
/** Exposed for the decoder's own tests. */
export const decodeNonFungibleIdForTest = (node: unknown): string => nonFungibleId(node, 'NonFungibleId');

/** A unit enum decodes to `[variantIndex, []]`. An out-of-range index yields `undefined`. */
function unitEnum(node: unknown, names: readonly string[], what: string): string | undefined {
  if (!Array.isArray(node) || node.length !== 2) throw new MarketplaceDecodeError(`${what} is not a unit-variant enum`);
  return names[Number(node[0])];
}

function componentAddress(node: unknown, what: string): string {
  return `component_${taggedHex(node, TAG_COMPONENT, what)}`;
}

function resourceAddress(node: unknown, what: string): string {
  return `resource_${taggedHex(node, TAG_RESOURCE, what)}`;
}

function vaultAddress(node: unknown, what: string): string {
  return `vault_${taggedHex(node, TAG_VAULT, what)}`;
}

/** What a component's escrow vault actually holds right now. */
export interface MarketplaceEscrow {
  readonly vaultAddress: string;
  readonly resourceAddress: string;
  /** Fungible amount held (revealed). Zero for an NFT escrow. */
  readonly amount: string;
  /** Non-fungible ids held. Empty for a fungible escrow. */
  readonly tokenIds: readonly string[];
  readonly empty: boolean;
}

const LISTING_STATUSES = ['ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED'] as const;
const ITEM_OFFER_STATUSES = ['ACTIVE', 'ACCEPTED', 'CANCELLED', 'EXPIRED'] as const;
const COLLECTION_BID_STATUSES = ['ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'] as const;

/** Status vocabularies in template declaration order; index N of a wire enum maps here. */
export const MARKETPLACE_STATUS_VOCABULARIES = {
  FixedPriceListing: LISTING_STATUSES,
  ItemOffer: ITEM_OFFER_STATUSES,
  CollectionBid: COLLECTION_BID_STATUSES,
} as const;

export type MarketplaceTemplateName = keyof typeof MARKETPLACE_STATUS_VOCABULARIES;

function vaultContainer(vaultSubstate: unknown, what: string): Record<string, unknown> {
  const container = record(record(record(vaultSubstate)?.Vault)?.resource_container) ?? record(record(vaultSubstate)?.resource_container);
  if (container === undefined) throw new MarketplaceDecodeError(`${what} has no resource_container`);
  return container;
}

/**
 * Read a component's escrow vault and check it holds what the component declared.
 *
 * The `expectResource` check is intrinsic, not advisory: without it a component could
 * declare one escrow resource while its vault held another, and every UI that reports
 * "escrow empty" or "escrow holds X" would be describing a lie.
 */
export async function readEscrow(reader: MarketplaceRawSubstateReader, vault: string, expectResource: string): Promise<MarketplaceEscrow> {
  const substate = await reader.read(vault);
  if (substate === undefined || substate === null) {
    throw new MarketplaceDecodeError(`Escrow vault ${vault} does not exist or could not be read`);
  }
  const container = vaultContainer(substate, vault);
  for (const kind of ['Fungible', 'Stealth', 'Confidential'] as const) {
    const inner = record(container[kind]);
    if (inner === undefined) continue;
    const address = inner.address;
    if (typeof address !== 'string' || address === '') {
      throw new MarketplaceDecodeError(`Escrow vault ${vault} carries no resource address; what it holds cannot be proven`);
    }
    if (address !== expectResource) {
      throw new MarketplaceDecodeError(`Escrow vault ${vault} holds ${address}, but the component declares ${expectResource}`);
    }
    const amount = intString(inner.amount ?? inner.revealed_amount ?? '0', `${vault}.amount`);
    return { vaultAddress: vault, resourceAddress: address, amount, tokenIds: [], empty: amount === '0' };
  }
  const nft = record(container.NonFungible);
  if (nft === undefined) {
    throw new MarketplaceDecodeError(`Escrow vault ${vault} has an unrecognised container kind (${Object.keys(container).join(',')})`);
  }
  const address = nft.address;
  if (typeof address !== 'string' || address === '') {
    throw new MarketplaceDecodeError(`Escrow vault ${vault} carries no resource address; what it holds cannot be proven`);
  }
  if (address !== expectResource) {
    throw new MarketplaceDecodeError(`Escrow vault ${vault} holds ${address}, but the component declares ${expectResource}`);
  }
  const rawIds = nft.token_ids;
  if (!Array.isArray(rawIds)) throw new MarketplaceDecodeError(`Escrow vault ${vault} carries no token_ids list`);
  const tokenIds = rawIds.map((id, index) => nonFungibleId(id, `${vault}.token_ids[${index}]`));
  return { vaultAddress: vault, resourceAddress: address, amount: '0', tokenIds, empty: tokenIds.length === 0 };
}

/**
 * The decoded settlement facts of one marketplace component, plus what its escrow
 * actually holds. `status` is the wire status; `fillable` is deliberately NOT derived
 * here, because expiry depends on the current epoch and only the caller knows it.
 */
export interface MarketplaceComponentFacts {
  readonly templateAddress: string;
  readonly escrow: MarketplaceEscrow;
  readonly listing?: Listing;
  readonly itemOffer?: ItemOffer;
  readonly collectionBid?: CollectionBid;
}

function requireTemplate(componentSubstate: unknown, expectedTemplateAddress: string, component: string): string {
  const actual = marketplaceTemplateAddress(componentSubstate);
  if (actual === undefined) {
    throw new MarketplaceDecodeError(`Component ${component} carries no template address; its identity cannot be established`);
  }
  if (actual !== bareObjectKey(expectedTemplateAddress)) {
    throw new MarketplaceDecodeError(`Component ${component} is template ${actual}, expected ${expectedTemplateAddress}`);
  }
  return actual;
}

export async function decodeListing(reader: MarketplaceRawSubstateReader, component: string, expectedTemplateAddress: string): Promise<MarketplaceComponentFacts> {
  const substate = await reader.read(component);
  if (substate === undefined || substate === null) throw new MarketplaceDecodeError(`Component ${component} does not exist or could not be read`);
  const templateAddress = requireTemplate(substate, expectedTemplateAddress, component);
  const state = componentState(substate);
  if (state.length < 8) throw new MarketplaceDecodeError(`FixedPriceListing state is not the expected 8-field tuple (got ${state.length})`);
  const nftResource = resourceAddress(state[1], 'nft_resource');
  const escrow = await readEscrow(reader, vaultAddress(state[0], 'nft_vault'), nftResource);
  const status = unitEnum(state[7], LISTING_STATUSES, 'listing status');
  const expiresAtEpoch = intString(state[6], 'expires_at_epoch');
  // A listing is only fillable when the wire says Active AND it has not reached expiry.
  const expired = expiresAtEpoch !== '0' && BigInt(expiresAtEpoch) <= BigInt(currentEpoch);
if (status === undefined) throw new MarketplaceDecodeError(`Listing status enum index is outside the declared vocabulary ${LISTING_STATUSES.join('|')}`);
  const effectiveStatus = status === 'ACTIVE' && expired ? 'EXPIRED' : status;
const listing: Listing = {
    listingAddress: component,
    sellerAccount: componentAddress(state[5], 'seller_account'),
    collectionResource: nftResource,
    nftId: nonFungibleId(state[2], 'nft_id'),
    quoteResource: resourceAddress(state[3], 'quote_resource'),
    price: intString(state[4], 'price'),
    expiresAtEpoch,
    status: effectiveStatus as Listing['status'],
  };
  return { templateAddress, escrow, listing };
}

export async function decodeItemOffer(reader: MarketplaceRawSubstateReader, component: string, expectedTemplateAddress: string): Promise<MarketplaceComponentFacts> {
  const substate = await reader.read(component);
  if (substate === undefined || substate === null) throw new MarketplaceDecodeError(`Component ${component} does not exist or could not be read`);
  const templateAddress = requireTemplate(substate, expectedTemplateAddress, component);
  const state = componentState(substate);
  if (state.length < 9) throw new MarketplaceDecodeError(`ItemOffer state is not the expected 9-field tuple (got ${state.length})`);
  const quoteResource = resourceAddress(state[4], 'quote_resource');
  const escrow = await readEscrow(reader, vaultAddress(state[0], 'quote_vault'), quoteResource);
  const expiresAtEpoch = intString(state[7], 'expires_at_epoch');
  const status = unitEnum(state[8], ITEM_OFFER_STATUSES, 'offer status');
  const expired = expiresAtEpoch !== '0' && BigInt(expiresAtEpoch) <= BigInt(currentEpoch);
if (status === undefined) throw new MarketplaceDecodeError(`Offer status enum index is outside the declared vocabulary ${ITEM_OFFER_STATUSES.join('|')}`);
  const effectiveStatus = status === 'ACTIVE' && expired ? 'EXPIRED' : status;
const itemOffer: ItemOffer = {
    offerAddress: component,
    buyerAccount: componentAddress(state[1], 'buyer_account'),
    collectionResource: resourceAddress(state[2], 'nft_resource'),
    nftId: nonFungibleId(state[3], 'nft_id'),
    quoteResource,
    amount: intString(state[5], 'offer_amount'),
    createdAtEpoch: intString(state[6], 'created_at_epoch'),
    expiresAtEpoch,
    status: effectiveStatus as ItemOffer['status'],
  };
  return { templateAddress, escrow, itemOffer };
}

export async function decodeCollectionBid(reader: MarketplaceRawSubstateReader, component: string, expectedTemplateAddress: string): Promise<MarketplaceComponentFacts> {
  const substate = await reader.read(component);
  if (substate === undefined || substate === null) throw new MarketplaceDecodeError(`Component ${component} does not exist or could not be read`);
  const templateAddress = requireTemplate(substate, expectedTemplateAddress, component);
  const state = componentState(substate);
  if (state.length < 12) throw new MarketplaceDecodeError(`CollectionBid state is not the expected 12-field tuple (got ${state.length})`);
  const quoteResource = resourceAddress(state[3], 'quote_resource');
  const escrow = await readEscrow(reader, vaultAddress(state[0], 'quote_vault'), quoteResource);
  const expiresAtEpoch = intString(state[10], 'expires_at_epoch');
  const status = unitEnum(state[11], COLLECTION_BID_STATUSES, 'bid status');
const expired = expiresAtEpoch !== '0' && BigInt(expiresAtEpoch) <= BigInt(currentEpoch);
  if (status === undefined) throw new MarketplaceDecodeError(`Bid status enum index is outside the declared vocabulary ${COLLECTION_BID_STATUSES.join('|')}`);
  const effectiveStatus = status === 'ACTIVE' || status === 'PARTIALLY_FILLED' ? (expired ? 'EXPIRED' : status) : status;
const collectionBid: CollectionBid = {
    bidAddress: component,
    buyerAccount: componentAddress(state[1], 'buyer_account'),
    collectionResource: resourceAddress(state[2], 'collection'),
    quoteResource,
    pricePerNft: intString(state[4], 'price_per_nft'),
    originalQuantity: intString(state[5], 'original_quantity'),
    remainingQuantity: intString(state[6], 'remaining_quantity'),
    originalEscrow: intString(state[7], 'original_escrow'),
    remainingEscrow: intString(state[8], 'remaining_escrow'),
    createdAtEpoch: intString(state[9], 'created_at_epoch'),
    expiresAtEpoch,
    status: effectiveStatus as CollectionBid['status'],
  };
  return { templateAddress, escrow, collectionBid };
}

/**
 * The consensus epoch to judge expiry against.
 *
 * Kept as a single module-level fact with an explicit setter rather than a hidden global:
 * expiry is a function of TIME, so a decoder that silently assumed "now" would make a
 * read non-reproducible. A caller that cannot supply an epoch gets the wire status
 * (expiry already applied on chain) instead of a guess.
 */
let currentEpoch = '0';

export function setMarketplaceCurrentEpoch(epoch: string | number | bigint): void {
  const text = typeof epoch === 'bigint' ? epoch.toString() : String(epoch);
  if (!/^\d+$/.test(text)) throw new MarketplaceDecodeError(`current epoch must be a non-negative integer, got ${JSON.stringify(epoch)}`);
  currentEpoch = text;
}

export function marketplaceCurrentEpoch(): string {
  return currentEpoch;
}

export function resetMarketplaceCurrentEpoch(): void {
  currentEpoch = '0';
}

/** Human-readable identity facts read from a component's own header. Never from its creator. */
export interface MarketplaceComponentHeader {
  readonly templateAddress?: string;
  readonly ownerRule?: string;
  readonly defaultRule?: string;
  readonly methodAccess: Readonly<Record<string, unknown>>;
}

export function decodeComponentHeader(componentSubstate: unknown): MarketplaceComponentHeader {
  const header = componentHeader(componentSubstate);
  const rules = record(header?.access_rules);
  return {
    ...(marketplaceTemplateAddress(componentSubstate) !== undefined ? { templateAddress: marketplaceTemplateAddress(componentSubstate) } : {}),
    ...(typeof header?.owner_rule === 'string' ? { ownerRule: header.owner_rule } : {}),
    ...(typeof rules?.default === 'string' ? { defaultRule: rules.default } : {}),
    methodAccess: (record(rules?.method_access) ?? {}) as Record<string, unknown>,
  };
}