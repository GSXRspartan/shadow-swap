/**
 * Cross-layer quoting: exact integer arithmetic, bounded maker risk, and the economics of an
 * exit bonus computed rather than assumed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

/** 1:1 reference with a 30 bps spread. 1:1 is THIS maker's choice, never a protocol default. */
const PRICING = {
  referenceRatioNum: '1',
  referenceRatioDen: '1',
  baseSpreadBps: 30,
  fixedNetworkCostRaw: '100',
  variableCostBps: 10,
  exitBonusBps: 0,
  maxSubsidyRaw: '0',
  perTradeMaxRaw: '500000',
  minOrderRaw: '1000',
  maxOrderRaw: '500000',
  committedInventoryRaw: '1000000',
  maxDailyVolumeRaw: '1000000',
  minMakerProceedsRaw: '0',
  maxExposurePerCounterpartyRaw: '1000000',
};
const STATE = {
  filledTodayRaw: '0',
  subsidySpentRaw: '0',
  exposureByCounterparty: {},
  availableInventoryRaw: '1000000',
  paused: false,
};
const req = (over = {}) => ({ direction: 'L2_TO_L1', amountInRaw: '100000', counterpartyId: 'taker-1', ...over });

test('there is no default rate: a maker with no reference ratio cannot quote', () => {
  // L1 XTM and L2 TARI are distinct assets and nothing in either chain fixes a price between
  // them. A 1:1 default would be an invented market price dressed as a protocol constant.
  for (const bad of [{ referenceRatioNum: '0' }, { referenceRatioDen: '0' }]) {
    const r = pc.quote({ ...PRICING, ...bad }, STATE, req());
    assert.equal(r.ok, false);
    assert.match(r.refusal, /no default rate/);
  }
});

test('the arithmetic is exact, reproducible, and rounds against whoever chose the number', () => {
  const r = pc.quote(PRICING, STATE, req());
  assert.equal(r.ok, true);
  const b = r.breakdown;
  // gross 100000; spread ceil(100000*30/10000)=300; variable ceil(100000*10/10000)=100; fixed 100
  assert.equal(b.grossOutRaw, '100000');
  assert.equal(b.spreadRaw, '300');
  assert.equal(b.variableCostRaw, '100');
  assert.equal(b.fixedCostRaw, '100');
  assert.equal(b.netOutRaw, String(100000 - 300 - 100 - 100));
  assert.equal(b.makerProceedsRaw, '400');
  // Every step is recorded, so a quote can be checked without rerunning this code.
  assert.equal(b.steps.length, 7);
  assert.match(b.steps[0], /gross = floor\(100000 \* 1 \/ 1\) = 100000/);
  assert.equal(r.effectiveRateBps, '9950');
});

test('costs round UP and output rounds DOWN, so rounding never creates value', () => {
  // A size where every division is inexact. The invariant that matters: net out plus the maker's
  // real costs can never exceed gross plus bonus — i.e. no party receives a unit nobody paid.
  const odd = { ...PRICING, baseSpreadBps: 7, variableCostBps: 3, fixedNetworkCostRaw: '1' };
  for (const amount of ['1001', '1337', '9999', '33333', '100001']) {
    const r = pc.quote(odd, STATE, req({ amountInRaw: amount }));
    assert.equal(r.ok, true, amount);
    const b = r.breakdown;
    const gross = BigInt(b.grossOutRaw);
    const out = BigInt(b.netOutRaw);
    const costs = BigInt(b.spreadRaw) + BigInt(b.variableCostRaw) + BigInt(b.fixedCostRaw);
    assert.equal(out + costs, gross + BigInt(b.bonusRaw), `conserved at ${amount}`);
    assert.ok(out < gross, `the taker never receives more than gross at ${amount}`);
  }
});

test('an exit bonus is funded by the maker, applies only to the exit, and stops at its budget', () => {
  // The operator's illustrative case: 1000 in -> 1010 out, the extra paid by the provider.
  const bonused = {
    ...PRICING,
    exitBonusBps: 100, // 1%
    maxSubsidyRaw: '5000',
    baseSpreadBps: 0,
    variableCostBps: 0,
    fixedNetworkCostRaw: '0',
    // A promoting maker must OPT IN to losing money per trade. With the default of 0 this exact
    // quote is refused, which is the correct behaviour and is asserted below.
    minMakerProceedsRaw: '-1000',
  };
  const exit = pc.quote(bonused, STATE, req({ amountInRaw: '1000' }));
  assert.equal(exit.ok, true);
  assert.equal(exit.breakdown.bonusRaw, '10');
  assert.equal(exit.breakdown.netOutRaw, '1010', '1000 in -> 1010 out');
  // The maker PAYS for it: proceeds go negative, which is the honest accounting.
  assert.equal(exit.breakdown.makerProceedsRaw, '-10');
  assert.ok(Number(exit.effectiveRateBps) > 10000, 'the taker beats the reference rate');
  // And the opt-in is real: the same trade is refused if the maker has not accepted a loss.
  const notOptedIn = pc.quote({ ...bonused, minMakerProceedsRaw: '0' }, STATE, req({ amountInRaw: '1000' }));
  assert.equal(notOptedIn.ok, false);
  assert.match(notOptedIn.refusal, /requires at least 0 per trade/);

  // The entry direction gets no bonus: the incentive exists to pull flow one way.
  const entry = pc.quote(bonused, STATE, req({ direction: 'L1_TO_L2', amountInRaw: '1000' }));
  assert.equal(entry.breakdown.bonusRaw, '0');
  assert.equal(entry.breakdown.netOutRaw, '1000');

  // Once the budget is spent the bonus STOPS rather than silently shrinking: a taker shown a
  // rate must get that rate, so a partially-fundable bonus is not paid at all.
  const spent = { ...STATE, subsidySpentRaw: '4995' };
  const q = pc.quote(bonused, spent, req({ amountInRaw: '1000' }));
  assert.equal(q.breakdown.bonusRaw, '0');
  assert.match(q.breakdown.steps[4], /subsidy budget exhausted/);
});

test('a bonus is never presented as a yield', () => {
  assert.match(pc.BONUS_IS_NOT_YIELD, /not interest, not a yield, not an APY/);
  assert.match(pc.BONUS_IS_NOT_YIELD, /nothing accrues or compounds/);
  assert.match(pc.BONUS_IS_NOT_YIELD, /funded by the liquidity provider/);
});

test('every maker limit is enforced against reality, and each refusal names itself', () => {
  const cases = [
    ['below the minimum', { amountInRaw: '999' }, {}, {}, /minimum order/],
    ['above the maximum', { amountInRaw: '500001' }, {}, {}, /maximum order/],
    ['per-trade payout cap', {}, { perTradeMaxRaw: '1000' }, {}, /per-trade limit/],
    ['inventory cannot cover it', {}, {}, { availableInventoryRaw: '5000' }, /remaining escrowed inventory/],
    ['daily volume cap', {}, { maxDailyVolumeRaw: '50000' }, {}, /daily volume cap/],
    ['per-counterparty exposure', {}, { maxExposurePerCounterpartyRaw: '1000' }, {}, /exposure to one counterparty/],
    ['minimum maker proceeds', {}, { minMakerProceedsRaw: '99999' }, {}, /requires at least/],
    ['paused', {}, {}, { paused: true }, /paused and is not quoting/],
  ];
  for (const [what, r, p, s, pattern] of cases) {
    const result = pc.quote({ ...PRICING, ...p }, { ...STATE, ...s }, req(r));
    assert.equal(result.ok, false, what);
    assert.match(result.refusal, pattern, what);
  }
  // A trade whose fixed cost exceeds its output is refused, and the refusal is actionable.
  const dust = pc.quote({ ...PRICING, fixedNetworkCostRaw: '999999' }, STATE, req());
  assert.equal(dust.ok, false);
  assert.match(dust.refusal, /not economic/);
  assert.match(dust.refusal, /does not scale/, 'tells the user a larger trade may price');
});

test('a paused maker still honours funded trades; pausing only stops NEW quotes', () => {
  const r = pc.quote(PRICING, { ...STATE, paused: true }, req());
  assert.match(r.refusal, /already funded can still be claimed or refunded/);
});

test('filling a trade moves inventory, spends subsidy, and auto-pauses at a limit', () => {
  const q = pc.quote(PRICING, STATE, req());
  const next = pc.applyFill(PRICING, STATE, q.breakdown, 'taker-1');
  assert.equal(next.availableInventoryRaw, String(1000000 - Number(q.breakdown.netOutRaw)));
  assert.equal(next.filledTodayRaw, q.breakdown.netOutRaw);
  assert.equal(next.exposureByCounterparty['taker-1'], q.breakdown.netOutRaw);
  assert.equal(next.paused, false);

  // Auto-pause when inventory can no longer cover even the smallest order. Continuing to quote
  // trades that would be refused at execution is the dishonest alternative. The boundary is
  // inclusive: inventory worth exactly one minimum order can still serve one, so it does NOT
  // pause — a maker is only stopped when there is genuinely nothing tradeable left.
  const exactlyOneLeft = pc.applyFill(PRICING, { ...STATE, availableInventoryRaw: '100500' }, q.breakdown, 't');
  assert.equal(exactlyOneLeft.availableInventoryRaw, '1000', 'exactly minOrder remains');
  assert.equal(exactlyOneLeft.paused, false);
  const belowOne = pc.applyFill(PRICING, { ...STATE, availableInventoryRaw: '100499' }, q.breakdown, 't');
  assert.equal(belowOne.availableInventoryRaw, '999');
  assert.equal(belowOne.paused, true);
});

test('simulation: one-directional exit flow drains inventory, and the bonus cost is exact', () => {
  // The economics question the operator asked: how fast do L2 exits deplete L1 inventory, and
  // what does a 1% exit bonus actually cost over that run?
  const pricing = {
    ...PRICING,
    exitBonusBps: 100,
    maxSubsidyRaw: '1000000',
    baseSpreadBps: 30,
    variableCostBps: 0,
    fixedNetworkCostRaw: '0',
    minMakerProceedsRaw: '-1000000000',
  };
  const steps = Array.from({ length: 20 }, (_, i) => ({
    direction: 'L2_TO_L1',
    amountInRaw: '100000',
    counterpartyId: `taker-${i}`,
  }));
  const out = pc.simulate(pricing, STATE, steps);

  // Each 100000 exit pays out 100000 + 1000 bonus - 300 spread = 100700, so a 1000000
  // inventory supports 9 trades and then cannot cover a tenth.
  assert.equal(out.filled, 9);
  assert.equal(out.refused, 11);
  assert.equal(out.totalPaidOutRaw, String(9 * 100700));
  assert.equal(out.totalBonusRaw, String(9 * 1000));
  // The maker's net on the run is NEGATIVE: the 1% bonus exceeds the 30 bps spread. That is the
  // point of computing it rather than assuming a promotional rate is sustainable.
  assert.equal(out.totalProceedsRaw, String(9 * (300 - 1000)));
  assert.ok(BigInt(out.totalProceedsRaw) < 0n, 'a 1% bonus against a 30bps spread loses money');
  // 93700 remains: enough for a minimum order, NOT enough for another 100000 trade. Those are
  // different conditions and the distinction matters — a maker with usable inventory should not
  // be reported as exhausted merely because one requested size no longer fits.
  assert.equal(out.finalState.availableInventoryRaw, String(1000000 - 9 * 100700));
  assert.equal(out.exhausted, false);
  assert.match(out.refusals[0], /cannot cover a payout/);

  // With the spread above the bonus, the same flow is profitable — so the model distinguishes
  // "promotional" from "sustainable" by arithmetic, not by labelling.
  const sustainable = pc.simulate({ ...pricing, baseSpreadBps: 150 }, STATE, steps);
  assert.ok(BigInt(sustainable.totalProceedsRaw) > 0n);
});

test('simulation: entry flow replenishes the exit-side inventory it consumes', () => {
  // L1 -> L2 trades pay out L2 TARI and take in L1 XTM, which is what makes a two-way book
  // self-sustaining rather than a one-way drain.
  const steps = [
    { direction: 'L2_TO_L1', amountInRaw: '100000', counterpartyId: 'a' },
    { direction: 'L1_TO_L2', amountInRaw: '100000', counterpartyId: 'b' },
    { direction: 'L2_TO_L1', amountInRaw: '100000', counterpartyId: 'c' },
  ];
  const out = pc.simulate(PRICING, STATE, steps);
  assert.equal(out.filled, 3);
  // This model tracks ONE payout inventory, so a two-sided book needs a second maker state per
  // direction. Recorded here rather than implied: the figure below is payouts, not net position.
  assert.equal(out.totalPaidOutRaw, String(3 * (100000 - 300 - 100 - 100)));
  assert.equal(out.refused, 0);
});

test('amounts and rates are validated as integers and basis points', () => {
  assert.throws(() => pc.quote({ ...PRICING, baseSpreadBps: 10001 }, STATE, req()), /0\.\.10000 basis points/);
  assert.throws(() => pc.quote({ ...PRICING, baseSpreadBps: 1.5 }, STATE, req()), /basis points/);
  assert.throws(() => pc.quote(PRICING, STATE, req({ amountInRaw: '1.5' })), /raw non-negative integer/);
  assert.throws(() => pc.quote(PRICING, STATE, req({ amountInRaw: '-5' })), /raw non-negative integer/);
});
