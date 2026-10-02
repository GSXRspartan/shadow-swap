# TESTNET RUNBOOK

Target network: Esmeralda (current Tari Ootle testnet)
Upstream reference: **tari-ootle tag `v0.42.0`**, commit `a43773e600b9503ed3fadcd3f0048f86131e3644`

> **Current state, 2026-10-01 (post-reset).**
>
> The Esmeralda testnet was reset and the node software is now **walletd / `tari_indexer` 0.42.0**
> (released 2026-09-30). Every network restarts at `ProtocolVersion::V0` with wiped state, so
> **no on-chain state from before the reset survives.** This repository has therefore never had a
> live deployment and does not have one now: no template of this protocol has been published,
> before the reset or after it. Nothing here is migrated, because there was nothing to migrate.
>
> The four templates are **unpublished**. The next action is the manual publication sequence in
> [Publish the protocol templates](#publish-the-protocol-templates).

## Prerequisites
- Rust toolchain with wasm32-unknown-unknown target (verified: rustc/cargo 1.97.1)
- Node.js >= 20, pnpm 9
- `tari_ootle_walletd` **0.42.0** for publication
- tTARI in a fee account. **Note the v0.42.0 change:** public testnets now start with an
  **EMPTY tTARI faucet**. Testnet tTARI is claimed by burning on L1, and anyone can refill the
  faucet through its `deposit` method. LocalNet keeps a funded faucet. A claim against an empty
  faucet fails with error code `1002`, and the web UI disables *Claim Testnet Funds* while it is
  empty. Budget for this before attempting to publish.

## Build templates

The WASM artifacts that publication consumes are the ones in `templates/`, not
`crates/pool_math` (which is a plain Rust reference model, not a template).

```bash
# All four protocol templates. Each writes its own target/ directory, which is
# gitignored, so a build leaves nothing staged.
cargo build --manifest-path templates/fungible_pool/Cargo.toml      --target wasm32-unknown-unknown --release
cargo build --manifest-path templates/nft_marketplace/Cargo.toml    --target wasm32-unknown-unknown --release
cargo build --manifest-path templates/nft_item_offer/Cargo.toml     --target wasm32-unknown-unknown --release
cargo build --manifest-path templates/nft_collection_bid/Cargo.toml --target wasm32-unknown-unknown --release

# Artifacts land at templates/<name>/target/wasm32-unknown-unknown/release/<name>.wasm

# Web frontend
pnpm install --frozen-lockfile
pnpm --filter @tari-ootle/web build
```

### Verified build state (2026-10-01, v0.42.0 cohort)

All four compile cleanly to `wasm32-unknown-unknown --release` with **no warnings and no source
changes required**. Sizes matter because publishing cost scales with WASM size, and all four are
comfortably under the 1 MiB `max_template_binary_size_bytes` ceiling:

| Template | Bytes | SHA256 (first 16) |
|---|---|---|
| `fungible_pool` | 243,934 | `3c92b31dc1e57a32` |
| `nft_marketplace` | 196,726 | `ca638242f8bf95df` |
| `nft_item_offer` | 201,719 | `e09a100c76d22459` |
| `nft_collection_bid` | 201,639 | `991244f9cc986517` |

These are the authoritative digests, kept in step with `security/LP_BASELINE.md`. The release
profile does not set `strip = true`, so a digest tracks source line numbers and moves on a
comment-only edit; **size is the stable property** and a digest is an artifact identifier for
the exact commit, not a behavioural fingerprint.

Building is a local, offline, non-destructive operation. **Publishing is not,
and is not performed by any automated step in this repository** — see
[Publish the protocol templates](#publish-the-protocol-templates) below.

## Test commands
```
# Off-chain Rust suites (run on Windows and Linux CI)
cargo test --manifest-path crates/pool_math/Cargo.toml       --release
cargo test --manifest-path crates/pool_ref_model/Cargo.toml  --release
cargo test --manifest-path crates/protocol_types/Cargo.toml

# Real-engine suites: Linux CI only (wasmer-compiler-cranelift 7.4 is a
# compile_error! on Windows). Locally on Linux/WSL:
cargo test --manifest-path audit_engine_tests/Cargo.toml

# TypeScript + browser
pnpm install
pnpm typecheck
pnpm test
cd apps/web && npx playwright test
```

## Run web locally
```
cd apps/web
pnpm dev
# Open http://localhost:3000
```

## Check indexer endpoint health

The current public Esmeralda indexer is a **REST** API, not a JSON-RPC root.
`GET /info` is the smallest useful read, and it also reports the network identity
this app verifies before it trusts any discovery content:

```bash
# Network identity + version. Expect version "0.42.0", network "esmeralda",
# network_byte 38 (0x26).
curl -sS https://ootle-indexer-a.tari.com/info
curl -sS https://ootle-indexer-b.tari.com/info

# Current epoch
curl -sS https://ootle-indexer-a.tari.com/network
# -> {"network":"esmeralda","network_byte":38,"epoch":11714}

# Canonical TARI resource (exact identity, NOT a ticker)
curl -sS https://ootle-indexer-a.tari.com/resources/tari

# Is one of OUR templates published? A non-empty catalogue with no entry named
# exactly "Pool" means the endpoint works and our deployment is simply empty.
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=Pool&limit=100'
```

### The API surface this repository actually uses

Verified read-only against the live 0.42.0 hosts on 2026-10-01:

| Purpose | Endpoint |
|---|---|
| Network identity preflight | `GET /info` |
| Epoch | `GET /network` |
| Canonical TARI | `GET /resources/tari` |
| **Is a template published?** | `GET /templates/catalogue?name_filter=<exact name>&limit=100` |
| Template definition | `GET /templates/{template_address}` |
| Which components exist | `GET /transaction-receipts?limit=100&ordering=Descending` |
| Batch component read | `POST /substates/fetch` (max 20 ids) |
| Live events | `GET /transactions/events/stream` (SSE) |

Two facts that changed with v0.42.0 and that this repository now depends on:

- **`/templates/cached` was REMOVED.** The live host answers `HTTP 400` to it. `/templates/catalogue`
  is the replacement. Any tooling or doc that still names `/templates/cached` is stale.
- **There is no endpoint that lists components by template**, and the public indexer does not
  expose GraphQL at all (`/graphql` returns `404`). Component discovery is therefore
  receipts → component ids → batch substate read, and the template is confirmed from the
  component's **own header** rather than assumed from the creating transaction.

`/transaction-receipts` is used in preference to `/transactions/recent` because the indexer
documents the former as "synced from network state rather than gossip, **complete from genesis**,
and recovered after downtime", and the latter as best-effort with acknowledged gaps.

## Publish the protocol templates

**This is the current blocker for every live-pool workflow**, and it is a
publication step, not a coding one. Verified 2026-10-01: none of this
repository's four templates appears in `GET /templates/catalogue`, while the
catalogue returns 19+ community/builtin entries. The endpoint is healthy and our
deployment is simply empty.

Nothing in this repository publishes automatically, and nothing should. This is
the supported manual procedure, in order.

### 1. Order: there is no dependency order

The four templates are independent. `fungible_pool` is a self-contained AMM;
`nft_marketplace`, `nft_item_offer` and `nft_collection_bid` are independent
marketplace components that reference each other **by resource address at call
time**, never by template. Publish order is therefore arbitrary; publish
`fungible_pool` first so that a pool component can be instantiated and tested
as soon as possible.

| # | Template | Artifact | Publishes as template name |
|---|---|---|---|
| 1 | `fungible_pool` | `templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm` | `Pool` |
| 2 | `nft_marketplace` | `templates/nft_marketplace/target/wasm32-unknown-unknown/release/nft_marketplace.wasm` | `FixedPriceListing` |
| 3 | `nft_item_offer` | `templates/nft_item_offer/target/wasm32-unknown-unknown/release/nft_item_offer.wasm` | `ItemOffer` |
| 4 | `nft_collection_bid` | `templates/nft_collection_bid/target/wasm32-unknown-unknown/release/nft_collection_bid.wasm` | `CollectionBid` |

The published template name is the **component struct's identifier**, not the crate or module
name. This matters: the frontend's authoritative read refuses any component whose reported
template name is not the expected one, so a mismatch here silently makes every pool read return
`UNAVAILABLE`. `apps/web/test/ootleV042Contract.test.cjs` pins struct name == published name ==
readback expectation, so a rename fails a test rather than the network.

### 2. Fund a testnet account

Publishing and instantiating both cost fees. On **v0.42.0 public testnets the tTARI faucet starts
empty** — claim testnet tTARI by burning on L1, or have someone refill the faucet via its
`deposit` method. No real funds are involved at any point.

```bash
tari_ootle_walletd --network esmeralda
# wallet web UI at http://127.0.0.1:5100
# accounts.get_faucet_balance reports the faucet balance; a claim against an
# empty faucet fails with error code 1002.
```

### 3. Publish each template through the wallet web UI

**Publishing is done from the wallet web UI, not by a script.** Open
`http://127.0.0.1:5100` → *Publish Template* → select the fee account → upload
the artifact from the table above → *Estimate Fee* → *Publish Template* → read
the resulting template address from the sidebar.

There is deliberately no `publish` command in this repository. A programmatic
publish path would need its own fee estimation, its own confirmation gate, and
its own handling of the case where a publish is acknowledged but not committed —
which is exactly the `UNKNOWN` class of problem this protocol refuses to guess
about. A human clicking *Estimate Fee* then *Publish Template* is the honest
mechanism.

Fee guidance: v0.41.0 onwards publishing costs execution points charged **before** the compile runs
at `140_000_000 + 2100` per binary byte, so cost scales with WASM size. These templates are
197–244 KB. **Trust the wallet's own *Estimate Fee* result over any figure written here**, and
fund the fee account for the largest of the four first.

### 4. Record each template address

Record all four template addresses immediately, in the run log for this testnet
session and next to the test plan below. They are required to instantiate any
component and to verify publication. Do not record them anywhere that would make
a **pre-reset** address look current — no address from before the 2026-09-30
reset is valid on the current network.

### 5. Verify publication landed, and distinguish success from "submitted"

A publish acknowledgement is **not** a published template. Three independent
read-only checks distinguish them:

```bash
# (a) The catalogue reports the template, by EXACT name.
#     A substring hit is not enough: the builtin's "TwoResourceLiquidityPool"
#     contains "Pool".
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=Pool&limit=100'

# (b) The template's definition is retrievable at its address (200, not 404).
curl -sS 'https://ootle-indexer-a.tari.com/templates/<template_address>'

# (c) The transaction receipt says Commit, not Abort.
curl -sS 'https://ootle-indexer-a.tari.com/transactions/<tx_id>'
```

Only (a) with an exact name match, plus (b) returning a definition, means the
template is published. If (a) is empty but (c) shows the transaction still
`PENDING` or the receipt is missing, publication has been **submitted, not
committed** — report it as `UNKNOWN` and reconcile by transaction id. Do not
retry blindly.

### What must NOT be done to work around this

- Do **not** publish as part of a test run or a CI job.
- Do **not** hand-write a publish/transaction-construction script.
- Do **not** point discovery at something that returns plausible-looking pool
  records so the UI has rows. That is fabricated discovery data in a production
  path, which this repository refuses anywhere, and it is exactly the failure
  mode the outage states exist to prevent.
- Do **not** treat "endpoint works" as "we have a deployment". They are
  different facts and the code keeps them apart:
  `INDEXER_UNAVAILABLE`, `WRONG_NETWORK`, `PROTOCOL_NOT_DEPLOYED`,
  `PROTOCOL_DEPLOYED_EMPTY`, `PROTOCOL_AVAILABLE`.
- Do **not** carry a pre-reset address, epoch, transaction id or resource id
  forward as current configuration.

## Post-publication test plan (prepare; do not execute unattended)

Esmeralda/testnet only. Trivial values. Mainnet never. Real cross-chain
submission stays OFF.

- [ ] **A.** Publish all four templates (above), recording each template address.
- [ ] **B.** Verify all four template addresses through the indexer: exact-name
      catalogue match **and** `GET /templates/<addr>` returning a definition.
- [ ] **C.** Create one disposable public test token (a `ResourceBuilder::public_fungible()`
      resource) to pair against canonical TARI. Record its resource address.
- [ ] **D.** Instantiate exactly one tiny public pool: canonical TARI /
      the disposable test token, via `CallFunction` on the `Pool` template address.
      Record the component address.
- [ ] **E.** Verify the component and its state authoritatively — via the wallet's
      `tari_getSubstate`, which is the only source that decodes pool fields (the
      indexer returns component state as raw tagged CBOR).
- [ ] **F.** Add tiny initial liquidity. Verify: exact amounts in, LP resource
      created, `total_lp_supply` > 0, and first-depositor protection applied.
- [ ] **G.** Read reserves **authoritatively** (reread, not the pre-trade value).
- [ ] **H.** Execute one tiny swap with an explicit `min_output`. Verify exactly:
      exact input consumed; expected output matches the reference model within
      integer semantics; `min_output` respected; fee equals
      `ceil(amount_in * fee_bps / 10_000)`; post-swap reserves equal the
      reference model's post-trade reserves; LP supply unchanged by a trade;
      and history/reconciliation shows the trade.
- [ ] **I.** Remove a portion of liquidity. Verify LP burn/redemption returns the
      correct pro-rata amounts and reduces `total_lp_supply`.
- [ ] **J.** Instantiate the NFT marketplace, item-offer and collection-bid
      components.
- [ ] **K.** Test one disposable NFT listing → buy, and one item offer and one
      collection bid flow, each with trivial value and a disposable NFT.

For every step above, the comparison target is `crates/pool_ref_model`, an
independent integer-only implementation. No floating-point appears in either the
model or the template; if a mismatch is found, investigate the engine or the
protocol rather than relaxing the assertion.

## Feature gate verification

Route status is **not** hardcoded in the UI. It is read from
`crates/protocol_types/src/lib.rs` (`initial_route_matrix()`) and surfaced through
`docs/ROUTE_MATRIX.md`. To verify the gates after a change:

- **AMM routes.** `Public Fungible / Tari`, `Public Fungible / Public Fungible`,
  `Public Fungible / wSTABLE`, and `Tari / wSTABLE` must be reachable and must
  carry their issuer-risk disclosure. `Stealth Asset / *`, `Private Stablecoin / *`,
  and `Generic Confidential / *` must stay `BLOCKED` or `DESIGN_ONLY`.
- **`NFT Collection / *` as an AMM route stays `BLOCKED`.** That is about AMM
  trading of an NFT asset. It is *not* a statement about the NFT **marketplace**,
  where fixed-price listings, Buy Now, item offers, collection bids, and Sell Now
  are all `IMPLEMENTED`. Conflating the two is a documentation bug, not a gate.
- **Cross-layer.** The browser Minotari SHA atomic-swap capability must report
  `BLOCKED_EXTERNAL`, and the UI must show an explicit blocker rather than a
  button. Real cross-chain submission must report its gate as `OFF`. The reset
  and the v0.42 upgrade do **not** imply browser SHA support exists; no current
  API evidence establishes it, so the blocker stands.
- **Development-only switches must be inert in a production build.**
  `VITE_USE_FIXTURE_DATA` and `VITE_ENABLE_DEV_PROVIDERS` are refused by a
  shipped bundle and produce a blocking notice, not a silent no-op.
- **Mainnet must be unselectable.** Any network string containing `mainnet` is
  refused and the build blocks with an explicit error.
- **Endpoint identity.** Discovery must refuse an indexer whose `GET /info` names
  a different network (`WRONG_NETWORK`, distinct from `INDEXER_UNAVAILABLE`), and
  must distinguish "verified, nothing published" from "could not be read" in the
  rendered state.