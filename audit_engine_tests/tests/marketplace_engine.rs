// Real Ootle-engine regressions for the fixed-price public-NFT escrow component.
// These tests exercise the actual marketplace WASM; no frontend or metadata assertion is used
// as settlement evidence.

use tari_crypto::ristretto::RistrettoSecretKey;
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_lib::types::{
    Amount, ComponentAddress, NonFungibleAddress, NonFungibleId, ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
const PRICE: u64 = 100_000u64;

fn new_test() -> TemplateTest {
    TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/nft_marketplace",
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

fn create_listing(
    t: &mut TemplateTest,
    seller: ComponentAddress,
    seller_proof: NonFungibleAddress,
    seller_secret: &RistrettoSecretKey,
    nft_resource: ResourceAddress,
    nft_id: NonFungibleId,
    quote: ResourceAddress,
    price: Amount,
    expiry: u64,
) -> ComponentAddress {
    let template = t.get_template_address("FixedPriceListing");
    let result = t.execute_expect_success(
        t.transaction()
            .call_method(seller, "withdraw_non_fungible", args![nft_resource, nft_id])
            .put_last_instruction_output_on_workspace("nft")
            .call_function(
                template,
                "create",
                args![seller, Workspace("nft"), quote, price, expiry],
            )
            .build_and_seal(seller_secret),
        vec![seller_proof],
    );
    let listing: ComponentAddress = {
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
            .expect("listing component not found")
    };
    drop(result);
    listing
}

fn account_balance(
    t: &mut TemplateTest,
    account: ComponentAddress,
    resource: ResourceAddress,
) -> Amount {
    t.call_method(account, "balance", args![resource], vec![])
}

#[test]
fn m01_listing_purchase_escrows_and_settles_exact_nft() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wUSD");
    let nft_id = NonFungibleId::from_u64(123);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, nft_id.clone(), "COLA");
    // Same display metadata/symbol is irrelevant: identity remains the distinct resource address.
    let (_, same_metadata_collection) =
        create_nft_faucet(&mut t, NonFungibleId::from_u64(123), "COLA");
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    fund_nft(&mut t, nft_faucet, seller);
    fund(&mut t, quote_faucet, buyer);

    let listing = create_listing(
        &mut t,
        seller,
        seller_proof.clone(),
        &seller_secret,
        collection,
        nft_id.clone(),
        quote,
        Amount::from(PRICE),
        0,
    );
    assert_eq!(account_balance(&mut t, seller, collection), Amount::zero());

    let seller_quote_before = account_balance(&mut t, seller, quote);
    let buyer_quote_before = account_balance(&mut t, buyer, quote);
    t.execute_expect_success(
        t.transaction()
            .call_method(buyer, "withdraw", args![quote, Amount::from(PRICE)])
            .put_last_instruction_output_on_workspace("payment")
            .call_method(listing, "buy", args![Workspace("payment"), buyer])
            .build_and_seal(&buyer_secret),
        vec![buyer_proof.clone()],
    );
    assert_eq!(
        account_balance(&mut t, seller, quote) - seller_quote_before,
        Amount::from(PRICE)
    );
    assert_eq!(
        buyer_quote_before - account_balance(&mut t, buyer, quote),
        Amount::from(PRICE)
    );
    assert_eq!(
        account_balance(&mut t, buyer, collection),
        Amount::from(1u64)
    );
    assert_eq!(
        account_balance(&mut t, buyer, same_metadata_collection),
        Amount::zero()
    );

    // A successful exact-id withdrawal is engine evidence that the buyer received collection/id
    // `(collection, 123)`, not a look-alike collection or a different NFT.
    t.execute_expect_success(
        t.transaction()
            .call_method(
                buyer,
                "withdraw_non_fungible",
                args![collection, nft_id.clone()],
            )
            .put_last_instruction_output_on_workspace("exact_nft")
            .call_method(buyer, "deposit", args![Workspace("exact_nft")])
            .build_and_seal(&buyer_secret),
        vec![buyer_proof.clone()],
    );

    // A sold listing cannot be purchased a second time.
    let failed = t
        .transaction()
        .call_method(buyer, "withdraw", args![quote, Amount::from(PRICE)])
        .put_last_instruction_output_on_workspace("payment")
        .call_method(listing, "buy", args![Workspace("payment"), buyer])
        .build_and_seal(&buyer_secret);
    t.execute_expect_failure(failed, vec![buyer_proof]);
}

#[test]
fn m02_only_seller_can_cancel_and_cancellation_returns_escrowed_nft() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wUSD");
    let nft_id = NonFungibleId::from_u64(7);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, nft_id.clone(), "COLB");
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    let (attacker, attacker_proof, attacker_secret) = t.create_funded_account();
    fund_nft(&mut t, nft_faucet, seller);
    fund(&mut t, quote_faucet, attacker);
    let listing = create_listing(
        &mut t,
        seller,
        seller_proof.clone(),
        &seller_secret,
        collection,
        nft_id,
        quote,
        Amount::from(PRICE),
        0,
    );

    let unauthorized = t
        .transaction()
        .call_method(listing, "cancel", args![])
        .build_and_seal(&attacker_secret);
    t.execute_expect_failure(unauthorized, vec![attacker_proof]);
    assert_eq!(account_balance(&mut t, seller, collection), Amount::zero());

    t.execute_expect_success(
        t.transaction()
            .call_method(listing, "cancel", args![])
            .build_and_seal(&seller_secret),
        vec![seller_proof],
    );
    assert_eq!(
        account_balance(&mut t, seller, collection),
        Amount::from(1u64)
    );

    let cancelled_buy = t
        .transaction()
        .call_method(attacker, "withdraw", args![quote, Amount::from(PRICE)])
        .put_last_instruction_output_on_workspace("payment")
        .call_method(listing, "buy", args![Workspace("payment"), attacker])
        .build_and_seal(&attacker_secret);
    t.execute_expect_failure(cancelled_buy, vec![]);
}

#[test]
fn m03_listing_rejects_wrong_quote_insufficient_payment_non_nft_and_nft_quote() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wUSD");
    let (wrong_quote_faucet, wrong_quote) = create_fungible_faucet(&mut t, "OTHER");
    let nft_id = NonFungibleId::from_u64(9);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, nft_id.clone(), "COLC");
    let (_, other_collection) = create_nft_faucet(&mut t, NonFungibleId::from_u64(10), "COLD");
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    fund_nft(&mut t, nft_faucet, seller);
    fund(&mut t, quote_faucet, buyer);
    fund(&mut t, quote_faucet, seller);
    fund(&mut t, wrong_quote_faucet, buyer);
    let listing = create_listing(
        &mut t,
        seller,
        seller_proof.clone(),
        &seller_secret,
        collection,
        nft_id.clone(),
        quote,
        Amount::from(PRICE),
        0,
    );

    for (resource, amount) in [
        (wrong_quote, Amount::from(PRICE)),
        (quote, Amount::from(PRICE - 1)),
    ] {
        let rejected = t
            .transaction()
            .call_method(buyer, "withdraw", args![resource, amount])
            .put_last_instruction_output_on_workspace("payment")
            .call_method(listing, "buy", args![Workspace("payment"), buyer])
            .build_and_seal(&buyer_secret);
        t.execute_expect_failure(rejected, vec![buyer_proof.clone()]);
    }

    // A fungible bucket cannot be used as the listing NFT.
    let marketplace = t.get_template_address("FixedPriceListing");
    let non_nft = t
        .transaction()
        .call_method(seller, "withdraw", args![quote, Amount::from(1u64)])
        .put_last_instruction_output_on_workspace("fungible")
        .call_function(
            marketplace,
            "create",
            args![
                seller,
                Workspace("fungible"),
                wrong_quote,
                Amount::from(1u64),
                0u64
            ],
        )
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(non_nft, vec![seller_proof.clone()]);

    // An NFT is not an allowed quote resource, even if it is a different collection.
    let unsupported_quote = t
        .transaction()
        .call_method(seller, "withdraw_non_fungible", args![collection, nft_id])
        .put_last_instruction_output_on_workspace("nft")
        .call_function(
            marketplace,
            "create",
            args![
                seller,
                Workspace("nft"),
                other_collection,
                Amount::from(1u64),
                0u64
            ],
        )
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(unsupported_quote, vec![seller_proof]);
}

#[test]
fn m04_expired_listing_cannot_be_bought_at_the_consensus_epoch_boundary() {
    let mut t = new_test();
    t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(1),
    );
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wUSD");
    let nft_id = NonFungibleId::from_u64(88);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, nft_id.clone(), "COLE");
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    fund_nft(&mut t, nft_faucet, seller);
    fund(&mut t, quote_faucet, buyer);
    let listing = create_listing(
        &mut t,
        seller,
        seller_proof,
        &seller_secret,
        collection,
        nft_id,
        quote,
        Amount::from(PRICE),
        2,
    );
    t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(2),
    );
    let expired_buy = t
        .transaction()
        .call_method(buyer, "withdraw", args![quote, Amount::from(PRICE)])
        .put_last_instruction_output_on_workspace("payment")
        .call_method(listing, "buy", args![Workspace("payment"), buyer])
        .build_and_seal(&buyer_secret);
    t.execute_expect_failure(expired_buy, vec![buyer_proof]);
}
