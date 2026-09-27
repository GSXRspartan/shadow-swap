// Buyer-funded, item-specific public-NFT offer template for Tari Ootle.
//
// Each component escrows one exact fungible quote amount for one exact public-NFT identity.
// There is no marketplace operator, fee, or metadata-based settlement rule.

use tari_template_lib::prelude::*;

#[template]
mod nft_item_offer {
    use super::*;

    /// A buyer-funded offer for exactly `(nft_resource, nft_id)`.
    /// The component address is the authoritative offer identifier.
    pub struct ItemOffer {
        quote_vault: Vault,
        buyer_account: ComponentManager,
        nft_resource: ResourceAddress,
        nft_id: NonFungibleId,
        quote_resource: ResourceAddress,
        offer_amount: Amount,
        created_at_epoch: u64,
        expires_at_epoch: u64,
        status: ItemOfferStatus,
    }

    impl ItemOffer {
        /// Creates a buyer-cancellable, funded offer. The transaction signer is the only
        /// principal that can cancel it before expiry; the supplied buyer account is the
        /// immutable NFT/refund settlement destination.
        pub fn create(
            buyer_account: ComponentAddress,
            quote: Bucket,
            nft_resource: ResourceAddress,
            nft_id: NonFungibleId,
            expires_at_epoch: u64,
        ) -> Component<Self> {
            let offer_amount = quote.amount();
            assert!(offer_amount.is_positive(), "Offer amount must be positive");
            assert!(
                expires_at_epoch == 0 || expires_at_epoch > Consensus::current_epoch(),
                "Offer expiry must be in the future or zero for no expiry"
            );

            let quote_resource = quote.resource_address();
            Self::validate_quote_resource(quote_resource);
            assert_ne!(
                nft_resource, quote_resource,
                "NFT and quote resources must differ"
            );
            assert_eq!(
                ResourceManager::get(nft_resource).resource_type(),
                ResourceType::NonFungible,
                "Offer target must be a public non-fungible resource"
            );

            let buyer_signer = CallerContext::transaction_signer_public_key();
            let created_at_epoch = Consensus::current_epoch();
            emit_event(
                "ItemOfferCreated",
                metadata![
                    "nft_resource" => nft_resource.to_string(),
                    "nft_id" => nft_id.to_string(),
                    "quote_resource" => quote_resource.to_string(),
                    "offer_amount" => offer_amount.to_string(),
                    "buyer_account" => buyer_account.to_string(),
                    "created_at_epoch" => created_at_epoch.to_string(),
                    "expires_at_epoch" => expires_at_epoch.to_string(),
                ],
            );

            Component::new(Self {
                quote_vault: Vault::from_bucket(quote),
                buyer_account: ComponentManager::get(buyer_account),
                nft_resource,
                nft_id,
                quote_resource,
                offer_amount,
                created_at_epoch,
                expires_at_epoch,
                status: ItemOfferStatus::Active,
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(
                ComponentAccessRules::new()
                    .default(AccessRule::DenyAll)
                    .method("accept", AccessRule::AllowAll)
                    .method("refund_expired", AccessRule::AllowAll)
                    .method("offer", AccessRule::AllowAll)
                    .method("cancel", rule!(public_key(buyer_signer))),
            )
            .create()
        }

        /// Atomically pays the seller's chosen settlement account and deposits the exact NFT to
        /// the immutable buyer account. Any failed deposit reverts the entire acceptance.
        pub fn accept(&mut self, nft: Bucket, seller_account: ComponentAddress) {
            assert_eq!(
                self.effective_status(),
                ItemOfferStatus::Active,
                "Offer is not active"
            );
            assert_eq!(
                nft.resource_address(),
                self.nft_resource,
                "Incorrect NFT collection"
            );
            let ids = nft.get_non_fungible_ids();
            assert_eq!(ids.len(), 1, "Acceptance must supply exactly one NFT");
            assert_eq!(ids[0], self.nft_id, "Incorrect NFT id");

            let payment = self.quote_vault.withdraw(self.offer_amount);
            self.status = ItemOfferStatus::Accepted;
            ComponentManager::get(seller_account).invoke("deposit", args![payment]);
            self.buyer_account.invoke("deposit", args![nft]);
            emit_event(
                "ItemOfferAccepted",
                metadata![
                    "nft_resource" => self.nft_resource.to_string(),
                    "nft_id" => self.nft_id.to_string(),
                    "quote_resource" => self.quote_resource.to_string(),
                    "offer_amount" => self.offer_amount.to_string(),
                    "buyer_account" => self.buyer_account.component_address().to_string(),
                    "seller_account" => seller_account.to_string(),
                ],
            );
        }

        /// Returns the full escrow to the buyer while the offer is still active and unexpired.
        pub fn cancel(&mut self) {
            assert_eq!(
                self.effective_status(),
                ItemOfferStatus::Active,
                "Offer is not active"
            );
            let refund = self.quote_vault.withdraw(self.offer_amount);
            self.status = ItemOfferStatus::Cancelled;
            self.buyer_account.invoke("deposit", args![refund]);
            emit_event(
                "ItemOfferCancelled",
                metadata![
                    "nft_resource" => self.nft_resource.to_string(),
                    "nft_id" => self.nft_id.to_string(),
                    "quote_resource" => self.quote_resource.to_string(),
                    "offer_amount" => self.offer_amount.to_string(),
                    "buyer_account" => self.buyer_account.component_address().to_string(),
                ],
            );
        }

        /// After the consensus-epoch expiry, anyone may trigger the one-time refund, but it can
        /// only ever be deposited to the immutable buyer settlement account.
        pub fn refund_expired(&mut self) {
            assert_eq!(self.status, ItemOfferStatus::Active, "Offer is not active");
            assert!(self.is_expired(), "Offer has not expired");
            let refund = self.quote_vault.withdraw(self.offer_amount);
            self.status = ItemOfferStatus::Expired;
            self.buyer_account.invoke("deposit", args![refund]);
            emit_event(
                "ItemOfferExpiredRefunded",
                metadata![
                    "nft_resource" => self.nft_resource.to_string(),
                    "nft_id" => self.nft_id.to_string(),
                    "quote_resource" => self.quote_resource.to_string(),
                    "offer_amount" => self.offer_amount.to_string(),
                    "buyer_account" => self.buyer_account.component_address().to_string(),
                ],
            );
        }

        /// Authoritative offer facts. Display metadata is intentionally absent from settlement.
        pub fn offer(&self) -> ItemOfferDetails {
            ItemOfferDetails {
                nft_resource: self.nft_resource,
                nft_id: self.nft_id.clone(),
                quote_resource: self.quote_resource,
                offer_amount: self.offer_amount,
                buyer_account: self.buyer_account.component_address(),
                created_at_epoch: self.created_at_epoch,
                expires_at_epoch: self.expires_at_epoch,
                status: self.effective_status(),
            }
        }

        fn effective_status(&self) -> ItemOfferStatus {
            if self.status == ItemOfferStatus::Active && self.is_expired() {
                ItemOfferStatus::Expired
            } else {
                self.status
            }
        }

        fn is_expired(&self) -> bool {
            self.expires_at_epoch != 0 && Consensus::current_epoch() >= self.expires_at_epoch
        }

        fn validate_quote_resource(resource: ResourceAddress) {
            if resource == STEALTH_TARI_RESOURCE_ADDRESS {
                return;
            }
            assert_eq!(
                ResourceManager::get(resource).resource_type(),
                ResourceType::Fungible,
                "Quote resource must be canonical Tari or an ordinary public fungible"
            );
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum ItemOfferStatus {
        Active,
        Accepted,
        Cancelled,
        Expired,
    }

    pub struct ItemOfferDetails {
        pub nft_resource: ResourceAddress,
        pub nft_id: NonFungibleId,
        pub quote_resource: ResourceAddress,
        pub offer_amount: Amount,
        pub buyer_account: ComponentAddress,
        pub created_at_epoch: u64,
        pub expires_at_epoch: u64,
        pub status: ItemOfferStatus,
    }
}
