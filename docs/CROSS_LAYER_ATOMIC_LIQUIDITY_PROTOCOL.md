# Cross-layer atomic liquidity protocol

A bilateral, noncustodial exchange of **existing** L2 Ootle TARI for **existing** L1 Minotari XTM.
No burn, no mint, no bridge, no custodian, no operator discretion.

This is **not** Tari's native burn-and-claim. That route exists, is one-way (L1 → L2), and is
documented separately in `SHADOW_SWAP_L1_L2_ROUTING_IMPLEMENTATION.md`. It is retained as
technical background and is **no longer a Shadow Swap trading route**.

The priority direction is **L2 TARI → L1 XTM**, because it is the one Tari has no native path for:
v0.48 has no peg-out instruction and the base layer has no verifier for an L2 exit proof. The only
way an L2 holder gets real XTM is for a counterparty who already holds XTM to trade it.

## 1. Who funds what, and why it is not a choice

`send_sha_atomic_swap` generates the preimage **inside the funding wallet** and returns it; the
request has no hash parameter. Therefore **the L1 funder is always the secret holder.** Standard
HTLC safety then forces the rest: the secret holder reveals by claiming the counterparty's leg, so
their own leg must be the one that expires **later**, and they must fund **first**.

| | **L2 → L1** (the exit, priority) | **L1 → L2** (the entry) |
|---|---|---|
| User gives | L2 TARI | L1 XTM |
| User gets | **L1 XTM** | L2 TARI |
| L1 leg funded by | **Maker** | **User** |
| L2 leg funded by | User | Maker (from inventory they hold — no mint) |
| Secret held by | Maker | User |
| Funding order | L1, then L2 | L1, then L2 |
| Preimage revealed on | **L2** | **L2** |
| Claim order | maker claims L2 → user claims L1 | user claims L2 → maker claims L1 |

That the preimage is revealed on **L2 in both directions** is a useful property, not a coincidence:
the secret holder always claims the L2 leg, and L2 component state is indexer-readable, so the
watching party detects revelation with an ordinary substate read rather than by parsing an L1
script input.

## 2. The exit flow, step by step

1. **Quote.** The user picks an amount and a direction. A maker offer is only executable if its
   inventory is funded (see `CROSS_LAYER_MARKET_MAKER_ECONOMICS.md`).
2. **Maker funds L1.** `send_sha_atomic_swap` to the **user's** L1 address. The maker's wallet
   returns `pre_image` and `output_hash`. The maker keeps the preimage and publishes the output
   hash.
3. **User verifies against chain.** The user reads the funded L1 output and takes the hash **from
   the output's own script**, not from anything the maker says. This is what prevents a maker from
   inducing the user to lock L2 funds against a hash no L1 output commits to.
4. **User funds L2.** `CrossLayerHtlc::fund(asset, hash_lock, claimant=maker, expires_at_epoch,
   counterparty_leg=<L1 output hash>)`. The deadline comes from `deriveTimeouts`, never from a
   browser clock, and the maker's proposed deadlines are re-checked with `checkProposedTimeouts`.
5. **Maker claims L2.** `claim(preimage)` pays the maker the TARI and **persists the preimage** in
   component state.
6. **User claims L1.** The user reads the preimage from L2 and calls
   `claim_sha_atomic_swap{output, pre_image, fee_per_gram}`.

**Failure handling.** If the user never funds L2, the maker refunds L1 after its height. If the
maker never claims L2, the user refunds L2 after its epoch and the maker refunds L1. Neither party
can be left short, provided the margin in §3 holds.

## 3. Timeout ordering, formally justified

The L1 deadline **cannot be set**: it is `tip + 720` blocks, fixed in the wallet. So the only
adjustable deadline is L2's, and it must come **earlier** — by enough that the second claimant can
observe the preimage, broadcast their claim, and have it confirm past a shallow reorg.

`CLAIM_MARGIN_FRACTION = 0.5`: half the L1 window is reserved as margin. The asymmetry justifies
the generosity — too much margin only shortens the claimant's window, while too little loses the
entire position. Rounding is **always down** to a whole L2 epoch, so rounding can only enlarge the
margin.

Because 720 is a fixed **block count**, the real durations differ per network:

| Network | L1 block | L1 window (720 blocks) | L2 epoch | L2 deadline | Margin |
|---|---|---|---|---|---|
| Esmeralda | ~30 s | **~6 h** | ~40 min | 4 epochs (~2 h 40 m) | ~3 h 20 m |
| Mainnet | 120 s | 24 h | 2 h | 6 epochs (12 h) | 12 h |

**On Esmeralda the L1 window is about six hours, not twenty-four.** The wallet's comment ("2 min
blocks … 24 hours") is mainnet's block time, and Esmeralda's own `vn_epoch_length` comment
("15s per block") disagrees with its configured `target_time`. `deriveTimeouts` therefore takes
the **observed** tip height and epoch as inputs, so a live network that disagrees with its
constants cannot silently shorten a window. Details in
`CROSS_LAYER_WALLET_CAPABILITY_MATRIX.md` §4.

A malicious counterparty who waits until the last permissible moment is the case the margin is
sized for: it is computed from the **worst** case, where the first claim lands immediately before
the L2 deadline.

## 4. What the L2 leg enforces

`templates/cross_layer_htlc`, engine-verified (`cross_layer_htlc.rs`, 8/8). It mirrors the L1
script, with two deliberate differences, both safer:

1. **Claim and refund windows abut without overlapping.** L1's claim branch has no height
   condition, so on L1 a late claim races the refund and the outcome depends on block ordering.
   On L2, `claim` is refused at/after expiry and `refund` before it. `h05` proves both halves.
2. **The preimage is persisted on claim**, rather than left to be recovered from a transaction
   argument, because the counterparty's whole position depends on reading it.

Also enforced: only the named claimant may claim and only the funder may refund (`h03`); an escrow
settles exactly once (`h06`); terms are validated before anything is escrowed (`h07`); and the
escrowed asset is delivered unchanged, including created-Stealth (`h09`).

`OwnerRule::None`, no admin method, no fee, no discretionary withdrawal.

## 5. What is **not** yet proven

| Claim | Status |
|---|---|
| L2 escrow behaviour | **Local engine verified** |
| Timeout arithmetic, direction mapping, counterparty-proposal checking | **Local engine verified** (unit) |
| L1 script shape and gRPC surface | **Source verified** at `3994846`; no L1 script executed here |
| L1 funding / claiming / refunding | **Blocked in this environment** — needs a local wallet and a funded L1 account |
| **The composed two-layer exchange** | **NOT VERIFIED** — neither simulated nor live |
| Browser-only cross-layer trading | **Blocked for the L1 leg only.** The L2 leg is browser-signable today through Sapient or Tari Universe's embedded dApp provider (transaction requests carry an instruction list, so they can call a template method). L1 needs a local wallet because no browser API expresses a TariScript. See the capability matrix §3 |

**Signer assignment, from the capability matrix §3:** the L1 leg needs a local wallet over gRPC —
the only surface that builds the HTLC script at all. The **L2 leg is browser-signable today**,
through either Sapient or Tari Universe's embedded dApp provider: both implement the same
13-method dApp API, and a transaction request carries an instruction list, so it can call
`CrossLayerHtlc::fund` / `claim` / `refund`. A dApp never detects which wallet it has, so these
are two capability sets rather than two integrations.

Universe's separate **in-app Tapplet signer** is a different, narrower channel that can sign
neither leg; it matters only if Shadow Swap is ever shipped as a Tapplet rather than as an
ordinary web page.

**This document does not claim an atomic cross-layer swap.** Both legs are individually
characterised; the composition is not verified. Per the campaign's own rule, that claim waits for
a real L1 script execution, shared preimage revelation observed across both layers, and reconciled
balances for both participants.

## 6. Not yet built

The liquidity marketplace (maker inventory, funded-offer states, quote engine, incentives), the
browser and local-wallet integration, and staging deployment are **not started**. The protocol
above is the foundation they require, and is deliberately the part that was built first because
everything else is unsafe to design around until the chains' real constraints are known.
