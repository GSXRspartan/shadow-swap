/**
 * Test bootstrap.
 *
 * Two resolution redirects so the CommonJS server-render tests can load the app
 * graph:
 *
 *  1. `lightweight-charts` is ESM-only and the chart has no server-rendered
 *     output (it is created in an effect, which `renderToString` never runs), so
 *     an inert stub is behaviourally identical here.
 *  2. The workspace packages publish ESM-shaped `exports` maps that only accept
 *     `import`. Their build output is CommonJS, so a `require` of the package
 *     specifier fails even though the file is loadable. Pointing the specifier at
 *     the built file directly bypasses the `exports` gate without changing any
 *     code under test.
 *
 * Required by any test file that transitively imports the chart or a workspace
 * package.
 */
const Module = require('node:module');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..', '..');
const STUB = require.resolve('./stubs/lightweight-charts.cjs');

const REDIRECTS = [
  [/^lightweight-charts$/, STUB],
  [/^@tari-ootle\/wallet-adapter$/, path.join(repo, 'packages', 'wallet-adapter', 'dist', 'index.js')],
  // The declared `./crosschain` subpath resolves to the CommonJS build, exactly
  // as it would for a real CommonJS consumer.
  [/^@tari-ootle\/protocol-client\/crosschain$/, path.join(repo, 'packages', 'protocol-client', 'dist', 'crosschain', 'index.js')],
  [/^@tari-ootle\/protocol-client$/, path.join(repo, 'packages', 'protocol-client', 'dist', 'index.js')],
  // Deep paths remain available for the pattern subpath, and are resolved
  // relative to the package root exactly as Node would.
  [/^@tari-ootle\/wallet-adapter\/dist\/(.*)$/, path.join(repo, 'packages', 'wallet-adapter', 'dist', '$1')],
  [/^@tari-ootle\/protocol-client\/dist\/(.*)$/, path.join(repo, 'packages', 'protocol-client', 'dist', '$1')],
];

const original = Module._resolveFilename;
Module._resolveFilename = function resolveFilename(request, ...rest) {
  for (const [pattern, target] of REDIRECTS) {
    const match = pattern.exec(request);
    if (match === null) continue;
    return typeof target === 'string' ? target.replace(/\$(\d)/g, (_, index) => match[Number(index)]) : target;
  }
  return original.call(this, request, ...rest);
};
