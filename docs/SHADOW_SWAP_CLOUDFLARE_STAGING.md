# Shadow Swap — Cloudflare Pages Staging and Preview

Operator runbook. Nothing in this campaign deployed anything, created a project, or changed
DNS. Every step below is a manual decision.

## 1. What gets deployed

A static bundle (`apps/web/dist`): HTML, hashed JS/CSS, the Ootle v0.48 value decoder
(`assets/ootle_wasm_bor_bg-*.wasm`, 473 351 bytes), `_headers` (CSP, nosniff, COOP/CORP,
Referrer-Policy, Permissions-Policy, immutable `/assets/*`) and `_redirects` (SPA fallback,
200 rewrite). No Pages Functions, no Workers, no KV/D1/R2, no paid feature, no secret in the
bundle (CI scans it).

## 2. One-time setup (operator)

1. In the **existing** Cloudflare account, check whether the Pages project
   `ootle-liquidity-testnet` already exists (Dashboard → Workers & Pages). As of 2026-10-17
   `ootle-liquidity-testnet.pages.dev` was NXDOMAIN, i.e. never deployed.
   - If it does not exist, create it as a **Direct Upload** project with exactly that name
     (the workflow pins it; it never creates or renames projects). Do **not** attach a custom
     domain yet (see the domain section of `SHADOW_SWAP_EXISTING_INFRASTRUCTURE_DEPLOYMENT.md`).
2. Create an API token with **only** `Account → Cloudflare Pages → Edit` for that account.
3. In GitHub → Settings → Secrets and variables → Actions, add `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. Optionally add a `cloudflare-pages-testnet` environment with
   required reviewers so every deploy needs a second click.

## 3. Preview deployment

GitHub → Actions → *Deploy testnet frontend to Cloudflare Pages* → Run workflow:

- `confirm_project`: ✔
- `target`: **preview** (default)
- `preview_branch`: e.g. `staging`
- `reason`: free text, recorded in the run summary

Jobs: **build** (frozen lockfile, artifact validation, bundle hygiene) → **deploy** (pinned
wrangler 4.151.0, branch alias) → **verify** (no secrets: `verify-live-headers` + 
`smoke-deployment.mjs` against the URL wrangler printed). A preview lives at
`https://<branch>.ootle-liquidity-testnet.pages.dev` and at a per-deployment hash URL.

**Previews are publicly reachable** unless protected. For an access-restricted preview, add a
Cloudflare Access application (Zero Trust → Access → Applications → Self-hosted) covering
`*.ootle-liquidity-testnet.pages.dev` with an email allow-list. Access is part of the free
Zero Trust tier for small teams; confirm the plan before enabling.

## 4. Production deployment

Same workflow, `target: production`, dispatched **from `main`** (the gate refuses any other
ref). Only after: gates G and I pass, the preview verify job is green, and the release
readiness document says so.

## 5. Post-deployment checks (also run by the verify job)

```bash
pnpm --filter @tari-ootle/web run build:test
pnpm --filter @tari-ootle/web run verify:live-headers https://<deployment>.pages.dev
node apps/web/scripts/smoke-deployment.mjs https://<deployment>.pages.dev
```

The smoke test covers: every SPA route (including deep links and an unknown route) → 200
application document; every referenced asset with a script/style content type; the decoder
`.wasm` as `application/wasm` at the pinned size; icon/manifest/social card; no loopback or
`http://` subresource; and both v0.48 indexers answering `/info` as esmeralda/byte 38 on a
supported version with CORS permitting the browser.

Then, by hand in a real browser with the wallet extension: connect, confirm the network
badge, confirm DevTools shows **no CSP violation**, and follow
`SHADOW_SWAP_WINDOWS_LIVE_ACCEPTANCE.md` for any write.

## 6. Caching

- `/assets/*` are content-hashed: `Cache-Control: public, max-age=31536000, immutable`.
- `index.html` and SPA routes are revalidated by Pages on each deployment, so a rollback or
  redeploy takes effect immediately for new page loads. No service worker is registered
  (none exists in the app), so nothing pins an old version in the browser.

## 7. Rollback and incident response

- **Rollback**: Dashboard → Pages → `ootle-liquidity-testnet` → Deployments → choose the last
  good deployment → *Rollback to this deployment*. Instant, no rebuild. Alternatively
  re-dispatch the workflow from the last good commit.
- **Kill switch** (a serious frontend defect): roll back to a known-good deployment, or deploy
  a build from a commit that shows a maintenance notice. The contracts are ownerless and
  keep working through any wallet; taking the site down never strands funds.
- **Suspected malicious change** (e.g. a compromised dependency): roll back first, revoke and
  rotate `CLOUDFLARE_API_TOKEN`, review the deploy run's commit and lockfile diff, then
  redeploy only from a reviewed commit.
- Record every deploy/rollback (time, deployment id, commit, reason) in the PR or release notes.

## 8. What staging does NOT prove

Header delivery and asset serving, yes. It does not prove real wallet approval, live
settlement, or that the reset network has Shadow Swap templates — those are gates G and I.
