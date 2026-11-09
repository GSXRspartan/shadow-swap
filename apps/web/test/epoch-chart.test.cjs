require('./bootstrap.cjs');
/**
 * SSR assertions for the epoch-bucketed chart branch (no wall clock is ever
 * invented: axes are labelled in consensus epochs only).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createElement: h } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router-dom');

const { EpochChart } = require('../build-test/components/EpochChart.js');

const POOL_COMPONENT = 'component_' + 'a'.repeat(64);
const RA = 'resource_' + 'b'.repeat(64);
const RB = 'resource_' + 'c'.repeat(64);

function candle(bucketStart, priceN, priceD, volume) {
  return {
    poolComponent: POOL_COMPONENT,
    interval: '4h',
    bucketStart,
    bucketEnd: String(Number(bucketStart) + 1),
    bucketKind: 'EPOCH',
    open: { numerator: String(priceN), denominator: String(priceD), baseDecimals: 6, quoteDecimals: 6 },
    high: { numerator: String(priceN), denominator: String(priceD), baseDecimals: 6, quoteDecimals: 6 },
    low: { numerator: String(priceN), denominator: String(priceD), baseDecimals: 6, quoteDecimals: 6 },
    close: { numerator: String(priceN), denominator: String(priceD), baseDecimals: 6, quoteDecimals: 6 },
    baseVolumeRaw: String(volume),
    quoteVolumeRaw: '0',
    tradeCount: 1,
    partial: false,
  };
}

function render(element) {
  return renderToStaticMarkup(h(MemoryRouter, null, element));
}

test('epoch chart: renders a price line and volume with epoch axes only', () => {
  const html = render(
    h(EpochChart, {
      candles: [candle('11714', 990000, 1000000, 0), candle('11715', 1000000, 1000000, 5000000), candle('11716', 1010000, 1000000, 2500000)],
      baseSymbol: 'TARI',
      quoteSymbol: 'wSTABLE',
      interval: '4h',
      height: 320,
    }),
  );
  assert.match(html, /Epoch axis/);
  assert.match(html, /epoch 11714/);
  assert.match(html, /epoch 11716/);
  assert.match(html, /1\.01|1\.00|0\.99/);
  assert.match(html, /<svg/);
  // No wall-clock axis or fake timestamp anywhere.
  assert.equal(/1970|20[12][0-9]-[0-9]{2}-[0-9]{2}/.test(html), false, 'no date appears on an epoch axis');
});

test('epoch chart: empty series render nothing', () => {
  const html = render(h(EpochChart, { candles: [], baseSymbol: 'TARI', quoteSymbol: 'wSTABLE', interval: '4h' }));
  assert.equal(html, '');
});
