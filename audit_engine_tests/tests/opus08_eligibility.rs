// OPUS-08 resource-eligibility engine tests.
//
// Proves the ON-CHAIN type policy enforced by Pool::new (validate_pool_resource):
//   * canonical native Tari (TARI_TOKEN) and ordinary public fungibles are accepted;
//   * confidential / non-Tari stealth / non-fungible resources are rejected;
//   * a same-resource pair is rejected;
//   * metadata (e.g. a token that calls itself "TARI") does not affect eligibility.
//
// It also documents (RESOURCE04/05) the residual, UNSCREENABLE risk: a recallable or freezable
// public fungible is ACCEPTED because the v0.41.1 template ABI cannot read those rules. The actual
// recall drain is demonstrated in opus08_recall_demo.rs.
//
// EXECUTION: the engine (wasmer/cranelift) does not build on Windows; these run in Linux CI.

use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::constants::TARI_TOKEN;
use tari_template_lib::types::{Amount, ComponentAddress, ResourceAddress};
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

/// Mint an ordinary public fungible via the faucet; returns its resource address.
fn faucet_fungible(t: &mut TemplateTest, symbol: &str) -> ResourceAddress {
    let supply = Amount::from(1_000_000_000_000u64);
    let _c: ComponentAddress = t.call_function(
        "TestFaucet",
        "mint_with_symbol",
        args![supply, symbol.to_string()],
        vec![],
    );
    t.get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap()
}

/// Call a zero-arg Hostile factory function that returns (Component, ResourceAddress); returns the
/// resource address (execution result path `$.1`).
fn hostile_resource(t: &mut TemplateTest, func: &str) -> ResourceAddress {
    let tpl = t.get_template_address("Hostile");
    let res = t.execute_expect_success(
        t.transaction()
            .call_function(tpl, func, args![])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    res.finalize.execution_results[0]
        .get_value("$.1")
        .unwrap()
        .unwrap()
}

/// Attempt Pool::new(a, b, fee); returns true on success, false if the engine rejected it.
fn try_create_pool(t: &mut TemplateTest, a: ResourceAddress, b: ResourceAddress, fee: u16) -> bool {
    let tpl = t.get_template_address("Pool");
    let sealed = t
        .transaction()
        .call_function(tpl, "new", args![a, b, fee])
        .build_and_seal(t.secret_key());
    match t.try_execute(sealed, vec![]) {
        Ok(result) => result.finalize.result.is_accept(),
        Err(_) => false,
    }
}

// RESOURCE01 — a safe ordinary public fungible pair is accepted.
#[test]
fn resource01_safe_public_fungible_pair_accepted() {
    let mut t = new_test();
    let a = faucet_fungible(&mut t, "AAA");
    let b = faucet_fungible(&mut t, "BBB");
    assert!(
        try_create_pool(&mut t, a, b, 3),
        "safe fungible pair should be accepted"
    );
}

// RESOURCE02 — canonical native Tari (TARI_TOKEN) paired with a fungible is accepted.
#[test]
fn resource02_canonical_tari_accepted() {
    let mut t = new_test();
    let b = faucet_fungible(&mut t, "BBB");
    assert!(
        try_create_pool(&mut t, TARI_TOKEN, b, 3),
        "canonical Tari pair should be accepted"
    );
}

// RESOURCE03 — a "fake Tari" (ordinary fungible with symbol TARI) is NOT conflated with native
// Tari: it is a distinct resource that can coexist with real Tari in a pool, and it never gains
// canonical-Tari identity (identity is address-based, not symbol-based).
#[test]
fn resource03_fake_tari_is_just_a_fungible_not_canonical() {
    let mut t = new_test();
    let fake_tari = hostile_resource(&mut t, "symbol_tari_fungible");
    assert_ne!(
        fake_tari, TARI_TOKEN,
        "fake Tari must have a different address than canonical Tari"
    );
    // It is accepted only as an ordinary fungible, paired here with the real Tari.
    assert!(
        try_create_pool(&mut t, TARI_TOKEN, fake_tari, 3),
        "fake Tari should pool as an ordinary fungible"
    );
}

// RESOURCE04 — DOCUMENTED GAP: a recallable public fungible is ACCEPTED (type-eligible). The
// template cannot read the recall rule in v0.41.1. See opus08_recall_demo.rs for the drain.
#[test]
fn resource04_recallable_fungible_is_accepted_documenting_opus08_gap() {
    let mut t = new_test();
    let evil = hostile_resource(&mut t, "recallable_fungible");
    let safe = faucet_fungible(&mut t, "BBB");
    assert!(
        try_create_pool(&mut t, evil, safe, 3),
        "recallable fungible is currently accepted (unscreenable in v0.41.1) — OPUS-08 residual"
    );
}

// RESOURCE05 — DOCUMENTED GAP: a freezable public fungible is ACCEPTED (type-eligible).
#[test]
fn resource05_freezable_fungible_is_accepted_documenting_opus08_gap() {
    let mut t = new_test();
    let evil = hostile_resource(&mut t, "freezable_fungible");
    let safe = faucet_fungible(&mut t, "BBB");
    assert!(
        try_create_pool(&mut t, evil, safe, 3),
        "freezable fungible is currently accepted (unscreenable in v0.41.1) — OPUS-08 residual"
    );
}

// RESOURCE07 — a non-Tari STEALTH resource is rejected by the public-fungible pool.
#[test]
fn resource07_stealth_asset_rejected() {
    let mut t = new_test();
    let stealth = hostile_resource(&mut t, "stealth_asset");
    let safe = faucet_fungible(&mut t, "BBB");
    assert!(
        !try_create_pool(&mut t, stealth, safe, 3),
        "non-Tari stealth resource must be rejected by an ordinary public-fungible pool"
    );
}

// RESOURCE08 — confidential resources are rejected by the same non-Fungible code path as stealth
// (RESOURCE07). Creating a confidential resource in-engine requires confidential proofs, which is
// out of scope for this eligibility test; the rejection branch is covered by RESOURCE07 (stealth)
// and by the protocol_types::classify_resource unit tests. Documented, not separately executed.

// RESOURCE09 — a same-resource pair is rejected.
#[test]
fn resource09_same_resource_pair_rejected() {
    let mut t = new_test();
    let a = faucet_fungible(&mut t, "AAA");
    assert!(
        !try_create_pool(&mut t, a, a, 3),
        "same-resource pair must be rejected"
    );
}

// RESOURCE10 — metadata claiming to be TARI does not grant eligibility beyond ordinary fungible.
#[test]
fn resource10_malicious_metadata_does_not_affect_eligibility() {
    let mut t = new_test();
    let liar = hostile_resource(&mut t, "symbol_tari_fungible");
    let safe = faucet_fungible(&mut t, "BBB");
    // Accepted purely because it is ResourceType::Fungible — not because of its metadata.
    assert!(
        try_create_pool(&mut t, liar, safe, 3),
        "metadata must not change the type-based verdict"
    );
}
