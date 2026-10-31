# Shadow Swap — Deployment on the Operator's Existing Infrastructure

The operator already runs a Linux VPS hosting a separate, live production service, and a
Cloudflare account that holds that service's domain. This document decides how Shadow Swap
reuses that infrastructure **without** buying anything new, **without** touching the existing
service, and **without** publicly linking the two projects.

Naming policy: this repository is public. The other project and its domain are deliberately
not named here or anywhere in the repository (`tools/release-hygiene.mjs` fails CI on a
mention). They are referred to as "the existing service" and "the existing zone".

---

## 1. What is known about the existing Cloudflare infrastructure

| Fact | Status |
|---|---|
| A Cloudflare account exists and holds the existing zone | Stated by the operator |
| The account has deployed through Cloudflare before | Stated by the operator |
| Pages project `ootle-liquidity-testnet` | Pinned in `wrangler.jsonc` and the workflow. `ootle-liquidity-testnet.pages.dev` was **NXDOMAIN on 2026-10-17**: never deployed. Whether the project object exists in the account is **unverified** |
| Other Pages/Workers projects, DNS conventions, pipelines | **Unverified**: no Cloudflare credential was available to this campaign, and none was requested |

Read-only checks the operator can run (no secret leaves the machine; `wrangler login` uses the
browser):

```bash
npx wrangler@4.151.0 whoami
npx wrangler@4.151.0 pages project list          # does ootle-liquidity-testnet exist?
npx wrangler@4.151.0 pages deployment list --project-name ootle-liquidity-testnet
```

## 2. What is known or unverified about the VPS

Everything about the VPS is **unverified** from the cloud: it was not reachable, and no SSH
key or password was requested. Whether the existing service uses Nginx, Caddy, Docker,
systemd or a Cloudflare Tunnel is unknown and is not assumed. The read-only inventory in §8
establishes it.

## 3. Recommended architecture: **Option A — Cloudflare Pages, no backend**

| | A. Pages frontend | B. Existing VPS (static) | C. Hybrid (Pages + VPS service) |
|---|---|---|---|
| Needs a new backend | No | No | Yes (read-only API) |
| Risk to the existing service | **None** (VPS untouched) | Low but non-zero (shared host, reverse proxy, disk, CPU) | Same as B, plus a public API |
| Availability | Cloudflare edge | One VPS | Edge + one VPS |
| Cost | Free tier | Already paid | Already paid |
| Security headers | `_headers` natively | Must be replicated (provided, §7) | Both |
| Maintenance | Push-button deploy, instant rollback | Patching, TLS, logs, proxy config | Both, plus API hardening |
| Recovery | Dashboard rollback | Symlink rollback (`release.sh`) | Both |

**Recommendation: A.** Shadow Swap needs no server: discovery reads the public Ootle indexer
directly from the browser (CORS `*`), and every authoritative read and every transaction goes
through the user's own wallet. A backend would add attack surface and an availability
dependency without adding a capability. Pages also keeps the existing VPS entirely
out of the blast radius.

**Option B** is ready (§7) if the operator prefers the VPS. **Option C is not recommended**
now: no read-only function (discovery cache, health monitor, API shim) is justified while the
indexer serves the browser directly. Reconsider only if indexer rate limits become user-visible.

## 4. Required isolated service components

Option A: none on the VPS. One Pages project, one API token scoped to Pages:Edit, two GitHub
secrets.

Option B (only if chosen), each **new and separately named** — nothing shared with the
existing service:

| Component | Isolation |
|---|---|
| Deploy path | `/srv/shadow-swap/{releases,current,previous}` |
| Service identity | dedicated Unix user (e.g. `shadow-swap`), owns only that path |
| Web server unit | a NEW site file (nginx/Caddy) or a NEW compose project `shadow-swap` |
| Port | loopback `127.0.0.1:8088` (pick any unused port from the inventory) |
| Logs | `/var/log/nginx/shadow-swap.*` or the container's own capped log |
| Limits | container: 0.5 CPU, 128 MiB, 64 pids; nginx: per-IP rate limit, 1 KiB body |
| Wallet / signing / walletd | **none, ever** |

## 5. Domain separation strategy

1. **Now:** use the Pages URL `ootle-liquidity-testnet.pages.dev` (and branch previews). It
   carries no reference to the existing zone, and a `pages.dev` URL does not reveal which
   account owns it.
2. **Later, separately approved:** a domain of Shadow Swap's own, registered by the operator.
   Attach it in Pages → Custom domains. If that domain is added as a zone in the same
   account, it remains a separate zone; nothing about the existing zone changes.
3. **Never:** a subdomain of the existing zone. That would publicly connect the projects.
4. Nothing here purchases a domain or edits DNS.

Separate branding is a presentation choice. It does not create legal, regulatory or
operational independence, and nothing in this repository claims that it does.

## 6. Cloudflare build and configuration

| Setting | Value |
|---|---|
| Project | `ootle-liquidity-testnet` (Direct Upload; pinned, never renamed) |
| Build | in GitHub Actions: `pnpm install --frozen-lockfile`, build protocol-client, wallet-adapter, then `pnpm --filter @tari-ootle/web build` |
| Output directory | `apps/web/dist` (`wrangler.jsonc` `pages_build_output_dir`) |
| Headers / SPA | `dist/_headers`, `dist/_redirects` (generated from `apps/web/src/lib/deploymentHeaders.ts`) |
| Environment variables | none required. All `VITE_*` values are PUBLIC; never put a secret in one (`.env.example`) |
| Secrets | GitHub only: `CLOUDFLARE_API_TOKEN` (Pages:Edit), `CLOUDFLARE_ACCOUNT_ID` |
| Workflow | `.github/workflows/cloudflare-pages.yml` — manual dispatch, preview default, production only from `main`, post-deploy verify |
| Paid features | none |

Runbook: [`SHADOW_SWAP_CLOUDFLARE_STAGING.md`](SHADOW_SWAP_CLOUDFLARE_STAGING.md).

## 7. VPS setup (only if Option B is chosen)

All files are examples under `deploy/vps/`; none is live.

```bash
# On a trusted machine with the repo at a reviewed commit:
pnpm install --frozen-lockfile
pnpm --filter @tari-ootle/protocol-client run build && pnpm --filter @tari-ootle/wallet-adapter run build
pnpm --filter @tari-ootle/web run build && pnpm --filter @tari-ootle/web run build:test
node deploy/vps/render-static-headers.mjs nginx > shadow-swap-headers.conf   # or: caddy
node tools/release-hygiene.mjs --dist
# Copy apps/web/dist and the headers snippet to the VPS (scp/rsync as the deploy user).

# On the VPS, as the dedicated user:
bash deploy/vps/release.sh deploy ./dist <git-sha>       # atomic symlink switch
# Then, as an admin, ONCE: add the NEW site file, validate, reload (never restart):
sudo nginx -t && sudo systemctl reload nginx            # or: caddy validate && systemctl reload caddy
```

Publish the loopback listener through whatever the inventory shows the existing service uses
(its reverse proxy with a NEW server block for Shadow Swap's own hostname, or a NEW Cloudflare
Tunnel ingress rule). Do not edit the existing service's blocks, certificates, tunnel routes,
containers or environment.

## 8. Read-only infrastructure inventory commands

`deploy/vps/inventory-readonly.sh` — reads only; starts, stops, reloads, edits and deletes
nothing; prints no secret file. Run, read, redact, then share:

```bash
bash deploy/vps/inventory-readonly.sh > shadow-swap-vps-inventory.txt 2>&1
```

It reports: OS and resources; listening sockets (which ports are taken); running and enabled
services; which of nginx/caddy/apache/traefik/haproxy/cloudflared/docker exist and their
config file names (and `nginx -T`, which may contain the existing service's credentials —
**redact**); tunnel configuration names; containers, networks and live resource use;
firewall rules; whether `/srv` paths and a `shadow-swap` user exist; certificate directory
names (no key material).

## 9. Security checks

| Check | How |
|---|---|
| No walletd endpoint exposed | Shadow Swap never uses one in production (`release-hygiene --dist` fails on a loopback walletd URL); the VPS config proxies nothing |
| VPS is not a custodian or signer | static files only; no key, no RPC, no admin path |
| Headers equal Pages' | `render-static-headers.mjs` renders from the same source |
| HTTPS | Cloudflare edge TLS; origin "Full (strict)" if the origin is ever reachable directly |
| Rate / size limits | nginx `limit_req` + 1 KiB body; container CPU/memory/pids caps |
| Input validation | static origin accepts GET/HEAD only |
| Logging | own log files / capped container logs |
| Admin separated from public traffic | no admin surface exists |
| Existing service unaffected | §11 checks before and after |

## 10. Test procedures

- **Before any deploy:** CI green; `tools/build-templates.sh --check`; `release-hygiene --dist`.
- **Pages:** the workflow's verify job (`verify-live-headers` + `smoke-deployment.mjs`).
- **VPS:** `curl -sI http://127.0.0.1:8088/` on the VPS, then from outside
  `node apps/web/scripts/smoke-deployment.mjs https://<shadow-swap-hostname>` and
  `pnpm --filter @tari-ootle/web run verify:live-headers https://<shadow-swap-hostname>`.
- **Existing service, before AND after:** its health URL answers as before; its process/container
  list and listening ports are unchanged except the new loopback port (diff two inventory runs).
- **Real wallet:** `SHADOW_SWAP_WINDOWS_LIVE_ACCEPTANCE.md`.

## 11. Rollback instructions

- **Pages:** Deployments → previous → *Rollback* (instant), or re-dispatch from the last good commit.
- **VPS release:** `bash deploy/vps/release.sh rollback` (symlink swap; no reload needed).
- **VPS removal (complete):** disable the NEW site file (or `docker compose -p shadow-swap down`),
  validate, reload; remove `/srv/shadow-swap`. The existing service was never modified, so
  there is nothing of its to restore.

## 12. Remaining operator actions

1. Run the §1 read-only wrangler checks; create the Pages project if absent.
2. Add the two GitHub secrets (Pages:Edit token only).
3. Dispatch a **preview** deploy; confirm the verify job is green.
4. Optionally protect previews with Cloudflare Access.
5. Choose and register Shadow Swap's own domain when ready (separate approval).
6. Only if choosing Option B: run the read-only VPS inventory and share the redacted output
   before any change is planned.
