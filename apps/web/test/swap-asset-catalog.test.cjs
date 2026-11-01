/**
 * Swap asset-catalog regressions: what the picker offers, and under what name.
 *
 * Live acceptance context: a user-owned created-Stealth airdrop (KSK) never
 * appeared in the picker because balances were read once, at connect, and
 * assets WITHOUT pools were dropped on the way to the options. The catalog is
 * the pure decision now tested here; the balance-refresh behaviour that feeds
 * it is separately covered.
 */
require('./bootstrap.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');

const TARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
const KSK = 'resource_baacb92d6bd399111c89c5277a7c6f4593c91e33e3d8ac0261d8489a870df29c';
const LPTESTA = 'resource_87385b51c57f8682ec2de4a0e590b17a56c7465c904552e80cabaeb467e70dfc';
const OTHER = 'resource_' + 'ab'.repeat(32);

const catalog = require('../build-test/lib/swapAssetCatalog.js');

const poolSide = (resource, symbol, decimals) => ({ resourceAddress: resource, symbol, decimals });

test('catalog: known pool assets are listed with their descriptor names', () => {
  const out = catalog.swapAssetCatalog({ pools: [{ base: poolSide(TARI, 'tTARI', '6'), quote: poolSide(LPTESTA, 'LPTESTA', '6') }], balances: [] });
  assert.deepEqual(out.map((a) => a.name).sort(), ['LPTESTA', 'tTARI']);
  const lpt = out.find((a) => a.resource === LPTESTA);
  assert.equal(lpt.kind, 'fungible');
  assert.equal(lpt.decimals, 6);
  assert.equal(lpt.heldDisplay, undefined, 'a pool asset the wallet does not hold shows no made-up holding');
});

test('catalog: a wallet-owned asset with NO pool still appears, with its real holding', () => {
  const out = catalog.swapAssetCatalog({
    pools: [{ base: poolSide(TARI, 'tTARI', '6'), quote: poolSide(LPTESTA, 'LPTESTA', '6') }],
    balances: [{ resourceAddress: KSK, amount: '2000000000', resourceType: 'stealth', divisibility: 6, symbol: 'KSK' }],
  });
  const ksk = out.find((a) => a.resource === KSK);
  assert.ok(ksk, 'the owned asset must not be hidden');
  assert.equal(ksk.name, 'KSK');
  assert.equal(ksk.kind, 'stealth', 'the wallet reports the asset as Stealth-typed and the catalog keeps that exact type');
  assert.equal(ksk.heldDisplay, '2000', '2,000,000,000 raw at divisibility 6 displays as 2000');
  assert.equal(ksk.decimals, 6);
});

test('catalog: an owned resource the application cannot name is listed under its exact address', () => {
  const out = catalog.swapAssetCatalog({
    pools: [],
    balances: [{ resourceAddress: OTHER, amount: '1000', resourceType: 'fungible', divisibility: 3 }],
  });
  assert.equal(out.length, 1);
  assert.ok(out[0].name.startsWith('resource_'), 'an unnamed asset is displayed by its address, never an invented symbol');
  assert.ok(out[0].name.length < out[0].resource.length, 'unnamed assets are abbreviated, not the full 71-char address');
  assert.equal(out[0].heldDisplay, '1');
});

test('catalog: duplicate symbols across different resources remain separate identities', () => {
  const HOLDER = 'resource_' + 'cd'.repeat(32);
  const out = catalog.swapAssetCatalog({
    pools: [],
    balances: [
      { resourceAddress: KSK, amount: '1', resourceType: 'fungible', symbol: 'TARI' },
      { resourceAddress: HOLDER, amount: '2', resourceType: 'fungible', symbol: 'TARI' },
    ],
  });
  assert.equal(out.length, 2, 'two resources with the same copied ticker are two rows');
  assert.equal(new Set(out.map((a) => a.resource)).size, 2);
});

test('catalog: an owned asset that is also a pool side shows BOTH the descriptor name and the holding', () => {
  const out = catalog.swapAssetCatalog({
    pools: [{ base: poolSide(TARI, 'tTARI', '6'), quote: poolSide(LPTESTA, 'LPTESTA', '6') }],
    balances: [{ resourceAddress: TARI, amount: '179990226', resourceType: 'stealth', divisibility: 6, symbol: 'tTARI' }],
  });
  const tari = out.find((a) => a.resource === TARI);
  assert.equal(tari.name, 'tTARI');
  assert.equal(tari.heldDisplay, '179.990226');
});

test('catalog: malformed resource addresses are refused, never displayed or invented', () => {
  const out = catalog.swapAssetCatalog({
    pools: [{ base: poolSide('component_notanaddress', 'EVIL', '6'), quote: poolSide(LPTESTA, 'LPTESTA', '6') }],
    balances: [{ resourceAddress: 'resource_SHORT', amount: '5', resourceType: 'fungible' }],
  });
  assert.ok(!out.some((a) => a.name === 'EVIL'), 'a malformed pool side cannot enter the catalog');
  assert.ok(!out.some((a) => a.resource === 'resource_SHORT'));
  assert.equal(out.length, 1, 'only the well-formed resource survives');
});

test('catalog: native tTARI is classified stealth by ADDRESS, not by anyone metadata', () => {
  const out = catalog.swapAssetCatalog({
    pools: [{ base: poolSide(TARI, 'tTARI', '6'), quote: poolSide(LPTESTA, 'LPTESTA', '6') }],
    balances: [],
  });
  assert.equal(out.find((a) => a.resource === TARI).kind, 'stealth');
});
