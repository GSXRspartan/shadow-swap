# Disposable public test-token minter

This is a **local preparation artifact** for the Esmeralda Pool acceptance campaign. It has not
been published. `mint_pair` returns two ordinary public fungible buckets, each fixed at
`10_000.000000` units:

- `TESTA`
- `TESTB`

The resources have six decimal places and `OwnerRule::None`. The template does not retain a
component, vault, badge, mint authority, recall authority, freeze authority, or rule-update
authority. Consequently, after a successful one-time call, each resource is fixed-supply.

## Required operator-approved dry run

The walletd Manifest page can use this exact source after the template has been separately
published and its returned V2 template address has been recorded:

```tari
use template_${TEST_TOKEN_MINTER_TEMPLATE} as TestTokenMinter;
fn main() {
  let account = arg!["account"];
  let (testa, testb) = TestTokenMinter::mint_pair();
  account.deposit(testa);
  account.deposit(testb);
}
```

Set the `account` variable to the confirmed `shadow-swap` component. Keep **Dry run** selected
and let walletd calculate the fee. A walletd manifest dry run signs a transaction locally and
therefore requires the authenticated WebAuthn session plus `transactions:create`; the existing
read-only API credential cannot run it. Do not submit unless a separate bounded authorization
names the final template address, fee cap, and transaction count.

After any authorized submission, independently read the committed receipt and verify that both
new resource addresses are ordinary public fungibles, have divisibility 6, show a 10,000.000000
balance in the intended account, and expose no usable mint authority.
