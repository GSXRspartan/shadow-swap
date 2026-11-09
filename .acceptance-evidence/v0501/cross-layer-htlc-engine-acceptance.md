# CrossLayerHtlc engine acceptance — WSL Ubuntu run

Date: 2026-11-08. Branch: `codex/ootle-v0501-pool`.
Toolchain: Rust 1.97.1, WSL distro `Ubuntu` (darkp, writable), `/mnt/c/...` path.

## Engine tests — PASS

Command:

```text
cargo test -j 1 --manifest-path audit_engine_tests/Cargo.toml --test cross_layer_htlc
```

`-j 1` is required on this machine (2.6 GiB RAM; parallel build OOMs at
`wasmparser` rmeta write: "Cannot allocate memory").

Result:

```text
running 10 tests
test h01_fund_then_claim_pays_the_claimant_and_publishes_the_preimage ... ok
test h02_only_the_committed_preimage_opens_the_escrow ... ok
test h03_only_the_named_claimant_claims_and_only_the_funder_refunds ... ok
test h04_refund_is_refused_before_expiry_and_pays_the_funder_after ... ok
test h05_claim_and_refund_can_never_both_succeed ... ok
test h06_an_escrow_settles_exactly_once ... ok
test h07_funding_terms_are_validated_before_anything_is_escrowed ... ok
test h08_the_recorded_hash_is_exactly_the_sha256_an_l1_output_carries ... ok
test h09_whatever_is_escrowed_is_exactly_what_is_delivered ... ok
test h10_a_bucket_carrying_blinded_commitments_cannot_fund_an_escrow ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; finished in 901.85s
```

This replaces the previous state where only compilation was shown and the
WSL Wasmer run crashed under a read-only distro (`Ubuntu-22.04` at
`D:\wsl\Ubuntu-2204` mounts read-only; the two writable distros are
`Ubuntu` and `Ubuntu-22.04-orig`). Native Windows cannot run these tests at
all (`wasmer-compiler-cranelift` errors on Windows).

Covers: fund → claim pays claimant and publishes preimage, wrong preimage
refused, named claimant / funder-only refund, refund refused before expiry,
claim/refund mutually exclusive, settles exactly once, funding terms
validated, hash is the real L1 SHA256, escrow amount equals delivery amount,
blinded commitments cannot fund.

## WASM build — PASS (V2 ABI)

Command:

```text
cargo build --target wasm32-unknown-unknown --release
```

in `templates/cross_layer_htlc`.

- Artifact: `target/wasm32-unknown-unknown/release/cross_layer_htlc.wasm`
- Size: 176243 bytes
- SHA-256: `b88b3889722b323153725dac7279442de6d3372744c486439448a256c8cd1447`
- Reproducible in this environment (clean rebuild → identical hash).
- `tari_tdef` custom section at byte 138504; CBOR prefix after the name
  `82 01` → `TemplateDef::V2` variant index 1, same V2 marker as the
  Pool evidence in `compatibility-summary.md`.
- ABI: `fund(Bucket, Hash32, RistrettoPublicKeyBytes, u64, String) -> Component`,
  `claim(Vec<u8>) -> Bucket`, `refund() -> Bucket`, `terms()`,
  `revealed_preimage()`. Matches `packages/wallet-adapter/src/crossLayerHtlc.ts`
  and the instruction-wire fixtures.

Note: hash differs from the earlier `d0916869...` artifact in
`remaining-template-sha256s.txt` (176373 bytes). Both are V2; the difference
is the build environment/path (WSL `/mnt/c/...` vs Windows git-bash
`C:\...` embedded paths). Either artifact is publishable; the hash above is
the one produced by the test-verified source in this checkout.

## Blockers that remain

- Template is still **unpublished**: `activeDeployment(...).crossLayerHtlcTemplates`
  is empty for every generation, so the cross-layer market reports
  `NOT_RECORDED` / unavailable. Publication is a separate, user-approved
  operation (Wallet Web UI publish, or walletd-initiated). Not done here.
- L1 browser signing is still **upstream-blocked**: `window.tari` has no
  Minotari SHA atomic-swap methods. L2 leg can sign via `window.tari`
  (`htlcFund` / `scriptPathSpend` capabilities); L1 leg needs a local
  Minotari wallet (`MinotariDevGrpcProvider`, dev-only). No real two-chain
  settlement has been observed yet. Do not fund either leg on Esmeralda
  until the full 12-scenario suite (acceptance harness) and a small live
  testnet exchange are run with user approval.
