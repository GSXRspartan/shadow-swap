<div align="center">

# Shadow Swap

**Shadow Swap is a non-custodial liquidity and NFT trading protocol built for Tari's Ootle network. It provides markets where users can trade compatible assets created through Tari wallets, applications, and asset-creation tools.**

[![Node Tests](https://github.com/GSXRspartan/shadow-swap/actions/workflows/node-tests.yml/badge.svg)](https://github.com/GSXRspartan/shadow-swap/actions/workflows/node-tests.yml)
[![Security Engine Tests](https://github.com/GSXRspartan/shadow-swap/actions/workflows/security-engine-tests.yml/badge.svg)](https://github.com/GSXRspartan/shadow-swap/actions/workflows/security-engine-tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#licensing)

`Swift` `TypeScript` `Rust` — **Esmeralda testnet** — **mainnet disabled**

</div>

> [!WARNING]
> **TESTNET / EXPERIMENTAL.** Mainnet is intentionally disabled in every layer of this build.
> Do not use funds you cannot afford to lose. Nothing in this repository is an audit, a
> guarantee, or a claim of production readiness — see [Project status](#project-status) and
> [Security](#security) for exactly what has and has not been verified.

---

## Overview

### What Shadow Swap is

A liquidity venue for Tari. Assets are created elsewhere — in Tari wallets, in
asset-creation applications, and with the tooling those tools expose. Shadow Swap is
where those assets then find each other: you swap them, you supply liquidity against
them, and you buy and sell the NFTs among them.

### Why it exists

Tari's Ootle network can hold user-issued assets, but "can hold" and "can trade"
are different problems. Something has to provide the market: price assets against
one another, discover what is on offer, and settle it without anyone taking custody
of the funds in between.

Most Tari asset tooling stops at creation. An asset you minted is an asset you
alone hold. Shadow Swap is the missing half — the layer where assets acquire a price
from other people, not from the person who issued them.

### How it complements Tari asset creators

The relationship is deliberately one-directional:

> **Create or acquire Tari assets through supported wallets and applications, then
> trade compatible assets or provide liquidity through Shadow Swap.**

Shadow Swap does not mint assets, custody assets, or replace a wallet. It assumes
assets already exist and routes them. An asset that cannot enter a public fungible
pool — a Stealth or Confidential resource, for example — is labelled as unsupported
rather than quietly offered.

### Public fungible AMM trading

A constant-product pool over any **eligible public fungible** pair, plus native
tTARI. The pool holds its own reserves in vault substates; the frontend reads them
authoritatively from the wallet provider and never from an indexer's summary.

### Native tTARI markets

tTARI is identified by its **resource address**, never by its ticker. Two resources
can both render as "TARI"; only one is the settlement asset of the layer 2. Anything
that would treat them as interchangeable is refused.

### Liquidity provision

Deposit both sides in the current reserve ratio, receive LP tokens, withdraw a
proportional share later. A permanently locked portion of LP supply anchors the pool
against first-depositor manipulation.

### NFT marketplace

Three marketplace templates, each verified settling live on Esmeralda:

| Flow | What it does |
|---|---|
| **FixedPriceListing** | Seller names a price; buyer pays; NFT and payment swap atomically through escrow. |
| **ItemOffer** | Buyer escrows an amount for a specific item; seller accepts or the offer is cancelled and refunded. |
| **CollectionBid** | Buyer escrows price × quantity for a collection; sellers fill it; unused escrow is released. |

### Future privacy-preserving liquidity

Stealth and Confidential assets are modelled and explicitly routed **away** from the
public AMM rather than into it. The privacy work is a separate lane: bringing them
into a public pool today would break the confidentiality the asset exists to provide.

### Future Tari L1/L2 routing

A cross-layer router (Minotari L1 burn/claim → Ootle L2 swap) is designed and
documented but **not live**. The browser provider gap that blocks it is tracked in
[`docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md`](docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md).

### Shadow Swap and Atomic Swap

These are separate products with related branding, not two halves of one:

- **Atomic Swap** is an asset-creation and direct-exchange application.
- **Shadow Swap** is the liquidity and trading venue that other tools feed.

They share the Tari stack and the Shadow identity. There is **no technical
integration between them in this repository** — no shared contract, no shared
state, no shared call path. They are related the way a marketplace and a minting
tool are related: you use one, then you use the other.

---

## Features

Stated by what has actually been demonstrated, not by what is intended.

### ✅ Live verified

Every item here has committed on Esmeralda with a recorded transaction id and a
reconciled readback.

- **Pool v2** (ownerless `OwnerRule::None`) instantiated, funded, and traded. A live
  1 000-raw-unit tTARI swap committed with the pool product invariant **increased**:
  `595 664 × 604 684 = 360 168 168 176` → `596 664 × 603 674 = 360 168 168 336`.
- **FixedPriceListing** settled — listing `SOLD`.
- **ItemOffer** settled — offer `ACCEPTED`.
- **CollectionBid** settled — bid `FILLED`.
- **Ootle v0.46.0 / Protocol V2** migration complete across all eight manifests,
  four templates rebuilt, engine suite green on Linux CI.
- **WASM module-shape ceilings** verified safe by a non-mutating publish dry-run of
  all four templates against the live 0.46.0 daemon. Nothing was published.

### 🧪 Testnet available

- AMM swap, add liquidity, remove liquidity — through the browser wallet provider.
- All nine marketplace operations: create / buy / cancel a listing, make / accept /
  cancel / refund an offer, create / fill / cancel / refund a bid.
- Durable wallet approvals that survive a page reload.

### ⚠️ Experimental

- **Durable wallet approval and resume.** Implemented and tested against a reference
  provider. **Not verified against a live browser wallet** — see
  [Unverified browser-provider behaviour](#unverified-browser-provider-behaviour).
- **Cross-layer XTM → TARI routing.** Designed and documented, not live.
- **Market data and charts.** Derived from indexer reads. The charts are display
  only: no executable quote is ever computed from them.

### 🔨 Under development

- Privacy-preserving liquidity for Stealth and Confidential assets.
- Mainnet configuration. Mainnet is disabled in code, not merely in documentation.

### 💡 Planned

- Routing across more than two hops.
- Better execution for multi-hop routes.

### ❌ Not claimed

No mainnet readiness. No audit certification. No published TVL or trading volume —
those would be numbers this repository cannot honestly produce at testnet scale.

---

## Architecture

```
                   ┌──────────────────────────┐
                   │   Browser (apps/web)     │
                   │  React 19 + Vite 6 SPA   │
                   └───────────┬──────────────┘
                               │ window.tari
                   ┌───────────▼──────────────┐
                   │  Tari wallet provider    │
                   │  Universe / Sapient      │
                   └───────────┬──────────────┘
                               │ tari_getSubstate
                               │ tari_createTransactionRequest
                               │ tari_submitTransactionRequest
                   ┌───────────▼──────────────┐
                   │  Ootle chain (Esmeralda) │
                   └───────────┬──────────────┘
                               ▲
        ┌──────────────────────┴──────────────────────┐
        │                                             │
┌───────┴────────┐                          ┌─────────┴─────────┐
│ Wallet / signer│                          │  Ootle indexer    │
│ (walletd)      │                          │  (discovery only) │
└────────────────┘                          └───────────────────┘
```

| Layer | Where | What it does |
|---|---|---|
| **Smart-contract templates** | `templates/` | Four Ootle templates: `fungible_pool`, `nft_marketplace`, `nft_item_offer`, `nft_collection_bid`. Ownerless by construction. |
| **Protocol client** | `packages/protocol-client/` | Authoritative multi-substate decoders, AMM and marketplace resolvers, the execution/reconciliation flow, and the durable history store. **The only source of economic truth.** |
| **Wallet adapter** | `packages/wallet-adapter/` | The `window.tari` boundary and the transaction builders. Contains no wallet-brand checks anywhere. |
| **Frontend** | `apps/web/` | React 19 + Vite 6. Renders what the protocol client resolved; computes no economics. |
| **Indexers** | `services/` (frontend) | **Discovery and advisories only.** Never used to satisfy an authoritative read, a settlement proof, or a quote. |
| **Local testnet executor** | `tools/live-executor/` | A guarded, reviewed CLI that runs operations against a **local** wallet daemon. Every operation is dry-run first. |

### The one architectural rule

> **Indexers discover. They never decide.**

Every reserve, every balance, every listing status shown before an action is reread
from the chain through the wallet provider immediately before that action. Discovery
data is advisory and is labelled as such in the UI.

---

## Security

### Non-custodial architecture

There is no operator key, no admin function, and no upgrade path in any published
template. Funds move only through escrows whose release condition is the template's
own logic.

### Ownerless Pool v2

Pool v2 is published with `OwnerRule::None`. The pool has no owner, so there is no
account that can drain reserves, re-point the pair, or change the fee after
deployment. Pool v1 (ownerful) is superseded; the frontend refuses it as a
destination for new liquidity.

### Scoped LP mint/burn

LP tokens are minted only in proportion to a correctly-ratioed deposit and burned
only against a proportional redemption of both reserves. The pool cannot be drained
by minting unbacked LP.

### Permanently locked LP

A portion of LP supply is permanently locked and cannot be redeemed. This raises the
cost of a first-depositor attack, which is the standard defence for an unweighted
constant-product pool.

### 30 bps AMM fee

A fixed 30 bps (0.30%) swap fee, enforced on-chain and read back from the pool
component rather than assumed by the frontend.

### Resource identity checks

- Canonical tTARI is identified by **resource address**, never by ticker text.
- The pool decoder is fail-closed on every malformation: a wrong template, a pair
  that does not match what the caller expected, a vault whose resource container
  does not match the declared resource. **There is no fallback to a lenient parse.**
- Unsupported resource types (Stealth, Confidential) are labelled unsupported
  rather than offered.

### Transaction review and reconciliation

Every financial operation produces a frozen, human-readable review before the wallet
is asked to sign. Three gates run immediately before signing:

1. **No concurrent approval** — a second wallet request cannot be minted while one
   is still unresolved, because approving both would execute both.
2. **Identity** — provider object, network, account, and capabilities are re-read
   live and compared against the snapshot the user reviewed.
3. **Review** — the review is re-diffed against the intent that will be signed.

After submission, outcomes are reconciled **by durable identifier**. `UNKNOWN` is a
first-class state meaning "not yet known", never "failed" and never "retry".

### Known limitations

- **Not audited.** The repository contains an internal audit record and a hostile
  frontend review, which are engineering self-review, not third-party assurance.
- **Browser-provider approval is unverified live.** See below.
- **`CallFunction` wire spelling is unverified against a browser wallet.** The
  instruction is documented in the Ootle transaction reference and the field names
  come from the Rust enum, but unlike `CallMethod` it has not been verified against
  a deployed provider. A wallet that does not recognise it rejects the request, which
  fails closed.
- **Stealth/Confidential assets are unsupported in the public AMM** by design.
- **Cross-layer routing is not live.**
- **No mainnet deployment exists.**

---

## Getting started

### Prerequisites

- **Node.js ≥ 20**
- **pnpm 9.x** (pinned to major 9 — CI uses `pnpm/action-setup` v9 and the lockfile
  is `lockfileVersion 9.0`; a pnpm 10 lockfile cannot be read by pnpm 9)
- **Rust + `wasm32-unknown-unknown`** — only to build the templates
- A **Tari wallet** exposing the browser provider (Universe or a compatible
  extension), on the **Esmeralda** network

### Installation

```bash
pnpm install
```

### Environment setup

```bash
cp .env.example .env
```

Defaults are correct for local development. You almost certainly do not need to
change anything: the indexer URLs, the network, and the CSP host allowlist all
default to the live Esmeralda endpoints.

| Variable | Default | Notes |
|---|---|---|
| `VITE_TARI_NETWORK` | `esmeralda` | Only `esmeralda` and `localnet` are allowed. Mainnet is rejected in code. |
| `VITE_INDEXER_URL` | live Esmeralda indexer | Discovery only, never authoritative. |
| `VITE_WALLETD_URL` | local walletd | Only used by the dev provider. |
| `VITE_USE_FIXTURE_DATA` | unset | **Never set in production.** Renders fixtures. |
| `VITE_ENABLE_DEV_PROVIDERS` | unset | Enables the dev provider double. Leave unset in production. |

### Development

```bash
pnpm --filter @tari-ootle/web dev
```

### Build

```bash
pnpm build                                  # everything
pnpm --filter @tari-ootle/web build         # frontend + its CJS test build
```

### Test

```bash
pnpm test                                                  # every workspace
pnpm --filter @tari-ootle/protocol-client run test         # protocol client
pnpm --filter @tari-ootle/web run test                    # frontend unit tests
pnpm --filter @tari-ootle/web run test:e2e:all            # Playwright, all browsers
```

Browser tests need Playwright browsers installed once:

```bash
pnpm --filter @tari-ootle/web run test:e2e:install
```

### Wallet requirements

The dApp uses the official Tari browser-provider interface and branches on
**capabilities**, never on which wallet is installed:

| Method | Used for |
|---|---|
| `tari_getCapabilities` | The mandatory handshake, and the only feature-selection mechanism |
| `tari_getNetwork` | Network pre-check before connecting |
| `tari_requestAccounts` / `tari_getAccounts` | Explicit connect, and re-reads |
| `tari_getBalances` | Display balances and LP positions |
| `tari_getSubstate` | **Every** authoritative pool and marketplace read |
| `tari_createTransactionRequest` | Durable approval request |
| `tari_getTransactionRequest` | Poll approval state, and resume after a reload |
| `tari_submitTransactionRequest` | Submit the exact approved request, by id |

A wallet that does not advertise `transactionRequests` falls back to the one-shot
sign-and-submit path. Everything still works; it simply loses reload survival.

---

## Deployment

### Published Esmeralda templates

These are **live on-chain deployment identities**. They are not affected by the
product rename and must not be republished because the name changed.

| Template | Address |
|---|---|
| Pool v2 | `template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab` |
| FixedPriceListing | `template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329` |
| ItemOffer | `template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6` |
| CollectionBid | `template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54` |

Live Pool v2 component:
`component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2`

### Testnet deployments

The frontend is configured for the **Cloudflare Pages** project `ootle-liquidity-testnet`.
That project name predates the rename and is **deliberately unchanged** — renaming it
would require a coordinated Cloudflare-side change, and an existing working deployment
should not be taken down for branding. The *product* name inside the app is Shadow
Swap; the *hosting project* name is unchanged.

### Source build artifacts

Templates build to `templates/*/target/wasm32-unknown-unknown/release/*.wasm`. The
Cargo crate names (`fungible_pool`, `nft_marketplace`, `nft_item_offer`,
`nft_collection_bid`) determine those filenames and are load-bearing for CI — they
are technical identifiers, not product names.

### Future mainnet deployment

Does not exist. Mainnet is rejected by the network guard in every layer, so a
mainnet configuration is a code change, not a flag flip.

---

## Project status

Current: **Ootle v0.46.0, Protocol V2, Esmeralda testnet.**

### Verified on-chain

| Evidence | Result |
|---|---|
| Pool v2 live swap | Committed; product invariant **increased** |
| FixedPriceListing | `SOLD` |
| ItemOffer | `ACCEPTED` |
| CollectionBid | `FILLED` |
| v0.46 module-shape ceilings | All four templates accepted by a non-mutating publish dry-run |
| Engine suite under v0.46 | Green on Linux CI |

Full evidence, including the exact transaction ids, the operation ledger, and the
migration record:

- [`docs/OOTLE_V046_MIGRATION.md`](docs/OOTLE_V046_MIGRATION.md)
- [`docs/V046_BROWSER_TRADING_AND_MARKETPLACE_UX.md`](docs/V046_BROWSER_TRADING_AND_MARKETPLACE_UX.md)
- [`docs/ESMERALDA_POOL_V2_REPORT.md`](docs/ESMERALDA_POOL_V2_REPORT.md)
- [`tools/live-executor/live-op-ledger.jsonl`](tools/live-executor/live-op-ledger.jsonl) — the append-only record of every operation, live and dry-run

### Not verified

- **Live browser-wallet approval.** Every transaction in the evidence above was
  submitted through `walletd` via the CLI executor. The browser path is exercised
  only against a reference provider double and unit tests.
- **Mainnet.** Nothing.
- **Third-party audit.** None.

### Unverified browser-provider behaviour

Stated plainly rather than implied by a green test suite:

1. The durable create → approve → submit trio, and resuming an approval after a
   reload, are implemented and unit-tested but **have never been driven by a real
   wallet**. The protocol-client brand that distinguishes "still awaiting approval"
   from "failed" is exercised only by doubles.
2. The `CallFunction` instruction spelling used by all three marketplace **create**
   operations is derived from the Ootle transaction reference and the Rust enum, not
   from a live provider's accepted payload.
3. Provider *replacement* semantics are handled (`classifyProviderTransition`
   distinguishes late initialisation from a real replacement) but have only been
   observed against the reference provider.

None of these are cosmetic. Each would need a real wallet and a human approving a
real request before it could be called verified.

---

## Security

Deeper material, kept as records rather than marketing:

- [`docs/FRONTEND_SECURITY_MODEL.md`](docs/FRONTEND_SECURITY_MODEL.md)
- [`docs/FRONTEND_TRUST_BOUNDARIES.md`](docs/FRONTEND_TRUST_BOUNDARIES.md)
- [`security/FRONTEND_RESIDUAL_RISKS.md`](security/FRONTEND_RESIDUAL_RISKS.md)
- [`security/FRONTEND_INVARIANTS.md`](security/FRONTEND_INVARIANTS.md)
- [`security/LP_INVARIANTS.md`](security/LP_INVARIANTS.md)
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)
- [`docs/FIRST_DEPOSIT_AUDIT.md`](docs/FIRST_DEPOSIT_AUDIT.md)
- [`docs/LP_AUTHORITY_MODEL.md`](docs/LP_AUTHORITY_MODEL.md)

Historical attack matrices are kept as historical records and are never rewritten.

---

## Repository layout

| Path | What lives there |
|---|---|
| `templates/` | The four Ootle smart-contract templates |
| `packages/protocol-client/` | Decoders, resolvers, execution flow, history |
| `packages/wallet-adapter/` | The `window.tari` boundary and transaction builders |
| `packages/ui-components/` | Shared React components |
| `apps/web/` | The browser dApp |
| `apps/extension/`, `apps/mobile/` | Scaffolds — not yet part of the shipped application |
| `crates/` | `pool_math`, `pool_ref_model`, `protocol_types` |
| `audit_engine_tests/` | The real Ootle engine test suite |
| `tools/live-executor/` | Guarded testnet executor |
| `security/`, `docs/` | Audits, threat models, evidence |

> **Note on package names.** The workspace packages are `@tari-ootle/web`,
> `@tari-ootle/protocol-client`, and friends. They were **not** renamed. They are
> referenced by import specifier in ~50 sites, by CI, by the test harness, and by the
> lockfile, and they are also accurate — they describe the chain they target. A
> product rename does not make a technical identifier wrong.

---

## Contributing

Open an issue describing the behaviour you expected and what happened. For security
issues, do not open a public issue — see the security model documents above for the
reporting path.

---

## Licensing

Declared **MIT** in `package.json`.

> **Gap:** no `LICENSE` file is committed yet, so the licence badge above links to a
> section rather than to the licence text. That is a real omission and should be
> closed before the repository is published anywhere public. Third-party dependency
> licences are listed in [`docs/THIRD_PARTY_LICENSES.md`](docs/THIRD_PARTY_LICENSES.md).