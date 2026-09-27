/**
 * Deadline policy for cross-layer HTLCs.
 *
 * L1 block heights and L2 epochs are DIFFERENT time domains and are NEVER compared
 * numerically. The first-funded leg must have a LATER refund deadline than the
 * second-funded leg by an explicit, evidence-based margin so the counterparty still has
 * time to claim the first leg after the secret is revealed on the second leg.
 *
 * Margin components are supplied as explicit, auditable inputs — never a bare "+10".
 */
import { requireRawAmount } from './types.js';

export class DeadlineError extends Error {}

export interface DeadlinePolicyInput {
  /** Required L1 confirmations (decimal string). */
  requiredL1Confirmations: string;
  /** Expected L1 block cadence in milliseconds. */
  l1BlockMs: string;
  /** Expected L2 epoch cadence in milliseconds. */
  l2EpochMs: string;
  /** Expected propagation/fee-retry/readback allowance in milliseconds. */
  propagationDelayMs: string;
  /** Extra safety buffer in milliseconds. */
  safetyBufferMs: string;
  /** Current L1 height and L2 epoch at deadline derivation. */
  currentL1Height: string;
  currentL2Epoch: string;
}

export interface DerivedDeadlines {
  /** Refund deadline for the SECOND-FUNDED leg (L2, earlier). */
  secondLegRefundEpoch: string;
  /** Refund deadline for the FIRST-FUNDED leg (L1, later). */
  firstLegRefundHeight: string;
  marginEvidence: {
    confirmationsMs: string;
    l2ClaimWindowMs: string;
    l1FirstLegMarginMs: string;
  };
}

function divCeil(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * SECOND-FUNDED (L2) refund deadline = now + one funding-observation/claim window.
 * FIRST-FUNDED (L1) refund deadline = now + second-leg window + one extra claim window
 * (the counterparty's claim after secret reveal) + propagation + confirmations + buffer.
 */
export function deriveDeadlines(input: DeadlinePolicyInput): DerivedDeadlines {
  const confirmations = requireRawAmount(input.requiredL1Confirmations, 'requiredL1Confirmations');
  const l1BlockMs = requireRawAmount(input.l1BlockMs, 'l1BlockMs');
  const l2EpochMs = requireRawAmount(input.l2EpochMs, 'l2EpochMs');
  const propagation = requireRawAmount(input.propagationDelayMs, 'propagationDelayMs');
  const safety = requireRawAmount(input.safetyBufferMs, 'safetyBufferMs');
  if (l1BlockMs === 0n || l2EpochMs === 0n) throw new DeadlineError('block/epoch cadence must be positive');
  if (confirmations === 0n) throw new DeadlineError('required confirmations must be positive');
  const confirmationsMs = confirmations * l1BlockMs;
  // Second leg (L2) refund deadline: funding observation + claim, in epochs.
  const l2ClaimWindowMs = l2EpochMs * 3n + propagation + safety;
  const secondLegRefundEpoch = (BigInt(input.currentL2Epoch) + divCeil(l2ClaimWindowMs, l2EpochMs)).toString();
  // First leg (L1): second-leg window + one L2 claim observation + confirmations + propagation.
  const l1FirstLegMarginMs = l2ClaimWindowMs + l2EpochMs * 2n + propagation + safety;
  const firstLegBlocks = divCeil(l1FirstLegMarginMs, l1BlockMs);
  const firstLegRefundHeight = (BigInt(input.currentL1Height) + firstLegBlocks + confirmations).toString();
  return {
    secondLegRefundEpoch,
    firstLegRefundHeight,
    marginEvidence: { confirmationsMs: confirmationsMs.toString(), l2ClaimWindowMs: l2ClaimWindowMs.toString(), l1FirstLegMarginMs: l1FirstLegMarginMs.toString() },
  };
}

export type IrreversiblePhase = 'FIRST_LEG_FUNDING' | 'SECOND_LEG_FUNDING' | 'CLAIM_ARMED' | 'SECRET_REVEAL' | 'CLAIM_SUBMIT';

export interface DeadlineSafetyInput {
  phase: IrreversiblePhase;
  /** Remaining safety margin per leg, in milliseconds, computed from AUTHORITATIVE reads. */
  l1RemainingMarginMs: string;
  l2RemainingMarginMs: string;
  /** How much margin the phase requires before proceeding. */
  requiredL1MarginMs: string;
  requiredL2MarginMs: string;
}

/**
 * Rechecked before EVERY irreversible transition (second-leg funding, CLAIM_ARMED, secret
 * reveal, claim submit). Refuses on insufficient remaining margin — caller must move to
 * safe refund/recovery handling instead.
 */
export function assertDeadlineSafety(input: DeadlineSafetyInput): void {
  const l1 = requireRawAmount(input.l1RemainingMarginMs, 'l1RemainingMarginMs');
  const l2 = requireRawAmount(input.l2RemainingMarginMs, 'l2RemainingMarginMs');
  const reqL1 = requireRawAmount(input.requiredL1MarginMs, 'requiredL1MarginMs');
  const reqL2 = requireRawAmount(input.requiredL2MarginMs, 'requiredL2MarginMs');
  if (l1 < reqL1) {
    throw new DeadlineError(`${input.phase} refused: L1 remaining margin ${input.l1RemainingMarginMs}ms < required ${input.requiredL1MarginMs}ms — move to safe refund/recovery`);
  }
  if (l2 < reqL2) {
    throw new DeadlineError(`${input.phase} refused: L2 remaining margin ${input.l2RemainingMarginMs}ms < required ${input.requiredL2MarginMs}ms — move to safe refund/recovery`);
  }
}