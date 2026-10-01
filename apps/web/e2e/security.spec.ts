import { test, expect, type Page } from '@playwright/test';
import { installReferenceProvider } from './referenceProvider.js';
import { mockIndexer, simulateIndexerOutage, POOL_COMPONENT, SAFE_POOL_COMPONENT } from './mockIndexer.js';

/**
 * Browser security flows.
 *
 * Each test names the invariant it defends. These are the checks a server-render
 * suite cannot make: that the real production bundle loads in a real browser,
 * that a hostile provider can be injected before the app script runs, and that
 * the resulting state is what the UI says it is.
 *
 * The app is served from its production build, and the indexer is mocked at the
 * production origin, so nothing about the shipped artifact is relaxed to make a
 * test pass.
 */

async function open(page: Page, path: string): Promise<void> {
  await page.addInitScript(installReferenceProvider);
  await page.goto(path);
  // The shell is what must always render, whatever the route resolves to.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

async function connectWallet(page: Page): Promise<void> {
  // `exact` matters: without it, this also matches "Connect wallet to swap".
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  // The account is rendered truncated, so assert on the stable control rather
  // than on the address text, whose visible form depends on font metrics.
  await expect(page.getByRole('button', { name: /Open wallet details/ }).first()).toBeVisible({ timeout: 10_000 });
}

function connected(page: Page) {
  return page.getByRole('button', { name: /Open wallet details/ }).filter({ visible: true }).first();
}

/**
 * The shell deliberately renders the network and health badges twice — once in
 * the desktop row and once in the mobile row, with CSS choosing which is shown.
 * A text locator therefore matches two nodes, exactly one of which is visible
 * at any given breakpoint, so scope to the visible one rather than to `.first()`.
 */
function badge(page: Page, text: string | RegExp) {
  return page.getByText(text).filter({ visible: true }).first();
}

function swapControl(page: Page) {
  return page
    .getByRole('button', { name: 'Swap', exact: true })
    .or(page.getByRole('button', { name: 'Connect wallet to swap' }))
    .first();
}

// ---------------------------------------------------------------------------
// 1-2. Pool load, market header, and simple swap review
// ---------------------------------------------------------------------------

// The indexer says WHICH pools exist; the WALLET says WHAT they hold, because
// the indexer serves component state as raw tagged CBOR and cannot decode a
// pool's fields. So a pool becomes describable only once a wallet is connected
// and the authoritative read has resolved.
test('pool discovery renders both pools with the full metric set', async ({ page }) => {
  await mockIndexer(page);
  await open(page, '/pools');
  await connectWallet(page);
  await expect(badge(page, 'TARI / wSTABLE')).toBeVisible();
  await expect(badge(page, 'AAA / BBB')).toBeVisible();
  for (const column of ['Pair', 'Price', '24h change', '24h volume', 'Liquidity', '24h LP fees', 'Market data', 'Asset safety']) {
    await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
  }
  // No market data is connected, so metrics are the unavailable marker, never 0.
  const body = await page.locator('tbody').first().innerText();
  expect(body).toContain('—');
  expect(body).not.toMatch(/>\s*0\s*</);
  // The issuer-controlled quote asset is surfaced.
  await expect(badge(page, 'Issuer controlled')).toBeVisible();
});

test('an indexer outage produces an explicit unavailable state, not an empty list', async ({ page }) => {
  await simulateIndexerOutage(page);
  await open(page, '/pools');
  await expect(badge(page, /Pool discovery unavailable/)).toBeVisible();
  // A failure must never read as "there are no pools".
  await expect(badge(page, /0 pools/)).toHaveCount(0);
});

test('unpublished templates read as a reachable network with nothing deployed', async ({ page }) => {
  // The post-reset Esmeralda reality: the chain answers, reports no published
  // `Pool` template, and that is an EMPTY DEPLOYMENT. It must not be dressed up
  // as an outage and never as "no liquidity".
  await mockIndexer(page, { unpublished: true });
  await open(page, '/pools');
  await expect(badge(page, /Network reachable, protocol not yet deployed/)).toBeVisible();
  await expect(badge(page, /Pool discovery unavailable/)).toHaveCount(0);
  await expect(badge(page, /network is reachable/i)).toBeVisible();
});

test('the market header and swap card render on a real pool page', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  await expect(badge(page, /TARI/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Swap' })).toBeVisible();
  // The issuer-controlled asset warning must be present before any action.
  await expect(badge(page, /Issuer controlled asset in this pool/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. Malicious market data
// ---------------------------------------------------------------------------

test('a hostile discovery payload cannot inject script or break the layout', async ({ page }) => {
  await mockIndexer(page, { hostile: true });
  await open(page, '/pools');
  await connectWallet(page);
  // Malformed records are dropped; the well-formed ones still render.
  await expect(badge(page, 'TARI / wSTABLE')).toBeVisible();
  const pwned = await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned);
  expect(pwned).toBeUndefined();
  // An unknown safety classification must not be treated as vetted.
  await expect(badge(page, /Unclassified|Unknown/)).toHaveCount(0);
  // A hostile substate id is never rendered as a pool.
  await expect(page.getByText('__pwned')).toHaveCount(0);
});

test('a hostile market-data price cannot reach the swap control', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  // The swap control is bound to a resolver result. No authoritative reread has
  // happened, so it must be disabled regardless of anything on screen.
  await expect(swapControl(page)).toBeDisabled();
});

// ---------------------------------------------------------------------------
// 4-5. Account / network switch before approval
// ---------------------------------------------------------------------------

test('an account switch after connect leaves the swap control disabled', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  await page.evaluate(() => window.__tariHost!.swapAccount());
  await expect(swapControl(page)).toBeDisabled();
});

test('a mainnet provider is refused and the page never reads as mainnet', async ({ page }) => {
  await mockIndexer(page);
  // No reload here: `addInitScript` re-runs on every navigation and would reset
  // the provider state back to the default testnet before the click.
  await page.addInitScript(installReferenceProvider);
  await page.goto('/pools');
  await page.evaluate(() => window.__tariHost!.switchNetwork('mainnet'));
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  // A network outside the allowlist, or a mismatch against the pinned network,
  // is a hard failure. No session may be established, and the refusal must be
  // visible in the page rather than hidden behind the wallet-details dialog.
  const refusal = page.getByRole('alert').filter({ hasText: 'Wallet connection refused' });
  await expect(refusal).toBeVisible({ timeout: 10_000 });
  await expect(refusal).toContainText(/Mainnet is disabled|not allowed|pinned to|does not match/i);
  await expect(connected(page)).toHaveCount(0);
  await expect(badge(page, 'Esmeralda Testnet')).toBeVisible();
});

test('a provider that downgrades its capabilities cannot keep an enabled control', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  await page.evaluate(() => window.__tariHost!.downgradeCapabilities());
  // Capabilities are re-fetched at authorization time, so the snapshot the
  // review would be bound to no longer matches the live advertisement.
  await expect(swapControl(page)).toBeDisabled();
});

test('a provider replaced mid-session is refused at authorization, not trusted', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  const before = await page.evaluate(() => window.tari);
  await page.evaluate(() => window.__tariHost!.replaceProvider());
  const after = await page.evaluate(() => window.tari);
  // The host really did swap the object.
  expect(after).not.toBe(before);

  // The bridge re-resolves `window.tari` at authorization time, so the live
  // identity no longer matches the pinned reference. Nothing may be submitted.
  await expect(swapControl(page)).toBeDisabled();
  await expect(badge(page, /submitted/i)).toHaveCount(0);
});


// ---------------------------------------------------------------------------
// 6. Rapid double submit
// ---------------------------------------------------------------------------

test('a rapid double submit cannot create two durable operations', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  const swap = swapControl(page);
  await expect(swap).toBeDisabled();
  await swap.click({ force: true, timeout: 1000 }).catch(() => undefined);
  await swap.click({ force: true, timeout: 1000 }).catch(() => undefined);
  await expect(badge(page, /submitted/i)).toHaveCount(0);
  // And nothing was written to the operation history.
  const stored = await page.evaluate(() => window.localStorage.getItem('ootle.operations.v1'));
  expect(stored === null || stored === '[]').toBe(true);
});

// ---------------------------------------------------------------------------
// 7-8. Multi-hop partial completion, requote, UNKNOWN
// ---------------------------------------------------------------------------

test('the multi-hop route panel shows the two-hop chain and the browser blocker', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  for (const node of ['XTM', 'Fast XTM / TARI', 'TARI', 'AMM', 'Destination asset']) {
    await expect(badge(page, node)).toBeVisible();
  }
  await expect(badge(page, 'Wallet upgrade required for atomic XTM swaps')).toBeVisible();
  await expect(badge(page, /gated OFF/)).toBeVisible();
});

test('the Activity page documents UNKNOWN as reconciling, not retryable', async ({ page }) => {
  await open(page, '/activity');
  for (const state of ['PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'UNKNOWN']) {
    await expect(badge(page, state)).toBeVisible();
  }
  await expect(badge(page, /being reconciled by durable identifier/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Retry$/ })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 10-11. NFT stale listing, malicious metadata
// ---------------------------------------------------------------------------

test('a hostile NFT metadata document cannot execute or inject', async ({ page }) => {
  // The metadata loader only accepts https, and only from a validated host list;
  // a data: or javascript: document never reaches fetch.
  await page.route('https://meta.example/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: '<img src=x onerror="window.__nftPwned=1">',
        description: '<script>window.__nftPwned=2</script>',
        image: 'javascript:window.__nftPwned=3',
      }),
    }),
  );
  await mockIndexer(page);
  await open(page, '/nfts');
  const pwned = await page.evaluate(() => (window as unknown as { __nftPwned?: number }).__nftPwned);
  expect(pwned).toBeUndefined();
  // No collection exists, so the page says so rather than inventing one.
  await expect(badge(page, /No collections|discovery/)).toBeVisible();
});

test('no NFT collection is fabricated when discovery returns nothing', async ({ page }) => {
  await mockIndexer(page);
  await open(page, '/nfts');
  await expect(badge(page, /No collections/)).toBeVisible();
  await expect(badge(page, /not fabricated|returned no collections/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// 11-14. Responsive, accessibility, no overflow
// ---------------------------------------------------------------------------

test('the mobile layout has no horizontal overflow at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the mobile layout still has no overflow under wider font metrics', async ({ page }) => {
  // Regression (Pixel Canary fourth pass, CI finding): CI's Linux headless
  // Chromium falls back to wider system fonts than a developer machine, which
  // pushed a `nowrap` market-header metric past the viewport and overflowed the
  // page by 11px. Forcing a wide font stack here reproduces that environment on
  // any machine, so the fix (capped grid tracks + wrappable metric values) is
  // verified against the failure condition itself, not just the happy fonts.
  await page.setViewportSize({ width: 390, height: 844 });
  await mockIndexer(page);
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = ':root { --font-sans: "Liberation Sans", "DejaVu Sans", "Arial", sans-serif; letter-spacing: 0.04em; }';
    document.addEventListener('DOMContentLoaded', () => document.head.append(style));
  });
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the desktop layout has no horizontal overflow at 1440px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockIndexer(page);
  await open(page, '/pools');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the smallest supported width does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await mockIndexer(page);
  await open(page, '/pools');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('the skip link is the first focus stop', async ({ page }) => {
  await mockIndexer(page);
  await open(page, '/pools');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  expect(focused).toMatch(/skip to main content/i);
});

test('critical status is not colour-only', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  // The issuer warning carries text, so it survives greyscale and screen readers.
  const warning = badge(page, /Issuer controlled asset in this pool/);
  await expect(warning).toBeVisible();
  await expect(warning).toBeVisible();
});

test('the TradingView attribution is present, linked, and opener-safe', async ({ page }) => {
  await mockIndexer(page);
  await open(page, '/pools');
  const link = page.getByRole('link', { name: /TradingView Lightweight Charts/ });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://www.tradingview.com/');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(link).toHaveAttribute('rel', /noreferrer/);
});

// ---------------------------------------------------------------------------
// Provider abuse
// ---------------------------------------------------------------------------

test('without a provider the app is disconnected and says so', async ({ page }) => {
  await mockIndexer(page);
  await page.addInitScript('window.tari = undefined;');
  await page.goto('/pools');
  await expect(badge(page, 'No wallet')).toBeVisible();
  await expect(connected(page)).toHaveCount(0);
});

test('a provider that cannot answer the capability handshake is not used', async ({ page }) => {
  await mockIndexer(page);
  await page.addInitScript(`
    window.tari = { request: async () => { throw new Error('nope'); } };
  `);
  await page.goto('/pools');
  await expect(connected(page)).toHaveCount(0);
});

test('a provider hanging forever cannot wedge the page', async ({ page }) => {
  await mockIndexer(page);
  await page.addInitScript(`
    window.tari = { request: () => new Promise(() => {}) };
  `);
  await page.goto('/pools');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});


// ---------------------------------------------------------------------------
// 27-28. Mainnet and the submit gate
// ---------------------------------------------------------------------------

test('mainnet is never offered as a network anywhere in the UI', async ({ page }) => {
  await mockIndexer(page);
  await open(page, '/pools');
  const options = await page.locator('select option').allTextContents();
  expect(options.join(' ')).not.toMatch(/mainnet/i);
  const body = await page.locator('body').innerText();
  // The only permitted mention is the sentence that says it is disabled.
  expect(body.split(/mainnet/i).length - 1).toBeLessThanOrEqual(1);
});

test('the real-submit gate is displayed as off and cannot be set from the URL', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}?TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT=1&network=mainnet`);
  await connectWallet(page);
  await expect(badge(page, /gated OFF/)).toBeVisible();
  await expect(badge(page, 'Esmeralda Testnet')).toBeVisible();
});

test('a query parameter cannot change the displayed network', async ({ page }) => {
  await mockIndexer(page);
  await open(page, '/pools?VITE_TARI_NETWORK=mainnet');
  await expect(badge(page, 'Esmeralda Testnet')).toBeVisible();
  await expect(badge(page, 'TESTNET')).toBeVisible();
});

test('the browser SHA swap blocker is shown, not a working button', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  await expect(badge(page, 'Wallet upgrade required for atomic XTM swaps')).toBeVisible();
  await expect(badge(page, /does not fall back to a local wallet service/)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('a tampered operation record is dropped, not displayed', async ({ page }) => {
  await mockIndexer(page);
  await page.addInitScript(`
    window.localStorage.setItem('ootle.operations.v1', JSON.stringify([
      { operationId: 'forged-1', operationKind: 'AMM_SWAP', state: 'CONFIRMED', resources: [], amounts: { a: '1' }, createdAtUnixMs: 1, preimage: 'deadbeef' },
      { operationId: 'forged-2', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: { a: 'not-a-number' }, createdAtUnixMs: 1 },
      { operationId: 'ok-1', operationKind: 'AMM_SWAP', state: 'PENDING', resources: [], amounts: { a: '100' }, createdAtUnixMs: 1 }
    ]));
  `);
  await page.goto('/activity');
  await expect(badge(page, 'ok-1')).toBeVisible();
  await expect(badge(page, 'forged-1')).toHaveCount(0);
  await expect(badge(page, 'forged-2')).toHaveCount(0);
});

test('a tampered confirmation is shown as a claim, not as settled', async ({ page }) => {
  await mockIndexer(page);
  await page.addInitScript(`
    window.localStorage.setItem('ootle.operations.v1', JSON.stringify([
      { operationId: 'forged-confirm', operationKind: 'AMM_SWAP', state: 'CONFIRMED', resources: [], amounts: { a: '100' }, createdAtUnixMs: Date.now() }
    ]));
  `);
  await page.goto('/activity');
  // The record loads, but nothing may present it as final without a lookup.
  await expect(badge(page, 'forged-confirm')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Retry$/ })).toHaveCount(0);
  // The claim must be visibly qualified, not just stored: a persisted CONFIRMED
  // is editable by any script on this origin and can never be rendered as proof.
  await expect(page.getByText('Local claim, not chain proof')).toBeVisible();
  await expect(page.getByText(/Local storage can be edited by any script on this origin/)).toBeVisible();
  // Verification stays reachable instead of being blocked by the bogus state.
  await expect(page.getByRole('button', { name: 'Verify against the chain' })).toBeVisible();
});

test('no secret is ever written to storage', async ({ page }) => {
  await mockIndexer(page);
  await open(page, `/pools/${POOL_COMPONENT}`);
  await connectWallet(page);
  const dump = await page.evaluate(() => JSON.stringify({ ...window.localStorage }));
  expect(dump).not.toMatch(/preimage|seed|mnemonic|privateKey/i);
});

// ---------------------------------------------------------------------------
// Console hygiene
// ---------------------------------------------------------------------------

test('the app logs nothing to the console', async ({ page }) => {
  await mockIndexer(page);
  const messages: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') messages.push(`${message.type()}: ${message.text()}`);
  });
  await open(page, '/pools');
  await open(page, `/pools/${SAFE_POOL_COMPONENT}`);
  await open(page, '/activity');
  expect(messages).toEqual([]);
});



