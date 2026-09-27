# LP SECURITY BASELINE (frozen)

Security conclusions below apply to EXACTLY this binary/runtime. Any change to the pins,
source, or toolchain invalidates them until re-recorded.

## Repository state

| Item | Value |
|---|---|
| Branch | `feat/multi-asset-stablecoin-markets` |
| HEAD at audit | `6425c660f8f5274aea1fff2d7e47d53c7ef52879` |
| Recent commits | `6425c66 feat: add marketplace readback and route resolution`, `bcb1eb0 feat: add executable marketplace transaction builders` |

## Toolchain

| Item | Value |
|---|---|
| rustc | 1.97.1 (8bab26f4f 2026-07-14) |
| cargo | 1.97.1 (c980f4866 2026-06-30) |
| wasm target | wasm32-unknown-unknown (installed) |

## Pinned Ootle runtime (from actual Cargo.toml pins)

| Crate | Source | Rev |
|---|---|---|
| tari_template_abi | github.com/tari-project/tari-ootle.git | `4732f65ec17a96547050989d78fd70a4e3d94113` |
| tari_template_lib | same | `4732f65ec17a96547050989d78fd70a4e3d94113` (features: `precision`, `extra-arith`) |
| tari_template_test_tooling | same | `4732f65ec17a96547050989d78fd70a4e3d94113` |
| tari_ootle_transaction / common_types / engine_types | same | `4732f65ec17a96547050989d78fd70a4e3d94113` |

This pin corresponds to the v0.41.1-era engine (workspace version 0.41.1) targeted for
Esmeralda compatibility; `tari_template_lib` 0.32 / `tari_template_abi` 0.20 / `tari_template_macros` 0.23
lineage. All template security assumptions (access rules, `OwnerRule::None`, component-scoped
mint/burn, `into_precision_amount()` 192-bit math, `Amount` semantics, absence of a recall-rule
introspection API in the template ABI) are stated against THIS revision. Upgrading the pin
requires re-running the entire suite and re-recording this file.

## Fungible pool WASM (release, wasm32)

| Item | Value |
|---|---|
| Path | `templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm` |
| Size | 242,679 bytes |
| SHA256 | `e83980a22b4b3faeae46fa542dfd0d6f720acd61e507967a360226626d0ea705` |
| Build flags | `--release`, `opt-level = "z"`, `lto = true`, `panic = "abort"` |

## Test inventory at this baseline

| Suite | Location | Runs on | Count / scope |
|---|---|---|---|
| pool_math unit + adversarial | `crates/pool_math` (lib tests, `tests/protocol_tests.rs`, `tests/amm_cycle.rs`) | Windows + CI | 32 tests |
| **Independent reference model** | `crates/pool_ref_model` (`tests/differential.rs`, `tests/security_gauntlet.rs`, `tests/state_fuzzer.rs`) | Windows + CI | 22 tests incl. 100,000 fuzz operations |
| Real-engine: pool lifecycle/fee | `audit_engine_tests/tests/pool_engine.rs` | Linux CI only (wasmer/cranelift) | e01–e06 |
| Real-engine: economics/first-depositor | `audit_engine_tests/tests/pool_economics.rs` | Linux CI only | E05/E11/E12 class |
| Real-engine: OPUS-08 eligibility | `audit_engine_tests/tests/opus08_eligibility.rs` | Linux CI only | RESOURCE01–10 |
| Real-engine: OPUS-08 recall drain demo | `audit_engine_tests/tests/opus08_recall_demo.rs` | Linux CI only | 1 |
| **Real-engine: adversarial (new)** | `audit_engine_tests/tests/pool_adversarial.rs` | Linux CI only | w01–w11 |
| TypeScript | `packages/protocol-client/test`, `packages/wallet-adapter/test` | Windows + CI | marketplace route/readback |

## CI

`.github/workflows/security-engine-tests.yml`: fmt + clippy (warnings denied) + unit/property
tests (pool_math, **pool_ref_model**, protocol_types) + WASM builds with SHA256 recording +
**real engine tests (never skipped; failure fails the job)**.

## Platform constraint (recorded)

`wasmer-compiler-cranelift 7.4.0` refuses to compile on Windows (`compile_error!`), so the
real-engine suites execute only on Linux CI / WSL. This is a tooling-environment limitation,
not a contract limitation; all off-chain suites run on both platforms.
