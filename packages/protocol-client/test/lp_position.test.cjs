/**
 * LP position reporting: what is determinable from a pool read, and what is refused.
 *
 * The temptation this module exists to resist is a yield figure. A provider shown "12% APY" acts
 * on it, and nothing in an AMM produces that number — fees accrue by growing reserves, so a
 * return depends on volume that has not happened. These tests pin both halves: the arithmetic
 * that IS exact, and the absence of the arithmetic that cannot be.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

const pool = (over = {}) => ({
  reserveA: '1000000000',
  reserveB: '4000000000',
  totalLpSupply: '2000000000',
  lockedLpSupply: '1000',
  ...over,
});

test('ownership and claims are exact, and floor exactly as the chain floors', () => {
  // A quarter of the supply.
  const position = pc.lpPosition({ lpBalanceRaw: '500000000', pool: pool() });
  assert.equal(position.ownershipBps, 2500);
  assert.equal(position.ownershipPercent, '25.0000');
  assert.equal(position.claimARaw, '250000000');
  assert.equal(position.claimBRaw, '1000000000');
  assert.equal(position.redeemableSupplyRaw, '1999999000', 'total less the permanently locked LP');

  // The floor is the point: `lp * reserve / total` with a remainder pays the lower amount, and
  // the fraction stays in the reserves. Promising the ceiling would promise a unit the pool
  // will not pay.
  const dust = pc.lpPosition({ lpBalanceRaw: '3', pool: pool({ reserveA: '10', reserveB: '10', totalLpSupply: '7', lockedLpSupply: '0' }) });
  assert.equal(dust.claimARaw, '4', 'floor(3 * 10 / 7) = 4');
  assert.equal(dust.ownershipBps, 4285, 'floor(3 * 10000 / 7)');

  // A position that redeems to nothing reports zero rather than rounding up to one.
  const tiny = pc.lpPosition({ lpBalanceRaw: '1', pool: pool({ reserveA: '5', reserveB: '5', totalLpSupply: '1000000', lockedLpSupply: '0' }) });
  assert.equal(tiny.claimARaw, '0');
  assert.equal(tiny.ownershipBps, 0);
});

test('the permanently locked LP is reported, because it dilutes every provider', () => {
  const position = pc.lpPosition({ lpBalanceRaw: '1000000000', pool: pool() });
  assert.equal(position.lockedLpSupplyRaw, '1000');
  assert.equal(position.lockedBps, 0, 'a thousandth of a percent, floored to zero bps');
  const note = position.notes.join(' ');
  assert.match(note, /permanently locked in this pool and can never be redeemed by anyone/);
  assert.match(note, /including whoever supplied it/);
  assert.match(note, /dilutes every provider equally/);

  // A pool with no locked LP says nothing about it rather than printing a zero.
  const unlocked = pc.lpPosition({ lpBalanceRaw: '1000', pool: pool({ lockedLpSupply: '0' }) });
  assert.equal(unlocked.lockedBps, 0);
  assert.equal(/permanently locked/.test(unlocked.notes.join(' ')), false);
  assert.equal(unlocked.redeemableSupplyRaw, unlocked.totalLpSupplyRaw);

  // A material locked share is reported as a percentage with two places.
  const heavy = pc.lpPosition({ lpBalanceRaw: '1000', pool: pool({ totalLpSupply: '1000000', lockedLpSupply: '50000' }) });
  assert.equal(heavy.lockedBps, 500);
  assert.match(heavy.notes.join(' '), /5\.00% of supply/);
});

test('NO APY, NO APR AND NO IMPERMANENT LOSS IS PRODUCED, and the notes say why', () => {
  const position = pc.lpPosition({ lpBalanceRaw: '500000000', pool: pool() });
  // Nothing in the result is a rate or a projection.
  for (const key of Object.keys(position)) {
    assert.equal(/apy|apr|yield|roi|annual/i.test(key), false, `no field may be a yield: ${key}`);
  }
  const notes = position.notes.join(' ');
  assert.match(notes, /No APR, APY or impermanent-loss figure is shown/);
  assert.match(notes, /any percentage here would be a projection, not a fact/);
  // And realized fees are refused with the actual reason, not just omitted.
  assert.match(notes, /A pool records no per-provider history/);
  assert.match(notes, /would report price movement as fee income/);
  // The snapshot is labelled as one.
  assert.match(notes, /snapshot of one authoritative pool read/);
  assert.match(notes, /whatever the pool pays at the moment you redeem/);
});

test('an inconsistent pair of reads is refused rather than reported', () => {
  // A position shown with one field wrong is worse than a position not shown, because a provider
  // acts on it.
  assert.throws(
    () => pc.lpPosition({ lpBalanceRaw: '3000000000', pool: pool() }),
    /One of the two reads is wrong, and neither can be used/,
  );
  assert.throws(() => pc.lpPosition({ lpBalanceRaw: '1', pool: pool({ totalLpSupply: '0' }) }), /zero LP supply/);
  assert.throws(() => pc.lpPosition({ lpBalanceRaw: '1', pool: pool({ lockedLpSupply: '9999999999999' }) }), /locked out of a total supply/);
  for (const bad of ['-1', '1.5', '', '1e9', 'lots', undefined]) {
    assert.throws(() => pc.lpPosition({ lpBalanceRaw: bad, pool: pool() }), /raw non-negative integer/);
  }
  assert.throws(() => pc.lpPosition({ lpBalanceRaw: '1', pool: pool({ reserveA: '-5' }) }), /raw non-negative integer/);
});

test('pool composition is reported as a difference between two reads, never as a rate', () => {
  const before = pool();
  // Reserves grew, supply did not: the shape fee accrual takes.
  const accrued = pc.poolCompositionChange(before, pool({ reserveA: '1000030000', reserveB: '4000000000' }));
  assert.equal(accrued.reserveADelta, '30000');
  assert.equal(accrued.reserveBDelta, '0');
  assert.equal(accrued.supplyDelta, '0');
  assert.equal(accrued.reservesGrewWithoutMint, true);
  // Even then it is not claimed as fee income, because a one-sided trade looks the same.
  assert.match(accrued.summary, /It is not proof of fee income/);
  assert.match(accrued.summary, /a one-sided trade moves the reserves too/);

  // A deposit grows reserves AND supply, so it is not reported as accrual.
  const deposit = pc.poolCompositionChange(before, pool({ reserveA: '1100000000', reserveB: '4400000000', totalLpSupply: '2200000000' }));
  assert.equal(deposit.reservesGrewWithoutMint, false);
  assert.equal(deposit.supplyDelta, '200000000');
  assert.match(deposit.summary, /LP supply changing by 200000000/);

  // A withdrawal is a negative delta, reported as such rather than clamped.
  const withdrawal = pc.poolCompositionChange(before, pool({ reserveA: '900000000', totalLpSupply: '1800000000' }));
  assert.equal(withdrawal.reserveADelta, '-100000000');
  assert.equal(withdrawal.supplyDelta, '-200000000');
  // No rate, no projection, no annualisation anywhere in the result.
  for (const key of Object.keys(withdrawal)) {
    assert.equal(/rate|apy|apr|perDay|annual/i.test(key), false, `no field may be a rate: ${key}`);
  }
});
