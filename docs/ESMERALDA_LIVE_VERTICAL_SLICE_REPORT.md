# Esmeralda LIVE AMM Vertical Slice — Evidence

**Status: `LIVE ESMERALDA AMM VERTICAL SLICE VERIFIED`.** A complete AMM lifecycle
— create assets → instantiate pool → add liquidity → swap → add more → partial
withdrawal — was executed on the live Esmeralda testnet and each step verified
authoritatively against the exact integer reference math.

Executed 2026-10-06 via `tools/live-executor` (walletd `transactions.submit_manifest`;
the daemon signed with its own account key — no key export). Testnet only; no
mainnet, no L1, no cross-chain. All amounts are raw integer units (divisibility 6).

## Network

| Fact | Value | Source |
|---|---|---|
| Network / byte | `esmeralda` / `38` | walletd `settings.get`, indexer `/info` |
| Ootle version (indexer) | `0.43.0` | `/info` |
| Epoch (at run) | ~`11923` | `settings.get` |
| Indexers | `https://ootle-indexer-a.tari.com`, `…-b.tari.com` | live |

## Wallet / account

- Fee + signing account: **`Purrivacy Swap`**
  `component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b`
  (the wallet default; walletd holds its owner key and signed every tx).
- Fees are paid from the account's **revealed** tTARI via the manifest's implicit
  `pay_fee`. Starting revealed tTARI `1.806470`; total fees this run `0.026132`.
- No secrets, seeds, view keys, or masks are recorded anywhere.

## Test resources created (public fungibles, `TestCoinFactory`)

Minted by the published `TestCoinFactory`
(`template_93aa539e3a59bd9e45db35f88ec733a40d493223b5892d8724fbfe198831b692`),
`create_public_fungible_test_coin(symbol, 6, 1_000_000_000)`:

| Symbol | Resource address | Type | Rules | Supply |
|---|---|---|---|---|
| `LPTESTA` | `resource_87385b51c57f8682ec2de4a0e590b17a56c7465c904552e80cabaeb467e70dfc` | **Fungible** (public) | mint/burn/recall/freeze = **DenyAll** | 1_000_000_000 |
| `LPTESTB` | `resource_8187d4053bf20b3c3c8cd2fb14556d74e755fe97c6e19247093e687648290051` | **Fungible** (public) | mint/burn/recall/freeze = **DenyAll** | 1_000_000_000 |

Both are pool-eligible (`ResourceType::Fungible`), and **non-recallable /
non-freezable** (verified via indexer `/resources/<addr>`), so neither can drain or
freeze the pool. tTARI itself was NOT pooled — it is only spent on fees — so the
pool liquidity consumes zero tTARI.

## Pool

| Fact | Value |
|---|---|
| Template | `Pool` `template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649` |
| Component | **`component_329d4ef20fe6803ca499db7f923b0d1773d1f72e38d76cfcbe351327d6304169`** |
| Canonical pair | a = LPTESTB (`8187…`), b = LPTESTA (`8738…`) |
| LP resource | `resource_32a6a6b0869a9cc28be2df45baf8b0b70855d2a8ec57f1c3236fd53ad16bb6e9` |
| Fee | `30` bps (0.30%), 100% to LPs, no developer fee |
| Access rules | default `DenyAll`; only the 9 permissionless methods AllowAll; **no admin/withdraw method** |

Verified authoritatively before funding: template address == Pool, version 0,
fee_bps == 30, resources == the two test tokens, reserves == 0, LP supply == 0.

> **Owner-rule caveat (OPUS-16, see Security).** This pool was created from the
> **currently published** `Pool` template, whose component defaults to
> `OwnerRule::OwnedBySigner`. The live pool is therefore owned by the creator key.
> This is harmless for a disposable test pool, but is a real finding for production;
> it is fixed in source and requires a **new template version** (the on-chain
> `ef2bc1…` address is immutable and is NOT patched).

## Transactions (each `LIVE VERIFIED`)

| # | Operation | Tx id | Status | Fee (µtTARI) | Epoch-ish |
|---|---|---|---|---:|---|
| 1 | create LPTESTA | `8611e7dc1359820ee1a4f198a08c450f838bef02f60b7e5d2a9151c20ba4377e` | Commit | 3010 | ~11920 |
| 2 | create LPTESTB | `baf965c2d3d5c4b1cdfe4e729b6f9f7926ef8936107352fbb1f10afcb023a46b` | Commit | 3097 | ~11921 |
| 3 | instantiate Pool | `773f26e495f85246d3515b603ad242dc439f7eee6aac4fd7cfc75a0b27e6ee93` | Commit | 3210 | ~11922 |
| 4 | initial liquidity | `e4d96bf031fad3c66ccf74e4817c740248dd5241ae01124b09aaa8622dd8d719` | Commit | 5360 | ~11922 |
| 5 | swap A→B | `1fc4d54c2d7d1252b08941d8241462ff0e0df097f6b3d6ea532f029916478181` | Commit | 3235 | ~11922 |
| 6 | additional liquidity | `1bdc21f883a5e302ac3dfd0890f5725498a67deecfcd881a0db2304d563d0b65` | Commit | 4180 | ~11923 |
| 7 | partial withdrawal | `f2f50d4f98e34f75dd697022df60a85e63e19809298abf60e7b871d3e7ac0806` | Commit | 4040 | ~11923 |

**Total actual network fees: 26_132 µtTARI ≈ 0.026132 tTARI** (budget 25 tTARI).
Durable per-op record: `tools/live-executor/live-op-ledger.jsonl`.

### Invariants verified on-chain (vs the integer reference math)

**Initial liquidity** (in: 3_000_000 LPTESTB + 6_000_000 LPTESTA):
- `initial_shares = floor(sqrt(3e6 · 6e6)) = 4_242_640` — matched `lp_total_supply`.
- `locked_lp_supply = 1_000` (permanently locked; first-depositor protection).
- LP minted to depositor = `4_241_640` (= total − locked) — matched account balance.
- reserves = LPTESTB `3_000_000` / LPTESTA `6_000_000` — matched.

**Swap** (in: 600_000 LPTESTA → LPTESTB, min_out 270_000):
- `effective_input = 600_000·(10_000−30)/10_000 = 598_200`.
- `output = floor(3_000_000·598_200 / (6_000_000+598_200)) = 271_983` — matched the
  post-swap reserve delta exactly (LPTESTB `2_728_017`).
- full input deposited (reserve LPTESTA `6_600_000`) → the `1_800` fee stays in the
  pool as LP profit; `k` grew (1.8e13 → 1.80049e13); `min_output` respected; LP
  supply unchanged; **no developer fee**.

**Additional liquidity** (in: 1_000_000 LPTESTB + 2_419_338 LPTESTA):
- `a_shares=1_555_210`, `b_shares=1_555_209` → minted **min = 1_555_209** (the
  template takes the min side, protecting existing LPs against a skewed deposit).
- `lp_total_supply = 5_797_849`; reserves `3_728_017` / `9_019_338` — matched.

**Partial withdrawal** (burn 1_000_000 LP):
- returned LPTESTB `643_000` + LPTESTA `1_555_635` (floor proportional) — matched the
  reserve deltas; `lp_total_supply = 4_797_849`; **locked LP still `1_000`** (the
  first-depositor lock survived every operation; it is never redeemable).

Final pool state (also readable via `node tools/live-executor/cli.mjs read-pool`):
reserves LPTESTB `3_085_017` / LPTESTA `7_463_703`, LP supply `4_797_849`, locked `1_000`.

## Frontend (live discovery)

- `apps/web` `/pools` discovers the live pool component
  `component_329d4ef2…` on chain and confirms its template is `Pool` (`ef2bc1…`),
  version 0 — verified in-browser against the real indexer.
- Pair/reserves render as `—` without a connected wallet **by design**: the indexer
  serves component state as raw tagged CBOR, and the app only trusts reserves from
  the wallet's authoritative `tari_getSubstate` reread. No reserves are fabricated.
- Discovery is receipt-scan based and **windowed**: on the busy testnet this pool was
  ~page 2 of recent receipts at run time and will age past the default 5-page scan as
  the chain advances. This is a known limitation (the public indexer has no
  list-components-by-template API); a durable known-pool registry is the robustness
  follow-up. `UNVERIFIED` beyond what is stated here.

## Classification

- **LIVE VERIFIED:** asset creation, pool instantiation, initial liquidity, swap,
  additional liquidity, partial withdrawal, fee = 30 bps, first-depositor lock,
  on-chain pool discovery by the frontend.
- **ENGINE VERIFIED (CI):** the AMM invariants and OPUS-16 ownerless-component
  regression in `audit_engine_tests` (Linux CI; Cranelift is unsupported on Windows).
- **UNIT VERIFIED:** `pool_math`, `pool_ref_model`, `protocol_types`, web unit tests,
  `tools/live-executor` guard/parse tests.
- **UNVERIFIED / FOLLOW-UP:** wallet-connected reserve rendering in the browser;
  durable pool registry for windowed discovery; a republished owner-rule-fixed Pool.
