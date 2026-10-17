/**
 * DESIGN REVIEW CAPTURE — screenshots for visual inspection.
 *
 * NOT a test. It asserts nothing and fails nothing; it produces images for a
 * human to look at, because "the suite is green" and "the page looks right" are
 * different claims and only the second one settles the design question.
 *
 * It therefore runs ONLY when invoked explicitly, and it is deliberately not part
 * of `test:e2e`. Run with:  npm run capture
 *
 * WHAT IT MUST NEVER CAPTURE.
 *
 *   - A private wallet address, key, request id, or any other secret.
 *   - Private or unreleased character artwork. This harness installs NO provider
 *     and NO indexer, so every page renders its disconnected, empty, or
 *     unavailable state — which is also the state that most needs looking at.
 *
 * Because there is no wallet connected, no live address can appear in a capture
 * even by accident. That is a property of the harness, not a scrubber.
 */

import { chromium, devices, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
const OUT = path.join(REPO_ROOT, 'docs', 'screenshots', 'design');
const PORT = 4188;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** The five widths the brief names, plus the mobile device profile. */
const WIDTHS = [
  { name: '360', width: 360, height: 780 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 800 },
  { name: '1440', width: 1440, height: 900 },
];

const ROUTES = [
  { path: '/', name: 'home' },
  { path: '/pools', name: 'pools' },
  { path: '/nfts', name: 'nft-market' },
  { path: '/activity', name: 'activity' },
];

async function startServer(): Promise<ChildProcess> {
  // No shell: arguments go straight to the child, so nothing in a path can be
  // interpreted as a command.
  //
  // `--host 127.0.0.1` is REQUIRED and not cosmetic. `vite preview` with no host
  // binds whatever `localhost` resolves to first, which is `::1` on a
  // IPv6-preferring machine; this harness then polls the IPv4 literal, the health
  // check never succeeds, and the capture aborts with "preview server did not
  // start" while the server is in fact running and listening. Pinning both sides
  // to the same literal is what makes the check and the server agree.
  const child = spawn(process.execPath, [path.join(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: WEB_ROOT,
    stdio: 'ignore',
    shell: false,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ORIGIN, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return child;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  child.kill();
  throw new Error(`preview server did not start on ${ORIGIN}`);
}

/** Fail loudly on any console error: a screenshot that hides an exception is worse than none. */
function watchConsole(page: Page, label: string, errors: string[]) {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`[${label}] ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`[${label}] ${error.message}`));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  const errors: string[] = [];

  try {
    for (const route of ROUTES) {
      for (const viewport of WIDTHS) {
        // Desktop context for the desktop widths, the Pixel 7 profile for the
        // narrow ones — a real mobile device profile sets the viewport AND the
        // touch/`isMobile` flags a CSS media query and a `hover` rule depend on.
        const context =
          viewport.width <= 390
            ? await browser.newContext({ ...devices['Pixel 7'], viewport: { width: viewport.width, height: viewport.height } })
            : await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        const label = `${route.name}-${viewport.width}`;
        watchConsole(page, label, errors);
        await page.goto(`${ORIGIN}${route.path}`, { waitUntil: 'networkidle' });
        // Let entry transitions settle. A capture taken mid-animation shows a
        // half-faded page and would be judged as a rendering bug.
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `${route.name}-${viewport.width}.png`), fullPage: true });
        await context.close();
        process.stdout.write(`captured ${label}\n`);
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }

  if (errors.length > 0) {
    process.stdout.write(`\nCONSOLE ERRORS (${errors.length}):\n${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nno console errors. screenshots in ${OUT}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});