/**
 * Ootle v0.48 in a REAL browser, under the SHIPPED Content-Security-Policy.
 *
 * The v0.48 indexer serves chain values as base64 CBOR, and the app decodes them with
 * the official `@tari-project/ootle-wasm-bor@0.48.0` WebAssembly module. Node tests
 * prove the decoder's output against real engine bytes; only a browser can prove the
 * part that matters at deployment time: that the production build actually loads and
 * compiles that module under its own CSP (`script-src 'self' 'wasm-unsafe-eval' …`)
 * in Chromium AND Firefox, with no policy violation, and that nothing broader than
 * WebAssembly compilation was opened to make it work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { mockIndexer } from './mockIndexer.js';

const assets = path.resolve(process.cwd(), 'dist', 'assets');
const loaderChunk = fs.readdirSync(assets).find((name) => /^ootleWasmBor\.browser-[\w-]+\.js$/.test(name));
const wasmAsset = fs.readdirSync(assets).find((name) => /^ootle_wasm_bor_bg-[\w-]+\.wasm$/.test(name));
const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'test', 'fixtures', 'ootle-v048-pool-wire.json'), 'utf8')) as {
  poolComponent: string;
  substates: Record<string, { version: number; value: string }>;
  executeResults: { acceptedSwap: string; rejectedSwap: string };
};

test('the production build ships the decoder as a same-origin hashed asset', () => {
  expect(loaderChunk, 'the lazy decoder chunk is emitted').toBeTruthy();
  expect(wasmAsset, 'the WebAssembly module is emitted as an asset').toBeTruthy();
  expect(fs.statSync(path.join(assets, wasmAsset as string)).size).toBe(473_351);
});

test('the official v0.48 decoder compiles and decodes real engine bytes under the shipped CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to|wasm-unsafe-eval|WebAssembly/i.test(message.text()) && message.type() === 'error') violations.push(message.text());
  });
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await mockIndexer(page);
  await page.goto('/pools');
  const decoded = await page.evaluate(
    async ({ loader, pool, accepted, rejected }) => {
      const mod = (await import(loader)) as { loadOotleWasmBor: () => Promise<{ decodeSubstateValue(b: string): unknown; decodeExecuteResult(b: string): unknown }> };
      const codec = await mod.loadOotleWasmBor();
      const value = codec.decodeSubstateValue(pool) as Record<string, { header: { template_address: string } }>;
      const ok = codec.decodeExecuteResult(accepted) as { finalize: { result: Record<string, unknown> } };
      const bad = codec.decodeExecuteResult(rejected) as { finalize: { result: Record<string, unknown> } };
      let refused = false;
      try {
        codec.decodeSubstateValue('AAAA');
      } catch {
        refused = true;
      }
      return {
        variant: Object.keys(value),
        template: value.Component?.header.template_address,
        accepted: Object.keys(ok.finalize.result),
        rejected: Object.keys(bad.finalize.result),
        refused,
        violations: (window as unknown as { __cspViolations: string[] }).__cspViolations,
      };
    },
    {
      loader: `/assets/${loaderChunk}`,
      pool: fixture.substates[fixture.poolComponent].value,
      accepted: fixture.executeResults.acceptedSwap,
      rejected: fixture.executeResults.rejectedSwap,
    },
  );
  expect(decoded.variant).toEqual(['Component']);
  expect(decoded.template).toMatch(/^[0-9a-f]{64}$/);
  expect(decoded.accepted).toEqual(['Accept']);
  expect(decoded.rejected).toEqual(['AcceptFeeRejectRest']);
  expect(decoded.refused, 'malformed bytes throw instead of decoding').toBe(true);
  expect(decoded.violations).toEqual([]);
  expect(violations).toEqual([]);
});

test('NEGATIVE CONTROL: without wasm-unsafe-eval the same decode is refused, so the CSP is really enforced', async ({ page }) => {
  // Proves the positive test above is not vacuous: the page's policy genuinely governs
  // WebAssembly compilation, and the one token added for v0.48 is load-bearing. (The
  // policy's continued refusal of JavaScript eval is asserted token-exactly in
  // test/deployment.test.cjs; DevTools-evaluated code is exempt from eval checks, so a
  // browser probe of `new Function` here would prove nothing.)
  await mockIndexer(page);
  await page.route('**/pools', async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(" 'wasm-unsafe-eval'", '');
    await route.fulfill({ response, body: html });
  });
  await page.goto('/pools');
  const outcome = await page.evaluate(
    async ({ loader, pool }) => {
      try {
        const mod = (await import(loader)) as { loadOotleWasmBor: () => Promise<{ decodeSubstateValue(b: string): unknown }> };
        const codec = await mod.loadOotleWasmBor();
        codec.decodeSubstateValue(pool);
        return 'decoded';
      } catch (error) {
        return `refused: ${(error as Error).message}`;
      }
    },
    { loader: `/assets/${loaderChunk}`, pool: fixture.substates[fixture.poolComponent].value },
  );
  expect(outcome).toMatch(/^refused/);
});
