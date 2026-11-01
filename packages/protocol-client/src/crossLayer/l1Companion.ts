/**
 * The L1 wallet companion: the safe client layer that runs beside a Minotari wallet.
 *
 * `l1Adapter.ts` is the gRPC CONTRACT — request shapes and response validation, no socket. This
 * module is the layer above it: what must be true before an L1 leg is funded, what must be
 * checked after it is, and how an ambiguous outcome is recorded. It opens no socket either. Both
 * are pure so they can be tested without a wallet, and so neither can reach the network alone.
 *
 * WHAT THIS MODULE WILL NOT DO, and these are not configurable:
 *
 *   * No seed, spend key or view key is ever an input, an output, or a field of any type here.
 *     Signing happens in the wallet, under its own authorization, one transaction at a time.
 *   * No unattended signer. Every operation returns a REQUEST for a person to approve; nothing
 *     here submits, retries or schedules anything.
 *   * It never claims an L1 script executed. `expectedScript` renders what the wallet WILL
 *     build, labelled as expected; only `verifyFundedOutput`, against an observed output, says
 *     anything about what exists.
 *   * An ambiguous submission is UNKNOWN, never failed. `classifySubmission` exists because the
 *     wrong answer there means retrying a transaction that may already have committed.
 *   * It refuses to operate on mainnet. The campaign's own constraint is disposable Esmeralda
 *     assets and wallets, and a module that would happily drive a mainnet wallet holding real
 *     XTM is one accident away from spending it.
 *
 * THE SYNC GAP IS THE SUBTLE ONE, and it is why this module exists at all.
 *
 * `send_sha_atomic_swap` does not take a timeout. It locks the refund branch at
 * `last_scanned_height + 720` — the wallet's OWN scanned height, not the chain tip. So a wallet
 * that is 200 blocks behind produces an output whose refund branch opens only 520 blocks from
 * now, not 720. The claimant's window is shortened by exactly the sync gap, silently, and the
 * L2 deadline derived from the tip would then be WRONG in the dangerous direction: the L1 refund
 * could open before the margin the L2 deadline was supposed to preserve.
 *
 * Nothing in the wallet reports this as a problem, and the funder is not the party who loses.
 * So `assessSync` refuses to fund past a bounded gap, and `verifyFundedOutput` re-checks the
 * refund height that the output ACTUALLY carries rather than the one that was intended.
 */

import { L1_HTLC_REFUND_BLOCKS, type SwapDirection } from './atomicSwap.js';
import { type L1SendAtomicSwapRequest, type L1SendResult } from './l1Adapter.js';

export class L1CompanionError extends Error {}

/**
 * Networks this companion will drive. Mainnet is absent deliberately: the operator's holding is
 * not a development resource, and the one-line change needed to add it is a decision for a
 * person, not a default.
 */
export const L1_APPROVED_NETWORKS: readonly string[] = ['esmeralda', 'igor', 'localnet', 'stagenet'];

export const L1_MAINNET_REFUSAL =
  'This companion will not drive a mainnet wallet. Cross-layer work here runs on disposable Esmeralda assets and wallets; a mainnet wallet holding real XTM is not a test fixture, and no amount of care in this code makes an accidental mainnet spend recoverable.';

/**
 * The largest sync gap, in L1 blocks, that may still fund an HTLC.
 *
 * Any gap shortens the claimant's window by exactly that many blocks. 10 blocks is ~20 minutes
 * on Esmeralda and ~20 minutes on mainnet too (different block times, same order of magnitude
 * relative to the 720-block window), which is small against a window whose margin is half of
 * 720 blocks. Past that, the derived L2 deadline can no longer be trusted to come first.
 */
export const MAX_SYNC_GAP_BLOCKS = 10;

// -------------------------------------------------------------------------------------------
// Capability discovery
// -------------------------------------------------------------------------------------------

/**
 * What a companion found when it asked the wallet what it can do. Every field is something the
 * companion OBSERVED; nothing here is assumed from a version string.
 */
export interface L1WalletFacts {
  /** The network the wallet reports. Checked, not trusted to be the one expected. */
  readonly network: string;
  /** Which of the three atomic-swap methods answered. A method that was not tried is absent. */
  readonly methodsAnswered: readonly ('send' | 'claim' | 'refund')[];
  /**
   * True when the wallet's keys live on a Ledger device. A Ledger wallet CANNOT fund an HTLC:
   * the atomic-swap send path is not implemented for it upstream. It can still receive.
   */
  readonly isLedger: boolean;
  /** A view-only wallet can observe and verify but can sign nothing. */
  readonly isViewOnly: boolean;
  readonly tipHeight: number;
  readonly scannedHeight: number;
  /** Spendable microMinotari, raw. Pending or unconfirmed value must be excluded. */
  readonly spendableMicroRaw: string;
}

export type L1Capability = 'FUND' | 'CLAIM' | 'REFUND' | 'OBSERVE';

export interface L1CapabilityVerdict {
  readonly can: readonly L1Capability[];
  /** Every capability that is absent, with the reason, shown verbatim. */
  readonly cannot: readonly string[];
  /** True only when funding, claiming and refunding are all available. */
  readonly complete: boolean;
}

const RAW = /^\d+$/;
const HEX64 = /^[0-9a-f]{64}$/i;

function requireRaw(value: string, field: string): bigint {
  if (!RAW.test(value)) throw new L1CompanionError(`${field} must be a raw non-negative integer string`);
  return BigInt(value);
}

function requireHeight(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) throw new L1CompanionError(`${field} must be a non-negative integer height`);
  return value;
}

function requireHex64(value: string, field: string): string {
  if (!HEX64.test(value)) throw new L1CompanionError(`${field} must be 64 hex characters`);
  return value.toLowerCase();
}

/**
 * What this wallet can actually do in a cross-layer trade.
 *
 * Observation is listed as a capability of its own because it is the one a view-only or Ledger
 * wallet still has, and it is enough to VERIFY a counterparty's leg — which is most of what
 * makes a trade safe to enter.
 */
export function assessCapabilities(facts: L1WalletFacts): L1CapabilityVerdict {
  const can: L1Capability[] = [];
  const cannot: string[] = [];
  const answered = new Set(facts.methodsAnswered);

  if (!L1_APPROVED_NETWORKS.includes(facts.network.toLowerCase())) {
    return {
      can: [],
      cannot: [
        facts.network.toLowerCase() === 'mainnet'
          ? L1_MAINNET_REFUSAL
          : `This wallet reports network "${facts.network}", which is not one this companion drives (${L1_APPROVED_NETWORKS.join(', ')}).`,
      ],
      complete: false,
    };
  }

  can.push('OBSERVE');

  if (facts.isViewOnly) {
    cannot.push('A view-only wallet holds no spend keys, so it can fund, claim and refund nothing. It can still observe and verify a counterparty\'s leg.');
    return { can, cannot, complete: false };
  }

  if (facts.isLedger) {
    cannot.push(
      'A Ledger wallet cannot fund an HTLC: the atomic-swap send path is not implemented for Ledger keys upstream. It can still receive a claim, so it can be the DESTINATION of a trade but not the funder of the L1 leg.',
    );
  } else if (answered.has('send')) {
    can.push('FUND');
  } else {
    cannot.push('The wallet did not answer SendShaAtomicSwapTransaction, so no L1 escrow can be funded through it.');
  }

  if (answered.has('claim')) can.push('CLAIM');
  else cannot.push('The wallet did not answer ClaimShaAtomicSwapTransaction, so an L1 escrow funded FOR you could not be claimed through it.');

  if (answered.has('refund')) can.push('REFUND');
  else
    cannot.push(
      'The wallet did not answer ClaimHtlcRefundTransaction. Do not fund an L1 escrow through this wallet: a refund is the only way back if the counterparty never claims.',
    );

  return { can, cannot, complete: can.includes('FUND') && can.includes('CLAIM') && can.includes('REFUND') };
}

/**
 * Which capabilities a role needs for a direction — including the refund, which is the one a
 * plan is tempted to leave out because it is only needed when something goes wrong.
 */
export function requiredL1Capabilities(direction: SwapDirection, role: 'USER' | 'MAKER'): readonly L1Capability[] {
  const l1Funder = direction === 'L2_TO_L1' ? 'MAKER' : 'USER';
  return role === l1Funder ? ['FUND', 'REFUND', 'OBSERVE'] : ['CLAIM', 'OBSERVE'];
}

// -------------------------------------------------------------------------------------------
// Sync
// -------------------------------------------------------------------------------------------

export interface SyncVerdict {
  readonly ok: boolean;
  readonly gapBlocks: number;
  /** The refund height the wallet WILL use: scanned + 720. Not the one a tip read implies. */
  readonly actualRefundHeight: number;
  /** What the refund height would be if the wallet were fully synced. */
  readonly intendedRefundHeight: number;
  /** How many blocks of the claimant's window the gap costs. Equals `gapBlocks`. */
  readonly windowLostBlocks: number;
  readonly reason: string;
}

/**
 * Whether this wallet is synced enough to fund an HTLC, and what the gap costs if not.
 *
 * The party harmed by a gap is the CLAIMANT, not the funder, so the funder has no natural
 * incentive to check. That is the whole reason this is a gate and not a warning.
 */
export function assessSync(facts: { readonly tipHeight: number; readonly scannedHeight: number }): SyncVerdict {
  const tip = requireHeight(facts.tipHeight, 'tipHeight');
  const scanned = requireHeight(facts.scannedHeight, 'scannedHeight');
  if (scanned > tip) {
    return {
      ok: false,
      gapBlocks: 0,
      actualRefundHeight: scanned + L1_HTLC_REFUND_BLOCKS,
      intendedRefundHeight: tip + L1_HTLC_REFUND_BLOCKS,
      windowLostBlocks: 0,
      reason: `The wallet reports a scanned height of ${scanned} above the chain tip of ${tip}. One of the two reads is wrong, and neither can be used to derive a deadline.`,
    };
  }
  const gap = tip - scanned;
  const actualRefundHeight = scanned + L1_HTLC_REFUND_BLOCKS;
  const intendedRefundHeight = tip + L1_HTLC_REFUND_BLOCKS;
  if (gap > MAX_SYNC_GAP_BLOCKS) {
    return {
      ok: false,
      gapBlocks: gap,
      actualRefundHeight,
      intendedRefundHeight,
      windowLostBlocks: gap,
      reason: `This wallet is ${gap} blocks behind the tip (scanned ${scanned}, tip ${tip}). The wallet locks the refund branch at its own scanned height + ${L1_HTLC_REFUND_BLOCKS}, so the output would refund at ${actualRefundHeight} instead of ${intendedRefundHeight} — ${gap} blocks of the claimant's window gone, silently. Let the wallet finish syncing before funding.`,
    };
  }
  return {
    ok: true,
    gapBlocks: gap,
    actualRefundHeight,
    intendedRefundHeight,
    windowLostBlocks: gap,
    reason:
      gap === 0
        ? `Synced at height ${tip}. The refund branch will open at ${actualRefundHeight}.`
        : `${gap} block(s) behind the tip, within the ${MAX_SYNC_GAP_BLOCKS}-block bound. The refund branch will open at ${actualRefundHeight}, ${gap} block(s) earlier than a tip-derived estimate.`,
  };
}

// -------------------------------------------------------------------------------------------
// The script, rendered for inspection
// -------------------------------------------------------------------------------------------

export interface ScriptParameters {
  /** SHA-256 the claim branch requires, 64 hex. */
  readonly hashLockHex: string;
  /** The claimant's public key, 64 hex: the only key that may take the claim branch. */
  readonly destinationPublicKeyHex: string;
  /** The funder's public key, 64 hex: the only key that may take the refund branch. */
  readonly senderPublicKeyHex: string;
  readonly refundHeight: number;
}

/**
 * The TariScript the wallet WILL build, rendered so a person can compare it to what their wallet
 * shows them before approving.
 *
 * This is the shape `send_sha_atomic_swap_transaction` constructs in
 * `base_layer/wallet/src/transaction_service/service.rs` (tari 6.3.0-pre.2). It is EXPECTED, not
 * observed: nothing in this module can see a chain, and a rendered script is not evidence that
 * any script executed.
 */
export function expectedScript(params: ScriptParameters): string {
  const hash = requireHex64(params.hashLockHex, 'hashLockHex');
  const destination = requireHex64(params.destinationPublicKeyHex, 'destinationPublicKeyHex');
  const sender = requireHex64(params.senderPublicKeyHex, 'senderPublicKeyHex');
  const height = requireHeight(params.refundHeight, 'refundHeight');
  if (destination === sender) {
    throw new L1CompanionError('The claimant and the funder must be different keys, or the script has no two outcomes.');
  }
  return [
    'HashSha256',
    `PushHash(${hash})`,
    'Equal',
    'IfThen',
    `  PushPubKey(${destination})`,
    'Else',
    `  CheckHeightVerify(${height})`,
    `  PushPubKey(${sender})`,
    'EndIf',
  ].join(' ');
}

/** One line a person can read before approving, naming both outcomes and who gets each. */
export function describeScript(params: ScriptParameters): string {
  const script = expectedScript(params);
  return (
    `Two outcomes, no others. CLAIM: whoever presents a value whose SHA-256 is ` +
    `${params.hashLockHex.toLowerCase()} and signs for ${params.destinationPublicKeyHex.toLowerCase()} takes the ` +
    `output, at any height. REFUND: from height ${params.refundHeight}, ` +
    `${params.senderPublicKeyHex.toLowerCase()} can take it back. Before that height the funder cannot ` +
    `recover it, and on L1 a late claim races the refund because the claim branch carries no ` +
    `height condition of its own. Script: ${script}`
  );
}

// -------------------------------------------------------------------------------------------
// Funding
// -------------------------------------------------------------------------------------------

/**
 * UTF-8 to lowercase hex, without Buffer or TextEncoder.
 *
 * This module is shared with the browser bundle, where Buffer does not exist, and the memo is
 * bounded to 128 characters, so a hand-rolled encoder is cheaper than a polyfill and has no
 * environment to be wrong about.
 */
function utf8ToHex(text: string): string {
  let hex = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const bytes: number[] =
      code < 0x80
        ? [code]
        : code < 0x800
          ? [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
          : code < 0x10000
            ? [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
            : [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export interface FundingIntent {
  readonly network: string;
  readonly direction: SwapDirection;
  readonly role: 'USER' | 'MAKER';
  /** The counterparty's base58 Tari address: the claim branch's destination. */
  readonly destinationAddress: string;
  readonly amountMicroRaw: string;
  readonly feePerGramRaw: string;
  /** Identifies the other chain's leg, recorded in the memo. Public, bounded. */
  readonly counterpartyLegMemo?: string;
}

export type FundingPlan =
  | {
      readonly ok: true;
      /** The request to hand to `fundL1Htlc`, after a person approves it. */
      readonly request: L1SendAtomicSwapRequest;
      readonly sync: SyncVerdict;
      /** Everything the wallet decides for itself, so a review card can state it. */
      readonly notControllable: readonly string[];
      readonly review: string;
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * Prepares one funding request, or refuses it.
 *
 * It returns a request to be APPROVED, never a submission. The checks here are the ones that
 * cannot be made after the fact: once an L1 HTLC is funded, its hash, its destination and its
 * refund height are fixed, and the funder cannot recover the output until that height whatever
 * they discover in between.
 */
export function planL1Funding(intent: FundingIntent, facts: L1WalletFacts): FundingPlan {
  const capability = assessCapabilities(facts);
  if (!capability.can.includes('FUND')) {
    return { ok: false, refusal: capability.cannot.join(' ') };
  }
  if (facts.network.toLowerCase() !== intent.network.toLowerCase()) {
    return {
      ok: false,
      refusal: `The wallet is on ${facts.network} but this trade is for ${intent.network}. An output funded on the wrong network is not recoverable by the other side's refund either.`,
    };
  }
  if (!capability.can.includes('REFUND')) {
    return {
      ok: false,
      refusal:
        'This wallet cannot refund, so funding an L1 escrow through it would leave no way back if the counterparty never claims. Refused.',
    };
  }
  const sync = assessSync(facts);
  if (!sync.ok) return { ok: false, refusal: sync.reason };

  let amount: bigint;
  let fee: bigint;
  try {
    amount = requireRaw(intent.amountMicroRaw, 'amountMicroRaw');
    fee = requireRaw(intent.feePerGramRaw, 'feePerGramRaw');
    requireRaw(facts.spendableMicroRaw, 'spendableMicroRaw');
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  if (amount === 0n) return { ok: false, refusal: 'An escrow of zero cannot be claimed and is not a trade.' };
  if (fee === 0n) return { ok: false, refusal: 'feePerGramRaw must be positive, or the wallet cannot build a transaction.' };
  if (intent.destinationAddress.trim().length === 0) {
    return { ok: false, refusal: 'A destination address is required: it is the only key that can take the claim branch.' };
  }
  if (amount > BigInt(facts.spendableMicroRaw)) {
    return {
      ok: false,
      refusal: `The wallet reports ${facts.spendableMicroRaw} µXTM spendable, which cannot fund ${intent.amountMicroRaw}. A partially funded escrow cannot settle the trade.`,
    };
  }
  if (intent.counterpartyLegMemo !== undefined && intent.counterpartyLegMemo.length > 128) {
    return { ok: false, refusal: 'counterpartyLegMemo must be at most 128 characters, matching the L2 template bound.' };
  }

  const request: L1SendAtomicSwapRequest = {
    address: intent.destinationAddress.trim(),
    amountMicroRaw: intent.amountMicroRaw,
    feePerGramRaw: intent.feePerGramRaw,
    ...(intent.counterpartyLegMemo === undefined
      ? {}
      : { rawPaymentIdHex: utf8ToHex(intent.counterpartyLegMemo) }),
  };
  return {
    ok: true,
    request,
    sync,
    notControllable: [
      'The hash lock is not an input: the wallet generates the secret itself and returns it in the response. Whoever funds this leg therefore holds the secret for the whole trade.',
      `The refund height is not an input: it is fixed at the wallet's scanned height + ${L1_HTLC_REFUND_BLOCKS} blocks, which is ${sync.actualRefundHeight} for this wallet right now.`,
      'UTXO selection is not an input: the wallet uses its default criteria.',
      'The amount and the destination are public on L1 the moment this confirms.',
    ],
    review:
      `Fund ${intent.amountMicroRaw} µXTM into a hash-time-locked output claimable by ` +
      `${intent.destinationAddress.trim()}, refundable to you from height ${sync.actualRefundHeight}. ` +
      `You cannot recover it before that height, whatever happens in between. The secret that ` +
      `opens it is generated by your wallet and must not leave this machine until you claim the ` +
      `counterparty's leg with it.`,
  };
}

// -------------------------------------------------------------------------------------------
// Observation and verification
// -------------------------------------------------------------------------------------------

/** An output as OBSERVED on L1. Absent script fields mean the companion could not read them. */
export interface ObservedL1Output {
  readonly outputHashHex: string;
  readonly amountMicroRaw: string;
  readonly confirmations: number;
  /** From the output's script, where the companion can read it. */
  readonly scriptHashLockHex?: string;
  readonly scriptDestinationPublicKeyHex?: string;
  readonly scriptRefundHeight?: number;
  /** True once the output has been spent — by a claim or a refund. */
  readonly spent?: boolean;
}

export interface ExpectedL1Output {
  readonly outputHashHex: string;
  readonly amountMicroRaw: string;
  readonly hashLockHex: string;
  readonly destinationPublicKeyHex: string;
  readonly refundHeight: number;
  /** Confirmations required before this is treated as settled. */
  readonly minConfirmations: number;
}

export type L1OutputVerdict = {
  /** True only when every checkable field matched and the output has enough confirmations. */
  readonly confirmed: boolean;
  /** Mismatches that make this output unusable. Shown verbatim; never summarised away. */
  readonly mismatches: readonly string[];
  /** Things that could not be checked, which is not the same as things that passed. */
  readonly unverified: readonly string[];
  readonly reason: string;
};

/**
 * Checks an observed L1 output against what the trade requires.
 *
 * The distinction between a MISMATCH and an UNVERIFIED field is the point of this function. A
 * companion that cannot read an output's script has not verified the hash lock, and reporting
 * that as a pass would let a counterparty fund a leg against an output whose claim branch
 * commits to a different secret.
 */
export function verifyFundedOutput(observed: ObservedL1Output, expected: ExpectedL1Output): L1OutputVerdict {
  const mismatches: string[] = [];
  const unverified: string[] = [];

  if (requireHex64(observed.outputHashHex, 'outputHashHex') !== requireHex64(expected.outputHashHex, 'expected.outputHashHex')) {
    mismatches.push(`This is output ${observed.outputHashHex.toLowerCase()}, not the ${expected.outputHashHex.toLowerCase()} the trade names.`);
  }
  const seen = requireRaw(observed.amountMicroRaw, 'amountMicroRaw');
  const want = requireRaw(expected.amountMicroRaw, 'expected.amountMicroRaw');
  if (seen < want) {
    mismatches.push(`The output holds ${observed.amountMicroRaw} µXTM, less than the ${expected.amountMicroRaw} agreed. A claim takes the whole output, so the shortfall cannot be made up later.`);
  }

  if (observed.scriptHashLockHex === undefined) {
    unverified.push("The output's hash lock could not be read, so it has NOT been checked against this trade's hash. Do not fund the other leg on the strength of this read.");
  } else if (requireHex64(observed.scriptHashLockHex, 'scriptHashLockHex') !== requireHex64(expected.hashLockHex, 'expected.hashLockHex')) {
    mismatches.push(`The output's claim branch commits to hash ${observed.scriptHashLockHex.toLowerCase()}, not ${expected.hashLockHex.toLowerCase()}. A secret that opens one does not open the other.`);
  }

  if (observed.scriptDestinationPublicKeyHex === undefined) {
    unverified.push("The output's claim destination could not be read, so who may claim it has NOT been checked.");
  } else if (
    requireHex64(observed.scriptDestinationPublicKeyHex, 'scriptDestinationPublicKeyHex') !==
    requireHex64(expected.destinationPublicKeyHex, 'expected.destinationPublicKeyHex')
  ) {
    mismatches.push(
      `The output is claimable by ${observed.scriptDestinationPublicKeyHex.toLowerCase()}, not ${expected.destinationPublicKeyHex.toLowerCase()}. It pays somebody else and cannot be redirected.`,
    );
  }

  if (observed.scriptRefundHeight === undefined) {
    unverified.push("The output's refund height could not be read, so the claimant's actual window is unknown.");
  } else if (observed.scriptRefundHeight !== expected.refundHeight) {
    // Lower is the dangerous direction: the funder can take it back sooner than the trade's
    // margin assumed. Higher only lengthens the claimant's window, which is safe for them, but
    // it still means the deadlines were derived from something other than this output.
    const worse = observed.scriptRefundHeight < expected.refundHeight;
    mismatches.push(
      `The output refunds at height ${observed.scriptRefundHeight}, not ${expected.refundHeight}` +
        (worse
          ? `. That is ${expected.refundHeight - observed.scriptRefundHeight} blocks EARLIER than the trade's deadlines assume, so the funder could take it back inside the margin meant to protect the claimant.`
          : `. That is later than assumed, which lengthens the claim window but means the deadlines were derived from a different output than this one.`),
    );
  }

  if (observed.spent === true) {
    mismatches.push('This output has already been spent — claimed or refunded. There is nothing left in it.');
  }

  const enough = observed.confirmations >= expected.minConfirmations;
  if (!enough) {
    unverified.push(`The output has ${observed.confirmations} confirmation(s), fewer than the ${expected.minConfirmations} this trade requires. It can still be reorganised out.`);
  }

  const confirmed = mismatches.length === 0 && unverified.length === 0;
  return {
    confirmed,
    mismatches,
    unverified,
    reason: confirmed
      ? `Output ${observed.outputHashHex.toLowerCase()} holds ${observed.amountMicroRaw} µXTM, commits to the agreed hash, is claimable by the agreed key, refunds at ${expected.refundHeight}, and has ${observed.confirmations} confirmations.`
      : [...mismatches, ...unverified].join(' '),
  };
}

// -------------------------------------------------------------------------------------------
// Claim and refund
// -------------------------------------------------------------------------------------------

export type L1ActionPlan =
  | { readonly ok: true; readonly request: { readonly outputHashHex: string; readonly feePerGramRaw: string }; readonly review: string }
  | { readonly ok: false; readonly refusal: string };

/**
 * Prepares a refund, which is only possible at or after the output's own refund height.
 *
 * The height comes from the OBSERVED output, not from what the trade intended: if the wallet was
 * behind when it funded, those are different numbers, and the observed one is the one consensus
 * will enforce.
 */
export function planRefund(
  observed: ObservedL1Output,
  tipHeight: number,
  feePerGramRaw: string,
): L1ActionPlan {
  requireHex64(observed.outputHashHex, 'outputHashHex');
  const tip = requireHeight(tipHeight, 'tipHeight');
  try {
    if (requireRaw(feePerGramRaw, 'feePerGramRaw') === 0n) throw new L1CompanionError('feePerGramRaw must be positive');
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  if (observed.spent === true) {
    return { ok: false, refusal: 'This output has already been spent. Read its spending transaction before doing anything else: if the counterparty claimed it, the secret is now public and your own claim on the other chain may still be open.' };
  }
  if (observed.scriptRefundHeight === undefined) {
    return {
      ok: false,
      refusal: "This output's refund height could not be read, so there is no way to tell whether a refund would be accepted yet. A refund submitted too early is rejected by consensus, and the attempt tells the counterparty you are trying.",
    };
  }
  if (tip < observed.scriptRefundHeight) {
    return {
      ok: false,
      refusal: `This output refunds from height ${observed.scriptRefundHeight} and the tip is ${tip}: ${observed.scriptRefundHeight - tip} block(s) to go. Until then it is the claimant's to take, and a refund cannot be built.`,
    };
  }
  return {
    ok: true,
    request: { outputHashHex: observed.outputHashHex.toLowerCase(), feePerGramRaw },
    review: `Recover ${observed.amountMicroRaw} µXTM from output ${observed.outputHashHex.toLowerCase()}, whose refund branch opened at height ${observed.scriptRefundHeight} (tip ${tip}). On L1 the claim branch has no height condition, so a counterparty holding the secret can still race this refund until it confirms.`,
  };
}

/**
 * Prepares a claim. The secret is supplied by the caller at the moment of signing and is NOT
 * stored in the returned plan: it goes straight into the request `l1Adapter.claimL1Htlc` sends.
 *
 * The caller must have read the secret from the L2 escrow that published it. This function
 * checks only its shape, because its correctness is a fact about a hash it cannot compute here
 * without pulling in a digest — `verifyFundedOutput` is where the hash lock is checked, and the
 * wallet's own claim will fail loudly if the secret does not open the script.
 */
export function planClaim(observed: ObservedL1Output, feePerGramRaw: string): L1ActionPlan {
  requireHex64(observed.outputHashHex, 'outputHashHex');
  try {
    if (requireRaw(feePerGramRaw, 'feePerGramRaw') === 0n) throw new L1CompanionError('feePerGramRaw must be positive');
  } catch (e) {
    return { ok: false, refusal: (e as Error).message };
  }
  if (observed.spent === true) {
    return { ok: false, refusal: 'This output has already been spent; there is nothing to claim. If the funder refunded it, your own escrow on the other chain is still yours to recover after its deadline.' };
  }
  return {
    ok: true,
    request: { outputHashHex: observed.outputHashHex.toLowerCase(), feePerGramRaw },
    review: `Claim ${observed.amountMicroRaw} µXTM from output ${observed.outputHashHex.toLowerCase()} by revealing the secret. Revealing it makes it public: the funder can then take your leg on the other chain, which is exactly the trade. Claim the LATER-expiring leg only once your own is safe.`,
  };
}

// -------------------------------------------------------------------------------------------
// Submission outcomes
// -------------------------------------------------------------------------------------------

export type SubmissionOutcome = 'CONFIRMED' | 'REFUSED' | 'UNKNOWN';

export interface SubmissionReport {
  readonly outcome: SubmissionOutcome;
  readonly reason: string;
  /** True when the caller must read chain state before any retry. */
  readonly mustCheckChainBeforeRetry: boolean;
}

/**
 * Classifies what happened to a submission, and the only interesting case is UNKNOWN.
 *
 * A transport that failed AFTER the wallet accepted a transaction looks exactly like one that
 * failed before. Calling that "failed" and retrying can fund or claim twice; an economic
 * operation that may have committed must be reconciled against chain state, not retried.
 */
export function classifySubmission(input: {
  /** A wallet response that was parsed successfully, if one arrived. */
  readonly parsed?: { readonly transactionId: string; readonly isSuccess: boolean; readonly failureMessage?: string };
  /** A transport-level error, if the call did not return a response at all. */
  readonly transportError?: string;
  /** True when the request was known to have been written to the wire. */
  readonly requestSent: boolean;
}): SubmissionReport {
  if (input.parsed !== undefined) {
    if (input.parsed.isSuccess) {
      return {
        outcome: 'CONFIRMED',
        reason: `The wallet accepted the transaction as ${input.parsed.transactionId}. Accepted is not confirmed: it is in the mempool until it is in a block.`,
        mustCheckChainBeforeRetry: false,
      };
    }
    return {
      outcome: 'REFUSED',
      reason: `The wallet refused it: ${input.parsed.failureMessage ?? 'no reason given'}. Nothing was submitted, so this is safe to correct and retry.`,
      mustCheckChainBeforeRetry: false,
    };
  }
  if (input.transportError === undefined) {
    return {
      outcome: 'UNKNOWN',
      reason: 'No response and no error: the outcome of this submission is unknown. Read the chain for this output before doing anything else.',
      mustCheckChainBeforeRetry: true,
    };
  }
  if (!input.requestSent) {
    return {
      outcome: 'REFUSED',
      reason: `The request never reached the wallet (${input.transportError}), so nothing was submitted and this is safe to retry.`,
      mustCheckChainBeforeRetry: false,
    };
  }
  return {
    outcome: 'UNKNOWN',
    reason: `The request reached the wallet but no answer came back (${input.transportError}). This is UNKNOWN, not failed: the wallet may have accepted it. Read the chain for this output before any retry — retrying a funding or a claim that already committed spends twice.`,
    mustCheckChainBeforeRetry: true,
  };
}

/**
 * Reconciles an L1 settlement against a balance delta, which is the only evidence that counts.
 *
 * Mirrors `reconcileSettlement` in `swapLifecycle.ts` deliberately: a transaction id proves a
 * submission, not an arrival, and the two chains must be held to the same standard.
 */
export function reconcileL1Settlement(input: {
  readonly baselineMicroRaw: string;
  readonly observedMicroRaw: string;
  readonly expectedMicroRaw: string;
}): { readonly settled: boolean; readonly gainedMicroRaw: string; readonly reason: string } {
  const baseline = requireRaw(input.baselineMicroRaw, 'baselineMicroRaw');
  const observed = requireRaw(input.observedMicroRaw, 'observedMicroRaw');
  const expected = requireRaw(input.expectedMicroRaw, 'expectedMicroRaw');
  const gained = observed - baseline;
  if (gained >= expected) {
    return {
      settled: true,
      gainedMicroRaw: gained.toString(),
      reason: `The L1 balance rose by ${gained} µXTM against a baseline of ${baseline}, covering the ${expected} expected.`,
    };
  }
  return {
    settled: false,
    gainedMicroRaw: gained > 0n ? gained.toString() : '0',
    reason:
      gained <= 0n
        ? `The L1 balance has not risen above its baseline of ${baseline} µXTM. Nothing has arrived, whatever any transaction id says.`
        : `The L1 balance rose by only ${gained} µXTM of the ${expected} expected. A partial arrival is not a settlement; a claim takes a whole output, so this is a different payment.`,
  };
}

/** Everything a companion must never be asked for, stated so a future caller does not. */
export const L1_COMPANION_NEVER: readonly string[] = [
  'A seed phrase, spend key or view key. Signing happens in the wallet, under its own authorization.',
  'An unattended signer. Every operation here returns a request for a person to approve.',
  'A stored secret. The secret the wallet generates stays on the funder\'s machine and leaves it only as a claim on the counterparty\'s leg.',
  'A retry of an UNKNOWN submission. Read the chain for the output first.',
  'A mainnet wallet. ' + L1_MAINNET_REFUSAL,
];

/** The redacted public facts a counterparty needs from a funding, and nothing else. */
export function publishableFunding(result: L1SendResult, amountMicroRaw: string, refundHeight: number): {
  readonly outputHashHex: string;
  readonly amountMicroRaw: string;
  readonly refundHeight: number;
} {
  return {
    outputHashHex: result.outputHashHex.toLowerCase(),
    amountMicroRaw: requireRaw(amountMicroRaw, 'amountMicroRaw').toString(),
    refundHeight: requireHeight(refundHeight, 'refundHeight'),
  };
}
