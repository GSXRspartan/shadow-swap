import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTrade, aggregateTrade } from '../server.mjs';

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

test('aggregateTrade: two chained trades mark the row partial', () => {
  const out = aggregateTrade(
    { reserveA: '101000000', reserveB: '99012842' },
    { reserveA: '103000000', reserveB: '97012842' },
    2,
    2,
  );
  assert.equal(out.kind, 'trade');
  assert.equal(out.partial, true);
  assert.equal(out.multiCount, 2);
  assert.equal(out.inputAmount, '2000000');
  assert.equal(out.outputAmount, '2000000');
});

test('aggregateTrade: a single chained trade stays an exact trade', () => {
  const out = aggregateTrade(
    { reserveA: '101000000', reserveB: '99012842' },
    { reserveA: '102000000', reserveB: '98012842' },
    1,
    1,
  );
  assert.equal(out.kind, 'trade');
  assert.equal(out.partial, false);
  assert.equal(out.multiCount, 1);
});
