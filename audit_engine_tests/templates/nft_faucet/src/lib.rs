// Minimal public-NFT fixture used only by the real marketplace engine tests.
use tari_template_lib::prelude::*;

#[template]
mod test_nft_faucet {
    use super::*;

    pub struct TestNftFaucet {
        vault: Vault,
        nft_id: NonFungibleId,
    }

    impl TestNftFaucet {
        pub fn mint_one(nft_id: NonFungibleId, symbol: String) -> Component<Self> {
            let immutable_data = metadata!["name" => "Engine test NFT"];
            let mutable_data = ();
            let nft = ResourceBuilder::non_fungible()
                .with_token_symbol(symbol)
                .initial_supply_with_data(vec![(nft_id.clone(), (&immutable_data, &mutable_data))]);

            Component::new(Self {
                vault: Vault::from_bucket(nft),
                nft_id,
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn mint_many(nft_ids: Vec<NonFungibleId>, symbol: String) -> Component<Self> {
            assert!(!nft_ids.is_empty(), "At least one NFT id is required");
            let immutable_data = metadata!["name" => "Engine test NFT"];
            let mutable_data = ();
            let nft = ResourceBuilder::non_fungible()
                .with_token_symbol(symbol)
                .initial_supply_with_data(
                    nft_ids
                        .iter()
                        .cloned()
                        .map(|id| (id, (&immutable_data, &mutable_data))),
                );

            Component::new(Self {
                vault: Vault::from_bucket(nft),
                nft_id: nft_ids[0].clone(),
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn take_nft(&mut self) -> Bucket {
            self.vault.withdraw_non_fungible(self.nft_id.clone())
        }

        pub fn take_nft_by_id(&mut self, nft_id: NonFungibleId) -> Bucket {
            self.vault.withdraw_non_fungible(nft_id)
        }
    }
}
