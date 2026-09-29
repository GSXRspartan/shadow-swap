# Testnet static hosting

The Ootle Liquidity frontend is a static bundle. It is served by **Cloudflare
Pages**, because that host actually consumes the `dist/_headers` file the build
emits, and therefore actually delivers the security response headers.

## Why not GitHub Pages

GitHub Pages ignores `dist/_headers` entirely. It has no equivalent mechanism, so
a build that emits correct headers and deploys there delivers **no** CSP,
`frame-ancestors`, COOP, `X-Content-Type-Options`, `Referrer-Policy`, or
`Permissions-Policy` to any browser. That was the state recorded as risk **R-1**:
the headers were authored and unit-tested, and served to nobody.

This is why the previous workflow asserted `test -f apps/web/dist/_headers` and
then uploaded to a host that never read it. A build-time existence check is not
a delivery guarantee.

## Configuration

| Setting | Value | Where |
|---|---|---|
| Platform | Cloudflare Pages | `wrangler.jsonc` (`pages_build_output_dir`) |
| Pages project name | `ootle-liquidity-testnet` | `wrangler.jsonc` `name`, and pinned as an env var in `.github/workflows/cloudflare-pages.yml` |
| Build command | `pnpm --filter @tari-ootle/web build` | Cloudflare dashboard, or the deploy workflow |
| Build output directory | `apps/web/dist` | `wrangler.jsonc` and the dashboard must agree |
| Node | 20 | matches `.github/workflows/*` |
| pnpm | 9.15.9 | pinned by `packageManager`, matched to `pnpm-lock.yaml` |
| Install | `pnpm install --frozen-lockfile` | same as CI |
| Deployment trigger | manual `workflow_dispatch` only | `.github/workflows/cloudflare-pages.yml` |

`pnpm --filter @tari-ootle/web build` runs `build:test` (a CommonJS compile of
`test/`), then `vite build`, then `scripts/write-deployment-headers.mjs`, which
writes `dist/_headers` **and** `dist/_redirects` from
`apps/web/src/lib/deploymentHeaders.ts`.

The output directory is `apps/web/dist`, not a repository-root `dist/`. The
build must not be changed to emit elsewhere without updating both
`wrangler.jsonc` and the dashboard, because a mismatch deploys a stale or empty
site rather than failing loudly.

## SPA routing

The build emits `dist/_redirects` containing exactly one rule:

```
/*  /index.html  200
```

This is a **200 rewrite**, not a redirect, so the browser URL stays on `/pools`
and a reload or a pasted deep link keeps working. Cloudflare Pages resolves
static assets before applying `_redirects`, so the rule cannot shadow
`/assets/*`, and `_redirects` carries no header rules, so it cannot weaken
`dist/_headers`.

It is emitted explicitly rather than relying on Pages' "no `404.html`, so fall
back to `index.html`" default, because that default is host behaviour that no
test in this repository can assert. `/pools` is not cosmetic: it is the deep
route the clickjacking test uses, so a deployment where deep routes do not resolve
directly cannot be verified for `frame-ancestors` at all.

## Source control stays on GitHub

GitHub remains the source repository, the pull-request review surface, and CI.
Only static hosting is intended to move.

**Current state: no deployment has been performed, and no Cloudflare credential
is present in this environment.** There is no `CLOUDFLARE_API_TOKEN` or
`CLOUDFLARE_ACCOUNT_ID` available here, and `wrangler` is not installed. That is
why risk **R-1 is OPEN / BLOCKED_EXTERNAL**: the headers are authored,
unit-tested, browser-tested against the local server, and written into
`dist/_headers`, but have never been observed coming from a real HTTPS URL.

Everything that can be prepared without an account **has** been prepared:

- `.github/workflows/cloudflare-pages.yml` — the deploy workflow, manual-dispatch
  only, fail-closed on a missing token, with the target project name **pinned**
  so a broadly-scoped token cannot redirect the build to an unrelated Pages
  project.
- It refuses to deploy unless `dist/_headers`, `dist/_redirects`,
  `frame-ancestors`, the wallet dApp origin, and the live indexer origin are all
  present in the built artifacts.
- It deliberately does **not** mark R-1 closed. A successful deploy says nothing
  about whether headers were delivered; only the verification run below does. The
  workflow prints the command to run.
- `apps/web/scripts/verify-live-headers.mjs` — the verification tool (below).

### Exact minimal closure procedure for R-1

1. Create a Cloudflare API token with `Account / Cloudflare Pages / Edit` only,
   scoped to the Pages project `ootle-liquidity-testnet`. Store it as the
   repository secret `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`. Never
   commit it.
2. Build exactly as CI does: `pnpm install --frozen-lockfile` then
   `pnpm --filter @tari-ootle/web build`.
3. Deploy `apps/web/dist` (the `pages_build_output_dir` value) with
   `npx wrangler pages deploy apps/web/dist --project-name=ootle-liquidity-testnet`,
   or trigger `.github/workflows/cloudflare-pages.yml` manually. The build output
   directory in the Cloudflare dashboard must agree with `wrangler.jsonc`.
4. Verify the live URL — see below. **This is the step that closes R-1.**
5. Record the URL, the timestamp, and the observed header values in
   `security/FRONTEND_RESIDUAL_RISKS.md` and
   `security/FRONTEND_HOSTILE_AUDIT_REPORT.md`.

## Verifying a deployment

Header presence must be checked over the network, against the real URL. One
command does the whole set of checks and exits non-zero on any mismatch:

```bash
pnpm --filter @tari-ootle/web run verify:live-headers https://<deployment-host>
```

It checks, and fails on:

- `/` returning 200 and carrying a real CSP **response** header (a meta CSP
  silently ignores `frame-ancestors`, so a response header is the only thing that
  counts);
- that CSP containing `frame-ancestors` naming `https://universe.tari.mw`;
- `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, and CORP present
  **with the authored values**;
- `X-Frame-Options` absent and CORP not `same-origin`, since either would
  silently break the wallet dApp iframe;
- no wildcard source, no `unsafe-eval`, and no `http://` source in the policy;
- `/pools` — a deep SPA route — returning 200 directly and carrying the same
  CSP, so a host protecting only `/` fails;
- a hashed `/assets/*.js` file being served **as JavaScript** with an immutable
  `Cache-Control` and the CSP, which catches an SPA rewrite that shadows assets;
- no `http://` subresource in the served document (mixed content);
- no credential-shaped literal in the served document.

It is read-only: it issues `GET`/`HEAD` only, sends no credentials, deploys
nothing, and refuses a non-`https://` origin because an HTTP origin cannot close
R-1.

The raw curl equivalent, if a browser-independent look is wanted:

```bash
curl -sSI https://<deployment-host>/        | grep -i -E 'content-security-policy|cross-origin|x-content|referrer|permissions'
curl -sSI https://<deployment-host>/pools   | grep -i content-security-policy
curl -sSI https://<deployment-host>/assets/<hashed>.js | grep -i -E 'cache-control|content-security-policy|content-type'
```

`/pools` matters as much as `/`: it is a client-side route served the same HTML
document, and it is a document a user can be clickjacked on. A host that
protected only `/` would pass a shallow check.

`apps/web/scripts/serve-headers.mjs` implements the same `_headers` grammar
locally, and `apps/web/e2e/hosting.spec.ts` drives a real browser against it to
prove the policy is enforced rather than merely present. That is a test of the
policy's semantics; it is **not** a substitute for querying the deployed URL, and
R-1 is only closed by the latter.

