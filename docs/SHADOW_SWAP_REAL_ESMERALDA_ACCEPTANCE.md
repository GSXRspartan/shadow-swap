# Shadow Swap — Real Esmeralda Acceptance Record (Windows run, v0.47 live network)

Record generated 2026-11-01. Repository main at `406ab3f` (PR #15 merged; tree clean).
Everything below was executed locally on the operator's Windows machine. Mainnet XTM and all
existing wallet databases were never opened.

## 1. Environment

| Item | Value |
|---|---|
| Repository SHA (start) | `406ab3fad871a10fdaeab1e6460804f28ad3be7d` (main, clean) |
| Toolchain | Node v24.14.0, pnpm 9.15.9, Rust 1.97.1 (msvc), Playwright 1.56.1 |
| Live walletd | PID 12016, **official v0.47.0 release binary** (SHA256 `a2e2678e…109e`, matches the published release checksum), data dir `~\.tari\ootle\shadow-swap-esmeralda-live` (fresh, loopback-only `127.0.0.1:5100`, auth `none`) |
| Built (not running) | v0.48.0 walletd compiled from the verified tag `v0.48.0` = `6a25dbc` at `C:\Users\pdark\Documents\Codex\2026-10-31\tari-ootle-v048\target\release\tari_ootle_walletd.exe`; isolated dir `~\.tari\ootle\shadow-swap-v048-test` |
| Live indexers | `esme-indexer-a/b.ootle.tari.com`, `ootle-indexer-a/b.tari.com` → all `0.47.0`, `esmeralda`, byte 38, epoch 12776, `verify_substate_proofs: true` |

**Network verdict:** Esmeralda is still the PRE-v0.48-reset generation. The cohort logic in
`apps/web/src/lib/ootleCohort.ts` classifies 0.47 correctly (`PRE_V048_RESET`, JSON_VALUES) and
the app serves the pre-reset trusted template rows for exactly this generation. The 0.48 build
was retained for the reset; a 0.48 walletd against the current 0.47 indexers submits
transactions the indexer rejects (`HTTP 400`), as documented in the module comment.

## 2. What works today (read-only, real chain, no wallet approval needed)

| Check | Result |
|---|---|
| Templates live on the current network | `Pool` = `f47a330e…19ab` (160 KB, V1 ABI, `swap/add_liquidity/remove_liquidity`, `fee_bps` 30), `FixedPriceListing` = `612114e3…`, `ItemOffer` = `083fef7d…`, `CollectionBid` = `999ef37f…` — all read from the indexer directly and equal to the addresses pinned in `protocolDeployment.ts` |
| SwapOffer (P2P) / RevealedAssetPool | Correctly absent on this generation; the frontend disables the routes and says so |
| Live pool component | `component_8c20c644…59a2`, verified substate, OwnerRule None, contains tTARI + LPTESTA (`resource_87385b51…dfc`, fungible, div 6, total supply 1e9) |
| Production frontend vs live chain | `vite preview` at 127.0.0.1:4173: "Esmeralda Testnet", "Data: Synced", **1 pool discovered** (exact seeded component), RevealedAssetPool honestly "not available on this network", **0 console errors** |
| Unit tests | protocol-client 268 pass, wallet-adapter 31 pass, web **565 pass / 0 fail** |
| Playwright e2e (chromium desktop + mobile + hosting) | **183 passed / 8 skipped / 1 failed**; the single failure (matrix 2b, mobile) passes in isolation and the whole spec passes when re-run (24+25 tests) — parallel-load flake, not a defect |

### Defect fixed in this run
Stale `dist/` (saved 2026-10-16) made 2 CSP tests fail: `_headers` named the new
`esme-indexer-{a,b}.ootle.tari.com` connectivity origins, but `dist/index.html` was built before
they were added. Rebuilding the production bundle (`pnpm --filter @tari-ootle/web build`) fixed
both tests; source was already correct. Verified by rerunning `test/deployment.test.cjs`
(36 pass / 0 fail) and the full suite.

## 3. Wallet-side status

- No account exists in the fresh walletd wallet (0.47). This is expected; nothing is spent.
- Sapient browser-extension `window.tari` is the one provider the frontend accepts for signing;
  `WalletDaemonAdapter` and `SapientWalletAdapter` are deliberately refuse-all placeholders.

## 4. An authenticated localhost-only walletd (PREPARED — requires one approved restart)

Current: `--authentication none` (loopback-only, fresh disposable wallet; tooling mints its own
Admin JWT via `auth.request` after a local signing login). Prepared command for operator
approval when a real wallet will be funded:

```
--network esmeralda --base-path <dir> --authentication password   # password at start-up
# secrets stay local; never bind to a non-loopback address
```

The daemon already binds only 127.0.0.1. Switching auth modes is the single specific reason a
restart would ever be needed.

## 5. Minimum real-wallet acceptance plan — needs operator approval

All read-only preparation is done. The first economic submissions require explicit approval of
each item below (the running walletd or the Sapient extension will do the signing):

1. FUND: faucet/one account funding (~fee ≈ a few thousand units; hard ceiling set at approval time).
2. SWAP 1: tTARI → LPTESTA through the live pool, minimal disposable amount (fee ≈ 3,500 units at
   v0.46-era measurements), per-trade min-output from the app's quote.
3. SWAP 2: LPTESTA → tTARI (reversal), same review model.
4. POOL 2: create a second tiny pool (required for a two-hop route) — needs the Pool `CallFunction
   new()` publication through the wallet, plus seed liquidity for both sides.

Fee ceilings and exact amounts are shown in each wallet approval card; the app's review and the
wallet's card must agree exactly, and reconciliation happens before and after.

## 6. Hosting / Cloudflare staging (prepared, not deployed)

- `.github/workflows/cloudflare-pages.yml` is already the supported path: manual dispatch,
  pinned Pages project `ootle-liquidity-testnet`, pinned wrangler 4.151.0, preview target =
  branch alias `staging.<project>.pages.dev`, `dist/_headers` + `_redirects` (CSP/frame-ancestors)
  enforced by Pages.
- Missing infrastructure, operator action only: the repo currently has **no** `CLOUDFLARE_API_TOKEN`
  / `CLOUDFLARE_ACCOUNT_ID` secrets. Add the token with `Account / Cloudflare Pages / Edit` scope
  and the project then deploys a preview from this same commit.
- Access restriction (Cloudflare Access on the preview alias) and DNS stay untouched until
  the operator permits it; nothing has been deployed and no URL is claimed as live.
- `GH_PAGES / pages.yml` is NOT a supported host (no response-header enforcement).

## 7. Next operator actions

1. Approve the funding of one disposable account (then swaps 1/2 as in §5).
2. Decide authentication mode for the daemon before the first signed submission (§4).
3. Add the two Cloudflare secrets to unlock the gated staging deploy (§6).
4. On the community reset to 0.48: the freshly built binary and the untouched v0.48 wallet dir
   are ready; template republishing follows the existing publication checklist.
