/**
 * Chain identity: the question every other guard reduces to — *does this value belong to the
 * network I think I am on?*
 *
 * The vectors here are real. The Minotari address is the operator's own public donation address,
 * and the Ootle one is upstream's own test vector from `crates/ootle_address/src/macros.rs`. A
 * parser verified only against strings it generated itself is verified against nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../dist/index.js');

/** The operator's public XTM donation address. Minotari L1 mainnet. */
const L1_MAINNET = '1259DG2v4nxMugUpj3pgSheEEhVZmoExr44GhpnC9FGVwiJscmwo2oYnzFTQWxcsHBYjmupCBaWUsNf5gDttKw2Xmg4';
/** Upstream's own localnet vector, from ootle_address's macros. */
const L2_LOCALNET =
  'otl_loc_1nsy5c5mfn7jgmg5nm3s3m4vr829tgpeehmymkme6k5wszde6wc7zcfwtyyxwn62tqefqyfyjangalt4zrygzwyf8c6c2jtfqyd8dk0gtwcv5x';

test('network bytes match the authoritative upstream table, on both layers', () => {
  // `crates/ootle_network/src/lib.rs` at cohort 6a25dbc, whose enum carries the comment "The
  // variants and assigned byte needs to match the L1 network enum" — and
  // `base_layer/common_types/src/configuration/network.rs` in tari 6.3.0-pre.2 agrees.
  assert.deepEqual(pc.NETWORK_BYTES, {
    mainnet: 0x00,
    stagenet: 0x01,
    nextnet: 0x02,
    localnet: 0x10,
    igor: 0x24,
    esmeralda: 0x26,
  });
  assert.equal(pc.networkForByte(0x26), 'esmeralda');
  assert.equal(pc.networkForByte(0x00), 'mainnet');
  // A byte no network claims fails closed rather than defaulting.
  assert.equal(pc.networkForByte(0x25), undefined);
  assert.equal(pc.networkForByte(0xff), undefined);
  assert.equal(pc.networkForByte(1.5), undefined);
  // Mainnet is the only network that is not a testnet, matching upstream's own `is_testnet`.
  assert.equal(pc.isTestnet('mainnet'), false);
  for (const network of ['stagenet', 'nextnet', 'localnet', 'igor', 'esmeralda']) {
    assert.equal(pc.isTestnet(network), true, `${network} is a testnet`);
  }
});

test('Ootle address prefixes are per-network, so an L2 address identifies its own network', () => {
  assert.deepEqual(pc.OOTLE_ADDRESS_HRP, {
    mainnet: 'otl_',
    stagenet: 'otl_stg_',
    nextnet: 'otl_nxt_',
    localnet: 'otl_loc_',
    igor: 'otl_igr_',
    esmeralda: 'otl_esm_',
  });
  assert.equal(pc.networkForHrp('otl_esm_'), 'esmeralda');
  assert.equal(pc.networkForHrp('otl_'), 'mainnet');
  assert.equal(pc.networkForHrp('otl_nope_'), undefined);
});

test('the Minotari parser is a real parse: three-part base58, DammSum, size and network byte', () => {
  const parsed = pc.parseMinotariAddress(L1_MAINNET);
  assert.equal(parsed.network, 'mainnet');
  assert.equal(parsed.networkByte, 0x00);
  assert.equal(parsed.kind, 'dual', 'a dual address carries a view key and a spend key');
  assert.deepEqual(parsed.features, ['ONE_SIDED']);
  assert.equal(parsed.paymentIdBytes, 0);

  // Each way the string can be wrong gets its own refusal, and every one of them is caught —
  // which a regex over the base58 alphabet would not do.
  const flipLast = L1_MAINNET.slice(0, -1) + (L1_MAINNET.endsWith('o') ? 'p' : 'o');
  assert.throws(() => pc.parseMinotariAddress(flipLast), /DammSum checksum/);
  assert.throws(() => pc.parseMinotariAddress(L1_MAINNET.slice(0, -1)), /single\) or 67/);
  assert.throws(() => pc.parseMinotariAddress(`${L1_MAINNET.slice(0, 10)}0${L1_MAINNET.slice(11)}`), /not a base58 character/);
  assert.throws(() => pc.parseMinotariAddress(''), /45\.\.443/);
  assert.throws(() => pc.parseMinotariAddress(` ${L1_MAINNET}`), /no surrounding whitespace/);
  assert.throws(() => pc.parseMinotariAddress(42), /must be a string/);
  // An Ootle address is not a Minotari address, and is refused as one.
  assert.throws(() => pc.parseMinotariAddress(L2_LOCALNET), /base58 character/);
});

test('the Ootle parser verifies a real bech32m checksum over the network prefix', () => {
  const parsed = pc.parseOotleAddress(L2_LOCALNET);
  assert.equal(parsed.network, 'localnet');
  assert.equal(parsed.hrp, 'otl_loc_');
  assert.equal(parsed.accountPublicKeyHex.length, 64);
  assert.equal(parsed.viewPublicKeyHex.length, 64);
  assert.equal(parsed.destinationTagBytes, 0);

  // THE PROPERTY THAT MATTERS: the checksum covers the prefix, so an address cannot be relabelled
  // onto another network. This is why an L2 donation destination can be validated for its network
  // with no chain read at all.
  const relabelled = L2_LOCALNET.replace('otl_loc_', 'otl_');
  assert.throws(() => pc.parseOotleAddress(relabelled), /bech32m checksum/);
  const asEsmeralda = L2_LOCALNET.replace('otl_loc_', 'otl_esm_');
  assert.throws(() => pc.parseOotleAddress(asEsmeralda), /bech32m checksum/);

  const flipped = L2_LOCALNET.slice(0, -1) + (L2_LOCALNET.endsWith('x') ? 'y' : 'x');
  assert.throws(() => pc.parseOotleAddress(flipped), /bech32m checksum/);
  assert.throws(() => pc.parseOotleAddress('otl_esm_1b'), /no bech32 checksum/);
  assert.throws(() => pc.parseOotleAddress('nothing'), /no bech32 separator|bech32/);
  assert.throws(() => pc.parseOotleAddress(`otl_loc_1${'q'.repeat(10)}`), /bech32m checksum/);
  // Mixed case is refused, as bech32m requires.
  assert.throws(() => pc.parseOotleAddress(`${L2_LOCALNET.slice(0, 20).toUpperCase()}${L2_LOCALNET.slice(20)}`), /mix upper and lower case/);
});

test('ESMERALDA RESOURCES AND ADDRESSES CANNOT BE MISTAKEN FOR MAINNET ONES', () => {
  // Isolation test 1. Both layers, both directions.
  const esmeralda = L2_LOCALNET.replace('otl_loc_', 'otl_esm_');
  // (Relabelling breaks the checksum, so a genuine Esmeralda address is needed for the positive
  // case; the point here is that no relabelled string is ever accepted for either network.)
  assert.throws(() => pc.parseOotleAddress(esmeralda), /bech32m checksum/);

  assert.equal(pc.addressIdentity(L2_LOCALNET).network, 'localnet');
  assert.equal(pc.requireAddressFor(L2_LOCALNET, { layer: 'L2_OOTLE', network: 'mainnet' }).ok, false);
  assert.match(
    pc.requireAddressFor(L2_LOCALNET, { layer: 'L2_OOTLE', network: 'mainnet' }).reason,
    /This address is for localnet, but mainnet is required/,
  );
  // And a mainnet L1 address is not usable where an Esmeralda one is wanted.
  assert.equal(pc.requireAddressFor(L1_MAINNET, { layer: 'L1_MINOTARI', network: 'esmeralda' }).ok, false);
});

test('AN L1 XTM ADDRESS CANNOT BE USED AS AN L2 TRADING OR DONATION DESTINATION', () => {
  // Isolation test 8. The two layers are separate networks with separate assets, and the refusal
  // says so rather than reporting a malformed address.
  const verdict = pc.requireAddressFor(L1_MAINNET, { layer: 'L2_OOTLE', network: 'mainnet' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /different networks with different assets/);
  assert.match(verdict.reason, /one is never a destination for the other/);

  // The reverse, too.
  const reverse = pc.requireAddressFor(L2_LOCALNET, { layer: 'L1_MINOTARI', network: 'localnet' });
  assert.equal(reverse.ok, false);
  assert.match(reverse.reason, /Ootle \(L2\) address, but a Minotari base-layer \(L1\) address is required/);

  // Layer detection comes from PARSING both, not from a prefix guess.
  assert.deepEqual(pc.addressIdentity(L1_MAINNET), { layer: 'L1_MINOTARI', network: 'mainnet' });
  assert.deepEqual(pc.addressIdentity(L2_LOCALNET), { layer: 'L2_OOTLE', network: 'localnet' });
  assert.equal(pc.addressIdentity('component_' + 'ab'.repeat(32)), undefined, 'a component address is neither');
  assert.equal(pc.addressIdentity(''), undefined);
  assert.equal(pc.addressIdentity(undefined), undefined);
  assert.match(pc.requireAddressFor('garbage', { layer: 'L1_MINOTARI', network: 'mainnet' }).reason, /parsed as both and failed both/);
});

test('AN UNKNOWN NETWORK FAILS CLOSED, with no default and no fallback', () => {
  // Isolation test 3.
  assert.equal(pc.networkFromName('esmeralda'), 'esmeralda');
  assert.equal(pc.networkFromName('ESMERALDA'), 'esmeralda');
  assert.equal(pc.networkFromName('mainnet'), 'mainnet');
  for (const bad of ['', 'esme', 'tari-mainnet', 'nextnet2', null, undefined, 7, {}]) {
    assert.equal(pc.networkFromName(bad), undefined, `${JSON.stringify(bad)} is not a network`);
  }
  // The registry refuses too, naming what it does know rather than substituting.
  const lookup = pc.profileFor('L2_OOTLE', 'igor');
  assert.equal(lookup.ok, false);
  assert.match(lookup.reason, /no verified facts about igor on Ootle \(L2\)/);
  assert.match(lookup.reason, /Nothing is assumed for an unlisted network/);
});
