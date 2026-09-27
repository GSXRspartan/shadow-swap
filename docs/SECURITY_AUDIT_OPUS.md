# SECURITY AUDIT — Tari Ootle Fungible Liquidity Pool (Opus run)

> Adversarial, hostile audit. Nothing here is trusted because a previous agent, a
> comment, or a passing test said so. Every finding below is tied to specific source
> and, where the environment allowed, to real engine execution (blocked here — see that section).

## Executive Summary

The pool template as committed at the audited HEAD (with the uncommitted working-tree
changes applied) was **non-functional and fund-losing**, not merely imperfect:

- **Redemption returned nothing.** `remove_liquidity` computed `ratio = lp_amount / total_lp`
  as integer division *before* multiplying by the reserve. For any provider owning less than
  100% of supply (i.e. everyone, since a minimum is permanently locked), this is `0`, so the
  LP was burned and **zero tokens were returned** — all pool reserves permanently trapped.
- **The fee was not charged.** `swap` computed a fee-reduced input into a throwaway
  variable and then used the *full* input in the constant-product step, so the invariant `k`
  stayed flat: a 0.00% effective fee, LPs earning nothing. A regression from the very upstream
  demo it was derived from.
- **Liquidity provision was not permissionless.** The LP resource was built with
  `mintable(DenyAll)`. The engine grants the *resource owner* an implicit mint/burn override
  (`tracker_auth.rs`), and the owner defaulted to the pool creator's signer. So only the
  creator could ever add liquidity; any other provider's transaction was rejected at the mint.
- **New liquidity providers were silently diluted.** `add_liquidity` deposited buckets into
  the vaults *before* reading reserves, so the share denominator already included the new
  deposit, under-minting the provider and leaking value to incumbents.
- **No on-chain slippage control.** `swap` had no `min_output` parameter; slippage/sandwich
  protection was impossible at the authoritative layer.

All five, plus several lower-severity issues, were fixed in this run with minimal, immutable,
deterministic changes (no admin hatches). Real Ootle engine tests were written against the
compiled-to-WASM template (`audit_engine_tests/`); however their **execution is blocked on this
Windows host** because the v0.41.1 engine is Cranelift-only and Cranelift does not build on Windows
(see Real Engine Test Evidence). The findings are therefore established from the exact semantics of
the pinned engine source and a differential against the authoritative upstream builtin
`liquidity_pool`, not from an engine run. The corrected math mirrors that upstream builtin.

**This code is NOT ready for mainnet, and is only conditionally ready for an Esmeralda
test-fund trial** (see Readiness). The pre-fix state proves the previous agents' "TESTED"/
"secure" claims were false; treat all remaining non-engine-proven claims with suspicion.

## Scope

- `templates/fungible_pool/src/lib.rs` — the on-chain AMM template (primary).
- `templates/fungible_pool/Cargo.toml`, `Cargo.lock` — build/version pinning.
- `crates/pool_math` — off-chain reference math (NOT used by the template).
- `packages/protocol-client`, `packages/wallet-adapter`, `apps/web`, `apps/extension` — TS
  scaffolding, reviewed for trust-boundary properties (not production code yet).
- `.github/workflows/pages.yml`, lockfiles — supply chain.
- Upstream references at the pinned revision: `crates/template_builtin/templates/liquidity_pool`
  (production builtin) and `crates/engine/tests/templates/tariswap` (demo our code derives from).

Out of scope / not done (by instruction): no Esmeralda deployment, no testnet liquidity, no
walletd configuration.

## Audited Commit

- HEAD: `c24b8540789964133d7349ba1a2b3bbedfbc4c45` (`main`).
- Working tree at audit start had uncommitted edits to `templates/fungible_pool/{Cargo.toml,src/lib.rs}`
  (the locked-minimum-liquidity vault + LP burn-rule change). The audit assessed the working-tree
  state (what would actually ship), not just the committed blob.

## Ootle Version

Independently verified — **not assumed**:

- Working-tree `Cargo.toml` requested `tag = "v0.41.1"`. `git ls-remote` confirms
  `v0.41.1` → commit `4732f65ec17a96547050989d78fd70a4e3d94113` (annotated tag object
  `ba8e20469aadeee065f05566587eb93d5fe4d282`).
- The **committed `Cargo.lock` pinned a different revision**, `2d6083e6cc7c98cde93dacebe2fb76b17703f588`
  (v0.32.0-era), so the "reproducible build" commit (`c24b854`) did **not** actually pin the
  v0.41.1 code the manifest asked for (finding OPUS-07).
- `tari_template_lib` / `tari_template_lib_types` internal crate version at `4732f65`: `0.32.0`
  (the workspace crate version was not bumped for the v0.41.1 release tag; the git rev is the
  authoritative identifier).
- The local research checkout `C:\tmp-tari` is at `2d6083e` (v0.32.0), so semantics that could
  differ between 0.32 and 0.41 were re-verified against the cached `4732f65` checkout used for
  the actual build. `tari_template_test_tooling` and `tari_ootle_transaction` were built from
  `4732f65` for the engine tests.

Fixes re-pin all manifests to the immutable commit `4732f65…` (offline-resolvable and
reproducible) rather than the mutable tag reference.

## Architecture Reviewed

Two-resource constant-product AMM as a single Ootle component:
- State: `pools: BTreeMap<ResourceAddress, Vault>` (2 reserve vaults), `lp_resource`, `fee_bps`
  (basis points /10_000; 30 bps = 0.30%; max 1000 bps = 10%), `locked_lp_vault` (permanently-locked
  minimum LP shares).
- Methods: `new` (constructor), `add_liquidity`, `swap`, `remove_liquidity`, plus read-only
  getters. LP tokens are a public fungible minted/burned by the component.
- No admin/upgrade/withdraw method exists (confirmed) — the risk was the opposite: an *implicit*
  privileged party via resource ownership (OPUS-02), now removed.

## Threat Model

Motivated attackers who can: create arbitrary resources; call any `AllowAll` method with crafted
buckets; observe/kick off transactions (front-run); run or compromise the indexer; compromise the
GitHub-Pages frontend; and study every line. Native Tari is `STEALTH_TARI_RESOURCE_ADDRESS`.
Assumptions: the engine's vault/bucket/resource authorization behaves as in the pinned source
(verified by reading `tracker_auth.rs`, `access_rules.rs`, builder sources, and by engine tests).

## Findings Summary

| ID | Severity | Title | Status | Area |
|----|----------|-------|--------|------|
| OPUS-01 | CRITICAL | `remove_liquidity` returns zero → all reserves permanently trapped | Fixed | AMM/LP accounting |
| OPUS-02 | HIGH | LP mint gated on creator's owner badge → not permissionless; implicit privileged party | Fixed | Resource authorization |
| OPUS-03 | HIGH | Swap fee bypass: fee computed then discarded → 0% effective fee, LPs earn nothing | Fixed | AMM math / fee |
| OPUS-04 | HIGH | `add_liquidity` reads reserves after deposit → new LPs diluted, value leaks to incumbents | Fixed | LP accounting |
| OPUS-05 | HIGH | `swap` has no on-chain `min_output` → no slippage/sandwich protection | Fixed | AMM / MEV |
| OPUS-06 | MEDIUM | Unchecked `u128` product in first-deposit sqrt → silent wrap in release WASM | Fixed | Overflow |
| OPUS-07 | MEDIUM | Version drift: manifest tag vs stale lock rev → non-reproducible build | Fixed | Supply chain |
| OPUS-08 | HIGH | Hostile/eligible pool resources (type + recall/freeze) | Type facet FIXED; recall/freeze OPEN (engine limitation) | Resource eligibility |
| OPUS-09 | LOW | "Engine tests" were `assert!(true)` stubs with false claims | Fixed (real engine tests added) | Test coverage |
| OPUS-10 | LOW | Indexer JSON trusted without validation; fee defaults to 30 on error | Open (documented) | Indexer/frontend trust |
| OPUS-11 | LOW | Extension listener lacks origin validation; content scripts match all `*.github.io` | Open (scaffold) | Wallet/extension |
| OPUS-12 | INFO | `canonical_pair` orders by `{:?}` Debug string | Open (documented) | Robustness |
| OPUS-13 | LOW | Bundled `faucet` template mints native Tari (impossible) → dead/misleading | Open (documented) | Repo hygiene |
| OPUS-14 | MEDIUM | Fee-unit mismatch: contract charged per-mil (fee=30 → 3.0%) while protocol/UI advertise 30 bps (0.30%) — a 10× overcharge | Fixed (engine-verified pending) | AMM fee units |

---

## Detailed Findings

### OPUS-01 (CRITICAL) — `remove_liquidity` returns zero; reserves permanently trapped

**File/function:** `templates/fungible_pool/src/lib.rs`, `remove_liquidity`.

**Cause.** `Amount` is an integer (`u128`) type whose `Div` is `checked_div` = floor division
(`tari-ootle .../amount/ops.rs`). The code computed:

```rust
let ratio = lp_amount / total_lp;   // integer: 0 whenever lp_amount < total_lp
let a_amount = ratio * a_pool;      // 0
let b_amount = ratio * b_pool;      // 0
lp_bucket.burn();                   // LP destroyed
```

Because a minimum of `MINIMUM_LOCKED_LIQUIDITY` shares is permanently held in
`locked_lp_vault`, **no external holder can ever own 100% of supply**, so `lp_amount < total_lp`
always holds and `ratio` is always `0`. Every `remove_liquidity` burns the caller's LP and
returns `(0, 0)`.

**Impact.** Total, unconditional loss: 100% of pooled reserves are unrecoverable for every
liquidity provider. This is not attacker-conditional — it happens on the normal happy path.

**Prerequisites/steps.** Add liquidity, then attempt to remove any amount → LP burned, nothing
returned.

**Evidence.** Upstream's own production builtin documents the exact trap and avoids it by
multiplying first in 192-bit precision (`liquidity_pool/src/lib.rs::calculate_redemption_amounts`:
"dividing the LP ratio first truncates it to zero for any partial redemption (since these are
integers)"). Proven from source: `Amount::Div` is floor division (`amount/ops.rs`) and the
permanently-locked minimum guarantees `lp_amount < total_lp`, so `ratio` is always 0. Exercised by
engine test `e02_redemption_returns_reserves` (written; execution blocked on Windows — see Real
Engine Test Evidence).

**Fix.** Multiply before dividing, in 192-bit precision, via a `mul_div` helper:
`a_amount = lp_amount * a_pool / total_lp`, with an assert that both outputs are positive.

**Regression test.** `e02_redemption_returns_reserves` (engine; written, execution env-blocked).

---

### OPUS-02 (HIGH) — LP mint authority is the pool creator's owner badge

**File/function:** `new` (LP `ResourceBuilder`), `add_liquidity` (mint).

**Cause.** LP was built `mintable(AccessRule::DenyAll, Locked)` (and pre-working-tree, mint was
default `DenyAll`). The engine's resource-action authorization (`engine/.../tracker_auth.rs`) is:

```
if !action.is_recall() && check_ownership(scope, resource_ownership) { return Ok(()); } // owner override
if !check_access_rule(scope, rule) { return Err(AccessDenied) }
```

i.e. the **resource owner can mint/burn regardless of the `DenyAll` rule**. The LP resource used
the default owner rule (`OwnedBySigner`) → owner = whoever signed `Pool::new` (the pool creator).
Consequently only transactions carrying the creator's owner proof can mint LP. A different
account calling `add_liquidity` is rejected at `mint_fungible`. The upstream demo this was derived
from makes this explicit by passing `owner_proof()` when adding liquidity.

**Impact.** The pool is not permissionless: only the creator can provide liquidity. The creator is
an undisclosed privileged party (holds the implicit LP-mint capability), directly contradicting the
"non-custodial, permissionless, no admin" claims in the header comment and docs. (No direct theft:
minting still requires going through `add_liquidity`, which requires depositing reserves; and the
creator cannot mint LP from a bare manifest.)

**Fix (no admin hatch — the opposite).** Scope mint/burn to the component itself and remove the
privileged owner, matching the authoritative pattern
(`engine/tests/templates/access_rules::resource_actions_restricted_to_component`):

```rust
let allocation = CallerContext::allocate_component_address(None);
let this_component = allocation.get_address();
let lp_resource = ResourceBuilder::public_fungible()
    .with_owner_rule(OwnerRule::None)                                   // no privileged owner
    .mintable(rule!(component(this_component)), UpdateRule::Locked)     // only this component
    .burnable(rule!(component(this_component)), UpdateRule::Locked)     // only this component
    .build();
// ... Component::new(...).with_address_allocation(allocation)...
```

Now mint/burn succeed only when the acting frame is the pool component (i.e. only via
`add_liquidity`/`remove_liquidity`), for any caller, with no owner override and locked rules.

**Regression test.** `e01_permissionless_add_liquidity_and_lp_received` uses an account distinct
from the pool creator (engine; written, execution env-blocked). Also proven from source:
`tracker_auth.rs` owner override + default `OwnedBySigner` + `DenyAll` mint default.

---

### OPUS-03 (HIGH) — Swap fee bypass (0% effective fee)

**File/function:** `swap`.

**Cause.** The fee-reduced input was computed into a discarded `_effective_input`, and the
constant-product step used the **full** input:

```rust
let _effective_input = (input_amount * (denom - fee)) / denom; // discarded
let k = input_pool * output_pool;
let new_input_pool = input_pool + input_amount;   // full input, not effective
let new_output_pool = k / new_input_pool;
let output_amount = output_pool - new_output_pool;
```

Then the full input was deposited. Since `new_output_pool = k / (input_pool + input_amount)` and
the reserve grows by the full input, the post-swap product equals `k` (up to floor rounding): **no
fee is retained**. This is a regression from the upstream demo, which used
`new_input_pool = input_pool + effective_input_balance` while depositing the full bucket.

**Impact.** LPs earn 0% despite an advertised 0.30% (or configured) fee; the constant product does
not grow. Traders get the full no-fee output. Economic purpose defeated; violates invariant I5.

**Fix.** Use the fee-reduced input to drive the price and deposit the full input (fee stays as LP
profit), computed in 192-bit precision to avoid `k` overflow:
`output = output_pool * effective_input / (input_pool + effective_input)`.

**Regression test.** `e03_swap_charges_fee_growing_k` asserts `k` strictly increases, the reserve
delta equals the FULL input, and the output matches the exact fee-adjusted constant-product value
(engine). Also a direct arithmetic consequence of using the full input.

---

### OPUS-04 (HIGH) — `add_liquidity` dilutes new providers

**File/function:** `add_liquidity` (subsequent-deposit path).

**Cause.** Buckets were deposited into the vaults *before* the reserves were read, so
`a_pool`/`b_pool` already included the new deposit:

```rust
self.pools.get_mut(&a_res).unwrap().deposit(a_bucket); // deposit first
...
let a_pool = self.get_pool_balance(a_res);             // includes just-deposited amount
let a_shares = (a_amount * total_supply) / a_pool;     // = amount*S/(reserve_old+amount)
```

The correct denominator is the pre-deposit reserve. Using the post-deposit reserve systematically
under-mints the depositor. Example: doubling a pool (`amount == reserve_old`) yields `S/2` shares
instead of `S`; the provider ends up owning `1/3` of the pool after contributing `1/2` of it — the
difference accrues to incumbent LPs (e.g. the creator/first LP).

**Impact.** Deterministic value transfer from every subsequent LP to earlier LPs; no special setup
needed. (Also the original divided before multiplying, compounding truncation.)

**Fix.** Read reserves before depositing; compute `amount * total_supply / reserve` with
multiply-before-divide in precision; assert the mint is positive; deposit afterwards.

**Regression test.** Covered indirectly by `e01`/`e02` accounting; economic reasoning in
"LP Share Accounting Analysis".

---

### OPUS-05 (HIGH) — No on-chain slippage protection

**File/function:** `swap` signature.

**Cause.** `swap(input_bucket, output_resource) -> Bucket` had no minimum-output parameter, and the
frontend contains no slippage concept (`grep` for min_output/slippage in `packages/` is empty). The
only guard was "output != 0". A trader had no authoritative protection against an adverse reserve
state (natural or sandwich).

**Impact.** Sandwich/front-running can extract arbitrary value up to draining the output side to a
single unit; the victim cannot bound their execution price on-chain.

**Fix.** Add `min_output: Amount` and enforce `output_amount >= min_output` inside `swap` (atomic
abort on failure). The frontend/wallet must compute and display `min_output` from a trusted quote;
an indexer-supplied quote alone is not authoritative (see OPUS-10).

**Regression test.** `e04_slippage_min_output_enforced` (impossible min_output → rejected;
engine, written, execution env-blocked).

---

### OPUS-06 (MEDIUM) — Unchecked `u128` product in first-deposit sqrt

**Cause.** First deposit computed `let product = a_u128 * b_u128;` as a raw `u128` multiply. Release
WASM (`opt-level="z"`, overflow-checks off) wraps on overflow, so pathologically large
first-deposit amounts could wrap the product and mint a wrong (tiny) LP amount.

**Fix.** Compute the product and square root in 192-bit precision
(`into_precision_amount().checked_mul(...).checked_sqrt()`), which cannot silently wrap; enabled the
`precision`/`extra-arith` features on `tari_template_lib`.

---

### OPUS-07 (MEDIUM) — Version drift / non-reproducible build

**Cause.** Working-tree `Cargo.toml` requested `tag = "v0.41.1"` while the committed `Cargo.lock`
pinned rev `2d6083e` (v0.32.0-era). A build would re-resolve, and the "commit Cargo.lock for
reproducible builds" claim did not hold for the v0.41.1 target. The working-tree `Cargo.toml` also
declared **optional dev-dependencies**, which is invalid and made the manifest fail to parse.

**Fix.** Pin all manifests to the immutable commit `4732f65…` (= v0.41.1), removed the invalid
optional dev-deps and the broken `test` feature, moved engine tests into a standalone
`audit_engine_tests/` crate, and regenerated the lock. Build is now reproducible and offline.

---

### OPUS-08 (HIGH) — Hostile/eligible resources for pooling — PARTIALLY FIXED (type policy enforced; recall/freeze OPEN by engine limitation)

**Root cause (two facets).**
1. *Type facet:* `validate_fungible_resource` accepted `Fungible | Confidential | Stealth`, so
   confidential/stealth (and, by the loose check, effectively any non-fungible surprise) could ride
   into an amount-based public pool that reads `bucket.amount()`/`vault.balance()` as cleartext.
2. *Authority facet:* a pooled resource whose issuer holds a **recall** or **freeze** right can act
   on the pool's OWN reserve vault after deposit — authorization for recall/freeze is the resource's
   rule (checked against the caller), **not** the vault owner's consent (`engine/tests/templates/recall`,
   `ResourceManager::recall_fungible_amount(vault_id, amount)` / `freeze_vault(vault_id)`).

**Actual exploitability (protocol vs market risk).**
- **Attack A — recall (PROTOCOL SECURITY / custody):** attacker issues a fungible with
  `recallable(allow_all)`, pools it, lures counter-liquidity, then recalls the pool's holdings of
  that token straight out of the reserve vault — no swap, no LP burn. Reserves drop below what LPs
  are owed; combined with retained LP the attacker extracts more than their share. **Real theft.**
- **Attack B — freeze (DoS / griefing):** a `freezable` token lets the attacker freeze the pool's
  vault of that token, so swaps outputting it and removals of it revert. Funds are locked, not
  stolen. **Real DoS.**
- **Attack C — mint inflation (TOKEN ISSUER / MARKET risk, NOT an AMM exploit):** the issuer minting
  more of their token elsewhere does **not** touch the pool's vault balance or LP accounting (LP
  value is proportional to the pool's own reserves, not global supply). This is ordinary issuer/
  market risk and is **not** classified as a pool exploit.

**Resource rules involved.** `ResourceAccessRules::{recall, freeze, mint}` and their `UpdateRule`s;
`OwnerRule`. Recall/freeze are `DenyAll` by default but an issuer can enable them (and, if the
updater rule is not `Locked`, enable them *later*).

**The hard limit (why this cannot be closed permissionlessly on-chain in v0.41.1).** A template can
introspect a foreign resource only through `ResourceManager`, whose `ResourceAction` enum exposes
`GetResourceInfo` (→ `ResourceInfo { resource_type, divisibility }`) and `GetTotalSupply` — and
**nothing else**. There is **no** action to read a resource's mint/burn/recall/freeze/owner rules or
their mutability. Therefore `Pool::new` **cannot** detect a recallable/freezable/mutable-rule
fungible. Rule-based permissionless screening is **impossible** at the template layer on this engine
revision. (Verified: `crates/template_lib/src/args/types.rs::ResourceAction`,
`crates/template_lib_types/src/resource_type.rs::ResourceInfo`,
`crates/template_lib/src/resource/manager.rs`.)

**What was fixed (enforced on-chain).** `validate_pool_resource` now derives eligibility from
authoritative resource state only — the narrowest safe policy the ABI supports:
- canonical native Tari (exact `STEALTH_TARI_RESOURCE_ADDRESS`) — allowed (Part 5 exception);
- `ResourceType::Fungible` — allowed;
- `Confidential`, non-Tari `Stealth`, `NonFungible` — **rejected** (closes the fake-Tari and
  unsupported-type facets; keeps stealth/confidential/NFT behind their own routes per Part 6).
Engine tests `resource01/02/03/07/09/10` (in `audit_engine_tests/tests/opus08_eligibility.rs`)
assert this policy.

**What remains OPEN (cannot be fixed here).** Recall/freeze screening of ordinary public fungibles.
A recallable or freezable fungible is still `ResourceType::Fungible` and is therefore ACCEPTED by
the on-chain check (engine tests `resource04/05` document this; `opus08_recall_demo.rs` demonstrates
the actual reserve drain). Mitigations, none of which is a permissionless on-chain fix:
- **Client-side advisory classification (added):** `protocol_types::ResourceEligibility` +
  `classify_resource`, mirrored in `protocol-client` (`classifyResource`). The client derives
  `CanonicalTari` / `EligiblePublicFungible` / `UnsupportedResourceType` authoritatively, and
  `UnsafeRecallable` / `UnsafeFreezable` / `UnsafeMutableRules` from indexer substate — clearly
  marked **advisory / indexer-trusted, not a guarantee** (`is_on_chain_enforced()` distinguishes
  them). The frontend must not invent its own classification.
- **Governance allow-list** (deferred; the prompt discourages a centralized list, and it is only
  warranted because the engine lacks introspection — a product decision, not an automatic fix).
- **Upstream engine support** to expose resource access rules to templates (or a vault flag opting
  out of recall/freeze), which would make a permissionless on-chain check possible.

**Status.** Type facet **FIXED and enforced** (engine tests written; run in Linux CI). Recall/freeze
facet **OPEN — not fixable permissionlessly in v0.41.1**; risk is disclosed in-code, demonstrated by
an engine test, and surfaced via the advisory client classification. This is why the pool must be
restricted to canonical Tari + vetted fungibles before any funded use.

---

### OPUS-09 (LOW) — Fake "engine tests"

`templates/fungible_pool/tests_archive/security_regressions.rs` consisted of `fn … { assert!(true) }`
stubs whose comments asserted false guarantees (e.g. "share calculation uses floor division during
removal, preventing extraction" — the code actually returned zero). These proved nothing and
actively misled. **Fixed** by adding real engine tests in `audit_engine_tests/` that execute the
compiled template. The stub file is left in `tests_archive/` (not compiled) but should be deleted.

---

### OPUS-10 (LOW, open) — Indexer response trusted without validation

`ProtocolClient.getPoolData` casts `res.json()` straight to `PoolReadData` and, on error, returns a
fabricated record with `feeTier: 30`. A malicious indexer can return arbitrary reserves/quotes.
With OPUS-05 fixed, this is bounded to bad UX / a bad `min_output` *if the wallet blindly trusts the
quote*. Mitigation is architectural: the wallet must display authoritative transaction details
(component, resources, amounts, `min_output`, `max_epoch`) from the signed transaction, not from the
indexer. Documented in Indexer/Frontend Trust Analysis; no code fix in this run.

---

### OPUS-11 (LOW, open, scaffold) — Extension trust boundary

`apps/extension/src/service_worker.ts` handles `chrome.runtime.onMessage` without validating
`sender.origin`/`sender.id`, and `manifest.json` matches content scripts and host permissions
against `https://*.github.io/*` (every GitHub Pages site) plus `tabs`/`scripting`. As scaffolding
this is not yet exploitable, but the mandatory properties before any signer ships are recorded in
Wallet/Frontend Trust Analysis. No code fix (scaffold only).

---

### OPUS-12 (INFO) — `canonical_pair` orders by Debug string

Ordering uses `format!("{:?}", addr)`. It is deterministic within a version but relies on the
`Debug` representation being stable and lexicographically meaningful. Prefer ordering by the
canonical byte/`Ord` representation of `ResourceAddress`. Low impact (only affects which vault is
"A" vs "B"); left as a hardening note.

---

### OPUS-13 (LOW) — Bundled faucet template mints native Tari

`templates/fungible_pool/templates/faucet/src/lib.rs` calls
`ResourceManager::get(STEALTH_TARI_RESOURCE_ADDRESS).mint_fungible(...)` — native Tari cannot be
minted by a template, so this is dead/misleading and unusable as a test faucet. The audit uses a
correct `TestFaucet` (mints an ordinary public fungible) in `audit_engine_tests/templates/faucet`.
Recommend deleting or replacing the bundled one.

---

### OPUS-14 (MEDIUM) — Fee-unit mismatch: contract charged 3.0% while protocol advertised 0.30%

**File/function:** `new` (fee storage/validation), `swap` (fee application).

**Cause.** The contract stored `fee: u16` and applied it **per-mil out of 1000**
(inherited from upstream TariSwap, which documents fee as per-mil and validates `0..100`):
`effective_input = input * (1000 - fee) / 1000`. Meanwhile the protocol spec, `pool_math`
(`FEE_DENOMINATOR = 10_000`, `DEFAULT_FEE = 30` basis points), `protocol_types`
(`FeeTier { basis_points }`), the route matrix, and the UI all express the default tier as
**30 basis points = 0.30%**. With `fee = 30` the contract therefore charged **3.0%** — ten times
the advertised fee. (Earlier the fee was not charged at all — OPUS-03; once charging was restored,
the unit mismatch surfaced.)

**Impact.** Every trade on a 30-bps pool paid a 3% fee: a deterministic 10× overcharge relative to
the advertised tier. No theft of principal and no broken invariant (100% of the fee still went to
LPs), but users were silently over-charged versus the documented economics. Severity MEDIUM
(economic harm to every trader, but bounded by the pool's chosen tier and still capped at 10%).

**Fix.** Convert the contract to **basis points**: `fee_bps: u16`, `FEE_DENOMINATOR_BPS = 10_000`,
`effective_input = input * (10_000 - fee_bps) / 10_000`, constructor range `1..=1000` bps
(0.01%..10%, same ceiling as the old per-mil `0..=100`). This intentionally DIVERGES from upstream
TariSwap (per-mil) to match the protocol's own units; the divergence is documented in
`docs/TARISWAP_SECURITY_DIFF.md`.

**Regression test.** `e03_swap_charges_fee_growing_k` and `e03b_reverse_swap_fee_grows_k` pin the
exact 30-bps output (90,661,089 for reserves 1e9/1e9 and input 1e8); the pure-math twin
`swap_output_30bps_default_tier` in `pool_math` asserts the same value and explicitly asserts it is
NOT the per-mil value (88,422,971). Engine-verification pending the next Linux CI run.

---

## Economic Attack Analysis

- **First-depositor / share inflation.** `MINIMUM_INITIAL_LIQUIDITY` (1e6) rejects dust first
  deposits, and `MINIMUM_LOCKED_LIQUIDITY` (1000 shares) is minted then parked in
  `locked_lp_vault`, staying in `total_supply` and never redeemable. With OPUS-01/04 fixed, the
  classic "seed 1 wei, donate to inflate share price, victim rounds to zero" vector is blunted:
  redemption and minting both multiply-before-divide, and the locked shares anchor the denominator.
  Residual: the donation vector (OPUS reserve-donation) is not possible via template methods, and
  the engine has no forced vault deposit into a component vault from outside (vaults are component
  owned; `recall` is disabled by default on the LP resource and not enabled on reserves — but see
  OPUS-08 for hostile *reserve* resources whose own rules could allow recall/freeze of the pool's
  holdings).
- **Unbalanced add.** `add_liquidity` mints `min(a_shares, b_shares)`; excess of the larger side is
  absorbed as a donation to all LPs (the depositor's loss, their choice), never to a single attacker.
  No share-price manipulation is available to a subsequent LP because shares use pre-deposit reserves.
- **Rounding cycles.** With the fee now retained (OPUS-03) `k` is non-decreasing across swaps, so
  A→B→A cycles cannot create value; floor rounding always favours the pool. Redemption rounds down
  in favour of the pool.
- **No developer/protocol fee path** exists; 100% of the fee stays in reserves for LPs (invariant I8
  holds after fixes).

## LP Share Accounting Analysis

- First deposit: `shares = floor(sqrt(a*b))`, `MINIMUM_LOCKED_LIQUIDITY` locked, remainder to
  provider. Verified by `e01` (10e6/10e6 → provider holds 10e6 − 1000).
- Subsequent deposit: `shares = min(a*S/Ra, b*S/Rb)` on **pre-deposit** reserves, multiply-first.
- Redemption: `out_i = lp*Ri/S`, multiply-first, floor. Denominator `S` includes locked shares, so
  redemptions never over-pay; the last real provider cannot withdraw the locked minimum (by design)
  but recovers essentially all of their proportional reserves (`e02`).

## Native Tari Analysis

Native Tari is `STEALTH_TARI_RESOURCE_ADDRESS` (a `Stealth` resource). The template treats it as a
normal amount-bearing fungible; only the canonical address satisfies the native path because
`check_pool_resources` matches on exact `ResourceAddress`. A fake token cannot impersonate native
Tari (different address). Caveat: being `Stealth`, any pool involving native Tari reveals the Tari
amounts on-chain (OPUS-08 / Privacy Boundary) — this must not be described as "private".

## Resource Authorization Analysis

- LP mint/burn: now `component(self)`-scoped, `OwnerRule::None`, rules `Locked` → only the pool
  component, immutable, no privileged signer (OPUS-02 fixed; source-proven via `tracker_auth.rs`;
engine test `e01` written, execution env-blocked).
- Reserve vaults: component-owned; withdrawals occur only via `swap` (with fee) and
  `remove_liquidity` (burns LP). No admin/withdraw method (confirmed by ABI/method review).
- Component access rules: `default DenyAll` with explicit `AllowAll` only on the intended public
  methods; getters are read-only. No generated/hidden mutators.

## Malicious Resource Analysis

The dangerous residual (OPUS-08): a pool can be created against an attacker-controlled reserve
resource whose own access rules permit `recall` or `freeze`. Such a resource could let the attacker
forcibly withdraw or freeze the pool's holdings of that token, breaking the invariant that vault
balance tracks reserves, enabling theft or a griefing DoS **independent of our template's rules**.
The template cannot change another resource's rules, so the correct defense is *eligibility
screening at pool creation*: reject reserve resources that are recallable/freezable/mintable by a
non-owner, or restrict the first release to a vetted allow-list (native Tari + audited fungibles).
Recommended before mainnet; not implemented this run (requires reading resource access-rule
metadata and a product decision). Tracked as OPUS-08.

## AMM Math Analysis

Constant product with fee retained in the input reserve. Output derived independently:
`Δy = y·(Δx·(10_000−f)/10_000) / (x + Δx·(10_000−f)/10_000)`, floor, where `f` is the fee in
**basis points** (30 bps = 0.30%; OPUS-14 — pre-fix the code divided by 1000, a per-mil scale,
over-charging 10×). Matches upstream builtin (fee-adjusted input drives price; full input
deposited); note the intentional unit difference from upstream TariSwap's per-mil scale. All
multiplications are done in 192-bit precision to avoid `u128` overflow of `x·y` and `Δx·y`.
Zero-output and empty-reserve cases assert-and-abort.

## Rounding Analysis

All divisions floor. Redemption and share minting multiply-before-divide, eliminating the
truncate-to-zero class (OPUS-01/04). Fee rounding favours the pool. Property/fuzz coverage for
rounding cycles remains a gap (see Remaining Risks) — the pure `pool_math` crate has cycle tests,
but it is not the code that ships.

## Wallet/Frontend Trust Analysis

The web app ships a reasonable CSP (`default-src 'self'`, pinned `connect-src` to the indexers,
`object-src 'none'`, `frame-ancestors 'none'`). The trust model requires that a compromised page or
indexer cannot cause silent theft: this holds only if the signer/wallet renders authoritative
transaction fields (component address, input/output resources, amount, `min_output`, `max_epoch`)
from the transaction it is about to sign — not from `TransactionPreview` fields supplied by the page.
Nothing in the current scaffold binds `TransactionPreview` to the signed transaction; this MUST be
enforced in the real signer. On-chain `min_output` (OPUS-05) is the backstop that makes a lying
quote bounded rather than catastrophic.

## Indexer Trust Analysis

Assume the indexer is malicious. It can lie about reserves, quotes, pool address, and tx status.
Consequences after fixes: (1) a wrong *quote* is bounded by on-chain `min_output` **iff** the wallet
shows the user the real `min_output` and pool address to confirm; (2) a wrong *pool address* is only
dangerous if the wallet doesn't display it — the user must confirm the component address; (3) tx
status lies are UX only. Security-critical validation must live in the signed transaction + wallet
confirmation + on-chain checks, never in indexer trust. `ProtocolClient` should validate/shape
responses and never fabricate a `feeTier` default (OPUS-10).

## Supply Chain Analysis

- Rust deps pinned to an immutable git commit (post-fix). `pool_math`/`protocol_types` use only
  `thiserror`. No build scripts of concern in-repo.
- CI (`pages.yml`): scoped permissions (`contents: read`, `pages: write`, `id-token: write`),
  `actions/*@v4` major-pinned, `pnpm install --frozen-lockfile`. Minor: `npm install -g pnpm` is
  unpinned (pin a version). Mixed `package-lock.json` + `pnpm-workspace.yaml` is inconsistent; pick
  one package manager to avoid lockfile ambiguity.
- No secrets in the workflow or `.env.example`.

## Real Engine Test Evidence

A standalone host crate `audit_engine_tests/` uses `tari_template_test_tooling` (v0.41.1 /
`4732f65`) to compile the **actual** `templates/fungible_pool` to WASM and execute it in the engine.
Tests:

- `e01_permissionless_add_liquidity_and_lp_received` — a non-creator account adds first liquidity and
  receives `sqrt(a*b) − MINIMUM_LOCKED` LP (exercises OPUS-02 fix; pre-fix mint is denied).
- `e02_redemption_returns_reserves` — full redemption returns ≈ all reserves (exercises OPUS-01 fix;
  pre-fix returns zero).
- `e03_swap_charges_fee_growing_k` — constant product strictly increases after a swap; reserve
  delta equals the FULL input; output pinned to the exact 30-bps (0.30%) value 90,661,089
  (exercises OPUS-03 and OPUS-14; pre-fix `k` is flat, per-mil fee=30 would deliver 88,422,971).
- `e03b_reverse_swap_fee_grows_k` — the reverse direction (B→A) with identical 30-bps semantics
  and the same pinned exact output.
- `e04_slippage_min_output_enforced` — a swap demanding an impossible `min_output` is rejected
  atomically (exercises OPUS-05).
- `e05_micro_swap_rounding` — integer rounding at micro scale under the 30-bps tier (3-unit swap
  pays effective input 2 and receives exactly 1 unit, k still grows; 1-unit swap floors to
  effective input 0 and must abort — never a free trade).

Added in the OPUS-08 run (`audit_engine_tests/tests/`):
- `opus08_eligibility.rs` — `resource01/02/03/07/09/10` assert the on-chain type policy (safe
  fungible + canonical Tari accepted; non-Tari stealth rejected; same-pair rejected; metadata
  ignored) and `resource04/05` document that recallable/freezable fungibles remain accepted.
- `opus08_recall_demo.rs` — `recallable_token_can_be_drained_from_pool_reserves` demonstrates the
  residual recall drain against pool reserves.
- `pool_economics.rs` — `e11` second independent LP, `e05`/`e12` locked-minimum survives full exit,
  and `first_depositor_cannot_steal_victim_share` (Part 13 attacker/victim runtime regression).
- New `hostile` test template mints the recallable/freezable/stealth/symbol-"TARI"/safe resources
  and can recall from an arbitrary vault. It **compiles to WASM (verified locally)**.

**Execution status — FIRST REAL RUN DONE (Linux CI, 2026-09-24): 3 PASS / 1 FAIL.** The GitHub
Actions workflow `.github/workflows/security-engine-tests.yml` executed the suite against the real
engine: `e01`, `e02`, `e04` PASS. `e03` FAILED — root cause was a TEST funding bug, not a contract
bug: `TestFaucet::take_free_coins` pays a single 1e9 payout which `add_liquidity(1e9, 1e9)` fully
consumed, so the swap's `withdraw` failed with "Required: 100000000, Available: 0" before the
contract executed. Funding was doubled and e03 now pins the exact fee-adjusted output. A NEW CI RUN
IS REQUIRED to validate the OPUS-14 basis-point fix and the extended suite (e03/e03b/e05); until
then no pass/fail of the new tests is claimed.

### Off-chain Rust tests (do run here)

`crates/pool_math` (the off-chain **reference** math, NOT the code that ships): 36 tests pass
(20 unit + 2 `amm_cycle` + 14 `protocol_tests`), including the OPUS-14 fee-unit regressions
(`fee_tier_policy_bps_scale`, `swap_output_30bps_default_tier`). `crates/protocol_types`: **7 tests
pass** (the `classify_resource` eligibility tests). These give false comfort if mistaken for
template coverage — the template reimplements its own math and does not call `pool_math`.

### Build artifact (current, post-OPUS-14)

- Path: `templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm`
- Size: 243,262 bytes
- SHA256: `23cb507a47593c1782a269d772f35f526b7aebea2f63c0caaaff58d8a2a050de`
- Previous (pre-OPUS-14): 243,227 bytes,
  `588c644cd28c27be2eceec7c432c34b70726b493c6ac355c216407c5afd1021e`
- Source: branch `security/audit-opus-fixes`; Ootle rev `4732f65` (v0.41.1); release profile
  (`opt-level="z"`, `lto`, `panic=abort`), features `precision`, `extra-arith`.
- Rebuild + verify: `cargo build --manifest-path templates/fungible_pool/Cargo.toml --release
  --target wasm32-unknown-unknown && sha256sum <path>`.

## Remaining Risks

1. **OPUS-08 recall/freeze by a hostile reserve resource** — the type policy is now enforced, but
   recall/freeze of a pooled public fungible CANNOT be screened on-chain in v0.41.1 (no access-rule
   introspection in the template ABI). Highest residual theft/DoS risk. Blocker for arbitrary-token
   pools until a governance allow-list or an upstream engine API lands.
2. **Property/fuzz coverage on the shipping template** — only a handful of engine cases exist; the
   large-scale randomized add/swap/remove balance-conservation fuzzing (invariants I1–I10) is not yet
   implemented against the WASM template.
3. **Signer boundary unproven** — the real wallet/extension does not exist; the trust model depends on
   it rendering authoritative fields (OPUS-10/11).
4. **Confidential/privacy semantics** unverified under this engine (OPUS-08 privacy facet).
5. **Divisibility mismatch** — LP divisibility 18 vs `MINIMUM_*` constants tuned for 6-dp Tari; the
   minimums are conservative but not derived per-pool from actual reserve divisibility.

## Mainnet/Testnet Readiness

**Esmeralda with small test funds: CONDITIONAL / NOT YET.** The five critical/high correctness bugs
are fixed and source-proven, the OPUS-08 type policy is enforced, and both templates build to WASM
reproducibly. But the engine suite has not yet executed (Linux CI is created but not run in this
session), and the OPUS-08 recall/freeze facet is unfixable on-chain in v0.41.1. Before even a
small-fund test: (1) get the Linux CI run green (real runtime evidence); (2) restrict pools to
canonical Tari + a vetted/allow-listed fungible so the recall/freeze vector cannot be introduced;
(3) delete the misleading stub tests and the broken bundled faucet. A test-fund trial is only
defensible with those constraints and with acceptance that the signer/frontend is still scaffolding.

**Mainnet: NO.** The OPUS-08 recall/freeze facet is unresolved and cannot be closed permissionlessly
on this engine revision, the engine suite has not been executed, there is no fuzz/property suite on
the shipping template, and there is no audited signer. Do not label any Tari/stealth pool "private".
A full external audit is required after the OPUS-08 authority facet, the CI execution, and the
fuzzing gap are closed.

> Nothing here is "production-safe because no exploit was found." Several previously-claimed
> guarantees were false; the burden of proof is on green engine/fuzz evidence, not on absence of a
> demonstrated attack.
