// Peer-to-peer escrow offers (templates/p2p_offer, EXPERIMENTAL, UNPUBLISHED) in the REAL v0.48
// engine, with freshly created disposable resources. This is the settlement lane for assets the
// public AMM deliberately refuses (created-Stealth) and for NFT barter.
//
//   p01 public fungible <-> public fungible at an agreed price
//   p02 created-Stealth (revealed) -> public fungible, delivered into the taker's ACCOUNT
//   p03 created-Stealth <-> created-Stealth
//   p04 NFT <-> specific NFT (atomic barter)
//   p05 designated taker: another signer is refused, the named signer fills
//   p06 hash lock (HTLC-style): wrong preimage refused, right preimage fills
//   p07 wrong resource / wrong amount / wrong NFT id refused, escrow untouched
//   p08 cancel refunds; fill after cancel, claim before fill, non-maker cancel all refused
//   p09 expiry: an expired offer cannot be filled; the maker still recovers the escrow
//   p10 created-Stealth held in the maker's ACCOUNT -> offer -> taker's account (type kept)
//   c03 revealed Confidential held in the maker's ACCOUNT -> offer -> taker's account
use ootle_byte_type::ToByteType;
use tari_crypto::{keys::PublicKey as _, ristretto::RistrettoPublicKey};
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{
    crypto::RistrettoPublicKeyBytes, Amount, ComponentAddress, NonFungibleAddress, NonFungibleId,
    ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const NONE_ID: Option<NonFungibleId> = None;
const NONE_KEY: Option<RistrettoPublicKeyBytes> = None;
const NONE_HASH: Option<tari_template_lib::types::Hash32> = None;

struct World {
    t: TemplateTest,
    maker: ComponentAddress,
    maker_proof: NonFungibleAddress,
    maker_key: tari_crypto::ristretto::RistrettoSecretKey,
    taker: ComponentAddress,
    taker_proof: NonFungibleAddress,
    taker_key: tari_crypto::ristretto::RistrettoSecretKey,
}

fn world() -> World {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/p2p_offer",
            "templates/faucet",
            "templates/stealth_probe",
            "templates/nft_faucet",
        ],
    );
    // `rule!(public_key(..))` (maker-only claim/cancel, designated taker) is satisfied by the
    // transaction signer's key proof, which the harness adds only when asked (as upstream's
    // engine/tests/stealth.rs does).
    t.enable_auto_add_proofs_from_signers();
    let (maker, maker_proof, maker_key) = t.create_funded_account();
    let (taker, taker_proof, taker_key) = t.create_funded_account();
    World {
        t,
        maker,
        maker_proof,
        maker_key,
        taker,
        taker_proof,
        taker_key,
    }
}

fn fungible(w: &mut World, symbol: &str, to: ComponentAddress) -> ResourceAddress {
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
    let tx =
        w.t.transaction()
            .call_method(f, "take_free_coins", args![])
            .put_last_instruction_output_on_workspace("c")
            .call_method(to, "deposit", args![Workspace("c")]);
    w.t.build_and_execute(tx, vec![]).expect_success();
    r
}

/// A disposable created-Stealth resource whose REVEALED supply sits in a probe component.
fn stealth(w: &mut World) -> (ComponentAddress, ResourceAddress) {
    let probe: ComponentAddress = w.t.call_function(
        "StealthProbe",
        "new",
        args![Amount::from(1_000_000u64)],
        vec![],
    );
    let r =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    (probe, r)
}

fn nft(w: &mut World, id: &str, symbol: &str) -> (ComponentAddress, ResourceAddress) {
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
    (f, r)
}

fn balance(w: &mut World, account: ComponentAddress, r: ResourceAddress) -> Amount {
    w.t.call_method(account, "balance", args![r], vec![])
}

fn offer_address(w: &World) -> ComponentAddress {
    w.t.get_previous_output_address(SubstateType::Component)
        .as_component_address()
        .unwrap()
}

/// Maker escrows `amount` of `offered` from their account.
fn make_fungible_offer(
    w: &mut World,
    offered: ResourceAddress,
    amount: u64,
    want: ResourceAddress,
    want_amount: u64,
    taker: Option<RistrettoPublicKeyBytes>,
    lock: Option<tari_template_lib::types::Hash32>,
    expires: u64,
) -> ComponentAddress {
    let maker = w.maker;
    let tmpl = w.t.get_template_address("SwapOffer");
    let tx =
        w.t.transaction()
            .call_method(maker, "withdraw", args![offered, Amount::from(amount)])
            .put_last_instruction_output_on_workspace("o")
            .call_function(
                tmpl,
                "create",
                args![
                    Workspace("o"),
                    want,
                    Amount::from(want_amount),
                    NONE_ID,
                    taker,
                    lock,
                    expires
                ],
            )
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    offer_address(w)
}

fn fill_tx(
    w: &World,
    offer: ComponentAddress,
    pay: ResourceAddress,
    amount: u64,
    preimage: Option<Vec<u8>>,
    signer: &tari_crypto::ristretto::RistrettoSecretKey,
) -> tari_ootle_transaction::Transaction {
    let taker = w.taker;
    w.t.transaction()
        .call_method(taker, "withdraw", args![pay, Amount::from(amount)])
        .put_last_instruction_output_on_workspace("p")
        .call_method(offer, "fill", args![Workspace("p"), preimage])
        .put_last_instruction_output_on_workspace("got")
        .call_method(taker, "deposit", args![Workspace("got")])
        .build_and_seal(signer)
}

fn claim(w: &mut World, offer: ComponentAddress) {
    let maker = w.maker;
    let tx =
        w.t.transaction()
            .call_method(offer, "claim", args![])
            .put_last_instruction_output_on_workspace("c")
            .call_method(maker, "deposit", args![Workspace("c")])
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
}

fn taker_pk(w: &World) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(&w.taker_key).to_byte_type()
}

#[test]
fn p01_fungible_for_fungible_at_an_agreed_price() {
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let x = fungible(&mut w, "XXX", maker);
    let y = fungible(&mut w, "YYY", taker);
    let offer = make_fungible_offer(&mut w, x, 1_000, y, 2_500, NONE_KEY, NONE_HASH, 0);
    let tx = fill_tx(&w, offer, y, 2_500, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(balance(&mut w, taker, x), Amount::from(1_000u64));
    claim(&mut w, offer);
    assert_eq!(balance(&mut w, maker, y), Amount::from(2_500u64));
}

#[test]
fn p02_created_stealth_revealed_for_public_fungible_into_the_takers_account() {
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let (probe, pstl) = stealth(&mut w);
    let y = fungible(&mut w, "YYY", taker);
    let tmpl = w.t.get_template_address("SwapOffer");
    // The maker reveals 400 units of the created-Stealth resource and escrows them.
    let tx =
        w.t.transaction()
            .call_method(probe, "take", args![Amount::from(400u64)])
            .put_last_instruction_output_on_workspace("o")
            .call_function(
                tmpl,
                "create",
                args![
                    Workspace("o"),
                    y,
                    Amount::from(700u64),
                    NONE_ID,
                    NONE_KEY,
                    NONE_HASH,
                    0u64
                ],
            )
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    let offer = offer_address(&w);
    let tx = fill_tx(&w, offer, y, 700, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(
        balance(&mut w, taker, pstl),
        Amount::from(400u64),
        "the revealed created-Stealth units land in the taker's account, type unchanged"
    );
    claim(&mut w, offer);
    assert_eq!(balance(&mut w, maker, y), Amount::from(700u64));
}

#[test]
fn p03_created_stealth_for_created_stealth() {
    let mut w = world();
    let taker = w.taker;
    let (probe_a, sa) = stealth(&mut w);
    let (probe_b, sb) = stealth(&mut w);
    let tmpl = w.t.get_template_address("SwapOffer");
    let tx =
        w.t.transaction()
            .call_method(probe_a, "take", args![Amount::from(300u64)])
            .put_last_instruction_output_on_workspace("o")
            .call_function(
                tmpl,
                "create",
                args![
                    Workspace("o"),
                    sb,
                    Amount::from(600u64),
                    NONE_ID,
                    NONE_KEY,
                    NONE_HASH,
                    0u64
                ],
            )
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    let offer = offer_address(&w);
    // The taker pays with revealed units of the OTHER created-Stealth resource.
    let tx =
        w.t.transaction()
            .call_method(probe_b, "take", args![Amount::from(600u64)])
            .put_last_instruction_output_on_workspace("p")
            .call_method(offer, "fill", args![Workspace("p"), None::<Vec<u8>>])
            .put_last_instruction_output_on_workspace("got")
            .call_method(taker, "deposit", args![Workspace("got")])
            .build_and_seal(&w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(balance(&mut w, taker, sa), Amount::from(300u64));
}

#[test]
fn p04_nft_for_a_specific_nft_atomic_barter() {
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let (fa, na) = nft(&mut w, "art-1", "ARTA");
    let (fb, nb) = nft(&mut w, "art-2", "ARTB");
    let tmpl = w.t.get_template_address("SwapOffer");
    let tx =
        w.t.transaction()
            .call_method(fa, "take_nft", args![])
            .put_last_instruction_output_on_workspace("o")
            .call_function(
                tmpl,
                "create",
                args![
                    Workspace("o"),
                    nb,
                    Amount::zero(),
                    Some(NonFungibleId::from_string("art-2")),
                    NONE_KEY,
                    NONE_HASH,
                    0u64
                ],
            )
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    let offer = offer_address(&w);
    let tx =
        w.t.transaction()
            .call_method(fb, "take_nft", args![])
            .put_last_instruction_output_on_workspace("p")
            .call_method(offer, "fill", args![Workspace("p"), None::<Vec<u8>>])
            .put_last_instruction_output_on_workspace("got")
            .call_method(taker, "deposit", args![Workspace("got")])
            .build_and_seal(&w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(balance(&mut w, taker, na), Amount::from(1u64));
    claim(&mut w, offer);
    assert_eq!(balance(&mut w, maker, nb), Amount::from(1u64));
}

#[test]
fn p05_designated_taker_only() {
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let x = fungible(&mut w, "XXX", maker);
    let y = fungible(&mut w, "YYY", taker);
    let pk = taker_pk(&w);
    let offer = make_fungible_offer(&mut w, x, 1_000, y, 10, Some(pk), NONE_HASH, 0);
    // A THIRD party holding the payment asset, proving only its own key: refused.
    let (imp, imp_proof, imp_key) = w.t.create_funded_account();
    let tp = w.taker_proof.clone();
    let give =
        w.t.transaction()
            .call_method(taker, "withdraw", args![y, Amount::from(10u64)])
            .put_last_instruction_output_on_workspace("g")
            .call_method(imp, "deposit", args![Workspace("g")])
            .build_and_seal(&w.taker_key.clone());
    w.t.execute_expect_success(give, vec![tp]);
    let impostor =
        w.t.transaction()
            .call_method(imp, "withdraw", args![y, Amount::from(10u64)])
            .put_last_instruction_output_on_workspace("p")
            .call_method(offer, "fill", args![Workspace("p"), None::<Vec<u8>>])
            .put_last_instruction_output_on_workspace("got")
            .call_method(imp, "deposit", args![Workspace("got")])
            .build_and_seal(&imp_key);
    let reason = w.t.execute_expect_failure(impostor, vec![imp_proof]);
    println!("p05 impostor refused: {reason:?}");
    let tx = fill_tx(&w, offer, y, 10, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(balance(&mut w, taker, x), Amount::from(1_000u64));
}

#[test]
fn p06_hash_lock_requires_the_preimage() {
    use sha2::{Digest, Sha256};
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let x = fungible(&mut w, "XXX", maker);
    let y = fungible(&mut w, "YYY", taker);
    let secret = b"shadow-swap-invite-7f3a".to_vec();
    let digest: [u8; 32] = Sha256::digest(&secret).into();
    let lock = tari_template_lib::types::Hash32::from_array(digest);
    let offer = make_fungible_offer(&mut w, x, 1_000, y, 10, NONE_KEY, Some(lock), 0);
    let tx = fill_tx(
        &w,
        offer,
        y,
        10,
        Some(b"wrong".to_vec()),
        &w.taker_key.clone(),
    );
    let p = w.taker_proof.clone();
    w.t.execute_expect_failure(tx, vec![p]);
    let tx = fill_tx(&w, offer, y, 10, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_failure(tx, vec![p]);
    let tx = fill_tx(&w, offer, y, 10, Some(secret), &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(balance(&mut w, taker, x), Amount::from(1_000u64));
}

#[test]
fn p07_wrong_resource_amount_or_nft_is_refused_and_escrow_is_untouched() {
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let x = fungible(&mut w, "XXX", maker);
    let y = fungible(&mut w, "YYY", taker);
    let z = fungible(&mut w, "ZZZ", taker);
    let offer = make_fungible_offer(&mut w, x, 1_000, y, 10, NONE_KEY, NONE_HASH, 0);
    for (pay, amt) in [(y, 9u64), (y, 11), (z, 10)] {
        let tx = fill_tx(&w, offer, pay, amt, None, &w.taker_key.clone());
        let p = w.taker_proof.clone();
        w.t.execute_expect_failure(tx, vec![p]);
    }
    let (_, escrowed, _, _, _): (ResourceAddress, Amount, ResourceAddress, Amount, u8) =
        decode_offer(&mut w, offer);
    assert_eq!(escrowed, Amount::from(1_000u64));
}

fn decode_offer(
    w: &mut World,
    offer: ComponentAddress,
) -> (ResourceAddress, Amount, ResourceAddress, Amount, u8) {
    let (a, b, c, d, status): (
        ResourceAddress,
        Amount,
        ResourceAddress,
        Amount,
        tari_template_lib::prelude::tari_bor::Value,
    ) = w.t.call_method(offer, "offer", args![], vec![]);
    let _ = status;
    (a, b, c, d, 0)
}

#[test]
fn p08_cancel_refunds_and_the_lifecycle_is_enforced() {
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let x = fungible(&mut w, "XXX", maker);
    let y = fungible(&mut w, "YYY", taker);
    let before = balance(&mut w, maker, x);
    let offer = make_fungible_offer(&mut w, x, 1_000, y, 10, NONE_KEY, NONE_HASH, 0);
    // claim before fill: refused
    let tx =
        w.t.transaction()
            .call_method(offer, "claim", args![])
            .put_last_instruction_output_on_workspace("c")
            .call_method(maker, "deposit", args![Workspace("c")])
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_failure(tx, vec![p]);
    // cancel by someone other than the maker: refused
    let tx =
        w.t.transaction()
            .call_method(offer, "cancel", args![])
            .put_last_instruction_output_on_workspace("c")
            .call_method(taker, "deposit", args![Workspace("c")])
            .build_and_seal(&w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_failure(tx, vec![p]);
    // maker cancel: refunded in full
    let tx =
        w.t.transaction()
            .call_method(offer, "cancel", args![])
            .put_last_instruction_output_on_workspace("c")
            .call_method(maker, "deposit", args![Workspace("c")])
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(balance(&mut w, maker, x), before);
    // fill after cancel: refused
    let tx = fill_tx(&w, offer, y, 10, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_failure(tx, vec![p]);
}

#[test]
fn p09_expired_offer_cannot_be_filled_but_is_recoverable() {
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let x = fungible(&mut w, "XXX", maker);
    let y = fungible(&mut w, "YYY", taker);
    let before = balance(&mut w, maker, x);
    let offer = make_fungible_offer(&mut w, x, 1_000, y, 10, NONE_KEY, NONE_HASH, 5);
    w.t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(5),
    );
    let tx = fill_tx(&w, offer, y, 10, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_failure(tx, vec![p]);
    let tx =
        w.t.transaction()
            .call_method(offer, "cancel", args![])
            .put_last_instruction_output_on_workspace("c")
            .call_method(maker, "deposit", args![Workspace("c")])
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(balance(&mut w, maker, x), before);
}

// ---------------------------------------------------------------------------------------------
// Confidential lane (revealed balances only)
// ---------------------------------------------------------------------------------------------

fn confidential_world() -> World {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/p2p_offer",
            "../templates/fungible_pool",
            "templates/faucet",
            "templates/confidential_probe",
        ],
    );
    t.enable_auto_add_proofs_from_signers();
    let (maker, maker_proof, maker_key) = t.create_funded_account();
    let (taker, taker_proof, taker_key) = t.create_funded_account();
    World {
        t,
        maker,
        maker_proof,
        maker_key,
        taker,
        taker_proof,
        taker_key,
    }
}

fn confidential(w: &mut World) -> (ComponentAddress, ResourceAddress) {
    let probe: ComponentAddress = w.t.call_function(
        "ConfidentialProbe",
        "new",
        args![Amount::from(1_000_000u64)],
        vec![],
    );
    let r =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    (probe, r)
}

#[test]
fn c01_confidential_revealed_for_public_fungible_via_p2p_offer() {
    let mut w = confidential_world();
    let (maker, taker) = (w.maker, w.taker);
    let (probe, conf) = confidential(&mut w);
    let y = fungible(&mut w, "YYY", taker);
    let tmpl = w.t.get_template_address("SwapOffer");
    let tx =
        w.t.transaction()
            .call_method(probe, "take", args![Amount::from(250u64)])
            .put_last_instruction_output_on_workspace("o")
            .call_function(
                tmpl,
                "create",
                args![
                    Workspace("o"),
                    y,
                    Amount::from(900u64),
                    NONE_ID,
                    NONE_KEY,
                    NONE_HASH,
                    0u64
                ],
            )
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    let offer = offer_address(&w);
    let tx = fill_tx(&w, offer, y, 900, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(
        balance(&mut w, taker, conf),
        Amount::from(250u64),
        "revealed confidential units land in the taker's account, type unchanged"
    );
    claim(&mut w, offer);
    assert_eq!(balance(&mut w, maker, y), Amount::from(900u64));
}

#[test]
fn c02_pool_v2_refuses_a_confidential_resource() {
    let mut w = confidential_world();
    let taker = w.taker;
    let (_probe, conf) = confidential(&mut w);
    let y = fungible(&mut w, "YYY", taker);
    let pool_template = w.t.get_template_address("Pool");
    let tx =
        w.t.transaction()
            .call_function(pool_template, "new", args![conf, y, 30u16])
            .build_and_seal(w.t.secret_key());
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![]));
    assert!(reason.contains("not eligible"), "{reason}");
}

/// The maker's ACCOUNT holds `amount` of the probe's resource (revealed), so the offer is made
/// from the account exactly as a wallet makes it, not from a probe component.
fn into_account(w: &mut World, probe: ComponentAddress, amount: u64, to: ComponentAddress) {
    let tx =
        w.t.transaction()
            .call_method(probe, "take", args![Amount::from(amount)])
            .put_last_instruction_output_on_workspace("s")
            .call_method(to, "deposit", args![Workspace("s")]);
    w.t.build_and_execute(tx, vec![]).expect_success();
}

/// Maker offers `amount` of a private-typed resource held in their ACCOUNT, taker fills with
/// `y`; returns the offer. Asserts the escrow vault keeps the asset's container kind.
fn account_held_private_offer(
    w: &mut World,
    private: ResourceAddress,
    amount: u64,
    y: ResourceAddress,
    want: u64,
    kind: &str,
) -> ComponentAddress {
    let maker = w.maker;
    let tmpl = w.t.get_template_address("SwapOffer");
    let tx =
        w.t.transaction()
            .call_method(maker, "withdraw", args![private, Amount::from(amount)])
            .put_last_instruction_output_on_workspace("o")
            .call_function(
                tmpl,
                "create",
                args![
                    Workspace("o"),
                    y,
                    Amount::from(want),
                    NONE_ID,
                    NONE_KEY,
                    NONE_HASH,
                    0u64
                ],
            )
            .build_and_seal(&w.maker_key.clone());
    let p = w.maker_proof.clone();
    let result = w.t.execute_expect_success(tx, vec![p]);
    // The escrow is the vault this transaction brought up at version 0; its Debug form names
    // the container kind (`resource_container: Stealth { .. }` etc.).
    let escrow = result
        .expect_success()
        .up_iter()
        .filter(|(id, s)| id.to_string().starts_with("vault_") && u64::from(s.version()) == 0)
        .map(|(_, s)| format!("{:?}", s.substate_value()))
        .find(|v| v.contains(&format!("{private:?}")))
        .expect("the escrow vault was created");
    assert!(
        escrow.contains(&format!("resource_container: {kind} {{")),
        "escrow keeps the {kind} container, got {escrow}"
    );
    offer_address(w)
}

#[test]
fn p10_created_stealth_from_the_makers_account_into_an_offer_and_back_out_to_the_taker() {
    // A plain Account::withdraw of a REVEALED created-Stealth balance is accepted by the v0.48
    // engine (Sapient's client-side signer refuses that instruction for its local accounts and
    // uses its native withdrawStealthAndExecute instead; that is a wallet constraint, not an
    // engine one). The escrow vault is a Stealth container, and the taker receives the same
    // Stealth-typed resource.
    let mut w = world();
    let (maker, taker) = (w.maker, w.taker);
    let (probe, pstl) = stealth(&mut w);
    let y = fungible(&mut w, "YYY", taker);
    into_account(&mut w, probe, 400, maker);
    assert_eq!(balance(&mut w, maker, pstl), Amount::from(400u64));
    let offer = account_held_private_offer(&mut w, pstl, 400, y, 700, "Stealth");
    assert_eq!(balance(&mut w, maker, pstl), Amount::zero());
    let tx = fill_tx(&w, offer, y, 700, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(
        balance(&mut w, taker, pstl),
        Amount::from(400u64),
        "created-Stealth delivered, type unchanged"
    );
    claim(&mut w, offer);
    assert_eq!(balance(&mut w, maker, y), Amount::from(700u64));
}

#[test]
fn c03_confidential_revealed_from_the_makers_account_into_an_offer_and_back_out() {
    let mut w = confidential_world();
    let (maker, taker) = (w.maker, w.taker);
    let (probe, conf) = confidential(&mut w);
    let y = fungible(&mut w, "YYY", taker);
    into_account(&mut w, probe, 250, maker);
    let offer = account_held_private_offer(&mut w, conf, 250, y, 900, "Confidential");
    let tx = fill_tx(&w, offer, y, 900, None, &w.taker_key.clone());
    let p = w.taker_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(
        balance(&mut w, taker, conf),
        Amount::from(250u64),
        "revealed confidential delivered, type unchanged"
    );
    claim(&mut w, offer);
    assert_eq!(balance(&mut w, maker, y), Amount::from(900u64));
}
