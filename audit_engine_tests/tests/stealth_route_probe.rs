// Phase 6 research, executed in the REAL v0.48.0 engine: what does a GENERIC created-Stealth
// resource (not native TARI) do in a component vault, and does Pool v2 keep refusing it?
//
// Findings these tests pin (see docs/SHADOW_SWAP_V047_RELEASE_READINESS.md, route matrix):
//   * engine-compatible: the REVEALED portion of a created-Stealth resource is held in, and
//     withdrawn from, a component vault exactly like revealed native TARI;
//   * Pool v2 still REFUSES it at construction (validate_pool_resource, OPUS-08): issuer
//     authority over stealth resources (freeze / burn / recall rules) cannot be inspected
//     from a template, so a public pool must not hold one. The guard is intentional and is
//     NOT relaxed by this research.
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, ResourceAddress};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");

fn setup() -> (TemplateTest, ComponentAddress, ResourceAddress) {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/fungible_pool",
            "templates/faucet",
            "templates/stealth_probe",
        ],
    );
    let probe: ComponentAddress = t.call_function(
        "StealthProbe",
        "new",
        args![Amount::from(1_000_000u64)],
        vec![],
    );
    let resource = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    (t, probe, resource)
}

#[test]
fn s01_created_stealth_revealed_supply_lives_in_a_component_vault() {
    let (mut t, probe, _resource) = setup();
    let balance: Amount = t.call_method(probe, "balance", args![], vec![]);
    assert_eq!(balance, Amount::from(1_000_000u64));

    // Withdraw revealed units into the workspace and deposit them back: the vault behaves as
    // Pool v2's native-TARI reserve vault does.
    let tx = t
        .transaction()
        .call_method(probe, "take", args![Amount::from(250_000u64)])
        .put_last_instruction_output_on_workspace("b")
        .call_method(probe, "put", args![Workspace("b")])
        .build_and_seal(t.secret_key());
    t.execute_expect_success(tx, vec![]);
    let balance: Amount = t.call_method(probe, "balance", args![], vec![]);
    assert_eq!(balance, Amount::from(1_000_000u64));
}

#[test]
fn s02_pool_v2_still_refuses_a_created_stealth_resource() {
    let (mut t, _probe, stealth) = setup();
    let fungible: ComponentAddress = t.call_function(
        "TestFaucet",
        "mint_with_symbol",
        args![Amount::from(1_000_000_000u64), "FUN".to_string()],
        vec![],
    );
    let _ = fungible;
    let fungible_resource = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    let pool_template = t.get_template_address("Pool");
    let tx = t
        .transaction()
        .call_function(
            pool_template,
            "new",
            args![stealth, fungible_resource, 30u16],
        )
        .build_and_seal(t.secret_key());
    let reason = t.execute_expect_failure(tx, vec![]);
    let text = format!("{reason:?}");
    assert!(
        text.contains("not eligible"),
        "the refusal must be the OPUS-08 eligibility guard, got: {text}"
    );
}
