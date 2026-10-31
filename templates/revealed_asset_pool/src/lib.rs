// RevealedAssetPool: a constant-product AMM for assets held as EXACT REVEALED integers.
// MIT License — noncustodial, permissionless, ownerless, no admin withdrawal, no protocol fee.
//
// WHY A SEPARATE TEMPLATE
//
// Pool v2 (templates/fungible_pool) admits only ordinary public fungibles and native tTARI by
// exact address; its guard refuses created-Stealth and Confidential resources because a
// template cannot inspect a resource's issuer authority (freeze/recall rules). That guard is
// NOT relaxed, and nothing here can put a private-typed resource into Pool v2. This is a
// different pool, opted into per pair, with its own eligibility policy stated in one place.
//
// WHAT MAKES THIS SAFE FOR A PRIVACY-TYPED RESOURCE
//
// The whole template depends on one property: `bucket.amount()` must be the WHOLE value of
// every bucket it is given, or integer reserve accounting is a lie.
//
//   * Fungible  — `amount` is the only value field. Exact.
//   * Stealth   — upstream's `ResourceContainer::Stealth { address, revealed_amount,
//                 locked_amount }` has NO commitment field at all, so a Stealth bucket's value
//                 is entirely its revealed amount. Exact. (Native tTARI is such a resource.)
//   * Confidential — `ResourceContainer::Confidential { .., commitments, revealed_amount, .. }`
//                 CAN carry blinded commitments beside the revealed amount, and `amount()`
//                 returns only the revealed part. A bucket carrying commitments is therefore
//                 REFUSED by `assert_contains_no_confidential_funds()` (upstream documents this
//                 exact use: "before performing an operation e.g. depositing it into a vault
//                 that expects only revealed funds"). Without that assert a depositor's blinded
//                 value would be silently unaccounted; with it, this pool only ever sees
//                 revealed value.
//   * NonFungible — rejected: there is no divisible amount to price.
//
// PRIVACY DISCLOSURE, STATED IN THE CODE BECAUSE IT CONSTRAINS THE DESIGN
//
// Reserves, every swap amount and every LP position in this pool are PUBLIC integers. Trading a
// Stealth- or Confidential-typed resource here reveals the traded amount, its timing and the
// counterparty's account. This is transparent liquidity for privacy-capable assets. It is not
// confidential liquidity and must never be described as such.
//
// ECONOMICS (identical to Pool v2, which is reviewed and live-verified)
//
// Constant product, fee in basis points out of 10_000 (30 bps = 0.30%), the full input
// deposited so the fee stays in the reserve for LPs, no developer or protocol fee, no owner,
// no admin withdrawal, LP mint/burn authorised only by this component's own frame, and a
// permanently locked minimum LP supply on the first deposit.
//
// DIFFERENCES FROM POOL v2, EACH DELIBERATE
//
//  1. Eligibility is the revealed-value policy above instead of "public fungible or tTARI".
//  2. Every incoming bucket is asserted to carry no blinded commitments and no locked funds.
//  3. There is no donating `add_liquidity`: the only deposit method takes the balanced amounts,
//     refunds the remainder and enforces `min_lp_out` (Pool v2 keeps its legacy method for
//     compatibility; a new template has no such obligation).
//  4. `remove_liquidity` enforces minimum outputs, so an exit cannot be sandwiched either.
//  5. The first-deposit minimum is expressed in LP SHARES with headroom over the permanently
//     locked amount, so the policy does not depend on a resource's divisibility; the refusal
//     message reports each side's divisibility so an operator can see why it did not qualify.

use tari_template_abi::rust::collections::BTreeMap;
use tari_template_lib::prelude::*;

#[template]
mod revealed_asset_pool {
    use super::*;

    /// Fee denominator in basis points: fee_bps / 10_000 = fee fraction.
    const FEE_DENOMINATOR_BPS: u128 = 10_000;

    /// Maximum supported fee tier: 1000 bps = 10.00%.
    const MAX_FEE_BPS: u16 = 1_000;

    /// LP shares permanently locked on the first deposit, never redeemable by anyone.
    const MINIMUM_LOCKED_LIQUIDITY: u128 = 1_000;

    /// The first deposit must mint at least this multiple of the locked amount, so the
    /// permanent lock is at most 1% of it. Pool v2 only required `shares >= locked`, which at
    /// the boundary would lock 100% of the first depositor's shares and leave them nothing for
    /// a real deposit. Requiring headroom makes the locked-minimum defence meaningful for a
    /// resource of ANY divisibility instead of assuming six decimal places.
    const LOCK_HEADROOM: u128 = 100;

    /// Pool component: one vault per side, the LP resource, the fee tier, and the vault that
    /// holds the permanently locked LP shares. No admin field, no owner, no fee recipient.
    pub struct RevealedAssetPool {
        pools: BTreeMap<ResourceAddress, Vault>,
        lp_resource: ResourceAddress,
        fee_bps: u16,
        locked_lp_vault: Vault,
    }

    impl RevealedAssetPool {
        /// Create an empty pool for an eligible pair. Permissionless: anyone may create one,
        /// and the creator receives no authority over it.
        pub fn new(
            a_addr: ResourceAddress,
            b_addr: ResourceAddress,
            fee_bps: u16,
        ) -> Component<Self> {
            assert_ne!(a_addr, b_addr, "Pool pair resources must differ");
            Self::validate_revealed_resource(a_addr);
            Self::validate_revealed_resource(b_addr);
            assert!(
                fee_bps > 0 && fee_bps <= MAX_FEE_BPS,
                "Pool fee must be in range 1..1000 basis points (30 bps = 0.30%)"
            );

            let (canonical_a, canonical_b) = Self::canonical_pair(a_addr, b_addr);
            let mut pools = BTreeMap::new();
            pools.insert(canonical_a, Vault::new_empty(canonical_a));
            pools.insert(canonical_b, Vault::new_empty(canonical_b));

            // Scope the LP resource to THIS component's address, allocated before creation, so
            // mint and burn are authorised only while this component is the acting frame — no
            // signer, owner or external caller can mint or burn LP, and the rules are Locked so
            // they can never be changed.
            let allocation = CallerContext::allocate_component_address(None);
            let this_component = allocation.get_address();

            // The LP token is an ordinary PUBLIC fungible even when the pooled assets are
            // privacy-typed: an LP position in a transparent pool is public information
            // already (the reserves and every trade are), so a privacy-typed LP token would
            // imply a protection this pool does not provide.
            let lp_resource = ResourceBuilder::public_fungible()
                .with_token_symbol("RLP")
                .with_divisibility(18)
                .with_owner_rule(OwnerRule::None)
                .mintable(rule!(component(this_component)), UpdateRule::Locked)
                .burnable(rule!(component(this_component)), UpdateRule::Locked)
                .build();
            let locked_lp_vault = Vault::new_empty(lp_resource);

            Component::new(Self {
                pools,
                lp_resource,
                fee_bps,
                locked_lp_vault,
            })
            .with_address_allocation(allocation)
            // OWNERLESS: with an owner, the engine would let that owner rewrite this component's
            // access rules after LPs had deposited (SetAccessRules requires only ownership), so
            // `remove_liquidity` could be denied and every LP's funds frozen. `OwnerRule::None`
            // means no such authorisation can ever exist. LP mint/burn is unaffected: it is
            // authorised by the component frame, not by ownership.
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(
                ComponentAccessRules::new()
                    .default(AccessRule::DenyAll)
                    .method("add_liquidity", AccessRule::AllowAll)
                    .method("swap", AccessRule::AllowAll)
                    .method("remove_liquidity", AccessRule::AllowAll)
                    .method("get_pool_balances", AccessRule::AllowAll)
                    .method("get_pool_balance", AccessRule::AllowAll)
                    .method("pair", AccessRule::AllowAll)
                    .method("lp_resource", AccessRule::AllowAll)
                    .method("lp_total_supply", AccessRule::AllowAll)
                    .method("locked_lp_supply", AccessRule::AllowAll)
                    .method("fee_bps", AccessRule::AllowAll),
            )
            .create()
        }

        /// Deposit liquidity, taking ONLY the balanced amounts and refunding the rest.
        /// Returns `(lp, refund_a, refund_b)` in the order the buckets were supplied; either
        /// refund may be empty. `min_lp_out` is enforced on-chain, so a ratio move between
        /// quote and execution cannot silently cost the depositor value.
        pub fn add_liquidity(
            &mut self,
            mut a_bucket: Bucket,
            mut b_bucket: Bucket,
            min_lp_out: Amount,
        ) -> (Bucket, Bucket, Bucket) {
            let a_res = a_bucket.resource_address();
            let b_res = b_bucket.resource_address();
            self.check_pool_resources(a_res, b_res);
            Self::assert_fully_revealed(&a_bucket, "Deposit A");
            Self::assert_fully_revealed(&b_bucket, "Deposit B");
            let a_amount = a_bucket.amount();
            let b_amount = b_bucket.amount();
            assert!(a_amount.is_positive(), "Deposit A must be positive");
            assert!(b_amount.is_positive(), "Deposit B must be positive");
            assert!(!min_lp_out.is_negative(), "min_lp_out must not be negative");

            let a_pool = self.get_pool_balance(a_res);
            let b_pool = self.get_pool_balance(b_res);

            if a_pool.is_zero() && b_pool.is_zero() {
                // FIRST DEPOSIT: there is no ratio to honour, so both buckets are taken whole
                // and the shares are the geometric mean of the amounts.
                let product = a_amount
                    .into_precision_amount()
                    .checked_mul(b_amount.into_precision_amount())
                    .expect("overflow computing initial liquidity product");
                let initial_shares = Amount::try_from(
                    product
                        .checked_sqrt()
                        .expect("overflow computing initial liquidity sqrt"),
                )
                .expect("initial shares exceed Amount range");
                let required = Amount::new(MINIMUM_LOCKED_LIQUIDITY * LOCK_HEADROOM);
                assert!(
                    initial_shares >= required,
                    "First deposit is too small: it would mint {} LP shares but at least {} are \
                     required so the permanently locked {} shares stay under 1% of the position. \
                     Supply more of either side (divisibility: A={}, B={}).",
                    initial_shares,
                    required,
                    MINIMUM_LOCKED_LIQUIDITY,
                    ResourceManager::get(a_res).divisibility(),
                    ResourceManager::get(b_res).divisibility()
                );

                let mut lp_bucket =
                    ResourceManager::get(self.lp_resource).mint_fungible(initial_shares);
                let locked = lp_bucket.take(Amount::new(MINIMUM_LOCKED_LIQUIDITY));
                self.locked_lp_vault.deposit(locked);
                assert!(
                    lp_bucket.amount() >= min_lp_out,
                    "LP output {} is below the minimum {}",
                    lp_bucket.amount(),
                    min_lp_out
                );
                // Take the amounts and return the now-EMPTY originals as the refunds, so the
                // return shape is identical to the subsequent-deposit path and the caller's
                // instruction list never changes.
                //
                // This must not be done by constructing empty buckets: `Bucket::take` asserts
                // `amount.is_positive()` in template_lib itself, so `take(0)` always panics.
                // Pool v2's `add_liquidity_exact` does exactly that in its own first-deposit
                // branch and therefore cannot serve a first deposit at all (proved in
                // audit_engine_tests/tests/pool_engine.rs e07e). Returning the drained inputs
                // avoids the whole class: an already-empty bucket deposits fine.
                let deposit_a = a_bucket.take(a_amount);
                let deposit_b = b_bucket.take(b_amount);
                self.pools.get_mut(&a_res).unwrap().deposit(deposit_a);
                self.pools.get_mut(&b_res).unwrap().deposit(deposit_b);
                return (lp_bucket, a_bucket, b_bucket);
            }

            assert!(
                !a_pool.is_zero() && !b_pool.is_zero(),
                "Pool reserves are one-sided; liquidity cannot be priced"
            );

            let total_supply = self.lp_total_supply();
            let a_shares = Self::mul_div(a_amount, total_supply, a_pool);
            let b_shares = Self::mul_div(b_amount, total_supply, b_pool);
            let lp_amount = a_shares.min(b_shares);
            assert!(
                lp_amount.is_positive(),
                "Contribution too small relative to reserves to mint any LP shares"
            );
            assert!(
                lp_amount >= min_lp_out,
                "LP output {} is below the minimum {}",
                lp_amount,
                min_lp_out
            );

            // What those shares are worth at the CURRENT reserves, rounded UP so a remainder
            // can never dilute the pool. Both are <= what was supplied, because `lp_amount` is
            // the smaller of the two share computations.
            let take_a = Self::mul_div_ceil(lp_amount, a_pool, total_supply);
            let take_b = Self::mul_div_ceil(lp_amount, b_pool, total_supply);
            let deposit_a = a_bucket.take(take_a);
            let deposit_b = b_bucket.take(take_b);
            self.pools.get_mut(&a_res).unwrap().deposit(deposit_a);
            self.pools.get_mut(&b_res).unwrap().deposit(deposit_b);

            let lp = ResourceManager::get(self.lp_resource).mint_fungible(lp_amount);
            (lp, a_bucket, b_bucket)
        }

        /// Swap `input_bucket` for `output_resource`, delivering at least `min_output`.
        ///
        /// `min_output` is the authoritative slippage bound and is enforced here, on-chain: a
        /// frontend or indexer check is not a substitute.
        pub fn swap(
            &mut self,
            input_bucket: Bucket,
            output_resource: ResourceAddress,
            min_output: Amount,
        ) -> Bucket {
            let input_resource = input_bucket.resource_address();
            self.check_pool_resources(input_resource, output_resource);
            Self::assert_fully_revealed(&input_bucket, "Swap input");

            let input_pool = self.get_pool_balance(input_resource);
            let output_pool = self.get_pool_balance(output_resource);
            assert!(!input_pool.is_zero(), "Input reserve is empty");
            assert!(!output_pool.is_zero(), "Output reserve is empty");

            let input_amount = input_bucket.amount();
            assert!(input_amount.is_positive(), "Swap amount must be positive");

            // The fee-reduced input drives the price move, but the FULL input is deposited, so
            // the fee stays in the reserve as LP profit and the constant product grows.
            let fee_bps = Amount::new(self.fee_bps as u128);
            let denom = Amount::new(FEE_DENOMINATOR_BPS);
            let effective_input = Self::mul_div(input_amount, denom - fee_bps, denom);
            assert!(
                effective_input.is_positive(),
                "Swap input too small to yield any output after fee"
            );

            // output = output_pool * effective_input / (input_pool + effective_input), in
            // 192-bit precision so a large reserve cannot overflow the product.
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
            assert!(
                output_amount >= min_output,
                "Slippage: output {} is below min_output {}",
                output_amount,
                min_output
            );
            // The output must come out of reserves that actually hold it; withdrawing the whole
            // reserve would leave the pair unpriceable for everyone else.
            assert!(
                output_amount < output_pool,
                "Swap would drain the entire {} reserve",
                output_resource
            );

            self.pools
                .get_mut(&input_resource)
                .unwrap()
                .deposit(input_bucket);
            self.pools
                .get_mut(&output_resource)
                .unwrap()
                .withdraw(output_amount)
        }

        /// Burn LP shares and take the proportional reserves, at least `min_a`/`min_b` of the
        /// pair in canonical order. Returns `(a, b)` in that same canonical order.
        pub fn remove_liquidity(
            &mut self,
            lp_bucket: Bucket,
            min_a: Amount,
            min_b: Amount,
        ) -> (Bucket, Bucket) {
            assert_eq!(
                lp_bucket.resource_address(),
                self.lp_resource,
                "Invalid LP resource"
            );
            let lp_amount = lp_bucket.amount();
            assert!(
                lp_amount.is_positive(),
                "LP removal amount must be positive"
            );
            assert!(
                !min_a.is_negative() && !min_b.is_negative(),
                "Minimum outputs must not be negative"
            );

            let (a_res, b_res) = self.pair();
            let a_pool = self.get_pool_balance(a_res);
            let b_pool = self.get_pool_balance(b_res);
            let total_lp = self.lp_total_supply();
            assert!(!total_lp.is_zero(), "LP total supply is zero");

            // Multiply BEFORE dividing: computing the share fraction first would truncate to
            // zero for any partial position, burning the LP and returning nothing. Floor
            // division rounds in favour of the pool.
            let a_amount = Self::mul_div(lp_amount, a_pool, total_lp);
            let b_amount = Self::mul_div(lp_amount, b_pool, total_lp);
            assert!(
                a_amount.is_positive() && b_amount.is_positive(),
                "Redemption too small to withdraw any reserves"
            );
            assert!(
                a_amount >= min_a && b_amount >= min_b,
                "Slippage: redemption would return {} and {}, below the minimums {} and {}",
                a_amount,
                b_amount,
                min_a,
                min_b
            );

            lp_bucket.burn();
            let a_bucket = self.pools.get_mut(&a_res).unwrap().withdraw(a_amount);
            let b_bucket = self.pools.get_mut(&b_res).unwrap().withdraw(b_amount);
            (a_bucket, b_bucket)
        }

        /// The pair in canonical (engine `Ord`) order.
        pub fn pair(&self) -> (ResourceAddress, ResourceAddress) {
            let mut keys = self.pools.keys();
            let a = *keys.next().unwrap();
            let b = *keys.next().unwrap();
            (a, b)
        }

        pub fn get_pool_balances(&self) -> BTreeMap<ResourceAddress, Amount> {
            self.pools
                .iter()
                .map(|(resource, vault)| (*resource, vault.balance()))
                .collect()
        }

        pub fn get_pool_balance(&self, resource_address: ResourceAddress) -> Amount {
            self.pools
                .get(&resource_address)
                .map(|vault| vault.balance())
                .unwrap_or_else(Amount::zero)
        }

        pub fn lp_resource(&self) -> ResourceAddress {
            self.lp_resource
        }

        pub fn lp_total_supply(&self) -> Amount {
            ResourceManager::get(self.lp_resource).total_supply()
        }

        pub fn locked_lp_supply(&self) -> Amount {
            self.locked_lp_vault.balance()
        }

        pub fn fee_bps(&self) -> u16 {
            self.fee_bps
        }

        // -----------------------------------------------------------------------------------
        // Internals
        // -----------------------------------------------------------------------------------

        /// THE eligibility policy, in one place.
        ///
        /// Fungible, Stealth and Confidential resources are admitted because each can hold
        /// value as an exact revealed integer; `assert_fully_revealed` then guarantees that
        /// every bucket this pool receives contains nothing BUT such value. NonFungible is
        /// rejected: a token id is not a divisible amount and cannot be priced by a reserve
        /// ratio.
        ///
        /// Like Pool v2, this cannot inspect a resource's issuer authority (the template ABI
        /// exposes no access-rule introspection at v0.48.0), so a resource whose issuer kept
        /// recall or freeze rights remains as risky here as anywhere else on the network. That
        /// is why this pool is opted into per pair rather than being the default venue.
        fn validate_revealed_resource(resource: ResourceAddress) {
            let resource_type = ResourceManager::get(resource).resource_type();
            assert!(
                matches!(
                    resource_type,
                    ResourceType::Fungible | ResourceType::Stealth | ResourceType::Confidential
                ),
                "Resource {:?} is not eligible for a revealed-value pool: only Fungible, \
                 Stealth or Confidential resources can be priced by exact revealed amounts \
                 (non-fungible resources are rejected)",
                resource
            );
        }

        /// Every bucket entering this pool must contain its WHOLE value as a revealed amount.
        ///
        /// For a Confidential resource a bucket may also carry blinded commitments, and
        /// `amount()` reports only the revealed part; depositing such a bucket would leave that
        /// blinded value unaccounted for in a reserve this template prices in exact integers.
        /// Upstream provides this assertion for precisely this case. A locked portion is
        /// refused for the same reason: `amount()` excludes it.
        fn assert_fully_revealed(bucket: &Bucket, what: &str) {
            bucket.assert_contains_no_confidential_funds();
            assert!(
                bucket.locked_amount().is_zero(),
                "{} carries locked funds, which are not counted in its amount and cannot be pooled",
                what
            );
        }

        fn check_pool_resources(&self, a: ResourceAddress, b: ResourceAddress) {
            assert_ne!(a, b, "Pool resources must differ");
            assert!(self.pools.contains_key(&a), "Resource {:?} not in pool", a);
            assert!(self.pools.contains_key(&b), "Resource {:?} not in pool", b);
        }

        /// Deterministic pairing from the engine's own `Ord`, never from a display string.
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

        /// `a * b / denom`, the product taken in 192-bit precision, floored.
        fn mul_div(a: Amount, b: Amount, denom: Amount) -> Amount {
            assert!(!denom.is_zero(), "mul_div by zero");
            let result = a
                .into_precision_amount()
                .checked_mul(b.into_precision_amount())
                .and_then(|product| product.checked_div(denom.into_precision_amount()))
                .expect("overflow in mul_div");
            Amount::try_from(result).expect("mul_div result exceeds Amount range")
        }

        /// `ceil(a * b / denom)`, the product taken in 192-bit precision. Identical to Pool
        /// v2's, so the rounding behaviour LPs are already exposed to is unchanged.
        fn mul_div_ceil(a: Amount, b: Amount, denom: Amount) -> Amount {
            assert!(!denom.is_zero(), "mul_div_ceil by zero");
            let floor = Self::mul_div(a, b, denom);
            let exact = floor
                .into_precision_amount()
                .checked_mul(denom.into_precision_amount())
                .expect("overflow in mul_div_ceil check");
            let product = a
                .into_precision_amount()
                .checked_mul(b.into_precision_amount())
                .expect("overflow in mul_div_ceil product");
            if exact == product {
                floor
            } else {
                floor
                    .checked_add(Amount::new(1))
                    .expect("mul_div_ceil result exceeds Amount range")
            }
        }
    }
}
