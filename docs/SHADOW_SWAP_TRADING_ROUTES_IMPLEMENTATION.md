# Shadow Swap — Trading Routes Implementation

Date: **2026-10-31** · Branch: `claude/shadow-swap-v047-release-25lmq7` (continues the v0.48 cohort work)
Engine: tari-ootle **v0.48.0** (`6a25dbc`) · All engine evidence below ran in the REAL engine
(`audit_engine_tests`, `TemplateTest`), with freshly created disposable resources.

> **Superseded in part by Phase 2** (`docs/SHADOW_SWAP_P2P_SWAPOFFER_BROWSER.md`): the browser
> now builds every SwapOffer flow and the Sapient Stealth withdrawal, and the instruction wire
> format below this record was found NOT to be v0.48 `Instruction` JSON and was fixed there.
> "IMPLEMENTED" statements in this file presuppose that fix.

Status vocabulary: **LIVE VERIFIED** (settled on Esmeralda, recorded tx) · **ENGINE VERIFIED**
(executed in the real v0.48 engine) · **IMPLEMENTED, NOT LIVE VERIFIED** (browser builds and
signs it; no live wallet run yet) · **PARTIALLY IMPLEMENTED** · **BLOCKED BY ENGINE OR WALLET** ·
**NOT IMPLEMENTED**.

---

## 1. Route matrix, before and after

| Input → Output | Mechanism | Before this session | After |
|---|---|---|---|
| Public fungible → public fungible | Direct AMM | LIVE VERIFIED via CLI (pre-reset). **Browser path defective** (see §2) | **IMPLEMENTED, NOT LIVE VERIFIED** (browser fixed); CLI history unchanged |
| Native revealed tTARI → public fungible | Direct AMM | LIVE VERIFIED via walletd CLI | IMPLEMENTED, NOT LIVE VERIFIED (browser). Sapient **local** accounts: **BLOCKED BY WALLET** (`withdrawStealthAndExecute` not yet built); daemon-relayed accounts unaffected |
| Public fungible A → C | **Multi-hop AMM (2–3 hops)** | NOT IMPLEMENTED | **ENGINE VERIFIED** (atomic, m01–m04, m07, m08) + **IMPLEMENTED, NOT LIVE VERIFIED** |
| (new pool) | **Permissionless create-and-fund** | NOT IMPLEMENTED (CLI only) | **ENGINE VERIFIED** (m06) + **IMPLEMENTED, NOT LIVE VERIFIED** |
| Created-Stealth (revealed) → public fungible | P2P escrow (`SwapOffer`) | NOT IMPLEMENTED | **ENGINE VERIFIED** (p02, delivered into an account). Browser builder NOT IMPLEMENTED → shown disabled |
| Created-Stealth ↔ created-Stealth | P2P escrow | NOT IMPLEMENTED | **ENGINE VERIFIED** (p03). Browser disabled |
| Confidential (revealed) → public fungible | P2P escrow | NOT IMPLEMENTED | **ENGINE VERIFIED** (c01). Browser disabled |
| Confidential ↔ confidential (revealed) | P2P escrow | NOT IMPLEMENTED | Engine-compatible by construction (same template path as p03/c01), **not separately executed** |
| Confidential (blinded commitments) | Proof-backed settlement | NOT IMPLEMENTED | **BLOCKED BY WALLET**: needs wallet-built `ConfidentialWithdrawProof`; no browser wallet exposes it to dApps |
| NFT → public fungible | Marketplace (listing/offer/bid) | LIVE VERIFIED (pre-reset, walletd) | unchanged |
| NFT ↔ specific NFT | P2P barter | NOT IMPLEMENTED | **ENGINE VERIFIED** (p04). Browser disabled |
| Hash-locked / invited offers | HTLC-style / designated taker | NOT IMPLEMENTED | **ENGINE VERIFIED** (p05, p06) |
| Created-Stealth / confidential → Pool v2 | (refused) | refused | still refused, re-proven (s02, c02) |
| Compatible L1 asset → Ootle L2 | Cross-layer | PARTIALLY IMPLEMENTED, gated off | unchanged: **BLOCKED** until proven |

## 2. Direct AMM coverage

Two defects made every browser AMM write unsettleable; both are fixed with tests:

1. **Undeposited outputs.** The swap/add/remove intents serialised `withdraw → put → swap`
   with nothing consuming the pool's returned bucket. The engine rejects a transaction that
   leaves a returned bucket on the workspace (**m05**). The live-verified CLI manifests always
   deposited; the browser never did. Every call that returns a bucket now carries `output`
   (→ `PutLastInstructionOutputOnWorkspace`) and is deposited; `remove_liquidity`'s
   `(Bucket, Bucket)` is deposited by tuple offset 0 and 1 (`routes-wire.test.cjs` pins the
   exact wire list).
2. **Wrong account.** `SwapCard` and `LiquidityPanel` built intents with the **pool's address
   as the account**, so the signed list would have withdrawn from and deposited into the pool.
   They now build for the connected account only.

Reverse direction, slippage boundary, fee accounting and min-output enforcement for a single
hop were already engine-verified (`pool_engine.rs` e03–e05, `pool_adversarial.rs`).

## 3. Pool creation

`buildCreatePoolIntent` + `CreatePoolPanel` (Pools page): `Pool::new(a, b, 30)` on the template
**recorded** for the verified generation → workspace → `add_liquidity` on the new component via
`ComponentReference::Workspace` → deposit LP. **One transaction**: the pool exists and is funded,
or nothing happened (**m06**: `floor(sqrt(4e6·9e6)) = 6 000 000` LP minted, 1 000 locked forever,
5 999 000 to the creator). The panel offers only ordinary fungibles and native tTARI, warns when
a verified pool already exists for the pair, shows the initial price, LP minted and locked LP,
and refreshes discovery afterwards. Pool v2 is **not** republished; on the v0.48 reset network
the panel is disabled with the reason until a template is published and recorded.

## 4. Multi-hop routing and atomic settlement

- **Graph + routes** (`protocol-client/ammRouter.ts`): simple paths ≤ 3 hops, no pool or resource
  revisited; integer-only composition with `quoteSwapOutput`; mid output and total route cost
  (fees + impact, rounded up); ranking by **executable output**, ties by fewer hops;
  unquotable candidates reported with a reason.
- **Resolution**: `resolveMultiHopSwap` re-reads **every** hop through the pinned authoritative
  readback, re-derives the quote, derives the whole-route minimum from the fresh quote, and
  returns `STALE` when the route now pays below what the shown quote allowed.
- **Construction** (`buildMultiHopSwapIntent`): `withdraw → swap₁ → … → swapₙ → deposit` in one
  transaction; buckets chained on the workspace; `min_output = 1` on intermediate hops, the user's
  minimum on the final hop. The review shows the **final** hop's bound (it previously read the
  first `swap`, which would have shown 1).
- **Engine evidence**:

| Test | Proves |
|---|---|
| m01 | A→B→C in one transaction; intermediate asset never touches the account |
| m02 | A→B→C→D (three hops) |
| m03 | Final-hop min breach rejects everything; first pool's reserves and trader balance unchanged |
| m04 | A failing middle hop reverts the first hop |
| m07 | Off-chain composed quote == engine payout, every hop, three amounts |
| m08 | Deep two-hop beats a thin direct pool; the router picks it |

## 5. Created-Stealth trading

`stealth_route_probe.rs` (s01/s02): a created-Stealth resource's **revealed** balance lives in a
component vault; Pool v2 still refuses the resource (guard unchanged). The settlement lane is the
new **`SwapOffer`** template (`templates/p2p_offer`, experimental, unpublished): the component
never calls an account, so any vault-able resource works. **p02**: 400 revealed units of a fresh
created-Stealth token traded for 700 of a fungible; the revealed units **land in the taker's
account** with their type unchanged. **p03**: created-Stealth ↔ created-Stealth. Privacy:
only the traded amount is revealed; reconstructing new private outputs after receipt is a wallet
action (not performed by the template).

## 6. Confidential trading

`confidential_probe` mints a confidential resource with a revealed supply
(`ConfidentialOutputStatement::mint_revealed`). **c01**: revealed confidential units traded for a
fungible through `SwapOffer`, received into an account; **c02**: Pool v2 refuses the resource.
Blinded commitments are **not** traded: spending them requires a `ConfidentialWithdrawProof`
built by the holder's wallet (`Vault::withdraw_confidential`). The engine supports it; no browser
wallet exposes it to dApps, so that route is **BLOCKED BY WALLET** and disabled. No plaintext
"confidential swap" is presented.

## 7. P2P / HTLC

`SwapOffer`: exact agreed amount or one specific NFT; `fill` returns the asset atomically;
maker-only `claim` and `cancel` (`rule!(public_key(maker))`); optional **designated taker**
(`rule!(public_key(taker))` — a binding, front-run-proof invitation); optional **SHA-256 hash
lock** (`hash_sha256` intrinsic, HTLC-style: the preimage becomes public once a fill is
submitted); expiry; `OwnerRule::None`, no admin, no fee. Engine: p01–p09, c01–c02 (11/11).
Not enabled in the browser: no `SwapOffer` transaction builder exists yet, and the template is
unpublished. Cross-chain HTLC (with L1) remains the gated cross-layer work.

## 8. Frontend route selection and execution

- **`/swap`** (new nav item): select any two assets; `resolvePairRoutes` lists every mechanism
  with availability, privacy, required capabilities and the exact reason when unavailable;
  executable quotes are compared by output with per-hop fees, total route cost and the
  whole-route minimum; the chosen route is re-resolved and runs through the existing review →
  submit-once pipeline (`executeSwap`), so pending-approval persistence, duplicate-submit
  refusal and reconciliation are unchanged.
- Mechanisms without a signable implementation (P2P, barter, blinded confidential, cross-layer)
  are shown as unavailable with their reason and **no action**.
- LP: 25/50/75/100% removal; reserves, fee and locked LP shown; no APR/TVL/USD.

## 9. Engine and test results

| Suite | Result |
|---|---|
| `multihop_routes.rs` (new) | **8/8** |
| `p2p_offer_routes.rs` (new) | **11/11** |
| Full engine suite, `RUSTFLAGS=-D warnings` | **72/72** (53 prior + 8 multi-hop + 11 P2P) |
| protocol-client (incl. new `amm_router` 8) | **266/266** |
| wallet-adapter (incl. new `routes` 6) | **27/27** |
| web (incl. new `routes-wire` 5, `route-resolver` 5) | **477/477** |
| e2e Chromium desktop + hosting, no retries | 106 passed, 1 failed (sandbox blocks `universe.tari.mw`), 4 skipped |

## 10. Wallet compatibility constraints

- Every write needs `transactionRequests` (create → approve → submit). Unchanged.
- **Sapient local accounts cannot spend Stealth-typed funds through a plain `withdraw`** (its own
  docs); tTARI-input AMM routes need `withdrawStealthAndExecute`, not yet built. Fungible-input
  routes and daemon-relayed accounts are unaffected.
- `CallFunction` (pool creation, marketplace create) and `ComponentReference::Workspace` calls
  are engine-proven but **not yet observed through a browser wallet**.
- Blinded confidential spends need wallet proofs no dApp API exposes.

## 11. Feature flags and known limitations

- `SwapOffer` is **unpublished**. Phase 2 added the browser builders, invitations and UI; the
  P2P lanes stay unavailable until a SwapOffer address is recorded for the verified generation.
  No feature flag can enable them.
- Pool creation and all AMM routes require a Pool template **recorded** for the verified network
  generation; the v0.48 reset network has none until the operator publishes.
- The frontend still calls `add_liquidity` for existing pools (the published pre-reset Pool
  lacks `add_liquidity_exact`).
- Route search is bounded to 3 hops and to verified pools the wallet can read.

## 12. Git, PRs and CI

Commits on `claude/shadow-swap-v047-release-25lmq7` (this phase): `616a6b4` engine multi-hop and
pool creation · `df1e9db` builders, router, serializer · `7e65fde` SwapOffer + engine tests ·
`d54eb48` Swap page, Create-pool panel, account fix · plus this document. **`git push` is
refused with HTTP 403** (the Claude GitHub App is not authorized for this repository in this
session), so there is no PR and no CI run yet. Final regression totals are in §9 and `CHECKPOINT.md` E1.

## 13. Windows walletd tests needed

The web app has no built-in walletd provider (the `VITE_ENABLE_DEV_PROVIDERS` /
`VITE_WALLETD_URL` settings are parsed but nothing consumes them). The supported way to drive
your local walletd from the browser is **Sapient's daemon-relayed account**: Sapient connects to
the walletd on your machine and relays signing to it; walletd stays on loopback.

```powershell
# 0. walletd running on 127.0.0.1:5100 with a disposable account and small balances.
#    In Sapient: add a daemon-relayed account pointing at your local walletd.
cd shadow-swap
pnpm install --frozen-lockfile
pnpm --filter @tari-ootle/protocol-client run build; pnpm --filter @tari-ootle/wallet-adapter run build
# Pre-reset network (Pool v2 recorded) while it is still served; omit for the v0.48 hosts.
$env:VITE_INDEXER_URL="https://ootle-indexer-a.tari.com"
pnpm --filter @tari-ootle/web build; pnpm --filter @tari-ootle/web preview -- --host 127.0.0.1
# open http://127.0.0.1:4173 (localhost satisfies Sapient's secure-origin rule)
```

1. **Direct swap** (fungible → fungible, then tTARI → fungible, daemon-relayed account) on the
   existing pool: one approval, Confirmed, balances reconcile (input + fee, output ≥ minimum).
2. **Create a second pool** on the Pools page: one transaction; it appears after discovery;
   LP = `floor(sqrt(a·b)) − 1000`.
3. **Two-hop swap** on `/swap` through both pools: one approval, one transaction, the
   intermediate asset's balance unchanged, final ≥ minimum.
4. **Atomic refusal**: move a reserve between quote and approval (or demand too much): the
   transaction is rejected and **no** balance moves.
5. **Remove 25% / 100%** of the new LP: both assets received.
6. Repeat 1 and 3 with a Sapient **local** (seed) account: fungible-input routes; record the
   expected wallet refusal for tTARI input (needs `withdrawStealthAndExecute`).
7. Reload during approval: the same request id resumes; nothing double-submits.

## 14. Remaining work before a Cloudflare testnet release

1. Restore GitHub access, push, open the PR, get CI green.
2. Operator-approved publication of the v0.48 Pool (and, if wanted, `SwapOffer`) from the
   reproducible build; record addresses in `protocolDeployment.ts`.
3. `withdrawStealthAndExecute` path for tTARI-input routes through Sapient local accounts.
4. Browser `SwapOffer` builders (create/fill/claim/cancel) + an offers view, then enable the
   P2P lanes behind the published template.
5. Switch add-liquidity **into a pool that already has reserves** to `add_liquidity_exact`
   once the published Pool has it. Pool CREATION must keep `add_liquidity`:
   `add_liquidity_exact` cannot serve a first deposit (`pool_engine` `e07e`).
6. Windows acceptance (§13) and a Cloudflare preview with the verify job green.

---

## Newly executable routes (this session)

- **Multi-hop public AMM, 2 and 3 hops, atomic** — engine-proven, built and signable in the browser.
- **Permissionless pool creation and funding in one transaction** — engine-proven, built and signable.
- **Direct AMM swap / add / remove from the browser** — now constructible at all (output deposit and
  account fixes); previously unsettleable from the browser.
- **Created-Stealth (revealed) → public fungible, created-Stealth ↔ created-Stealth, confidential
  (revealed) → public fungible, NFT ↔ NFT barter, invited and hash-locked offers** — executable in the
  real v0.48 engine via `SwapOffer`; browser-built since Phase 2, unavailable until published.
