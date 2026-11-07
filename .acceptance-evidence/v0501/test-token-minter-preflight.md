# Esmeralda public test-token preflight — 2026-11-07

Scope: read-only network inspection and local compilation only. No wallet operation, signature,
dry run, transaction, publication, resource creation, or mint was performed.

## Current alternatives

- `tari_ootle_walletd` v0.50.1 exposes no direct public fungible resource-create or mint RPC.
- The deployment account has no known ordinary public fungible balance suitable for a two-sided
  Pool. Its native tTARI entry is a Stealth resource, not a public Pool leg.
- The historical `TestCoinFactory` address
  `template_93aa539e3a59bd9e45db35f88ec733a40d493223b5892d8724fbfe198831b692`
  returned 404 from both configured official Esmeralda indexers.
- Both indexers' catalogue searches found no `TestCoin`, `Test`, `Fungible`, `Minter`, or
  `Asset` template. Built-in `NftFaucet` only mints NFTs; `XtrFaucet` supplies native test
  funds; `StealthFaucet` is not an ordinary public fungible resource. Catalogue token candidates
  were unaudited third-party templates and their ABI reads returned 500, so they are not used.

## Local V2 fallback

- source: `templates/test_token_minter/`
- dependency cohort: signed Tari Ootle `0b3f364dd0eaff9997b08d722948619981b62ce7`,
  `tari_template_lib` 0.38.0
- build: Rust 1.97.1, `cargo build --locked --release --target wasm32-unknown-unknown`
- result: exit 0
- artifact:
  `.acceptance-evidence/v0501/artifacts/test_token_minter-v0501-v2-b7f77e73.wasm`
- SHA-256: `b7f77e73a8c121baf3b37e1a32e12e75914cdaf69fe842697c15a961ebbd5a16`
- size: 122072 bytes
- V2 evidence: the `tari_tdef` custom section is structurally valid (declared=actual=65) and has
  the same V2 BOR envelope prefix (`82 01 81 83`) as the published Pool V2 WASM.

`mint_pair` returns two public fungible buckets: 10,000.000000 TESTA and 10,000.000000 TESTB.
Both use six decimals, `OwnerRule::None`, and locked deny rules for mint, burn, recall and freeze;
withdraw and deposit are locked allow rules for normal account/Pool flow. It leaves no component,
vault, badge, or retained mint authority.

## Dry-run boundary

Walletd's `transactions.submit_manifest` with `dry_run: true` still requires
`transactions:create` and signs the locally built transaction before submitting it to the indexer
dry-run service. The existing DPAPI credential is intentionally read-only, so no fee estimate was
attempted. The authenticated walletd Manifest UI can perform the operator-approved estimate using
the exact manifest documented in `templates/test_token_minter/README.md` after a separately
approved template publication.
