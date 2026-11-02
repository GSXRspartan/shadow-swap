/**
 * The maker's inventory ledger: what they actually hold, what they have already promised, and
 * the one rule that cannot be allowed to break — that two matched takers are never promised the
 * same coins.
 *
 * WHY THIS MODULE IS SHAPED LIKE THIS, AND NOT LIKE AN ORDER BOOK
 *
 * A cross-layer escrow names its claimant when it is funded. `CrossLayerHtlc::fund` writes the
 * claimant's key into the component's access rules and `claim` does `escrow.withdraw_all()`; the
 * L1 script's claim branch is `PushPubKey(destination)`. And the funding order is forced: the L1
 * wallet GENERATES the preimage, so the L1 leg is always first and the second leg can only be
 * built once the first leg's hash exists.
 *
 * Together those mean there is no such thing as a pool of pre-funded escrows waiting for whoever
 * turns up, and no partial fill of one. An escrow exists only after a specific taker is matched,
 * for exactly that taker, for exactly one trade.
 *
 * So a maker's published offer is an ADVERTISEMENT, always — and the thing that has to be
 * accounted for is the maker's own unescrowed balance, which they can spend at any moment and
 * which no settlement can claw back. That is what this module tracks:
 *
 *   observation   a balance READ from chain (or from the local L1 wallet). Never typed in.
 *   commitment    the maker has promised a payout to one named taker, from that balance.
 *   escrow        the commitment's funds have left the balance into an on-chain escrow.
 *   settlement    terminal: the taker claimed it, the maker refunded it, or it lapsed unescrowed.
 *
 * THE DOUBLE-PROMISE GUARD is `commit`, and it is the only way a commitment can be created.
 * It refuses any promise that the last chain read cannot cover once every live promise is
 * subtracted, so the worst case is a refusal rather than a maker who cannot pay the second taker.
 *
 * WHAT THIS MODULE REFUSES TO DO
 *
 *   * It never treats a maker's typed-in figure as inventory. Only an observation counts.
 *   * It never credits inventory on settlement. Coins arriving on the other chain are a fact
 *     about that chain, and only a read of that chain may record them.
 *   * It never returns escrowed funds to available inventory when a deadline passes. An expired
 *     escrow is RECOVERABLE, which means a refund transaction still has to be signed and land.
 *   * It holds no keys, signs nothing, and has no automatic replenishment or blanket approval.
 */

import { type SwapDirection } from './atomicSwap.js';
import {
  type FundingEvidence,
  type MakerOffer,
  type OfferTerms,
  indicative,
  makerEscrowChain,
  signed,
} from './makerOffer.js';
import { type ChainPosition } from './swapLifecycle.js';

export type Chain = 'L1' | 'L2';

/** A balance read. `reference` says what was read, so a wrong or stale read is attributable. */
export interface InventoryObservation {
  readonly chain: Chain;
  /** The L2 account component and resource, or the local L1 wallet's identity. */
  readonly reference: string;
  /** Spendable balance the read returned, raw. Locked or unconfirmed value must be excluded. */
  readonly balanceRaw: string;
  /** The L2 epoch the read was taken at, for both chains, so ages are comparable. */
  readonly readAtEpoch: number;
}

/**
 * `COMMITTED`  promised to one taker, still in the maker's wallet. Reversible by lapsing.
 * `ESCROWED`   funded into an on-chain escrow bound to that taker. No longer the maker's to spend.
 * `SETTLED`    the taker claimed it. Terminal.
 * `REFUNDED`   the maker recovered it after the deadline, and a refund transaction landed.
 * `LAPSED`     the promise expired before any escrow existed. Nothing left the wallet.
 */
export type CommitmentState = 'COMMITTED' | 'ESCROWED' | 'SETTLED' | 'REFUNDED' | 'LAPSED';

export interface Commitment {
  readonly commitmentId: string;
  readonly offerId: string;
  readonly direction: SwapDirection;
  /** Both identities: a cross-layer trade touches both chains, and the escrow names the L2 key. */
  readonly takerL2PublicKey: string;
  readonly takerL1Address: string;
  /** The chain the maker PAYS OUT on, derived from the direction. */
  readonly payOutChain: Chain;
  readonly payOutRaw: string;
  /** What the maker expects to receive on the other chain. Recorded, never assumed received. */
  readonly takeInRaw: string;
  readonly committedAtEpoch: number;
  /** The epoch at which an unescrowed commitment lapses and its inventory is free again. */
  readonly expiresAtEpoch: number;
  readonly state: CommitmentState;
  /** From `ESCROWED` on: the escrow as READ FROM CHAIN. */
  readonly escrow?: FundingEvidence;
  readonly escrowedAtEpoch?: number;
  /**
   * The escrow's own deadline: an L2 epoch for an L2 escrow, an L1 block height for an L1 one.
   * After it, the escrow is recoverable by a refund transaction — not automatically.
   */
  readonly escrowDeadline?: number;
  /** Evidence for a terminal state. A transaction id alone is never enough; see `settle`. */
  readonly settlementEvidence?: string;
}

/** One line of history. Append-only: a maker's own record of what actually happened. */
export interface SettlementRecord {
  readonly commitmentId: string;
  readonly offerId: string;
  readonly outcome: 'SETTLED' | 'REFUNDED' | 'LAPSED';
  readonly payOutChain: Chain;
  readonly payOutRaw: string;
  readonly atEpoch: number;
  readonly evidence: string;
}

export interface BookEntry {
  readonly offer: MakerOffer;
  /** Paused: no new commitments. Live commitments and escrows are untouched. */
  readonly paused: boolean;
  /** Withdrawn: off the market for good. Also does not touch live commitments or escrows. */
  readonly withdrawn: boolean;
}

export interface MakerBook {
  readonly network: string;
  /** Latest observation per chain, in insertion order. */
  readonly observations: readonly InventoryObservation[];
  readonly entries: readonly BookEntry[];
  readonly commitments: readonly Commitment[];
  readonly history: readonly SettlementRecord[];
}

/**
 * The seven states the UI must distinguish, plus the two operational ones. Mapped from the
 * offer's evidence state and its live commitments, so a single label can never contradict them.
 */
export type OfferDisplayState =
  | 'INDICATIVE'
  | 'SIGNED'
  | 'RESERVED'
  | 'FUNDED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'PAUSED'
  | 'WITHDRAWN';

export type BookResult =
  | { readonly ok: true; readonly book: MakerBook }
  | { readonly ok: false; readonly refusal: string };

export type CommitResult =
  | { readonly ok: true; readonly book: MakerBook; readonly commitment: Commitment }
  | { readonly ok: false; readonly refusal: string };

/**
 * How old a balance read may be and still support a new promise, in L2 epochs. One epoch is
 * ~40 minutes on Esmeralda and ~2 hours on mainnet, and a maker can spend their own balance at
 * any moment, so a read from two epochs ago is not evidence of anything.
 */
export const MAX_READ_AGE_EPOCHS = 1;

const RAW = /^\d+$/;

function raw(value: string, field: string): bigint {
  if (!RAW.test(value)) throw new Error(`${field} must be a raw non-negative integer string`);
  return BigInt(value);
}

function epoch(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer epoch`);
  return value;
}

export function emptyBook(network: string): MakerBook {
  if (network.length === 0) throw new Error('a book must name the network it is for');
  return { network, observations: [], entries: [], commitments: [], history: [] };
}

export function latestObservation(book: MakerBook, chain: Chain): InventoryObservation | undefined {
  let best: InventoryObservation | undefined;
  for (const o of book.observations) {
    if (o.chain !== chain) continue;
    if (best === undefined || o.readAtEpoch >= best.readAtEpoch) best = o;
  }
  return best;
}

/**
 * Records a balance read. A read OLDER than the one it would replace is refused: going backwards
 * would silently raise available inventory if an older, larger balance arrived late.
 */
export function observeInventory(book: MakerBook, observation: InventoryObservation): BookResult {
  raw(observation.balanceRaw, 'balanceRaw');
  epoch(observation.readAtEpoch, 'readAtEpoch');
  if (observation.reference.length === 0) {
    return { ok: false, refusal: 'A balance read must say what was read; an unattributed figure is not evidence.' };
  }
  const current = latestObservation(book, observation.chain);
  if (current !== undefined && observation.readAtEpoch < current.readAtEpoch) {
    return {
      ok: false,
      refusal: `This ${observation.chain} read is from epoch ${observation.readAtEpoch}, older than the one already held (epoch ${current.readAtEpoch}). An older balance is not news.`,
    };
  }
  return {
    ok: true,
    book: {
      ...book,
      observations: [...book.observations.filter((o) => o.chain !== observation.chain), observation],
    },
  };
}

/**
 * What the maker could still promise on a chain, raw — or `undefined` when no read exists, which
 * is "unknown" and must never be rendered as a number.
 *
 * THE SUBTRACTION RULE, which is where this is easy to get wrong in the maker's favour:
 *
 *   * A `COMMITTED` payout is always subtracted: the coins are still in the wallet, so every
 *     balance read still counts them, and they are already promised.
 *   * An `ESCROWED` or `SETTLED` payout is subtracted only when the read PREDATES the escrow
 *     (`escrowedAtEpoch >= readAtEpoch`), because a read taken before the escrow still counts
 *     coins that have since left. `>=` rather than `>` because an epoch is coarse: within one
 *     epoch the order is unknown, and the conservative reading is the one that does not
 *     overstate what is available.
 *   * A `REFUNDED` payout is subtracted never: those coins came back, so a read from before the
 *     escrow is right again and a read from after it includes the refund.
 *   * A `LAPSED` payout is subtracted never: nothing ever left.
 */
export function uncommittedRaw(book: MakerBook, chain: Chain): string | undefined {
  const observation = latestObservation(book, chain);
  if (observation === undefined) return undefined;
  let held = BigInt(observation.balanceRaw);
  for (const c of book.commitments) {
    if (c.payOutChain !== chain) continue;
    const amount = BigInt(c.payOutRaw);
    if (c.state === 'COMMITTED') {
      held -= amount;
      continue;
    }
    if (c.state === 'ESCROWED' || c.state === 'SETTLED') {
      if ((c.escrowedAtEpoch ?? 0) >= observation.readAtEpoch) held -= amount;
    }
  }
  return held > 0n ? held.toString() : '0';
}

export interface ChainSummary {
  readonly chain: Chain;
  readonly observation: InventoryObservation | undefined;
  /** `undefined` means no read exists. A UI must print that, not a zero. */
  readonly availableRaw: string | undefined;
  readonly committedRaw: string;
  readonly escrowedRaw: string;
  /** Escrowed, past its deadline, and still needing a refund transaction to come back. */
  readonly recoverableRaw: string;
  readonly paidOutRaw: string;
  readonly refundedRaw: string;
  readonly readAgeEpochs: number | undefined;
  readonly readIsStale: boolean;
}

export function chainSummary(book: MakerBook, chain: Chain, position: ChainPosition): ChainSummary {
  const observation = latestObservation(book, chain);
  let committed = 0n;
  let escrowed = 0n;
  let recoverable = 0n;
  let paidOut = 0n;
  let refunded = 0n;
  for (const c of book.commitments) {
    if (c.payOutChain !== chain) continue;
    const amount = BigInt(c.payOutRaw);
    if (c.state === 'COMMITTED') committed += amount;
    if (c.state === 'ESCROWED') {
      escrowed += amount;
      if (escrowIsPastDeadline(c, position)) recoverable += amount;
    }
    if (c.state === 'SETTLED') paidOut += amount;
    if (c.state === 'REFUNDED') refunded += amount;
  }
  const age = observation === undefined ? undefined : position.l2CurrentEpoch - observation.readAtEpoch;
  return {
    chain,
    observation,
    availableRaw: uncommittedRaw(book, chain),
    committedRaw: committed.toString(),
    escrowedRaw: escrowed.toString(),
    recoverableRaw: recoverable.toString(),
    paidOutRaw: paidOut.toString(),
    refundedRaw: refunded.toString(),
    readAgeEpochs: age,
    readIsStale: age === undefined || age > MAX_READ_AGE_EPOCHS,
  };
}

function entryOf(book: MakerBook, offerId: string): BookEntry | undefined {
  return book.entries.find((e) => e.offer.terms.offerId === offerId);
}

/** Publishes an advertisement. It escrows nothing, and `indicative` says so in its own reason. */
export function publishOffer(book: MakerBook, terms: OfferTerms): BookResult {
  if (terms.network !== book.network) {
    return { ok: false, refusal: `This offer names network ${terms.network} but the book is for ${book.network}. An offer must never cross a network generation.` };
  }
  if (entryOf(book, terms.offerId) !== undefined) {
    return { ok: false, refusal: `An offer with id ${terms.offerId} already exists; ids identify offers and cannot be reused.` };
  }
  let offer: MakerOffer;
  try {
    offer = indicative(terms);
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  return { ok: true, book: { ...book, entries: [...book.entries, { offer, paused: false, withdrawn: false }] } };
}

/** The maker signs their own advertisement. Proves authorship; still escrows nothing. */
export function signOffer(book: MakerBook, offerId: string, signature: string): BookResult {
  const entry = entryOf(book, offerId);
  if (entry === undefined) return { ok: false, refusal: `No offer ${offerId} in this book.` };
  let next: MakerOffer;
  try {
    next = signed(entry.offer, signature);
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  return { ok: true, book: replaceEntry(book, { ...entry, offer: next }) };
}

function replaceEntry(book: MakerBook, entry: BookEntry): MakerBook {
  return {
    ...book,
    entries: book.entries.map((e) => (e.offer.terms.offerId === entry.offer.terms.offerId ? entry : e)),
  };
}

/**
 * Pause or withdraw. Neither touches a live commitment or an escrow: those are promises already
 * made and funds already moved, and a maker taking an advertisement down does not unmake them.
 */
export function setOfferAvailability(
  book: MakerBook,
  offerId: string,
  change: { readonly paused?: boolean; readonly withdrawn?: boolean },
): BookResult {
  const entry = entryOf(book, offerId);
  if (entry === undefined) return { ok: false, refusal: `No offer ${offerId} in this book.` };
  if (entry.withdrawn && change.withdrawn !== false) {
    return { ok: false, refusal: `Offer ${offerId} is already withdrawn.` };
  }
  return {
    ok: true,
    book: replaceEntry(book, {
      ...entry,
      paused: change.paused ?? entry.paused,
      withdrawn: change.withdrawn ?? entry.withdrawn,
    }),
  };
}

export interface CommitRequest {
  readonly commitmentId: string;
  readonly offerId: string;
  readonly takerL2PublicKey: string;
  readonly takerL1Address: string;
  /** What the maker will pay out, in the output asset's raw units. From the quote, not typed in. */
  readonly payOutRaw: string;
  readonly takeInRaw: string;
  /** The epoch this promise lapses at, if no escrow appears. */
  readonly expiresAtEpoch: number;
}

/**
 * The ONLY way a commitment is created, and therefore the only place the double-promise guard
 * lives. Every refusal names the arithmetic, because a maker who is told "no" needs to know
 * which limit said so.
 */
export function commit(book: MakerBook, request: CommitRequest, position: ChainPosition): CommitResult {
  const entry = entryOf(book, request.offerId);
  if (entry === undefined) return { ok: false, refusal: `No offer ${request.offerId} in this book.` };
  if (entry.withdrawn) return { ok: false, refusal: `Offer ${request.offerId} has been withdrawn and is not quoting.` };
  if (entry.paused) return { ok: false, refusal: `Offer ${request.offerId} is paused and is not quoting new trades.` };
  if (entry.offer.state === 'SETTLED') return { ok: false, refusal: `Offer ${request.offerId} is settled.` };
  if (book.commitments.some((c) => c.commitmentId === request.commitmentId)) {
    return { ok: false, refusal: `Commitment ${request.commitmentId} already exists; a repeat is refused rather than promising the same coins twice.` };
  }
  if (request.takerL2PublicKey.length === 0 || request.takerL1Address.length === 0) {
    return { ok: false, refusal: 'A commitment must name the taker on both chains: the escrow names their L2 key, and the other leg pays their L1 address.' };
  }

  const terms = entry.offer.terms;
  if (position.l2CurrentEpoch >= terms.expiresAtEpoch) {
    return { ok: false, refusal: `Offer ${request.offerId} expired at epoch ${terms.expiresAtEpoch}; it is now epoch ${position.l2CurrentEpoch}.` };
  }
  if (request.expiresAtEpoch <= position.l2CurrentEpoch) {
    return { ok: false, refusal: `A commitment cannot expire at epoch ${request.expiresAtEpoch}, which is not after the current epoch ${position.l2CurrentEpoch}.` };
  }
  if (request.expiresAtEpoch > terms.expiresAtEpoch) {
    return { ok: false, refusal: `A commitment cannot outlive its offer (epoch ${terms.expiresAtEpoch}).` };
  }

  let payOut: bigint;
  try {
    payOut = raw(request.payOutRaw, 'payOutRaw');
    raw(request.takeInRaw, 'takeInRaw');
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  if (payOut === 0n) return { ok: false, refusal: 'A commitment of zero is not a trade.' };
  const min = BigInt(terms.minFillRaw);
  const max = BigInt(terms.maxFillRaw);
  if (payOut < min || payOut > max) {
    return { ok: false, refusal: `A fill must be between ${terms.minFillRaw} and ${terms.maxFillRaw}; ${request.payOutRaw} is not.` };
  }

  const chain = makerEscrowChain(terms.direction);
  const observation = latestObservation(book, chain);
  if (observation === undefined) {
    return {
      ok: false,
      refusal: `No ${chain} balance has been read, so there is nothing to promise from. Read the balance first: a maker's own figure is not inventory.`,
    };
  }
  const age = position.l2CurrentEpoch - observation.readAtEpoch;
  if (age > MAX_READ_AGE_EPOCHS) {
    return {
      ok: false,
      refusal: `The ${chain} balance was last read at epoch ${observation.readAtEpoch} and it is now epoch ${position.l2CurrentEpoch}. A read ${age} epochs old is not evidence of a balance the maker can spend at any time; read it again.`,
    };
  }
  const available = uncommittedRaw(book, chain);
  if (available === undefined || payOut > BigInt(available)) {
    return {
      ok: false,
      refusal: `This would promise ${request.payOutRaw} on ${chain}, but only ${available ?? '0'} is unpromised (read ${observation.balanceRaw} at epoch ${observation.readAtEpoch}, less what is already committed or escrowed). Refused rather than promising the same coins to two takers.`,
    };
  }

  const commitment: Commitment = {
    commitmentId: request.commitmentId,
    offerId: request.offerId,
    direction: terms.direction,
    takerL2PublicKey: request.takerL2PublicKey,
    takerL1Address: request.takerL1Address,
    payOutChain: chain,
    payOutRaw: request.payOutRaw,
    takeInRaw: request.takeInRaw,
    committedAtEpoch: position.l2CurrentEpoch,
    expiresAtEpoch: request.expiresAtEpoch,
    state: 'COMMITTED',
  };
  return { ok: true, book: { ...book, commitments: [...book.commitments, commitment] }, commitment };
}

function commitmentOf(book: MakerBook, commitmentId: string): Commitment | undefined {
  return book.commitments.find((c) => c.commitmentId === commitmentId);
}

function replaceCommitment(book: MakerBook, next: Commitment): MakerBook {
  return {
    ...book,
    commitments: book.commitments.map((c) => (c.commitmentId === next.commitmentId ? next : c)),
  };
}

export interface EscrowReport {
  readonly commitmentId: string;
  /** The escrow as read from chain. Its `boundClaimant` is checked against the commitment. */
  readonly evidence: FundingEvidence;
  readonly escrowedAtEpoch: number;
  /** L2 epoch for an L2 escrow, L1 block height for an L1 one. */
  readonly escrowDeadline: number;
}

/**
 * Records that a commitment's escrow now exists on chain.
 *
 * The claimant check is the one that matters: an escrow bound to a key other than the taker's
 * pays a stranger, and the maker's own leg would be gone with nothing recoverable until the
 * deadline. So a mismatch is refused rather than recorded with a warning.
 */
export function recordEscrow(book: MakerBook, report: EscrowReport): BookResult {
  const c = commitmentOf(book, report.commitmentId);
  if (c === undefined) return { ok: false, refusal: `No commitment ${report.commitmentId} in this book.` };
  if (c.state !== 'COMMITTED') {
    return { ok: false, refusal: `Commitment ${report.commitmentId} is ${c.state}; only a COMMITTED promise can be escrowed.` };
  }
  const evidence = report.evidence;
  if (evidence.chain !== c.payOutChain) {
    return { ok: false, refusal: `The escrow is on ${evidence.chain}, but this commitment pays out on ${c.payOutChain}.` };
  }
  if (evidence.leg.length === 0) return { ok: false, refusal: 'The escrow evidence names no escrow.' };
  if (evidence.boundClaimant.toLowerCase() !== c.takerL2PublicKey.toLowerCase()) {
    return {
      ok: false,
      refusal: `The escrow names ${evidence.boundClaimant} as its claimant, but this commitment is for ${c.takerL2PublicKey}. An escrow bound to another key pays a stranger and cannot be redirected.`,
    };
  }
  let escrowed: bigint;
  try {
    escrowed = raw(evidence.escrowedRaw, 'escrowedRaw');
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  if (escrowed < BigInt(c.payOutRaw)) {
    return {
      ok: false,
      refusal: `The escrow holds ${evidence.escrowedRaw}, less than the ${c.payOutRaw} promised. An under-funded escrow cannot settle this trade: fund the difference or re-quote.`,
    };
  }
  if (report.escrowDeadline <= 0) {
    return { ok: false, refusal: 'An escrow must record its own deadline, or there is no point at which it becomes recoverable.' };
  }
  return {
    ok: true,
    book: replaceCommitment(book, {
      ...c,
      state: 'ESCROWED',
      escrow: evidence,
      escrowedAtEpoch: epoch(report.escrowedAtEpoch, 'escrowedAtEpoch'),
      escrowDeadline: report.escrowDeadline,
    }),
  };
}

function escrowIsPastDeadline(c: Commitment, position: ChainPosition): boolean {
  if (c.escrowDeadline === undefined) return false;
  const now = c.payOutChain === 'L1' ? position.l1TipHeight : position.l2CurrentEpoch;
  return now >= c.escrowDeadline;
}

/**
 * Lapses unescrowed promises whose deadline has passed, freeing their inventory.
 *
 * Only `COMMITTED` ones. An `ESCROWED` commitment past its deadline is RECOVERABLE, not lapsed:
 * its funds are on chain behind a refund branch, and nothing returns them until a refund
 * transaction is signed and lands.
 */
export function lapseExpired(book: MakerBook, position: ChainPosition): MakerBook {
  let next = book;
  for (const c of book.commitments) {
    if (c.state !== 'COMMITTED') continue;
    if (position.l2CurrentEpoch < c.expiresAtEpoch) continue;
    next = replaceCommitment(next, { ...c, state: 'LAPSED' });
    next = {
      ...next,
      history: [
        ...next.history,
        {
          commitmentId: c.commitmentId,
          offerId: c.offerId,
          outcome: 'LAPSED',
          payOutChain: c.payOutChain,
          payOutRaw: c.payOutRaw,
          atEpoch: position.l2CurrentEpoch,
          evidence: `The promise expired at epoch ${c.expiresAtEpoch} with no escrow funded; nothing left the wallet.`,
        },
      ],
    };
  }
  return next;
}

/** Escrows past their deadline, each needing its own refund transaction. */
export function recoverable(book: MakerBook, position: ChainPosition): readonly Commitment[] {
  return book.commitments.filter((c) => c.state === 'ESCROWED' && escrowIsPastDeadline(c, position));
}

/**
 * Records a terminal outcome for an escrowed commitment.
 *
 * `evidence` must be a statement about chain state — a balance that rose, an escrow whose status
 * is now Claimed or Refunded. A transaction id proves a submission, not an arrival, so it is
 * refused on its own: see `reconcileSettlement` for the balance-delta rule this mirrors.
 */
export function settleCommitment(
  book: MakerBook,
  commitmentId: string,
  outcome: 'SETTLED' | 'REFUNDED',
  evidence: string,
  position: ChainPosition,
): BookResult {
  const c = commitmentOf(book, commitmentId);
  if (c === undefined) return { ok: false, refusal: `No commitment ${commitmentId} in this book.` };
  if (c.state !== 'ESCROWED') {
    return { ok: false, refusal: `Commitment ${commitmentId} is ${c.state}; only an ESCROWED commitment settles or refunds.` };
  }
  if (evidence.trim().length === 0) {
    return { ok: false, refusal: 'A settlement needs evidence of chain state. Record what was read, not that a transaction was sent.' };
  }
  if (outcome === 'REFUNDED' && !escrowIsPastDeadline(c, position)) {
    const now = c.payOutChain === 'L1' ? position.l1TipHeight : position.l2CurrentEpoch;
    return {
      ok: false,
      refusal: `This escrow cannot have been refunded yet: its deadline is ${c.escrowDeadline ?? 'unknown'} and ${c.payOutChain} is at ${now}. Until then it is the claimant's to take.`,
    };
  }
  return {
    ok: true,
    book: {
      ...replaceCommitment(book, { ...c, state: outcome, settlementEvidence: evidence }),
      history: [
        ...book.history,
        {
          commitmentId: c.commitmentId,
          offerId: c.offerId,
          outcome,
          payOutChain: c.payOutChain,
          payOutRaw: c.payOutRaw,
          atEpoch: position.l2CurrentEpoch,
          evidence,
        },
      ],
    },
  };
}

export function commitmentsFor(book: MakerBook, offerId: string): readonly Commitment[] {
  return book.commitments.filter((c) => c.offerId === offerId);
}

/**
 * The label a UI shows for an offer, from its evidence state and its live commitments. Live
 * commitments dominate, because what is already promised or escrowed is the strongest fact about
 * an offer; only then do the operational flags and the advertisement's own state apply.
 */
export function displayState(book: MakerBook, offerId: string, position: ChainPosition): OfferDisplayState | undefined {
  const entry = entryOf(book, offerId);
  if (entry === undefined) return undefined;
  const mine = commitmentsFor(book, offerId);
  if (mine.some((c) => c.state === 'ESCROWED')) return 'FUNDED';
  if (mine.some((c) => c.state === 'COMMITTED' && position.l2CurrentEpoch < c.expiresAtEpoch)) return 'RESERVED';
  if (entry.withdrawn) return 'WITHDRAWN';
  if (mine.length > 0 && mine.every((c) => c.state === 'SETTLED' || c.state === 'REFUNDED' || c.state === 'LAPSED')) {
    const last = mine[mine.length - 1];
    if (last !== undefined && last.state === 'SETTLED') return 'COMPLETED';
    if (last !== undefined && last.state === 'REFUNDED') return 'REFUNDED';
  }
  if (position.l2CurrentEpoch >= entry.offer.terms.expiresAtEpoch) return 'EXPIRED';
  if (entry.paused) return 'PAUSED';
  return entry.offer.state === 'SIGNED' ? 'SIGNED' : 'INDICATIVE';
}

/** One line per offer for a UI, stating the evidence rather than implying more than exists. */
export function describeOfferForMaker(book: MakerBook, offerId: string, position: ChainPosition): string {
  const entry = entryOf(book, offerId);
  if (entry === undefined) return `No offer ${offerId} in this book.`;
  const state = displayState(book, offerId, position);
  const mine = commitmentsFor(book, offerId);
  const live = mine.filter((c) => c.state === 'COMMITTED' || c.state === 'ESCROWED');
  const chain = makerEscrowChain(entry.offer.terms.direction);
  if (state === 'FUNDED' || state === 'RESERVED') {
    const promised = live.reduce((total, c) => total + BigInt(c.payOutRaw), 0n).toString();
    const who = live.map((c) => c.takerL2PublicKey).join(', ');
    return state === 'FUNDED'
      ? `${promised} is escrowed on ${chain} against ${live.length} matched trade(s), claimable only by ${who}.`
      : `${promised} is promised to ${live.length} matched taker(s) but NOT yet escrowed, so it is still in the maker's wallet and still spendable by them.`;
  }
  if (state === 'EXPIRED') return `This advertisement expired at epoch ${entry.offer.terms.expiresAtEpoch}. Any escrow it produced is listed separately and is recovered by its own refund.`;
  if (state === 'WITHDRAWN') return 'Withdrawn from the market. Live commitments and escrows are unaffected.';
  if (state === 'PAUSED') return 'Paused: not quoting new trades. Nothing is escrowed by an advertisement.';
  if (state === 'COMPLETED') return 'The last matched trade settled: the taker claimed the escrow.';
  if (state === 'REFUNDED') return 'The last matched trade was recovered by the maker after its deadline.';
  return entry.offer.state === 'SIGNED'
    ? `Signed advertisement: it proves these are the maker's terms. Nothing is escrowed — a ${chain} escrow exists only once a specific taker is matched, and it names that taker.`
    : `Indicative advertisement: a price, and nothing more. Nothing is escrowed — a ${chain} escrow exists only once a specific taker is matched, and it names that taker.`;
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

export class MakerBookError extends Error {}

/** Bounded so a tampered or runaway store cannot be used to push a blob into memory or a UI. */
export const MAKER_BOOK_MAX_CHARS = 64_000;
const MAX_ENTRIES = 200;
const MAX_COMMITMENTS = 500;
const MAX_HISTORY = 1000;
const MAX_FIELD_CHARS = 256;

export function serializeBook(book: MakerBook): string {
  const text = JSON.stringify(book);
  if (text.length > MAKER_BOOK_MAX_CHARS) {
    throw new MakerBookError(`This book serializes to ${text.length} characters, over the ${MAKER_BOOK_MAX_CHARS} bound. Settle or prune old commitments.`);
  }
  return text;
}

function str(value: unknown, field: string, max = MAX_FIELD_CHARS): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new MakerBookError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  // A control character in a persisted identifier is a tampering signal, not a typo.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new MakerBookError(`${field} contains control characters`);
  return value;
}

function rawField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !RAW.test(value) || value.length > 40) {
    throw new MakerBookError(`${field} must be a raw non-negative integer string`);
  }
  return value;
}

function intField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new MakerBookError(`${field} must be a non-negative integer`);
  }
  return value;
}

function chainField(value: unknown, field: string): Chain {
  if (value !== 'L1' && value !== 'L2') throw new MakerBookError(`${field} must be L1 or L2`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MakerBookError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new MakerBookError(`${field} must be an array of at most ${max} entries`);
  }
  return value;
}

/**
 * Restores a book from browser storage, and DELIBERATELY DROPS EVERY BALANCE OBSERVATION.
 *
 * Persisted state is attacker-modifiable: a page script can rewrite `localStorage` between
 * reloads. Every other field here is a record of something that already happened, and a
 * tampered one is caught by the chain read that any action requires. A balance observation is
 * different: it is the input to the double-promise guard, so a forged `balanceRaw` with a fresh
 * `readAtEpoch` would let a maker promise coins they do not have. The only safe treatment is to
 * require it to be read again, so that is what this does — the restored book reports its
 * inventory as unknown until the wallet answers.
 *
 * Throws rather than silently returning an empty book: a maker whose stored commitments cannot
 * be validated needs to be told, because those promises may still be live on chain.
 */
export function restoreBook(text: string | null, expect: { readonly network: string }): MakerBook | undefined {
  if (text === null || text.length === 0) return undefined;
  if (text.length > MAKER_BOOK_MAX_CHARS) throw new MakerBookError('The stored book is over its size bound and is not trusted.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MakerBookError('The stored book is not valid JSON.');
  }
  const root = record(parsed, 'book');
  const network = str(root['network'], 'network');
  if (network !== expect.network) return undefined;

  const entries: BookEntry[] = array(root['entries'], 'entries', MAX_ENTRIES).map((raw0, i) => {
    const e = record(raw0, `entries[${i}]`);
    const offer = record(e['offer'], `entries[${i}].offer`);
    const terms = record(offer['terms'], `entries[${i}].offer.terms`);
    const direction = terms['direction'];
    if (direction !== 'L2_TO_L1' && direction !== 'L1_TO_L2') {
      throw new MakerBookError(`entries[${i}].offer.terms.direction is not a known direction`);
    }
    const state = offer['state'];
    if (typeof state !== 'string' || !OFFER_STATES_FOR_RESTORE.includes(state)) {
      throw new MakerBookError(`entries[${i}].offer.state is not a known offer state`);
    }
    const rebuilt: OfferTerms = {
      offerId: str(terms['offerId'], `entries[${i}].offerId`),
      direction,
      network,
      inventoryRaw: rawField(terms['inventoryRaw'], `entries[${i}].inventoryRaw`),
      minFillRaw: rawField(terms['minFillRaw'], `entries[${i}].minFillRaw`),
      maxFillRaw: rawField(terms['maxFillRaw'], `entries[${i}].maxFillRaw`),
      makerL1Address: str(terms['makerL1Address'], `entries[${i}].makerL1Address`),
      makerL2PublicKey: str(terms['makerL2PublicKey'], `entries[${i}].makerL2PublicKey`),
      expiresAtEpoch: intField(terms['expiresAtEpoch'], `entries[${i}].expiresAtEpoch`),
    };
    const signature = offer['signature'];
    return {
      offer: {
        terms: rebuilt,
        state: state as MakerOffer['state'],
        ...(signature === undefined ? {} : { signature: str(signature, `entries[${i}].signature`) }),
      },
      paused: e['paused'] === true,
      withdrawn: e['withdrawn'] === true,
    };
  });

  const commitments: Commitment[] = array(root['commitments'], 'commitments', MAX_COMMITMENTS).map((raw0, i) => {
    const c = record(raw0, `commitments[${i}]`);
    const state = c['state'];
    if (typeof state !== 'string' || !COMMITMENT_STATES.includes(state as CommitmentState)) {
      throw new MakerBookError(`commitments[${i}].state is not a known commitment state`);
    }
    const direction = c['direction'];
    if (direction !== 'L2_TO_L1' && direction !== 'L1_TO_L2') {
      throw new MakerBookError(`commitments[${i}].direction is not a known direction`);
    }
    const escrow = c['escrow'];
    return {
      commitmentId: str(c['commitmentId'], `commitments[${i}].commitmentId`),
      offerId: str(c['offerId'], `commitments[${i}].offerId`),
      direction,
      takerL2PublicKey: str(c['takerL2PublicKey'], `commitments[${i}].takerL2PublicKey`),
      takerL1Address: str(c['takerL1Address'], `commitments[${i}].takerL1Address`),
      payOutChain: chainField(c['payOutChain'], `commitments[${i}].payOutChain`),
      payOutRaw: rawField(c['payOutRaw'], `commitments[${i}].payOutRaw`),
      takeInRaw: rawField(c['takeInRaw'], `commitments[${i}].takeInRaw`),
      committedAtEpoch: intField(c['committedAtEpoch'], `commitments[${i}].committedAtEpoch`),
      expiresAtEpoch: intField(c['expiresAtEpoch'], `commitments[${i}].expiresAtEpoch`),
      state: state as CommitmentState,
      ...(escrow === undefined
        ? {}
        : {
            escrow: ((): FundingEvidence => {
              const e = record(escrow, `commitments[${i}].escrow`);
              return {
                leg: str(e['leg'], `commitments[${i}].escrow.leg`),
                escrowedRaw: rawField(e['escrowedRaw'], `commitments[${i}].escrow.escrowedRaw`),
                chain: chainField(e['chain'], `commitments[${i}].escrow.chain`),
                boundClaimant: str(e['boundClaimant'], `commitments[${i}].escrow.boundClaimant`),
                readAtEpoch: intField(e['readAtEpoch'], `commitments[${i}].escrow.readAtEpoch`),
              };
            })(),
          }),
      ...(c['escrowedAtEpoch'] === undefined ? {} : { escrowedAtEpoch: intField(c['escrowedAtEpoch'], `commitments[${i}].escrowedAtEpoch`) }),
      ...(c['escrowDeadline'] === undefined ? {} : { escrowDeadline: intField(c['escrowDeadline'], `commitments[${i}].escrowDeadline`) }),
      ...(c['settlementEvidence'] === undefined ? {} : { settlementEvidence: str(c['settlementEvidence'], `commitments[${i}].settlementEvidence`, 1024) }),
    };
  });

  const history: SettlementRecord[] = array(root['history'], 'history', MAX_HISTORY).map((raw0, i) => {
    const h = record(raw0, `history[${i}]`);
    const outcome = h['outcome'];
    if (outcome !== 'SETTLED' && outcome !== 'REFUNDED' && outcome !== 'LAPSED') {
      throw new MakerBookError(`history[${i}].outcome is not a known outcome`);
    }
    return {
      commitmentId: str(h['commitmentId'], `history[${i}].commitmentId`),
      offerId: str(h['offerId'], `history[${i}].offerId`),
      outcome,
      payOutChain: chainField(h['payOutChain'], `history[${i}].payOutChain`),
      payOutRaw: rawField(h['payOutRaw'], `history[${i}].payOutRaw`),
      atEpoch: intField(h['atEpoch'], `history[${i}].atEpoch`),
      evidence: str(h['evidence'], `history[${i}].evidence`, 1024),
    };
  });

  // A commitment must belong to an offer in the same book, or the inventory arithmetic would be
  // attributing a promise to nothing.
  const offerIds = new Set(entries.map((e) => e.offer.terms.offerId));
  for (const c of commitments) {
    if (!offerIds.has(c.offerId)) {
      throw new MakerBookError(`Commitment ${c.commitmentId} names offer ${c.offerId}, which is not in this book.`);
    }
  }
  const seen = new Set<string>();
  for (const c of commitments) {
    if (seen.has(c.commitmentId)) throw new MakerBookError(`Commitment id ${c.commitmentId} appears twice.`);
    seen.add(c.commitmentId);
  }

  // Observations are dropped on purpose: see this function's own comment.
  return { network, observations: [], entries, commitments, history };
}

const OFFER_STATES_FOR_RESTORE: readonly string[] = ['INDICATIVE', 'SIGNED', 'FUNDED', 'RESERVED', 'SETTLED'];
const COMMITMENT_STATES: readonly CommitmentState[] = ['COMMITTED', 'ESCROWED', 'SETTLED', 'REFUNDED', 'LAPSED'];
