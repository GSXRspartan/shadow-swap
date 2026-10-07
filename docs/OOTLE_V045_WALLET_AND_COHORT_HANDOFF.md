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

## Remaining / open items

- **CI-only Firefox coverage**: firefox-desktop runs only in CI (`test:e2e:all`); it is green.
- **R-1 hosting**: `dist/_headers` emission is build-checked, but "served by the real origin"
  remains open until the deployed origin is observed (`docs/TESTNET_HOSTING.md`).
- **Walletd 0.45 daemon is local-only**; it is not a committed artifact.
- No open blockers in code or CI. `feat/v045-walletd-and-full-cohort` is ready to open as a PR.

## Evidence index

- `packages/protocol-client/src/ootle.ts`, `packages/protocol-client/src/poolSubstate.ts`
- `packages/protocol-client/test/pool_substate.test.cjs`
- `apps/web/e2e/rawPoolSubstates.ts`, `apps/web/e2e/referenceProvider.ts`, `apps/web/e2e/wallet-conformance.spec.ts`
- `apps/web/src/services/walletService.ts`, `apps/web/src/services/tariWindow.ts`, `apps/web/src/services/ootleIndexer.ts`
- `.github/workflows/node-tests.yml`, `.github/workflows/security-engine-tests.yml`
- `docs/OOTLE_V045_CONFORMANCE.md`, `docs/ESMERALDA_POOL_V2_REPORT.md`
