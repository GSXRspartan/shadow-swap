// Ootle v0.48 WIRE FIXTURES, produced by the REAL engine.
//
// v0.48.0 moved every engine value the indexer serves to its CBOR encoding, base64 in JSON
// (`EncodedSubstate { version, value }`, receipts as `[address, base64]`, and
// `state.up.substate` as base64). The browser decodes those bytes with the official
// `@tari-project/ootle-wasm-bor` decoder and then runs its own fail-closed Pool decoder over
// the JSON that comes back.
//
// A hand-written fixture for that path would only prove that the client agrees with the
// fixture's author. These fixtures are instead emitted by THIS engine executing THIS
// repository's Pool template, then encoded exactly as the indexer encodes them
// (`Encoded::<SubstateValue>::encode` -> serde base64). The web suite
// (`apps/web/test/ootle-v048-wire.test.cjs`) consumes the committed file, so the whole chain
// engine -> CBOR -> official decoder -> Shadow Swap decoder is exercised with real bytes.
//
// Two modes:
//   * default (CI): the COMMITTED fixture must still decode, byte-exact, under the pinned
//     engine cohort, and must hold the shapes the web suite relies on. A cohort bump that
//     changes the CBOR schema fails here rather than silently in a browser.
//   * SHADOW_SWAP_WRITE_WIRE_FIXTURES=1: regenerate the committed file from a fresh run.
//
// Addresses inside the fixture are TemplateTest addresses (test author key, local WASM hash).
// They identify nothing on Esmeralda and are never used as a registry seed.

use std::collections::BTreeMap;

use tari_engine_types::{
    commit_result::{ExecuteResult, TransactionResult},
    encoded::Encoded,
    substate::SubstateValue,
};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{Amount, ComponentAddress, ResourceAddress};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const FIXTURE_PATH: &str = "../apps/web/test/fixtures/ootle-v048-pool-wire.json";
const COHORT: &str = "tari-ootle v0.48.0 (6a25dbc524581bfaa0a3c6ef120f8d59cc827572)";

fn faucet(t: &mut TemplateTest, symbol: &str) -> (ComponentAddress, ResourceAddress) {
    let component: ComponentAddress = t.call_function(
        "TestFaucet",
        "mint_with_symbol",
        args![Amount::from(1_000_000_000_000u64), symbol.to_string()],
        vec![],
    );
    let resource = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    (component, resource)
}

/// The value the indexer would serve: `Encoded::<SubstateValue>` rendered by serde as base64.
fn encode_value(value: &SubstateValue) -> String {
    let encoded = Encoded::encode(value).expect("a live substate value always encodes");
    match serde_json::to_value(&encoded).expect("Encoded serialises") {
        serde_json::Value::String(b64) => b64,
        other => panic!("Encoded must serialise as a base64 string in JSON, got {other}"),
    }
}

fn decode_value(b64: &str) -> SubstateValue {
    let encoded: Encoded<SubstateValue> =
        serde_json::from_value(serde_json::Value::String(b64.to_string()))
            .expect("fixture value is base64");
    encoded
        .decode()
        .expect("fixture value decodes as a SubstateValue under the pinned cohort")
}

struct Run {
    pool: String,
    template: String,
    substates: BTreeMap<String, (u64, String)>,
    receipts: Vec<(String, String)>,
    /// `Encoded<ExecuteResult>` of the committed swap and of a swap the template rejected
    /// (min_output above anything the pool can pay). This is what
    /// `IndexerTransactionFinalizedResult.Finalized.execution_result` carries at v0.48.
    accepted_execute_result: String,
    rejected_execute_result: String,
}

fn encode_execute_result(result: &ExecuteResult) -> String {
    let encoded = Encoded::encode(result).expect("an execute result encodes");
    match serde_json::to_value(&encoded).unwrap() {
        serde_json::Value::String(s) => s,
        other => panic!("unexpected execute-result encoding {other}"),
    }
}

fn run_pool_lifecycle() -> Run {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        ["../templates/fungible_pool", "templates/faucet"],
    );
    let (fa, a) = faucet(&mut t, "AAA");
    let (fb, b) = faucet(&mut t, "BBB");
    let pool_template = t.get_template_address("Pool");

    let mut substates: BTreeMap<String, (u64, String)> = BTreeMap::new();
    let mut receipts: Vec<(String, String)> = Vec::new();
    let mut absorb = |diff: &tari_engine_types::substate::SubstateDiff| {
        for (id, substate) in diff.up_iter() {
            let value = substate.substate_value();
            if let SubstateValue::TransactionReceipt(_) = value {
                // `/transaction-receipts` serves the inner `TransactionReceipt`, not the
                // SubstateValue wrapper.
                let receipt = value.as_transaction_receipt().unwrap();
                let encoded = Encoded::encode(receipt).expect("receipt encodes");
                let b64 = match serde_json::to_value(&encoded).unwrap() {
                    serde_json::Value::String(s) => s,
                    other => panic!("unexpected receipt encoding {other}"),
                };
                receipts.push((id.to_string(), b64));
                continue;
            }
            substates.insert(
                id.to_string(),
                (u64::from(substate.version()), encode_value(value)),
            );
        }
    };

    let tx = t
        .transaction()
        .call_function(pool_template, "new", args![a, b, 30u16])
        .build_and_seal(t.secret_key());
    let res = t.execute_expect_success(tx, vec![]);
    let diff = res.expect_success();
    absorb(diff);
    let pool = diff
        .up_iter()
        .find(|(id, s)| {
            id.is_component()
                && *s.substate_value().component().unwrap().template_address() == pool_template
        })
        .map(|(id, _)| id.as_component_address().unwrap())
        .expect("pool component created");

    let (account, proof, _) = t.create_funded_account();
    for f in [fa, fb] {
        let tx = t
            .transaction()
            .call_method(f, "take_free_coins", args![])
            .put_last_instruction_output_on_workspace("coins")
            .call_method(account, "deposit", args![Workspace("coins")]);
        t.build_and_execute(tx, vec![]).expect_success();
    }

    let tx = t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(400_000_000u64)])
        .put_last_instruction_output_on_workspace("a")
        .call_method(account, "withdraw", args![b, Amount::from(500_000_000u64)])
        .put_last_instruction_output_on_workspace("b")
        .call_method(pool, "add_liquidity", args![Workspace("a"), Workspace("b")])
        .put_last_instruction_output_on_workspace("lp")
        .call_method(account, "deposit", args![Workspace("lp")]);
    let res = t.build_and_execute(tx, vec![proof.clone()]);
    absorb(res.expect_success());

    let tx = t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(1_000_000u64)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(pool, "swap", args![Workspace("in"), b, Amount::from(1u64)])
        .put_last_instruction_output_on_workspace("out")
        .call_method(account, "deposit", args![Workspace("out")]);
    let res = t.build_and_execute(tx, vec![proof.clone()]);
    absorb(res.expect_success());
    let accepted_execute_result = encode_execute_result(&res);

    // A swap the template must refuse: min_output far above the reserve. Executed but
    // never committed, so the fixture's substates are unaffected.
    let tx = t
        .transaction()
        .call_method(account, "withdraw", args![a, Amount::from(1_000_000u64)])
        .put_last_instruction_output_on_workspace("in")
        .call_method(
            pool,
            "swap",
            args![Workspace("in"), b, Amount::from(999_999_999_999u64)],
        )
        .put_last_instruction_output_on_workspace("out")
        .call_method(account, "deposit", args![Workspace("out")])
        .build_and_seal(t.secret_key());
    let rejected = t
        .try_execute(tx, vec![proof])
        .expect("the transaction is valid; only its execution fails");
    assert!(
        !matches!(rejected.finalize.result, TransactionResult::Accept(_)),
        "a swap demanding more than the reserve must not be accepted"
    );
    let rejected_execute_result = encode_execute_result(&rejected);

    Run {
        pool: pool.to_string(),
        template: pool_template.to_string(),
        substates,
        receipts,
        accepted_execute_result,
        rejected_execute_result,
    }
}

fn fixture_json(run: &Run) -> serde_json::Value {
    let substates: serde_json::Map<String, serde_json::Value> = run
        .substates
        .iter()
        .map(|(id, (version, b64))| {
            (
                id.clone(),
                serde_json::json!({ "version": version, "value": b64 }),
            )
        })
        .collect();
    serde_json::json!({
        "cohort": COHORT,
        "generatedBy": "audit_engine_tests/tests/wire_fixtures_v048.rs (SHADOW_SWAP_WRITE_WIRE_FIXTURES=1)",
        "note": "TemplateTest addresses. They identify nothing on Esmeralda and must never seed a registry.",
        "poolComponent": run.pool,
        "poolTemplate": run.template,
        "substates": substates,
        "receipts": run.receipts,
        "executeResults": {
            "acceptedSwap": run.accepted_execute_result,
            "rejectedSwap": run.rejected_execute_result,
        },
    })
}

#[test]
fn v048_wire_fixture_is_engine_produced_and_decodes_under_the_pinned_cohort() {
    if std::env::var_os("SHADOW_SWAP_WRITE_WIRE_FIXTURES").is_some() {
        let run = run_pool_lifecycle();
        let text = serde_json::to_string_pretty(&fixture_json(&run)).unwrap() + "\n";
        std::fs::write(format!("{CRATE_PATH}/{FIXTURE_PATH}"), text).expect("write fixture");
    }

    let text = std::fs::read_to_string(format!("{CRATE_PATH}/{FIXTURE_PATH}"))
        .expect("the committed v0.48 wire fixture exists");
    let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        fixture["cohort"], COHORT,
        "fixture was produced by a different cohort"
    );

    let pool = fixture["poolComponent"].as_str().unwrap();
    let substates = fixture["substates"].as_object().unwrap();
    let mut kinds = BTreeMap::<&str, usize>::new();
    for (id, entry) in substates {
        let value = decode_value(entry["value"].as_str().unwrap());
        // Byte-exact: re-encoding the decoded value reproduces the committed bytes, so the
        // fixture is a canonical encoding under this cohort and not merely "decodable".
        assert_eq!(
            encode_value(&value),
            entry["value"].as_str().unwrap(),
            "{id} is not a canonical v0.48 encoding"
        );
        let kind = match &value {
            SubstateValue::Component(_) => "component",
            SubstateValue::Resource(_) => "resource",
            SubstateValue::Vault(_) => "vault",
            _ => "other",
        };
        *kinds.entry(kind).or_default() += 1;
        if id == pool {
            let component = value.component().expect("pool id holds a component");
            assert_eq!(
                component.template_address().to_string(),
                fixture["poolTemplate"]
                    .as_str()
                    .unwrap()
                    .trim_start_matches("template_"),
                "pool component's own header names the fixture's pool template"
            );
        }
    }
    assert!(
        substates.contains_key(pool),
        "fixture carries the pool component"
    );
    assert!(
        kinds.get("vault").copied().unwrap_or(0) >= 3,
        "two reserve vaults and the locked-LP vault"
    );
    assert!(
        kinds.get("resource").copied().unwrap_or(0) >= 1,
        "the LP resource"
    );

    for receipt in fixture["receipts"].as_array().unwrap() {
        let b64 = receipt[1].as_str().unwrap();
        let encoded: Encoded<tari_engine_types::transaction_receipt::TransactionReceipt> =
            serde_json::from_value(serde_json::Value::String(b64.to_string())).unwrap();
        encoded
            .decode()
            .expect("receipt decodes under the pinned cohort");
    }

    let decode_result = |b64: &str| -> ExecuteResult {
        let encoded: Encoded<ExecuteResult> =
            serde_json::from_value(serde_json::Value::String(b64.to_string())).unwrap();
        encoded
            .decode()
            .expect("execute result decodes under the pinned cohort")
    };
    let accepted = decode_result(fixture["executeResults"]["acceptedSwap"].as_str().unwrap());
    assert!(matches!(
        accepted.finalize.result,
        TransactionResult::Accept(_)
    ));
    let rejected = decode_result(fixture["executeResults"]["rejectedSwap"].as_str().unwrap());
    assert!(!matches!(
        rejected.finalize.result,
        TransactionResult::Accept(_)
    ));
}
