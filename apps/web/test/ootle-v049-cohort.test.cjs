require('./bootstrap.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');

const cohort = require('../build-test/lib/ootleCohort.js');
const deployment = require('../build-test/services/protocolDeployment.js');

test('v0.50.1 indexers retain the v0.49-reset CBOR decoding cohort', () => {
  const result = cohort.classifyIndexerVersion('0.50.1');
  assert.equal(result.ok, true);
  assert.equal(result.cohort.generation, 'V049_RESET');
  assert.equal(result.cohort.wireFormat, 'CBOR_VALUES');
  assert.equal(cohort.PINNED_OOTLE_RELEASE.tag, 'v0.50.1');
  assert.equal(cohort.PINNED_OOTLE_RELEASE.commit, '0b3f364dd0eaff9997b08d722948619981b62ce7');
});

test('the v0.49-reset registry records only receipt-verified v0.50.1 public-pool deployment', () => {
  const v049 = deployment.deploymentFor('esmeralda', 'V049_RESET');
  const v048 = deployment.deploymentFor('esmeralda', 'V048_RESET');
  assert.equal(v049.registryKey, 'esmeralda@v049');
  assert.deepEqual(v049.poolTemplates, ['1c7d39e782b6ca5023ad186c7d5f82cb2ad171336cd75ae0025245fe84bebae3']);
  assert.deepEqual(v049.offerTemplates, []);
  assert.deepEqual(v049.crossLayerHtlcTemplates, []);
  assert.equal(deployment.crossLayerAvailability(v048).kind, 'INCOMPATIBLE_GENERATION');
  assert.equal(deployment.crossLayerAvailability(v049).kind, 'NOT_RECORDED');
});
