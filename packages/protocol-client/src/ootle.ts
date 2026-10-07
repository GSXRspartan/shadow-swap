/**
 * Concrete Ootle readback provider for authoritative chain reads.
 *
 * Transport is injected (`AuthoritativeSubstateReader`): walletd, an embedded wallet, or a
 * browser provider implements it. Indexers must NOT be plugged in here — discovery stays in
 * the discovery providers.
 *
 * All on-chain amounts are decimal strings (u64/u128 raw units). No JS number ever carries
 * an on-chain value.
 */
import {
  ExecutionAuthoritativeRead,
  Freshness,
  FreshnessIdentity,
  isAuthoritativeSource,
  ReadSource,
} from './execution.js';
import { Listing, ItemOffer, CollectionBid } from './marketplace.js';
import { decodePoolState } from './poolSubstate.js';

// ---------------------------------------------------------------------------
// Pool readback
// ---------------------------------------------------------------------------

export interface PoolState {
  poolComponent: string;
  /** Canonical (engine-ordered) resource pair — identity is the exact ResourceAddress. */
  resourceA: string;
  resourceB: string;
  reserveA: string;
  reserveB: string;
  feeBps: string;
  lpResource: string;
  totalLpSupply: string;
  lockedLpSupply: string;
}

export type PoolReadStatus = 'ACTIVE' | 'STALE' | 'UNAVAILABLE' | 'CONFLICTED';

export interface OotleSubstateEnvelope {
  /** Component or resource address actually read. */
  address: string;
  /** Template name the component instantiates (must match exactly — never by symbol). */
  templateName?: string;
  /** Engine-exposed state version / component version, when available. */
  substateVersion?: string;
  producingTxHash?: string;
  epoch?: string;
  /** The authoritative payload as returned by the transport (template fields, stringified). */
  fields: Record<string, string>;
}

/**
 * The minimal authoritative transport. Implementations: walletd RPC, wallet-daemon, browser
 * extension provider, or a test double. Must return the CURRENT committed component state.
 */
export interface AuthoritativeSubstateReader {
  readComponent(address: string): Promise<OotleSubstateEnvelope | undefined>;
  readResource?(address: string): Promise<OotleSubstateEnvelope | undefined>;
  /**
   * RAW substate read: the full `{ Component|Vault|Resource: {...} }` value, with
   * nested structures intact. Required for the real Pool decode (reserves live in
   * vault substates). When present, `readPool` uses the multi-substate decoder; when
   * absent, it falls back to the legacy flat-field envelope path (test doubles).
   */
  readRaw?(address: string): Promise<unknown>;
}

function freshness(envelope: EnvelopeInput): Freshness {
  const identity: FreshnessIdentity = {
    substateVersion: envelope.substateVersion,
    producingTxHash: envelope.producingTxHash,
    epoch: envelope.epoch,
    stateIdentity: envelope.templateName ? `${envelope.address}@${envelope.templateName}` : envelope.address,
    readAtUnixMs: Date.now(),
  };
  return { source: envelope.source, identity };
}

type EnvelopeInput = OotleSubstateEnvelope & { source: ReadSource };

/** Field accessors: the transport stringifies everything; parse strictly. */
function field(envelope: EnvelopeInput, name: string): string {
  const raw = envelope.fields[name];
  if (raw === undefined || raw === null) throw new Error(`Authoritative read of ${envelope.address} is missing field ${name}`);
  return String(raw);
}

/**
 * A numeric field from the authoritative transport.
 *
 * The transport stringifies everything, so a field that should be a `u128` can
 * arrive as `"abc"`, `"1.5"`, or `"-3"`. `parsePoolState` is the boundary every
 * resolver reads from, so validating here removes a whole class of `BigInt(...)`
 * throws (and BigInt division-by-zero) from the execution path instead of
 * scattering guards through each resolver.
 */
function numericField(envelope: EnvelopeInput, name: string): string {
  const raw = field(envelope, name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Authoritative read of ${envelope.address} has a malformed ${name}: ${JSON.stringify(raw)} is not a non-negative integer string`);
  }
  return raw;
}


/** Readback provider interface for pools (separate from any pool discovery/search). */
export interface PoolReadbackProvider {
  readPool(poolComponent: string): Promise<ExecutionAuthoritativeRead<PoolState>>;
}

export function parsePoolState(envelope: EnvelopeInput): PoolState {
  const state: PoolState = {
    poolComponent: envelope.address,
    resourceA: field(envelope, 'resource_a'),
    resourceB: field(envelope, 'resource_b'),
    reserveA: numericField(envelope, 'reserve_a'),
    reserveB: numericField(envelope, 'reserve_b'),
    feeBps: numericField(envelope, 'fee_bps'),
    lpResource: field(envelope, 'lp_resource'),
    totalLpSupply: numericField(envelope, 'total_lp_supply'),
    lockedLpSupply: numericField(envelope, 'locked_lp_supply'),
  };
  return state;
}

export interface OotleReadbackProvider extends PoolReadbackProvider {
  readListing(listingAddress: string): Promise<ExecutionAuthoritativeRead<Listing>>;
  readItemOffer(offerAddress: string): Promise<ExecutionAuthoritativeRead<ItemOffer>>;
  readCollectionBid(bidAddress: string): Promise<ExecutionAuthoritativeRead<CollectionBid>>;
}

/**
 * Production readback provider over the injected authoritative reader.
 * Template identity is checked by NAME at the component level; resource identity is always
 * the exact address carried in the payload.
 */
export function createOotleReadbackProvider(reader: AuthoritativeSubstateReader, source: ReadSource): OotleReadbackProvider {
  if (!isAuthoritativeSource(source)) {
    throw new Error('Ootle readback must be backed by an authoritative source (CHAIN_NODE or WALLET_PROVIDER)');
  }
  async function readEnvelope(address: string, expectedTemplate: string): Promise<ExecutionAuthoritativeRead<EnvelopeInput>> {
    let envelope: OotleSubstateEnvelope | undefined;
    try {
      envelope = await reader.readComponent(address);
    } catch (error) {
      return { status: 'UNAVAILABLE', reason: `Authoritative read failed: ${(error as Error).message}` };
    }
    if (!envelope) return { status: 'UNAVAILABLE', reason: `Component ${address} does not exist` };
    if (expectedTemplate && envelope.templateName && envelope.templateName !== expectedTemplate) {
      return { status: 'UNAVAILABLE', reason: `Component ${address} is template ${envelope.templateName}, expected ${expectedTemplate}` };
    }
    const withSource: EnvelopeInput = { ...envelope, source };
    return { status: 'FOUND', value: withSource, freshness: freshness(withSource) };
  }
  return {
    async readPool(poolComponent: string): Promise<ExecutionAuthoritativeRead<PoolState>> {
      // Preferred path: the published Pool keeps reserves in VAULT substates and LP
      // supply in the LP RESOURCE substate, so decode the real multi-substate state
      // via the RAW reader. The legacy flat-field `parsePoolState` is kept only for
      // readers without `readRaw` (test doubles that supply a pre-decoded envelope).
      if (typeof reader.readRaw === 'function') {
        try {
          const value = await decodePoolState({ read: (address) => reader.readRaw!(address) }, poolComponent);
          const fresh = freshness({ address: poolComponent, source, templateName: 'Pool', fields: {} });
          return { status: 'FOUND', value, freshness: fresh };
        } catch (error) {
          // Fail-closed: a missing/malformed substate is UNAVAILABLE, never a fabricated pool.
          return { status: 'UNAVAILABLE', reason: (error as Error).message };
        }
      }
      const read = await readEnvelope(poolComponent, 'Pool');
      if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: read.reason };
      try {
        return { status: 'FOUND', value: parsePoolState(read.value), freshness: read.freshness };
      } catch (error) {
        return { status: 'UNAVAILABLE', reason: (error as Error).message };
      }
    },
    async readListing(address: string): Promise<ExecutionAuthoritativeRead<Listing>> {
      const read = await readEnvelope(address, 'FixedPriceListing');
      if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: read.reason };
      const e = read.value;
      const parsedStatus = parseStatus(field(e, 'status'), LISTING_STATUSES, 'listing');
      if (!parsedStatus.ok) return { status: 'UNAVAILABLE', reason: parsedStatus.reason };
      return {
        status: 'FOUND',
        value: {
          listingAddress: e.address,
          sellerAccount: field(e, 'seller_account'),
          collectionResource: field(e, 'collection_resource'),
          nftId: field(e, 'nft_id'),
          quoteResource: field(e, 'quote_resource'),
          price: field(e, 'price'),
          createdAtEpoch: optionalField(e, 'created_at_epoch'),
          expiresAtEpoch: field(e, 'expires_at_epoch'),
          status: parsedStatus.value,
        },
        freshness: read.freshness,
      };
    },
    async readItemOffer(address: string): Promise<ExecutionAuthoritativeRead<ItemOffer>> {
      const read = await readEnvelope(address, 'ItemOffer');
      if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: read.reason };
      const e = read.value;
      const parsedStatus = parseStatus(field(e, 'status'), ITEM_OFFER_STATUSES, 'item-offer');
      if (!parsedStatus.ok) return { status: 'UNAVAILABLE', reason: parsedStatus.reason };
      return {
        status: 'FOUND',
        value: {
          offerAddress: e.address,
          buyerAccount: field(e, 'buyer_account'),
          collectionResource: field(e, 'collection_resource'),
          nftId: field(e, 'nft_id'),
          quoteResource: field(e, 'quote_resource'),
          amount: field(e, 'amount'),
          createdAtEpoch: field(e, 'created_at_epoch'),
          expiresAtEpoch: field(e, 'expires_at_epoch'),
          status: parsedStatus.value,
        },
        freshness: read.freshness,
      };
    },
    async readCollectionBid(address: string): Promise<ExecutionAuthoritativeRead<CollectionBid>> {
      const read = await readEnvelope(address, 'CollectionBid');
      if (read.status === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: read.reason };
      const e = read.value;
      const parsedStatus = parseStatus(field(e, 'status'), COLLECTION_BID_STATUSES, 'collection-bid');
      if (!parsedStatus.ok) return { status: 'UNAVAILABLE', reason: parsedStatus.reason };
      return {
        status: 'FOUND',
        value: {
          bidAddress: e.address,
          buyerAccount: field(e, 'buyer_account'),
          collectionResource: field(e, 'collection_resource'),
          quoteResource: field(e, 'quote_resource'),
          pricePerNft: field(e, 'price_per_nft'),
          originalQuantity: field(e, 'original_quantity'),
          remainingQuantity: field(e, 'remaining_quantity'),
          originalEscrow: field(e, 'original_escrow'),
          remainingEscrow: field(e, 'remaining_escrow'),
          createdAtEpoch: field(e, 'created_at_epoch'),
          expiresAtEpoch: field(e, 'expires_at_epoch'),
          status: parsedStatus.value,
        },
        freshness: read.freshness,
      };
    },
  };
}

function optionalField(e: EnvelopeInput, name: string): string | undefined {
  const raw = e.fields[name];
  return raw === undefined || raw === null ? undefined : String(raw);
}

/**
 * Parse a component's status field WITHOUT a default.
 *
 * The previous helper normalised any unrecognized status string to the most
 * permissive value (`ACTIVE`), so a malformed, future, or tampered readback
 * reporting `"active"`, `"OPEN"`, or `"PENDING_SETTLEMENT"` would present an
 * unknown component state as executable. The authoritative outcome is still the
 * chain's (the template re-asserts its own status), but the readback boundary —
 * whose entire job is to refuse states it cannot vouch for — must never
 * normalise toward execution. An unrecognized status is therefore UNAVAILABLE,
 * the same typed outcome as any other unreadable component.
 */
function parseStatus<T extends string>(raw: string, allowed: readonly T[], what: string): { ok: true; value: T } | { ok: false; reason: string } {
  if ((allowed as readonly string[]).includes(raw)) return { ok: true, value: raw as T };
  return { ok: false, reason: `Authoritative read reports an unrecognized ${what} status ${JSON.stringify(raw)} — refusing to normalize an unknown state toward execution` };
}

const LISTING_STATUSES = ['ACTIVE', 'SOLD', 'CANCELLED', 'EXPIRED'] as const;
const ITEM_OFFER_STATUSES = ['ACTIVE', 'ACCEPTED', 'CANCELLED', 'EXPIRED'] as const;
const COLLECTION_BID_STATUSES = ['ACTIVE', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'] as const;


