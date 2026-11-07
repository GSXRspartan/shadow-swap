//! Disposable public fungible assets for the Esmeralda Pool acceptance campaign.
//!
//! `mint_pair` creates exactly 10,000.000000 TESTA and TESTB units per invocation.
//! The two returned buckets must be deposited by the transaction manifest.  Neither
//! resource retains a mint authority, an owner, recall, freeze, or access-rule update
//! authority, so the fixed supply cannot be increased or administratively seized later.

use tari_template_lib::prelude::*;

#[template]
mod test_token_minter {
    use super::*;

    // Six decimal places match the Pool's normal integer-unit accounting. This is the
    // smallest unit count that represents precisely 10,000 whole tokens.
    const INITIAL_SUPPLY: Amount = Amount::from_u64(10_000_000_000);

    pub struct TestTokenMinter;

    impl TestTokenMinter {
        /// Creates a fresh, fixed-supply public TESTA/TESTB pair for one disposable test.
        /// The caller must deposit both returned buckets in its own account in the same
        /// transaction; returning the buckets makes the recipient explicit in the manifest.
        pub fn mint_pair() -> (Bucket, Bucket) {
            let testa = ResourceBuilder::public_fungible()
                .with_token_symbol("TESTA")
                .metadata("name", "Shadow Swap disposable TESTA")
                .with_divisibility(6)
                .with_owner_rule(OwnerRule::None)
                .mintable(AccessRule::DenyAll, UpdateRule::Locked)
                .burnable(AccessRule::DenyAll, UpdateRule::Locked)
                .recallable(AccessRule::DenyAll, UpdateRule::Locked)
                .freezable(AccessRule::DenyAll, UpdateRule::Locked)
                .withdrawable(AccessRule::AllowAll, UpdateRule::Locked)
                .depositable(AccessRule::AllowAll, UpdateRule::Locked)
                .initial_supply(INITIAL_SUPPLY);

            let testb = ResourceBuilder::public_fungible()
                .with_token_symbol("TESTB")
                .metadata("name", "Shadow Swap disposable TESTB")
                .with_divisibility(6)
                .with_owner_rule(OwnerRule::None)
                .mintable(AccessRule::DenyAll, UpdateRule::Locked)
                .burnable(AccessRule::DenyAll, UpdateRule::Locked)
                .recallable(AccessRule::DenyAll, UpdateRule::Locked)
                .freezable(AccessRule::DenyAll, UpdateRule::Locked)
                .withdrawable(AccessRule::AllowAll, UpdateRule::Locked)
                .depositable(AccessRule::AllowAll, UpdateRule::Locked)
                .initial_supply(INITIAL_SUPPLY);

            (testa, testb)
        }
    }
}
