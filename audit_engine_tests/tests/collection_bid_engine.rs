// Real Ootle-engine regressions for public-NFT collection-floor limit bids.

use tari_crypto::ristretto::RistrettoSecretKey;
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{
    Amount, ComponentAddress, NonFungibleAddress, NonFungibleId, ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const PRICE: u64 = 25_000;

fn new_test() -> TemplateTest {
    TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/nft_collection_bid",
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

fn create_bid(
    t: &mut TemplateTest,
    buyer: ComponentAddress,
    buyer_proof: NonFungibleAddress,
    buyer_secret: &RistrettoSecretKey,
    quote: ResourceAddress,
    collection: ResourceAddress,
    price: Amount,
    quantity: u64,
    expiry: u64,
) -> ComponentAddress {
    let template = t.get_template_address("CollectionBid");
    let escrow = price
        .checked_mul(Amount::from(quantity))
        .expect("test escrow multiplication overflow");
    let result = t.execute_expect_success(
        t.transaction()
            .call_method(buyer, "withdraw", args![quote, escrow])
            .put_last_instruction_output_on_workspace("quote")
            .call_function(
                template,
                "create",
                args![
                    buyer,
                    Workspace("quote"),
                    collection,
                    price,
                    quantity,
                    expiry
                ],
            )
            .build_and_seal(buyer_secret),
        vec![buyer_proof],
    );
    let bid: ComponentAddress = {
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
            .expect("collection-bid component not found")
    };
    drop(result);
    bid
}

fn fill_bid(
    t: &mut TemplateTest,
    bid: ComponentAddress,
    seller: ComponentAddress,
    seller_proof: NonFungibleAddress,
    seller_secret: &RistrettoSecretKey,
    collection: ResourceAddress,
    id: NonFungibleId,
) {
    t.execute_expect_success(
        t.transaction()
            .call_method(seller, "withdraw_non_fungible", args![collection, id])
            .put_last_instruction_output_on_workspace("nft")
            .call_method(bid, "fill", args![Workspace("nft"), seller])
            .build_and_seal(seller_secret),
        vec![seller_proof],
    );
}

fn account_balance(
    t: &mut TemplateTest,
    account: ComponentAddress,
    resource: ResourceAddress,
) -> Amount {
    t.call_method(account, "balance", args![resource], vec![])
}

#[test]
fn b01_sequential_fills_decrement_exact_escrow_and_quantity() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wSTABLE");
    let ids = vec![
        NonFungibleId::from_u64(1),
        NonFungibleId::from_u64(2),
        NonFungibleId::from_u64(3),
        NonFungibleId::from_u64(4),
    ];
    let (nft_faucet, collection) = create_many_nft_faucet(&mut t, ids.clone(), "COLA");
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    let (seller_one, seller_one_proof, seller_one_secret) = t.create_funded_account();
    let (seller_two, seller_two_proof, seller_two_secret) = t.create_funded_account();
    let (seller_three, seller_three_proof, seller_three_secret) = t.create_funded_account();
    let (seller_four, seller_four_proof, seller_four_secret) = t.create_funded_account();
    fund(&mut t, quote_faucet, buyer);
    fund_nft_by_id(&mut t, nft_faucet, seller_one, ids[0].clone());
    fund_nft_by_id(&mut t, nft_faucet, seller_two, ids[1].clone());
    fund_nft_by_id(&mut t, nft_faucet, seller_three, ids[2].clone());
    fund_nft_by_id(&mut t, nft_faucet, seller_four, ids[3].clone());

    let buyer_quote_before = account_balance(&mut t, buyer, quote);
    let bid = create_bid(
        &mut t,
        buyer,
        buyer_proof.clone(),
        &buyer_secret,
        quote,
        collection,
        Amount::from(PRICE),
        3,
        0,
    );
    assert_eq!(
        buyer_quote_before - account_balance(&mut t, buyer, quote),
        Amount::from(PRICE * 3)
    );

    let one_before = account_balance(&mut t, seller_one, quote);
    fill_bid(
        &mut t,
        bid,
        seller_one,
        seller_one_proof,
        &seller_one_secret,
        collection,
        ids[0].clone(),
    );
    assert_eq!(
        account_balance(&mut t, seller_one, quote) - one_before,
        Amount::from(PRICE)
    );
    assert_eq!(t.extract_component_value::<u64>(bid, "$.6"), 2);
    assert_eq!(
        t.extract_component_value::<Amount>(bid, "$.8"),
        Amount::from(PRICE * 2)
    );

    let two_before = account_balance(&mut t, seller_two, quote);
    fill_bid(
        &mut t,
        bid,
        seller_two,
        seller_two_proof,
        &seller_two_secret,
        collection,
        ids[1].clone(),
    );
    assert_eq!(
        account_balance(&mut t, seller_two, quote) - two_before,
        Amount::from(PRICE)
    );
    let three_before = account_balance(&mut t, seller_three, quote);
    fill_bid(
        &mut t,
        bid,
        seller_three,
        seller_three_proof,
        &seller_three_secret,
        collection,
        ids[2].clone(),
    );
    assert_eq!(
        account_balance(&mut t, seller_three, quote) - three_before,
        Amount::from(PRICE)
    );
    assert_eq!(
        account_balance(&mut t, buyer, collection),
        Amount::from(3u64)
    );
    assert_eq!(
        buyer_quote_before - account_balance(&mut t, buyer, quote),
        Amount::from(PRICE * 3)
    );
    assert_eq!(t.extract_component_value::<u64>(bid, "$.6"), 0);
    assert_eq!(
        t.extract_component_value::<Amount>(bid, "$.8"),
        Amount::zero()
    );

    let overfill = t
        .transaction()
        .call_method(
            seller_four,
            "withdraw_non_fungible",
            args![collection, ids[3].clone()],
        )
        .put_last_instruction_output_on_workspace("nft")
        .call_method(bid, "fill", args![Workspace("nft"), seller_four])
        .build_and_seal(&seller_four_secret);
    t.execute_expect_failure(overfill, vec![seller_four_proof]);
    assert_eq!(
        account_balance(&mut t, seller_four, collection),
        Amount::from(1u64)
    );
}

#[test]
fn b02_cancel_partially_filled_bid_refunds_only_unfilled_escrow() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wSTABLE");
    let ids = vec![NonFungibleId::from_u64(10), NonFungibleId::from_u64(11)];
    let (nft_faucet, collection) = create_many_nft_faucet(&mut t, ids.clone(), "COLB");
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    let (attacker, attacker_proof, attacker_secret) = t.create_funded_account();
    fund(&mut t, quote_faucet, buyer);
    fund_nft_by_id(&mut t, nft_faucet, seller, ids[0].clone());
    fund_nft_by_id(&mut t, nft_faucet, attacker, ids[1].clone());

    let buyer_quote_before = account_balance(&mut t, buyer, quote);
    let bid = create_bid(
        &mut t,
        buyer,
        buyer_proof.clone(),
        &buyer_secret,
        quote,
        collection,
        Amount::from(PRICE),
        2,
        0,
    );
    fill_bid(
        &mut t,
        bid,
        seller,
        seller_proof,
        &seller_secret,
        collection,
        ids[0].clone(),
    );

    let unauthorized = t
        .transaction()
        .call_method(bid, "cancel", args![])
        .build_and_seal(&attacker_secret);
    t.execute_expect_failure(unauthorized, vec![attacker_proof.clone()]);
    t.execute_expect_success(
        t.transaction()
            .call_method(bid, "cancel", args![])
            .build_and_seal(&buyer_secret),
        vec![buyer_proof.clone()],
    );
    assert_eq!(
        buyer_quote_before - account_balance(&mut t, buyer, quote),
        Amount::from(PRICE)
    );

    let cancelled_fill = t
        .transaction()
        .call_method(
            attacker,
            "withdraw_non_fungible",
            args![collection, ids[1].clone()],
        )
        .put_last_instruction_output_on_workspace("nft")
        .call_method(bid, "fill", args![Workspace("nft"), attacker])
        .build_and_seal(&attacker_secret);
    t.execute_expect_failure(cancelled_fill, vec![attacker_proof]);

    let duplicate_cancel = t
        .transaction()
        .call_method(bid, "cancel", args![])
        .build_and_seal(&buyer_secret);
    t.execute_expect_failure(duplicate_cancel, vec![buyer_proof]);
}

#[test]
fn b03_wrong_collection_and_expired_bid_cannot_fill_and_refund_once() {
    let mut t = new_test();
    t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(1),
    );
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wSTABLE");
    let id = NonFungibleId::from_u64(55);
    let (nft_faucet, collection) = create_many_nft_faucet(&mut t, vec![id.clone()], "COLC");
    let (fake_faucet, fake_collection) = create_many_nft_faucet(&mut t, vec![id.clone()], "COLC");
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    fund(&mut t, quote_faucet, buyer);
    fund_nft_by_id(&mut t, fake_faucet, seller, id.clone());

    let buyer_quote_before = account_balance(&mut t, buyer, quote);
    let bid = create_bid(
        &mut t,
        buyer,
        buyer_proof.clone(),
        &buyer_secret,
        quote,
        collection,
        Amount::from(PRICE),
        1,
        2,
    );
    let wrong_collection = t
        .transaction()
        .call_method(
            seller,
            "withdraw_non_fungible",
            args![fake_collection, id.clone()],
        )
        .put_last_instruction_output_on_workspace("nft")
        .call_method(bid, "fill", args![Workspace("nft"), seller])
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(wrong_collection, vec![seller_proof.clone()]);

    t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(2),
    );
    fund_nft_by_id(&mut t, nft_faucet, seller, id);
    let expired_fill = t
        .transaction()
        .call_method(
            seller,
            "withdraw_non_fungible",
            args![collection, NonFungibleId::from_u64(55)],
        )
        .put_last_instruction_output_on_workspace("nft")
        .call_method(bid, "fill", args![Workspace("nft"), seller])
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(expired_fill, vec![seller_proof]);

    let refund = t
        .transaction()
        .call_method(bid, "refund_expired", args![])
        .build_and_seal(&seller_secret);
    t.execute_expect_success(refund, vec![]);
    assert_eq!(account_balance(&mut t, buyer, quote), buyer_quote_before);

    let duplicate_refund = t
        .transaction()
        .call_method(bid, "refund_expired", args![])
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(duplicate_refund, vec![]);
}
