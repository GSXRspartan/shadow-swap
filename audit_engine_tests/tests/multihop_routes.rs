// Multi-hop AMM routing and permissionless pool creation, executed in the REAL v0.48.0 engine.
//
// What this file establishes, with the existing (unchanged) Pool template:
//   m01  A -> B -> C settles in ONE transaction: every hop's bucket is passed through the
//        workspace and only the final output is deposited.
//   m02  A -> B -> C -> D (three hops) likewise.
//   m03  ATOMICITY: when the FINAL hop's min_output is not met, the whole transaction is
//        rejected and NO hop commits (reserves of the first pool and the trader's balances
//        are unchanged). A multi-hop route is never "partially executed".
//   m04  ATOMICITY: a failure in a MIDDLE hop (wrong resource for that pool) also reverts all.
//   m05  The engine rejects a swap whose output bucket is left on the workspace (dangling
//        resources). This is why every browser intent must deposit every returned bucket.
//   m06  Create AND fund a new ownerless pool in ONE transaction: `Pool::new` returns the
//        component, which is put on the workspace and called by workspace reference.
//   m07  The integer quote composed off-chain equals what the engine pays, hop by hop.
//   m08  A direct pool and a two-hop route are compared by executable output, not hop count.
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, NonFungibleAddress, ResourceAddress};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const FEE_BPS: u16 = 30;

struct World {
    t: TemplateTest,
    account: ComponentAddress,
    proof: NonFungibleAddress,
    res: Vec<ResourceAddress>,
}

fn world(n: usize) -> World {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        ["../templates/fungible_pool", "templates/faucet"],
    );
    let mut faucets = Vec::new();
    let mut res = Vec::new();
    for i in 0..n {
        let f: ComponentAddress = t.call_function(
            "TestFaucet",
            "mint_with_symbol",
            args![Amount::from(1_000_000_000_000u64), format!("T{i}")],
            vec![],
        );
        let r = t
            .get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
        faucets.push(f);
        res.push(r);
    }
    let (account, proof, _) = t.create_funded_account();
    for f in faucets {
        for _ in 0..3 {
            let tx = t
                .transaction()
                .call_method(f, "take_free_coins", args![])
                .put_last_instruction_output_on_workspace("c")
                .call_method(account, "deposit", args![Workspace("c")]);
            t.build_and_execute(tx, vec![]).expect_success();
        }
    }
    World {
        t,
        account,
        proof,
        res,
    }
}

/// Creates and funds a pool in ONE transaction (the m06 pattern), returning its address.
fn create_funded_pool(
    w: &mut World,
    a: ResourceAddress,
    b: ResourceAddress,
    amt_a: u64,
    amt_b: u64,
) -> ComponentAddress {
    let pool_template = w.t.get_template_address("Pool");
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_function(pool_template, "new", args![a, b, FEE_BPS])
            .put_last_instruction_output_on_workspace("pool")
            .call_method(account, "withdraw", args![a, Amount::from(amt_a)])
            .put_last_instruction_output_on_workspace("a")
            .call_method(account, "withdraw", args![b, Amount::from(amt_b)])
            .put_last_instruction_output_on_workspace("b")
            .call_method(
                "pool",
                "add_liquidity",
                args![Workspace("a"), Workspace("b")],
            )
            .put_last_instruction_output_on_workspace("lp")
            .call_method(account, "deposit", args![Workspace("lp")])
            .build_and_seal(w.t.secret_key());
    let proof = w.proof.clone();
    let result = w.t.execute_expect_success(tx, vec![proof]);
    let created = result
        .expect_success()
        .up_iter()
        .find(|(id, s)| {
            id.is_component()
                && *s.substate_value().component().unwrap().template_address() == pool_template
        })
        .map(|(id, _)| id.as_component_address().unwrap())
        .expect("the transaction created the pool");
    created
}

fn balance(w: &mut World, r: ResourceAddress) -> Amount {
    let account = w.account;
    w.t.call_method(account, "balance", args![r], vec![])
}

fn reserve(w: &mut World, pool: ComponentAddress, r: ResourceAddress) -> Amount {
    w.t.call_method(pool, "get_pool_balance", args![r], vec![])
}

/// The protocol-client integer formula (`quoteSwapOutput`), mirrored exactly.
fn quote(reserve_in: u128, reserve_out: u128, amount_in: u128, fee_bps: u128) -> u128 {
    let eff = amount_in * (10_000 - fee_bps) / 10_000;
    reserve_out * eff / (reserve_in + eff)
}

fn u(a: Amount) -> u128 {
    a.to_u128()
}

/// Builds `withdraw -> swap (hop 1) -> ... -> swap (hop n) -> deposit`, every intermediate
/// bucket carried on the workspace. `mins[i]` is hop i's on-chain min_output.
fn route_tx(
    w: &mut World,
    pools: &[ComponentAddress],
    path: &[ResourceAddress],
    amount_in: u64,
    mins: &[u64],
) -> tari_ootle_transaction::Transaction {
    let account = w.account;
    let mut b =
        w.t.transaction()
            .call_method(account, "withdraw", args![path[0], Amount::from(amount_in)])
            .put_last_instruction_output_on_workspace("h0");
    for (i, pool) in pools.iter().enumerate() {
        let input = format!("h{i}");
        let output = format!("h{}", i + 1);
        b = b
            .call_method(
                *pool,
                "swap",
                args![
                    Workspace(input.as_str()),
                    path[i + 1],
                    Amount::from(mins[i])
                ],
            )
            .put_last_instruction_output_on_workspace(output);
    }
    let last = format!("h{}", pools.len());
    b.call_method(account, "deposit", args![Workspace(last.as_str())])
        .build_and_seal(w.t.secret_key())
}

#[test]
fn m01_two_hop_route_settles_atomically_in_one_transaction() {
    let mut w = world(3);
    let (a, b, c) = (w.res[0], w.res[1], w.res[2]);
    let p_ab = create_funded_pool(&mut w, a, b, 200_000_000, 300_000_000);
    let p_bc = create_funded_pool(&mut w, b, c, 250_000_000, 150_000_000);

    let r = (
        u(reserve(&mut w, p_ab, a)),
        u(reserve(&mut w, p_ab, b)),
        u(reserve(&mut w, p_bc, b)),
        u(reserve(&mut w, p_bc, c)),
    );
    let hop1 = quote(r.0, r.1, 1_000_000, 30);
    let hop2 = quote(r.2, r.3, hop1, 30);
    let (a0, b0, c0) = (balance(&mut w, a), balance(&mut w, b), balance(&mut w, c));

    let tx = route_tx(
        &mut w,
        &[p_ab, p_bc],
        &[a, b, c],
        1_000_000,
        &[1, hop2 as u64],
    );
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);

    assert_eq!(u(a0) - u(balance(&mut w, a)), 1_000_000);
    assert_eq!(
        u(balance(&mut w, b)),
        u(b0),
        "the intermediate asset never touches the account"
    );
    assert_eq!(u(balance(&mut w, c)) - u(c0), hop2);
    assert_eq!(u(reserve(&mut w, p_ab, a)), r.0 + 1_000_000);
    assert_eq!(u(reserve(&mut w, p_bc, c)), r.3 - hop2);
}

#[test]
fn m02_three_hop_route_settles_atomically() {
    let mut w = world(4);
    let (a, b, c, d) = (w.res[0], w.res[1], w.res[2], w.res[3]);
    let p1 = create_funded_pool(&mut w, a, b, 200_000_000, 200_000_000);
    let p2 = create_funded_pool(&mut w, b, c, 200_000_000, 400_000_000);
    let p3 = create_funded_pool(&mut w, c, d, 300_000_000, 100_000_000);
    let h1 = quote(200_000_000, 200_000_000, 5_000_000, 30);
    let h2 = quote(200_000_000, 400_000_000, h1, 30);
    let h3 = quote(300_000_000, 100_000_000, h2, 30);
    let d0 = balance(&mut w, d);
    let tx = route_tx(
        &mut w,
        &[p1, p2, p3],
        &[a, b, c, d],
        5_000_000,
        &[1, 1, h3 as u64],
    );
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(u(balance(&mut w, d)) - u(d0), h3);
}

#[test]
fn m03_final_min_output_breach_reverts_every_hop() {
    let mut w = world(3);
    let (a, b, c) = (w.res[0], w.res[1], w.res[2]);
    let p_ab = create_funded_pool(&mut w, a, b, 200_000_000, 300_000_000);
    let p_bc = create_funded_pool(&mut w, b, c, 250_000_000, 150_000_000);
    let before = (
        u(reserve(&mut w, p_ab, a)),
        u(reserve(&mut w, p_ab, b)),
        u(balance(&mut w, a)),
    );
    let hop1 = quote(200_000_000, 300_000_000, 1_000_000, 30);
    let hop2 = quote(250_000_000, 150_000_000, hop1, 30);
    // Demand one unit more than the route can pay. Hop 1 would succeed on its own.
    let tx = route_tx(
        &mut w,
        &[p_ab, p_bc],
        &[a, b, c],
        1_000_000,
        &[1, hop2 as u64 + 1],
    );
    let proof = w.proof.clone();
    let reason = w.t.execute_expect_failure(tx, vec![proof]);
    println!("m03 rejected as expected: {reason:?}");
    let after = (
        u(reserve(&mut w, p_ab, a)),
        u(reserve(&mut w, p_ab, b)),
        u(balance(&mut w, a)),
    );
    assert_eq!(before, after, "no hop's economic effect committed");
}

#[test]
fn m04_middle_hop_failure_reverts_the_first_hop() {
    let mut w = world(4);
    let (a, b, c, d) = (w.res[0], w.res[1], w.res[2], w.res[3]);
    let p_ab = create_funded_pool(&mut w, a, b, 200_000_000, 300_000_000);
    let p_cd = create_funded_pool(&mut w, c, d, 200_000_000, 200_000_000);
    let before = (u(reserve(&mut w, p_ab, a)), u(balance(&mut w, a)));
    // Hop 2 hands pool C/D a bucket of B: not in that pool, so it must abort.
    let tx = route_tx(&mut w, &[p_ab, p_cd], &[a, b, d], 1_000_000, &[1, 1]);
    let proof = w.proof.clone();
    w.t.execute_expect_failure(tx, vec![proof]);
    assert_eq!(before, (u(reserve(&mut w, p_ab, a)), u(balance(&mut w, a))));
}

#[test]
fn m05_an_undeposited_swap_output_is_rejected_by_the_engine() {
    let mut w = world(2);
    let (a, b) = (w.res[0], w.res[1]);
    let pool = create_funded_pool(&mut w, a, b, 200_000_000, 200_000_000);
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_method(account, "withdraw", args![a, Amount::from(1_000_000u64)])
            .put_last_instruction_output_on_workspace("in")
            .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(1u64)])
            .build_and_seal(w.t.secret_key());
    let proof = w.proof.clone();
    let reason = w.t.execute_expect_failure(tx, vec![proof]);
    println!("m05 rejected as expected: {reason:?}");
}

#[test]
fn m06_create_and_fund_an_ownerless_pool_in_one_transaction() {
    let mut w = world(2);
    let (a, b) = (w.res[0], w.res[1]);
    let pool = create_funded_pool(&mut w, a, b, 4_000_000, 9_000_000);
    // floor(sqrt(4e6 * 9e6)) = 6_000_000 shares minted; 1_000 locked forever.
    let total: Amount = w.t.call_method(pool, "lp_total_supply", args![], vec![]);
    let locked: Amount = w.t.call_method(pool, "locked_lp_supply", args![], vec![]);
    assert_eq!(u(total), 6_000_000);
    assert_eq!(u(locked), 1_000);
    let lp: ResourceAddress = w.t.call_method(pool, "lp_resource", args![], vec![]);
    assert_eq!(u(balance(&mut w, lp)), 6_000_000 - 1_000);
    assert_eq!(u(reserve(&mut w, pool, a)), 4_000_000);
    assert_eq!(u(reserve(&mut w, pool, b)), 9_000_000);
}

#[test]
fn m07_off_chain_integer_quote_matches_engine_payout_on_every_hop() {
    let mut w = world(3);
    let (a, b, c) = (w.res[0], w.res[1], w.res[2]);
    let p_ab = create_funded_pool(&mut w, a, b, 123_456_789, 987_654_321);
    let p_bc = create_funded_pool(&mut w, b, c, 555_555_555, 333_333_333);
    for amount in [1_003u64, 77_777, 2_500_000] {
        let r = (
            u(reserve(&mut w, p_ab, a)),
            u(reserve(&mut w, p_ab, b)),
            u(reserve(&mut w, p_bc, b)),
            u(reserve(&mut w, p_bc, c)),
        );
        let hop2 = quote(r.2, r.3, quote(r.0, r.1, amount as u128, 30), 30);
        let c0 = u(balance(&mut w, c));
        let tx = route_tx(&mut w, &[p_ab, p_bc], &[a, b, c], amount, &[1, hop2 as u64]);
        let proof = w.proof.clone();
        w.t.execute_expect_success(tx, vec![proof]);
        assert_eq!(
            u(balance(&mut w, c)) - c0,
            hop2,
            "exact parity at amount {amount}"
        );
    }
}

#[test]
fn m08_route_choice_is_by_executable_output_not_hop_count() {
    let mut w = world(3);
    let (a, b, c) = (w.res[0], w.res[1], w.res[2]);
    // A thin direct pool and a deep two-hop path.
    let p_ac = create_funded_pool(&mut w, a, c, 2_000_000, 2_000_000);
    let p_ab = create_funded_pool(&mut w, a, b, 500_000_000, 500_000_000);
    let p_bc = create_funded_pool(&mut w, b, c, 500_000_000, 500_000_000);
    let direct = quote(2_000_000, 2_000_000, 1_000_000, 30);
    let two_hop = quote(
        500_000_000,
        500_000_000,
        quote(500_000_000, 500_000_000, 1_000_000, 30),
        30,
    );
    assert!(
        two_hop > direct,
        "the deep route pays more despite two fees"
    );
    let c0 = u(balance(&mut w, c));
    let tx = route_tx(
        &mut w,
        &[p_ab, p_bc],
        &[a, b, c],
        1_000_000,
        &[1, two_hop as u64],
    );
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(u(balance(&mut w, c)) - c0, two_hop);
    let _ = p_ac;
}
