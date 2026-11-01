// TEST-ONLY: a disposable CONFIDENTIAL resource whose initial supply is REVEALED
// (`ConfidentialOutputStatement::mint_revealed`), so engine tests can exercise the revealed
// portion of a confidential vault without wallet-generated range proofs. Blinded commitments
// are exercised only by `mint_blinded`, which mints a bucket carrying a REAL blinded
// commitment so a revealed-value mechanism's refusal of such a bucket can be PROVEN. Spending
// a blinded commitment still needs a wallet-built ConfidentialWithdrawProof.
use tari_template_abi::rust::collections::BTreeMap;
use tari_template_lib::prelude::*;
use tari_template_lib::types::confidential::ConfidentialOutputStatement;
use tari_template_lib::types::crypto::{CommitmentValueProof, PedersenCommitmentBytes};

#[template]
mod confidential_probe {
    use super::*;

    pub struct ConfidentialProbe {
        vault: Vault,
        resource: ResourceAddress,
    }

    impl ConfidentialProbe {
        pub fn new(supply: Amount) -> Component<Self> {
            let bucket = ResourceBuilder::confidential()
                .with_token_symbol("PCNF")
                .mintable(rule!(allow_all), UpdateRule::Locked)
                .initial_supply(ConfidentialOutputStatement::mint_revealed(supply));
            let resource = bucket.resource_address();
            Component::new(Self {
                vault: Vault::from_bucket(bucket),
                resource,
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn take(&mut self, amount: Amount) -> Bucket {
            self.vault.withdraw(amount)
        }

        /// TEST-ONLY: a bucket carrying a real blinded commitment (plus whatever revealed
        /// amount the statement names). `count_confidential_commitments()` on it is non-zero,
        /// which is exactly the shape a revealed-value reserve must refuse.
        pub fn mint_blinded(
            &self,
            statement: ConfidentialOutputStatement,
            value_proofs: BTreeMap<PedersenCommitmentBytes, CommitmentValueProof>,
        ) -> Bucket {
            // The engine requires a value proof per minted commitment because this resource
            // tracks total supply; the caller supplies them (engine test tooling builds them).
            ResourceManager::get(self.resource).mint_confidential(statement, value_proofs)
        }
    }
}
