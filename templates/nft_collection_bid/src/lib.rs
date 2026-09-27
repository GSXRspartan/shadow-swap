// Buyer-funded collection-floor bid template for public Tari Ootle NFTs.
//
// Each component escrow is a standing limit order, not an NFT AMM or a pooled inventory.

use tari_template_lib::prelude::*;

#[template]
mod nft_collection_bid {
    use super::*;

    /// A buyer-funded bid to buy up to `original_quantity` NFTs from exactly one collection.
    /// The component address is the authoritative bid/order identifier.
    pub struct CollectionBid {
        quote_vault: Vault,
        buyer_account: ComponentManager,
        collection: ResourceAddress,
        quote_resource: ResourceAddress,
        price_per_nft: Amount,
        original_quantity: u64,
        remaining_quantity: u64,
        original_escrow: Amount,
        remaining_escrow: Amount,
        created_at_epoch: u64,
        expires_at_epoch: u64,
        status: CollectionBidStatus,
    }

    impl CollectionBid {
        /// Escrows exactly `price_per_nft * quantity`. The creator is the only principal who
        /// can cancel an active or partially-filled bid before expiry.
        pub fn create(
            buyer_account: ComponentAddress,
            quote: Bucket,
            collection: ResourceAddress,
            price_per_nft: Amount,
            quantity: u64,
            expires_at_epoch: u64,
        ) -> Component<Self> {
            assert!(price_per_nft.is_positive(), "Bid price must be positive");
            assert!(quantity > 0, "Bid quantity must be positive");
            assert!(
                expires_at_epoch == 0 || expires_at_epoch > Consensus::current_epoch(),
                "Bid expiry must be in the future or zero for no expiry"
            );
            assert_eq!(
                ResourceManager::get(collection).resource_type(),
                ResourceType::NonFungible,
                "Bid collection must be a public non-fungible resource"
            );

            let quote_resource = quote.resource_address();
            Self::validate_quote_resource(quote_resource);
            assert_ne!(
                collection, quote_resource,
                "NFT and quote resources must differ"
            );
            let original_escrow = price_per_nft
                .checked_mul(Amount::from(quantity))
                .expect("Bid escrow multiplication overflow");
            assert_eq!(
                quote.amount(),
                original_escrow,
                "Bid escrow must equal price times quantity"
            );

            let buyer_signer = CallerContext::transaction_signer_public_key();
            let created_at_epoch = Consensus::current_epoch();
            emit_event(
                "CollectionBidCreated",
                metadata![
                    "collection" => collection.to_string(),
                    "quote_resource" => quote_resource.to_string(),
                    "price_per_nft" => price_per_nft.to_string(),
                    "original_quantity" => quantity.to_string(),
                    "original_escrow" => original_escrow.to_string(),
                    "buyer_account" => buyer_account.to_string(),
                    "created_at_epoch" => created_at_epoch.to_string(),
                    "expires_at_epoch" => expires_at_epoch.to_string(),
                ],
            );

            Component::new(Self {
                quote_vault: Vault::from_bucket(quote),
                buyer_account: ComponentManager::get(buyer_account),
                collection,
                quote_resource,
                price_per_nft,
                original_quantity: quantity,
                remaining_quantity: quantity,
                original_escrow,
                remaining_escrow: original_escrow,
                created_at_epoch,
                expires_at_epoch,
                status: CollectionBidStatus::Active,
            })
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(
                ComponentAccessRules::new()
                    .default(AccessRule::DenyAll)
                    .method("fill", AccessRule::AllowAll)
                    .method("refund_expired", AccessRule::AllowAll)
                    .method("bid", AccessRule::AllowAll)
                    .method("cancel", rule!(public_key(buyer_signer))),
            )
            .create()
        }

        /// Atomically accepts one exact NFT from the configured collection and pays the fixed
        /// per-NFT amount. Each call fills one unit, preventing batch overfill ambiguity.
        pub fn fill(&mut self, nft: Bucket, seller_account: ComponentAddress) {
            assert!(
                matches!(
                    self.effective_status(),
                    CollectionBidStatus::Active | CollectionBidStatus::PartiallyFilled
                ),
                "Bid is not fillable"
            );
            assert!(self.remaining_quantity > 0, "Bid is fully filled");
            assert_eq!(
                nft.resource_address(),
                self.collection,
                "Incorrect NFT collection"
            );
            assert_eq!(
                nft.get_non_fungible_ids().len(),
                1,
                "Each fill must supply exactly one NFT"
            );
            assert!(
                self.remaining_escrow >= self.price_per_nft,
                "Bid escrow is inconsistent"
            );

            let payment = self.quote_vault.withdraw(self.price_per_nft);
            self.remaining_quantity = self
                .remaining_quantity
                .checked_sub(1)
                .expect("Bid quantity underflow");
            self.remaining_escrow = self
                .remaining_escrow
                .checked_sub(self.price_per_nft)
                .expect("Bid escrow underflow");
            self.status = if self.remaining_quantity == 0 {
                CollectionBidStatus::Filled
            } else {
                CollectionBidStatus::PartiallyFilled
            };
            ComponentManager::get(seller_account).invoke("deposit", args![payment]);
            self.buyer_account.invoke("deposit", args![nft]);
            emit_event(
                "CollectionBidFilled",
                metadata![
                    "collection" => self.collection.to_string(),
                    "quote_resource" => self.quote_resource.to_string(),
                    "price_per_nft" => self.price_per_nft.to_string(),
                    "remaining_quantity" => self.remaining_quantity.to_string(),
                    "remaining_escrow" => self.remaining_escrow.to_string(),
                    "buyer_account" => self.buyer_account.component_address().to_string(),
                    "seller_account" => seller_account.to_string(),
                ],
            );
        }

        /// Returns only the unfilled escrow. Settled fills remain final.
        pub fn cancel(&mut self) {
            assert!(
                matches!(
                    self.effective_status(),
                    CollectionBidStatus::Active | CollectionBidStatus::PartiallyFilled
                ),
                "Bid is not cancellable"
            );
            let refund = self.quote_vault.withdraw(self.remaining_escrow);
            self.remaining_escrow = Amount::zero();
            self.status = CollectionBidStatus::Cancelled;
            self.buyer_account.invoke("deposit", args![refund]);
            emit_event(
                "CollectionBidCancelled",
                metadata![
                    "collection" => self.collection.to_string(),
                    "quote_resource" => self.quote_resource.to_string(),
                    "remaining_quantity" => self.remaining_quantity.to_string(),
                    "remaining_escrow" => "0",
                    "buyer_account" => self.buyer_account.component_address().to_string(),
                ],
            );
        }

        /// After expiry, anyone may trigger the one-time remainder refund to the immutable buyer
        /// account. A filled bid has no escrow and cannot be refunded.
        pub fn refund_expired(&mut self) {
            assert!(
                matches!(
                    self.status,
                    CollectionBidStatus::Active | CollectionBidStatus::PartiallyFilled
                ),
                "Bid is not refundable"
            );
            assert!(self.is_expired(), "Bid has not expired");
            let refund = self.quote_vault.withdraw(self.remaining_escrow);
            self.remaining_escrow = Amount::zero();
            self.status = CollectionBidStatus::Expired;
            self.buyer_account.invoke("deposit", args![refund]);
            emit_event(
                "CollectionBidExpiredRefunded",
                metadata![
                    "collection" => self.collection.to_string(),
                    "quote_resource" => self.quote_resource.to_string(),
                    "remaining_quantity" => self.remaining_quantity.to_string(),
                    "buyer_account" => self.buyer_account.component_address().to_string(),
                ],
            );
        }

        /// Authoritative collection-bid facts. Metadata is intentionally absent from settlement.
        pub fn bid(&self) -> CollectionBidDetails {
            CollectionBidDetails {
                collection: self.collection,
                quote_resource: self.quote_resource,
                price_per_nft: self.price_per_nft,
                original_quantity: self.original_quantity,
                remaining_quantity: self.remaining_quantity,
                original_escrow: self.original_escrow,
                remaining_escrow: self.remaining_escrow,
                buyer_account: self.buyer_account.component_address(),
                created_at_epoch: self.created_at_epoch,
                expires_at_epoch: self.expires_at_epoch,
                status: self.effective_status(),
            }
        }

        fn effective_status(&self) -> CollectionBidStatus {
            if matches!(
                self.status,
                CollectionBidStatus::Active | CollectionBidStatus::PartiallyFilled
            ) && self.is_expired()
            {
                CollectionBidStatus::Expired
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
    pub enum CollectionBidStatus {
        Active,
        PartiallyFilled,
        Filled,
        Cancelled,
        Expired,
    }

    pub struct CollectionBidDetails {
        pub collection: ResourceAddress,
        pub quote_resource: ResourceAddress,
        pub price_per_nft: Amount,
        pub original_quantity: u64,
        pub remaining_quantity: u64,
        pub original_escrow: Amount,
        pub remaining_escrow: Amount,
        pub buyer_account: ComponentAddress,
        pub created_at_epoch: u64,
        pub expires_at_epoch: u64,
        pub status: CollectionBidStatus,
    }
}
