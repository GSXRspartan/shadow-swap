/**
 * Cross-layer maker offers: the difference between liquidity that is ADVERTISED and liquidity
 * that can actually settle.
 *
 * This module exists because of one failure mode. A venue that shows a user "1,000,000 XTM
 * available" when nothing is escrowed has told them something false at the exact moment they are
 * deciding to lock their own funds — and in a cross-layer trade the user's leg is irreversible
 * once the counterparty claims it. So the states below are not presentation detail: `EXECUTABLE`
 * is a claim about on-chain reality, and every weaker state must be visibly weaker.
 *
 * THE FIVE STATES, as the brief requires them:
 *
 *   1. `INDICATIVE`     a price a maker published. Evidence: none. Not a commitment.
 *   2. `SIGNED`         the maker signed those terms. Proves authorship and intent, NOT funds.
 *   3. `FUNDED`         an escrow holding the advertised asset was READ FROM CHAIN.
 *   4. `RESERVED`       funded, and allocated to one taker for a bounded window.
 *   5. `SETTLED`        claimed or refunded. Terminal.
 *
 * A FUNDED OFFER IS NOT OPEN INVENTORY. This corrects the shape this module shipped with, which
 * said "only `FUNDED` is offerable to a new taker". It cannot be. `CrossLayerHtlc::fund` fixes
 * the claimant's key at fund time (`.method("claim", rule!(public_key(claimant)))`) and `claim`
 * does `escrow.withdraw_all()`; the L1 script's claim branch is the same shape,
 * `PushPubKey(destination)`. So an escrow is claimable by exactly ONE named key, exactly ONCE,
 * in full. A pre-funded escrow waiting for whoever turns up does not exist on either chain, and
 * neither does a partial fill of one.
 *
 * Two things follow, and they shape the whole maker side:
 *
 *   * `FUNDED` means "escrowed and already bound to one counterparty". The taker it names is the
 *     only taker it is executable for, which is what `isOfferableTo` asks.
 *   * What a maker publishes to an open market is therefore INDICATIVE or SIGNED, always. The
 *     escrow comes into existence only after a specific taker is matched, so the maker's
 *     unescrowed inventory is the thing that has to be accounted for. That is `makerBook.ts`,
 *     which is also what stops two matched takers being promised the same coins.
 *
 * `isExecutable` remains the liveness predicate (escrowed, unexpired, still covering a minimum
 * fill). `isOfferableTo` adds the binding, and is the single predicate a UI may use to say "you
 * can trade this now".
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *
 *   * It never treats a maker's own statement of their balance as inventory. A wallet balance is
 *     not an escrow: the maker can spend it, and a cross-layer settlement cannot claw it back.
 *     Inventory is what an escrow holds, full stop.
 *   * It grants no blanket approval and no automatic replenishment. Each offer is bounded by the
 *     escrow that backs it, so the worst case for a maker is the loss of one offer's escrow.
 *   * It holds no keys and signs nothing.
 */

import { type SwapDirection, DIRECTIONS } from './atomicSwap.js';

export type OfferState = 'INDICATIVE' | 'SIGNED' | 'FUNDED' | 'RESERVED' | 'SETTLED';

/** Ordered weakest to strongest, so a UI can sort and a test can assert monotonicity. */
export const OFFER_STATES: readonly OfferState[] = [
  'INDICATIVE',
  'SIGNED',
  'FUNDED',
  'RESERVED',
  'SETTLED',
];

/**
 * What a maker publishes. All amounts are RAW INTEGER STRINGS in the asset's smallest unit:
 * cross-layer pricing compares two chains' units, and a float would make a rounding error into
 * a loss that one side silently absorbs.
 */
export interface OfferTerms {
  readonly offerId: string;
  readonly direction: SwapDirection;
  /** Network generation this offer is valid on. An offer must never replay across networks. */
  readonly network: string;
  /** Raw amount the maker will pay out, in the asset the taker receives. */
  readonly inventoryRaw: string;
  /** Smallest and largest fill the maker will accept, raw. */
  readonly minFillRaw: string;
  readonly maxFillRaw: string;
  /** Maker's L1 and L2 identities. Both are needed: a cross-layer trade touches both. */
  readonly makerL1Address: string;
  readonly makerL2PublicKey: string;
  /** Absolute L2 epoch after which the offer may not be taken. */
  readonly expiresAtEpoch: number;
}

/** Evidence that an escrow exists on chain, as read back — never as asserted by the maker. */
export interface FundingEvidence {
  /** The L2 escrow component, or the L1 output hash, depending on which leg the maker funds. */
  readonly leg: string;
  /** The amount the escrow actually holds, raw, from an authoritative read. */
  readonly escrowedRaw: string;
  /** Which chain the maker's own escrow sits on, derived from the direction — not supplied. */
  readonly chain: 'L1' | 'L2';
  /**
   * The key the escrow NAMES as its claimant, read from the escrow itself. Required: neither
   * chain can produce an escrow without one, and an offer whose binding is unknown must never
   * be shown as tradeable to anybody.
   */
  readonly boundClaimant: string;
  /** The read's own identity, so a stale read cannot masquerade as current. */
  readonly readAtEpoch: number;
}

export interface Reservation {
  readonly takerId: string;
  readonly amountRaw: string;
  /** Absolute L2 epoch at which an unsettled reservation lapses and the offer is offerable again. */
  readonly expiresAtEpoch: number;
}

export interface MakerOffer {
  readonly terms: OfferTerms;
  readonly state: OfferState;
  readonly signature?: string;
  readonly funding?: FundingEvidence;
  readonly reservation?: Reservation;
  readonly settlement?: 'CLAIMED' | 'REFUNDED';
  /** Why this offer is not executable, when it is not. Shown verbatim. */
  readonly reason?: string;
}

/** Which chain the MAKER escrows on, for a direction. Derived, never taken as input. */
export function makerEscrowChain(direction: SwapDirection): 'L1' | 'L2' {
  const shape = DIRECTIONS[direction];
  if (shape === undefined) throw new Error(`unknown direction ${direction}`);
  return shape.l1FundedBy === 'MAKER' ? 'L1' : 'L2';
}

function assertRaw(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a raw non-negative integer string`);
  return BigInt(value);
}

/** An indicative quote: a price, and nothing more. */
export function indicative(terms: OfferTerms): MakerOffer {
  const inventory = assertRaw(terms.inventoryRaw, 'inventoryRaw');
  const min = assertRaw(terms.minFillRaw, 'minFillRaw');
  const max = assertRaw(terms.maxFillRaw, 'maxFillRaw');
  if (!(min > 0n)) throw new Error('minFillRaw must be positive: a zero-size fill is not a trade');
  if (max < min) throw new Error('maxFillRaw must be at least minFillRaw');
  if (inventory < min) throw new Error('inventoryRaw must cover at least one minimum fill');
  if (!Number.isInteger(terms.expiresAtEpoch) || terms.expiresAtEpoch <= 0) {
    throw new Error('expiresAtEpoch must be a positive absolute L2 epoch');
  }
  if (terms.network.length === 0) throw new Error('an offer must name the network it is valid on');
  return {
    terms,
    state: 'INDICATIVE',
    reason:
      'Indicative only: the maker has published a price but nothing is escrowed, so this cannot be traded. Nothing on chain backs it yet.',
  };
}

/** The maker signed their own terms. Authorship and intent — still not funds. */
export function signed(offer: MakerOffer, signature: string): MakerOffer {
  if (offer.state !== 'INDICATIVE') return offer;
  if (signature.length === 0) throw new Error('a signature is required to advance past INDICATIVE');
  return {
    ...offer,
    state: 'SIGNED',
    signature,
    reason:
      'Signed by the maker, but still not funded: a signature proves who published these terms, not that any asset is escrowed. This cannot be traded.',
  };
}

/**
 * Promotes to FUNDED, and ONLY on evidence read from chain.
 *
 * The checks here are the ones a maker could otherwise get wrong in their own favour: an escrow
 * on the wrong chain, holding less than advertised, or read at an epoch that has already passed
 * the offer's expiry.
 */
export function funded(
  offer: MakerOffer,
  evidence: FundingEvidence,
): MakerOffer {
  if (offer.state !== 'SIGNED' && offer.state !== 'FUNDED') return offer;
  const expectedChain = makerEscrowChain(offer.terms.direction);
  if (evidence.chain !== expectedChain) {
    return {
      ...offer,
      state: 'SIGNED',
      reason: `The escrow is on ${evidence.chain}, but for a ${offer.terms.direction} trade the maker must escrow on ${expectedChain}. Not executable.`,
    };
  }
  if (evidence.leg.length === 0) {
    return { ...offer, state: 'SIGNED', reason: 'The funding evidence names no escrow. Not executable.' };
  }
  if (evidence.boundClaimant.length === 0) {
    return {
      ...offer,
      state: 'SIGNED',
      reason:
        'The funding evidence does not say which key the escrow names as its claimant. An escrow is claimable by exactly one named key, so until that is read from chain this offer is tradeable by nobody.',
    };
  }
  const escrowed = assertRaw(evidence.escrowedRaw, 'escrowedRaw');
  const min = BigInt(offer.terms.minFillRaw);
  if (escrowed < min) {
    return {
      ...offer,
      state: 'SIGNED',
      reason: `The escrow holds ${evidence.escrowedRaw}, below the offer's own minimum fill of ${offer.terms.minFillRaw}. Not executable.`,
    };
  }
  if (evidence.readAtEpoch >= offer.terms.expiresAtEpoch) {
    return {
      ...offer,
      state: 'SIGNED',
      reason: `The offer expired at epoch ${offer.terms.expiresAtEpoch} and the escrow was read at ${evidence.readAtEpoch}. Not executable.`,
    };
  }
  // An escrow holding LESS than advertised is not a failure — it is the real inventory. The
  // advertised figure is demoted to it rather than the offer being rejected, because a maker
  // partially filling their own offer is normal and the smaller number is the honest one.
  const advertised = BigInt(offer.terms.inventoryRaw);
  const realInventory = escrowed < advertised ? evidence.escrowedRaw : offer.terms.inventoryRaw;
  return {
    terms: { ...offer.terms, inventoryRaw: realInventory },
    state: 'FUNDED',
    ...(offer.signature === undefined ? {} : { signature: offer.signature }),
    funding: evidence,
  };
}

/** Reserves part of a funded offer for one taker, for a bounded window. */
export function reserve(offer: MakerOffer, reservation: Reservation): MakerOffer {
  if (offer.state !== 'FUNDED') {
    return { ...offer, reason: `Only a FUNDED offer can be reserved; this one is ${offer.state}.` };
  }
  const amount = assertRaw(reservation.amountRaw, 'amountRaw');
  const min = BigInt(offer.terms.minFillRaw);
  const max = BigInt(offer.terms.maxFillRaw);
  const inventory = BigInt(offer.terms.inventoryRaw);
  if (amount < min || amount > max) {
    return { ...offer, reason: `A fill must be between ${offer.terms.minFillRaw} and ${offer.terms.maxFillRaw}; ${reservation.amountRaw} is not.` };
  }
  if (amount > inventory) {
    return { ...offer, reason: `The offer's escrow holds ${offer.terms.inventoryRaw}; ${reservation.amountRaw} cannot be reserved.` };
  }
  if (reservation.expiresAtEpoch > offer.terms.expiresAtEpoch) {
    return { ...offer, reason: `A reservation cannot outlive its offer (epoch ${offer.terms.expiresAtEpoch}).` };
  }
  return { ...offer, state: 'RESERVED', reservation };
}

/** A lapsed reservation returns the offer to FUNDED; it never silently extends. */
export function expireReservation(offer: MakerOffer, currentEpoch: number): MakerOffer {
  if (offer.state !== 'RESERVED' || offer.reservation === undefined) return offer;
  if (currentEpoch < offer.reservation.expiresAtEpoch) return offer;
  const { reservation: _lapsed, ...rest } = offer;
  return { ...rest, state: 'FUNDED' };
}

/** Terminal. A settled offer is never executable again, whichever way it ended. */
export function settle(offer: MakerOffer, outcome: 'CLAIMED' | 'REFUNDED'): MakerOffer {
  if (offer.state === 'SETTLED') return offer;
  return {
    ...offer,
    state: 'SETTLED',
    settlement: outcome,
    reason: `This offer is settled (${outcome.toLowerCase()}) and cannot be traded again.`,
  };
}

/**
 * The ONE predicate a UI may use to tell a user they can trade now.
 *
 * Deliberately not a state comparison at the call site: scattering `state === 'FUNDED'` through a
 * UI is how an unfunded offer eventually gets a button.
 */
export function isExecutable(offer: MakerOffer, currentEpoch: number): boolean {
  if (offer.state !== 'FUNDED' && offer.state !== 'RESERVED') return false;
  if (offer.funding === undefined) return false;
  if (currentEpoch >= offer.terms.expiresAtEpoch) return false;
  return BigInt(offer.terms.inventoryRaw) >= BigInt(offer.terms.minFillRaw);
}

/**
 * The ONE predicate a UI may use to tell a PARTICULAR user they can trade now.
 *
 * `isExecutable` says the escrow is live; this adds the part that decides whether this user can
 * take it. Both legs name their claimant at fund time, so an escrow bound to somebody else is
 * worth exactly nothing to this user — and showing it as available liquidity would be the same
 * lie as showing an unfunded offer, with the added sting that the user could fund their own leg
 * against an escrow they can never claim.
 */
export function isOfferableTo(offer: MakerOffer, currentEpoch: number, takerL2PublicKey: string): boolean {
  if (!isExecutable(offer, currentEpoch)) return false;
  const bound = offer.funding?.boundClaimant;
  if (bound === undefined || bound.length === 0) return false;
  if (takerL2PublicKey.length === 0) return false;
  return bound.toLowerCase() === takerL2PublicKey.toLowerCase();
}

/** What a taker may still take right now, raw. Zero when nothing is takeable. */
export function availableRaw(offer: MakerOffer, currentEpoch: number): string {
  if (!isExecutable(offer, currentEpoch)) return '0';
  const inventory = BigInt(offer.terms.inventoryRaw);
  if (offer.state === 'RESERVED' && offer.reservation !== undefined) {
    if (currentEpoch < offer.reservation.expiresAtEpoch) {
      const left = inventory - BigInt(offer.reservation.amountRaw);
      return left > 0n ? left.toString() : '0';
    }
  }
  return inventory.toString();
}

/** One line for a UI, stating the evidence rather than implying more than exists. */
export function describeOffer(offer: MakerOffer, currentEpoch: number): string {
  if (offer.state === 'SETTLED') return offer.reason ?? 'Settled.';
  if (!isExecutable(offer, currentEpoch)) {
    return offer.reason ?? `Not executable: the offer is ${offer.state}.`;
  }
  const chain = makerEscrowChain(offer.terms.direction);
  const where = chain === 'L1' ? 'an L1 output' : 'an L2 escrow component';
  return `Escrowed and bound: ${availableRaw(offer, currentEpoch)} is held in ${where} (${offer.funding?.leg}), read from chain at epoch ${offer.funding?.readAtEpoch}, claimable only by ${offer.funding?.boundClaimant}, and the offer runs to epoch ${offer.terms.expiresAtEpoch}.`;
}
