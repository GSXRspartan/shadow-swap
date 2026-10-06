# Esmeralda Pool v2 — Publication + Native-tTARI Live Market

**Status: `POOL V2 + NATIVE TARI LIVE MARKET VERIFIED`.**

Pool v2 (the OPUS-16 `OwnerRule::None` fix) was published to Esmeralda, and a real
native-tTARI market was instantiated and exercised end-to-end — create → initial
liquidity → tTARI→token swap → token→tTARI swap → partial withdrawal — each step
verified against the exact integer reference math, with the component proven
**ownerless on-chain**. Executed 2026-10-06 via `tools/live-executor` (loopback
walletd; daemon-signed; no key export). Testnet only.

## Pool v2 artifact
| Fact | Value |
|---|---|
| Source commit | `d339738` (OPUS-16 fix) |
| Ootle cohort | `tari-ootle` rev `a43773e600b9503ed3fadcd3f0048f86131e3644` (git dep; `precision` + `extra-arith`) |
| Artifact | `templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm` |
| Bytes | **243,929** (v1 was 243,934) |
| SHA-256 | **`d5d3fba667aababdfe3c4e583e9de062cde7d661894faf422662aab4a9ce9377`** |
| ABI | `new, add_liquidity, swap, remove_liquidity, get_a_resource, get_b_resource, get_pool_balances, get_pool_balance, lp_resource, lp_total_supply, locked_lp_supply, fee_bps` (identical to v1) |

Local/on-chain byte equality is NOT claimed: walletd runs `wasm-opt` before publishing
(the same equivalence caveat as v1).

## Publication (LIVE VERIFIED)
| Fact | Value |
|---|---|
| **Template v2** | **`template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab`** (`CURRENT_ESMERALDA`) |
| Publication tx | `c38863bc4c5d02535e200b8b0cd150141454446d04a0114867a9d5b6ff5da34b` |
| Dry-run fee / actual | 1,240,095 / **1,240,083** |
| Status | Commit |
| Indexer A / B | name `Pool`, identical 12-fn ABI, catalogue exact match on **both** |

Pool v1 `template_ef2bc1b0…d5649` is `SUPERSEDED_TESTNET` (immutable; retains OPUS-16;
not patched on chain). Both now appear as exact `Pool` catalogue entries.

## Pool v2 component (LIVE VERIFIED)
| Fact | Value |
|---|---|
| Component | **`component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2`** |
| Instantiation tx | `029456fd9413369625d515255c8ff5a9b60e487d0dfe85794698be81cad087fe` (fee 3,182) |
| Template | `f47a330e…` (Pool v2) |
| **Owner rule** | **`None`** — verified on-chain, **and still `None` after the full lifecycle** (mandatory criterion, OPUS-16 closed live) |
| Pair | a = tTARI (`resource_0101…`), b = LPTESTA (`resource_87385b51…`) |
| LP resource | `resource_8c69acbc731c626fdd37557653ab1133b548fee654e14bbbfc747f1bcf7a3281` |
| Fee | 30 bps; default DenyAll; 9 permissionless methods; no admin |

Note: `get_a_resource`/`get_b_resource` are DenyAll (not granted) so an ownerless pool
refuses them — the pair is read from `get_pool_balances` (AllowAll). (v1 only answered
them because its creator-owner could bypass DenyAll — more evidence for `OwnerRule::None`.)

## Funding: reveal (LIVE VERIFIED)
tTARI fees come from the account's **revealed** balance. To fund the tTARI liquidity
side, 1,200,000 confidential tTARI was revealed to the same account via
`accounts.stealth_transfer` (`ConfidentialOnly` input → `revealed_output_amount`,
destination = the account's own `otl_esm…` address): tx
`4e4017c067e6ddb361d9a45b14c64a73be9619ef27e5dc8d47aed39813ef7542`, fee 300,000.
Revealed tTARI 529,429 → 1,729,429.

## Lifecycle (all LIVE VERIFIED, exact vs reference math)

**Initial liquidity** — in 1,100,000 tTARI + 1,100,000 LPTESTA (tx `fa9d1975…`, fee 5,306):
`initial_shares = floor(sqrt(1.1e6·1.1e6)) = 1,100,000`; locked **1,000**; LP to depositor
**1,099,000**; reserves 1,100,000 / 1,100,000. All matched.

**Swap tTARI → LPTESTA** — in 100,000, min_out 90,000 (tx `236bd6f5…`, fee 3,111):
`eff = 99,700`; `out = floor(1,100,000·99,700/1,199,700) = 91,414` — matched the reserve
delta exactly (LPTESTA 1,100,000→1,008,586; tTARI 1,100,000→1,200,000, full input in);
`k` grew; min respected; LP unchanged; no dev fee.

**Swap LPTESTA → tTARI** (reverse) — in 100,000, min_out 100,000 (tx `20580b3f…`, fee 3,111):
`out = floor(1,200,000·99,700/1,108,286) = 107,950` — matched (tTARI 1,200,000→1,092,050;
LPTESTA 1,008,586→1,108,586); `k` grew again.

**Partial withdrawal** — burn 500,000 LP (tx `f52332b3…`, fee 3,919):
returned `floor(500,000·1,092,050/1,100,000) = 496,386` tTARI + `floor(500,000·1,108,586/1,100,000)
= 503,902` LPTESTA — matched; LP 1,100,000→**600,000**; **locked still 1,000**; reserves
595,664 / 604,684.

## Created-Stealth policy (preserved)
STEST remains `POOL_TEMPLATE_BLOCKED` on v2 (the resource-type check is unchanged and
NOT weakened). Front-end classifies it `Stealth Asset — direct public AMM unsupported`.
A separate privacy-liquidity mechanism is future work.

## Fees / budget
This session on-chain fees ≈ **1.56 tTARI** (publish 1,240,083 + reveal 300,000 + create
3,182 + add 5,306 + 2 swaps 3,111 each + remove 3,919). Budget 20 tTARI → ~18.4 remaining.
No mainnet, no L1, no burn, no cross-chain.

## Classification
- **LIVE VERIFIED:** publication, instantiation, owner-rule None (initial + post-lifecycle),
  initial liquidity, both swap directions, partial withdrawal, reveal.
- **ENGINE VERIFIED (CI):** `opus16_pool_component_is_ownerless` + AMM invariants.
- **UNIT VERIFIED:** pool_math/pool_ref_model/protocol_types, executor, protocol-client.
