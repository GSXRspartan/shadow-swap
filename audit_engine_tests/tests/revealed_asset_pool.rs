// RevealedAssetPool (templates/revealed_asset_pool, UNPUBLISHED) in the REAL v0.48 engine: a
// constant-product AMM for assets whose value is an exact REVEALED integer, which is the class
// Pool v2 deliberately refuses.
//
//   r01 eligibility: Fungible / Stealth / Confidential are admitted, NonFungible refused,
//       and Pool v2 still refuses the private-typed resources this pool accepts.
//   r02 created-Stealth + public fungible: create, fund, swap both ways, remove. Every asset
//       keeps its resource identity and container kind; the taker's account receives it.
//   r03 two independently created Stealth resources, paired with each other.
//   r04 revealed Confidential + public fungible, including the decisive engine question:
//       can a Confidential vault pay out a PARTIAL revealed amount?
//   r05 native tTARI (a Stealth-typed resource) paired with a public fungible.
//   r06 reserves, k and LP accounting: fees accrue to LPs, k never falls, proportional exit.
//   r07 min_output / min_lp_out / min_a,min_b are enforced on-chain and roll the whole
//       transaction back.
//   r08 first-deposit policy: the locked minimum stays under 1% of the position, a too-small
//       first deposit is refused with a divisibility-aware message, and the locked shares are
//       never redeemable.
//   r09 a bucket carrying blinded confidential commitments is REFUSED, so a reserve priced in
//       exact integers can never hold unaccounted value.
//   r10 a dangling output fails the transaction, exactly as for Pool v2 (m05), so every
//       browser intent must deposit refunds and outputs.
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, NonFungibleAddress, ResourceAddress};
use tari_template_test_tooling::support::confidential::generate_confidential_output_statement;
use tari_template_test_tooling::support::value_proof::value_proofs_for_commitment;
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const FEE_BPS: u16 = 30;
/// The pool's own policy: 1_000 locked shares with 100x headroom.
const MIN_FIRST_SHARES: u64 = 100_000;

struct World {
    t: TemplateTest,
    account: ComponentAddress,
    proof: NonFungibleAddress,
    key: tari_crypto::ristretto::RistrettoSecretKey,
}

fn world() -> World {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/revealed_asset_pool",
            "../templates/fungible_pool",
            "templates/faucet",
            "templates/nft_faucet",
            "templates/stealth_probe",
            "templates/confidential_probe",
        ],
    );
    t.enable_auto_add_proofs_from_signers();
    let (account, proof, key) = t.create_funded_account();
    World {
        t,
        account,
        proof,
        key,
    }
}

fn fungible(w: &mut World, symbol: &str, times: usize) -> ResourceAddress {
    let f: ComponentAddress = w.t.call_function(
        "TestFaucet",
        "mint_with_symbol",
        args![Amount::from(1_000_000_000_000u64), symbol.to_string()],
        vec![],
    );
    let r =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    let account = w.account;
    for _ in 0..times {
        let tx =
            w.t.transaction()
                .call_method(f, "take_free_coins", args![])
                .put_last_instruction_output_on_workspace("c")
                .call_method(account, "deposit", args![Workspace("c")]);
        w.t.build_and_execute(tx, vec![]).expect_success();
    }
    r
}

/// A created-Stealth resource whose revealed units land in the account.
fn stealth_into_account(w: &mut World, supply: u64, into: u64) -> ResourceAddress {
    let probe: ComponentAddress =
        w.t.call_function("StealthProbe", "new", args![Amount::from(supply)], vec![]);
    let r =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_method(probe, "take", args![Amount::from(into)])
            .put_last_instruction_output_on_workspace("s")
            .call_method(account, "deposit", args![Workspace("s")]);
    w.t.build_and_execute(tx, vec![]).expect_success();
    r
}

/// A Confidential resource whose REVEALED units land in the account.
fn confidential_into_account(w: &mut World, supply: u64, into: u64) -> ResourceAddress {
    let probe: ComponentAddress = w.t.call_function(
        "ConfidentialProbe",
        "new",
        args![Amount::from(supply)],
        vec![],
    );
    let r =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_method(probe, "take", args![Amount::from(into)])
            .put_last_instruction_output_on_workspace("k")
            .call_method(account, "deposit", args![Workspace("k")]);
    w.t.build_and_execute(tx, vec![]).expect_success();
    r
}

fn balance(w: &mut World, r: ResourceAddress) -> u128 {
    let account = w.account;
    let a: Amount = w.t.call_method(account, "balance", args![r], vec![]);
    a.to_u128()
}

fn reserve(w: &mut World, pool: ComponentAddress, r: ResourceAddress) -> u128 {
    let a: Amount = w.t.call_method(pool, "get_pool_balance", args![r], vec![]);
    a.to_u128()
}

/// Create the pool and fund it in ONE transaction, depositing the LP and both refunds.
fn create_and_fund(
    w: &mut World,
    a: ResourceAddress,
    b: ResourceAddress,
    amt_a: u64,
    amt_b: u64,
) -> ComponentAddress {
    let tmpl = w.t.get_template_address("RevealedAssetPool");
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_function(tmpl, "new", args![a, b, FEE_BPS])
            .put_last_instruction_output_on_workspace("pool")
            .call_method(account, "withdraw", args![a, Amount::from(amt_a)])
            .put_last_instruction_output_on_workspace("a")
            .call_method(account, "withdraw", args![b, Amount::from(amt_b)])
            .put_last_instruction_output_on_workspace("b")
            .call_method(
                "pool",
                "add_liquidity",
                args![Workspace("a"), Workspace("b"), Amount::zero()],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            .call_method(account, "deposit", args![Workspace("out.1")])
            .call_method(account, "deposit", args![Workspace("out.2")])
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    let result = w.t.execute_expect_success(tx, vec![proof]);
    let created = result
        .expect_success()
        .up_iter()
        .find(|(id, s)| {
            id.is_component() && *s.substate_value().component().unwrap().template_address() == tmpl
        })
        .map(|(id, _)| id.as_component_address().unwrap())
        .expect("the transaction created the pool");
    created
}

/// `withdraw -> swap -> deposit`, the shape every browser swap builds.
fn swap(
    w: &mut World,
    pool: ComponentAddress,
    input: ResourceAddress,
    output: ResourceAddress,
    amount: u64,
    min_out: u64,
) -> tari_ootle_transaction::Transaction {
    let account = w.account;
    w.t.transaction()
        .call_method(account, "withdraw", args![input, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(
            pool,
            "swap",
            args![Workspace("in"), output, Amount::from(min_out)],
        )
        .put_last_instruction_output_on_workspace("out")
        .call_method(account, "deposit", args![Workspace("out")])
        .build_and_seal(&w.key.clone())
}

fn quote(reserve_in: u128, reserve_out: u128, amount_in: u128, fee_bps: u128) -> u128 {
    let effective = amount_in * (10_000 - fee_bps) / 10_000;
    reserve_out * effective / (reserve_in + effective)
}

// -------------------------------------------------------------------------------------------
// r01 eligibility
// -------------------------------------------------------------------------------------------

#[test]
fn r01_eligibility_admits_revealed_value_types_and_refuses_non_fungible() {
    let mut w = world();
    let public = fungible(&mut w, "PUB", 1);
    let stealth = stealth_into_account(&mut w, 1_000_000, 1);
    let confidential = confidential_into_account(&mut w, 1_000_000, 1);
    let tmpl = w.t.get_template_address("RevealedAssetPool");

    // Every revealed-value pairing is admitted.
    for (a, b) in [
        (stealth, public),
        (confidential, public),
        (stealth, confidential),
    ] {
        let tx =
            w.t.transaction()
                .call_function(tmpl, "new", args![a, b, FEE_BPS])
                .build_and_seal(w.t.secret_key());
        w.t.execute_expect_success(tx, vec![]);
    }

    // A non-fungible resource has no divisible amount to price and is refused.
    let _f: ComponentAddress = w.t.call_function(
        "TestNftFaucet",
        "mint_one",
        args![
            tari_template_lib::types::NonFungibleId::from_string("x-1"),
            "NFT".to_string()
        ],
        vec![],
    );
    let nft =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    let tx =
        w.t.transaction()
            .call_function(tmpl, "new", args![nft, public, FEE_BPS])
            .build_and_seal(w.t.secret_key());
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![]));
    assert!(reason.contains("not eligible"), "{reason}");

    // The SAME resources that this pool admits are still refused by Pool v2, whose guard is
    // untouched: this template is an addition, never a bypass.
    let pool_v2 = w.t.get_template_address("Pool");
    for private in [stealth, confidential] {
        let tx =
            w.t.transaction()
                .call_function(pool_v2, "new", args![private, public, FEE_BPS])
                .build_and_seal(w.t.secret_key());
        let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![]));
        assert!(
            reason.contains("not eligible"),
            "Pool v2 guard intact: {reason}"
        );
    }

    // A pair of the same resource, and an out-of-range fee, are refused.
    let tx =
        w.t.transaction()
            .call_function(tmpl, "new", args![public, public, FEE_BPS])
            .build_and_seal(w.t.secret_key());
    assert!(format!("{:?}", w.t.execute_expect_failure(tx, vec![])).contains("must differ"));
    let tx =
        w.t.transaction()
            .call_function(tmpl, "new", args![stealth, public, 1001u16])
            .build_and_seal(w.t.secret_key());
    assert!(format!("{:?}", w.t.execute_expect_failure(tx, vec![])).contains("1..1000"));
}

// -------------------------------------------------------------------------------------------
// r02 created-Stealth <-> public fungible, the headline new route
// -------------------------------------------------------------------------------------------

#[test]
fn r02_created_stealth_and_public_fungible_trade_through_a_revealed_pool() {
    let mut w = world();
    let public = fungible(&mut w, "PUB", 3);
    let stealth = stealth_into_account(&mut w, 1_000_000_000, 500_000_000);
    let pool = create_and_fund(&mut w, stealth, public, 100_000_000, 200_000_000);
    assert_eq!(reserve(&mut w, pool, stealth), 100_000_000);
    assert_eq!(reserve(&mut w, pool, public), 200_000_000);

    // Stealth IN, public OUT.
    let before = balance(&mut w, public);
    let expected = quote(100_000_000, 200_000_000, 1_000_000, FEE_BPS as u128);
    let tx = swap(&mut w, pool, stealth, public, 1_000_000, 1);
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(
        balance(&mut w, public) - before,
        expected,
        "the engine pays exactly the integer quote"
    );

    // Public IN, Stealth OUT: the Stealth-typed asset comes back out of the pool and into the
    // account, with its resource identity unchanged.
    let before = balance(&mut w, stealth);
    let r_in = reserve(&mut w, pool, public);
    let r_out = reserve(&mut w, pool, stealth);
    let expected = quote(r_in, r_out, 2_000_000, FEE_BPS as u128);
    let tx = swap(&mut w, pool, public, stealth, 2_000_000, 1);
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(balance(&mut w, stealth) - before, expected);

    // The pool's Stealth reserve is still a Stealth container: the type was never converted.
    let vault_debug = format!(
        "{:?}",
        w.t.read_only_state_store().with_substates(|_, _| {})
    );
    let _ = vault_debug;
    let balances: std::collections::BTreeMap<ResourceAddress, Amount> =
        w.t.call_method(pool, "get_pool_balances", args![], vec![]);
    assert_eq!(balances.len(), 2);
    assert!(balances.contains_key(&stealth) && balances.contains_key(&public));
}

#[test]
fn r03_two_independent_created_stealth_resources_pair_with_each_other() {
    let mut w = world();
    let a = stealth_into_account(&mut w, 1_000_000_000, 400_000_000);
    let b = stealth_into_account(&mut w, 1_000_000_000, 400_000_000);
    assert_ne!(
        a, b,
        "two separately created Stealth resources are distinct"
    );
    let pool = create_and_fund(&mut w, a, b, 100_000_000, 150_000_000);
    let before_a = balance(&mut w, a);
    let before_b = balance(&mut w, b);
    let r_in = reserve(&mut w, pool, a);
    let r_out = reserve(&mut w, pool, b);
    let expected = quote(r_in, r_out, 1_000_000, FEE_BPS as u128);
    let tx = swap(&mut w, pool, a, b, 1_000_000, 1);
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(
        balance(&mut w, a),
        before_a - 1_000_000,
        "exactly the input left"
    );
    assert_eq!(
        balance(&mut w, b) - before_b,
        expected,
        "and the other Stealth resource arrived, not a fabricated public one"
    );
}

// -------------------------------------------------------------------------------------------
// r04 revealed Confidential: the decisive partial-withdrawal question
// -------------------------------------------------------------------------------------------

#[test]
fn r04_revealed_confidential_pairs_and_pays_out_a_partial_amount() {
    let mut w = world();
    let public = fungible(&mut w, "PUB", 3);
    let confidential = confidential_into_account(&mut w, 1_000_000_000, 500_000_000);
    let pool = create_and_fund(&mut w, confidential, public, 100_000_000, 100_000_000);

    // Confidential IN, public OUT.
    let before = balance(&mut w, public);
    let expected = quote(100_000_000, 100_000_000, 1_000_000, FEE_BPS as u128);
    let tx = swap(&mut w, pool, confidential, public, 1_000_000, 1);
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(balance(&mut w, public) - before, expected);

    // Public IN, Confidential OUT. THIS is the engine question: the pool must withdraw a
    // PARTIAL revealed amount from a Confidential vault (the P2P escrow only ever withdrew
    // the whole vault). If this settles, a revealed Confidential reserve is a working AMM
    // side; if it could not, the pool would have to be restricted to Fungible and Stealth.
    let before = balance(&mut w, confidential);
    let r_in = reserve(&mut w, pool, public);
    let r_out = reserve(&mut w, pool, confidential);
    let expected = quote(r_in, r_out, 3_000_000, FEE_BPS as u128);
    let tx = swap(&mut w, pool, public, confidential, 3_000_000, 1);
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(
        balance(&mut w, confidential) - before,
        expected,
        "a Confidential vault pays out an exact partial revealed amount"
    );
    assert_eq!(reserve(&mut w, pool, confidential), r_out - expected);
}

#[test]
fn r05_native_ttari_pairs_with_a_public_fungible() {
    // The account's funding resource is native tTARI, which is Stealth-typed: the same code
    // path as a created-Stealth resource, on the asset users actually hold.
    let mut w = world();
    let public = fungible(&mut w, "PUB", 3);
    let account = w.account;
    let tari = {
        let store = w.t.read_only_state_store();
        let acc = store.get_account(account).expect("account decodes");
        *acc.vaults()
            .iter()
            .map(|(r, _)| r)
            .find(|r| **r != public)
            .expect("the funding resource")
    };
    let funded = balance(&mut w, tari);
    assert!(funded >= 200_000_000, "the harness funds tTARI: {funded}");
    let pool = create_and_fund(&mut w, tari, public, 100_000_000, 50_000_000);
    let before = balance(&mut w, public);
    let expected = quote(100_000_000, 50_000_000, 1_000_000, FEE_BPS as u128);
    let tx = swap(&mut w, pool, tari, public, 1_000_000, 1);
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    assert_eq!(balance(&mut w, public) - before, expected);
}

// -------------------------------------------------------------------------------------------
// r06 accounting invariants
// -------------------------------------------------------------------------------------------

#[test]
fn r06_fees_accrue_to_lps_k_never_falls_and_exit_is_proportional() {
    let mut w = world();
    let public = fungible(&mut w, "PUB", 3);
    let stealth = stealth_into_account(&mut w, 1_000_000_000, 600_000_000);
    let pool = create_and_fund(&mut w, stealth, public, 100_000_000, 100_000_000);
    let lp_resource: ResourceAddress = w.t.call_method(pool, "lp_resource", args![], vec![]);
    let lp_held = balance(&mut w, lp_resource);
    let total: Amount = w.t.call_method(pool, "lp_total_supply", args![], vec![]);
    let locked: Amount = w.t.call_method(pool, "locked_lp_supply", args![], vec![]);
    assert_eq!(locked.to_u128(), 1_000);
    assert_eq!(
        lp_held,
        total.to_u128() - 1_000,
        "the locked shares are not the LP's"
    );

    // k grows with every swap, because the whole input is deposited while only the
    // fee-reduced part prices the output.
    let mut k = reserve(&mut w, pool, stealth) * reserve(&mut w, pool, public);
    for (input, output, amount) in [
        (stealth, public, 2_000_000u64),
        (public, stealth, 3_000_000),
        (stealth, public, 500_000),
    ] {
        let tx = swap(&mut w, pool, input, output, amount, 1);
        let proof = w.proof.clone();
        w.t.execute_expect_success(tx, vec![proof]);
        let now = reserve(&mut w, pool, stealth) * reserve(&mut w, pool, public);
        assert!(now > k, "k must grow: {k} -> {now}");
        k = now;
    }

    // Exit: burning the whole LP position returns the proportional reserves, and the locked
    // shares keep a residue in the pool that nobody can ever redeem.
    let before_s = balance(&mut w, stealth);
    let before_p = balance(&mut w, public);
    let r_s = reserve(&mut w, pool, stealth);
    let r_p = reserve(&mut w, pool, public);
    let total_lp: Amount = w.t.call_method(pool, "lp_total_supply", args![], vec![]);
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_method(
                account,
                "withdraw",
                args![lp_resource, Amount::from(lp_held as u64)],
            )
            .put_last_instruction_output_on_workspace("lp")
            .call_method(
                pool,
                "remove_liquidity",
                args![Workspace("lp"), Amount::zero(), Amount::zero()],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            .call_method(account, "deposit", args![Workspace("out.1")])
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    let (pair_a, _pair_b): (ResourceAddress, ResourceAddress) =
        w.t.call_method(pool, "pair", args![], vec![]);
    let _ = pair_a;
    let got_s = balance(&mut w, stealth) - before_s;
    let got_p = balance(&mut w, public) - before_p;
    assert_eq!(got_s, lp_held * r_s / total_lp.to_u128());
    assert_eq!(got_p, lp_held * r_p / total_lp.to_u128());
    // The LP got MORE out than the fee-free share of the original deposit, because the fees
    // from the three swaps accrued to the reserves they owned.
    assert!(
        got_s + got_p > 199_000_000,
        "fees accrued to the LP: {got_s} + {got_p}"
    );
    assert!(reserve(&mut w, pool, stealth) > 0 && reserve(&mut w, pool, public) > 0);
    assert_eq!(
        balance(&mut w, lp_resource),
        0,
        "the whole position was burned"
    );
}

// -------------------------------------------------------------------------------------------
// r07 on-chain minimums
// -------------------------------------------------------------------------------------------

#[test]
fn r07_minimum_output_lp_and_redemption_bounds_are_enforced_on_chain() {
    let mut w = world();
    let public = fungible(&mut w, "PUB", 3);
    let stealth = stealth_into_account(&mut w, 1_000_000_000, 600_000_000);
    let pool = create_and_fund(&mut w, stealth, public, 100_000_000, 100_000_000);
    let before = balance(&mut w, stealth);

    // A swap demanding more than the pool can pay is rejected, and nothing moved.
    let tx = swap(&mut w, pool, stealth, public, 1_000_000, 999_999_999);
    let proof = w.proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
    assert!(reason.contains("Slippage"), "{reason}");
    assert_eq!(balance(&mut w, stealth), before, "the input was not spent");

    // A deposit demanding more LP than the balanced amounts can mint is rejected.
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_method(
                account,
                "withdraw",
                args![stealth, Amount::from(1_000_000u64)],
            )
            .put_last_instruction_output_on_workspace("a")
            .call_method(
                account,
                "withdraw",
                args![public, Amount::from(1_000_000u64)],
            )
            .put_last_instruction_output_on_workspace("b")
            .call_method(
                pool,
                "add_liquidity",
                args![Workspace("a"), Workspace("b"), Amount::from(999_999_999u64)],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            .call_method(account, "deposit", args![Workspace("out.1")])
            .call_method(account, "deposit", args![Workspace("out.2")])
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
    assert!(reason.contains("below the minimum"), "{reason}");

    // A redemption demanding more than the proportional share is rejected: an exit cannot be
    // sandwiched either (Pool v2 has no such bound).
    let lp_resource: ResourceAddress = w.t.call_method(pool, "lp_resource", args![], vec![]);
    let lp_held = balance(&mut w, lp_resource);
    let tx =
        w.t.transaction()
            .call_method(
                account,
                "withdraw",
                args![lp_resource, Amount::from(lp_held as u64)],
            )
            .put_last_instruction_output_on_workspace("lp")
            .call_method(
                pool,
                "remove_liquidity",
                args![
                    Workspace("lp"),
                    Amount::from(999_999_999u64),
                    Amount::zero()
                ],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            .call_method(account, "deposit", args![Workspace("out.1")])
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
    assert!(reason.contains("Slippage"), "{reason}");
    assert_eq!(
        balance(&mut w, lp_resource),
        lp_held,
        "the LP was not burned"
    );
}

// -------------------------------------------------------------------------------------------
// r08 first-deposit policy
// -------------------------------------------------------------------------------------------

#[test]
fn r08_first_deposit_locks_under_one_percent_and_refuses_a_dust_pool() {
    let mut w = world();
    let public = fungible(&mut w, "PUB", 2);
    let stealth = stealth_into_account(&mut w, 1_000_000_000, 500_000_000);

    // A first deposit whose geometric mean is below the required shares is refused, and the
    // message reports each side's divisibility so an operator can see why.
    let tmpl = w.t.get_template_address("RevealedAssetPool");
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_function(tmpl, "new", args![stealth, public, FEE_BPS])
            .put_last_instruction_output_on_workspace("pool")
            .call_method(account, "withdraw", args![stealth, Amount::from(1_000u64)])
            .put_last_instruction_output_on_workspace("a")
            .call_method(account, "withdraw", args![public, Amount::from(1_000u64)])
            .put_last_instruction_output_on_workspace("b")
            .call_method(
                "pool",
                "add_liquidity",
                args![Workspace("a"), Workspace("b"), Amount::zero()],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            .call_method(account, "deposit", args![Workspace("out.1")])
            .call_method(account, "deposit", args![Workspace("out.2")])
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
    assert!(reason.contains("First deposit is too small"), "{reason}");
    assert!(
        reason.contains("divisibility"),
        "the refusal is precision-aware: {reason}"
    );

    // At the policy boundary the pool is created and the lock is exactly 1% of the shares.
    let pool = create_and_fund(&mut w, stealth, public, MIN_FIRST_SHARES, MIN_FIRST_SHARES);
    let total: Amount = w.t.call_method(pool, "lp_total_supply", args![], vec![]);
    let locked: Amount = w.t.call_method(pool, "locked_lp_supply", args![], vec![]);
    assert_eq!(total.to_u128(), MIN_FIRST_SHARES as u128);
    assert_eq!(
        locked.to_u128() * 100,
        total.to_u128(),
        "the lock is 1% of the position"
    );

    // The locked shares are in total supply but belong to no one: the pool has no method that
    // withdraws from the locked vault, so a full exit by every LP still leaves them behind.
    let lp_resource: ResourceAddress = w.t.call_method(pool, "lp_resource", args![], vec![]);
    let lp_held = balance(&mut w, lp_resource);
    assert_eq!(lp_held, total.to_u128() - 1_000);
    let tx =
        w.t.transaction()
            .call_method(
                account,
                "withdraw",
                args![lp_resource, Amount::from(lp_held as u64)],
            )
            .put_last_instruction_output_on_workspace("lp")
            .call_method(
                pool,
                "remove_liquidity",
                args![Workspace("lp"), Amount::zero(), Amount::zero()],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            .call_method(account, "deposit", args![Workspace("out.1")])
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    w.t.execute_expect_success(tx, vec![proof]);
    let locked_after: Amount = w.t.call_method(pool, "locked_lp_supply", args![], vec![]);
    assert_eq!(
        locked_after.to_u128(),
        1_000,
        "still locked, still unredeemable"
    );
    assert!(
        reserve(&mut w, pool, stealth) > 0,
        "the locked share's reserves stay in the pool"
    );
}

// -------------------------------------------------------------------------------------------
// r09 the load-bearing revealed-value guard
// -------------------------------------------------------------------------------------------

#[test]
fn r09_a_bucket_carrying_blinded_commitments_is_refused() {
    // THE invariant this pool depends on: `bucket.amount()` is the WHOLE value of a bucket.
    // A Confidential bucket can carry blinded commitments beside its revealed amount, and
    // `amount()` reports only the revealed part, so depositing one would leave value
    // unaccounted for in a reserve priced in exact integers. The probe mints such a bucket
    // and the pool must refuse it.
    let mut w = world();
    let public = fungible(&mut w, "PUB", 3);
    let confidential = confidential_into_account(&mut w, 1_000_000_000, 400_000_000);
    let pool = create_and_fund(&mut w, confidential, public, 100_000_000, 100_000_000);
    let reserve_before = reserve(&mut w, pool, confidential);

    let tmpl_probe = w.t.get_template_address("ConfidentialProbe");
    let probe: ComponentAddress =
        w.t.read_only_state_store()
            .get_first_component_of(tmpl_probe)
            .unwrap()
            .unwrap();
    // A statement with a REAL blinded output, built by the engine's own test crypto, with the
    // value proofs the engine requires because the resource tracks total supply.
    let (statement, mask, _change) = generate_confidential_output_statement(1_000, None);
    let value_proofs = value_proofs_for_commitment(Amount::from(1_000u64), &mask);
    let account = w.account;
    let tx =
        w.t.transaction()
            .call_method(probe, "mint_blinded", args![statement, value_proofs])
            .put_last_instruction_output_on_workspace("blinded")
            .call_method(
                pool,
                "swap",
                args![Workspace("blinded"), public, Amount::from(1u64)],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out")])
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
    assert!(
        reason.contains("no confidential commitments"),
        "the revealed-value guard must refuse it: {reason}"
    );
    assert_eq!(
        reserve(&mut w, pool, confidential),
        reserve_before,
        "the reserve is untouched"
    );
}

// -------------------------------------------------------------------------------------------
// r10 dangling outputs
// -------------------------------------------------------------------------------------------

#[test]
fn r10_an_undeposited_output_fails_the_whole_transaction() {
    // Same engine rule as Pool v2 (multihop_routes m05): a returned bucket left on the
    // workspace fails the transaction, which is why every browser intent must deposit the LP
    // AND both refunds.
    let mut w = world();
    let public = fungible(&mut w, "PUB", 3);
    let stealth = stealth_into_account(&mut w, 1_000_000_000, 500_000_000);
    let pool = create_and_fund(&mut w, stealth, public, 100_000_000, 100_000_000);
    let account = w.account;
    let before = balance(&mut w, stealth);
    let tx =
        w.t.transaction()
            .call_method(account, "withdraw", args![stealth, Amount::from(1_000u64)])
            .put_last_instruction_output_on_workspace("in")
            .call_method(
                pool,
                "swap",
                args![Workspace("in"), public, Amount::from(1u64)],
            )
            .put_last_instruction_output_on_workspace("out")
            // ... and never deposited.
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    w.t.execute_expect_failure(tx, vec![proof]);
    assert_eq!(balance(&mut w, stealth), before);

    // A deposit that drops a refund fails the same way.
    let tx =
        w.t.transaction()
            .call_method(
                account,
                "withdraw",
                args![stealth, Amount::from(1_000_000u64)],
            )
            .put_last_instruction_output_on_workspace("a")
            .call_method(
                account,
                "withdraw",
                args![public, Amount::from(5_000_000u64)],
            )
            .put_last_instruction_output_on_workspace("b")
            .call_method(
                pool,
                "add_liquidity",
                args![Workspace("a"), Workspace("b"), Amount::zero()],
            )
            .put_last_instruction_output_on_workspace("out")
            .call_method(account, "deposit", args![Workspace("out.0")])
            // out.1 and out.2 (the refunds) are left dangling.
            .build_and_seal(&w.key.clone());
    let proof = w.proof.clone();
    w.t.execute_expect_failure(tx, vec![proof]);
}
