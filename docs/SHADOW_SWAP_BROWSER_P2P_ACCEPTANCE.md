# Browser P2P acceptance — SwapOffer maker/taker

What a reviewer or operator should check in a browser, and what is already proven below it.
Prerequisite for anything to be executable: a SwapOffer template published and recorded for the
verified network generation (`SHADOW_SWAP_P2P_SWAPOFFER_BROWSER.md` §8). With none recorded, the
expected result of every case is the gated message, which is itself case 0.

## 0. Gated state (the shipped build)

`/swap` → P2P panel must say offers are unavailable on this network with the reason, show **no**
create or fill control, and let an invitation be inspected only as UNVERIFIED claims. Covered by
`apps/web/e2e/p2p-offers.spec.ts` in a real browser.

## 1. Maker: create an offer

| Check | Expected |
|---|---|
| Offered NFT selection | A **dropdown of items this account provably holds**, read from its own vaults. No engine id is typed. |
| Offered amount beyond the revealed balance | Refused in the browser, before the wallet is asked |
| An item the account no longer holds | Refused with "does not currently hold" |
| A private-typed offered asset | Shows the revealed-amount warning; the asset keeps its type |
| Hash lock | Preimage generated or typed locally; the lock shown; the preimage **never** stored, never in the invitation |
| Expiry | Entered in epochs; refused when the current epoch is unknown |
| Review | States what leaves (INPUT) and what is requested (OUTPUT), and matches the wallet's approval card exactly |
| After commit | The offer component is found **from the transaction receipt**, and its invitation appears under "My offers" |

## 2. Taker: import and fill

| Check | Expected |
|---|---|
| Paste or open a file | Both work; QR is deliberately absent (no camera dependency) |
| Verify | The offer is **re-read from chain**; the terms shown are the chain's, not the invitation's |
| A forged invitation (any altered term) | Not fillable; the differences are listed; the chain terms are still what is displayed |
| Another network or generation | Not fillable |
| A requested asset the taker lacks | "Insufficient balance", or for an NFT "you do not hold the requested item", from the chain-read inventory |
| Designated-taker offer | A warning that only one key can fill; the network enforces it |
| Hash-locked offer | A preimage field appears; the fill button stays disabled until it is well-formed |
| Fill | The escrowed asset is deposited into the taker's account; the wallet card matches the review |

## 3. Maker: claim, cancel, recover

| Check | Expected |
|---|---|
| After a fill | "Claim proceeds" appears; claiming deposits the payment |
| Before a fill | "Cancel and refund" appears; cancelling returns the escrow |
| A filled offer | No cancel is offered, and the network would refuse one |
| Status | Always read from chain, never from the local list |
| Reload mid-approval | The same durable request id resumes; exactly one transaction |

## 4. What is already proven in the engine

`audit_engine_tests/tests/p2p_offer_routes.rs`, 17/17 — these do not need re-proving by hand,
only confirming end to end once with a real wallet:

`p01` fungible↔fungible · `p02` created-Stealth→fungible into the taker's account ·
`p03` Stealth↔Stealth · `p04` NFT↔named NFT · `p05` designated taker (a third party refused) ·
`p06` hash lock (wrong preimage refused) · `p07` wrong resource/amount/NFT refused, escrow
untouched · `p08` cancel refunds; fill-after-cancel, claim-before-fill and non-maker cancel all
refused · `p09` expiry (unfillable, still recoverable) · `p10` created-Stealth from the maker's
own account · `p11` NFT→public fungible · `p12` public fungible→ONE named NFT (a different token
of the same collection refused, escrow untouched) · `p13` NFT→created-Stealth payment ·
`c01`/`c03` revealed Confidential · `c02` Pool v2 refuses a Confidential resource ·
`c04` NFT→revealed Confidential payment.

Wire format: every browser operation's JSON is **executed by the engine** in
`instruction_wire_v048.rs` and required to match byte for byte by
`apps/web/test/instruction-wire-v048.test.cjs`.

Invitations: 11 forgery cases, secret-carrying and malformed codes, and the blocker set
(filled, cancelled, expired, wrong taker, own offer, unknown epoch) in
`apps/web/test/swapoffer-flow.test.cjs`; the chain decoder's tamper cases in
`swapoffer-decoder.test.cjs`.

## 5. Things that must never be observed

- An invitation that changes what is signed. The signed terms always come from `decodeSwapOffer`.
- A hash-lock preimage in storage, a URL or an invitation (`deployment.test.cjs` checks the
  panel for exactly this property rather than banning the word).
- A P2P control while no SwapOffer template is recorded.
- A revealed-value or private-typed trade described as confidential.
- Any asset arriving as a different resource or container kind than was escrowed.
