/**
 * What a liquidity position actually is, right now, in exact integers.
 *
 * WHAT IS DETERMINABLE AND WHAT IS NOT, because that line is the whole design of this module.
 *
 * Determinable from one authoritative pool read plus the holder's LP balance:
 *
 *   * the LP tokens held, and what share of total supply they are;
 *   * what those tokens would redeem for at the reserves as read — floored, because the on-chain
 *     redemption floors;
 *   * how much of the supply is permanently locked, and therefore how much of the pool every
 *     provider is permanently diluted by.
 *
 * NOT determinable, and therefore not produced here:
 *
 *   * **APR, APY or any yield figure.** Nothing in the protocol derives a defensible one. Fees
 *     accrue by growing the reserves, so a provider's return depends on volume that has not
 *     happened yet. A number here would be a guess wearing a percentage sign.
 *   * **Realized fees.** A pool does not record what it paid any individual provider. Deriving it
 *     needs the position's own deposit history — every add, every remove, with the reserves at
 *     each — which lives in the holder's transaction history and not in pool state. A figure
 *     computed from the current read alone would silently report price movement as fee income.
 *   * **Impermanent loss.** Same reason: it is defined against an entry price this module cannot
 *     see, and against an external market price that does not exist for most of these pairs.
 *   * **Trading volume.** Not in pool state. It is derivable from transaction history, which is a
 *     market-data concern and is handled — with its own freshness and trust labelling — by the
 *     market-data modules, not by arithmetic over a single read.
 *
 * Every amount in and out is a raw integer string. A float would make a rounding error into a
 * difference between what is displayed and what the chain pays.
 */

export class LpPositionError extends Error {}

/** The pool fields this calculation needs, from an authoritative read. */
export interface LpPoolState {
  readonly reserveA: string;
  readonly reserveB: string;
  readonly totalLpSupply: string;
  /**
   * LP permanently locked in the pool. Pool v2 locks the first provider's minimum liquidity
   * forever so the pool can never be fully drained; nobody can redeem it, including whoever
   * supplied it.
   */
  readonly lockedLpSupply: string;
}

export interface LpPosition {
  readonly lpBalanceRaw: string;
  readonly totalLpSupplyRaw: string;
  readonly lockedLpSupplyRaw: string;
  /** Share of TOTAL supply, in basis points, floored. 10000 = the whole pool. */
  readonly ownershipBps: number;
  /** The same share as a string with four decimal places, for display without re-deriving it. */
  readonly ownershipPercent: string;
  /** What this position redeems for at the reserves as read, floored as the chain floors. */
  readonly claimARaw: string;
  readonly claimBRaw: string;
  /** Supply that can ever be redeemed: total less the permanently locked portion. */
  readonly redeemableSupplyRaw: string;
  /** Share of supply that is locked for ever, in basis points. Dilutes every provider equally. */
  readonly lockedBps: number;
  /** Stated plainly wherever a position is shown. */
  readonly notes: readonly string[];
}

const RAW = /^\d+$/;

function raw(value: string, field: string): bigint {
  if (typeof value !== 'string' || !RAW.test(value)) {
    throw new LpPositionError(`${field} must be a raw non-negative integer string`);
  }
  return BigInt(value);
}

/** Basis points of `part` in `whole`, floored. Zero when `whole` is zero. */
function bps(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Number((part * 10_000n) / whole);
}

/**
 * Computes a position from an authoritative read.
 *
 * Throws rather than returning a partial result: a position shown with one field wrong is worse
 * than a position not shown, because a provider acts on it.
 */
export function lpPosition(input: { readonly lpBalanceRaw: string; readonly pool: LpPoolState }): LpPosition {
  const lp = raw(input.lpBalanceRaw, 'lpBalanceRaw');
  const total = raw(input.pool.totalLpSupply, 'totalLpSupply');
  const locked = raw(input.pool.lockedLpSupply, 'lockedLpSupply');
  const reserveA = raw(input.pool.reserveA, 'reserveA');
  const reserveB = raw(input.pool.reserveB, 'reserveB');

  if (total === 0n) throw new LpPositionError('This pool reports zero LP supply, so no position can be measured against it');
  if (lp > total) {
    throw new LpPositionError(`This account reports ${input.lpBalanceRaw} LP but the pool's total supply is ${input.pool.totalLpSupply}. One of the two reads is wrong, and neither can be used.`);
  }
  if (locked > total) {
    throw new LpPositionError(`This pool reports ${input.pool.lockedLpSupply} LP locked out of a total supply of ${input.pool.totalLpSupply}.`);
  }

  // Floored, exactly as the on-chain redemption floors: `expected = lp * reserve / total`. A
  // ceiling here would promise a unit the pool will not pay.
  const claimA = (lp * reserveA) / total;
  const claimB = (lp * reserveB) / total;
  const ownership = bps(lp, total);

  const notes: string[] = [
    'These figures are a snapshot of one authoritative pool read. They move with every trade, and what you receive is whatever the pool pays at the moment you redeem.',
    'Redemption floors: the amounts shown are what the pool would actually pay, with the fractional remainder staying in the reserves.',
  ];
  if (locked > 0n) {
    notes.push(
      `${input.pool.lockedLpSupply} LP (${(bps(locked, total) / 100).toFixed(2)}% of supply) is permanently locked in this pool and can never be redeemed by anyone, including whoever supplied it. Your share above is of the whole supply, so that locked portion dilutes every provider equally.`,
    );
  }
  notes.push(
    'No APR, APY or impermanent-loss figure is shown. Fees accrue by growing the reserves, so a return depends on trading volume that has not happened yet; any percentage here would be a projection, not a fact.',
  );
  notes.push(
    'Fees you have already earned are not shown either. A pool records no per-provider history, so a realized-fee figure would need your own deposit history — computing it from this read alone would report price movement as fee income.',
  );

  return {
    lpBalanceRaw: input.lpBalanceRaw,
    totalLpSupplyRaw: input.pool.totalLpSupply,
    lockedLpSupplyRaw: input.pool.lockedLpSupply,
    ownershipBps: ownership,
    ownershipPercent: (ownership / 100).toFixed(4),
    claimARaw: claimA.toString(),
    claimBRaw: claimB.toString(),
    redeemableSupplyRaw: (total - locked).toString(),
    lockedBps: bps(locked, total),
    notes,
  };
}

/**
 * How the pool's composition has moved between two reads, in exact integers.
 *
 * Deliberately a DIFFERENCE between two observations rather than a rate: "the reserves changed by
 * this much between these two reads" is a fact, while "the pool is growing at N% a day" requires
 * assumptions about what happens next.
 */
export function poolCompositionChange(before: LpPoolState, after: LpPoolState): {
  readonly reserveADelta: string;
  readonly reserveBDelta: string;
  readonly supplyDelta: string;
  /** True when reserves grew without supply growing: the shape fee accrual takes. */
  readonly reservesGrewWithoutMint: boolean;
  readonly summary: string;
} {
  const a = raw(after.reserveA, 'after.reserveA') - raw(before.reserveA, 'before.reserveA');
  const b = raw(after.reserveB, 'after.reserveB') - raw(before.reserveB, 'before.reserveB');
  const supply = raw(after.totalLpSupply, 'after.totalLpSupply') - raw(before.totalLpSupply, 'before.totalLpSupply');
  const grew = (a > 0n || b > 0n) && supply === 0n;
  return {
    reserveADelta: a.toString(),
    reserveBDelta: b.toString(),
    supplyDelta: supply.toString(),
    reservesGrewWithoutMint: grew,
    summary: grew
      ? `Reserves moved by ${a} and ${b} with no change in LP supply, which is the shape fee accrual takes: the same LP tokens now claim more. It is not proof of fee income — a one-sided trade moves the reserves too.`
      : `Reserves moved by ${a} and ${b}, with LP supply changing by ${supply}.`,
  };
}
