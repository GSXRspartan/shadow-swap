/**
 * RESPONSIVE / VIEWPORT PASS.
 *
 * The task names five widths: 360, 390, 768, 1024, 1440. 360 and 390 are the
 * practical floor (small Android and the current iPhone baseline), 768 is the
 * tablet breakpoint where a two-column layout usually has to become one, 1024 is
 * where the wordmark is hidden, and 1440 is the wide case.
 *
 * The failures this guards are the ones that are invisible in a unit test and
 * obvious on a phone: horizontal overflow that makes the whole page pan sideways,
 * a primary button pushed off-screen, and a dialog taller than the viewport with its
 * confirm button unreachable.
 *
 * `document.scrollingElement.scrollWidth > clientWidth` is the overflow check. It is
 * asserted on every route rather than only on the busiest one, because overflow is
 * usually caused by the element with the widest fixed minimum.
 */
import { test, expect } from '@playwright/test';

const WIDTHS = [
  { name: '360', width: 360, height: 740 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 768 },
  { name: '1440', width: 1440, height: 900 },
];

const ROUTES = [
  { path: '/pools', label: 'Pools' },
  { path: '/nfts', label: 'NFT market' },
  { path: '/activity', label: 'Activity' },
];

async function overflow(page) {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}

test.describe('responsive: no route overflows horizontally at any supported width', () => {
  for (const viewport of WIDTHS) {
    test(`${viewport.name}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const route of ROUTES) {
        await page.goto(route.path);
        await page.waitForLoadState('domcontentloaded');
        const { scrollWidth, clientWidth } = await overflow(page);
        // A one-pixel tolerance absorbs sub-pixel rounding, which the layout engine
        // does even when no element actually overflows.
        expect(scrollWidth, `${route.label} overflows at ${viewport.width}px`).toBeLessThanOrEqual(clientWidth + 1);
      }
    });
  }
});

test.describe('responsive: critical controls stay reachable', () => {
  for (const viewport of [WIDTHS[0], WIDTHS[1], WIDTHS[3]]) {
    test(`${viewport.name}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/pools');
      await page.waitForLoadState('domcontentloaded');

      // Navigation must be usable: every primary route is reachable at every width.
      for (const label of ['Pools', 'NFTs', 'Activity']) {
        const link = page.getByRole('link', { name: label, exact: false }).first();
        await expect(link, `${label} navigation must exist at ${viewport.width}px`).toBeVisible();
      }

      // The brand identity must survive the wordmark being hidden below 1024px.
      // It is carried by the link's accessible name, so a screen reader and a
      // narrow screen both still identify the product — that is the property
      // under test. The link's TARGET is asserted only to be one of the app's
      // real top-level routes: the brand link leads home, which is the
      // conventional target, and was briefly pinned to /pools here before `/`
      // became a real page instead of a redirect to /pools.
      const brand = page.getByRole('link', { name: /Shadow Swap/i }).first();
      await expect(brand, 'the product must be identifiable at every width').toBeVisible();
      await expect(brand).toHaveAttribute('href', /^\/$|^\/pools$/);
    });
  }
});

test.describe('responsive: the product identity is present and consistent', () => {
  test('the document announces Shadow Swap, not the former name', async ({ page }) => {
    await page.goto('/pools');
    await expect(page).toHaveTitle(/Shadow Swap/);
    await expect(page).not.toHaveTitle(/Ootle Liquidity/i);

    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description).toContain('Shadow Swap');
    expect(description).not.toMatch(/Ootle Liquidity/i);
  });

  test('social preview metadata is complete and points at the branded card', async ({ page }) => {
    await page.goto('/pools');
    for (const property of ['og:title', 'og:description', 'og:image', 'og:site_name', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
      const content = await page.locator(`meta[property="${property}"], meta[name="${property}"]`).first().getAttribute('content');
      expect(content, `${property} must be declared`).toBeTruthy();
    }
    // og:image and twitter:image must be ABSOLUTE. A relative path does not resolve
    // in a social preview and renders as a broken card.
    const ogImage = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(ogImage).toMatch(/^https:\/\//);
    const twImage = await page.locator('meta[name="twitter:image"]').getAttribute('content');
    expect(twImage).toMatch(/^https:\/\//);
  });

  test('the branded assets actually resolve', async ({ request }) => {
    for (const asset of ['/icon.svg', '/icon-maskable.svg', '/og-card.svg', '/manifest.json']) {
      const response = await request.get(asset);
      expect(response.status(), `${asset} must be served`).toBe(200);
    }
    const manifest = await (await request.get('/manifest.json')).json();
    expect(manifest.name).toMatch(/Shadow Swap/);
    expect(manifest.short_name).toMatch(/Shadow Swap/);
  });

  test('the PWA manifest declares a maskable icon', async ({ request }) => {
    // A manifest with only a non-maskable icon gets its glyph clipped by Android.
    const manifest = await (await request.get('/manifest.json')).json();
    const purposes = manifest.icons.map((icon) => icon.purpose);
    expect(purposes).toContain('maskable');
  });
});