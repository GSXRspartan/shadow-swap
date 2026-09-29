# TESTNET RUNBOOK

Target network: Esmeralda (current Tari Ootle testnet)
Upstream reference: tari-ootle development branch

## Prerequisites
- Rust toolchain with wasm32-unknown-unknown target
- Node.js >= 20, pnpm
- tari-cli installed (`cargo install tari-ootle-cli`)
- Wallet daemon running for advanced/development testing (`tari_ootle_walletd --network esmeralda`)

## Build templates
```
# Build the pool math crate
cargo build --manifest-path crates/pool_math/Cargo.toml --target wasm32-unknown-unknown --release

# Build web frontend
pnpm install
pnpm --filter @tari-ootle/web build
```

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

## Feature gate verification
- Confirm BLOCKED routes (Stealth, Stablecoin, NFT) are disabled in UI.
- Confirm Experimental routes (Public Fungible / Tari) display warnings but allow preview.
- Confirm wallet adapter returns unsupported for Sapient mode.
