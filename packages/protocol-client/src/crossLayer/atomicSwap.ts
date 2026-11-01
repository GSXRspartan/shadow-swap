/**
 * Cross-layer atomic exchange: L2 Ootle TARI against L1 Minotari XTM that a counterparty
 * ALREADY HOLDS. No burn, no mint, no bridge, no custodian.
 *
 * This is NOT Tari's native burn-and-claim. That route exists, is one-way (L1 -> L2), and is
 * handled elsewhere (`burnClaim.ts`). What this module settles is a bilateral trade against
 * existing inventory on both layers, which is the only way an L2 TARI holder can get real L1
 * XTM at all: v0.48 has no peg-out instruction and the base layer has no verifier for an L2
 * exit proof.
 *
 * WHAT EACH CHAIN ACTUALLY ENFORCES (read from source, not assumed)
 *
 * L1 Minotari 6.3.0-pre.2, `send_sha_atomic_swap_transaction`
 * (base_layer/wallet/src/transaction_service/service.rs) builds exactly:
 *
 *     HashSha256 PushHash(h) Equal IfThen
 *         PushPubKey(destination)                       // claim: recipient, with the preimage
 *     Else
 *         CheckHeightVerify(height) PushPubKey(sender)  // refund: sender, at/after height
 *     EndIf
 *
 * Three properties of that call drive this entire protocol:
 *
 *   1. THE SENDER'S WALLET GENERATES THE PREIMAGE. `SendShaAtomicSwapRequest` carries only a
 *      `PaymentRecipient` — there is NO hash parameter — and the response returns `pre_image`.
 *      So whoever funds the L1 leg is necessarily the secret holder. That is not a style
 *      choice; it fixes who must fund which leg first in each direction (see `DIRECTIONS`).
 *   2. THE TIMEOUT IS NOT CONFIGURABLE. The wallet hardcodes `tip_height + 720` blocks with the
 *      comment "2 min blocks ... 24 hours". On a network whose blocks are faster, 720 blocks is
 *      proportionally LESS wall-clock time, so the real refund window must be derived from the
 *      network's own block rate rather than from that comment (see `l1RefundWindowSeconds`).
 *   3. LEDGER WALLETS CANNOT FUND. `send_sha_atomic_swap_transaction` refuses on a Ledger wallet
 *      type, because the device signs only a standard stealth script it builds itself. Claiming
 *      and refunding are unaffected.
 *
 * The L2 leg is `templates/cross_layer_htlc`, engine-verified in
 * `audit_engine_tests/tests/cross_layer_htlc.rs` (h01-h09), and deliberately stricter than L1:
 * its claim and refund windows abut without overlapping, so the L2 leg has no race.
 *
 * NOTHING HERE CLAIMS ATOMICITY YET. Both legs are individually proven; the composed exchange is
 * not called atomic until a real L1 script execution and a real two-layer settlement have both
 * been observed. `docs/CROSS_LAYER_HTLC_TEST_EVIDENCE.md` records which is which.
 */

/** Which way value moves. The priority route for this project is `L2_TO_L1`. */
export type SwapDirection = 'L2_TO_L1' | 'L1_TO_L2';

/**
 * Who funds which leg, and therefore who holds the secret — forced by L1 generating the
 * preimage inside `send_sha_atomic_swap`.
 *
 * In BOTH directions the L1 funder is the secret holder, so the L1 leg is always the one with
 * the LONGER deadline and is always funded FIRST. The standard HTLC safety argument then holds:
 * the secret holder reveals by claiming the counterparty's leg, leaving the counterparty a
 * bounded window to use the revealed secret on the leg that expires later.
 */
export const DIRECTIONS: Readonly<Record<SwapDirection, SwapDirectionShape>> = {
  /**
   * The priority route: a user leaves L2 and receives real L1 XTM.
   *
   * The MAKER funds L1 XTM (and so holds the secret). The user then funds the L2 escrow bound to
   * the hash in the maker's already-funded L1 output — read from chain, so a maker cannot induce
   * the user to lock L2 funds against a hash no L1 output commits to. The maker claims the L2
   * TARI, publishing the preimage; the user claims the L1 XTM with it.
   */
  L2_TO_L1: {
    direction: 'L2_TO_L1',
    userGives: 'L2_TARI',
    userGets: 'L1_XTM',
    l1FundedBy: 'MAKER',
    l2FundedBy: 'USER',
    secretHeldBy: 'MAKER',
    fundingOrder: ['L1', 'L2'],
    /** The maker reveals on L2 by claiming; the user then spends that preimage on L1. */
    revealedOn: 'L2',
    claimOrder: ['L2_BY_MAKER', 'L1_BY_USER'],
  },
  /**
   * A user enters L2 against existing L2 inventory. No burn is involved: the maker is paying out
   * TARI they already hold.
   *
   * The USER funds L1 XTM (and so holds the secret). The maker funds the L2 escrow against the
   * hash in the user's L1 output. The user claims the L2 TARI, publishing the preimage; the
   * maker claims the L1 XTM with it.
   */
  L1_TO_L2: {
    direction: 'L1_TO_L2',
    userGives: 'L1_XTM',
    userGets: 'L2_TARI',
    l1FundedBy: 'USER',
    l2FundedBy: 'MAKER',
    secretHeldBy: 'USER',
    fundingOrder: ['L1', 'L2'],
    revealedOn: 'L2',
    claimOrder: ['L2_BY_USER', 'L1_BY_MAKER'],
  },
};

export interface SwapDirectionShape {
  readonly direction: SwapDirection;
  readonly userGives: 'L2_TARI' | 'L1_XTM';
  readonly userGets: 'L2_TARI' | 'L1_XTM';
  readonly l1FundedBy: 'USER' | 'MAKER';
  readonly l2FundedBy: 'USER' | 'MAKER';
  readonly secretHeldBy: 'USER' | 'MAKER';
  readonly fundingOrder: readonly ['L1', 'L2'];
  readonly revealedOn: 'L2';
  readonly claimOrder: readonly [string, string];
}

/**
 * The L1 timeout, as blocks — hardcoded upstream and not settable by any caller.
 * `base_layer/wallet/src/transaction_service/service.rs`: `const BLOCKS_PER_DAY: u64 = 24 * 30`,
 * then `height = tip_height + BLOCKS_PER_DAY`.
 */
export const L1_HTLC_REFUND_BLOCKS = 720;

/**
 * Per-network chain timing, from the networks' own consensus constants rather than from prose.
 *
 * Tari's base layer runs two PoW algorithms, each with its own `target_time`, so the effective
 * block interval is their harmonic combination `t1*t2/(t1+t2)` — which reproduces mainnet's known
 * 2-minute block time from `target_time: 240`, and is therefore the formula used here.
 *
 * NOTE A REAL DISCREPANCY: Esmeralda's `vn_epoch_length: 80` carries the upstream comment
 * "15s per block * 80 ±= 20 mins", but its configured `target_time` is 60 for both algorithms,
 * giving ~30s blocks and so ~40 minutes per epoch. The comment appears stale. These figures
 * follow the configured constants, and `deriveTimeouts` additionally refuses to rely on them
 * alone: it takes the OBSERVED tip height and epoch as inputs so a live network that disagrees
 * with its own constants cannot silently shorten a refund window.
 */
export const CHAIN_TIMING: Readonly<Record<'esmeralda' | 'mainnet', ChainTiming>> = {
  esmeralda: { l1TargetTimePerAlgo: 60, l1Algorithms: 2, l1BlocksPerL2Epoch: 80 },
  mainnet: { l1TargetTimePerAlgo: 240, l1Algorithms: 2, l1BlocksPerL2Epoch: 60 },
};

export interface ChainTiming {
  /** `target_time` of each PoW algorithm, in seconds. */
  readonly l1TargetTimePerAlgo: number;
  readonly l1Algorithms: number;
  /** L1 `vn_epoch_length`: how many L1 blocks make one L2 epoch. */
  readonly l1BlocksPerL2Epoch: number;
}

/** The effective L1 block interval in seconds, from the dual-PoW target times. */
export function l1BlockSeconds(timing: ChainTiming): number {
  if (timing.l1Algorithms < 1) throw new Error('a network has at least one PoW algorithm');
  // n algorithms each targeting t seconds produce a block every t/n seconds.
  return timing.l1TargetTimePerAlgo / timing.l1Algorithms;
}

/** How long the L1 refund branch actually stays locked, on this network, in seconds. */
export function l1RefundWindowSeconds(timing: ChainTiming): number {
  return L1_HTLC_REFUND_BLOCKS * l1BlockSeconds(timing);
}

/** Seconds per L2 epoch, from `vn_epoch_length` and the L1 block interval. */
export function l2EpochSeconds(timing: ChainTiming): number {
  return timing.l1BlocksPerL2Epoch * l1BlockSeconds(timing);
}

/**
 * The safety margin the second claim needs, as a fraction of the L1 window.
 *
 * The margin must cover, in sequence: the counterparty observing the preimage on L2, building
 * and broadcasting their L1 claim, that claim confirming, and enough further confirmations that
 * a shallow L1 reorg cannot undo it. Half the window is deliberately generous, because the
 * asymmetry is brutal: too much margin only shortens the claimant's window, while too little
 * loses the whole position.
 */
export const CLAIM_MARGIN_FRACTION = 0.5;

export interface TimeoutInputs {
  readonly network: 'esmeralda' | 'mainnet';
  /** The L1 tip height the funding wallet reports, from a live read. */
  readonly l1TipHeight: number;
  /** The L2 epoch a live read reports. */
  readonly l2CurrentEpoch: number;
}

export interface DerivedTimeouts {
  /** The L1 refund height the wallet WILL use. Not settable; stated so it can be checked. */
  readonly l1RefundHeight: number;
  /** The L2 escrow deadline, in absolute L2 epochs. Strictly earlier than the L1 one. */
  readonly l2ExpiresAtEpoch: number;
  /** Wall-clock seconds the second claimant has after the first claim, at worst. */
  readonly claimMarginSeconds: number;
  readonly l1BlockSeconds: number;
  readonly l2EpochSeconds: number;
  /** Everything a reviewer needs to check the arithmetic without rerunning it. */
  readonly justification: string;
}

/**
 * Derives the two deadlines from live chain readings, with the L2 one strictly earlier.
 *
 * Why the L2 leg gets the SHORTER deadline, in both directions: the L1 funder is always the
 * secret holder (L1 generates the preimage), the secret holder always reveals by claiming the
 * counterparty's leg, and the revealing claim must therefore happen on the leg that expires
 * FIRST — leaving the other party a bounded window on the leg that expires later. Since the L1
 * deadline is fixed by the wallet and cannot be lengthened, the only adjustable deadline is
 * L2's, and it must come earlier.
 *
 * Throws rather than returning a short window: an escrow funded with too little margin is worse
 * than no trade, and the caller cannot make it safe after the fact.
 */
export function deriveTimeouts(input: TimeoutInputs): DerivedTimeouts {
  const timing = CHAIN_TIMING[input.network];
  if (timing === undefined) throw new Error(`no chain timing recorded for network ${input.network}`);
  if (!Number.isInteger(input.l1TipHeight) || input.l1TipHeight < 0) {
    throw new Error('l1TipHeight must be a non-negative integer from a live read');
  }
  if (!Number.isInteger(input.l2CurrentEpoch) || input.l2CurrentEpoch < 0) {
    throw new Error('l2CurrentEpoch must be a non-negative integer from a live read');
  }

  const blockSeconds = l1BlockSeconds(timing);
  const epochSeconds = l2EpochSeconds(timing);
  const l1WindowSeconds = l1RefundWindowSeconds(timing);
  const l1RefundHeight = input.l1TipHeight + L1_HTLC_REFUND_BLOCKS;

  // The L2 deadline takes the share of the window that is NOT reserved as margin, rounded DOWN
  // to a whole epoch so rounding can only enlarge the margin, never shrink it.
  const l2WindowSeconds = l1WindowSeconds * (1 - CLAIM_MARGIN_FRACTION);
  const l2Epochs = Math.floor(l2WindowSeconds / epochSeconds);
  if (l2Epochs < 1) {
    throw new Error(
      `on ${input.network} the L1 refund window is ${l1WindowSeconds}s and one L2 epoch is ${epochSeconds}s, so no whole-epoch L2 deadline fits inside it with a ${CLAIM_MARGIN_FRACTION * 100}% margin. This pair cannot be settled safely by this protocol.`,
    );
  }
  const l2ExpiresAtEpoch = input.l2CurrentEpoch + l2Epochs;
  const claimMarginSeconds = l1WindowSeconds - l2Epochs * epochSeconds;

  return {
    l1RefundHeight,
    l2ExpiresAtEpoch,
    claimMarginSeconds,
    l1BlockSeconds: blockSeconds,
    l2EpochSeconds: epochSeconds,
    justification:
      `${input.network}: L1 blocks ~${blockSeconds}s (${timing.l1Algorithms} PoW algorithms at ` +
      `target_time ${timing.l1TargetTimePerAlgo}s). The L1 wallet locks its refund branch for a ` +
      `fixed ${L1_HTLC_REFUND_BLOCKS} blocks = ${l1WindowSeconds}s, at height ${l1RefundHeight} ` +
      `from tip ${input.l1TipHeight}. One L2 epoch = ${timing.l1BlocksPerL2Epoch} L1 blocks = ` +
      `${epochSeconds}s. The L2 escrow therefore expires at epoch ${l2ExpiresAtEpoch} ` +
      `(${l2Epochs} epochs = ${l2Epochs * epochSeconds}s from epoch ${input.l2CurrentEpoch}), ` +
      `leaving ${claimMarginSeconds}s for the second claimant to observe the preimage on L2, ` +
      `broadcast their L1 claim and have it confirm beyond a shallow reorg.`,
  };
}

/**
 * Checks a counterparty's proposed deadlines before anything is funded.
 *
 * A counterparty chooses their own leg's parameters, so their proposal is untrusted input. The
 * dangerous proposal is not an obviously absurd one but a plausible one that leaves too little
 * margin — so the margin is recomputed here rather than taken on trust.
 */
export function checkProposedTimeouts(
  proposed: { readonly l1RefundHeight: number; readonly l2ExpiresAtEpoch: number },
  input: TimeoutInputs,
): { readonly safe: true } | { readonly safe: false; readonly reason: string } {
  const timing = CHAIN_TIMING[input.network];
  if (timing === undefined) return { safe: false, reason: `unknown network ${input.network}` };
  const epochSeconds = l2EpochSeconds(timing);
  const blockSeconds = l1BlockSeconds(timing);

  if (proposed.l2ExpiresAtEpoch <= input.l2CurrentEpoch) {
    return {
      safe: false,
      reason: `The proposed L2 deadline (epoch ${proposed.l2ExpiresAtEpoch}) is not in the future; L2 is at epoch ${input.l2CurrentEpoch}. An escrow funded against it could be refunded before it could ever be claimed.`,
    };
  }
  if (proposed.l1RefundHeight <= input.l1TipHeight) {
    return {
      safe: false,
      reason: `The proposed L1 refund height (${proposed.l1RefundHeight}) is at or below the current tip (${input.l1TipHeight}), so the L1 leg is already refundable.`,
    };
  }

  const l1RemainingSeconds = (proposed.l1RefundHeight - input.l1TipHeight) * blockSeconds;
  const l2RemainingSeconds = (proposed.l2ExpiresAtEpoch - input.l2CurrentEpoch) * epochSeconds;
  if (l2RemainingSeconds >= l1RemainingSeconds) {
    return {
      safe: false,
      reason: `The L2 deadline (${l2RemainingSeconds}s away) is not earlier than the L1 one (${l1RemainingSeconds}s away). The secret holder reveals by claiming the leg that expires first, so an L2 leg that outlives the L1 leg would let the preimage appear with no time left to use it.`,
    };
  }
  const margin = l1RemainingSeconds - l2RemainingSeconds;
  const required = l1RemainingSeconds * CLAIM_MARGIN_FRACTION;
  if (margin < required) {
    return {
      safe: false,
      reason: `Only ${margin}s would remain after the L2 deadline to observe the preimage, broadcast an L1 claim and have it confirm past a shallow reorg. At least ${required}s is required on ${input.network}.`,
    };
  }
  return { safe: true };
}
