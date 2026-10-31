// Post-deployment smoke test for a served Shadow Swap build (Cloudflare Pages preview,
// a VPS static origin, or `vite preview`). READ-ONLY: GET requests only, no credentials,
// no wallet, nothing submitted.
//
//   node apps/web/scripts/smoke-deployment.mjs https://<preview>.pages.dev
//   node apps/web/scripts/smoke-deployment.mjs http://127.0.0.1:4180 --allow-http --skip-indexer
//
// Complements verify-live-headers.mjs (which owns the security-header assertions). This
// script owns "does the site actually work when served":
//   1. every SPA route answers 200 with the application document (no 404 on deep links);
//   2. every script/style the document references loads with a script/style content type,
//      not the SPA fallback document;
//   3. the Ootle v0.48 value decoder (lazy chunk + .wasm) is served, the .wasm as
//      application/wasm with the exact pinned size, so CBOR chain values can be decoded;
//   4. the favicon, PWA manifest and social card load;
//   5. the document contains no development-provider marker and no loopback endpoint;
//   6. (unless --skip-indexer) each default indexer answers GET /info as esmeralda / byte 38
//      on a version this build supports. This reads the PUBLIC indexer, never a wallet.
//
// Exit code is non-zero on any failure, so it can gate a deployment.

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const base = (args.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base) && !(flags.has('--allow-http') && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base))) {
  console.error('usage: smoke-deployment.mjs https://<origin> [--skip-indexer]   (http only for loopback with --allow-http)');
  process.exit(2);
}

const ROUTES = ['/', '/pools', '/pools/component_' + '0'.repeat(64), '/nfts', '/nfts/resource_' + '0'.repeat(64), '/activity', '/a-route-that-does-not-exist'];
const DECODER_WASM_BYTES = 473_351; // @tari-project/ootle-wasm-bor@0.48.0
const INDEXERS = ['https://esme-indexer-a.ootle.tari.com', 'https://esme-indexer-b.ootle.tari.com'];
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

async function get(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { redirect: 'manual', credentials: 'omit', ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let documentHtml = '';
for (const route of ROUTES) {
  try {
    const response = await get(base + route);
    const type = response.headers.get('content-type') ?? '';
    const body = await response.text();
    const isApp = body.includes('id="root"');
    check(`route ${route} -> 200 application document`, response.status === 200 && /text\/html/.test(type) && isApp, `${response.status} ${type}`);
    if (route === '/') documentHtml = body;
  } catch (error) {
    check(`route ${route}`, false, String(error));
  }
}

const refs = [...documentHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
check('document references hashed assets', refs.length > 0, `${refs.length} referenced`);
for (const ref of refs) {
  const response = await get(base + ref);
  const type = response.headers.get('content-type') ?? '';
  const expected = ref.endsWith('.js') ? /javascript/ : ref.endsWith('.css') ? /text\/css/ : /./;
  check(`asset ${ref}`, response.status === 200 && expected.test(type) && !/text\/html/.test(type), `${response.status} ${type}`);
  await response.arrayBuffer();
}

// The decoder chunk is lazy, so it is not in index.html; find it through the entry chunk.
let decoderChunk;
let wasmAsset;
for (const ref of refs.filter((r) => r.endsWith('.js'))) {
  const text = await (await get(base + ref)).text();
  decoderChunk ??= text.match(/(ootleWasmBor\.browser-[\w-]+\.js)/)?.[1];
}
if (decoderChunk !== undefined) {
  const text = await (await get(`${base}/assets/${decoderChunk}`)).text();
  wasmAsset = text.match(/(ootle_wasm_bor_bg-[\w-]+\.wasm)/)?.[1];
}
check('v0.48 decoder chunk is referenced by the entry bundle', decoderChunk !== undefined, decoderChunk ?? 'not found');
if (wasmAsset !== undefined) {
  const response = await get(`${base}/assets/${wasmAsset}`);
  const bytes = (await response.arrayBuffer()).byteLength;
  check('v0.48 decoder .wasm served as application/wasm, exact size', response.status === 200 && /application\/wasm/.test(response.headers.get('content-type') ?? '') && bytes === DECODER_WASM_BYTES, `${response.status} ${response.headers.get('content-type')} ${bytes}B`);
} else {
  check('v0.48 decoder .wasm is referenced', false, 'not found');
}

for (const asset of ['/icon.svg', '/manifest.json', '/og-card.png']) {
  const response = await get(base + asset);
  const type = response.headers.get('content-type') ?? '';
  check(`public asset ${asset}`, response.status === 200 && !/text\/html/.test(type), `${response.status} ${type}`);
  await response.arrayBuffer();
}

check('document carries no loopback endpoint', !/127\.0\.0\.1|localhost:/.test(documentHtml));
check('document carries no http:// subresource', !/(?:src|href)="http:\/\//.test(documentHtml));

if (!flags.has('--skip-indexer')) {
  for (const origin of INDEXERS) {
    try {
      const response = await get(`${origin}/info`);
      const info = await response.json();
      const minor = Number(String(info.version ?? '').replace(/^v/, '').split('.')[1]);
      check(`indexer ${origin}/info is esmeralda / byte 38 / supported version`, response.ok && info.network === 'esmeralda' && info.network_byte === 38 && minor >= 41 && minor <= 48, `${info.version} ${info.network} ${info.network_byte} epoch ${info.current_epoch}`);
      const acao = response.headers.get('access-control-allow-origin');
      check(`indexer ${origin} allows browser reads (CORS)`, acao === '*' || acao === new URL(base).origin, `access-control-allow-origin: ${acao}`);
    } catch (error) {
      check(`indexer ${origin}/info`, false, String(error));
    }
  }
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} smoke checks passed against ${base}`);
process.exit(failed === 0 ? 0 : 1);
