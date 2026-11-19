# SHADOW SWAP — EIGHT-PASS HOSTILE SECURITY AUDIT

Independent fresh-context adversarial audit.
Branch `codex/ootle-v0501-pool`, HEAD `5d8a27a8d2b198739f1c519d154c34e47672648f` at audit start.
Pre-existing uncommitted changes preserved untouched: `apps/web/src/pages/HomePage.tsx`, `apps/web/src/styles/global.css`, `decode-receipts.mjs` (untracked), `.pnpm-store/` (untracked).

## 1. Scope and trust boundaries

Audited trees:

| Area | Path | Role |
|---|---|---|
| Pool v2 template | `templates/fungible_pool/src/lib.rs` | Public-fungible constant-product AMM (published) |
| Revealed pool template | `templates/revealed_asset_pool/src/lib.rs` | Revealed-value AMM for Stealth/Confidential assets (experimental) |
| NFT templates | `templates/nft_marketplace`, `nft_item_offer`, `nft_collection_bid` | Escrowed fixed-price listings, buyer offers, collection bids (published) |
| P2P escrow | `templates/p2p_offer/src/lib.rs` | Maker-funded escrow offer (experimental, unpublished) |
| Cross-layer HTLC | `templates/cross_layer_htlc/src/lib.rs` | One-sided L2 HTLC mirroring the Minotari SHA script (experimental, unpublished) |
| Reference math | `crates/pool_math`, `crates/pool_ref_model`, `crates/protocol_types` | Independent off-chain models |
| Engine tests | `audit_engine_tests/` | Real-engine (tari-ootle v0.50.1, rev 0b3f364d) host-side proofs |
| Client | `packages/protocol-client`, `packages/wallet-adapter` | Resolvers, quote math, cross-chain coordinator, intent builders |
| Frontend | `apps/web` | React/Vite signing UI, review/differential, durable pending-request ledger |
| Indexer | `tools/market-indexer` | Read-only VPS sidecar (reserve-delta trade inference) |
| Deploy | `.github/workflows`, `wrangler.jsonc`, `deploy/vps`, `tools/market-indexer/{Dockerfile,docker-compose.yml}` | CI, Cloudflare Pages, VPS sidecar |

Trust boundaries: browser page ↔ wallet extension/Universe provider; browser ↔ indexer (read-only);
coordinator ↔ L1/L2 wallet ports; site ↔ localStorage (attacker-writable, deny-only); pool components ↔
resource access rules; template ABI ↔ issuer-authority introspection (documented ABSENCE).

Feature classification: Ootle public-fungible AMM + NFT marketplace = deployed/live-verified on
Esmeralda; revealed pool + p2p_offer + cross-layer HTLC = experimental/unpublished; Minotari L1
submarine swap leg = gated OFF (`TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT`, mainnet refused);
mainnet = disabled in every layer (env + reviewed constant in `apps/web/src/lib/networks.ts`).

## 2. Findings ledger

Statuses: CONFIRMED / REPRODUCED / MITIGATED / UNVERIFIED / ACCEPTED RISK / NOT APPLICABLE.

### PASS 1 — Pool templates & AMM economics

| ID | Sev | Conf | Status | Summary |
|---|---|---|---|---|
| P1-H1 | HIGH | CONFIRMED→MITIGATED | MITIGATED | Client builds donating legacy `add_liquidity` for every funded-pool deposit: any reserve-ratio move between quote and execution donates the imbalance to existing LPs with no `min_lp_out` bound. A (near-)sole LP can front-run a deposit with an imbalanced add and recover the victim's dominant-side deposit on withdrawal. On-chain fix existed (`add_liquidity_exact`, engine tests e07/e07b/e07c) but was never used by the client. |
| P1-M1 | LOW | CONFIRMED | ACCEPTED RISK (documented) | `add_liquidity_exact`'s first-deposit branch panics (`Bucket::take(Amount::zero())`); proven by engine test `e07e_add_liquidity_exact_cannot_serve_a_first_deposit`. First deposits must use `add_liquidity`/`create_pool` (resolver refuses bootstrap). Template is immutable so it cannot be fixed on-chain; the client now only uses the exact method for funded pools. |
| P1-L1 | LOW | REPRODUCED (e07d) | ACCEPTED RISK | Legacy `add_liquidity` remains callable AllowAll on-chain; direct template callers can still donate imbalances. Kept for template immutability; the client no longer emits it for funded pools. |

Verified-secure in Pass 1 (evidence: source + engine tests + differential model):
first-deposit sqrt-mint with 1000 locked shares; min-side proportional minting with 192-bit
multiply-before-divide; floor division everywhere rounding to the pool; full-input deposit (fee to
LPs); on-chain `min_output` slippage; ownerless component (`OwnerRule::None`) with locked
mint/burn/upgrade rules; canonical pair ordering by engine `Ord`; resource-type gate
(`STEALTH_TARI_RESOURCE_ADDRESS` exact address or `ResourceType::Fungible`); reference math
(`crates/pool_math`) matches template semantics; differential model (`pool_ref_model`, 256-bit
independent model). OPUS-08 residual (no recall/freeze introspection in template ABI) re-verified
unchanged at v0.50.1 — accepted, disclosed in code.

### PASS 2 — NFT marketplace & escrow

Verified-secure (source review + engine suites `marketplace_engine`, `item_offer_engine`,
`collection_bid_engine`, `p2p_offer_routes`): single-item escrow with immutable
seller/buyer settlement accounts; exact-amount payment asserts; status-machine double-spend
refusals; one-time expired refunds to immutable recipients; maker-key-only claim/cancel;
collection bid invariant `remaining_escrow == remaining_quantity * price` enforced with checked
arithmetic; no metadata-based settlement anywhere. No findings above LOW.

### PASS 3 — Cross-chain atomic swaps & HTLC

| ID | Sev | Conf | Status | Summary |
|---|---|---|---|---|
| P3-M1 | MEDIUM | CONFIRMED (code path) | MITIGATED (fix below) | `crosschain/coordinator.ts::validateQuoteView` validates every untrusted-quote field EXCEPT the cross-leg deadline-ordering invariant ("the second-funded leg must expire strictly before the first"). The invariant IS enforced in the `crossLayer` path (`atomicSwap.ts deriveTimeouts`/`checkProposedTimeouts`) but not in the coordinator path, which stores `l1RefundDeadlineHeight`/`l2RefundDeadlineEpoch` from the quote and never compares them. A quote violating the ordering creates a leg pair where the preimage can appear with no time left to use it (double-take shape). Server-side only (frontend bundle excludes coordinator, FI-R9); deadline authority rechecks margins at each irreversible phase but never the ordering. |

Verified-secure: L2 HTLC template mirrors the real Minotari script (`HashSha256 PushHash Equal
IfThen claim / CheckHeightVerify refund`); strictly disjoint claim/refund epochs (L1 has no race);
preimage stored on claim for counterparty completion; coordinator fail-closed evidence stamps
(`applyEvent` refuses unproven `L1/L2_VERIFIED_FUNDED`); second-leg funding gated on authoritative
L1 verification; deadline freshness (> tip + confirmations) re-checked; CLAIM_ARMED re-observes
BOTH chains before reveal; preimage verified `SHA256(S)==H` before every use; duplicate-secret-id
attack refused in `CrossChainSecretStore.ingestExternalSecret`; session recovery absorbing
(RECOVERY_REQUIRED never auto-resumes; CLAIMED reconciles by durable id); preimage never persists
in swap records (`assertRecordIsSafe`).

### PASS 4 — Wallet signing & transaction state machine

| ID | Sev | Conf | Status | Summary |
|---|---|---|---|---|
| P4-L1 | LOW | CONFIRMED (code path) | MITIGATED (fix below) | `submitApprovedRequest` keeps its in-session double-submit guard on TIMEOUT/INTERNAL errors but does not durably mark the ledger entry UNKNOWN; after a reload the entry still reads APPROVED and a user-initiated resubmit of the same requestId is offered. The wallet's own requestId authority bounds the damage, and the resume path re-polls the wallet, but the durable record should reflect the unknown outcome. |

Verified-secure: historical NO_LIVE_REVIEW guard fixed (submit-by-requestId needs no payload
reconstruction); resume refusals are deny-only (tampered storage can refuse but never authorise);
wallet word is the only word on resume; UNKNOWN never auto-retries; duplicate-button guard marks
before the network call; pending ledger allowlist-validated with forbidden-field rejection and
bounded payload.

### PASS 5 — Frontend & browser security

Verified-secure: no `dangerouslySetInnerHTML`/eval/`new Function`/`document.write` anywhere; all
untrusted text through `safeLabel` (control chars, bidi overrides stripped, 96-char cap); URLs via
`safeExternalUrl` (protocol allowlist, no credentials) and `safeImageUrl` (image-extension or
https-only); NFT metadata fetch bounded (256 KiB, JSON content-type, timeout, credentials omit,
no-referrer); presentation/authority split (asset identity from exact addresses; symbols are labels
only); Meshy 3D sculpture viewer loads ONLY first-party static assets (no untrusted GLB path, no
DRACO, deferred load); CSP generated to `dist/_headers` with `frame-ancestors 'self'
https://universe.tari.mw`, no `unsafe-eval`, wasm-unsafe-eval only for the value decoder. No
findings above LOW.

### PASS 6 — Backend, indexer & local sidecars

Verified-secure: indexer binds `127.0.0.1` only; no CORS headers (same-origin only); no file
serving (no traversal); `limit` clamped; decode fail-closed (`try/continue`); ledger dedupe by
vault version; 50k row cap with bounded rewrite; docker-compose isolates network, read-only
rootfs, non-root, cap-drop ALL, loopback publish, resource limits. Trade inference is honest:
opposite-direction deltas only, one-vault-version windows marked exact, multi-step windows marked
`partial:true, multiCount`, provenance `INFERRED_CONSECUTIVE_OBSERVATION`,
`verifiedByReceipt:false`. The frontend's own observation path requires
`producingTxHash == ourTxId` OR version advance of exactly 1 (strict attribution; contended pools
record nothing). No findings above LOW.

### PASS 7 — Deployment, supply chain & configuration

| ID | Sev | Conf | Status | Summary |
|---|---|---|---|---|
| P7-M1 | MEDIUM | CONFIRMED | UNVERIFIED (build-env evidence) | Locally-built `cross_layer_htlc.wasm` hash (`b88b3889…`) does not match the pinned `WASM_SHA256SUMS.v0501` (`d0916869…`). The build script documents that plain dev builds embed host paths, so a mismatch is expected for dev builds; the pinned manifest can only be validated by `tools/build-templates.sh --check` (Linux, Rust 1.97.1). NOT an attempted attack: CI runs `--check` on every push to main/security/feat branches. |
| P7-L1 | LOW | CONFIRMED | OPEN | `security-engine-tests.yml` comments + cache key still say cohort v0.49.2 (aa7b0c8) while `audit_engine_tests/Cargo.toml` pins v0.50.1 (0b3f364d). Documentation drift only; the pins themselves are consistent. |
| P7-L2 | LOW | CONFIRMED | OPEN | Production build ships source maps (`vite.config.ts sourcemap: true`) → published `.map` files on the Pages host. No secrets are embedded (verified: VITE_* are public by design; no secret-shaped constants found in src), but maps expand the reviewable attack surface of the public bundle. |

Verified-secure: deploy workflow is manual-dispatch only with explicit project confirmation,
pinned Pages project name, preview-by-default, production requires main; all actions pinned by
commit SHA; wrangler pinned; deploy job runs no repo code; post-deploy header verification +
smoke test; headers/redirects generated from one reviewed source (`deploymentHeaders.ts`);
mainnet execution requires a reviewed code change, not an env var; dev-only flags refused in
production builds; no secrets in `src` (pattern scan clean).

### PASS 8 — Independent hostile red-team review

Cross-component scenarios examined (details in per-pass sections):
- A. Malicious pool creator: no authority (ownerless, locked rules) — no finding.
- B. Malicious token issuer: recall/freeze risk is a documented ABI limitation (OPUS-08), disclosed; cannot be fixed permissionlessly.
- C/D. Dishonest NFT seller/buyer: exact-identity escrows; refunds go to immutable recipients — no finding.
- E. Hostile cross-chain counterparty: deadline-ordering gap = P3-M1; preimage binding + fail-closed otherwise.
- F. Compromised indexer: read-only in both web and indexer paths; strict attribution prevents fake trades entering the frontend's own pipeline; the VPS indexer's inferred rows are labelled.
- G. Malicious site vs local wallet: walletd adapter is dev-only and refused in production builds; browser path goes through the extension's own approval.
- H. Two tabs: in-session `submittedRequestIds` guard + `blockingPendingRequest` refuses a second approval while one is unresolved.
- I. Compromised VPS: indexer holds no custody, no signing, loopback-only; worst case is serving stale/wrong reads, which the web marks non-authoritative (readback sources validated).
- J. Deceptive wallet provider: UNKNOWN handled as unknown everywhere; capability negotiation fail-closed; provider assertion source (`PROVIDER_ASSERTION`) never satisfies settlement verification.

## 3. Corrective commits (this audit)

| Commit | Fixes |
|---|---|
| (local, this branch) | P1-H1: client joins funded pools via `add_liquidity_exact` with the quote hint as on-chain `min_lp_out`; refunds deposited; review binds `min_lp_out` via the same args[2] channel as swap min_output. Tests: wallet-adapter (2 new), protocol-client (2 new), web wire test pinning the exact-method shape to the engine-executed `revealed_add_liquidity` fixture. |

## 4. Test evidence (this session)

- `packages/wallet-adapter` amm.test.cjs: 8/8 pass (2 new).
- `packages/protocol-client` targeted suites (amm, amm_model, amm_parity, amm_router, lp_position,
  donations, marketplace, marketplace_substate, pool_substate, history, packaging,
  route_immutability, crosschain, hostile_crosschain, cross_layer_atomic_swap, multihop_hostile,
  hostile_fuzz): 248/248 pass (2 new).
- `apps/web` instruction-wire-v048.test.cjs: 27/27 pass (1 new). lib.test.cjs: 25/25.
- Rust engine suites (`pool_engine`, `pool_adversarial`, `pool_economics`, `revealed_asset_pool`,
  `marketplace_engine`, `item_offer_engine`, `collection_bid_engine`, `p2p_offer_routes`,
  `cross_layer_htlc`, `multihop_routes`): running on Linux (WSL Ubuntu-22.04, Rust 1.97.1,
  pinned cohort) — Windows cannot compile the engine (Wasmer Cranelift), matching CI's design.
- Typecheck/build of `protocol-client`, `wallet-adapter`, web build:test: pass.

## 5. Remaining unverified assumptions

- Pinned WASM manifest reproducibility must be re-proven by `tools/build-templates.sh --check` on
  Linux before any template publication (P7-M1).
- Wallet-side idempotency of `tari_submitTransactionRequest` for a repeated requestId could not be
  verified from this repository (external wallet behavior); the app treats wallet-reported status
  as authoritative and never auto-resubmits.
- The cross-chain coordinator's real-submission path remains gated OFF; its deadline-ordering
  check (P3-M1 fix) is validated at the quote-validation layer, not against a live chain.

## 6. Readiness verdicts (separate decisions)

- READ-ONLY PUBLIC PREVIEW: acceptable (read-only paths, header policy, no fabrication of market data).
- WALLET-CONNECTED TESTNET: acceptable with P1-H1 fix deployed; keep the real-crosschain gate OFF.
- LIVE TESTNET FINANCIAL OPERATIONS: only after (a) pinned-WASM reproducibility re-verified, (b)
  engine suite green on the pinned v0.50.1 cohort, (c) LP add/remove flows re-verified live via
  dry runs, (d) P3-M1 fix present if the coordinator is ever enabled.
- MAINNET: NOT ready (deliberately disabled in code; requires the full mainnet checklist).
