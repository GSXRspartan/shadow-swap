// The test build emits CommonJS, but this package is `"type": "module"`. Drop a
// `package.json` into the output directory so Node treats those files as CJS and
// the `.cjs` test files can `require()` them.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'build-test');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
