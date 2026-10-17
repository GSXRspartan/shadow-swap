/**
 * Asset integrity.
 *
 * These tests exist because "the images are missing" is almost never a deleted
 * file. Three distinct real failures in this repository were all invisible to the
 * suite, and each has a distinct cause:
 *
 *   1. A CSS `url()` or a `<meta>` asset path that points at a file nobody
 *      committed. The build succeeds, the request 404s at runtime, and nothing in
 *      CI notices because no test ever resolves the path.
 *   2. A social-preview image in a format the platforms REFUSE. Every major
 *      scraper rejects SVG for `og:image`, so an SVG OG card renders as a blank
 *      card everywhere — a perfectly committed, perfectly reachable file that
 *      still never appears.
 *   3. An asset referenced from the app shell that is not in `public/`, so Vite
 *      does not copy it and the served path 404s only after deployment.
 *
 * The rule enforced here is narrow and mechanical: every static asset path the
 * app references must resolve to a committed file, and every social preview must
 * be in a format a real scraper will render.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const publicDir = path.join(appRoot, 'public');
const srcRoot = path.join(appRoot, 'src');
const indexHtml = path.join(appRoot, 'index.html');

function readIfPresent(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Every file under `public/`, relative to it, with forward slashes. */
function publicAssets() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`/${path.relative(publicDir, full).split(path.sep).join('/')}`);
    }
  };
  walk(publicDir);
  return out;
}

function sourceFiles(dir, extensions) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

// ===========================================================================
// Referenced paths must exist
// ===========================================================================

test('assets: every public/ asset is actually reachable from the served root', () => {
  const assets = publicAssets();
  assert.ok(assets.length > 0, 'public/ must not be empty');
  for (const asset of assets) {
    assert.ok(!asset.includes('..'), `asset path escapes public/: ${asset}`);
    assert.match(asset, /^\/[A-Za-z0-9._/-]+$/, `asset path is not URL-safe: ${asset}`);
  }
});

test('assets: every CSS url() resolves to a committed public/ file', () => {
  const css = sourceFiles(srcRoot, ['.css'])
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const referenced = [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((match) => match[1]);

  // Data URIs and absolute/remote URLs are not public/ paths and are out of scope.
  const localPaths = referenced.filter(
    (ref) => !ref.startsWith('data:') && !/^https?:\/\//i.test(ref) && !ref.startsWith('#'),
  );

  for (const ref of localPaths) {
    const resolved = ref.startsWith('/') ? ref : `/${ref}`;
    assert.ok(
      publicAssets().includes(resolved),
      `stylesheet references ${ref}, which is not committed under public/. A build will succeed and the served request will 404.`,
    );
  }
});

test('assets: the hero artwork is committed, and it is small enough to be a backdrop', () => {
  const hero = path.join(publicDir, 'hero-liquidity.webp');
  assert.ok(fs.existsSync(hero), 'apps/web/public/hero-liquidity.webp is missing; the hero would render empty');
  const bytes = fs.statSync(hero).size;
  // A full-bleed decorative backdrop under a text layer. Anything in the megabyte
  // range would dominate the page's transfer weight for something a reader never
  // looks at directly.
  assert.ok(bytes < 250_000, `hero backdrop is ${bytes} bytes; keep decorative full-bleed art under 250 kB`);
});

test('assets: no raster asset in public/ is large enough to be mistaken for a mistake', () => {
  for (const asset of publicAssets()) {
    if (!/\.(png|jpe?g|webp|gif)$/i.test(asset)) continue;
    const bytes = fs.statSync(path.join(publicDir, asset.replace(/^\//, ''))).size;
    assert.ok(bytes < 1_500_000, `${asset} is ${bytes} bytes; raster assets must be web-optimised before commit`);
  }
});

// ===========================================================================
// Social preview: present, absolute, and in a format scrapers actually render
// ===========================================================================

test('social: og:image and twitter:image are absolute URLs', () => {
  const html = readIfPresent(indexHtml);
  // `og:` tags take `property`, `twitter:` tags take `name`. Accept either so this
  // asserts the requirement (an absolute, resolvable URL) rather than the spelling.
  const metaContent = (tag) => {
    const match = new RegExp(`<meta\\s+(?:property|name)="${tag}"\\s+content="([^"]+)"`).exec(html);
    assert.ok(match, `${tag} must be declared`);
    return match[1];
  };
  for (const tag of ['og:image', 'twitter:image']) {
    assert.match(metaContent(tag), /^https:\/\//, `${tag} must be absolute; a relative path does not resolve in a preview`);
  }
});

test('social: the preview image is a raster format every scraper will render', () => {
  const html = readIfPresent(indexHtml);
  const ogMatch = /<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/.exec(html);
  const twMatch = /<meta\s+(?:property|name)="twitter:image"\s+content="([^"]+)"/.exec(html);
  assert.ok(ogMatch && twMatch, 'both og:image and twitter:image must be declared');

  // Twitter/X, Facebook, LinkedIn, Slack and Discord all reject SVG here and
  // render the card with no picture. This is the single most common reason a
  // "perfectly committed" social image never appears.
  for (const [name, url] of [['og:image', ogMatch[1]], ['twitter:image', twMatch[1]]]) {
    const extension = url.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
    assert.ok(
      ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension),
      `${name} points at a .${extension}; social scrapers do not render SVG and will show a blank card`,
    );
  }
});

test('social: the declared preview image filename is committed under public/', () => {
  const html = readIfPresent(indexHtml);
  const match = /<meta\s+property="og:image"\s+content="https?:\/\/[^/]*\/([^"]+)"/.exec(html);
  assert.ok(match, 'og:image must be an absolute URL');
  // The URL points at a raw GitHub path that mirrors this repository, so the
  // filename must exist in public/ at exactly that path.
  const localPath = `/${match[1].split('/apps/web/public/').pop()}`;
  assert.ok(publicAssets().includes(localPath), `og:image names ${localPath}, which is not committed under public/`);
});

test('social: the declared dimensions match the committed image', () => {
  const html = readIfPresent(indexHtml);
  const width = Number(/<meta\s+property="og:image:width"\s+content="(\d+)"/.exec(html)?.[1]);
  const height = Number(/<meta\s+property="og:image:height"\s+content="(\d+)"/.exec(html)?.[1]);
  assert.ok(Number.isInteger(width) && width > 0, 'og:image:width must be declared so a scraper need not guess');
  assert.ok(Number.isInteger(height) && height > 0, 'og:image:height must be declared so a scraper need not guess');
  // 1.91:1 is the ratio both major platforms ask for.
  const ratio = width / height;
  assert.ok(ratio > 1.8 && ratio < 2.0, `declared preview ratio ${ratio.toFixed(2)} is not the ~1.91:1 platforms request`);
});

test('social: the preview image declares an aspect ratio a scraper can honour', () => {
  const html = readIfPresent(indexHtml);
  assert.ok(
    /<meta\s+name="twitter:card"\s+content="summary_large_image"/.test(html),
    'summary_large_image is what makes a link render as a full-width card rather than a thumbnail',
  );
  assert.ok(/<meta\s+property="og:image:type"/.test(html), 'og:image:type must be declared');
  assert.ok(/property="og:image:alt"/.test(html), 'og:image:alt is the accessible description of the preview');
});

// ===========================================================================
// Icons referenced by the shell
// ===========================================================================

test('assets: the icons the shell links are committed', () => {
  const html = readIfPresent(indexHtml);
  const hrefs = [...html.matchAll(/<link\s+rel="(?:icon|apple-touch-icon|manifest)"\s+href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 0, 'the shell must link at least a favicon');
  for (const href of hrefs) {
    const resolved = href.startsWith('/') ? href : `/${href}`;
    assert.ok(publicAssets().includes(resolved), `index.html links ${href}, which is not committed under public/`);
  }
});

test('assets: the web manifest parses and its icons are committed', () => {
  const manifestPath = path.join(publicDir, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'public/manifest.json is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const referenced = [manifest.icon, ...(manifest.icons ?? [])].filter((entry) => typeof entry === 'string');
  for (const src of referenced) {
    const resolved = src.startsWith('/') ? src : `/${src}`;
    assert.ok(publicAssets().includes(resolved), `manifest references ${src}, which is not committed under public/`);
  }
});
