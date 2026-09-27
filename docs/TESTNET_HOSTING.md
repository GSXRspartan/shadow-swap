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
| Build command | `pnpm --filter @tari-ootle/web build` | Cloudflare dashboard, or the deploy workflow |
| Build output directory | `apps/web/dist` | `wrangler.jsonc` and the dashboard must agree |
| Node | 20 | matches `.github/workflows/*` |
| pnpm | 9.15.9 | pinned by `packageManager`, matched to `pnpm-lock.yaml` |
| Install | `pnpm install --frozen-lockfile` | same as CI |
| Git branch | `feat/multi-asset-stablecoin-markets` | deployment is pinned to the CI-tested SHA |

`pnpm --filter @tari-ootle/web build` runs `build:test` (a CommonJS compile of
`test/`), then `vite build`, then `scripts/write-deployment-headers.mjs`, which
writes `dist/_headers` from `apps/web/src/lib/deploymentHeaders.ts`.

The output directory is `apps/web/dist`, not a repository-root `dist/`. The
build must not be changed to emit elsewhere without updating both
`wrangler.jsonc` and the dashboard, because a mismatch deploys a stale or empty
site rather than failing loudly.

## Source control stays on GitHub

GitHub remains the source repository, the pull-request review surface, and CI.
Only static hosting is intended to move.

**Current state: there is no Cloudflare deploy workflow in this repository.**
`.github/workflows/` contains `node-tests.yml`, `pages.yml`, and
`security-engine-tests.yml` only — none of them authenticates to Cloudflare.
Earlier wording in this document implied such a workflow existed; it did not, and
the claim is withdrawn. Deployment therefore happens by whatever manual process
the operator uses, and no credential is committed.

This is why risk **R-1 is OPEN / BLOCKED_EXTERNAL**: the headers are authored,
unit-tested, browser-tested against the local server, and written into
`dist/_headers`, but has never been observed coming from a real HTTPS URL.

### Exact minimal closure procedure for R-1

1. Create a Cloudflare API token with `Account / Cloudflare Pages / Edit` only,
   scoped to the Pages project `ootle-liquidity-testnet`. Store it as the
   repository secret `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if the
   account is not otherwise inferable). Never commit it.
2. Build exactly as CI does: `pnpm install --frozen-lockfile` then
   `pnpm --filter @tari-ootle/web build`, and assert
   `test -f apps/web/dist/_headers` and `grep -q frame-ancestors apps/web/dist/_headers`.
3. Deploy `apps/web/dist` (the value of `pages_build_output_dir` in
   `wrangler.jsonc`) with `npx wrangler pages deploy apps/web/dist --project-name=ootle-liquidity-testnet`,
   or add a workflow that does the same. The build output directory in the
   Cloudflare dashboard must agree with `wrangler.jsonc`.
4. Observe the headers **over the network from the deployed URL**, on `/`, on a
   client-side route such as `/pools`, and on an asset — using the curl commands
   below. All six required headers must be present, including
   `frame-ancestors 'self' https://universe.tari.mw`.
5. Only then may R-1 be moved to CLOSED, recording the URL, timestamp, and the
   observed header values as evidence.

## Verifying a deployment

Header presence must be checked over the network, against the real URL:

```bash
curl -sSI https://<deployment-host>/        | grep -i -E 'content-security-policy|cross-origin|x-content|referrer|permissions'
curl -sSI https://<deployment-host>/pools   | grep -i content-security-policy
curl -sSI https://<deployment-host>/assets/<hashed>.js | grep -i -E 'cache-control|content-security-policy'
```

`/pools` matters as much as `/`: it is a client-side route served the same HTML
document, and it is a document a user can be clickjacked on. A host that
protected only `/` would pass a shallow check.

`apps/web/scripts/serve-headers.mjs` implements the same `_headers` grammar
locally, and `apps/web/e2e/hosting.spec.ts` drives a real browser against it to
prove the policy is enforced rather than merely present. That is a test of the
policy's semantics; it is **not** a substitute for querying the deployed URL, and
R-1 is only closed by the latter.
