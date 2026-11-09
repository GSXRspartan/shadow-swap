const test = require('node:test');
const assert = require('node:assert/strict');
const amm = require('../dist/esm/amm.js');

// The live TESTA/TESTB pool layout under the BTreeMap keying: resource A sorts
// first by address bytes (resource_bc2f = TESTB), so pairs[0] = TESTB and
// pairs[1] = TESTA — PoolState.resourceA = TESTB's address.
// Live reserves on 2026-11-09: A (TESTB) = 99.012842, B (TESTA) = 101.000000, fee 30 bps.
const RESERVE_A = '99012842'; // TESTB side
const RESERVE_B = '101000000'; // TESTA side
const FEE = '30';

test('quote direction: reserveA is the A-resource reserve, quote orientation follows the input resource', () => {
  // TESTB in (resourceA side) -> TESTA out
  const b2a = amm.quoteSwapOutput(RESERVE_A, RESERVE_B, '1000000', FEE);
  assert.equal(b2a.output, '1006870');
  const b2aSmall = amm.quoteSwapOutput(RESERVE_A, RESERVE_B, '100000', FEE);
  assert.equal(b2aSmall.output, '101598');
  // TESTA in (resourceB side) -> TESTB out: the REVERSE computation
  const a2b = amm.quoteSwapOutput(RESERVE_B, RESERVE_A, '1000000', FEE);
  assert.equal(a2b.output, '967830');
  const a2bSmall = amm.quoteSwapOutput(RESERVE_B, RESERVE_A, '100000', FEE);
  assert.equal(a2bSmall.output, '97642');
});
