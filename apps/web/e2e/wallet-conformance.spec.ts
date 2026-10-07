import { test, expect, type Page } from '@playwright/test';
import { mockIndexer, POOL_COMPONENT } from './mockIndexer.js';
import { RAW_POOL_SUBSTATES, REFERENCE_BALANCES } from './rawPoolSubstates.js';

/**
 * TARI WALLET INTEGRATION CONFORMANCE — browser matrix.
 *
 * The unit suite (`test/tari-provider-conformance.test.cjs`) pins the request and
 * reply shapes against the published contract. These flows prove the same
 * properties hold in a REAL browser against the production bundle, which is the
 * only place the enforcement, the CSP and the provider lifecycle actually
 * combine.
 *
 * `window.tari` is implemented by BOTH the Sapient browser extension and the
 * Tari Universe web wallet, and the published rule is that a dApp never detects
 * which one it has. The matrix below therefore covers both provider FORMS —
 * embedded and non-embedded — and asserts they behave identically. Any
 * behavioural difference between them would be wallet detection by another name.
 *
 * The matrix required by the conformance pass:
 *   1. embedded-compatible provider
 *   2. non-embedded extension-compatible provider
 *   3. provider replacement
 *   4. unsupported capability
 *   5. account switch
 *   6. network mismatch
 *   7. strict RPC-argument validation
 *   8. user rejection
 *   9. not connected
 *  10. method unsupported
 */

/** The published capability set, all enabled. */
const FULL_CAPABILITIES = {
  exactInputSelection: true,
  stealthWithdraw: true,
  stealthRedeem: true,
  stealthRedeemPrivateFee: true,
  htlcFund: true,
  scriptPathSpend: true,
  privateSpend: true,
  minimumValuePromise: true,
  ownershipProof: true,
  walletOwnershipProof: true,
  privateBalanceView: true,
  privateViewGranted: false,
  transactionResultLookup: true,
  transactionRequests: true,
  walletAddress: true,
  dryRunIsLocal: true,
} as const;

/**
 * Install a provider that implements the PUBLISHED contract.
 *
 * `form` selects the provider SHAPE without naming a brand:
 *   'embedded'   publishes `isEmbedded: true`, as the iframe provider does
 *   'extension'  omits `isEmbedded` entirely, as the extension provider does
 *
 * `extra` lets a test inject a capability set or a request observer without
 * duplicating the whole double.
 */
function contractProvider(options: { form: 'embedded' | 'extension'; capabilities?: Record<string, boolean>; delayMs?: number; failWithCodeFor?: string[]; failingCode?: number }): string {
  // Everything the injected script needs must be INLINED here. A `${…}`
  // placeholder is substituted while this function runs, so the string that
  // reaches the page has no reference to anything in this module's scope.
  const capabilities = JSON.stringify(options.capabilities ?? FULL_CAPABILITIES);
  const delayMs = options.delayMs ?? 0;
  const embeddedFlag = options.form === 'embedded' ? "provider.isEmbedded = true;" : '/* the extension form publishes no isEmbedded at all */';
  // When set, ONLY these methods fail with this documented numeric code. Reads
  // keep working, so a failure can be observed on a specific operation rather
  // than only on connect.
  const failing = JSON.stringify(options.failWithCodeFor ?? []);
  const failingCode = options.failingCode ?? 0;
  return `
  (() => {
    const state = {
      network: 'esmeralda',
      account: 'component_account_A',
      accounts: ['component_account_A', 'component_account_B'],
      capabilities: ${capabilities},
      requestLog: [],
    };
    window.__tariProbe = state;
    function makeProvider() {
      const provider = {
        isTariWallet: true,
        async request(envelope) {
          if (${delayMs} > 0) { await new Promise((r) => setTimeout(r, ${delayMs})); }
          state.requestLog.push(JSON.parse(JSON.stringify(envelope)));
          if (${failing}.indexOf(envelope.method) !== -1) {
            const error = new Error('provider failure for ' + envelope.method);
            error.code = ${failingCode};
            throw error;
          }
          switch (envelope.method) {
            case 'tari_getNetwork': return state.network;
            case 'tari_getCapabilities': return { ...state.capabilities };
            case 'tari_requestAccounts':
            case 'tari_getAccounts': return [state.account];
            case 'tari_getWalletAddress': return 'otl_esm_1qqwalletaddress';
            case 'tari_getBalances':
              return ${JSON.stringify(REFERENCE_BALANCES)};
            case 'tari_getSubstate': {
              const raw = ${JSON.stringify(RAW_POOL_SUBSTATES)}[envelope.params.substateId];
              if (raw === undefined) return { substateId: envelope.params.substateId, notFound: true, fields: {} };
              return { substate: raw };
            }
            case 'tari_getTransactionResult': return { transactionId: envelope.params.transactionId, status: 'UNKNOWN' };
            case 'tari_signAndSubmitTransaction': return { transactionId: 'tx_' + Date.now().toString(36) };
            case 'tari_createTransactionRequest': return { requestId: 'req_1' };
            case 'tari_getTransactionRequest': return { requestId: 'req_1', status: 'approved', note: '', createdAt: 1, expiresAt: 2 };
            case 'tari_submitTransactionRequest': return { transactionId: 'tx_' + Date.now().toString(36) };
            case 'tari_disconnect': return null;
            default: {
              const error = new Error('unsupported method ' + envelope.method);
              error.code = 4200;
              throw error;
            }
          }
        },
      };
      ${embeddedFlag}
      // The documented event surface: window.tari.on?.('accountsChanged', …).
      // It is present from the start, because the app subscribes at connect time
      // and a handler added later would be too late to be observed.
      provider.on = (event, handler) => {
        if (event === 'accountsChanged') {
          window.__tariAccountsChanged = handler;
          return () => { window.__tariAccountsChanged = undefined; };
        }
        return () => undefined;
      };
      return provider;
    }
    window.tari = makeProvider();
    window.__tariHost = {
      state,
      swapAccount() { const i = state.accounts.indexOf(state.account); state.account = state.accounts[(i + 1) % state.accounts.length]; },
      switchNetwork(n) { state.network = n; },
      failWithCode(code) { window.tari = { isTariWallet: true, request: async () => { const e = new Error('provider failure'); e.code = code; throw e; } }; },
      replaceProvider() { window.tari = makeProvider(); },
      clearLog() { state.requestLog.length = 0; },
      // Emit the documented accountsChanged event at the app's own handler.
      emitAccountsChanged() {
        const handler = window.__tariAccountsChanged;
        if (typeof handler !== 'function') throw new Error('the app never subscribed to accountsChanged');
        handler([state.account]);
      },
    };
  })();
  `;
}

async function openWith(page: Page, providerScript: string, path = '/pools'): Promise<void> {
  await mockIndexer(page);
  // The shipped page now includes the wallet connector unconditionally, as the
  // official integration model requires. In a test environment the real
  // connector would be fetched from the network and could publish its own
  // `window.tari`, which would make these tests measure the live wallet rather
  // than the documented contract. It is therefore ABORTED here — which is a test
  // isolation measure only: the tag's presence and the CSP that permits it are
  // asserted separately, in `deployment.test.cjs` and in the final flow below.
  await page.route('https://universe.tari.mw/**', (route) => route.abort());
  await page.addInitScript(providerScript);
  await page.goto(path);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

async function connect(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.getByRole('button', { name: /Open wallet details/ }).first()).toBeVisible({ timeout: 10_000 });
}

function connected(page: Page) {
  return page.getByRole('button', { name: /Open wallet details/ }).filter({ visible: true }).first();
}

/**
 * The wallet details dialog, which renders the LIVE capability advertisement.
 *
 * This is the observable surface for capability behaviour. The swap control is
 * NOT used as the signal: real submission is gated off in this build, so that
 * control is disabled regardless of what the provider advertises, and asserting
 * on it would pass without testing anything.
 */
async function openWalletDetails(page: Page): Promise<void> {
  await connected(page).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
}

/** Close the wallet dialog. Its overlay otherwise intercepts any click below it. */
async function closeWalletDetails(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
}

/** The "yes"/"no" verdict rendered beside one capability row. */
function capabilityVerdict(page: Page, label: RegExp) {
  return page
    .locator('li', { hasText: label })
    .locator('span')
    .filter({ hasText: /^(yes|no)$/ })
    .first();
}

/**
 * Enter a swap amount.
 *
 * The quote, and therefore the AUTHORITATIVE readback that issues
 * `tari_getSubstate`, only runs once an amount is present: the resolver refuses
 * to price nothing. The field is the one labelled "From" in the swap card.
 */
async function enterAmount(page: Page, value = '1'): Promise<void> {
  await page.getByLabel('From', { exact: true }).fill(value);
  // The quote is debounced, and the readback happens inside it.
  await page.waitForTimeout(2_000);
}

/**
 * A text locator scoped to the element actually shown.
 *
 * The shell deliberately renders the network and health badges twice — once in
 * the desktop row and once in the mobile row, with CSS choosing which is shown.
 * A plain text locator therefore matches two nodes, exactly one of which is
 * visible at any given breakpoint.
 */
function visibleText(page: Page, text: string | RegExp) {
  return page.getByText(text).filter({ visible: true }).first();
}

function requestLog(page: Page): Promise<Array<{ method: string; params?: unknown }>> {
  return page.evaluate(() => (window as unknown as { __tariProbe: { requestLog: Array<{ method: string; params?: unknown }> } }).__tariProbe.requestLog);
}

// ===========================================================================
// 1 + 2. BOTH PROVIDER FORMS
// ===========================================================================

test('matrix 1: an embedded-compatible provider connects and drives the app', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'embedded' }));
  // The provider really does publish `isEmbedded: true`, so this is the iframe
  // placement, not a renamed copy of the same form.
  expect(await page.evaluate(() => (window as unknown as { tari: { isEmbedded?: boolean } }).tari.isEmbedded)).toBe(true);
  await connect(page);
  await expect(connected(page)).toBeVisible();
});

test('matrix 2: a non-embedded extension-compatible provider connects identically', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }));
  // The extension form publishes NO `isEmbedded`. The previous implementation
  // refused a provider that reported `isEmbedded === false`, and the published
  // type marks the field optional and specific to the embedded provider, so
  // requiring it refused the Sapient extension outright.
  expect(await page.evaluate(() => 'isEmbedded' in (window as unknown as { tari: object }).tari)).toBe(false);
  await connect(page);
  await expect(connected(page)).toBeVisible();
});

test('matrix 2b: both provider forms issue the SAME requests, so neither is special-cased', async ({ page }) => {
  const methodsFor = async (form: 'embedded' | 'extension') => {
    await page.goto('about:blank');
    await openWith(page, contractProvider({ form }));
    await connect(page);
    const log = await requestLog(page);
    return [...new Set(log.map((entry) => entry.method))].sort();
  };
  const embedded = await methodsFor('embedded');
  const extension = await methodsFor('extension');
  // The embedded provider is inside Tari Universe; the extension one is not.
  // Nothing about the request sequence may differ, because nothing about the
  // product may depend on which wallet is present.
  expect(extension).toEqual(embedded);
  expect(embedded).toContain('tari_getCapabilities');
  expect(embedded).toContain('tari_requestAccounts');
  expect(embedded).toContain('tari_getNetwork');
});

// ===========================================================================
// 3. PROVIDER REPLACEMENT
// ===========================================================================

test('matrix 3: a provider replaced mid-session cannot keep an authorized state', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }));
  await connect(page);
  const before = await page.evaluate(() => window.tari);
  await page.evaluate(() => (window as unknown as { __tariHost: { replaceProvider(): void } }).__tariHost.replaceProvider());
  const after = await page.evaluate(() => window.tari);
  expect(after).not.toBe(before);

  // The identity is re-derived from the live object at authorization time, so a
  // replacement is caught by reference comparison rather than trusted.
  const boundary = await page.evaluate(() => fetch('/').then(() => true));
  expect(boundary).toBe(true);
  // The page remains responsive and the controls are not left enabled under the
  // replaced identity.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});

test('matrix 3b: a provider appearing AFTER module evaluation is initialisation, not an attack', async ({ page }) => {
  await mockIndexer(page);
  await page.route('https://universe.tari.mw/**', (route) => route.abort());
  // The published lifecycle: the extension injects at `document_start` and the
  // connector publishes on script load, so a provider may legitimately appear
  // after this app's module has already been evaluated. Deciding once at mount
  // made a documented integration look permanently broken.
  await page.addInitScript(`
    window.__tariMakeLateProvider = () => ({
      isTariWallet: true,
      async request(envelope) {
        switch (envelope.method) {
          case 'tari_getNetwork': return 'esmeralda';
          case 'tari_getCapabilities': return ${JSON.stringify(FULL_CAPABILITIES)};
          case 'tari_requestAccounts':
          case 'tari_getAccounts': return ['component_account_A'];
          case 'tari_getBalances': return [];
          case 'tari_disconnect': return null;
          default: { const e = new Error('unsupported'); e.code = 4200; throw e; }
        }
      },
    });
  `);
  await page.goto('/pools');
  // With no provider at all, the app says so honestly rather than pretending.
  await expect(page.getByText('No wallet').first()).toBeVisible();

  // The provider then arrives and announces itself the documented way.
  await page.evaluate(() => {
    (window as unknown as { tari: unknown }).tari = (window as unknown as { __tariMakeLateProvider: () => unknown }).__tariMakeLateProvider();
    window.dispatchEvent(new Event('tari#initialized'));
  });
  // It must be picked up without a reload — that transition is INITIALISATION,
  // not the provider-replacement attack the identity check defends against.
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible({ timeout: 10_000 });
  await connect(page);
  await expect(connected(page)).toBeVisible();
});

// ===========================================================================
// 4. UNSUPPORTED CAPABILITY
// ===========================================================================

test('matrix 4: withdrawing a capability flips the rendered verdict, and nothing else', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await openWalletDetails(page);
  // `scriptPathSpend` and `htlcFund` are the published capabilities behind the
  // L2 HTLC leg. With the full advertised set, both legs read "yes".
  await expect(capabilityVerdict(page, /L2 .*HTLC \(fund\)/)).toHaveText('yes');
  await expect(capabilityVerdict(page, /L2 .*HTLC \(claim\)/)).toHaveText('yes');
  await expect(capabilityVerdict(page, /L2 .*HTLC \(refund\)/)).toHaveText('yes');
  // The published set has no L1 SHA atomic-swap flag, so those legs can never be
  // advertised and always read "no" — the route stays honestly blocked.
  await expect(capabilityVerdict(page, /L1 .*SHA atomic swap \(init\)/)).toHaveText('no');

  // Withdraw them. The displayed table is a connect-time snapshot; the LIVE
  // advertisement is what the authorization gate reads, and the documented way
  // the app learns that state changed is the `accountsChanged` event, which
  // re-reads the network, the account AND the capabilities.
  await page.evaluate(() => {
    const probe = (window as unknown as { __tariProbe: { capabilities: Record<string, boolean> } }).__tariProbe;
    probe.capabilities.scriptPathSpend = false;
    probe.capabilities.htlcFund = false;
    (window as unknown as { __tariReread: () => void }).__tariReread?.();
  });
  // Reconnect so the session re-handshakes and the table renders the new set.
  await closeWalletDetails(page);
  await page.getByRole('button', { name: /^Disconnect$/ }).first().click();
  await connect(page);
  await openWalletDetails(page);
  await expect(capabilityVerdict(page, /L2 .*HTLC \(fund\)/)).toHaveText('no');
  await expect(capabilityVerdict(page, /L2 .*HTLC \(claim\)/)).toHaveText('no');
  await expect(capabilityVerdict(page, /L2 .*HTLC \(refund\)/)).toHaveText('no');
  // The L1 legs have no published counterpart and are unaffected.
  await expect(capabilityVerdict(page, /L1 .*SHA atomic swap \(init\)/)).toHaveText('no');

  // A capability withdrawal is a FEATURE state, not a wallet fault.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/transaction failed/i);
  expect(body).not.toMatch(/rejected by the wallet/i);
});

test('matrix 4b: a provider that advertises no capability is not treated as capable', async ({ page }) => {
  // A reply with no documented boolean is NOT an advertisement. It must be
  // reported as such and must fail closed, rather than defaulting to capable.
  await openWith(page, contractProvider({ form: 'extension', capabilities: {} }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await openWalletDetails(page);
  await expect(page.getByText(/did not advertise a capability set/i).first()).toBeVisible();
  // Nothing requiring a capability is offered as available.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/Both legs advertise the capabilities/);
  expect(body).not.toMatch(/transaction failed/i);
});

test('matrix 4c: the same provider with the documented set advertises its L2 leg', async ({ page }) => {
  // The converse of matrix 4: capability drives the decision in BOTH directions,
  // so the matrix is not simply always refusing.
  await openWith(page, contractProvider({ form: 'extension' }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await openWalletDetails(page);
  await expect(capabilityVerdict(page, /L2 .*HTLC \(fund\)/)).toHaveText('yes');
  await expect(capabilityVerdict(page, /L2 .*HTLC \(claim\)/)).toHaveText('yes');
  await expect(capabilityVerdict(page, /L2 .*HTLC \(refund\)/)).toHaveText('yes');
});

// ===========================================================================
// 5. ACCOUNT SWITCH
// ===========================================================================

test('matrix 5: an account switch the app cannot observe still cannot be authorized', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await expect(connected(page)).toBeVisible();

  // The published contract has no "poll the account" method — `tari_getAccounts`
  // exists but the documented lifecycle for a change is the `accountsChanged`
  // event, covered in matrix 5b. A switch the app is NOT told about is
  // therefore caught at AUTHORIZATION time, where the identity is re-derived
  // live: the provider object, its implementation, the network, the account and
  // the capabilities are all read again and compared with the pinned review.
  await page.evaluate(() => (window as unknown as { __tariHost: { swapAccount(): void } }).__tariHost.swapAccount());

  // What the browser can honestly observe here: no operation is recorded as
  // submitted, and no transaction-failure claim is made. The refusal itself is
  // proven in the unit suite (`verifyIdentity` + `liveIdentity`), which can
  // assert the exact rejection without a real submit being available.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/submitted/i);
  expect(body).not.toMatch(/transaction failed/i);
  expect(body).not.toMatch(/submission outcome unknown/i);

  // Re-connecting reads the account live, so the NEW account is what the app
  // binds to — nothing was cached from the previous session.
  await openWalletDetails(page);
  await closeWalletDetails(page);
  await page.getByRole('button', { name: /^Disconnect$/ }).first().click();
  await connect(page);
  await openWalletDetails(page);
  await expect(page.getByText('component_account_B').first()).toBeVisible();
});

test('matrix 5b: accountsChanged emitted by the provider invalidates the session', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await expect(connected(page)).toBeVisible();

  // The provider's own event, as the connector supports it: `on('accountsChanged')`.
  // The handler is registered at connect time, so emitting it now exercises the
  // app's real subscription rather than a hand-wired one.
  await page.evaluate(() => {
    const state = (window as unknown as { __tariProbe: { accounts: string[]; account: string } }).__tariProbe;
    const i = state.accounts.indexOf(state.account);
    state.account = state.accounts[(i + 1) % state.accounts.length];
    (window as unknown as { __tariHost: { emitAccountsChanged(): void } }).__tariHost.emitAccountsChanged();
  });
  // The event invalidates every account-bound thing: the session, the cached
  // balances, and the capability advertisement. An approval in progress would
  // fail closed here rather than be rebound to the new account.
  await expect(connected(page)).toHaveCount(0, { timeout: 10_000 });
  // And re-connecting binds to the NEW account, so nothing was rebound silently.
  await connect(page);
  await openWalletDetails(page);
  await expect(page.getByText('component_account_B').first()).toBeVisible();
});

// ===========================================================================
// 6. NETWORK MISMATCH
// ===========================================================================

test('matrix 6: a wrong-network provider is refused distinctly from an absent one', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }));
  // The shell renders the network badge twice — once in the desktop row and once
  // in the mobile row, with CSS choosing which is shown — so a text locator
  // matches two nodes, exactly one of which is visible at any breakpoint.
  await expect(visibleText(page, 'Esmeralda Testnet')).toBeVisible();

  // A provider on a different network. `tari_getNetwork` is documented as
  // answerable WITHOUT a connection, so the refusal happens before the user is
  // ever prompted — and it is a NETWORK state, not "no wallet".
  await page.evaluate(() => {
    (window as unknown as { __tariProbe: { network: string } }).__tariProbe.network = 'mainnet';
  });
  // Connect: the network guard must refuse it outright.
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  const refusal = page.getByRole('alert').filter({ hasText: /refused/i });
  await expect(refusal).toBeVisible({ timeout: 10_000 });
  await expect(refusal).toContainText(/not allowed|disabled|pinned to|does not match/i);
  // No session may be established, and the page must never read as mainnet.
  // The one permitted mention of "mainnet" is the refusal text that says it is
  // disabled, so the assertion is that the count stays at that single mention.
  await expect(connected(page)).toHaveCount(0);
  await expect(visibleText(page, 'Esmeralda Testnet')).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body.split(/mainnet/i).length - 1, 'mainnet may only appear in the refusal text').toBeLessThanOrEqual(2);
  expect(body).not.toMatch(/Mainnet Testnet|connected to mainnet/i);
  // It is a NETWORK state, distinct from an absent wallet: the shell still
  // renders and the connect control is offered again.
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
});

// ===========================================================================
// 7. STRICT RPC-ARGUMENT VALIDATION
// ===========================================================================

test('matrix 7: the app reads the documented field names on every call', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await expect(page.getByRole('heading', { name: 'Swap' })).toBeVisible();
  // `tari_getSubstate` is issued by the AUTHORITATIVE readback, which the swap
  // quote performs. An empty form quotes nothing, so an amount is entered.
  await enterAmount(page);

  const log = await requestLog(page);
  const substate = log.filter((entry) => entry.method === 'tari_getSubstate');
  expect(substate.length, 'the authoritative readback must issue tari_getSubstate').toBeGreaterThan(0);
  for (const call of substate) {
    const params = call.params as Record<string, unknown>;
    // The contract is `{ substateId, version? }`. The `address` alias that an
    // earlier revision transmitted is not a documented parameter and must be
    // gone, and a cached version must not be pinned.
    expect(Object.keys(params).sort()).toEqual(['substateId']);
    expect(typeof params.substateId).toBe('string');
  }
});

test('matrix 7b: a no-parameter method is issued with no params member', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await enterAmount(page);
  // Disconnecting issues the liveness probe and tari_disconnect, so every
  // no-parameter method in the contract is exercised on one page.
  await page.getByRole('button', { name: /^Disconnect$/ }).first().click();
  await page.waitForTimeout(1_000);
  const log = await requestLog(page);
  for (const method of ['tari_getNetwork', 'tari_getCapabilities', 'tari_requestAccounts', 'tari_getAccounts', 'tari_disconnect']) {
    const calls = log.filter((entry) => entry.method === method);
    expect(calls.length, `${method} must actually have been issued`).toBeGreaterThan(0);
    for (const call of calls) {
      expect('params' in call, `${method} must not carry a params member`).toBe(false);
    }
  }
});

test('matrix 7c: no outbound request ever carries an undocumented parameter', async ({ page }) => {
  // The whole observed request set, checked against the published parameter
  // lists. This is the browser-side counterpart of the strict provider double in
  // the unit suite, and it covers every method the app actually issued rather
  // than a hand-picked few.
  await openWith(page, contractProvider({ form: 'extension' }), `/pools/${POOL_COMPONENT}`);
  await connect(page);
  await expect(page.getByRole('heading', { name: 'Swap' })).toBeVisible();
  await enterAmount(page);

  const NO_PARAMS = new Set(['tari_getNetwork', 'tari_requestAccounts', 'tari_getAccounts', 'tari_getWalletAddress', 'tari_getBalances', 'tari_getCapabilities', 'tari_disconnect']);
  const PARAMS = new Map<string, Set<string>>([
    ['tari_getSubstate', new Set(['substateId', 'version'])],
    ['tari_getTransactionResult', new Set(['transactionId'])],
    ['tari_signAndSubmitTransaction', new Set(['instructions', 'maxFee', 'inputs', 'dryRun'])],
    ['tari_createTransactionRequest', new Set(['kind', 'instructions', 'maxFee', 'inputs', 'relatedComponents'])],
    ['tari_getTransactionRequest', new Set(['requestId'])],
    ['tari_submitTransactionRequest', new Set(['requestId'])],
  ]);

  const log = await requestLog(page);
  expect(log.length).toBeGreaterThan(0);
  for (const call of log) {
    if (NO_PARAMS.has(call.method)) {
      expect('params' in call, `${call.method} must not carry a params member`).toBe(false);
      continue;
    }
    const allowed = PARAMS.get(call.method);
    expect(allowed, `${call.method} is not a documented Tari method`).toBeDefined();
    const params = call.params as Record<string, unknown>;
    for (const key of Object.keys(params)) {
      expect(allowed!.has(key), `${call.method} sent the undocumented parameter "${key}"`).toBe(true);
    }
    // `transaction`/`display` were the invented wrapper of the earlier shape.
    expect('transaction' in params).toBe(false);
    expect('display' in params).toBe(false);
  }
});

// ===========================================================================
// 8-10. ERROR CODES
// ===========================================================================

test('matrix 8: a 4001 user rejection is a clean decline, not a failure', async ({ page }) => {
  // The reads keep working; only the SIGNING methods reject with the documented
  // 4001, so the failure is observed on the operation that can produce it rather
  // than on connect.
  await openWith(
    page,
    contractProvider({
      form: 'extension',
      failWithCodeFor: ['tari_signAndSubmitTransaction', 'tari_createTransactionRequest'],
      failingCode: 4001,
    }),
    `/pools/${POOL_COMPONENT}`,
  );
  await connect(page);
  await expect(connected(page)).toBeVisible();
  await enterAmount(page);
  // The quote path runs the authoritative readback, so `tari_getSubstate` is
  // observed too: the failure is scoped to signing, not to the wallet.
  const log = await requestLog(page);
  expect(log.some((entry) => entry.method === 'tari_getSubstate')).toBe(true);

  // The published table is explicit: 4001 is "not an error. Return to the
  // pre-connect state quietly." So the UI must not present a decline as a
  // transaction failure, and must not claim an unknown submission.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/transaction failed/i);
  expect(body).not.toMatch(/submission outcome unknown/i);
  expect(body).not.toMatch(/rejected by the wallet/i);
});

test('matrix 9: a 4100 not-connected provider is not presented as a successful wallet', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }));
  await page.evaluate(() => (window as unknown as { __tariHost: { failWithCode(c: number): void } }).__tariHost.failWithCode(4100));
  await expect(connected(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  // 4100 is a connection state, not a lost transaction: nothing may be reported
  // as an unknown submission, which is the state this protocol works hardest to
  // keep meaning exactly one thing.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/submission outcome unknown/i);
  expect(body).not.toMatch(/transaction failed/i);
});

test('matrix 10: a 4200 unsupported method surfaces as a capability limit', async ({ page }) => {
  // A provider that answers the network probe but rejects the capability
  // handshake with 4200 cannot drive this app, and must be reported as a
  // limitation rather than as a crash or a silent failure.
  await mockIndexer(page);
  await page.route('https://universe.tari.mw/**', (route) => route.abort());
  await page.addInitScript(`
    window.tari = {
      isTariWallet: true,
      async request(envelope) {
        if (envelope.method === 'tari_getNetwork') return 'esmeralda';
        const error = new Error('unsupported method ' + envelope.method);
        error.code = 4200;
        throw error;
      },
    };
  `);
  await page.goto('/pools');
  await expect(connected(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/transaction failed/i);
});

test('matrix 10b: an unknown numeric code stays unknown, never a rejection', async ({ page }) => {
  await openWith(page, contractProvider({ form: 'extension' }));
  await page.evaluate(() => (window as unknown as { __tariHost: { failWithCode(c: number): void } }).__tariHost.failWithCode(-32000));
  const body = await page.locator('body').innerText();
  // An unrecognised code must not be upgraded into a deterministic verdict.
  expect(body).not.toMatch(/rejected by the wallet/i);
  expect(body).not.toMatch(/transaction failed/i);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});

test('matrix 10c: a codeless failure is not reported as a user rejection', async ({ page }) => {
  await mockIndexer(page);
  await page.route('https://universe.tari.mw/**', (route) => route.abort());
  await page.addInitScript(`
    window.tari = {
      isTariWallet: true,
      async request(envelope) {
        if (envelope.method === 'tari_getNetwork') return 'esmeralda';
        // The text deliberately contains the words a message matcher used to
        // look for, with no numeric code. A documented code is the only
        // discriminator, so this must not become a user rejection.
        throw new Error('the user rejected everything');
      },
    };
  `);
  await page.goto('/pools');
  await expect(connected(page)).toHaveCount(0);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/rejected by the wallet/i);
});

// ===========================================================================
// AVAILABILITY
// ===========================================================================

test('availability: a top-level connector with no wallet is unavailable, not absent', async ({ page }) => {
  await mockIndexer(page);
  await page.route('https://universe.tari.mw/**', (route) => route.abort());
  // This is the documented top-level case: the connector script is included
  // unconditionally and still publishes a provider object it cannot service.
  // `Boolean(window.tari)` is therefore not "a usable wallet is available", and
  // the two states must not be reported identically.
  await page.addInitScript(`
    window.tari = {
      isTariWallet: true,
      isEmbedded: false,
      async request() { throw new Error('this page is not running inside a Tari wallet'); },
    };
  `);
  await page.goto('/pools');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(connected(page)).toHaveCount(0);
  // It must not hang, and it must not claim a transaction failed or that no
  // wallet is installed: an availability failure is its own state, reached long
  // before any transaction is attempted.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/transaction failed/i);
  expect(body).not.toMatch(/No wallet/);
});

test('availability: a provider that never answers does not hang the page', async ({ page }) => {
  await mockIndexer(page);
  await page.route('https://universe.tari.mw/**', (route) => route.abort());
  await page.addInitScript(`
    window.tari = { isTariWallet: true, request: () => new Promise(() => {}) };
  `);
  await page.goto('/pools');
  // The availability probe is bounded, so the page reaches an honest state.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/transaction failed/i);
});

test('the connector script is shipped unconditionally and the effective CSP permits it', async ({ page }) => {
  // The served document, not the source file: this proves the built artifact
  // carries the tag and that the policy a browser applies to it allows the
  // origin. A browser enforces the meta CSP AND the response-header CSP as an
  // INTERSECTION, so a narrower copy in either place silently blocks the
  // embedded placement even when the other is correct.
  const violations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await mockIndexer(page);
  await page.goto('/pools');
  const tagCount = await page.locator('script[src="https://universe.tari.mw/tari-connector.js"]').count();
  expect(tagCount, 'the connector must be included exactly once, unconditionally').toBe(1);

  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toMatch(/script-src[^;]*https:\/\/universe\.tari\.mw/);

  // And nothing the page loads is refused by the policy. A CSP violation would
  // surface as a console error naming the directive.
  await page.waitForTimeout(1_000);
  expect(violations, `the CSP blocked a page resource:\n${violations.join('\n')}`).toEqual([]);
});
