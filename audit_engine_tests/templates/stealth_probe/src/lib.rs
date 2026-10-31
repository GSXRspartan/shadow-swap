// TEST-ONLY probe for Phase 6: can a GENERIC created-Stealth resource (not native TARI) be
// held, withdrawn and deposited in a component vault the way Pool v2 holds revealed tTARI?
//
// `ResourceBuilder::stealth().initial_supply(n)` mints n REVEALED units into a bucket. The
// revealed portion is a public amount: holding it in a vault is exactly the privacy boundary
// Pool v2 already uses for native TARI (the wallet reveals before the pool sees it).
use tari_template_lib::prelude::*;

#[template]
mod stealth_probe {
    use super::*;

    pub struct StealthProbe {
        vault: Vault,
    }

    impl StealthProbe {
        pub fn new(supply: Amount) -> Component<Self> {
            let bucket = ResourceBuilder::stealth()
                .with_token_symbol("PSTL")
                .initial_supply(supply);
            Component::new(Self {
                vault: Vault::from_bucket(bucket),
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn take(&mut self, amount: Amount) -> Bucket {
            self.vault.withdraw(amount)
        }

        pub fn put(&mut self, bucket: Bucket) {
            self.vault.deposit(bucket)
        }

        pub fn balance(&self) -> Amount {
            self.vault.balance()
        }
    }
}
