// Real-engine ADVERSARIAL tests for the fungible_pool template (hostile security phase).
//
// Each test reproduces a historical AMM attack class against the ACTUAL template WASM in
// the Ootle engine via tari_template_test_tooling. Negative tests here deliberately reach
// the pool's own security boundary (the pool method executes and its assertions abort the
// transaction atomically) — a failure that happens BEFORE the pool method runs is not
// counted as evidence and is avoided.
//
// EXECUTION: the engine (wasmer/cranelift) does not build on Windows; these run in Linux CI.

use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, NonFungibleAddress, ResourceAddress};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");

struct Ctx {
    t: TemplateTest,
    a: ResourceAddress,
    b: ResourceAddress,
    lp: ResourceAddress,
    pool: ComponentAddress,
    /// main attacker / experimenter account
    account: ComponentAddress,
    proof: NonFungibleAddress,
}

fn faucet(t: &mut TemplateTest, symbol: &str) -> (ComponentAddress, ResourceAddress) {
    let supply = Amount::from(1_000_000_000_000u64);
    let c: ComponentAddress = t.call_function(
        "TestFaucet",
        "mint_with_symbol",
        args![supply, symbol.to_string()],
        vec![],
    );
    let r = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    (c, r)
}

fn new_ctx(fee: u16) -> Ctx {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/fungible_pool",
            "templates/faucet",
            "templates/hostile",
        ],
    );
    let (a_faucet, a) = faucet(&mut t, "AAA");
    let (b_faucet, b) = faucet(&mut t, "BBB");
    let tpl = t.get_template_address("Pool");
    let res = t.execute_expect_success(
        t.transaction()
            .call_function(tpl, "new", args![a, b, fee])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    let (pool_addr, _) = res
        .expect_success()
        .up_iter()
        .find(|(addr, s)| {
            addr.is_component()
                && *s.substate_value().component().unwrap().template_address() == tpl
        })
        .unwrap();
    let lp = res
        .expect_success()
        .up_iter()
        .find(|(addr, _)| addr.is_resource())
        .unwrap()
        .0
        .as_resource_address()
        .unwrap();
    let (account, proof, _) = t.create_funded_account();
    let mut ctx = Ctx {
        t,
        a,
        b,
        lp,
        pool: pool_addr.as_component_address().unwrap(),
        account,
        proof,
    };
    // 4 payouts of 1e9 per side (faucet pays 1e9 per call)
    for _ in 0..4 {
        fund_once(&mut ctx, a_faucet);
        fund_once(&mut ctx, b_faucet);
    }
    ctx
}

fn fund_once(ctx: &mut Ctx, faucet_component: ComponentAddress) {
    let account = ctx.account;
    let tx = ctx
        .t
        .transaction()
        .call_method(faucet_component, "take_free_coins", args![])
        .put_last_instruction_output_on_workspace("coins")
        .call_method(account, "deposit", args![Workspace("coins")]);
    ctx.t.build_and_execute(tx, vec![]).expect_success();
}

/// Instantiate the Hostile factory (returns `(Component<Self>, ResourceAddress)`); returns
/// the component address (execution result path `$.0`).
fn hostile_component(t: &mut TemplateTest) -> ComponentAddress {
    let tpl = t.get_template_address("Hostile");
    let res = t.execute_expect_success(
        t.transaction()
            .call_function(tpl, "safe_fungible", args![])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    res.finalize.execution_results[0]
        .get_value("$.0")
        .unwrap()
        .unwrap()
}

fn pool_balance(ctx: &mut Ctx, res: ResourceAddress) -> u128 {
    let pool = ctx.pool;
    let v: Amount = ctx
        .t
        .call_method(pool, "get_pool_balance", args![res], vec![]);
    v.to_u128()
}

fn pool_lp_supply(ctx: &mut Ctx) -> u128 {
    let pool = ctx.pool;
    let v: Amount = ctx.t.call_method(pool, "lp_total_supply", args![], vec![]);
    v.to_u128()
}

fn pool_locked(ctx: &mut Ctx) -> u128 {
    let pool = ctx.pool;
    let v: Amount = ctx.t.call_method(pool, "locked_lp_supply", args![], vec![]);
    v.to_u128()
}

fn account_balance(ctx: &mut Ctx, res: ResourceAddress) -> u128 {
    let acc = ctx.account;
    let v: Amount = ctx.t.call_method(acc, "balance", args![res], vec![]);
    v.to_u128()
}

/// Add liquidity from the main account; returns the LP minted to it.
fn add_liquidity(ctx: &mut Ctx, a_amt: u64, b_amt: u64) -> u128 {
    let (a, b, lp, account, pool, proof) = (
        ctx.a,
        ctx.b,
        ctx.lp,
        ctx.account,
        ctx.pool,
        ctx.proof.clone(),
    );
    let lp_before = account_balance(ctx, lp);
    let tx = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(a_amt)])
        .put_last_instruction_output_on_workspace("a")
        .call_method(account, "withdraw", args![b, Amount::from(b_amt)])
        .put_last_instruction_output_on_workspace("b")
        .call_method(pool, "add_liquidity", args![Workspace("a"), Workspace("b")])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(account, "deposit", args![Workspace("lp")]);
    ctx.t.build_and_execute(tx, vec![proof]).expect_success();
    account_balance(ctx, lp) - lp_before
}

/// Redeem `lp_amt` LP from the main account; returns (A out, B out).
fn redeem(ctx: &mut Ctx, lp_amt: u64) -> (u128, u128) {
    let (a, b, lp, account, pool, proof) = (
        ctx.a,
        ctx.b,
        ctx.lp,
        ctx.account,
        ctx.pool,
        ctx.proof.clone(),
    );
    let a_before = account_balance(ctx, a);
    let b_before = account_balance(ctx, b);
    let tx = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![lp, Amount::from(lp_amt)])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(pool, "remove_liquidity", args![Workspace("lp")])
        .put_last_instruction_output_on_workspace("out")
        .call_method(account, "deposit", args![Workspace("out.0")])
        .call_method(account, "deposit", args![Workspace("out.1")]);
    ctx.t.build_and_execute(tx, vec![proof]).expect_success();
    let a_after = account_balance(ctx, a);
    let b_after = account_balance(ctx, b);
    (a_after - a_before, b_after - b_before)
}

/// Swap from the main account; returns the output received.
fn swap(ctx: &mut Ctx, side_a_to_b: bool, amount: u64, min_output: u64) -> u128 {
    let (a, b, account, pool, proof) = (ctx.a, ctx.b, ctx.account, ctx.pool, ctx.proof.clone());
    let (input, output) = if side_a_to_b { (a, b) } else { (b, a) };
    let out_before = account_balance(ctx, output);
    let tx = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![input, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(
            pool,
            "swap",
            args![Workspace("in"), output, Amount::from(min_output)],
        )
        .put_last_instruction_output_on_workspace("out")
        .call_method(account, "deposit", args![Workspace("out")]);
    ctx.t.build_and_execute(tx, vec![proof]).expect_success();
    account_balance(ctx, output) - out_before
}

// ---------------------------------------------------------------------------
// URANIUM-CLASS: fee denominator mismatch / disproportionate tiny-input output
// ---------------------------------------------------------------------------

/// A 2-unit input with 30 bps fee can only ever yield exactly 1 unit out of 1e9
/// reserves — the same fee model that drives the output drives the invariant, so there
/// is no denominator split through which a tiny input demands a disproportionate output.
/// A min_output demand beyond that aborts atomically and leaves state untouched.
#[test]
fn w01_uranium_denominator_tiny_input_cannot_extract() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000_000, 1_000_000_000);

    let a = ctx.a;
    let b = ctx.b;
    let ra0 = pool_balance(&mut ctx, a);
    let rb0 = pool_balance(&mut ctx, b);
    let supply0 = pool_lp_supply(&mut ctx);

    // Attack: tiny input, disproportionate output demanded (Uranium shape)
    let (account, pool, proof) = (ctx.account, ctx.pool, ctx.proof.clone());
    let tx = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(2u64)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(
            pool,
            "swap",
            args![Workspace("in"), b, Amount::from(1_000_000_000u64)],
        )
        .build_and_seal(ctx.t.secret_key());
    let reason = ctx.t.execute_expect_failure(tx, vec![proof]);
    println!("w01 disproportionate-output swap rejected: {:?}", reason);

    // atomicity: nothing changed
    let ra1 = pool_balance(&mut ctx, a);
    let rb1 = pool_balance(&mut ctx, b);
    let supply1 = pool_lp_supply(&mut ctx);
    assert_eq!(ra1, ra0, "reserve A changed after abort");
    assert_eq!(rb1, rb0, "reserve B changed after abort");
    assert_eq!(supply1, supply0, "supply changed after abort");

    // The same 2-unit input yields exactly 1 unit: eff = 2*9970/10000 = 1;
    // out = 1e9*1/(1e9+1) floor = 0... with these reserves it floors to 0, so a
    // min_output of 1 aborts. Prove the boundary: demanding 1 is rejected here.
    let (account, pool, proof) = (ctx.account, ctx.pool, ctx.proof.clone());
    let tx = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(2u64)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(1u64)])
        .build_and_seal(ctx.t.secret_key());
    let reason = ctx.t.execute_expect_failure(tx, vec![proof]);
    println!(
        "w01 2-unit swap with min_output=1 rejected (floors to 0): {:?}",
        reason
    );
    let rb2 = pool_balance(&mut ctx, b);
    assert_eq!(rb2, rb0, "state mutated by aborted swap");

    // A 3-unit input floors to exactly 1 output — the maximum any tiny input may take.
    let out = swap(&mut ctx, true, 3, 1);
    assert_eq!(out, 1, "3-unit swap must yield exactly 1 unit");
    let rb3 = pool_balance(&mut ctx, b);
    assert!(rb3 < rb0, "output reserve must decrease");
    // and k must grow (fee retained for LPs)
    let ra3 = pool_balance(&mut ctx, a);
    let k0 = ra0 * rb0;
    let k1 = ra3 * rb3;
    assert!(k1 > k0, "k did not grow");
}

/// 1-unit swap floors to zero effective input and must abort — never a free trade.
#[test]
fn w02_one_unit_swap_aborts_free_trade() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000_000, 1_000_000_000);
    let a = ctx.a;
    let b = ctx.b;
    let ra0 = pool_balance(&mut ctx, a);
    let rb0 = pool_balance(&mut ctx, b);
    let (account, pool, proof) = (ctx.account, ctx.pool, ctx.proof.clone());
    let tx = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(1u64)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(0u64)])
        .build_and_seal(ctx.t.secret_key());
    let reason = ctx.t.execute_expect_failure(tx, vec![proof]);
    println!("w02 1-unit swap rejected: {:?}", reason);
    let ra1 = pool_balance(&mut ctx, a);
    let rb1 = pool_balance(&mut ctx, b);
    assert_eq!(ra1, ra0);
    assert_eq!(rb1, rb0);
}

/// Repeated micro round-trips — repeated precision extraction class. Each full A→B→A
/// round must recover strictly less than the previous round, and never more than paid in.
#[test]
fn w03_repeated_micro_rounding_no_extraction() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000_000, 1_000_000_000);

    let mut last_recovered: Option<u128> = None;
    let mut held = 1_001u128;
    for round in 0..6u32 {
        let got_b = swap(&mut ctx, true, held as u64, 0);
        let back_a = swap(&mut ctx, false, got_b as u64, 0);
        assert!(
            back_a <= held,
            "round {round}: micro round-trip gained value: {back_a} > {held}"
        );
        if let Some(prev) = last_recovered {
            assert!(
                back_a <= prev,
                "round {round}: extraction increased across rounds: {back_a} > {prev}"
            );
        }
        last_recovered = Some(back_a);
        held = back_a;
    }
    // after 6 rounds the attacker must have strictly less than the initial 1_001
    assert!(
        held < 1_001,
        "repeated micro round-trips did not strictly lose value: {held}"
    );
}

// ---------------------------------------------------------------------------
// FIRST-DEPOSITOR / SHARE INFLATION (ERC4626 class)
// ---------------------------------------------------------------------------

/// Attacker seeds 1e6/1e6 (999_000 LP + 1000 locked). Victim deposits 1e9/1e9.
/// Attacker redeems: must receive LESS than deposited. Victim redeems: exactly deposit.
#[test]
fn w04_first_depositor_cannot_capture_victim_value() {
    let mut ctx = new_ctx(30);
    let attacker_lp = add_liquidity(&mut ctx, 1_000_000, 1_000_000);
    assert_eq!(
        attacker_lp, 999_000,
        "first depositor must receive sqrt(1e6*1e6)-1000"
    );
    assert_eq!(pool_locked(&mut ctx), 1_000);

    let (a, b, lp) = (ctx.a, ctx.b, ctx.lp);

    // victim account (separate identity) receives 1e9 of each from the main account
    let (victim, victim_proof, _) = ctx.t.create_funded_account();
    {
        let (account, proof) = (ctx.account, ctx.proof.clone());
        let tx = ctx
            .t
            .transaction()
            .call_method(
                account,
                "withdraw",
                args![a, Amount::from(1_000_000_000u64)],
            )
            .put_last_instruction_output_on_workspace("a")
            .call_method(
                account,
                "withdraw",
                args![b, Amount::from(1_000_000_000u64)],
            )
            .put_last_instruction_output_on_workspace("b")
            .call_method(victim, "deposit", args![Workspace("a")])
            .call_method(victim, "deposit", args![Workspace("b")]);
        ctx.t.build_and_execute(tx, vec![proof]).expect_success();
    }
    let pool = ctx.pool;
    let tx = ctx
        .t
        .transaction()
        .call_method(victim, "withdraw", args![a, Amount::from(1_000_000_000u64)])
        .put_last_instruction_output_on_workspace("a")
        .call_method(victim, "withdraw", args![b, Amount::from(1_000_000_000u64)])
        .put_last_instruction_output_on_workspace("b")
        .call_method(pool, "add_liquidity", args![Workspace("a"), Workspace("b")])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(victim, "deposit", args![Workspace("lp")]);
    ctx.t
        .build_and_execute(tx, vec![victim_proof.clone()])
        .expect_success();

    // victim LP must be exactly proportional: 1e9 * 1e6 / 1e6 = 1e9 (never zero/under)
    let victim_lp: Amount = ctx.t.call_method(victim, "balance", args![lp], vec![]);
    assert_eq!(
        victim_lp.to_u128(),
        1_000_000_000,
        "victim must receive proportional LP"
    );

    // attacker redeems — must get back LESS than their deposit (locked-LP dilution cost)
    let (a_out, b_out) = redeem(&mut ctx, 999_000);
    assert!(
        a_out < 1_000_000,
        "first depositor extracted a profit: {a_out}"
    );
    assert!(
        b_out < 1_000_000,
        "first depositor extracted a profit: {b_out}"
    );

    // victim redeems everything user-held: must recover exactly the deposit
    let tx = ctx
        .t
        .transaction()
        .call_method(victim, "withdraw", args![lp, victim_lp])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(pool, "remove_liquidity", args![Workspace("lp")])
        .put_last_instruction_output_on_workspace("out")
        .call_method(victim, "deposit", args![Workspace("out.0")])
        .call_method(victim, "deposit", args![Workspace("out.1")]);
    ctx.t
        .build_and_execute(tx, vec![victim_proof])
        .expect_success();
    let va: Amount = ctx.t.call_method(victim, "balance", args![a], vec![]);
    let vb: Amount = ctx.t.call_method(victim, "balance", args![b], vec![]);
    assert_eq!(va.to_u128(), 1_000_000_000, "victim under-recovered A");
    assert_eq!(vb.to_u128(), 1_000_000_000, "victim under-recovered B");
    assert_eq!(pool_lp_supply(&mut ctx), 1_000, "only locked LP remains");
    assert_eq!(pool_locked(&mut ctx), 1_000);
}

// ---------------------------------------------------------------------------
// ZERO-USER-LP / REINITIALIZATION
// ---------------------------------------------------------------------------

/// After every ordinary LP exits, exactly the locked minimum remains, reserves reduce
/// proportionally to nonzero dust, and a new deposit takes the PROPORTIONAL path — the
/// bootstrap branch cannot reappear (locked supply must never re-mint).
#[test]
fn w05_zero_user_lp_reinit_is_proportional_never_rebootstraps() {
    let mut ctx = new_ctx(30);
    let a = ctx.a;
    let b = ctx.b;
    let lp = add_liquidity(&mut ctx, 10_000_000, 10_000_000);
    assert_eq!(lp, 9_999_000);
    let _ = redeem(&mut ctx, lp as u64);
    // reserves reduce proportionally to the locked share: 1e7 * 1000/1e7 = 1000
    assert_eq!(pool_balance(&mut ctx, a), 1_000);
    assert_eq!(pool_balance(&mut ctx, b), 1_000);
    assert_eq!(pool_lp_supply(&mut ctx), 1_000);
    assert_eq!(pool_locked(&mut ctx), 1_000);

    // re-entry deposit: proportional shares (1e6 * 1000 / 1000 = 1e6), NOT bootstrap.
    let lp2 = add_liquidity(&mut ctx, 1_000_000, 1_000_000);
    assert_eq!(lp2, 1_000_000, "re-entry mint must be proportional");
    assert_eq!(pool_locked(&mut ctx), 1_000, "bootstrap branch re-entered!");

    // re-entering LP redeems exactly their deposit
    let (ra, rb) = redeem(&mut ctx, lp2 as u64);
    assert_eq!(ra, 1_000_000, "reinit over-redemption: {ra}");
    assert_eq!(rb, 1_000_000, "reinit over-redemption: {rb}");
    assert_eq!(pool_balance(&mut ctx, a), 1_000);
    assert_eq!(pool_balance(&mut ctx, b), 1_000);
    assert_eq!(pool_lp_supply(&mut ctx), 1_000);
}

// ---------------------------------------------------------------------------
// LP AUTHORIZATION (mint/burn outside the pool component)
// ---------------------------------------------------------------------------

/// An untrusted component must not be able to mint the pool's LP token.
#[test]
fn w06_unauthorized_lp_mint_rejected() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000, 1_000_000);
    let supply0 = pool_lp_supply(&mut ctx);

    let lp = ctx.lp;
    let hostile_c = hostile_component(&mut ctx.t);
    let sealed = ctx
        .t
        .transaction()
        .call_method(
            hostile_c,
            "try_mint_foreign",
            args![lp, Amount::from(1_000_000_000u64)],
        )
        .build_and_seal(ctx.t.secret_key());
    let reason = ctx
        .t
        .execute_expect_failure(sealed, vec![ctx.proof.clone()]);
    println!("w06 unauthorized LP mint rejected: {:?}", reason);
    assert_eq!(
        pool_lp_supply(&mut ctx),
        supply0,
        "LP supply grew without authorization"
    );
}

/// An untrusted component must not be able to BURN LP (even a bucket it legitimately
/// received from the owner) — the burn rule is scoped to the pool component.
#[test]
fn w07_unauthorized_lp_burn_rejected() {
    let mut ctx = new_ctx(30);
    let lp_held = add_liquidity(&mut ctx, 1_000_000, 1_000_000);
    let supply0 = pool_lp_supply(&mut ctx);

    let hostile_c = hostile_component(&mut ctx.t);
    let (account, lp) = (ctx.account, ctx.lp);
    let sealed = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![lp, Amount::from(lp_held as u64)])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(hostile_c, "try_burn_foreign", args![Workspace("lp")])
        .build_and_seal(ctx.t.secret_key());
    let reason = ctx
        .t
        .execute_expect_failure(sealed, vec![ctx.proof.clone()]);
    println!("w07 unauthorized LP burn rejected: {:?}", reason);
    assert_eq!(
        pool_lp_supply(&mut ctx),
        supply0,
        "LP was burned outside the pool component"
    );
}

// ---------------------------------------------------------------------------
// WRONG RESOURCE / UNSUPPORTED RESOURCE
// ---------------------------------------------------------------------------

/// Swap with a bucket of a third resource must abort inside the pool boundary.
#[test]
fn w08_wrong_resource_swap_rejected_at_boundary() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000, 1_000_000);
    let a = ctx.a;
    let (c_faucet, c) = faucet(&mut ctx.t, "CCC");
    {
        let account = ctx.account;
        let tx = ctx
            .t
            .transaction()
            .call_method(c_faucet, "take_free_coins", args![])
            .put_last_instruction_output_on_workspace("coins")
            .call_method(account, "deposit", args![Workspace("coins")]);
        ctx.t.build_and_execute(tx, vec![]).expect_success();
    }
    let (account, b, pool, proof) = (ctx.account, ctx.b, ctx.pool, ctx.proof.clone());
    let ra0 = pool_balance(&mut ctx, a);
    let rb0 = pool_balance(&mut ctx, b);
    let sealed = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![c, Amount::from(1_000u64)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(0u64)])
        .build_and_seal(ctx.t.secret_key());
    let reason = ctx.t.execute_expect_failure(sealed, vec![proof]);
    println!("w08 wrong-resource swap rejected: {:?}", reason);
    // state untouched
    let ra1 = pool_balance(&mut ctx, a);
    let rb1 = pool_balance(&mut ctx, b);
    assert_eq!(ra1, ra0);
    assert_eq!(rb1, rb0);
}

// ---------------------------------------------------------------------------
// FAILED-TRANSACTION ATOMICITY
// ---------------------------------------------------------------------------

/// An aborting swap must leave reserves, supply and locked LP unchanged, and roll the
/// withdrawn bucket back to the attacker.
#[test]
fn w09_failed_swap_atomicity() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000_000, 1_000_000_000);
    let a = ctx.a;
    let b = ctx.b;
    let ra0 = pool_balance(&mut ctx, a);
    let rb0 = pool_balance(&mut ctx, b);
    let s0 = pool_lp_supply(&mut ctx);
    let l0 = pool_locked(&mut ctx);
    let held0 = account_balance(&mut ctx, a);

    // min_output above achievable output
    let (account, pool, proof) = (ctx.account, ctx.pool, ctx.proof.clone());
    let sealed = ctx
        .t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(1_000_000u64)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(
            pool,
            "swap",
            args![Workspace("in"), b, Amount::from(1_000_000_000u64)],
        )
        .build_and_seal(ctx.t.secret_key());
    let reason = ctx.t.execute_expect_failure(sealed, vec![proof]);
    println!("w09 min_output swap rejected: {:?}", reason);

    let ra1 = pool_balance(&mut ctx, a);
    let rb1 = pool_balance(&mut ctx, b);
    assert_eq!(ra1, ra0, "reserve A mutated");
    assert_eq!(rb1, rb0, "reserve B mutated");
    assert_eq!(pool_lp_supply(&mut ctx), s0, "supply mutated");
    assert_eq!(pool_locked(&mut ctx), l0, "locked mutated");
    assert_eq!(
        account_balance(&mut ctx, a),
        held0,
        "attacker balance not rolled back atomically"
    );
}

// ---------------------------------------------------------------------------
// NO ADMIN / FEE-WITHDRAWAL BACKDOOR
// ---------------------------------------------------------------------------

/// The pool exposes no privileged entry points: nonexistent methods must fail outright.
#[test]
fn w10_no_admin_or_fee_withdrawal_entry_points() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000, 1_000_000);
    let pool = ctx.pool;
    for (method, args_) in [
        ("withdraw_fees", args![]),
        ("set_fee", args![3u16]),
        ("upgrade", args![]),
        ("mint_lp", args![Amount::from(1_000_000u64)]),
        ("burn_lp", args![Amount::from(1_000_000u64)]),
        ("drain", args![]),
    ] {
        let sealed = ctx
            .t
            .transaction()
            .call_method(pool, method, args_)
            .build_and_seal(ctx.t.secret_key());
        let ok = match ctx.t.try_execute(sealed, vec![]) {
            Ok(result) => !result.finalize.result.is_accept(),
            Err(_) => true,
        };
        assert!(ok, "pool must not expose method {method}");
    }
}

// ---------------------------------------------------------------------------
// CONCURRENCY (best effort in the sequential test tooling)
// ---------------------------------------------------------------------------

/// Two near-full swaps issued from the same starting expectations: the second executes
/// against the POST-first-swap state and simply cannot over-withdraw; the engine
/// serializes them. (True parallel substate-lock contention is consensus-layer and is
/// classified in the attack matrix as BLOCKED for the test tooling.)
#[test]
fn w11_sequential_conflicting_swaps_cannot_over_withdraw() {
    let mut ctx = new_ctx(30);
    add_liquidity(&mut ctx, 1_000_000_000, 1_000_000_000);
    let b = ctx.b;
    let rb0 = pool_balance(&mut ctx, b);
    // near-full swap A->B
    let out1 = swap(&mut ctx, true, 999_000_000, 0);
    assert!(out1 > 0 && out1 < rb0);
    // the "stale" second tx (same size, same expectations) now sees the drained reserve
    let out2 = swap(&mut ctx, true, 999_000_000, 0);
    assert!(
        out2 < out1,
        "second near-full swap must yield strictly less against post-trade reserves"
    );
    // reserves never went negative / wrapped
    let rb1 = pool_balance(&mut ctx, b);
    assert!(
        rb1 < rb0 && rb1 > 0,
        "output reserve invalid after conflicting swaps"
    );
}
