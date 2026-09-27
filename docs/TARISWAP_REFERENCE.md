# TARISWAP REFERENCE

Source repository: tari-ootle (development branch)
Upstream commit: 2d6083e6cc7c98cde93dacebe2fb76b17703f588 (cloned to C:\tmp-tari, 2026-09-22)
Workspace version: 0.41.1
Template lib version: 0.32
Test tooling version: 0.41
Engine version: 0.41

## Key source paths
- crates/engine/tests/templates/tariswap/src/lib.rs
- crates/engine/tests/templates/tariswap/Cargo.toml
- crates/engine/tests/tariswap.rs
- utilities/tariswap_test_bench/src/tariswap.rs

## Template architecture
- Component: `TariSwapPool`
- Vaults: `BTreeMap<ResourceAddress, Vault>`
- LP resource: `ResourceBuilder::public_fungible().with_token_symbol("LP").build()`
- Access rules: `.with_access_rules(AccessRules::allow_all())` (placeholder)

## Constant-product AMM
Invariant: `k = a * b`

Swap formula (from source):
```
effective_input = input_amount - (input_amount * fee) / 1000
new_input = pool_input + effective_input
new_output = k / new_input
output_amount = pool_output - new_output
```
Note: fee is per-mil (e.g., 50 = 5%). Division by 1000 rounds down, taking fee from trader.

Add liquidity:
```
new_lp = (a_amount / pool_a) * a_amount + (b_amount / pool_b) * b_amount
```
Wait: source uses `a_ratio = amount / balance` (not inverse). Then:
`new_lp_amount = a_ratio * a_amount + b_ratio * b_amount`
This is proportional to `(amount^2 / balance)`, which is unusual for standard AMM share minting (should be proportional to `amount / balance`). This suggests TariSwap's share minting may not be standard. For our protocol, we must use a mathematically sound share formula.

Remove liquidity:
```
lp_ratio = lp_amount / total_lp
amount_a = ceil(lp_ratio * balance_a / 1_000_000)
amount_b = ceil(lp_ratio * balance_b / 1_000_000)
```
Note: `.div_ceil()` introduces upward rounding; over many cycles this could extract slightly more than entitlement. Must use safe integer division with documented rounding direction.

## Fee behavior
- Upstream fee is immutable after creation (`fee: u16` stored in component), expressed as **per-mil out of 1000** (e.g. 50 = 5%; range 0..100 = 0%..10%).
- 100% of fee remains in pool reserves (no separate fee vault).
- **Our protocol uses BASIS POINTS instead (OPUS-14)**: `fee_bps: u16`, `fee_bps / 10_000` (range 1..1000 bps = 0.01%..10%), default 30 bps = 0.30%. This intentionally differs from upstream's per-mil scale so the on-chain math matches `pool_math`, `protocol_types::FeeTier`, the route matrix, and the UI display.

## Native Tari
Native Tari is `STEALTH_TARI_RESOURCE_ADDRESS` (upstream: `crates/template_lib_types/src/constants.rs` line 63):`
ResourceAddress::new(ObjectKey::from_array([1u8; ObjectKey::LENGTH]))`
Alias: `TARI_TOKEN` (deprecated alias `XTR` since 0.24.5).
Divisibility: 6 (smallest unit = 0.000001 TARI; `ONE_XTR` = 1_000_000).

The TariSwap template treats Tari as any fungible/confidential/stealth resource. The AMM does not distinguish Tari from other fungible assets. The wallet layer must reveal Tari amounts before depositing into the pool component; the component itself only sees public vault balances. This is the correct privacy boundary: Tari is stealth before entry, public once in pool reserves.

## Security observations for reuse / comparison
Upstream TariSwap observations:
1. First-depositor vulnerability exists if tiny initial liquidity allows ratio manipulation. (FIXED in our template: `MINIMUM_INITIAL_LIQUIDITY = 1_000_000` enforced on first deposit)
2. No minimum liquidity lock is enforced. (FIXED in our template)
3. `AccessRules::allow_all()` must be replaced. (FIXED: strict `.set_method_access()` used)
4. `ResourceType::Stealth` and `Confidential` are accepted by `check_resource_is_fungible` but AMM math does not model privacy leakage. (DOCUMENTED: Tari is stealth before entry, public after deposit)
5. Fee math rounds down; must verify over many swaps that total fees never exceed theoretical maximum. (VERIFIED: `pool_math` property tests confirm invariant preservation and rounding protection)
