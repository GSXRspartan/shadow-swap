import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTrade } from '../server.mjs';

test('deriveTrade: opposite deltas form a trade', () => {
  const out = deriveTrade(
    { reserveA: '101000000', reserveB: '99012842' },
    { reserveA: '102000000', reserveB: '98012842' },
  );
  assert.equal(out.kind, 'trade');
  assert.equal(out.direction, 'BASE_TO_QUOTE');
  assert.equal(out.inputAmount, '1000000');
  assert.equal(out.outputAmount, '1000000');
});

test('deriveTrade: liquidity movement is not a trade', () => {
  assert.equal(
    deriveTrade({ reserveA: '101000000', reserveB: '99012842' }, { reserveA: '102000000', reserveB: '100012842' }),
    undefined,
  );
});

test('deriveTrade: quote-to-base direction mirrors', () => {
  const out = deriveTrade(
    { reserveA: '101000000', reserveB: '99012842' },
    { reserveA: '100000000', reserveB: '100012842' },
  );
  assert.equal(out.kind, 'trade');
  assert.equal(out.direction, 'QUOTE_TO_BASE');
  assert.equal(out.inputAmount, '1000000');
  assert.equal(out.outputAmount, '1000000');
});

test('deriveTrade: zero deltas and impossible values are refused', () => {
  assert.equal(
    deriveTrade({ reserveA: '101000000', reserveB: '99012842' }, { reserveA: '101000000', reserveB: '99012842' }),
    undefined,
  );
});
