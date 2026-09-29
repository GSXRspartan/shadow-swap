# TESTNET RUNBOOK

Target network: Esmeralda (current Tari Ootle testnet)
Upstream reference: tari-ootle development branch

## Prerequisites
- Rust toolchain with wasm32-unknown-unknown target
- Node.js >= 20, pnpm
- tari-cli installed (`cargo install tari-ootle-cli`)
- Wallet daemon running for advanced/development testing (`tari_ootle_walletd --network esmeralda`)

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

### Verified build state (2026-09-28)

All four templates compile cleanly to `wasm32-unknown-unknown --release` on this
toolchain (`rustc`/`cargo` 1.97.1). Sizes, which matter because publishing fees
scale with WASM size:

| Template | Bytes |
|---|---|
| `fungible_pool` | 242,679 |
| `nft_marketplace` | 196,014 |
| `nft_item_offer` | 198,624 |
| `nft_collection_bid` | 198,829 |

Building is a local, offline, non-destructive operation. **Publishing is not,
and is not performed by any automated step in this repository** — see
[Publish the protocol templates](#publish-the-protocol-templates) below.

## Test commands
```
# Rust tests
cargo test --manifest-path crates/pool_math/Cargo.toml

# TypeScript typecheck
pnpm install
pnpm typecheck

# Build verification
ls apps/web/dist/
```

## Run web locally
```
cd apps/web
pnpm dev
# Open http://localhost:3000
```

## Inspect upstream TariSwap test
```
# Clone upstream (optional)
git clone --depth 1 https://github.com/tari-project/tari-ootle.git /tmp/tari-ootle
cat /tmp/tari-ootle/crates/engine/tests/templates/tariswap/src/lib.rs
```

## Check indexer endpoint health

The current public Esmeralda indexer is a **REST** API, not a JSON-RPC root.
The smallest useful read is `GET /info`, which also reports the network identity
this app verifies before it trusts any discovery content:

```bash
# Network identity + version. Expect network "esmeralda", network_byte 38 (0x26).
curl -sS https://ootle-indexer-a.tari.com/info
curl -sS https://ootle-indexer-b.tari.com/info

# Current epoch and block height
curl -sS https://ootle-indexer-a.tari.com/epoch-manager/stats

# Canonical TARI (tTARI) resource
curl -sS https://ootle-indexer-a.tari.com/resources/tari

# Is one of OUR templates published? (This repository's four are not, as of
# 2026-09-28. A non-empty catalogue with no matching names means the endpoint
# works and our deployment is simply empty — not an outage.)
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=pool&limit=100'
```

`POST /` with a JSON-RPC `get_version` envelope returns **404**: that endpoint
shape belongs to the old configuration and is not how `tari_indexer` 0.41.x
serves. There is **no GraphQL endpoint** on this indexer; see
[docs/LIVE_TESTNET_EVIDENCE.md](LIVE_TESTNET_EVIDENCE.md) for the full captured
API surface and the reasoning.

## Publish the protocol templates

**This is the current blocker for every live-pool workflow**, and it is a
publication step, not a coding one. Verified 2026-09-28: none of this
repository's four templates appear in
`GET /templates/catalogue?name_filter=…`, while the catalogue itself returns 100
community entries. So the endpoint is healthy and our deployment is simply empty.

Nothing in this repository publishes automatically, and nothing should. This is
the supported manual procedure, in order.

### 1. Fund a testnet account

Publishing and instantiating both cost fees. Use the wallet daemon's built-in
faucet (tTARI on Esmeralda); no real funds are involved at any point.

```bash
tari_ootle_walletd --network esmeralda
# wallet web UI at http://127.0.0.1:5100 -> claim testnet funds
```

### 2. Publish each template through the wallet web UI

**Publishing is done from the wallet web UI, not by a script.** Open
`http://127.0.0.1:5100` → *Publish Template* → select the fee account → upload
`templates/<name>/target/wasm32-unknown-unknown/release/<name>.wasm` → *Estimate
Fee* → *Publish Template* → read the resulting template address from the sidebar.

There is deliberately no `publish` command in this repository. A programmatic
publish path would need its own fee estimation, its own confirmation gate, and
its own handling of the case where a publish is acknowledged but not committed —
which is exactly the `UNKNOWN` class of problem this protocol refuses to guess
about. A human clicking *Estimate Fee* then *Publish Template* is the honest
mechanism.

Fee guidance: publishing fees scale with WASM size. These templates are
196–243 KB, so budget on the order of 150,000–250,000 fee units per template and
trust the wallet's own estimate over any figure written here.

### 3. Verify publication landed

Publication is only real once the chain says so:

```bash
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=fungible_pool&limit=100'
curl -sS 'https://ootle-indexer-a.tari.com/templates/<template_address>'
```

### 4. Then, and only then, revisit discovery

With components deployed, discovery can be pointed at the REST endpoints that
actually serve them. Until a pool *component* exists there is nothing to
discover, and no amount of endpoint work changes that — which is why the
discovery-protocol gap (R-14) is a follow-up to this step rather than a
substitute for it.

### What must NOT be done to work around this

- Do **not** publish as part of a test run or a CI job.
- Do **not** hand-write a publish/transaction-construction script.
- Do **not** point discovery at something that returns plausible-looking pool
  records so the UI has rows. That is fabricated discovery data in a production
  path, which this repository refuses anywhere, and it is exactly the failure
  mode the outage states exist to prevent.
- Do **not** treat "endpoint works" as "we have a deployment". They are
  different facts and the code now keeps them apart.

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
  button. Real cross-chain submission must report its gate as `OFF`.
- **Development-only switches must be inert in a production build.**
  `VITE_USE_FIXTURE_DATA` and `VITE_ENABLE_DEV_PROVIDERS` are refused by a
  shipped bundle and produce a blocking notice, not a silent no-op.
- **Mainnet must be unselectable.** Any network string containing `mainnet` is
  refused and the build blocks with an explicit error.
- **Endpoint identity.** Discovery must refuse an indexer whose `GET /info` names
  a different network, and must distinguish "verified, zero pools" from
  "could not be read" in the rendered state.

