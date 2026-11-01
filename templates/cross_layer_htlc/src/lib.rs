// CrossLayerHtlc: the Ootle L2 leg of a cross-layer atomic exchange (EXPERIMENTAL, UNPUBLISHED).
//
// WHY THIS EXISTS AND WHY SwapOffer CANNOT DO IT
//
// `SwapOffer::fill(payment: Bucket, preimage)` requires the counter-asset as an L2 Bucket in the
// SAME transaction. In a cross-layer exchange the counter-asset is on Minotari L1 and can never
// be an L2 Bucket, so SwapOffer is structurally a same-chain escrow. This template is the
// one-sided shape a cross-chain HTLC needs: ONE party funds ONE asset, a NAMED counterparty may
// take it by revealing a preimage, and the funder recovers it if they do not.
//
// IT MIRRORS THE REAL L1 SCRIPT, which is the only reason the two legs compose.
// Minotari `send_sha_atomic_swap_transaction` (tari 6.3.0-pre.2,
// base_layer/wallet/src/transaction_service/service.rs) builds exactly:
//
//     HashSha256 PushHash(hash) Equal IfThen
//         PushPubKey(destination)                        // claim: recipient, with the preimage
//     Else
//         CheckHeightVerify(height) PushPubKey(sender)   // refund: sender, at/after height
//     EndIf
//
// so: SHA-256 over the preimage bytes, claim by a named key, refund by the funder after a
// deadline. This template is that, with L2 epochs in place of L1 block heights.
//
// TWO DELIBERATE DIFFERENCES FROM L1, both in the safe direction:
//
//   1. L1's claim branch has NO height condition, so on L1 a late claim RACES the refund. Here
//      `claim` is refused at/after expiry and `refund` is refused before it: the two are
//      strictly disjoint, so the L2 leg has no race to lose and no ordering-dependent outcome.
//      The cost is that a claimant holding the preimage still loses the claim if they are late —
//      which is what a timeout means, and what the protocol's margin exists to prevent.
//   2. The revealed preimage is STORED in component state on claim. The counterparty's whole
//      position depends on reading it, and L2 state is indexer-readable, so publication is made
//      explicit rather than left to be recovered from a transaction argument.
//
// The preimage is whatever L1 generated: `send_sha_atomic_swap` picks it itself (a random
// CompressedPublicKey, 32 bytes) and returns it. This template therefore accepts the HASH as an
// input, never generating one, so an L2 escrow can be bound to the hash in an already-funded L1
// output rather than to a hash a counterparty merely claims to have used.
//
// NO OPERATOR: `OwnerRule::None`, no admin method, no fee, no discretionary withdrawal. Only the
// claimant's key can claim; only the funder's key can refund.
use tari_template_lib::intrinsics::hash_sha256;
use tari_template_lib::prelude::*;
use tari_template_lib::types::crypto::RistrettoPublicKeyBytes;

#[template]
mod cross_layer_htlc {
    use super::*;

    pub struct CrossLayerHtlc {
        /// The funded L2 asset. Leaves only through `claim` or `refund`.
        escrow: Vault,
        resource: ResourceAddress,
        /// The exact amount escrowed, recorded so a reader need not trust a vault read.
        amount: Amount,
        /// SHA-256 of the preimage, supplied by the caller — never generated here.
        hash_lock: Hash32,
        /// The only key that may `claim`.
        claimant: RistrettoPublicKeyBytes,
        /// The only key that may `refund`.
        funder: RistrettoPublicKeyBytes,
        /// L2 epoch at/after which `refund` is allowed and `claim` is refused.
        expires_at_epoch: u64,
        /// Binds this escrow to one counterparty leg, so a preimage learned from one trade
        /// cannot be replayed against another escrow that happens to share a hash.
        counterparty_leg: String,
        status: HtlcStatus,
        /// Published on a successful claim: the counterparty completes their own leg with this.
        revealed_preimage: Option<Vec<u8>>,
    }

    impl CrossLayerHtlc {
        /// Funds the L2 leg. The caller's transaction key becomes the funder.
        ///
        /// `expires_at_epoch` is ABSOLUTE and must be in the future: a relative duration would
        /// have to be resolved against some clock, and the only clock that matters here is
        /// consensus'. `counterparty_leg` identifies the other chain's leg (for an L1 Minotari
        /// leg, its output hash) and is recorded, not interpreted.
        pub fn fund(
            asset: Bucket,
            hash_lock: Hash32,
            claimant: RistrettoPublicKeyBytes,
            expires_at_epoch: u64,
            counterparty_leg: String,
        ) -> Component<Self> {
            let amount = asset.amount();
            assert!(
                amount.is_positive(),
                "A cross-layer escrow must be funded with a positive amount"
            );
            assert!(
                expires_at_epoch > Consensus::current_epoch(),
                "expires_at_epoch must be in the future: an escrow that is already expired could be refunded before it could ever be claimed"
            );
            assert!(
                !counterparty_leg.is_empty()
                    && counterparty_leg.len() <= MAX_COUNTERPARTY_LEG_CHARS,
                "counterparty_leg must name the other chain's leg and be at most {} characters",
                MAX_COUNTERPARTY_LEG_CHARS
            );
            // A funded escrow must hold its whole value as spendable, revealed balance: a locked
            // portion could not be paid out on claim, and a blinded portion could not be counted.
            asset.assert_contains_no_confidential_funds();
            assert!(
                asset.locked_amount().is_zero(),
                "A cross-layer escrow cannot be funded with a bucket that has a locked portion"
            );

            let funder = CallerContext::transaction_signer_public_key();
            assert_ne!(
                funder, claimant,
                "The funder and the claimant must be different parties"
            );

            let access_rules = ComponentAccessRules::new()
                .default(AccessRule::DenyAll)
                .method("claim", rule!(public_key(claimant)))
                .method("refund", rule!(public_key(funder)))
                .method("terms", AccessRule::AllowAll)
                .method("revealed_preimage", AccessRule::AllowAll);

            Component::new(Self {
                resource: asset.resource_address(),
                amount,
                escrow: Vault::from_bucket(asset),
                hash_lock,
                claimant,
                funder,
                expires_at_epoch,
                counterparty_leg,
                status: HtlcStatus::Funded,
                revealed_preimage: None,
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(access_rules)
            .create()
        }

        /// The claimant takes the escrow by revealing the preimage, before expiry.
        ///
        /// The preimage is stored, which is what lets the funder complete their own leg on the
        /// other chain. Mutually exclusive with `refund`, and once only.
        pub fn claim(&mut self, preimage: Vec<u8>) -> Bucket {
            assert_eq!(
                self.status,
                HtlcStatus::Funded,
                "This escrow has already been settled"
            );
            // Strictly before expiry: see difference (1) in the module comment.
            assert!(
                Consensus::current_epoch() < self.expires_at_epoch,
                "This escrow expired at epoch {}; it can now only be refunded to the funder",
                self.expires_at_epoch
            );
            assert!(
                !preimage.is_empty() && preimage.len() <= MAX_PREIMAGE_BYTES,
                "A preimage must be 1..={} bytes",
                MAX_PREIMAGE_BYTES
            );
            assert_eq!(
                hash_sha256(&preimage),
                self.hash_lock,
                "The preimage does not match this escrow's hash lock"
            );
            self.status = HtlcStatus::Claimed;
            self.revealed_preimage = Some(preimage);
            self.escrow.withdraw_all()
        }

        /// The funder recovers the escrow at/after expiry. Mutually exclusive with `claim`.
        pub fn refund(&mut self) -> Bucket {
            assert_eq!(
                self.status,
                HtlcStatus::Funded,
                "This escrow has already been settled"
            );
            assert!(
                Consensus::current_epoch() >= self.expires_at_epoch,
                "This escrow cannot be refunded before epoch {}: until then it is the claimant's to take",
                self.expires_at_epoch
            );
            self.status = HtlcStatus::Refunded;
            self.escrow.withdraw_all()
        }

        /// Everything a counterparty needs to verify the escrow before funding their own leg.
        pub fn terms(&self) -> HtlcTerms {
            HtlcTerms {
                resource: self.resource,
                amount: self.amount,
                hash_lock: self.hash_lock,
                claimant: self.claimant,
                funder: self.funder,
                expires_at_epoch: self.expires_at_epoch,
                counterparty_leg: self.counterparty_leg.clone(),
                status: self.status,
                balance: self.escrow.balance(),
            }
        }

        /// The preimage, once a claim has published it. `None` until then.
        pub fn revealed_preimage(&self) -> Option<Vec<u8>> {
            self.revealed_preimage.clone()
        }
    }

    /// An L1 Minotari output hash is 64 hex characters; the bound is generous but finite so a
    /// funder cannot bloat component state.
    const MAX_COUNTERPARTY_LEG_CHARS: usize = 128;
    /// Minotari's preimage is a 32-byte CompressedPublicKey. The bound admits that and a little
    /// more, without admitting an unbounded blob.
    const MAX_PREIMAGE_BYTES: usize = 64;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum HtlcStatus {
        Funded,
        Claimed,
        Refunded,
    }

    #[derive(Clone, Debug)]
    pub struct HtlcTerms {
        pub resource: ResourceAddress,
        pub amount: Amount,
        pub hash_lock: Hash32,
        pub claimant: RistrettoPublicKeyBytes,
        pub funder: RistrettoPublicKeyBytes,
        pub expires_at_epoch: u64,
        pub counterparty_leg: String,
        pub status: HtlcStatus,
        pub balance: Amount,
    }
}
