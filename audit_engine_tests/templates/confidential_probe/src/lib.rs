// TEST-ONLY: a disposable CONFIDENTIAL resource whose initial supply is REVEALED
// (`ConfidentialOutputStatement::mint_revealed`), so engine tests can exercise the revealed
// portion of a confidential vault without wallet-generated range proofs. Blinded commitments
// are NOT exercised here; spending them needs a wallet-built ConfidentialWithdrawProof.
use tari_template_lib::prelude::*;
use tari_template_lib::types::confidential::ConfidentialOutputStatement;

#[template]
mod confidential_probe {
    use super::*;

    pub struct ConfidentialProbe {
        vault: Vault,
    }

    impl ConfidentialProbe {
        pub fn new(supply: Amount) -> Component<Self> {
            let bucket = ResourceBuilder::confidential()
                .with_token_symbol("PCNF")
                .initial_supply(ConfidentialOutputStatement::mint_revealed(supply));
            Component::new(Self {
                vault: Vault::from_bucket(bucket),
            })
            .with_access_rules(AccessRules::allow_all())
            .create()
        }

        pub fn take(&mut self, amount: Amount) -> Bucket {
            self.vault.withdraw(amount)
        }
    }
}
