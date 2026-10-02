# Esmeralda v0.42 — Template Publication Evidence

Status: **STOPPED BEFORE SUBMISSION — no template was published.**

Nothing was instantiated, no pool/component/resource was created, no swap or NFT
operation was executed, mainnet was not enabled, and no cross-chain submission was
enabled. The four templates below are verified artifacts with verified fee estimates
and **no** on-chain address, because the automated publication path does not exist on
this toolchain. See [Blocker](#blocker).

Recorded 2026-10-02 UTC. Branch `ops/esmeralda-template-publication` (not merged).

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

No rebuild was performed and none is warranted. `docs/TESTNET_RUNBOOK.md:55` should
be corrected to `3c92b31dc1e57a32`, or made to defer to `security/LP_BASELINE.md`.

## Pre-publication state (evidence nothing was submitted)

All four fee estimates were obtained with `dry_run: true`, which executes the
transaction against the engine and returns the required fee **without** submitting
or settling anything.

- Template catalogue on indexer A and indexer B, queried by exact name:
  `Pool`, `FixedPriceListing`, `ItemOffer`, `CollectionBid` — all return
  `{"entries":[]}` except `Pool`, which returns only the builtin
  `TwoResourceLiquidityPool` (`template_address` `…0002`). No exact-name match for
  `Pool`, so none of this repository's templates is published.
- `accounts.get_balances` for `Purrivacy Swap` before and after the dry runs is
  unchanged at `4005148` revealed / `1983911412` confidential tTARI micro-units.
- The wallet's transaction list contains no `PublishTemplate` instruction.

## Fee estimates (mandatory dry-run, obtained and recorded)

Obtained via `transactions.publish_template` with `dry_run: true`, fee account
`Purrivacy Swap`, from walletd `0.42.0` against current Esmeralda state. These are
the wallet's own estimates, not hand-computed figures. No fee was hardcoded.

| # | Template | WASM bytes | Dry-run estimated fee | Fee account | Dry-run tx id |
|---|---|---|---|---|---|
| 1 | `fungible_pool` | 243934 | `1240006` | `Purrivacy Swap` | `715142b04d6ca0528e2bc809e83c41686e20a7feae696207d176beed1fe8a00c` |
| 2 | `nft_marketplace` | 196726 | `929653` | `Purrivacy Swap` | `1a85e0aa0df1f3f3bef38057a6f2f40d98d0642141580bfd340857faeb4675ea` |
| 3 | `nft_item_offer` | 201719 | `949799` | `Purrivacy Swap` | `f7e96db86a07209b8278d4bdccb0443bc5f19e75ed1e7be0aaae7cb158dcfff4` |
| 4 | `nft_collection_bid` | 201639 | `958313` | `Purrivacy Swap` | `ddf19b3368dae4c304dcdd8fcf513ac9087728f8091a4bd67035d950fca277fe` |

Total estimated publication cost: `4077771` micro-units ≈ 4.077771 tTARI, against
`4005148` available. **The total estimate exceeds the account's revealed balance.**
The shortfall is covered only because the account also holds `1983911412`
confidential tTARI micro-units; publishing will draw on the combined position, and
the fee account must be able to source the fee confidentially. This is tight enough
to matter and is called out in the manual procedure below.

Per-template actual fee, submission transaction hash, template address, publication
epoch, indexer verification, and final status are **not applicable — no submission
occurred**.

## Publication ledger (per template)

Each row is intentionally complete-with-`NOT PUBLISHED` rather than blank, so the
gap is explicit rather than ambiguous.

### 1. `fungible_pool` (publishes as template name `Pool`)

```
Template name:          Pool
Artifact path:          templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm
Artifact byte size:     243934
SHA-256:                3c92b31dc1e57a32a0bf9f146dfdd492bda4b91f18dd1cc5f7701de0404767b2
Network:                esmeralda (byte 38), Ootle v0.42.0
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Dry-run estimated fee:  1240006
Actual fee:             NOT PUBLISHED
Submission tx hash:     NOT PUBLISHED
Final tx status:        NOT PUBLISHED
Template address:       NOT PUBLISHED
Publication epoch:      NOT PUBLISHED
Indexer A verification: no exact-name `Pool` entry (only builtin TwoResourceLiquidityPool)
Indexer B verification: no exact-name `Pool` entry
Timestamp (UTC):        2026-10-02, artifact verified only
Notes:                  Artifact and fee estimate verified; no submission.
```

### 2. `nft_marketplace` (publishes as `FixedPriceListing`)

```
Template name:          FixedPriceListing
Artifact path:          templates/nft_marketplace/target/wasm32-unknown-unknown/release/nft_marketplace.wasm
Artifact byte size:     196726
SHA-256:                ca638242f8bf95dff65e314590e609a0facd1fb92257980fde16752af5fb2c19
Network:                esmeralda (byte 38), Ootle v0.42.0
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Dry-run estimated fee:  929653
Actual fee:             NOT PUBLISHED
Submission tx hash:     NOT PUBLISHED
Final tx status:        NOT PUBLISHED
Template address:       NOT PUBLISHED
Publication epoch:      NOT PUBLISHED
Indexer A verification: {"entries":[]}
Indexer B verification: {"entries":[]}
Timestamp (UTC):        2026-10-02, artifact verified only
Notes:                  Artifact and fee estimate verified; no submission.
```

### 3. `nft_item_offer` (publishes as `ItemOffer`)

```
Template name:          ItemOffer
Artifact path:          templates/nft_item_offer/target/wasm32-unknown-unknown/release/nft_item_offer.wasm
Artifact byte size:     201719
SHA-256:                e09a100c76d2245918b2a219717eb9e535f06a56514041158eff02e1467d2b12
Network:                esmeralda (byte 38), Ootle v0.42.0
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Dry-run estimated fee:  949799
Actual fee:             NOT PUBLISHED
Submission tx hash:     NOT PUBLISHED
Final tx status:        NOT PUBLISHED
Template address:       NOT PUBLISHED
Publication epoch:      NOT PUBLISHED
Indexer A verification: {"entries":[]}
Indexer B verification: {"entries":[]}
Timestamp (UTC):        2026-10-02, artifact verified only
Notes:                  Artifact and fee estimate verified; no submission.
```

### 4. `nft_collection_bid` (publishes as `CollectionBid`)

```
Template name:          CollectionBid
Artifact path:          templates/nft_collection_bid/target/wasm32-unknown-unknown/release/nft_collection_bid.wasm
Artifact byte size:     201639
SHA-256:                991244f9cc9865171f64342841b594dad1e3a4f32cb63633db31eda95fbc29d4
Network:                esmeralda (byte 38), Ootle v0.42.0
Walletd version:        0.42.0 (a43773e)
Account used:           Purrivacy Swap / component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b
Dry-run estimated fee:  958313
Actual fee:             NOT PUBLISHED
Submission tx hash:     NOT PUBLISHED
Final tx status:        NOT PUBLISHED
Template address:       NOT PUBLISHED
Publication epoch:      NOT PUBLISHED
Indexer A verification: {"entries":[]}
Indexer B verification: {"entries":[]}
Timestamp (UTC):        2026-10-02, artifact verified only
Notes:                  Artifact and fee estimate verified; no submission.
```

## Blocker

**There is no supported automated publication tool on this machine, and the
supported manual path needs a human, so automated submission was stopped rather
than improvised.**

Findings, in order of decisiveness:

1. **No `tari` CLI is installed.** `tari`, `tari_ootle_wallet_cli`, and
   `tari-console` are all absent from `PATH` and from a scan of `%USERPROFILE%\.cargo\bin`,
   `%LOCALAPPDATA%`, `%APPDATA%`, and both `Program Files` trees. The only Tari
   binaries present are the `tari_ootle_walletd` daemon itself and Tari
   Universe/Private Ballot, which are different products.

2. **The official v0.42 wallet CLI has no publish command at all.** Against the
   upstream `tari-ootle` v0.42 source, `applications/tari_wallet_cli/src` contains
   **zero** occurrences of `publish` or `PublishTemplate`. `tari publish` does not
   exist as a subcommand in this cohort, so there is nothing to run even if the
   binary were installed. The repo's own runbook agrees: `docs/TESTNET_RUNBOOK.md`
   states "There is deliberately no `publish` command in this repository."

3. **This repository deliberately has no automated publish path,** and
   `docs/TESTNET_RUNBOOK.md` lists "Do not hand-write a publish/transaction-construction
   script" as a hard rule. Publication is specified as a Web UI action.

The project instructions forbid the workarounds that would otherwise close the gap:
no third-party publication software, no custom JSON-RPC template publisher, no
one-off Rust publisher, and no bypassing the wallet's normal signing/fee behaviour.
The only mechanism that would satisfy publication is therefore the Wallet Web UI,
which needs a human click.

Note that walletd's own RPC does expose `transactions.publish_template`, and it was
used here **read-only** with `dry_run: true` to obtain the mandatory fee estimates.
That is the wallet's supported fee-estimation path, not a publisher: it executed
against the engine, returned a fee, and settled nothing — confirmed by the unchanged
balance and the absence of any `PublishTemplate` instruction in the wallet's
transaction list. Using it to actually submit would be exactly the hand-written
publisher the rules exclude, so submission was not attempted.

## Manual publication checklist (Wallet Web UI)

Everything below is available through `http://127.0.0.1:5100`, which is already
serving the wallet UI and requires no authentication in this session.

Before starting: confirm `Purrivacy Swap` shows a balance covering the remaining
total. Estimated remaining cost for all four is `4077771` micro-units; the account's
revealed balance is `4005148`, so ensure the fee is sourced from the account's
combined position.

For each template, in this order — publish one, verify it, then move on:

1. Open `http://127.0.0.1:5100` → **Publish Template**.
2. Select fee account **`Purrivacy Swap`**.
3. Upload the exact artifact:

   | # | Template | File to upload | Expected bytes | Expected SHA-256 |
   |---|---|---|---|---|
   | 1 | `Pool` | `templates\fungible_pool\target\wasm32-unknown-unknown\release\fungible_pool.wasm` | 243934 | `3c92b31dc1e57a32a0bf9f146dfdd492bda4b91f18dd1cc5f7701de0404767b2` |
   | 2 | `FixedPriceListing` | `templates\nft_marketplace\target\wasm32-unknown-unknown\release\nft_marketplace.wasm` | 196726 | `ca638242f8bf95dff65e314590e609a0facd1fb92257980fde16752af5fb2c19` |
   | 3 | `ItemOffer` | `templates\nft_item_offer\target\wasm32-unknown-unknown\release\nft_item_offer.wasm` | 201719 | `e09a100c76d2245918b2a219717eb9e535f06a56514041158eff02e1467d2b12` |
   | 4 | `CollectionBid` | `templates\nft_collection_bid\target\wasm32-unknown-unknown\release\nft_collection_bid.wasm` | 201639 | `991244f9cc9865171f64342841b594dad1e3a4f32cb63633db31eda95fbc29d4` |

4. Click **Estimate Fee** and compare with this session's dry-run figure:

   | # | Template | Expected estimated fee |
   |---|---|---|
   | 1 | `Pool` | 1240006 |
   | 2 | `FixedPriceListing` | 929653 |
   | 3 | `ItemOffer` | 949799 |
   | 4 | `CollectionBid` | 958313 |

   Do not proceed on a materially different number without investigating first.
5. Click **Publish Template** — exactly once. Do not re-click on an ambiguous
   result.
6. Record the transaction id and the template address.
7. Verify independently before starting the next template:

```bash
# (a) exact-name catalogue match — a substring hit is not enough
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=Pool&limit=100'
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=FixedPriceListing&limit=100'
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=ItemOffer&limit=100'
curl -sS 'https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=CollectionBid&limit=100'

# (b) the template definition resolves at its address (200, not 404)
curl -sS "https://ootle-indexer-a.tari.com/templates/<template_address>"

# (c) the transaction committed, not aborted
curl -sS "https://ootle-indexer-a.tari.com/transactions/<tx_id>"

# repeat (a) and (b) against indexer B
```

8. Repeat for all four, then report each result.

If a publish is acknowledged but the catalogue stays empty and the receipt is
missing or still pending, record it as `UNKNOWN`, reconcile by transaction id, and
**do not republish the same artifact**.

## Deployment configuration

No addresses were added to any deployment registry, because no address exists yet.
`crates/protocol_types` carries no live template addresses to update. Once
publication completes, the four verified addresses belong in deployment
configuration under a `CURRENT_ESMERALDA` label, kept distinct from `FIXTURE`
addresses used by tests and from any `HISTORICAL` pre-2026-09-30-reset address — no
address from before that reset is valid on the current network.

## Scope not performed, deliberately

Not done, per the phase boundary: no component instantiated, no pool created, no
resource created, no liquidity added, no swap executed, no listing/offer/collection
bid made, no unrelated template published, mainnet not enabled, real cross-chain
execution not enabled.
