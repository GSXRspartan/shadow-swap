# ESMERALDA VERSION TARGET

Date: **2026-10-01** (post-reset re-verification)

## Current Ootle State — resolved from the upstream repository, not a local checkout

The previous revision of this document was derived from a local `C:\tmp-tari`
shallow clone and could not see tags, so it recorded "development HEAD
`2d6083e`" with a note that no tag existed. That is no longer the situation: the
versions below were read from the **v0.42.0 release tag** on GitHub and
**confirmed against crates.io and against the live post-reset Esmeralda hosts**.

**Workspace version**: `0.42.0`
**Release tag**: `v0.42.0`
**Tag commit**: `a43773e600b9503ed3fadcd3f0048f86131e3644`
**Release date**: 2026-09-30
**Live indexer version** (`GET /info`, 2026-10-01): `0.42.0`, network
`esmeralda`, network_byte `38`, epoch `11714`

## Version details (from tag `v0.42.0` `Cargo.toml`, confirmed on crates.io)

| Component | Workspace decl | crates.io max stable |
|---|---|---|
| tari-ootle workspace | 0.42.0 | — |
| `tari_engine` | 0.42.0 | 0.42.0 |
| `tari_engine_types` | 0.42.0 | 0.42.0 |
| `tari_ootle_common_types` | 0.42.0 | 0.42.0 |
| `tari_ootle_transaction` | 0.42.0 | 0.42.0 |
| `tari_consensus_types` | 0.42.0 | 0.42.0 |
| `tari_template_builtin` | 0.42.0 | 0.42.0 |
| `tari_template_test_tooling` | 0.42.0 | 0.42.0 |
| `tari_transaction_manifest` | 0.42.0 | 0.42.0 |
| `tari_template_lib` | 0.33.0 | 0.33.0 |
| `tari_template_lib_types` | 0.33.0 | 0.33.0 |
| `tari_template_abi` | 0.20.1 | 0.20.1 |
| `tari_template_macros` | 0.23 | 0.23.0 |
| `tari_ootle_template_metadata` | 0.13 | 0.13.0 |
| `tari_ootle_template_build` | 0.13 | — |
| `tari_bor` | 0.16.2 | 0.16.2 |
| `ootle_serde` | 0.6 | 0.6.0 |
| `ootle_byte_type` | 0.14 | 0.14.0 |
| `tari_crypto` | 0.23.4 | 0.23.4 |
| `tari_indexer_client` | 0.43 | 0.43.0 |
| `tari_ootle_wallet_sdk` | 0.44.0 | 0.44.0 |
| `tari_ootle_wallet_crypto` | 0.44 | 0.44.0 |
| workspace edition | 2024 | — |

## Version selection for this project

**Selected**: git dependencies pinned to the immutable **v0.42.0 release tag commit**
`a43773e600b9503ed3fadcd3f0048f86131e3644`, from ONE revision for every
Tari/Ootle crate.

Reasoning:

- The post-reset Esmeralda validators run 0.42.0 (confirmed by `GET /info` from
  both public indexer origins on 2026-10-01). Anything else is a different
  engine from the one that will execute a published template.
- The **tag** is used rather than a development HEAD. The previous revision of
  this document pinned `2d6083e`, a development commit, for want of a visible
  tag; that made the cohort unnameable and unreproducible.
- One revision for every crate means a published template's ABI and the engine
  that executes it can never be a mixed cohort.
- `tari_crypto` is pinned to **`0.23.4`**, not left floating at `"0.23"`.
  `tari_engine_types` 0.42.0 requires `^0.23.4`; the previous lock's `0.23.3`
  makes the cohort unresolvable.

## Dependency configuration for this project

```toml
# Pinned to the v0.42.0 release tag (a43773e600b9503ed3fadcd3f0048f86131e3644)
tari_template_abi  = { git = "https://github.com/tari-project/tari-ootle.git", rev = "a43773e600b9503ed3fadcd3f0048f86131e3644" }
tari_template_lib  = { git = "https://github.com/tari-project/tari-ootle.git", rev = "a43773e600b9503ed3fadcd3f0048f86131e3644", features = ["precision", "extra-arith"] }
tari_template_test_tooling = { git = "https://github.com/tari-project/tari-ootle.git", rev = "a43773e600b9503ed3fadcd3f0048f86131e3644" }
tari_crypto = "0.23.4"   # required ^0.23.4 by tari_engine_types 0.42.0
```

## Why this matters for the templates

- All four templates compile unchanged against this cohort, with no warnings and
  no source edits.
- The engine test harness uses `tari_template_test_tooling` 0.42.0 — the same
  engine the network runs, so an engine test pass means something on Esmeralda.
- WASM artifacts are well under the 1 MiB `max_template_binary_size_bytes` cap.
- **The template ABI still exposes no access-rule introspection for a foreign
  resource** in v0.42.0, so the OPUS-08 recall/freeze limitation remains a live,
  disclosed, in-code-mitigated residual risk rather than something this upgrade
  closed.

## Note on the reset

v0.42.0 is *"the testnet reset release"*: every network restarts at
`ProtocolVersion::V0` with wiped state and no storage migration. **No on-chain
state from before 2026-09-30 survives.** This repository never had a live
deployment, so there was nothing to migrate; the four templates remain
unpublished. See `docs/LIVE_TESTNET_EVIDENCE.md` §0 for the captured
post-reset observations and `docs/TESTNET_RUNBOOK.md` for the publication
sequence.