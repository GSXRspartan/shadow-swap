// Minimal test faucet (mints an ordinary public fungible with a symbol) used by the
// audit engine harness to fund accounts with arbitrary test tokens. Derived from the
// upstream tari-ootle TestFaucet test template.
use tari_template_lib::prelude::*;

#[template]
mod faucet_template {
    use super::*;

    pub struct TestFaucet {
        vault: Vault,
    }

    impl TestFaucet {
        pub fn mint_with_symbol(initial_supply: Amount, symbol: String) -> Component<Self> {
            let coins = ResourceBuilder::public_fungible()
                .with_token_symbol(symbol)
                .initial_supply(initial_supply);

            Component::new(Self {
                vault: Vault::from_bucket(coins),
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn take_free_coins(&mut self) -> Bucket {
            self.vault.withdraw(Amount::from(1_000_000_000u64))
        }
    }
}
