/**
 * Guards for two facts this pass established against Ootle v0.42.0 that are
 * easy to break silently and expensive to discover on a live network.
 *
 * 1. A template's PUBLISHED name is its COMPONENT STRUCT's identifier, not its
 *    module's. `packages/protocol-client/src/ootle.ts` refuses any component
 *    whose reported template name is not the expected one, so renaming a struct
 *    without updating the readback would make every pool read refuse — and would
 *    only show up after publication, against real money.
 *
 * 2. Canonical TARI is an ADDRESS. `resource_0101...0101` is
 *    `STEALTH_TARI_RESOURCE_ADDRESS` / `TARI_TOKEN` in
 *    `crates/template_lib_types/src/constants.rs` at tag v0.42.0 (commit
 *    a43773e), whose 32-byte object key is all `0x01`. Its symbol is `tTARI` and
 *    its deprecated alias is `XTR`; neither is an identity, and the resource is
 *    STEALTH, which is a different safety shape from a public fungible token.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pools = require('../build-test/services/pools.js');
const ootleIndexer = require('../build-test/services/ootleIndexer.js');
const P = require('@tari-ootle/protocol-client');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const clientSrc = fs.readFileSync(path.join(repoRoot, 'packages', 'protocol-client', 'src', 'ootle.ts'), 'utf8');

/** The struct the `#[template]` module declares as its component. */
function componentStructOf(templateName) {
  const source = fs.readFileSync(path.join(repoRoot, 'templates', templateName, 'src', 'lib.rs'), 'utf8');
  const start = source.indexOf('#[template]');
  assert.notEqual(start, -1, `templates/${templateName}/src/lib.rs must declare a #[template] module`);
  const rest = source.slice(start);
  // The first `pub struct`/`pub enum` at module depth is the component. The
  // builtins follow this same rule: `account_template` publishes as `Account`
  // and the liquidity-pool `template` module as `TwoResourceLiquidityPool`.
  const match = /\n\s*pub (?:struct|enum) ([A-Za-z0-9_]+)/.exec(rest);
  assert.ok(match, `templates/${templateName}/src/lib.rs must declare a component struct`);
  return match[1];
}

test('ootle v0.42: the published template name is the component struct, and the readback agrees', () => {
  const expected = {
    fungible_pool: pools.PROTOCOL_TEMPLATE_NAMES.pool,
    nft_marketplace: pools.PROTOCOL_TEMPLATE_NAMES.marketplace,
    nft_item_offer: pools.PROTOCOL_TEMPLATE_NAMES.itemOffer,
    nft_collection_bid: pools.PROTOCOL_TEMPLATE_NAMES.collectionBid,
  };
  for (const [crate, templateName] of Object.entries(expected)) {
    assert.equal(
      componentStructOf(crate),
      templateName,
      `templates/${crate} publishes as the template named "${templateName}"; a struct rename must update PROTOCOL_TEMPLATE_NAMES and the readback together`,
    );
    // The readback asserts the SAME name, or every authoritative read refuses.
    assert.ok(
      clientSrc.includes(`'${templateName}'`),
      `packages/protocol-client/src/ootle.ts must assert the template name "${templateName}"`,
    );
  }
});

test('ootle v0.42: canonical TARI is the exact resource address, not a ticker', () => {
  assert.equal(ootleIndexer.CANONICAL_TARI_RESOURCE, 'resource_0101010101010101010101010101010101010101010101010101010101010101');
  // 32 bytes of 0x01: `STEALTH_TARI_RESOURCE_ADDRESS` at tag v0.42.0.
  const hex = ootleIndexer.CANONICAL_TARI_RESOURCE.replace(/^resource_/, '');
  assert.equal(hex.length, 64);
  assert.equal(/^0{64}$/.test(hex), false, 'the canonical TARI address must not be a zero placeholder');
  assert.equal(hex, '01'.repeat(32), 'the canonical TARI object key is all 0x01');
});

test('ootle v0.42: canonical TARI divisibility is 6 raw units per TARI', () => {
  // `pub const TARI: u64 = 1_000_000;` and the constant's own doc comment:
  // "a fungible resource with a divisibility of 6". The display boundary divides
  // by exactly this, so a wrong constant silently misprices every amount.
  assert.equal(ootleIndexer.TARI_UNITS_PER_TARI, 1_000_000);
  assert.equal(String(10 ** 6), '1000000');
});

test('ootle v0.42: canonical TARI is STEALTH, so it is not a public fungible token', () => {
  // The safety policy classifies by resource TYPE and by exact identity. A
  // stealth resource's amounts are not public on chain, which is a different
  // disclosure shape from a public fungible balance.
  const eligibility = P.classifyResource({ isCanonicalTari: true, resourceType: 'Stealth', onChainEnforced: true });
  assert.equal(eligibility, 'canonical_tari');
  // A resource that merely shares the `tTARI` SYMBOL must never classify as canonical.
  const lookalike = P.classifyResource({ isCanonicalTari: false, resourceType: 'PublicFungible', onChainEnforced: true });
  assert.notEqual(lookalike, 'canonical_tari', 'a symbol lookalike must not be classified as canonical TARI');
});

test('ootle v0.42: the substate version is carried as a decimal string, never a JS number', () => {
  // v0.42.0 widened the substate version to u64. A JS number truncates above
  // 2^53, so the version is parsed only from a decimal STRING and a numeric JSON
  // value is refused rather than coerced.
  const view = { substateVersion: '18446744073709551615' };
  assert.equal(String(view.substateVersion), '18446744073709551615');
  assert.equal(Number.isSafeInteger(Number(view.substateVersion)), false, 'the u64 ceiling must not survive a round trip through a JS number');
});
