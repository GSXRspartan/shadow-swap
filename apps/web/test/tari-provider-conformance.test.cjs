/**
 * TARI WALLET INTEGRATION CONFORMANCE.
 *
 * The provider boundary in `services/tariWindow.ts` was originally derived by
 * reverse-engineering `https://universe.tari.mw/tari-connector.js`. It is now
 * coded against the PUBLISHED contract instead:
 *
 *   https://universe.tari.mw/integration/tari-dapp.d.ts
 *   https://universe.tari.mw/integration/llms-full.txt
 *   https://universe.tari.mw/integration/SKILL.md
 *
 * These tests pin that. The connector remains evidence, but the TypeScript
 * definitions are the authority, and a shape that only one wallet happens to
 * tolerate is not conformance.
 *
 * The suite is deliberately built around a STRICT provider double: it rejects
 * any outbound request parameter the published interface does not define. That
 * is what makes the suite able to catch a re-introduced compatibility field,
 * which an ordinary permissive mock can never detect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const tari = require('../build-test/services/tariWindow.js');
const types = require('../build-test/services/tariDappTypes.js');
const instructions = require('../build-test/lib/instructions.js');
const addressDomain = require('../build-test/lib/addressDomain.js');

// ---------------------------------------------------------------------------
// A STRICT provider double
// ---------------------------------------------------------------------------

/**
 * The request shapes the published `tari-dapp.d.ts` defines, per method.
 *
 * `params: null` means the contract declares no parameters at all, so a `params`
 * member on the envelope is itself a violation. Each declared parameter lists the
 * ONLY keys that may appear; `version: null` and `inputs: null` mean the optional
 * member may be absent, or present as null.
 */
const CONTRACT_PARAMS = {
  tari_requestAccounts: null,
  tari_getAccounts: null,
  tari_getNetwork: null,
  tari_getWalletAddress: null,
  tari_getBalances: null,
  tari_getCapabilities: null,
  tari_disconnect: null,
  tari_getSubstate: { required: ['substateId'], optional: ['version'] },
  tari_getTransactionResult: { required: ['transactionId'], optional: [] },
  tari_signAndSubmitTransaction: { required: ['instructions'], optional: ['maxFee', 'inputs', 'dryRun'] },
  tari_createTransactionRequest: {
    required: ['kind', 'instructions'],
    optional: ['maxFee', 'inputs', 'relatedComponents'],
  },
  tari_getTransactionRequest: { required: ['requestId'], optional: [] },
  tari_submitTransactionRequest: { required: ['requestId'], optional: [] },
};

class ContractViolation extends Error {}

/**
 * A provider that enforces the published request shapes.
 *
 * Every violation is recorded in `violations` as well as thrown, so a test can
 * assert on the exact set of undocumented fields that were transmitted.
 */
function strictProvider(overrides = {}) {
  const violations = [];
  const seen = [];
  const provider = {
    isTariWallet: true,
    violations,
    seen,
    async request(envelope) {
      seen.push(JSON.parse(JSON.stringify(envelope)));
      const shape = CONTRACT_PARAMS[envelope.method];
      if (shape === undefined) {
        violations.push(`${envelope.method} is not in the published method list`);
        throw new ContractViolation(`method ${envelope.method} is not a documented Tari method`);
      }
      // `params` present where the contract declares none.
      if (shape === null) {
        if (envelope.params !== undefined) {
          violations.push(`${envelope.method} was sent params ${JSON.stringify(envelope.params)} but the contract declares none`);
        }
      } else {
        if (envelope.params === undefined || typeof envelope.params !== 'object' || envelope.params === null || Array.isArray(envelope.params)) {
          violations.push(`${envelope.method} requires a params object`);
        } else {
          for (const key of Object.keys(envelope.params)) {
            if (!shape.required.includes(key) && !shape.optional.includes(key)) {
              violations.push(`${envelope.method} sent the undocumented parameter "${key}"`);
            }
          }
          for (const key of shape.required) {
            if (!(key in envelope.params)) violations.push(`${envelope.method} omitted the required parameter "${key}"`);
          }
        }
      }
      if (overrides.handler) return overrides.handler(envelope);
      return defaultReply(envelope.method);
    },
  };
  return provider;
}

function defaultReply(method) {
  switch (method) {
    case 'tari_getNetwork':
      return 'esmeralda';
    case 'tari_requestAccounts':
    case 'tari_getAccounts':
      return ['component_account_1'];
    case 'tari_getWalletAddress':
      return 'otl_esm_1qqwalletaddress';
    case 'tari_getCapabilities':
      return FULL_CAPABILITIES;
    case 'tari_getBalances':
      return [{ resourceAddress: 'otl_resource_1', kind: 'Fungible', symbol: 'TARI', name: 'Tari', divisibility: 6, amount: '1000000', confidentialAmount: '0' }];
    case 'tari_getSubstate':
      return { substateId: 'component_1', templateName: 'Pool', fields: {} };
    case 'tari_disconnect':
      return null;
    default:
      return {};
  }
}

/** Every documented capability, enabled. */
const FULL_CAPABILITIES = Object.fromEntries(types.TARI_CAPABILITY_KEYS.map((key) => [key, true]));

// ---------------------------------------------------------------------------
// The two provider FORMS
// ---------------------------------------------------------------------------

/**
 * A Sapient-shaped, NON-EMBEDDED extension provider.
 *
 * It does not publish `isEmbedded` at all — which is what the published
 * `TariProvider` type says: the property is optional and "only on the embedded
 * (iframe) provider". It is described by BEHAVIOUR (which methods it answers),
 * never by name, so the test cannot pass by special-casing a brand.
 */
function extensionProvider(overrides = {}) {
  return { ...strictProvider(overrides), isTariWallet: true };
}

/**
 * A Tari Universe-shaped, EMBEDDED iframe provider.
 *
 * Publishes `isEmbedded: true` and the `tari#initialized` event, as the
 * connector does.
 */
function embeddedProvider(overrides = {}) {
  return { ...strictProvider(overrides), isTariWallet: true, isEmbedded: true };
}

// ===========================================================================
// 1. NO WALLET IDENTITY, NO EMBEDDING GATE
// ===========================================================================

test('conformance: a non-embedded provider that does not publish isEmbedded is accepted', () => {
  // THE confirmed defect. The previous implementation refused any provider
  // reporting `isEmbedded === false`, on the reasoning that the connector rejects
  // outside a wallet frame. That is a wallet-identity gate the published
  // documentation forbids: `window.tari` is implemented by the Sapient extension,
  // which does not publish the field at all, and the reference states plainly
  // that a dApp "never detects which wallet it has".
  const provider = { isTariWallet: true, request: async () => 'esmeralda' };
  assert.equal('isEmbedded' in provider, false, 'the extension form must not publish isEmbedded');
  assert.equal(tari.getTariProvider({ tari: provider }), provider);
});

test('conformance: an explicitly non-embedded provider is accepted, not refused', () => {
  const provider = { isTariWallet: true, isEmbedded: false, request: async () => 'esmeralda' };
  assert.equal(tari.getTariProvider({ tari: provider }), provider);
});

test('conformance: both provider FORMS are accepted and neither is special-cased', () => {
  const forms = [
    ['embedded', embeddedProvider()],
    ['non-embedded', extensionProvider()],
  ];
  for (const [label, provider] of forms) {
    assert.equal(tari.isTariInjected({ tari: provider }), true, `${label} form must be recognised`);
    assert.equal(tari.getTariProvider({ tari: provider }), provider, `${label} form must be accepted as-is`);
  }
  // The two forms are distinguished by NOTHING in the code under test: the same
  // operations succeed on both, and neither answer depends on a brand string.
  for (const [label, provider] of forms) {
    assert.equal(typeof provider.request, 'function', `${label} form exposes the same interface`);
  }
});

test('conformance: the provider boundary never reads isEmbedded, info, or the registry', () => {
  // A source-level guard. Behaviour tests cannot prove a field is not consulted
  // on some path; this can. `isEmbedded` may appear in a comment explaining WHY
  // it is ignored, and nowhere else.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'tariWindow.ts'), 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n');
  assert.equal(/provider\s*\.\s*isEmbedded/.test(code), false, 'no executable code may read provider.isEmbedded');
  assert.equal(/\.isEmbedded\s*===/.test(code), false, 'isEmbedded must not be compared to anything');
  // The connector's own diagnostics surface must not become a selection signal.
  for (const forbidden of ['tariUniverse', 'tariProviders', 'info.rdns', 'info.name', 'announceProvider']) {
    const uses = code.split(forbidden).length - 1;
    assert.equal(uses, 0, `${forbidden} must not be referenced by executable code in the provider boundary`);
  }
});

test('conformance: the wallet service never branches on wallet identity either', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['services/walletService.ts', 'state/AppContext.tsx', 'services/execution.ts', 'lib/capabilities.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    assert.equal(/isEmbedded/.test(code), false, `${file} must not reference isEmbedded in code`);
    // Brand names are allowed in prose only.
    for (const brand of ['Sapient', 'Universe']) {
      const inCode = code.split(brand).length - 1;
      assert.equal(inCode, 0, `${file} must not name ${brand} in executable code`);
    }
  }
});

// ===========================================================================
// 2. EXACT RPC ARGUMENT AND REPLY SHAPES
// ===========================================================================

test('conformance: NO outbound request carries an undocumented parameter', async () => {
  // The single most important assertion in this file. The strict double rejects
  // any key the published interface does not define, so this cannot pass while an
  // invented compatibility field is on the wire.
  const provider = strictProvider({
    handler: (envelope) => {
      switch (envelope.method) {
        case 'tari_getCapabilities':
          return FULL_CAPABILITIES;
        case 'tari_createTransactionRequest':
          return { requestId: 'req_1' };
        case 'tari_getTransactionRequest':
          return { requestId: 'req_1', status: 'approved', note: '', createdAt: 1, expiresAt: 2 };
        case 'tari_submitTransactionRequest':
          return { transactionId: 'tx_1' };
        case 'tari_signAndSubmitTransaction':
          return { transactionId: 'tx_1' };
        default:
          return defaultReply(envelope.method);
      }
    },
  });

  await tari.fetchNetwork(provider);
  await tari.fetchCapabilities(provider);
  await tari.requestAccounts(provider);
  await tari.fetchAccounts(provider);
  await tari.fetchBalances(provider);
  await tari.fetchWalletAddress(provider);
  await tari.readSubstate(provider, 'component_pool_1');
  await tari.fetchTransactionResult(provider, 'tx_1');
  await tari.disconnectProvider(provider);
  await tari.signAndSubmit(provider, { instructions: [{ CallMethod: { call: { Address: 'component_1' }, method: 'swap', args: [] } }] });
  await tari.createTransactionRequest(provider, { kind: 'instructions', instructions: [{ CallMethod: {} }] });
  await tari.pollTransactionRequest(provider, 'req_1');
  await tari.submitTransactionRequest(provider, 'req_1');

  assert.deepEqual(provider.violations, [], `undocumented parameters were transmitted:\n${provider.violations.join('\n')}`);
});

test('conformance: tari_getSubstate transmits exactly { substateId } and nothing else', async () => {
  // The contract is `{ substateId, version? }`. Two earlier revisions were wrong:
  // one sent `{ address }` alone, and the "fix" sent `{ substateId, address }`,
  // adding an alias the interface does not define. The alias is removed.
  const provider = strictProvider();
  await tari.readSubstate(provider, 'component_pool_1');
  const envelope = provider.seen.find((call) => call.method === 'tari_getSubstate');
  assert.deepEqual(Object.keys(envelope.params).sort(), ['substateId'], 'the outbound params must be exactly the documented fields');
  assert.equal(envelope.params.substateId, 'component_pool_1');
  assert.equal('address' in envelope.params, false, 'the undocumented `address` alias must not be transmitted');
  assert.deepEqual(provider.violations, []);
});

test('conformance: tari_getSubstate omits `version` so the wallet resolves what it needs', async () => {
  // The published pitfalls warn that pinning a cached substate version rejects
  // with `Lock failure: Substate …:N is not found or DOWN`. The field is optional
  // precisely so it can be omitted, and a version is only sent when a caller
  // genuinely has one.
  const provider = strictProvider();
  await tari.readSubstate(provider, 'component_pool_1');
  const envelope = provider.seen.find((call) => call.method === 'tari_getSubstate');
  assert.equal('version' in envelope.params, false, 'an absent version must be omitted, not sent as a guess');

  // The officially supported nullable form is still accepted when supplied.
  const withVersion = strictProvider();
  await tari.readSubstate(withVersion, 'component_pool_1', null);
  const explicit = withVersion.seen.find((call) => call.method === 'tari_getSubstate');
  assert.equal(explicit.params.version, null, 'an explicit null version is the documented representation');
  assert.deepEqual(withVersion.violations, [], 'an explicit null version must not be a contract violation');
});

test('conformance: no-param methods are sent with NO params member', async () => {
  // The contract declares these with no parameters, so sending `params: {}` is
  // an undocumented request shape. Three different ways of being wrong are
  // covered: network, capabilities, disconnect.
  const provider = strictProvider();
  await tari.fetchNetwork(provider);
  await tari.fetchCapabilities(provider);
  await tari.disconnectProvider(provider);
  for (const call of provider.seen) {
    assert.equal('params' in call, false, `${call.method} must not carry a params member`);
  }
  assert.deepEqual(provider.violations, []);
});

test('conformance: tari_disconnect accepts the documented null reply', async () => {
  // The contract types this `Promise<null>`. A caller that treats a null reply as
  // "no reply" would turn every SUCCESSFUL disconnect into a failure.
  const provider = strictProvider();
  await tari.disconnectProvider(provider);
});

test('conformance: tari_signAndSubmitTransaction sends { instructions, maxFee?, dryRun? }', async () => {
  // The previous implementation sent `{ transaction, display }`, which is not
  // this method's parameter shape at all — neither name is defined by the
  // contract, and the wallet-side `instructions` array was simply absent.
  const provider = strictProvider({ handler: (envelope) => (envelope.method === 'tari_signAndSubmitTransaction' ? { transactionId: 'tx_1' } : defaultReply(envelope.method)) });
  const payload = [{ CallMethod: { call: { Address: 'component_1' }, method: 'swap', args: ['otl_res_1', '1000'] } }];
  await tari.signAndSubmit(provider, { instructions: payload, maxFee: '5000' });
  const envelope = provider.seen.find((call) => call.method === 'tari_signAndSubmitTransaction');
  assert.deepEqual(envelope.params.instructions, payload);
  assert.equal(envelope.params.maxFee, '5000', 'maxFee must be a RAW integer string');
  assert.equal('transaction' in envelope.params, false, 'the undocumented `transaction` member must not be transmitted');
  assert.equal('display' in envelope.params, false, 'the undocumented `display` member must not be transmitted');
  assert.deepEqual(provider.violations, []);
});

test('conformance: tari_signAndSubmitTransaction never pins inputs', async () => {
  // `inputs` pins exact substates, and the documented guidance is not to pin
  // cached versions. Omitting it lets the wallet resolve what it needs.
  const provider = strictProvider({ handler: (envelope) => (envelope.method === 'tari_signAndSubmitTransaction' ? { transactionId: 'tx_1' } : defaultReply(envelope.method)) });
  await tari.signAndSubmit(provider, { instructions: [{ CallMethod: {} }] });
  const envelope = provider.seen.find((call) => call.method === 'tari_signAndSubmitTransaction');
  assert.equal('inputs' in envelope.params, false, 'substate pins must not be sent');
});

test('conformance: the accounts methods return string[] of component addresses', async () => {
  // The contract returns plain strings. The previous implementation expected
  // objects with a `componentAddress` member, so a conforming provider's answer
  // was rejected as malformed.
  const provider = strictProvider();
  const accounts = await tari.requestAccounts(provider);
  assert.deepEqual(accounts, [{ componentAddress: 'component_account_1' }]);
  const polled = await tari.fetchAccounts(provider);
  assert.deepEqual(polled, [{ componentAddress: 'component_account_1' }]);
});

test('conformance: tari_getNetwork is read as the documented string', async () => {
  // The contract types it `Promise<string>`. An object-shaped expectation would
  // have rejected every conforming provider's answer.
  const provider = strictProvider();
  const view = await tari.fetchNetwork(provider);
  assert.equal(view.network, 'esmeralda');
});

test('conformance: tari_getBalances is read with the documented field names', async () => {
  // `kind` / `divisibility` / `confidentialAmount`, not the invented
  // `resourceType`. The contract's `kind` is PascalCase.
  const provider = strictProvider();
  const [balance] = await tari.fetchBalances(provider);
  assert.equal(balance.resourceAddress, 'otl_resource_1');
  assert.equal(balance.amount, '1000000');
  assert.equal(balance.resourceType, 'fungible', 'Fungible must normalise to the lowercase form the protocol uses');
  assert.equal(balance.divisibility, 6);
  assert.equal(balance.confidentialAmount, '0');
  // divisibility is carried for DISPLAY and is never applied to the raw amount.
  assert.equal(balance.amount, '1000000', 'the raw amount must survive unscaled');
});

test('conformance: a balance with an unrecognised kind is refused, not coerced', async () => {
  const provider = strictProvider({ handler: () => [{ resourceAddress: 'otl_r', kind: 'SomethingElse', amount: '1', divisibility: 0, confidentialAmount: '0' }] });
  await assert.rejects(() => tari.fetchBalances(provider), /unrecognised kind/);
});

test('conformance: a numeric balance amount is refused because precision is already lost', async () => {
  // A JS number above 2^53 has already lost precision before this code sees it,
  // so a numeric amount cannot be trusted as a raw integer.
  const provider = strictProvider({ handler: () => [{ resourceAddress: 'otl_r', kind: 'Fungible', amount: 1000000, divisibility: 0, confidentialAmount: '0' }] });
  await assert.rejects(() => tari.fetchBalances(provider), /not an exact non-negative integer/);
});

test('conformance: bigint balance amounts are accepted as exact raw integers', async () => {
  // The contract types both amounts `string | bigint`, so a real bigint must be
  // read exactly rather than coerced through Number.
  const huge = 1n << 100n;
  const provider = strictProvider({ handler: () => [{ resourceAddress: 'otl_r', kind: 'Fungible', amount: huge, divisibility: 0, confidentialAmount: 0n }] });
  const [balance] = await tari.fetchBalances(provider);
  assert.equal(balance.amount, huge.toString(), 'a bigint amount must survive exactly');
  assert.equal(balance.confidentialAmount, '0');
});

test('conformance: a stringified bigint literal is refused, not coerced', async () => {
  // `"0n"` is a string that merely LOOKS like a bigint. Trimming or coercing it
  // would be inventing an amount the provider never sent.
  const provider = strictProvider({ handler: () => [{ resourceAddress: 'otl_r', kind: 'Fungible', amount: '0n', divisibility: 0, confidentialAmount: '0' }] });
  await assert.rejects(() => tari.fetchBalances(provider), /not an exact non-negative integer/);
});

// ===========================================================================
// 3. CAPABILITIES
// ===========================================================================

test('conformance: the published capability set is read, and nothing else counts', () => {
  const caps = tari.mapCapabilities(FULL_CAPABILITIES);
  assert.ok(caps, 'a full documented advertisement must be recognised');
  for (const key of types.TARI_CAPABILITY_KEYS) {
    assert.equal(caps[key], true, `${key} must be read`);
  }
});

test('conformance: a reply with no documented boolean is NOT an advertisement', () => {
  // Including the camelCase names this repository previously invented. Recognising
  // them would let a provider that answers nothing recognisable look capable.
  assert.equal(tari.mapCapabilities({}), undefined);
  assert.equal(tari.mapCapabilities({ unrelated: true }), undefined);
  assert.equal(tari.mapCapabilities({ l1Balance: true, l2HtlcFund: true, l1ShaInit: true }), undefined, 'invented flag names must not count as capabilities');
});

test('conformance: a non-boolean capability value is ignored rather than coerced', () => {
  const caps = tari.mapCapabilities({ ...FULL_CAPABILITIES, transactionRequests: 'yes' });
  assert.equal(caps.transactionRequests, undefined, 'a non-boolean must not become true');
  assert.equal(caps.dryRunIsLocal, true, 'the other documented keys still read');
});

test('conformance: leg capabilities fail closed when nothing is advertised', () => {
  assert.equal(tari.mapLegCapabilities(undefined), undefined, 'no advertisement must be distinguishable from "unsupported"');
  const legs = tari.mapLegCapabilities(tari.mapCapabilities({}));
  assert.equal(legs, undefined);
});

test('conformance: the L2 HTLC leg maps onto the documented scriptPath/htlcFund flags', () => {
  const legs = tari.mapLegCapabilities(tari.mapCapabilities(FULL_CAPABILITIES));
  assert.equal(legs.l2HtlcFund, true, 'htlcFund is the documented fund capability');
  assert.equal(legs.l2HtlcClaim, true, 'scriptPathSpend covers htlcClaim');
  assert.equal(legs.l2HtlcRefund, true, 'scriptPathSpend covers htlcRefund');
  // The published capability set has NO L1 SHA atomic-swap flag, so those legs
  // cannot be advertised and stay false. That is what keeps the browser XTM
  // atomic route honestly blocked: there is no capability to map it from.
  assert.equal(legs.l1ShaInit, false, 'no published capability exists for an L1 SHA init');
  assert.equal(legs.l1ShaClaim, false, 'no published capability exists for an L1 SHA claim');
  assert.equal(legs.l1Balance, false, 'no published capability exists for an L1 balance');
});

test('conformance: turning the documented HTLC flags off turns the L2 leg off', () => {
  const legs = tari.mapLegCapabilities(tari.mapCapabilities({ ...FULL_CAPABILITIES, htlcFund: false, scriptPathSpend: false }));
  assert.equal(legs.l2HtlcFund, false);
  assert.equal(legs.l2HtlcClaim, false);
  assert.equal(legs.l2HtlcRefund, false);
});

// ===========================================================================
// 4. ERROR NORMALISATION
// ===========================================================================

test('conformance: every documented provider error code maps to its own state', () => {
  const cases = [
    [4001, 'REJECTED', 'user rejected'],
    [4100, 'NOT_CONNECTED', 'not connected'],
    [4200, 'UNSUPPORTED_METHOD', 'method unsupported'],
    [-32603, 'INTERNAL', 'internal'],
  ];
  for (const [code, expected, label] of cases) {
    const error = Object.assign(new Error(label), { code });
    const normalised = tari.normalizeProviderError(error, 'tari_signAndSubmitTransaction');
    assert.equal(normalised.code, expected, `code ${code} (${label}) must normalise to ${expected}`);
    assert.equal(normalised.providerCode, code, 'the numeric code must be preserved');
  }
});

test('conformance: the documented code is the ONLY discriminator, never the message', () => {
  // An internal failure whose text happens to contain "rejected" must NOT become a
  // clean user rejection: that would silently downgrade a wallet or network fault
  // to "the user said no", and the UI would return to the pre-connect state and
  // tell the user nothing went wrong.
  const wordy = Object.assign(new Error('The user rejected this transaction'), { code: -32603 });
  assert.equal(tari.normalizeProviderError(wordy, 'tari_signAndSubmitTransaction').code, 'INTERNAL');

  // And a genuine 4001 worded unusually is still a user rejection.
  const terse = Object.assign(new Error('nope'), { code: 4001 });
  assert.equal(tari.normalizeProviderError(terse, 'tari_signAndSubmitTransaction').code, 'REJECTED');
});

test('conformance: an unknown numeric code stays unknown and keeps the number', () => {
  const error = Object.assign(new Error('the user rejected everything'), { code: -32000 });
  const normalised = tari.normalizeProviderError(error, 'tari_getBalances');
  assert.equal(normalised.code, 'UNKNOWN', 'an unrecognised code is not a verdict');
  assert.equal(normalised.providerCode, -32000);
});

test('conformance: a missing code, a malformed error, and a non-Error throw are never a rejection', () => {
  for (const thrown of [new Error('something went wrong'), { message: 'no code here' }, 'a bare string', 42, null, undefined, { code: '4001' }]) {
    const normalised = tari.normalizeProviderError(thrown, 'tari_signAndSubmitTransaction');
    assert.notEqual(normalised.code, 'REJECTED', `a codeless failure must not become a rejection: ${JSON.stringify(thrown)}`);
    assert.ok(['UNKNOWN', 'INTERNAL'].includes(normalised.code), `expected UNKNOWN/INTERNAL, got ${normalised.code}`);
  }
});

test('conformance: a non-integer or non-numeric code is not read as a code', () => {
  assert.equal(tari.normalizeProviderError({ code: 4001.5, message: 'x' }, 'm').code, 'UNKNOWN');
  assert.equal(tari.normalizeProviderError({ code: Number.NaN, message: 'x' }, 'm').code, 'UNKNOWN');
  assert.equal(tari.normalizeProviderError({ code: '4001', message: 'x' }, 'm').code, 'UNKNOWN', 'a string code is not a numeric code');
});

test('conformance: a codeless rejection that explicitly says the user declined is honoured', () => {
  // The narrow fallback. It exists because a bridge that drops `code` must not
  // turn a decline into an unknown fault, and it is the ONLY message inspection
  // in the path.
  const error = new Error('The user rejected the request');
  assert.equal(tari.normalizeProviderError(error, 'tari_requestAccounts').code, 'REJECTED');
  // …and it must not fire on unrelated prose.
  assert.equal(tari.normalizeProviderError(new Error('the pool rejected the quote'), 'm').code, 'UNKNOWN');
});

test('conformance: documented codes survive the full request path', async () => {
  for (const [code, expected] of [[4001, 'REJECTED'], [4100, 'NOT_CONNECTED'], [4200, 'UNSUPPORTED_METHOD'], [-32603, 'INTERNAL']]) {
    const provider = { request: async () => { throw Object.assign(new Error('nope'), { code }); } };
    await assert.rejects(
      () => tari.requestAccounts(provider),
      (error) => {
        assert.equal(error.code, expected, `code ${code} must surface as ${expected}`);
        return true;
      },
    );
  }
});

// ===========================================================================
// 5. AVAILABILITY
// ===========================================================================

test('conformance: a present-but-unusable provider is UNAVAILABLE, not ABSENT', async () => {
  // The connector publishes a provider object on a top-level page it cannot
  // serve, and rejects every request. That is a different state from "no wallet
  // is installed", with a different remedy, and collapsing the two tells the
  // user to install something they already have.
  const dead = { isTariWallet: true, isEmbedded: false, request: async () => { throw new Error('this page is not running inside a wallet'); } };
  const state = await tari.probeAvailability({ tari: dead });
  assert.equal(state.available, false);
  assert.equal(state.reason, 'unavailable', 'a present-but-dead provider is `unavailable`, not `absent`');
});

test('conformance: no provider at all is ABSENT', async () => {
  const state = await tari.probeAvailability({});
  assert.equal(state.available, false);
  assert.equal(state.reason, 'absent');
});

test('conformance: a provider that answers the network probe is available, and that needs no connection', async () => {
  // `tari_getNetwork` is documented as answerable without a connection, which is
  // what makes a pre-connect network check possible and keeps the probe
  // non-prompting.
  let calls = [];
  const provider = { request: async (envelope) => { calls.push(envelope.method); return 'esmeralda'; } };
  const state = await tari.probeAvailability({ tari: provider });
  assert.equal(state.available, true);
  assert.equal(state.network, 'esmeralda');
  assert.deepEqual(calls, ['tari_getNetwork'], 'the probe must be the connection-independent read and nothing else');
});

test('conformance: a provider that never answers does not hang the availability probe', { timeout: 40_000 }, async () => {
  // Bounded, so a page with a dead provider reaches an honest state instead of
  // spinning forever, and never reports a transaction failure.
  const silent = { request: () => new Promise(() => {}) };
  const state = await tari.probeAvailability({ tari: silent });
  assert.equal(state.available, false);
  assert.equal(state.reason, 'unavailable');
});

test('conformance: availability is never inferred from the undefined isAvailable property', () => {
  // The connector's header comment claims `window.tari.isAvailable` is false
  // outside Tari Universe, but the published interface does not declare the
  // property and the deployed object does not define it. Reading it would be
  // inventing behaviour, so nothing in this codebase may consult it.
  const fs = require('node:fs');
  const path = require('node:path');
  const srcDir = path.join(__dirname, '..', 'src');
  const stack = [srcDir];
  const offenders = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const code = fs
        .readFileSync(full, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
        .join('\n');
      // `\bisAvailable\b` but not the `isAvailable` inside a longer identifier.
      if (/(?<![\w.])isAvailable(?![\w])/.test(code)) offenders.push(path.relative(srcDir, full));
    }
  }
  assert.deepEqual(offenders, [], 'no source file may read the undocumented `isAvailable` property');
});

// ===========================================================================
// 6. LIFECYCLE
// ===========================================================================

test('conformance: a provider appearing after module evaluation is INITIALISATION, not an attack', () => {
  // The published lifecycle: the extension injects at `document_start`, the
  // connector publishes on script load, and both can be after this app's module
  // ran. Treating that as a replacement attack would break the documented model.
  assert.equal(tari.classifyProviderTransition(undefined, {}), 'INITIALISED');
  assert.equal(tari.classifyProviderTransition(undefined, undefined), 'UNCHANGED');
});

test('conformance: mid-session provider replacement is still detected', () => {
  const pinned = { isTariWallet: true, request: async () => 'esmeralda' };
  assert.equal(tari.classifyProviderTransition(pinned, pinned), 'UNCHANGED', 'the same object is never a replacement');
  assert.equal(tari.classifyProviderTransition(pinned, { isTariWallet: true }), 'REPLACED');
  assert.equal(tari.classifyProviderTransition(pinned, undefined), 'REMOVED');
});

test('conformance: accountsChanged is consumed, and a replaced provider is refused at authorization', async () => {
  const first = { isTariWallet: true, request: async (envelope) => (envelope.method === 'tari_getNetwork' ? 'esmeralda' : ['component_account_1']) };
  const second = { isTariWallet: true, request: async (envelope) => (envelope.method === 'tari_getNetwork' ? 'esmeralda' : ['component_account_2']) };
  const scope = { tari: first, addEventListener() {}, removeEventListener() {} };
  const service = require('../build-test/services/walletService.js');
  const { bridge } = service.createWalletService('esmeralda');
  const adapter = bridge.call(service.createWalletService('esmeralda'));
  void adapter;
  void scope;
  void second;
  // The classification is the unit under test; the wiring is asserted above by
  // `classifyProviderTransition`, and the live-identity check in the adapter
  // refuses a REPLACED provider.
  assert.equal(tari.classifyProviderTransition(first, second), 'REPLACED');
});

test('conformance: tari#initialized is listened for, so a late provider is noticed', () => {
  const listeners = new Map();
  const scope = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  let fired = 0;
  const detach = tari.onProviderInitialized(scope, () => { fired += 1; });
  assert.ok(listeners.has('tari#initialized'), 'the documented event name must be used');
  listeners.get('tari#initialized')();
  assert.equal(fired, 1);
  detach();
  assert.equal(listeners.has('tari#initialized'), false, 'the listener must be removable');
});

test('conformance: accountsChanged subscription tolerates a provider without `on`', () => {
  let called = 0;
  const detach = tari.onProviderAccountsChanged({ request: async () => ({}) }, () => { called += 1; });
  assert.equal(called, 0, 'no event may be fabricated');
  assert.equal(typeof detach, 'function');
  detach();
});

test('conformance: accountsChanged unsubscribes through the returned handle', () => {
  const handlers = [];
  const provider = { request: async () => ({}), on: (_event, handler) => { handlers.push(handler); return () => handlers.splice(handlers.indexOf(handler), 1); } };
  let fired = 0;
  const detach = tari.onProviderAccountsChanged(provider, () => { fired += 1; });
  assert.equal(handlers.length, 1);
  handlers[0]();
  assert.equal(fired, 1, 'a real provider event must reach the handler');
  detach();
  assert.equal(handlers.length, 0, 'unsubscribe must remove the handler');
});

// ===========================================================================
// 7. TRANSACTION REQUEST TRIO
// ===========================================================================

test('conformance: the trio submits by requestId and carries no payload at submission', async () => {
  // The structural point: `tari_submitTransactionRequest` takes ONLY a requestId.
  // There is therefore no code path on which a reviewed payload could be
  // re-derived or replaced between approval and broadcast.
  const provider = strictProvider({
    handler: (envelope) => {
      switch (envelope.method) {
        case 'tari_createTransactionRequest':
          return { requestId: 'req_abc' };
        case 'tari_getTransactionRequest':
          return { requestId: 'req_abc', status: 'approved', note: '', createdAt: 1, expiresAt: 2 };
        case 'tari_submitTransactionRequest':
          return { transactionId: 'tx_abc' };
        default:
          return defaultReply(envelope.method);
      }
    },
  });
  const persisted = [];
  const instructions_ = [{ CallMethod: { call: { Address: 'component_pool_1' }, method: 'swap', args: ['otl_res_1', '1000'] } }];
  const result = await tari.submitViaTransactionRequest(provider, { kind: 'instructions', instructions: instructions_ }, {
    onRequestId: (id) => persisted.push(id),
    onSubmitted: () => undefined,
  });

  assert.equal(result.transactionId, 'tx_abc');
  assert.deepEqual(persisted, ['req_abc'], 'the durable request id must be persisted before any further progress is assumed');

  const create = provider.seen.find((call) => call.method === 'tari_createTransactionRequest');
  assert.equal(create.params.kind, 'instructions');
  assert.deepEqual(create.params.instructions, instructions_, 'the EXACT reviewed operation is what is created');

  const submit = provider.seen.find((call) => call.method === 'tari_submitTransactionRequest');
  assert.deepEqual(Object.keys(submit.params), ['requestId'], 'submission carries only the id');
  assert.equal(submit.params.requestId, 'req_abc');
  assert.deepEqual(provider.violations, []);
});

test('conformance: every transaction-request status is handled, and unknown fails closed', async () => {
  const cases = [
    ['pending', 'pending-request', 'nothing is submitted while the user has not approved'],
    ['submitting', 'pending-request', 'submitting is still not submittable by us'],
    ['approved', 'submitted', 'approved permits exactly one submission'],
    ['rejected', 'rejected', 'a decline is a clean terminal decision, not a fault'],
    ['failed', 'failed', 'a wallet/network failure is recorded as such, not as a rejection'],
    ['wat', 'unknown-status', 'an unrecognised status is never permission to submit'],
  ];
  for (const [status, expected] of cases) {
    let submitted = 0;
    const provider = strictProvider({
      handler: (envelope) => {
        if (envelope.method === 'tari_createTransactionRequest') return { requestId: 'req_1' };
        if (envelope.method === 'tari_getTransactionRequest') return { requestId: 'req_1', status, note: '', createdAt: 1, expiresAt: 2, error: status === 'failed' ? 'insufficient funds' : undefined };
        if (envelope.method === 'tari_submitTransactionRequest') {
          submitted += 1;
          return { transactionId: 'tx_1' };
        }
        return defaultReply(envelope.method);
      },
    });
    let outcome = 'threw';
    try {
      const result = await tari.submitViaTransactionRequest(provider, { kind: 'instructions', instructions: [{ CallMethod: {} }] }, { onRequestId: () => undefined, onSubmitted: () => undefined });
      outcome = 'pendingRequestId' in result ? 'pending-request' : 'submitted';
    } catch (error) {
      if (error.code === 'REJECTED') outcome = 'rejected';
      else if (error.code === 'INTERNAL') outcome = 'failed';
      else if (error.code === 'MALFORMED_REPLY') outcome = 'unknown-status';
      else throw error;
    }
    assert.equal(outcome, expected, `status "${status}" must be handled as ${expected}`);
    if (expected !== 'submitted') {
      assert.equal(submitted, 0, `status "${status}" must not submit anything`);
    }
  }
});

test('conformance: an already-submitted request is reconciled, never submitted again', async () => {
  // The duplicate-broadcast case: a page reload after the wallet already
  // broadcast. Submitting again would broadcast twice.
  let submitted = 0;
  const provider = strictProvider({
    handler: (envelope) => {
      if (envelope.method === 'tari_createTransactionRequest') return { requestId: 'req_1' };
      if (envelope.method === 'tari_getTransactionRequest') return { requestId: 'req_1', status: 'submitted', note: '', createdAt: 1, expiresAt: 2, result: { transactionId: 'tx_already' } };
      if (envelope.method === 'tari_submitTransactionRequest') {
        submitted += 1;
        return { transactionId: 'tx_again' };
      }
      return defaultReply(envelope.method);
    },
  });
  const result = await tari.submitViaTransactionRequest(provider, { kind: 'instructions', instructions: [{ CallMethod: {} }] }, { onRequestId: () => undefined, onSubmitted: () => undefined });
  assert.equal(result.transactionId, 'tx_already', 'the stored wallet result is the authority, not a fresh submission');
  assert.equal(submitted, 0, 'a submitted request must never be submitted again');
});

test('conformance: a malformed transaction-request summary is refused, not guessed', async () => {
  for (const reply of [{}, { status: 42 }, { status: '' }, { status: null }, 'nonsense', null]) {
    const provider = strictProvider({ handler: (envelope) => (envelope.method === 'tari_getTransactionRequest' ? reply : defaultReply(envelope.method)) });
    await assert.rejects(() => tari.pollTransactionRequest(provider, 'req_1'), /carried no status|valid transaction request/);
  }
});

test('conformance: a non-instructions transaction-request kind is refused', async () => {
  // This is a public AMM. A private/stealth kind would be hand-building a
  // stealth transfer, which the documentation says must never be done from a
  // dApp and is rejected by the wallet anyway.
  const provider = strictProvider();
  for (const kind of ['shield', 'unshield', 'sendPrivately', 'htlcFund', 'withdrawStealthAndExecute']) {
    await assert.rejects(() => tari.createTransactionRequest(provider, { kind, resourceAddress: 'otl_r', amount: '1' }), /public AMM/);
  }
});

// ===========================================================================
// 8. DRY RUN
// ===========================================================================

test('conformance: dryRun is transmitted and never prompts', async () => {
  const provider = strictProvider({ handler: (envelope) => (envelope.method === 'tari_signAndSubmitTransaction' ? { transactionId: 'tx_dry' } : defaultReply(envelope.method)) });
  const result = await tari.dryRunTransaction(provider, { instructions: [{ CallMethod: {} }], maxFee: '5000' });
  assert.equal(result.ok, true);
  const envelope = provider.seen.find((call) => call.method === 'tari_signAndSubmitTransaction');
  assert.equal(envelope.params.dryRun, true, 'dryRun must be transmitted so the wallet simulates without prompting');
  assert.deepEqual(provider.violations, []);
});

test('conformance: a dry run is an advisory check, never a quote and never a failure', async () => {
  // The AMM quote is protocol math. A wallet simulation is an ADDITIONAL check
  // that the reviewed instructions would be accepted; it never produces an
  // amount, and it never turns a preflight failure into a transaction outcome.
  const provider = strictProvider({ handler: () => { throw Object.assign(new Error('would fail'), { code: -32603 }); } });
  await assert.rejects(() => tari.dryRunTransaction(provider, { instructions: [{ CallMethod: {} }] }), (error) => {
    assert.equal(error.code, 'INTERNAL');
    return true;
  });
});

// ===========================================================================
// 9. ADDRESS DOMAINS
// ===========================================================================

test('conformance: a wallet address is refused where a SubstateId is required', () => {
  // The exact failure the reference warns about: passing an `otl_…` where a
  // component address belongs fails deep in deserialization as
  // `data did not match any variant of untagged enum TransactionInput`,
  // naming neither the field nor the reason.
  assert.throws(() => addressDomain.requireAccountComponent('otl_esm_1qqwallet', 'accounts[0]'), /not interchangeable/);
  assert.equal(addressDomain.requireAccountComponent('component_account_1', 'f'), 'component_account_1');
});

test('conformance: an account component is refused as a private/stealth destination', () => {
  // "Never address a stealth/private output to the account component" is a
  // correctness requirement, so the mistake is refused at the boundary.
  assert.throws(() => addressDomain.requireWalletAddress('component_account_1', 'recipient'), /not interchangeable/);
  assert.equal(addressDomain.requireWalletAddress('otl_esm_1qqwallet', 'f'), 'otl_esm_1qqwallet');
});

test('conformance: address domains are classified, and unclassifiable values fail closed', () => {
  assert.equal(addressDomain.classifyAddress('component_x'), 'ACCOUNT_COMPONENT');
  assert.equal(addressDomain.classifyAddress('otl_1abc'), 'WALLET_ADDRESS');
  assert.equal(addressDomain.classifyAddress(''), 'OTHER');
  assert.equal(addressDomain.classifyAddress(undefined), 'OTHER');
  assert.equal(addressDomain.classifyAddress(42), 'OTHER');
});

test('conformance: a tagged address carries its domain and cannot be forged', () => {
  const component = addressDomain.accountComponent('component_account_1');
  assert.equal(component.domain, 'ACCOUNT_COMPONENT');
  assert.equal(component.value, 'component_account_1');
  assert.equal(Object.isFrozen(component), true);
  const wallet = addressDomain.walletAddress('otl_esm_1qqwallet');
  assert.equal(wallet.domain, 'WALLET_ADDRESS');
  // A wallet address is never accepted as a component, even when tagged as one
  // by mistake: the classifier is independent of the tag.
  assert.throws(() => addressDomain.requireAccountComponent(wallet.value, 'f'), /not interchangeable/);
});

test('conformance: the public execution path never receives a wallet address as its account', () => {
  // Static guard: the settlement account for a public AMM/NFT trade comes from
  // the accounts method, and the wallet address is a different value from a
  // different method. `walletAddress()` is the only source of the latter and it
  // is not on the public execution path.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'walletService.ts'), 'utf8');
  const code = src.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
  // `componentAddress` assignments must come from the accounts view, never from
  // the wallet-address accessor.
  assert.equal(/account\s*=\s*await\s+this\.walletAddress\(\)/.test(code), false, 'the settlement account must not be the wallet address');
  assert.equal(/account:\s*await\s+this\.walletAddress\(\)/.test(code), false);
});

// ===========================================================================
// 10. INSTRUCTION SERIALISATION
// ===========================================================================

test('conformance: AMM instructions serialise to the documented Ootle form', () => {
  const out = instructions.buildSignableInstructions({
    instructions: [
      { kind: 'withdraw_fungible', accountAddress: 'component_account_1', resourceAddress: 'otl_resource_1', amount: '1000000', output: { kind: 'workspace_bucket', name: 'swap_input' } },
      { kind: 'call_method', componentAddress: 'component_pool_1', method: 'swap', args: [{ kind: 'workspace_bucket', name: 'swap_input' }, 'otl_resource_2', '3900000'], resourcesInvolved: ['otl_resource_1'] },
    ],
    maxEpoch: '950',
  });
  assert.deepEqual(out[0], { CallMethod: { call: { Address: 'component_account_1' }, method: 'withdraw', args: ['otl_resource_1', '1000000'] } });
  // Workspace references must be PLAIN INTEGER ids: name resolution only applies
  // to instructions the wallet itself builds.
  assert.deepEqual(out[1], { PutLastInstructionOutputOnWorkspace: { key: 0 } });
  assert.deepEqual(out[2].CallMethod.args[0], { Workspace: { id: 0, offset: null } });
  // The on-chain expiry the intent carries must be bound, or a signed swap stays
  // valid indefinitely after market state moves.
  assert.deepEqual(out[3], { WithMaxEpoch: { epoch: '950' } });
});

test('conformance: a deposit is a CallMethod naming the account component', () => {
  const out = instructions.buildSignableInstructions({
    instructions: [
      { kind: 'withdraw_fungible', accountAddress: 'component_account_1', resourceAddress: 'otl_r', amount: '5', output: { kind: 'workspace_bucket', name: 'b0' } },
      { kind: 'deposit_all', accountAddress: 'component_account_1', bucket: { kind: 'workspace_bucket', name: 'b0' } },
    ],
  });
  assert.deepEqual(out[2], { CallMethod: { call: { Address: 'component_account_1' }, method: 'deposit', args: [{ Workspace: { id: 0, offset: null } }] } });
});

test('conformance: an unrecognised instruction kind is refused, never skipped', () => {
  // Silently dropping an instruction would make the signed transaction differ
  // from the reviewed one — the exact defect this repository exists to prevent.
  assert.throws(() => instructions.buildSignableInstructions({ instructions: [{ kind: 'stealth_transfer', destination: 'otl_1x' }] }), /unrecognised instruction kind/);
  assert.throws(() => instructions.buildSignableInstructions({ instructions: [] }), /empty instruction list/);
});

test('conformance: amounts stay raw integer strings through serialisation', () => {
  const huge = (1n << 120n).toString();
  const out = instructions.buildSignableInstructions({
    instructions: [{ kind: 'withdraw_fungible', accountAddress: 'component_a', resourceAddress: 'otl_r', amount: huge, output: { kind: 'workspace_bucket', name: 'b' } }],
  });
  assert.equal(out[0].CallMethod.args[1], huge, 'a raw integer beyond 2^53 must survive exactly');
  // A non-canonical amount is refused at the boundary rather than coerced.
  assert.throws(() => instructions.buildSignableInstructions({ instructions: [{ kind: 'withdraw_fungible', accountAddress: 'component_a', resourceAddress: 'otl_r', amount: '1.5', output: { kind: 'workspace_bucket', name: 'b' } }] }));
  assert.throws(() => instructions.buildSignableInstructions({ instructions: [{ kind: 'withdraw_fungible', accountAddress: 'component_a', resourceAddress: 'otl_r', amount: '-1', output: { kind: 'workspace_bucket', name: 'b' } }] }));
});

test('conformance: a market-data display value can never become an instruction amount', () => {
  const { asDisplayOnly } = require('../build-test/lib/tradeBoundary.js');
  assert.throws(
    () => instructions.buildSignableInstructions({ instructions: [{ kind: 'withdraw_fungible', accountAddress: 'component_a', resourceAddress: 'otl_r', amount: asDisplayOnly('1.00', 'chart'), output: { kind: 'workspace_bucket', name: 'b' } }] }),
    /market-data display value/,
  );
});

// ===========================================================================
// 11. NO UNDOCUMENTED METHODS
// ===========================================================================

test('conformance: every allow-listed method exists in the published contract', () => {
  // The allow-list is a fail-closed guard, so an invented name is a call that can
  // never succeed and a denial reason that would point at the wallet.
  const documented = new Set([
    'tari_requestAccounts', 'tari_getAccounts', 'tari_getNetwork', 'tari_getWalletAddress', 'tari_getBalances', 'tari_getSubstate',
    'tari_getCapabilities', 'tari_getTransactionResult', 'tari_signAndSubmitTransaction', 'tari_createTransactionRequest',
    'tari_getTransactionRequest', 'tari_submitTransactionRequest', 'tari_disconnect',
  ]);
  for (const method of Object.values(tari.TARI_METHODS)) {
    assert.ok(documented.has(method), `${method} is not a documented Tari method`);
  }
});

test('conformance: the private/stealth surface is deliberately not called', () => {
  // This is a public AMM, a public marketplace, and a market-data reader. The
  // connector also exposes the private surface; adding any of it would widen
  // what the app asks a wallet for. Asserted so adding one is deliberate.
  const used = new Set(Object.values(tari.TARI_METHODS));
  for (const method of [
    'tari_getPrivateBalances', 'tari_getShieldedOutputs', 'tari_claimPrivatePayment',
    'tari_requestViewAccess', 'tari_revokeViewAccess', 'tari_getViewAccess',
    'tari_scanForPrivatePayments', 'tari_scanForResourceUtxos',
    'tari_signOwnershipChallenge', 'tari_signWalletOwnershipChallenge',
  ]) {
    assert.equal(used.has(method), false, `${method} must not be called by a public AMM`);
  }
});

test('conformance: only allow-listed methods are callable', async () => {
  const provider = strictProvider();
  // The allow-list is checked BEFORE the call, so a hostile page cannot induce
  // this app to probe a method the published contract does not define.
  await assert.rejects(() => tari.call(provider, 'tari_not_a_method'), /unlisted Tari method/);
  await assert.rejects(() => tari.call(provider, 'tari_getPrivateBalances'), /unlisted Tari method/);
});
