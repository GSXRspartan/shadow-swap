# Cross-layer market-maker economics

What a liquidity provider is actually signing up for, in integers.

Every figure below was produced by running `quoteEngine.simulate` / `quote` from this repository,
not estimated. The script that produced them is reproduced in §8 so any number here can be
re-derived. Amounts are raw integers in the output asset's smallest unit; rates are basis points.

**There is no protocol rate between L1 XTM and L2 TARI.** They are distinct assets and nothing in
either chain fixes a price between them, so `referenceRatioNum/Den` has no default and must be
supplied. A 1:1 default would be an invented market price dressed as a protocol constant. The
examples below use 1:1 only because it makes the fee arithmetic legible.

## 1. What a maker's inventory is, and is not

A maker's inventory is **their own unescrowed balance on the chain they pay out on**, read from
chain. It is not an escrow, and the distinction is the whole reason `makerBook.ts` exists:

* A cross-layer escrow names its claimant at fund time and a claim takes the whole escrow
  (`CROSS_LAYER_ATOMIC_LIQUIDITY_PROTOCOL.md` §4a). So an escrow can only exist **after** a
  specific taker is matched, and it backs exactly one trade.
* Therefore nothing is escrowed when an offer is published. The coins stay in the maker's wallet,
  where the maker can spend them and no settlement can claw them back.

Which chain a maker pays out on is derived from the direction, never chosen:

| Direction | Taker brings | Maker pays out | Maker's inventory is on |
|---|---|---|---|
| `L2_TO_L1` (exit) | L2 TARI | L1 XTM | **Minotari L1** |
| `L1_TO_L2` (entry) | L1 XTM | L2 TARI | **Ootle L2** |

## 2. The double-promise guard

`makerBook.commit` is the only way a promise is created, and it refuses any promise the last
balance read cannot cover once every live promise is subtracted. That refusal is the only thing
standing between two matched takers and the same coins.

Why it is not merely an accounting nicety: a taker who is promised a payout funds **their** leg
first — on L1, irreversibly, because the L1 wallet generates the secret and so goes first. If the
maker then cannot pay, the taker's funds sit behind a 720-block refund branch for hours. "The
maker promised more than they hold" is somebody else's money locked up.

Three rules make the arithmetic honest rather than optimistic:

1. **A balance is a chain read or it is unknown.** `uncommittedRaw` returns `undefined` with no
   read, and a UI must print that rather than a zero. A read older than `MAX_READ_AGE_EPOCHS` (1)
   cannot support a new promise: a maker can spend their own balance at any moment.
2. **An escrowed payout is subtracted only when the read predates the escrow.** Once an escrow is
   funded the coins have left the wallet, so a later read already excludes them; subtracting again
   would hide inventory the maker really has. Within one epoch the order is unknown, so the
   comparison is `>=` — the conservative direction, which never overstates what is available.
3. **An expired escrow is `RECOVERABLE`, not available.** Those coins are on chain behind a refund
   branch. Nothing returns them until a refund transaction is signed and lands, and only a fresh
   read records their return. A lapsed *promise* is different: nothing ever moved, so its
   inventory is free immediately.

A restored book **drops every balance observation**. Persisted state is attacker-modifiable, and
a forged balance with a fresh timestamp is the one tampering the guard could not survive; every
other field is a record of something that already happened and is caught by the chain read any
action requires.

## 3. One-directional exit flow: the depletion question

The question a maker actually needs answered: *if only exits arrive, how fast does my XTM go, and
what did I earn for it?*

Inventory 1,000,000. Trades of 100,000. Minimum order 10,000. Twenty trades offered.

| Configuration | Filled | Refused | Paid out | Maker proceeds | Inventory left |
|---|---|---|---|---|---|
| 30 bps spread, no bonus | 10 | 10 | 997,000 | **+3,000** | 3,000 (paused) |
| 30 bps spread, 1% exit bonus | 9 | 11 | 906,300 | **−6,300** | 93,700 |
| 150 bps spread, 1% exit bonus | 10 | 10 | 995,000 | **+5,000** | 5,000 (paused) |

Three things to read off this:

* **One-directional flow at a positive spread does not lose money — it converts inventory.** The
  first row earns 3,000 and ends with the XTM gone and TARI in its place. Whether that is good
  depends entirely on what the maker wanted to hold, which is a judgement no fee schedule makes
  for them.
* **A bonus larger than the spread loses money on every trade it touches.** 30 bps earned against
  100 bps paid is −70 bps per trade; nine trades is −6,300. The engine does not stop this, because
  a maker paying to attract flow in a direction they want is a legitimate choice — but it must be
  a chosen one, which is what `minMakerProceedsRaw` is for (§5).
* **Running out is reported, not silently continued.** `applyFill` pauses the maker when the
  remaining inventory can no longer cover the smallest payout they would make. In row 2 it does
  *not* pause at 93,700: that still covers the 10,000 minimum, so smaller trades still price while
  a 100,000 one is refused with `remaining escrowed inventory is 93700, which cannot cover a
  payout of 100700`.

## 4. The exit bonus is not a yield

`BONUS_IS_NOT_YIELD` is carried wherever a bonus is displayed, and it says: *a better exchange
rate funded by the liquidity provider out of their own coins, for this one trade. Not interest,
not a yield, not an APY, and nothing accrues or compounds.*

The budget is a hard stop, and the stop is a cliff rather than a taper. A 1% bonus on trades of
100,000 costs 1,000 each; with `maxSubsidyRaw = 3000`, six trades produce:

```
filled=6  bonus total=3000  maker proceeds=-1200
```

Three trades are bonused at −700 each (−2,100), then the budget is exhausted and the next three
price at the plain 30 bps spread, +300 each (+900). Net −1,200.

A partially funded bonus is **never** scaled down to fit the remaining budget: a taker shown a
rate must get that rate, so the bonus is paid in full while it fits and then stops.

### Break-even

With a 1% bonus, the spread that makes a trade break even is exactly 100 bps:

| Spread | Maker proceeds per 100,000 |
|---|---|
| 99 bps | −10 |
| 100 bps | **0** |
| 101 bps | +10 |
| 130 bps | +300 |

So a sustainable exit promotion means a spread **above** the bonus — at which point the "bonus" is
a rebate against a wider spread, which is a fair thing to run and an unfair thing to describe as a
reward. A maker whose spread is below their bonus is buying flow, and the budget is the only thing
bounding what that costs.

## 5. `minMakerProceedsRaw` may be negative, and that is deliberate

A promoting maker's per-trade proceeds are negative by construction, so a non-negative-only floor
would make the exit bonus unconfigurable. It is parsed with a signed reader for exactly that
reason — and the opt-in is real, not decorative: with a floor of `0` and a 1% bonus against a
30 bps spread, the quote is refused outright:

```
This maker requires at least 0 per trade; at this size the bonus would leave -700.
```

A maker therefore cannot lose money on a bonus by accident. They have to lower the floor first.

## 6. Fixed costs and the minimum order

The fixed network cost is a real per-trade outlay (the maker's own chain fees) and does not scale,
so it dominates small trades. With `fixedNetworkCostRaw = 500` and a 30 bps spread:

| Trade size | Taker receives | Maker proceeds | Effective rate |
|---|---|---|---|
| 400 | **refused** — costs 502 ≥ output 400 | — | — |
| 500 | **refused** — costs 502 ≥ output 500 | — | — |
| 600 | 98 | 2 | — |
| 1,000 | 497 | 3 | — |
| 10,000 | 9,470 | 30 | 9,470 bps |
| 100,000 | 99,200 | 300 | 9,920 bps |
| 200,000 | 198,900 | 600 | 9,945 bps |

At 600 the trade "prices" and the taker receives 98 of their 600 — technically economic, obviously
useless. The refusal message says what to do about it (`a larger trade may price, since the fixed
network cost of 500 does not scale`), but the real fix is a **minimum order above the point where
the fixed cost stops dominating**. A maker whose chain fee is 500 should not be quoting 600.

## 7. Rounding, and who it favours

Division never rounds in the direction that would create value neither side put in:

* The taker's output floors (`mulDivFloor`), so a rounding surplus stays in the maker's inventory.
* Every cost the taker bears ceils (`mulDivCeil`), so a cost is never partly absorbed by the maker
  without their consent.

Across many trades either error would be a real transfer, which is why the arithmetic is integer
throughout and every quote carries its own `steps` — the arithmetic in order, so a quote can be
reproduced without rerunning the code.

## 8. What this model does **not** answer

**It is a model of this pricing logic, not of a market.** It assumes every quoted trade that is
not refused settles. Real flow depends on counterparties who may not appear, so the conclusion
worth drawing from §3 is about *depletion*, not about profit.

**It has one inventory pool, so it cannot model two-way rotation.** `simulate` tracks a single
`availableInventoryRaw`, so an entry trade drains the same figure an exit trade does:

```
5 exits + 5 entries, 100,000 each, 1,000,000 inventory
  filled=10 refused=0 left=3000
```

That is not what a real two-way maker experiences — an exit drains L1 and credits L2, and an entry
does the reverse. The reason the simulator does not model the credit is principled rather than
lazy: **a credit on the other chain is a chain read, not a model output.** `makerBook` tracks the
two chains separately and will only credit an inventory from an observation, so the honest answer
to "how does two-way flow rotate my inventory" is a pair of balance reads, not a simulation.

**It says nothing about price risk.** A maker holding XTM and quoting TARI is exposed to the ratio
between them moving, and nothing here hedges, predicts or bounds that. The spread is compensation
for the service, not for the exposure.

### Reproducing the figures

```js
const pc = require('./packages/protocol-client/dist/index.js');
const base = {
  referenceRatioNum: '1', referenceRatioDen: '1', baseSpreadBps: 30,
  fixedNetworkCostRaw: '0', variableCostBps: 0, exitBonusBps: 0, maxSubsidyRaw: '0',
  perTradeMaxRaw: '10000000', minOrderRaw: '10000', maxOrderRaw: '200000',
  committedInventoryRaw: '1000000', maxDailyVolumeRaw: '100000000',
  minMakerProceedsRaw: '-1000000', maxExposurePerCounterpartyRaw: '100000000',
};
const state = inv => ({ filledTodayRaw: '0', subsidySpentRaw: '0',
  exposureByCounterparty: {}, availableInventoryRaw: inv, paused: false });
const flow = (n, size, dir) => Array.from({ length: n },
  (_, i) => ({ direction: dir, amountInRaw: String(size), counterpartyId: 't' + i }));

pc.simulate(base, state('1000000'), flow(20, 100000, 'L2_TO_L1'));
pc.simulate({ ...base, exitBonusBps: 100, maxSubsidyRaw: '1000000' },
            state('1000000'), flow(20, 100000, 'L2_TO_L1'));
pc.simulate({ ...base, baseSpreadBps: 150, exitBonusBps: 100, maxSubsidyRaw: '1000000' },
            state('1000000'), flow(20, 100000, 'L2_TO_L1'));
```

## 9. Readiness

| Claim | Status |
|---|---|
| Integer quoting, limits, bonus budget, rounding direction | **ENGINE VERIFIED** (unit) |
| Inventory accounting and the double-promise guard | **ENGINE VERIFIED** (unit) |
| Depletion figures in §3, §4, §6 | **ENGINE VERIFIED** — produced by running this repository's own code |
| Two-way inventory rotation | **NOT MODELLED** — see §8 |
| Real maker behaviour against real flow | **BLOCKED** — no offer has been quoted to a real counterparty on any network |
| Exit-side market making from a browser | **BLOCKED** — paying out XTM needs an L1 balance read and an L1 TariScript; `MakerInventoryPanel` refuses to publish an exit offer rather than advertise an unverifiable balance |
