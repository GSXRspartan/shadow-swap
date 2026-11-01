// Ootle v0.48 INSTRUCTION WIRE FIXTURES, produced and EXECUTED by the real engine.
//
// The browser never signs. It hands the wallet a JSON instruction list (Sapient:
// `tari_createTransactionRequest { kind: "instructions", instructions }`; walletd-relayed
// accounts reach the same Rust `Instruction` serde). Those instructions are only correct if
// they are byte-for-byte the serde JSON of `tari_ootle_transaction::Instruction` at the
// pinned cohort:
//
//   * every non-workspace argument is `{"Literal": "<hex of the tari_bor CBOR encoding>"}`
//     (`InstructionArg::Literal`, crates/transaction/src/args.rs) -- never a bare string;
//   * a workspace argument is `{"Workspace": {"id": n, "offset": null|k}}`;
//   * there is NO max-epoch instruction: `max_epoch` is a field of the unsigned transaction,
//     which the wallet sets when it builds and signs.
//
// This test builds, with the upstream Rust builder, the exact transaction shape of every
// operation the browser constructs, serialises it to JSON, DESERIALISES that JSON back into
// `Vec<Instruction>`, and executes the deserialised list in the engine. Each scenario records
// the parameters it used, so the web suite (apps/web/test/instruction-wire-v048.test.cjs) can
// feed the same parameters through the browser's own builders and serializer and require the
// identical JSON. That closes the chain: browser JSON == engine JSON, and engine JSON executes.
//
// Literal encodings of FIXED values are deterministic; in default (CI) mode they are compared
// against the committed fixture, so a cohort bump that changes an encoding fails here.
// Scenario addresses are TemplateTest addresses (random keys) and identify nothing on any
// network; they are regenerated only with SHADOW_SWAP_WRITE_WIRE_FIXTURES=1.

use std::str::FromStr;

use serde_json::{json, Value};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::{args, Instruction, Network, Transaction};
use tari_template_lib::types::{
    crypto::RistrettoPublicKeyBytes, Amount, ComponentAddress, Hash32, NonFungibleAddress,
    NonFungibleId, ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const FIXTURE_PATH: &str = "../apps/web/test/fixtures/ootle-v048-instructions.json";
const COHORT: &str = "tari-ootle v0.48.0 (6a25dbc524581bfaa0a3c6ef120f8d59cc827572)";

const FIXED_RESOURCE: &str =
    "resource_7e0d2b7f4c1a9e8d6b5a4c3d2e1f00112233445566778899aabbccddeeff0011";
const FIXED_COMPONENT: &str =
    "component_a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
const FIXED_HASH: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const FIXED_KEY: &str = "e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn instructions_json(instructions: &[Instruction]) -> Value {
    serde_json::to_value(instructions).expect("Instruction serialises")
}

/// JSON -> Vec<Instruction>, asserting the round trip is lossless. What executes below is the
/// DESERIALISED list, i.e. exactly what a wallet would reconstruct from the browser's JSON.
fn from_json(value: &Value) -> Vec<Instruction> {
    let back: Vec<Instruction> =
        serde_json::from_value(value.clone()).expect("instruction JSON deserialises");
    assert_eq!(
        instructions_json(&back),
        *value,
        "instruction JSON must round-trip losslessly"
    );
    back
}

/// The literal encoding of one argument, read off a real builder instruction.
fn literal_of(builder_args: Vec<tari_ootle_transaction::builder::named_args::NamedArg>) -> String {
    let instructions = Transaction::builder(Network::LocalNet, tari_ootle_transaction::Epoch(0))
        .call_method(
            ComponentAddress::from_str(FIXED_COMPONENT).unwrap(),
            "m",
            builder_args,
        )
        .into_instructions();
    let v = instructions_json(&instructions);
    v[0]["CallMethod"]["args"][0]["Literal"]
        .as_str()
        .unwrap_or_else(|| panic!("expected a Literal argument, got {v}"))
        .to_string()
}

fn literal_cases() -> Vec<Value> {
    let res = ResourceAddress::from_str(FIXED_RESOURCE).unwrap();
    let comp = ComponentAddress::from_str(FIXED_COMPONENT).unwrap();
    let hash = Hash32::from_hex(FIXED_HASH).unwrap();
    let key = RistrettoPublicKeyBytes::from_hex(FIXED_KEY).unwrap();
    let uuid = NonFungibleId::from_u256([0xab; 32]);
    let preimage: Vec<u8> = b"shadow-swap preimage".to_vec();
    let big = Amount::from(u128::from(u64::MAX) + 1);
    let huge = Amount::from(u128::MAX >> 1);
    let mut out = vec![];
    let mut case = |ty: &str, value: Value, lit: String| {
        out.push(json!({ "type": ty, "value": value, "hex": lit }));
    };
    case(
        "ResourceAddress",
        json!(FIXED_RESOURCE),
        literal_of(args![res]),
    );
    case(
        "ComponentAddress",
        json!(FIXED_COMPONENT),
        literal_of(args![comp]),
    );
    for a in [
        0u64,
        1,
        23,
        24,
        30,
        255,
        256,
        65_535,
        65_536,
        1_000_000,
        u64::MAX,
    ] {
        case(
            "Amount",
            json!(a.to_string()),
            literal_of(args![Amount::from(a)]),
        );
    }
    case("Amount", json!(big.to_string()), literal_of(args![big]));
    case("Amount", json!(huge.to_string()), literal_of(args![huge]));
    case("u16", json!("30"), literal_of(args![30u16]));
    case("u64", json!("0"), literal_of(args![0u64]));
    case(
        "u64",
        json!("4294967296"),
        literal_of(args![4_294_967_296u64]),
    );
    case(
        "u64",
        json!(u64::MAX.to_string()),
        literal_of(args![u64::MAX]),
    );
    case("bool", json!(true), literal_of(args![true]));
    case("bool", json!(false), literal_of(args![false]));
    case("String", json!("T0"), literal_of(args!["T0".to_string()]));
    case("Hash32", json!(FIXED_HASH), literal_of(args![hash]));
    case("PublicKey", json!(FIXED_KEY), literal_of(args![key]));
    case(
        "Bytes",
        json!(hex(&preimage)),
        literal_of(args![preimage.clone()]),
    );
    case(
        "NonFungibleId",
        json!("str_art-1"),
        literal_of(args![NonFungibleId::from_string("art-1")]),
    );
    case(
        "NonFungibleId",
        json!(uuid.to_canonical_string()),
        literal_of(args![uuid.clone()]),
    );
    case(
        "NonFungibleId",
        json!("u32_7"),
        literal_of(args![NonFungibleId::from_u32(7)]),
    );
    case(
        "NonFungibleId",
        json!(format!("u64_{}", u64::MAX)),
        literal_of(args![NonFungibleId::from_u64(u64::MAX)]),
    );
    case(
        "Option<NonFungibleId>",
        Value::Null,
        literal_of(args![None::<NonFungibleId>]),
    );
    case(
        "Option<NonFungibleId>",
        json!("str_art-2"),
        literal_of(args![Some(NonFungibleId::from_string("art-2"))]),
    );
    case(
        "Option<PublicKey>",
        Value::Null,
        literal_of(args![None::<RistrettoPublicKeyBytes>]),
    );
    case(
        "Option<PublicKey>",
        json!(FIXED_KEY),
        literal_of(args![Some(key)]),
    );
    case(
        "Option<Hash32>",
        Value::Null,
        literal_of(args![None::<Hash32>]),
    );
    case(
        "Option<Hash32>",
        json!(FIXED_HASH),
        literal_of(args![Some(hash)]),
    );
    case(
        "Option<Bytes>",
        Value::Null,
        literal_of(args![None::<Vec<u8>>]),
    );
    case(
        "Option<Bytes>",
        json!(hex(&preimage)),
        literal_of(args![Some(preimage)]),
    );
    out
}

// ---------------------------------------------------------------------------------------------
// Executed scenarios
// ---------------------------------------------------------------------------------------------

struct World {
    t: TemplateTest,
    alice: ComponentAddress,
    alice_proof: NonFungibleAddress,
    alice_key: tari_crypto::ristretto::RistrettoSecretKey,
    bob: ComponentAddress,
    bob_proof: NonFungibleAddress,
    bob_key: tari_crypto::ristretto::RistrettoSecretKey,
}

fn world() -> World {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/fungible_pool",
            "../templates/p2p_offer",
            "../templates/nft_marketplace",
            "../templates/revealed_asset_pool",
            "../templates/cross_layer_htlc",
            "templates/faucet",
            "templates/nft_faucet",
            "templates/stealth_probe",
        ],
    );
    t.enable_auto_add_proofs_from_signers();
    let (alice, alice_proof, alice_key) = t.create_funded_account();
    let (bob, bob_proof, bob_key) = t.create_funded_account();
    World {
        t,
        alice,
        alice_proof,
        alice_key,
        bob,
        bob_proof,
        bob_key,
    }
}

fn fungible(w: &mut World, symbol: &str) -> ResourceAddress {
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
    for to in [w.alice, w.bob] {
        let tx =
            w.t.transaction()
                .call_method(f, "take_free_coins", args![])
                .put_last_instruction_output_on_workspace("c")
                .call_method(to, "deposit", args![Workspace("c")]);
        w.t.build_and_execute(tx, vec![]).expect_success();
    }
    r
}

/// Mints ONE NFT `id` straight into `to`'s account.
fn nft_into(w: &mut World, id: &str, symbol: &str, to: ComponentAddress) -> ResourceAddress {
    let f: ComponentAddress = w.t.call_function(
        "TestNftFaucet",
        "mint_one",
        args![NonFungibleId::from_string(id), symbol.to_string()],
        vec![],
    );
    let r =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    let tx =
        w.t.transaction()
            .call_method(f, "take_nft", args![])
            .put_last_instruction_output_on_workspace("n")
            .call_method(to, "deposit", args![Workspace("n")]);
    w.t.build_and_execute(tx, vec![]).expect_success();
    r
}

fn balance(w: &mut World, account: ComponentAddress, r: ResourceAddress) -> u128 {
    let a: Amount = w.t.call_method(account, "balance", args![r], vec![]);
    a.to_u128()
}

enum Who {
    Alice,
    Bob,
}

/// Serialise -> deserialise -> execute. Returns the JSON that executed.
fn run(
    w: &mut World,
    who: Who,
    instructions: Vec<Instruction>,
) -> (Value, tari_engine_types::commit_result::ExecuteResult) {
    let json = instructions_json(&instructions);
    let back = from_json(&json);
    let (key, proof) = match who {
        Who::Alice => (w.alice_key.clone(), w.alice_proof.clone()),
        Who::Bob => (w.bob_key.clone(), w.bob_proof.clone()),
    };
    let tx =
        w.t.transaction()
            .with_instructions(back)
            .build_and_seal(&key);
    let result = w.t.execute_expect_success(tx, vec![proof]);
    (json, result)
}

fn created_component(
    result: &tari_engine_types::commit_result::ExecuteResult,
    template: tari_template_lib::types::TemplateAddress,
) -> ComponentAddress {
    result
        .expect_success()
        .up_iter()
        .find(|(id, s)| {
            id.is_component()
                && *s.substate_value().component().unwrap().template_address() == template
        })
        .map(|(id, _)| id.as_component_address().unwrap())
        .expect("the transaction created the component")
}

fn s(v: impl ToString) -> Value {
    Value::String(v.to_string())
}

fn scenarios() -> Vec<Value> {
    let mut w = world();
    let (alice, bob) = (w.alice, w.bob);
    let x = fungible(&mut w, "XXX");
    let y = fungible(&mut w, "YYY");
    let z = fungible(&mut w, "ZZZ");
    let pool_template = w.t.get_template_address("Pool");
    let offer_template = w.t.get_template_address("SwapOffer");
    let listing_template = w.t.get_template_address("FixedPriceListing");
    let mut out = vec![];

    // 1. create_pool: Pool::new -> workspace component -> add_liquidity -> deposit LP (m06 shape).
    let ins =
        w.t.transaction()
            .call_function(pool_template, "new", args![x, y, 30u16])
            .put_last_instruction_output_on_workspace("new_pool")
            .call_method(alice, "withdraw", args![x, Amount::from(4_000_000u64)])
            .put_last_instruction_output_on_workspace("a")
            .call_method(alice, "withdraw", args![y, Amount::from(9_000_000u64)])
            .put_last_instruction_output_on_workspace("b")
            .call_method(
                "new_pool",
                "add_liquidity",
                args![Workspace("a"), Workspace("b")],
            )
            .put_last_instruction_output_on_workspace("lp")
            .call_method(alice, "deposit", args![Workspace("lp")])
            .into_instructions();
    let (json, result) = run(&mut w, Who::Alice, ins);
    let pool_xy = created_component(&result, pool_template);
    let lp: ResourceAddress = w.t.call_method(pool_xy, "lp_resource", args![], vec![]);
    assert_eq!(balance(&mut w, alice, lp), 6_000_000 - 1_000);
    out.push(json!({
        "name": "create_pool",
        "params": { "poolTemplateAddress": hex(pool_template.as_ref()), "accountAddress": s(alice), "resourceA": s(x), "resourceB": s(y), "rawAmountA": "4000000", "rawAmountB": "9000000", "feeBps": 30 },
        "instructions": json,
    }));

    // A second pool for the multi-hop scenario, created the same way (not recorded).
    let ins =
        w.t.transaction()
            .call_function(pool_template, "new", args![y, z, 30u16])
            .put_last_instruction_output_on_workspace("p")
            .call_method(alice, "withdraw", args![y, Amount::from(5_000_000u64)])
            .put_last_instruction_output_on_workspace("a")
            .call_method(alice, "withdraw", args![z, Amount::from(5_000_000u64)])
            .put_last_instruction_output_on_workspace("b")
            .call_method("p", "add_liquidity", args![Workspace("a"), Workspace("b")])
            .put_last_instruction_output_on_workspace("lp")
            .call_method(alice, "deposit", args![Workspace("lp")])
            .into_instructions();
    let (_, result) = run(&mut w, Who::Alice, ins);
    let pool_yz = created_component(&result, pool_template);

    // 2. add_liquidity
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![x, Amount::from(40_000u64)])
            .put_last_instruction_output_on_workspace("a")
            .call_method(bob, "withdraw", args![y, Amount::from(90_000u64)])
            .put_last_instruction_output_on_workspace("b")
            .call_method(
                pool_xy,
                "add_liquidity",
                args![Workspace("a"), Workspace("b")],
            )
            .put_last_instruction_output_on_workspace("lp")
            .call_method(bob, "deposit", args![Workspace("lp")])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Bob, ins);
    let bob_lp = balance(&mut w, bob, lp);
    assert!(bob_lp > 0, "LP deposited into the account");
    out.push(json!({
        "name": "add_liquidity",
        "params": { "poolComponent": s(pool_xy), "accountAddress": s(bob), "resourceA": s(x), "resourceB": s(y), "rawAmountA": "40000", "rawAmountB": "90000" },
        "instructions": json,
    }));

    // 3. swap
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![x, Amount::from(10_000u64)])
            .put_last_instruction_output_on_workspace("swap_input")
            .call_method(
                pool_xy,
                "swap",
                args![Workspace("swap_input"), y, Amount::from(1u64)],
            )
            .put_last_instruction_output_on_workspace("swap_output")
            .call_method(bob, "deposit", args![Workspace("swap_output")])
            .into_instructions();
    let y0 = balance(&mut w, bob, y);
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert!(
        balance(&mut w, bob, y) > y0,
        "swap output deposited into the account"
    );
    out.push(json!({
        "name": "swap",
        "params": { "poolComponent": s(pool_xy), "accountAddress": s(bob), "inputResource": s(x), "outputResource": s(y), "rawInputAmount": "10000", "minOutput": "1" },
        "instructions": json,
    }));

    // 4. multi_hop_swap X -> Y -> Z, intermediate min 1
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![x, Amount::from(10_000u64)])
            .put_last_instruction_output_on_workspace("route_0")
            .call_method(
                pool_xy,
                "swap",
                args![Workspace("route_0"), y, Amount::from(1u64)],
            )
            .put_last_instruction_output_on_workspace("route_1")
            .call_method(
                pool_yz,
                "swap",
                args![Workspace("route_1"), z, Amount::from(2u64)],
            )
            .put_last_instruction_output_on_workspace("route_2")
            .call_method(bob, "deposit", args![Workspace("route_2")])
            .into_instructions();
    let z0 = balance(&mut w, bob, z);
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert!(balance(&mut w, bob, z) > z0);
    out.push(json!({
        "name": "multi_hop_swap",
        "params": { "accountAddress": s(bob), "rawInputAmount": "10000", "minOutput": "2", "hops": [
            { "poolComponent": s(pool_xy), "inputResource": s(x), "outputResource": s(y) },
            { "poolComponent": s(pool_yz), "inputResource": s(y), "outputResource": s(z) } ] },
        "instructions": json,
    }));

    // 5. remove_liquidity: the (Bucket, Bucket) tuple is deposited element by element.
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![lp, Amount::from(bob_lp)])
            .put_last_instruction_output_on_workspace("remove_liquidity_lp")
            .call_method(
                pool_xy,
                "remove_liquidity",
                args![Workspace("remove_liquidity_lp")],
            )
            .put_last_instruction_output_on_workspace("remove_liquidity_out")
            .call_method(bob, "deposit", args![Workspace("remove_liquidity_out.0")])
            .call_method(bob, "deposit", args![Workspace("remove_liquidity_out.1")])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert_eq!(balance(&mut w, bob, lp), 0);
    out.push(json!({
        "name": "remove_liquidity",
        "params": { "poolComponent": s(pool_xy), "accountAddress": s(bob), "lpResource": s(lp), "rawLpAmount": bob_lp.to_string() },
        "instructions": json,
    }));

    // 6. swap_offer_create (fungible, designated taker, hash lock, expiry)
    let bob_pk: RistrettoPublicKeyBytes = {
        use ootle_byte_type::ToByteType;
        use tari_crypto::keys::PublicKey as _;
        tari_crypto::ristretto::RistrettoPublicKey::from_secret_key(&w.bob_key).to_byte_type()
    };
    let preimage = b"shadow-swap wire preimage".to_vec();
    let lock = {
        use sha2::Digest;
        let d: [u8; 32] = sha2::Sha256::digest(&preimage).into();
        Hash32::from(d)
    };
    let ins =
        w.t.transaction()
            .call_method(alice, "withdraw", args![x, Amount::from(1_000u64)])
            .put_last_instruction_output_on_workspace("offer_escrow")
            .call_function(
                offer_template,
                "create",
                args![
                    Workspace("offer_escrow"),
                    y,
                    Amount::from(2_500u64),
                    None::<NonFungibleId>,
                    Some(bob_pk),
                    Some(lock),
                    1_000_000u64
                ],
            )
            .into_instructions();
    let (json, result) = run(&mut w, Who::Alice, ins);
    let offer = created_component(&result, offer_template);
    out.push(json!({
        "name": "swap_offer_create",
        "params": { "offerTemplateAddress": hex(offer_template.as_ref()), "accountAddress": s(alice), "offered": { "kind": "fungible", "resource": s(x), "amount": "1000" },
                    "requested": { "kind": "fungible", "resource": s(y), "amount": "2500" }, "designatedTaker": hex(bob_pk.as_ref()), "hashLock": hex(lock.as_ref()), "expiresAtEpoch": "1000000" },
        "instructions": json,
    }));

    // 7. swap_offer_fill (with preimage) -> the offered asset is deposited into the taker's account.
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![y, Amount::from(2_500u64)])
            .put_last_instruction_output_on_workspace("offer_payment")
            .call_method(
                offer,
                "fill",
                args![Workspace("offer_payment"), Some(preimage.clone())],
            )
            .put_last_instruction_output_on_workspace("offer_received")
            .call_method(bob, "deposit", args![Workspace("offer_received")])
            .into_instructions();
    let x0 = balance(&mut w, bob, x);
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert_eq!(balance(&mut w, bob, x) - x0, 1_000);
    out.push(json!({
        "name": "swap_offer_fill",
        "params": { "offerComponent": s(offer), "accountAddress": s(bob), "payment": { "kind": "fungible", "resource": s(y), "amount": "2500" }, "preimage": hex(&preimage) },
        "instructions": json,
    }));

    // 8. swap_offer_claim -> proceeds deposited into the maker's account.
    let ins =
        w.t.transaction()
            .call_method(offer, "claim", args![])
            .put_last_instruction_output_on_workspace("offer_proceeds")
            .call_method(alice, "deposit", args![Workspace("offer_proceeds")])
            .into_instructions();
    let ya = balance(&mut w, alice, y);
    let (json, _) = run(&mut w, Who::Alice, ins);
    assert_eq!(balance(&mut w, alice, y) - ya, 2_500);
    out.push(json!({ "name": "swap_offer_claim", "params": { "offerComponent": s(offer), "accountAddress": s(alice) }, "instructions": json }));

    // 9. NFT barter: maker escrows an NFT (withdraw_non_fungible) and wants a SPECIFIC NFT.
    let na = nft_into(&mut w, "art-1", "ARTA", alice);
    let nb = nft_into(&mut w, "art-2", "ARTB", bob);
    let ins =
        w.t.transaction()
            .call_method(
                alice,
                "withdraw_non_fungible",
                args![na, NonFungibleId::from_string("art-1")],
            )
            .put_last_instruction_output_on_workspace("offer_escrow")
            .call_function(
                offer_template,
                "create",
                args![
                    Workspace("offer_escrow"),
                    nb,
                    Amount::zero(),
                    Some(NonFungibleId::from_string("art-2")),
                    None::<RistrettoPublicKeyBytes>,
                    None::<Hash32>,
                    0u64
                ],
            )
            .into_instructions();
    let (json, result) = run(&mut w, Who::Alice, ins);
    let barter = created_component(&result, offer_template);
    out.push(json!({
        "name": "swap_offer_create_nft",
        "params": { "offerTemplateAddress": hex(offer_template.as_ref()), "accountAddress": s(alice), "offered": { "kind": "nft", "resource": s(na), "nftId": "str_art-1" },
                    "requested": { "kind": "nft", "resource": s(nb), "nftId": "str_art-2" }, "designatedTaker": null, "hashLock": null, "expiresAtEpoch": "0" },
        "instructions": json,
    }));
    let ins =
        w.t.transaction()
            .call_method(
                bob,
                "withdraw_non_fungible",
                args![nb, NonFungibleId::from_string("art-2")],
            )
            .put_last_instruction_output_on_workspace("offer_payment")
            .call_method(
                barter,
                "fill",
                args![Workspace("offer_payment"), None::<Vec<u8>>],
            )
            .put_last_instruction_output_on_workspace("offer_received")
            .call_method(bob, "deposit", args![Workspace("offer_received")])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert_eq!(
        balance(&mut w, bob, na),
        1,
        "the maker's NFT, same resource, now in the taker's account"
    );
    out.push(json!({
        "name": "swap_offer_fill_nft",
        "params": { "offerComponent": s(barter), "accountAddress": s(bob), "payment": { "kind": "nft", "resource": s(nb), "nftId": "str_art-2" }, "preimage": null },
        "instructions": json,
    }));

    // 10. swap_offer_cancel -> escrow deposited back to the maker.
    let ins =
        w.t.transaction()
            .call_method(alice, "withdraw", args![z, Amount::from(777u64)])
            .put_last_instruction_output_on_workspace("offer_escrow")
            .call_function(
                offer_template,
                "create",
                args![
                    Workspace("offer_escrow"),
                    x,
                    Amount::from(1u64),
                    None::<NonFungibleId>,
                    None::<RistrettoPublicKeyBytes>,
                    None::<Hash32>,
                    0u64
                ],
            )
            .into_instructions();
    let (_, result) = run(&mut w, Who::Alice, ins);
    let to_cancel = created_component(&result, offer_template);
    let za = balance(&mut w, alice, z);
    let ins =
        w.t.transaction()
            .call_method(to_cancel, "cancel", args![])
            .put_last_instruction_output_on_workspace("offer_refund")
            .call_method(alice, "deposit", args![Workspace("offer_refund")])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Alice, ins);
    assert_eq!(balance(&mut w, alice, z) - za, 777);
    out.push(json!({ "name": "swap_offer_cancel", "params": { "offerComponent": s(to_cancel), "accountAddress": s(alice) }, "instructions": json }));

    // 10b. RevealedAssetPool: a SEPARATE pool for revealed-value private-typed assets. The
    //      stealth probe's resource is created-Stealth, which Pool v2 refuses.
    let rev_template = w.t.get_template_address("RevealedAssetPool");
    let probe: ComponentAddress = w.t.call_function(
        "StealthProbe",
        "new",
        args![Amount::from(1_000_000_000u64)],
        vec![],
    );
    let pstl =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    for to in [alice, bob] {
        let tx =
            w.t.transaction()
                .call_method(probe, "take", args![Amount::from(200_000_000u64)])
                .put_last_instruction_output_on_workspace("s")
                .call_method(to, "deposit", args![Workspace("s")]);
        w.t.build_and_execute(tx, vec![]).expect_success();
    }

    // create_revealed_pool: new -> workspace -> withdraw both -> add_liquidity -> deposit x3.
    let ins =
        w.t.transaction()
            .call_function(rev_template, "new", args![pstl, x, 30u16])
            .put_last_instruction_output_on_workspace("new_revealed_pool")
            .call_method(alice, "withdraw", args![pstl, Amount::from(100_000_000u64)])
            .put_last_instruction_output_on_workspace("revealed_create_a")
            .call_method(alice, "withdraw", args![x, Amount::from(50_000_000u64)])
            .put_last_instruction_output_on_workspace("revealed_create_b")
            .call_method(
                "new_revealed_pool",
                "add_liquidity",
                args![
                    Workspace("revealed_create_a"),
                    Workspace("revealed_create_b"),
                    Amount::zero()
                ],
            )
            .put_last_instruction_output_on_workspace("revealed_create_out")
            .call_method(alice, "deposit", args![Workspace("revealed_create_out.0")])
            .call_method(alice, "deposit", args![Workspace("revealed_create_out.1")])
            .call_method(alice, "deposit", args![Workspace("revealed_create_out.2")])
            .into_instructions();
    let (json, result) = run(&mut w, Who::Alice, ins);
    let rev_pool = created_component(&result, rev_template);
    out.push(json!({
        "name": "create_revealed_pool",
        "params": { "poolTemplateAddress": hex(rev_template.as_ref()), "accountAddress": s(alice), "resourceA": s(pstl), "resourceB": s(x), "rawAmountA": "100000000", "rawAmountB": "50000000", "feeBps": 30 },
        "instructions": json,
    }));

    // revealed_swap: the created-Stealth asset is the INPUT, so this is the shape a Sapient
    // seed account wraps in withdrawStealthAndExecute.
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![pstl, Amount::from(1_000_000u64)])
            .put_last_instruction_output_on_workspace("revealed_swap_input")
            .call_method(
                rev_pool,
                "swap",
                args![Workspace("revealed_swap_input"), x, Amount::from(1u64)],
            )
            .put_last_instruction_output_on_workspace("revealed_swap_output")
            .call_method(bob, "deposit", args![Workspace("revealed_swap_output")])
            .into_instructions();
    let x0 = balance(&mut w, bob, x);
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert!(
        balance(&mut w, bob, x) > x0,
        "the revealed-pool swap paid out"
    );
    out.push(json!({
        "name": "revealed_swap",
        "params": { "poolComponent": s(rev_pool), "accountAddress": s(bob), "inputResource": s(pstl), "outputResource": s(x), "rawInputAmount": "1000000", "minOutput": "1" },
        "instructions": json,
    }));

    // revealed_add_liquidity: three outputs, all deposited (refunds may be empty).
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![pstl, Amount::from(10_000_000u64)])
            .put_last_instruction_output_on_workspace("revealed_add_a")
            .call_method(bob, "withdraw", args![x, Amount::from(10_000_000u64)])
            .put_last_instruction_output_on_workspace("revealed_add_b")
            .call_method(
                rev_pool,
                "add_liquidity",
                args![
                    Workspace("revealed_add_a"),
                    Workspace("revealed_add_b"),
                    Amount::from(1u64)
                ],
            )
            .put_last_instruction_output_on_workspace("revealed_add_out")
            .call_method(bob, "deposit", args![Workspace("revealed_add_out.0")])
            .call_method(bob, "deposit", args![Workspace("revealed_add_out.1")])
            .call_method(bob, "deposit", args![Workspace("revealed_add_out.2")])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Bob, ins);
    let rev_lp: ResourceAddress = w.t.call_method(rev_pool, "lp_resource", args![], vec![]);
    let bob_rev_lp = balance(&mut w, bob, rev_lp);
    assert!(bob_rev_lp > 0, "LP minted to the depositor");
    out.push(json!({
        "name": "revealed_add_liquidity",
        "params": { "poolComponent": s(rev_pool), "accountAddress": s(bob), "resourceA": s(pstl), "resourceB": s(x), "rawAmountA": "10000000", "rawAmountB": "10000000", "minLpOut": "1" },
        "instructions": json,
    }));

    // revealed_remove_liquidity: on-chain exit minimums, both sides deposited.
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![rev_lp, Amount::from(bob_rev_lp)])
            .put_last_instruction_output_on_workspace("revealed_remove_lp")
            .call_method(
                rev_pool,
                "remove_liquidity",
                args![
                    Workspace("revealed_remove_lp"),
                    Amount::from(1u64),
                    Amount::from(1u64)
                ],
            )
            .put_last_instruction_output_on_workspace("revealed_remove_out")
            .call_method(bob, "deposit", args![Workspace("revealed_remove_out.0")])
            .call_method(bob, "deposit", args![Workspace("revealed_remove_out.1")])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert_eq!(
        balance(&mut w, bob, rev_lp),
        0,
        "the whole LP position was burned"
    );
    out.push(json!({
        "name": "revealed_remove_liquidity",
        "params": { "poolComponent": s(rev_pool), "accountAddress": s(bob), "lpResource": s(rev_lp), "rawLpAmount": bob_rev_lp.to_string(), "minA": "1", "minB": "1" },
        "instructions": json,
    }));

    // ---------------------------------------------------------------------------------------
    // Cross-layer HTLC: the L2 leg of an exchange against existing L1 XTM.
    //
    // These three scenarios exist so the BROWSER's instruction JSON can be compared byte for
    // byte against instructions this engine actually executed. An advertised wallet capability
    // is not evidence that a transaction executes; a matching wire format against a real
    // execution is.
    // ---------------------------------------------------------------------------------------
    let htlc_template = w.t.get_template_address("CrossLayerHtlc");
    // The hash Minotari commits to is SHA-256 over the 32 preimage bytes. A fixed pair here, so
    // the fixture is deterministic and the browser can be checked against the same values.
    let cl_preimage: Vec<u8> = (1u8..=32).collect();
    let cl_hash = {
        use sha2::{Digest, Sha256};
        let d: [u8; 32] = Sha256::digest(&cl_preimage).into();
        Hash32::from_array(d)
    };
    let cl_claimant: RistrettoPublicKeyBytes = {
        use ootle_byte_type::ToByteType;
        use tari_crypto::keys::PublicKey as _;
        tari_crypto::ristretto::RistrettoPublicKey::from_secret_key(&w.bob_key).to_byte_type()
    };
    let cl_leg = "ab00000000000000000000000000000000000000000000000000000000000001".to_string();
    let cl_expiry = 50u64;

    // fund: withdraw -> workspace -> fund(...) . The component is the only output, so there is
    // nothing to deposit; the escrow holds the asset until a claim or a refund.
    let ins =
        w.t.transaction()
            .call_method(alice, "withdraw", args![x, Amount::from(1_000_000u64)])
            .put_last_instruction_output_on_workspace("cross_layer_escrow")
            .call_function(
                htlc_template,
                "fund",
                args![
                    Workspace("cross_layer_escrow"),
                    cl_hash,
                    cl_claimant,
                    cl_expiry,
                    cl_leg.clone()
                ],
            )
            .into_instructions();
    let (json, result) = run(&mut w, Who::Alice, ins);
    let htlc = created_component(&result, htlc_template);
    out.push(json!({
        "name": "cross_layer_fund",
        "params": {
            "templateAddress": hex(htlc_template.as_ref()),
            "accountAddress": s(alice),
            "resourceAddress": s(x),
            "rawAmount": "1000000",
            "hashLockHex": hex(cl_hash.as_ref()),
            "claimantPublicKeyHex": hex(cl_claimant.as_bytes()),
            "expiresAtEpoch": cl_expiry,
            "counterpartyLeg": cl_leg,
        },
        "instructions": json,
    }));

    // claim: the claimant reveals the preimage and deposits the escrowed asset.
    let ins =
        w.t.transaction()
            .call_method(htlc, "claim", args![cl_preimage.clone()])
            .put_last_instruction_output_on_workspace("cross_layer_claim")
            .call_method(bob, "deposit", args![Workspace("cross_layer_claim")])
            .into_instructions();
    let x_before = balance(&mut w, bob, x);
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert!(
        balance(&mut w, bob, x) > x_before,
        "the cross-layer claim paid the claimant"
    );
    out.push(json!({
        "name": "cross_layer_claim",
        "params": {
            "htlcComponent": s(htlc),
            "accountAddress": s(bob),
            "preimageHex": hex(&cl_preimage),
        },
        "instructions": json,
    }));

    // refund: a SECOND escrow, left unclaimed past its expiry, recovered by its funder.
    let ins =
        w.t.transaction()
            .call_method(alice, "withdraw", args![x, Amount::from(250_000u64)])
            .put_last_instruction_output_on_workspace("cross_layer_escrow")
            .call_function(
                htlc_template,
                "fund",
                args![
                    Workspace("cross_layer_escrow"),
                    cl_hash,
                    cl_claimant,
                    cl_expiry,
                    cl_leg.clone()
                ],
            )
            .into_instructions();
    let (_json, result) = run(&mut w, Who::Alice, ins);
    let stale = created_component(&result, htlc_template);
    // Past the deadline the claim window is closed and only the funder may recover it.
    w.t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(cl_expiry),
    );
    let ins =
        w.t.transaction()
            .call_method(stale, "refund", args![])
            .put_last_instruction_output_on_workspace("cross_layer_refund")
            .call_method(alice, "deposit", args![Workspace("cross_layer_refund")])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Alice, ins);
    out.push(json!({
        "name": "cross_layer_refund",
        "params": { "htlcComponent": s(stale), "accountAddress": s(alice) },
        "instructions": json,
    }));

    // mixed_multi_hop_swap: a created-Stealth asset reaches a purely public one by crossing a
    // REVEALED-value pool and a public Pool v2 in ONE transaction.
    //
    // Both templates expose the same `swap(Bucket, ResourceAddress, Amount)`, so the
    // instruction list is the ordinary multi-hop shape and the venues are indistinguishable
    // on the wire — which is exactly why the browser must name each hop's venue from its own
    // template address and disclose it. Note only the INPUT needs a Stealth-capable
    // withdrawal: every intermediate stays on the workspace.
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![pstl, Amount::from(1_000_000u64)])
            .put_last_instruction_output_on_workspace("route_0")
            .call_method(
                rev_pool,
                "swap",
                args![Workspace("route_0"), x, Amount::from(1u64)],
            )
            .put_last_instruction_output_on_workspace("route_1")
            .call_method(
                pool_xy,
                "swap",
                args![Workspace("route_1"), y, Amount::from(2u64)],
            )
            .put_last_instruction_output_on_workspace("route_2")
            .call_method(bob, "deposit", args![Workspace("route_2")])
            .into_instructions();
    let mixed_y0 = balance(&mut w, bob, y);
    let mixed_pstl0 = balance(&mut w, bob, pstl);
    let mixed_x0 = balance(&mut w, bob, x);
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert!(
        balance(&mut w, bob, y) > mixed_y0,
        "the mixed route paid out in the public resource"
    );
    assert_eq!(
        balance(&mut w, bob, pstl),
        mixed_pstl0 - 1_000_000,
        "exactly the routed amount left the Stealth-typed balance"
    );
    assert_eq!(
        balance(&mut w, bob, x),
        mixed_x0,
        "the intermediate resource never reached the account"
    );
    out.push(json!({
        "name": "mixed_multi_hop_swap",
        "params": { "accountAddress": s(bob), "rawInputAmount": "1000000", "minOutput": "2", "hops": [
            { "poolComponent": s(rev_pool), "inputResource": s(pstl), "outputResource": s(x), "venue": "REVEALED" },
            { "poolComponent": s(pool_xy), "inputResource": s(x), "outputResource": s(y), "venue": "PUBLIC" } ] },
        "instructions": json,
    }));

    // 11. Marketplace listing via withdraw_non_fungible (the browser's NFT withdrawal).
    let nc = nft_into(&mut w, "art-3", "ARTC", alice);
    let ins =
        w.t.transaction()
            .call_method(
                alice,
                "withdraw_non_fungible",
                args![nc, NonFungibleId::from_string("art-3")],
            )
            .put_last_instruction_output_on_workspace("listing_nft")
            .call_function(
                listing_template,
                "create",
                args![
                    alice,
                    Workspace("listing_nft"),
                    x,
                    Amount::from(5_000u64),
                    0u64
                ],
            )
            .into_instructions();
    let (json, result) = run(&mut w, Who::Alice, ins);
    let listing = created_component(&result, listing_template);
    out.push(json!({
        "name": "create_listing",
        "params": { "templateAddress": hex(listing_template.as_ref()), "sellerAccount": s(alice), "nftResource": s(nc), "nftId": "str_art-3", "quoteResource": s(x), "price": "5000", "expiryEpoch": "0" },
        "instructions": json,
    }));
    let ins =
        w.t.transaction()
            .call_method(bob, "withdraw", args![x, Amount::from(5_000u64)])
            .put_last_instruction_output_on_workspace("listing_payment")
            .call_method(listing, "buy", args![Workspace("listing_payment"), bob])
            .into_instructions();
    let (json, _) = run(&mut w, Who::Bob, ins);
    assert_eq!(balance(&mut w, bob, nc), 1);
    out.push(json!({
        "name": "buy_listing",
        "params": { "listingAddress": s(listing), "buyerAccount": s(bob), "quoteResource": s(x), "amount": "5000" },
        "instructions": json,
    }));
    out
}

#[test]
fn w01_instruction_wire_is_upstream_serde_json_and_executes() {
    let literals = literal_cases();
    // Structural facts the browser serializer relies on, asserted directly.
    let probe = Transaction::builder(Network::LocalNet, tari_ootle_transaction::Epoch(0))
        .call_function(
            tari_template_lib::types::TemplateAddress::from_hex(FIXED_HASH).unwrap(),
            "f",
            args![],
        )
        .put_last_instruction_output_on_workspace("o")
        .call_method(
            ComponentAddress::from_str(FIXED_COMPONENT).unwrap(),
            "m",
            args![Workspace("o")],
        )
        .into_instructions();
    let probe = instructions_json(&probe);
    assert_eq!(
        probe[0]["CallFunction"]["address"],
        json!(FIXED_HASH),
        "CallFunction.address is the bare 64-hex template hash"
    );
    assert_eq!(
        probe[1],
        json!({ "PutLastInstructionOutputOnWorkspace": { "key": 0 } })
    );
    assert_eq!(
        probe[2]["CallMethod"]["call"],
        json!({ "Address": FIXED_COMPONENT })
    );
    assert_eq!(
        probe[2]["CallMethod"]["args"][0],
        json!({ "Workspace": { "id": 0, "offset": null } })
    );

    let write = std::env::var("SHADOW_SWAP_WRITE_WIRE_FIXTURES").as_deref() == Ok("1");
    let committed: Option<Value> = std::fs::read_to_string(format!("{CRATE_PATH}/{FIXTURE_PATH}"))
        .ok()
        .map(|s| serde_json::from_str(&s).expect("committed fixture is JSON"));
    if !write {
        let committed = committed.expect("the committed instruction fixture exists");
        assert_eq!(
            committed["literals"],
            Value::Array(literals.clone()),
            "a literal encoding changed under the pinned cohort; regenerate with SHADOW_SWAP_WRITE_WIRE_FIXTURES=1 and review"
        );
        assert_eq!(committed["probe"], probe);
    }
    // Scenarios ALWAYS execute (from their deserialised JSON), in both modes.
    let scenarios = scenarios();
    if write {
        let doc = json!({
            "cohort": COHORT,
            "generatedBy": "audit_engine_tests/tests/instruction_wire_v048.rs",
            "note": "Scenario addresses are TemplateTest addresses (random keys); they identify nothing on Esmeralda.",
            "probe": probe,
            "literals": literals,
            "scenarios": scenarios,
        });
        std::fs::write(
            format!("{CRATE_PATH}/{FIXTURE_PATH}"),
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
    }
}
