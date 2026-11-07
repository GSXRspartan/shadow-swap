# Shadow Swap Pool v0.50.1 local compatibility evidence

## Source and toolchain

- Upstream release: `v0.50.1`, signed tag commit
  `0b3f364dd0eaff9997b08d722948619981b62ce7`.
- Rust: `1.97.1`.
- Pool cohort: `tari_template_lib 0.38.0`, `tari_template_abi 0.23.0`, with
  all focused test-harness Tari dependencies pinned to the same signed commit.

## Pool build

Command (isolated worktree):

```text
rustup run 1.97.1 cargo build --locked --release --target wasm32-unknown-unknown
```

- Result: pass, exit `0`.
- Artifact: `artifacts/fungible_pool-v0501-v2.wasm`.
- Size: `246482` bytes.
- SHA-256:
  `8882d8c1123c8f721dcc722aa25dea51c349327aec02086e5cefb760f8e29e01`.
- Static `tari_tdef` check: section length prefix `803`, CBOR prefix `82 01`.
  The official v0.50.1 ABI encodes `TemplateDef::V2` at variant index `1`, so
  this is a V2 definition rather than the rejected V1 layout.

The original v0.49.2 Pool artifact remains untouched in the migration
evidence, with SHA-256
`d4c834f793edf8ec7bf75cf2cce1a3833074bfb6797330543681eb9b3e840bfc`.

## Focused engine tests

Requested test binaries:

```text
cargo test --locked --test pool_engine --test pool_economics --test pool_adversarial
```

They did not reach test execution on Windows. The initial GNU host was blocked
before test compilation because `dlltool.exe` is not installed. The retry using
the installed Rust 1.97.1 MSVC host reached the upstream runtime dependency and
failed with:

```text
error: The Cranelift compiler backend is not supported on Windows. Use the V8 backend instead.
```

This is an upstream Windows test-runtime limitation (`wasmer-compiler-cranelift`),
not a Pool source or V2 ABI failure. No application tests have been counted as
passed by this run.

## Walletd upgrade preparation

- Official Windows x64 executable:
  `C:\Users\pdark\Downloads\tari_ootle_walletd-0.50.1-0b3f364-windows-x64.exe`.
- `--version`: `tari_ootle_walletd 0.50.1`.
- SHA-256:
  `ebf546910e5df73669018229c6bf06765fb7923d2f78b85d97ad94ba24066680`.
- This equals the GitHub v0.50.1 release asset digest.
- The isolated v0.49.2 profile has not been opened, copied, or changed by the
  v0.50.1 binary.

The v0.50.1 wallet store calls `run_migrations()` during startup. Relative to
v0.49.2, its new wallet migration is
`2026-11-06-120000_remove_v1_authored_templates`; it deletes only locally
stored authored-template rows carrying the V1 `is_mut` definition field. It
does not describe an account/key/passkey migration. A clean-shutdown, full
profile backup is still mandatory before first v0.50.1 startup because it is a
database migration and the profile contains protected credentials.
