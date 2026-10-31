require('./bootstrap.cjs');
/**
 * P2P SwapOffer maker/taker flows, end to end below the UI:
 *   builders  == the JSON the real engine executed (instruction fixture, swap_offer_* scenarios)
 *   reviews   state exactly what leaves and what is released; tampering is caught
 *   invitations: round trip, and a FORGED invitation can never override chain terms
 * Chain terms come from the engine-produced SwapOffer substates via the official decoder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('@tari-ootle/wallet-adapter');
const pc = require('@tari-ootle/protocol-client');
const wire = require('./fixtures/ootle-v048-instructions.json');
const so = require('./fixtures/ootle-v048-swapoffer-wire.json');
const { buildSignableInstructions } = require('../build-test/lib/instructions.js');
const review = require('../build-test/lib/review.js');
const executionIdentity = require('../build-test/lib/executionIdentity.js');
const { loadOotleWasmBor } = require('./support/ootleWasmBor.cjs');

const scenario = (name) => wire.scenarios.find((s) => s.name === name);
const serialise = (intent) => buildSignableInstructions({ instructions: intent.instructions });
const base = { maxEpoch: '10', operationId: 'op' };

async function chain(name) {
  const d = await loadOotleWasmBor();
  const o = so.offers.find((x) => x.name === name);
  const map = new Map(Object.entries(o.substates).map(([id, e]) => [id, d.decodeSubstateValue(e.value)]));
  return pc.decodeSwapOffer({ read: async (id) => map.get(id) }, o.component, [so.template]);
}

const CTX = { network: 'esmeralda', generation: 'v048' };

// ---------------------------------------------------------------------------
// Builders == engine
// ---------------------------------------------------------------------------

test('maker: create (fungible, designated taker, hash lock, expiry) == engine-executed JSON', () => {
  const { params, instructions } = scenario('swap_offer_create');
  const intent = w.buildCreateSwapOfferIntent({ ...params, ...base });
  assert.deepEqual(serialise(intent), instructions);
});

test('maker: create NFT-for-NFT barter (withdraw_non_fungible, Some(wanted id)) == engine-executed JSON', () => {
  const { params, instructions } = scenario('swap_offer_create_nft');
  assert.deepEqual(serialise(w.buildCreateSwapOfferIntent({ ...params, ...base })), instructions);
});

test('taker: fill (with preimage) deposits what the escrow releases == engine-executed JSON', () => {
  const { params, instructions } = scenario('swap_offer_fill');
  const intent = w.buildFillSwapOfferIntent({ ...params, ...base });
  assert.deepEqual(serialise(intent), instructions);
  assert.equal(instructions.at(-1).CallMethod.method, 'deposit', 'the released asset is deposited, never left dangling');
});

test('taker: NFT barter fill == engine-executed JSON', () => {
  const { params, instructions } = scenario('swap_offer_fill_nft');
  assert.deepEqual(serialise(w.buildFillSwapOfferIntent({ ...params, ...base })), instructions);
});

test('maker: claim and cancel deposit the released bucket == engine-executed JSON', () => {
  for (const [name, build] of [['swap_offer_claim', w.buildClaimSwapOfferIntent], ['swap_offer_cancel', w.buildCancelSwapOfferIntent]]) {
    const { params, instructions } = scenario(name);
    assert.deepEqual(serialise(build({ ...params, ...base })), instructions, name);
  }
});

test('builders refuse malformed terms instead of guessing (no type or representation change)', () => {
  const { params } = scenario('swap_offer_create');
  const bad = [
    { ...params, requested: { ...params.offered } },
    { ...params, offered: { kind: 'fungible', resource: params.offered.resource, amount: '0' } },
    { ...params, offered: { kind: 'nft', resource: params.offered.resource, nftId: 'art-1' } },
    { ...params, designatedTaker: 'xyz' },
    { ...params, hashLock: 'ab' },
    { ...params, expiresAtEpoch: '-1' },
    { ...params, offerTemplateAddress: 'nope' },
  ];
  for (const p of bad) assert.throws(() => w.buildCreateSwapOfferIntent({ ...p, ...base }), JSON.stringify(p).slice(0, 80));
  assert.throws(() => w.buildFillSwapOfferIntent({ ...scenario('swap_offer_fill').params, preimage: 'zz', ...base }), /preimage/);
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

function identityFor(account) {
  return executionIdentity.captureIdentity({ provider: {}, expectedNetwork: 'esmeralda', providerNetwork: 'esmeralda', account, capabilities: { transactionRequests: true }, nonce: 'n1' });
}

test('review: a create states what leaves (INPUT) and what is requested (OUTPUT); the differential accepts it', () => {
  const { params } = scenario('swap_offer_create');
  const intent = w.buildCreateSwapOfferIntent({ ...params, ...base });
  const r = review.reviewFromSwapOfferIntent({ intent, operationId: 'op', network: 'esmeralda', identity: identityFor(params.accountAddress) });
  assert.equal(r.legs[0].operation, 'P2P_OFFER_CREATE');
  assert.deepEqual(r.legs[0].amounts.map((a) => [a.role, a.amountRaw]), [['INPUT', '1000'], ['OUTPUT', '2500']]);
  const diff = review.diffReviewForIntent(r, intent);
  assert.equal(diff.ok, true, diff.mismatches.join('; '));
});

test('review: a review for different terms or another account is refused by the differential', () => {
  const { params } = scenario('swap_offer_create');
  const intent = w.buildCreateSwapOfferIntent({ ...params, ...base });
  const other = w.buildCreateSwapOfferIntent({ ...params, requested: { ...params.requested, amount: '1' }, ...base });
  const r = review.reviewFromSwapOfferIntent({ intent: other, operationId: 'op', network: 'esmeralda', identity: identityFor(params.accountAddress) });
  assert.equal(review.diffReviewForIntent(r, intent).ok, false);
  const wrongAccount = { ...intent, accountAddress: `component_${'9'.repeat(64)}` };
  assert.equal(review.diffReviewForIntent(review.reviewFromSwapOfferIntent({ intent, operationId: 'op', network: 'esmeralda', identity: identityFor(params.accountAddress) }), wrongAccount).ok, false);
});

test('review: fill/claim/cancel cannot be reviewed without the chain-read release, and state it', async () => {
  const { params } = scenario('swap_offer_fill');
  const intent = w.buildFillSwapOfferIntent({ ...params, ...base });
  assert.throws(() => review.reviewFromSwapOfferIntent({ intent, operationId: 'op', network: 'esmeralda', identity: identityFor(params.accountAddress) }), /what the escrow releases/);
  const s = await chain('open_fungible');
  const r = review.reviewFromSwapOfferIntent({ intent, operationId: 'op', network: 'esmeralda', identity: identityFor(params.accountAddress), chainReceive: { kind: 'fungible', resource: s.offered.resourceAddress, amount: s.offered.amount } });
  assert.deepEqual(r.legs[0].amounts.map((a) => a.role), ['INPUT', 'RECEIVE']);
  assert.equal(review.diffReviewForIntent(r, intent).ok, true, review.diffReviewForIntent(r, intent).mismatches.join('; '));
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

test('invitation: built from chain, encoded, pasted back, and verified against chain = fillable for the designated taker', async () => {
  const s = await chain('open_fungible');
  const code = pc.encodeInvitation(pc.invitationFromChain(s, { ...CTX, memo: 'XXX for YYY' }));
  assert.match(code, /^shadowswap-offer:v1:[A-Za-z0-9_-]+$/);
  const parsed = pc.parseInvitation(`  ${code}\n`);
  const verdict = pc.verifyInvitation(parsed, s, { ...CTX, currentEpoch: '5', takerPublicKey: so.taker.publicKey });
  assert.deepEqual(verdict.mismatches, []);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.fillable, true);
  assert.equal(verdict.requiresPreimage, true);
  assert.equal(parsed.memo, 'XXX for YYY');
});

test('invitation: carries no secret (no preimage, no keys) and refuses one that tries', async () => {
  const s = await chain('open_fungible');
  const inv = pc.invitationFromChain(s, CTX);
  const json = JSON.stringify(inv);
  const fixtureOffer = so.offers.find((o) => o.name === 'open_fungible');
  assert.equal(json.includes(fixtureOffer.preimage), false, 'the hash-lock preimage is never in an invitation');
  for (const key of ['preimage', 'secret', 'seed', 'privateKey', 'viewKey', 'mnemonic']) {
    assert.throws(() => pc.validateInvitation({ ...inv, [key]: 'x' }), /never carry secrets/, key);
  }
  assert.throws(() => pc.validateInvitation({ ...inv, extra: 1 }), /unknown field/);
});

test('invitation: malformed, oversized or foreign codes are refused', () => {
  assert.throws(() => pc.parseInvitation('hello'), /not a Shadow Swap offer invitation/);
  assert.throws(() => pc.parseInvitation('shadowswap-offer:v2:abc'), /unsupported version/);
  assert.throws(() => pc.parseInvitation('shadowswap-offer:v1:@@@'), /base64url/);
  assert.throws(() => pc.parseInvitation('shadowswap-offer:v1:' + Buffer.from('{').toString('base64url')), /not valid JSON/);
  assert.throws(() => pc.parseInvitation('shadowswap-offer:v1:' + 'A'.repeat(5000)), /too long/);
});

test('FORGED invitation: every altered term is detected, the offer is unfillable, and the CHAIN terms are what is shown', async () => {
  const s = await chain('open_fungible');
  const real = pc.invitationFromChain(s, CTX);
  const forgeries = {
    'offered amount inflated': { ...real, offered: { ...real.offered, amount: '1000000' } },
    'offered resource swapped': { ...real, offered: { ...real.offered, resource: `resource_${'ab'.repeat(32)}` } },
    'requested amount lowered': { ...real, requested: { ...real.requested, amount: '1' } },
    'requested resource swapped': { ...real, requested: { ...real.requested, resource: `resource_${'cd'.repeat(32)}` } },
    'designated taker dropped': { ...real, designatedTaker: null },
    'hash lock removed': { ...real, hashLock: null },
    'expiry extended': { ...real, expiresAtEpoch: '0' },
    'maker replaced': { ...real, maker: 'ef'.repeat(32) },
    'template replaced': { ...real, template: '12'.repeat(32) },
    'other network': { ...real, network: 'igor' },
    'other generation': { ...real, generation: 'pre-v048' },
  };
  for (const [what, forged] of Object.entries(forgeries)) {
    const parsed = pc.parseInvitation(pc.encodeInvitation(forged));
    const v = pc.verifyInvitation(parsed, s, { ...CTX, currentEpoch: '5', takerPublicKey: so.taker.publicKey });
    assert.equal(v.fillable, false, what);
    assert.ok(v.mismatches.length >= 1, what);
    assert.equal(v.chain, s, `${what}: the verdict's terms are the chain's`);
  }
});

test('blockers: filled, cancelled, expired, wrong taker, own offer and unknown epoch all prevent a fill', async () => {
  const open = await chain('open_fungible');
  const inv = pc.invitationFromChain(open, CTX);
  const at = (state, ctx) => pc.verifyInvitation(inv, state, { ...CTX, ...ctx });
  assert.match(at(open, { currentEpoch: '1000000', takerPublicKey: so.taker.publicKey }).blockers.join(';'), /expired/);
  assert.match(at(open, { currentEpoch: '5', takerPublicKey: 'ab'.repeat(32) }).blockers.join(';'), /reserved for a different key/);
  assert.match(at(open, { currentEpoch: '5' }).blockers.join(';'), /did not report its public key/);
  assert.match(at(open, { currentEpoch: '5', takerPublicKey: so.maker.publicKey }).blockers.join(';'), /reserved for a different key|your own offer/);
  assert.match(at(open, { takerPublicKey: so.taker.publicKey }).blockers.join(';'), /epoch is unknown/);
  const filled = await chain('filled');
  assert.match(pc.verifyInvitation(inv, filled, { ...CTX, currentEpoch: '5', takerPublicKey: so.taker.publicKey }).blockers.join(';'), /filled/);
  const nftOpen = await chain('open_nft');
  const nftInv = pc.invitationFromChain(nftOpen, CTX);
  const cancelled = await chain('cancelled');
  const v = pc.verifyInvitation(nftInv, cancelled, { ...CTX, currentEpoch: '5', takerPublicKey: so.taker.publicKey });
  assert.equal(v.fillable, false);
  assert.match(v.blockers.join(';'), /cancelled/);
});

test('NFT barter invitation: exact ids on both sides; a different wanted id is a mismatch', async () => {
  const s = await chain('open_nft');
  const inv = pc.invitationFromChain(s, CTX);
  assert.deepEqual(inv.offered, { kind: 'nft', resource: s.offered.resourceAddress, nftId: 'str_art-1' });
  assert.deepEqual(inv.requested, { kind: 'nft', resource: s.requested.resource, nftId: 'str_art-2' });
  assert.equal(pc.verifyInvitation(inv, s, { ...CTX, currentEpoch: '5' }).fillable, true);
  const forged = { ...inv, requested: { ...inv.requested, nftId: 'str_art-9' } };
  assert.equal(pc.verifyInvitation(forged, s, { ...CTX, currentEpoch: '5' }).fillable, false);
});

test('taker fill is built from CHAIN terms: payment = exactly what the offer wants', async () => {
  const s = await chain('open_fungible');
  const payment = s.requested.nftId === null ? { kind: 'fungible', resource: s.requested.resource, amount: s.requested.amount } : { kind: 'nft', resource: s.requested.resource, nftId: s.requested.nftId };
  const intent = w.buildFillSwapOfferIntent({ offerComponent: s.component, accountAddress: so.taker.account, payment, preimage: so.offers[0].preimage, ...base });
  const out = serialise(intent);
  assert.equal(out[0].CallMethod.method, 'withdraw');
  assert.equal(out[2].CallMethod.method, 'fill');
  assert.equal(out.at(-1).CallMethod.method, 'deposit');
});
