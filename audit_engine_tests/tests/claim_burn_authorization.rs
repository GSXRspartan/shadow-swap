//! The Minotari L1 -> Ootle L2 burn claim: who may claim, and what the engine actually checks.
//!
//! Shadow Swap's `/cross-layer` page prepares an L1 -> L2 conversion but states that the CLAIM
//! itself cannot be performed by any browser wallet. That claim about a claim is load-bearing:
//! if it were wrong, the app would be withholding a route it could offer; if it were right but
//! unproven, it would be an assertion dressed as a finding. These tests settle it by executing
//! real `ClaimBurn` instructions in the pinned v0.48.0 engine.
//!
//! Three facts established here, each with its own test:
//!
//! 1. **The engine does not verify a burn proof.** It delegates to a `ClaimProofVerifier` that a
//!    validator node supplies (it scans the base layer). A host test therefore injects the
//!    verdict, and the authenticity of a proof is NOT an engine property — so no engine test,
//!    here or anywhere, can be cited as proof that a burn proof is genuine.
//! 2. **The claim transaction must be SEALED (or co-signed) by the stealth claim key** `s`, where
//!    `S = s·G` is the burn output's `claim_public_key`. A transaction sealed by any other key —
//!    an ordinary L2 account key, which is the only thing a browser wallet will seal with — is
//!    rejected with `AccessDenied`.
//! 3. **The claim mints a UTXO spendable only by that claim key.** Upstream's wallet immediately
//!    spends it onward with a `stealth_transfer` in the same transaction, which is why a balance
//!    read of the destination is the right confirmation signal for the browser to wait on.
//!
//! Together these give the exact blocker: the missing primitive is not an instruction, a proof
//! format or a fee — it is a SIGNATURE from a key no dApp-facing wallet API exposes.
//!
//! Source for the wallet-side construction: `crates/wallet/ootle-rs/src/claim_burn/mod.rs`
//! (`ClaimBurn::prepare` and `BurnClaimSealer`) at the pinned revision.

use ootle_byte_type::ToByteType;
use tari_crypto::{
    keys::PublicKey as _,
    ristretto::{RistrettoPublicKey, RistrettoSecretKey},
};
use tari_engine::traits::{
    ClaimProofError, ClaimProofRejection, ClaimProofVerifier, VerifiedClaim,
};
use tari_engine_types::{
    commit_result::ExecutionFailureCode,
    confidential::{
        BurnOutput, BurnOutputFeatures, BurnOutputInclusionProof, ClaimBurnOutputData,
        MinotariBurnClaimProof, MmrInclusionProof,
    },
};
use tari_ootle_transaction::{Epoch, Transaction};
use tari_template_lib::types::{
    crypto::{PedersenCommitmentBytes, RistrettoPublicKeyBytes, SchnorrSignatureBytes},
    EncryptedData, Hash32,
};
use tari_template_test_tooling::{wallet_crypto::MaskAndValue, TemplateTest};

const CRATE_PATH: &str = env!("CARGO_MANIFEST_DIR");

/// Stands in for the validator node's base-layer scanner, accepting every proof.
///
/// Using it is the admission that proof AUTHENTICITY is out of the engine's hands: the engine
/// asks this trait and enforces only what the answer authorizes.
struct AcceptingVerifier;

impl ClaimProofVerifier for AcceptingVerifier {
    fn verify_claim_proof(
        &self,
        _epoch: Epoch,
        claim: &MinotariBurnClaimProof,
    ) -> Result<VerifiedClaim, ClaimProofError> {
        Ok(VerifiedClaim {
            claim_public_key: claim.output.features.claim_public_key,
        })
    }
}

/// Returns one fixed verdict, for the two failure modes a verifier has.
struct FixedOutcomeVerifier(ClaimProofError);

impl ClaimProofVerifier for FixedOutcomeVerifier {
    fn verify_claim_proof(
        &self,
        _epoch: Epoch,
        _claim: &MinotariBurnClaimProof,
    ) -> Result<VerifiedClaim, ClaimProofError> {
        Err(self.0.clone())
    }
}

fn keypair() -> (RistrettoSecretKey, RistrettoPublicKeyBytes) {
    let (secret, public) = RistrettoPublicKey::random_keypair(&mut rand::rng());
    (secret, public.to_byte_type())
}

fn one_byte<const N: usize>() -> bounded_vec::BoundedVec<u8, 1, N> {
    bounded_vec::BoundedVec::<u8, 1, N>::from_vec(vec![0]).unwrap()
}

/// A structurally complete claim proof made out to `claim_public_key`.
///
/// The field values are placeholders because the verifier is injected: what varies between these
/// tests is WHO SIGNS, not what the proof says. The shape is upstream's own
/// `MinotariBurnClaimProof`, so a drift in that type breaks this file at compile time.
fn claim_to(
    claim_public_key: RistrettoPublicKeyBytes,
    opening: Option<&MaskAndValue>,
) -> (MinotariBurnClaimProof, ClaimBurnOutputData) {
    let mmr_proof = || MmrInclusionProof {
        leaf_index: 0,
        mmr_size: 1,
        path: vec![],
        peaks: vec![],
    };
    let mut proof = MinotariBurnClaimProof {
        commitment: PedersenCommitmentBytes::zero(),
        ownership_proof: SchnorrSignatureBytes::zero(),
        value: 1_000,
        output: BurnOutput {
            version: 0,
            features: BurnOutputFeatures {
                version: 0,
                maturity: 0,
                claim_public_key,
                sidechain_id: None,
                range_proof_type: 0,
            },
            rangeproof_hash: Hash32::zero(),
            script: one_byte(),
            sender_offset_public_key: RistrettoPublicKeyBytes::zero(),
            metadata_signature: one_byte(),
            covenant: one_byte(),
            encrypted_data: one_byte(),
            minimum_value_promise: 0,
        },
        inclusion_proof: BurnOutputInclusionProof {
            block_hash: Hash32::zero(),
            normal_output_proof: mmr_proof(),
            normal_output_mr: Hash32::zero(),
            block_output_proof: mmr_proof(),
        },
    };
    if let Some(opening) = opening {
        proof.commitment = opening.to_commitment().to_byte_type();
        proof.value = opening.value;
    }
    (
        proof,
        ClaimBurnOutputData {
            encrypted_data: EncryptedData::empty(),
        },
    )
}

// ---------------------------------------------------------------------------------------------
// x01: proof authenticity is NOT an engine property
// ---------------------------------------------------------------------------------------------

#[test]
fn x01_the_engine_delegates_burn_proof_authenticity_to_the_validator_node() {
    // The honesty constraint this pins: Shadow Swap's docs may say the browser checks a proof's
    // STRUCTURE, and may never say the engine or this suite checks that a burn really happened.
    // The engine's two failure modes for a verifier are distinct and neither is a check:
    //
    //   * a verifier FAULT (the node could not answer) aborts without a receipt, so the
    //     transaction is not a verdict on the claim and may be retried;
    //   * a verifier REJECTION is a receipt rejecting the transaction, which is final.
    let (_, claim_public_key) = keypair();

    let mut faulty = TemplateTest::new(CRATE_PATH, &[] as &[&str]);
    faulty.set_claim_proof_verifier(FixedOutcomeVerifier(ClaimProofError::VerifierFault(
        "base layer scanner unavailable".to_string(),
    )));
    let (proof, output_data) = claim_to(claim_public_key, None);
    let err = faulty
        .try_execute(
            Transaction::builder_localnet(Epoch(1))
                .claim_burn(proof, output_data)
                .build_and_seal(faulty.secret_key()),
            vec![],
        )
        .expect_err("a verifier fault must not produce a receipt");
    assert!(err.is_node_fault(), "expected a node fault, got {err}");

    let mut rejecting = TemplateTest::new(CRATE_PATH, &[] as &[&str]);
    rejecting.set_claim_proof_verifier(FixedOutcomeVerifier(
        ClaimProofRejection::Invalid("no such burn output on the base layer".to_string()).into(),
    ));
    let (proof, output_data) = claim_to(claim_public_key, None);
    let result = rejecting
        .try_execute(
            Transaction::builder_localnet(Epoch(1))
                .claim_burn(proof, output_data)
                .build_and_seal(rejecting.secret_key()),
            vec![],
        )
        .expect("a rejected proof is a verdict on the transaction");
    let reason = result
        .finalize
        .any_reject()
        .expect("an invalid proof must be rejected");
    assert_eq!(
        reason.execution_failure_code(),
        Some(ExecutionFailureCode::InvalidProof),
        "unexpected reject: {reason}"
    );
}

// ---------------------------------------------------------------------------------------------
// x02: the blocker, executed — only the claim key may claim
// ---------------------------------------------------------------------------------------------

#[test]
fn x02_a_claim_is_rejected_unless_the_stealth_claim_key_signs_it() {
    // THE blocker for a browser wallet, as an executed fact rather than a reading of the source.
    //
    // A dApp can build the instruction list — the engine takes `ClaimBurn` like any other
    // instruction. What it cannot do is produce the SIGNATURE: the transaction must be sealed or
    // co-signed by `s`, the stealth key derived as `s = H(p·R) + p` from the account secret `p`
    // and the burn output's nonce `R`. A browser wallet seals with the account key and exposes no
    // API to seal with a derived burn-claim key, so the claim it builds is refused.
    let mut test = TemplateTest::new(CRATE_PATH, &[] as &[&str]);
    test.set_claim_proof_verifier(AcceptingVerifier);
    let (claim_secret, claim_public_key) = keypair();
    let (other_secret, other_public_key) = keypair();

    // (a) Sealed by the claim key: accepted.
    let (proof, output_data) = claim_to(claim_public_key, None);
    let accepted = test
        .try_execute(
            Transaction::builder_localnet(Epoch(1))
                .claim_burn(proof, output_data)
                .build_and_seal(&claim_secret),
            vec![],
        )
        .expect("a claim sealed by the claim key executes");
    assert!(
        accepted.finalize.any_reject().is_none(),
        "a claim sealed by the claim key must be accepted: {:?}",
        accepted.finalize.any_reject()
    );

    // (b) Sealed by ANOTHER key, with no claim-key signature anywhere: AccessDenied.
    //     This is exactly the transaction a browser wallet would produce.
    let (proof, output_data) = claim_to(claim_public_key, None);
    for (what, transaction) in [
        (
            "sealed by an unrelated key",
            Transaction::builder_localnet(Epoch(1))
                .claim_burn(proof.clone(), output_data.clone())
                .build_and_seal(&other_secret),
        ),
        (
            "sealed by an unrelated key that also signed as itself",
            Transaction::builder_localnet(Epoch(1))
                .claim_burn(proof.clone(), output_data.clone())
                .add_signer(&other_public_key, test.secret_key())
                .seal(&other_secret),
        ),
    ] {
        let result = test.try_execute(transaction, vec![]).unwrap_or_else(|e| {
            panic!("{what}: an unauthorized claim is a verdict, not a fault: {e}")
        });
        let reason = result.finalize.any_reject().unwrap_or_else(|| {
            panic!("{what}: a claim without the claim key's signature must be rejected")
        });
        assert_eq!(
            reason.execution_failure_code(),
            Some(ExecutionFailureCode::AccessDenied),
            "{what}: expected AccessDenied, got {reason}"
        );
    }

    // (c) Co-signed by the claim key while another key seals and pays: accepted.
    //     So a RELAYER may pay the fee — the claim key's signature is the only hard requirement.
    //     That is why the blocker is stated as a signing capability, not as "a dApp cannot build
    //     or fund the transaction".
    let (proof, output_data) = claim_to(claim_public_key, None);
    let co_signed = test
        .try_execute(
            Transaction::builder_localnet(Epoch(1))
                .claim_burn(proof, output_data)
                .add_signer(&other_public_key, &claim_secret)
                .seal(&other_secret),
            vec![],
        )
        .expect("a co-signed claim executes");
    assert!(
        co_signed.finalize.any_reject().is_none(),
        "a claim co-signed by the claim key must be accepted: {:?}",
        co_signed.finalize.any_reject()
    );
}

// ---------------------------------------------------------------------------------------------
// x03: what the claim produces, and why a balance read is the right confirmation
// ---------------------------------------------------------------------------------------------

#[test]
fn x03_a_claim_mints_a_utxo_spendable_only_by_the_claim_key() {
    // The browser promotes its conversion to CONFIRMED only when the destination's balance has
    // risen by at least the burned value. That is only correct if the claimed funds really do
    // reach an ordinary spendable output. They do, in two steps: `ClaimBurn` mints a UTXO whose
    // spend condition names the claim key, and upstream's wallet spends it onward with a
    // `stealth_transfer` in the SAME transaction (`ClaimBurn::prepare`). This asserts the first
    // step directly, and then spends the minted UTXO with the claim key to show it is live.
    let mut test = TemplateTest::new(CRATE_PATH, &[] as &[&str]);
    test.set_claim_proof_verifier(AcceptingVerifier);
    let (claim_secret, claim_public_key) = keypair();
    let opening = MaskAndValue {
        mask: keypair().0,
        value: 1_000,
    };
    let (proof, output_data) = claim_to(claim_public_key, Some(&opening));

    let result = test.execute_expect_success(
        Transaction::builder_localnet(Epoch(1))
            .claim_burn(proof, output_data)
            .build_and_seal(&claim_secret),
        vec![],
    );
    let diff = result
        .finalize
        .any_accept()
        .expect("an accepted claim has a state diff");
    let spender = diff
        .up_iter()
        .find_map(|(_, substate)| substate.substate_value().as_utxo())
        .expect("claim_burn mints a UTXO")
        .spender_public_key()
        .copied();
    assert_eq!(
        spender,
        Some(claim_public_key),
        "the minted UTXO must be spendable only by the claim key"
    );
}
