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

/// The escrow vault's own contents, read from the store rather than inferred from an
/// account balance.
///
/// The live decoder the frontend now uses reports `escrow` straight from this vault, so
/// "the component holds nothing after settlement" is a property the UI depends on and
/// must be engine-proven, not assumed from a net balance difference.
fn escrow_holding(
    t: &mut TemplateTest,
    listing: ComponentAddress,
) -> (ResourceAddress, Amount, Vec<NonFungibleId>) {
    let vaults = t
        .read_only_state_store()
        .get_vaults_for_component(listing)
        .expect("listing escrow vault readable");
    let (_, vault) = vaults
        .iter()
        .next()
        .expect("listing has exactly one escrow vault");
    (
        vault.resource_address(),
        vault.balance(),
        vault.get_non_fungible_ids(),
    )
}

/// LIVE DISCOVERY (Esmeralda 2026-10-07, tx 0af825a4...): a settled listing's escrow vault
/// is EMPTY, and both the seller's chosen settlement account and the buyer's own account
/// receive the exact amounts. `seller_account` is whatever the seller signed at create
/// time; it is not implied to be the account that held the NFT.
#[test]
fn m05_settled_listing_holds_nothing_in_escrow_and_pays_the_signed_settlement_account() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wUSD");
    let nft_id = NonFungibleId::from_u64(41);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, nft_id.clone(), "COLF");
    let (seller, seller_proof, seller_secret) = t.create_funded_account();
    let (buyer, buyer_proof, buyer_secret) = t.create_funded_account();
    // A THIRD account the seller nominates as the settlement destination. This is the
    // live shape: the seller chooses where payment lands, and nothing may change it
    // afterwards.
    let (payee, payee_proof, _) = t.create_funded_account();
    fund_nft(&mut t, nft_faucet, seller);
    fund(&mut t, quote_faucet, buyer);

    let template = t.get_template_address("FixedPriceListing");
    let created = t.execute_expect_success(
        t.transaction()
            .call_method(
                seller,
                "withdraw_non_fungible",
                args![collection, nft_id.clone()],
            )
            .put_last_instruction_output_on_workspace("nft")
            .call_function(
                template,
                "create",
                args![payee, Workspace("nft"), quote, Amount::from(PRICE), 0u64],
            )
            .build_and_seal(&seller_secret),
        vec![seller_proof.clone()],
    );
    let listing: ComponentAddress = created
        .expect_success()
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
        .expect("listing component not found");
    drop(created);

    // While active, the escrow holds exactly the listed NFT and nothing else.
    let (escrow_resource, escrow_amount, escrow_ids) = escrow_holding(&mut t, listing);
    assert_eq!(escrow_resource, collection);
    assert_eq!(
        escrow_amount,
        Amount::zero(),
        "an NFT escrow has no fungible amount"
    );
    assert_eq!(escrow_ids, vec![nft_id.clone()]);

    let payee_before = account_balance(&mut t, payee, quote);
    let seller_before = account_balance(&mut t, seller, quote);
    t.execute_expect_success(
        t.transaction()
            .call_method(buyer, "withdraw", args![quote, Amount::from(PRICE)])
            .put_last_instruction_output_on_workspace("payment")
            .call_method(listing, "buy", args![Workspace("payment"), buyer])
            .build_and_seal(&buyer_secret),
        vec![buyer_proof],
    );

    // Payment landed on the account the SELLER nominated, and nowhere else.
    assert_eq!(
        account_balance(&mut t, payee, quote) - payee_before,
        Amount::from(PRICE)
    );
    assert_eq!(
        account_balance(&mut t, seller, quote),
        seller_before,
        "the NFT-holding account is not the settlement destination unless it nominated itself"
    );
    assert_eq!(
        account_balance(&mut t, buyer, collection),
        Amount::from(1u64)
    );

    // The escrow is empty afterwards. This is what "no residual escrow" means.
    let (after_resource, after_amount, after_ids) = escrow_holding(&mut t, listing);
    assert_eq!(
        after_resource, collection,
        "the escrow vault still exists and names its resource"
    );
    assert_eq!(after_amount, Amount::zero());
    assert!(
        after_ids.is_empty(),
        "a sold listing must escrow nothing; found {after_ids:?}"
    );

    // A sold listing cannot be cancelled back into existence, even by the signer.
    let cancel_after_sell = t
        .transaction()
        .call_method(listing, "cancel", args![])
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(cancel_after_sell, vec![seller_proof]);
    assert_eq!(
        account_balance(&mut t, buyer, collection),
        Amount::from(1u64)
    );
    let (_, final_amount, final_ids) = escrow_holding(&mut t, listing);
    assert_eq!(final_amount, Amount::zero());
    assert!(final_ids.is_empty());
}

/// LIVE DISCOVERY (Esmeralda 2026-10-07, tx 73246824... / ab5267e1...): after a cancel the
/// escrow vault is empty AND the listing's stored status is terminal, so a subsequent buy
/// is refused on status rather than on an absent NFT.
#[test]
fn m06_cancelled_listing_escrows_nothing_and_refuses_every_settlement() {
    let mut t = new_test();
    let (quote_faucet, quote) = create_fungible_faucet(&mut t, "wUSD");
    let nft_id = NonFungibleId::from_u64(42);
    let (nft_faucet, collection) = create_nft_faucet(&mut t, nft_id.clone(), "COLG");
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

    t.execute_expect_success(
        t.transaction()
            .call_method(listing, "cancel", args![])
            .build_and_seal(&seller_secret),
        vec![seller_proof.clone()],
    );
    let (_, amount, ids) = escrow_holding(&mut t, listing);
    assert_eq!(amount, Amount::zero());
    assert!(
        ids.is_empty(),
        "a cancelled listing must escrow nothing; found {ids:?}"
    );
    assert_eq!(
        account_balance(&mut t, seller, collection),
        Amount::from(1u64),
        "cancellation returns the exact NFT to the seller"
    );

    // Buy is refused on the listing's status, not incidentally.
    let reason = t
        .transaction()
        .call_method(buyer, "withdraw", args![quote, Amount::from(PRICE)])
        .put_last_instruction_output_on_workspace("payment")
        .call_method(listing, "buy", args![Workspace("payment"), buyer])
        .build_and_seal(&buyer_secret);
    let failure = t.execute_expect_failure(reason, vec![buyer_proof]);
    assert!(format!("{failure:?}").contains("Listing is not active"));

    // A second cancel is refused too.
    let duplicate = t
        .transaction()
        .call_method(listing, "cancel", args![])
        .build_and_seal(&seller_secret);
    t.execute_expect_failure(duplicate, vec![seller_proof]);
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
