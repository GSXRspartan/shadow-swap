// SwapOffer: a noncustodial peer-to-peer escrow offer for Tari Ootle (EXPERIMENTAL, UNPUBLISHED).
//
// A maker escrows ONE asset (any fungible amount, the REVEALED balance of a created-Stealth
// resource, or NFTs) and names exactly what they want in return: an exact amount of one
// resource, or one specific NFT. A taker fills it atomically in their own transaction.
//
// Design rules:
//   * Resource-type agnostic by construction: the component never calls an account. `fill`
//     RETURNS the offered asset to the taker's transaction, and the taker's payment stays in
//     the component until the maker claims it. Whatever can live in a vault can be traded.
//   * No operator: OwnerRule::None, no admin method, no fee. Only the maker's transaction key
//     can `claim` proceeds or `cancel`; only the designated taker's key (if any) can `fill`.
//   * Optional SHA-256 hash lock: `fill` must reveal a preimage (HTLC-style). The preimage is
//     public once a fill is submitted; for a binding invitation use `designated_taker`.
//   * Expiry: after `expires_at_epoch` (0 = never) the offer cannot be filled and the maker
//     can always cancel and recover the escrow.
//   * The asset's type is never changed: what is escrowed is exactly what is delivered.
use tari_template_lib::intrinsics::hash_sha256;
use tari_template_lib::prelude::*;
use tari_template_lib::types::crypto::RistrettoPublicKeyBytes;

#[template]
mod p2p_offer {
    use super::*;

    pub struct SwapOffer {
        escrow: Vault,
        proceeds: Vault,
        offered_resource: ResourceAddress,
        want_resource: ResourceAddress,
        want_amount: Amount,
        want_nft: Option<NonFungibleId>,
        hash_lock: Option<Hash32>,
        expires_at_epoch: u64,
        status: OfferStatus,
    }

    impl SwapOffer {
        pub fn create(
            offer: Bucket,
            want_resource: ResourceAddress,
            want_amount: Amount,
            want_nft: Option<NonFungibleId>,
            designated_taker: Option<RistrettoPublicKeyBytes>,
            hash_lock: Option<Hash32>,
            expires_at_epoch: u64,
        ) -> Component<Self> {
            let offered_resource = offer.resource_address();
            assert!(!offer.amount().is_zero(), "The offered bucket is empty");
            assert_ne!(
                offered_resource, want_resource,
                "An offer must exchange two different resources"
            );
            assert!(
                expires_at_epoch == 0 || expires_at_epoch > Consensus::current_epoch(),
                "Expiry must be in the future, or 0 for none"
            );
            match &want_nft {
                Some(_) => assert_eq!(
                    ResourceManager::get(want_resource).resource_type(),
                    ResourceType::NonFungible,
                    "A wanted NFT id requires a non-fungible wanted resource"
                ),
                None => assert!(
                    want_amount.is_positive(),
                    "The wanted amount must be positive"
                ),
            }

            let maker = CallerContext::transaction_signer_public_key();
            let fill_rule = match designated_taker {
                Some(taker) => rule!(public_key(taker)),
                None => AccessRule::AllowAll,
            };
            let access_rules = ComponentAccessRules::new()
                .default(AccessRule::DenyAll)
                .method("fill", fill_rule)
                .method("claim", rule!(public_key(maker)))
                .method("cancel", rule!(public_key(maker)))
                .method("offer", AccessRule::AllowAll);

            Component::new(Self {
                escrow: Vault::from_bucket(offer),
                proceeds: Vault::new_empty(want_resource),
                offered_resource,
                want_resource,
                want_amount,
                want_nft,
                hash_lock,
                expires_at_epoch,
                status: OfferStatus::Open,
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(access_rules)
            .create()
        }

        /// Pays the agreed price and receives the escrowed asset, atomically.
        pub fn fill(&mut self, payment: Bucket, preimage: Option<Vec<u8>>) -> Bucket {
            assert_eq!(self.status, OfferStatus::Open, "The offer is not open");
            assert!(!self.is_expired(), "The offer has expired");
            if let Some(lock) = self.hash_lock {
                let secret = preimage.expect("This offer is hash-locked: a preimage is required");
                assert_eq!(
                    hash_sha256(&secret),
                    lock,
                    "The preimage does not match the hash lock"
                );
            }
            assert_eq!(
                payment.resource_address(),
                self.want_resource,
                "Payment is not the wanted resource"
            );
            match &self.want_nft {
                Some(id) => {
                    let ids = payment.get_non_fungible_ids();
                    assert!(
                        ids.len() == 1 && &ids[0] == id,
                        "Payment must be exactly the wanted NFT"
                    );
                }
                None => assert_eq!(
                    payment.amount(),
                    self.want_amount,
                    "Payment must equal the agreed amount"
                ),
            }
            self.proceeds.deposit(payment);
            self.status = OfferStatus::Filled;
            self.escrow.withdraw_all()
        }

        /// The maker withdraws the taker's payment (after a fill).
        pub fn claim(&mut self) -> Bucket {
            assert_eq!(
                self.status,
                OfferStatus::Filled,
                "Nothing to claim: the offer is not filled"
            );
            self.proceeds.withdraw_all()
        }

        /// The maker recovers the escrow from an open (or expired) offer.
        pub fn cancel(&mut self) -> Bucket {
            assert_eq!(
                self.status,
                OfferStatus::Open,
                "Only an open offer can be cancelled"
            );
            self.status = OfferStatus::Cancelled;
            self.escrow.withdraw_all()
        }

        pub fn offer(
            &self,
        ) -> (
            ResourceAddress,
            Amount,
            ResourceAddress,
            Amount,
            OfferStatus,
        ) {
            (
                self.offered_resource,
                self.escrow.balance(),
                self.want_resource,
                self.want_amount,
                self.status,
            )
        }

        fn is_expired(&self) -> bool {
            self.expires_at_epoch != 0 && Consensus::current_epoch() >= self.expires_at_epoch
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum OfferStatus {
        Open,
        Filled,
        Cancelled,
    }
}
