# Pixel Canary — independent architecture review

Written from the code outward, not from the existing documents inward. Where a
claim in an existing document is repeated here, it was re-checked against the
implementation first, and the check is named. Existing reports were treated as a
list of hypotheses: several of their conclusions held, one of their statements
about tooling was withdrawn (`docs/GITHUB_PAGES.md`), and several gaps they do
not mention are recorded below.

Scope: `packages/protocol-client`, `packages/wallet-adapter`, `apps/web`,
`templates/*`, `crates/*`, `.github/workflows`, hosting configuration.

---

## 1. Boundaries that are strong enough to keep

These are the parts of the system where responsibility is genuinely single, the
trust direction is right, and a future refactor would have to work hard to break
them. They are worth more than most of the features built on top of them.

**1.1 Execution is separated from display by a runtime brand, not by a
convention.** `lib/tradeBoundary.ts` brands a display value with a *real* `Symbol`
rather than a `declare const` type fiction, so the guard keeps working after
compilation, and the same module provides the only funnel (`asRawExecutionAmount`,
`asResourceAddress`) that turns user input into an execution input. The comment
explains exactly why the type-level-only version was rejected. This is the single
most important boundary in the frontend and it is implemented the right way.

**1.2 The signing path is gated three times, and none of the gates can be
skipped by a caller.** `services/execution.ts` requires (a) a live identity
re-derived from `window` — not the cached provider reference — (b) a differential
match between the frozen review and the intent, and (c) that the review *and* the
reviewed wallet request are actually frozen. The reviewed request is then handed
to the provider rather than re-derived from a preview, so "shown == signed" rests
on one code path, not two that must agree.

**1.3 Discovery and authority are different types with different constructors.**
`IndexerPoolDiscovery` / `IndexerMarketplaceSource` produce descriptors; execution
resolvers accept a `PoolReadbackProvider` / `MarketplaceReadbackProvider` and
`createOotleReadbackProvider` refuses to be constructed with a non-authoritative
source. The frontend's readback is bound to the wallet and explicitly never
substitutes an indexer.

**1.4 The cross-layer state machine refuses to record unproven evidence.** In
`crosschain/session.ts`, `L1_VERIFIED_FUNDED` and `L2_VERIFIED_FUNDED` build an
explicit `gaps` list and *throw* rather than stamp partial evidence; `L1_FUNDED`
requires the stamp before second-leg funding. This is the shape of a correct
design: the unsafe thing is not representable as a successful transition.

**1.5 The L1 amount-authority boundary fails closed at three independent
points.** Verified in code, not just documented:
`chains/minotari_grpc.ts` reports `amountAuthoritative: false` unless a real
opening proves the value; `crosschain/coordinator.ts` computes
`amountExact = (amountRaw matches) && amountAuthoritative`, so the historic
"compare the intent against itself" bug cannot recur; `multihop/proof.ts` refuses
to build a settlement proof without authority. No path substitutes a quote, a
cached amount, or a provider assertion for chain evidence.

**1.6 Persisted state is a display cache, and the live path is validated.**
`services/history.ts` routes *every* read through `loadHistoryPayload`, which
bounds the payload, rejects forbidden fields on sight (preimage/seed/privateKey/
capabilities/network), and rebuilds each record from an allow-list. `lastReadback`
is deliberately not restored.


---

## 2. Where the architecture is weaker than it looks

**2.1 Client-side resolvers accepted a wider state space than the chain does.**
`quoteSwapOutput` accepted any fee in `1..=9999`; the on-chain template asserts
`fee_bps > 0 && fee_bps <= MAX_FEE_BPS` with `MAX_FEE_BPS = 1000`. A pool
reporting 5000 bps cannot exist, yet the client would happily quote it. The
client is now clamped to the chain's own range (`MAX_FEE_BPS`), so an impossible
readback is refused instead of priced. Severity MEDIUM: not exploitable while the
chain is correct, but it is exactly the class of "trust the readback" assumption
that breaks the day the readback is imperfect.

**2.2 The A/A refusal was documented but not implemented.** The comment in
`resolveSwap` claimed A/A was refused; the code only checked that the direction
matched one of the two legs, which an A/A pool satisfies. The chain's
`check_pool_resources` asserts `a != b`, so nothing could actually be stolen — but
the user would have been shown a quote and asked to sign a transaction that could
only abort. Now refused client-side with an explicit reason.

**2.3 Impossible pool states could throw out of an async resolver.** A pool with
one empty reserve made `resolveAddLiquidity` divide by zero *outside* any
`try/catch`, and a readback returning `reserve_a: "abc"` reached `BigInt()` in
three resolvers. `parsePoolState` now validates every numeric field at the
boundary, so a malformed authoritative read becomes a typed `UNAVAILABLE`
(`createOotleReadbackProvider` already converts a parse throw into that). The
resolvers also refuse half-initialised pools, zero LP supply with non-zero
reserves, and burning more LP than exists.

**2.4 The browser transport was the one place with no deadline.** Discovery was
the only browser→operator-host path and it used a bare `fetch`: no timeout, no
body cap, and a thrown error collapsed into the same value as a legitimate empty
result. Fixed in `services/net.ts`, which is now the only bounded-transport module
in the app — the right shape.

**2.5 Dead and misleading code.** `PoolHealthBadge` looked a pool up and discarded
it (`void pool`), reading as a resolved per-pool state that did not exist (now
removed). `MarketDataService.follow()` and `Bundle.stop()` are exported but called
from nowhere — and, more importantly, `AppContext` never supplies a
`TradeDiscoverySource`, so the indexer is never constructed and **no trade is
ever stored in the browser at all**. The protocol-client market-data subsystem
is complete and tested; the application has not connected it, and the UI does
not say so. These are honesty defects rather than security ones, and they are
recorded because "the code implies a capability it does not have" is how a
future reader gets hurt.

---

## 3. Duplicated logic and multiple truth sources

**3.1 Small string helpers are duplicated three times.** `pools.ts` has
`readString`/`readRaw`, `marketplace.ts` has `str`/`raw`, and `execution.ts` /
`lib/amountInput.ts` each re-implement the "non-negative integer string" check.
They agree today; they are not shared, so a future fix to one (rate limits,
length caps) will not reach the others. Maintenance debt rather than a live bug.
Extracting them would touch trust boundaries, so the duplication was left in place
deliberately — but recorded rather than quietly tolerated.

**3.2 Pool health is derived in two different ways.** `PoolsPage` re-derives a
`MarketDataHealth` object from the *presentation* fields of the aggregate health
(`{ status, source: label, reason: detail }`), which works only because the status
enum happens to be identical in both places; a field added to the health model
later would be silently dropped.

**3.3 Two deployment stories, one security policy.** The repository has a
Cloudflare Pages configuration (`wrangler.jsonc` + generated `dist/_headers`) *and*
a GitHub Pages workflow. GitHub Pages cannot serve the policy at all, and the
documentation previously asserted that it did — two truth sources about
deployment posture. The workflow is now gated so the weaker path cannot happen
silently, and the documentation states the difference in a table.

**3.4 Test discovery is enumerated, not globbed.** `packages/protocol-client`
lists every test file explicitly in its `test` script, so a new regression file is
dead code until the script is edited — which is what happened with the parity and
model suites added in this pass (the script was updated deliberately, and the
check is visible in the diff). A directory form of `node --test` would remove the
footgun.

---

## 4. Fail-open patterns

The architecture is fail-closed almost everywhere, which is the correct default
for a client that constructs financial transactions. The exceptions found:

- **Discovery errors were fail-silent** — fixed (`services/net.ts` + the
  `IndexerMarketplaceSource.failureReason`), and the global `OutageNotice` now
  states the condition instead of letting empty tables imply "zero pools".
- **`createWalletService` swallows a constructor failure** and reports
  `DISCONNECTED`-shaped state. That is fail-closed for execution (nothing can be
  signed without a bridge) and fail-open only for diagnosis: a malformed provider
  is indistinguishable from "no provider" in the UI. Acceptable, but it is why
  the wallet-state copy in the shell is worded as "no Tari wallet provider is
  injected" rather than as an error.
- **NFT metadata failure is cached as a permanent result.** `nftMetadata.ts`
  caches the *failure* alongside successes, so a transient metadata outage keeps
  showing the fallback until the cache is cleared. Fail-open in the harmless
  direction (a placeholder instead of media), but it will make a blip look
  permanent.
- **The market-data indexer is simply not constructed without a readback**
  (`MarketDataService` receives `readback: undefined` until a wallet connects).
  Chart data is therefore absent rather than unverified — fail-closed for
  correctness, fail-open for usefulness, and the correct trade.
- **An unrecognized authoritative status used to normalize to `ACTIVE`**
  (`ootle.ts` `normalizeStatus`), the most permissive value at the one boundary
  whose job is to refuse unvouchable state. Fixed in the fourth pass
  (matrix PC-66): an unknown status is now typed `UNAVAILABLE` with the reason,
  and no default fallback exists. The on-chain template was never reachable
  through this gap (it re-asserts its own status), but the signed transaction it
  would have produced could only abort — a defect of presentation, not of
  settlement, and closed rather than tolerated.


---

## 5. Unsafe casts, `any`, and nominal types

- **`any` does not appear in application code.** The browser services and
  resolvers are typed end to end, and the branded `DisplayOnly` is the mechanism
  that makes the display/execution split checkable. This is better than typical.
- **`as unknown as` is confined to React-adapter seams** (`MarketDataService`
  listener registration, `NftMarketplacePage`'s duck-typed `unavailableReason`).
  These are the only places where a type assertion crosses a trust boundary, and
  both are guarded at runtime immediately afterwards. They are the first place to
  look if the shape of `MarketplaceSource` ever changes.
- **The duck-typed `unavailableReason` on the marketplace page is the weakest
  link in the NFT read path**: `'unavailableReason' in source` is true for a
  class getter as well as for a plain property, and the page re-checks
  `typeof === 'string'`. It is correct today, but a named optional property on the
  `MarketplaceSource` interface would be strictly better and is the change I would
  make first if this area is ever revisited.
- **Runtime nominal identity is used for the settlement-proof brand**
  (`multihop/proof.ts`) and the `DisplayOnly` brand. Both are module-level
  `Symbol`s, so a duplicated module instance would produce a *different* symbol
  and a legitimate proof would be rejected rather than accepted. That is the
  correct failure direction (fail-closed on a packaging accident), and it is why
  `packaging.test.cjs` exists.

---

## 6. Scalability and complexity worth reducing

**6.1 The browser holds every pool it has ever visited.** `MarketDataService`
keeps a `bundles` map keyed by pool component with an `InMemoryMarketDataStore`
each, and never evicts. Per-bundle data is bounded (backfill limit, no live
follow), so this is not an unbounded leak today, but the eviction story does not
exist and would be needed before a long session across many pools, or before live
follow is wired. `Bundle.stop()` is the hook that was written for it and is
currently dead.

**6.2 Resolvers are linear and explicit, which is the right complexity budget.**
`resolveSwap` / `resolveAddLiquidity` / `resolveRemoveLiquidity` are long but
straight-line: read, validate identity, quote, derive, build. The length is the
validation, and collapsing it into a helper chain would make the "nothing
authoritative slipped through" property harder to read, not easier. No change
recommended.

**6.3 Cross-layer coordinator surface is large but justified.** `coordinator.ts`
carries the real-submit gate at three call sites, deadline rechecks, UNKNOWN
reconciliation and idempotency. The duplication of the gate across three
irreversible phases is intentional (a single choke point would be one place to
get wrong) and the tests assert it at each site.

**6.4 Routing is deliberately not a graph search.** There is no multi-hop path
enumeration, so there is no route-explosion DoS and no cycle detection to get
wrong. The multi-hop router composes a fixed `XTM → TARI → AMM` shape. Any future
generalisation must re-open the cycle/duplicate-asset/amount-mismatch analysis
from scratch — this is a deliberate boundary, not an oversight.

---

## 7. Unresolved external blockers

| Blocker | Effect on the architecture | Why it cannot be closed here |
| --- | --- | --- |
| **R-1** — security headers never observed on a live HTTPS origin | The authored CSP / `frame-ancestors` / COOP / nosniff / Referrer / Permissions policy is generated and browser-tested but unproven in delivery | No Cloudflare credentials in this environment |
| **R-2** — wallet connector injection mechanism | `frame-ancestors 'self' https://universe.tari.mw` is retained on repository evidence that the dApp runs cross-origin inside the wallet; a live fetch of the wallet shell showed no connector surface in the outer document | Needs upstream wallet source or a working in-wallet dApp session |
| **Ootle / Esmeralda unreachable** | No live pool, market, NFT, wallet, L2, LP or cross-layer integration can be exercised; the frontend is exercised only against mocks and the local header server | Both known indexer hostnames fail DNS |
| **Engine suite on Windows** | The on-chain template behaviour is verified by model and by the TypeScript mirror, not by running the engine locally | `wasmer-compiler-cranelift` refuses to compile on Windows; Linux CI owns it |
| **Firefox locally** | Cross-engine browser coverage is CI-only | Software WebRender OOM |
| **Browser SHA leg upstream** | The `XTM → TARI` leg cannot run for a normal user; the UI shows a blocker rather than a button | `tari_l1_wasm` exposes no SHA swap operation |

---

## 8. What I would change next, in order

1. Move pool health from a presentation-reconstruction to the real object, and
   give `MarketplaceSource` a declared optional `unavailableReason`.
2. Bound the number of live market-data bundles per session, and either wire
   `follow()`/`stop()` or delete them.
3. Share one strict-string helper module across discovery, execution and the
   amount parser, with a single test for the canonical shapes.
4. Switch protocol-client test discovery to a directory form so a new file cannot
   be silently inert.
5. Reconcile the cancel-authority model across the three NFT templates: all gate
   `cancel` on the *signing public key* captured at creation
   (`rule!(public_key(buyer_signer))`, `OwnerRule::None`), which means a key
   rotation strands the cancel path and an `expires_at_epoch == 0` bid has no
   other exit. Not a fund-loss path (the funds stay escrowed in the component and
   the buyer keeps them), and not changed here because the fix is a wallet-side
   authority decision rather than a client bug.

---

## 9. Fourth-pass addendum (irreversible-act bookkeeping, and LP sequences)

Two further findings from continuing the review past the second and third
passes; both are fixed with retained regressions and classified in the attack
matrix (PC-63, PC-64, PC-65).

- **A submission may never be followed by an unrecordable transition.**
  `claimL1` accepted sessions in `RECOVERY_REQUIRED`, where the state machine has
  no `CLAIM_ACKNOWLEDGED` edge: an L1 claim submitted there succeeded on the port
  and then threw, so the durable record lost the claim id and a retry had no
  idempotency key. Recovery must now be explicitly resolved into `CLAIMING`
  first, and a `CLAIMED` session without a recorded claim id reconciles instead
  of submitting. No fund loss was possible (the claim credits the accept-time
  recipient and the chain refuses a duplicate spend), but the failure class —
  "irreversible act, then a bookkeeping throw that erases the evidence" — is
  exactly the one this architecture exists to prevent, which is why it is fixed
  rather than merely recorded.

- **A policy mode that enforces nothing must refuse to build.**
  `AmmSwapPolicy`'s `ABORT_AND_PAUSE` compared the settled amount against the
  settlement proof it came from — always equal — so the mode silently protected
  nothing. It now compares against an explicit `expectedIntermediateRaw`
  (the route quote's hop-2 input) and refuses the build when the mode is
  selected without an expectation. The general lesson for this codebase: a
  fail-open branch behind a safety-sounding name is worse than no branch, because
  it survives review by looking like the control it replaced.

- **LP conservation is now asserted across sequences, not just round trips.**
  `amm_model.test.cjs` adds an independent multi-step model (swap/add/remove
  interleaved with fee accrual, 200 × 12 steps, exact BigInt floor arithmetic)
  asserting k-monotonicity per swap, proportional bounds per add/remove by
  cross-multiplication, and non-empty reserves. Per-share backing monotonicity
  was deliberately NOT asserted across swaps: value legitimately leaves the pool
  to traders, so the exact statement is the per-operation proportional bound plus
  k-monotonicity, not a global per-share inequality.

---

## 10. Fifth-pass addendum: what the CI run taught that local green could not

Pushing the branch and watching CI for the first time in a day surfaced four
facts that local verification could not, which is the strongest argument in this
repository for treating CI as the arbiter rather than a formality:

1. **Two test files carried the same structural corruption** — a test callback
   opened and never closed, nesting every following test inside an unawaited
   synchronous parent. Node 24 (the local runner) waits for outstanding subtests,
   so both suites were locally green; Node 20 (CI) cancelled them. Fixed in
   `amm_parity.test.cjs` and `hostile-frontend.test.cjs` (matrix PC-67).
2. **The per-job CI split dropped an implicit build ordering** — the previous
   single sequential job built `protocol-client`'s dist as a side effect of
   running first; standalone jobs typecheck against a fresh checkout, where
   `dist/` does not exist. Each job now builds its workspace dependencies
   explicitly, and the web job builds the production bundle before its node
   suites, several of which assert the shipped artifacts.
3. **The frontend overflowed under CI's wider font metrics** — an uncapped grid
   track, `nowrap` metric values, and unbreakable tokens in notices/hints pushed
   the pool page 11px past a 390px viewport and the pools page 17px past 360px.
   Fixed with `minmax(0, 1fr)` tracks, wrappable metric values, and
   `overflow-wrap: anywhere` on notice/hint/mono text, with a regression that
   forces the wide-font condition on any machine (matrix PC-67 residual).
4. **The frame-ancestors refusal signal is Chromium-shaped** — Firefox refuses
   the frame before any document commits and does not surface the CSP violation
   on the top page's console, so the clickjacking test reported a bypass while
   the control worked. The assertion now accepts either the console violation or
   an attacker-visible never-committed frame; a genuine embed satisfies neither
   (matrix PC-68).
