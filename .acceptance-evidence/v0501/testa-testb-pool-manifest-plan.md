# TESTA/TESTB Pool V2 manifest plan

No manifest in this document has been dry-run or submitted. Replace every angle-bracket value
only after the preceding committed receipt is independently reconciled.

## 1. Mint pair dry run

Requires the committed V2 `TestTokenMinter` publication address and the confirmed shadow-swap
account component. The two return buckets are both consumed by `account.deposit` in the same
transaction, so neither can be orphaned.

```tari
use template_<TEST_TOKEN_MINTER_TEMPLATE> as TestTokenMinter;
fn main() {
  let account = arg!["account"];
  let (testa, testb) = TestTokenMinter::mint_pair();
  account.deposit(testa);
  account.deposit(testb);
}
```

Expected receipt checks: two distinct resource addresses; public fungible type; divisibility 6;
`10_000_000_000` raw units (10,000.000000 display units) in the target account for each; locked
deny mint/burn/recall/freeze rules; `OwnerRule::None`.

## 2. Create 30-bps Pool dry run

```tari
use template_1c7d39e782b6ca5023ad186c7d5f82cb2ad171336cd75ae0025245fe84bebae3 as Pool;
fn main() {
  Pool::new(arg!["testa"], arg!["testb"], 30u16);
}
```

Record the component and LP resource addresses from the committed receipt; do not infer either.

## 3. Initial liquidity dry run

`<A_RAW>` and `<B_RAW>` must be the separately approved raw amounts and must satisfy the Pool's
minimum-initial-liquidity invariant. Use the actual dry-run result for the LP minimum.

```tari
fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let a = account.withdraw(arg!["testa"], amount!(<A_RAW>));
  let b = account.withdraw(arg!["testb"], amount!(<B_RAW>));
  let lp = pool.add_liquidity(a, b);
  account.deposit(lp);
}
```

## 4. Directional swap dry runs

Obtain a fresh Pool quote and set `<MIN_B_RAW>` / `<MIN_A_RAW>` from the approved slippage limit;
never use zero as a minimum output.

```tari
fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let input = account.withdraw(arg!["input_resource"], amount!(<INPUT_RAW>));
  let output = pool.swap(input, arg!["output_resource"], amount!(<MIN_OUTPUT_RAW>));
  account.deposit(output);
}
```

Run once with TESTA input/TESTB output and once in reverse only after the first committed receipt,
account balances, and reserve deltas reconcile.

## 5. LP withdrawal dry run

```tari
fn main() {
  let account = arg!["account"];
  let pool = arg!["pool"];
  let lp = account.withdraw(arg!["lp_resource"], amount!(<LP_RAW>));
  let (a, b) = pool.remove_liquidity(lp);
  account.deposit(a);
  account.deposit(b);
}
```

For every operation: first use walletd Manifest **Dry run**, capture `required_fees`, set a
user-approved ceiling at or above it, submit at most once only after explicit approval, then check
the committed receipt, resource/account balance deltas, pool reserves, LP supply, and journal.
