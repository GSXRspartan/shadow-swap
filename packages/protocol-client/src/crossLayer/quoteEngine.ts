/**
 * Cross-layer quoting and maker inventory limits, in exact integer arithmetic.
 *
 * WHAT A QUOTE HERE IS, AND IS NOT
 *
 * It is a maker's offer to exchange coins they already hold, priced off a reference ratio THEY
 * choose. There is no protocol-mandated rate: L1 XTM and L2 TARI are distinct assets and
 * nothing in either chain fixes a price between them. A 1:1 default would be an invented market
 * price dressed as a protocol constant, so `referenceRatio` has no default and must be supplied.
 *
 * An "exit bonus" here is a WORSE price for the maker, paid out of their own inventory to attract
 * flow in the direction they want. It is not a yield, not an APY, not a return on anything, and
 * nothing compounds. `BONUS_IS_NOT_YIELD` says so in the one place a UI would be tempted to
 * imply otherwise.
 *
 * EVERYTHING IS RAW INTEGER STRINGS AND BASIS POINTS. Two chains' smallest units are being
 * compared, often across a large ratio; a float would make rounding a silent transfer from
 * whichever side the error favoured. Division always rounds in the direction that favours the
 * party who is NOT choosing the number — the taker's output rounds down, the maker's cost rounds
 * up — so a rounding error can never create value that neither side put in.
 */

import type { SwapDirection } from './atomicSwap.js';

export const BPS = 10_000n;

/** The disclosure a UI must carry wherever a bonus is shown. */
export const BONUS_IS_NOT_YIELD =
  'An exit bonus is a better exchange rate funded by the liquidity provider out of their own coins, for this one trade. It is not interest, not a yield, not an APY, and nothing accrues or compounds. The provider pays it to attract trades in this direction and can withdraw or change it at any time.';

/**
 * A maker's configuration. Every limit exists so that the worst case for the maker is bounded
 * and knowable before they fund anything.
 */
export interface MakerPricing {
  /**
   * The maker's reference ratio as an exact rational: `num` units of the OUTPUT asset per `den`
   * units of the INPUT asset. A rational rather than a decimal so no precision is lost, and
   * mandatory so no price is ever assumed.
   */
  readonly referenceRatioNum: string;
  readonly referenceRatioDen: string;
  /** The maker's margin, taken off the taker's output. */
  readonly baseSpreadBps: number;
  /** A flat per-trade cost in output units: the maker's own chain fees for settling. */
  readonly fixedNetworkCostRaw: string;
  /** A proportional cost in bps, for costs that scale with size. */
  readonly variableCostBps: number;
  /** L2 -> L1 only: a better rate funded by the maker. Zero disables it. */
  readonly exitBonusBps: number;
  /** Total promotional budget. Once spent, the bonus stops; it never silently continues. */
  readonly maxSubsidyRaw: string;
  /** Hard caps on one trade and on the book. */
  readonly perTradeMaxRaw: string;
  readonly minOrderRaw: string;
  readonly maxOrderRaw: string;
  readonly committedInventoryRaw: string;
  readonly maxDailyVolumeRaw: string;
  /**
   * The least the maker will accept for a trade, after costs and bonus, in output units.
   * MAY BE NEGATIVE: a maker running an exit promotion is choosing to lose a bounded amount per
   * trade, and `maxSubsidyRaw` is what bounds the total. A non-negative-only field here would
   * make the promotion unconfigurable.
   */
  readonly minMakerProceedsRaw: string;
  readonly maxExposurePerCounterpartyRaw: string;
}

/** What has already happened, so limits are enforced against reality rather than intent. */
export interface MakerState {
  readonly filledTodayRaw: string;
  readonly subsidySpentRaw: string;
  readonly exposureByCounterparty: Readonly<Record<string, string>>;
  /** Remaining escrowable inventory, from chain — not the maker's wallet balance. */
  readonly availableInventoryRaw: string;
  readonly paused: boolean;
}

export interface QuoteRequest {
  readonly direction: SwapDirection;
  readonly amountInRaw: string;
  readonly counterpartyId: string;
}

export interface QuoteBreakdown {
  readonly grossOutRaw: string;
  readonly spreadRaw: string;
  readonly variableCostRaw: string;
  readonly fixedCostRaw: string;
  readonly bonusRaw: string;
  readonly netOutRaw: string;
  readonly makerProceedsRaw: string;
  /** The arithmetic, in order, so a quote can be reproduced without rerunning this code. */
  readonly steps: readonly string[];
}

export type QuoteResult =
  | { readonly ok: true; readonly breakdown: QuoteBreakdown; readonly effectiveRateBps: string }
  | { readonly ok: false; readonly refusal: string };

function raw(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${field} must be a raw non-negative integer string`);
  return BigInt(value);
}

/**
 * A SIGNED raw integer. Used only for `minMakerProceedsRaw`, which must be allowed to be
 * negative: a maker running an exit promotion is deliberately accepting negative per-trade
 * proceeds, and forcing this field non-negative would make the exit bonus impossible to
 * configure at all. Every other amount is a quantity and stays non-negative.
 */
function signedRaw(value: string, field: string): bigint {
  if (!/^-?\d+$/.test(value)) throw new Error(`${field} must be a raw integer string (it may be negative)`);
  return BigInt(value);
}

function bps(value: number, field: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${field} must be an integer 0..10000 basis points`);
  }
  return BigInt(value);
}

/** Floor division. Used wherever the result is the TAKER's output. */
function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero in quote arithmetic');
  return (a * b) / d;
}

/** Ceiling division. Used wherever the result is a COST the taker bears. */
function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero in quote arithmetic');
  const n = a * b;
  return n === 0n ? 0n : (n + d - 1n) / d;
}

/**
 * Prices one trade, or refuses it with the exact reason.
 *
 * Refusals come BEFORE arithmetic wherever possible, so a maker's limits cannot be learned by
 * inspecting a quote that was never going to be honoured.
 */
export function quote(
  pricing: MakerPricing,
  state: MakerState,
  request: QuoteRequest,
): QuoteResult {
  if (state.paused) {
    return {
      ok: false,
      refusal:
        'This maker is paused and is not quoting new trades. Trades already funded can still be claimed or refunded.',
    };
  }

  const amountIn = raw(request.amountInRaw, 'amountInRaw');
  const minOrder = raw(pricing.minOrderRaw, 'minOrderRaw');
  const maxOrder = raw(pricing.maxOrderRaw, 'maxOrderRaw');
  const num = raw(pricing.referenceRatioNum, 'referenceRatioNum');
  const den = raw(pricing.referenceRatioDen, 'referenceRatioDen');
  if (num === 0n || den === 0n) {
    return { ok: false, refusal: 'This maker has published no reference ratio, so no price can be formed. There is no default rate between L1 XTM and L2 TARI.' };
  }
  if (amountIn < minOrder) return { ok: false, refusal: `Below this maker's minimum order of ${pricing.minOrderRaw}.` };
  if (amountIn > maxOrder) return { ok: false, refusal: `Above this maker's maximum order of ${pricing.maxOrderRaw}.` };

  const spreadBps = bps(pricing.baseSpreadBps, 'baseSpreadBps');
  const varBps = bps(pricing.variableCostBps, 'variableCostBps');
  const bonusBps = bps(pricing.exitBonusBps, 'exitBonusBps');

  // Gross output at the maker's own ratio. Floors: the surplus of a rounding stays with the
  // maker's inventory rather than being conjured for the taker.
  const grossOut = mulDivFloor(amountIn, num, den);
  if (grossOut === 0n) {
    return { ok: false, refusal: `At this maker's ratio, ${request.amountInRaw} converts to less than one unit of the output asset.` };
  }

  // Costs round UP: a cost that rounds down would be partly absorbed by the maker without their
  // consent, and across many trades that is a real transfer.
  const spread = mulDivCeil(grossOut, spreadBps, BPS);
  const variableCost = mulDivCeil(grossOut, varBps, BPS);
  const fixedCost = raw(pricing.fixedNetworkCostRaw, 'fixedNetworkCostRaw');

  // The bonus applies only to the exit direction, and only as far as the remaining budget allows.
  // A partially-funded bonus is paid in full up to the budget and then stops — it is never
  // silently scaled, because a taker shown a rate must get that rate.
  const subsidyBudget = raw(pricing.maxSubsidyRaw, 'maxSubsidyRaw');
  const subsidySpent = raw(state.subsidySpentRaw, 'subsidySpentRaw');
  const subsidyLeft = subsidyBudget > subsidySpent ? subsidyBudget - subsidySpent : 0n;
  let bonus = 0n;
  if (request.direction === 'L2_TO_L1' && bonusBps > 0n) {
    const wanted = mulDivFloor(grossOut, bonusBps, BPS);
    bonus = wanted <= subsidyLeft ? wanted : 0n;
  }

  const deductions = spread + variableCost + fixedCost;
  if (deductions >= grossOut + bonus) {
    return {
      ok: false,
      refusal: `This trade is not economic: costs (${deductions}) meet or exceed the output (${grossOut + bonus}). A larger trade may price, since the fixed network cost of ${pricing.fixedNetworkCostRaw} does not scale.`,
    };
  }
  const netOut = grossOut + bonus - deductions;

  // The maker keeps the spread and the variable cost, and pays the bonus out of inventory. The
  // fixed network cost is a real outlay, so it is not proceeds.
  const makerProceeds = spread + variableCost - bonus;
  const minProceeds = signedRaw(pricing.minMakerProceedsRaw, 'minMakerProceedsRaw');
  if (makerProceeds < minProceeds) {
    return {
      ok: false,
      refusal: `This maker requires at least ${pricing.minMakerProceedsRaw} per trade; at this size the bonus would leave ${makerProceeds}.`,
    };
  }

  // Inventory and exposure limits, checked against what the OUTPUT side must actually pay out.
  const perTradeMax = raw(pricing.perTradeMaxRaw, 'perTradeMaxRaw');
  if (netOut > perTradeMax) {
    return { ok: false, refusal: `This trade would pay out ${netOut}, above this maker's per-trade limit of ${pricing.perTradeMaxRaw}.` };
  }
  const available = raw(state.availableInventoryRaw, 'availableInventoryRaw');
  if (netOut > available) {
    return { ok: false, refusal: `This maker's remaining escrowed inventory is ${state.availableInventoryRaw}, which cannot cover a payout of ${netOut}.` };
  }
  const filledToday = raw(state.filledTodayRaw, 'filledTodayRaw');
  const dailyCap = raw(pricing.maxDailyVolumeRaw, 'maxDailyVolumeRaw');
  if (filledToday + netOut > dailyCap) {
    return { ok: false, refusal: `This maker's daily volume cap of ${pricing.maxDailyVolumeRaw} would be exceeded (${filledToday} already filled).` };
  }
  const priorExposure = raw(state.exposureByCounterparty[request.counterpartyId] ?? '0', 'exposure');
  const exposureCap = raw(pricing.maxExposurePerCounterpartyRaw, 'maxExposurePerCounterpartyRaw');
  if (priorExposure + netOut > exposureCap) {
    return { ok: false, refusal: `This maker limits exposure to one counterparty to ${pricing.maxExposurePerCounterpartyRaw}; this trade would reach ${priorExposure + netOut}.` };
  }

  return {
    ok: true,
    // The rate the taker actually gets, in bps of the reference, so a UI can show the real cost
    // of trading rather than only the headline ratio.
    effectiveRateBps: (grossOut === 0n ? 0n : mulDivFloor(netOut, BPS, grossOut)).toString(),
    breakdown: {
      grossOutRaw: grossOut.toString(),
      spreadRaw: spread.toString(),
      variableCostRaw: variableCost.toString(),
      fixedCostRaw: fixedCost.toString(),
      bonusRaw: bonus.toString(),
      netOutRaw: netOut.toString(),
      makerProceedsRaw: makerProceeds.toString(),
      steps: [
        `gross = floor(${amountIn} * ${num} / ${den}) = ${grossOut}`,
        `spread = ceil(${grossOut} * ${spreadBps} / 10000) = ${spread}`,
        `variable = ceil(${grossOut} * ${varBps} / 10000) = ${variableCost}`,
        `fixed = ${fixedCost}`,
        `bonus = ${bonus}${bonus === 0n && bonusBps > 0n && request.direction === 'L2_TO_L1' ? ' (subsidy budget exhausted)' : ''}`,
        `net out = ${grossOut} + ${bonus} - (${spread} + ${variableCost} + ${fixedCost}) = ${netOut}`,
        `maker proceeds = ${spread} + ${variableCost} - ${bonus} = ${makerProceeds}`,
      ],
    },
  };
}

/** Applies a filled trade to the maker's state. Pauses automatically when a limit is reached. */
export function applyFill(
  pricing: MakerPricing,
  state: MakerState,
  breakdown: QuoteBreakdown,
  counterpartyId: string,
): MakerState {
  const netOut = BigInt(breakdown.netOutRaw);
  const available = BigInt(state.availableInventoryRaw) - netOut;
  const filledToday = BigInt(state.filledTodayRaw) + netOut;
  const subsidySpent = BigInt(state.subsidySpentRaw) + BigInt(breakdown.bonusRaw);
  const prior = BigInt(state.exposureByCounterparty[counterpartyId] ?? '0');
  // Pausing when inventory can no longer cover the smallest payout the maker would make is the
  // honest alternative to continuing to quote trades that will be refused at execution.
  const paused = available < BigInt(pricing.minOrderRaw) || filledToday >= BigInt(pricing.maxDailyVolumeRaw);
  return {
    availableInventoryRaw: (available > 0n ? available : 0n).toString(),
    filledTodayRaw: filledToday.toString(),
    subsidySpentRaw: subsidySpent.toString(),
    exposureByCounterparty: { ...state.exposureByCounterparty, [counterpartyId]: (prior + netOut).toString() },
    paused,
  };
}

// ---------------------------------------------------------------------------------------------
// Inventory simulation
// ---------------------------------------------------------------------------------------------

export interface SimulationStep {
  readonly direction: SwapDirection;
  readonly amountInRaw: string;
  readonly counterpartyId: string;
}

export interface SimulationOutcome {
  readonly filled: number;
  readonly refused: number;
  readonly refusals: readonly string[];
  readonly finalState: MakerState;
  readonly totalPaidOutRaw: string;
  readonly totalProceedsRaw: string;
  readonly totalBonusRaw: string;
  /** True when the maker ran out of the asset the exit direction consumes. */
  readonly exhausted: boolean;
}

/**
 * Replays a sequence of trades deterministically, so the economics questions can be answered
 * with arithmetic instead of intuition — in particular: how fast does one-directional exit flow
 * drain an inventory, and what does a promotional bonus actually cost over that run.
 *
 * It is a model of THIS pricing logic, not of a market: it assumes every quoted trade that is
 * not refused settles. Real flow depends on counterparties who may not appear, which is why the
 * exit-side conclusion worth drawing from it is about depletion, not about profit.
 */
export function simulate(
  pricing: MakerPricing,
  initial: MakerState,
  steps: readonly SimulationStep[],
): SimulationOutcome {
  let state = initial;
  let filled = 0;
  let refused = 0;
  const refusals: string[] = [];
  let paidOut = 0n;
  let proceeds = 0n;
  let bonusTotal = 0n;

  for (const step of steps) {
    const q = quote(pricing, state, step);
    if (!q.ok) {
      refused += 1;
      refusals.push(q.refusal);
      continue;
    }
    filled += 1;
    paidOut += BigInt(q.breakdown.netOutRaw);
    proceeds += BigInt(q.breakdown.makerProceedsRaw);
    bonusTotal += BigInt(q.breakdown.bonusRaw);
    state = applyFill(pricing, state, q.breakdown, step.counterpartyId);
  }

  return {
    filled,
    refused,
    refusals,
    finalState: state,
    totalPaidOutRaw: paidOut.toString(),
    totalProceedsRaw: proceeds.toString(),
    totalBonusRaw: bonusTotal.toString(),
    exhausted: BigInt(state.availableInventoryRaw) < BigInt(pricing.minOrderRaw),
  };
}
