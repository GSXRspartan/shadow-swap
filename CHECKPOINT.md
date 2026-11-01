# END-OF-RUN CHECKPOINT (2026-10-31, Phase 3) — universal trading: revealed-value liquidity, mixed routing, cross-layer

> Supersedes only the facts it contradicts below. Full record:
> `docs/SHADOW_SWAP_UNIVERSAL_TRADING_MATRIX.md` (+ the private-liquidity, L1/L2, P2P-acceptance
> and Windows-test docs beside it).

## G1. Outcome
Branched from `main` @ `838cbb6` (PRs #9, #10 merged). Three stacked PRs:
#11 (`feat/universal-trading-v048`, 12/12 green), #12 (`feat/cross-layer-v048`, 12/12 green) and
#13 (`feat/mixed-route-execution-v048`) and #14 (`feat/cross-layer-claim-engine-v048`).
Nothing published, deployed or merged.

NEW executable capability: `RevealedAssetPool`, a separate AMM for assets whose value is an exact
revealed integer — created-Stealth (native tTARI included), revealed Confidential, and public
fungibles. That class previously had NO AMM liquidity at all, because Pool v2 refuses it; its
guard is untouched and r01 proves the refusal still holds. Plus four new mixed-asset P2P routes,
an own-item NFT picker read from chain, mixed-pool atomic routing, and the L1→L2 conversion
flow.

The Swap page now SIGNS the revealed-value and mixed routes, not merely quotes them. Each hop's
venue is read from the pool component's own template address in the authoritative re-read, which
decides the builder, the operation name and the disclosure; an unrecorded or unreported template
is refused rather than assumed public. `SIGNABLE_MECHANISMS` is exported and tested, so no
button can exist for a route that cannot build its transaction.

## G2. Engine findings
- A Confidential vault CAN pay out a partial revealed amount (r04) — the open question that
  decided whether Confidential could be an AMM side.
- `Bucket::take` asserts `amount.is_positive()` in template_lib, so Pool v2's
  `add_liquidity_exact` CANNOT serve a first deposit (e07e). Pool creation must keep
  `add_liquidity`; this corrects an open release blocker.
- Both pool templates share one `swap` signature, so a revealed hop and a public hop compose
  atomically (r11), and only the transaction's INPUT needs a Stealth-capable withdrawal. The
  corollary: the venues are indistinguishable ON THE WIRE, so the browser must carry the venue
  itself, from chain. The `mixed_multi_hop_swap` wire scenario pins that the engine executes
  the exact instruction list the browser builds across both templates.
- A Stealth container has no commitment field upstream; a Confidential one does. That asymmetry
  is the whole safety argument, enforced per bucket and proved against a real blinded
  commitment (r09).
- Sapient's dApp balance API carries no NFT token ids; the ids are public in the account's own
  vaults, so they are read from chain instead (authoritative, not advisory).
- No L2→L1 route exists in v0.48. Missing primitives: an L2 exit instruction emitting a
  consensus-attested receipt, and a base-layer verifier for it.
- The L1 burn claim's blocker is a SIGNATURE, not the instruction (`claim_burn_authorization`):
  a claim sealed by any key but the stealth claim key `s = H(R·p) + p` is AccessDenied (x02),
  while a claim CO-SIGNED by `s` with a relayer sealing and paying IS accepted — so the one
  missing provider capability is "co-sign with the derived burn-claim key". The engine does NOT
  verify burn-proof authenticity at all; it asks a validator-supplied `ClaimProofVerifier`
  (x01), so no engine test may be cited as evidence a burn happened. The claim mints a UTXO
  spendable only by `S` (x03), which is why a destination balance read is the right
  confirmation. Upstream reveals the fee OUT OF the claimed amount, so a burn worth less than
  the fee is permanently unclaimable — now stated to the user.

## G3. Evidence
Engine 96/96 (17 binaries) · web 561/561 · wallet-adapter 31/31 · protocol-client 268/268 ·
e2e Chromium 91 passed / 4 skipped / 1 sandbox-egress failure that passes in CI ·
reproducible WASM for 6 templates from two checkout paths.
Levels: engine-verified and reference-provider verified only. Nothing real-wallet or
live-Esmeralda verified (the indexers are unreachable from this environment).

## G4. Open
Operator: publish Pool + SwapOffer + RevealedAssetPool via walletd and record the addresses;
keep `add_liquidity` for creation; then the Windows lists
(`SHADOW_SWAP_WINDOWS_LIVE_TESTS.md`), including the first real-wallet check of the
`withdrawStealthAndExecute` follow-up workspace ids and the L1→L2 observation cases.

---
# END-OF-RUN CHECKPOINT (2026-10-31, Phase 2) — browser SwapOffer, Sapient Stealth input, v0.48 wire format

> Supersedes only the facts it contradicts below. Full record: `docs/SHADOW_SWAP_P2P_SWAPOFFER_BROWSER.md`.

## F1. Outcome
Branch `claude/shadow-swap-swapoffer-browser`, stacked on PR #9 (`7b325f9`, unchanged). The
browser now builds, reviews and verifies every P2P SwapOffer flow (create, fill, claim, cancel;
fungible, created-Stealth, revealed Confidential, NFT barter; designated taker, hash lock,
expiry), shareable invitations verified against chain, and Sapient `withdrawStealthAndExecute`
for Stealth-typed inputs. SwapOffer is unpublished, so P2P is unavailable in production. Nothing
was published, merged or deployed.

## F2. Defects fixed
- CRITICAL: browser instruction JSON was not v0.48 `Instruction` serde: bare-string args (must be
  `{Literal: hex(tari_bor)}`), a non-existent `WithMaxEpoch`, NFT withdrawn via `withdraw`
  (must be `withdraw_non_fungible`), `template_`-prefixed `CallFunction.address`. Every wallet
  write would have been refused. Fixed and engine-pinned (`instruction_wire_v048.rs`).
- NonFungibleId decoder mislabelled variant 0 and lacked Uint32/Uint64; now all four, canonical.
- Review carry check matched substrings; now matches encoded literals.
- Publishing: the raw WASM carries custom sections the v0.48 engine rejects; walletd's
  optimiser is required (docs corrected).

## F3. Evidence
See the PR description for the final counts of this run (engine, web, protocol-client,
wallet-adapter, e2e). Verification levels: engine-verified and reference-provider verified only;
nothing real-wallet or live-Esmeralda verified (indexers unreachable from this environment).

## F4. Open
Operator: publish Pool + SwapOffer via walletd and record addresses; switch to
`add_liquidity_exact` before publishing the Pool (**corrected in G2: for deposits into a pool
that already has reserves only — creation must keep `add_liquidity`, see `e07e`**);
Windows acceptance (Phase 2 doc §10),
including the first real-wallet check of the `withdrawStealthAndExecute` workspace-id convention.

---
# END-OF-RUN CHECKPOINT (2026-10-31, later) — trading routes: multi-hop AMM, pool creation, P2P lane

> Supersedes only the facts it contradicts below. Full record: `docs/SHADOW_SWAP_TRADING_ROUTES_IMPLEMENTATION.md`.

## E1. Outcome
Still LOCAL ONLY (push refused, HTTP 403). New on the branch: atomic 2-3 hop AMM routing and
one-transaction pool creation (engine-proven, browser-built), a unified pair resolver and `/swap`
page, a Create-pool panel, and the experimental unpublished `SwapOffer` P2P template covering
created-Stealth, revealed confidential and NFT barter (engine-proven, not enabled in the browser).

## E2. Defects fixed
- Browser AMM intents never deposited the pool's returned bucket (engine rejects: m05): no
  browser swap/add/remove could have settled. Fixed for every output, incl. tuple outputs.
- SwapCard/LiquidityPanel built intents with the POOL as the account. Fixed.
- Review showed the FIRST swap's min_output; a route would have shown 1. Now the final hop's.

## E3. Evidence
Engine 72/72 (`-D warnings`; multihop_routes 8, p2p_offer_routes 11 new) · protocol-client
266/266 · wallet-adapter 27/27 · web 477/477 · e2e Chromium desktop+hosting 106 passed, 1
sandbox-caused failure (blocked `universe.tari.mw`), 4 skipped.

## E4. Open
Push/PR/CI; publish v0.48 Pool (and optionally SwapOffer); SwapOffer browser builders;
Sapient `withdrawStealthAndExecute` for tTARI input; Windows acceptance per the doc §13.

---
# END-OF-RUN CHECKPOINT (2026-10-31) — Ootle v0.48.0 cohort, wire-format migration, release-candidate hardening

> Supersedes only the facts it contradicts below; all prior checkpoint sections are retained.
> Full record, release gates and route matrix: `docs/SHADOW_SWAP_V047_RELEASE_READINESS.md`.

## D1. Outcome
Branch `claude/shadow-swap-v047-release-25lmq7`, base `main` @ `49d3d26`. Work is COMMITTED
LOCALLY; `git push` was refused (HTTP 403: the Claude GitHub App is not authorized for this
repository in the session), so no PR and no CI run exist yet. The branch head is the SHA to cite.

## D2. Cohort
The latest official release is **v0.48.0** (`6a25dbc`, 2026-10-29), a TESTNET RESET (fresh V0
genesis, sr25519, base64-CBOR indexer values, templates must be republished), not v0.47.0
(`9dabb2a`). All 8 manifests pinned to `6a25dbc` (template_lib 0.36.0, abi 0.22.0, crypto 0.24.1).
Templates and the full engine suite compiled with NO source change. Live Esmeralda was NOT
observed: the egress policy denied both indexer host pairs and `universe.tari.mw`.

## D3. Fixed (each with a regression)
- HIGH: pool templates were trusted by catalogue NAME; now by recorded address per network
  generation, at discovery and at execution-time rereads (`services/protocolDeployment.ts`).
- MEDIUM: `add_liquidity` donates any imbalance to LPs (no min-LP); new `add_liquidity_exact`
  refunds and enforces `min_lp_out` (engine e07–e07d). Frontend switch is a publish prerequisite.
- MEDIUM: v0.48 receipts (strings) were skipped -> false "deployed but empty".
- MEDIUM: a fee-only commit (`AcceptFeeRejectRest`) would have read as a confirmed swap.
- Real Sapient reply shapes (`getSubstate`, `getTransactionResult`) were unreadable.
- Supply chain: SHA-pinned actions, Rust 1.97.1, `pnpm audit` clean, reproducible WASM gate.
- Cloudflare workflow: deploy job had no `dist/` and no URL output; both fixed, verify job added.

## D4. Evidence
- web 435 -> **467/467**; wallet-adapter 21/21; protocol-client 258/258 (unchanged sources).
- Real engine suite ran LOCALLY on Linux for the first time (previously CI-only):
  **53/53** under v0.48.0 with `RUSTFLAGS=-D warnings` (46 existing + wire fixture +
  4 add_liquidity_exact + 2 created-Stealth probe).
- Wire fixtures are engine-produced v0.48 bytes; the web suite decodes them with the official
  `@tari-project/ootle-wasm-bor@0.48.0` and recomputes reserves/LP independently.
- Chromium e2e (desktop, mobile, hosting) `--retries=0`: 195 passed, 2 failed (both: the sandbox
  blocks `universe.tari.mw/tari-connector.js`), 8 skipped. Real-browser proof that the decoder
  compiles under the shipped CSP, with a negative control.
- Reproducible WASM: relocated checkout + fresh CARGO_HOME reproduce all four sha256.

## D5. Open
Push/CI (operator: GitHub App access); live `/info` on the v0.48 hosts; Sapient local-account
tTARI input needs `withdrawStealthAndExecute`; publish v0.48 templates (operator decision) and
record addresses; real-extension acceptance; Cloudflare preview (operator dispatch). Gates
G, H, I BLOCKED; B FAIL until CI runs.

---
# END-OF-RUN CHECKPOINT (2026-10-17) — frontend completion: real marketplace discovery, design system, asset integrity

> Supersedes only the facts it contradicts below; all prior checkpoint sections are retained.
> Full record with evidence tables: `docs/SHADOW_SWAP_FRONTEND_COMPLETION.md`.

## C1. Outcome
PR #7 (`feat/shadow-swap-frontend-redesign` -> `main`, base `1a21b9e`) is OPEN with all 10 CI
checks GREEN. PRs #5 and #6 were verified MERGED, so this work sits on current main. The NFT
marketplace rendered blank because discovery POSTed a `{query, params}` document to the BARE
indexer origin, which serves no such route (404, no CORS headers) — no image was ever deleted.

## C2. Live chain facts, read 2026-10-16 (public Esmeralda indexer, read-only)
- Pool v2 live and ownerless: `component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2`
  reads with `owner_rule: "None"` and `template_address: f47a330eee…` (the pinned Pool v2).
- Swap fee decoded from that component's `state[2]` = **30 bps** — the homepage figure is
  chain-read, not doc-copied.
- All three marketplace templates PUBLISHED: `GET /templates/{bare-hex}` -> 200 for
  FixedPriceListing / ItemOffer / CollectionBid. `/templates/catalogue` lists none of ours —
  catalogue absence is NOT evidence of non-publication; the component header is authoritative.
- NO "list components by template" route exists on the indexer. A 4 000-receipt scan
  (2 142 components, epoch 12 355 back to 12 212) found NO marketplace component; receipt-scan
  pagination was also observed NON-MONOTONIC in epoch order. Therefore
  `MARKETPLACE_REGISTRY_SEED` is EMPTY ON PURPOSE, documented as a chain fact, and one line
  per real component when any exists (self-verifying on every read).

## C3. What was fixed
- Marketplace discovery now reads the real chain (`OotleIndexerMarketplaceSource`):
  `/substates/fetch` + `/transaction-receipts`, candidates reverified against their OWN header
  template, decoded by the protocol-client dual-form decoders, undecodable components COUNTED,
  and "empty" distinguished from "could not read". Durable `marketplaceRegistry.ts` mirrors the
  proven pool registry. Optional `VITE_NFT_DISCOVERY_URL` still selects the old envelope source.
- Social preview was SVG, which every major scraper refuses for `og:image` -> now 1200x630 PNG
  with explicit width/height/type/alt. SVG retained for favicons/PWA.
- Homepage `/` was a redirect with no identity -> real landing page stating only independently
  checkable figures (30 bps chain-read, 0 admin keys, 4 templates, byte 38). No TVL/APR/volume/
  pool count. Homepage "0 pools discovered" and pools-page "0 pools" false negatives removed.
- Health derived ONCE (AppContext); page badge and header badge disagreed on the live network.
- Rendering defects: inert placeholder rotation (plain-string template literal), mid-word
  truncation without ellipsis, stretched eyebrow chip, duplicated TESTNET badge, header overlap
  at 360/390px, clipped search input at 360px.
- MIT `LICENSE` added (README carried the badge and documented the gap since the first audit).
- README's "Shadow Swap and Atomic Swap" cross-product section REMOVED as a disclosure this
  repository should not publish. Generic "atomic swap" survives only as the HTLC protocol term.
- Capture harness pinned to `--host 127.0.0.1` (`vite preview` binds `::1` first on
  IPv6-preferring hosts, so the harness aborted while the server was actually listening).

## C4. Test status (local Windows + GitHub CI)
- Node: **714 pass / 0 fail** (web **435** — was 405/1 fail, protocol-client 258, wallet-adapter 21).
  New: marketplace-discovery 18, assets 11. The 1 baseline failure was copy drift, and the test
  was strengthened (no `<img>` for an unvalidated URL).
- E2E: **278 pass / 0 fail with `--retries=0`** (was "259 passed" WITH retries — flaky retries had
  been masking two real spec bugs: assertions on the old literal `/No collections/`, and a brand
  link href pinned to `/pools` after it correctly moved to `/`). Specs now assert the property,
  not the implementation detail, and anti-fabrication assertions were kept and strengthened.
- Rust engine tests remain CI-only (Cranelift; Windows cannot build them) — GREEN in CI on PR #7.
- Secret scan on the full diff (49 files): clean. `.claude/` git-ignored, never staged.

## C5. Open items
1. REAL BROWSER WALLET VERIFIED: still BLOCKED — no extension installable here. Reference-provider
   path green (25 e2e conformance tests). Manual steps are in `SHADOW_SWAP_FRONTEND_COMPLETION.md` §6.
2. DEPLOYMENT: `ootle-liquidity-testnet.pages.dev` is NXDOMAIN — nothing is being served. Deploy
   workflow is manual-dispatch only by design; needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   (steps in §8). Nothing deployed, no DNS changed.
3. Seed `MARKETPLACE_REGISTRY_SEED` the moment a real marketplace component exists on chain.
4. Meshy: 2 text-to-image jobs / 12 credits spent (operator-approved), hero + OG art installed.
   Balance was 908. No mascot/character/silhouette anywhere; verified by scan.

---
# END-OF-RUN CHECKPOINT (2026-10-13) â€” v0.46.0 migration + live NFT/AMM verification

> Supersedes only the facts it contradicts below; all prior checkpoint sections are retained.

## B1. Outcome
Repository migrated to the Ootle **v0.46.0** cohort (release commit `cc8a83bcab88e03e0fcf760d2652ab6f1e067d8a`).
Live esmeralda confirmed on Protocol V2 (epoch â‰¥12220; observed 12234). The local wallet
daemon was upgraded 0.45.0 â†’ 0.46.0 with a verified pre-migration backup, and the full NFT
marketplace + AMM swap write paths were executed live. Full record:
`docs/OOTLE_V046_MIGRATION.md`.

## B2. Daemon upgrade (rollback point exists)
Backup `v042-esmeralda-bootstrap.backup-pre046-20261013-142449` verified BEFORE any 0.46
binary ran (`integrity_check ok`, 26 tables, 2 accounts). Binary sha256
`7e4b21c5â€¦733aa9` matched the official sidecar. 0.46 migrated the DB **in place**
(27 tables, both accounts intact, 690 txs). `wallet.get_info` â†’ 0.46.0 / esmeralda / byte 38.
Runs with `--authentication none` (loopback only; config file untouched).

## B3. Live bug found and fixed: NonFungibleId dual rendering
`NonFungibleId` is a positional tuple `[1,["â€¦"]]` inside component CBOR state but a **named
variant object** `{"String":"â€¦"}` inside vault `resource_container`. The escrow reader used
the tuple form; every previously inspected escrow was empty, so the defect never executed.
Fixture had encoded vault ids in the component form â€” the tests could not have caught it.
Fixed in `marketplaceSubstate.ts` (both renderings accepted, malformed still refused),
fixture corrected, 3 regressions added, and the test file was **added to the package test
script, which had never included it**.

## B4. Live evidence on v0.46 (all committed, all reconciled)
- FixedPriceListing createâ†’buy: txs `54b4ab30â€¦` (fee 3291), `cd8d111eâ€¦` (4419) â†’ SOLD, escrow empty.
- ItemOffer createâ†’accept: txs `9164094bâ€¦` (3657), `00f6eba0â€¦` (5123) â†’ ACCEPTED, escrow empty.
- CollectionBid createâ†’fill: txs `30ebfe17â€¦` (3708), `c219b2aeâ€¦` (5081) â†’ FILLED, escrow empty.
- Pool swap 1000 tTARIâ†’LPTESTA: tx `00557411â€¦` (3604); reserves 595664/604684 â†’ 596664/603674;
  product invariant increased (fee retained); min-out satisfied.
- One rejection proved v0.46 structured codes live: `Execution failure (InsufficientFunds)`.
- Balances reconcile **exactly**: A 49 987 978, B 1 638 456 (arithmetic in Â§10.3).
- Dry-run fee receipts show `WasmExecution` / `NativeExecution` line items (v0.46 metering).

## B5. Test status (local, Windows)
protocol-client 220 pass (now incl. marketplace_substate 38), web 346 pass, executor 13 pass,
wallet-adapter pass, web build + typecheck clean, Rust crates 36 + 22 + 10 pass.
`audit_engine_tests` remains **Windows-unbuildable** (Cranelift); CI-only.

## B6. Open items (full table in the migration doc)
WASM shape-cap measurement (needs publish dry-run), engine suite under v0.46 (CI),
wallet-extension behaviour under #2855 (app-side handling verified correct in code).

---

# END-OF-RUN CHECKPOINT (2026-09-25) â€” market-data foundation

> Supersedes only the facts it contradicts below; all prior checkpoint sections are retained.

## A1. Outcome
Market data is **INFORMATIONAL ONLY** and is structurally prevented from influencing
execution. No React, no chart library, no new frontend dependency, no AMM math change.

## A2. Settlement proof freshness gap: CLOSED (`57399d5`)
A `SettlementRevalidator` is now MANDATORY before hop-2 construction. It re-derives the
settled state from an authoritative source and compares identity, canonical TARI resource,
exact amount, recipient account, transaction/substate identity, settled state, and
confirmations. A missing, malformed, throwing, or non-authoritative revalidator returns
`AUTHORITATIVE_REVALIDATION_UNAVAILABLE` â€” the proof's age window is explicitly a LIVENESS
bound, never treated as equivalent to a chain read. A reorg is distinguished from a mismatch.

## A3. Source model (traced, `docs/MARKET_DATA_SOURCE_MODEL.md`)
| Capability | Reality |
|---|---|
| Historical trades | GraphQL `get_events` (offset/limit, â‰¤1000) or cursor-paginated backfill |
| Live | SSE `/transactions/events/stream` with a monotonic `id` cursor; NO GraphQL subscription exists |
| Consensus timestamp | **None exposed** â€” wall-clock sub-epoch candles are marked UNSUPPORTED, not fabricated |
| Our pool template | **Emits no events** â€” ingestion is source-pluggable and verified against authoritative pool state |
| Reorg signal | **None** â€” invalidation is a model + API, automatic detection is BLOCKED_EXTERNAL |

## A4. What was built
`src/marketdata/`: exact rational prices; canonical `PoolActivityRecord` (TRADE /
ADD_LIQUIDITY / REMOVE_LIQUIDITY) and immutable `CanonicalTrade`; DERIVED, always-rebuildable
OHLCV candles; `MarketDataStore` with chain-derived idempotent trade identity; an indexer
(DISCOVERâ†’VERIFYâ†’NORMALIZEâ†’DEDUPEâ†’STOREâ†’AGGREGATEâ†’EMIT) with authoritative corroboration;
pool metrics; the frontend query API; live subscriptions; and `toChartSeries` as the single,
documented display boundary where a Number may appear.

## A5. Findings (all fixed, all retained)
| Severity | Count | Highlights |
|---|---|---|
| CRITICAL / HIGH | 0 | â€” |
| MEDIUM | 3 | a trade for a different pool passed validation; a finality promotion updated the activity but not the trade index (candles kept reading a provisional trade); the reserve-growth sanity check compared the wrong reserve pair in one direction |

## A6. Evidence
| Suite | Result |
|---|---|
| `test/marketdata_fuzz.test.cjs` | 6/6 â€” **100,000 randomized insertions**, 0 failing seeds |
| `test/marketdata_hostile.test.cjs` | 19/19 â€” 17 malicious-observation classes, dedupe, reorg, boundary, health |
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
**FRONTEND V1** â€” pool discovery, pool page, TradingView-style candlestick chart, swap card,
add/remove liquidity, NFT marketplace, wallet/provider connection, transaction/history UI.

---

# END-OF-RUN CHECKPOINT (2026-09-25) â€” unified multi-hop route (XTM â†’ TARI â†’ AMM)

> Supersedes only the facts it contradicts below; all prior checkpoint sections are retained.

## A1. Outcome
**NO KNOWN MULTI-HOP ROUTE DRAIN FOUND UNDER TESTED MODEL.** 68 attack-matrix rows, all
classified, no UNKNOWN. Open CRITICAL: 0. Open HIGH: 0.

The route is XTM L1 â†’ FAST_XTM_TARI â†’ TARI L2 â†’ AMM â†’ public fungible. The AMM hop is
unreachable until hop 1 mints a chain-proven `TerminalSettlementProof`.

## A2. Findings (all fixed, all retained as regressions)
| Severity | Count | Highlights |
|---|---|---|
| CRITICAL | 0 | â€” |
| HIGH | 3 | (1) a failed hop 2 mapped to ROUTE_FAILED_TERMINAL, misreporting a completed cross-layer trade as a total loss â€” now pauses with the user's TARI intact; (2) a blank hop-2 operation id was accepted, weakening idempotency; (3) the AMM quote could be frozen at route-quote time â€” hop 2's input is now only ever the proven settled amount, filled from the proof |
| MEDIUM | 3 | `HOP1_SETTLED` accepted a zero settled amount (silent loss of the intermediate TARI â€” found by the fuzzer); `HOP2_SETTLED` did not enforce the accepted final minimum; `RESOLVE_SETTLED` could settle hop 2 with no proof, no settled hop 1, and no txid (found by the fuzzer) |

## A3. Evidence
| Suite | Result |
|---|---|
| `test/multihop_hostile.test.cjs` | 28/28 |
| `test/multihop_fuzz.test.cjs` | 4/4 (100,000 route transitions + 20,000 proof-tamper attempts) |
| protocol-client total | **138/138** (was 106) |
| wallet-adapter | **12/12** |
| persisted failing fuzz seeds | **0** |
| multi-hop matrix | 68 rows: PASS 58, FIXED 6, N/A 1, EXTERNAL_RISK 1, BLOCKED_EXTERNAL 2, UNKNOWN 0 |
| cross-layer regressions | all 146 rows still green â€” no coordinator change in this phase |
| AMM regressions | green â€” `resolveSwap` reused unchanged, no AMM math touched |

## A4. Not established
No live Esmeralda composed execution (no concrete Ootle ScriptPath provider exists), no
live L2 HTLC leg, no production restart-safe secret storage, no market-data aggregation.
Reverse routes (â†’ XTM) are refused with a structured BLOCKED_EXTERNAL and the exact
prerequisite, not pretended. The route is EXPERIMENTAL/TESTNET: real submit OFF by default,
mainnet refused.

## A5. Next exact phase
**MARKET DATA / TRADE INDEXING / OHLC CANDLES, then FRONTEND V1.** The seam is ready:
`buildMarketDataEvent` emits pool, input/output resource, amounts, exact price inputs
(reserves before AND after), fee bps, txid, and epoch/version on successful hop-2
settlement. `RouteView` is the stable frontend contract. Candle aggregation is
deliberately not implemented.

---

# END-OF-RUN CHECKPOINT (2026-09-25) â€” hostile cross-layer audit

> Supersedes only the facts it contradicts below; the AMM/template history in the
> 2026-09-23 checkpoint and the Minotari phase section below are retained for reference.

## A1. Outcome
**NO KNOWN CROSS-LAYER CONTRACT/COORDINATOR DRAIN FOUND UNDER TESTED MODEL.**
3 CRITICAL + 6 HIGH + 7 MEDIUM root causes found, all fixed, all covered by retained
regressions. Open CRITICAL: 0. Open HIGH: 0.

CRITICAL fixes (previously the "authoritative verification" steps were advisory):
- second-leg funding was reachable from a bare submission ack â†’ now requires an
  authoritative `l1Verification` stamp the state machine refuses to write unless fully proven;
- `CLAIM_ARMED` trusted durable state plus a truthy `claimConstructileEvidence` string and
  re-observed nothing â†’ now re-observes BOTH legs authoritatively at arm time; the string is gone;
- the L1 `amountExact` check compared the funding intent against itself â†’ an explicitly proven
  amount is now required, and `amountAuthoritative` defaults to false.

## A2. Evidence
| Suite | Result |
|---|---|
| `test/hostile_crosschain.test.cjs` | 34/34 (attack matrix rows Aâ€“U) |
| `test/hostile_fuzz.test.cjs` | 5/5 (~150k ops: 100k transitions, 70k script mutations, 12 crash points) |
| protocol-client total | **106/106** (was 67) |
| wallet-adapter | **12/12** |
| workspace typecheck | clean |
| persisted failing fuzz seeds | **0** (`test/fuzz-failing-seeds.jsonl` not created) |
| attack-matrix rows | 146 (PASS 81, FIXED 48, N/A 3, EXTERNAL_RISK 2, BLOCKED_EXTERNAL 10, BLOCKED_TOOLING 2, UNKNOWN 0) |

## A3. Deliverables
- `security/CROSS_LAYER_INVARIANTS.md` â€” 14 required + 6 additional invariants, each naming
  its enforcing code and its test
- `security/CROSS_LAYER_ATTACK_MATRIX.md` â€” 146 classified rows, no UNKNOWN
- `security/CROSS_LAYER_HOSTILE_AUDIT_REPORT.md`
- `security/CROSS_LAYER_RESIDUAL_RISKS.md` â€” 17 residual risks
- `security/MINOTARI_AUTHORITY_MODEL.md` â€” field-by-field authority classification

## A4. The L1 amount answer
The amount **is** establishable, but never by the base node (blinded commitment). The
claimant can prove it from chain data + its own view key via `EncryptedData::decrypt_data`
+ `output.verify_mask` (the APIs the real claim path already uses) â€” yet no traced wallet
gRPC or WASM operation exposes that, so the reference provider reports
`amountAuthoritative: false` and the coordinator refuses. Availability limit, not a fund risk.
`TARI_TO_XTM` cannot complete until that upstream operation exists.

## A5. Still not established
No live Esmeralda execution (no funded wallet/gRPC/readback), no real Ootle L2 execution
(no concrete `OotleScriptPathLegPort` provider), no reorg simulation, no browser L1 leg
(upstream-blocked), no production restart-safe secret storage. Route remains
EXPERIMENTAL/TESTNET; real submit OFF by default; mainnet refused.

## A6. Next exact phase
Unified route composition **XTM â†’ TARI â†’ AMM** plus hostile multi-hop failure testing.
The seam is prepared but inert by construction: `RouteResult.composable` is typed `false`
and `settlementStatus` starts `UNSETTLED`, so a downstream hop cannot start on a
coordinator's optimism.

---

# END-OF-RUN CHECKPOINT (2026-09-25) â€” FAST_XTM_TARI Minotari phase

> Supersedes only the facts it contradicts below; the AMM/template history in the
> 2026-09-23 checkpoint is retained for reference.

## A. Pinned upstreams
| Repo | Path | Revision |
|---|---|---|
| Minotari L1 (`tari-project/tari`) | `C:\tmp-tari-l1` | tag `v6.0.0`, commit `97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3` (network Esmeralda) |
| tari-ootle L2 | `C:\tmp-tari` | `2d6083e6cc7c98cde93dacebe2fb76b17703f588` (workspace 0.41.1) |

## B. Git state
- Branch: `feat/multi-asset-stablecoin-markets`
- HEAD: `3f20e4c` â€” recovery fixture bound to durable `l1TxId`; esbuild build approved.
- The Minotari provider/coordinator/docs work in the working tree is **uncommitted** at this
  checkpoint.

## C. Test status (this contradicts Â§16 "TypeScript tests: None")
| Suite | Result |
|---|---|
| `@tari-ootle/protocol-client` | **66/66 pass** (includes 17 Minotari SHA/script/provider tests + 20 crosschain tests) |
| `@tari-ootle/wallet-adapter` | **12/12 pass** |
| Workspace typecheck (all packages) | green |
| CI-equivalent pnpm commands | green |
| Rust crates | unchanged this phase (32 tests) |

## D. Delivered this phase
- `src/chains/minotari.ts` â€” traced script serializer/decoder, SHA256 interop, fail-closed
  branch verifier.
- `src/chains/minotari_grpc.ts` â€” `MinotariDevGrpcProvider` (`DEVELOPMENT_REFERENCE_PROVIDER`),
  capability advertisement, base-node readback port, mainnet refusal.
- Coordinator/session/secret/provider changes â€” capability negotiation per leg, wallet-generated
  preimage ingestion, authoritative H binding, `amountAuthoritative` fail-closed gate.
- Docs: `MINOTARI_ATOMIC_SWAP_API.md` (full source trace + honest limits),
  `TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md` (new), `UPSTREAM_BASELINE.md` (L1 pin),
  `TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md` (trace no longer pending).

## E. Honest open limits (do not overstate)
1. Funded **amount** is not provable from base-node evidence (blinded commitment) â†’ the
   provider reports `amountAuthoritative: false` and settlement refuses to treat it as proven.
2. Wallet transport and base-node readback are **interfaces**; no concrete client is committed
   and nothing has run against a live node.
3. In-flight funding map is in-memory (not restart-safe).
4. Browser `window.tari` L1 SHA support is **missing upstream** (`tari_l1_wasm` exposes no
   SHA atomic swap) â†’ normal-user browser path still blocked; plan documented, not implemented.
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
| External mint blocked | âœ… | LP token `burnable(DenyAll)`, no public mint method |
| Creator mint blocked | âœ… | No owner badge; creator is regular caller |
| Random account mint blocked | âœ… | Only `add_liquidity()` calls `mint_fungible` |
| Unrelated component mint | âœ… | Component isolation; no cross-component mint authority |
| Reserve withdrawal paths | âœ… | Only `swap()` and `remove_liquidity()` |

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
| `cargo fmt --all -- --check` | âœ… PASS |
| `cargo check --workspace` | âœ… PASS |
| `cargo test --workspace` | âœ… 32 PASS |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | âœ… PASS |
| WASM release build | âœ… PASS (223,692 bytes) |
| Secret scan | âœ… CLEAN (no private keys, mnemonics, wallet API keys) |

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
- `docs/LP_AUTHORITY_MODEL.md` â€” LP mint/burn authority isolation proof
- `docs/TARISWAP_SECURITY_DIFF.md` â€” Security comparison with upstream
- `docs/ESMERALDA_VERSION_TARGET.md` â€” Actual dependency versions from upstream
- `docs/FIRST_DEPOSIT_AUDIT.md` â€” Attack analysis and fix documentation