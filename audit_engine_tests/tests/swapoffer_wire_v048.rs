// SwapOffer SUBSTATE fixtures, produced by the REAL v0.48 engine running templates/p2p_offer.
//
// A shareable invitation is untrusted text. Before anyone fills an offer, the browser re-reads
// the offer component (and its escrow vault) from the network and derives the terms from
// CHAIN STATE: what is escrowed, what is wanted, the hash lock, the expiry, the status, the
// maker key (the `claim`/`cancel` access rule) and the designated taker (the `fill` access
// rule). The decoder that does that (packages/protocol-client/src/swapOfferSubstate.ts) is
// only as good as its fixture, so the fixture is the engine's own bytes, encoded exactly as
// the indexer serves them (`Encoded::<SubstateValue>` -> base64), for every state an offer
// can be in:
//
//   open_fungible   fungible escrow, designated taker, SHA-256 hash lock, expiry
//   open_nft        NFT-for-a-specific-NFT barter, no taker restriction, no expiry
//   filled          after a fill: escrow empty, proceeds holding the payment
//   cancelled       after a maker cancel: escrow empty
//
// Default (CI) mode: the committed fixture must decode byte-exact under the pinned cohort and
// still hold those facts. SHADOW_SWAP_WRITE_WIRE_FIXTURES=1 regenerates it.
// Addresses are TemplateTest addresses; they identify nothing on Esmeralda.

use std::collections::BTreeMap;

use ootle_byte_type::ToByteType;
use serde_json::{json, Value};
use tari_crypto::{keys::PublicKey as _, ristretto::RistrettoPublicKey};
use tari_engine_types::{encoded::Encoded, substate::SubstateValue};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{
    crypto::RistrettoPublicKeyBytes, Amount, ComponentAddress, Hash32, NonFungibleId,
    ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const FIXTURE_PATH: &str = "../apps/web/test/fixtures/ootle-v048-swapoffer-wire.json";
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Capture {
    /// substate id -> (version, base64) at the moment the offer is snapshotted.
    live: BTreeMap<String, (u64, String)>,
    /// offer component -> the vaults its create transaction brought up at version 0
    /// (escrow + proceeds).
    vaults: BTreeMap<String, Vec<String>>,
}

impl Capture {
    fn absorb(&mut self, diff: &tari_engine_types::substate::SubstateDiff) {
        for (id, substate) in diff.up_iter() {
            let value = substate.substate_value();
            if matches!(value, SubstateValue::TransactionReceipt(_)) {
                continue;
            }
            self.live.insert(
                id.to_string(),
                (u64::from(substate.version()), encode_value(value)),
            );
        }
    }

    /// The offer component and every vault it references, as the browser would read them.
    fn snapshot(&self, offer: &ComponentAddress) -> Value {
        let offer_id = offer.to_string();
        let (version, b64) = self.live.get(&offer_id).expect("offer captured").clone();
        let mut out = serde_json::Map::new();
        out.insert(
            offer_id.clone(),
            json!({ "version": version, "value": b64 }),
        );
        for id in &self.vaults[&offer_id] {
            let (v, b) = &self.live[id];
            out.insert(id.clone(), json!({ "version": v, "value": b }));
        }
        Value::Object(out)
    }
}

#[test]
fn so01_swapoffer_substates_are_engine_produced_and_decode_under_the_pinned_cohort() {
    if std::env::var("SHADOW_SWAP_WRITE_WIRE_FIXTURES").as_deref() == Ok("1") {
        let doc = generate();
        std::fs::write(
            format!("{CRATE_PATH}/{FIXTURE_PATH}"),
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
    }
    let text = std::fs::read_to_string(format!("{CRATE_PATH}/{FIXTURE_PATH}"))
        .expect("the committed SwapOffer wire fixture exists");
    let fixture: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(fixture["cohort"], COHORT);
    let template = fixture["template"].as_str().unwrap().to_string();
    let offers = fixture["offers"].as_array().unwrap();
    assert_eq!(offers.len(), 4);
    for offer in offers {
        let id = offer["component"].as_str().unwrap();
        let substates = offer["substates"].as_object().unwrap();
        for (sid, entry) in substates {
            let b64 = entry["value"].as_str().unwrap();
            let value = decode_value(b64);
            assert_eq!(
                encode_value(&value),
                b64,
                "{sid} is not a canonical v0.48 encoding"
            );
            if sid == id {
                let c = value.component().expect("offer id holds a component");
                assert_eq!(
                    c.template_address().to_string(),
                    template.trim_start_matches("template_")
                );
            }
        }
        assert!(
            substates.contains_key(id),
            "{id} snapshot carries the component"
        );
        assert!(
            substates.keys().filter(|k| k.starts_with("vault_")).count() == 2,
            "escrow + proceeds vaults"
        );
    }
}

fn generate() -> Value {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/p2p_offer",
            "templates/faucet",
            "templates/nft_faucet",
        ],
    );
    t.enable_auto_add_proofs_from_signers();
    let (maker, maker_proof, maker_key) = t.create_funded_account();
    let (taker, taker_proof, taker_key) = t.create_funded_account();
    let maker_pk: RistrettoPublicKeyBytes =
        RistrettoPublicKey::from_secret_key(&maker_key).to_byte_type();
    let taker_pk: RistrettoPublicKeyBytes =
        RistrettoPublicKey::from_secret_key(&taker_key).to_byte_type();
    let mut cap = Capture {
        live: BTreeMap::new(),
        vaults: BTreeMap::new(),
    };

    let fungible = |t: &mut TemplateTest, cap: &mut Capture, symbol: &str| -> ResourceAddress {
        let f: ComponentAddress = t.call_function(
            "TestFaucet",
            "mint_with_symbol",
            args![Amount::from(1_000_000_000_000u64), symbol.to_string()],
            vec![],
        );
        let r = t
            .get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
        for to in [maker, taker] {
            let tx = t
                .transaction()
                .call_method(f, "take_free_coins", args![])
                .put_last_instruction_output_on_workspace("c")
                .call_method(to, "deposit", args![Workspace("c")]);
            cap.absorb(t.build_and_execute(tx, vec![]).expect_success());
        }
        r
    };
    let x = fungible(&mut t, &mut cap, "XXX");
    let y = fungible(&mut t, &mut cap, "YYY");
    let nft = |t: &mut TemplateTest,
               cap: &mut Capture,
               id: &str,
               symbol: &str,
               to: ComponentAddress|
     -> ResourceAddress {
        let f: ComponentAddress = t.call_function(
            "TestNftFaucet",
            "mint_one",
            args![NonFungibleId::from_string(id), symbol.to_string()],
            vec![],
        );
        let r = t
            .get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
        let tx = t
            .transaction()
            .call_method(f, "take_nft", args![])
            .put_last_instruction_output_on_workspace("n")
            .call_method(to, "deposit", args![Workspace("n")]);
        cap.absorb(t.build_and_execute(tx, vec![]).expect_success());
        r
    };
    let na = nft(&mut t, &mut cap, "art-1", "ARTA", maker);
    let nb = nft(&mut t, &mut cap, "art-2", "ARTB", taker);
    let tmpl = t.get_template_address("SwapOffer");
    let preimage = b"shadow-swap fixture preimage".to_vec();
    let lock: Hash32 = {
        use sha2::Digest;
        let d: [u8; 32] = sha2::Sha256::digest(&preimage).into();
        Hash32::from(d)
    };

    let create = |t: &mut TemplateTest,
                  cap: &mut Capture,
                  withdraw: tari_ootle_transaction::TransactionBuilder<
        tari_ootle_transaction::builder::MainIntent,
    >,
                  args: Vec<tari_ootle_transaction::builder::named_args::NamedArg>|
     -> ComponentAddress {
        let tx = withdraw
            .put_last_instruction_output_on_workspace("o")
            .call_function(tmpl, "create", args)
            .build_and_seal(&maker_key);
        let res = t.execute_expect_success(tx, vec![maker_proof.clone()]);
        let diff = res.expect_success();
        cap.absorb(diff);
        let offer = diff
            .up_iter()
            .find(|(id, s)| {
                id.is_component()
                    && *s.substate_value().component().unwrap().template_address() == tmpl
            })
            .map(|(id, _)| id.as_component_address().unwrap())
            .unwrap();
        let fresh: Vec<String> = diff
            .up_iter()
            .filter(|(id, s)| id.to_string().starts_with("vault_") && u64::from(s.version()) == 0)
            .map(|(id, _)| id.to_string())
            .collect();
        assert_eq!(
            fresh.len(),
            2,
            "create brings up exactly the escrow and proceeds vaults"
        );
        cap.vaults.insert(offer.to_string(), fresh);
        offer
    };

    let mut offers = vec![];
    // open_fungible
    let w = t
        .transaction()
        .call_method(maker, "withdraw", args![x, Amount::from(1_000u64)]);
    let a = create(
        &mut t,
        &mut cap,
        w,
        args![
            Workspace("o"),
            y,
            Amount::from(2_500u64),
            None::<NonFungibleId>,
            Some(taker_pk),
            Some(lock),
            1_000_000u64
        ],
    );
    offers.push(json!({ "name": "open_fungible", "component": a.to_string(), "substates": cap.snapshot(&a),
        "expect": { "status": "Open", "offered": { "kind": "fungible", "resource": x.to_string(), "amount": "1000" }, "requested": { "kind": "fungible", "resource": y.to_string(), "amount": "2500" },
                    "maker": hex(maker_pk.as_ref()), "designatedTaker": hex(taker_pk.as_ref()), "hashLock": hex(lock.as_ref()), "expiresAtEpoch": "1000000", "proceeds": "0" },
        "preimage": hex(&preimage) }));
    // open_nft
    let w = t.transaction().call_method(
        maker,
        "withdraw_non_fungible",
        args![na, NonFungibleId::from_string("art-1")],
    );
    let b = create(
        &mut t,
        &mut cap,
        w,
        args![
            Workspace("o"),
            nb,
            Amount::zero(),
            Some(NonFungibleId::from_string("art-2")),
            None::<RistrettoPublicKeyBytes>,
            None::<Hash32>,
            0u64
        ],
    );
    offers.push(json!({ "name": "open_nft", "component": b.to_string(), "substates": cap.snapshot(&b),
        "expect": { "status": "Open", "offered": { "kind": "nft", "resource": na.to_string(), "nftIds": ["str_art-1"] }, "requested": { "kind": "nft", "resource": nb.to_string(), "nftId": "str_art-2" },
                    "maker": hex(maker_pk.as_ref()), "designatedTaker": null, "hashLock": null, "expiresAtEpoch": "0", "proceeds": "0" } }));
    // filled: fill `a` with the preimage, as the designated taker
    let tx = t
        .transaction()
        .call_method(taker, "withdraw", args![y, Amount::from(2_500u64)])
        .put_last_instruction_output_on_workspace("p")
        .call_method(a, "fill", args![Workspace("p"), Some(preimage.clone())])
        .put_last_instruction_output_on_workspace("g")
        .call_method(taker, "deposit", args![Workspace("g")])
        .build_and_seal(&taker_key);
    cap.absorb(
        t.execute_expect_success(tx, vec![taker_proof.clone()])
            .expect_success(),
    );
    offers.push(json!({ "name": "filled", "component": a.to_string(), "substates": cap.snapshot(&a),
        "expect": { "status": "Filled", "offered": { "kind": "fungible", "resource": x.to_string(), "amount": "0" }, "requested": { "kind": "fungible", "resource": y.to_string(), "amount": "2500" },
                    "maker": hex(maker_pk.as_ref()), "designatedTaker": hex(taker_pk.as_ref()), "hashLock": hex(lock.as_ref()), "expiresAtEpoch": "1000000", "proceeds": "2500" } }));
    // cancelled: cancel `b`
    let tx = t
        .transaction()
        .call_method(b, "cancel", args![])
        .put_last_instruction_output_on_workspace("r")
        .call_method(maker, "deposit", args![Workspace("r")])
        .build_and_seal(&maker_key);
    cap.absorb(
        t.execute_expect_success(tx, vec![maker_proof.clone()])
            .expect_success(),
    );
    offers.push(json!({ "name": "cancelled", "component": b.to_string(), "substates": cap.snapshot(&b),
        "expect": { "status": "Cancelled", "offered": { "kind": "nft", "resource": na.to_string(), "nftIds": [] }, "requested": { "kind": "nft", "resource": nb.to_string(), "nftId": "str_art-2" },
                    "maker": hex(maker_pk.as_ref()), "designatedTaker": null, "hashLock": null, "expiresAtEpoch": "0", "proceeds": "0" } }));

    json!({
        "cohort": COHORT,
        "generatedBy": "audit_engine_tests/tests/swapoffer_wire_v048.rs (SHADOW_SWAP_WRITE_WIRE_FIXTURES=1)",
        "note": "TemplateTest addresses. They identify nothing on Esmeralda and must never seed a registry.",
        "template": tmpl.to_string(),
        "maker": { "account": maker.to_string(), "publicKey": hex(maker_pk.as_ref()) },
        "taker": { "account": taker.to_string(), "publicKey": hex(taker_pk.as_ref()) },
        "offers": offers,
    })
}
