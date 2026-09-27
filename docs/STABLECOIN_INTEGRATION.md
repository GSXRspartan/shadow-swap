# STABLECOIN INTEGRATION

Status: public-wrapper AMM lane EXPERIMENTAL; direct private-stablecoin revealed-boundary lane
DESIGN_ONLY; private-stablecoin ↔ wrapper gateway BLOCKED.

## Upstream source
- Repository: https://github.com/tari-project/stable-coin
- Branch: main
- Pinned commit: `bef1a89aa33d89ca0ed3882b44cdd625f61303e2` (2026-09-22, `chore: reduce string sizes (#33)`)
- License: BSD-3-Clause
- Template: `templates/private_stable_coin/issuer-no-user-badge/` is the working version.

## Inspected upstream implementation

The reviewed template is `templates/private_stable_coin/issuer-no-user-badge`. It creates a
stealth private coin plus an optional public fungible `w<SYMBOL>` wrapper. The public wrapper is
minted/burned only by the stablecoin component, has no recall/freeze/deposit restriction, and is
compatible with the existing public-fungible pool *as a public asset*. That compatibility does not
make the quote asset permissionless or peg-guaranteed.

The component itself is admin-gated. Its controls include supply mint/burn, user-badge and
exchange-limit management, private-coin recall of revealed balances, UTXO freeze/unfreeze and
burn, transfer-fee configuration, and pause state. Both conversion methods require component
admin access plus a user badge proof; the former is capped by an admin-set per-user limit and
charges the configured wrapper-exchange fee. The project must never hold that admin badge.

## Route boundary and issuer risk

`PRIVATE_BEFORE_ROUTE` → `REVEALED_AT_MARKET_BOUNDARY` → `PUBLIC_AMM` →
`REPRIVATE_AFTER_ROUTE` is the privacy model for a future direct private-stablecoin pool. The
inspected upstream holder tests show that an ordinary account holder can withdraw and transfer a
revealed bucket of the same stealth resource without an admin proof. Ootle's wallet SDK also
builds holder-signed `stealth_transfer_with_input_bucket` instructions for a resource's own
stealth inputs and produces a revealed bucket. Neither operation invokes the stablecoin component.

The current `fungible_pool` deliberately rejects non-canonical stealth resources, so this is
`DESIGN_ONLY` until a separate revealed-boundary adapter has real engine proof. The AMM trade and
its reserves would be public. Re-stealthing is wallet-side and remains unproven for this route.

Treat every configured wrapper as `ISSUER_CONTROLLED_QUOTE_ASSET`: the AMM controls only its own
reserve accounting, LP supply, 30-bps fee, and swap rules. The issuer controls the backing/private
coin and whether or on what terms a user can enter or exit the wrapper. The public wrapper's source
rules are non-recallable/non-freezable, but this is an upstream-source/deployment review fact, not
a permissionless guarantee that the AMM template can prove for an arbitrary address under OPUS-08.

## Permitted architecture
```
PUBLIC FUNGIBLE / wSTABLE  -- public constant-product pool
TARI / wSTABLE             -- public constant-product pool

PRIVATE STABLE / TARI      -- DESIGN_ONLY revealed-boundary market
PRIVATE STABLE / TOKEN     -- DESIGN_ONLY revealed-boundary market

PRIVATE STABLECOIN ↔ wSTABLE -- BLOCKED: issuer-admin-gated conversion
```

## Privacy disclosure matrix
| Step | Asset Type | Amount Visibility | Admin Control Required |
|------|-----------|-------------------|------------------------|
| Holder's private stable UTXO | Stealth stable coin | Hidden from the public; issuer has a view key | Holder controls the spend key |
| Revealed market input | Same stealth resource, revealed bucket | Revealed | Holder-signed transaction; no issuer proof shown in the upstream holder path |
| AMM pool deposit | Revealed stable or wrapped public fungible amount | Revealed | Pool has no issuer authority |
| AMM reserve | Revealed public amount | Revealed | No |
| AMM output (public wrapped) | Revealed public amount | Revealed | No |
| Conversion back to private wrapper route | Stealth asset | Hidden from the public after conversion | Issuer-admin-gated |

Issuer-risk boundary: `recall_revealed_tokens` is an admin-only exposed method and its current
implementation targets a registered `Account` vault, not an arbitrary pool component vault. The
stealth resource itself is recallable/freezable by the stablecoin component, however, so LPs still
inherit `ISSUER_CONTROLLED_STABLECOIN` risk. A dedicated adapter must add hostile issuer tests
before its route becomes executable.

Important: the AMM trade itself is never confidential. The wrapper conversion builder remains
blocked because it would require issuer authority.
