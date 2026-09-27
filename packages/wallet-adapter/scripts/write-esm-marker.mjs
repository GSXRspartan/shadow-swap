// The ESM build emits `.js` files into `dist/esm/`, but the package itself is
// CommonJS (no root `"type"`), so Node would otherwise parse them as CJS. This
// marker makes the nearest package boundary declare ESM, which is the standard
// dual-package layout: `dist/*.js` stays CommonJS for `require()`, and
// `dist/esm/*.js` is ESM for `import`.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, '..', 'dist', 'esm', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
