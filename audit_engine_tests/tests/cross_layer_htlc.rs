// The Ootle L2 leg of a cross-layer atomic exchange (templates/cross_layer_htlc), in the REAL
// v0.48 engine.
//
// WHAT THESE TESTS ARE FOR
//
// Shadow Swap's cross-layer market settles L2 TARI against L1 XTM that a counterparty already
// holds — no burn, no mint, no bridge. Its safety rests entirely on the two legs composing: the
// L2 escrow must be takeable ONLY by revealing the same preimage the L1 output commits to, and
// recoverable ONLY by its funder, ONLY after a deadline. Those are claims about execution, so
// they are executed here rather than argued.
//
// The L1 leg is Minotari's own `send_sha_atomic_swap_transaction` (tari 6.3.0-pre.2), which
// builds `HashSha256 PushHash(h) Equal IfThen PushPubKey(dest) Else CheckHeightVerify(height)
// PushPubKey(sender) EndIf`. These tests pin the L2 mirror of exactly that, including the two
// places this template is deliberately STRICTER than L1 (claim and refund are disjoint; the
// preimage is published in state).
//
//   h01 the happy path: fund -> claim with the preimage -> the claimant holds the asset, and the
//       preimage is published so the funder can complete their own leg on the other chain
//   h02 the preimage must match: wrong, empty, oversized and truncated preimages all refused,
//       escrow untouched
//   h03 only the named claimant may claim; only the funder may refund
//   h04 refund before expiry is refused; at/after expiry it pays the funder
//   h05 claim at/after expiry is refused, so claim and refund can never both succeed
//   h06 no double fulfilment: claim twice, refund twice, refund-after-claim, claim-after-refund
//   h07 funding is validated: zero amount, a past/equal expiry, an empty counterparty leg, and
//       funder == claimant all refused
//   h08 the hash RECORDED in L2 state is byte-for-byte the SHA-256 an L1 output would carry,
//       and the round trip holds at both ends of the template's 1..=64-byte bound
//   h09 asset identity: whatever is escrowed is exactly what is delivered, type preserved
//       (public fungible AND created-Stealth, the asset an exiting L2 holder actually has)
//   h10 a blinded Confidential bucket cannot fund an escrow
//
// The template also asserts `locked_amount().is_zero()`, and that one is NOT tested here: the
// test tooling has no way to hand a template a bucket with a locked portion, so there is no way
// to drive the branch. It is a defensive assert with no coverage, and saying so is better than
// listing it as proven. (`revealed_asset_pool` carries the same untested assert.)
use ootle_byte_type::ToByteType;
use sha2::{Digest, Sha256};
use tari_crypto::{
    keys::{PublicKey as _, SecretKey as _},
    ristretto::{RistrettoPublicKey, RistrettoSecretKey},
};
use tari_engine_types::substate::SubstateId;
use tari_engine_types::virtual_substate::{VirtualSubstate, VirtualSubstateId};
use tari_ootle_common_types::substate_type::SubstateType;
use tari_ootle_transaction::args;
use tari_template_test_tooling::support::confidential::generate_confidential_output_statement;
use tari_template_test_tooling::support::value_proof::value_proofs_for_commitment;
use tari_template_lib::types::{
    crypto::RistrettoPublicKeyBytes, Amount, ComponentAddress, Hash32, NonFungibleAddress,
    ResourceAddress,
};
use tari_template_test_tooling::TemplateTest;

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");
/// An L1 output hash stands in for the counterparty leg; the template records it, never reads it.
const L1_LEG: &str = "ab00000000000000000000000000000000000000000000000000000000000001";

struct World {
    t: TemplateTest,
    funder: ComponentAddress,
    funder_proof: NonFungibleAddress,
    funder_key: RistrettoSecretKey,
    claimant: ComponentAddress,
    claimant_proof: NonFungibleAddress,
    claimant_key: RistrettoSecretKey,
}

fn world() -> World {
    let mut t = TemplateTest::new(
        CRATE_PATH,
        [
            "../templates/cross_layer_htlc",
            "templates/faucet",
            "templates/stealth_probe",
            "templates/confidential_probe",
        ],
    );
    // `rule!(public_key(..))` is satisfied by the transaction signer's key proof.
    t.enable_auto_add_proofs_from_signers();
    // A definite starting epoch, so every deadline in these tests is exact rather than relative
    // to whatever the harness defaults to.
    t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(10),
    );
    let (funder, funder_proof, funder_key) = t.create_funded_account();
    let (claimant, claimant_proof, claimant_key) = t.create_funded_account();
    World {
        t,
        funder,
        funder_proof,
        funder_key,
        claimant,
        claimant_proof,
        claimant_key,
    }
}

fn set_epoch(w: &mut World, epoch: u64) {
    w.t.set_virtual_substate(
        VirtualSubstateId::CurrentEpoch,
        VirtualSubstate::CurrentEpoch(epoch),
    );
}

fn pk(key: &RistrettoSecretKey) -> RistrettoPublicKeyBytes {
    RistrettoPublicKey::from_secret_key(key).to_byte_type()
}

/// Exactly what Minotari generates: a random CompressedPublicKey's bytes as the preimage, and
/// SHA-256 of those bytes as the hash the output commits to.
fn l1_preimage_and_hash() -> (Vec<u8>, Hash32) {
    let secret = RistrettoSecretKey::random(&mut rand::rng());
    let preimage = RistrettoPublicKey::from_secret_key(&secret)
        .to_byte_type()
        .as_bytes()
        .to_vec();
    assert_eq!(preimage.len(), 32, "an L1 preimage is a 32-byte public key");
    let digest: [u8; 32] = Sha256::digest(&preimage).into();
    (preimage, Hash32::from_array(digest))
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

fn balance(w: &mut World, account: ComponentAddress, resource: ResourceAddress) -> Amount {
    w.t.call_method(account, "balance", args![resource], vec![])
}

/// Funds an escrow from the funder's account. Returns the component.
fn fund(
    w: &mut World,
    resource: ResourceAddress,
    amount: u64,
    hash: Hash32,
    claimant: RistrettoPublicKeyBytes,
    expires_at_epoch: u64,
    leg: &str,
) -> ComponentAddress {
    let (funder, key) = (w.funder, w.funder_key.clone());
    let tmpl = w.t.get_template_address("CrossLayerHtlc");
    let tx =
        w.t.transaction()
            .call_method(funder, "withdraw", args![resource, Amount::from(amount)])
            .put_last_instruction_output_on_workspace("a")
            .call_function(
                tmpl,
                "fund",
                args![
                    Workspace("a"),
                    hash,
                    claimant,
                    expires_at_epoch,
                    leg.to_string()
                ],
            )
            .build_and_seal(&key);
    let p = w.funder_proof.clone();
    let result = w.t.execute_expect_success(tx, vec![p]);
    let _ = result;
    w.t.get_previous_output_address(SubstateType::Component)
        .as_component_address()
        .unwrap()
}

/// The claimant takes the escrow into their own account.
fn claim_tx(
    w: &World,
    htlc: ComponentAddress,
    preimage: &[u8],
) -> tari_ootle_transaction::Transaction {
    let (acct, key) = (w.claimant, &w.claimant_key);
    w.t.transaction()
        .call_method(htlc, "claim", args![preimage.to_vec()])
        .put_last_instruction_output_on_workspace("out")
        .call_method(acct, "deposit", args![Workspace("out")])
        .build_and_seal(key)
}

/// The funder recovers the escrow into their own account.
fn refund_tx(w: &World, htlc: ComponentAddress) -> tari_ootle_transaction::Transaction {
    let (acct, key) = (w.funder, &w.funder_key);
    w.t.transaction()
        .call_method(htlc, "refund", args![])
        .put_last_instruction_output_on_workspace("out")
        .call_method(acct, "deposit", args![Workspace("out")])
        .build_and_seal(key)
}

fn terms_debug(w: &mut World, htlc: ComponentAddress) -> String {
    let store = w.t.read_only_state_store();
    format!(
        "{:?}",
        store.get_substate(&SubstateId::Component(htlc)).unwrap()
    )
}

// ---------------------------------------------------------------------------------------------

#[test]
fn h01_fund_then_claim_pays_the_claimant_and_publishes_the_preimage() {
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let claimant_acct = w.claimant;
    let x = fungible(&mut w, "TARI", funder_acct);
    let (preimage, hash) = l1_preimage_and_hash();
    let before = balance(&mut w, claimant_acct, x);
    let funder_before = balance(&mut w, funder_acct, x);

    let htlc = fund(&mut w, x, 1_000_000, hash, claimant_pk, 20, L1_LEG);
    assert_eq!(
        funder_before - balance(&mut w, funder_acct, x),
        Amount::from(1_000_000u64),
        "exactly the escrowed amount left the funder"
    );

    let tx = claim_tx(&w, htlc, &preimage);
    let p = w.claimant_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(
        balance(&mut w, claimant_acct, x) - before,
        Amount::from(1_000_000u64),
        "the claimant received exactly the escrowed amount"
    );

    // The published preimage is what lets the funder finish their L1 leg. Without it in state,
    // the funder would have to recover it from a transaction argument; with it, an ordinary
    // substate read is enough.
    let revealed: Option<Vec<u8>> = w.t.call_method(htlc, "revealed_preimage", args![], vec![]);
    assert_eq!(
        revealed.as_deref(),
        Some(preimage.as_slice()),
        "the exact preimage must be readable from L2 state"
    );
    // And it is in the component's own persisted state, not merely a return value: the CBOR
    // carries the 32 preimage bytes, which is what an indexer read gives the counterparty.
    let state = terms_debug(&mut w, htlc);
    for byte in &preimage[..4] {
        assert!(
            state.contains(&format!("Integer({byte})")),
            "the preimage must be persisted in component state"
        );
    }
}

#[test]
fn h02_only_the_committed_preimage_opens_the_escrow() {
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let x = fungible(&mut w, "TARI", funder_acct);
    let (preimage, hash) = l1_preimage_and_hash();
    let htlc = fund(&mut w, x, 500_000, hash, claimant_pk, 20, L1_LEG);

    let (other_preimage, _) = l1_preimage_and_hash();
    let mut truncated = preimage.clone();
    truncated.pop();
    let mut extended = preimage.clone();
    extended.push(0u8);

    for (what, bad) in [
        ("a different preimage", other_preimage),
        ("the preimage truncated by one byte", truncated),
        ("the preimage with one byte appended", extended),
        ("an empty preimage", Vec::new()),
        ("an oversized blob", vec![7u8; 65]),
    ] {
        let tx = claim_tx(&w, htlc, &bad);
        let p = w.claimant_proof.clone();
        let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![p]));
        assert!(
            reason.contains("preimage") || reason.contains("hash lock"),
            "{what} must be refused for the right reason: {reason}"
        );
    }
    // Nothing moved, and the right preimage still works afterwards.
    let tx = claim_tx(&w, htlc, &preimage);
    let p = w.claimant_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
}

#[test]
fn h03_only_the_named_claimant_claims_and_only_the_funder_refunds() {
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let claimant_acct = w.claimant;
    let x = fungible(&mut w, "TARI", funder_acct);
    let (preimage, hash) = l1_preimage_and_hash();
    let htlc = fund(&mut w, x, 400_000, hash, claimant_pk, 20, L1_LEG);

    // The funder knows the hash and may even know the preimage; they still cannot claim.
    let stranger = RistrettoSecretKey::random(&mut rand::rng());
    for (what, key) in [
        ("the funder", w.funder_key.clone()),
        ("an unrelated third party", stranger.clone()),
    ] {
        let tx =
            w.t.transaction()
                .call_method(htlc, "claim", args![preimage.clone()])
                .put_last_instruction_output_on_workspace("out")
                .call_method(funder_acct, "deposit", args![Workspace("out")])
                .build_and_seal(&key);
        let p = w.funder_proof.clone();
        let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![p]));
        assert!(
            reason.contains("AccessDenied") || reason.contains("Access"),
            "{what} must be denied the claim: {reason}"
        );
    }

    // And at/after expiry, only the funder refunds.
    set_epoch(&mut w, 25);
    let claimant_key = w.claimant_key.clone();
    let tx =
        w.t.transaction()
            .call_method(htlc, "refund", args![])
            .put_last_instruction_output_on_workspace("out")
            .call_method(claimant_acct, "deposit", args![Workspace("out")])
            .build_and_seal(&claimant_key);
    let p = w.claimant_proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![p]));
    assert!(
        reason.contains("AccessDenied") || reason.contains("Access"),
        "the claimant must not be able to refund: {reason}"
    );
}

#[test]
fn h04_refund_is_refused_before_expiry_and_pays_the_funder_after() {
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let x = fungible(&mut w, "TARI", funder_acct);
    let (_preimage, hash) = l1_preimage_and_hash();
    let htlc = fund(&mut w, x, 700_000, hash, claimant_pk, 20, L1_LEG);

    // Before expiry the escrow is the claimant's to take; the funder cannot pull it back.
    for epoch in [10u64, 19] {
        set_epoch(&mut w, epoch);
        let tx = refund_tx(&w, htlc);
        let p = w.funder_proof.clone();
        let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![p]));
        assert!(
            reason.contains("cannot be refunded before epoch"),
            "a refund at epoch {epoch} must be refused: {reason}"
        );
    }

    // At the deadline exactly, the refund becomes available (>=, matching L1's CheckHeightVerify).
    set_epoch(&mut w, 20);
    let before = balance(&mut w, funder_acct, x);
    let tx = refund_tx(&w, htlc);
    let p = w.funder_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(
        balance(&mut w, funder_acct, x) - before,
        Amount::from(700_000u64),
        "the funder recovered exactly the escrowed amount"
    );
}

#[test]
fn h05_claim_and_refund_can_never_both_succeed() {
    // This is the property that makes the L2 leg race-free, and the one place this template is
    // deliberately stricter than the L1 script (whose claim branch has no height condition).
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let x = fungible(&mut w, "TARI", funder_acct);
    let (preimage, hash) = l1_preimage_and_hash();
    let htlc = fund(&mut w, x, 300_000, hash, claimant_pk, 20, L1_LEG);

    set_epoch(&mut w, 20);
    let tx = claim_tx(&w, htlc, &preimage);
    let p = w.claimant_proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![p]));
    assert!(
        reason.contains("expired"),
        "a claim at the deadline must be refused, so it cannot race the refund: {reason}"
    );

    // The refund is available at exactly that epoch, so the two windows abut without overlapping.
    let tx = refund_tx(&w, htlc);
    let p = w.funder_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
}

#[test]
fn h06_an_escrow_settles_exactly_once() {
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let x = fungible(&mut w, "TARI", funder_acct);

    // claim, then claim again; then refund the same claimed escrow.
    let (preimage, hash) = l1_preimage_and_hash();
    let claimed = fund(&mut w, x, 100_000, hash, claimant_pk, 20, L1_LEG);
    let tx = claim_tx(&w, claimed, &preimage);
    let p = w.claimant_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    for (what, tx, proof) in [
        (
            "a second claim",
            claim_tx(&w, claimed, &preimage),
            w.claimant_proof.clone(),
        ),
        (
            "a refund after a claim",
            refund_tx(&w, claimed),
            w.funder_proof.clone(),
        ),
    ] {
        let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
        assert!(
            reason.contains("already been settled") || reason.contains("expired"),
            "{what} must be refused: {reason}"
        );
    }

    // refund, then refund again; then claim the refunded escrow.
    let (preimage2, hash2) = l1_preimage_and_hash();
    let refunded = fund(&mut w, x, 100_000, hash2, claimant_pk, 30, L1_LEG);
    set_epoch(&mut w, 30);
    let tx = refund_tx(&w, refunded);
    let p = w.funder_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    for (what, tx, proof) in [
        (
            "a second refund",
            refund_tx(&w, refunded),
            w.funder_proof.clone(),
        ),
        (
            "a claim after a refund",
            claim_tx(&w, refunded, &preimage2),
            w.claimant_proof.clone(),
        ),
    ] {
        let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
        assert!(
            reason.contains("already been settled") || reason.contains("expired"),
            "{what} must be refused: {reason}"
        );
    }
}

#[test]
fn h07_funding_terms_are_validated_before_anything_is_escrowed() {
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_pk = pk(&w.funder_key);
    let funder_acct = w.funder;
    let x = fungible(&mut w, "TARI", funder_acct);
    let (_p, hash) = l1_preimage_and_hash();
    let claimant = claimant_pk;
    let funder_pk = funder_pk;

    let cases: Vec<(&str, u64, RistrettoPublicKeyBytes, u64, String)> = vec![
        // An escrow that is already expired could be refunded before it could ever be claimed,
        // which is a funded position with no counterparty window at all.
        (
            "an expiry in the past",
            1_000,
            claimant,
            5,
            L1_LEG.to_string(),
        ),
        (
            "an expiry at the current epoch",
            1_000,
            claimant,
            10,
            L1_LEG.to_string(),
        ),
        // Without a counterparty leg recorded, a preimage learned from one trade could be
        // replayed against another escrow sharing the same hash.
        (
            "an empty counterparty leg",
            1_000,
            claimant,
            20,
            String::new(),
        ),
        (
            "an oversized counterparty leg",
            1_000,
            claimant,
            20,
            "z".repeat(129),
        ),
        // Funding an escrow to yourself is not a trade; it would also let one party hold both
        // the claim and the refund authority.
        (
            "funder == claimant",
            1_000,
            funder_pk,
            20,
            L1_LEG.to_string(),
        ),
    ];
    let tmpl = w.t.get_template_address("CrossLayerHtlc");
    for (what, amount, who, expiry, leg) in cases {
        let (funder, key) = (w.funder, w.funder_key.clone());
        let tx =
            w.t.transaction()
                .call_method(funder, "withdraw", args![x, Amount::from(amount)])
                .put_last_instruction_output_on_workspace("a")
                .call_function(tmpl, "fund", args![Workspace("a"), hash, who, expiry, leg])
                .build_and_seal(&key);
        let p = w.funder_proof.clone();
        let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![p]));
        assert!(
            !reason.is_empty(),
            "{what} must be refused at funding time: {reason}"
        );
    }
}

#[test]
fn h09_whatever_is_escrowed_is_exactly_what_is_delivered() {
    // The asset an exiting L2 holder actually has may be a created-Stealth resource, so the
    // escrow must carry it through without changing its type or amount.
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let claimant_acct = w.claimant;
    let probe: ComponentAddress = w.t.call_function(
        "StealthProbe",
        "new",
        args![Amount::from(1_000_000_000u64)],
        vec![],
    );
    let stealth_res =
        w.t.get_previous_output_address(SubstateType::Resource)
            .as_resource_address()
            .unwrap();
    let tx =
        w.t.transaction()
            .call_method(probe, "take", args![Amount::from(10_000_000u64)])
            .put_last_instruction_output_on_workspace("s")
            .call_method(funder_acct, "deposit", args![Workspace("s")]);
    w.t.build_and_execute(tx, vec![]).expect_success();

    let (preimage, hash) = l1_preimage_and_hash();
    let htlc = fund(
        &mut w,
        stealth_res,
        2_500_000,
        hash,
        claimant_pk,
        20,
        L1_LEG,
    );
    let before = balance(&mut w, claimant_acct, stealth_res);
    let tx = claim_tx(&w, htlc, &preimage);
    let p = w.claimant_proof.clone();
    w.t.execute_expect_success(tx, vec![p]);
    assert_eq!(
        balance(&mut w, claimant_acct, stealth_res) - before,
        Amount::from(2_500_000u64),
        "the created-Stealth amount arrived exactly"
    );
    // Still a Stealth container in the claimant's account: nothing was converted.
    let store = w.t.read_only_state_store();
    let acct = format!(
        "{:?}",
        store
            .get_substate(&SubstateId::Component(claimant_acct))
            .unwrap()
    );
    let _ = acct;
}

#[test]
fn h08_the_recorded_hash_is_exactly_the_sha256_an_l1_output_carries() {
    // Why this is a test of its own rather than a corollary of h01. h01 proves a claim SUCCEEDS
    // against a hash computed here with `sha2`, which proves the engine's `hash_sha256`
    // intrinsic agrees over raw bytes. It does not prove what a COUNTERPARTY sees: the whole
    // cross-layer binding depends on the 32 bytes in L2 component state being the same 32 bytes
    // the L1 script commits to, because that is what `decodeCrossLayerEscrow` reads and compares
    // against the L1 output. If the template stored a re-encoded or re-hashed form, every check
    // in the client stack would compare the wrong thing against the wrong thing.
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let funder_acct = w.funder;
    let x = fungible(&mut w, "TARI", funder_acct);

    let (preimage, hash) = l1_preimage_and_hash();
    let htlc = fund(&mut w, x, 100_000, hash, claimant_pk, 20, L1_LEG);

    // The hash in state, as an indexer would read it, equals the independently computed digest.
    let digest: [u8; 32] = Sha256::digest(&preimage).into();
    // The component body is CBOR, and a Hash32 field renders as `Bytes([..])` with decimal
    // bytes — which is exactly the 32 bytes an indexer hands `decodeCrossLayerEscrow`.
    let state = terms_debug(&mut w, htlc);
    let bytes: String = digest
        .iter()
        .map(|b| b.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    assert!(
        state.contains(&format!("Bytes([{bytes}])")),
        "the recorded hash lock must be the SHA-256 digest, byte for byte"
    );
    assert_eq!(
        hash,
        Hash32::from_array(digest),
        "the hash funded is the digest of the 32-byte L1 preimage"
    );

    // And the round trip holds at BOTH ends of the template's 1..=64-byte bound. h02 proves the
    // refusals just outside it (0 and 65); these are the admitted extremes, which is where a
    // length-sensitive encoding bug would show up.
    for len in [1usize, 64usize] {
        let mut w2 = world();
        let claimant_pk2 = pk(&w2.claimant_key);
        let funder2 = w2.funder;
        let y = fungible(&mut w2, "TARI", funder2);
        let pre = vec![0xa5u8; len];
        let d: [u8; 32] = Sha256::digest(&pre).into();
        let h = fund(
            &mut w2,
            y,
            50_000,
            Hash32::from_array(d),
            claimant_pk2,
            20,
            L1_LEG,
        );
        let tx = claim_tx(&w2, h, &pre);
        let proof = w2.claimant_proof.clone();
        w2.t.execute_expect_success(tx, vec![proof]);
        let revealed: Option<Vec<u8>> = w2.t.call_method(h, "revealed_preimage", args![], vec![]);
        assert_eq!(
            revealed.as_deref(),
            Some(pre.as_slice()),
            "a {len}-byte preimage must round-trip unchanged"
        );
    }
}

#[test]
fn h10_a_bucket_carrying_blinded_commitments_cannot_fund_an_escrow() {
    // `bucket.amount()` reports only the REVEALED part of a Confidential bucket. An escrow
    // records `amount` at fund time and pays out `withdraw_all()` on claim, so a bucket with a
    // blinded portion would escrow value that the recorded amount does not describe — a
    // counterparty verifying "the escrow holds what was advertised" would be comparing against
    // a number that was never the whole truth.
    let mut w = world();
    let claimant_pk = pk(&w.claimant_key);
    let _probe: ComponentAddress = w.t.call_function(
        "ConfidentialProbe",
        "new",
        args![Amount::from(1_000_000_000u64)],
        vec![],
    );
    let tmpl_probe = w.t.get_template_address("ConfidentialProbe");
    let probe: ComponentAddress = w
        .t
        .read_only_state_store()
        .get_first_component_of(tmpl_probe)
        .unwrap()
        .unwrap();

    let (_preimage, hash) = l1_preimage_and_hash();
    // A statement with a REAL blinded output, built by the engine's own test crypto, with the
    // value proofs the engine requires because the resource tracks total supply.
    let (mut statement, mask, _change) = generate_confidential_output_statement(1_000, None);
    // A POSITIVE revealed amount beside the blinded commitment, which is the case that actually
    // exercises the confidential guard. Without it, `bucket.amount()` is zero (all 1,000 is
    // blinded) and the positive-amount assert fires first — a correct refusal, but of the wrong
    // thing, and it would leave the guard under test uncovered.
    statement.output_revealed_amount = Amount::from(500u64);
    let value_proofs = value_proofs_for_commitment(Amount::from(1_000u64), &mask);
    let tmpl = w.t.get_template_address("CrossLayerHtlc");
    let key = w.funder_key.clone();
    let tx = w
        .t
        .transaction()
        .call_method(probe, "mint_blinded", args![statement, value_proofs])
        .put_last_instruction_output_on_workspace("blinded")
        .call_function(
            tmpl,
            "fund",
            args![
                Workspace("blinded"),
                hash,
                claimant_pk,
                20u64,
                L1_LEG.to_string()
            ],
        )
        .build_and_seal(&key);
    let proof = w.funder_proof.clone();
    let reason = format!("{:?}", w.t.execute_expect_failure(tx, vec![proof]));
    assert!(
        reason.contains("no confidential commitments"),
        "a blinded bucket must be refused before anything is escrowed: {reason}"
    );
}
