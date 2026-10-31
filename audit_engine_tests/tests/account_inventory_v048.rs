// ACCOUNT INVENTORY fixtures, produced by the REAL v0.48 engine.
//
// A dApp cannot learn which NFTs an account holds from the wallet: Sapient's documented
// `DappTokenBalance` (tari-wallet docs/integration/provider-api.md) carries
// `{resourceAddress, kind, amount, confidentialAmount, privateVisible, divisibility, symbol,
// name}` and NO token ids — the ids exist only in the wallet's own popup model. The ids are
// public on-chain data, so Shadow Swap reads them from the account's OWN vaults through the
// wallet's `tari_getSubstate`, which is authoritative rather than advisory.
//
// The account template stores `vaults: VaultMap` keyed by resource (crates/template_builtin/
// templates/account/src/lib.rs at v0.48.0), so the vault ids are the CBOR tag-132 nodes of the
// component's state — the same derivation the upstream TS SDK's `getVaultIdsForAccount` uses.
// This fixture is one account holding every container kind at once, so the browser's reader
// (packages/protocol-client/src/accountInventory.ts) is exercised against real bytes:
//
//   public fungible  (Fungible container)
//   created-Stealth, revealed  (Stealth container: revealed_amount only, no commitments)
//   confidential, revealed     (Confidential container: commitments + revealed_amount)
//   two NFTs of one collection and one of another (NonFungible container, canonical ids)
//
// Default (CI) mode: the committed fixture must still decode byte-exact under the pinned
// cohort and hold those shapes. SHADOW_SWAP_WRITE_WIRE_FIXTURES=1 regenerates it.
// Addresses are TemplateTest addresses; they identify nothing on Esmeralda.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use tari_engine_types::{encoded::Encoded, substate::SubstateValue};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;

use tari_engine_types::substate::SubstateId;
use tari_template_lib::types::{Amount, ComponentAddress, NonFungibleId};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const FIXTURE_PATH: &str = "../apps/web/test/fixtures/ootle-v048-account-inventory.json";
const COHORT: &str = "tari-ootle v0.48.0 (6a25dbc524581bfaa0a3c6ef120f8d59cc827572)";

fn encode_value(value: &SubstateValue) -> String {
    let encoded = Encoded::encode(value).expect("a live substate value always encodes");
    match serde_json::to_value(&encoded).unwrap() {
        Value::String(b64) => b64,
        other => panic!("Encoded must serialise as base64, got {other}"),
    }
}

fn decode_value(b64: &str) -> SubstateValue {
    let encoded: Encoded<SubstateValue> =
        serde_json::from_value(Value::String(b64.to_string())).expect("base64");
    encoded.decode().expect("decodes under the pinned cohort")
}

#[test]
fn ai01_account_inventory_substates_are_engine_produced_and_decode_under_the_pinned_cohort() {
    if std::env::var("SHADOW_SWAP_WRITE_WIRE_FIXTURES").as_deref() == Ok("1") {
        let doc = generate();
        std::fs::write(
            format!("{CRATE_PATH}/{FIXTURE_PATH}"),
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
    }
    let text = std::fs::read_to_string(format!("{CRATE_PATH}/{FIXTURE_PATH}"))
        .expect("the committed account-inventory fixture exists");
    let fixture: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(fixture["cohort"], COHORT);
    let account = fixture["account"].as_str().unwrap();
    let substates = fixture["substates"].as_object().unwrap();
    assert!(
        substates.contains_key(account),
        "the account component is captured"
    );
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    for (id, entry) in substates {
        let b64 = entry["value"].as_str().unwrap();
        let value = decode_value(b64);
        assert_eq!(
            encode_value(&value),
            b64,
            "{id} is not a canonical v0.48 encoding"
        );
        if matches!(value, SubstateValue::Vault(_)) {
            // The Debug rendering names the container variant: `resource_container: Stealth { .. }`.
            let text = format!("{value:?}");
            let kind = if text.contains("resource_container: NonFungible {") {
                "non_fungible"
            } else if text.contains("resource_container: Confidential {") {
                "confidential"
            } else if text.contains("resource_container: Stealth {") {
                "stealth"
            } else if text.contains("resource_container: Fungible {") {
                "fungible"
            } else {
                panic!("unknown container in {text}")
            };
            *kinds.entry(kind).or_default() += 1;
        }
    }
    // Every container kind the browser must classify appears at least once, so the fixture
    // cannot silently stop covering one.
    for kind in ["fungible", "non_fungible", "confidential", "stealth"] {
        assert!(
            kinds.get(kind).copied().unwrap_or(0) >= 1,
            "fixture covers a {kind} vault"
        );
    }
    let expect = fixture["expect"].as_array().unwrap();
    assert!(
        expect.len() >= 5,
        "every holding is described for the web test"
    );
}

fn generate() -> Value {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "templates/faucet",
            "templates/nft_faucet",
            "templates/stealth_probe",
            "templates/confidential_probe",
        ],
    );
    t.enable_auto_add_proofs_from_signers();
    let (account, proof, _key) = t.create_funded_account();
    let mut expect: Vec<Value> = vec![];

    // 1. A public fungible.
    let faucet: ComponentAddress = t.call_function(
        "TestFaucet",
        "mint_with_symbol",
        args![Amount::from(1_000_000_000_000u64), "PUB".to_string()],
        vec![],
    );
    let public = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    let tx = t
        .transaction()
        .call_method(faucet, "take_free_coins", args![])
        .put_last_instruction_output_on_workspace("c")
        .call_method(account, "deposit", args![Workspace("c")]);
    t.build_and_execute(tx, vec![]).expect_success();
    let public_amount: Amount = t.call_method(account, "balance", args![public], vec![]);
    expect.push(json!({ "resource": public.to_string(), "containerKind": "Fungible", "amount": public_amount.to_string(), "tokenIds": [] }));

    // 2. A created-Stealth resource's REVEALED units (no commitments can exist in a Stealth
    //    container, so the amount is the whole holding).
    let stealth_probe: ComponentAddress = t.call_function(
        "StealthProbe",
        "new",
        args![Amount::from(1_000_000u64)],
        vec![],
    );
    let stealth = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    let tx = t
        .transaction()
        .call_method(stealth_probe, "take", args![Amount::from(400_000u64)])
        .put_last_instruction_output_on_workspace("s")
        .call_method(account, "deposit", args![Workspace("s")]);
    t.build_and_execute(tx, vec![]).expect_success();
    expect.push(json!({ "resource": stealth.to_string(), "containerKind": "Stealth", "amount": "400000", "tokenIds": [] }));

    // 3. A confidential resource's REVEALED units.
    let conf_probe: ComponentAddress = t.call_function(
        "ConfidentialProbe",
        "new",
        args![Amount::from(1_000_000u64)],
        vec![],
    );
    let confidential = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    let tx = t
        .transaction()
        .call_method(conf_probe, "take", args![Amount::from(250_000u64)])
        .put_last_instruction_output_on_workspace("k")
        .call_method(account, "deposit", args![Workspace("k")]);
    t.build_and_execute(tx, vec![]).expect_success();
    expect.push(json!({ "resource": confidential.to_string(), "containerKind": "Confidential", "amount": "250000", "tokenIds": [] }));

    // 4. TWO NFTs of one collection: a picker must list both, by canonical id.
    let nft_faucet: ComponentAddress = t.call_function(
        "TestNftFaucet",
        "mint_many",
        args![
            vec![
                NonFungibleId::from_string("art-1"),
                NonFungibleId::from_string("art-2")
            ],
            "ARTA".to_string()
        ],
        vec![],
    );
    let collection_a = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    for id in ["art-1", "art-2"] {
        let tx = t
            .transaction()
            .call_method(
                nft_faucet,
                "take_nft_by_id",
                args![NonFungibleId::from_string(id)],
            )
            .put_last_instruction_output_on_workspace("n")
            .call_method(account, "deposit", args![Workspace("n")]);
        t.build_and_execute(tx, vec![]).expect_success();
    }
    expect.push(json!({ "resource": collection_a.to_string(), "containerKind": "NonFungible", "amount": "0", "tokenIds": ["str_art-1", "str_art-2"] }));

    // 5. One NFT of a second collection, with a NUMERIC id, so the reader's canonical-id
    //    handling is covered for more than the string variant.
    let nft_faucet_b: ComponentAddress = t.call_function(
        "TestNftFaucet",
        "mint_many",
        args![vec![NonFungibleId::from_u64(77)], "ARTB".to_string()],
        vec![],
    );
    let collection_b = t
        .get_previous_output_address(SubstateType::Resource)
        .as_resource_address()
        .unwrap();
    let tx = t
        .transaction()
        .call_method(
            nft_faucet_b,
            "take_nft_by_id",
            args![NonFungibleId::from_u64(77)],
        )
        .put_last_instruction_output_on_workspace("n")
        .call_method(account, "deposit", args![Workspace("n")]);
    t.build_and_execute(tx, vec![]).expect_success();
    expect.push(json!({ "resource": collection_b.to_string(), "containerKind": "NonFungible", "amount": "0", "tokenIds": ["u64_77"] }));

    // The account component plus EXACTLY the vaults it references, read from CURRENT state
    // (not from transaction diffs): the browser reads the same two things in the same order,
    // and a diff-derived set would both miss the funding vault and include other components'.
    let store = t.read_only_state_store();
    let account_substate = store
        .get_substate(&SubstateId::Component(account))
        .expect("the account component exists");
    let mut substates = serde_json::Map::new();
    substates.insert(
        account.to_string(),
        json!({
            "version": u64::from(account_substate.version()),
            "value": encode_value(account_substate.substate_value()),
        }),
    );
    let account_state = store.get_account(account).expect("the account decodes");
    let mut covered: Vec<String> = vec![];
    for (resource, vault) in account_state.vaults().iter() {
        let id = SubstateId::Vault(vault.vault_id());
        let substate = store.get_substate(&id).expect("a referenced vault exists");
        substates.insert(
            id.to_string(),
            json!({
                "version": u64::from(substate.version()),
                "value": encode_value(substate.substate_value()),
            }),
        );
        covered.push(resource.to_string());
    }
    // Every holding this fixture set up must be one of the account's own vaults, and the
    // account's funding vault (created by `create_funded_account`) is described too, so the
    // web test can require that EVERY vault decodes with nothing left over.
    for want in &expect {
        let resource = want["resource"].as_str().unwrap().to_string();
        assert!(
            covered.contains(&resource),
            "{resource} is one of the account's vaults"
        );
    }
    for resource in &covered {
        if !expect
            .iter()
            .any(|e| e["resource"].as_str() == Some(resource.as_str()))
        {
            let vault_id = account_state
                .vaults()
                .iter()
                .find(|(r, _)| r.to_string() == *resource)
                .map(|(_, v)| v.vault_id())
                .unwrap();
            let substate = store.get_substate(&SubstateId::Vault(vault_id)).unwrap();
            let vault = substate
                .substate_value()
                .as_vault()
                .expect("a vault id holds a vault");
            let text = format!("{:?}", substate.substate_value());
            let kind = if text.contains("resource_container: NonFungible {") {
                "NonFungible"
            } else if text.contains("resource_container: Confidential {") {
                "Confidential"
            } else if text.contains("resource_container: Stealth {") {
                "Stealth"
            } else {
                "Fungible"
            };
            expect.push(json!({
                "resource": resource,
                "containerKind": kind,
                "amount": vault.balance().to_string(),
                "tokenIds": [],
                "note": "the account's funding vault, created by create_funded_account",
            }));
        }
    }

    json!({
        "cohort": COHORT,
        "generatedBy": "audit_engine_tests/tests/account_inventory_v048.rs (SHADOW_SWAP_WRITE_WIRE_FIXTURES=1)",
        "note": "TemplateTest addresses. They identify nothing on Esmeralda and must never seed a registry.",
        "account": account.to_string(),
        "proofResource": proof.resource_address().to_string(),
        "substates": substates,
        "expect": expect,
    })
}
