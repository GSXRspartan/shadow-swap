# Shadow Swap — v0.46 browser trading and NFT marketplace UX

**Scope.** The browser path from a connected Tari wallet to a signed, submitted, and
reconciled transaction, for the live AMM pool and for all three NFT marketplace
templates. This document records what was built, what is actually verified, and —
section by section — what is not.

**Product name.** This repository was renamed to **Shadow Swap**. That is a product
rename only. Every on-chain identity, template address, resource address, contract
method, and serialized state layout is unchanged. See
[§11](#11-rebrand-scope-and-what-was-deliberately-not-renamed).

---

## 1. Starting Git checkpoint

| | |
|---|---|
| Branch at session start | `feat/v046-liquidity-continuation` |
| Starting SHA | `a071167` — *fix(engine): an NFT vault's balance() is its token count* |
| Prior session's reported commit | `4090031` (**not** HEAD; four commits later) |
| Uncommitted work at start | `docs/OOTLE_V046_MIGRATION.md` and the four WASM shape-cap dry-run ledger entries — **preserved and committed**, not discarded |
| Working branch | `feat/v046-browser-marketplace-ux` |
| Branched from | the verified v0.46 HEAD, so the follow-on work carries the escrow-decoder fix with it |

The previously reported `4090031` was *not* the HEAD. `4090031 → 48099fc → ffbc1f7 →
a071167` were all already committed and pushed.

### Commits made this session

| SHA | Subject |
|---|---|
| `9f1491a` | `docs(v046):` settle the WASM shape-cap risk with a non-mutating publish dry-run |
| `b8d1f4d` | `fix(exec):` an approval the user has not answered is not a failed transaction |
| `8621fa4` | `feat(market):` make every marketplace operation reachable from the browser |
| *(this commit)* | `feat(web):` LP position display, and rebrand the product to Shadow Swap |
| `docs(v046):` browser trading and marketplace UX (this document) |

---

## 2. v0.46 delivery and PR status

**PR #5** — <https://github.com/GSXRspartan/shadow-swap/pull/5> —
`feat/v046-liquidity-continuation` → `main`.

| Check | Result at delivery |
|---|---|
| Node Tests | green |
| Security Engine Tests (Linux, v0.46 engine suite) | green |
| WASM builds (4 templates) | green |

The three earlier `Security Engine Tests` failures on the branch were **not** left
open — they were found already fixed by `ffbc1f7` (the v0.46 vault API mismatch in
`escrow_holding`) and `a071167` (an NFT vault's `balance()` is its token count), and
the final run at `a071167` was green.

**Not merged.** The PR is open and unmerged by instruction. See
[§10](#10-branch-dependency-and-merge-order).

### WASM shape-cap dry-run — non-mutation proof

The v0.46 shape caps were carried as an open MEDIUM risk and are now settled. All four
templates were dry-run published against the live 0.46.0 daemon and every one was
accepted:

| Template | bytes | dry-run fee (microTARI) |
|---|---|---|
| `fungible_pool` | 244 029 | 1 438 537 |
| `nft_marketplace` | 196 806 | 1 089 304 |
| `nft_item_offer` | 201 715 | 1 114 144 |
| `nft_collection_bid` | 201 096 | 1 113 276 |

Non-mutation was **proven from the v0.46.0 source** (`cc8a83bc`), not assumed:
`handle_publish_template` routes `req.dry_run` into `submit_dry_run_inner`, which
never finalises and never links locks; `submit_dry_run_transaction` terminates at
`network_interface.submit_dry_run_transaction` and never reaches network submission,
so a template cannot be registered without a real publish transaction finalising
on-chain. `enforce_max_fee_limit` is skipped for dry runs, so the ceiling could not
have been raised into a refusal either. The ledger records exactly four
`phase: dry_run` entries and no `submitting`/`final` for any of them.

These are also the first concrete v0.46 publish prices: **~1.1–1.4 tTARI per
publication**.

---

## 3. Provider contract and capabilities

Every wallet interaction goes through `src/services/tariWindow.ts`. **No React
component may touch `window.tari`** — this is enforced by the conformance suite and
by the e2e suite.

| Method | Used for | Reference handling |
|---|---|---|
| `tari_getCapabilities` | Mandatory handshake; the **only** feature-selection mechanism | `mapCapabilities` accepts only the 16 published boolean keys and returns `undefined` if it recognises none — fail-closed, never a default-`false` |
| `tari_getNetwork` | Network pre-check before connect; live re-read | Typed `string` per the contract; answerable without a connection |
| `tari_requestAccounts` | Explicit connect | Prompts |
| `tari_getAccounts` | Re-reads | Never prompts; `[]` when disconnected |
| `tari_getBalances` | Display balances and LP positions | |
| `tari_getSubstate` | **Every** authoritative pool and marketplace read | |
| `tari_createTransactionRequest` | Durable approval request | |
| `tari_getTransactionRequest` | Poll approval state; resume after reload | |
| `tari_submitTransactionRequest` | Submit the exact approved request, **by id** | |

### Capability-driven, never brand-driven

The flow that is used is selected by `capabilities.transactionRequests`. There is no
wallet-brand test anywhere on the execution path. The published rule is explicit:
*"Never branch on which wallet is present. Call `tari_getCapabilities` and branch on
the answer."*

- `transactionRequests === true` → durable create → approve → submit trio.
- otherwise → one-shot `tari_signAndSubmit`, still handed the **exact reviewed
  instructions**. Everything works; it loses reload survival.

### Provider lifecycle

`classifyProviderTransition` distinguishes the three states the official integration
model actually produces:

| Transition | Meaning | Treatment |
|---|---|---|
| `INITIALISED` | a provider appeared after the app module ran | benign — the connector is documented as safe to include unconditionally |
| `UNCHANGED` | same object | proceed |
| `REPLACED` / `REMOVED` | a **different** object, or none | abort with `ACCOUNT_CHANGED`; never authorize |

`probeAvailability` uses `tari_getNetwork`, **not** `Boolean(window.tari)`. The
connector publishes a provider object on a page it cannot serve, so presence is
necessary but not sufficient.

---

## 4. Pool quote and state implementation

### Authoritative multi-substate decode

The pool state is read with the hardened decoder in
`packages/protocol-client/src/poolSubstate.ts`, which requires five reads and fails
closed on each:

1. the pool component substate (absent ⇒ refuse);
2. `header.template_address` (absent or mismatched ⇒ refuse);
3. the component state array (must be length ≥ 4, `pools` must be a CBOR map with
   **exactly two** entries);
4. the declared pair, compared against the caller's `expect`;
5. the four dependent substates, plus an **intrinsic** identity check — each vault's
   `resource_container` must carry an address matching the resource it is declared to
   hold.

**No legacy flat-field downgrade after a raw decode error.** If `readRaw` is present
and the decode fails, the result is `UNAVAILABLE`, not a fallback parse. The legacy
path exists only for test doubles that cannot produce raw substates.

### Template identity, pinned three ways

| Layer | Mechanism |
|---|---|
| Discovery | the indexer's `name_filter` result is **exact-matched** against the protocol's template names |
| Registry | a protocol-verified seed pins Pool v2's component to its template |
| Reread | the wallet's own component header must name that template |

The seed **wins** over an indexer-reported template. An indexer claim is discovery
evidence and must never become the identity a read is pinned to.

### Live Pool v2

| | |
|---|---|
| Template | `f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab` (ownerless) |
| Component | `component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2` |
| Fee | 30 bps |
| LP resource | `resource_8c69acbc731c626fdd37557653ab1133b548fee654e14bbbfc747f1bcf7a3281` |

Displayed: pair, resource addresses and symbols, both reserves, 30 bps fee, LP total
supply, permanently locked LP, connected-wallet balances, connected-wallet LP
position, pool share, price derived from the authoritative reserves, available
liquidity, network, and read freshness.

### Integer-only arithmetic

Every amount is a raw integer string end to end. `asRawExecutionAmount` refuses a
decimal point, an exponent, whitespace, or anything that is not a non-negative
integer string, so a float can never enter a signed transaction. The LP percentage
selector multiplies with `BigInt` and **floors** — rounding up could ask a user to
burn LP they do not hold.

### LP position (added this session)

`PoolDescriptor` now carries `lpResource`, read from the pool component itself rather
than inferred from the pair — a position measured against the wrong resource is
meaningless. `LiquidityPanel` shows the balance and makes 25/50/100% compute an exact
floored `BigInt` figure. Previously the percentage buttons set a "LP balance
unavailable" notice and did nothing.

`undefined` and `'0'` are rendered differently on purpose: "this pool reports no LP
resource" and "you hold none" have different consequences for the remove flow.

---

## 5. Marketplace discovery and action wiring

### Discovery

| Surface | Source |
|---|---|
| Collections, items, listings, offers, bids, recent sales | indexer queries via a **rate-limit-aware** transport |
| Listing / offer / bid **status before an action** | the component, reread through the wallet provider, pinned to the published template |

Status is distinguished as `ACTIVE` / `SOLD` / `ACCEPTED` / `FILLED` / `CANCELLED` /
`EXPIRED` / `UNKNOWN`. `parseStatus` refuses any unrecognised status — it is never
normalised toward `ACTIVE`. A settled order is never presented as owned by a live
listing.

Dual-form `NonFungibleId` decoding is preserved throughout (the v0.46 named-variant
form and the older positional-tuple form both decode, and both produce identical
results — asserted by test).

### Published templates

| Template | Address |
|---|---|
| FixedPriceListing | `template_612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329` |
| ItemOffer | `template_083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6` |
| CollectionBid | `template_999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54` |

### All nine controls, and how each is driven

| Control | Mechanism | Rereads the component? |
|---|---|---|
| Buy listing | `resolveBuyNow` | yes |
| Fill collection bid | `resolveSellNow` | yes |
| Accept item offer | `resolveAcceptItemOffer` | yes |
| Create listing | `createListing` + shared action service | **no — nothing exists yet** |
| Cancel listing | `cancelListing` + shared action service | no |
| Make item offer | `createItemOffer` + shared action service | no |
| Cancel / refund item offer | `cancelItemOffer` / `refundExpiredItemOffer` | no |
| Create collection bid | `createCollectionBid` + shared action service | no |
| Cancel / refund collection bid | `cancelCollectionBid` / `refundExpiredCollectionBid` | no |

The first three use the protocol-client's authoritative resolvers and are refused if
the component has moved. The other six go through `services/marketplaceActions.ts`,
which owns template pinning, intent construction, review construction, and human
summaries. **No page component holds marketplace business logic.**

### Why the creates are pinned by constant, not by parameter

A create has no component address until its receipt lands. There is therefore
**nothing to reread before signing**, and the template address is the *entire*
pre-submission identity check. A caller-supplied template address would be a hole
exactly where the user has no other way to see what they approved. The three
addresses are compiled-in constants; a test asserts an extra caller-supplied
`templateAddress` field is ignored.

---

## 6. The three defects that blocked the marketplace

These were found by the new test suite, not by inspection. Each one made a wired
button fail at the last gate before signing.

### 6.1 `call_function` could not be serialised at all

`buildSignableInstructions` handled `withdraw_fungible`, `withdraw_non_fungible`,
`call_method`, and `deposit_all`, and **threw on anything else**. All three CREATE
operations emit `call_function`. They were unreachable by construction, not by
omission — which is why the create buttons had simply been left disabled.

Added as its own case emitting `{ CallFunction: { address, function, args } }`, plus
a canonical `template_<64 hex>` validator. It is deliberately **not** folded into the
`call_method` case: doing so would silently emit a `CallMethod` aimed at a template
address.

> **Verification gap.** The instruction is documented in the Ootle transaction
> reference and the field names come from `tari_ootle_transaction::Instruction`. The
> `CallMethod` spelling **is** verified against the published provider contract; this
> one is not. A wallet that does not recognise the shape rejects the request, which
> fails closed. Recorded as an open gap rather than presented as proven.

### 6.2 The review differential would have refused every create

Three separate assumptions that a create is a component call:

| Site | Assumed | Actual for a create |
|---|---|---|
| `legMentionsComponent` | inspected `CallMethod` only | a create emits `CallFunction` |
| target comparison | `leg.componentAddress === target.componentOrOrderId` | that field is `undefined` |
| review `method` | `intent.operation` (`create_listing`) | the contract method is `create` |

All three fixed. The create case is now **required** to name the template its own
`call_function` targets — checked, not skipped, because that is the field a
substituted template would attack and no reread catches it later.

### 6.3 A cancel or refund produced a blank review

A cancel moves nothing by withdrawal — the template returns the escrow — so the
amount walk found nothing, and `createReview` refuses a review with no amounts
(correctly: a signer must be told what is being spent).

Resolved with an explicit **`REFUND`** review role:

- the escrow figure is **required** on the action, so it always comes from an
  authoritative reread and is never invented;
- it is shown to the user in the review and the summary;
- it is excluded from the instruction carry check, because it genuinely is **not** a
  transaction argument;
- it is never read as an economic term. `FEE` was already excluded for exactly the
  same reason.

No existing guard is weakened. The test asserts the figure is present, is flagged
`REFUND`, and is **not** presented as a value-moving amount.

---

## 7. Durable request lifecycle

This was the single most serious finding of the session.

### The defect

A session-gated approval degraded into a false failure with a financial consequence:

1. `submitExact` minted a durable wallet request, polled it, got `PENDING`, and
   threw a bare `TariProviderError(…, 'UNKNOWN')`.
2. That reached `executeResolved`'s Layer-2 catch, which stamps the durable record
   **`FAILED`**.
3. But the wallet request **still existed** and could be approved at any later moment.
4. The user is shown a red state for something that is still live. The natural next
   action is to press the button again.
5. That mints a **second** durable request for the same intent. Approving both popups
   executes the trade **twice**.

Nothing detects this afterwards.

### The fix, in three parts

**1. Awaiting approval is a typed state, not an error.** `awaitingApproval()` brands
the throw via `Symbol.for('tari.ootle.awaitingWalletApproval')`; `executeResolved`
records `PENDING` instead of `FAILED`. The brand is non-enumerable, and it is honoured
only on the marker — never on message text, so an unrelated failure cannot be
silently reclassified as recoverable. A genuine sign failure still records `FAILED`.

**2. `requireFreshSubmissionAllowed` refuses a `PENDING` record carrying the marker.**
Plain `PENDING` without a marker stays permitted, so an operation that never reached a
signer is not stranded with no way to try again.

**3. `executeSwap` refuses to mint a new request while one is unresolved**
(`PendingApprovalError`), for the same account and network. Same-operation idempotent
retry is explicitly not self-blocked.

### The recovery store

`src/lib/pendingRequests.ts`, key `ootle.pendingRequests.v1`.

**Persisted:** operation id, wallet request id, review fingerprint, operation label,
account, network, destination, created-at, state.

**Deliberately NOT persisted:** instructions, amounts, nonce, signature, capabilities.
Submission is by `requestId` alone, so recovering needs the id and **nothing else**.
There is nothing in that key that could be replayed even if it were fully
attacker-readable — which is what makes writing it to `localStorage` defensible at
all.

### The anti-substitution binding

Each entry carries a **fingerprint of the review that was approved**. On resume, the
live review is re-fingerprinted and compared; a mismatch refuses. Without it a
persisted id would be a bare pointer that a tampered ledger could aim at a
transaction the user never saw.

`resumeBlockReason` compares the **persisted** account / network / fingerprint against
the **live** session, and every branch is a refusal. The asymmetry is the whole
design:

> Forged local state can **deny** a user their money moving. It can never **allow**
> it. Flipping `approvedNetwork` in `localStorage` can only make the resume return
> `NETWORK_CHANGED`; it cannot authorise one.

| Refusal | Condition |
|---|---|
| `ACCOUNT_CHANGED` | persisted account ≠ live account |
| `NETWORK_CHANGED` | persisted network ≠ live network |
| `REVIEW_SUBSTITUTED` | persisted fingerprint ≠ live fingerprint |
| `NO_LIVE_REVIEW` | no review on screen to authorise against |
| `NOT_BLOCKING` | already settled |

### Resume is by the wallet's answer, never the ledger's

`resumeTransactionRequest` polls `tari_getTransactionRequest` and acts on **that**:

| Wallet status | Behaviour |
|---|---|
| `pending` | returned as a **value**, not thrown — nothing broadcast, entry stays for later |
| `approved` | submitted **exactly once**, by id |
| `submitted` | recognised, **not re-broadcast**; the stored transaction id is used |
| `rejected` | terminal, entry forgotten |
| `failed` | terminal, entry forgotten |
| anything else | **fails closed without submitting** |
| `submitted` with no transaction id | fails closed |

`submitTransactionRequest` takes `{ requestId }` and **no payload**. There is
therefore no code path on which an approved transaction is re-derived, mutated, or
replaced between approval and broadcast.

### Ordering guarantee

The request id is persisted in `onRequestId` — **before** the approval is polled, and
before any await a reload could interrupt. That ordering is the recovery guarantee.
The test asserts the exact call order:
`create → persist → getTransactionRequest`.

### UI

`ActivityPage` gains a **Wallet approvals** panel. It asks the wallet what happened
and renders the wallet's answer. There is deliberately **no "submit anyway"**
control. A blocking banner appears while any approval is open, explaining that
starting another transaction would create a second request for the same intent.

### Error presentation

`AWAITING_WALLET_APPROVAL` and `APPROVAL_SUBSTITUTED` were added to the error
normaliser, matched **before** the rejection patterns. Without that ordering,
"awaiting wallet approval" matches several rejection patterns and tells the user
their pending, un-submitted request failed — which is precisely the confusion that
leads them to press the button a second time.

### A second bug, found by the new suite

`validatePendingRequest` initially required `createdAtUnixMs` to be a decimal
**string**, while `walletService` mints records with a **number** from `Date.now()`.
So `rememberPendingRequest` rejected the app's own freshly-minted records and wrote
nothing — **the recovery store would have persisted nothing at all**, silently, with
no error anywhere. A validator now accepts both forms, which is correctness rather
than leniency: a record is built in memory and read back from storage, and a
validator that accepted only one form would reject half the lifecycle.

---

## 8. UI security boundaries

| Boundary | Enforcement |
|---|---|
| `window.tari` | only `services/tariWindow.ts`. Asserted by the conformance suite and e2e |
| Economics | only the protocol-client. No component computes AMM or marketplace math |
| Display vs execution | `asDisplayOnly` / `asRawExecutionAmount` / `asResourceAddress` type fence |
| Before signing | no-concurrent-approval → identity re-read → review differential → frozen-review assertions |
| Before resuming | account, network, and fingerprint bindings, all refusals |
| After submission | reconcile by durable identifier. `UNKNOWN` is never success, never a retry |
| Persisted state | allowlist rebuild; a forbidden field **rejects the whole record**; a corrupt payload yields **zero** records, never a best-effort subset |

### Nothing sensitive is stored or logged

Three `localStorage` keys, and the test asserts the inventory is exactly those:

| Key | Class | Holds secrets? |
|---|---|---|
| `ootle.operations.v1` | operation history, display cache | no |
| `ootle.pendingRequests.v1` | durable request ids | no |
| `__ootle_probe__` | availability probe, removed | no |

A fresh production build was secret-scanned. The only matches for
`preimage` / `mnemonic` / `seedPhrase` / `privateKey` are the
`FORBIDDEN_PENDING_FIELDS` **deny-list** — the detector, not a leak, the same class
as the pre-existing `storage.ts` deny-list. No bearer tokens, JWTs, private keys, or
signing secrets appear in the bundle, in storage, or in any log.

---

## 9. Evidence: live versus mocked

Stated precisely, because the distinction is the whole value of this section.

| Class | What it covers here |
|---|---|
| **LIVE WALLETD VERIFIED** | All v0.46 on-chain evidence: the Pool v2 swap, the three marketplace settlements, the four shape-cap dry-runs. Submitted through `walletd` via the CLI executor. |
| **LIVE CHAIN READ VERIFIED** | Pool and marketplace substates read from the live Esmeralda chain. |
| **REFERENCE PROVIDER VERIFIED** | The entire browser approval lifecycle, including durable resume. Driven by a deterministic provider double with exact published reply shapes. |
| **UNIT VERIFIED** | Decoders, review differentials, identity binding, storage tampering, and the duplicate-submission guards. |
| **E2E VERIFIED** | Chromium, Firefox, and mobile viewports against the reference provider and a mock indexer. |
| **BLOCKED** | Real `window.tari` approval by a human. |
| **NOT VERIFIED** | The `CallFunction` wire spelling against a deployed provider. |

### What is *not* claimed

- **No browser-provider end-to-end verification exists.** Every live transaction in
  the evidence above went through `walletd`. The browser path has never been driven
  by a real wallet.
- **The CLI executor was never used to impersonate browser approval.** The executor
  and the browser are separate evidence classes, and they are not merged.
- **No additional live economic transaction was initiated this session.** The prior
  AMM and NFT lifecycles were already verified; repeating them to generate activity
  would add nothing.
- **No mock result is presented as a live one anywhere in this document or the UI.**

Mainnet, real L1 burn, and real cross-chain submission were not touched.

---

## 10. Tests

| Suite | Count | Result |
|---|---|---|
| Web unit (`node:test`) | **404** (346 baseline + 58 new) | all green |
| Protocol client | **258** | all green |
| Wallet adapter | **21** | all green |
| Playwright e2e | **73** (15 hosting + 33 security + 25 wallet conformance) | green in CI |
| Web typecheck | — | clean |
| Web production build | — | clean |
| Production-bundle secret scan | — | only deny-list detectors |

New suites this session:

| Suite | Tests | Covers |
|---|---|---|
| `test/wallet-approval.test.cjs` | 37 | awaiting-approval vs failure, the resubmission guard, the concurrent-approval gate, ledger round-trip and reload survival, tamper rejection, all five resume refusals, forged-state-can-only-deny, the provider-level resume primitive including submit-once and already-submitted |
| `test/marketplace-actions.test.cjs` | 21 | template pinning, smuggled-template rejection, `call_function` serialisation, review/sign differential for all eight actions, frozen reviews, account and amount drift, identity normalisation, record-kind distinctness, summaries |

---

## 11. Rebrand scope and what was deliberately not renamed

Renamed to **Shadow Swap**: page title, meta description, Open Graph and Twitter card,
PWA manifest, icon and a new maskable icon, header wordmark and its `aria-label`, the
shipped `_headers` / `_redirects` comments, `.env.example`, the root and workspace
`package.json` descriptions, the extension and mobile scaffolds, and the README
(written from scratch — overview, features by evidence class, architecture, security,
getting started, deployment, project status).

### Deliberately unchanged

| Thing | Why |
|---|---|
| Published template addresses | On-chain deployment identities. Republishing because the product name changed would orphan every existing listing, offer, and bid. |
| LP and NFT resource addresses | Chain state. |
| Contract method names, ABIs, state layouts | Wire compatibility. |
| **Workspace package names** (`@tari-ootle/*`) | ~50 import sites, 14 CI lines, the test harness, the packaging tests, and `pnpm-lock.yaml`. They also remain accurate — they describe the chain they target. |
| **`localStorage` keys** | Silent renaming loses a user's history and in-flight approvals. |
| **Cloudflare Pages project** `ootle-liquidity-testnet` | Renaming requires a coordinated Cloudflare-side change. An existing working deployment should not be taken down for branding, so the hosting project name is left as-is and the rename is called out here rather than silently half-done. |
| Upstream chain identifiers | `Ootle`, `ootle-indexer-*.tari.com`, `tari_ootle_transaction`, `otl_1…` addresses, `Network::Esmeralda`, `tari-project/tari-ootle.git` rev `cc8a83bc` |
| ~40 evidence / audit / migration documents | Historical records. Rewriting them would falsify the record. |

### Shadow Swap vs the Atomic Swap application

Related branding, separate products. Atomic Swap is an asset-creation and
direct-exchange application; Shadow Swap is the liquidity venue. **There is no
technical integration between them in this repository** — no shared contract, no
shared state, no shared call path. The relationship is stated in the README as:

> Create or acquire Tari assets through supported wallets and applications, then
> trade compatible assets or provide liquidity through Shadow Swap.

No files were copied from the Atomic Swap project, and no artwork was invented: the
mark, the maskable icon, and the social card are all committed SVG drawn from the
existing brand-neutral geometry.

---

## 12. Branch dependency and merge order

```
feat/v046-liquidity-continuation  (9f1491a) ──► PR #5 ──► main
                                            │
feat/v046-browser-marketplace-ux    (…) ────┘   branched from 9f1491a
```

**PR #5 must merge first.** `feat/v046-browser-marketplace-ux` is branched from its
verified HEAD and depends on:

- the v0.46 escrow `NonFungibleId` decoder fix, without which every settled
  marketplace component reads as malformed;
- the v0.46 vault API fixes (`ffbc1f7`, `a071167`).

Merging the follow-on first would land the frontend on a `main` that lacks them.

---

## 13. Remaining blockers

| # | Blocker | Severity | What is needed |
|---|---|---|---|
| 1 | **No live browser-wallet approval has ever been driven.** The entire durable approval and resume path is reference-provider verified only. | HIGH | A human approving a real `tari_createTransactionRequest`, then reloading mid-approval and resuming. Tiny testnet amount, strict fee ceiling, submit-once reconciliation. |
| 2 | **`CallFunction` wire spelling is unverified against a deployed provider.** All three marketplace creates depend on it. | MEDIUM | One live create against a real wallet. A rejected shape fails closed, so this cannot mis-execute — but the feature is unproven. |
| 3 | No `LICENSE` file is committed although MIT is declared. | LOW | A `LICENSE` file. Called out in the README rather than papered over. |
| 4 | Cloudflare Pages project still named `ootle-liquidity-testnet`. | LOW | A coordinated rename, only when a replacement is configured and verified. |
| 5 | Cross-layer XTM → TARI routing is not live. | MEDIUM | The browser SHA provider gap; tracked in `docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md`. |
| 6 | Stealth / Confidential assets are unsupported in the public AMM. | BY DESIGN | A separate privacy-preserving lane. |
| 7 | No mainnet deployment. | BY DESIGN | Mainnet is rejected by the network guard in every layer. |

### What would most improve confidence next

Blocker 1, and nothing else. Every other open item is either cosmetic, by design, or
already fails closed. The single thing standing between this being "a working
browser trading venue" and "a working browser trading venue that has been used once"
is one real wallet approval.