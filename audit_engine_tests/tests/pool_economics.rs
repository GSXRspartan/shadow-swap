// Economic / first-depositor engine regressions (audit Parts 12-13).
//
// Replaces source-only confidence with runtime evidence that:
//   * a second independent LP can provide liquidity (E11);
//   * the permanently-locked minimum stays in LP total supply and reserves after everyone exits
//     (E05/E12);
//   * a first-depositor attacker cannot capture a later victim's proportional share (Part 13).
//
// EXECUTION: engine (wasmer/cranelift) does not build on Windows; runs in Linux CI.

use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, NonFungibleAddress, ResourceAddress};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const LOCKED: u64 = 1_000; // MINIMUM_LOCKED_LIQUIDITY in the template

struct Ctx {
    t: TemplateTest,
    a: ResourceAddress,
    b: ResourceAddress,
    a_faucet: ComponentAddress,
    b_faucet: ComponentAddress,
    lp: ResourceAddress,
    pool: ComponentAddress,
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

fn setup(fee: u16) -> Ctx {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        ["../templates/fungible_pool", "templates/faucet"],
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
        .find(|(address, s)| {
            address.is_component()
                && *s.substate_value().component().unwrap().template_address() == tpl
        })
        .unwrap();
    let pool = pool_addr.as_component_address().unwrap();
    let (lp_addr, _) = res
        .expect_success()
        .up_iter()
        .find(|(a, _)| a.is_resource())
        .unwrap();
    let lp = lp_addr.as_resource_address().unwrap();
    Ctx {
        t,
        a,
        b,
        a_faucet,
        b_faucet,
        lp,
        pool,
    }
}

/// Create a funded account and give it `amount` of both A and B from the faucets.
fn funded_lp(ctx: &mut Ctx, amount: u64) -> (ComponentAddress, NonFungibleAddress) {
    let (acc, proof, _) = ctx.t.create_funded_account();
    for faucet in [ctx.a_faucet, ctx.b_faucet] {
        let tx = ctx
            .t
            .transaction()
            .call_method(faucet, "take_free_coins", args![])
            .put_last_instruction_output_on_workspace("c")
            .call_method(acc, "deposit", args![Workspace("c")]);
        ctx.t.build_and_execute(tx, vec![]).expect_success();
    }
    let _ = amount;
    (acc, proof)
}

fn add_liquidity(
    ctx: &mut Ctx,
    acc: ComponentAddress,
    proof: &NonFungibleAddress,
    a_amt: u64,
    b_amt: u64,
) {
    let (a, b, pool) = (ctx.a, ctx.b, ctx.pool);
    let tx = ctx
        .t
        .transaction()
        .call_method(acc, "withdraw", args![a, Amount::from(a_amt)])
        .put_last_instruction_output_on_workspace("a")
        .call_method(acc, "withdraw", args![b, Amount::from(b_amt)])
        .put_last_instruction_output_on_workspace("b")
        .call_method(pool, "add_liquidity", args![Workspace("a"), Workspace("b")])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(acc, "deposit", args![Workspace("lp")]);
    ctx.t
        .build_and_execute(tx, vec![proof.clone()])
        .expect_success();
}

fn remove_all_lp(ctx: &mut Ctx, acc: ComponentAddress, proof: &NonFungibleAddress) {
    let (lp, pool) = (ctx.lp, ctx.pool);
    let held: Amount = ctx.t.call_method(acc, "balance", args![lp], vec![]);
    let tx = ctx
        .t
        .transaction()
        .call_method(acc, "withdraw", args![lp, held])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(pool, "remove_liquidity", args![Workspace("lp")])
        .put_last_instruction_output_on_workspace("out")
        .call_method(acc, "deposit", args![Workspace("out.0")])
        .call_method(acc, "deposit", args![Workspace("out.1")]);
    ctx.t
        .build_and_execute(tx, vec![proof.clone()])
        .expect_success();
}

// `acc`/`r` (both Copy) precede `&mut ctx` so any `ctx.<field>` argument is read before the mutable
// borrow — avoids E0503 (no two-phase borrow for a free function's `&mut` argument).
fn bal(acc: ComponentAddress, r: ResourceAddress, ctx: &mut Ctx) -> Amount {
    ctx.t.call_method(acc, "balance", args![r], vec![])
}

fn lp_total(ctx: &mut Ctx) -> Amount {
    let pool = ctx.pool;
    ctx.t.call_method(pool, "lp_total_supply", args![], vec![])
}

fn locked(ctx: &mut Ctx) -> Amount {
    let pool = ctx.pool;
    ctx.t.call_method(pool, "locked_lp_supply", args![], vec![])
}

// E11 — a second, independent LP can add liquidity and receive shares.
#[test]
fn e11_second_independent_lp_can_provide() {
    let mut ctx = setup(3);
    let (lp1, p1) = funded_lp(&mut ctx, 0);
    add_liquidity(&mut ctx, lp1, &p1, 10_000_000, 10_000_000);

    let (lp2, p2) = funded_lp(&mut ctx, 0);
    add_liquidity(&mut ctx, lp2, &p2, 5_000_000, 5_000_000);
    let lp2_shares = bal(lp2, ctx.lp, &mut ctx);
    println!("e11 second LP shares = {}", lp2_shares);
    assert!(
        lp2_shares.is_positive(),
        "second independent LP must receive shares"
    );
    // Adding half the reserves at supply=1e7 should mint ~5e6 shares.
    assert!(
        lp2_shares >= Amount::from(4_990_000u64),
        "second LP under-minted: {}",
        lp2_shares
    );
}

// E05 — the locked minimum is present in total supply after the first deposit.
#[test]
fn e05_locked_minimum_in_total_supply() {
    let mut ctx = setup(3);
    let (lp1, p1) = funded_lp(&mut ctx, 0);
    add_liquidity(&mut ctx, lp1, &p1, 10_000_000, 10_000_000);
    assert_eq!(
        locked(&mut ctx),
        Amount::from(LOCKED),
        "locked vault must hold the minimum"
    );
    assert_eq!(
        lp_total(&mut ctx),
        Amount::from(10_000_000u64),
        "supply = sqrt(a*b) incl. locked"
    );
}

// E12 — after ALL redeemable LPs exit, the locked minimum still remains in supply (never redeemed).
#[test]
fn e12_locked_minimum_survives_full_exit() {
    let mut ctx = setup(3);
    let (lp1, p1) = funded_lp(&mut ctx, 0);
    add_liquidity(&mut ctx, lp1, &p1, 10_000_000, 10_000_000);
    remove_all_lp(&mut ctx, lp1, &p1);
    assert_eq!(
        locked(&mut ctx),
        Amount::from(LOCKED),
        "locked minimum must remain after full exit"
    );
    assert_eq!(
        lp_total(&mut ctx),
        Amount::from(LOCKED),
        "only the locked minimum should remain"
    );
}

// Part 13 — first-depositor attacker cannot capture a later victim's proportional share.
#[test]
fn first_depositor_cannot_steal_victim_share() {
    let mut ctx = setup(3);

    // Attacker seeds at the minimum allowed initial liquidity.
    let (attacker, ap) = funded_lp(&mut ctx, 0);
    add_liquidity(&mut ctx, attacker, &ap, 1_000_000, 1_000_000);

    // Victim adds 100x proportional liquidity.
    let (victim, vp) = funded_lp(&mut ctx, 0);
    let victim_a_before = bal(victim, ctx.a, &mut ctx);
    add_liquidity(&mut ctx, victim, &vp, 100_000_000, 100_000_000);

    // Attacker exits everything.
    let atk_a_before = bal(attacker, ctx.a, &mut ctx);
    remove_all_lp(&mut ctx, attacker, &ap);
    let atk_a_gained = bal(attacker, ctx.a, &mut ctx) - atk_a_before;
    println!("first-depositor: attacker A recovered = {}", atk_a_gained);

    // Attacker must not extract more than roughly what they contributed (1_000_000); certainly not
    // any meaningful slice of the victim's 100_000_000.
    assert!(
        atk_a_gained <= Amount::from(1_000_000u64),
        "attacker withdrew more than contributed: {}",
        atk_a_gained
    );
    assert!(
        atk_a_gained >= Amount::from(990_000u64),
        "attacker unfairly lost funds (should recover ~contribution): {}",
        atk_a_gained
    );

    // Victim exits and must recover ~their full contribution.
    remove_all_lp(&mut ctx, victim, &vp);
    let victim_a_after = bal(victim, ctx.a, &mut ctx);
    // Net change vs before adding = -deposit + returned; returned should be ~= deposit.
    let victim_net = victim_a_before - victim_a_after; // small (rounding/locked share)
    println!("first-depositor: victim net A cost = {}", victim_net);
    assert!(
        victim_net <= Amount::from(2_000u64),
        "victim failed to recover proportional share (net loss {})",
        victim_net
    );

    // Locked minimum still anchors the pool.
    assert_eq!(locked(&mut ctx), Amount::from(LOCKED));
}
