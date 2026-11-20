#!/usr/bin/env node
/**
 * Capture the production bundle in a real browser, with the deployment security
 * headers ENFORCED (same server as the hosting e2e project).
 *
 *   node scripts/capture-screens.mjs            # writes docs/screenshots/<today>/*.png
 *   node scripts/capture-screens.mjs --out DIR  # custom output directory
 *
 * Read-only: no wallet provider is installed, so every surface renders its
 * unconnected/discovery state. The response headers for / are printed so the
 * CSP actually delivered to the browser is visible next to the screenshots.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
const PORT = 4181;
const BASE = `http://127.0.0.1:${PORT}`;

const argIndex = process.argv.indexOf('--out');
const outArg = argIndex !== -1 ? process.argv[argIndex + 1] : undefined;
const outDir = path.resolve(
  outArg ?? path.join(REPO_ROOT, 'docs', 'screenshots', new Date().toISOString().slice(0, 10)),
);
/** `--route /pools --wait 30000`: capture ONE route after settling, for diagnosis. */
const onlyIndex = process.argv.indexOf('--route');
const onlyRoute = onlyIndex !== -1 ? process.argv[onlyIndex + 1] : undefined;
const settleMs = Number(process.argv[process.argv.indexOf('--wait') + 1] ?? 4000) || 4000;
mkdirSync(outDir, { recursive: true });

const server = spawn('node', [path.join(HERE, 'serve-headers.mjs'), '--port', String(PORT), '--root', 'dist'], {
  cwd: WEB_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not come up at ${url}`);
}

const ROUTES = [
  ['/', 'home'],
  ['/swap', 'swap-routes'],
  ['/pools', 'pools'],
  ['/nfts', 'nft-marketplace'],
  ['/market', 'cross-layer-market'],
  ['/activity', 'activity'],
  ['/support', 'support'],
];

try {
  await waitForServer(`${BASE}/`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`));

  // Prove the policy reaches the real browser on the entry document.
  const first = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const csp = first.headers()['content-security-policy'] ?? '(MISSING)';
  console.log('content-security-policy:', csp.slice(0, 160));
  console.log('frame-ancestors present:', csp.includes('frame-ancestors'));
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: path.join(outDir, 'home-1440.png'), fullPage: true });

  const routes = onlyRoute ? [onlyRoute] : ROUTES.slice(1).map(([r]) => r);
  for (const route of routes) {
    const name = (ROUTES.find(([r]) => r === route)?.[1]) ?? (route.replace(/^\//, '').replace(/\//g, '-') || 'root');
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(settleMs);
    await page.screenshot({ path: path.join(outDir, `${name}-1440.png`), fullPage: true });
    console.log(`captured ${route} -> ${name}-1440.png`);
  }
  if (consoleErrors.length > 0) {
    console.log(`console errors (${consoleErrors.length}):`);
    consoleErrors.slice(0, 6).forEach((e) => console.log('  ' + e));
  }

  // Mobile viewport for the home page (the sculpture hero is the responsive change).
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await mobile.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForTimeout(4000);
  await mobile.screenshot({ path: path.join(outDir, 'home-390.png'), fullPage: true });
  console.log(`captured / (mobile) -> home-390.png`);

  await browser.close();
  console.log(`done: ${outDir}`);
} finally {
  server.kill();
}
