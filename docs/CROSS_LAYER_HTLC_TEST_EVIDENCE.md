# Cross-layer HTLC test evidence

Every test that backs a cross-layer claim, what it actually proves, and — the part a test
inventory usually leaves out — what it does **not**.

## 1. Where the evidence comes from, and how strong each kind is

| Layer | Runs against | What a pass means |
|---|---|---|
| Engine tests (`audit_engine_tests/tests/*.rs`) | The real Ootle v0.48.0 engine, cohort `6a25dbc524581bfaa0a3c6ef120f8d59cc827572`, via `TemplateTest` | The template behaved this way **in the engine**. The strongest evidence here. |
| Wire tests (`instruction-wire-v048.test.cjs`) | A fixture produced by that same engine | The browser builder emits the **byte-identical** instruction the engine executed. |
| Client unit tests (`packages/protocol-client/test`) | Pure TypeScript | The client's own arithmetic and refusals. Proves nothing about either chain. |
| Acceptance scenarios (`cross_layer_acceptance.test.cjs`) | **Simulated** chains | The modules agree with each other and with the rules both chains enforce. **Not** evidence of on-chain behaviour. |
| Browser render tests (`apps/web/test`) | `renderToStaticMarkup` | What a user is shown, including what is *not* offered. |

## 2. The L2 escrow template, in the engine

`templates/cross_layer_htlc` — `audit_engine_tests/tests/cross_layer_htlc.rs`, **10/10**.

| Test | What it proves |
|---|---|
| `h01_fund_then_claim_pays_the_claimant_and_publishes_the_preimage` | Exactly the escrowed amount leaves the funder and arrives with the claimant; the secret is readable from component state afterwards, so the counterparty finishes their own leg from an ordinary substate read rather than by parsing a transaction argument. |
| `h02_only_the_committed_preimage_opens_the_escrow` | A different secret, one truncated by a byte, one with a byte appended, an empty one and a 65-byte blob are all refused, the escrow is untouched, and the right secret still works afterwards. |
| `h03_only_the_named_claimant_claims_and_only_the_funder_refunds` | The access rules hold: neither party can take the other's branch. |
| `h04_refund_is_refused_before_expiry_and_pays_the_funder_after` | The funder cannot change their mind inside the window. |
| `h05_claim_and_refund_can_never_both_succeed` | The two windows abut without overlapping, so the L2 leg has no race to lose. |
| `h06_an_escrow_settles_exactly_once` | Claim twice, refund twice, refund-after-claim and claim-after-refund are all refused. |
| `h07_funding_terms_are_validated_before_anything_is_escrowed` | Zero amount, a past or equal expiry, an empty counterparty leg, and funder == claimant are all refused **before** anything moves. |
| `h08_the_recorded_hash_is_exactly_the_sha256_an_l1_output_carries` | The 32 bytes in L2 component state are byte-for-byte the SHA-256 digest an L1 output commits to, and the round trip holds at both ends of the 1..=64-byte bound. |
| `h09_whatever_is_escrowed_is_exactly_what_is_delivered` | Asset identity is preserved, including a created-Stealth resource — the asset an exiting L2 holder actually has. |
| `h10_a_bucket_carrying_blinded_commitments_cannot_fund_an_escrow` | A Confidential bucket with a blinded portion is refused before anything is escrowed. |

### Two things worth recording about h08 and h10

**Both were documented in that file's header and not implemented.** The header listed h08 and h10
among the proven properties while only eight tests existed (h01–h07 and h09). They are implemented
now; the gap is noted because a header that over-claims is worse than one that omits.

**h08 is not a corollary of h01.** h01 proves a claim *succeeds* against a digest computed with
`sha2`, which proves the engine's `hash_sha256` intrinsic agrees over raw bytes. It does not prove
what a *counterparty* sees. The whole cross-layer binding rests on the 32 bytes in L2 state being
the same 32 bytes the L1 script commits to, because that is what `decodeCrossLayerEscrow` reads
and compares against the L1 output. h08 asserts the recorded bytes directly.

**h10 needed a positive revealed amount to test the right thing.** A statement whose whole value
is blinded produces a bucket whose `amount()` is zero, so the template's *positive-amount* assert
fires first — a correct refusal of the wrong thing, leaving the confidential guard uncovered. The
test sets `output_revealed_amount` so the bucket carries 500 revealed beside a real blinded
commitment, which is the shape that actually reaches `assert_contains_no_confidential_funds()`.

### One assert in the template has no test

`fund` also asserts `asset.locked_amount().is_zero()`. **There is no test for it**, because the
engine test tooling has no way to hand a template a bucket with a locked portion, so the branch
cannot be driven. It is a defensive assert with no coverage. (`revealed_asset_pool` carries the
same untested assert.) Listing it as proven would have been false, so it is listed here instead.

## 3. The browser builders, against the engine's own wire format

`apps/web/test/instruction-wire-v048.test.cjs` — the fixture is produced by the pinned v0.48.0
engine, and each test compares the builder's output to the instruction the engine **executed**.

| Test | What it proves |
|---|---|
| `wire == engine: cross_layer_fund (withdraw -> fund, NO deposit — the escrow is a component)` | The funding transaction withdraws and calls `fund`, and deposits nothing: `fund` returns a Component, so a deposit instruction would fail the transaction. |
| `wire == engine: cross_layer_claim (claim -> deposit, the preimage as a Vec<u8>)` | The claim passes the secret as the engine's own `Vec<u8>` encoding and deposits the returned bucket. |
| `wire == engine: cross_layer_refund (refund -> deposit, no arguments)` | The refund takes no arguments and deposits the recovered bucket. |
| `cross-layer builders refuse terms that cannot settle, before a wallet is asked` | A zero amount, a malformed hash or claimant, an expiry at or before the read epoch, a missing or oversized counterparty leg, and a malformed secret are all refused locally. |
| `a cross-layer escrow is never presented as a same-chain swap` | The cross-layer intent is its own type, with its own disclosure, and cannot be rendered through the same-chain swap path. |

## 4. The client stack

`packages/protocol-client/test` — **387/387** overall. The cross-layer files:

| File | Tests | What it covers |
|---|---|---|
| `cross_layer_atomic_swap.test.cjs` | 7 | Direction mapping, the forced funding order, timeout derivation per network, counterparty-proposal checking |
| `cross_layer_maker_offer.test.cjs` | 9 | The five evidence states, and that a FUNDED escrow is offerable only to the key it names |
| `cross_layer_maker_book.test.cjs` | 15 | Inventory observations, the double-promise guard, the subtraction rule, recoverable-vs-available, tamper-resistant restore |
| `cross_layer_quote_engine.test.cjs` | 11 | Integer quoting, rounding direction, limits, the exit bonus and its budget |
| `cross_layer_wallet_capabilities.test.cjs` | 9 | What each wallet surface can sign, and that an incomplete plan is a refusal |
| `cross_layer_l1_adapter.test.cjs` | 6 | The gRPC request/response contract, and what the handler ignores |
| `cross_layer_l1_companion.test.cjs` | 13 | The sync gate, capability discovery, script rendering, output verification, UNKNOWN classification, balance-delta settlement |
| `cross_layer_lifecycle.test.cjs` | 9 | Stage transitions, recovery, and that no record ever holds a secret |
| `cross_layer_invitation.test.cjs` | 9 | Invitation validation, canonical form, and verification against chain |
| `cross_layer_escrow.test.cjs` | 7 | The escrow decoder, including live balance versus remembered amount |
| `cross_layer_acceptance.test.cjs` | 24 | The 23 two-chain scenarios, plus the harness stating its own limits |

`packages/wallet-adapter` — **31/31**. `apps/web` — **580/580**, including
`maker-inventory.test.cjs` (6), which asserts what the maker surface says and refuses on its first
frame.

## 5. The 23 two-chain scenarios

Against simulated chains (`acceptanceHarness.ts`). The simulation restates what the template and
the L1 script assert, including the difference the L2 template deliberately does not copy.

| # | Scenario | What it establishes |
|---|---|---|
| A01 | Exit settles on both chains | The exit path, with the maker funding L1 and claiming L2 |
| A02 | Entry settles on both chains | The entry path, with the roles swapped |
| A03 | L1 funded, L2 never funded | The L1 funder recovers at the refund height — not a block early |
| A04 | L2 funded, never claimed | The L2 funder recovers at the expiry epoch — not an epoch early |
| A05 | L2 claim and refund never overlap | The L2 leg has no race to lose |
| A06 | A late L1 claim races the refund | The L1 asymmetry, both outcomes: the late claim wins if the refund has not confirmed, and loses outright if it has |
| A07 | A wrong secret opens neither leg | And a malformed one is rejected earlier still, on shape |
| A08 | An escrow names one claimant | A stranger cannot claim it, and `isOfferableTo` never offers it to them |
| A09 | A hash no L1 output carries | Caught by reading the output, which is why the hash must come from the read and not the claim |
| A10 | An unreadable script | UNVERIFIED, and the second leg is not funded |
| A11 | An under-funded leg | Refused on both sides rather than settled for less |
| A12 | A funding wallet behind the tip | Refused, and the output really would have refunded early |
| A13 | Timeout ordering | The L2 deadline comes strictly first, with the margin recomputed rather than trusted |
| A14 | A claim one epoch late | A stalemate: the secret is never published and both legs refund |
| A15 | Two takers, one inventory | The second promise is refused |
| A16 | A lapsed promise versus an expired escrow | One frees inventory immediately; the other does not |
| A17 | A stale balance read | Cannot support a new promise |
| A18 | The exit bonus budget | Stops at a cliff, and the arithmetic shows the per-trade loss |
| A19 | Invitation replay across networks | Refused on both network and generation |
| A20 | An invitation addressed to someone else | Not actionable by this taker |
| A21 | An invitation disagreeing with chain | The chain wins, in every field |
| A22 | An ambiguous submission | UNKNOWN, reconciled against chain state, never retried |
| A23 | A route no wallet can finish | Refused, refunds included |

A15 and A16 are the maker-side pair; A03, A04, A15 and A16 are the ones that matter most, because
a protocol that settles when both parties cooperate is the easy case.

## 6. What none of this proves

| Claim | Status |
|---|---|
| The L2 escrow behaves as described | **ENGINE VERIFIED** |
| The browser's L2 instructions match what the engine executes | **BROWSER BUILDER VERIFIED** |
| The client's arithmetic, refusals and accounting | **ENGINE VERIFIED** (unit) |
| The composed exchange, against simulated chains | **ENGINE VERIFIED** — and the chains are simulated |
| A real wallet approved a real cross-layer L2 transaction | **BLOCKED** — not attempted; Esmeralda was unreachable throughout |
| An L1 HTLC script executed | **BLOCKED** — no transport, no funded L1 account |
| A secret observed crossing from L2 to L1 | **BLOCKED** |
| Two reconciled balances after a completed exchange | **BLOCKED** |
| The `locked_amount` guard in `fund` | **UNTESTED** — the branch cannot be driven by the test tooling |
| Two-way maker inventory rotation | **NOT MODELLED** — see `CROSS_LAYER_MARKET_MAKER_ECONOMICS.md` §8 |

The acceptance procedure that would move the blocked rows is
`CROSS_LAYER_ESMERALDA_ACCEPTANCE.md`.
