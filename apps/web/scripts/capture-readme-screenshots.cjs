/**
 * Capture README screenshots from the PRODUCTION build.
 *
 * Everything shown comes from the deterministic mock indexer in
 * `e2e/mockIndexer.ts`'s shape — the same fixtures the browser security suite
 * uses — plus a locally intercepted media host. NO live network, NO real
 * chain data, NO wallet. The images are presentation samples of the shipped
 * bundle, not evidence of live market state, and the README says so.
 *
 * Usage: npm run build && node scripts/capture-readme-screenshots.cjs
 * Output: docs/screenshots/*.png (run from apps/web)
 */
const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
const MEDIA_HOST = 'https://media.captures.example';
const OUT = path.resolve(__dirname, '..', '..', '..', 'docs', 'screenshots');

const POOL = {
  poolComponent: 'component_pool_tari_wstable_0001',
  resourceA: 'otl_canonical_tari',
  resourceB: 'otl_wstable_0001',
  baseResource: 'otl_canonical_tari',
  quoteResource: 'otl_wstable_0001',
  baseSymbol: 'TARI',
  quoteSymbol: 'wSTABLE',
  baseDecimals: '6',
  quoteDecimals: '6',
  safetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED',
  baseSafetyClass: 'CANONICAL_TARI',
  quoteSafetyClass: 'PUBLIC_IMMUTABLE_OR_VETTED',
  feeBps: '30',
};

const COLLECTION = 'otl_ootsuki_0001';
// Metadata is fetched with `fetch()`, which the shipped CSP restricts to
// `connect-src 'self'` + the indexer origins — so the sample metadata is served
// AT the indexer origin, exactly where production metadata would come from.
// Media (an <img>, governed by the permissive `img-src https:`) may come from
// any https host and uses the intercepted media origin.
const METADATA_ORIGIN = 'https://ootle-indexer-a.tari.com';
const ITEMS = [
  { nftId: '0001', listingAddress: 'listing_0001', price: '42000000', quoteResource: 'otl_wstable_0001', metadataUri: `${METADATA_ORIGIN}/metadata/0001.json` },
  { nftId: '0002', price: '38000000', quoteResource: 'otl_wstable_0001', metadataUri: `${METADATA_ORIGIN}/metadata/0002.json` },
  { nftId: '0003', listingAddress: 'listing_0003', price: '55000000', quoteResource: 'otl_wstable_0001', metadataUri: `${METADATA_ORIGIN}/metadata/0003.json` },
  { nftId: '0004', price: '61000000', quoteResource: 'otl_wstable_0001', metadataUri: `${METADATA_ORIGIN}/metadata/0004.json` },
  { nftId: '0005', listingAddress: 'listing_0005', price: '47500000', quoteResource: 'otl_wstable_0001', metadataUri: `${METADATA_ORIGIN}/metadata/0005.json` },
  { nftId: '0006', price: '39000000', quoteResource: 'otl_wstable_0001', metadataUri: `${METADATA_ORIGIN}/metadata/0006.json` },
];

const ART = (hue) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
     <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
       <stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360},60%,30%)"/>
     </linearGradient></defs>
     <rect width="600" height="600" fill="url(#g)"/>
     <circle cx="300" cy="300" r="150" fill="rgba(255,255,255,0.16)"/>
     <rect x="200" y="420" width="200" height="28" rx="14" fill="rgba(0,0,0,0.35)"/>
   </svg>`,
);

function hueFor(nftId) {
  return 90 + (Number(nftId) * 47) % 220;
}

async function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const probe = await fetch(url);
      if (probe.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview server did not come up at ${url}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // No `shell: true` (Node DEP0190: a shell concatenates arguments
  // unescaped) and no npx shim (Node >= 18.20 refuses batch-file spawns
  // without an absolute path): run vite's preview CLI directly under the
  // current Node. `vite/bin/vite.js` is not exported by the package manifest,
  // so resolve it from the workspace install path.
  const viteBin = path.join(__dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js');
  const preview = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'ignore',
  });
  try {
    await waitForServer(BASE);

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

    // Context-level interception: every page in the context sees the same
    // deterministic discovery and media responses.
    for (const ctx of [context, mobileContext]) {
      await ctx.route('https://ootle-indexer-a.tari.com/**', async (route) => {
        const url = route.request().url();
        const metadataId = /\/metadata\/(\d+)\.json/.exec(url)?.[1];
        if (metadataId !== undefined) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              name: `Ootsuki #${metadataId}`,
              collection: 'Ootsuki',
              description: 'Deterministic sample metadata served by the screenshot harness — not live chain data.',
              image: `${MEDIA_HOST}/art/${metadataId}.svg`,
            }),
          });
          return;
        }
        let body = { data: [] };
        try {
          const payload = (route.request().postDataJSON() ?? {});
          switch (payload.query) {
            case 'pool_discovery':
              body = { data: [POOL] };
              break;
            case 'nft_collections':
              body = { data: [{ collectionResource: COLLECTION }] };
              break;
            case 'nft_items':
              body = { data: ITEMS };
              break;
            default:
              body = { data: [] };
          }
        } catch {
          body = { data: [] };
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      // Metadata + media: served from an intercepted https host so the shipped
      // URL validator sees exactly the shape production sees.
      await ctx.route(`${MEDIA_HOST}/**`, async (route) => {
        const url = route.request().url();
        const id = /(\d+)\.svg/.exec(url)?.[1] ?? '1';
        const numeric = Number(id);
        await route.fulfill({
          status: Number.isNaN(numeric) ? 404 : 200,
          contentType: Number.isNaN(numeric) ? 'text/plain' : 'image/svg+xml',
          body: Number.isNaN(numeric) ? 'not found' : ART(hueFor(id)).toString('utf8'),
        });
      });
    }

    const desktop = await context.newPage();
    await desktop.setViewportSize({ width: 1440, height: 900 });
    await desktop.goto(`${BASE}/pools/${POOL.poolComponent}`);
    await desktop.waitForTimeout(2500);
    await desktop.screenshot({ path: path.join(OUT, 'pool-market.png') });

    await desktop.goto(`${BASE}/nfts/${COLLECTION}`);
    await desktop.waitForTimeout(3500);
    await desktop.screenshot({ path: path.join(OUT, 'nft-marketplace.png') });

    const mobile = await mobileContext.newPage();
    await mobile.goto(`${BASE}/pools/${POOL.poolComponent}`);
    await mobile.waitForTimeout(2500);
    await mobile.screenshot({ path: path.join(OUT, 'mobile-pool.png') });

    await browser.close();
    console.log(`screenshots written to ${OUT}`);
  } finally {
    preview.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
