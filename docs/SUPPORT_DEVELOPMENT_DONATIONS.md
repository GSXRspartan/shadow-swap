# Support development donations

What the donation feature is, where its addresses come from, and the properties it is built to
guarantee.

## 1. What it is

A link in the footer to `/support`, which shows the project's donation addresses with a copy
control and a QR code. That is all it is.

It is **not** in the primary navigation. A donation link beside the trading controls would read as
a toll on trading, which it is not. It is also not a modal: nothing about a donation is
time-sensitive, and a dialog over a trade screen is exactly the interruption to avoid.

### Required copy, verbatim

> **Support Shadow Swap Development**
>
> Shadow Swap is a public, noncustodial exchange. If you'd like to support ongoing development,
> infrastructure, security testing, and maintenance, you can make a voluntary donation.
>
> Donations are optional and are not required to trade, provide liquidity, or withdraw funds.

## 2. The XTM destination, and how it was verified

**Minotari L1 Mainnet, XTM:**

```
1259DG2v4nxMugUpj3pgSheEEhVZmoExr44GhpnC9FGVwiJscmwo2oYnzFTQWxcsHBYjmupCBaWUsNf5gDttKw2Xmg4
```

Supplied and authorized by the operator for public use. It is not the operator's primary wallet.

It was **verified, not assumed**. Parsed with the real Minotari format rather than matched against
a regex — the encoding is three separate base58 blocks and the last byte is a DammSum checksum,
neither of which a string check inspects:

| Property | Value |
|---|---|
| base58 length | 91 characters |
| Decoded length | 67 bytes → a **dual** address (view key + spend key) |
| Network byte | `0x00` → **mainnet** |
| DammSum checksum | valid |
| Features | `ONE_SIDED` |
| Payment id | none |

Two of those matter to a donor:

* **Mainnet.** Real XTM exists on no other network, which is why no testnet XTM destination is
  offered at all: a donation of test currency costs the donor their time and gives the project
  nothing.
* **`ONE_SIDED`.** The address accepts non-interactive payments, so an ordinary send from a
  Minotari wallet works — no interactive exchange with the recipient is needed. It is not
  interactive-only.

The verification is a test (`packages/protocol-client/test/donations.test.cjs`), so a future edit
to the address gets a failure rather than a silently wrong destination. The check also runs in the
read path, so the refusal happens before anything is displayed.

## 3. The Ootle destination, which does not exist yet

**Not configured on any network.** The operator has not supplied a permanent Ootle address, and
Ootle mainnet has not launched. The UI shows an unavailable state with the reason, and both the
copy and QR controls are disabled.

What the code deliberately does **not** do:

* It does not invent a placeholder. A donation sent to a guessed address is gone.
* It does not derive one from a walletd account, a testnet account, or the connected user's
  account. A donation destination is never derived from whoever is looking at the page.
* It does not fall back to another network. This is the single most important line in the module:
  a mainnet donor shown a testnet address would send real intent to a worthless destination, and
  the fallback would look like a feature.

Mainnet and Esmeralda are **distinct entries** with **distinct reasons**, because the remedies
differ — one waits for a launch, the other never gets an address at all:

| Network | Reason shown |
|---|---|
| mainnet | No address supplied yet, and Ootle mainnet has not launched. A placeholder would be worse than nothing. |
| esmeralda | There is no Esmeralda donation address and there will not be one: Esmeralda TARI is test currency with no value. |
| anything else | No address is configured, and no other network's address is ever used in its place. |

### Adding it later

One reviewed line in `OOTLE_DONATION_ADDRESSES` in
`packages/protocol-client/src/networks/donations.ts`. It is validated for the network it is listed
under, so an Esmeralda address placed under `mainnet` is a refusal rather than a substitution —
the bech32m checksum covers the network prefix, so the check needs no chain read.

No frontend change is needed: the panel renders whatever the configuration reports, including the
unavailable state.

## 4. Isolation

A donation address is the only address in this application that is a destination for value and is
**not** derived from the user, the chain, or a transaction they are building. That makes it the
most attractive thing to substitute: change one string and donations go elsewhere, with no wallet
compromised and nothing else visibly wrong.

So the destinations are literals in one reviewed module, isolated from every source an attacker can
influence. They are **not** read from:

* token metadata or a token symbol,
* a pool registry or an LP position,
* a URL parameter,
* a deployment manifest,
* a discovery service or a cached response,
* the connected account.

`assertDonationIsolation` is called before anything is rendered and throws unless the address is
one of the module's own configured destinations — so a value arriving from any of the above cannot
be displayed as a donation destination even if some future caller passes one in. That turns the
property from an intention into a test.

The donation configuration is also separate from pool reserves, LP positions, trading fees,
cross-layer maker inventory, user wallet accounts and swap recipients. Nothing in any of those
paths references it.

## 5. What opening the page does not do

* **No transaction is prepared or signed.** There is no amount field and no send control, because
  there is nothing to submit. The panel references no wallet bridge and no transaction builder, and
  a test asserts that by name.
* **No wallet connection is required.** The addresses are public receive-only configuration.
  Requiring a connection merely to view a donation address would be a reason to be suspicious of
  the address.
* **No fee is added and nothing is deducted.** A donation is separate from exchange fees, and no
  transaction this application builds pays anything to these addresses. Liquidity provider fees go
  entirely to liquidity providers, unchanged.
* **No privilege is bought.** No fee discount, no priority, no special access to liquidity, no
  share of trading fees, and no claim on the project.

## 6. The QR code

Encoded in-repo (`apps/web/src/lib/qr.ts`) rather than taken as a dependency. This renders a
destination for money; a dependency in that path is one more thing that can be replaced in a
registry, and `pnpm audit` does not tell you whether a package encodes the string you gave it.

**A wrong encoding fails safe.** A QR symbol carries its own Reed–Solomon error correction and a
BCH-protected format word, so a mis-encoded symbol fails to decode rather than decoding to a
different string: a scanner reports nothing, not another address. The full address is also always
shown as text with a copy control, so the QR is a convenience and never the only path.

It is verified three ways:

1. **Against ISO/IEC 18004 Annex A** — every Reed–Solomon generator polynomial the encoder uses
   equals the published one, compared as alpha exponents.
2. **Against the published capacity table** — byte capacity derived from the block structure
   matches the standard's level-M figures for versions 1–10.
3. **By round trip** — an independent reader in the test file recovers the mask from the symbol's
   own format word, reverses the module placement, de-interleaves the blocks and parses the header.
   It shares no code with the encoder's bit writing, padding or block building, so a placement,
   masking or interleaving error shows up as a payload that does not come back.

The rendered path is also asserted to be exactly the encoder's output for the configured address,
so the QR cannot drift from the text beside it.

## 7. Accessibility and mobile

* Every control is a real `<button type="button">` with a text label: reachable by Tab, announced
  by a screen reader, no icon-only affordance.
* The copy acknowledgement is in a `role="status" aria-live="polite"` region, so it is announced
  rather than only coloured.
* The address is a labelled region with `user-select: all`, so a browser that blocks the clipboard
  API still leaves a way to copy — and the panel says so when a copy is refused.
* The QR scales with the viewport (`min(200px, 60vw)`) and the address wraps rather than
  overflowing. No fixed pixel widths that would break a phone.
