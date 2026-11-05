require('./bootstrap.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');

const cohort = require('../build-test/lib/ootleCohort.js');
const deployment = require('../build-test/services/protocolDeployment.js');

test('v0.49 indexers retain CBOR decoding but are a new Esmeralda generation', () => {
  const result = cohort.classifyIndexerVersion('0.49.1');
  assert.equal(result.ok, true);
  assert.equal(result.cohort.generation, 'V049_RESET');
  assert.equal(result.cohort.wireFormat, 'CBOR_VALUES');
  assert.equal(cohort.PINNED_OOTLE_RELEASE.tag, 'v0.49.2');
  assert.equal(cohort.PINNED_OOTLE_RELEASE.commit, 'aa7b0c81719e5c3cfaf9bf3b5fb87bd83180cb90');
});

test('the v0.49 registry is intentionally empty and cannot trust v0.48 deployments', () => {
  const v049 = deployment.deploymentFor('esmeralda', 'V049_RESET');
  const v048 = deployment.deploymentFor('esmeralda', 'V048_RESET');
  assert.equal(v049.registryKey, 'esmeralda@v049');
  assert.deepEqual(v049.poolTemplates, []);
  assert.deepEqual(v049.offerTemplates, []);
  assert.deepEqual(v049.crossLayerHtlcTemplates, []);
  assert.equal(deployment.crossLayerAvailability(v048).kind, 'INCOMPATIBLE_GENERATION');
  assert.equal(deployment.crossLayerAvailability(v049).kind, 'NOT_RECORDED');
});
