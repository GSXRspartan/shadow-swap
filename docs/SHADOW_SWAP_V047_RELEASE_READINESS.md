# Shadow Swap — Ootle v0.47/v0.48 Release Readiness

Date: **2026-10-31** · Branch: `claude/shadow-swap-v047-release-25lmq7` · Base: `main` @ `49d3d26`

This campaign was briefed as a v0.47 migration. The first step — verifying the latest
official release rather than assuming it — changed the target: **Ootle v0.48.0 was released
on 2026-10-29 and is a testnet-reset release.** This record states what was established,
how, and what is still unverified. It does not claim mainnet readiness.

Status labels: **VERIFIED** (executed here, evidence cited) · **SOURCE-VERIFIED** (read from
pinned upstream source, not executed against a live network) · **UNVERIFIED** · **BLOCKED**.

---

## 1. Git and cohort

| Item | Value |
|---|---|
| Starting SHA | `49d3d26a5370711120557130dca2646c54a3cc76` (`main`, merge of PR #8) |
| Final SHA | recorded in the PR and in `CHECKPOINT.md` D1 (the branch head at hand-off) |
| Latest official Ootle release | **v0.48.0** — tag object `49e4933`, release commit **`6a25dbc524581bfaa0a3c6ef120f8d59cc827572`**, 2026-10-29 |
| v0.47.0 | tag object `5ad03da`, commit `9dabb2a76a9ad5c6e99dfa180ab7bbbcb1a05a47`, 2026-10-20 |
| Pinned cohort (all 8 Cargo manifests) | `tari-ootle` @ `6a25dbc`: `tari_template_lib` 0.36.0, `tari_template_abi` 0.22.0, `tari_template_macros` 0.25.0, `tari_engine_types` 0.48.0, `tari_bor` 0.16.5, `tari_crypto` **0.24.1** |
| Browser decoder | `@tari-project/ootle-wasm-bor` **0.48.0** exactly (lockfile sha512 = registry `eH9+yUwR…`) |
| Toolchain for reproducible WASM | Rust **1.97.1** (upstream v0.48.0's `rust-toolchain.toml`) |

### Why v0.48.0 and not v0.47.0

SOURCE-VERIFIED from the v0.48.0 tree and CHANGELOG:

- `crates/engine_types/src/protocol_version.rs`: Esmeralda's activation schedule collapses to
  `[(Epoch(0), V0)]` (it was `V0 / V1@11925 / V2@12220` at v0.47.0). The network restarts.
- "Every node, indexer and wallet resets … genesis state roots change", sr25519 transaction
  signatures, and "Rebuild and republish templates after the reset."
- Esmeralda defaults move to `esme-indexer-{a,b}.ootle.tari.com` (#3027).
- Indexer REST serves substate values, receipts, resources and execution results as **base64
  CBOR** (#3100, #3101, #3110, #3174, #3180).

A v0.47 pin would have targeted a network the official release has retired. Every v0.47-era
change (verified wallet reads, `GET /substates/{id}` → `state`, GraphQL removal,
`engine_debug!` removal, confidential minimum value) is also handled, because the frontend
supports the pre-reset (≤ v0.47) and reset (v0.48) indexers side by side.

### Live Esmeralda status: UNVERIFIED from this environment

The environment's egress policy denied `ootle-indexer-{a,b}.tari.com`,
`esme-indexer-{a,b}.ootle.tari.com` and `universe.tari.mw` (HTTP 403 at the proxy). Whether
Esmeralda has *already* been reset to v0.48 on 2026-10-31 was therefore **not observed**.
The app does not depend on knowing: each indexer's `GET /info` version selects the
generation at runtime (§3). The first live `/info` reads are operator step 1 in
[`SHADOW_SWAP_WINDOWS_LIVE_ACCEPTANCE.md`](SHADOW_SWAP_WINDOWS_LIVE_ACCEPTANCE.md).

---

## 2. Template and engine compatibility

| Check | Result |
|---|---|
| All four templates build for `wasm32-unknown-unknown` at `6a25dbc` | **VERIFIED**, no source change needed |
| `clippy -D warnings`, all four templates | **VERIFIED** (CI previously linted one) |
| Real engine suite (`audit_engine_tests`) under v0.48.0 | **VERIFIED locally on Linux** — see §8 for counts |
| Existing (pre-reset) published templates on the reset network | **STALE by construction** (fresh genesis); not observed live, see §1 |
| Replacement templates published | **No.** Publishing is an operator decision |
| Reproducible WASM | **VERIFIED**: relocated checkout + fresh `CARGO_HOME` reproduce all four sha256 |

Reproducible hashes (`templates/WASM_SHA256SUMS`, Rust 1.97.1, `tools/build-templates.sh`):

| Template | Bytes | sha256 |
|---|---|---|
| fungible_pool | 246 624 | `cc493f4647c3684e6f34986a52ab10859e59876c04795eed2ee6bea03b1f60a9` |
| nft_marketplace | 196 050 | `51d395ee8bed74a285e75374a555dee4c697545ce377df47ea4b5b795b50bc17` |
| nft_item_offer | 201 202 | `84de608187ee0bbaf53abd0331c576cd63cb8d23aff0c1c2a50cf0897cb0d03b` |
| nft_collection_bid | 201 028 | `5a14be7afa9913c98f3f0fd56aeb43370661ad00bce6a3f2f7becda5004d538a` |

Previously the WASM embedded host paths (`/root/.cargo/git/checkouts/…`), so two machines
produced different bytes, binary hashes and template addresses. CI now fails on any drift.

**ABI and result interpretation, not just compilation.** `wire_fixtures_v048.rs` executes the
Pool in the v0.48 engine (create → add liquidity → swap → rejected swap), encodes every value
exactly as the indexer does (`Encoded<T>`, serde base64) and checks the committed fixture
re-encodes byte-exact under the cohort. The web suite decodes those bytes with the official
decoder and recomputes reserves and LP supply independently with BigInt (§8).

---

## 3. Trust boundaries and verified reads

| Question | Answer |
|---|---|
| Is indexer discovery authoritative? | **No.** It yields candidate component addresses only |
| Does the app cryptographically verify substate proofs? | **No.** It never claims to |
| Does the Sapient wallet verify? | **No** for `tari_getSubstate`: it calls `getSubstate(…, include_proof: false)` and returns the indexer's `IndexerGetSubstateResponse` (read from `chironbuilds/tari-wallet@e2f7bf9`, `@tari-project/ootle-indexer@0.11.1`) |
| What does `verified: true` mean? | The **answering indexer's own claim** that it checked the value against a shard-committee proof. Labelled `INDEXER_VERIFIED`, never "independently verified" |
| `verified: false` | Refused for EXECUTION; allowed only for an explicitly display-only read |
| Network identity | name + network byte 38 + **version** (new): unknown/newer/older/missing versions are refused (`UNSUPPORTED_VERSION`) |
| Generation | v0.41–v0.47 → `PRE_V048_RESET` (JSON values); v0.48.x → `V048_RESET` (CBOR). A session never mixes generations |
| Template identity | By **recorded address per generation** (`services/protocolDeployment.ts`), at discovery **and** at execution-time rereads |
| Unavailable data | An error with a reason; never an empty list and never a zero balance |

The v0.48 rows of the deployment table are **empty on purpose**: nothing is published on the
reset network, so discovery there reports `PROTOCOL_NOT_DEPLOYED` with the reason, and
marketplace create actions are refused.

---

## 4. Security changes (defects found and fixed)

| ID | Severity | Defect | Fix | Regression |
|---|---|---|---|---|
| S-1 | **HIGH** | Pool templates trusted by catalogue **name**. Any template published as `Pool` whose state decoded like ours was listed and tradable; the reread of a non-seeded pool was pinned to the candidate's own template; execution-time rereads (`amm.ts` resolvers) had no pin at all. A hostile `swap` need not honour `min_output` | Recorded-address allowlist per generation; `withTrustedPoolTemplates` wraps the execution readback | `outage.test.cjs` "SECURITY: a third-party template …", `ootle-v048-wire.test.cjs` deployment tests |
| S-2 | MEDIUM (financial) | `add_liquidity` deposits both full buckets while minting on the smaller side: any imbalance at execution (including a front-run) is donated to existing LPs; no min-LP guard | New `add_liquidity_exact(a, b, min_lp_out)` takes ceil-rounded balanced amounts, refunds the rest, enforces `min_lp_out` on-chain. `add_liquidity` unchanged | engine `e07`, `e07b`, `e07c`, `e07d` |
| S-3 | MEDIUM | v0.48 receipts are strings; discovery skipped them and reported a deployed protocol as `PROTOCOL_DEPLOYED_EMPTY` | Cohort-aware normaliser; an undecodable entry fails the scan | "REGRESSION: v0.48 receipts read with the JSON format …" |
| S-4 | MEDIUM | `final_decision: "Commit"` would have read as success for `AcceptFeeRejectRest` (fee taken, swap rejected) | COMMITTED only when `finalize.result` is `Accept`; fee-only → REJECTED with reason | "REGRESSION: a real rejected swap …" (engine-produced bytes) |
| S-5 | MEDIUM (availability) | Sapient `tari_getSubstate` shape (`state.up.substate`) not read: every authoritative pool read through a real v0.47+ wallet failed | `normalizeSingleSubstate` for v0.46/v0.47/v0.48 shapes | wallet envelope tests |
| S-6 | LOW (availability) | Sapient `tari_getTransactionResult` (`{result: …}`) read as UNKNOWN forever | `interpretIndexerTransactionResult` | outcome tests |
| S-7 | LOW (supply chain) | Floating action tags; floating Rust; dev-tool advisories (vite ≤ 6.4.3, source-map-js < 1.2.2) | SHA pins, Rust 1.97.1, patched versions; `pnpm audit` clean at every severity | release-hygiene CI job |
| S-8 | LOW (ops) | Cloudflare deploy job never received `dist/` and never set its URL output | Artifact hand-off, URL parsed from wrangler, post-deploy verify job | workflow review |

Unchanged and re-verified: no admin keys, ownerless Pool v2 design, component-scoped LP
mint/burn, locked minimum liquidity, 30 bps fee retained by LPs, on-chain `min_output`.
No administrator withdrawal, developer fee, custody, hosted matching or operator-mediated
settlement was introduced.

**Open (not fixed here):** OPUS-08 residual (a public fungible whose issuer can recall/freeze
cannot be screened from a template); the frontend still calls `add_liquidity` (S-2) because
the only published Pool predates `add_liquidity_exact` — switching the builder is a
prerequisite of publishing the v0.48 Pool.

---

## 5. Wallet-provider status

Audited against the **actual** Sapient extension source (`chironbuilds/tari-wallet` @
`e2f7bf9`, v0.6.17, 2026-10-30) and the published `@tari-project/ootle(-indexer)@0.11.1`
packages. The previously transcribed contract (`universe.tari.mw/integration/tari-dapp.d.ts`)
could not be re-fetched (egress denied).

| Surface | Status |
|---|---|
| `tari_getSubstate` reply | Fixed (S-5); v0.46/v0.47/v0.48 envelopes; DOWN = absent |
| `tari_getTransactionResult` reply | Fixed (S-4, S-6) |
| create → get → submit request trio | Shapes match Sapient (`{kind:"instructions", instructions, maxFee?}`, statuses `pending/approved/submitting/submitted/rejected/failed`, request bound to origin and account) |
| Account switch | Sapient refuses submit for a different account; the app also invalidates its session |
| **Stealth-typed input (tTARI) from a Sapient LOCAL account** | **GAP / BLOCKER.** Sapient documents that a plain `CallMethod withdraw` on a Stealth vault "is not a standalone-valid instruction" and requires `withdrawStealthAndExecute`. The app sends `kind:"instructions"` with a `withdraw`, so a tTARI-input swap is refused by the wallet (no funds move). Fix plan: when the input resource is Stealth and `capabilities.stealthWithdraw` is true, submit `{kind:"withdrawStealthAndExecute", resourceAddress, amount, workspaceVarName, followUpInstructions}` with the review fingerprint covering the transformed operation; otherwise refuse with an explanation |
| Daemon-relayed accounts | The tTARI-input path executed live through walletd on the pre-reset network (B4) |
| Real extension + human approval | **BLOCKED** here (no browser extension in the cloud) — operator step |

The browser decoder was proven in **real Chromium** under the shipped CSP, with a negative
control showing `'wasm-unsafe-eval'` is load-bearing (`e2e/ootle-v048.spec.ts`).

---

## 6. Route capability matrix

Evidence: `stealth_route_probe.rs` (real v0.48 engine), `fungible_pool` `validate_pool_resource`,
upstream v0.48 source. "Pool v2" = the public AMM template.

| Pair | Supported today | Engine-compatible, unverified | Needs new template | Needs wallet changes | Blocked |
|---|---|---|---|---|---|
| public fungible ↔ public fungible | **Yes** (pre-reset; needs republish on v0.48) | — | — | — | — |
| native tTARI (revealed) ↔ public fungible | **Yes** via walletd (pre-reset live) | — | — | **Sapient local accounts**: `withdrawStealthAndExecute` (§5) | — |
| created-Stealth (revealed) ↔ tTARI / fungible | No (Pool v2 refuses, s02) | **Yes**: revealed balance lives in a component vault (s01) | Yes: a separate opt-in pool with explicit issuer-authority disclosure | Yes: stealth withdraw for the input leg | — |
| Confidential ↔ anything (public pool) | No (refused) | Revealed portion only | Yes | Yes | Pricing commitments needs proofs the AMM cannot verify |
| Confidential/Stealth private P2P settlement | No | Engine has stealth transfers with proofs (upstream `engine/tests/stealth.rs`) | Yes (escrow/HTLC style) | Yes (wallet must build statements) | — |
| NFT ↔ tTARI / fungible (marketplace) | **Yes** (pre-reset live: listing, offer, collection bid) | — | Republish on v0.48 | `CallFunction` spelling unverified in a browser wallet | — |
| Fully private AMM (hidden reserves) | No | — | — | — | **Blocked**: constant-product math over Pedersen commitments is not provable with current template APIs |

"Not supported by the existing public pool" is a property of one template's safety guard,
not a permanent product limit. No experimental route is enabled in the production UI.

---

## 7. Deployment configuration

Recommended: **Cloudflare Pages** (existing account), static only, no backend. Details,
the VPS fallback and the read-only inventory are in
[`SHADOW_SWAP_EXISTING_INFRASTRUCTURE_DEPLOYMENT.md`](SHADOW_SWAP_EXISTING_INFRASTRUCTURE_DEPLOYMENT.md);
the operator runbook is [`SHADOW_SWAP_CLOUDFLARE_STAGING.md`](SHADOW_SWAP_CLOUDFLARE_STAGING.md).

CSP change, exactly one token: `script-src 'self' 'wasm-unsafe-eval' https://universe.tari.mw`.
`'unsafe-eval'` stays absent (asserted token-exactly). `connect-src` adds the two v0.48 hosts.

---

## 8. Tests and results

| Suite | Before (main) | After | Where run |
|---|---|---|---|
| web (node) | 435 | **467 / 467** | local |
| protocol-client | 258 | **258 / 258** (sources unchanged) | local (baseline run) |
| wallet-adapter | 21 | **21 / 21** | local |
| Real engine (`audit_engine_tests`) | CI-only, 46 | **53 / 53** (46 existing + wire fixture + 4 add-liquidity + 2 stealth probe) | **local Linux** |
| Off-chain Rust crates | — | unchanged; fmt clean | CI |
| Browser e2e, Chromium desktop + mobile + hosting, `--retries=0` | 278 (all projects) | **195 passed, 2 failed, 8 skipped** | local |
| Browser e2e, Firefox | — | not run locally (no Firefox build) | CI |

The 2 local e2e failures are both "the app logs nothing to the console": the sandbox's
egress policy blocks `https://universe.tari.mw/tari-connector.js`, which the page loads in
every environment. They are environmental here and are expected to pass in GitHub CI.

Commands:

```bash
pnpm install --frozen-lockfile
pnpm --filter @tari-ootle/protocol-client run build && pnpm --filter @tari-ootle/wallet-adapter run build
pnpm --filter @tari-ootle/web run build && pnpm --filter @tari-ootle/web run test
pnpm --filter @tari-ootle/protocol-client run test
pnpm --filter @tari-ootle/wallet-adapter run test
cargo test --manifest-path audit_engine_tests/Cargo.toml
tools/build-templates.sh --check
node tools/release-hygiene.mjs --dist
pnpm --filter @tari-ootle/web run test:e2e:all
```

**GitHub CI:** not run for this branch. `git push` was refused with HTTP 403 (the Claude
GitHub App is not authorized for this repository in this session), so no PR could be opened
and no CI result exists. Green CI is **not** claimed.

---

## 9. Release gates

| Gate | Status | Basis |
|---|---|---|
| A. Source and dependency cohort compatible | **PASS** | One v0.48.0 cohort; templates + engine suite build and pass; decoder pinned to the same release |
| B. All local and GitHub tests green | **FAIL** | Local green except 2 environment-caused e2e failures; GitHub CI not run (push blocked) |
| C. No unresolved critical/high security defects | **PASS** | S-1 (HIGH) fixed with regressions; no open critical/high |
| D. Production build excludes debug providers and fixtures | **PASS** | existing deployment tests + `release-hygiene --dist` |
| E. Network and resource identity safeguards verified | **PASS** | name + byte + version + generation + recorded template addresses, tested |
| F. Wallet approval/recovery tests green | **PASS** (reference provider + unit) | real-shape envelopes tested; Sapient Stealth-input gap documented |
| G. Real browser-extension approval demonstrated | **BLOCKED** | operator step |
| H. Cloudflare preview deployed and smoke-tested | **BLOCKED** | needs operator dispatch and Cloudflare credentials |
| I. Real public Esmeralda settlement reconciled | **BLOCKED** | reset network has no published Shadow Swap template; operator publish + walletd |
| J. Mainnet explicitly disabled | **PASS** | unchanged guards in every layer |

---

## 10. Remaining release blockers

1. Grant the Claude GitHub App access (or push manually) so CI runs and the PR exists.
2. Confirm live Esmeralda: `GET /info` on both v0.48 hosts (version `0.48.x`, network byte 38).
3. Switch the add-liquidity builder to `add_liquidity_exact` (with `min_lp_out` from the
   authoritative quote) — required before the v0.48 Pool is published.
4. Implement the Sapient `withdrawStealthAndExecute` path for Stealth-typed inputs (§5).
5. Operator-approved publication of the four v0.48 templates from the reproducible build,
   then record the addresses in `protocolDeployment.ts` for `V048_RESET`.
6. Real-extension acceptance on Windows (`SHADOW_SWAP_WINDOWS_LIVE_ACCEPTANCE.md`).
7. Cloudflare preview deploy + verify job green (`SHADOW_SWAP_CLOUDFLARE_STAGING.md`).
8. External review before any claim beyond "testnet release candidate".
