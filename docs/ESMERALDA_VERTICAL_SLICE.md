# ESMERALDA VERTICAL SLICE EVIDENCE

Status: **PUBLISHED + COMMITTED + VERIFIED** (all four templates; see `docs/ESMERALDA_V042_DEPLOYMENT.md`)

Historical note: this file originally recorded status PARTIAL with deployment blocked by an
unavailable CLI/walletd. Those blockers are resolved as of 2026-10-02.

Date: 2026-09-22 (vertical slice) · updated 2026-10-02 (publication reconciliation)
Repo commit: 223cc2f (with updates through current session)
Upstream tari-ootle: v0.42.0 cohort, rev `a43773e600b9503ed3fadcd3f0048f86131e3644`
Local Rust: 1.97.1
Local Node/pnpm: v24.14.0 / 11.6.0
Target network: Esmeralda, network byte 38 (current Tari Ootle testnet)

## Template Source
Path: templates/fungible_pool/src/lib.rs
Build command intended (when in tari-ootle workspace):
```
cd templates/fungible_pool
cargo build --target wasm32-unknown-unknown --release
```
WASM output path (expected): target/wasm32-unknown-unknown/release/fungible_pool.wasm
SHA-256: `3c92b31dc1e57a32a0bf9f146dfdd492bda4b91f18dd1cc5f7701de0404767b2` (243,934 bytes; built and published 2026-10-02)

## Template Design Reference
Based on upstream TariSwap (`C:\tmp-tari\crates\engine\tests\templates\tariswap\src\lib.rs`) with the following critical differences:

| Feature | TariSwap (upstream test) | Our Fungible Pool |
|---------|--------------------------|-------------------|
| Access rules | `AccessRules::allow_all()` (placeholder, UNSAFE) | Strict method-level rules; no admin access |
| Admin withdrawal | Not present in upstream either | Explicitly absent; no `adminWithdraw` method exists |
| Fee scale | Per-mil out of 1000 (`fee / 1000`) | **Basis points out of 10_000** (`fee_bps / 10_000`); default 30 bps = 0.30% (OPUS-14: differs intentionally from upstream's per-mil) |
| Fee immutability | Stored as `fee: u16`, no setter after new | Same — `fee_bps: u16`, no `set_fee` method |
| LP mint | `ResourceManager::get(lp_resource).mint_fungible(...)` | Same mechanism; only component can mint via access rules |
| Resource validation | `check_resource_is_fungible` accepts Fungible/Confidential/Stealth | Same validation; rejects non-fungible |
| First deposit protection | None in TariSwap | Basic protection: initial share calculation uses large base factor (1_000_000) to prevent extreme ratio manipulation; minimum liquidity lock recommended for production |
| Reserve drain protection | None explicitly | Integer arithmetic only; zero reserve checks; output must be non-zero |
| Native Tari | Treated as fungible resource address in TariSwap | Explicitly supported through resource pair validation |

## Security Decisions in Template
- `AccessRules` configured with `set_method_access` per method rather than `AccessRules::allow_all()`.
- `add_constraint` includes `.set_call_fee_only(true)` and `.add_hook(ResourceAuthAction::Burn, OwnerRule::ResourceOnly(lp_resource))` to restrict LP burn to resource owners.
- `new()` initializes the pair deterministically using canonical lexicographic ordering.
- `fee` stored as `u16`; no setter method provided.
- No `recover_funds`, `set_owner`, `upgrade`, `pause`, `freeze`, `set_recipient`, `admin_withdraw`, or similar privileged methods exist.
- Pool reserves stored in `BTreeMap<ResourceAddress, Vault>`; withdrawals only through `remove_liquidity` (burning LP shares) or `swap` (with fee retained).

## Math Verification (Independent from TariSwap)
All arithmetic uses `pool_math` crate (integer only, no f32/f64):
- `amount_in_with_fee` computes `amount_in * (denom - fee) / denom` (down-round, protects LP).
- `swap_output_amount` computes standard fee-adjusted constant product.
- `new_reserves_after_swap` updates reserves with full input (fee included) and reduced output.
- Invariant `k_after >= k_before` verified by `verify_swap_invariant`.
- Rounding protection verified by `check_rounding_protection` (repeated swaps must not extract value beyond mathematical entitlement).

## Required Commands for Full Vertical Slice (not yet executed)
The following commands require `tari-cli` (not currently in PATH) and an active wallet daemon connection to Esmeralda. They are documented for manual execution by an engineer with the appropriate environment.

### 1. Build template WASM
```
cd templates/fungible_pool
cargo build --target wasm32-unknown-unknown --release
# Verify output:
ls target/wasm32-unknown-unknown/release/fungible_pool.wasm
```

### 2. Inspect / publish template (requires tari-cli and wallet daemon API key)
```
tari build
# If successful, outputs WASM binary and template_metadata.cbor
tari publish -a <esmeralda_account_name> --api-key <wallet_daemon_key>
# Expected output: Template published with address like template_... and metadata hash
```

> **Superseded 2026-10-02 — do not run these commands.** `tari publish` does not exist
> in the v0.42 cohort: the official `tari_wallet_cli` has no publish subcommand, so
> there is no `--api-key` flag to pass either. Publication was performed through the
> wallet Web UI at `http://127.0.0.1:5100` instead. The resulting address is recorded in
> `docs/ESMERALDA_V042_DEPLOYMENT.md`. The commands are kept only as a record of the
> originally intended approach.

### 3. Create test fungible token resource
This requires either a faucet template or an existing token resource. For the vertical slice:
```
# If using a test token already on Esmeralda:
# Record resource address (e.g., ResourceAddress("resource_...") for Tari native or test token)
```

### 4. Instantiate pool component
```
# Transaction manifest must include:
# - Call `Pool::new(resource_a, resource_b, 30)` (fee_bps = 30 => 0.30%)
# - Use exact resource addresses for native Tari and test token
# - Submit via wallet daemon with proper account proof
```
Expected outputs to capture:
- Component address (`ComponentAddress`)
- LP resource address (`ResourceAddress`)
- Transaction hash
- Epoch

### 5. Add liquidity
```
# Build transaction that:
# - Withdraws Tari from account (with NonFungibleProof for account ownership)
# - Withdraws test token from account
# - Calls Pool::add_liquidity(a_bucket, b_bucket)
# - Deposits resulting LP bucket back to account
```
Expected outputs:
- Tari balance before/after
- Token balance before/after
- LP shares received
- Component reserve state (read via `get_pool_balances`)
- Transaction hash

### 6. Execute Tari -> Token swap
```
# Build swap transaction:
# - Withdraw Tari (small amount, e.g., 10 units)
# - Call Pool::swap(tari_bucket, token_resource_address)
# - Set non-zero min_output explicitly in transaction arguments/manifest
# - Deposit output token back to account
```
Expected outputs:
- Tari reserve before/after
- Token reserve before/after
- Actual output amount
- Fee retained (calculated as `amount_in * 3 / 1000`)
- Transaction hash

### 7. Execute Token -> Tari swap (reverse)
Same pattern as step 6, with token as input and Tari as output.

### 8. Failed slippage / impossible min-output test
Intentionally set `min_output` higher than mathematically possible (greater than reserve output) and confirm the transaction is rejected by the engine or results in zero output assert failure. Capture failure evidence.

### 9. Remove liquidity
```
# Build removal transaction:
# - Withdraw LP shares
# - Call Pool::remove_liquidity(lp_bucket)
# - Deposit returned Tari and token buckets back to account
```
Expected outputs:
- LP shares burned
- Tari returned (proportional to share ratio)
- Token returned (proportional to share ratio)
- Component reserve state after removal
- Transaction hash

### 10. Final empty/pool verification
After full removal, verify reserves are zero (or near-zero due to integer division floor) and no stray LP supply exists. Confirm no unauthorized reserve remains in pool component.

## Deployment Blockers — RESOLVED as of 2026-10-02

The blockers recorded in this file have been resolved. All four protocol templates are
published and verified on Esmeralda. See `docs/ESMERALDA_V042_DEPLOYMENT.md` for the
authoritative addresses, transaction ids, fees, and epochs.

| Old blocker | Current state |
|---|---|
| `tari-ootle-cli` not installed | Still not installed, and **still not needed**: the official v0.42 `tari_wallet_cli` has no `publish` subcommand at all. Publication was performed through the wallet Web UI. |
| `tari_ootle_walletd` not installed | Resolved. `tari_ootle_walletd` `0.42.0` (`a43773e`) runs on `127.0.0.1:5100` against Esmeralda. |
| Upstream workspace not in build chain | Resolved. Templates build from crates.io/git `tari-ootle` rev `a43773e`. |
| `tari publish` unavailable | Resolved by the Web UI path; no CLI publish command exists to call. |
| `fungible_pool.wasm` never produced | Resolved. Built at 243,934 bytes, SHA-256 `3c92b31d…`. |

The stale command list below is retained for history only. Do **not** run
`tari publish`; that subcommand does not exist in this cohort. The remaining real
step is instantiation, covered in `docs/ESMERALDA_V042_DEPLOYMENT.md`.

## What IS Verified in This Run
- Template source (`templates/fungible_pool/src/lib.rs`) exists, is syntactically valid Rust (`rustfmt` passes), uses upstream TariSwap-style API (`Component`, `Vault`, `Bucket`, `AccessRules`, `ResourceBuilder`, `ResourceManager`), replaces `AccessRules::allow_all()` with strict method-level rules, excludes all privileged admin methods, enforces immutable fee (no setter), validates resource types, and uses integer-only arithmetic.
- Math crate (`pool_math`) independently verified with 28 passing tests (including property tests for overflow, division by zero, rounding protection, reserve depletion, first-deposit ratio safety).
- Security model (`docs/SECURITY_MODEL.md`) explicitly states no admin withdrawal, no upgrade mechanism, 100% fees to LPs, no protocol fee.
- Route matrix (`docs/ROUTE_MATRIX.md`) marks P0 (Public Fungible / Tari Native) as Experimental (not TESTED) until actual engine/testnet execution succeeds.

## Exact Next Commands Required (historical — steps 1–5 are DONE)
```
# 1. Install tari-cli — NOT DONE, and not needed. The v0.42 tari_wallet_cli has no
#    publish subcommand, so installing it would not enable publication.
#    cargo install tari-ootle-cli

# 2. DONE. Wallet daemon runs on Esmeralda:
tari_ootle_walletd --network esmeralda -b /path/to/config

# 3. DONE. Template builds from crates.io/git tari-ootle rev a43773e:
cd templates/fungible_pool
cargo build --target wasm32-unknown-unknown --release

# 4. NOT APPLICABLE. `tari build` is not a v0.42 command either.

# 5. DONE, via the Wallet Web UI at http://127.0.0.1:5100, NOT via CLI.
#    `tari publish` does not exist; there is no --api-key flag to pass.
#    Resulting address recorded in docs/ESMERALDA_V042_DEPLOYMENT.md

# 6. Instantiate pool on Esmeralda — THE NEXT REAL STEP.
#    Requires: a disposable public test token resource, then CallFunction on
#    template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649.
#    No programmatic publish/instantiate path exists; use the wallet Web UI or an
#    SDK client that submits through walletd's normal signing and fee flow.
```

### Exact next step for the first live pool instantiation

1. Restart walletd on Esmeralda (`tari_ootle_walletd --network esmeralda --authentication none --listen-on 127.0.0.1:5100 run`).
2. Confirm the fee account `Purrivacy Swap` still holds tTARI — the four publications cost `4077739` micro-units and the revealed balance is tight, so fund it before instantiating.
3. Create one disposable `ResourceBuilder::public_fungible()` test token (runbook step C) and record its resource address.
4. Call `new(a_addr, b_addr)` on `template_ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649`, pairing canonical tTARI (`resource_0101…0101`) with that test token, paying the fee from `Purrivacy Swap`.
5. Verify the component authoritatively via the wallet's `tari_getSubstate` (the indexer returns component state as raw tagged CBOR), then proceed to runbook steps F onward with trivial values.

Esmeralda/testnet only. Mainnet never. Real cross-chain submission stays OFF.

## Security Check During Template Development
Inspected during this session:
- Template has NO `adminWithdraw`, `setFee`, `setRecipient`, `upgrade`, `pause`, `freeze`, `recoverFunds` methods.
- `AccessRules` uses `.set_method_access()` for each public method (`swap`, `add_liquidity`, `remove_liquidity`, `get_pool_balances`, `get_pool_balance`, `lp_resource`, `lp_total_supply`, `fee`).
- `.add_constraint()` restricts LP burn to resource owner.
- `fee` is `u16` with no mutation method.
- `new()` asserts `a_addr != b_addr`, validates fungible resources, and enforces fee range.
- `swap()` asserts non-zero reserves (prevents division by zero / drain) and non-zero output (prevents useless swap / potential rounding extraction).
- `add_liquidity()` asserts non-zero amounts and calculates shares based on reserve ratios (not arbitrary mint authority).
- `remove_liquidity()` uses floor division (`.floor()` equivalent through integer division) to prevent over-withdrawal beyond proportional entitlement.
- `canonical_pair()` orders resources lexicographically to prevent duplicate pools for reversed pairs.

No serious security issues discovered in template source. First-deposit vulnerability remains a documented limitation (no minimum initial liquidity lock enforced by component). Recommended fix for production: enforce a minimum initial deposit amount (e.g., `assert!(a_amount > MINIMUM && b_amount > MINIMUM)`) or implement a minimum locked liquidity mechanism.
