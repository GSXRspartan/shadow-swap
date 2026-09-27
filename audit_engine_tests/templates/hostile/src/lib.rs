// Hostile / edge-case resource factory for OPUS-08 engine tests.
//
// Mints resources with deliberately dangerous or unusual security configurations so the audit
// suite can prove (a) what the pool template rejects by type, and (b) the residual recall/freeze
// risk it cannot screen. Modeled on the upstream tari-ootle `recall` test template.
use tari_template_lib::prelude::*;

#[template]
mod hostile {
    use super::*;

    pub struct Hostile {
        vault: Vault,
    }

    impl Hostile {
        /// Ordinary public fungible whose issuer can RECALL it from any vault (allow_all recall).
        /// Still `ResourceType::Fungible`, so the pool's type check accepts it — this is the
        /// unscreenable OPUS-08 residual.
        pub fn recallable_fungible() -> (Component<Self>, ResourceAddress) {
            let bucket = ResourceBuilder::public_fungible()
                .with_token_symbol("EVILR")
                .recallable(rule!(allow_all), LOCKED)
                .initial_supply(1_000_000_000u64);
            let resource = bucket.resource_address();
            let component = Component::new(Self {
                vault: Vault::from_bucket(bucket),
            })
            .with_access_rules(AccessRules::allow_all())
            .create();
            (component, resource)
        }

        /// Ordinary public fungible whose issuer can FREEZE vaults holding it (allow_all freeze).
        pub fn freezable_fungible() -> (Component<Self>, ResourceAddress) {
            let bucket = ResourceBuilder::public_fungible()
                .with_token_symbol("EVILF")
                .freezable(rule!(allow_all), LOCKED)
                .initial_supply(1_000_000_000u64);
            let resource = bucket.resource_address();
            let component = Component::new(Self {
                vault: Vault::from_bucket(bucket),
            })
            .with_access_rules(AccessRules::allow_all())
            .create();
            (component, resource)
        }

        /// A non-Tari STEALTH resource — must be rejected by the public-fungible pool by type.
        pub fn stealth_asset() -> (Component<Self>, ResourceAddress) {
            let bucket = ResourceBuilder::stealth()
                .with_token_symbol("STL")
                .initial_supply(1_000_000u32);
            let resource = bucket.resource_address();
            let component = Component::new(Self {
                vault: Vault::from_bucket(bucket),
            })
            .with_access_rules(AccessRules::allow_all())
            .create();
            (component, resource)
        }

        /// Ordinary public fungible that merely CLAIMS the "TARI" symbol via metadata. Must be
        /// treated as a normal fungible (never as canonical native Tari); metadata is ignored.
        pub fn symbol_tari_fungible() -> (Component<Self>, ResourceAddress) {
            let bucket = ResourceBuilder::public_fungible()
                .with_token_symbol("TARI")
                .add_metadata("name", "Tari")
                .add_metadata("description", "definitely the real native tari, trust me")
                .initial_supply(1_000_000_000u64);
            let resource = bucket.resource_address();
            let component = Component::new(Self {
                vault: Vault::from_bucket(bucket),
            })
            .with_access_rules(AccessRules::allow_all())
            .create();
            (component, resource)
        }

        /// A perfectly safe ordinary public fungible (no recall/freeze), for the positive case.
        pub fn safe_fungible() -> (Component<Self>, ResourceAddress) {
            let bucket = ResourceBuilder::public_fungible()
                .with_token_symbol("SAFE")
                .initial_supply(1_000_000_000u64);
            let resource = bucket.resource_address();
            let component = Component::new(Self {
                vault: Vault::from_bucket(bucket),
            })
            .with_access_rules(AccessRules::allow_all())
            .create();
            (component, resource)
        }

        /// Withdraw some of this factory's tokens (used to fund accounts in tests).
        pub fn take(&mut self, amount: Amount) -> Bucket {
            self.vault.withdraw(amount)
        }

        /// Attacker action: recall `amount` of this resource from an arbitrary vault (e.g. a pool's
        /// reserve vault). Authorized by the resource's allow_all recall rule, NOT by the vault
        /// owner. Returns the stolen bucket to the caller.
        pub fn recall_from_vault(&mut self, vault_id: VaultId, amount: Amount) -> Bucket {
            ResourceManager::get(self.vault.resource_address()).recall_fungible_amount(vault_id, amount)
        }

        /// Attack (LP-AUTH): attempt to MINT an arbitrary foreign resource (e.g. the pool's LP
        /// token) from an untrusted component frame. Must fail unless the resource's mint rule
        /// authorizes THIS component — the pool's LP mint rule is scoped to the pool component
        /// only, so this must abort.
        pub fn try_mint_foreign(&mut self, resource: ResourceAddress, amount: Amount) -> Bucket {
            ResourceManager::get(resource).mint_fungible(amount)
        }

        /// Attack (LP-AUTH): attempt to BURN an arbitrary bucket (e.g. another user's LP) from an
        /// untrusted component frame. The pool's LP burn rule is scoped to the pool component
        /// only, so this must abort.
        pub fn try_burn_foreign(&mut self, bucket: Bucket) {
            bucket.burn();
        }
    }
}
