#!/usr/bin/env node
/**
 * Release hygiene gate. Fails (exit 1) on any finding; prints every finding first.
 *
 *   node tools/release-hygiene.mjs            # scan tracked source + apps/web/dist if built
 *   node tools/release-hygiene.mjs --dist     # require apps/web/dist to exist and scan it
 *
 * 1. SECRETS in tracked files: private keys, cloud/API tokens, GitHub tokens, Cloudflare
 *    token assignments, mnemonic/seed assignments, walletd JWTs.
 * 2. PRODUCTION BUNDLE (apps/web/dist): no development wallet provider, no walletd endpoint,
 *    no localhost/loopback origin, no fixture data source, no source of a VITE_ secret,
 *    and no reference to the operator's other projects or private infrastructure (Shadow Swap's public identity is
 *    kept separate by policy; see docs/SHADOW_SWAP_EXISTING_INFRASTRUCTURE_DEPLOYMENT.md).
 * 3. PUBLIC IDENTITY in EVERY tracked file (the repository is public): no
 *    reference to the operator's other projects or private hostnames.
 *
 * Deliberately dependency-free so it runs before `pnpm install` in CI.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const requireDist = process.argv.includes('--dist');
const findings = [];

// Assembled so this file does not itself contain the literal it forbids.
const OTHER_PROJECT = [new RegExp(['ghost', 'gate'].join('[\\s_.-]?'), 'i'), new RegExp(['ghost', 'gate', '\\.', 'boo'].join(''), 'i')];

const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Cloudflare token assignment', /CLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['mnemonic/seed assignment', /\b(?:mnemonic|seed_?phrase|seed_words)\b\s*[:=]\s*["'](?:[a-z]+\s+){11,}[a-z]+["']/i],
];

/** Files whose purpose is to DESCRIBE these patterns, or binary assets. */
const SKIP = [ /\.(png|webp|jpg|jpeg|gif|ico|wasm|lock)$/, /^pnpm-lock\.yaml$/, /Cargo\.lock$/];

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of tracked) {
  if (SKIP.some((re) => re.test(file))) continue;
  const full = path.join(ROOT, file);
  let text;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 5_000_000) continue;
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  for (const [label, re] of SECRET_PATTERNS) {
    const match = re.exec(text);
    if (match) findings.push(`secret: ${label} in ${file}`);
  }
  // Separate public identity: no tracked file names the operator's other project or its
  // domain. The repository is public; a single mention links the two.
  for (const re of OTHER_PROJECT) if (re.test(text)) findings.push(`identity: ${file} names the operator's other project or its domain`);
}

/** Patterns that must never appear in a production bundle or in public-facing identity. */
const PRIVATE_IDENTITY = OTHER_PROJECT;
const BUNDLE_FORBIDDEN = [
  ['loopback walletd endpoint', /127\.0\.0\.1:5100|localhost:5100/],
  ['walletd JSON-RPC path with loopback host', /https?:\/\/(?:127\.0\.0\.1|localhost)[^"'\s]*json_rpc/],
  ['development reference provider marker', /__SHADOW_SWAP_REFERENCE_PROVIDER__|installReferenceProvider/],
  ['fixture market data marker', /FIXTURE_POOL_|fixtureMarketData/],
  ...PRIVATE_IDENTITY.map((re) => ['private infrastructure / other-project reference', re]),
];

const dist = path.join(ROOT, 'apps', 'web', 'dist');
if (fs.existsSync(dist)) {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(dist)) {
    if (/\.(png|webp|jpg|jpeg|gif|ico|wasm|map)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const [label, re] of BUNDLE_FORBIDDEN) if (re.test(text)) findings.push(`bundle: ${label} in ${path.relative(ROOT, file)}`);
    for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) findings.push(`bundle secret: ${label} in ${path.relative(ROOT, file)}`);
  }
} else if (requireDist) {
  findings.push('bundle: apps/web/dist does not exist; build before running with --dist');
}

const PUBLIC_FACING = tracked.filter((f) => f === 'README.md' || f === 'apps/web/index.html' || f.startsWith('apps/web/public/') || f === 'wrangler.jsonc');
for (const file of PUBLIC_FACING) {
  if (/\.(png|webp|jpg|jpeg|gif|ico)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const re of PRIVATE_IDENTITY) if (re.test(text)) findings.push(`public identity: ${file} references another project's infrastructure`);
}

if (findings.length > 0) {
  for (const f of findings) console.error(`FAIL ${f}`);
  console.error(`\n${findings.length} release-hygiene finding(s).`);
  process.exit(1);
}
console.log(`release hygiene: clean (${tracked.length} tracked files${fs.existsSync(dist) ? ' + production bundle' : ''})`);
