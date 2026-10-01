# TARI WALLET INTEGRATION CONFORMANCE

**Date:** 2026-09-29
**Branch:** `feat/live-testnet-productization`
**Scope:** the browser wallet integration, audited against the PUBLISHED Tari dApp
integration contract rather than against a reverse-engineered copy of one
wallet's bridge script.

This document records what the official sources say, what this repository did
before, what it does now, and the discrepancies that remain. It supersedes the
provider-shape claims in `docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md` and
`docs/LIVE_TESTNET_EVIDENCE.md` wherever the two disagree.

---

## 1. Sources of truth

Fetched and read directly on 2026-09-29:

| Source | What it is |
|---|---|
| `https://universe.tari.mw/integration/llms.txt` | Short reference |
| `https://universe.tari.mw/integration/llms-full.txt` | Full reference (identical content to `SKILL.md`) |
| `https://universe.tari.mw/integration/SKILL.md` | Agent skill file |
| `https://universe.tari.mw/integration/tari-dapp.d.ts` | **The contract.** Type authority for every request and reply |
| `https://universe.tari.mw/tari-connector.js` | The Tari Universe bridge script. Evidence, not authority |

`llms-full.txt` and `SKILL.md` are byte-identical in content; there is no
disagreement between them.

### The governing rules, quoted

> One interface, `window.tari`, implemented by the Sapient browser extension and
> by the Tari Universe web wallet. **A dApp never detects which wallet it has** —
> it calls methods and feature-detects.

> **Never branch on which wallet is present. Call `tari_getCapabilities` and branch
> on the answer.**

> `window.tari.isEmbedded` — *Only on the embedded (iframe) provider: true when
> running inside a wallet.*  (declared `isEmbedded?: boolean`, i.e. OPTIONAL)

> Include it always. It is what makes the wallet reachable when your dApp is
> embedded in Tari Universe, and it stands aside when an extension already owns
> `window.tari` in an ordinary tab.

> `tari_getWalletAddress` — the connected account's **bech32m wallet address**
> (`otl_…`) — what you address a private/stealth output to. **Not the same value
> as, nor derivable from, the component address.**

> `tari_getNetwork` — network name. **Answerable without a connection.**

> **Wallet addresses are not component addresses.** Users hold `otl_esm_1…`;
> instruction arguments need `component_…`. Passing an `otl_…` where a
> `SubstateId` belongs fails deep in deserialization … naming neither the field
> nor the reason.

> **Amounts are raw integer units; divide by `10 ** divisibility` for display.**

> `dryRun: true` never prompts — use it for quotes and previews.

> 4001 user rejected · 4100 not connected · 4200 unsupported · -32603 internal.

> `tari_getSubstate` — `{ substateId, version? }`

> `tari_signAndSubmitTransaction` — `{ instructions, maxFee?, inputs?, dryRun? }`

> Prefer `tari_createTransactionRequest` over `tari_signAndSubmitTransaction` for
> anything new: the single-call method loses its result forever if the page
> reloads while the approval popup is open.

---

## 2. The confirmed defect, and its fix

**A previous pass added a rule that refuses any provider reporting
`isEmbedded === false`, before any call is made.** The reasoning was that the
Tari Universe connector rejects immediately outside a wallet frame.

That rule is wrong under the published contract, and it is now removed.

`window.tari` is implemented by **both** wallets. The published type marks
`isEmbedded` **optional** and documents it as present *only* on the embedded
provider — so the Sapient extension does not publish it at all, and any rule
keyed on it refuses a valid extension. The reference is explicit that a dApp
"never detects which wallet it has".

Both provider FORMS are now accepted, and nothing in the product may branch on
them. The regression tests for this describe the two forms by BEHAVIOUR (which
methods they answer, whether they publish the optional field) and never by name.

---

## 3. Audit 1 — exact RPC argument types

Every method this app calls, against `tari-dapp.d.ts`. "Our previous request" is
what the reverse-engineered adapter sent.

| Method | Our previous request | Official request | Our previous reply parse | Official reply | Status |
|---|---|---|---|---|---|
| `tari_requestAccounts` | none | none | array of `{componentAddress}` | **`string[]`** | **FIXED** |
| `tari_getAccounts` | none | none | array of `{componentAddress}` | **`string[]`** | **FIXED** |
| `tari_getNetwork` | none | none | `{network, epoch}` record | **`string`** | **FIXED** |
| `tari_getWalletAddress` | in allow-list, never called | none | — | `string` | **MATCH** (now called) |
| `tari_getBalances` | none | none | `{resourceAddress, amount, resourceType}` | **`kind` / `divisibility` / `confidentialAmount`** | **FIXED** |
| `tari_getCapabilities` | none | none | invented `l1*`/`l2*` flags | **16 documented keys** | **FIXED** |
| `tari_getSubstate` | **`{substateId, address}`** | **`{substateId, version?}`** | tolerant | `unknown` | **FIXED** |
| `tari_getTransactionResult` | `{transactionId}` | `{transactionId}` | required `status` | `unknown` | request MATCH, reply relaxed |
| `tari_signAndSubmitTransaction` | **`{transaction, display}`** | **`{instructions, maxFee?, inputs?, dryRun?}`** | `{transactionId}` | `unknown` | **FIXED** |
| `tari_createTransactionRequest` | allow-listed, never called | `{kind, instructions, maxFee?, inputs?}` | — | `{requestId}` | **now USED** |
| `tari_getTransactionRequest` | allow-listed, never called | `{requestId}` | — | summary | **now USED** |
| `tari_submitTransactionRequest` | allow-listed, never called | `{requestId}` | — | `unknown` | **now USED** |
| `tari_disconnect` | none | none | **null treated as "no reply"** | **`Promise<null>`** | **FIXED** |

Six of these were not merely wrong but *fatal against a conforming provider*:
`requestAccounts` and `getNetwork` would have rejected every conforming reply,
`getBalances` would have read a key the contract does not define, and
`signAndSubmitTransaction` was sending a parameter object with no
`instructions` member at all — the wallet had nothing to sign.

`inputs` is deliberately never sent. The reference warns that pinning a cached
substate version rejects with `Lock failure: Substate …:N is not found or DOWN`.

### `tari_getSubstate`: the alias question, answered

The previous pass "fixed" the old `{ address }` call by sending
`{ substateId, address }` — the same string under two names. That alias **was
actually transmitted**, and it is an undocumented field on an outbound request.

Undocumented fields are exactly the thing that works by accident against one
bridge and breaks against another, so it is removed. The outbound payload is now
exactly:

```json
{ "substateId": "component_pool_…" }
```

`version` is omitted. The connector itself serialises `{ substateId, version: null }`,
and the contract types it `version?: number | null`, so **both** the omitted and
the explicit-null forms are correct; the app uses the omitted form because the
reference advises against pinning a cached version. A caller-supplied version is
still sent when one is genuinely available.

**Regression guard:** `test/tari-provider-conformance.test.cjs` drives every
method through a provider double that *rejects any request parameter the
published interface does not define*. A permissive mock cannot catch a
re-introduced alias; this one cannot miss one.

---

## 4. Audit 2 — account component vs wallet address

| Use | Domain | Source |
|---|---|---|
| Account that settles a public AMM swap / add / remove | **ACCOUNT_COMPONENT** `component_…` | `tari_requestAccounts` |
| Account that settles a public NFT trade | **ACCOUNT_COMPONENT** `component_…` | `tari_requestAccounts` |
| Substate read (`tari_getSubstate`) | **SUBSTATE_ADDRESS** `component_…` | resolver |
| Amount denominated in | **RESOURCE_ADDRESS** `otl_…` | `tari_getBalances` |
| Stealth / private output destination | **WALLET_ADDRESS** `otl_esm_1…` | `tari_getWalletAddress` |

The reference is blunt: the two are not interchangeable, and mixing them fails
in deserialization without naming the field.

- The public execution path uses the **account component** throughout.
- `tari_getWalletAddress` is now actually called, gated on the documented
  `capabilities.walletAddress`, and is **not** on the public execution path.
- `src/lib/addressDomain.ts` makes a cross-domain substitution a loud, early
  refusal. `requireAccountComponent` rejects an `otl_…`; `requireWalletAddress`
  rejects a `component_…`. Both are called on the connect and authorization
  paths.

This protocol has **no private/stealth feature**, so nothing is addressed to a
stealth destination. That is deliberate and unchanged.

---

## 5. Audit 3 — capability detection

`mapCapabilities` previously looked for camelCase `l1Balance` / `l1ShaInit` /
`l2HtlcFund` … — **names the published contract does not contain**. Against a real
wallet, `mapCapabilities` therefore returned `undefined` for every account, and
every leg capability was permanently false.

Now the **16 documented keys** are read, and only those. Absent keys are *not*
filled with `false`; a reply with no documented boolean is not an advertisement
and returns `undefined`, which every caller fails closed on.

Mapping onto this protocol's L1/L2 leg model:

| Leg capability | Documented counterpart |
|---|---|
| `l2HtlcFund` | `htlcFund` |
| `l2HtlcClaim` | `scriptPathSpend` |
| `l2HtlcRefund` | `scriptPathSpend` |
| `l1Balance`, `l1NormalSend`, `l1ShaInit/Inspect/Claim/Refund` | **none exist** |

The published capability set contains **no L1 tXTM SHA atomic-swap flag at all**.
That is consistent with `BROWSER_MINOTARI_PROVIDER === 'BLOCKED_EXTERNAL'` and it
is the *reason* the browser XTM atomic route stays disabled: there is no
capability to map it from, and inventing one would be a claim no wallet made.
**The private/stealth methods the connector exposes do not unblock Minotari L1
routing** (Audit 21).

Account type genuinely can change the answer — a daemon-relayed account has no
view secret — so capabilities are re-read at authorization time and on
`accountsChanged`, never remembered across an account change or a disconnect.

---

## 6. Audit 4 / 17 — transaction request flow

**Decision: migrate to the create → approve → submit trio**, gated on
`capabilities.transactionRequests`.

Why, given the one-shot method also exists:

1. The reference is explicit that the one-shot call "loses its result forever if
   the page reloads while the approval popup is open". This protocol's entire
   durable-operation design depends on surviving exactly that.
2. `tari_submitTransactionRequest` takes **only a `requestId`**. There is
   therefore **no code path on which a payload can be re-derived, mutated, or
   replaced between the user's approval and the broadcast.** That is a
   structural strengthening of `shown == signed`: the one-shot form still
   depends on the caller passing the right object, the trio does not.

Flow, and the mapping onto the durable operation record:

```
construct exact operation
  → freeze / canonicalise (the review is deep-frozen)
  → show an operation-derived review
  → tari_createTransactionRequest({ kind: 'instructions', instructions })
  → persist requestId  (hooks.onRequestId, bound to the durable operationId)
  → poll tari_getTransactionRequest(requestId)
  → 'approved'  → exactly one tari_submitTransactionRequest(requestId)
  → 'submitted' → reconcile; NEVER submit again
  → 'rejected'  → clean terminal user decision
  → 'failed'    → wallet/network failure, recorded as such
  → anything else → fail closed, submit nothing
```

- `pending` (and `submitting`) is **not** an error and **not** a submission. The
  call returns with the id persisted so the caller can resume after a reload.
- An already-`submitted` request is reconciled, never re-broadcast.
- An unrecognised status fails closed. An unrecognised status is not permission.

**Capability fallback.** When `transactionRequests` is `false` (or nothing was
advertised) the one-shot `tari_signAndSubmitTransaction` is used, still carrying
the **exact** reviewed instructions. What is lost is the reload-survival of the
request id; `shown == signed` is preserved either way. The mechanism is never
changed silently — it is a capability read, and it is recorded in the source.

---

## 7. Audit 5 — dry run / preview

`dryRun: true` "never prompts". It is exposed as `bridge.preflight(reviewedRequest)`
and sends the **exact reviewed instructions** with `dryRun: true`.

It is **not** used for the AMM quote. The pool math is protocol math, exactly as
the brief requires; a wallet simulation is an additional, non-authoritative check
that the reviewed instructions would be accepted. Its failure is informational
and can never become a quote or a submission outcome.

---

## 8. Audit 6 — error codes

The previous implementation classified by matching the message against
`/reject|denied|declined|user/i`. That is wrong in both directions: an internal
failure whose text happened to contain one of those words became a **clean user
rejection** — so the UI would tell the user nothing went wrong — and a genuine
4001 worded differently became an unknown fault.

Now the documented `code` is the **only** discriminator:

| Code | Normalised state |
|---|---|
| `4001` | `REJECTED` — a clean decline, not a fault |
| `4100` | `NOT_CONNECTED` — a connection state |
| `4200` | `UNSUPPORTED_METHOD` — a capability limit |
| `-32603` | `INTERNAL` — the chain's own reason |
| unknown numeric | `UNKNOWN`, **the number is preserved for display** |
| missing / non-numeric / malformed / non-Error throw | `UNKNOWN` |

Message inspection survives in exactly one narrow place: a rejection carrying **no
code at all** whose text explicitly says the user declined. That exists so a
bridge which drops `code` does not turn a decline into an unknown fault. Nothing
else is ever upgraded into a deterministic verdict.

---

## 9. Audit 7 / 11 — the connector and CSP

The reference says **"Include it always."** `index.html` now carries:

```html
<script src="https://universe.tari.mw/tari-connector.js"></script>
```

unconditionally — not behind a wallet check, a user-agent test, or a runtime
branch. Including it conditionally is the wallet-detection the documentation
forbids, and it would race the provider's own initialisation.

**A real defect was found and fixed here.** The response-header CSP carried
`script-src 'self' https://universe.tari.mw`, but the **meta** CSP in `index.html`
carried `script-src 'self'`. A browser enforces **both**, and the effective
policy is their **intersection** — so the meta tag silently blocked the
connector and the Tari Universe iframe placement could never have connected, even
though the header was correct. `script-src` parity is now asserted by
`test/deployment.test.cjs` alongside the existing `connect-src` parity check.

Nothing else about the policy was weakened: the origin is exact, never a
wildcard, and no `unsafe-inline` or `unsafe-eval` was accepted in exchange.

`frame-ancestors 'self' https://universe.tari.mw` stays, because the embedded
placement is one of the two supported ones. It costs nothing in the extension
placement, which is a top-level page.

The connector is never re-implemented, and `window.tariUniverse`,
`window.tariProviders`, `info.rdns`, `info.name` and `isEmbedded` are **not**
referenced by any executable code in the provider boundary — asserted by a
source-level test.

---

## 10. Audits 10, 12, 13 — presence, availability, and lifecycle

**`Boolean(window.tari)` is not "a usable wallet is available."** The connector is
documented as safe to include unconditionally, and on a top-level page with no
wallet frame it still publishes a provider object whose every request rejects.
`probeAvailability` establishes availability with a **real call**:
`tari_getNetwork`, which the reference documents as **answerable without a
connection**, so it neither prompts nor requires a prior `tari_requestAccounts`.
The probe is bounded by `PROVIDER_READ_TIMEOUT_MS`, so a dead provider reaches an
honest state rather than spinning.

Three states are now distinct, with different remedies:

| State | Meaning |
|---|---|
| `UNAVAILABLE` | no `window.tari` object at all — install a wallet |
| `PROVIDER_UNAVAILABLE` | a provider exists but cannot answer here — open from inside a wallet |
| `DISCONNECTED` | a provider answered; no account connected yet |

An availability failure is never reported as "transaction failed": it happens
long before any transaction is attempted.

**The `isAvailable` contradiction is real and is not worked around.** The
connector's header comment says `window.tari.isAvailable` is false outside Tari
Universe, but the published interface does not declare the property and the
deployed object does not define it. Availability is therefore established by an
actual supported call. A test asserts that **no source file reads `isAvailable`**.

**Lifecycle.** The published model makes a provider appear *after* page code has
run: the extension injects at `document_start`, the connector publishes on script
load, and both dispatch `tari#initialized`. Deciding once at mount made a
documented integration look permanently broken. The app now:

- listens for `tari#initialized` and re-resolves (as a **hint** only — an event is
  something a hostile page can dispatch, so it may never be an authority);
- distinguishes **INITIALISATION** (no provider pinned yet) from **REPLACEMENT**
  (a different object while a session is live) via `classifyProviderTransition`;
- **still refuses a mid-session replacement** — the object-identity check is
  untouched, only made lifecycle-aware;
- subscribes to `accountsChanged`, which invalidates the session, the cached
  balances and the capability advertisement. An approval in progress is **not**
  rebound to the new account; it fails closed and reconciles.

---

## 11. Audit 8 — public holdings vs execution authority

Unchanged and correct. Fungible balances and NFT holdings are public on-chain
data; wallet balance APIs are used for wallet UX only. A wallet-returned balance
is never treated as proof of spendability, and every resolver reread still goes
through the `WALLET_PROVIDER` readback port — an indexer is never substituted.
Discovery remains advisory. Chart and indexer presentation remain display-only.

---

## 12. Audit 9 — raw amounts

**PASS, no change needed.** Every official wallet boundary preserves raw integer
amounts. `asRawExecutionAmount` gates the outbound instruction arguments;
`asResourceAddress` gates resource addresses; a numeric balance amount is refused
outright because a JS number above 2^53 has already lost precision. Division by
`10 ** divisibility` happens only at display boundaries, and `divisibility` is
carried through as a **display** value that is never applied to a settlement
amount.

**One pre-existing defect was found and fixed in this class.** Five resolver calls
validated a **resource address** with `asRawExecutionAmount`, which requires
`^\d+$`. A resource address is `otl_…`, so the guard threw on **every** call:
the swap quote never ran, and with it the authoritative readback that issues
`tari_getSubstate` was unreachable in a browser. It failed safe, but the feature
was dead. Fixed in `SwapCard.tsx` and `NftDetailPanel.tsx`, with a source-level
regression guard.

---

## 13. Private / stealth surface

Out of scope, deliberately. The connector exposes `shield`, `unshield`,
`sendPrivately`, `withdrawStealthAndExecute`, `redeemStealthOutputAndExecute`,
`redeemStealthOutputWithPrivateFee`, the HTLC trio, proof-of-funds and ownership
proofs. **None is used**, and the type transcription omits the private operation
kinds entirely, so a private kind is not expressible in this codebase. A test
asserts they are not in the allow-list.

This protocol has **no hand-built stealth transfer**, and never had. The
documented rule — a stealth transfer needs the wallet's signer and cannot be
assembled as raw `instructions` — is respected by not having the feature.

**The presence of Ootle stealth/HTLC methods does NOT unblock the Minotari L1 XTM
browser atomic-swap blocker.** Those are different chains with different
primitives. `BROWSER_MINOTARI_PROVIDER` remains `BLOCKED_EXTERNAL`.

---

## 14. Invariants preserved

Not weakened anywhere in this pass, and each has a test:

- **Live `window.tari` object identity**, compared by reference at authorization
  time. A mid-session replacement still invalidates the operation.
- **Provider implementation fingerprint**, so a swapped `request` is caught.
- **Network identity** — pinned and re-derived; a mismatch is a hard refusal.
- **Connected account identity** — re-derived live, and domain-checked.
- **Capability checks** — the documented set, fail-closed on no advertisement.
- **User approval / rejection** — a decline is a clean terminal decision.
- **`shown == signed`** — strengthened, not weakened. The reviewed, deep-frozen
  `instructions` array is what is signed, and the differential now checks the
  **serialised instructions**, not only the display record beside them. Submission
  by `requestId` removes the re-derivation path entirely.
- **Authoritative rereads** — every resolver read still goes through the
  `WALLET_PROVIDER` port.
- **Raw BigInt amounts** — no floating-point settlement math anywhere.
- **Market-data trust boundary** — `DisplayOnly` still cannot become an amount.
- **Provider announcement events are not trusted for detection** — `tari#initialized`
  is a hint to re-read, never an authority.

---

## 15. Test evidence

| Suite | Count | Result |
|---|---|---|
| `apps/web/test/tari-provider-conformance.test.cjs` (new) | 63 | pass |
| `apps/web/test/*.test.cjs` total | 321 | pass |
| `apps/web/e2e/wallet-conformance.spec.ts` (new, Chromium desktop) | 22 | pass |
| Playwright Chromium desktop + mobile (all specs) | 142 | pass |
| Playwright Firefox desktop (all specs) | 71 | pass |
| Playwright hosting project | 17 | pass |
| `packages/protocol-client` | — | pass |
| `packages/wallet-adapter` | — | pass |
| `pnpm -r typecheck` | — | clean |
| `pnpm -r build` (production) | — | clean |

The browser matrix covers all ten required scenarios: embedded-compatible
provider, non-embedded extension-compatible provider, provider replacement,
unsupported capability, account switch, network mismatch, strict RPC-argument
validation, user rejection, not connected, method unsupported — plus
unconditional connector inclusion, CSP intersection, availability, late provider
initialisation, and `accountsChanged`.

---

## 16. Remaining discrepancies with the official sources

Recorded rather than guessed.

1. **The connector's `isAvailable` comment vs its own object.** The header
   comment documents `window.tari.isAvailable`; neither the published interface
   nor the deployed object defines it. **Resolution:** availability is established
   by a real supported call, and no code reads the property.

2. **The connector's convenience sugar is not the contract.** The connector
   exposes named helpers — `requestAccounts()`, `getSubstate(substateId)`,
   `requestTransaction(operation)`, `proveFunds()`, `verifyFunds()`,
   `signOwnershipChallenge()` — that are NOT part of the published
   `TariProvider` interface, which is `request({ method, params })` only. **This
   app uses only `request`**, which is the documented surface and the one the
   extension also implements.

3. **`requestTransaction()` is deliberately not used.** It performs
   create → poll → submit behind one in-memory promise, which a page reload
   destroys along with the locally-held `requestId`. For durable financial flows
   the explicit trio is used and the `requestId` is persisted.

4. **The connector's `getSubstate` sugar sends `version: null`; this app omits
   `version`.** Both are correct under the contract (`version?: number | null`).
   The app omits it because the reference advises against pinning versions.

5. **The published capability set has no L1 SHA atomic-swap flag.** Recorded as
   the positive reason the browser XTM atomic route remains blocked, rather than
   as a missing integration.

6. **`tari_getSubstate` and `tari_getTransactionResult` are typed
   `Promise<unknown>` upstream.** Their replies are read defensively and fail
   closed when a required field is absent. A missing transaction status becomes
   `UNKNOWN` — never an assumption of success.

---

## 17. Architecture

```
window.tari
   ↓
capability detection            tari_getCapabilities — never wallet identity
   ↓
wallet-agnostic provider adapter
   ↓
Sapient extension  OR  Tari Universe iframe
```

The product remains the **Tari/Ootle Liquidity Protocol**. Cross-layer atomic
settlement is a routing primitive, not the product identity.

---

## 18. Superseded claims

The following statements elsewhere in the repository are now **wrong** and are
corrected in the same change set:

- "A provider that reports `isEmbedded === false` is refused before any call"
  (`README.md`, `security/DEPLOYMENT_SECURITY_MATRIX.md` D-7a.4/D-7a.5).
- "The app is not a top-level page in its intended deployment" / "open the app
  from inside the wallet dApp frame" (`security/FRONTEND_RESIDUAL_RISKS.md` R-2,
  `security/FRONTEND_HOSTILE_AUDIT_REPORT.md`).
- "`address` retained as an identical-value compatibility alias"
  (`docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md`,
  `docs/LIVE_TESTNET_EVIDENCE.md`).
- "window.tari (Sapient-shaped dApp API)" — the interface is not Sapient-shaped,
  it is the **published** one, which Sapient happens to implement
  (`docs/FAST_XTM_TARI_ARCHITECTURE.md`).
- `D-7a.4` / `D-7a.5` cited two test names that never existed in the repository.
  The corrected behaviour is now pinned by tests that do exist.
