# Shadow Swap — Cloudflare + VPS deployment procedure

Date: 2026-11-09. Branch: `codex/ootle-v0501-pool` (head at time of writing: see `git log`).

Both production paths are static, and both serve the same `apps/web/dist` build. There
are no secrets in it and no pricing/state fabricated inside it.

## Option A — Cloudflare Pages (supported host)

Pages consumes `dist/_headers` and `dist/_redirects` (CSP/`frame-ancestors` for
Universe iframe embedding, cache rules, SPA 200-rewrite). GitHub Pages **cannot**
serve these and is therefore NOT a supported target.

1. **Operator prerequisite (one-time):** in the Cloudflare dashboard, check whether
   Pages project `ootle-liquidity-testnet` exists (`Workers & Pages → ...`). It is
   NOT deployed yet (`ootle-liquidity-testnet.pages.dev` is NXDOMAIN). If missing,
   create it as a **Direct Upload** project with exactly that name. Do NOT attach a
   custom domain yet.
2. **Operator prerequisite:** Cloudflare API token with ONLY `Account → Cloudflare
   Pages → Edit`. Add to GitHub → Settings → Secrets → Actions:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   Optionally: environment `cloudflare-pages-testnet` with required reviewers.
3. **Every deployment**: GitHub → Actions → *Deploy testnet frontend to Cloudflare Pages*
   → Run workflow with `confirm_project = true`, `target = preview`,
   `preview_branch = staging`, `reason = <why>`.
   - Jobs: `build` (frozen lockfile, artifact validation, bundle hygiene) →
     `deploy` (wrangler 4.151.0, branch alias `staging.ootle-liquidity-testnet.pages.dev`)
     → `verify` (verify-live-headers + smoke against the printed URL).
4. Rollback: dashboard → Pages → project → Deployments → *Rollback to this deployment*.
5. Custom domain later (after preview verified): add CNAME `shadow` and apex binding;
   no `X-Frame-Options` or CSP change is needed — `_headers` carries the whole policy.

## Option B — VPS (already reviewed artifacts)

`deploy/vps/` holds Caddy + compose configs, `release.sh` atomic deploy/rollback,
header rendering, and `inventory-readonly.sh` (the most dangerous step in the whole
stack — wallet RPC — stays local and `127.0.0.1`-only).

Market indexer (`tools/market-indexer/`, Dockerized, compose provided): serves `/api/v1/*`
on loopback only (`tools/market-indexer/docker-compose.yml`). To expose market history
to the frontend on the VPS, add this to `Caddyfile.container` before the SPA fallback:

```caddy
reverse_proxy /api/* 127.0.0.1:8089
```

The frontend can fetch `GET /api/v1/trades?pool=<component>` from its own origin
(same-origin → no CSP change required). The sidecar is optional: the app is fully
usable without it (it only supplies market-wide trade history).

## Local-only verifications (no deploy)
- `pnpm --filter @tari-ootle/web test` — 663/663 green.
- `pnpm --filter @tari-ootle/web build` — clean.
- `node apps/web/scripts/smoke-deployment.mjs` — 20/20 (local).

## Not yet done
- Pages project + secrets + preview deploy (operator). Real-wallet acceptance (operator).
- `tools/market-indexer` VPS deployment (optional; never exposes wallets).
