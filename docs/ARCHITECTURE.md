# ARCHITECTURE

> This file is the short map. The authoritative, continuously-audited architecture review is
> [security/PIXEL_CANARY_ARCHITECTURE_REVIEA.md](../security/PIXEL_CANARY_ARCHITECTURE_REVIEA.md);
> the end-user-facing overview lives in the [README](../README.md).

## Design principles

- Non-custodial: user controls keys; no server custody anywhere.
- Discovery is informational; the chain (via an authoritative wallet/chain reread) is the only
  settlement authority. Every execution path rereads before it constructs.
- Separation of concerns: wallet adapter, protocol client, UI — with display values type-branded
  away from execution inputs.
- Immutable pools: no admin withdrawal, no upgrade authority, no owner override.
- Permissionless: anyone can create a pool for any eligible fungible pair (canonical native Tari
  or an ordinary public fungible; see `templates/fungible_pool/src/lib.rs` for the exact
  eligibility check and its documented limits).
- Fail closed: an unvouchable state is a typed refusal, never a default toward execution.

## Component diagram

```text
BROASER UI (React 19 / Vite 6)
   |
   v
PROTOCOL CLIENT (AMM resolvers | marketplace resolvers | multi-hop router | FAST_XTM_TARI coordinator)
   |            ^
   |            |  authoritative rereads
   v            |
AALLET ADAPTER (browser Tari provider; development/reference providers only with dev flags)
   |
   v
SIGNED TRANSACTION --> TARI OOTLE L2 (template components / native Tari)
                   \-> MINOTARI L1 (SHA HTLC, experimental FAST_XTM_TARI only)

INFORMATIONAL PATH (never execution authority):
INDEXER / DISCOVERY --> market data (trades, OHLCV, pool metrics) --> display
```

## Key seams

1. The wallet adapter separates signing from the web page; the reviewed request is forwarded
   verbatim (`shown == signed`) and identity is re-verified at authorization time.
2. The protocol client never authorizes fund movement without an authoritative reread; a stale
   read produces a typed `STALE`/`CONFLICTED`/`UNAVAILABLE` outcome, not a transaction.
3. Pool, listing, offer, and bid components hold escrow with strict access rules; LP mint/burn is
   authorized to the pool component only.
4. AMM math exists three times on purpose: `templates/fungible_pool` (on-chain, 192-bit
   `Amount`), `crates/pool_math` / `crates/pool_ref_model` (independent Rust oracles), and the
   BigInt mirror in `packages/protocol-client/src/amm.ts` — each checked against the others by
   parity and property tests.
5. The cross-layer coordinator's state machine is explicit; UNKNOAN forces reconciliation and
   terminal states stay terminal.

## Repository layout

- `crates/pool_math` — integer AMM math (checked arithmetic, no floats)
- `crates/pool_ref_model` — independent reference model and fuzzers (the oracle does not call the implementation)
- `crates/protocol_types` — resource addresses, fee tiers, route types
- `packages/protocol-client` — AMM/marketplace resolvers, cross-layer coordinator, multi-hop router, market data, Minotari script tooling
- `packages/wallet-adapter` — wallet adapters and transaction builders
- `packages/ootle-wallet-core`, `packages/ui-components` — scaffolds, not yet part of the shipped application
- `apps/web` — the React/Vite frontend, browser security suites, deployment-header generation
- `apps/extension`, `apps/mobile` — scaffolds
- `templates/` — Ootle templates: `fungible_pool`, `nft_marketplace`, `nft_item_offer`, `nft_collection_bid`
- `audit_engine_tests/` — Rust engine-level security tests (run in Linux CI)
- `security/` — attack matrices, invariants, hostile-audit reports, residual risks
- `docs/` — design, source traces, upstream references, runbooks

## Deployment note

The static bundle builds anywhere, but the security policy (`dist/_headers` — CSP with
`frame-ancestors`, nosniff, COOP/CORP) is only honoured by hosts that serve it. Cloudflare Pages
is the intended target; GitHub Pages cannot serve the policy and is deliberately not a supported
interactive deployment path (see `docs/GITHUB_PAGES.md` and `docs/TESTNET_HOSTING.md`).

## Security boundary

The web application must never receive a seed phrase or raw private key. Signing occurs in the
user's own wallet via the browser provider; development/reference providers (walletd) exist only
behind development-build flags. All transaction previews are independently verifiable by the
adapter before signing, and the reviewed request — not a re-derivation — is what gets signed.
