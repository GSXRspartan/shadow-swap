// Real Ootle engine tests for the fungible_pool template (SECURITY_AUDIT_OPUS).
//
// These execute the ACTUAL template WASM in the engine via tari_template_test_tooling
// (the template at ../templates/fungible_pool is compiled to WASM and loaded). They encode
// the economic and authorization invariants the audit fixes rely on, so any regression in
// the template is caught by real engine execution rather than by inspection.

use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{
    constants::TARI_TOKEN, Amount, ComponentAddress, NonFungibleAddress, ResourceAddress,
    SubstateOwnerRule,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");

struct PoolTest {
    t: TemplateTest,
    a: ResourceAddress,
    b: ResourceAddress,
    lp: ResourceAddress,
    pool: ComponentAddress,
    account: ComponentAddress,
    account_proof: NonFungibleAddress,
}

fn create_faucet(t: &mut TemplateTest, symbol: &str) -> (ComponentAddress, ResourceAddress) {
    let initial = Amount::from(1_000_000_000_000u64);
    let component: ComponentAddress = t.call_function(
        "TestFaucet",
        "mint_with_symbol",
        args![initial, symbol.to_string()],
        vec![],
    );
    let resource = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    (component, resource)
}

fn setup(fee: u16) -> PoolTest {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        ["../templates/fungible_pool", "templates/faucet"],
    );

    let (a_faucet, a) = create_faucet(&mut t, "AAA");
    let (b_faucet, b) = create_faucet(&mut t, "BBB");

    let pool_template = t.get_template_address("Pool");
    let seal_tx = t
        .transaction()
        .call_function(pool_template, "new", args![a, b, fee])
        .build_and_seal(t.secret_key());
    let res = t.execute_expect_success(seal_tx, vec![]);
    let (pool_addr, _) = res
        .expect_success()
        .up_iter()
        .find(|(addr, s)| {
            addr.is_component()
                && *s.substate_value().component().unwrap().template_address() == pool_template
        })
        .unwrap();
    let pool = pool_addr.as_component_address().unwrap();
    let (lp_addr, _) = res
        .expect_success()
        .up_iter()
        .find(|(addr, _)| addr.is_resource())
        .unwrap();
    let lp = lp_addr.as_resource_address().unwrap();

    // IMPORTANT: the account is a SEPARATE identity from the pool creator (t.secret_key()).
    // If LP minting were gated on the creator's owner badge, this account could not add
    // liquidity; proving that it CAN is the evidence that the pool is permissionless.
    let (account, account_proof, _) = t.create_funded_account();
    let mut pt = PoolTest {
        t,
        a,
        b,
        lp,
        pool,
        account,
        account_proof,
    };
    fund(&mut pt, a_faucet);
    fund(&mut pt, b_faucet);
    pt
}

fn fund(pt: &mut PoolTest, faucet: ComponentAddress) {
    let account = pt.account;
    // TestFaucet::take_free_coins pays out exactly 1_000_000_000 units per call. The engine
    // tests deposit up to 1_000_000_000 into the pool AND then swap up to 100_000_000 more, so
    // the account needs 2 payouts of each resource; a single payout left it with 0 and made the
    // swap's `withdraw` fail with "Required: 100000000, Available: 0" (e03 CI failure).
    for _ in 0..2 {
        let tx =
            pt.t.transaction()
                .call_method(faucet, "take_free_coins", args![])
                .put_last_instruction_output_on_workspace("coins")
                .call_method(account, "deposit", args![Workspace("coins")]);
        pt.t.build_and_execute(tx, vec![]).expect_success();
    }
}

// NOTE: `resource` comes BEFORE `&mut pt` so a `pt.<field>` argument is read (Copy) before the
// mutable borrow is taken — avoids E0503 at call sites (two-phase borrow does not apply to a free
// function's explicit `&mut` argument).
fn account_balance(resource: ResourceAddress, pt: &mut PoolTest) -> Amount {
    let acc = pt.account;
    pt.t.call_method(acc, "balance", args![resource], vec![])
}

fn pool_balance(resource: ResourceAddress, pt: &mut PoolTest) -> Amount {
    let pool = pt.pool;
    pt.t.call_method(pool, "get_pool_balance", args![resource], vec![])
}

fn add_liquidity(pt: &mut PoolTest, a_amt: Amount, b_amt: Amount) {
    let (a, b, account, pool, proof) = (pt.a, pt.b, pt.account, pt.pool, pt.account_proof.clone());
    let tx =
        pt.t.transaction()
            .call_method(account, "withdraw", args![a, a_amt])
            .put_last_instruction_output_on_workspace("a")
            .call_method(account, "withdraw", args![b, b_amt])
            .put_last_instruction_output_on_workspace("b")
            .call_method(pool, "add_liquidity", args![Workspace("a"), Workspace("b")])
            .put_last_instruction_output_on_workspace("lp")
            .call_method(account, "deposit", args![Workspace("lp")]);
    pt.t.build_and_execute(tx, vec![proof]).expect_success();
}

/// Public-wrapper market regression. `wUSD` is an ordinary public fungible fixture, which proves
/// the AMM lane used by a reviewed wrapper without claiming to test the issuer-gated private
/// stablecoin conversion contract. Native Tari is the engine's canonical `TARI_TOKEN`.
#[test]
fn e06_tari_wstable_public_wrapper_lifecycle() {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        ["../templates/fungible_pool", "templates/faucet"],
    );
    let (wrapper_faucet, wrapped) = create_faucet(&mut t, "wUSD");
    let pool_template = t.get_template_address("Pool");
    let result = t.execute_expect_success(
        t.transaction()
            .call_function(pool_template, "new", args![TARI_TOKEN, wrapped, 30u16])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    let pool = result
        .expect_success()
        .up_iter()
        .find(|(address, substate)| {
            address.is_component()
                && *substate
                    .substate_value()
                    .component()
                    .unwrap()
                    .template_address()
                    == pool_template
        })
        .unwrap()
        .0
        .as_component_address()
        .unwrap();
    let lp = result
        .expect_success()
        .up_iter()
        .find(|(address, _)| address.is_resource())
        .unwrap()
        .0
        .as_resource_address()
        .unwrap();

    let (account, proof, _) = t.create_funded_account();
    for _ in 0..2 {
        t.build_and_execute(
            t.transaction()
                .call_method(wrapper_faucet, "take_free_coins", args![])
                .put_last_instruction_output_on_workspace("wrapped")
                .call_method(account, "deposit", args![Workspace("wrapped")]),
            vec![],
        )
        .expect_success();
    }

    let initial = Amount::from(10_000_000u64);
    t.build_and_execute(
        t.transaction()
            .call_method(account, "withdraw", args![TARI_TOKEN, initial])
            .put_last_instruction_output_on_workspace("tari")
            .call_method(account, "withdraw", args![wrapped, initial])
            .put_last_instruction_output_on_workspace("wrapped")
            .call_method(
                pool,
                "add_liquidity",
                args![Workspace("tari"), Workspace("wrapped")],
            )
            .put_last_instruction_output_on_workspace("lp")
            .call_method(account, "deposit", args![Workspace("lp")]),
        vec![proof.clone()],
    )
    .expect_success();

    for (input, output) in [(TARI_TOKEN, wrapped), (wrapped, TARI_TOKEN)] {
        t.build_and_execute(
            t.transaction()
                .call_method(
                    account,
                    "withdraw",
                    args![input, Amount::from(1_000_000u64)],
                )
                .put_last_instruction_output_on_workspace("input")
                .call_method(
                    pool,
                    "swap",
                    args![Workspace("input"), output, Amount::from(1u64)],
                )
                .put_last_instruction_output_on_workspace("output")
                .call_method(account, "deposit", args![Workspace("output")]),
            vec![proof.clone()],
        )
        .expect_success();
    }

    let lp_held: Amount = t.call_method(account, "balance", args![lp], vec![]);
    t.build_and_execute(
        t.transaction()
            .call_method(account, "withdraw", args![lp, lp_held])
            .put_last_instruction_output_on_workspace("lp")
            .call_method(pool, "remove_liquidity", args![Workspace("lp")])
            .put_last_instruction_output_on_workspace("redeemed")
            .call_method(account, "deposit", args![Workspace("redeemed.0")])
            .call_method(account, "deposit", args![Workspace("redeemed.1")]),
        vec![proof],
    )
    .expect_success();

    let locked: Amount = t.call_method(pool, "locked_lp_supply", args![], vec![]);
    assert_eq!(locked, Amount::from(1_000u64));
}

// ---------------------------------------------------------------------------

/// Mint authority + permissionlessness: a NON-creator account can add the first liquidity and
/// receive LP. Pre-fix, LP mint was `DenyAll` with only a resource-owner override, so a
/// non-creator identity could not mint. The component-scoped mint rule makes it permissionless.
#[test]
fn e01_permissionless_add_liquidity_and_lp_received() {
    let mut pt = setup(3);
    add_liquidity(
        &mut pt,
        Amount::from(10_000_000u64),
        Amount::from(10_000_000u64),
    );
    let lp_held = account_balance(pt.lp, &mut pt);
    println!("e01 LP held by non-creator provider = {}", lp_held);
    assert!(lp_held.is_positive(), "non-creator provider received no LP");
    // total minted = floor(sqrt(1e7*1e7)) = 1e7; locked minimum = 1000
    assert_eq!(
        lp_held,
        Amount::from(10_000_000u64) - Amount::from(1_000u64)
    );
}

/// Redemption / trapped-funds: full redemption returns essentially all deposited reserves.
/// Pre-fix `ratio = lp/total` truncated to 0 and returned NOTHING, trapping funds.
#[test]
fn e02_redemption_returns_reserves() {
    let mut pt = setup(3);
    add_liquidity(
        &mut pt,
        Amount::from(10_000_000u64),
        Amount::from(10_000_000u64),
    );

    let lp_held = account_balance(pt.lp, &mut pt);
    let a_before = account_balance(pt.a, &mut pt);
    let b_before = account_balance(pt.b, &mut pt);

    let (lp, account, pool, proof) = (pt.lp, pt.account, pt.pool, pt.account_proof.clone());
    let tx =
        pt.t.transaction()
            .call_method(account, "withdraw", args![lp, lp_held])
            .put_last_instruction_output_on_workspace("lp")
            .call_method(pool, "remove_liquidity", args![Workspace("lp")])
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            .call_method(account, "deposit", args![Workspace("out.1")]);
    pt.t.build_and_execute(tx, vec![proof]).expect_success();

    let a_ret = account_balance(pt.a, &mut pt) - a_before;
    let b_ret = account_balance(pt.b, &mut pt) - b_before;
    println!("e02 returned a={} b={}", a_ret, b_ret);
    // Provider held 9_999_000 of 10_000_000 total supply; expect ~9_999_000 of each.
    assert!(
        a_ret >= Amount::from(9_990_000u64),
        "A returned too small (trapped funds?): {}",
        a_ret
    );
    assert!(
        b_ret >= Amount::from(9_990_000u64),
        "B returned too small (trapped funds?): {}",
        b_ret
    );
}

/// Fee / invariant: after a swap the constant product k must strictly INCREASE (fee retained
/// for LPs). Pre-fix the swap used the full input in the k-division and discarded the fee.
/// (OPUS-14) The fee is in BASIS POINTS out of 10_000: 30 bps = 0.30%. Pre-OPUS-14 the
/// contract divided by 1000 (per-mil), so fee=30 charged 3.0% — 10x the advertised 0.30%.
///
/// Exact integer expectation for this test (fee = 30 bps = 0.30%, reserves 1e9/1e9, input
/// 100_000_000):
///   effective_input = 100_000_000 * (10_000 - 30) / 10_000      = 99_700_000
///   output          = 1e9 * 99_700_000 / (1e9 + 99_700_000)     = 90_661_089  (floor)
///   reserve_a_after = 1_100_000_000   (FULL input deposited; fee stays in reserve for LPs)
///   reserve_b_after = 909_338_911
///   k_before        = 1_000_000_000_000_000_000
///   k_after         = 1_000_272_802_100_000_000   (> k_before by 272_802_100_000_000)
///   fee-free output = 90_909_090 (trader must receive strictly less)
///
/// NOTE: the earlier CI failure of this test was NOT a contract bug — the account held only
/// the single 1e9 faucet payout, which add_liquidity consumed, so the swap's withdraw failed
/// with "Required: 100000000, Available: 0" before the contract ever executed.
#[test]
fn e03_swap_charges_fee_growing_k() {
    let mut pt = setup(30); // fee is in basis points: 30 = 0.30%
    add_liquidity(
        &mut pt,
        Amount::from(1_000_000_000u64),
        Amount::from(1_000_000_000u64),
    );

    let a0 = pool_balance(pt.a, &mut pt).to_u128();
    let b0 = pool_balance(pt.b, &mut pt).to_u128();
    let k0 = a0 * b0;
    let acct_b_before = account_balance(pt.b, &mut pt).to_u128();

    let (a, b, account, pool, proof) = (pt.a, pt.b, pt.account, pt.pool, pt.account_proof.clone());
    let tx =
        pt.t.transaction()
            .call_method(account, "withdraw", args![a, Amount::from(100_000_000u64)])
            .put_last_instruction_output_on_workspace("in")
            .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(1u64)])
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out")]);
    pt.t.build_and_execute(tx, vec![proof]).expect_success();

    let a1 = pool_balance(pt.a, &mut pt).to_u128();
    let b1 = pool_balance(pt.b, &mut pt).to_u128();
    let k1 = a1 * b1;
    let actual_output = account_balance(pt.b, &mut pt).to_u128() - acct_b_before;

    // Independent reference calculation (no floats, floor division) matching the template:
    let effective_input = 100_000_000u128 * 9_970 / 10_000;
    let expected_output = b0 * effective_input / (a0 + effective_input);
    let fee_free_output = b0 * 100_000_000u128 / (a0 + 100_000_000u128);
    let k_delta = k1 - k0;

    println!(
        "e03 diagnostics: reserve_a_before={} reserve_b_before={} input=100000000 fee_bps=30 \
         effective_input={} expected_output={} actual_output={} reserve_a_after={} \
         reserve_b_after={} k_before={} k_after={} k_delta={}",
        a0, b0, effective_input, expected_output, actual_output, a1, b1, k0, k1, k_delta
    );

    // FULL input lands in the reserve — the fee (30_000 of input) stays with the LPs.
    assert_eq!(
        a1,
        a0 + 100_000_000u128,
        "full input must be deposited into the input reserve"
    );
    assert_eq!(
        actual_output, expected_output,
        "engine output does not match exact fee-adjusted constant-product math"
    );
    assert!(
        actual_output < fee_free_output,
        "trader received the fee-free output; fee not retained"
    );
    assert!(
        k1 > k0,
        "fee NOT charged: k did not grow (k0={} k1={})",
        k0,
        k1
    );
    // OPUS-14 guard: fee must be charged at the ADVERTISED 30 bps (0.30%), not 10x.
    // With 30 bps the trader receives 90_661_089; a 10x (per-mil) fee would deliver only
    // 88_422_971. Pin the exact value so a fee-unit regression cannot slip through.
    assert_eq!(
        actual_output, 90_661_089u128,
        "output must match the 30-bps (0.30%) fee tier exactly"
    );
}

/// Reverse direction (B -> A): identical fee semantics must hold symmetrically.
/// effective_input = 99_700_000, output = 90_661_089, k_after = 1_000_272_802_100_000_000.
#[test]
fn e03b_reverse_swap_fee_grows_k() {
    let mut pt = setup(30); // fee is in basis points: 30 = 0.30%
    add_liquidity(
        &mut pt,
        Amount::from(1_000_000_000u64),
        Amount::from(1_000_000_000u64),
    );

    let a0 = pool_balance(pt.a, &mut pt).to_u128();
    let b0 = pool_balance(pt.b, &mut pt).to_u128();
    let k0 = a0 * b0;
    let acct_a_before = account_balance(pt.a, &mut pt).to_u128();

    let (a, b, account, pool, proof) = (pt.a, pt.b, pt.account, pt.pool, pt.account_proof.clone());
    let tx =
        pt.t.transaction()
            .call_method(account, "withdraw", args![b, Amount::from(100_000_000u64)])
            .put_last_instruction_output_on_workspace("in")
            .call_method(pool, "swap", args![Workspace("in"), a, Amount::from(1u64)])
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out")]);
    pt.t.build_and_execute(tx, vec![proof]).expect_success();

    let a1 = pool_balance(pt.a, &mut pt).to_u128();
    let b1 = pool_balance(pt.b, &mut pt).to_u128();
    let k1 = a1 * b1;
    let actual_output = account_balance(pt.a, &mut pt).to_u128() - acct_a_before;

    let effective_input = 100_000_000u128 * 9_970 / 10_000;
    let expected_output = a0 * effective_input / (b0 + effective_input);

    println!(
        "e03b diagnostics: reserve_a_before={} reserve_b_before={} input=100000000 \
         effective_input={} expected_output={} actual_output={} reserve_a_after={} \
         reserve_b_after={} k_before={} k_after={} k_delta={}",
        a0,
        b0,
        effective_input,
        expected_output,
        actual_output,
        a1,
        b1,
        k0,
        k1,
        k1 - k0
    );

    assert_eq!(
        b1,
        b0 + 100_000_000u128,
        "full input must reach the reserve"
    );
    assert_eq!(
        actual_output, expected_output,
        "reverse-direction output mismatch"
    );
    assert_eq!(
        actual_output, 90_661_089u128,
        "reverse-direction output must match the 30-bps (0.30%) fee tier exactly"
    );
    assert!(
        k1 > k0,
        "fee NOT charged in reverse direction (k0={} k1={})",
        k0,
        k1
    );
}

/// Slippage: a swap whose min_output exceeds the achievable output must abort atomically.
#[test]
fn e04_slippage_min_output_enforced() {
    let mut pt = setup(3);
    add_liquidity(
        &mut pt,
        Amount::from(1_000_000_000u64),
        Amount::from(1_000_000_000u64),
    );

    let (a, b, account, pool, proof) = (pt.a, pt.b, pt.account, pt.pool, pt.account_proof.clone());
    let sealed =
        pt.t.transaction()
            .call_method(account, "withdraw", args![a, Amount::from(1_000_000u64)])
            .put_last_instruction_output_on_workspace("in")
            // demand an impossibly high output
            .call_method(
                pool,
                "swap",
                args![Workspace("in"), b, Amount::from(1_000_000_000u64)],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out")])
            .build_and_seal(pt.t.secret_key());
    let reason = pt.t.execute_expect_failure(sealed, vec![proof]);
    println!("e04 rejected as expected: {:?}", reason);
}

/// Integer rounding at micro scale (documents behavior, does not weaken assertions), under the
/// 30-bps (0.30%) fee tier:
///   * a 3-unit swap pays effective input 3*9_970/10_000 = 2 (floor) and receives exactly
///     1_000_000_000 * 2 / (1_000_000_000 + 2) = 1 unit out; k still grows;
///   * a 1-unit swap has effective input 9_970/10_000 = 0 and must ABORT (never a free trade).
///
/// No sequence of such micro-swaps can create free value: every successful trade strictly
/// decreases the trader's combined input+output value (fee floor + output floor).
#[test]
fn e05_micro_swap_rounding() {
    let mut pt = setup(30); // fee is in basis points: 30 = 0.30%
    add_liquidity(
        &mut pt,
        Amount::from(1_000_000_000u64),
        Amount::from(1_000_000_000u64),
    );

    let a0 = pool_balance(pt.a, &mut pt).to_u128();
    let b0 = pool_balance(pt.b, &mut pt).to_u128();
    let k0 = a0 * b0;

    let (a, b, account, pool, proof) = (pt.a, pt.b, pt.account, pt.pool, pt.account_proof.clone());
    let tx =
        pt.t.transaction()
            .call_method(account, "withdraw", args![a, Amount::from(3u64)])
            .put_last_instruction_output_on_workspace("in")
            .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(1u64)])
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out")]);
    // `proof` (NonFungibleAddress) is not Copy; clone here so the same authorization identity
    // stays available for the 1-unit rejection transaction below.
    pt.t.build_and_execute(tx, vec![proof.clone()])
        .expect_success();

    let a1 = pool_balance(pt.a, &mut pt).to_u128();
    let b1 = pool_balance(pt.b, &mut pt).to_u128();
    let k1 = a1 * b1;
    println!(
        "e05 micro-swap: a0={} b0={} a1={} b1={} k0={} k1={} k_delta={}",
        a0,
        b0,
        a1,
        b1,
        k0,
        k1,
        k1 - k0
    );
    assert_eq!(a1, a0 + 3u128, "3-unit swap must deposit the full input");
    assert_eq!(b1, b0 - 1u128, "3-unit swap output must floor to exactly 1");
    assert!(
        k1 > k0,
        "3-unit swap must still grow k (k0={} k1={})",
        k0,
        k1
    );

    // 1-unit swap: effective input floors to 0 -> must abort, never a free trade.
    let sealed =
        pt.t.transaction()
            .call_method(account, "withdraw", args![a, Amount::from(1u64)])
            .put_last_instruction_output_on_workspace("in")
            .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(1u64)])
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out")])
            .build_and_seal(pt.t.secret_key());
    let reason = pt.t.execute_expect_failure(sealed, vec![proof]);
    println!("e05 1-unit swap rejected as expected: {:?}", reason);
}

/// OPUS-16 — the Pool component must be created OWNERLESS (`OwnerRule::None`).
///
/// If the component defaults to `OwnedBySigner` (the creator), the engine's
/// `ComponentAction::SetAccessRules` / `SetOwnerRule` — which require only component
/// ownership — let the deployer rewrite the pool's method access rules AFTER liquidity
/// providers have deposited: e.g. deny `remove_liquidity` and permanently freeze every
/// LP's funds (a non-custodial-AMM-breaking DoS), even though no admin WITHDRAW method
/// exists. `OwnerRule::None` removes the owner entirely, so SetAccessRules/SetOwnerRule
/// can never be authorised by anyone, making the published rule set truly immutable.
///
/// LP mint/burn is unaffected: it is authorised by the COMPONENT frame
/// (`rule!(component(this_component))`), not by component ownership.
#[test]
fn opus16_pool_component_is_ownerless() {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        ["../templates/fungible_pool", "templates/faucet"],
    );
    let (_a_faucet, a) = create_faucet(&mut t, "AAA");
    let (_b_faucet, b) = create_faucet(&mut t, "BBB");
    let pool_template = t.get_template_address("Pool");
    let seal_tx = t
        .transaction()
        .call_function(pool_template, "new", args![a, b, 30u16])
        .build_and_seal(t.secret_key());
    let res = t.execute_expect_success(seal_tx, vec![]);
    let ownerless = res
        .expect_success()
        .up_iter()
        .find(|(addr, s)| {
            addr.is_component()
                && *s.substate_value().component().unwrap().template_address() == pool_template
        })
        .map(|(_, s)| {
            matches!(
                s.substate_value().component().unwrap().owner_rule(),
                SubstateOwnerRule::None
            )
        })
        .expect("pool component must be created");
    assert!(
        ownerless,
        "Pool component must be ownerless (OwnerRule::None). A non-None owner can call \
         SetAccessRules/SetOwnerRule on the pool and freeze LP withdrawals."
    );
}

// ---------------------------------------------------------------------------------------------
// add_liquidity_exact (v0.48 release-readiness audit finding)
//
// `add_liquidity` mints on the smaller side but deposits BOTH full buckets, so any imbalance at
// execution time is donated to existing LPs, with no minimum-output guard. `add_liquidity_exact`
// takes only the balanced amounts, refunds the rest, and enforces `min_lp_out` on-chain.
// ---------------------------------------------------------------------------------------------

/// Calls `add_liquidity_exact` and deposits all three returned buckets.
fn add_liquidity_exact_tx(
    pt: &mut PoolTest,
    a_amt: Amount,
    b_amt: Amount,
    min_lp: Amount,
) -> tari_ootle_transaction::Transaction {
    let (a, b, account, pool) = (pt.a, pt.b, pt.account, pt.pool);
    pt.t.transaction()
        .call_method(account, "withdraw", args![a, a_amt])
        .put_last_instruction_output_on_workspace("a")
        .call_method(account, "withdraw", args![b, b_amt])
        .put_last_instruction_output_on_workspace("b")
        .call_method(
            pool,
            "add_liquidity_exact",
            args![Workspace("a"), Workspace("b"), min_lp],
        )
        .put_last_instruction_output_on_workspace("out")
        .call_method(account, "deposit", args![Workspace("out.0")])
        .call_method(account, "deposit", args![Workspace("out.1")])
        .call_method(account, "deposit", args![Workspace("out.2")])
        .build_and_seal(pt.t.secret_key())
}

#[test]
fn e07_add_liquidity_exact_refunds_the_imbalance_instead_of_donating_it() {
    let mut pt = setup(30);
    add_liquidity(
        &mut pt,
        Amount::from(100_000_000u64),
        Amount::from(100_000_000u64),
    );
    let (a, b, lp) = (pt.a, pt.b, pt.lp);
    let total_before: Amount = {
        let pool = pt.pool;
        pt.t.call_method(pool, "lp_total_supply", args![], vec![])
    };
    let acct_a = account_balance(a, &mut pt);
    let acct_b = account_balance(b, &mut pt);
    let acct_lp = account_balance(lp, &mut pt);
    let pool_a = pool_balance(a, &mut pt);
    let pool_b = pool_balance(b, &mut pt);

    // 1:3 against a 1:1 pool. Only 10M of B is worth anything; 20M must come back.
    let tx = add_liquidity_exact_tx(
        &mut pt,
        Amount::from(10_000_000u64),
        Amount::from(30_000_000u64),
        Amount::from(1u64),
    );
    let proof = pt.account_proof.clone();
    pt.t.execute_expect_success(tx, vec![proof]);

    let expected_lp = Amount::from(10_000_000u64)
        .checked_mul(total_before)
        .unwrap()
        .checked_div(Amount::from(100_000_000u64))
        .unwrap();
    assert_eq!(account_balance(lp, &mut pt) - acct_lp, expected_lp);
    assert_eq!(
        acct_a - account_balance(a, &mut pt),
        Amount::from(10_000_000u64)
    );
    assert_eq!(
        acct_b - account_balance(b, &mut pt),
        Amount::from(10_000_000u64),
        "the 20M excess of B is refunded, not donated"
    );
    assert_eq!(
        pool_balance(a, &mut pt) - pool_a,
        Amount::from(10_000_000u64)
    );
    assert_eq!(
        pool_balance(b, &mut pt) - pool_b,
        Amount::from(10_000_000u64)
    );
}

#[test]
fn e07b_add_liquidity_exact_enforces_min_lp_out_on_chain() {
    let mut pt = setup(30);
    add_liquidity(
        &mut pt,
        Amount::from(100_000_000u64),
        Amount::from(100_000_000u64),
    );
    // Balanced 10M/10M mints ~10% of supply; demanding the whole supply must abort.
    let tx = add_liquidity_exact_tx(
        &mut pt,
        Amount::from(10_000_000u64),
        Amount::from(10_000_000u64),
        Amount::from(1_000_000_000_000u64),
    );
    let proof = pt.account_proof.clone();
    let reason = pt.t.execute_expect_failure(tx, vec![proof]);
    println!("e07b rejected as expected: {reason:?}");
}

#[test]
fn e07c_add_liquidity_exact_rounding_never_dilutes_the_pool() {
    let mut pt = setup(30);
    add_liquidity(
        &mut pt,
        Amount::from(100_000_007u64),
        Amount::from(300_000_011u64),
    );
    let (a, b) = (pt.a, pt.b);
    let pool = pt.pool;
    let total_before: Amount = pt.t.call_method(pool, "lp_total_supply", args![], vec![]);
    let pool_a = pool_balance(a, &mut pt);
    let pool_b = pool_balance(b, &mut pt);
    let tx = add_liquidity_exact_tx(
        &mut pt,
        Amount::from(1_000_003u64),
        Amount::from(3_000_019u64),
        Amount::from(1u64),
    );
    let proof = pt.account_proof.clone();
    pt.t.execute_expect_success(tx, vec![proof]);
    let total_after: Amount = pt.t.call_method(pool, "lp_total_supply", args![], vec![]);
    let pool_a2 = pool_balance(a, &mut pt);
    let pool_b2 = pool_balance(b, &mut pt);
    // Value per share must not fall on either side: reserve/supply after >= before
    // (cross-multiplied to stay in integers).
    assert!(pool_a2.checked_mul(total_before).unwrap() >= pool_a.checked_mul(total_after).unwrap());
    assert!(pool_b2.checked_mul(total_before).unwrap() >= pool_b.checked_mul(total_after).unwrap());
}

#[test]
fn e07d_legacy_add_liquidity_donates_an_imbalance_characterised() {
    // Characterises the hazard `add_liquidity_exact` exists to avoid. NOT a desired property:
    // if this ever starts failing because `add_liquidity` began refunding, update the docs.
    let mut pt = setup(30);
    add_liquidity(
        &mut pt,
        Amount::from(100_000_000u64),
        Amount::from(100_000_000u64),
    );
    let b = pt.b;
    let pool_b = pool_balance(b, &mut pt);
    add_liquidity(
        &mut pt,
        Amount::from(10_000_000u64),
        Amount::from(30_000_000u64),
    );
    assert_eq!(
        pool_balance(b, &mut pt) - pool_b,
        Amount::from(30_000_000u64),
        "the legacy method keeps all 30M of B while minting LP for 10M"
    );
}
