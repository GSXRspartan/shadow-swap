/**
 * The cross-layer exchange lifecycle, and its recovery.
 *
 * A cross-layer trade spans two chains and four transactions. A browser closing must never
 * destroy the ability to recover funds, so every stage is reconstructible from durable
 * non-secret state plus fresh chain reads — and the stages that rest on a user's word say so in
 * their names.
 *
 * WHERE THE PREIMAGE LIVES, which is the one genuinely hard question here.
 *
 * `send_sha_atomic_swap` generates the preimage inside the L1 wallet and returns it ONCE. Whoever
 * funds L1 holds it, and needs it later to claim the counterparty's L2 escrow. So it cannot
 * simply be discarded — but it must not sit in browser storage either, where it is readable by
 * anything with access to the origin and survives in backups.
 *
 * The resolution: **the preimage's durable home is the local companion beside the L1 wallet**,
 * which is where it was produced. The browser holds only its HASH (public, and already committed
 * on both chains) and fetches the preimage from the companion at the moment it builds a claim.
 * `CrossLayerSwapRecord` therefore has no preimage field at all, and `assertRecordIsSafe` refuses
 * to persist anything shaped like one. On reload the browser recovers the stage from chain and
 * re-fetches the secret only when it is about to be spent.
 *
 * An ambiguous submission is UNKNOWN, never failed: a cross-layer leg that may have committed
 * must be checked against chain state before anything is retried, because retrying a funded
 * escrow would fund a second one.
 */

import type { SwapDirection } from './atomicSwap.js';

/**
 * Stages, in the order a successful exchange passes through them. Ordered so a UI can show
 * progress and a test can assert monotonicity.
 */
export type SwapStage =
  /** Terms agreed, nothing funded. Either side may still walk away at no cost. */
  | 'QUOTED'
  /** The L1 leg has been submitted but not confirmed. May or may not have committed. */
  | 'L1_FUNDING_SUBMITTED'
  /** The L1 escrow is confirmed on chain, with its amount and hash lock verified by a read. */
  | 'L1_FUNDED'
  /** The L2 leg has been submitted. */
  | 'L2_FUNDING_SUBMITTED'
  /** Both escrows exist and have been verified against each other. */
  | 'BOTH_FUNDED'
  /** The secret holder has claimed the L2 escrow, publishing the preimage on L2. */
  | 'PREIMAGE_REVEALED'
  /** The second claim is in: both sides settled, balances reconciled. */
  | 'SETTLED'
  /** An L2 escrow was recovered by its funder after expiry. */
  | 'L2_REFUNDED'
  /** An L1 escrow was recovered by its funder after its height. */
  | 'L1_REFUNDED'
  /** A submission's outcome could not be established. Requires a chain read, never a retry. */
  | 'UNKNOWN'
  /** Something checkable disagrees; `blockers` says what. */
  | 'BLOCKED';

export const SWAP_STAGES: readonly SwapStage[] = [
  'QUOTED',
  'L1_FUNDING_SUBMITTED',
  'L1_FUNDED',
  'L2_FUNDING_SUBMITTED',
  'BOTH_FUNDED',
  'PREIMAGE_REVEALED',
  'SETTLED',
  'L2_REFUNDED',
  'L1_REFUNDED',
  'UNKNOWN',
  'BLOCKED',
];

/** Stages from which no further action is possible. */
export const TERMINAL_STAGES: readonly SwapStage[] = ['SETTLED', 'L2_REFUNDED', 'L1_REFUNDED'];

/**
 * The durable record. ONLY non-secret identifiers and public chain data.
 *
 * No preimage field exists, by construction — see the module comment. The hash lock IS here
 * because it is committed in both escrows and is public on both chains.
 */
export interface CrossLayerSwapRecord {
  readonly swapId: string;
  readonly direction: SwapDirection;
  readonly network: string;
  readonly stage: SwapStage;
  /** Who this client is in the trade. Decides which legs it may sign. */
  readonly role: 'USER' | 'MAKER';
  readonly l2Account: string;
  readonly l1Address: string;
  readonly counterpartyL2PublicKey: string;
  readonly counterpartyL1Address: string;
  readonly hashLockHex: string;
  readonly l2ResourceAddress: string;
  readonly l2RawAmount: string;
  readonly l1MicroAmount: string;
  /** Deadlines, both absolute and both derived rather than chosen. */
  readonly l2ExpiresAtEpoch: number;
  readonly l1RefundHeight: number;
  /** Chain references, filled in as each leg lands. */
  readonly l1OutputHashHex?: string;
  readonly l1FundingTxId?: string;
  readonly l2EscrowComponent?: string;
  readonly l2FundingTxId?: string;
  readonly l2ClaimTxId?: string;
  readonly l1ClaimTxId?: string;
  readonly refundTxId?: string;
  /** Balance baselines, so a receipt is reconciled against a delta rather than a guess. */
  readonly l2BaselineRaw?: string;
  readonly l1BaselineMicro?: string;
  readonly blockers?: readonly string[];
  readonly updatedAtUnixMs: number;
}

export class SwapRecordError extends Error {}

/**
 * Field names that may never be persisted. Matched as substrings so `preImageHex`,
 * `swapSecret` and `spend_key` are all caught; `hashLockHex` is not, because a hash lock is
 * public and committed on both chains.
 */
const SECRET_PATTERN = /(pre.?image|secret|mnemonic|seed|private.?key|view.?key|spend.?key|signing.?key|mask)/i;

/** Refuses to persist anything secret-shaped, whatever a caller passes. */
export function assertRecordIsSafe(record: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(record)) {
    if (SECRET_PATTERN.test(key)) {
      throw new SwapRecordError(
        `A cross-layer swap record may never carry "${key}". The preimage's durable home is the local companion beside the L1 wallet, not browser storage.`,
      );
    }
  }
}

export function serializeSwap(record: CrossLayerSwapRecord): string {
  assertRecordIsSafe(record as unknown as Record<string, unknown>);
  return JSON.stringify(record);
}

/**
 * Restores a record, or `undefined` when it cannot be trusted. Never throws: a swap's truth is on
 * chain, so an unusable aid must degrade to "nothing recovered" rather than to an error a user
 * cannot act on. Browser storage is attacker-writable in a shared browser, so each rejection is
 * explicit.
 */
export function restoreSwap(
  raw: string | null | undefined,
  expect: { readonly network: string; readonly l2Account: string },
): CrossLayerSwapRecord | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  if (r.network !== expect.network || r.l2Account !== expect.l2Account) return undefined;
  if (!SWAP_STAGES.includes(r.stage as SwapStage)) return undefined;
  if (typeof r.swapId !== 'string' || r.swapId.length === 0) return undefined;
  if (typeof r.updatedAtUnixMs !== 'number' || !Number.isFinite(r.updatedAtUnixMs)) return undefined;
  try {
    assertRecordIsSafe(r);
  } catch {
    return undefined;
  }
  return r as unknown as CrossLayerSwapRecord;
}

/**
 * What this client may do right now, given the record and the live chain position.
 *
 * Deliberately the single source of "can I act": a UI that decided per-button would eventually
 * offer a claim on an expired escrow or a refund on a live one.
 */
export type SwapAction =
  | 'FUND_L1'
  | 'FUND_L2'
  | 'CLAIM_L2'
  | 'CLAIM_L1'
  | 'REFUND_L2'
  | 'REFUND_L1'
  | 'RESOLVE_UNKNOWN'
  | 'WAIT'
  | 'NOTHING';

export interface ChainPosition {
  readonly l2CurrentEpoch: number;
  readonly l1TipHeight: number;
}

export interface ActionVerdict {
  readonly action: SwapAction;
  /** Shown verbatim. For WAIT and NOTHING it is what is being waited for, or why not. */
  readonly reason: string;
}

/**
 * Which leg each role funds, from the direction. The L1 funder is always the secret holder
 * because L1 generates the preimage, so this is forced rather than chosen.
 */
function l1FunderRole(direction: SwapDirection): 'USER' | 'MAKER' {
  return direction === 'L2_TO_L1' ? 'MAKER' : 'USER';
}

export function nextAction(record: CrossLayerSwapRecord, position: ChainPosition): ActionVerdict {
  const l1Funder = l1FunderRole(record.direction);
  const isL1Funder = record.role === l1Funder;
  const l2Expired = position.l2CurrentEpoch >= record.l2ExpiresAtEpoch;
  const l1Refundable = position.l1TipHeight >= record.l1RefundHeight;

  if (record.stage === 'UNKNOWN') {
    return {
      action: 'RESOLVE_UNKNOWN',
      reason:
        'A submission\'s outcome could not be established. Read the chain for this escrow before doing anything else: retrying could fund a second escrow, and that loss would not be recoverable by this protocol.',
    };
  }
  if (record.stage === 'BLOCKED') {
    return { action: 'NOTHING', reason: (record.blockers ?? ['This exchange cannot proceed.']).join(' ') };
  }
  if (TERMINAL_STAGES.includes(record.stage)) {
    return { action: 'NOTHING', reason: `This exchange is finished (${record.stage.toLowerCase().replace(/_/g, ' ')}).` };
  }

  switch (record.stage) {
    case 'QUOTED':
      return isL1Funder
        ? { action: 'FUND_L1', reason: 'You hold the secret for this trade, so you fund the L1 leg first. Your escrow has the LATER deadline, which is what gives your counterparty time to act after you reveal.' }
        : { action: 'WAIT', reason: 'Waiting for your counterparty to fund the L1 leg. Nothing of yours is committed yet, and you can walk away at no cost.' };
    case 'L1_FUNDING_SUBMITTED':
      return { action: 'WAIT', reason: 'The L1 escrow has been submitted but not confirmed. Do not fund the L2 leg until the L1 output is confirmed and its amount and hash lock have been read from chain.' };
    case 'L1_FUNDED':
      if (isL1Funder) return { action: 'WAIT', reason: 'Waiting for your counterparty to fund the L2 escrow against the hash in your L1 output.' };
      if (l2Expired) {
        return { action: 'NOTHING', reason: `The L2 deadline (epoch ${record.l2ExpiresAtEpoch}) has already passed, so funding now would create an escrow that could be refunded before it could be claimed. Do not fund.` };
      }
      return { action: 'FUND_L2', reason: 'The L1 escrow is confirmed and its hash lock matches. Funding the L2 leg commits your side; you recover it only after its deadline if the trade does not complete.' };
    case 'L2_FUNDING_SUBMITTED':
      return { action: 'WAIT', reason: 'The L2 escrow has been submitted but not confirmed.' };
    case 'BOTH_FUNDED':
      if (isL1Funder) {
        return l2Expired
          ? { action: 'WAIT', reason: `The L2 escrow expired at epoch ${record.l2ExpiresAtEpoch}, so it can no longer be claimed and your counterparty will recover it. Your own L1 escrow becomes refundable at height ${record.l1RefundHeight}.` }
          : { action: 'CLAIM_L2', reason: 'Claim the L2 escrow with your preimage. This publishes the preimage on L2, which is what lets your counterparty take the L1 side.' };
      }
      return l2Expired
        ? { action: 'REFUND_L2', reason: `Your L2 escrow expired at epoch ${record.l2ExpiresAtEpoch} unclaimed. Recover it.` }
        : { action: 'WAIT', reason: 'Waiting for your counterparty to claim the L2 escrow, which publishes the preimage you need for the L1 side.' };
    case 'PREIMAGE_REVEALED':
      if (isL1Funder) return { action: 'WAIT', reason: 'You have the L2 funds. Waiting for your counterparty to claim the L1 side with the revealed preimage.' };
      return l1Refundable
        ? { action: 'CLAIM_L1', reason: `The preimage is public on L2. Claim the L1 output NOW: it is already past its refund height (${record.l1RefundHeight}), so the funder may recover it at any moment and you would be racing them.` }
        : { action: 'CLAIM_L1', reason: `The preimage is public on L2. Claim the L1 output before height ${record.l1RefundHeight}, after which the funder can recover it.` };
    default:
      return { action: 'NOTHING', reason: `No action is defined for stage ${record.stage}.` };
  }
}

/**
 * Promotes a submitted leg only on a chain read that reconciles.
 *
 * The amount and hash lock are BOTH checked: a counterparty who funded the right hash for the
 * wrong amount, or the right amount against a hash no L2 escrow could use, must not advance the
 * trade. This is the check that stops a user committing their own side against a bad leg.
 */
export function confirmL1Funding(
  record: CrossLayerSwapRecord,
  observed: { readonly outputHashHex: string; readonly microAmount: string; readonly hashLockHex: string; readonly confirmations: number },
  requiredConfirmations: number,
  now = Date.now(),
): CrossLayerSwapRecord {
  if (record.stage !== 'L1_FUNDING_SUBMITTED' && record.stage !== 'QUOTED' && record.stage !== 'UNKNOWN') return record;
  const blockers: string[] = [];
  if (observed.hashLockHex.toLowerCase() !== record.hashLockHex.toLowerCase()) {
    blockers.push(`The L1 output commits to hash ${observed.hashLockHex}, not the ${record.hashLockHex} this trade agreed. Do not fund the L2 leg: a preimage for that hash would not open your escrow.`);
  }
  if (BigInt(observed.microAmount) < BigInt(record.l1MicroAmount)) {
    blockers.push(`The L1 output holds ${observed.microAmount}, below the ${record.l1MicroAmount} agreed. Do not fund the L2 leg.`);
  }
  if (blockers.length > 0) return { ...record, stage: 'BLOCKED', blockers, updatedAtUnixMs: now };
  if (observed.confirmations < requiredConfirmations) {
    return { ...record, stage: 'L1_FUNDING_SUBMITTED', l1OutputHashHex: observed.outputHashHex, updatedAtUnixMs: now };
  }
  return { ...record, stage: 'L1_FUNDED', l1OutputHashHex: observed.outputHashHex, updatedAtUnixMs: now };
}

/**
 * Marks a submission whose outcome is unknown. Never 'failed': it may have committed.
 *
 * Named for this module because the existing execution layer already exports a `markUnknown`
 * for single-chain operations, and the two must not be interchangeable: a cross-layer leg that
 * may have committed has a counterparty waiting on it.
 */
export function markSwapUnknown(record: CrossLayerSwapRecord, what: string, now = Date.now()): CrossLayerSwapRecord {
  return {
    ...record,
    stage: 'UNKNOWN',
    blockers: [`${what} was submitted but its outcome could not be established. Read the chain before retrying: a retry could fund or claim twice.`],
    updatedAtUnixMs: now,
  };
}

/**
 * Reconciles a receipt against a balance delta, which is the only evidence that counts.
 *
 * A transaction id proves a submission, not an arrival. So settlement is recorded only when the
 * destination's balance has risen by at least the agreed amount since the baseline.
 */
export function reconcileSettlement(
  record: CrossLayerSwapRecord,
  observed: { readonly l2BalanceRaw?: string; readonly l1BalanceMicro?: string },
  now = Date.now(),
): CrossLayerSwapRecord {
  if (TERMINAL_STAGES.includes(record.stage)) return record;
  const wantsL2 = record.direction === 'L1_TO_L2' ? record.role === 'USER' : record.role === 'MAKER';
  if (wantsL2) {
    if (observed.l2BalanceRaw === undefined || record.l2BaselineRaw === undefined) return record;
    const gained = BigInt(observed.l2BalanceRaw) - BigInt(record.l2BaselineRaw);
    if (gained < BigInt(record.l2RawAmount)) return record;
  } else {
    if (observed.l1BalanceMicro === undefined || record.l1BaselineMicro === undefined) return record;
    const gained = BigInt(observed.l1BalanceMicro) - BigInt(record.l1BaselineMicro);
    if (gained < BigInt(record.l1MicroAmount)) return record;
  }
  return { ...record, stage: 'SETTLED', updatedAtUnixMs: now };
}

/** One line for a UI, stating evidence rather than implying more than exists. */
export function describeSwap(record: CrossLayerSwapRecord, position: ChainPosition): string {
  const verdict = nextAction(record, position);
  const where = record.direction === 'L2_TO_L1' ? 'L2 TARI for L1 XTM' : 'L1 XTM for L2 TARI';
  return `${where}, stage ${record.stage}: ${verdict.reason}`;
}
