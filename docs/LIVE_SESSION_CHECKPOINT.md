# Live Session Checkpoint — feat/esmeralda-live-vertical-slice

Session date: 2026-10-06. Branch created from `main` @ `5118e95`.

This file is the append-only context-recovery checkpoint for the overnight live
vertical-slice run. Authoritative detail lives in the referenced docs.

## Live network baseline (verified read-only 2026-10-06)

- Network: **esmeralda**, network_byte **38**. Indexers A/B both live (REST API).
- **Version drift: live indexer now reports `0.43.0`** (was `0.42.0` at publication).
  `current_epoch` ≈ **11913**. State was PRESERVED across the 0.42→0.43 upgrade
  (no reset): all four templates still present.
- Frontend identity check (`apps/web/src/services/indexerIdentity.ts`) gates on
  network **name + byte only, NOT version** → the 0.43 drift does **not** break
  discovery. Verified by source review. No code change required for the bump.
- All four templates confirmed by exact-name catalogue match on live v0.43:
  - Pool `ef2bc1b00fc3212c9acd9ff5f2e8203d9d0b8402c4d04d284a95c1d1e80d5649`
  - FixedPriceListing `612114e382c28205ee5d4d24754dbdb13351d648237e880b77c991d5f2fa2329`
  - ItemOffer `083fef7d75857d83ea5424e24d7f47058b4082fa727b91b515aace1c50ec22a6`
  - CollectionBid `999ef37f1da524e4d3e06132145c1c6e7bef735a66549da24b747c22d4706a54`

## Wallet baseline (walletd http://127.0.0.1:5100, Web UI)

- Account **Purrivacy Swap** `component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b`.
  Balance: **1.806470 revealed + 1,983.911412 confidential tTARI** (plenty).
  Publications historically paid fees from the **confidential stealth tTARI** position.
- Native tTARI = `resource_0101…0101` (Stealth, canonical — pool accepts it as the special case).
- A prior test token **STEST** `resource_e0158c30…4ae3d318` exists on the account
  but is **Stealth-typed** → the Pool template's `validate_pool_resource` REJECTS it.
  (owner_rule ByPublicKey = the Purrivacy Swap key.)
- Faucet is EMPTY (burn-on-L1 to refill; L1 burns are OUT of scope by budget).
- JSON-RPC needs a bearer token (auth flow with a `credentials` field); Web UI self-authenticates.

## PRIMARY-OBJECTIVE BLOCKER (honest, evidence-based)

**Live pool instantiation + lifecycle = BLOCKED_TOOLING.** Reasons:
1. No supported mechanism in this environment submits a `CallFunction` /
   multi-instruction manifest (withdraw→call→workspace→deposit). The wallet Web UI
   offers only *Publish Template / Claim Fees / Claim Burn / Send*. The
   `tari_ootle_wallet_cli` is not installed. The frontend walletd adapter is a
   deliberate no-op (`packages/wallet-adapter/src/walletd_adapter.ts`), and no
   TariConnect provider bridge actually submits.
2. No pool-eligible **public fungible** asset exists (STEST is Stealth). Creating
   one needs a token template + a CallFunction — same blocker as (1).
3. Repo policy (TESTNET_RUNBOOK, VERTICAL_SLICE) explicitly forbids hand-writing a
   publish/transaction-construction script as the submission path, to avoid exactly
   the UNKNOWN-submission class this protocol refuses. Not overridden lightly.

Funding and network are NOT the blocker. No live state-changing tx was submitted.

## REAL v0.43 INTEGRATION BUG FOUND + FIXED (verified live)

`apps/web/src/services/ootleIndexer.ts` — the batch component read
(`POST /substates/fetch`) spoke the v0.42 contract and the live v0.43 host
answered **HTTP 422**, so the Pools page rendered "Pool discovery unavailable"
even though all four templates are published. Root cause, from live probing:

- Request body changed: v0.42 `{substate_ids:[…]}` (or `{requests:[{substate_id}]}`)
  → v0.43 `{requests:[<id string>,…], cached_only:false}`. The `cached_only`
  field is now **required**; `requests` elements must be **strings**.
- Response shape changed: v0.42 `substates` = ARRAY of `{substate_id,version,substate}`
  → v0.43 `substates` = MAP keyed by substate id, value `{version, substate:{Component}}`,
  with `version` as a JSON **number** (was a string).

Fix: send the v0.43 body; parse the keyed map (id = key); generalise `rawInteger`
to accept a non-negative safe-integer JSON number (capped at MAX_SAFE_INTEGER so a
u64-ceiling version still stays a string). **Verified live**: Pools page now reports
`PROTOCOL_DEPLOYED_EMPTY` ("Protocol published, not yet in use") — the correct
state (4 templates published, 0 pool components). End-to-end read path exercised:
identity → catalogue → receipts → batch substate fetch, all against real v0.43.

Regressions: `apps/web/test/outage.test.cjs` `componentSubstates` stub updated to
the v0.43 map shape + numeric-version carry asserted; new test in
`apps/web/test/ootleV042Contract.test.cjs` pins `{requests,cached_only}` request
and keyed-map parse via an injected transport.

## Test evidence (Windows, this session)
- Rust: pool_math **36** (20+2+14), pool_ref_model **22** (differential 5,
  security_gauntlet 16, state_fuzzer 1), protocol_types **10** — all 0 failed.
- TS: workspace typecheck PASS; web unit tests **334 passed / 0 failed**.
- Engine suite (`audit_engine_tests`) is Linux/Cranelift-only → CI, not Windows.

## Pivot checklist
- [x] Rust Windows suites: pool_math, pool_ref_model, protocol_types
- [x] Live read-only discovery verification against v0.43 (frontend read path)
- [x] v0.43 discovery bug fixed + regressions + verified live
- [x] TS typecheck / web tests
- [x] web production build (137 modules, deployment headers written, exit 0)
- [x] OPUS-08 recall/freeze status re-check — template source re-read; all prior
      OPUS fixes intact (mul-before-div, effective-input fee, component-scoped LP
      mint/burn + OwnerRule::None, reserves-read-before-deposit, on-chain min_output,
      first-deposit minimum + permanently-locked LP). Recall/freeze residual is an
      ABI limitation, still documented, still OPEN (needs engine API or allow-list).
- [x] Live pages checked: /pools (DEPLOYED_EMPTY, correct), /activity (honest empty
      + full reconciliation state machine), /nfts (no discovery endpoint by design).
- [x] Branch pushed; CI (Node Tests + Security Engine Tests) triggered on push.
- [ ] Final CI result check (engine suite runs Linux-only there)

## UPDATE 2026-10-06 (session 2): LIVE AMM VERTICAL SLICE VERIFIED

Live execution UNBLOCKED and completed. Full detail in
`docs/ESMERALDA_LIVE_VERTICAL_SLICE_REPORT.md`.

- Submission path: `tools/live-executor` → walletd `transactions.submit_manifest`
  (daemon signs with its own account key; no key export; loopback-only; testnet
  identity checked; dry-run fee estimate + per-tx ceiling; durable ledger).
  Auth solved: v0.43 `auth.request` needs `credentials:{None:null}`.
- Public fungibles minted via published `TestCoinFactory` (no publish needed):
  LPTESTA `resource_87385b51…`, LPTESTB `resource_8187d405…` (both Fungible,
  recall/freeze DenyAll).
- Pool `component_329d4ef20fe6803ca499db7f923b0d1773d1f72e38d76cfcbe351327d6304169`
  (Pool template, fee 30bps, LP `resource_32a6a6b0…`).
- Verified LIVE: initial liquidity (shares 4,242,640; locked 1,000), swap (out
  271,983 exact), add-liquidity-2 (min-side mint 1,555,209), partial withdrawal
  (LP→4,797,849; locked still 1,000). Total fees ≈0.026 tTARI.
- Frontend `/pools` discovers the live pool component on chain (verified in-browser).
- Finding OPUS-16 (HIGH): pool component defaults to OwnedBySigner → deployer can
  SetAccessRules and freeze LP funds. Fixed in template source (OwnerRule::None),
  WASM rebuilt, engine regression added. Needs a NEW published template version;
  live ef2bc1 pool retains the flaw (harmless, disposable).
