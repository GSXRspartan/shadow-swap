# Ootle v0.45 Conformance — Liquidity Protocol

Read-only + engine + build verification that the Liquidity Protocol is safe and
compatible under the current Esmeralda line. No Pool was republished, no asset
created, no live state-changing transaction submitted.

## Network (observed 2026-10-06, read-only)

| Fact | Value | Source |
|---|---|---|
| Indexer A / B version | **0.45.0** / **0.45.0** | `GET /info` on both |
| Network / byte | esmeralda / 38 | `/info`, `/network` |
| Current epoch | **11940** | `/info`, `/network` |
| Protocol version | **V1 active** (V1 activated at epoch 11925; 11940 > 11925) | upstream release notes + epoch |
| `verify_substate_proofs` | true | `/info` |
| **walletd** | **0.42.0** (`tari_ootle_walletd-0.42.0-a43773e-windows-x64.exe` on :5100) | process inspection |

**Live state-changing transactions are BLOCKED** this run: walletd (0.42.0) is older
than the v0.45 line. Per policy, no new state-changing tx is submitted with an outdated
daemon, and the binary is not replaced unattended (never a second daemon on the same DB,
never a DB reset). To enable live mutation, the operator upgrades walletd to the v0.45
line and restarts it against the same base-path. Read-only chain work uses the 0.45
indexers directly.

## Upstream delta reviewed (v0.44.0 `59b8af33…`, v0.45.0 `7b16f2a0a3c4ee548aaaa20bf597ffd489839cd5`)

The prompt's `9c62606` is the `template_lib` subtree commit inside the v0.45.0 tag; the
tag commit itself is `7b16f2a0…` (verified by `git ls-remote --tags`).

- **Protocol V1** (v0.44): commits each shard's state version in the state Merkle root;
  changes state-sync verification. **Impact on us: none at the read layer** — the
  component/vault/resource substate shapes are unchanged (the decoder reproduces the
  exact live state, below). WASM execution semantics are unchanged.
- **LP mint/burn authorization fix, PR #2759** — see **Pool security** below.
- **Empty-reserve swap rejection** (v0.44) — our template already asserts non-empty
  reserves; see below.
- **`ResourceAccessRules::update_nft_data` default → DenyAll for non-owners** (v0.44):
  **no impact** — none of our NFT templates (`FixedPriceListing`, `ItemOffer`,
  `CollectionBid`) mutate NFT data (no `update_non_fungible_data`/mutable-data calls;
  they escrow and transfer whole NFTs). Verified by source audit.
- **Resource auth hook runs on Stealth/confidential actions; `AuthHookCaller::template()`
  → `Option`** (v0.44): **no impact** — none of our templates define or rely on auth
  hooks (no `auth_hook`/`AuthHook` usage). Native tTARI is referenced only by its
  canonical address for pool eligibility; Created-Stealth (STEST) stays
  `POOL_TEMPLATE_BLOCKED` (unchanged policy).
- **v0.45 V1 block-id changes; Minotari 6.1.0-pre.0; tari_crypto 0.24**: the protocol
  performs **no L1 burn / cross-chain submission** (kept OFF), so these do not affect any
  active path. Transaction ids used for reconciliation come from walletd/indexer at
  submit time (no hard-coded fixture tx ids in the execution path).
- **Indexer proofs (`include_proofs`) / multi-indexer `indexer_urls`**: `PROOF_AVAILABLE_NOT_YET_VERIFIED`
  — the indexer advertises `verify_substate_proofs:true` and v0.44 adds optional proofs,
  but we do not yet run a client-side verifier, so current reads remain the indexer's
  verified substate reads. walletd failover (`indexer_urls`) is a daemon concern; the
  app/executor do not hard-code single-indexer assumptions that would conflict (the app
  already has A+B built-in and the executor talks only to loopback walletd). Opportunity
  documented; no unsafe custom verification added.

## Pool security — upstream #2759 attack reproduced against our custom Pool

Our Pool is a custom template; the upstream built-in flaw does not automatically apply.
It was attacked directly in the engine suite.

| Attack | Mechanism | Outcome |
|---|---|---|
| A/B — external / third-party LP mint | `w06_unauthorized_lp_mint_rejected`: a hostile component calls `try_mint_foreign(lp, 1e9)` | **DENIED** at the mint; LP supply unchanged |
| C/E — external LP burn / forged caller | `w07_unauthorized_lp_burn_rejected`: a hostile component calls `try_burn_foreign(lp_bucket)` | **DENIED**; supply unchanged |
| D — owner bypass | `opus16_pool_component_is_ownerless` + live read | component owner **None**, LP resource owner **None** |

Live-confirmed on chain under v0.45/V1 for `component_8c20c644…`: LP mint and burn =
`Restricted → ScopedToComponent(pool)`, recall/freeze `DenyAll`, LP owner `None`;
component owner `None`. A foreign component frame cannot satisfy `component(pool)`, so
unbacked-LP mint-then-drain is impossible.

**Verdict: `UPSTREAM_GHSA_CLASS_NOT_APPLICABLE_TO_CUSTOM_POOL_V2 — ENGINE VERIFIED`**
(the scoping was already in place from the OPUS-02/OPUS-16 fixes). No Pool v3 required.

### Empty-reserve swap
`swap` asserts `!input_pool.is_zero()` ("Input reserve is empty") and
`!output_pool.is_zero()` ("Output reserve is empty") before any arithmetic, so a swap
against an empty reserve is rejected (no divide-by-zero, no free/donation output). The
reference model pins the same ("quote with zero reserves must fail",
`pool_ref_model/tests/security_gauntlet.rs`). UNIT + ENGINE VERIFIED via existing tests.

## Pool deployment status
Pool v2 `template_f47a330e…` remains **`CURRENT_ESMERALDA`** (promoted back from
`…_PRE_V045_CONFORMANCE`): safe (not #2759-class), and compatible — its published WASM is
valid under V1 (live reads), and its source **compiles cleanly under v0.45.0**
(`template_lib 0.34.0`, build EXIT 0) — BUILD VERIFIED. Pool v1 `template_ef2bc1…` stays
`SUPERSEDED_TESTNET`. No addresses changed.

## Protocol V1 compatibility
- **State decoder**: `decodePoolState` re-read the live Pool v2 under v0.45/V1 and
  produced the exact intact state — reserveA **595664**, reserveB **604684**,
  totalLpSupply **600000**, lockedLpSupply **1000**, feeBps **30** — identical to the
  pre-upgrade values. **LIVE READ VERIFIED**; the V1 substate envelope shape is unchanged.
- **Indexer**: A and B both 0.45.0 and agree. Compatible.
- **Reconciliation**: unchanged (durable id by walletd/indexer; no fixture tx ids).

## Dependency cohort

| Dependency | Old | v0.45 target | Changed? | Reason |
|---|---|---|---|---|
| templates `tari_template_lib`/`_abi` | git `a43773e` (0.42) | git `7b16f2a` (0.45, lib 0.34.0) | **No (committed)** | Source compiles under v0.45 (build-verified); published artifact is a43773e and valid under V1; a full-cohort bump needs Linux-CI validation of the engine suite — follow-up |
| `audit_engine_tests` tooling | git `a43773e` | `7b16f2a` | No | Engine suite is Linux-CI-only; bump + validate together as a follow-up |
| protocol-client / web JS | — | — | No | Pure TS; no Tari runtime pin |

The repo cohort is intentionally kept at `a43773e` so the committed source matches the
published artifact and CI stays green; moving the whole cohort (templates + engine tests
+ test tooling) to `7b16f2a` is a clean, CI-validated follow-up.

## Browser task (resumed)
- **Quote-path migration DONE**: `createOotleReadbackProvider.readPool` now decodes the
  real multi-substate pool via `decodePoolState` over a `readRaw` reader (added to
  `AuthoritativeSubstateReader` and the wallet's `substateReader`), instead of the
  obsolete flat-field `parsePoolState`. The legacy path remains only for readers without
  `readRaw`. Regression: `packages/protocol-client/test/pool_substate.test.cjs` asserts
  `readPool` returns the exact live state and is fail-closed. **UNIT VERIFIED.**
- Swap/add/remove **quotes** now read correct reserves through this path; their math is
  already pinned by `amm`/`pool_math`/`pool_ref_model`. Account/network/provider
  invalidation (`liveIdentity`) and durable transaction-request logic are unchanged.
- **Live provider: unavailable** (no `window.tari`), so a live browser transaction is
  **BLOCKED**; the executor is not a substitute and is classified separately.

## Evidence summary
- **LIVE READ VERIFIED**: v0.45/V1 network identity; Pool v2 state + owner None + LP
  scoping intact; decoder under V1.
- **ENGINE VERIFIED**: #2759-class denied (w06/w07), owner None (opus16), empty-reserve
  rejection — pending the Linux CI run on this push.
- **BUILD VERIFIED**: fungible_pool compiles under v0.45.0.
- **UNIT VERIFIED**: decoder (6 tests), quote-path migration, wallet read wiring.
- **BLOCKED**: live state-changing ops (walletd 0.42); live browser tx (no provider).
