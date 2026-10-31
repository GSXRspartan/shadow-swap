require('./bootstrap.cjs');
/**
 * MARKETPLACE ACTION WIRING — the eight create / cancel / refund operations, plus
 * the instruction form they depend on.
 *
 * Two properties are under test, and they are different in kind.
 *
 * 1. TEMPLATE PINNING. A create action names a template ADDRESS and produces a
 *    component with no address until the receipt lands. There is therefore nothing
 *    to reread before signing, and the template address IS the only pre-submission
 *    identity check available. If it were caller-supplied, a substituted template
 *    would be approved in the one place the user has no other way to tell what they
 *    are signing. These tests pin it to the three templates whose flows settled
 *    live.
 *
 * 2. REVIEW/SIGN DRIFT. The review's amounts are DERIVED FROM THE INTENT rather
 *    than passed alongside it. The tests here build an intent, derive its review,
 *    and then run the real differential the execution gate runs — so a drift
 *    between what is shown and what is signed would fail here rather than in
 *    production.
 *
 * Also covered: `CallFunction` serialisation, which is what makes the create
 * operations constructible at all. Before this, `buildSignableInstructions`
 * refused `call_function` outright, so all three create paths threw. The wire shape
 * is asserted here explicitly so a future edit cannot change it silently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const actions = require('../build-test/services/marketplaceActions.js');
const { buildSignableInstructions } = require('../build-test/lib/instructions.js');
const { diffReviewAgainstMarketplaceIntent } = require('../build-test/lib/review.js');
const executionIdentity = require('../build-test/lib/executionIdentity.js');

const TTARI = 'resource_0101010101010101010101010101010101010101010101010101010101010101';
const NFT = 'resource_e6d192037660ad95ae6bc50e3380f435dcf161453fa5754807c33b52a5623bd8';
const ACCOUNT_A = 'component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b';
const ACCOUNT_B = 'component_b510055406cbe43325aa7790a38f980eb03d354f525b0acc7c59461b07dde77d';
const LISTING = 'component_3ed8a84501206da7e968ab9e41cbc56de13101636a139312a18b65fd366f6836';
const OFFER = 'component_b42b09aef429cb41eb45c555a2bc5e9b504cc3a7c4d901527753d287d93737d8';
const BID = 'component_0d57aec2b2dddb1ea8a0f620ed295efd84645961a4d113ee4b396637d1a07dd2';

const identityFor = (account) =>
  executionIdentity.captureIdentity({
    provider: {},
    expectedNetwork: 'esmeralda',
    providerNetwork: 'esmeralda',
    account,
    capabilities: { transactionRequests: true },
    nonce: 'n1',
  });
const identity = identityFor(ACCOUNT_A);

/**
 * Build the review for an action, bound to the account THAT ACTION SETTLES FROM.
 *
 * Binding every review to one account would be wrong, not merely lax: the
 * differential compares the review's account against the account named on the
 * intent's own withdraw instructions, so an offer made from a different account
 * would be refused. That refusal is the check working, and the test asserts it
 * explicitly below rather than routing around it.
 */
function accountOf(action) {
  return action.sellerAccount ?? action.buyerAccount;
}

function reviewFor(action, account = accountOf(action)) {
  return actions.reviewForIntent({
    action: action.kind,
    operationId: 'op-1',
    network: 'esmeralda',
    account,
    identity: identityFor(account),
    intent: actions.buildMarketplaceIntent(action),
  });
}

const ALL_ACTIONS = [
  {
    kind: 'CREATE_LISTING',
    sellerAccount: ACCOUNT_A,
    nftResource: NFT,
    nftId: 'str_item-1',
    quoteResource: TTARI,
    priceRaw: '1000',
    expiryEpoch: 0,
  },
  { kind: 'CANCEL_LISTING', listingAddress: LISTING, sellerAccount: ACCOUNT_A, nftResource: NFT, nftId: 'str_item-1', quoteResource: TTARI },
  { kind: 'MAKE_ITEM_OFFER', buyerAccount: ACCOUNT_B, nftResource: NFT, nftId: 'str_item-1', quoteResource: TTARI, offerAmountRaw: '500', expiryEpoch: 0 },
  { kind: 'CANCEL_ITEM_OFFER', offerAddress: OFFER, buyerAccount: ACCOUNT_B, nftResource: NFT, nftId: 'str_item-1', quoteResource: TTARI, refundAmountRaw: '500' },
  { kind: 'REFUND_ITEM_OFFER', offerAddress: OFFER, buyerAccount: ACCOUNT_B, nftResource: NFT, nftId: 'str_item-1', quoteResource: TTARI, refundAmountRaw: '500' },
  {
    kind: 'PLACE_COLLECTION_BID',
    buyerAccount: ACCOUNT_A,
    collectionResource: NFT,
    quoteResource: TTARI,
    pricePerNftRaw: '250',
    quantityRaw: '3',
    expiryEpoch: 0,
  },
  { kind: 'CANCEL_COLLECTION_BID', bidAddress: BID, buyerAccount: ACCOUNT_A, collectionResource: NFT, quoteResource: TTARI, refundAmountRaw: '750' },
  { kind: 'REFUND_COLLECTION_BID', bidAddress: BID, buyerAccount: ACCOUNT_A, collectionResource: NFT, quoteResource: TTARI, refundAmountRaw: '750' },
];

// ---------------------------------------------------------------------------
// TEMPLATE PINNING
// ---------------------------------------------------------------------------

test('templates: the three published templates are pinned, not derived', () => {
  // These are the exact addresses whose flows settled live on Esmeralda. A rebrand
  // must never change them; they are on-chain identities.
  assert.equal(actions.MARKETPLACE_TEMPLATES.FixedPriceListing, 'template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329');
  assert.equal(actions.MARKETPLACE_TEMPLATES.ItemOffer, 'template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6');
  assert.equal(actions.MARKETPLACE_TEMPLATES.CollectionBid, 'template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54');
  for (const address of Object.values(actions.MARKETPLACE_TEMPLATES)) {
    assert.match(address, /^template_[0-9a-f]{64}$/);
  }
});

test('templates: a create action emits the pinned template, not a caller value', () => {
  const createOf = (intent) => intent.instructions.find((i) => i.kind === 'call_function');

  const listing = createOf(actions.buildMarketplaceIntent(ALL_ACTIONS[0]));
  assert.ok(listing, 'a create listing must emit a template function call');
  assert.equal(listing.templateAddress, actions.MARKETPLACE_TEMPLATES.FixedPriceListing);

  assert.equal(createOf(actions.buildMarketplaceIntent(ALL_ACTIONS[2])).templateAddress, actions.MARKETPLACE_TEMPLATES.ItemOffer);
  assert.equal(createOf(actions.buildMarketplaceIntent(ALL_ACTIONS[5])).templateAddress, actions.MARKETPLACE_TEMPLATES.CollectionBid);
});

test('templates: a caller cannot smuggle a different template through the action', () => {
  const hostile = { ...ALL_ACTIONS[0], templateAddress: 'template_'.concat('0'.repeat(64)) };
  const intent = actions.buildMarketplaceIntent(hostile);
  assert.equal(
    intent.instructions.find((i) => i.kind === 'call_function').templateAddress,
    actions.MARKETPLACE_TEMPLATES.FixedPriceListing,
    'an extra caller-supplied field must be ignored, not honoured',
  );
});

// ---------------------------------------------------------------------------
// CALL_FUNCTION SERIALISATION
// ---------------------------------------------------------------------------

test('call_function: serialises to the documented instruction shape', () => {
  const intent = actions.buildMarketplaceIntent(ALL_ACTIONS[0]);
  const wire = buildSignableInstructions({ instructions: intent.instructions });
  const create = wire.find((i) => i.CallFunction !== undefined);
  assert.ok(create, 'the create instruction must be a CallFunction');
  // TemplateAddress serialises as the bare 64-hex hash (engine fixture "probe").
  assert.equal(create.CallFunction.address, actions.MARKETPLACE_TEMPLATES.FixedPriceListing.replace(/^template_/, ''));
  assert.equal(typeof create.CallFunction.function, 'string');
  assert.ok(Array.isArray(create.CallFunction.args));
  // It must NOT be emitted as a CallMethod aimed at a template address.
  assert.equal(wire.some((i) => String(i.CallMethod?.call?.Address ?? '').includes(actions.MARKETPLACE_TEMPLATES.FixedPriceListing.replace(/^template_/, ''))), false);
});

test('call_function: a malformed template address is refused, not passed through', () => {
  for (const bad of ['', 'not-a-template', 'template_xyz', 'component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b']) {
    assert.throws(
      () => buildSignableInstructions({ instructions: [{ kind: 'call_function', templateAddress: bad, method: 'create', args: [] }] }),
      /call_function.templateAddress/,
      `${bad} must be refused`,
    );
  }
});

test('call_function: every create action now serialises instead of throwing', () => {
  // Before `call_function` support existed, all three of these threw
  // "Refusing to serialise unrecognised instruction kind", which is why the create
  // buttons were disabled.
  for (const action of [ALL_ACTIONS[0], ALL_ACTIONS[2], ALL_ACTIONS[5]]) {
    const wire = buildSignableInstructions({ instructions: actions.buildMarketplaceIntent(action).instructions });
    assert.ok(wire.length > 0);
  }
});

test('instructions: an unknown kind is still refused', () => {
  assert.throws(() => buildSignableInstructions({ instructions: [{ kind: 'teleport' }] }), /unrecognised instruction kind/);
});

// ---------------------------------------------------------------------------
// REVIEW / SIGN DRIFT
// ---------------------------------------------------------------------------

test('review: every action produces a review the real differential accepts', () => {
  for (const action of ALL_ACTIONS) {
    const intent = actions.buildMarketplaceIntent(action);
    const review = reviewFor(action);
    const diff = diffReviewAgainstMarketplaceIntent(review, intent);
    assert.deepEqual(diff.mismatches, [], `${action.kind}: ${diff.mismatches.join('; ')}`);
    assert.equal(diff.ok, true);
  }
});

test('review: the review is deeply frozen, so it cannot change after approval', () => {
  const review = reviewFor(ALL_ACTIONS[0]);
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.walletRequest), true);
  assert.equal(Object.isFrozen(review.legs), true);
  assert.equal(Object.isFrozen(review.legs[0].amounts), true);
});

test('review: a review bound to a different account is refused', () => {
  // The account check is what stops a review from being "valid" for an unrelated
  // signer. Every withdraw instruction names the settlement account.
  const intent = actions.buildMarketplaceIntent(ALL_ACTIONS[0]);
  const review = reviewFor(ALL_ACTIONS[0]);
  const tampered = { ...review, account: ACCOUNT_B };
  assert.equal(diffReviewAgainstMarketplaceIntent(tampered, intent).ok, false);
});

test('review: a review that drops a moved amount is refused', () => {
  const action = ALL_ACTIONS[2]; // make offer — moves a fungible amount into escrow
  const intent = actions.buildMarketplaceIntent(action);
  const review = reviewFor(action);
  const stripped = {
    ...review,
    legs: [{ ...review.legs[0], amounts: review.legs[0].amounts.filter((a) => a.role !== 'INPUT') }],
  };
  const diff = diffReviewAgainstMarketplaceIntent(stripped, intent);
  assert.equal(diff.ok, false);
  assert.ok(diff.mismatches.some((m) => /does not state that amount/.test(m)));
});

test('review: a cancel still names the item it releases', () => {
  // Cancelling a listing moves no fungible value, but the review must still say what
  // the operation is about or the user approves an empty-looking screen.
  const review = reviewFor(ALL_ACTIONS[1]);
  const nft = review.legs[0].amounts.find((a) => a.nftId !== undefined);
  assert.ok(nft, 'the released NFT must be named');
  assert.equal(nft.nftId, 'str_item-1');
  assert.equal(nft.role, 'OUTPUT');
});

test('review: a refund figure is shown to the user but NOT claimed as a value-moving amount', () => {
  // A cancel/refund moves no amount as an argument: it calls `cancel` on the
  // component and the template returns whatever is left. So the escrow figure is
  // carried with role REFUND — visible to the user, excluded from the instruction
  // carry check because it genuinely is not carried, and never read as an economic
  // term by anything downstream.
  const summary = actions.summarizeAction(ALL_ACTIONS[6]);
  assert.ok(
    summary.lines.some((l) => l.value === '750'),
    'the authoritative remaining escrow must be visible to the user',
  );
  const review = reviewFor(ALL_ACTIONS[6]);
  assert.equal(
    review.legs[0].amounts.some((a) => a.amountRaw === '750' && a.role !== 'REFUND'),
    false,
    'the refund figure must never be presented as a value the transaction spends',
  );
  const refund = review.legs[0].amounts.find((a) => a.role === 'REFUND');
  assert.ok(refund, 'the authoritative escrow must be shown, flagged as a refund');
  assert.equal(refund.amountRaw, '750');
  assert.equal(refund.resourceAddress, TTARI);
  // And the differential still accepts the review, because the leg names the bid.
  assert.equal(diffReviewAgainstMarketplaceIntent(review, actions.buildMarketplaceIntent(ALL_ACTIONS[6])).ok, true);
});

test('review: an amount of zero is refused rather than signed', () => {
  const intent = actions.buildMarketplaceIntent(ALL_ACTIONS[2]);
  const review = reviewFor(ALL_ACTIONS[2]);
  const zeroed = {
    ...review,
    legs: [{ ...review.legs[0], amounts: review.legs[0].amounts.map((a) => ({ ...a, amountRaw: '0' })) }],
  };
  assert.equal(diffReviewAgainstMarketplaceIntent(zeroed, intent).ok, false);
});

// ---------------------------------------------------------------------------
// IDENTITY NORMALISATION
// ---------------------------------------------------------------------------

test('identity: an empty nft resource is refused', () => {
  // sResourceAddress is a trade-boundary type fence, not a format validator: it
  // refuses display-only values and non-strings. Shape validation for addresses is
  // the decoder's job, and over-tightening here would reject legitimate ids.
  for (const bad of ['', '   ', undefined, null, 42]) {
    assert.throws(() => actions.buildMarketplaceIntent({ ...ALL_ACTIONS[0], nftResource: bad }), /nftResource/, String(bad));
  }
});

test('identity: a float amount is refused before it can be signed', () => {
  for (const bad of ['1.5', '1e6', '0x10', '', ' 12', '12 ']) {
    assert.throws(() => actions.buildMarketplaceIntent({ ...ALL_ACTIONS[0], priceRaw: bad }), /price/, `${bad} must be refused`);
  }
});

test('identity: a very large raw amount survives as an exact string', () => {
  const huge = '123456789012345678901234567890';
  const intent = actions.buildMarketplaceIntent({ ...ALL_ACTIONS[0], priceRaw: huge });
  assert.ok(JSON.stringify(intent).includes(huge), 'a raw amount beyond 2^53 must never round-trip through a JS number');
});

// ---------------------------------------------------------------------------
// RECORD KINDS AND SUMMARIES
// ---------------------------------------------------------------------------

test('records: every action maps to a distinct durable record kind', () => {
  const kinds = ALL_ACTIONS.map((a) => actions.recordKindFor(a.kind));
  assert.equal(new Set(kinds).size, kinds.length, 'two operations sharing a record kind would be indistinguishable in history');
  for (const kind of kinds) assert.match(kind, /^MARKET_[A-Z_]+$/);
});

test('summaries: every action produces a non-empty human summary', () => {
  for (const action of ALL_ACTIONS) {
    const summary = actions.summarizeAction(action);
    assert.ok(summary.title.length > 0, `${action.kind} needs a title`);
    assert.ok(summary.lines.length > 0, `${action.kind} needs at least one line`);
    // A summary must never be empty of substance — an "operation" with no named
    // item and no named amount is not reviewable by a human.
    assert.ok(
      summary.lines.some((line) => line.value.length > 0),
      `${action.kind} has a line with no value`,
    );
  }
});

test('summaries: a cancel states the refund so the user knows what comes back', () => {
  for (const kind of ['CANCEL_ITEM_OFFER', 'REFUND_ITEM_OFFER', 'CANCEL_COLLECTION_BID', 'REFUND_COLLECTION_BID']) {
    const action = ALL_ACTIONS.find((a) => a.kind === kind);
    const summary = actions.summarizeAction(action);
    assert.ok(
      summary.lines.some((line) => /refund|escrow|return/i.test(line.label) || /refund|return/i.test(line.value)),
      `${kind} must state the refund`,
    );
  }
});

test('actions: an unrecognised action is refused rather than default-constructed', () => {
  assert.throws(() => actions.buildMarketplaceIntent({ kind: 'SEND_TO_MOON' }), /unrecognised marketplace action/);
  assert.throws(() => actions.summarizeAction({ kind: 'SEND_TO_MOON' }), /unrecognised marketplace action/);
});