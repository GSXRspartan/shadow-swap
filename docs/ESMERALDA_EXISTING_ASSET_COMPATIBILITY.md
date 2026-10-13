# Esmeralda — Existing Wallet Asset Compatibility

**Status: `EXISTING WALLET ASSET COMPATIBILITY CHARACTERIZED`.**

Read-only + dry-run characterization of the assets **already present** in the
wallet, against the Liquidity Protocol. **No asset was created, no pool created, no
liquidity added, no swap, no listing — nothing was committed.** Evidence captured
2026-10-06 via `tools/live-executor` (loopback walletd, `submit_manifest`
`dry_run:true`) and read-only indexer GETs.

Account (authoritative from walletd): **`Purrivacy Swap`**
`component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b`.
Receive address (user-supplied): `otl_esm_1w3j5x3l8uzxccggkacly83le3…` — this is a
*receive* address, distinct from the account component used by manifests.
Network: esmeralda, byte 38, epoch ~11930.

## Inventory (8 resources)

Balances truncated to what matters for compatibility; resource **address** is the
authoritative identity (symbol is never trusted for identity).

| Resource (addr prefix) | Symbol | Kind | Revealed | Confidential | Provenance | Recall | Freeze | AMM verdict | NFT Mkt | Notes |
|---|---|---|---:|---:|---|---|---|---|---|---|
| `resource_0101…0101` | tTARI | NATIVE_TARI (Stealth) | 1,769,512 | 1,983,911,412 | native issuance (owner **None**) | DenyAll | DenyAll | **REVEALED_NATIVE_TARI_AMM_SUPPORTED** | — | canonical identity; revealed bucket + full pool create+add dry-run ACCEPT |
| `resource_a4991893…` | PTEST | PUBLIC_FUNGIBLE (div0) | 0 | 0 | INFERRED Public-Fungible creator | DenyAll | DenyAll | **DIRECT_AMM_SUPPORTED** (constructor dry-run ACCEPT) | — | ZERO_BALANCE_HISTORICAL |
| `resource_e0158c30…` | STEST | CREATED_STEALTH_FUNGIBLE | 970,000,000 | 29,000,000 | INFERRED Created-Stealth creator (`purrivacy_route: generic-stealth-fungible`) | DenyAll | DenyAll | **POOL_TEMPLATE_BLOCKED** | — | revealed bucket IS constructible; template rejects the Stealth *type* at `Pool::new`; reveal does not help |
| `resource_51e2234a…` | TNFTA | NFT (NonFungible) | 0 items | — | INFERRED NFT creator (`collection: Current Testnet Swap Fixtures`) | DenyAll | DenyAll | POOL_INELIGIBLE | MARKETPLACE_ELIGIBLE (by type) | 0 held |
| `resource_a473310d…` | TNFTB | NFT (NonFungible) | 0 items | — | INFERRED NFT creator | DenyAll | DenyAll | POOL_INELIGIBLE | MARKETPLACE_ELIGIBLE (by type) | 0 held |
| `resource_87385b51…` | LPTESTA | PUBLIC_FUNGIBLE | 992,536,297 | 0 | **PROVEN** TestCoinFactory (this protocol's ledger) | DenyAll | DenyAll | **DIRECT_AMM_SUPPORTED** (live-verified) | — | disposable test asset |
| `resource_8187d405…` | LPTESTB | PUBLIC_FUNGIBLE | 996,914,983 | 0 | **PROVEN** TestCoinFactory | DenyAll | DenyAll | **DIRECT_AMM_SUPPORTED** (live-verified) | — | disposable test asset |
| `resource_32a6a6b0…` | LP | PUBLIC_FUNGIBLE (div18) | 4,796,849 | 0 | **PROVEN** Pool v1 `component_329d4ef2…` | DenyAll | DenyAll | POOL_ELIGIBLE by type | — | pool LP share; mint/burn **ScopedToComponent**, owner **None** |

NFT items currently held: **0** → `NO_EXISTING_NFT_TEST_ASSET` for live marketplace
tests. The two NFT *collections* exist (balance 0 items each).

Provenance honesty: LPTESTA/LPTESTB/LP are **PROVEN** (this protocol created them).
tTARI is native. PTEST/STEST/TNFTA/TNFTB are **INFERRED** from resource type +
metadata consistent with the creator families — not proven by a creation receipt, so
they are not claimed as PROVEN. `PROVENANCE_UNKNOWN` is not used because the type +
metadata evidence is substantive, but the distinction PROVEN vs INFERRED is kept.

## Compatibility dry-run matrix (Pool v1 as a read-only oracle; nothing committed)

`Pool::new(a, b, 30)` dry-run, and — for the definitive native/stealth answers — a
full `Pool::new` + `add_liquidity` in one dry-run transaction. All **LIVE DRY-RUN
VERIFIED**.

| Pair | Result | Boundary / fee |
|---|---|---|
| LPTESTA × LPTESTB (public×public) | **ACCEPT** | fee est 3394 |
| LPTESTA × PTEST (public×public, div0) | **ACCEPT** | fee est 3394 |
| LPTESTA × tTARI (public×native) | **ACCEPT** | fee est 3388 |
| LPTESTA × LP (public×LP-share) | **ACCEPT** | fee est 3394 (type-eligible) |
| LPTESTA × STEST (public×created-stealth) | **REJECT** | template `validate_pool_resource` (STEST) |
| tTARI × STEST (native×created-stealth) | **REJECT** | template (STEST) |
| LPTESTA × TNFTA (public×NFT) | **REJECT** | template (non-fungible) |
| **tTARI full create + revealed-tTARI add_liquidity** | **ACCEPT** | fee est 6617 → revealed tTARI deposits into a pool vault end-to-end |
| STEST full create + add_liquidity | **REJECT** | at instruction #1 (`Pool::new`), before any deposit |
| STEST revealed-bucket (withdraw+deposit) | **ACCEPT** | walletd constructs a revealed STEST bucket (so not wallet/engine/balance blocked) |
| tTARI revealed-bucket (withdraw+deposit) | **ACCEPT** | revealed tTARI bucket constructible |

### Rejection-layer conclusions
- **Native tTARI** → `REVEALED_NATIVE_TARI_AMM_SUPPORTED`: the constructor accepts the
  canonical address, walletd builds a revealed bucket, and the engine deposits it into
  the pool vault — all proven by a committed-free dry-run. Confidential/stealth tTARI
  holdings would need a reveal first; the revealed portion is directly usable.
- **Created-Stealth (STEST)** → `POOL_TEMPLATE_BLOCKED`: rejected at `Pool::new` by the
  template's resource-type policy, **not** by the wallet or engine (a revealed STEST
  bucket is constructible). Revealing does not help: the rejection keys on the resource
  *type* (`Stealth`), which is immutable. Supporting it would require a *different* Pool
  template that deliberately accepts Created-Stealth types — not a weakening of the
  existing check.
- **Public fungibles** → `DIRECT_AMM_SUPPORTED`.
- **NFT** → `POOL_INELIGIBLE` (and marketplace-only).

## Asset security policy (recommendation for the protocol)

| Class | Policy |
|---|---|
| NATIVE_TARI (canonical) | permit (revealed) |
| PUBLIC_FUNGIBLE, recall/freeze/mutable all known-false | permit |
| PUBLIC_FUNGIBLE with recall/freeze/mutable authority | **block by default / expert override** (`ISSUER_CONTROLLED`): a recallable/freezable issuer can drain or freeze pool reserves — materially different from an immutable fungible |
| PUBLIC_FUNGIBLE with advisory facts uninspected | require acknowledgement (`UNKNOWN`) |
| CREATED_STEALTH_FUNGIBLE | unsupported for AMM on the current Pool template |
| NFT | marketplace only; never AMM |

## Frontend classification — verified correct, one coverage gap closed

The protocol-client classifiers (`classifyResource`, `classifyResourceForRouting`)
and their web consumers already classify every discovered asset to match the live
dry-run matrix: canonical tTARI → `canonical_tari`/`CANONICAL_TARI`; public fungible →
`eligible_public_fungible`/`PUBLIC_IMMUTABLE_OR_VETTED` (or `ISSUER_CONTROLLED`/`UNKNOWN`
with advisory facts); **Created-Stealth and NFT → `unsupported_resource_type`/`UNSUPPORTED`**.
No misclassification was found. The existing routing test covered `non_fungible →
UNSUPPORTED` but **not `stealth → UNSUPPORTED`** — a real gap given STEST is a held
asset. A regression pinning the real discovered inventory shapes (including the
created-stealth case) was added in `packages/protocol-client/test/amm.test.cjs`.

## Evidence classes
- **LIVE READ VERIFIED:** inventory, resource types, access rules, metadata, balances.
- **LIVE DRY-RUN VERIFIED:** the full compatibility matrix above (no state committed).
- **ENGINE / UNIT VERIFIED:** classifier behaviour (protocol-client tests), AMM invariants (engine CI).
- **INFERRED:** creator-family provenance for PTEST/STEST/TNFTA/TNFTB.
- **UNKNOWN:** none outstanding for the held assets.
