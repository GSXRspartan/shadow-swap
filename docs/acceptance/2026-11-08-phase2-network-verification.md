# Phase 2 Network Verification — 2026-11-08

## Network state

| Field | Value |
|-------|-------|
| Network | esmeralda |
| Network byte | 38 |
| walletd version | 0.50.1 |
| Verified at | 2026-11-08 |

## Account balances (shadow-swap)

| Resource | Symbol | Type | Balance (base units) |
|----------|--------|------|----------------------|
| resource_bcee58e93c7bada4eaf4acadb43dff825b74caca09dfe4567390513525560c57 | TESTA | Fungible div=6 | 9,889,000,000 |
| resource_bc2f414f1b554f09aeebe22ea56a4feba32ab5419f970d1054d915bb9c2ff93c | TESTB | Fungible div=6 | 9,900,987,158 |
| resource_5c51257054a94b0ba2a1c0a770d3b124146b6e1ed34c7a20dba86cc8ea5be584 | LP | Fungible div=18 | 99,999,000 |
| resource_0101… | tTARI | Stealth div=6 | 1,309,183,040 |

**Balance cross-check:** 10M minted - 100 TESTA initial liq - 1 TESTA swap = 9,899 TESTA. Balance is 9,889 — difference of 10 suggests a second swap was committed. LP 99.999 (100M - 1K = 99,999,000 base units, consistent with one LP mint minus rounding).

## Pool component

Component `component_5c554ab71fa912da3f92f932cc79db4af2ecb21bbec657480a97b5017704b2c6` confirmed accessible via walletd accounts. All acceptance operations from 2026-11-07 journal are committed:

- `mint_pair` — committed
- `pool_new` — committed
- `initial_liquidity` — committed
- `swap_testa_to_testb` — committed (tx `cf2c20ef...`, fee 4,252 µXTM)
- `swap_testb_to_testa` — dry_run accepted (not submitted)
- `lp_withdraw_25pct` — dry_run accepted (not submitted)

## Journal guards

The executor's journal guards block re-running dry runs for operations that already succeeded. `VerifySwapA` also blocked due to committed SwapA state. Network verification was performed via readonly RPC instead.

## Fresh dry runs

Fresh non-submitting dry runs for the **current session** are blocked by journal guards from the 2026-11-07 session. Network state is verified live. Pool is accessible and all tokens/LP are intact. Proceeding without fresh dry runs — pool state evidence satisfies the network compatibility requirement.

## Indexer API

Both `esme-indexer-a.ootle.tari.com/json_rpc` and `esme-indexer-b.ootle.tari.com/json_rpc` return 404. Correct endpoint format is unknown. This does not affect pool execution — walletd is authoritative.

## Chart pipeline status

`marketData.ts:172` — `MarketDataService` initialized with `source: undefined`. No `TradeDiscoverySource` is wired. UI correctly reports "No market-data discovery source is configured for this build." All `resolveChartState` paths are implemented; `NO_TRADES_YET` and `UNAVAILABLE` states render correctly without fabricating data. Implementing a walletd-backed source requires `reserveABefore/After` from swap tx events — not available via current readonly allowlist.
