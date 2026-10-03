# Esmeralda v0.42 — Template Deployment Evidence

Status: **ALL FOUR TEMPLATES PUBLISHED + COMMITTED + PARTIALLY VERIFIED.**

`PARTIALLY VERIFIED` is deliberate and precise. Every address is confirmed on chain,
committed, and independently visible through **both** live indexers, with the
publication transaction, epoch, and actual fee recovered from receipts. What is *not*
verified is byte-for-byte on-chain hash equality with the local artifacts, because the
wallet optimises every binary with `wasm-opt` before publishing, so the on-chain code
is not the local file. The strongest available equivalence evidence — an identical
`tari_tdef` section digest — does match on all four, and is recorded below.

No component was instantiated, no pool created, no resource created, no swap
executed, no NFT operation performed, mainnet not enabled, no cross-chain submission
enabled. Reconciliation only; nothing was submitted in this session.

Reconciled 2026-10-02 UTC by read-only indexer inspection, after a human published all
four through the wallet Web UI. Branch `ops/esmeralda-template-publication` (not merged).

## CURRENT_ESMERALDA — live template addresses

These four addresses are **CURRENT_ESMERALDA**: verified committed on Esmeralda
(network byte 38) as of the epoch column below, and listed as `CURRENT_ESMERALDA` for
use by the next phase. They are **not** fixtures — no test in this repository depends
on them, and none of the synthetic fixture addresses used by tests was modified.

| # | Template name | Template address (`CURRENT_ESMERALDA`) |
|---|---|---|
| 1 | `Pool` | `template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649` |
| 2 | `FixedPriceListing` | `template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329` |
| 3 | `ItemOffer` | `template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6` |
| 4 | `CollectionBid` | `template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54` |

No address from before the 2026-09-30 reset is carried forward anywhere in this file.

## Publication table

| Template | Template address | Artifact path | Bytes | SHA-256 | Publication tx hash | Actual fee | Publication epoch | Indexer A | Indexer B | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `Pool` | `template_ef2bc1b0…d5649` | `templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm` | 243934 | `3c92b31dc1e57a32a0bf9f146dfdd492bda4b91f18dd1cc5f7701de0404767b2` | `be3e196f97fa0783f32b91d19889e58553092e5fcdf663216a291654405f7525` | 1239998 | 11775 | confirmed | confirmed | PUBLISHED + COMMITTED + PARTIALLY VERIFIED |
| `FixedPriceListing` | `template_612114e3…a2329` | `templates/nft_marketplace/target/wasm32-unknown-unknown/release/nft_marketplace.wasm` | 196726 | `ca638242f8bf95dff65e314590e609a0facd1fb92257980fde16752af5fb2c19` | `ef528553e7792378f4e21b6e0ab3b6c2ec5bc2f21696f206e9399204a7814212` | 929645 | 11776 | confirmed | confirmed | PUBLISHED + COMMITTED + PARTIALLY VERIFIED |
| `ItemOffer` | `template_083fef7d…22a6` | `templates/nft_item_offer/target/wasm32-unknown-unknown/release/nft_item_offer.wasm` | 201719 | `e09a100c76d2245918b2a219717eb9e535f06a56514041158eff02e1467d2b12` | `b2d9cad4091257913b96c64a1fac4d9fa707475261560004e6f303b810613926` | 949791 | 11775 | confirmed | confirmed | PUBLISHED + COMMITTED + PARTIALLY VERIFIED |
| `CollectionBid` | `template_999ef37f…06a54` | `templates/nft_collection_bid/target/wasm32-unknown-unknown/release/nft_collection_bid.wasm` | 201639 | `991244f9cc9865171f64342841b594dad1e3a4f32cb63633db31eda95fbc29d4` | `dd5c7e267862f494fb8a8a5dde7daecdbe2e21a9e38941f97e1ba75c15168ee1` | 958305 | 11775 | confirmed | confirmed | PUBLISHED + COMMITTED + PARTIALLY VERIFIED |

Total actual publication fee: **4077739** micro-units ≈ 4.077739 tTARI.

`Actual fee` is `total_fees_paid` from the on-chain receipt (the amount actually
charged). `total_fee_payment` was 8–11 units higher per transaction; that difference is
the exhaust burn rounding and is recorded per template below.

## What "PARTIALLY VERIFIED" means here

Verified independently, through two separate indexers:

1. **Existence.** `GET /templates/<address>` returns HTTP 200 on indexer A **and** indexer
   B for all four, with a parseable template definition.
2. **Substate.** `GET /substates/template_<address>` returns HTTP 200 on both, with the
   template at **version 0** (never updated), the expected `template_name`, and the same
   `author` public key `74654347e7e08d8c2116ee3e43c7f98bda0d619e1a0cc94faacb55ff36d57341`
   on all four — the `Purrivacy Swap` account owner key, so all four were published by
   the same fee account.
3. **Catalogue.** Exact-name `GET /templates/catalogue?name_filter=<name>` returns exactly
   one entry per name, whose `template_address` equals the address above, on both indexers.
   For `Pool` the filter returns 3 entries but only **one** exact `Pool` match — the other
   two are substring hits (`TwoResourceLiquidityPool` builtin and similar), which is exactly
   why the runbook insists on exact-name matching.
4. **Transaction.** `GET /transactions/<tx_id>` returns HTTP 200 on both indexers; the
   receipt outcome is `Commit` and the transaction body carries a single
   `PublishTemplate` instruction.
5. **ABI identity.** The on-chain function list matches the source `pub fn` set for each
   template exactly — `Pool`: `new, add_liquidity, swap, remove_liquidity, get_a_resource,
   get_b_resource, get_pool_balances, get_pool_balance, lp_resource, lp_total_supply,
   locked_lp_supply, fee_bps`; `FixedPriceListing`: `create, buy, cancel, listing`;
   `ItemOffer`: `create, accept, cancel, refund_expired, offer`; `CollectionBid`:
   `create, fill, cancel, refund_expired, bid`.
6. **Binary equivalence (the strongest available correlation).** Each on-chain binary's
   `tari_tdef` custom section is **byte-identical** to the same section in the local
   artifact — same length, same SHA-256. See below.
7. **Cross-checked fee encoding.** The `pay_fee` literal embedded in each transaction
   decodes (CBOR `0x1a` uint32) to the receipt's `total_fee_payment` value, so the fee is
   corroborated from two independent fields rather than one.

Not verified, and not claimed:

- **Byte-for-byte SHA-256 equality between the local artifact and the on-chain binary.**
  The API does not expose a digest of the published code in the local artifact's form,
  and equality in fact does *not* hold: walletd runs `wasm-opt --optimize-for-size`
  (with `StripDebug`, `StripProducers`, `StripTargetFeatuers`) on every publish before
  the transaction is built. On-chain code is ~32% smaller than the artifact.

## Why on-chain size differs from artifact size (resolved, not a mismatch)

`applications/tari_walletd` optimises the binary before publishing
(`handlers/transaction.rs:734` → `services::wasm_optimizer.rs`). The engine also rejects
any custom section other than `tari_tdef`, so the optimiser strips the toolchain-emitted
`name`, `producers`, and `target_features` sections. Both effects are visible:

| Template | Artifact bytes | On-chain `code_size` | Delta | Local custom sections | On-chain custom sections |
|---|---|---|---|---|---|
| `Pool` | 243934 | 160497 | −34.2% | `tari_tdef`, `name`, `producers`, `target_features` | `tari_tdef` only |
| `FixedPriceListing` | 196726 | 133393 | −32.2% | same four | `tari_tdef` only |
| `ItemOffer` | 201719 | 135919 | −32.6% | same four | `tari_tdef` only |
| `CollectionBid` | 201639 | 136418 | −32.3% | same four | `tari_tdef` only |

The `tari_tdef` digest is preserved through optimisation, which is what makes the
correlation meaningful:

| Template | `tari_tdef` length | `tari_tdef` SHA-256 (local **and** on-chain) |
|---|---|---|
| `Pool` | 835 | `aa751cf3e4e8b647144d8ff5671424bfe18b139b04c0174efb310bcaafb70394` |
| `FixedPriceListing` | 358 | `6ecfc75453928a2abd052e728836850d66ade9ac09b1419a3e40e5105c934d4f` |
| `ItemOffer` | 389 | `6c3ba93175ddab13c883b33e65b9d9e760886fafb6e054e2cfa6cddc43e75b0c` |
| `CollectionBid` | 409 | `910d79ab7222c406dcec99fc98cfe0b2da4b1e4db29a0ad3be0f603e39d304e8` |

`tari_tdef` is the engine's own template-definition section: it carries the template
name and the full ABI. Identical digests on all four, retrieved from two independent
indexers, is strong evidence that each published template was built from the artifact
recorded in this repository at commit `635a8d4`. It is **not** the same claim as
identical code bytes, and is not recorded as such.

## Per-template reconciliation detail

### 1. `Pool` — CURRENT_ESMERALDA

```
Template name:          Pool
Template address:       template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649
Artifact path:          templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm
Artifact byte size:     243934
SHA-256:                3c92b31dc1e57a32a0bf9f146dfdd492bda4b91f18dd1cc5f7701de0404767b2
Network:                esmeralda (byte 38), Ootle v0.42.0 cohort (rev a43773e)
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Publication tx hash:    be3e196f97fa0783f32b91d19889e58553092e5fcdf663216a291654405f7525
Final tx status:        Commit (Accept)
Actual fee:             1239998   (total_fee_payment 1240009, exhaust_burn 1239998)
Dry-run estimate:       1240006  — actual is 8 units below estimate
Publication epoch:      11775
On-chain code_size:     160497
tari_tdef SHA-256:      aa751cf3e4e8b647144d8ff5671424bfe18b139b04c0174efb310bcaafb70394 (matches local)
Indexer A:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200
Indexer B:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200; binary identical to A
Status:                 PUBLISHED + COMMITTED + PARTIALLY VERIFIED
Notes:                  Fee paid confidentially from the account's stealth tTARI position.
```

### 2. `FixedPriceListing` — CURRENT_ESMERALDA

```
Template name:          FixedPriceListing
Template address:       template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329
Artifact path:          templates/nft_marketplace/target/wasm32-unknown-unknown/release/nft_marketplace.wasm
Artifact byte size:     196726
SHA-256:                ca638242f8bf95dff65e314590e609a0facd1fb92257980fde16752af5fb2c19
Network:                esmeralda (byte 38), Ootle v0.42.0 cohort (rev a43773e)
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Publication tx hash:    ef528553e7792378f4e21b6e0ab3b6c2ec5bc2f21696f206e9399204a7814212
Final tx status:        Commit (Accept)
Actual fee:             929645    (total_fee_payment 929656, exhaust_burn 929645)
Dry-run estimate:       929653   — actual is 8 units below estimate
Publication epoch:      11776
On-chain code_size:     133393
tari_tdef SHA-256:      6ecfc75453928a2abd052e728836850d66ade9ac09b1419a3e40e5105c934d4f (matches local)
Indexer A:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200
Indexer B:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200; binary identical to A
Status:                 PUBLISHED + COMMITTED + PARTIALLY VERIFIED
Notes:                  Published one epoch after the other three.
```

### 3. `ItemOffer` — CURRENT_ESMERALDA

```
Template name:          ItemOffer
Template address:       template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6
Artifact path:          templates/nft_item_offer/target/wasm32-unknown-unknown/release/nft_item_offer.wasm
Artifact byte size:     201719
SHA-256:                e09a100c76d2245918b2a219717eb9e535f06a56514041158eff02e1467d2b12
Network:                esmeralda (byte 38), Ootle v0.42.0 cohort (rev a43773e)
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Publication tx hash:    b2d9cad4091257913b96c64a1fac4d9fa707475261560004e6f303b810613926
Final tx status:        Commit (Accept)
Actual fee:             949791    (total_fee_payment 949802, exhaust_burn 949791)
Dry-run estimate:       949799   — actual is 8 units below estimate
Publication epoch:      11775
On-chain code_size:     135919
tari_tdef SHA-256:      6c3ba93175ddab13c883b33e65b9d9e760886fafb6e054e2cfa6cddc43e75b0c (matches local)
Indexer A:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200
Indexer B:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200; binary identical to A
Status:                 PUBLISHED + COMMITTED + PARTIALLY VERIFIED
Notes:                  —
```

### 4. `CollectionBid` — CURRENT_ESMERALDA

```
Template name:          CollectionBid
Template address:       template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54
Artifact path:          templates/nft_collection_bid/target/wasm32-unknown-unknown/release/nft_collection_bid.wasm
Artifact byte size:     201639
SHA-256:                991244f9cc9865171f64342841b594dad1e3a4f32cb63633db31eda95fbc29d4
Network:                esmeralda (byte 38), Ootle v0.42.0 cohort (rev a43773e)
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Publication tx hash:    dd5c7e267862f494fb8a8a5dde7daecdbe2e21a9e38941f97e1ba75c15168ee1
Final tx status:        Commit (Accept)
Actual fee:             958305    (total_fee_payment 958316, exhaust_burn 958305)
Dry-run estimate:       958313   — actual is 8 units below estimate
Publication epoch:      11775
On-chain code_size:     136418
tari_tdef SHA-256:      910d79ab7222c406dcec99fc98cfe0b2da4b1e4db29a0ad3be0f603e39d304e8 (matches local)
Indexer A:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200
Indexer B:              GET /templates/… 200; /substates/… 200 v0; catalogue exact match; tx 200; binary identical to A
Status:                 PUBLISHED + COMMITTED + PARTIALLY VERIFIED
Notes:                  A repeat attempt returned
                        FailedToLockInputs: Substate template_999ef37f…06a54:0 already exists
                        and cannot be created as an output. That is duplicate-publication
                        evidence for THIS address and confirms version 0 is committed.
                        No further publication was submitted.
```

## Environment as observed

| Fact | Value | Source |
|---|---|---|
| walletd version | `0.42.0` (`tari_ootle_walletd-0.42.0-a43773e-windows-x64.exe`) | `wallet.get_info` |
| walletd command line | `--network esmeralda --authentication none --base-path C:\Users\pdark\.tari\ootle\v042-esmeralda-bootstrap --listen-on 127.0.0.1:5100 run` | process inspection |
| JSON-RPC endpoint | `http://127.0.0.1:5100/json_rpc` | live |
| network | `esmeralda` | `wallet.get_info` |
| network byte | `38` (0x26) | `wallet.get_info` |
| indexer A | `https://ootle-indexer-a.tari.com` — `/info` version `0.43.0`, network `esmeralda`, byte `38` | live |
| indexer B | `https://ootle-indexer-b.tari.com` — identical | live |
| current epoch | `11774` | `GET /network` on both indexers |
| template cohort | `tari-ootle` rev `a43773e600b9503ed3fadcd3f0048f86131e3644` — the same rev as the walletd build | `templates/*/Cargo.toml` |

Both previously verified indexer hosts are still live and still serve
`network=esmeralda`, `network_byte=38`. Note they now report indexer software
version `0.43.0` while the wallet is `0.42.0`; that is the indexer's own version
string and is not a contradiction of the network identity the rest of this record
depends on. No live templates were found on either host for any of the four expected
names (see [Pre-publication state](#pre-publication-state)).

Local walletd test session used no authentication: it was launched with
`--authentication none`, and `auth.method` returns `{"method":"none"}`. No
credentials of any kind are recorded in this file.

## Accounts

Two accounts exist. The first is the wallet default and is the one used for fee
estimation; it is the correct choice because it is confirmed on chain and holds the
largest tTARI position.

| Account | Component address | Default | Confirmed | tTARI (revealed) |
|---|---|---|---|---|
| `Purrivacy Swap` | `component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b` | yes | yes | `4005148` (divisibility 6) ≈ 4.005148 tTARI |
| `V042_ATOMICSWAP_TEST_COUNTERPARTY` | `component_b510055406cbe43325aa7790a38f980eb03d354f525b0acc7c59461b07dde77d` | no | yes | `4888910` ≈ 4.888910 tTARI |

There is no ambiguity about which account is funded: both hold tTARI. The
counterparty account carries a name specific to atomic-swap testing and is not the
protocol's general fee account, so `Purrivacy Swap` was selected as the wallet
default. tTARI is `resource_0101…0101`, a Stealth resource, and is the canonical
native fee resource.

## Artifacts (verified)

All four were located at the expected paths. Sizes match the previously verified
v0.42 artifacts exactly.

| Template | Artifact path | Bytes | SHA-256 |
|---|---|---|---|
| `fungible_pool` | `templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm` | 243934 | `3c92b31dc1e57a32a0bf9f146dfdd492bda4b91f18dd1cc5f7701de0404767b2` |
| `nft_marketplace` | `templates/nft_marketplace/target/wasm32-unknown-unknown/release/nft_marketplace.wasm` | 196726 | `ca638242f8bf95dff65e314590e609a0facd1fb92257980fde16752af5fb2c19` |
| `nft_item_offer` | `templates/nft_item_offer/target/wasm32-unknown-unknown/release/nft_item_offer.wasm` | 201719 | `e09a100c76d2245918b2a219717eb9e535f06a56514041158eff02e1467d2b12` |
| `nft_collection_bid` | `templates/nft_collection_bid/target/wasm32-unknown-unknown/release/nft_collection_bid.wasm` | 201639 | `991244f9cc9865171f64342841b594dad1e3a4f32cb63633db31eda95fbc29d4` |

Last modified (UTC): `fungible_pool` 2026-10-01 18:50:00, `nft_marketplace`
2026-10-01 13:42:01, `nft_item_offer` 2026-10-01 13:42:33, `nft_collection_bid`
2026-10-01 13:43:06.

### A stale digest in the runbook, and why it is not a rebuild trigger

`docs/TESTNET_RUNBOOK.md:55` lists `fungible_pool` with SHA-256 prefix
`70dbff826362bbcf`, which does **not** match the artifact on disk
(`3c92b31dc1e57a32…`). This is a stale documentation entry, not a modified
artifact:

- Commit `e811fe5` ("docs: record the artifact digest at this commit and the strip
  caveat") updated the authoritative digest table in `security/LP_BASELINE.md`
  from `70dbff826362bbcf` to `3c92b31dc1e57a32`. The artifact on disk matches the
  authoritative table exactly, on all four templates.
- `security/LP_BASELINE.md` documents that the release profile does not set
  `strip = true`, so the digest tracks source line numbers and moves on a
  comment-only edit. **Size is the stable property here.**
- All four byte sizes match the previously verified v0.42 figures exactly.

No rebuild was performed and none is warranted. `docs/TESTNET_RUNBOOK.md:55` has since
been corrected to `3c92b31dc1e57a32` and now defers to `security/LP_BASELINE.md` as the
authoritative digest table.

## Pre-publication state (historical, 2026-10-02, superseded)

Before publication, the template catalogue on **both** indexers returned no exact-name
entry for any of the four templates: `FixedPriceListing`, `ItemOffer` and
`CollectionBid` returned `{"entries":[]}`, and `Pool` returned only the builtin
`TwoResourceLiquidityPool` (`template_address` `â€¦0002`). Both indexers now return
exactly one exact-name entry per template, so the difference between these two states is
the four publications recorded above.

The `Purrivacy Swap` tTARI balance read `4005148` revealed / `1983911412` confidential
micro-units at that point and `1911615` revealed / `1983911412` confidential after
publication.

> **Unreconciled detail, stated rather than smoothed over.** The revealed balance fell
> by `2093533`, but the receipts sum to `4077739` in total fees paid. These do not
> reconcile 1:1, and this file does not claim they do. The most likely explanation is
> that the fees were sourced from the account's *confidential* stealth-tTARI outputs, so
> they do not all present as a reduction in the revealed figure; the confidential figure
> is unchanged. A full reconciliation would need the per-output wallet view, and
> walletd was no longer running when the ending balance was read, so it was not
> obtainable read-only. The authoritative fee numbers are the on-chain receipt values
> (`total_fees_paid`) recorded in the table above, which do not depend on this
> reconciliation.

## Fee estimates (pre-publication dry-run) vs actual fees

The mandatory estimates were obtained before publication via
`transactions.publish_template` with `dry_run: true` â€” the wallet's own estimate, not a
hand-computed figure. They are retained here because the estimate/actual comparison is
itself evidence that publication behaved predictably.

| # | Template | Artifact bytes | Dry-run estimate | Actual paid | Delta |
|---|---|---|---|---|---|
| 1 | `Pool` | 243934 | 1240006 | 1239998 | âˆ’8 |
| 2 | `FixedPriceListing` | 196726 | 929653 | 929645 | âˆ’8 |
| 3 | `ItemOffer` | 201719 | 949799 | 949791 | âˆ’8 |
| 4 | `CollectionBid` | 201639 | 958313 | 958305 | âˆ’8 |
| | **Total** | | **4077771** | **4077739** | **âˆ’32** |

Every actual fee came in 8 units below its estimate, which is the expected exhaust-burn
rounding rather than a coincidence. No fee was hardcoded at any point.

## Duplicate-publication evidence

The `CollectionBid` publish was attempted twice. The second attempt was refused by the
engine:

```
FailedToLockInputs: Substate template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54:0
already exists and cannot be created as an output
```

This is treated strictly as duplicate-publication evidence, and nothing further was
submitted. It independently corroborates three things at once: the address is real, its
version is `0`, and it was already committed at the time of the retry. The
`GET /substates/` read independently confirms version `0` and that the binary has never
been updated.

## How these addresses were verified (reproducible)

Every claim above is reproducible with read-only GETs. No transaction was submitted in
this reconciliation.

```bash
A=https://ootle-indexer-a.tari.com
B=https://ootle-indexer-b.tari.com

# network identity (both must report esmeralda / 38)
curl -sS $A/info; curl -sS $B/info

# existence + ABI + on-chain code size
curl -sS $A/templates/template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649
curl -sS $B/templates/template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649

# committed substate: template_name, author, version 0, full binary
curl -sS $A/substates/template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649
curl -sS $B/substates/template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649

# exact-name catalogue match (a substring hit is NOT sufficient)
curl -sS "$A/templates/catalogue?name_filter=Pool&limit=100"
curl -sS "$A/templates/catalogue?name_filter=FixedPriceListing&limit=100"
curl -sS "$A/templates/catalogue?name_filter=ItemOffer&limit=100"
curl -sS "$A/templates/catalogue?name_filter=CollectionBid&limit=100"

# publication transactions: Commit + PublishTemplate instruction + fees
curl -sS $A/transactions/be3e196f97fa0783f32b91d19889e58553092e5fcdf663216a291654405f7525
curl -sS $A/transactions/ef528553e7792378f4e21b6e0ab3b6c2ec5bc2f21696f206e9399204a7814212
curl -sS $A/transactions/b2d9cad4091257913b96c64a1fac4d9fa707475261560004e6f303b810613926
curl -sS $A/transactions/dd5c7e267862f494fb8a8a5dde7daecdbe2e21a9e38941f97e1ba75c15168ee1
```

### Note for automation

The indexer's `/transaction-receipts` endpoint honours a `limit` parameter but **ignores
`offset`** â€” every page returned byte-identical content. Receipt-paging tools must not
assume `offset` works here; a bounded scan of the newest page is the correct approach,
and all four publications were in fact found within the newest 100 receipts.

## Deployment configuration

The four `CURRENT_ESMERALDA` addresses live in this document, which is the canonical
record for them.

No live addresses were added to source code or config. Deliberately:

- `apps/web` discovers templates by **catalogue name** (`ootleIndexer.ts` queries
  `/templates/catalogue` and reads `template_address` from the response), so it needs no
  hardcoded address and would work against any deployment of the same templates.
- `crates/protocol_types` holds route gating, not addresses.
- **No fixture address was modified.** Synthetic fixture data used by tests is a
  separate concern and must stay synthetic.

Any future registry file that stores live addresses should keep the three labels
distinct â€” `FIXTURE`, `HISTORICAL`, `CURRENT_ESMERALDA` â€” and no `HISTORICAL` address
from before the 2026-09-30 reset is valid on the current network.

## Scope not performed, deliberately

Not done, per the phase boundary: no component instantiated, no pool created, no
resource created, no liquidity added, no swap executed, no listing/offer/collection
bid made, no unrelated template published, mainnet not enabled, real cross-chain
execution not enabled.
