# Hostile cross-layer audit report — FAST_XTM_TARI

**Audited HEAD:** `6778660` (with the audit hardening commits that follow this document on
the same branch).
**Status after audit:** EXPERIMENTAL / TESTNET. Real submission remains gated OFF by default
and mainnet remains refused.

---

## 1. Scope

A dedicated hostile pass over the cross-layer XTM↔TARI atomic swap: the coordinator, the
session state machine, the Minotari L1 integration (script codec, reference provider, gRPC
surface), the Ootle L2 ScriptPath port, provider inventory/reservation, deadline logic,
secret lifecycle, recovery/reconciliation, and the route-composition boundary.

**Out of scope (explicitly):** frontend, asset lanes, and the hostile cross-layer audit of
the AMM/ERC-20 pool (covered separately by `security/LP_HOSTILE_AUDIT_REPORT.md`).

**Upstream pins used for every source-backed claim**
- Minotari L1: `tari-project/tari` **v6.0.0**, commit `97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3`, network Esmeralda
- Ootle L2: `tari-project/tari-ootle` commit `2d6083e6cc7c98cde93dacebe2fb76b17703f588` (workspace 0.41.1)

---

## 2. Frozen baseline

| Item | Value |
|---|---|
| Branch | `feat/multi-asset-stablecoin-markets` |
| HEAD at audit start | `7ae81d9` (CI green: Node Tests 66/66 + 12/12, Security Engine success) |
| HEAD at audit end | see §7 |
| protocol-client tests | 67 → **106** (34 hostile + 5 fuzz added) |
| wallet-adapter tests | 12 → **12** |
| Property operations | 10,000 → **100,000** transition attempts + 5,000 reveal probes + 70,000 script mutations |
| Failing fuzz seeds persisted | **0** (`packages/protocol-client/test/fuzz-failing-seeds.jsonl` is not created) |
| Browser provider capability | L2 `window.tari` leg READY; **L1 SHA leg MISSING upstream** (`tari_l1_wasm` exposes no SHA atomic swap) |
| Real-submit gate | OFF by default; only the exact value `1` enables it; mainnet always refused |
| Mainnet | impossible in this phase (allowlist `esmeralda`/`localnet`) |
| Rust crates | untouched this phase (32 LP tests, unchanged) |

---

## 3. What the audit found

The coordinator's "authoritative verification" steps turned out to be **advisory rather than
enforced**. The durable state could reach the irreversible phases without them. Two of these
are CRITICAL because they allow committing one asset against an unverified, reorged, or
absent counter-leg, and then disclosing the preimage.

### 3.1 Findings by root cause

| # | Finding | Severity | Attack rows | Fix |
|---|---|---|---|---|
| C-1 | **Second-leg funding was reachable from a bare submission acknowledgement.** `L1_FUNDED` is entered by `L1_FUND_ACKNOWLEDGED`; `verifyL1Funded` was never required. A session could commit the second asset against an unverified first leg. | **CRITICAL** | V-1, A-1, G-4 | `beginL2Funding` refuses unless the record carries an authoritative `l1Verification` stamp; `applyEvent` refuses to stamp unproven evidence |
| C-2 | **CLAIM_ARMED trusted durable state and an unvalidated string.** `armClaim` accepted any truthy `claimConstructibleEvidence` and re-observed nothing, so the preimage could be disclosed on legs that were never verified, or that had drifted (reorg, spend, capability loss, finality regression). | **CRITICAL** | V-2, G-2, G-5, G-6, G-7, M-1, M-2, M-5 | `armClaim` now requires both stamps, re-checks capabilities and the deadline, and **re-observes both legs authoritatively**; the string parameter was deleted |
| C-3 | **The L1 amount was compared against itself.** `amountExact` compared the remembered funding intent to the record; `amountAuthoritative` defaulted to true when unspecified. | **CRITICAL** | A-1, A-2, A-5 | `amountAuthoritative` must be explicitly `true`; the intent alone never proves the amount. See §4 for what legitimately can. |
| H-1 | **Deadline margins were entirely caller-asserted** at every irreversible phase, including immediately before disclosure. | HIGH | L-8, G-3 | New `DeadlineAuthority` port whose read wins over caller input; caller-asserted margins require an explicit `unsafeAllowAssertedDeadlines` opt-in and are recorded as `CALLER_ASSERTED` |
| H-2 | **`acceptQuote` validated nothing** about the untrusted provider quote (amounts, hash shape, recipients, deadlines, confirmations, direction, expiry, identifier hygiene, mixed networks). | HIGH | K-1…K-6, K-8 | `validateQuoteView` runs before any inventory is reserved; mixed L1/L2 network pairing refused |
| H-3 | **No deadline freshness requirement** — a refund height that merely *matched* the quote could already be in the past. | HIGH | B-4, B-5 | `deadlineFresh` (observed height ahead of the tip by the required confirmations) added to the evidence contract |
| H-4 | **A quote could back more than one reservation** (replay), and unfunded expired reservations were never reclaimed (`QUOTE_EXPIRED_UNFUNDED` was an unreachable event). | HIGH | I-1, J-7, K-7 | One reservation per `quoteId`; `expireUnfunded` sweep added |
| H-5 | **A stored preimage could be silently replaced** by a provider returning a different `S`, re-pointing an already-funded HTLC at a preimage nobody can satisfy. | HIGH | P-1, P-5 | `ingestExternalSecret` refuses a different value for an existing session; the coordinator additionally aborts funding on an H mismatch |
| H-6 | **The script varint decoder diverged from the engine.** `integer-encoding 3.0.4` truncates a 10th byte's upper bits into a `u64`; our BigInt decoder returned a value above `u64`, so the verifier could disagree with the chain about refund reachability. | HIGH | B-12, B-13 | Decoder matched to the engine; non-representable encodings are refused outright rather than silently truncated |
| M-1 | **Reservation release corrupted accounting before checking the invariant** — a double release would leave permanently negative totals and mask the bug. | MEDIUM | I-5, J-6 | Non-negative check now precedes mutation |
| M-2 | **Secret-leak detection was bypassable** by case-flip or base64 re-encoding. | MEDIUM | F-3 | `assertNoSecretInJson` scans case-insensitively plus uppercase/0x/base64 forms (dependency-free encoder — this module is browser-targeted) |
| M-3 | **A failed claim lost the disclosure evidence** — the recovery transition was derived from the pre-reveal record, so `secretRevealedAtUnixMs` was not persisted even though S may have gone out. | MEDIUM | H-3 | Recovery is now derived from the REVEALED record |
| M-4 | **The route result had no settlement contract** — it ignored the requested network entirely and offered only static `fundingProgress`, inviting a future AMM hop to start on "probably done". | MEDIUM | T-1…T-4 | `routeResult` validates the network, and carries `settlementStatus: 'UNSETTLED'`, `composable: false`, `containsSecret: false`, and an `operationId` seam |
| M-5 | **Network policy drifted between entry points** — advertisements used a mainnet substring check while everything else used a strict allowlist. | MEDIUM | V-7, K-8 | `validateAdvertisement` now uses the same `assertTestnetNetwork` allowlist |
| M-6 | **Caller-provided refund metadata was passed as if it were meaningful**, with nothing comparing it to the authoritative script. | MEDIUM | C-1, C-2 | Documented as informational and never transmitted; the refund identity is re-decoded from the observed script, and `constructRefund` requires local output-manager ownership |

**Open CRITICAL: 0. Open HIGH: 0.** Every finding above is fixed in code and covered by a
retained regression (finding policy: reproducer → classify → fix root cause → keep the test
→ full suite re-run).

### 3.2 Attack-matrix tally

| Result | Count |
|---|---|
| Total rows | 146 |
| PASS | 81 |
| FIXED | 48 |
| N/A_BY_CONSTRUCTION | 3 |
| EXTERNAL_RISK | 2 |
| BLOCKED_EXTERNAL | 10 |
| BLOCKED_TOOLING | 2 |
| UNKNOWN | **0** |

A single row can inherit a fix from a shared root cause (for example, five arm-time rows are
all closed by C-2), so 48 FIXED rows correspond to the 16 distinct root causes above.

---

## 4. The L1 amount question, answered

**Can the Minotari L1 amount ever be authoritatively established? Yes — but not by the base
node, and not through any currently exposed API.**

- A stealth one-sided output's value lives in a **blinded commitment**. The base node
  physically cannot reveal it. Any provider that reports an amount from a base-node read is
  reporting an assertion.
- The **claimant** can establish it from chain data plus its own private key, using the very
  APIs the real claim path already uses
  (`output_manager_service/service.rs:2841-2856`):
  `EncryptedData::decrypt_data(...) -> (MicroMinotari, blinding factor, memo)` followed by
  `output.verify_mask(&range_proof, &spending_key, amount)`. That is a cryptographic opening
  of an on-chain commitment, not a claim.
- The **funder** can do the same for its own output.
- The traced wallet gRPC surface exposes **no** RPC that returns a decrypted,
  range-proof-verified amount for an arbitrary output hash, so our reference provider cannot
  honestly do it and reports `amountAuthoritative: false`.

**Trust assumption, stated precisely.** `amountAuthoritative: true` is an *interface
contract*: the adapter asserts that it verified a chain-validated commitment opening. For our
own reference provider this is enforced by construction (it only sets the flag when a
readback supplies the value). For a third-party adapter the coordinator cannot verify the
proof itself — a hostile adapter could simply set the flag. This is recorded as
`EXTERNAL_RISK` (row A-6) and is the single most important thing an integration partner must
be held to.

**Route-level consequence.** In `XTM_TO_TARI` we fund L1, so the amount is self-consistency.
In `TARI_TO_XTM` the counterparty funds L1 and we must verify their amount as claimant — the
adversarial case. Until an upstream API exposes the decryption, the coordinator correctly
refuses to complete that direction. That is a fail-closed availability limit, not a loss of
funds, and it is the honest outcome rather than papering over a number we cannot prove.

---

## 5. Verification evidence

| Suite | Result |
|---|---|
| `hostile_crosschain.test.cjs` | 34/34 |
| `hostile_fuzz.test.cjs` | 5/5 (~150k operations) |
| `crosschain.test.cjs` | 21/21 |
| `minotari.test.cjs` | 17/17 |
| protocol-client total | **106/106** |
| wallet-adapter | **12/12** |
| workspace typecheck | clean |
| CI (Node Tests + Security Engine) | green at the pre-audit HEAD; re-verified at the audit HEAD — see §7 |

Fuzzing discipline: deterministic xorshift32 PRNG from a fixed base seed, six safety
invariants asserted after **every accepted transition**, and any invariant violation or
unexpected error type persists the seed to `test/fuzz-failing-seeds.jsonl` before failing.
Zero seeds were persisted.

---

## 6. What this audit does NOT establish

- **No live execution.** There is no funded Minotari wallet, no local gRPC endpoint, and no
  live base-node readback in this environment. Every network-level claim is traced from
  source or modelled with injectable doubles. Live rows are `BLOCKED_EXTERNAL`.
- **No real L2 execution.** `OotleScriptPathLegPort` has no concrete provider; the ScriptPath
  leg was attacked at the port/coordinator boundary only. Engine-level single-spend
  behaviour is `N/A_BY_CONSTRUCTION` (chain-enforced) but was not executed.
- **No reorg simulation.** `BLOCKED_TOOLING`.
- **The browser L1 leg does not exist yet** — the attack surface cannot be tested until
  upstream exposes the primitive.
- **No claim of atomicity under adversarial network timing.** The HTLC structure is sound as
  traced, but end-to-end atomicity has not been demonstrated on a live chain.

## 7. Conclusion

**NO KNOWN CROSS-LAYER CONTRACT/COORDINATOR DRAIN FOUND UNDER TESTED MODEL**, for the model
defined in §6. Three CRITICAL and six HIGH defects were found during the audit and are now
fixed with retained regressions; none remain open.

This is **not** a claim of production readiness. The route remains EXPERIMENTAL/TESTNET:
the browser path is upstream-blocked, the L1 amount cannot yet be proven through any exposed
API, and no live Esmeralda execution has occurred.

## 8. Next exact phase

**Unified route composition: XTM → TARI → AMM, plus hostile multi-hop failure testing.**
The composition seam is prepared but deliberately inert: `RouteResult.composable` is typed
`false` and `settlementStatus` starts at `UNSETTLED`, so no downstream hop can start on a
coordinator's optimism. Enabling it requires (a) a terminal, chain-proven settlement proof
on `RouteResult`, and (b) a new hostile suite for partial-hop failure — a failure after the
swap but before the AMM deposit must be provably refundable, never a silent loss.
