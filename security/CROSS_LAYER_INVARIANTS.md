# Cross-layer safety invariants — FAST_XTM_TARI

Status: **ENFORCED IN CODE + EXECUTABLE TESTS.** Every invariant below names the code that
enforces it and the test that proves it. Test files:
`packages/protocol-client/test/hostile_crosschain.test.cjs` (34 tests),
`packages/protocol-client/test/hostile_fuzz.test.cjs` (5 tests, ~150k operations),
`packages/protocol-client/test/crosschain.test.cjs`, `packages/protocol-client/test/minotari.test.cjs`.

Terms used in the "enforced by" column:
`session.ts` = `src/crosschain/session.ts` (state machine),
`coordinator.ts` = `src/crosschain/coordinator.ts`,
`provider.ts` = `src/crosschain/provider.ts`,
`reservation.ts` / `secret.ts` / `quote.ts` / `types.ts` / `deadlines.ts` under `src/crosschain/`,
`minotari.ts` = `src/chains/minotari.ts` (script codec + verifier),
`minotari_grpc.ts` = `src/chains/minotari_grpc.ts` (development-reference provider).

---

## INV-1 — S is never disclosed before CLAIM_ARMED

**Statement.** The preimage S is unrevealable until the session is in `CLAIM_ARMED`, and
S never appears in any durable, loggable, or user-facing object.

**Enforced by**
- `session.ts` transition table: `REVEAL_SECRET` is legal only from `CLAIM_ARMED`; the
  fuzzer additionally asserts `secretRevealedAtUnixMs` is first set only by that event.
- `requireSecretRevealAllowed(record)` re-checks the state immediately before reveal.
- `secret.ts::InMemorySecretStore.revealSecret(sessionId, claimArmed)` refuses without the
  arming flag.
- `CrossChainSessionRecord` has no secret field at all; only `hashH` and
  `secretRevealedAtUnixMs` (a timestamp) are stored.

**Tests.** `10.1` (12 states probed, every one refuses), `10.3`, `9.1`, `9.2`,
`22.1` (100k transitions, invariant asserted after every accepted transition),
`23.1` (a lost secret cannot claim after restart).

**Residual risk.** `revealSecret` trusts the caller's `claimArmed` boolean; the coordinator
is the only intended caller. A caller that passes `true` outside the coordinator would
bypass the store-level check. The state check in `requireSecretRevealAllowed` is the real
gate (MEDIUM, defense-in-depth).

---

## INV-2 — CLAIM_ARMED requires every authoritative condition for both legs

**Statement.** The claim may be armed only when (a) both legs carry authoritative
verification evidence, (b) both legs still pass a FRESH authoritative re-observation at arm
time, (c) capabilities still hold, and (d) the deadline margin still holds.

**Enforced by**
- `session.ts`: `applyEvent` REFUSES to record `L1_VERIFIED_FUNDED`/`L2_VERIFIED_FUNDED`
  unless every evidence field is affirmative, the L1 read is not a
  `PROVIDER_ASSERTION`, and `observedHashHex` is a real 32-byte value.
- `coordinator.ts::beginL2Funding`: refuses without `record.l1Verification` — the second
  leg can never be funded on an unverified first leg.
- `coordinator.ts::armClaim`: requires `l1Verification` AND `l2Verification`, re-checks
  capabilities, re-checks the deadline, then calls `verifyL1Funded` + `verifyL2Funded`
  again and refuses into `RECOVERY_REQUIRED` on any drift.
- The unvalidated `claimConstructibleEvidence` string parameter has been removed.

**Tests.** `10.2` (a–e), `17.1`, `18.1`, `8.2`, `28.1`, `12.3`, plus
`crosschain.test.cjs` "the state machine refuses to record a PARTIAL authoritative
verification" and "authoritative L1 verification refuses a merely-remembered amount".

**Why this mattered.** Before this audit, `L1_FUNDED` was reachable by a bare submission
acknowledgement and `verifyL1Funded` was optional, so the second leg could be funded and
the preimage disclosed with **no chain verification at all**. That was a CRITICAL finding
and is now closed (see `CROSS_LAYER_HOSTILE_AUDIT_REPORT.md`, finding C-1/C-2).

---

## INV-3 — A terminal claim/refund state cannot transition back to a live state

**Enforced by.** `session.ts::TERMINAL_STATES = {CLAIMED, REFUNDED, FAILED_TERMINAL}` with
empty transition rows; `allowedTargets` returns `undefined` for `REFUND_ELIGIBLE` from any
terminal state; `isTerminal(state)` gates `recoverSession`.

**Tests.** `22.1` invariant 1 and 6, `11.2` (a terminal session yields no recovery
action), `23.1` (crash fuzzing at every step), `10.1`.

---

## INV-4 — Claim and refund cannot both successfully settle the same leg

**Enforced by.** Each leg's on-chain script admits exactly one spend: the hashlock branch
(`HashSha256 PushHash(H) Equal`) or the timeout branch
(`CheckHeightVerify(height)`), never both. `minotari.ts::executeShaHtlcBranch` models
this and reports `refundReachable` separately from a successful claim. The coordinator
serializes legs through a single session state machine, and a leg's claim is idempotent
via its recorded `l1ClaimTxId`/`l2ClaimTxId`.

**Tests.** `5.3` (refund boundary exact; a wrong preimage cannot claim even past the
refund height), `12.3` (idempotent L1 claim), `11.1`.

**Residual risk.** Double-spend of the *same* output is prevented by the chain
(`TransactionOutput` commitment + the single-spend rule), not by our coordinator. Verified
by traced source, not by live execution (see residual risks, BLOCKED_EXTERNAL).

---

## INV-5 — Inventory cannot be reserved twice

**Enforced by.** `reservation.ts::reserve` keys on `reservationId` (identical terms are
idempotent, different terms are refused) and on `quoteId`: a second, different reservation
for the same quote is refused as a replay. Cumulative per-provider reserved totals are
checked before insertion.

**Tests.** `12.1`, `13.1` (80+80, 60+40, 60+41, 1×100 concurrent), `14.1`.

---

## INV-6 — Inventory cannot be released twice

**Enforced by.** `requestRelease` is idempotent only for the same
`reason:evidenceOperationId` and throws on a conflicting concurrent release;
`completeRelease` requires `RELEASE_PENDING` and now checks the non-negative invariant
**before** mutating, so a double release can never corrupt accounting.

**Tests.** `12.1`, `13.1` (release-then-reserve), and the state assertions in
`crosschain.test.cjs`.

---

## INV-7 — Quote expiry cannot release inventory after irreversible funding

**Enforced by.** `requestRelease(..., 'QUOTE_EXPIRED')` throws unless the reservation is
`RESERVED` (never `FUNDED`); `expireUnfunded` sweeps only `RESERVED` rows.

**Tests.** `13.2` (a funded reservation survives an expiry sweep), and the pre-existing
`crosschain.test.cjs` case "funded sessions live by chain deadlines".

---

## INV-8 — An UNKNOWN submission result never causes a blind resubmission

**Enforced by.** Every submit path catches transport failure and persists
`L1_FUND_UNKNOWN` / `L2_FUND_UNKNOWN` / `ENTER_RECOVERY`, which move the session to
`RECOVERY_REQUIRED`. Funding entry points require `RESERVED`/`L1_FUNDED`, so a recovery
session cannot be re-submitted. `recoverSession` queries both chains and only ever returns
a decision, never a resubmission. The general (non-crosschain) `execution.ts` layer has the
same rule via `reconcileUnknownSubmission`.

**Tests.** `11.1` (L1, L2, and post-reveal claim; exactly one submission attempt is ever
made), `11.2`, `23.1`.

---

## INV-9 — Wrong H / S / recipient / network / deadline / output identity fails closed

**Statement.** Every identity input is validated at the boundary it enters, and a
mismatch is a refusal — never a coercion.

| Input | Enforced by | Test |
|---|---|---|
| preimage S | `verifyPreimage` (exact 64 lowercase hex + SHA256 equality), `require32Bytes` in the script verifier | `8.1`, `5.3` |
| hash H | `requireHashHBound` before L2 funding, arming, and reveal; immutable once bound | `8.2`, `14.2` |
| L1 claim identity | re-derived from the observed script (`obs.claimRecipient`) | `6.1` |
| L1 refund identity | re-derived from the observed script, never from the intent | `6.1`, `6.2` |
| network | `assertTestnetNetwork` allowlist at every entry point; mixed l1/l2 pairing refused | `19/20`, `14.1`, `14.3` |
| deadline | exact equality with the observed script **and** freshness ahead of the tip | `6.2`, `15.2` |
| output identity | `obs.exists`, `obs.outputHashHex`, `obs.source !== 'PROVIDER_ASSERTION'` | `10.2`, `17.1` |

---

## INV-10 — Deadline safety margin is recomputed immediately before preimage disclosure

**Enforced by.** `coordinator.ts::resolveDeadlineSafety` + `assertDeadlineSafety` run at
`FIRST_LEG_FUNDING`, `SECOND_LEG_FUNDING`, `CLAIM_ARMED`, and `SECRET_REVEAL`. When a
`DeadlineAuthority` is configured its authoritative read WINS over anything the caller
passes; caller-asserted margins require the explicit `unsafeAllowAssertedDeadlines` opt-in
and are recorded as `deadlineEvidenceSource: 'CALLER_ASSERTED'`.

**Tests.** `15.3` (an authority reporting 1000 ms overrides a caller claiming 999999999 ms;
no authority and no opt-in is refused outright).

**Residual risk.** With `unsafeAllowAssertedDeadlines: true` the margin is, by definition,
an assertion. That flag exists for tests and must never be set in a deployment
configuration (documented in the audit report).

---

## INV-11 — A peer/provider assertion is never sufficient authoritative evidence

**Enforced by.** `L1HtlcObservation.source` is one of `BASE_NODE`,
`WALLET_OUTPUT_MANAGER`, `PROVIDER_ASSERTION`; `verifyL1Funded` refuses
`PROVIDER_ASSERTION`; `applyEvent` refuses to stamp a verification whose `source` is
`PROVIDER_ASSERTION`. The L2 port distinguishes `AUTHORITATIVE` from `CACHED` and refuses
`CACHED`. `minotari_grpc.ts` reports `source: 'BASE_NODE'` only when a readback port is
actually wired, and `capabilities().l1ShaInspect` is `false` otherwise.

**Tests.** `18.1`, `10.2`, `crosschain.test.cjs` "PROVIDER_ASSERTION must never verify".

---

## INV-12 — Normal operation history never contains S

**Enforced by.** S lives only inside `CrossChainSecretStore`; the session record has no
secret field; `assertNoSecretInJson` scans serialized state case-insensitively and across
uppercase/0x/base64 re-encodings; `secret.ts` exposes only `publicPart()` (hash + length).

**Tests.** `9.1` (every durable object serialized and scanned, plus error text).

**Residual risk.** An in-process memory dump or a compromised renderer is out of scope;
production restart-safe encrypted storage is still unimplemented (BLOCKED_EXTERNAL).

---

## INV-13 — Mainnet remains impossible in this phase

**Enforced by.** `assertTestnetNetwork` uses a strict allowlist (`esmeralda`, `localnet`)
in addition to a mainnet substring check; the same allowlist is now used by
`validateAdvertisement`, `acceptQuote`, `routeResult`, and the Minotari provider
constructor.

**Tests.** `19/20` (11 spellings/aliases/numeric ids/null), `14.1`, `14.3`, `21.1`,
`minotari.test.cjs` (mainnet constructor refusal).

---

## INV-14 — Real submission remains OFF by default

**Enforced by.** `isRealSubmitEnabled` requires the environment value to be exactly `'1'`
and always calls `assertTestnetNetwork` first.

**Tests.** `21.1` (unset, empty, `0`, `true`, `TRUE`, `yes`, `on`, `' 1'`, `'1 '`,
`random`, `01` all refuse; mainnet refuses even when enabled).

---

## Additional invariants enforced alongside the required set

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| INV-15 | L1 script bytes must decode to the exact intended semantics; any structural deviation is refused | `minotari.ts::decodeShaHtlcScript` (exact opcode sequence, no trailing bytes, no overlong/u64-escaping varint) | `5.1`, `5.4` |
| INV-16 | A verifier's u64 varint decoding must match the engine's truncation semantics | `minotari.ts::decodeU64Varint` (integer-encoding 3.0.4 parity; non-representable encodings refused) | `5.1` |
| INV-17 | Inventory can never go negative | `reservation.ts::completeRelease` (pre-mutation check) | `13.1` |
| INV-18 | An unfunded, expired reservation must not strand inventory forever | `reservation.ts::expireUnfunded` | `13.2` |
| INV-19 | A stored preimage is immutable for a session | `secret.ts::ingestExternalSecret` (refuses a different preimage) | `9.2`, `23.2` |
| INV-20 | A multi-hop consumer may never infer settlement from funding progress | `router.ts` (`settlementStatus: 'UNSETTLED'`, `composable: false`, `containsSecret: false`) | `31.1` |
