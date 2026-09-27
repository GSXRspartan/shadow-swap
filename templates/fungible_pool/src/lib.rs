// Fungible Liquidity Pool Template for Tari Ootle
// MIT License — non-custodial, permissionless, no admin withdrawal
// Uses upstream TariSwap constant-product model with strict access rules
// Fee scale: BASIS POINTS out of 10_000 (30 = 0.30%, 1000 = 10.00%).
// NOTE: this DIFFERS intentionally from upstream TariSwap, which uses per-mil out of 1000
// (see docs/TARISWAP_SECURITY_DIFF.md). Basis points match the protocol spec, pool_math,
// protocol_types (FeeTier), and the UI display (0.30%).
// Default fee: 30 bps = 0.30% — 100% to LP reserves, 0% developer/protocol fee

use tari_template_abi::rust::collections::BTreeMap;
use tari_template_lib::prelude::*;

#[template]
mod fungible_pool {
    use super::*;

    /// Fee denominator in basis points: fee_bps / 10_000 = fee fraction.
    /// 30 bps = 0.30%; the maximum supported tier is 1000 bps = 10.00%.
    const FEE_DENOMINATOR_BPS: u128 = 10_000;

    /// Maximum protocol-supported fee tier: 1000 bps = 10.00%.
    const MAX_FEE_BPS: u16 = 1_000;

    /// Minimum initial liquidity to defend against first-depositor ratio manipulation.
    /// Based on Tari divisibility (6): 1 TARI = 1_000_000 micro-tari.
    /// For general fungible resources, this represents a safe base amount.
    const MINIMUM_INITIAL_LIQUIDITY: u64 = 1_000_000; // 1 TARI in smallest units

    /// Minimum LP shares to permanently lock on first deposit.
    /// This prevents first-depositor attacks by ensuring a portion of initial
    /// shares is permanently locked and cannot be redeemed.
    /// Derived from LP token standard divisibility: 1000 smallest units is negligible
    /// for normal operation but sufficient to anchor the pool.
    const MINIMUM_LOCKED_LIQUIDITY: u64 = 1_000;

    /// Pool component storing reserves in vaults, LP token, and fee tier.
    pub struct Pool {
        pools: BTreeMap<ResourceAddress, Vault>,
        lp_resource: ResourceAddress,
        fee_bps: u16, // basis points out of 10_000; 30 = 0.30%; max 1000 = 10.00%
        locked_lp_vault: Vault, // Permanently holds MINIMUM_LOCKED_LIQUIDITY shares
    }

    impl Pool {
        /// Initialize a new pool for the given pair and fee tier.
        /// `fee_bps` is in basis points (30 = 0.30%). Each resource must be pool-eligible
        /// (canonical native Tari or an ordinary public fungible — see `validate_pool_resource`)
        /// and the two must differ.
        pub fn new(
            a_addr: ResourceAddress,
            b_addr: ResourceAddress,
            fee_bps: u16,
        ) -> Component<Self> {
            // Security: pair must be distinct
            assert!(a_addr != b_addr, "Pool pair resources must differ");

            // Security (OPUS-08): both resources must be pool-eligible by authoritative type/address.
            // NOTE: this enforces the resource-TYPE boundary only; it cannot screen recall/freeze
            // authority (the v0.41.1 template ABI does not expose those rules). See validate_pool_resource.
            Self::validate_pool_resource(a_addr);
            Self::validate_pool_resource(b_addr);

            // Security: fee must be within safe range (1..=1000 bps => 0.01%..10.00%)
            assert!(
                fee_bps > 0 && fee_bps <= MAX_FEE_BPS,
                "Pool fee must be in range 1..1000 basis points (30 bps = 0.30%)"
            );

            // Security: fix resource pairing deterministically to prevent substitution
            let ordered_pair = Pool::canonical_pair(a_addr, b_addr);
            let (canonical_a, canonical_b) = ordered_pair;

            // Create vaults for reserves
            let mut pools = BTreeMap::new();
            pools.insert(canonical_a, Vault::new_empty(canonical_a));
            pools.insert(canonical_b, Vault::new_empty(canonical_b));

            // Allocate this component's address up front so the LP resource can be scoped
            // to it. This is what makes minting/burning authorized ONLY when the acting frame
            // is this component (i.e. only via add_liquidity / remove_liquidity), and NOT by
            // any signer, owner, or external caller.
            let allocation = CallerContext::allocate_component_address(None);
            let this_component = allocation.get_address();

            // Create LP token resource (fungible).
            // SECURITY: mint and burn are restricted to THIS component via `component(..)`.
            //   * No transaction signer (including the pool creator) can mint or burn LP directly.
            //   * `OwnerRule::None` means there is no privileged owner that could override the
            //     access rules (the engine grants resource owners an implicit mint/burn override).
            //   * Rules are Locked, so they can never be changed after creation.
            // This is the difference between a permissionless pool and one whose creator holds an
            // implicit LP-mint badge.
            let lp_resource = ResourceBuilder::public_fungible()
                .with_token_symbol("LP")
                .with_divisibility(18)
                .with_owner_rule(OwnerRule::None)
                .mintable(rule!(component(this_component)), UpdateRule::Locked)
                .burnable(rule!(component(this_component)), UpdateRule::Locked)
                .build();

            // Create vault for permanently locked LP shares (never redeemable)
            let locked_lp_vault = Vault::new_empty(lp_resource);

            Component::new(Self {
                pools,
                lp_resource,
                fee_bps,
                locked_lp_vault,
            })
            .with_address_allocation(allocation)
            // STRICT ACCESS RULES: only component methods (not arbitrary callers)
            // No admin withdrawal method exists. Pool is immutable after creation.
            .with_access_rules(
                ComponentAccessRules::new()
                    .default(AccessRule::DenyAll)
                    .method("add_liquidity", AccessRule::AllowAll)
                    .method("swap", AccessRule::AllowAll)
                    .method("remove_liquidity", AccessRule::AllowAll)
                    .method("get_pool_balances", AccessRule::AllowAll)
                    .method("get_pool_balance", AccessRule::AllowAll)
                    .method("lp_resource", AccessRule::AllowAll)
                    .method("lp_total_supply", AccessRule::AllowAll)
                    .method("locked_lp_supply", AccessRule::AllowAll)
                    .method("fee_bps", AccessRule::AllowAll),
            )
            .create()
        }

        /// Add liquidity to the pool, minting LP shares proportionally.
        /// Both buckets must match the pool's resource pair.
        pub fn add_liquidity(&mut self, a_bucket: Bucket, b_bucket: Bucket) -> Bucket {
            let a_res = a_bucket.resource_address();
            let b_res = b_bucket.resource_address();
            self.check_pool_resources(a_res, b_res);

            // Security: amounts must be non-zero
            assert!(!a_bucket.amount().is_zero(), "Input A must be non-zero");
            assert!(!b_bucket.amount().is_zero(), "Input B must be non-zero");

            let a_amount = a_bucket.amount();
            let b_amount = b_bucket.amount();

            // Security: first-deposit defense — enforce minimum initial liquidity
            let a_pool_before = self.get_pool_balance(a_res);
            let b_pool_before = self.get_pool_balance(b_res);
            if a_pool_before.is_zero() && b_pool_before.is_zero() {
                let min_amount = Amount::from(MINIMUM_INITIAL_LIQUIDITY);
                assert!(
                    a_amount >= min_amount,
                    "First deposit A must exceed minimum initial liquidity ({} units)",
                    MINIMUM_INITIAL_LIQUIDITY
                );
                assert!(
                    b_amount >= min_amount,
                    "First deposit B must exceed minimum initial liquidity ({} units)",
                    MINIMUM_INITIAL_LIQUIDITY
                );

                // FIRST DEPOSIT: use geometric mean with locked minimum liquidity
                // initial_shares = floor(sqrt(a * b))
                // mint initial_shares total
                // deposit MINIMUM_LOCKED_LIQUIDITY into permanent locked vault (never redeemable)
                // return (initial_shares - MINIMUM_LOCKED) to first LP
                // initial_shares = floor(sqrt(a * b)), computed in 192-bit precision so the
                // intermediate product cannot overflow (a raw u128 `*` would wrap silently in a
                // release WASM build with overflow checks disabled).
                let product = a_amount
                    .into_precision_amount()
                    .checked_mul(b_amount.into_precision_amount())
                    .expect("overflow computing initial liquidity product");
                let initial_shares_p = product
                    .checked_sqrt()
                    .expect("overflow computing initial liquidity sqrt");
                let initial_shares =
                    Amount::try_from(initial_shares_p).expect("initial shares exceed Amount range");

                // Must have enough shares to lock minimum
                let min_locked = Amount::new(MINIMUM_LOCKED_LIQUIDITY as u128);
                assert!(
                    initial_shares >= min_locked,
                    "Initial shares ({}) must exceed minimum locked ({})",
                    initial_shares,
                    MINIMUM_LOCKED_LIQUIDITY
                );

                // Mint total initial_shares
                let mut lp_bucket =
                    ResourceManager::get(self.lp_resource).mint_fungible(initial_shares);

                // Permanently lock MINIMUM_LOCKED_LIQUIDITY shares in component-owned vault
                // These shares remain in total supply but are NEVER redeemable
                // No method ever withdraws from locked_lp_vault
                let min_locked = Amount::new(MINIMUM_LOCKED_LIQUIDITY as u128);
                let locked_shares = lp_bucket.take(min_locked);
                self.locked_lp_vault.deposit(locked_shares);

                // Security: deposit into vaults (reserves grow by full amounts)
                self.pools.get_mut(&a_res).unwrap().deposit(a_bucket);
                self.pools.get_mut(&b_res).unwrap().deposit(b_bucket);
                return lp_bucket;
            }

            // Subsequent deposits: proportional share minting based on the reserve ratios that
            // exist BEFORE this deposit is added. Reading reserves after depositing would use
            // (reserve + amount) as the denominator and systematically under-mint the new
            // provider, leaking value to the existing LPs.
            let a_pool = self.get_pool_balance(a_res);
            let b_pool = self.get_pool_balance(b_res);
            let total_supply = self.lp_total_supply();

            // shares_side = amount * total_supply / reserve, multiplying before dividing (in
            // 192-bit precision) so the ratio is never truncated to zero and cannot overflow.
            let a_shares = Self::mul_div(a_amount, total_supply, a_pool);
            let b_shares = Self::mul_div(b_amount, total_supply, b_pool);
            // Use the minimum side so the provider can never mint more than the balanced amount.
            let new_lp_amount = a_shares.min(b_shares);
            assert!(
                new_lp_amount.is_positive(),
                "Contribution too small relative to reserves to mint any LP shares"
            );

            // Deposit reserves only after the share amount has been computed from the old reserves.
            self.pools.get_mut(&a_res).unwrap().deposit(a_bucket);
            self.pools.get_mut(&b_res).unwrap().deposit(b_bucket);

            ResourceManager::get(self.lp_resource).mint_fungible(new_lp_amount)
        }

        /// Swap input resource for output resource using the constant-product formula.
        ///
        /// `min_output` is the minimum acceptable output amount and is enforced ON-CHAIN: the
        /// swap aborts (rolling back atomically) if the computed output is below it. This is the
        /// authoritative slippage / sandwich protection — a frontend or indexer check is not a
        /// substitute, and the caller must pass a `min_output` derived from a trusted quote.
        pub fn swap(
            &mut self,
            input_bucket: Bucket,
            output_resource: ResourceAddress,
            min_output: Amount,
        ) -> Bucket {
            let input_resource = input_bucket.resource_address();
            self.check_pool_resources(input_resource, output_resource);

            let input_pool = self.get_pool_balance(input_resource);
            let output_pool = self.get_pool_balance(output_resource);

            // Security: reject empty reserves (prevents division by zero / drain)
            assert!(!input_pool.is_zero(), "Input reserve is empty");
            assert!(!output_pool.is_zero(), "Output reserve is empty");

            let input_amount = input_bucket.amount();
            assert!(!input_amount.is_zero(), "Swap amount must be non-zero");

            // Apply the fee: fee_bps is in basis points out of 10_000 (30 bps = 0.30%). The
            // fee-reduced input is what drives the price move, but the FULL input is deposited
            // into the reserve, so the fee difference stays in the pool as LP profit and the
            // constant product grows.
            let fee_bps = Amount::new(self.fee_bps as u128);
            let denom = Amount::new(FEE_DENOMINATOR_BPS);
            let effective_input = Self::mul_div(input_amount, denom - fee_bps, denom);
            assert!(
                effective_input.is_positive(),
                "Swap input too small to yield any output after fee"
            );

            // output = output_pool * effective_input / (input_pool + effective_input)
            // Computed in 192-bit precision to avoid overflow in the product for large reserves.
            let eff_p = effective_input.into_precision_amount();
            let output_p = eff_p
                .checked_mul(output_pool.into_precision_amount())
                .and_then(|num| {
                    input_pool
                        .into_precision_amount()
                        .checked_add(eff_p)
                        .and_then(|den| num.checked_div(den))
                })
                .expect("overflow in swap calculation");
            let output_amount =
                Amount::try_from(output_p).expect("swap output exceeds Amount range");

            assert!(
                output_amount.is_positive(),
                "Swap output amount is zero (input too small)"
            );
            // On-chain slippage protection: never deliver less than the caller demanded.
            assert!(
                output_amount >= min_output,
                "Slippage: output {} is below min_output {}",
                output_amount,
                min_output
            );

            // Security: deposit the FULL input (fee retained in reserve for LPs)
            self.pools
                .get_mut(&input_resource)
                .unwrap()
                .deposit(input_bucket);
            // Security: withdraw output
            self.pools
                .get_mut(&output_resource)
                .unwrap()
                .withdraw(output_amount)
        }

        /// Remove liquidity by burning LP shares and returning proportional reserves.
        pub fn remove_liquidity(&mut self, lp_bucket: Bucket) -> (Bucket, Bucket) {
            assert_eq!(
                lp_bucket.resource_address(),
                self.lp_resource,
                "Invalid LP resource"
            );
            let lp_amount = lp_bucket.amount();
            assert!(!lp_amount.is_zero(), "LP removal amount must be non-zero");

            let a_res = self.get_a_resource();
            let a_pool = self.get_pool_balance(a_res);
            let b_res = self.get_b_resource();
            let b_pool = self.get_pool_balance(b_res);

            let total_lp = self.lp_total_supply();
            assert!(!total_lp.is_zero(), "LP total supply is zero");

            // Proportional withdrawal: amount = lp_amount * reserve / total_lp.
            // CRITICAL: multiply BEFORE dividing. Computing `(lp_amount / total_lp)` first would
            // truncate to zero for every partial LP (integer division), burning the caller's LP
            // and returning nothing — trapping all pool funds. The product is taken in 192-bit
            // precision to avoid overflow, and floor division rounds in favour of the pool.
            let a_amount = Self::mul_div(lp_amount, a_pool, total_lp);
            let b_amount = Self::mul_div(lp_amount, b_pool, total_lp);
            assert!(
                a_amount.is_positive() && b_amount.is_positive(),
                "Redemption too small to withdraw any reserves"
            );

            // Security: burn LP tokens (only this component is authorized to burn — see `new`).
            lp_bucket.burn();

            let a_bucket = self.pools.get_mut(&a_res).unwrap().withdraw(a_amount);
            let b_bucket = self.pools.get_mut(&b_res).unwrap().withdraw(b_amount);
            (a_bucket, b_bucket)
        }

        /// Public method to retrieve first resource in canonical order.
        pub fn get_a_resource(&self) -> ResourceAddress {
            *self.pools.keys().next().unwrap()
        }

        /// Public method to retrieve second resource in canonical order.
        pub fn get_b_resource(&self) -> ResourceAddress {
            let keys: Vec<ResourceAddress> = self.pools.keys().cloned().collect();
            assert!(keys.len() >= 2, "Pool must have exactly 2 resources");
            keys[1]
        }

        /// Read-only balance access.
        pub fn get_pool_balances(&self) -> BTreeMap<ResourceAddress, Amount> {
            let mut balances = BTreeMap::new();
            for (res, vault) in &self.pools {
                balances.insert(*res, vault.balance());
            }
            balances
        }

        /// Read-only single resource balance.
        pub fn get_pool_balance(&self, resource_address: ResourceAddress) -> Amount {
            let vault = self
                .pools
                .get(&resource_address)
                .unwrap_or_else(|| panic!("Resource {:?} is not in pool", resource_address));
            vault.balance()
        }

        /// Read LP resource address.
        pub fn lp_resource(&self) -> ResourceAddress {
            self.lp_resource
        }

        /// Read total LP supply.
        pub fn lp_total_supply(&self) -> Amount {
            ResourceManager::get(self.lp_resource).total_supply()
        }

        /// Read permanently locked LP supply (never redeemable).
        pub fn locked_lp_supply(&self) -> Amount {
            self.locked_lp_vault.balance()
        }

        /// Read fee tier in basis points (30 bps = 0.30%).
        pub fn fee_bps(&self) -> u16 {
            self.fee_bps
        }

        /// Internal validation: is this the canonical native Tari resource?
        ///
        /// Native Tari is `STEALTH_TARI_RESOURCE_ADDRESS` (a `Stealth`-typed resource). Identity is
        /// the exact, engine-defined address — never name/symbol/metadata — so a look-alike token
        /// cannot impersonate it.
        fn is_canonical_tari(resource: ResourceAddress) -> bool {
            resource == STEALTH_TARI_RESOURCE_ADDRESS
        }

        /// Internal validation: resource eligibility for an ORDINARY PUBLIC-FUNGIBLE pool (OPUS-08).
        ///
        /// This is the narrowest safe policy the v0.41.1 template ABI can enforce ON-CHAIN, and it
        /// is derived purely from authoritative resource state (address + `ResourceType`), never
        /// from metadata:
        ///   * canonical native Tari (exact `STEALTH_TARI_RESOURCE_ADDRESS`) — allowed;
        ///   * `ResourceType::Fungible` (ordinary public fungible) — allowed;
        ///   * everything else (`Confidential`, non-Tari `Stealth`, `NonFungible`) — rejected, so
        ///     confidential/stealth/NFT assets cannot ride into a public pool merely because a
        ///     `ResourceType` parse succeeds.
        ///
        /// LIMITATION — READ THIS (OPUS-08 residual, cannot be fixed permissionlessly in v0.41.1):
        /// The template ABI exposes ONLY `resource_type()` / `divisibility()` / `total_supply()`
        /// for a foreign resource (`ResourceAction` has no "get access rules"). A template therefore
        /// CANNOT determine whether a candidate fungible is `recallable` or `freezable`, or whether
        /// its rules are mutable. A public fungible whose issuer holds a recall right can, after
        /// being pooled, forcibly withdraw the pool's holdings of that token (draining reserves);
        /// a freezable one can lock the pool's vault (DoS). This check does NOT and cannot screen
        /// those. Screening them requires either off-chain (indexer-sourced, untrusted) inspection
        /// or a future engine API. See docs/SECURITY_AUDIT_OPUS.md (OPUS-08).
        fn validate_pool_resource(resource: ResourceAddress) {
            if Self::is_canonical_tari(resource) {
                return;
            }
            let resource_type = ResourceManager::get(resource).resource_type();
            assert!(
                matches!(resource_type, ResourceType::Fungible),
                "Resource {:?} is not eligible: only canonical native Tari or an ordinary public \
                 fungible (ResourceType::Fungible) may be pooled; confidential, non-Tari stealth, \
                 and non-fungible resources are rejected",
                resource
            );
        }

        /// Internal validation: resources must be valid pair and present in pool.
        fn check_pool_resources(&self, a: ResourceAddress, b: ResourceAddress) {
            assert_ne!(a, b, "Pool resources must differ");
            assert!(self.pools.contains_key(&a), "Resource {:?} not in pool", a);
            assert!(self.pools.contains_key(&b), "Resource {:?} not in pool", b);
        }

        /// Internal canonical pair ordering using `ResourceAddress`'s engine-defined `Ord`.
        /// Never derive security-critical identity ordering from a debug/display string.
        fn canonical_pair(
            a: ResourceAddress,
            b: ResourceAddress,
        ) -> (ResourceAddress, ResourceAddress) {
            if a <= b {
                (a, b)
            } else {
                (b, a)
            }
        }

        /// Computes `a * b / denom` with the multiplication carried out in 192-bit precision.
        ///
        /// Multiplying before dividing is essential: it prevents the ratio from being truncated
        /// to zero (which would trap funds in redemption or under-mint LP shares), while the wide
        /// intermediate makes the product overflow-safe for realistic reserve sizes. Panics only
        /// on `denom == 0` or a result that genuinely exceeds the `Amount` range.
        fn mul_div(a: Amount, b: Amount, denom: Amount) -> Amount {
            let product = a
                .into_precision_amount()
                .checked_mul(b.into_precision_amount())
                .expect("overflow in mul_div product");
            let quotient = product
                .checked_div(denom.into_precision_amount())
                .expect("division by zero in mul_div");
            Amount::try_from(quotient).expect("mul_div result exceeds Amount range")
        }
    }
}
