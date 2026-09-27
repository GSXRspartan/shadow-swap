// Real Ootle-engine regressions for buyer-funded, item-specific public-NFT offers.

use tari_crypto::ristretto::RistrettoSecretKey;
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{
    Amount, ComponentAddress, NonFungibleAddress, NonFungibleId, ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const OFFER: u64 = 80_000;

fn new_test() -> TemplateTest {
    TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/nft_item_offer",
            "templates/faucet",
            "templates/nft_faucet",
        ],
    )
}

fn create_fungible_faucet(
    t: &mut TemplateTest,
    symbol: &str,
) -> (ComponentAddress, ResourceAddress) {
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

fn create_nft_faucet(
    t: &mut TemplateTest,
    id: NonFungibleId,
    symbol: &str,
) -> (ComponentAddress, ResourceAddress) {
    let template = t.get_template_address("TestNftFaucet");
    let result = t.execute_expect_success(
        t.transaction()
            .call_function(template, "mint_one", args![id, symbol.to_string()])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    let component = result
        .expect_success()
        .up_iter()
        .find(|(address, substate)| {
            address.is_component()
                && *substate
                    .substate_value()
                    .component()
                    .unwrap()
                    .template_address()
                    == template
        })
        .unwrap()
        .0
        .as_component_address()
        .unwrap();
    let resource = result
        .expect_success()
        .up_iter()
        .find(|(address, _)| address.is_resource())
        .unwrap()
        .0
        .as_resource_address()
        .unwrap();
    (component, resource)
}

fn create_many_nft_faucet(
    t: &mut TemplateTest,
    ids: Vec<NonFungibleId>,
    symbol: &str,
) -> (ComponentAddress, ResourceAddress) {
    let template = t.get_template_address("TestNftFaucet");
    let result = t.execute_expect_success(
        t.transaction()
            .call_function(template, "mint_many", args![ids, symbol.to_string()])
            .build_and_seal(t.secret_key()),
        vec![],
    );
    let component = result
        .expect_success()
        .up_iter()
        .find(|(address, substate)| {
            address.is_component()
                && *substate
                    .substate_value()
                    .component()
                    .unwrap()
                    .template_address()
                    == template
        })
        .unwrap()
        .0
        .as_component_address()
        .unwrap();
    let resource = result
        .expect_success()
        .up_iter()
        .find(|(address, _)| address.is_resource())
        .unwrap()
        .0
        .as_resource_address()
        .unwrap();
    (component, resource)
}

fn fund(t: &mut TemplateTest, faucet: ComponentAddress, recipient: ComponentAddress) {
    t.build_and_execute(
        t.transaction()
            .call_method(faucet, "take_free_coins", args![])
            .put_last_instruction_output_on_workspace("coins")
            .call_method(recipient, "deposit", args![Workspace("coins")]),
        vec![],
    )
    .expect_success();
}

fn fund_nft(t: &mut TemplateTest, faucet: ComponentAddress, recipient: ComponentAddress) {
    t.build_and_execute(
        t.transaction()
            .call_method(faucet, "take_nft", args![])
            .put_last_instruction_output_on_workspace("nft")
            .call_method(recipient, "deposit", args![Workspace("nft")]),
        vec![],
    )
    .expect_success();
}

fn fund_nft_by_id(
    t: &mut TemplateTest,
    faucet: ComponentAddress,
    recipient: ComponentAddress,
    id: NonFungibleId,
) {
    t.build_and_execute(
        t.transaction()
            .call_method(faucet, "take_nft_by_id", args![id])
            .put_last_instruction_output_on_workspace("nft")
            .call_method(recipient, "deposit", args![Workspace("nft")]),
        vec![],
    )
    .expect_success();
}

fn create_item_offer(
    t: &mut TemplateTest,
    buyer: ComponentAddress,
    buyer_proof: NonFungibleAddress,
    buyer_secret: &RistrettoSecretKey,
    quote: ResourceAddress,
    collection: ResourceAddress,
    id: NonFungibleId,
    amount: Amount,
    expiry: u64,
) -> ComponentAddress {
    let template = t.get_template_address("ItemOffer");
    let result = t.execute_expect_success(
        t.transaction()
            .call_method(buyer, "withdraw", args![quote, amount])
            .put_last_instruction_output_on_workspace("quote")
            .call_function(
                template,
                "create",
                args![buyer, Workspace("quote"), collection, id, expiry],
            )
            .build_and_seal(buyer_secret),
        vec![buyer_proof],
    );
    let offer: ComponentAddress = {
        let receipt = result.expect_success();
        receipt
            .up_iter()
            .find_map(|(address, substate)| {
                if address.is_component()
                    && *substate
                        .substate_value()
                        .component()
                        .unwrap()
                        .template_address()
                        == template
                {
                    address.as_component_address()
                } else {
                    None
                }
            })
            .expect("item-offer component not found")
    };
    drop(result);
    offer
}

fn account_balance(
    t: &mut TemplateTest,
    account: ComponentAddress,
    resource: ResourceAddress,
) -> Amount {
    t.call_method(account, "balance", args![resource], vec![])
}

#[test]
fn i01_offer_escrows_exact_quote_and_atomically_settles_exact_nft() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wSTABLE");
    let id = NonFungibleId::from_u64(123);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, id.clone(), "COLA");
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    fund_nft(&mut t, nft_faucet, seller);
    fund(&mut t, quote_faucet, buyer);

    let buyer_quote_before = account_balance(&mut t, buyer, quote);
    let offer = create_item_offer(
        &mut t,
        buyer,
        buyer_proof.clone(),
        &buyer_secret,
        quote,
        collection,
        id.clone(),
        Amount::from(OFFER),
        0,
    );
    assert_eq!(
        buyer_quote_before - account_balance(&mut t, buyer, quote),
        Amount::from(OFFER)
    );

    let seller_quote_before = account_balance(&mut t, seller, quote);
    t.execute_expect_success(
        t.transaction()
            .call_method(
                seller,
                "withdraw_non_fungible",
                args![collection, id.clone()],
            )
            .put_last_instruction_output_on_workspace("nft")
            .call_method(offer, "accept", args![Workspace("nft"), seller])
            .build_and_seal(&seller_secret),
        vec![seller_proof.clone()],
    );
    assert_eq!(
        account_balance(&mut t, seller, quote) - seller_quote_before,
        Amount::from(OFFER)
    );
    assert_eq!(
        account_balance(&mut t, buyer, collection),
        Amount::from(1u64)
    );

    let replay = t
        .transaction()
        .call_method(seller, "withdraw_non_fungible", args![collection, id])
        .put_last_instruction_output_on_workspace("nft")
        .call_method(offer, "accept", args![Workspace("nft"), seller])
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(replay, vec![seller_proof]);

    let accepted_cancel = t
        .transaction()
        .call_method(offer, "cancel", args![])
        .build_and_seal(&buyer_secret);
    t.execute_expect_failure(accepted_cancel, vec![buyer_proof]);
}

#[test]
fn i02_only_buyer_can_cancel_and_expired_escrow_refunds_once() {
    let mut t = new_test();
    t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(1),
    );
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wSTABLE");
    let id = NonFungibleId::from_u64(7);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, id.clone(), "COLB");
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    let (attacker, attacker_proof, attacker_secret) = t.create_funded_account();
    fund(&mut t, quote_faucet, buyer);

    let quote_before = account_balance(&mut t, buyer, quote);
    let cancelled = create_item_offer(
        &mut t,
        buyer,
        buyer_proof.clone(),
        &buyer_secret,
        quote,
        collection,
        id.clone(),
        Amount::from(OFFER),
        0,
    );
    let unauthorized = t
        .transaction()
        .call_method(cancelled, "cancel", args![])
        .build_and_seal(&attacker_secret);
    t.execute_expect_failure(unauthorized, vec![attacker_proof]);
    t.execute_expect_success(
        t.transaction()
            .call_method(cancelled, "cancel", args![])
            .build_and_seal(&buyer_secret),
        vec![buyer_proof.clone()],
    );
    assert_eq!(account_balance(&mut t, buyer, quote), quote_before);

    fund_nft(&mut t, nft_faucet, attacker);
    let cancelled_accept = t
        .transaction()
        .call_method(
            attacker,
            "withdraw_non_fungible",
            args![collection, id.clone()],
        )
        .put_last_instruction_output_on_workspace("nft")
        .call_method(cancelled, "accept", args![Workspace("nft"), attacker])
        .build_and_seal(&attacker_secret);
    t.execute_expect_failure(cancelled_accept, vec![]);

    let (_, expiry_collection) = create_nft_faucet(&mut t, id, "COLC");
    let expiring = create_item_offer(
        &mut t,
        buyer,
        buyer_proof.clone(),
        &buyer_secret,
        quote,
        expiry_collection,
        NonFungibleId::from_u64(7),
        Amount::from(OFFER),
        2,
    );
    t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(2),
    );
    let refund = t
        .transaction()
        .call_method(expiring, "refund_expired", args![])
        .build_and_seal(&attacker_secret);
    t.execute_expect_success(refund, vec![]);
    assert_eq!(account_balance(&mut t, buyer, quote), quote_before);

    let duplicate_refund = t
        .transaction()
        .call_method(expiring, "refund_expired", args![])
        .build_and_seal(&attacker_secret);
    t.execute_expect_failure(duplicate_refund, vec![]);
}

#[test]
fn i03_wrong_nft_id_rejected() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wSTABLE");
    let requested_id = NonFungibleId::from_u64(1);
    let other_id = NonFungibleId::from_u64(2);
    let (many_faucet, collection) =
        create_many_nft_faucet(&mut t, vec![requested_id.clone(), other_id.clone()], "COLX");
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    fund(&mut t, quote_faucet, buyer);
    fund_nft_by_id(&mut t, many_faucet, seller, other_id.clone());

    let offer = create_item_offer(
        &mut t,
        buyer,
        buyer_proof.clone(),
        &buyer_secret,
        quote,
        collection,
        requested_id.clone(),
        Amount::from(OFFER),
        0,
    );
    let wrong_id = t
        .transaction()
        .call_method(seller, "withdraw_non_fungible", args![collection, other_id])
        .put_last_instruction_output_on_workspace("nft")
        .call_method(offer, "accept", args![Workspace("nft"), seller])
        .build_and_seal(&seller_secret);
    let reason = t.execute_expect_failure(wrong_id, vec![seller_proof.clone()]);
    assert!(format!("{reason:?}").contains("Incorrect NFT id"));
    assert_eq!(
        account_balance(&mut t, seller, collection),
        Amount::from(1u64)
    );

    // The rejected wrong-id attempt leaves this exact offer active and its escrow intact.
    fund_nft_by_id(&mut t, many_faucet, seller, requested_id.clone());
    t.execute_expect_success(
        t.transaction()
            .call_method(
                seller,
                "withdraw_non_fungible",
                args![collection, requested_id],
            )
            .put_last_instruction_output_on_workspace("nft")
            .call_method(offer, "accept", args![Workspace("nft"), seller])
            .build_and_seal(&seller_secret),
        vec![seller_proof],
    );
    assert_eq!(
        account_balance(&mut t, buyer, collection),
        Amount::from(1u64)
    );
}

#[test]
fn i04_wrong_collection_rejected() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wSTABLE");
    let requested_id = NonFungibleId::from_u64(1);
    let (_nft_faucet, collection) = create_nft_faucet(&mut t, requested_id.clone(), "COLX");
    let (same_metadata_faucet, same_metadata_collection) =
        create_nft_faucet(&mut t, requested_id.clone(), "COLX");
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    fund(&mut t, quote_faucet, buyer);
    fund_nft(&mut t, same_metadata_faucet, seller);

    let offer = create_item_offer(
        &mut t,
        buyer,
        buyer_proof,
        &buyer_secret,
        quote,
        collection,
        requested_id.clone(),
        Amount::from(OFFER),
        0,
    );

    let wrong_collection = t
        .transaction()
        .call_method(
            seller,
            "withdraw_non_fungible",
            args![same_metadata_collection, requested_id.clone()],
        )
        .put_last_instruction_output_on_workspace("nft")
        .call_method(offer, "accept", args![Workspace("nft"), seller])
        .build_and_seal(&seller_secret);
    let reason = t.execute_expect_failure(wrong_collection, vec![seller_proof]);
    assert!(format!("{reason:?}").contains("Incorrect NFT collection"));
    assert_eq!(
        account_balance(&mut t, seller, same_metadata_collection),
        Amount::from(1u64)
    );
}

#[test]
fn i05_non_fungible_quote_rejected() {
    let mut t = new_test();
    let requested_id = NonFungibleId::from_u64(1);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, requested_id.clone(), "COLX");
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    fund_nft(&mut t, nft_faucet, seller);

    // An NFT bucket cannot fund an offer; the quote boundary is fungible-only.
    let item_offer_template = t.get_template_address("ItemOffer");
    let non_fungible_quote = t
        .transaction()
        .call_method(
            seller,
            "withdraw_non_fungible",
            args![collection, requested_id.clone()],
        )
        .put_last_instruction_output_on_workspace("not_quote")
        .call_function(
            item_offer_template,
            "create",
            args![
                seller,
                Workspace("not_quote"),
                collection,
                requested_id.clone(),
                0u64
            ],
        )
        .build_and_seal(&seller_secret);
    let reason = t.execute_expect_failure(non_fungible_quote, vec![seller_proof]);
    assert!(format!("{reason:?}").contains("Quote resource must be canonical Tari"));
    assert_eq!(
        account_balance(&mut t, seller, collection),
        Amount::from(1u64)
    );
}
