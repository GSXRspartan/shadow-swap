# LP SECURITY BASELINE (frozen)

Security conclusions below apply to EXACTLY this binary/runtime. Any change to the pins,
source, or toolchain invalidates them until re-recorded.

> **SUPERSEDED IN PART — 2026-10-01, the v0.42 post-reset compatibility pass.**
>
> The Ootle pin has moved to tag **v0.42.0** (commit `a43773e600b9503ed3fadcd3f0048f86131e3644`),
> because the Esmeralda testnet was reset and walletd is now v0.42.0. The repository-state,
> toolchain, pin, and WASM tables below are updated to that cohort in place; the **audit
> findings themselves** (`SECURITY_AUDIT_OPUS.md`, `LP_HOSTILE_AUDIT_REPORT.md`) remain
> historical evidence about the v0.41.1 revision and are deliberately NOT rewritten.
>
> What the cohort move did and did not change:
>
> - **No template source changed.** All four templates compile unchanged against v0.42.0
>   with no warnings and no edits, so the access-rule, ownership and accounting reasoning in
>   those reports still applies to the same source.
> - **The pin and the WASM hash are new.** Re-verified below.
> - **One engine semantic is load-bearing for this protocol and is unchanged:** the v0.42.0
>   template ABI still exposes no access-rule introspection for a foreign resource, so the
>   OPUS-08 recall/freeze limitation is still a live, disclosed, in-code-mitigated residual
>   risk rather than something the upgrade closed.
> - **`tari_crypto` is pinned to `0.23.4`** (not the old lock's `0.23.3`) because
>   `tari_engine_types` 0.42.0 requires `^0.23.4`.

## Repository state

| Item | Value |
|---|---|
| Branch | `feat/live-testnet-productization` |
| HEAD at this baseline | `48d1045` (post-reset v0.42 compatibility pass) |
| Live protocol deployment | **NONE.** No template of this protocol has ever been published on Esmeralda, before or after the reset |

## Toolchain

| Item | Value |
|---|---|
| rustc | 1.97.1 (8bab26f4f 2026-07-14) |
| cargo | 1.97.1 (c980f4866 2026-06-30) |
| wasm target | wasm32-unknown-unknown (installed) |
| node / pnpm | v24.14.0 / 9.15.9 |

## Pinned Ootle runtime (from actual Cargo.toml pins)

Every Tari/Ootle crate resolves from ONE revision, so a published template's ABI and the
engine that executes it can never be a mixed cohort.

| Crate | Source | Rev | Resolved version |
|---|---|---|---|
| tari_template_abi | github.com/tari-project/tari-ootle.git | `a43773e600b9503ed3fadcd3f0048f86131e3644` | 0.20.1 |
| tari_template_lib | same | same | 0.33.0 (features: `precision`, `extra-arith`) |
| tari_template_test_tooling | same | same | 0.42.0 |
| tari_ootle_transaction | same | same | 0.42.0 |
| tari_ootle_common_types | same | same | 0.42.0 |
| tari_engine_types | same | same | 0.42.0 |
| tari_crypto | crates.io | — | 0.23.4 (required `^0.23.4` by engine_types 0.42.0) |

`a43773e` is the **v0.42.0 release tag** (published 2026-09-30), i.e. the exact cohort the
post-reset Esmeralda validators run. Previous pin was `4732f65` (tag v0.41.1).

Template ABI / library lineage: `tari_template_lib` 0.33, `tari_template_lib_types` 0.33,
`tari_template_abi` 0.20.1, `tari_template_macros` 0.23. All template security assumptions
(access rules, `OwnerRule::None`, component-scoped mint/burn, `into_precision_amount()`
192-bit math, `Amount` semantics, and the ABSENCE of a recall-rule introspection API in the
template ABI) were re-verified against this revision.

## Template WASM artifacts (release, wasm32-unknown-unknown)

Built 2026-10-01 against the v0.42.0 cohort. All four are far below the 1 MiB
`max_template_binary_size_bytes` ceiling.

| Template | Size (bytes) | SHA256 (first 16) |
|---|---|---|
| `fungible_pool` | 243,934 | `70dbff826362bbcf` |
| `nft_marketplace` | 196,726 | `ca638242f8bf95df` |
| `nft_item_offer` | 201,719 | `e09a100c76d22459` |
| `nft_collection_bid` | 201,639 | `991244f9cc986517` |

Build flags: `--release`, `opt-level = "z"`, `lto = true`, `panic = "abort"`.
Compilation produced **no warnings**.

## Test inventory at this baseline

| Suite | Location | Runs on | Count / scope |
|---|---|---|---|
| pool_math unit + adversarial | `crates/pool_math` (lib tests, `tests/protocol_tests.rs`, `tests/amm_cycle.rs`) | Windows + CI | 36 tests |
| **Independent reference model** | `crates/pool_ref_model` (`tests/differential.rs`, `tests/security_gauntlet.rs`, `tests/state_fuzzer.rs`) | Windows + CI | 22 tests incl. 100,000 fuzz operations |
| protocol_types | `crates/protocol_types` | Windows + CI | 10 tests |
| Real-engine: pool lifecycle/fee | `audit_engine_tests/tests/pool_engine.rs` | Linux CI only (wasmer/cranelift) | e01–e06 |
| Real-engine: economics/first-depositor | `audit_engine_tests/tests/pool_economics.rs` | Linux CI only | E05/E11/E12 class |
| Real-engine: OPUS-08 eligibility | `audit_engine_tests/tests/opus08_eligibility.rs` | Linux CI only | RESOURCE01–10 |
| Real-engine: OPUS-08 recall drain demo | `audit_engine_tests/tests/opus08_recall_demo.rs` | Linux CI only | 1 |
| **Real-engine: adversarial** | `audit_engine_tests/tests/pool_adversarial.rs` | Linux CI only | w01–w11 |
| **Real-engine: NFT marketplace / item offer / collection bid** | `audit_engine_tests/tests/{marketplace,item_offer,collection_bid}_engine.rs` | Linux CI only | full engine suites |
| TypeScript / browser | `packages/*/test`, `apps/web/test`, `apps/web/e2e` | Windows + CI | 555 unit + 72 Chromium + 72 Firefox |

## CI

`.github/workflows/security-engine-tests.yml`: fmt + clippy (warnings denied) + unit/property
tests (pool_math, **pool_ref_model**, protocol_types) + WASM builds with SHA256 recording +
**real engine tests (never skipped; failure fails the job)**.

## Platform constraint (recorded, re-confirmed 2026-10-01)

`wasmer-compiler-cranelift 7.4.0` refuses to compile on Windows (`compile_error!`), so the
real-engine suites execute only on Linux CI. This was re-observed on the v0.42.0 cohort and is
unchanged. It is a tooling-environment limitation, not a contract limitation; all off-chain
suites run on both platforms. Publication itself is unaffected: templates compile to WASM on
Windows and are published from the wallet, not from a local validator.

## Canonical native TARI (re-verified live 2026-10-01)

| Item | Value | Source |
|---|---|---|
| Resource address | `resource_0101010101010101010101010101010101010101010101010101010101010101` | `STEALTH_TARI_RESOURCE_ADDRESS` / `TARI_TOKEN` in `crates/template_lib_types/src/constants.rs` at `a43773e` |
| Object key | 32 bytes of `0x01` | same |
| Resource type | **Stealth** | live `GET /resources/tari` |
| Divisibility | 6 | live `GET /resources/tari` |
| Symbol | `tTARI` | live `GET /resources/tari` |
| Deprecated alias | `XTR` | `constants.rs` (`#[deprecated]`) |
| Units | `TARI = 1_000_000` | `constants.rs` |

The token did **not** change identity across the reset: only the node software was upgraded.
The safety policy binds `CANONICAL_TARI` to the ADDRESS. A symbol is never an identity.
