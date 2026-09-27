# Frontend design review — Pixel Canary pass

An independent look at the browser client as a *product surface*, not only as a
security boundary. Written after re-running the render, security and browser
suites, and after reading the shell, the pool list, the pool page, the swap card,
the liquidity panel, the route panel, the NFT surfaces, the activity page, the
chart, the token sheet and the global stylesheet.

The design direction the interface already commits to — dark-first, dense,
tabular, restrained animation, honest states — is the right one for a serious
trading client. The work below is about finishing it, not replacing it.

---

## 1. Current visual system

**Surfaces.** Five near-black steps (`--surface-0` … `--surface-raised`) with a
cool cast; nothing is pure `#000`, and the deepest step is reserved for the page
behind sticky chrome. Borders are three hairlines (`--line-1/2/strong`) rather
than shadows, with `--shadow-2/3` reserved for popovers and the wallet dialog.
That is a coherent, professional base and it does not need reworking.

**Type.** System sans for chrome, system mono for numbers and identifiers, with
`.num` applying `tabular-nums` so price, amount and reserve columns align
vertically. The scale is small and deliberate (`--text-xs` … `--text-3xl`) with
`--text-md`/`--text-base` doing most of the work. Uppercase micro-labels
(`.label`) with wide tracking give the "terminal" feel without extra weight.

**Accent — changed in this pass.** The brand accent is now a Tari-inspired acid
lime, `--accent: #b7f04a`, with a dim step (`#6f9426`) for muted borders and a
wash/line pair for selected surfaces. It is used in exactly five places: the
active route underline, primary buttons, the focus ring, links, and the chart's
current-price line. Everything else stays a dark neutral. On `--surface-0` the
lime clears a very high contrast ratio, so it is safe as a text colour; lime text
is never used on a light surface because there are none.

**Positive state — also changed in this pass.** `--up` was the same family as
the old accent, which made a price-up number and a brand highlight
indistinguishable. `--up` is now a cooler emerald (`#35d69a`) with a matching
wash, so "the price went up" can never be read as "this is the selected thing".
The chart's up/down candle and volume colours were moved with it, and the chart
literals now carry a comment explaining that they must stay in step with
`tokens.css` (canvas cannot read custom properties).

**Motion.** `--dur-fast: 110ms`, `--dur: 190ms`, one shared easing curve, and a
`prefers-reduced-motion` block that zeroes both durations at the token level, so
reduced motion is a property of the system rather than something each component
has to remember.

**Density.** Row padding, table cell padding and card padding are all on the
4/8/12/16 scale. The interface reads as dense but not cramped at 1440 px, and
the mobile table→card transformation keeps the same density at 360 px.

---

## 2. Hierarchy and information architecture

**Navigation.** Three sections (Pools, NFTs, Activity) plus a pool detail page.
That is correct for this product: there is no empty "Home", and the pool list is
the natural entry point because trading requires choosing a market. The active
route now carries the lime underline in addition to the raised background, which
fixes the previous "which tab am I on" ambiguity on a dark background where the
fill difference was easy to miss.

**The primary path is visible without scrolling.** On a pool page the layout is
a two-column grid at ≥1100 px: chart and market data on the left, a sticky swap
column on the right (360 px, widening to 400 px at ≥1400 px). Below 1100 px it
collapses to one column with the swap card in normal document order. This is the
right hierarchy for a trading interface and it degrades correctly.

**What a first-time user can now determine**, which was the weakest part of the
previous state: the network and testnet badge are always in the header; data
freshness has its own badge; and when discovery is down, a single banner at the
top of the page states the condition and the reason instead of leaving the user
to read four empty tables.

**What still is not obvious:** a user arriving at a pool cannot tell *why* a
market has no candles (the market-data service refuses to store trades without a
wallet-backed readback) from the pool page itself. The health badge says
"Unavailable" but not "connect a wallet to see indexed data". This is a copy gap,
not a layout gap.


---

## 3. Pool discovery

The pool list is a scannable table with sort controls on pair, price, 24h
change, volume, liquidity and fee, a text filter over the pair label and the
component address, a per-row safety badge, and a per-row data-health badge.
Strengths worth keeping: tabular numbers, a `—` unavailable marker that is
distinguishable from a real zero, sortable headers with `aria-sort` and a
screen-reader suffix, and a footnote that explicitly refuses to show a fiat TVL
because nothing in the build can defend one.

Changes in this pass: the per-row health badge no longer looks a pool up and
discards the result, and its tooltip now names the pool the health refers to.

Weaknesses, honestly stated:

- On mobile the table becomes stacked cards via the `hide-sm`/`hide-lg` rules,
  which works, but the card still shows every column in the same order. A mobile
  card should lead with pair, price and 24h change, and push liquidity, fees and
  safety below a disclosure.
- The safety badge is the last column on desktop. It is a *risk* signal, which
  argues for placing it immediately after the pair rather than after the metrics.
- There is no "last data update" per row, so a stale row looks identical to a
  live one unless the global health badge is also stale.

---

## 4. Pool page and chart

The chart frame is correct: a fixed aspect container, a separate volume pane
below the price pane, a crosshair with a tooltip, a timeframe selector, and a
current-price line in the brand accent. Degraded states exist and are honest —
empty, no-trades, unavailable and health states each render their own message
rather than an empty canvas, and a chart failure cannot take down the swap
controls because the chart owns its own container and its own effect cleanup.

What is missing, in order of value:

1. **A statement of what the chart can actually be.** `AppContext` constructs
   `MarketDataService` with `pools: []`, no `TradeDiscoverySource` and no
   readback, so the indexer is never constructed: no trade is ever stored and
   every pool reports an unavailable market-data state, while the interface
   implies a live market. Either a real discovery source is wired, or the chart
   says plainly that indexed data is not available in this build. This is the
   most misleading thing in the current client.
2. `MarketDataService.follow()` and `Bundle.stop()` are exported and called
   from nowhere, so there is neither a live subscription nor a cleanup path
   yet. A no-data-yet skeleton distinct from a no-trades-ever empty state.
3. A stale marker *on the chart frame*, not only in the header badge, so a
   screenshot of the chart carries its own freshness.

No technical indicators were added, deliberately: there is no defensible source
for them in this build, and inventing them is out of scope.

---

## 5. Swap card, liquidity, and route

**Swap card.** FROM/TO with a reverse control, balance and max per side, exact
amount entry, expected output, protected minimum, slippage, the fee breakdown
(LP fee and provider spread named separately from any network fee), the route
line, and an asset-risk line for issuer-controlled resources. The architecture
underneath is the important part and it is sound: the browser parses the amount
exactly (`lib/amountInput.ts` refuses anything it is not certain about), then
the protocol-client re-reads the pool authoritatively and derives both the quote
and the minimum.

Weakness: the card carries a lot of text at once, and at 360 px the fee
breakdown becomes a long run of label/value pairs. Grouping it under a single
"Details" disclosure — open on desktop, closed on mobile — would improve the
first impression without hiding risk.

**Liquidity panel.** Deposits show the proportional LP hint; removals show the
expected reserves and refuse a redemption that would floor to zero. The honesty
rule — no APR, no APY, no impermanent-loss estimate — is respected and
documented. Missing: the fee attribution a user actually asks for ("of the LP
fees accrued since my deposit, how much was mine"). Computable from indexed
data, but only once a real readback and trade history exist, so it is deferred
rather than faked.

**Route panel.** The hop chain is built from the actual hop kinds, each step
shows its own state, and partial completion is treated as what it is: hop 1
settled, hop 2 paused, user now holds TARI. The accepted minimum is displayed as
a protected floor that a later quote cannot lower. This is the best-designed

---

## 6. NFT, activity, wallet dialog, and outage state

**NFT surfaces.** Cards degrade gracefully with no media, broken media, or
hostile metadata; exact identities (collection resource + NFT id) stay reachable
underneath the display name; prices show the unavailable marker rather than a
zero. The marketplace home distinguishes "no discovery endpoint configured" from
"the endpoint returned nothing" and — after this pass — from "the endpoint failed
and here is why".

Weakness: the holdings tab is an empty state with an explanation ("Holdings view
needs an indexer"). It is honest, but it is a navigation entry that leads
nowhere. Either wire it or hide it behind the connected state so it does not read
as a broken feature.

**Activity.** Five states with distinct badges, each with a plain-language
explanation, a reference table defining every state, and no retry affordance for
`UNKNOWN`. Changes in this pass: a persisted `CONFIRMED` is now labelled an
unverified claim with an explanation, and the reconcile action is enabled for it
(as "Verify against the chain") so the claim can actually be checked.

**Wallet dialog.** Account, network, capability rows, the atomic-swap
availability verdict, and the real-submit gate state. The gate is displayed as
off and cannot be set from the URL — asserted in the browser suite.

**Outage state (new this pass).** A single banner above the page content renders
when discovery has finished and failed, quoting the reason verbatim, stating
that nothing is being fabricated, and stating that wallet signing and
authoritative rereads are unaffected. It is deliberately a `warn` notice rather
than a modal: the app stays usable and the per-page states below it still carry
their own detail. The rendering decision lives in an exported `OutageNotice`
component precisely so it could be regression-tested without running effects,
and it never renders while discovery is still loading or while the source is
healthy — both cases are pinned by tests.

---

## 7. Mobile

Tested at 360, 390, 430, 768, 1024 and 1440 px, with browser assertions for
horizontal overflow at 390 px, 1440 px and the smallest supported width, plus a
render test that no component sets a bare pixel `width`. The layout is sound: the
two-row mobile header, the `hide-sm`/`hide-lg` table-to-card transformation, the
scroll container around wide tables, and a `prefers-reduced-motion` block that
also removes tooltips on touch (`@media (hover: none)`), which prevents hover-only
information on a phone.

What still needs work, in priority order:

1. The swap card's detail list is long at 360 px — the "Details" disclosure
   described above.
2. Touch targets: the ghost icon/ghost small buttons rely on `btn--sm` padding;
   the minimum comfortable target is 40–44 px, and the sortable column headers
   are text-sized. Worth measuring rather than assuming.
3. The wallet details dialog should be verified for scroll containment on a
   360×640 viewport specifically; it is a tall stack of rows.

---

## 8. Accessibility

Present and correct in the ways that matter for a financial review surface:

- a skip link as the first focus stop, and a `:focus-visible` ring built from the
  accent token so focus is never invisible;
- `sr-only` labels on icon-only controls, and accessible names asserted by a
  render test;
- sortable headers carry `aria-sort` plus a screen-reader suffix;
- status is never colour-only — every badge has a text label, and a browser test
  asserts that a critical status is not communicated by hue alone;
- `aria-invalid`/`aria-describedby` on the amount field, matching the strict
  parser that rejects it;
- reduced motion honoured at the token level.

Gaps: the pool-table sort buttons do not announce a keyboard-shortcut affordance
(not required, but nice); focus order inside the wallet dialog is not asserted by
a test; and a full contrast audit of every token pairing has not been
machine-checked. The accent change in this pass was chosen partly because it
maximises contrast on the dark surfaces, but the audit itself is outstanding.

---

## 9. Changes implemented in this pass

| Change | Why |
| --- | --- |
| Brand accent → Tari-inspired lime `#b7f04a`, with dim/wash/line steps | Commits to a distinctive, restrained identity; used in exactly five places |
| `--up` → emerald `#35d69a`; chart candle/volume colours moved with it | Stops a price direction from reading as a brand highlight |
| Chart price line and active route use the accent | Two places where "the thing that matters right now" should be marked |
| `OutageNotice` global banner + render regressions | Ootle is down; an outage must be stated, not inferred from empty tables |
| Bounded discovery transport with a reason | "No data" must never be rendered as "zero data" |
| Marketplace failure reason distinguished from an empty result | Same rule, on the NFT surface |
| Activity: unverified-claim badge + verification action | A persisted `CONFIRMED` is a local claim, not chain proof |
| Dead pool-health lookup removed; tooltip now names the pool | Code should not imply a per-pool state it does not have |

## 10. Deliberately deferred

- **Wiring live market-data follow.** It needs a real discovery source and a
  subscription lifecycle; until then the honest fix is a "not live" label, which
  is recorded above as the top outstanding item rather than silently ignored.
- **Mobile card reordering and the swap "Details" disclosure.** Both are real
  improvements; both are pure presentation changes that deserve their own pass
  with browser screenshots, not a drive-by edit during a security review.
- **A contrast audit of every token pairing**, and focus-order assertions inside
  the dialog.
- **APR / APY / impermanent loss.** Out of scope by decision, not by oversight.
- **Any new indicator, portfolio view, or route graph.** Out of scope by decision.

surface in the app and should be the reference for the others.
