// Fixed-price public-NFT listing template for Tari Ootle.
//
// Each component escrows exactly one public NFT. There is no administrator, platform fee,
// royalty, collection-wide inventory, bonding curve, or metadata-based identity.

use tari_template_lib::prelude::*;

#[template]
mod nft_marketplace {
    use super::*;

    /// A single immutable fixed-price listing. The NFT identity is the exact pair
    /// `(nft_resource, nft_id)`; collection metadata is never used for settlement.
    pub struct FixedPriceListing {
        nft_vault: Vault,
        nft_resource: ResourceAddress,
        nft_id: NonFungibleId,
        quote_resource: ResourceAddress,
        price: Amount,
        seller_account: ComponentManager,
        expires_at_epoch: u64,
        status: ListingStatus,
    }

    impl FixedPriceListing {
        /// Escrows exactly one public NFT and creates a seller-cancellable listing.
        ///
        /// The transaction signer becomes the only principal permitted to cancel. The supplied
        /// `seller_account` is the immutable settlement destination chosen by that signer.
        pub fn create(
            seller_account: ComponentAddress,
            nft: Bucket,
            quote_resource: ResourceAddress,
            price: Amount,
            expires_at_epoch: u64,
        ) -> Component<Self> {
            assert!(price.is_positive(), "Listing price must be positive");
            assert!(
                expires_at_epoch == 0 || expires_at_epoch > Consensus::current_epoch(),
                "Listing expiry must be in the future or zero for no expiry"
            );

            let nft_resource = nft.resource_address();
            assert_eq!(
                ResourceManager::get(nft_resource).resource_type(),
                ResourceType::NonFungible,
                "Listing input must be a public non-fungible resource"
            );
            let nft_ids = nft.get_non_fungible_ids();
            assert_eq!(nft_ids.len(), 1, "A listing must escrow exactly one NFT");
            let nft_id = nft_ids[0].clone();

            Self::validate_quote_resource(quote_resource);
            assert_ne!(
                nft_resource, quote_resource,
                "NFT and quote resources must differ"
            );

            let seller_signer = CallerContext::transaction_signer_public_key();
            let access_rules = ComponentAccessRules::new()
                .default(AccessRule::DenyAll)
                .method("buy", AccessRule::AllowAll)
                .method("cancel", rule!(public_key(seller_signer)))
                .method("listing", AccessRule::AllowAll);

            Component::new(Self {
                nft_vault: Vault::from_bucket(nft),
                nft_resource,
                nft_id,
                quote_resource,
                price,
                seller_account: ComponentManager::get(seller_account),
                expires_at_epoch,
                status: ListingStatus::Active,
            })
            // No marketplace operator can alter access rules or recover escrowed assets.
            .with_owner_rule(OwnerRule::None)
            .with_access_rules(access_rules)
            .create()
        }

        /// Atomically transfers the escrowed NFT to `buyer_account` and the exact quoted payment
        /// to the immutable seller settlement account. Any failed deposit reverts the whole sale.
        pub fn buy(&mut self, payment: Bucket, buyer_account: ComponentAddress) {
            assert_eq!(
                self.effective_status(),
                ListingStatus::Active,
                "Listing is not active"
            );
            assert_eq!(
                payment.resource_address(),
                self.quote_resource,
                "Incorrect quote resource"
            );
            assert_eq!(
                payment.amount(),
                self.price,
                "Payment must equal the listed price"
            );

            let nft = self.nft_vault.withdraw_non_fungible(self.nft_id.clone());
            self.status = ListingStatus::Sold;
            self.seller_account.invoke("deposit", args![payment]);
            ComponentManager::get(buyer_account).invoke("deposit", args![nft]);
        }

        /// Returns the unsold NFT to the seller settlement account. At or after its expiry epoch,
        /// the final state is `Expired`; otherwise it is `Cancelled`.
        pub fn cancel(&mut self) {
            assert_eq!(self.status, ListingStatus::Active, "Listing is not active");
            let nft = self.nft_vault.withdraw_non_fungible(self.nft_id.clone());
            self.status = if self.is_expired() {
                ListingStatus::Expired
            } else {
                ListingStatus::Cancelled
            };
            self.seller_account.invoke("deposit", args![nft]);
        }

        /// Returns the exact settlement facts, without reading mutable NFT metadata.
        pub fn listing(&self) -> ListingDetails {
            ListingDetails {
                nft_resource: self.nft_resource,
                nft_id: self.nft_id.clone(),
                quote_resource: self.quote_resource,
                price: self.price,
                seller_account: self.seller_account.component_address(),
                expires_at_epoch: self.expires_at_epoch,
                status: self.effective_status(),
            }
        }

        fn effective_status(&self) -> ListingStatus {
            if self.status == ListingStatus::Active && self.is_expired() {
                ListingStatus::Expired
            } else {
                self.status
            }
        }

        fn is_expired(&self) -> bool {
            self.expires_at_epoch != 0 && Consensus::current_epoch() >= self.expires_at_epoch
        }

        /// The V1 quote boundary is intentionally narrow: canonical native TARI, or an ordinary
        /// public fungible such as a configured public wSTABLE. Non-Tari stealth, confidential,
        /// and NFT quote resources are rejected. Foreign-resource recall/freeze rules remain
        /// unavailable through this ABI and must be disclosed by the route/UI layer.
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
    pub enum ListingStatus {
        Active,
        Sold,
        Cancelled,
        Expired,
    }

    /// Public listing facts. This is deliberately an exact resource/id pair, never a display-name
    /// or collection metadata lookup.
    pub struct ListingDetails {
        pub nft_resource: ResourceAddress,
        pub nft_id: NonFungibleId,
        pub quote_resource: ResourceAddress,
        pub price: Amount,
        pub seller_account: ComponentAddress,
        pub expires_at_epoch: u64,
        pub status: ListingStatus,
    }
}
