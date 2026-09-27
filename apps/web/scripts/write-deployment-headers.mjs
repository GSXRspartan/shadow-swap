// Writes the deployment security headers to `dist/_headers` and records the
// source-map publication decision alongside them.
//
// A meta CSP silently ignores `frame-ancestors`, so clickjacking protection has
// to come from a real response header. Generating it as part of the build means
// it cannot drift from the policy the code documents.
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');
const compiled = join(here, '..', 'build-test', 'lib', 'deploymentHeaders.js');

if (!existsSync(compiled)) {
  throw new Error('build-test/lib/deploymentHeaders.js is missing. Run "npm run build:test" before "npm run build".');
}

// The headers module is TypeScript, so it is compiled into the test build and
// required from there. This keeps ONE source of truth for the policy.
const require = createRequire(import.meta.url);
const { renderHeadersFile, SECURITY_HEADERS } = require(compiled);

writeFileSync(join(distDir, '_headers'), renderHeadersFile(), 'utf8');

/**
 * SOURCE MAP POLICY.
 *
 * Source maps are published deliberately, for debugging a testnet deployment.
 * They are not a security control and nothing here depends on them being
 * hidden: an attacker who can read the bundle already has the source.
 *
 * The decision is recorded in the emitted artifact so a reviewer sees it rather
 * than having to infer it, and the names of the map files are listed so the
 * operator can strip them without hunting.
 */
const maps = existsSync(join(distDir, 'assets')) ? readdirSync(join(distDir, 'assets')).filter((name) => name.endsWith('.map')) : [];
writeFileSync(
  join(distDir, 'SOURCE_MAP_POLICY.txt'),
  [
    'Source maps ARE published with this build, deliberately, for testnet debugging.',
    'They are not a security control: an attacker who can read the bundle already has the source.',
    'No security property in apps/web relies on source obfuscation.',
    '',
    'To strip them from a deployment, delete these files and the .map comments at the end of each bundle:',
    ...maps.map((name) => `  assets/${name}`),
    '',
    `Security headers in force (${SECURITY_HEADERS.length}):`,
    ...SECURITY_HEADERS.map((header) => `  ${header.name}: ${header.value}`),
    '',
  ].join('\n'),
  'utf8',
);
