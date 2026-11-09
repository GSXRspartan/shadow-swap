/**
 * Deterministic tests for the settlement observation sink (services/marketObservations.ts).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const obs = require('../build-test/services/marketObservations.js');

const POOL = 'component_' + 'a'.repeat(64);
const RA = 'resource_' + 'b'.repeat(64);
const RB = 'resource_' + 'c'.repeat(64);
const TX = 'tx_1';

function before(overrides = {}) {
  return {
    operationId: 'swap-1',
    poolComponent: POOL,
    resourceA: RA,
    resourceB: RB,
    baseDecimals: '6',
    quoteDecimals: '6',
    reserveA: '101000000',
    reserveB: '99012842',
    feeBps: '30',
    substateVersion: '7',
    producingTxHash: '8Ytxhash',
    savedAtUnixMs: Date.now(),
    ...overrides,
  };
}

const RECORD = { operationId: 'swap-1', pulledAmount: '1000000' };

test('observation: a settled swap becomes one verified trade observation', () => {
  const observation = obs.settledObservation({
    record: RECORD,
    before: before(),
    after: { reserveA: '102000000', reserveB: '98012842', epoch: '11715', feeBps: '30' },
    transactionId: TX,
  });
  assert.ok(observation !== undefined);
  assert.equal(observation.chainTxId, TX);
  assert.equal(observation.poolComponent, POOL);
  assert.equal(observation.inputResource, RA);
  assert.equal(observation.outputResource, RB);
  assert.equal(observation.inputAmountRaw, '1000000');
  // Reserve B paid out exactly the amount lost.
  assert.equal(observation.outputAmountRaw, '1000000');
  assert.equal(observation.epoch, '11715');
  assert.equal(observation.feeBps, '30');
  assert.equal(observation.finality, 'FINALIZED');
  assert.equal(observation.source, 'LOCAL_EXECUTION');
});

test('observation: quote-to-base direction mirrors reserves', () => {
  const observation = obs.settledObservation({
    record: RECORD,
    before: before(),
    after: { reserveA: '100000000', reserveB: '100012842', epoch: '11715', feeBps: '30' },
    transactionId: TX,
  });
  assert.ok(observation !== undefined);
  assert.equal(observation.inputResource, RB);
  assert.equal(observation.outputResource, RA);
  assert.equal(observation.inputAmountRaw, '1000000');
  assert.equal(observation.outputAmountRaw, '1000000');
});

test('observation: same-direction deltas are not a trade', () => {
  const observation = obs.settledObservation({
    record: RECORD,
    before: before(),
    after: { reserveA: '102000000', reserveB: '100012842', epoch: '11715', feeBps: '30' },
    transactionId: TX,
  });
  assert.equal(observation, undefined, 'both reserves growing is a liquidity event, not a swap');
});

test('observation: zero deltas and malformed reserves yield nothing', () => {
  assert.equal(obs.settledObservation({ record: RECORD, before: before(), after: { reserveA: '101000000', reserveB: '99012842', epoch: '1', feeBps: '30' }, transactionId: TX }), undefined);
  assert.equal(obs.settledObservation({ record: { operationId: 'x', pulledAmount: '0' }, before: before(), after: { reserveA: '102000000', reserveB: '98012842', epoch: '1', feeBps: '30' }, transactionId: TX }), undefined);
  assert.equal(obs.settledObservation({ record: RECORD, before: before({ reserveA: '0' }), after: { reserveA: '102000000', reserveB: '98012842', epoch: '1', feeBps: '30' }, transactionId: TX }), undefined);
});

test('attribution: our tx producing the state, or version +1, attributes to us', () => {
  assert.equal(obs.attributesToOurSwap({ producingTxHash: '8Ytxhash' }, { producingTxHash: TX }, TX), true);
  assert.equal(obs.attributesToOurSwap({ substateVersion: '7' }, { substateVersion: '8' }), true);
});

test('attribution: contention — another tx touched the pool — records nothing', () => {
  assert.equal(obs.attributesToOurSwap({ substateVersion: '7' }, { substateVersion: '9' }), false, 'version advanced past ours');
  assert.equal(obs.attributesToOurSwap({ producingTxHash: 'same' }, { producingTxHash: 'other' }, TX), false, 'state moved to a different tx');
  assert.equal(obs.attributesToOurSwap({}, {}), true, 'unknown identity carries no evidence against attribution');
});
