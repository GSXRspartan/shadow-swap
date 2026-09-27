/**
 * A static server that ACTUALLY enforces `dist/_headers`.
 *
 * This exists because the finding that started this work (R-1) was precisely
 * that the app's security headers were authored, asserted by a unit test, and
 * then delivered to nobody: the previous host ignores `_headers`. Asserting on
 * the generated file proves only that a string was produced.
 *
 * This server implements the `_headers` grammar as Cloudflare Pages documents
 * it, so a browser talking to it is testing the real policy semantics:
 *
 *   - `#` starts a comment;
 *   - a non-indented, non-comment line is a path rule;
 *   - indented lines beneath a rule are the headers for that rule;
 *   - rules are matched against the request path, most specific wins;
 *   - a rule with no headers inherits nothing, it only adds.
 *
 * It also serves the SPA fallback, and CRITICALLY applies the headers to the
 * fallback document: a client-side route like /pools must be protected by the
 * same policy as `/`, and a host that only protected the entry point would pass
 * a naive test while leaving every deep route clickjackable.
 *
 * Usage: node scripts/serve-headers.mjs [--port 4180] [--root dist] [--check]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
const port = Number(arg('port', '4180'));
const root = path.resolve(appRoot, arg('root', 'dist'));
const checkOnly = args.includes('--check');

/**
 * Parse a `_headers` file into `[{ pathPattern, headers: [[name, value]] }]`.
 * Throws on a malformed entry rather than silently dropping it, because a
 * silently dropped header is exactly the failure this project already had once.
 */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    if (line.trimStart().startsWith('#')) continue; // comment, any indentation
    const indented = /^\s/.test(line);
    if (!indented) {
      current = { pathPattern: line.trim(), headers: [], line: i + 1 };
      rules.push(current);
      continue;
    }
    if (current === null) {
      throw new Error(`_headers line ${i + 1} is indented but has no path rule above it: ${JSON.stringify(line)}`);
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      throw new Error(`_headers line ${i + 1} is not "Name: value": ${JSON.stringify(line)}`);
    }
    current.headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  return rules;
}

/** Cloudflare-style pattern match: exact path, `/*` prefix, or `*`. */
function patternMatches(pattern, pathname) {
  if (pattern === '/*' || pattern === '*') return true;
  if (pattern === pathname) return true;
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return false;
}

/** All rules that match, in file order, so a later rule can add headers. */
export function headersFor(rules, pathname) {
  const out = [];
  for (const rule of rules) {
    if (patternMatches(rule.pathPattern, pathname)) {
      for (const [name, value] of rule.headers) out.push([name, value]);
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function createServer({ root: servedRoot }) {
  const headersPath = path.join(servedRoot, '_headers');
  if (!fs.existsSync(headersPath)) {
    throw new Error(`no _headers in ${servedRoot}: the security policy would be delivered to nobody`);
  }
  const rules = parseHeadersFile(fs.readFileSync(headersPath, 'utf8'));

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // Resolve the file, refusing any traversal outside the served root.
    const candidate = path.join(servedRoot, pathname);
    const resolved = path.resolve(candidate);
    const withinRoot = resolved === path.resolve(servedRoot) || resolved.startsWith(path.resolve(servedRoot) + path.sep);

    let file = null;
    let status = 200;
    if (withinRoot && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      file = resolved;
    } else {
      // SPA fallback. The headers MUST be applied here too: a deep route such
      // as /pools is served this document, and it is the document the browser
      // will be clickjacked on.
      file = path.join(servedRoot, 'index.html');
      status = 200;
    }

    const headers = headersFor(rules, pathname);
    for (const [name, value] of headers) res.setHeader(name, value);
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.statusCode = status;
    fs.createReadStream(file).pipe(res);
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const rules = parseHeadersFile(fs.readFileSync(path.join(root, '_headers'), 'utf8'));
  const applied = headersFor(rules, '/pools');
  if (checkOnly) {
    console.log(`parsed ${rules.length} rule(s) from ${path.join(root, '_headers')}`);
    for (const rule of rules) console.log(`  ${rule.pathPattern} -> ${rule.headers.length} header(s)`);
    console.log(`headers applied to /pools: ${applied.length}`);
    for (const [n, v] of applied) console.log(`  ${n}: ${v}`);
    process.exit(0);
  }
  const server = createServer({ root });
  server.listen(port, '127.0.0.1', () => {
    console.log(`serving ${root} with ${rules.length} _headers rule(s) on http://127.0.0.1:${port}`);
  });
}
