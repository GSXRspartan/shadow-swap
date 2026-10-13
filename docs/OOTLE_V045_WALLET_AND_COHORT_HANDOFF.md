# Ootle v0.45 — Walletd Upgrade & Full-Cohort Migration Handoff

Date: **2026-10-07**
Branch: **`feat/v045-walletd-and-full-cohort`** (tracking `origin/…`, pushed)
Head: **`478d7acfd0f29d3f6ead08f4b6fe037054304c19`**
Base: `5aebc5d` (`fix(wallet): fall back to legacy pool decode for pre-decoded readers`) on top of `origin/main`

This records the work that moved the protocol from the v0.42.0 (rev `a43773e`) line to the
**v0.45.0** line, upgraded the local `walletd`, hardened the pool reader, and brought CI to
green. All three changes are committed and pushed; both GitHub workflows passed on the head
commit.

## Commits in this handoff

| SHA | Subject |
|---|---|
| `478d7ac` | fix(wallet): fail closed on raw-capable pool readers; make browser doubles deliver raw Pool substates |
| `368c153` | chore(templates): pin Ootle cohort to v0.45.0 (9c62606), tari_crypto 0.24.0 |
| `5aebc5d` | fix(wallet): fall back to legacy pool decode for pre-decoded readers *(base of this slice)* |

## 1. walletd upgraded 0.42.0 → 0.45.0 (local, live Esmeralda)

- Binary: `C:\Users\pdark\Downloads\walletd-0.45.0\tari_ootle_walletd.exe`
  sha256 **`1fa177e6f3a8191493561bf95f325e3e999fde91601535ff9d19c2d9fda803d8`** (verified on disk).
- Running PID **9148** on `127.0.0.1:5100`, started 2026-10-06 18:36.
- `wallet.get_info` → `network: esmeralda`, `network_byte: 38`, `version: **0.45.0**`.
- Both accounts preserved and `is_confirmed_on_chain: true`:
  - `component_de8ac076ff2299cfc6be32cb7b4f3bc67ad53c9f698c484ad6477b7aa553998b` — **"Purrivacy Swap"** (default, index 0).
  - `component_b510055406cbe43325aa7790a38f980eb03d354f525b0acc7c59461b07dde77d` — `V042_ATOMICSWAP_TEST_COUNTERPARTY` (index 1).
- Observed live epoch at probe time: **11950**; indexer `https://ootle-indexer-a.tari.com/`.

The previously documented block on live state-changing transactions (daemon was 0.42.0 while
the network line is 0.45) is **cleared**: the daemon now matches the line. Note that this handoff
submits **no new state-changing transaction** — the run remains read-only at the chain level
except that the daemon is now the correct cohort.

## 2. Full cohort migration to the v0.45.0 release commit (committed)

Every Tari/Ootle git pin moved from the v0.42.0 tag object `a43773e600b9503ed3fadcd3f0048f86131e3644`
to the **real v0.45.0 source commit `9c626062673760530ffb075b6b006a67becebe5a`**, and `tari_crypto`
was bumped `0.23.4 → 0.24.0` (the version the v0.45.0 workspace pins).

| Manifest | Change |
|---|---|
| `templates/fungible_pool/Cargo.toml` | `tari_template_abi`/`_lib` → `9c62606` |
| `templates/nft_marketplace/Cargo.toml` | → `9c62606` |
| `templates/nft_item_offer/Cargo.toml` | → `9c62606` |
| `templates/nft_collection_bid/Cargo.toml` | → `9c62606` |
| `audit_engine_tests/Cargo.toml` | tooling crates → `9c62606`; `tari_crypto 0.23.4 → 0.24.0` |
| `audit_engine_tests/templates/{faucet,hostile,nft_faucet}/Cargo.toml` | → `9c62606` |
| all regenerated `Cargo.lock`s | contain **no** `a43773e` |

The Pool v2 artifact published on chain (`template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab`)
was built at `a43773e` and **remains the on-chain identity** — this cohort bump is the
development/build cohort only; **no Pool was republished**.

All four templates build clean under v0.45.0 (`cargo build --release --target wasm32-unknown-unknown`):

| Template | wasm sha256 | size |
|---|---|---|
| `fungible_pool` | `dd5cc4f92984d85a33d73533e46e6a0710f71010ac7087d0eeb09a7c65e2ee6c` | 244024 B |
| `nft_collection_bid` | `f2c7c1c96df3c53aed2a30f0837efa7f6929ec947206850d98d9e979f2bbf475` | 201633 B |
| `nft_item_offer` | `5889559157e70d24fe77a091ca6bf4cf6ba179e6cd84a3b230911880068340d0` | 201769 B |
| `nft_marketplace` | `98dae4952edff98a07af16ec15cd40504450971747efa6925ac397cdc698d044` | 196719 B |

## 3. Pool reader hardening + browser test doubles

- **`packages/protocol-client/src/ootle.ts`** — `readPool` no longer downgrades a
  `readRaw`-capable reader to the legacy flat-field parse. A raw decode failure now yields
  `UNAVAILABLE`; the legacy path is reachable only for readers **without** `readRaw`. This is
  correct because the live Pool keeps reserves in **VAULT** substates and LP supply in the LP
  **RESOURCE** substate — a flattened envelope must never be turned into a reserve.
- **`packages/protocol-client/test/pool_substate.test.cjs`** — asserts the fail-closed contract
  (no downgrade, no invented reserve).
- **Browser doubles fixed** — the e2e `referenceProvider` and conformance `contractProvider` had
  advertised `readRaw` but answered `tari_getSubstate` with a flat `fields` map, which only
  "passed" through the removed downgrade. They now return genuine
  `{ Component | Vault | Resource }` substates from a shared fixture
  (`apps/web/e2e/rawPoolSubstates.ts`), with canonical `resource_<64hex>` addresses matching the
  wallet balances. **No assertion was weakened.**

Root-cause note: an earlier report of "112 passed / 32 failed, all chromium-mobile" was a
stale-build artifact. On a clean build **both** chromium-desktop and chromium-mobile failed the
same pool tests until the doubles were corrected.

## Test evidence

### Local (clean build)

| Suite | Result |
|---|---|
| `@tari-ootle/protocol-client` (full) | **209 / 209** |
| protocol-client pool_substate + amm | 24 / 24 |
| `@tari-ootle/wallet-adapter` typecheck + tests | typecheck OK, **21 / 21** |
| web unit tests | **344 / 344** |
| web e2e — `security` + `wallet-conformance` (chromium-desktop + chromium-mobile) | **110 / 110** |
| web e2e — `hosting` | **17 / 17** |
| rustfmt (8 manifests) | clean |
| secret scan (changed/untracked files) | CLEAN |

### CI on head `478d7ac` (both workflows green)

| Workflow | Job | Result |
|---|---|---|
| **Node Tests** | protocol-client | success |
| | wallet-adapter | success |
| | web | success |
| | browser-security (`test:e2e:all`) | success — **233 / 233 passed (1.4m), 3 browser projects + hosting** |
| **Security Engine Tests** | engine-tests (`audit_engine_tests`, Linux) | success — **112 passed, 0 failed** across all test binaries |

- Node Tests run: `37575871176`
- Security Engine Tests run: `37575871348`

## Tag / commit correction (important)

`docs/OOTLE_V045_CONFORMANCE.md` previously claimed "the tag commit itself is `7b16f2a0…`".
That is wrong and has been corrected there:

- **`7b16f2a0a3c4ee548aaaa20bf597ffd489839cd5` is the annotated tag OBJECT.**
- **`9c626062673760530ffb075b6b006a67becebe5a` is the release COMMIT** the tag dereferences to
  (`v0.45.0^{}`). `9c62606` is the correct build pin, not a `template_lib` subtree commit.

## Backup & rollback

- Pre-upgrade backup: `C:\Users\pdark\.tari\ootle\v042-esmeralda-bootstrap.backup-pre045-20261006-183615`
  — verified restorable (`integrity_check = ok`, 26 tables, 2 accounts).
- Rollback: stop the 0.45 daemon, restore the backup directory, start the 0.42 binary. The
  chain-level state is untouched (no Pool republish, no new mutation).


# Independent audit (2026-10-07, second reviewer)

Everything above was re-derived from primary evidence, not trusted from the handoff. The
audit found the cohort, wallet and CI claims CORRECT, and added hardening on top:

## What was independently re-verified

| Claim | How it was re-verified | Result |
|---|---|---|
| v0.45.0 revision | GitHub tags API: `refs/tags/v0.45.0` is an annotated tag object `7b16f2a0…` whose `object.sha` dereferences to commit `9c626062…` ("chore: release v0.45.0 (#2801)"); the release asset itself is named `tari_ootle-0.45.0-9c62606-windows-x64.exe.zip` | **CORRECT** (`9c62606` is the build pin) |
| walletd binary | `Get-FileHash` on the running executable: `1fa177e6…`, matching the upstream `.sha256` sidecar | **CORRECT** |
| walletd runtime | PID 9148, `127.0.0.1:5100` ONLY (loopback), `wallet.get_info` → `0.45.0` / esmeralda / 38 | **CORRECT** |
| Backup | direct sqlite read of the backup copy: `integrity_check=ok`, `journal_mode=delete` (self-contained, no WAL dependency), 26 tables, 2 accounts, schema_version 84 | **CORRECT** |
| Accounts preserved | live `accounts.list`: "Purrivacy Swap" (default) + `V042_ATOMICSWAP_TEST_COUNTERPARTY`, both `is_confirmed_on_chain: true`, receive address `otl_esm_1w3j5x3l8uzxccggk…` | **CORRECT** |
| Live Pool v2 state | `decodePoolState` over walletd `substates.get` AND indexer A AND indexer B: reserves 595664 / 604684, LP supply 600000, locked 1000, fee 30 — all three sources agree exactly | **LIVE READ VERIFIED** |
| Template builds | all four templates rebuilt locally; byte-identical SHA-256 to the recorded values | **BUILD VERIFIED** |
| Rust suites | pool_math 36, pool_ref_model 22, protocol_types 10; rustfmt clean on all 8 manifests; clippy `-D warnings` clean | **UNIT VERIFIED** |
| TS suites | protocol-client 209/209 → re-run after hardening; web 344 → 346/346; Chromium e2e 148 → 150/150 | **UNIT/E2E VERIFIED** |

## Two real defects the audit found and fixed

### 1. The raw Pool decode was fail-open on identity (security)

`decodePoolState` never checked the component's `template_address`, and treated the
resource `address` inside a vault container as optional. So a raw-capable provider could:

- serve a DIFFERENT component that merely decodes like a pool (no template pin existed on
  the raw path, while the legacy flat-field path DID check the template name);
- declare the pair (tTARI, LPTESTA) while its reserve vaults held other resources.

Both are now fail-closed (`packages/protocol-client/src/poolSubstate.ts`):

- the component header MUST name its template (every raw-serving transport carries it, so
  a header without one is a stale or hand-made payload);
- each reserve vault MUST carry a container `address` and MUST hold the declared pair leg;
- the locked-LP vault MUST hold the declared LP resource;
- a caller may pin `expect.templateAddress/resourceA/resourceB/lpResource`, and
  `readPool(component, expect)` threads the pin through BOTH the raw and legacy paths
  (`packages/protocol-client/src/ootle.ts`).

The app now pins every authoritative reread: a protocol-verified registry seed wins
(`seededTemplateFor`, `apps/web/src/services/poolRegistry.ts`), otherwise discovery's own
verified header claim is the pin (`apps/web/src/state/AppContext.tsx`), so the wallet's
bytes must name the same template discovery found.

New regressions cover the full matrix: wrong template (pinned and unpinned), wrong pair,
wrong component, missing vault, missing LP resource, incorrect substate type, unrecognised
container, non-integer amounts, absent dependent substates, and a raw reader that also
carries plausible flat fields — which must never reach the legacy parser.

### 2. `create-pool` defaulted to the SUPERSEDED Pool v1 template

`tools/live-executor/cli.mjs` shipped `POOL_TEMPLATE = ef2bc1b0…` — the owner-controlled
v1 template (the OPUS-16 class the v2 template exists to close). A command that looked
current would have instantiated a pool from the wrong cohort. The template is now never
defaulted: it must be named explicitly and must equal the audited Pool v2 template
(`assertAuditedPoolTemplate` in `walletd.mjs`, unit-tested).

## Additional live verification (v0.45, read-only + dry-run)

- **Pool security, live**: the LP resource substate shows `owner_rule: None`, `mint` and
  `burn` `Restricted → ScopedToComponent: component_8c20c644…`, `recall: DenyAll`,
  `freeze: DenyAll`, and every rule updater `Locked`. The component shows
  `owner_rule: None`, `get_a_resource`/`get_b_resource` absent from the method set (DenyAll
  default) — calling them returns `AccessDenied`. **LIVE VERIFIED, #2759 class closed.**
- **STEST (created-stealth) is still rejected by the pool**: a `Pool::new(STEST, LPTESTA)`
  dry run returns `TemplateError: Resource … is not eligible: only canonical native Tari…`,
  and `pool.add_liquidity(STEST + LPTESTA)` returns `TemplateError: Resource … not in pool`,
  while the control `Pool::new(tTARI, LPTESTA)` is ACCEPTED. **POOL_TEMPLATE_BLOCKED holds
  under v0.45. LIVE VERIFIED.**
- **Dry-run conformance** (`tools/live-executor/dryrun-pool.mjs`, all `dry_run: true`, no
  state change): reads Accept; input selection Accept for tTARI (stealth reveal) and public
  fungibles; burn refused (DenyAll); swap Accept with `min_output` derived from live
  reserves; slippage failure returns `Slippage: output 9954 is below min_output 99540`;
  wrong pair returns `Pool resources must differ`; balanced add Accept; unbalanced add
  returns `Contribution too small relative to reserves to mint any LP shares`; over-balance
  add and over-hold remove return InsufficientFunds; over-supply remove returns
  `Redemption too small to withdraw any reserves`. Fee estimates: swap 3342, add 4269,
  remove 4141, empty manifest 1062 micro-tTARI — all far under the 1 tTARI ceiling.
  **DRY-RUN VERIFIED.**
- **Durable wallet request lifecycle** (`tools/live-executor/verify-request-flow.mjs`),
  against the real daemon with a READ-ONLY manifest: `transaction_requests.create` →
  durable `request_id`, `.get` → `Pending`, `.list` → present, `.reject` → persisted
  `Rejected`, and a SECOND `.reject` is REFUSED (`is Rejected, expected Pending or
  Approved`). No submission. **LIVE VERIFIED** for the daemon half of the browser contract.
  The browser half remains REFERENCE PROVIDER VERIFIED (no real `window.tari` here).
- **Indexer substate proofs** (§ evidence labels): `GET /info` reports
  `verify_substate_proofs: true` and `POST /substates/fetch` accepts `include_proofs: true`,
  returning `{anchor: {block_id, epoch, height, shard_group, state_merkle_root},
  commit_proof, value_proof, value_hash_epoch}`. Official verification lives in the Rust
  Tari-crypto state-Merkle verifier, which is NOT in this repository's JS dependency tree,
  and writing our own verifier is out of scope by policy. **PROOF_AVAILABLE_NOT_YET_VERIFIED.**

## Wallet inventory after the upgrade (re-read live)

All previous assets are present: canonical tTARI (Stealth), STEST (Stealth), PTEST,
LPTESTA, LPTESTB, the two LP resources (v1-scoped and v2-scoped), and the TNFTA/TNFTB
collections (zero items). One NEW finding: the wallet holds one actual NFT item
(`V042R`, id `v042-restart-swap-a-7f3c9`), so `NO_EXISTING_NFT_TEST_ASSET` is no longer
the correct label — disposable NFT marketplace flows are now actionable. They were NOT run
in this pass, so that the v0.45 migration could not be delayed by them.

Two pool LP resources exist because Pool v1 (LP scoped to `component_329d4ef2…`) still
exists on chain alongside Pool v2 (LP scoped to `component_8c20c644…`). Only v2 is seeded
in the registry; v1 is superseded and never a place to send new liquidity.

## Browser doubles

The e2e Pool fixtures now serve the REAL wire shape — the published Pool v2 template in the
component header and the resource `address` inside every vault container — instead of a
placeholder, and three NEW hostile-provider flows prove the browser refuses a raw-capable
provider that does not deliver it:

- `matrix 7d` — a wrong-template pool is not displayed (the honest "state not yet read"
  candidate view is shown instead);
- `matrix 7e` — a provider omitting the vault resource address is refused;
- `matrix 7f` — a provider reporting a reserve vault as absent is refused, never invented.

The hostile bytes are BAKED into the provider script (`hostileRawPoolSubstates` in
`apps/web/e2e/rawPoolSubstates.ts`), so the very first reply is already hostile and the
double is deterministic. No assertion was weakened: the control (`matrix 1`) still renders
the pool from the same decoder.

## Remaining / open items

- **CI-only Firefox coverage**: firefox-desktop runs only in CI (`test:e2e:all`); it is green.
- **R-1 hosting**: `dist/_headers` emission is build-checked, but "served by the real origin"
  remains open until the deployed origin is observed (`docs/TESTNET_HOSTING.md`).
- **Walletd 0.45 daemon is local-only**; it is not a committed artifact.
- **Live browser approval** needs a real `window.tari` provider and a human approval step;
  the durable request lifecycle is verified on the daemon side and via the reference
  provider in the browser, which is the honest ceiling without a real wallet.
- **NFT marketplace flows are actionable** (one disposable `V042R` NFT item is held) but
  were deliberately not run in this pass, so the v0.45 migration could not be delayed.
- **Optional tiny live smoke swap** on Pool v2 (<= 1 tTARI single tx, <= 0.25 tTARI
  economic) was NOT submitted this run: dry-run coverage is complete, and a live
  submission is an operator decision, not a migration requirement.
## Final CI on the audited head (both workflows green)

Head `79f7037` (`feat/v045-walletd-and-full-cohort`), pushed and verified:

| Workflow | Run | Result |
|---|---|---|
| Node Tests | `37601955897` | success — protocol-client **220/220**, wallet-adapter **21/21**, web **346/346**, browser-security **150/150** |
| Security Engine Tests | `37601955898` | success — Linux engine suite **44 passed / 0 failed** across 8 binaries, pool_math 36, pool_ref_model 22, protocol_types 10, all four templates built, rustfmt + clippy `-D warnings` clean |

Local counts matched CI exactly for every suite that runs locally.

## Walletd daemon state at the end of the audit (operator action, recorded honestly)

The upgrade itself was verified while v0.45.0 was running (`wallet.get_info` ->
`0.45.0`, loopback-only listener, both accounts confirmed). Afterwards, at
2026-10-07 00:21 local, the daemon was restarted from OUTSIDE this audit with the OLD
binary (`tari_ootle_walletd-0.42.0-a43773e-windows-x64.exe`, PID 11836, loopback
`127.0.0.1:5100` only). This audit did not restart it: the daemon is operator-owned
infrastructure and reverting it is an operator decision, not an audit one.

Consequences checked and clean:

- the wallet DB is intact after the revert (`integrity_check=ok`, `journal_mode=delete`,
  schema_version 84, 2 accounts);
- the three-source Pool v2 read still agrees exactly (595664 / 604684 / 600000 / 1000 /
  30) at epoch 11958, so the recorded live state does not depend on which daemon serves it;
- the verified v0.45.0 binary is still in place at
  `C:\Users\pdark\Downloads\walletd-0.45.0\tari_ootle_walletd.exe` with SHA-256
  `1fa177e6f3a8191493561bf95f325e3e999fde91601535ff9d19c2d9fda803d8` (unchanged mtime),
  so re-upgrading is a single operator restart against the same base path.

Note for the operator: the current DB has been written by BOTH 0.42.0 and 0.45.0. Both
used schema_version 84, and the restore-safe pre-upgrade backup is unchanged, but the
policy "never downgrade a migrated DB in place" is now satisfied only by luck rather
than by sequence. If any anomaly appears, stop the daemon, restore the pre-v0.45 backup
directory, and run 0.42 against THAT restored copy.

The audit hardening is itself regression-covered: the pool decoder grew from 7 to
**18 tests** (identity + downgrade matrix), the executor from 7 to **8** (the audited
pool-template guard), the registry suite from 9 to **12** (the template pin), and the
browser conformance matrix from 22 to **25 flows** (three hostile-provider refusals).
- No open blockers in code or CI. `feat/v045-walletd-and-full-cohort` is ready to open as a PR.

## Evidence index

- `packages/protocol-client/src/ootle.ts`, `packages/protocol-client/src/poolSubstate.ts`
- `packages/protocol-client/test/pool_substate.test.cjs`
- `apps/web/e2e/rawPoolSubstates.ts`, `apps/web/e2e/referenceProvider.ts`, `apps/web/e2e/wallet-conformance.spec.ts`
- `apps/web/src/services/walletService.ts`, `apps/web/src/services/tariWindow.ts`, `apps/web/src/services/ootleIndexer.ts`
- `.github/workflows/node-tests.yml`, `.github/workflows/security-engine-tests.yml`
- `docs/OOTLE_V045_CONFORMANCE.md`, `docs/ESMERALDA_POOL_V2_REPORT.md`
