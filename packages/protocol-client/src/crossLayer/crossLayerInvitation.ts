/**
 * Cross-layer offer discovery by DIRECT INVITATION. No backend, no order book, no server that
 * can hold funds or withhold a settlement.
 *
 * A maker exports a compact string; a taker imports it. That is the whole transport. A hosted
 * index could make offers easier to find later, but it is not needed to trade and must never be
 * needed to RECOVER: once an escrow is funded, claiming and refunding depend only on the two
 * chains. Building a server merely to display a list would put an availability dependency in
 * front of people's money for no protocol benefit.
 *
 * THE LESSON THIS CARRIES FORWARD. An invitation is UNTRUSTED INPUT — whoever sends it chose
 * every byte. So it is never the source of terms: `verifyCrossLayerInvitation` reads the funded
 * leg from chain and reports every disagreement, and the terms a taker acts on are ALWAYS the
 * chain's. A forged invitation can waste a taker's time; it must never move their funds.
 */

import type { SwapDirection } from './atomicSwap.js';

export const CROSS_LAYER_INVITATION_PREFIX = 'shadowswap-xlayer:v1:';
/** Bounded so an import cannot be used to push an unbounded blob into storage or a UI. */
export const CROSS_LAYER_INVITATION_MAX_CHARS = 4096;

/**
 * What a maker publishes. Every field is either a term of the trade or a binding that stops the
 * invitation being replayed somewhere it does not belong.
 */
export interface CrossLayerInvitation {
  readonly v: 1;
  /** Unique per offer-instance, so a duplicate fill can be refused by identity. */
  readonly swapId: string;
  readonly direction: SwapDirection;
  /** Network and deployment generation: an invitation must never cross either. */
  readonly network: string;
  readonly generation: string;
  /** The maker's identities on both chains. */
  readonly makerL2PublicKey: string;
  readonly makerL1Address: string;
  /**
   * The maker's ALREADY FUNDED leg, which is what makes this more than an advertisement:
   * for an exit (maker funds L1) the L1 output hash; for an entry (maker funds L2) the escrow
   * component. Absent means the offer is indicative only.
   */
  readonly fundedLeg?: string;
  /** SHA-256 hash lock the funded leg commits to. Absent while indicative. */
  readonly hashLockHex?: string;
  /** Raw integer strings. Two chains' units are compared, so never floats. */
  readonly l2RawAmount: string;
  readonly l1MicroAmount: string;
  readonly minFillRaw: string;
  readonly maxFillRaw: string;
  /** Absolute deadlines, both derived rather than chosen. */
  readonly l2ExpiresAtEpoch: number;
  readonly l1RefundHeight: number;
  /** Optional maker signature over the canonical form, where a wallet can produce one. */
  readonly signature?: string;
  /** Free-text, bounded, never interpreted. */
  readonly memo?: string;
}

export class CrossLayerInvitationError extends Error {}

const RAW = /^\d+$/;
const HEX64 = /^[0-9a-f]{64}$/i;

function requireString(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new CrossLayerInvitationError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function requireRaw(value: unknown, field: string): string {
  if (typeof value !== 'string' || !RAW.test(value)) {
    throw new CrossLayerInvitationError(`${field} must be a raw non-negative integer string`);
  }
  return value;
}

function requireEpoch(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new CrossLayerInvitationError(`${field} must be a positive integer`);
  }
  return value;
}

/** Validates an imported object completely before any of it is shown or used. */
export function validateCrossLayerInvitation(value: unknown): CrossLayerInvitation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CrossLayerInvitationError('An invitation must be a JSON object');
  }
  const v = value as Record<string, unknown>;
  if (v.v !== 1) throw new CrossLayerInvitationError('Unsupported invitation version');
  if (v.direction !== 'L2_TO_L1' && v.direction !== 'L1_TO_L2') {
    throw new CrossLayerInvitationError('direction must be L2_TO_L1 or L1_TO_L2');
  }
  const out: CrossLayerInvitation = {
    v: 1,
    swapId: requireString(v.swapId, 'swapId', 128),
    direction: v.direction,
    network: requireString(v.network, 'network', 64),
    generation: requireString(v.generation, 'generation', 64),
    makerL2PublicKey: requireString(v.makerL2PublicKey, 'makerL2PublicKey', 128),
    makerL1Address: requireString(v.makerL1Address, 'makerL1Address', 128),
    l2RawAmount: requireRaw(v.l2RawAmount, 'l2RawAmount'),
    l1MicroAmount: requireRaw(v.l1MicroAmount, 'l1MicroAmount'),
    minFillRaw: requireRaw(v.minFillRaw, 'minFillRaw'),
    maxFillRaw: requireRaw(v.maxFillRaw, 'maxFillRaw'),
    l2ExpiresAtEpoch: requireEpoch(v.l2ExpiresAtEpoch, 'l2ExpiresAtEpoch'),
    l1RefundHeight: requireEpoch(v.l1RefundHeight, 'l1RefundHeight'),
    ...(v.fundedLeg === undefined ? {} : { fundedLeg: requireString(v.fundedLeg, 'fundedLeg', 128) }),
    ...(v.hashLockHex === undefined ? {} : { hashLockHex: requireString(v.hashLockHex, 'hashLockHex', 64) }),
    ...(v.signature === undefined ? {} : { signature: requireString(v.signature, 'signature', 256) }),
    ...(v.memo === undefined ? {} : { memo: requireString(v.memo, 'memo', 280) }),
  };
  if (BigInt(out.l2RawAmount) === 0n || BigInt(out.l1MicroAmount) === 0n) {
    throw new CrossLayerInvitationError('Both sides of a cross-layer offer must be positive');
  }
  if (BigInt(out.minFillRaw) === 0n) throw new CrossLayerInvitationError('minFillRaw must be positive');
  if (BigInt(out.maxFillRaw) < BigInt(out.minFillRaw)) {
    throw new CrossLayerInvitationError('maxFillRaw must be at least minFillRaw');
  }
  if (out.hashLockHex !== undefined && !HEX64.test(out.hashLockHex)) {
    throw new CrossLayerInvitationError('hashLockHex must be 64 hex characters');
  }
  // A funded leg without a hash lock cannot be bound to, and a hash lock without a funded leg is
  // a promise rather than evidence. Either both or neither.
  if ((out.fundedLeg === undefined) !== (out.hashLockHex === undefined)) {
    throw new CrossLayerInvitationError(
      'fundedLeg and hashLockHex must be given together: a funded leg with no hash cannot be bound to, and a hash with no funded leg is not evidence of anything',
    );
  }
  return out;
}

/** A canonical JSON form with sorted keys, so a signature covers a stable byte sequence. */
export function canonicalInvitationJson(invitation: CrossLayerInvitation): string {
  const { signature: _omit, ...rest } = invitation;
  const keys = Object.keys(rest).sort();
  return JSON.stringify(rest, keys);
}

export function encodeCrossLayerInvitation(invitation: CrossLayerInvitation): string {
  const text = CROSS_LAYER_INVITATION_PREFIX + JSON.stringify(validateCrossLayerInvitation(invitation));
  if (text.length > CROSS_LAYER_INVITATION_MAX_CHARS) {
    throw new CrossLayerInvitationError(`An invitation must be at most ${CROSS_LAYER_INVITATION_MAX_CHARS} characters`);
  }
  return text;
}

export function parseCrossLayerInvitation(text: string): CrossLayerInvitation {
  if (typeof text !== 'string') throw new CrossLayerInvitationError('An invitation must be text');
  const trimmed = text.trim();
  if (trimmed.length > CROSS_LAYER_INVITATION_MAX_CHARS) {
    throw new CrossLayerInvitationError(`An invitation must be at most ${CROSS_LAYER_INVITATION_MAX_CHARS} characters`);
  }
  if (!trimmed.startsWith(CROSS_LAYER_INVITATION_PREFIX)) {
    throw new CrossLayerInvitationError(`An invitation must start with ${CROSS_LAYER_INVITATION_PREFIX}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(CROSS_LAYER_INVITATION_PREFIX.length));
  } catch {
    throw new CrossLayerInvitationError('An invitation must carry valid JSON after its prefix');
  }
  return validateCrossLayerInvitation(parsed);
}

/** What a chain read of the maker's funded leg reports. Supplied by the caller's own reader. */
export interface FundedLegState {
  /** The leg identifier actually read: an L1 output hash or an L2 escrow component. */
  readonly leg: string;
  readonly chain: 'L1' | 'L2';
  readonly hashLockHex: string;
  /** What the escrow or output actually holds, raw. */
  readonly amountRaw: string;
  /** For an L2 escrow: the key allowed to claim. For L1: the destination. */
  readonly claimantOrDestination: string;
  /** L2 escrows only. */
  readonly expiresAtEpoch?: number;
  /** L1 outputs only. */
  readonly refundHeight?: number;
  readonly settled: boolean;
}

export interface CrossLayerVerdict {
  /** True only when every term agrees with chain state and nothing blocks acting now. */
  readonly actionable: boolean;
  /** Terms where the invitation disagrees with chain. Non-empty means forged or stale. */
  readonly mismatches: readonly string[];
  /** Other reasons this cannot be acted on now. */
  readonly blockers: readonly string[];
  /** True facts the taker must know that do not block. */
  readonly warnings: readonly string[];
  /** The terms to show and act on: ALWAYS the chain's, never the invitation's. */
  readonly chain: FundedLegState;
}

/**
 * Verifies an invitation against the funded leg read from chain.
 *
 * Every comparison exists because a maker controls the invitation's bytes and could otherwise
 * induce a taker to escrow against something that will not pay out: a hash no preimage of theirs
 * opens, an amount smaller than advertised, a claimant who is not them, or a deadline that
 * leaves no margin.
 */
export function verifyCrossLayerInvitation(
  invitation: CrossLayerInvitation,
  chain: FundedLegState,
  ctx: {
    readonly network: string;
    readonly generation: string;
    readonly takerL2PublicKey?: string;
    readonly l2CurrentEpoch?: number;
    readonly l1TipHeight?: number;
    /** Swap ids this client has already acted on, so a duplicate fill is refused by identity. */
    readonly seenSwapIds?: readonly string[];
  },
): CrossLayerVerdict {
  const mismatches: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (invitation.network !== ctx.network) {
    mismatches.push(`the invitation is for network ${invitation.network}, your wallet is on ${ctx.network}`);
  }
  if (invitation.generation !== ctx.generation) {
    mismatches.push(`the invitation is for deployment generation ${invitation.generation}, this network is ${ctx.generation}`);
  }
  if (invitation.fundedLeg === undefined || invitation.hashLockHex === undefined) {
    blockers.push('This invitation advertises a price but names no funded escrow, so nothing on chain backs it. It cannot be traded.');
  } else {
    if (invitation.fundedLeg !== chain.leg) {
      mismatches.push(`the invitation names leg ${invitation.fundedLeg}, the read was of ${chain.leg}`);
    }
    if (invitation.hashLockHex.toLowerCase() !== chain.hashLockHex.toLowerCase()) {
      mismatches.push(`hash lock: the invitation says ${invitation.hashLockHex}, the funded leg commits to ${chain.hashLockHex}. A preimage for the invitation's hash would not open this escrow.`);
    }
    // The maker's own leg must hold at least what the taker is being promised.
    const promised = chain.chain === 'L1' ? invitation.l1MicroAmount : invitation.l2RawAmount;
    if (BigInt(chain.amountRaw) < BigInt(promised)) {
      mismatches.push(`the funded leg holds ${chain.amountRaw}, below the ${promised} this invitation promises`);
    }
    // The expected funding chain follows from the direction: the L1 funder is the secret holder.
    const expectedChain: 'L1' | 'L2' = invitation.direction === 'L2_TO_L1' ? 'L1' : 'L2';
    if (chain.chain !== expectedChain) {
      mismatches.push(`for a ${invitation.direction} offer the maker must fund on ${expectedChain}, but the leg read is on ${chain.chain}`);
    }
    if (chain.settled) {
      blockers.push('The maker\'s escrow has already been claimed or refunded, so this offer is spent.');
    }
    if (chain.chain === 'L2' && ctx.takerL2PublicKey !== undefined && chain.claimantOrDestination.toLowerCase() !== ctx.takerL2PublicKey.toLowerCase()) {
      mismatches.push(`the maker's L2 escrow names ${chain.claimantOrDestination} as its claimant, not your account key. You could not claim it.`);
    }
    if (chain.expiresAtEpoch !== undefined && chain.expiresAtEpoch !== invitation.l2ExpiresAtEpoch) {
      mismatches.push(`L2 deadline: the invitation says epoch ${invitation.l2ExpiresAtEpoch}, the escrow says ${chain.expiresAtEpoch}`);
    }
    if (chain.refundHeight !== undefined && chain.refundHeight !== invitation.l1RefundHeight) {
      mismatches.push(`L1 refund height: the invitation says ${invitation.l1RefundHeight}, the output says ${chain.refundHeight}`);
    }
  }

  if (ctx.l2CurrentEpoch !== undefined && ctx.l2CurrentEpoch >= invitation.l2ExpiresAtEpoch) {
    blockers.push(`This offer's L2 deadline (epoch ${invitation.l2ExpiresAtEpoch}) has passed; L2 is at ${ctx.l2CurrentEpoch}. Funding against it now would create an escrow refundable before it could be claimed.`);
  }
  if (ctx.l1TipHeight !== undefined && ctx.l1TipHeight >= invitation.l1RefundHeight) {
    blockers.push(`The maker's L1 escrow is already refundable at height ${invitation.l1RefundHeight} (tip ${ctx.l1TipHeight}), so they could recover it at any moment.`);
  }
  if ((ctx.seenSwapIds ?? []).includes(invitation.swapId)) {
    blockers.push(`This client has already acted on swap ${invitation.swapId}. Acting again could fund or claim twice.`);
  }

  if (invitation.signature === undefined) {
    warnings.push('This invitation is unsigned, so it proves nothing about who wrote it. What protects you is the chain read, not the invitation.');
  }
  warnings.push('A cross-layer exchange is four transactions across two chains. Your escrow is recoverable only AFTER its deadline, never before.');

  return {
    actionable: mismatches.length === 0 && blockers.length === 0,
    mismatches,
    blockers,
    warnings,
    chain,
  };
}
