# Cross-layer attack matrix — FAST_XTM_TARI

Audited HEAD: `6778660` (+ working-tree hardening in `security/` and the audit commits that
follow this document).
Baseline: `security/LP_BASELINE.md` conventions; invariants in `security/CROSS_LAYER_INVARIANTS.md`.

**Result vocabulary** (no UNKNOWN rows at completion):
`PASS` = attacked and refused, no defect found ·
`FIXED` = a real defect was found, root-caused, fixed, and covered by a retained regression ·
`N/A_BY_CONSTRUCTION` = the attack has no reachable path ·
`EXTERNAL_RISK` = real risk that lives outside this codebase (upstream/chain/wallet) ·
`BLOCKED_EXTERNAL` = requires a live Esmeralda endpoint or funds ·
`BLOCKED_TOOLING` = requires tooling this repo does not have.

Every row's **Test** column names an executable test. Test files:
`HCC` = `packages/protocol-client/test/hostile_crosschain.test.cjs`,
`HF` = `packages/protocol-client/test/hostile_fuzz.test.cjs`,
`XC` = `packages/protocol-client/test/crosschain.test.cjs`,
`MIN` = `packages/protocol-client/test/minotari.test.cjs`.

---

## A. L1 amount authoritativeness (§4)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A-1 | Amount substitution | Malicious provider | Ability to answer the L1 leg | L1_FUNDED | Advertise 1000 tXTM, fund 1 tXTM, report `amountRaw: '1000'` | Amount must be proven, not asserted | `XC` "refuses a merely-remembered amount" | FIXED | CRITICAL | `verifyL1Funded` requires `amountAuthoritative === true`; `applyEvent` refuses an unproven stamp | Provider could return a *forged* "authoritative" flag — see A-6 |
| A-2 | Stale local record | Wallet/provider restart | Lost in-memory amount | L1_FUNDED | Provider remembers the intended amount after restart | A remembered intent is not proof | `MIN` "refuses to call a blinded amount authoritative" | PASS | HIGH | Provider reports `amountAuthoritative: false` when the readback supplies no opening | None exploitable; fail-closed |
| A-3 | Peer-supplied amount | Counterparty | Quote carries a `tariRawAmount` | RESERVED | Set the L2 amount to something favourable | Quote terms are validated and immutable | `HCC 14.1`, `14.2` | FIXED | HIGH | `validateQuoteView` requires positive integer amounts; terms copied once at accept | — |
| A-4 | Transaction metadata substitution | Malicious transport | Can edit the tx record | CLAIM_ARMED | Swap the amount field on a "confirmed" record | Metadata is never evidence | `HCC 9.1`, `11.2` | PASS | MEDIUM | Only decoded script + base-node UTXO facts are used; recovery re-queries the chain | — |
| A-5 | Commitment known, value unknown | Honest provider | Blinded output | L1_FUNDED | Correct commitment, unknowable value | Refuse rather than guess | `MIN` "amountAuthoritative: false" | PASS | HIGH | Coordinator refuses to advance | Counterparty-funded leg cannot complete today (EXTERNAL_RISK) |
| A-6 | Forged authority flag | Malicious adapter | Implements the L1 port | L1_FUNDED | Return `amountAuthoritative: true` with no proof | Only a proven opening may set it | `XC` "authoritative L1 verification refuses a merely-remembered amount" (proven case requires a real opening) | EXTERNAL_RISK | HIGH | The flag is an interface contract; a hostile adapter can lie | **Documented trust assumption**: a conforming adapter proves the value with `decrypt_data` + `verify_mask`. Verified by construction for our own provider; unverifiable for a third-party adapter. See `MINOTARI_AUTHORITY_MODEL.md` §2.7 |
| A-7 | Wrong wallet observes | Hostile environment | Another wallet's gRPC | L1_FUNDED | Observe with a wallet that does not own the output | Refund refused, no false proof | `MIN` "refund refused: output is not in this wallet's output manager" | N/A_BY_CONSTRUCTION | LOW | `constructRefund` requires local output-manager ownership | — |

**Directional note.** A-1/A-6 only matter in `TARI_TO_XTM`, where the counterparty funds L1
and we must verify their amount as claimant. In `XTM_TO_TARI` we fund L1 ourselves, so the
amount is self-consistency rather than an adversarial input.

---

## B. L1 script verification (§5)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B-1 | Correct H, wrong claimant | Malicious funder | Can build a script | CLAIM_ARMED | Fund with our H but a claim key we do not control | Verification must read the key from the script | `HCC 5.1`, `6.1` | FIXED | HIGH | `obs.claimRecipient` is decoded from the script; the provider never reports an asserted key | — |
| B-2 | Correct claimant, wrong H | Malicious funder | — | CLAIM_ARMED | Fund a script whose `PushHash` is someone else's | Verification must read H from the script | `HCC 8.2`, `5.1` | PASS | HIGH | `hashMatches` compares the decoded `PushHash` to the bound H | — |
| B-3 | Wrong refund key | Malicious funder | — | REFUNDING | Script refund key ≠ our wallet | Refund identity is script-derived | `HCC 6.1` | PASS | MEDIUM | `obs.refundRecipient` from the script; intent field never transmitted | — |
| B-4 | Wrong refund height | Malicious funder | — | L1_FUNDED | Script height ≠ quote | Exact match required | `HCC 6.2` | PASS | HIGH | `deadlineSafe` equality check | — |
| B-5 | Stale/already-refundable deadline | Malicious funder | Height already passed | L1_FUNDED | Quote a height the wallet will produce but that is already refundable | Freshness required, not just equality | `XC` "refund height 500 at tip 510 is NOT fresh" | FIXED | HIGH | `deadlineFresh` added to the evidence contract and enforced in `applyEvent` | — |
| B-6 | Extra branch | Malicious funder | — | L1_FUNDED | Insert an extra `IfThen/EndIf` | Exact opcode sequence only | `HCC 5.1` "extra branch" | PASS | MEDIUM | `decodeShaHtlcScript` expects one exact sequence | — |
| B-7 | Reordered branch | Malicious funder | — | L1_FUNDED | Swap claim/refund branches | Exact sequence only | `HCC 5.1` | PASS | MEDIUM | Same | — |
| B-8 | Malformed opcode sequence | Malicious funder | — | L1_FUNDED | `EqualVerify`, `PushInt`, `Nop` injection | Fail closed | `HCC 5.1` (8 structural cases) | PASS | MEDIUM | Same | — |
| B-9 | Trailing script data | Malicious funder | — | L1_FUNDED | Append bytes after `EndIf` | Fail closed | `HCC 5.1` "trailing data" | PASS | LOW | Explicit trailing-byte check | — |
| B-10 | Truncated script | Malicious funder | — | L1_FUNDED | Cut the script short | Fail closed | `HCC 5.1` (2 truncation cases) | PASS | LOW | Truncation-aware cursor | — |
| B-11 | Duplicate hash condition | Malicious funder | — | L1_FUNDED | Two `HashSha256` conditions | Fail closed | `HCC 5.1` "duplicate hash condition" | PASS | MEDIUM | Exact sequence | — |
| B-12 | Alternate serialization, same fields | Malicious funder | — | L1_FUNDED | Overlong LEB128 for the height | Must decode exactly as the engine does | `HCC 5.1` "overlong" | FIXED | MEDIUM | `decodeU64Varint` matched to `integer-encoding 3.0.4`; u64-escaping encodings refused | — |
| B-13 | Varint exceeding u64 | Malicious funder | — | L1_FUNDED | 10-byte varint with bits above bit 63 | Refuse, never silently truncate | `HCC 5.1` "exceeds u64" | FIXED | HIGH | Range check in `decodeU64Varint` | The engine itself truncates; we refuse instead, which is strictly safer for a verifier |
| B-14 | Script fuzzing | Automated | — | L1_FUNDED | 20k random + 50k structured mutations | A script with a foreign H never accepts our preimage | `HCC 5.2`, `HF 5.4` | PASS | MEDIUM | Exact decoder + branch verifier | — |

---

## C. Refund branch (§6)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C-1 | Fake refund recipient | Malicious caller | Can call the port | L1_FUNDING | Pass a different `refundRecipient` | Caller metadata can never override the script | `HCC 6.1` | FIXED | MEDIUM | Field documented as informational and never transmitted; refund requires local output-manager ownership | — |
| C-2 | Intent ≠ observed script | Malicious provider | — | L1_FUNDED | Report a refund key/height that differs | Observed script is the only truth | `HCC 6.2` | PASS | HIGH | `deadlineSafe` + `refundPubKeyHex` re-decoded | — |
| C-3 | Account rotation mid-session | Hostile environment | Provider switches wallet | L1_FUNDED | Change the active account after funding | Observed script unchanged; refund refused | `HCC 6.1` | PASS | MEDIUM | Ownership check in `constructRefund` | — |
| C-4 | Wrong wallet funds | Operational | Wrong account selected | L1_FUNDED | Fund from a wallet we do not control | Refund path unavailable; recovery must reconcile | `MIN` constructRefund refusal | N/A_BY_CONSTRUCTION | MEDIUM | Fail-closed by design | Operational, not protocol |

---

## D. Fee semantics (§7)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| D-1 | Zero / tiny / huge / NaN / Infinity fee | Malicious config | Provider options | any | Set an absurd `fundingFeeTPerGram` | Never crashes or forces disclosure | `HCC 7.1` | PASS | LOW | Fee is a forwarded hint; the wallet recomputes it | A caller cannot force a fee — correct by design |
| D-2 | Negative / overflow fee | Malicious config | — | any | Supply a negative or huge value | Refused or ignored, never a crash | `HCC 7.1` | PASS | LOW | No fee arithmetic in the coordinator | — |
| D-3 | Fee omitted entirely | — | — | any | Omit the hint | Default reference value used | `MIN` "funding maps onto …" | PASS | LOW | `MINOTARI_REFERENCE_FEE_PER_GRAM` | — |
| D-4 | Fee change forces disclosure | Malicious wallet | Claim unconstructible | CLAIM_ARMED | Make the claim unbuildable so S must be revealed anyway | A failed construct reconciles, never re-reveals | `HCC 7.2` | PASS | MEDIUM | Claim failure → `ENTER_RECOVERY` from the revealed record | The secret is already public at that point by construction; the record preserves that evidence |

---

## E. Hash / preimage semantics (§8)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| E-1 | Wrong S | Any | — | CLAIM | Claim with a different preimage | Refused before any wallet call | `HCC 5.3`, `10.3` | PASS | HIGH | `verifyPreimage` + script branch verifier | — |
| E-2 | One-bit-flipped S | Any | — | CLAIM | Flip one bit | Refused | `HCC 5.3` (first and last bit) | PASS | HIGH | Same | — |
| E-3 | Wrong length / empty / oversized | Any | — | CLAIM | Truncate or pad the preimage | Refused by the encoding check | `HCC 8.1`, `5.3` | PASS | MEDIUM | `require32Bytes` / `verifyPreimage` | — |
| E-4 | Hex string vs raw bytes | Any | — | CLAIM | Hash the hex text instead of the bytes | Different H, refused | `HCC 8.1` | PASS | HIGH | Raw-byte hashing on both legs | — |
| E-5 | Case confusion | Any | — | CLAIM | Uppercase hex | Refused (no silent normalisation) | `HCC 5.3`, `8.1` | PASS | LOW | Lowercase-only validation | — |
| E-6 | UTF-8 reinterpretation | Any | — | CLAIM | latin1 mis-decode of multi-byte text | Different H | `HCC 8.1` | PASS | MEDIUM | Byte-exact hashing | — |
| E-7 | Leading-zero loss | Any | — | CLAIM | Drop a leading `00` byte | Different H, refused | `HCC 8.1` | PASS | MEDIUM | Fixed-length 32-byte encoding | — |
| E-8 | Double hashing | Any | — | CLAIM | Hash the hash | Different H, refused | `HCC 8.1` | PASS | MEDIUM | Single SHA-256 per leg | — |
| E-9 | L1/L2 digest divergence | Regression | — | any | One leg changes its digest convention | Both legs bind identical raw-byte SHA256 | `HCC 8.1`, `MIN` interop vectors | PASS | CRITICAL-if-broken | Pinned vectors incl. the NIST "abc" case | Canonical-Ristretto acceptance of S is proven by traced Rust source, not by our suite (documented) |

---

## F. Early secret leaks (§9)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F-1 | S in session record | Bug | — | any | Persist S in the session | No secret field exists | `HCC 9.1` | PASS | HIGH | Record has no secret field | — |
| F-2 | S in error text | Bug | An error path | any | Include S in an exception message | Refused | `HCC 9.1` | PASS | HIGH | Messages carry ids, never secrets | — |
| F-3 | S in logs / telemetry / URLs | Bug | — | any | Serialise a provider result | Refused across re-encodings | `HCC 9.1` (uppercase / 0x / base64) | FIXED | HIGH | `assertNoSecretInJson` now scans case-insensitively and across base64 | — |
| F-4 | S in history / route result | Bug | — | any | Put S in a `RouteResult` | Impossible by type | `HCC 31.1`, `9.1` | FIXED | MEDIUM | `containsSecret: false`, no secret field | — |
| F-5 | S in test snapshots | Bug | — | — | — | No snapshot contains S | `HCC 9.1` | PASS | LOW | — | — |

---

## G. CLAIM_ARMED bypass (§10)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G-1 | Arm from QUOTED/RESERVED/L1_FUNDING/L1_FUNDED/L2_FUNDING | Malicious caller | Direct coordinator access | any | Call `armClaim` in an early state | Refused by the state machine | `HCC 10.1` (12 states) | PASS | HIGH | `requireState(['BOTH_FUNDED'])` | — |
| G-2 | Arm with insufficient confirmations | Malicious provider | Low confirmations | BOTH_FUNDED | Report 0 confirmations | Refused at arm time | `HCC 10.2(d)` | FIXED | HIGH | Fresh re-observation in `armClaim` | — |
| G-3 | Arm with unsafe deadline margin | Malicious caller | Asserts a large margin | BOTH_FUNDED | Lie about the margin | Authoritative margin wins | `HCC 15.3` | FIXED | HIGH | `DeadlineAuthority` + explicit opt-in flag | `unsafeAllowAssertedDeadlines` is a test-only escape hatch |
| G-4 | Arm with `amountAuthoritative: false` | Honest provider | Blinded amount | BOTH_FUNDED | Arm anyway | Refused | `XC` "refuses a merely-remembered amount" | FIXED | CRITICAL | Stamp required before arming | — |
| G-5 | Arm with a truthy evidence string | Malicious caller | Old API | BOTH_FUNDED | Pass `"ok"` as `claimConstructibleEvidence` | Parameter removed | `HCC 10.2`, `XC` partial-verification test | FIXED | HIGH | Argument deleted; real re-observation replaces it | — |
| G-6 | Arm after capability loss | Provider degrades | Capability withdrawn | BOTH_FUNDED | Drop `l1ShaRefund` mid-session | Refused | `HCC 10.2(c)` | FIXED | MEDIUM | Capability re-check in `armClaim` | — |
| G-7 | Arm with a spent output | Counterparty claims first | Output spent | BOTH_FUNDED | L2 output already spent | Refused | `HCC 10.2(e)` | FIXED | HIGH | `unspent` in the L2 evidence contract | — |
| G-8 | Reveal from UNKNOWN state | Malicious caller | — | RECOVERY_REQUIRED | Reveal after an UNKNOWN submit | Refused | `HCC 10.1`, `11.1` | PASS | HIGH | State machine | — |
| G-9 | Reveal with a mismatched stored preimage | Corrupted store | Secret store drift | CLAIM_ARMED | Store a different S | Refused into recovery | `HCC 10.3` | PASS | HIGH | `verifyPreimage` before any irreversible call | — |

---

## H. UNKNOWN outcomes (§11)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| H-1 | L1 response lost | Network | Request reached the wallet | RECOVERY_REQUIRED | Swallow the response | UNKNOWN → reconcile, never resubmit | `HCC 11.1` | PASS | HIGH | `L1_FUND_UNKNOWN`; state blocks a retry | — |
| H-2 | L2 response lost | Network | — | RECOVERY_REQUIRED | Same on leg 2 | Same | `HCC 11.1` | PASS | HIGH | `L2_FUND_UNKNOWN` | — |
| H-3 | Claim response lost | Network | Secret already public | RECOVERY_REQUIRED | Same after disclosure | Record keeps the disclosure evidence | `HCC 11.1` | FIXED | MEDIUM | Recovery transition now derived from the REVEALED record | — |
| H-4 | Base-node outage | Infrastructure | Readback fails | any | Readback throws | Refuse, do not guess | `minotari_grpc` readback paths | BLOCKED_TOOLING | MEDIUM | No live node to inject an outage | Live fault injection required |
| H-5 | Stale wallet status | Provider | Cached status | RECOVERY_REQUIRED | Report a stale COMMITTED | Authoritative re-query | `HCC 11.2` | PASS | HIGH | `lookupTransaction` per leg | — |
| H-6 | tx accepted but not indexed | Chain | Mempool | RECOVERY_REQUIRED | Query before indexing | `UNKNOWN`, not failure | `HCC 11.2` (REJECTED/NOT_FOUND map to RECONCILE/WAIT) | PASS | MEDIUM | Never treats a lookup miss as success | — |

---

## I. Duplicate operations (§12)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| I-1 | Duplicate quote acceptance | Malicious provider | Replay a quote | RESERVED | Accept the same quote twice | Second reservation refused | `HCC 12.1` | FIXED | HIGH | One reservation per `quoteId` | — |
| I-2 | Same reservation id, different terms | Malicious caller | — | RESERVED | Reuse the id with new amounts | Refused | `HCC 12.1` | PASS | HIGH | Idempotency compares terms | — |
| I-3 | Concurrent duplicate claims | Race | Two callers | CLAIM_ARMED | Fire two reveals | At most one succeeds; state blocks the rest | `HCC 12.2` | PASS | HIGH | State machine | In-process only; a cross-process store needs compare-and-swap |
| I-4 | Duplicate L1 claim | Retry | Claim already recorded | CLAIMING | Call `claimL1` twice | Idempotent, same tx id | `HCC 12.3` | PASS | MEDIUM | `l1ClaimTxId` check | — |
| I-5 | Duplicate inventory release | Retry | Release already done | RELEASED | Release twice | Second is a no-op, never a double decrement | `HCC 12.1` | FIXED | MEDIUM | State machine + pre-mutation non-negative check | — |

---

## J. Reservation races (§13)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| J-1 | 80 + 80 over 100 | Concurrent taker | 2 requests | RESERVED | Both believe they fit | At most one succeeds | `HCC 13.1` | PASS | HIGH | Cumulative reserved totals | Single-process ledger only |
| J-2 | 60 + 40 (exact fit) | Concurrent taker | 2 requests | RESERVED | Boundary | Exactly two succeed, the third refused | `HCC 13.1` | PASS | MEDIUM | Same | — |
| J-3 | 60 + 41 | Concurrent taker | 2 requests | RESERVED | Over-subscribe | Second refused | `HCC 13.1` | PASS | MEDIUM | Same | — |
| J-4 | 1 × 100 concurrent | Load | 100 requests | RESERVED | Flood | Exactly 100 fit, inventory ≥ 0 | `HCC 13.1` | PASS | MEDIUM | Same | — |
| J-5 | FUNDED vs expiry race | Scheduler | Expiry sweep | FUNDED | Sweep a funded reservation | Funded inventory is never swept | `HCC 13.2` | PASS | HIGH | `expireUnfunded` skips `FUNDED` | — |
| J-6 | Release vs new reservation | Race | Concurrent release+reserve | RESERVED | Reserve while releasing | Capacity restored exactly once | `HCC 13.1` | PASS | MEDIUM | Sequential state machine | Cross-process needs a transactional store |
| J-7 | Inventory strand (unfunded expiry never swept) | Liveness | Quote accepted, never funded | RESERVED | Let the TTL pass | Inventory is reclaimed | `HCC 13.2` | FIXED | MEDIUM | `expireUnfunded` added; the `QUOTE_EXPIRED_UNFUNDED` event was previously unreachable | No scheduler calls the sweep automatically yet (operational) |

---

## K. Provider quote attacks (§14)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| K-1 | Expired quote | Malicious provider | — | QUOTED | Offer a stale quote | Refused before reserving | `HCC 14.1` | FIXED | MEDIUM | Expiry check in `validateQuoteView` | — |
| K-2 | Zero / negative / float amount | Malicious provider | — | QUOTED | Malformed amounts | Refused | `HCC 14.1` | FIXED | MEDIUM | `requirePositiveAmount` | — |
| K-3 | Garbage H | Malicious provider | — | QUOTED | Non-hex or wrong-length hash | Refused | `HCC 14.1` | FIXED | MEDIUM | 64-lowercase-hex or explicit `''` | — |
| K-4 | Empty claim recipient | Malicious provider | — | QUOTED | Blank address | Refused | `HCC 14.1` | FIXED | MEDIUM | `validateQuoteView` | — |
| K-5 | Mixed L1/L2 network | Malicious provider | — | QUOTED | l1=esmeralda, l2=localnet | Refused | `HCC 14.1` | FIXED | HIGH | Explicit pairing check | — |
| K-6 | Deadline altered after acceptance | Malicious provider | Post-accept | any | Mutate the caller's quote object | Durable state unchanged | `HCC 14.2` | FIXED | HIGH | Record copied once; immutable fields | — |
| K-7 | Quote id collision | Malicious provider | Two quotes, one id | RESERVED | Reuse a quote id | Second reservation refused | `HCC 12.1` | FIXED | HIGH | `quoteReservations` map | — |
| K-8 | Advertisement widens network policy | Malicious provider | — | any | Advertise on an arbitrary network | Refused | `HCC 14.3` | FIXED | MEDIUM | `validateAdvertisement` now uses the same allowlist | — |
| K-9 | Quote replay after restart | Operational | Fresh process | RESERVED | Re-present an old quote | TTL + one-reservation-per-quote | `HCC 12.1`, `13.2` | PASS | LOW | TTL and durable ids | A durable quote store would strengthen this |
| K-10 | Over-advertised inventory (economic) | Malicious provider | Lying ad | RESERVED | Advertise more than held | Unprovable off-chain | `HCC 13.1` | EXTERNAL_RISK | MEDIUM | Documented as economic, not protocol theft | Inventory over-advertisement is a provider-reputation problem; settlement is enforced by claim timing |

---

## L. Deadlines and cross-domain confusion (§15, §16)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L-1 | Exact refund boundary | — | — | REFUND_ELIGIBLE | Height == deadline | Refundable at the boundary, not before | `HCC 15.2` | PASS | MEDIUM | `>=` in the same domain | — |
| L-2 | One unit before | — | — | REFUND_ELIGIBLE | height = deadline−1 | Not refundable | `HCC 15.2` | PASS | MEDIUM | Same | — |
| L-3 | One unit after | — | — | REFUND_ELIGIBLE | height = deadline+1 | Refundable | `HCC 15.2` | PASS | LOW | Same | — |
| L-4 | L1 height read as L2 epoch | Bug | — | REFUND_ELIGIBLE | Compare a height against an epoch | Domains never compared | `HCC 15.2` (epoch 1 with height 0 ⇒ not refundable) | PASS | HIGH | Separate fields, like-for-like comparisons only | — |
| L-5 | Deadline fields swapped | Bug | — | any | Swap `l1RefundDeadlineHeight`/`l2RefundDeadlineEpoch` | Validation catches non-integers; domain checks catch swaps | `HCC 14.1`, `15.2` | PASS | MEDIUM | Integer validation + per-leg comparison | — |
| L-6 | Clock skew / wall clock | Bug | — | any | Use a timestamp for eligibility | Chain height/epoch only | `HCC 15.2`, `13.2` | PASS | MEDIUM | Wall clock governs only unfunded quote TTL | — |
| L-7 | Zero/negative cadence | Config | — | any | `l1BlockMs: '0'` | Refused | `HCC 15.1` | PASS | LOW | `deriveDeadlines` guards | — |
| L-8 | Deadline margin asserted, not measured | Malicious caller | — | any | Pass inflated margins | Authoritative read wins | `HCC 15.3` | FIXED | HIGH | `DeadlineAuthority` | Test opt-in flag remains a trust assumption |

---

## M. Reorg, finality, stale reads (§17, §18)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| M-1 | Output reorged away | Chain | Reorg | BOTH_FUNDED | Output vanishes before arming | Refused | `HCC 17.1` | FIXED | HIGH | Fresh re-observation at arm | Real reorg needs a live node |
| M-2 | Confirmations regress | Chain | Reorg | BOTH_FUNDED | Confirmation count drops | Refused | `HCC 17.1`, `10.2(d)` | FIXED | HIGH | Same | — |
| M-3 | Claim tx reorged | Chain | Reorg | CLAIMING | Claim disappears | Reconcile, never re-reveal | `HCC 11.2` | PASS | MEDIUM | `lookupTransaction` | — |
| M-4 | Cached L2 read | Stale cache | — | BOTH_FUNDED | `source: 'CACHED'` | Refused | `HCC 18.1` | FIXED | HIGH | `AUTHORITATIVE` required in the evidence contract | — |
| M-5 | Stale provider state | Provider cache | — | any | Serve an old observation | Re-read before irreversible steps | `HCC 17.1`, `10.2` | FIXED | HIGH | `armClaim` re-observes both legs | — |
| M-6 | Wallet reports confirmed early | Wallet | — | L1_FUNDED | Confirmations below policy | Refused | `XC` confirmations check | PASS | MEDIUM | `confirmationsSufficient` in the contract | — |
| M-7 | Live reorg behaviour | — | Live node | — | — | — | — | BLOCKED_EXTERNAL | MEDIUM | — | Requires Esmeralda + funds to execute |

---

## N. Network and mainnet escape (§19, §20)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| N-1 | Case variations | Malicious config | — | any | `MAINNET`, `MainNet` | Refused | `HCC 19/20` | PASS | HIGH | Allowlist | — |
| N-2 | Alias / substring | Malicious config | — | any | `base.mainnet`, `esmeralda-mainnet` | Refused | `HCC 19/20` | PASS | HIGH | Allowlist | — |
| N-3 | Numeric network id | Malicious config | — | any | `'1'` | Refused | `HCC 19/20` | PASS | MEDIUM | Allowlist | — |
| N-4 | Missing / undefined network | Bug | — | any | `undefined`, `null`, `''` | Refused | `HCC 19/20` | PASS | MEDIUM | Allowlist | — |
| N-5 | Mainnet provider construction | Malicious config | — | any | `new MinotariDevGrpcProvider({network:'mainnet'})` | Refused | `MIN` mainnet refusal | PASS | HIGH | Constructor guard | — |
| N-6 | Env-var trick to reach mainnet | Attacker | Shell access | any | Set the submit gate on mainnet | Mainnet still refused | `HCC 21.1` | PASS | HIGH | `isRealSubmitEnabled` checks the network first | — |

---

## O. Real-submit gate (§21)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| O-1 | Falsy/other values | Config | — | any | unset, `''`, `0`, `true`, `TRUE`, `yes`, `on`, `' 1'`, `'1 '`, `random`, `01` | Only exactly `'1'` enables | `HCC 21.1` | PASS | HIGH | Exact string equality | — |
| O-2 | Default state | — | — | any | No env var | OFF | `HCC 21.1` | PASS | HIGH | Same | — |
| O-3 | Gate open on mainnet | Attacker | Gate on | any | `1` + mainnet | Refused | `HCC 21.1` | PASS | HIGH | Network checked first | — |

---

## P. Secret store (§24)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P-1 | Duplicate secret id with a different S | Malicious provider | Returns a second preimage | L1_FUNDING | Overwrite a funded session's preimage | Refused | `HCC 9.2` | FIXED | HIGH | `ingestExternalSecret` refuses a different value | — |
| P-2 | Secret from another session | Bug | — | any | Cross-session read | Not readable | `HCC 9.2` | PASS | MEDIUM | Keyed by sessionId | — |
| P-3 | Deleted / missing secret | Restart | — | CLAIM_ARMED | Reveal after loss | Refused, never regenerated | `HCC 9.2`, `HF 23.1` | PASS | HIGH | No auto-regeneration | Production encrypted persistence is BLOCKED_EXTERNAL |
| P-4 | Corrupted secret | Bug | Store corruption | CLAIM_ARMED | Store bytes that do not hash to H | Refused into recovery | `HCC 10.3`, `HF 23.2` | PASS | HIGH | `verifyPreimage` before the irreversible call | — |
| P-5 | Provider supplies a preimage inconsistent with the bound H | Malicious provider | — | L1_FUNDING | Return a different S | Funding aborted, H unchanged | `HF 23.2` | PASS | HIGH | `ingestWalletGeneratedSecret` mismatch check | — |
| P-6 | Restart-safe encrypted storage | — | — | — | — | — | — | BLOCKED_EXTERNAL | HIGH | — | Not implemented; `InMemorySecretStore` is memory-only by design |

---

## Q. Provider spoofing (§25)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Q-1 | Missing capability advertisement | Fake provider | — | QUOTED | Omit `capabilities()` | Refused before reserving | `HCC 25.1`, `XC` | PASS | HIGH | `missingKeys` treats undefined as all-missing | — |
| Q-2 | Capability withdrawn mid-session | Provider | — | BOTH_FUNDED | Drop a required capability | Refused at arm | `HCC 10.2(c)` | FIXED | MEDIUM | Re-check in `armClaim` | — |
| Q-3 | Fake `window.tari` | Attacker | — | any | Spoof the browser provider | — | — | BLOCKED_EXTERNAL | HIGH | — | Browser L1 SHA is unavailable upstream; the provider surface does not exist yet |
| Q-4 | Account / network switch mid-session | Provider | — | any | Switch account or network | Observed script truth is unaffected; refund ownership checked | `HCC 6.1` | PASS | MEDIUM | Ownership + script-derived identity | No live provider to attack |

---

## R. Ootle L2 leg (§27)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R-1 | Wrong H on L2 | Malicious counterparty | — | BOTH_FUNDED | Fund an L2 output with a different H | Never verifies, never arms | `HCC 8.2` | FIXED | CRITICAL | `hashExact` in the L2 evidence contract | — |
| R-2 | Wrong L2 amount | Malicious counterparty | — | BOTH_FUNDED | Under-fund the L2 output | Refused | `HCC 28.1` | FIXED | HIGH | `amountExact` | — |
| R-3 | Wrong claimant | Malicious counterparty | — | BOTH_FUNDED | Different claim address | Refused | `HCC 28.1` | FIXED | HIGH | `claimantExact` | — |
| R-4 | Wrong refund epoch | Malicious counterparty | — | BOTH_FUNDED | Different epoch | Refused | `HCC 28.1` | FIXED | HIGH | `epochRefundExact` | — |
| R-5 | Reused witness / already-spent input | Chain | — | CLAIMING | Replay a witness | Chain rejects a double spend | — | N/A_BY_CONSTRUCTION | MEDIUM | The engine/chain enforces single-spend | Not executed here |
| R-6 | Premature refund | Malicious counterparty | — | REFUNDING | Refund before the epoch | Refused | `HCC 15.2` | PASS | MEDIUM | `epochRefundExact` at verification | — |
| R-7 | Real engine execution of the ScriptPath leg | — | Real Ootle node | — | — | — | — | BLOCKED_EXTERNAL | MEDIUM | — | `OotleScriptPathLegPort` has no concrete provider; `build_script_path_witness` exists upstream but is not wired |

---

## S. Two-leg mismatch and partial settlement (§28, §29)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S-1 | L1 H ≠ L2 H | Split-leg attacker | Funds only one leg correctly | BOTH_FUNDED | Mix legs from two swaps | Never arms | `HCC 28.1`, `8.2` | FIXED | CRITICAL | Both legs verified against the same bound H | — |
| S-2 | L1 amount correct, L2 wrong | Split-leg attacker | — | BOTH_FUNDED | Under-fund L2 | Refused | `HCC 28.1` | FIXED | HIGH | Per-leg amount checks | — |
| S-3 | One leg from a different session | Bug | — | BOTH_FUNDED | Reuse another session's tx id | Refused | `HCC 10.2` | PASS | MEDIUM | Per-session tx ids and observations | — |
| S-4 | Only L1 funded; counterparty vanishes | Counterparty | — | L1_FUNDED | Never fund L2 | Our XTM is refundable after the deadline | `HCC 15.2` | PASS | MEDIUM | Script-enforced refund | — |
| S-5 | Only L2 funded; first leg reorged | Chain | Reorg | BOTH_FUNDED | L1 disappears | No reveal; recovery/refund | `HCC 17.1` | FIXED | HIGH | Arm-time re-observation | — |
| S-6 | Permanent lock by a malicious party | Counterparty | — | any | Never claim, never refund | Both legs' refunds eventually open | traced script | PASS | MEDIUM | `CheckHeightVerify(tip+720)` on L1; `AfterEpoch` on L2 | Requires the counterparty's cooperation for L2 refunds; modelled, not executed |
| S-7 | One party obtains both assets | Attacker | — | — | — | Impossible under the hashlock | `HCC 5.3`, `E-1..E-9` | PASS | CRITICAL-if-broken | SHA256 hashlock on both legs | No live end-to-end execution (BLOCKED_EXTERNAL) |

---

## T. Multi-hop boundary prep (§31)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| T-1 | AMM hop starts on "probably done" | Bug | A composed hop | any | Use funding progress as settlement | Impossible by contract | `HCC 31.1` | FIXED | HIGH | `settlementStatus: 'UNSETTLED'`, `composable: false` | Composition stays blocked until terminal proof exists |
| T-2 | Route result leaks S | Bug | — | any | Include S in a route result | Impossible by type | `HCC 31.1`, `9.1` | PASS | MEDIUM | No secret field | — |
| T-3 | Route result lacks an operation id | Design | — | any | Composed hop cannot identify the session | `operationId` present in the contract | `HCC 31.1` | FIXED | MEDIUM | Field added (optional until a session exists) | — |
| T-4 | Network mismatch between request and quote | Bug | — | any | Price a route on a different network | Refused | `HCC 31.1` | FIXED | MEDIUM | Explicit cross-check in `routeResult` | — |

---

## U. Live testnet execution (§32)

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| U-1 | Live tXTM happy path | — | Funded wallet + gRPC | — | — | — | — | BLOCKED_EXTERNAL | — | — | Prerequisite: a running `minotari_console_wallet` gRPC on Esmeralda, a funded wallet, and a base-node readback endpoint |
| U-2 | Live refund path | — | Same | — | — | — | — | BLOCKED_EXTERNAL | — | — | Same |
| U-3 | Live wrong-preimage rejection | — | Same | — | — | — | — | BLOCKED_EXTERNAL | — | — | Same |
| U-4 | Live UNKNOWN reconciliation | — | Same | — | — | — | — | BLOCKED_EXTERNAL | — | — | Same |
| U-5 | Live restart recovery | — | Same | — | — | — | — | BLOCKED_EXTERNAL | — | — | Same |
| U-6 | Browser L1 SHA leg | — | Upstream `tari_l1_wasm` support | — | — | — | — | BLOCKED_EXTERNAL | — | — | Prerequisite: upstream must expose the SHA atomic-swap primitive to WASM, then wallet ops, then our adapter |
| U-7 | Live reorg / finality policy | — | Live node | — | — | — | — | BLOCKED_TOOLING | — | — | Requires a controllable chain or node simulator |

---

## V. Cross-cutting

| ID | Attack class | Attacker | Prerequisite | Target state | Exploit sequence | Expected invariant | Test | Result | Severity | Mitigation | Residual risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| V-1 | Second leg funded on an unverified first leg | Malicious/stale provider | Skip `verifyL1Funded` | L1_FUNDED | Fund leg 2 against an unverified/reorged leg 1 | Second-leg funding requires authoritative evidence | `XC` "no authoritative L1 verification" refusal; `HCC 10.2(a)` | FIXED | CRITICAL | `l1Verification` stamp required | — |
| V-2 | Reveal with no verification of either leg | Malicious caller | Skip both verifications | BOTH_FUNDED | Arm and reveal immediately | Arming re-observes both legs | `HCC 10.2`, `HF 23.1` | FIXED | CRITICAL | `armClaim` re-observes | — |
| V-3 | State-machine escape via a forged verification event | Malicious caller | Direct `applyEvent` access | any | Submit a partial `L1_VERIFIED_FUNDED` | Refused by the state machine | `XC` "refuses to record a PARTIAL authoritative verification" | FIXED | HIGH | Evidence validated inside `applyEvent` | — |
| V-4 | 100k random transitions | Automated | — | any | Illegal jumps, reveal bypass, mutation | No invariant violation | `HF 22.1` | PASS | — | Persisted seeds on failure (none recorded) | — |
| V-5 | Crash/restart at 12 points | Automated/operational | — | any | Crash after each irreversible step | Recovery never re-drives a terminal session | `HF 23.1` | PASS | — | Durable-record-only recovery | — |
| V-6 | Unreachable state | Design | — | — | — | Every state is reachable | `HF 22.2` | PASS | LOW | — | — |
| V-7 | Account/network policy drift between entry points | Bug | — | any | Advertisement uses a laxer rule than acceptQuote | One policy everywhere | `HCC 14.3` | FIXED | MEDIUM | Shared `assertTestnetNetwork` | — |
