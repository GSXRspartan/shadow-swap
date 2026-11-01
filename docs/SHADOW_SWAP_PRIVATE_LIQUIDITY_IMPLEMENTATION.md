# RevealedAssetPool — AMM liquidity for privacy-typed assets

`templates/revealed_asset_pool`, cohort tari-ootle **v0.48.0** (`6a25dbc`). **Unpublished.**

This answers the README's "future privacy-preserving liquidity" with what the protocol actually
supports today, and names precisely what it is not.

## 1. What it is

A separate constant-product AMM for resources whose value is held as an **exact revealed
integer**: ordinary public fungibles, created-Stealth resources (native tTARI included), and
Confidential resources whose buckets carry no blinded commitments.

**It is transparent liquidity, not confidential liquidity.** Its reserves, every swap amount
and every LP position are public integers on chain. Trading a Stealth- or Confidential-typed
asset here reveals the traded amount, its timing and the counterparty's account, for that trade
and for as long as the value sits in the pool. The asset's type is never converted. Every
surface that offers it says this; `route-resolver.test.cjs` asserts the word "confidential" is
never used to describe it.

## 2. Why Pool v2 was not changed

Pool v2's guard admits only `ResourceType::Fungible` and native tTARI by exact address, because
a template cannot inspect a resource's issuer authority (freeze/recall rules) at v0.48. That
guard is untouched, and `revealed_asset_pool.rs` `r01` proves the resources this pool admits are
**still refused** by Pool v2. Opting in per pair is the point: the risk of an issuer-controlled
resource is accepted pair by pair, not imposed on the public venue.

## 3. The invariant the whole design rests on

`bucket.amount()` must be a bucket's **whole** value, or integer reserve accounting is a lie.

| Container | Value fields upstream | Consequence |
|---|---|---|
| `Fungible` | `amount`, `locked_amount` | exact |
| `Stealth` | `revealed_amount`, `locked_amount` — **no commitment field at all** | a Stealth bucket is entirely revealed; exact |
| `Confidential` | `commitments`, `revealed_amount`, `locked_*` | `amount()` returns only the revealed part |
| `NonFungible` | token ids | no divisible amount; **rejected** |

So every incoming bucket passes `assert_contains_no_confidential_funds()` — the use upstream
documents for it ("before depositing it into a vault that expects only revealed funds") — and a
locked portion is refused too, because `amount()` excludes it. `r09` proves the refusal against
a bucket minted with a **real** blinded commitment, built by the engine's own test crypto.

Without that assert, a depositor's blinded value would be silently unaccounted for in a reserve
priced in exact integers.

## 4. Economics and authority

Identical to Pool v2, which is reviewed and was live-verified before the reset: constant
product, fee in basis points (30 bps default), the **full** input deposited so the fee stays in
the reserve for LPs, **no** developer or protocol fee, **no** owner (`OwnerRule::None`, so no
one can ever rewrite its access rules), **no** admin withdrawal method, LP mint/burn authorised
only by the component's own frame, and a permanently locked minimum LP supply.

Deliberate improvements over Pool v2:

| Change | Why |
|---|---|
| One deposit method, which takes the balanced amounts, refunds the rest and enforces `min_lp_out` | Pool v2 keeps a legacy `add_liquidity` that donates any imbalance to existing LPs; a new template has no compatibility obligation |
| `remove_liquidity(lp, min_a, min_b)` | an exit can be sandwiched too; Pool v2 has no exit bound |
| A swap may not drain a whole reserve | leaving a side at zero makes the pair unpriceable for everyone else |
| First-deposit minimum expressed in LP **shares** with 100× headroom over the locked amount | Pool v2's constant assumes six decimals and allows `shares == locked`, which at the boundary would lock 100% of the first depositor's position. The shares rule is precision-independent, and the refusal reports each side's divisibility |
| Returns the drained input buckets as the refunds | `Bucket::take` asserts `amount.is_positive()`, so `take(0)` panics — see §6 |

## 5. Publication (prepared, NOT executed)

Build and verify, then publish through walletd exactly as for the other templates
(`SHADOW_SWAP_P2P_SWAPOFFER_BROWSER.md` §8 has the full procedure and the reason the raw WASM
cannot be published directly):

```bash
tools/build-templates.sh --check    # revealed_asset_pool: 2feb75be…fb88e, 256,058 bytes
```

Then record the resulting address in `apps/web/src/services/protocolDeployment.ts` under
`ESMERALDA_V048.revealedPoolTemplates`, in a reviewed PR. That single change turns every
revealed-pool route from `BLOCKED` to `EXECUTABLE`; nothing else enables them. `poolKindOf`
refuses an address recorded in both the public and revealed lists, so a mis-recording fails
closed rather than letting a revealed pool be quoted as a public one.

### How a revealed pool is distinguished at execution time

Both templates produce the same component shape — `[pools, lp_resource, fee_bps,
locked_lp_vault]` — and expose the same `swap(Bucket, ResourceAddress, Amount)`. That is what
makes a mixed route possible, and it is also why **nothing on the wire** says a hop was a
transparent pool. So the venue is established from the one source that cannot be forged by
whatever proposed the route:

1. `decodePoolComponent` already REQUIRES the component header to name its template; that
   address is now surfaced as `PoolState.templateAddress`.
2. `withTrustedPoolTemplates` accepts a component whose template is recorded as **either**
   kind, and refuses a FOUND read whose reported template is unrecorded or absent.
3. `resolveMultiHopSwap` reports each hop's template address, in route order.
4. `ammRouteIntentBuilder` classifies them with the application's registry and derives the
   builder, the operation name and the disclosure. An unrecorded or unreported template
   **throws**: guessing would mean guessing "public", the less revealing of the two.

The Swap page therefore signs a transparent-pool swap and a mixed route directly, and the
review card it freezes says which venues were crossed.

## 6. Engine evidence

`audit_engine_tests/tests/revealed_asset_pool.rs`, 11/11:

| Test | Establishes |
|---|---|
| `r01` | Fungible/Stealth/Confidential admitted, NonFungible refused, same-resource and out-of-range fee refused, **and Pool v2 still refuses the private types** |
| `r02` | created-Stealth ↔ public fungible: create, fund, swap both ways, exact integer quote parity, type preserved |
| `r03` | two independently created Stealth resources paired with each other |
| `r04` | revealed Confidential ↔ public fungible, **including a partial revealed withdrawal from a Confidential vault** |
| `r05` | native tTARI (Stealth-typed) ↔ public fungible |
| `r06` | fees accrue to LPs, `k` strictly grows over three swaps, proportional exit, locked shares unredeemable |
| `r07` | `min_output`, `min_lp_out` and `min_a`/`min_b` enforced on chain, each reverting the whole transaction |
| `r08` | first-deposit policy: dust refused with a divisibility-aware message, lock exactly 1% at the boundary, locked shares survive a full exit |
| `r09` | a bucket carrying a real blinded commitment is refused; the reserve is untouched |
| `r10` | a dangling output (or dropped refund) fails the transaction |
| `r11` | a **mixed** multi-hop crosses a revealed pool and a Pool v2 atomically; an unreachable route minimum reverts both hops |

Browser JSON for `create_revealed_pool`, `revealed_swap`, `revealed_add_liquidity` and
`revealed_remove_liquidity` is **engine-executed** in `instruction_wire_v048.rs` and required to
match byte for byte by `apps/web/test/instruction-wire-v048.test.cjs`.

## 7. Confidential liquidity: what is and is not supported

**Supported:** a Confidential resource's *revealed* balance, in this pool, with the transparency
disclosure. `r04` proves the full round trip including partial payout.

**Not supported:** blinded (non-revealed) amounts. Spending a commitment needs a
`ConfidentialWithdrawProof`, which only a wallet can build from its own secrets; no browser
wallet exposes one, and an AMM that holds commitments cannot price them in integer reserves.
This pool refuses such buckets outright (`r09`) rather than accepting them and mis-accounting.
A `RevealedConfidentialPool` variant was considered and is unnecessary: the eligibility policy
plus the per-bucket assert covers Confidential resources without weakening anything.

**Hidden-value bilateral exchange** (both sides concealed, operator learning nothing) remains
out of reach: it needs wallet-exposed proof generation for a two-party statement, which does not
exist upstream. The precise missing primitive is a provider method that builds a
`ConfidentialWithdrawProof` for a destination the dApp names, without surrendering a view key.
No pseudo-privacy substitute was implemented.

## 8. Browser

`apps/web/src/components/RevealedLiquidityPanel.tsx` on the Pools page: create / add / withdraw,
gated on the recorded template, with the transparency notice, the first-deposit share policy
previewed before signing, revealed-balance checks read from the account's own vaults,
authoritative pool re-reads before pricing, and Stealth-input planning through
`stealthInputFor`. With no template recorded it explains why nothing can be created.
