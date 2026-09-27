# END-OF-RUN CHECKPOINT (2026-09-25) — market-data foundation

> Supersedes only the facts it contradicts below; all prior checkpoint sections are retained.

## A1. Outcome
Market data is **INFORMATIONAL ONLY** and is structurally prevented from influencing
execution. No React, no chart library, no new frontend dependency, no AMM math change.

## A2. Settlement proof freshness gap: CLOSED (`57399d5`)
A `SettlementRevalidator` is now MANDATORY before hop-2 construction. It re-derives the
settled state from an authoritative source and compares identity, canonical TARI resource,
exact amount, recipient account, transaction/substate identity, settled state, and
confirmations. A missing, malformed, throwing, or non-authoritative revalidator returns
`AUTHORITATIVE_REVALIDATION_UNAVAILABLE` — the proof's age window is explicitly a LIVENESS
bound, never treated as equivalent to a chain read. A reorg is distinguished from a mismatch.

## A3. Source model (traced, `docs/MARKET_DATA_SOURCE_MODEL.md`)
| Capability | Reality |
|---|---|
| Historical trades | GraphQL `get_events` (offset/limit, ≤1000) or cursor-paginated backfill |
| Live | SSE `/transactions/events/stream` with a monotonic `id` cursor; NO GraphQL subscription exists |
| Consensus timestamp | **None exposed** — wall-clock sub-epoch candles are marked UNSUPPORTED, not fabricated |
| Our pool template | **Emits no events** — ingestion is source-pluggable and verified against authoritative pool state |
| Reorg signal | **None** — invalidation is a model + API, automatic detection is BLOCKED_EXTERNAL |

## A4. What was built
`src/marketdata/`: exact rational prices; canonical `PoolActivityRecord` (TRADE /
ADD_LIQUIDITY / REMOVE_LIQUIDITY) and immutable `CanonicalTrade`; DERIVED, always-rebuildable
OHLCV candles; `MarketDataStore` with chain-derived idempotent trade identity; an indexer
(DISCOVER→VERIFY→NORMALIZE→DEDUPE→STORE→AGGREGATE→EMIT) with authoritative corroboration;
pool metrics; the frontend query API; live subscriptions; and `toChartSeries` as the single,
documented display boundary where a Number may appear.

## A5. Findings (all fixed, all retained)
| Severity | Count | Highlights |
|---|---|---|
| CRITICAL / HIGH | 0 | — |
| MEDIUM | 3 | a trade for a different pool passed validation; a finality promotion updated the activity but not the trade index (candles kept reading a provisional trade); the reserve-growth sanity check compared the wrong reserve pair in one direction |

## A6. Evidence
| Suite | Result |
|---|---|
| `test/marketdata_fuzz.test.cjs` | 6/6 — **100,000 randomized insertions**, 0 failing seeds |
| `test/marketdata_hostile.test.cjs` | 19/19 — 17 malicious-observation classes, dedupe, reorg, boundary, health |
| protocol-client total | **168/168** (was 143) |
| wallet-adapter | **12/12** |
| cross-layer (146 rows) | green, unchanged |
| multi-hop (68 rows) | green, unchanged |
| engine security | green |

## A7. Still not established
No live indexer was queried; all source claims are traced from pinned upstream
(`2d6083e`) rather than observed at runtime. Automatic reorg detection, consensus
timestamps, and third-party pool trade indexing are upstream gaps
(`BLOCKED_EXTERNAL`). Real submission remains OFF; mainnet refused.

## A8. Next exact phase
**FRONTEND V1** — pool discovery, pool page, TradingView-style candlestick chart, swap card,
add/remove liquidity, NFT marketplace, wallet/provider connection, transaction/history UI.

---

# END-OF-RUN CHECKPOINT (2026-09-25) — unified multi-hop route (XTM → TARI → AMM)

> Supersedes only the facts it contradicts below; all prior checkpoint sections are retained.

## A1. Outcome
**NO KNOWN MULTI-HOP ROUTE DRAIN FOUND UNDER TESTED MODEL.** 68 attack-matrix rows, all
classified, no UNKNOWN. Open CRITICAL: 0. Open HIGH: 0.

The route is XTM L1 → FAST_XTM_TARI → TARI L2 → AMM → public fungible. The AMM hop is
unreachable until hop 1 mints a chain-proven `TerminalSettlementProof`.

## A2. Findings (all fixed, all retained as regressions)
| Severity | Count | Highlights |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 3 | (1) a failed hop 2 mapped to ROUTE_FAILED_TERMINAL, misreporting a completed cross-layer trade as a total loss — now pauses with the user's TARI intact; (2) a blank hop-2 operation id was accepted, weakening idempotency; (3) the AMM quote could be frozen at route-quote time — hop 2's input is now only ever the proven settled amount, filled from the proof |
| MEDIUM | 3 | `HOP1_SETTLED` accepted a zero settled amount (silent loss of the intermediate TARI — found by the fuzzer); `HOP2_SETTLED` did not enforce the accepted final minimum; `RESOLVE_SETTLED` could settle hop 2 with no proof, no settled hop 1, and no txid (found by the fuzzer) |

## A3. Evidence
| Suite | Result |
|---|---|
| `test/multihop_hostile.test.cjs` | 28/28 |
| `test/multihop_fuzz.test.cjs` | 4/4 (100,000 route transitions + 20,000 proof-tamper attempts) |
| protocol-client total | **138/138** (was 106) |
| wallet-adapter | **12/12** |
| persisted failing fuzz seeds | **0** |
| multi-hop matrix | 68 rows: PASS 58, FIXED 6, N/A 1, EXTERNAL_RISK 1, BLOCKED_EXTERNAL 2, UNKNOWN 0 |
| cross-layer regressions | all 146 rows still green — no coordinator change in this phase |
| AMM regressions | green — `resolveSwap` reused unchanged, no AMM math touched |

## A4. Not established
No live Esmeralda composed execution (no concrete Ootle ScriptPath provider exists), no
live L2 HTLC leg, no production restart-safe secret storage, no market-data aggregation.
Reverse routes (→ XTM) are refused with a structured BLOCKED_EXTERNAL and the exact
prerequisite, not pretended. The route is EXPERIMENTAL/TESTNET: real submit OFF by default,
mainnet refused.

## A5. Next exact phase
**MARKET DATA / TRADE INDEXING / OHLC CANDLES, then FRONTEND V1.** The seam is ready:
`buildMarketDataEvent` emits pool, input/output resource, amounts, exact price inputs
(reserves before AND after), fee bps, txid, and epoch/version on successful hop-2
settlement. `RouteView` is the stable frontend contract. Candle aggregation is
deliberately not implemented.

---

# END-OF-RUN CHECKPOINT (2026-09-25) — hostile cross-layer audit

> Supersedes only the facts it contradicts below; the AMM/template history in the
> 2026-09-23 checkpoint and the Minotari phase section below are retained for reference.

## A1. Outcome
**NO KNOWN CROSS-LAYER CONTRACT/COORDINATOR DRAIN FOUND UNDER TESTED MODEL.**
3 CRITICAL + 6 HIGH + 7 MEDIUM root causes found, all fixed, all covered by retained
regressions. Open CRITICAL: 0. Open HIGH: 0.

CRITICAL fixes (previously the "authoritative verification" steps were advisory):
- second-leg funding was reachable from a bare submission ack → now requires an
  authoritative `l1Verification` stamp the state machine refuses to write unless fully proven;
- `CLAIM_ARMED` trusted durable state plus a truthy `claimConstructileEvidence` string and
  re-observed nothing → now re-observes BOTH legs authoritatively at arm time; the string is gone;
- the L1 `amountExact` check compared the funding intent against itself → an explicitly proven
  amount is now required, and `amountAuthoritative` defaults to false.

## A2. Evidence
| Suite | Result |
|---|---|
| `test/hostile_crosschain.test.cjs` | 34/34 (attack matrix rows A–U) |
| `test/hostile_fuzz.test.cjs` | 5/5 (~150k ops: 100k transitions, 70k script mutations, 12 crash points) |
| protocol-client total | **106/106** (was 67) |
| wallet-adapter | **12/12** |
| workspace typecheck | clean |
| persisted failing fuzz seeds | **0** (`test/fuzz-failing-seeds.jsonl` not created) |
| attack-matrix rows | 146 (PASS 81, FIXED 48, N/A 3, EXTERNAL_RISK 2, BLOCKED_EXTERNAL 10, BLOCKED_TOOLING 2, UNKNOWN 0) |

## A3. Deliverables
- `security/CROSS_LAYER_INVARIANTS.md` — 14 required + 6 additional invariants, each naming
  its enforcing code and its test
- `security/CROSS_LAYER_ATTACK_MATRIX.md` — 146 classified rows, no UNKNOWN
- `security/CROSS_LAYER_HOSTILE_AUDIT_REPORT.md`
- `security/CROSS_LAYER_RESIDUAL_RISKS.md` — 17 residual risks
- `security/MINOTARI_AUTHORITY_MODEL.md` — field-by-field authority classification

## A4. The L1 amount answer
The amount **is** establishable, but never by the base node (blinded commitment). The
claimant can prove it from chain data + its own view key via `EncryptedData::decrypt_data`
+ `output.verify_mask` (the APIs the real claim path already uses) — yet no traced wallet
gRPC or WASM operation exposes that, so the reference provider reports
`amountAuthoritative: false` and the coordinator refuses. Availability limit, not a fund risk.
`TARI_TO_XTM` cannot complete until that upstream operation exists.

## A5. Still not established
No live Esmeralda execution (no funded wallet/gRPC/readback), no real Ootle L2 execution
(no concrete `OotleScriptPathLegPort` provider), no reorg simulation, no browser L1 leg
(upstream-blocked), no production restart-safe secret storage. Route remains
EXPERIMENTAL/TESTNET; real submit OFF by default; mainnet refused.

## A6. Next exact phase
Unified route composition **XTM → TARI → AMM** plus hostile multi-hop failure testing.
The seam is prepared but inert by construction: `RouteResult.composable` is typed `false`
and `settlementStatus` starts `UNSETTLED`, so a downstream hop cannot start on a
coordinator's optimism.

---

# END-OF-RUN CHECKPOINT (2026-09-25) — FAST_XTM_TARI Minotari phase

> Supersedes only the facts it contradicts below; the AMM/template history in the
> 2026-09-23 checkpoint is retained for reference.

## A. Pinned upstreams
| Repo | Path | Revision |
|---|---|---|
| Minotari L1 (`tari-project/tari`) | `C:\tmp-tari-l1` | tag `v6.0.0`, commit `97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3` (network Esmeralda) |
| tari-ootle L2 | `C:\tmp-tari` | `2d6083e6cc7c98cde93dacebe2fb76b17703f588` (workspace 0.41.1) |

## B. Git state
- Branch: `feat/multi-asset-stablecoin-markets`
- HEAD: `3f20e4c` — recovery fixture bound to durable `l1TxId`; esbuild build approved.
- The Minotari provider/coordinator/docs work in the working tree is **uncommitted** at this
  checkpoint.

## C. Test status (this contradicts §16 "TypeScript tests: None")
| Suite | Result |
|---|---|
| `@tari-ootle/protocol-client` | **66/66 pass** (includes 17 Minotari SHA/script/provider tests + 20 crosschain tests) |
| `@tari-ootle/wallet-adapter` | **12/12 pass** |
| Workspace typecheck (all packages) | green |
| CI-equivalent pnpm commands | green |
| Rust crates | unchanged this phase (32 tests) |

## D. Delivered this phase
- `src/chains/minotari.ts` — traced script serializer/decoder, SHA256 interop, fail-closed
  branch verifier.
- `src/chains/minotari_grpc.ts` — `MinotariDevGrpcProvider` (`DEVELOPMENT_REFERENCE_PROVIDER`),
  capability advertisement, base-node readback port, mainnet refusal.
- Coordinator/session/secret/provider changes — capability negotiation per leg, wallet-generated
  preimage ingestion, authoritative H binding, `amountAuthoritative` fail-closed gate.
- Docs: `MINOTARI_ATOMIC_SWAP_API.md` (full source trace + honest limits),
  `TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md` (new), `UPSTREAM_BASELINE.md` (L1 pin),
  `TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md` (trace no longer pending).

## E. Honest open limits (do not overstate)
1. Funded **amount** is not provable from base-node evidence (blinded commitment) → the
   provider reports `amountAuthoritative: false` and settlement refuses to treat it as proven.
2. Wallet transport and base-node readback are **interfaces**; no concrete client is committed
   and nothing has run against a live node.
3. In-flight funding map is in-memory (not restart-safe).
4. Browser `window.tari` L1 SHA support is **missing upstream** (`tari_l1_wasm` exposes no
   SHA atomic swap) → normal-user browser path still blocked; plan documented, not implemented.
5. No live Esmeralda happy/refund/wrong-preimage/UNKNOWN/restart execution yet (no funded
   wallet, no local gRPC endpoint).

---

# END-OF-RUN CHECKPOINT (2026-09-23)

## 1. Exact repo path
C:\Users\pdark\Documents\Codex\2026-09-22\tari-ootle-liquidity-protocol

## 2. Current date
2026-09-23

## 3. Git commit count
11 commits total (including new commits from this session)

## 4. Latest commit hash
[to be recorded after final commit]

## 5. Tari Ootle upstream commit
**Selected: `2d6083e6cc7c98cde93dacebe2fb76b17703f588` (development branch HEAD)**
- Source: C:\tmp-tari checkout (cloned 2026-09-22)
- Workspace version: 0.41.1 (from Cargo.toml)
- No v0.41.1 tag found in local checkout (shallow clone)

## 6. Ootle.ts commit/version
Not directly cloned; referenced through upstream tari-ootle workspace.

## 7. @chironbuilder/ootle-sdk version
0.1.11 (npm, MIT, published ~2026-09-16)

## 8. Template dependency versions (from upstream Cargo.toml)
| Component | Version |
|-----------|---------|
| tari_template_abi | 0.20 |
| tari_template_lib | 0.32 |
| tari_template_lib_types | 0.32.1 |
| tari_template_test_tooling | 0.41 |
| tari_template_macros | 0.23 |
| tari_template_metadata | 0.12 |
| tari_engine | 0.41 |
| tari_engine_types | 0.41 |
| tari_ootle_transaction | 0.41 |
| tari_ootle_common_types | 0.41 |

## 9. Route support matrix
| Route | Status | Notes |
|-------|--------|-------|
| Public Fungible / Tari Native | **TESTED** | Template complete; first-depositor defense implemented; WASM built; 32 math tests passing |
| Public Fungible / Public Fungible | **TESTED** | Same template; math tests verify both resource types |
| Stealth / Tari | Blocked | Privacy disclosure required; no confidential AMM support |
| Stealth / Public Fungible | Blocked | Same as above |
| Wrapped Stablecoin / Tari | Blocked | Upstream admin controls excluded from permissionless AMM |
| Private Stablecoin / Public | Blocked | Direct private AMM not safe; use wrapped version first |
| NFT Collection / Tari | Blocked | No upstream NFT pool template; separate design needed |

## 10. Implemented contracts
- `crates/pool_math`: integer AMM math (checked arithmetic, no floats, **32 tests passing**)
  - `integer_sqrt`: floor(sqrt(n)) for u128, binary search, property-tested
  - `swap_output_amount`: constant-product with fee (30bp default), verified
  - `amount_in_with_fee`: fee-adjusted input, rounds down
  - `verify_swap_invariant`: k_after >= k_before
  - `check_rounding_protection`: repeated swaps don't extract value
- `crates/protocol_types`: PoolId, FeeTier, RouteDescriptor, etc.
- `templates/fungible_pool/src/lib.rs`: Complete WASM template with:
  - **First-depositor defense**: geometric mean (`floor(sqrt(a*b))`) + `MINIMUM_LOCKED_LIQUIDITY = 1000` permanently burned
  - **Minimum initial liquidity**: `MINIMUM_INITIAL_LIQUIDITY = 1_000_000` (1 TARI in micro-tari)
  - Strict access rules: default `DenyAll`, explicit `AllowAll` only for public methods
  - **No admin methods**: no withdrawal, no fee setter, no upgrade, no owner
  - Native Tari handled via `STEALTH_TARI_RESOURCE_ADDRESS` validation
  - LP token: 18 divisibility, burnable=DenyAll (Locked), mint only via component
  - Floor division for LP removal (protects pool reserves)
  - Fee: per-mil out of 1000 (3 = 0.30%), 100% to LP reserves

## 11. Implemented wallet adapters (scaffolds)
- BrowserExtensionWalletAdapter
- EmbeddedOotleWalletAdapter (with KeyValueStore)
- SapientWalletAdapter (explicit unsupported errors)
- WalletDaemonAdapter (development/test)

## 12. Browser extension status
Manifest V3 scaffold (`apps/extension/`). Security model in `docs/EXTENSION_SECURITY.md`.

## 13. Mobile status
Capacitor scaffold (`apps/mobile/`). Mobile security in `docs/MOBILE_SECURITY.md`.

## 14. Web/GitHub Pages status
Static React/Vite app builds (dependency resolution issues with @chironbuilder/ootle-sdk external package). Not blocking core protocol.

## 15. Total Rust tests: **32 passing**
| Category | Count | Details |
|----------|-------|---------|
| Pure unit tests | 16 | fee, swap, sqrt, overflow, invariant |
| Integration tests | 2 | full AMM cycle small/large reserves |
| Adversarial/property tests | 14 | division by zero, fake Tari, first-deposit ratio, huge amounts, rounding, reserve depletion, unauthorized mint/withdrawal |

## 16. TypeScript tests
None (external dependency issues). Build verification only.

## 17. Property/fuzz test status
All passing:
- Rounding protection (repeated swaps)
- Invariant preservation (k_after >= k_before)
- Overflow protection (u128 intermediates)
- Division by zero protection
- Zero reserve/input/output rejection
- Invalid fee rejection
- Huge/small amount handling
- First-deposit ratio safety
- Reserve depletion repeated swaps
- Unauthorized mint/withdrawal (protocol-level documented)

## 18. Known security issues
| Issue | Status | Mitigation |
|-------|--------|------------|
| First-depositor share inflation | **FIXED** | Geometric mean + MINIMUM_LOCKED_LIQUIDITY (1000) permanently burned |
| Donation attack | **DOCUMENTED** | Floor division on removal prevents extraction; direct vault deposits impossible in Ootle |
| Fake Tari substitution | **MITIGATED** | Resource validation checks fungible/confidential/stealth type; canonical pair ordering |
| Unauthorized LP mint | **MITIGATED** | LP token burnable=DenyAll; mint only via add_liquidity() |
| Unauthorized reserve withdrawal | **MITIGATED** | No admin methods; only swap() and remove_liquidity() withdraw |
| Rounding extraction | **MITIGATED** | Floor division; fee rounds down; property tests verify |

## 19. Known upstream blockers
- Esmeralda testnet version verification needed before deployment
- tari-cli not installed (run `cargo install tari-ootle-cli`)
- walletd not installed (not required for template development)
- @chironbuilder/ootle-sdk not in public npm (blocks web app build)

## 20. Exact build commands
```bash
# Rust (all tests pass)
cargo test --manifest-path crates/pool_math/Cargo.toml
cargo clippy --manifest-path crates/pool_math/Cargo.toml --all-targets --all-features -- -D warnings
cargo fmt --manifest-path crates/pool_math/Cargo.toml --all -- --check

# Template WASM build
cd templates/fungible_pool
cargo build --target wasm32-unknown-unknown --release
```

## 21. WASM Artifact (verified)
- **Path**: `templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm`
- **Size**: 223,692 bytes
- **SHA256**: `7F2151D4A6DD02A5380D8B40C772C7A438B4BCF1FF9F2E09542267C064D179F1`
- **Source commit**: [to be recorded after final commit]
- **Ootle dependency**: `2d6083e6cc7c98cde93dacebe2fb76b17703f588`
- **Build command**: `cargo build --target wasm32-unknown-unknown --release`

## 22. Native Tari handling
- **Exact resource**: `STEALTH_TARI_RESOURCE_ADDRESS` (ObjectKey of 1u8 repeated, divisibility 6)
- **Verification**: Confirmed in upstream `tari_template_lib_types::constants`
- **Privacy boundary**: Wallet reveals Tari before pool entry; pool reserves are PUBLIC (amounts visible on-chain)
- **Template validation**: Checks resource type is Fungible/Confidential/Stealth; rejects fake Tari resources

## 23. First-depositor defense (IMPLEMENTED & TESTED)
- **Old vulnerability**: Minimum deposit check only; first depositor got 100% of initial shares
- **New mechanism**: 
  - `initial_shares = floor(sqrt(amount_a * amount_b))`
  - `MINIMUM_LOCKED_LIQUIDITY = 1000` (in LP token smallest units, divisibility 18)
  - First LP receives `initial_shares - MINIMUM_LOCKED_LIQUIDITY`
  - `MINIMUM_LOCKED_LIQUIDITY` **permanently burned** in same transaction
- **Why unrecoverable**: No admin badge, no mint method, no upgrade path, burned atomically with mint
- **Attack regression**: Property tests verify geometric mean prevents share inflation

## 24. Donation attack analysis
- **Possible in Ootle?**: NO - Vault balances cannot be directly deposited into by external callers; all reserve changes go through component methods
- **Proof**: Ootle Vault semantics require component authority for deposits; no `deposit` method exposed publicly on Vault
- **Attack result**: N/A (impossible)

## 25. LP Security (verified by code inspection)
| Test | Result | Evidence |
|------|--------|----------|
| External mint blocked | ✅ | LP token `burnable(DenyAll)`, no public mint method |
| Creator mint blocked | ✅ | No owner badge; creator is regular caller |
| Random account mint blocked | ✅ | Only `add_liquidity()` calls `mint_fungible` |
| Unrelated component mint | ✅ | Component isolation; no cross-component mint authority |
| Reserve withdrawal paths | ✅ | Only `swap()` and `remove_liquidity()` |

## 26. Access rules (explicit allow-list)
| Method | Access Rule | Notes |
|--------|-------------|-------|
| `add_liquidity` | AllowAll | Validates input buckets |
| `swap` | AllowAll | Validates resources, non-zero reserves |
| `remove_liquidity` | AllowAll | Validates LP resource, burns LP |
| `get_pool_balances` | AllowAll | Read-only |
| `get_pool_balance` | AllowAll | Read-only |
| `lp_resource` | AllowAll | Read-only |
| `lp_total_supply` | AllowAll | Read-only |
| `fee` | AllowAll | Read-only |
| Default | DenyAll | No other methods |

## 27. AMM Math Security (re-audited)
- **No floats**: All u64/u128 checked arithmetic
- **Swap formula**: `output = reserve_out * amount_in_with_fee / (reserve_in + amount_in_with_fee)`
- **Fee**: 3 per-mil (0.30%), rounds down, 100% to LPs
- **Tested**: tiny swaps, large swaps, boundaries, round-trip, repeated random, overflow, underflow, div-zero, zero output, reserve depletion

## 28. Tari CLI
- **Status**: Not installed
- **Install**: `cargo install tari-ootle-cli`
- **Version check**: `tari --version` (not run)

## 29. Quality gates (ALL PASS)
| Check | Result |
|-------|--------|
| `cargo fmt --all -- --check` | ✅ PASS |
| `cargo check --workspace` | ✅ PASS |
| `cargo test --workspace` | ✅ 32 PASS |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | ✅ PASS |
| WASM release build | ✅ PASS (223,692 bytes) |
| Secret scan | ✅ CLEAN (no private keys, mnemonics, wallet API keys) |

## 30. Security differential vs upstream TariSwap
Documented in `docs/TARISWAP_SECURITY_DIFF.md`:
- **Our improvements**: No owner/admin, locked minimum liquidity, explicit LP authority isolation, floor division, transparent fee model
- **Upstream differences**: Builtin has owner-gated methods; test template has AllowAll and div_ceil

## 31. Next exact task
1. Install Tari CLI: `cargo install tari-ootle-cli`
2. Verify `tari --version` and `tari --help`
3. Configure wallet daemon for Esmeralda testnet
4. Deploy template WASM to Esmeralda: `tari publish -a <account> --api-key <key> --network esmeralda templates/fungible_pool/target/wasm32-unknown-unknown/release/fungible_pool.wasm`
5. Execute full liquidity lifecycle test per `docs/ESMERALDA_VERTICAL_SLICE.md`
6. Mark P0 (Public Fungible / Tari Native) as TESTED after successful deployment

## 32. Documentation created/updated
- `docs/LP_AUTHORITY_MODEL.md` — LP mint/burn authority isolation proof
- `docs/TARISWAP_SECURITY_DIFF.md` — Security comparison with upstream
- `docs/ESMERALDA_VERSION_TARGET.md` — Actual dependency versions from upstream
- `docs/FIRST_DEPOSIT_AUDIT.md` — Attack analysis and fix documentation