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
| **walletd** | **0.45.0** (`tari_ootle_walletd.exe` sha256 `1fa177e6…`, PID 9148 on `127.0.0.1:5100`) | `wallet.get_info`; process inspection |

**Update (2026-10-07):** walletd was upgraded 0.42.0 → **0.45.0** against the same base-path
(a verified restorable backup was taken first). The daemon now matches the v0.45 line, so the
previous **BLOCKED** status on live state-changing transactions is cleared. No new
state-changing transaction was submitted in this run; read-only chain work uses the 0.45
indexers directly. See `docs/OOTLE_V045_WALLET_AND_COHORT_HANDOFF.md`.

## Upstream delta reviewed (v0.44.0 `59b8af33…`, v0.45.0 `9c626062673760530ffb075b6b006a67becebe5a`)

**Correction (2026-10-07):** v0.45.0 is an **annotated tag**. `7b16f2a0a3c4ee548aaaa20bf597ffd489839cd5`
is the tag **object**; the release **commit** it points to is
`9c626062673760530ffb075b6b006a67becebe5a` (`git ls-remote --tags` → `v0.45.0^{} = 9c62606…`).
`9c62606` is therefore the correct build pin — **not** a `template_lib` subtree commit, as
previously stated here. See `docs/OOTLE_V045_WALLET_AND_COHORT_HANDOFF.md`.

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
| templates `tari_template_lib`/`_abi` | git `a43773e` (0.42) | git `9c62606` (0.45, lib 0.34.0) | **Yes (committed)** | Migrated on `feat/v045-walletd-and-full-cohort`; all four templates build under v0.45. The published Pool v2 artifact stays `a43773e` and remains the on-chain identity. |
| `audit_engine_tests` tooling | git `a43773e` | `9c62606` | **Yes (committed)** | Bumped with the templates; `tari_crypto 0.23.4 → 0.24.0`; regenerated lockfiles contain no `a43773e`. |
| protocol-client / web JS | — | — | No | Pure TS; no Tari runtime pin |

The repo cohort is now migrated to the v0.45.0 release commit (`9c62606`) for both the
templates and the engine test tooling. This was a clean, CI-validated migration: the Linux
Security Engine Tests job passed **112 tests, 0 failed**, and all four templates build under
v0.45.0. See `docs/OOTLE_V045_WALLET_AND_COHORT_HANDOFF.md`.

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
  rejection — Linux Security Engine Tests green (**112 passed, 0 failed**) on `478d7ac`.
- **BUILD VERIFIED**: all four templates compile under v0.45.0 (cohort `9c62606`).
- **UNIT VERIFIED**: decoder (7 tests), quote-path migration, wallet read wiring.
- **CI VERIFIED**: Node Tests (incl. browser-security **233/233**) and Security Engine Tests green on `478d7ac`.
- **OPEN**: live state-changing ops are unblocked (walletd upgraded to **0.45.0**) but none
  were submitted this run; live browser tx still has no provider.
