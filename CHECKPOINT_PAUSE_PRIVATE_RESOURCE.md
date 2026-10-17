# MID-RUN CHECKPOINT (2026-10-17 ~09:00 UTC) — private-resource campaign, PAUSED on operator disk space

> Session ended early: the operator ran out of disk space and is fixing it.
> Everything below is DURABLE and committed on branch `feat/private-resource-trading-v046`.
> Supersedes nothing; ADDS to the checkpoints below. Resume from §P7.

## P1. Git state

- Branch `feat/private-resource-trading-v046` created from `main` @ `49d3d26`
  (= merge of PR #8, README banner/screenshots; PRs #5/#6/#7/#8 all MERGED).
- Working tree was clean at pause except the changes listed in §P6.
- Never pushed yet (nothing lost either way — the branch exists locally with all work).

## P2. walletd discovery (Phase A — COMPLETE)

- Binary: `tari_ootle_walletd-0.46.1-4a9fc7d-windows-x64.exe` (v0.46.1 — a PATCH NEWER than
  the project's 0.46.0; compatible, NOT upgraded, NOT touched).
- Listens on `127.0.0.1:5100` ONLY (loopback verified via Get-NetTCPConnection).
- Web UI is an SPA; JSON-RPC endpoint is `POST http://127.0.0.1:5100/json_rpc`.
- AUTH MODE CHANGED vs prior sessions: NOT `--authentication none`. WebAuthn/passkey required.
  `auth.request` with `{None:null}` returns `500 No webauthn finish login request present`.
  Short-lived (~30 min) JWTs come from the web session; the operator minted a long-lived
  API key (`tw_…`, scope: reads + no Transactions) via the UI api-keys page.
- CREDENTIAL HANDLING: operator-supplied tokens/keys were used from the process environment
  ONLY (`$env:WALLETD_API_KEY`), never written to any file, log, test, commit, or report.
  The executor change in §P6 reads `process.env.WALLETD_API_KEY` at call time.
- Permission boundaries observed (exact daemon strings):
  - PUBLIC (no auth): `wallet.get_info` → `{network:"esmeralda", network_byte:38, version:"0.46.1"}`.
  - Operator key HAS: accounts.list/get_balances, nfts.list, resources.get, substates.get,
    templates.get.
  - Operator key LACKS: `Settings(Read)` (settings.get), `StealthUtxos(Read)`,
    `Confidential(Read)`, and `Transactions(Create)` (blocks ALL manifest submission incl.
    NON-MUTATING dry runs).
- Operator paused before deciding on adding `Transactions(Create)` (+ optionally
  `StealthUtxos(Read)`, `Confidential(Read)`) to the API key. THAT IS THE RESUME GATE.

## P3. Wallet inventory (Phase A — COMPLETE, authoritative reads 2026-10-17)

Two accounts (names + component addresses only; no keys/addresses beyond components):

1. "Purrivacy Swap" (default) `component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b`
2. "V042_ATOMICSWAP_TEST_COUNTERPARTY" `component_b510055406cbe43325aa7790a38f980eb03d354f525b0acc7c59461b07dde77d`

Balances (raw units, resource ADDRESS is the identity; symbol is metadata only):

| Resource | Type | Div | A1 revealed | A1 confidential | A2 revealed | Class |
|---|---|---|---|---|---|---|
| `resource_0101…0101` tTARI | **Stealth** (native) | 6 | 49,983,374 | 1,930,355,309 | 1,638,456 | STEALTH SPENDABLE (+CONFIDENTIAL BALANCE — see note) |
| `resource_e015…d318` STEST | **Stealth** (created) | 6 | 970,000,000 | 28,000,000 | 0 | STEALTH SPENDABLE — the Phase C target |
| `resource_8738…0dfc` LPTESTA | Fungible | 6 | 990,932,623 | 0 | 1,000,000 | PUBLIC SPENDABLE |
| `resource_8187…0051` LPTESTB | Fungible | 6 | 996,914,983 | 0 | 0 | PUBLIC SPENDABLE |
| `resource_32a6…6bb6e9` LP (div 18) | Fungible | 18 | 4,796,849 | 0 | 0 | LP POSITION (pool LP token) |
| `resource_8c69…3281` LP (div 18) | Fungible | 18 | 599,000 | 0 | 0 | LP POSITION — matches live Pool v2 lp_resource |
| `resource_a499…5a72` PTEST | Fungible | 0 | 1 | 0 | 0 | PUBLIC SPENDABLE (1 raw unit) |
| `resource_51e2…3236a` TNFTA | NonFungible | 0 | 0 | 0 | 0 | ZERO BALANCE |
| `resource_a473…1b985` TNFTB | NonFungible | 0 | 0 | 0 | 0 | ZERO BALANCE |
| `resource_cfcf…82dd7` V042R | NonFungible | 0 | 1 NFT (`v042-restart-swap-a-7f3c9`) | — | 0 | NFT OWNED |
| `resource_4786…3fb1b` V042R | NonFungible | 0 | 0 | — | 1 NFT (`v042-restart-swap-b-f2a02`) | NFT OWNED (A2) |
| `resource_e6d1…23bd8` V042R | NonFungible | 0 | 0 | — | 1 NFT (`v042-soak-swap-a-cba74`) | NFT OWNED (A2) |
| `resource_ef30…3d0` V042R | NonFungible | 0 | 1 NFT (`v042-soak-swap-b-6af4d`) | — | 0 | NFT OWNED |

CRITICAL FINDING: **native tTARI is `ResourceType::Stealth`** — there is no separate public
TARI. `accounts.get_balances` reports a `balance` (revealed) AND a `confidential_balance`
field per resource. For tTARI A1: revealed 49,983,374 + confidential 1,930,355,309.
INTERPRETATION CAUTION (do not resolve by guessing): whether `confidential_balance` here
means "hidden commitments the wallet can spend" or "a figure the wallet tracks but cannot
spend without a reveal step" MUST be settled by an actual dry-run `account.withdraw(tTARI, n)`
larger than the revealed balance, or by `StealthUtxos(Read)`/`Confidential(Read)` scopes.
Do NOT interpret a withheld private balance as zero (brief §A).

- STEST metadata (from `resources.get`): `resource_type:"Stealth"`, divisibility 6,
  total_supply 1,000,000,000, owner `ByPublicKey` (operator), `view_key` SET on the resource,
  metadata includes `purrivacy_route:"generic-stealth-fungible"`, `lab_scope:"local-testnet"`,
  name "Current Testnet Stealth Test". This is the designated generic created-Stealth test
  asset, 970M revealed in A1 — ideal for Phase C.
- tTARI resource: `resource_type:"Stealth"`, `view_key: null` on the resource itself.
- NFT listing (nfts.list) worked; TNFTA/TNFTB hold zero items.
- stealth_utxos.list → 401 `Required 'StealthUtxos(Read, None)'` (key lacks scope).

## P4. Pool v2 live state (authoritative, walletd substates.get)

`component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2`:
template `f47a330eee…19ab` (Pool v2), owner_rule None, **fee_bps = 30** (state[2] literal 30),
lp_resource `8c69…3281`, wallet holds 599,000 LP of 600,000 supply with 1,000 locked.
Reserves via indexer read: 596,664 tTARI / 603,674 LPTESTA. Pool v2 ABI (templates.get):
`new(a_addr,b_addr,fee_bps)`, `add_liquidity(&mut,Bucket,Bucket)->Bucket`,
`swap(&mut,Bucket,ResourceAddress,Amount)->Bucket`, `remove_liquidity(&mut,Bucket)->(Bucket,Bucket)`
+ read-only getters. All consistent with prior sessions; NOTHING changed on chain.

## P5. Source-level findings (Phase B/C — engine evidence, no chain writes)

- `templates/fungible_pool/src/lib.rs:438` `validate_pool_resource`: ONLY canonical native
  Tari (Stealth-typed, exact address) or `ResourceType::Fungible` pass. Generic created-Stealth
  (STEST) and Confidential are rejected BY DELIBERATE OPUS-08 POLICY, with a documented
  residual: the template ABI cannot see recall/freezability of foreign resources.
- Therefore NO existing Pool v2 component can ever hold STEST; compatibility requires a NEW
  template (ownerless adapter/pool) — NOT a patch to Pool v2 (brief §B forbids republish).
- The prior session's dry-run harness ALREADY asserts `Pool::new(STEST,…)` must REJECT and
  `Pool::new(tTARI,LPTESTA)` must ACCEPT (control) — good tests waiting for permission.
- Existing manifest dialect (v0.45 note in dryrun-pool.mjs): manifest TEXT form
  `fn main() { let a = arg!["account"]; let b = a.withdraw(arg!["r"], amount!(N)); a.deposit(b); }`
  with `variables: {account, r, ...}`; `transactions.submit_manifest` params
  `{manifest, variables, max_fee, dry_run: true|false, signing_key_ids: []}`.
  Nested-call chaining is a syntax error; bind every step with `let`.

## P6. Code changes made (ON BRANCH, uncommitted at pause → COMMIT THESE FIRST)

1. `tools/live-executor/walletd.mjs`:
   a. `authenticate()` now prefers `process.env.WALLETD_API_KEY` when set (daemon no longer
      runs `--authentication none`; `auth.request` is rejected by WebAuthn mode). Falls back
      to the old `auth.request {None:null}` path. Secret stays in env; never logged/committed.
   b. `verifyNetwork()` rewritten to use PUBLIC `wallet.get_info` as the authoritative identity
      (name + byte), with an OPTIONAL `settings.get` cross-check that is skipped (not an error)
      when the credential lacks `Settings(Read)`. Fail-closed mainnet/network-byte checks unchanged.
   NOTE: a hardcoded key must NEVER be added; keep env-only.
2. No other files touched. No tests run yet beyond the live harness itself.

## P7. RESUME PLAN (next session, in order)

1. `git checkout feat/private-resource-trading-v046` (it already has §P6 changes; commit them
   first thing: message "feat(exec): operator API-key auth + public-identity network preflight").
2. Ask operator for `Transactions(Create)` on the API key (+ ideally `StealthUtxos(Read)`,
   `Confidential(Read)`); re-run `$env:WALLETD_API_KEY=… ; node tools/live-executor/dryrun-pool.mjs`
   → THIS is the Phase C1 input-selection + eligibility proof (non-mutating).
3. If STEST `withdraw+deposit` dry-run ACCEPTS → generic created-Stealth input selection works
   at walletd level; then design the ownerless stealth-compatible pool template (Phase C1/C2)
   WITHOUT publishing; add engine tests under `templates/` (cargo test on Windows is fine for
   protocol crates; audit_engine_tests stays CI-only).
4. Confidential lane (Phase D): settle the `confidential_balance` interpretation FIRST
   (dry-run probe or Confidential(Read) scope), then choose Route 1 (user-authorized reveal)
   vs Route 3 (P2P/HTLC) based on what the engine actually supports. Do not fake hidden prices.
5. Phase E routing matrix + Phase H UI + Phase J docs (`docs/PRIVATE_RESOURCE_TRADING_V046.md`)
   + README wording change (suggested wording is in the brief §J).
6. Phase F budget reminder: ≤8 live txs, ≤50,000 µT/tx, ≤200,000 µT total, small expendable
   amounts only, never exhaust balances, no new contract publication, no L1 burn/claim,
   no spending existing NFTs or primary-account assets without explicit approval.
7. Phase G browser: walletd web UI ≠ browser extension; do not conflate. Real `window.tari`
   remains unverified (reference provider only) — carry that boundary forward.
8. Deliver: PR from this branch, CI green, CHECKPOINT.md updated with final results.

## P8. Environment facts worth keeping

- walletd URL/loopback rule: executor asserts loopback (assertLoopback) — keep.
- Indexers still 0.46.1, network_byte 38, epoch ~12,355+ (2026-10-16/17).
- `docs/screenshots/*-market.png` (PR #8) are fixture-driven PRESENTATION captures via
  `CAPTURE_README=1 npx playwright test capture-readme` — do not mistake for live data.
- Existing test baselines before this campaign: 714 node tests, 278 e2e (--retries=0), CI green.
