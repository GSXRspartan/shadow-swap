# Shadow Swap v0.50.1 overnight template campaign

Date: 2026-11-07

Scope: local source and WASM verification only. No wallet daemon, browser profile, credentials,
network endpoint, chain state, transaction, or deployment was changed.

## Cohort

- Signed Tari Ootle source: `v0.50.1`, `0b3f364dd0eaff9997b08d722948619981b62ce7`.
- Rust: `1.97.1`.
- Every deployable template lockfile resolves `tari_template_lib` to `0.38.0` from that exact
  source revision.
- V2 evidence is the `tari_tdef` custom section, with CBOR prefix `82 01` (definition enum V2).
- Inventory result: all 13 Tari manifests (seven deployables, five engine-test helpers, and the
  engine-test harness) point to v0.50.1; none still references the v0.49.2 commit.

## Deployable template artifacts

| Template | Bytes | SHA-256 | V2 |
|---|---:|---|---|
| fungible_pool | 246482 | `8882d8c1123c8f721dcc722aa25dea51c349327aec02086e5cefb760f8e29e01` | yes |
| nft_marketplace | 197443 | `d1b800b262a86c07c8dfb1a1432c1b4b26bdefed51ceb5736cf207efc711881b` | yes |
| nft_item_offer | 202426 | `1be1f407a0fb12d17740615f9964bfb4b99e7956ed83c81c36c57f12969f507c` | yes |
| nft_collection_bid | 201644 | `f36d01d505acc12997dce9379e93a113d60c6d0e6375098a8d7186ccc5d1d7c5` | yes |
| p2p_offer | 189841 | `cfe55fdf957298657b913cab2b1d3c4408826f463d096edde18d865886a0581f` | yes |
| revealed_asset_pool | 256116 | `145c2083f453540c8124997a16f23f7b52c6e95541b0b7cd9e9b6352b35a6cc6` | yes |
| cross_layer_htlc | 176373 | `d0916869cb3f0bc07c8abb95fd45603f5980777af229ac1c9801b98776d59f59` | yes |

The reproducible build script completed `--check` successfully against
`templates/WASM_SHA256SUMS.v0501`. The older `templates/WASM_SHA256SUMS` was not changed.

## Static compatibility review

- The AMM adapter maps `new` to `CallFunction` and swap/add/remove operations to `CallMethod`.
- The marketplace, P2P offer, and HTLC adapters likewise use static `create`/`fund` calls and
  component-method calls for settlement/recovery. Their argument counts were reviewed against
  the public template signatures.
- The serializer retains distinct `CallFunction` and `CallMethod` wire forms; no transaction
  manifest files are present outside the typed builders.
- All deployable components use explicit access rules and `OwnerRule::None` where immutable
  custody is required. No empty `any_of()` or `all_of()` access rule was found.
- Fee payment remains a transaction concern. No template was changed to pay fees from a vault.
- The existing `tools/live-executor` remains disabled for this campaign; publication must use the
  authenticated wallet Web UI after a separately approved wallet migration.

## Local checks

- Six remaining deployable locked WASM builds: pass (see `remaining-template-builds.log`).
- Five test-helper locked WASM builds: pass (see `test-helper-template-builds.log`).
- Seven-template reproducible build and checksum comparison: pass (see
  `reproducible-v0501-template-check.log`).
- Rust formatting check: all deployables and four helpers pass. The pre-existing formatting issue
  in `audit_engine_tests/templates/hostile/src/lib.rs` caused the aggregate check to exit 1; that
  source is outside this migration patch and was left untouched.
- Engine execution: blocked. The existing `Ubuntu-22.04-orig` runner is unavailable because its
  configured VHD path is missing. The unsupported Windows Wasmer/Cranelift backend was not retried.

## Deployment status

All seven template binaries are compiler-verified and V2-definition-verified. None is deployment
ready until the operator-approved walletd v0.50.1 database migration is complete and focused
engine execution is available. Cross-layer HTLC additionally remains blocked on independent
two-chain and receipt reconciliation work.

## Walletd migration plan (not executed)

1. Operator approves a maintenance window; gracefully stop the existing v0.49.2 walletd from its
   originating console/service and verify its loopback listener has closed.
2. Copy the full `C:\Users\pdark\.tari\ootle\shadow-swap-esmeralda-v0492` profile after the clean
   shutdown to a protected, non-repository backup. Preserve `wallet.sqlite`, any `-wal` and `-shm`
   files, credentials, configuration, and WebAuthn data together.
3. Record a SHA-256 manifest of that backup and keep the v0.49.2 executable.
4. Start only the checksum-verified `tari_ootle_walletd-0.50.1-0b3f364-windows-x64.exe` with the
   exact pre-existing profile, loopback listener, authentication, indexer, cookie, and fee-limit
   settings. First start runs the authored-template migration.
5. Manually authenticate with WebAuthn. Verify the original account, receiving address, balances,
   account confirmation, and read-only RPC before estimating any fee.
6. On migration failure, stop and restore only from the complete clean-shutdown backup; do not use
   reset, create-account, seed-word, or passkey-reset commands.
