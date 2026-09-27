# Multi-hop attack matrix — XTM → FAST_XTM_TARI → TARI → AMM → public fungible

Audited HEAD: `e958281` (multi-hop composition). Predecessor audit: `695291d`
(cross-layer). Invariants: `security/MULTIHOP_INVARIANTS.md`.

**Result vocabulary** (no UNKNOWN rows at completion):
`PASS` · `FIXED` (real defect found, root-caused, fixed, regression retained) ·
`N/A_BY_CONSTRUCTION` · `EXTERNAL_RISK` · `BLOCKED_EXTERNAL` · `BLOCKED_TOOLING`.

Test files: `MH` = `packages/protocol-client/test/multihop_hostile.test.cjs` (28 tests),
`MF` = `packages/protocol-client/test/multihop_fuzz.test.cjs` (4 tests, ~120k operations),
`XC` = `test/hostile_crosschain.test.cjs` (the 146-row cross-layer suite, still green).

---

## A. Hop 2 starting before hop 1 terminal proof

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-1 | hop 2 with NO proof | Malicious caller | Direct hop-2 access | any | Build hop 2 with `settlementProof: undefined` | Hop 2 is unreachable without a proof | `MH 1.1` | PASS | CRITICAL-if-broken | `verifyTerminalSettlementProof` is the first statement of `buildAmmSwapHop` | — |
| MH-2 | forged proof object literal | Attacker | Same process | any | Hand a hand-written object shaped like a proof | The brand symbol is module-private | `MH 1.1` | PASS | CRITICAL-if-broken | Symbol brand; only `mintTerminalSettlementProof` can satisfy it | Brand is an in-process guard, not a sandbox boundary |
| MH-3 | proof from a peer (JSON payload) | Attacker | Network/JSON | any | Round-trip a forged proof through JSON | A deserialised payload is not a proof | `MH 1.1` | PASS | HIGH | Symbol brand is lost on JSON round-trip → refused | — |
| MH-4 | route machine bypasses the hop gate | Malicious caller | `applyRouteEvent` | BOTH_FUNDED → HOP2_READY | Apply `HOP2_READY` with no proof | `HOP2_READY` requires a proof and a proven input amount | `MH 1.2` | PASS | CRITICAL-if-broken | Precondition checked in the state machine | — |
| MH-5 | `BEGIN_HOP2` without `HOP2_READY` | Malicious caller | — | HOP1_SETTLED | Jump straight to execution | Illegal transition | `MH 1.2` | PASS | HIGH | Explicit transition table | — |
| MH-6 | second hop-2 execution with the same proof | Attacker | After one execution | HOP2_READY | Re-arm and execute again | A proof backs exactly ONE hop-2 execution | `MH 2.3`, `MF MHF-4` | PASS | HIGH | `proofConsumedByHop2` single-use binding | In-process; a cross-process store needs CAS |
| MH-7 | `HOP1_SETTLED` with a proof ref from another route | Attacker | Two routes | any | Settle hop 1 with a foreign `proofRef` | A settlement is bound to its route | `MF MHF-1` | FIXED | MEDIUM | `proofRef.routeId` must equal the route id | — |

## B. Forged / stale / mismatched terminal proofs

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-8 | session not terminal | Malicious caller | Hand-made session | — | Mint from `BOTH_FUNDED` | Only a terminal CLAIMED session settles | `MH 2.1` | PASS | CRITICAL-if-broken | `isTerminal` + explicit `CLAIMED` check | — |
| MH-9 | session in RECOVERY_REQUIRED | Same | Unresolved swap | — | Mint from recovery | An UNKNOWN leg never settles | `MH 2.1` | PASS | HIGH | Terminal check excludes it | — |
| MH-10 | missing L1/L2 verification stamps | Same | Tampered session | — | Drop `l1Verification` | Both legs must be authoritatively proven | `MH 2.1` | PASS | HIGH | Mint requires both | — |
| MH-11 | CACHED (indexer) L2 evidence | Same | — | — | Set `l2Verification.source = 'CACHED'` | Cached reads never settle | `MH 2.1` | PASS | HIGH | `AUTHORITATIVE` required | — |
| MH-12 | L1 amount authority false | Honest provider | Blinded amount | — | Mint anyway | Uncertainty blocks the route | `MH 2.1`, `MH 13.1` | PASS | CRITICAL-if-broken | Mint refuses; the cross-layer boundary is not weakened for composition | Blocks `TARI_TO_XTM` completion — by design |
| MH-13 | provider assertion as evidence | Malicious provider | — | — | `l1Verification.source = 'PROVIDER_ASSERTION'` | Never settlement evidence | `MH 2.1` | PASS | HIGH | Refused | — |
| MH-14 | refund path outstanding | Tampered session | — | — | Add `l2RefundTxId` to a CLAIMED session | A route never settles over a live refund | `MH 2.1` | PASS | HIGH | Refused | — |
| MH-15 | stale proof | Delayed consumer | — | — | Reuse a proof after `maxAgeMs` | A stale proof must be re-derived | `MH 2.2` | PASS | HIGH | `verify` checks age | — |
| MH-16 | mutated proof field | Attacker | In-process | — | Change the amount after minting | Tampering is detectable | `MH 2.2`, `MF MHF-3` | PASS | HIGH | FNV fingerprint over the fact fields | Fingerprint is not a signature; it detects mutation, not a crafted forgery |
| MH-17 | wrong-session proof | Attacker | Two sessions | — | Use route B's proof in route A | Proofs are route-bound | `MH 2.2`, `MF MHF-2` | PASS | HIGH | Route binding in `verify` | — |
| MH-18 | wrong recipient account | Account switch | — | — | Hop 2 executes from a different account | Identity binding between settlement and execution | `MH 2.2`, `8.2` | PASS | HIGH | `recipientAccount` must equal the hop-2 account | — |
| MH-19 | wrong TARI amount (too high) | Malicious evidence | — | — | Report more than the quote | Value is never invented | `MH 2.1` | PASS | HIGH | `amount > tariRawAmount` refused | — |
| MH-20 | non-integer / oversized amount | Malicious evidence | — | — | `1.5`, `1e6`, 129-bit | Raw integer only, bounded | `MH 2.1`, `14.1` | PASS | MEDIUM | `requireRaw` + 2^128-1 bound computed, not typed | — |

## C. Resource identity

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-21 | fake same-symbol TARI | Malicious provider | — | HOP2_READY | Substitute a lookalike resource address | Exact identity only | `MH 3.1` | PASS | HIGH | Exact `resourceAddress` equality | — |
| MH-22 | wrapped TARI pretending canonical | Same | — | HOP2_READY | Set `isCanonicalTari: true` on a wrapper | The flag is not self-asserted: the address must be the canonical one | `MH 3.1` | PASS | HIGH | Record validation requires the chained canonical asset | Identity of "canonical TARI" is configured by the caller — a deployment concern |
| MH-23 | arbitrary stealth asset | Same | — | HOP2_READY | Route through a stealth resource | Only canonical TARI is composable | `MH 3.1` | PASS | MEDIUM | `isCanonicalTari` + `kind === 'OOTLE_L2'` | — |
| MH-24 | wrong network resource | Same | — | HOP2_READY | Use a resource from another network | Network identity is part of the asset | `MH 3.1` | PASS | MEDIUM | Exact address; networks are per-route | A cross-network address collision is not modelled |
| MH-25 | metadata-only match | Same | — | HOP2_READY | Rely on the `label` field | Labels are never identity | `MH 3.1` | PASS | LOW | Identity is the address only | — |

## D. Stale AMM quote / min_output between hops

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-26 | AMM moves between hops | Market | — | HOP2_READY | Fund hop 1, let reserves move, build hop 2 | Hop 2 rereads authoritatively | `MH 4.1` | PASS | HIGH | `resolveSwap` performs a mandatory reread; no cached quote is reused | — |
| MH-27 | AMM frozen at route-quote time | Bug | — | HOP2_READY | Pre-sign hop 2 during quoting | Never pre-sign across hops | `MH 4.1` | FIXED | HIGH | `RouteHop.inputAmountRaw` is empty until a proof supplies it; the AMM intent is built only post-settlement | — |
| MH-28 | min_output disappears | Market | — | HOP2_READY | Drain the output reserve after hop 1 | A stale min_output is never used | `MH 4.2` | PASS | HIGH | Refreshed `minOutput` re-checked against the accepted floor | — |
| MH-29 | price moves beyond acceptance | Market | — | HOP2_READY | Large adverse move | Pause, do not silently accept | `MH 4.2` | PASS | HIGH | `REQUOTE_REQUIRED` | — |
| MH-30 | AMM quote expired | Clock | — | HOP2_READY | `currentEpoch >= maxEpoch` | Expired quotes never build | `MH 4.3` | PASS | MEDIUM | `resolveSwap` EXPIRED → requote | — |
| MH-31 | liquidity vanished | Market | — | HOP2_READY | Empty reserve | Never build on an empty pool | `MH 4.3` | PASS | MEDIUM | `UNAVAILABLE` | — |
| MH-32 | dust intermediate | Small fill | — | HOP2_READY | Settle 1 unit of TARI | Dust never silently builds | `MH 4.3` | PASS | LOW | Explicit dust guard | — |
| MH-33 | wrong pool / direction | Bug | — | HOP2_READY | Request a pair the pool does not hold | Direction checked authoritatively | `MH 4.4` | PASS | MEDIUM | `resolveSwap` CONFLICTED | — |

## E. Failure after hop 1 (partial completion)

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-34 | hop 2 rejected after hop 1 settled | Chain/market | — | HOP2_EXECUTING | AMM tx rejected | The user keeps their TARI; the route pauses | `MH 5.1` | FIXED | HIGH | `HOP2_FAILED` → `ROUTE_PAUSED` (was `ROUTE_FAILED_TERMINAL`, which misreported a total loss) | — |
| MH-35 | wallet/provider disconnect | Environment | — | HOP2_REQUOTE | Provider vanishes | Intermediate stays user-controlled | `MH 5.1` | PASS | MEDIUM | `intermediateAssetRemainsUserControlled`, no automated retry | — |
| MH-36 | hop 2 deliberately skipped | User choice | — | HOP1_SETTLED | Skip hop 2 | Partial completion is a first-class outcome | `MH 5.2` | PASS | MEDIUM | `HOP2_SKIPPED` → `ROUTE_SETTLED`, hop 2 stays UNSETTLED | — |
| MH-37 | no automated attempt risks the TARI | Hostile caller | — | ROUTE_PAUSED | "Retry until it works" | Never risk the intermediate to hit the target | `MH 5.1` | PASS | MEDIUM | Retry is always an explicit route event, never automatic | — |

## F. UNKNOWN reconciliation and duplicate execution

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-38 | hop-2 response lost | Network | — | HOP2_EXECUTING | Submit, lose the response | UNKNOWN → reconcile, never resubmit | `MH 6.1` | PASS | HIGH | `reconcileHop2`; resubmit only on a proven REJECTED/NOT_FOUND | — |
| MH-39 | hop-2 UNKNOWN then retry | Bug | — | HOP2_EXECUTING | Rebuild immediately | No blind resubmit | `MH 6.1` | FIXED | HIGH | Route parks in `ROUTE_RECOVERY_REQUIRED`, from which hop 2 is unreachable | — |
| MH-40 | hop-1 UNKNOWN then continue | Network | — | HOP1_EXECUTING | L1 result unknown | No blind continuation | `MH 6.1` | PASS | HIGH | `HOP1_UNKNOWN` → recovery | — |
| MH-41 | duplicate claim/settlement | Attacker | — | any | Apply the same settlement twice | No duplicate hop settlement | `MF MHF-1` (P7) | PASS | HIGH | Terminal states + single-use proof | — |

## G. Restart recovery

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-42 | restart in a terminal route | Environment | — | ROUTE_SETTLED/FAILED | Re-drive after restart | Terminal routes are terminal | `MH 7.1`, `MF MHF-4` | PASS | HIGH | Empty transition rows on terminal states | — |
| MH-43 | restart mid-hop-2 | Environment | — | HOP2_EXECUTING | Restart after submit | At most one hop-2 execution after restart | `MF MHF-4` | PASS | HIGH | `proofConsumedByHop2` survives in the durable record | Cross-process needs CAS |
| MH-44 | restart after hop 1 | Environment | — | HOP1_SETTLED | Restart mid-requote | Settlement is re-derivable from the proof | `MH 7.1` | PASS | MEDIUM | Proof is durable and re-verified | — |
| MH-45 | route id collision | Malicious caller | — | — | Reuse a route id | Route ids must be valid identifiers | `MH 8.1` | PASS | MEDIUM | `requireIdentifier` | Uniqueness is the caller's durable-id discipline |
| MH-46 | operation id replay | Malicious caller | — | HOP2_READY | Reuse a hop-2 operation id | Durable, non-empty operation id | `MH 8.1` | FIXED | MEDIUM | `requireOperationId` on `BEGIN_HOP2` | — |

## H. Account / network switching

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-47 | account switch after hop 1 | User/env | — | HOP1_SETTLED | Execute hop 2 from another wallet | Settlement-to-execution identity binding | `MH 8.2`, `MH 2.2` | PASS | HIGH | Proof recipient must equal the hop-2 account | — |
| MH-48 | wallet provider switch | Environment | — | HOP2_REQUOTE | Swap the provider mid-route | The reread must come from the new provider | `MH 4.1` | PASS | MEDIUM | Each build rereads; no cached state is trusted | Provider identity is not pinned per route |
| MH-49 | network switch mid-route | Environment | — | any | Change the network | Route networks are fixed at acceptance | `XC 14.1` (cross-layer) | PASS | HIGH | Cross-layer `assertTestnetNetwork`; route assets are exact | Route does not re-assert the network per hop — relies on hop 1 |
| MH-50 | mainnet escape | Attacker | Env | any | Point the route at mainnet | Mainnet is impossible | `MH 12.2` | PASS | HIGH | Cross-layer gate + provider guard | — |

## I. Malicious quotes, discovery, and economics

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-51 | malicious provider quote | Malicious provider | — | ROUTE_QUOTED | Quote an impossible rate | Discovery validates bounds | `XC 14.1` | PASS | HIGH | `quoteXtmToTari` bounds + `validateQuoteView` | Provider selection is economic, not cryptographic |
| MH-52 | malicious discovery/indexer quote | Malicious indexer | — | ROUTE_QUOTED | Poison discovery | Discovery is never settlement evidence; hop 2 rereads authoritatively | `MH 4.1` | PASS | MEDIUM | `resolveSwap` mandatory reread | — |
| MH-53 | provider over-advertised inventory | Malicious provider | — | ROUTE_QUOTED | Advertise more than held | Bounded by the cross-layer ledger | `XC 13.1` | EXTERNAL_RISK | MEDIUM | Reservation invariants | Economic, not protocol |
| MH-54 | final minimum output violation | Bug/market | — | HOP2_SETTLED | Report a settlement below the floor | The accepted minimum is a hard floor | `MH 12.1`, `MF MHF-1` (P3) | FIXED | HIGH | Enforced in the route machine, not only in the hop | — |
| MH-55 | slippage double-applied | Bug | — | — | Apply provider and AMM slippage twice | Each layer applies its own exactly once | `MH 9.2` | PASS | MEDIUM | Provider spread inside the provider quote; AMM slippage in `deriveMinOutput` | — |
| MH-56 | fee confusion / hidden rake | Implementation | — | — | Fold provider spread into a protocol fee | Fees stay separate; developer fee is zero | `MH 9.1` | PASS | MEDIUM | `buildRouteFees` + record validation | — |
| MH-57 | value invented/lost in composition | Bug | — | any | Mismatch between legs | Accounting conserves value | `MH 9.3` | PASS | MEDIUM | Proof amount ≤ quote; min ≤ quote | Full conservation across a real chain is unproven (no live run) |
| MH-58 | extreme price movement | Market | — | HOP2_REQUOTE | Crash the price mid-route | Pause rather than accept | `MH 4.2` | PASS | MEDIUM | Refreshed quote vs accepted floor | — |
| MH-59 | fee spike | Market | — | HOP2_REQUOTE | Fees exceed acceptance | `maxNetworkFeesRaw` in the acceptance record | `MH 12.1` | PASS | LOW | Recorded; enforcement happens per hop | Fee enforcement is not yet wired into the hop build |

## J. Amount authority and cross-layer regression

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-60 | weaken the L1 amount boundary to enable composition | Implementation | — | — | Trust a remembered amount | The audit's boundary is not relaxed | `MH 13.1` | PASS | CRITICAL-if-broken | Mint requires `amountAuthoritative === true` | Blocks a direction; correct trade-off |
| MH-61 | bypass the unverified-first-leg guard | Implementation | — | L1_FUNDED | Fund hop 2 without verification | Cross-layer guard intact | `MH 13.1` | PASS | CRITICAL-if-broken | `beginL2Funding` unchanged and still refuses | — |
| MH-62 | cross-layer regressions | — | — | — | Composition changes cross-layer behaviour | All 146 cross-layer rows stay green | full suite | PASS | HIGH | No coordinator change in this phase | — |
| MH-63 | AMM math regressions | — | — | — | Composition alters the AMM | AMM untouched | full suite | PASS | HIGH | `resolveSwap` reused unchanged | — |

## K. Real execution and market data

| ID | Attack | Attacker | Prereq | Target state | Sequence | Invariant | Test | Result | Severity | Mitigation | Residual |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MH-64 | live composed execution | — | Funded wallet + Ootle node | — | — | — | — | BLOCKED_EXTERNAL | — | — | Requires a real Ootle `ScriptPath` provider (upstream-blocked) and funded accounts |
| MH-65 | live L2 HTLC leg | — | Same | — | — | — | — | BLOCKED_EXTERNAL | — | — | Same as the cross-layer audit's RR-5 |
| MH-66 | market-data event tampering | Bug | — | — | Emit a fabricated trade record | The event requires the real txid and integer amounts | `MH 11.2` | PASS | LOW | `buildMarketDataEvent` validates | Indexing integrity is out of scope here |
| MH-67 | candle aggregation from unverified data | — | — | — | — | — | — | N/A_BY_CONSTRUCTION | LOW | Aggregation deliberately not implemented | Next phase |
| MH-68 | frontend secret exposure | Bug | — | — | Put S in the route view | The UI model is secret-free | `MH 11.1` | PASS | HIGH | `containsSecret: false`; no secret field | — |
