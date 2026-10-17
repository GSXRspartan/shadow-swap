/**
 * README presentation captures.
 *
 * Companion to `capture-design.mts`, which captures the honest DISCONNECTED
 * state at five widths. This spec captures the CONNECTED presentation state.
 *
 * Run ONLY when explicitly asked for; it asserts nothing about correctness and
 * is excluded from every normal run:
 *
 *   CAPTURE_README=1 npx playwright test capture-readme --project=chromium-desktop
 *
 * WHY THIS EXISTS. The production bundle refuses to render decoded pool state
 * without a wallet — that is the security model, not a bug — so the only way to
 * show the real Swap UI is to drive it with the same deterministic reference
 * provider and indexer mock the browser security suite uses
 * (`referenceProvider.ts` + `mockIndexer.ts`). Everything on screen is
 * synthetic sample data: TARI / wSTABLE / AAA / BBB are invented asset symbols,
 * with no live network, no real chain, no real wallet, and no real balances.
 *
 * These are PRESENTATION SAMPLES of the shipped bundle, not evidence of market
 * state. The README says so next to the images.
 *
 * WHAT IT MUST NEVER SHOW: a real wallet address, a real key, real balances, or
 * any private or unreleased artwork of any kind. The provider mock answers with
 * a synthetic account only and the indexer mock with synthetic pools.
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import {
  MARKETPLACE_COLLECTION_RESOURCE,
  mockIndexer,
  POOL_COMPONENT,
} from './mockIndexer.js';
import { installReferenceProvider } from './referenceProvider.js';

const CAPTURE = process.env.CAPTURE_README === '1';
// Playwright always runs from the config directory (apps/web), and the README
// assets live in the repository root's docs/.
const OUT = path.resolve(process.cwd(), '..', '..', 'docs', 'screenshots');

const SHOTS = [
  { file: 'home-market.png', route: '/', label: 'home' },
  { file: 'swap-market.png', route: `/pools/${POOL_COMPONENT}`, label: 'swap' },
  { file: 'pools-market.png', route: '/pools', label: 'pools' },
  // The item GRID lives on the collection route; /nfts lists collections only.
  { file: 'nft-market.png', route: `/nfts/${MARKETPLACE_COLLECTION_RESOURCE}`, label: 'nft' },
] as const;

test.beforeEach(async ({ page }) => {
  test.skip(!CAPTURE, 'presentation capture only; set CAPTURE_README=1 to run');
  // Installed BEFORE any navigation, exactly as the security suite installs it.
  await page.addInitScript(installReferenceProvider);
  // `marketplace: true` is what lets the NFT capture show a populated grid: the
  // default mock serves no marketplace component, which is the honest empty
  // state the security suite asserts.
  mockIndexer(page, { marketplace: true });
});

/**
 * The wallet must be CONNECTED for pool state to decode: the authoritative
 * readback is bound to the connected account, and a disconnected provider is
 * refused rather than trusted. This is the same handshake the security suite
 * performs, and the mock provider auto-approves it with a synthetic account.
 */
async function connectWallet(page: Page): Promise<void> {
  // `.first()` is required: the landing page has its own hero connect button
  // AND the header's wallet control, and a two-match click is a strict-mode
  // error. Either one performs the same handshake.
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /Open wallet details/ }).first()).toBeVisible({ timeout: 10_000 });
}

for (const shot of SHOTS) {
  test(`capture ${shot.label}`, async ({ page }) => {
    await page.goto(shot.route, { waitUntil: 'networkidle' });
    await connectWallet(page);
    // Let entry transitions settle; a capture taken mid-animation shows a
    // half-faded page and would be judged a rendering bug.
    await page.waitForTimeout(1200);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await page.screenshot({ path: `${OUT}/${shot.file}`, fullPage: false });
  });
}