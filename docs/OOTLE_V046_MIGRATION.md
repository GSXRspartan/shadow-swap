# Ootle v0.46.0 — Migration Record and Live Verification

Date: **2026-10-13**
Branch: **`feat/v046-liquidity-continuation`** (base `0a2a7e2` = `origin/main`)

This records the migration of the repository from the Ootle **v0.45.0** cohort to
**v0.46.0**, and the read-only live verification performed against Esmeralda after the
network activated Protocol V2.

Everything marked **LIVE VERIFIED** below was observed on the public network during this
session. Everything marked **UNVERIFIED** is stated as such rather than assumed.

---

## 1. The upstream identity (established, not assumed)

| Fact | Value | How it was established |
|---|---|---|
| Release tag | `v0.46.0` | GitHub releases API |
| Annotated tag **object** | `b2fa1e5b588d48d19c28687914859c66bf049591` | `git/refs/tags/v0.46.0`, `type: tag` |
| Release **commit** (`v0.46.0^{}`) | **`cc8a83bcab88e03e0fcf760d2652ab6f1e067d8a`** | dereferenced the tag object |
| Published | `2026-10-13T10:47:46Z` | releases API |
| Marked prerelease | yes | releases API |
| Delta from v0.45.0 (`9c62606…`) | **85 commits, 300 files** | compare API |
| Windows walletd asset | `tari_ootle_walletd-0.46.0-cc8a83b-windows-x64.exe` | releases API |

`cc8a83b` is the correct build pin. This is the same tag-object-vs-release-commit
distinction the v0.45 handoff recorded (`7b16f2a0…` was the object, `9c62606…` the
commit); it is repeated here because getting it wrong silently builds against the wrong
tree.

## 2. The network is ALREADY on v0.46 / Protocol V2

The v0.46.0 release notes schedule **Protocol V2 activation on Esmeralda at epoch
12220**. Observed at the time of inspection:

| Source | version | network | byte | current_epoch |
|---|---|---|---|---|
| `ootle-indexer-a.tari.com/info` | **0.46.0** | esmeralda | 38 | **12231** |
| `ootle-indexer-b.tari.com/info` | **0.46.0** | esmeralda | 38 | **12231** |

The observed epoch is **past 12220**, so the V2 activation has already happened. This is
not a future migration — the network cohort changed under this repository while it was
parked, and any local daemon still on 0.45.0 is now an **incompatible cohort**.

Consequence, stated plainly: **no live state-changing transaction may be submitted with a
0.45.0 daemon.** The live pool reads recorded in §4 are unaffected (they go to the
indexers, not a daemon), but any execution requires the 0.46.0 walletd.

## 3. Requirement-by-requirement migration analysis

Each row is a real upstream change in `v0.45.0…v0.46.0`. "Action" says what this
repository had to do; "still needed" says what remains.

### 3.1 `Amount` / template ABI encoding — **UNCHANGED (verified negative)**

| Check | Result |
|---|---|
| Files under `crates/template_lib_types/` changed between the two revs | **none** |
| Files under `crates/template_abi/` changed between the two revs | **none** |
| `tari_template_abi` version | `0.20.1` at **both** revs |
| `tari_template_lib` / `tari_template_lib_types` version | `0.34.0` at **both** revs |
| `tari_crypto` | `0.24.0` at **both** revs |

The compare API returned **zero** changed files under either path. Template argument
encoding — including `Amount` — is therefore byte-identical and **requires no change**.
This was checked specifically because it is the kind of change that would silently corrupt
every on-chain amount.

**Action taken:** none to encoding. Cohort rev bumped only (see §5).

### 3.2 Template return values removed — **HARD BREAK, migrated**

Upstream `#2859` *stop recording template return values in the transaction result*.

- `FinalizeResult` **CBOR field index 3 is retired**; upstream's own comment is
  *"Index 3 is retired: it carried template return values, which payloads from older nodes
  may still hold and decoding skips. It must not be reused."*
- `bindings/src/types/InstructionResult.ts` is **deleted**.
- `bindings/src/types/FinalizeResult.ts` no longer contains `execution_results`.
- `ExecuteResult::expect_return<T>()` is gone.
- Upstream's prescribed replacement: **read component state or events instead**.

Call sites found and migrated:

| Site | Was | Now |
|---|---|---|
| `audit_engine_tests/tests/pool_adversarial.rs` | `res.finalize.execution_results[0].get_value("$.0")` | `t.return_values()[0].get_value("$.0")` |
| `audit_engine_tests/tests/opus08_eligibility.rs` | `res.finalize.execution_results[0].get_value("$.1")` | `t.return_values()[0].get_value("$.1")` |
| `audit_engine_tests/tests/opus08_recall_demo.rs` | `res.finalize.execution_results[0].get_value("$.0"/"$.1")` | `t.return_values()[0].get_value(...)` |
| `tools/live-executor/cli.mjs` `read-pool` | dry-run manifest + `execution_results` | `decodePoolState` over raw substates |
| `tools/live-executor/nft-market-core.mjs` `readMarketplace` | dry-run manifest + `execution_results` | `decodeListing`/`decodeItemOffer`/`decodeCollectionBid` |
| `tools/live-executor/verify-decoder-live.mjs` | decoder vs. template getter | decoder vs. escrow vault substate |

**Why `return_values()` and not `expect_return::<(A, B)>(0)`.** `expect_return` has the
bound `T: for<'b> tari_bor::Decode<'b, ()>`. This repository cannot compile the engine test
crate on Windows (§7), so a tuple `Decode` impl could not be verified locally, and upstream
publishes no example of decoding a tuple from an `IndexedValue` — only single
`ComponentAddress` decodes. `IndexedValue::get_value::<T>(path)` carries the *identical*
bound and was the expression that already compiled at v0.45, so reusing it against the
harness's own captured outputs cannot fail for a reason the old code did not already
satisfy. This deliberately trades a little elegance for not shipping an unverifiable
bound.

**The migration is a strict improvement, not a downgrade.** The retired getter path returned
what the *component claimed*. The component-state path additionally pins the published
template address and cross-checks the escrow vault's resource against the declared one.

### 3.3 `FinalizeResult.total_fees_required` — new — **acted on**

New field (CBOR index 6) holding what committing the whole transaction was priced at. It
can exceed the envelope's `required_fees`, and it differs most when only the fee intent
commits.

**Action:** `tools/live-executor/walletd.mjs` now gates the per-transaction fee ceiling on
the **maximum** of `required_fees` and `total_fees_required`. Gating on the envelope alone
would let through a transaction the node then refuses.

### 3.4 `ExecuteResult.wasm_execution_points` / `native_execution_points` — new

Both are additive, default-0 on decode from older payloads. No code in this repository
reads either. **No action.** Recorded because engine metering is what these quantify.

### 3.5 `RejectReason` — new variants and a new structured `code`

`TransactionResult` itself is **unchanged**: still exactly
`{ Accept } | { AcceptFeeRejectRest: [SubstateDiff, RejectReason] } | { Reject: RejectReason }`
(verified against `bindings/src/types/TransactionResult.ts` at `cc8a83b`). The executor's
accepted/rejected verdict therefore still keys off the same outer variants and did **not**
break.

`RejectReason` did change, in two ways that matter:

1. `ExecutionFailure` now carries a structured `code: ExecutionFailureCode`
   (`TemplateError`, `AccessDenied`, `AssertionFailed`, `InsufficientFunds`,
   `OutOfCompute`, `LimitExceeded`, `InvalidArgument`, `NotFound`, `DanglingResources`,
   `ResourceRestricted`, `InvalidProof`, `EngineInvariant`, `NotYetValid`, `Unclassified`).
   The rendered message reaches consensus as prose and is **not** a stable contract.
2. **Unit variants serialize as bare JSON strings**, not objects —
   `"FeePaymentInMainIntent"` and `"ForeignPledgeInputConflict"`. A consumer that assumes
   a reject reason is an object will read `undefined` off it.

**Action:** added `describeRejectReason()` in `walletd.mjs`, which handles both shapes,
prefers the structured code over the message, and returns `UNRECOGNISED` rather than
silently dropping an unknown reason. `summariseResult()` now records the reason in the
ledger. **7 new unit tests** cover every v0.46 reason variant and the bare-string shape.

### 3.6 `detect_inputs` refuses signed submissions — **no action, verified**

Exactly one `detect_inputs` site exists: `walletd.mjs` `publishTemplate()`, which passes
only `binary` / `fee_account` / `max_fee` / `dry_run` and never attaches signatures. Every
manifest submission sends `signing_key_ids: []` — the delegate-signing path, never
pre-signed. **No code change required.**

### 3.7 Transaction-request approval requires a wallet session — **RESOLVED BY DESIGN, verified in code**

Upstream `#2855`: approving a transaction request now requires an interactive user session
in the wallet.

The browser app uses exactly the create → approve → submit trio
(`apps/web/src/services/tariWindow.ts:747`, `walletService.ts:313`), so this change lands
in its path. Inspection of the consuming code, however, shows the app already handles the
new behaviour correctly, because it never assumed approval was immediate:

```ts
case 'PENDING':
  // The human has not answered. Nothing is submitted and nothing is an
  // error; the durable id is already persisted for a later resume.
  return { pendingRequestId: requestId };
```

(`submitViaTransactionRequest`, `tariWindow.ts:911-914`.) Under a session-gated approve,
the request simply stays `pending`, the app persists the durable id, and the user resumes
later — no error, no stuck state, no double submission. An unrecognised status still fails
closed (`UNKNOWN_STATUS`).

The requirement is therefore met **by the app's existing design**. What still cannot be
verified without a real wallet extension is the extension's own behaviour; that remains an
integration-test item, not a code defect.

### 3.8 Indexer rate limits on all public read routes — **acted on**

Upstream `#2823`. This is new and directly affects discovery, which issues a burst of
requests.

**Before:** HTTP 429 collapsed into the same `"The discovery endpoint returned HTTP 429"`
text as any other failure, which discovery then reported as `INDEXER_UNAVAILABLE`.

That is a false claim about the network: the host was up and answering, and the burst is
usually this app's own request rate. Under v0.46 that misreport becomes routine.

**Action:**
- `apps/web/src/services/net.ts`: 429 is detected, retried up to `RATE_LIMIT_RETRIES`
  (2) honouring `Retry-After` (capped at 4s, bounded exponential backoff otherwise), and
  returned as a distinct `{ rateLimited: true }`.
- `ootleIndexer.ts`: new `RATE_LIMITED` deployment state, propagated from every transport
  call site (catalogue, receipts, substate batch).
- `pools.ts` / `AppContext.tsx` / `PoolsPage.tsx`: rendered as an **informational**
  "wait a moment and refresh", never as an outage.

Retries are deliberately bounded: an unbounded retry against a rate limiter converts a
throttle into an outage by making it worse.

### 3.9 Verified substate reads need a recent anchor — **no behaviour change required**

`{ requests: [...], cached_only: false }` is still the live request shape and is still
accepted (confirmed live, §4). The stricter requirements apply to the *verified* read
path, which this repository does not use: `include_proofs` appears in **zero** code sites
and no substate proof is ever verified here. The existing
`PROOF_AVAILABLE_NOT_YET_VERIFIED` posture from the v0.45 conformance record still holds
unchanged.

### 3.10 Engine metering / publish fees — **monitored**

One shared WASM budget across nested template calls; argument scanning/decoding and
return-value handling are now charged; compile work is billed at publish.

Practical effect: **every transaction becomes slightly more expensive**, and recorded fee
estimates from the v0.42/v0.45 era will not reproduce exactly. This is a cost fact, not a
correctness one. The 1 MiB `max_template_binary_size_bytes` ceiling and the quadratic size
premium are **unchanged** (both `fee_table.rs` and `fee_module.rs` are byte-identical
between revs), and at 244 KB the largest template is ~24% of the cap.

### 3.11 New WASM *shape* caps — **UNVERIFIED, carried as a risk**

v0.46 adds hard module-shape ceilings that can refuse a publish outright:
`max_function_metering_checks = 8192`, `max_function_loops = 512`,
`max_module_loops = 2048`, `max_function_nesting_depth = 1024`. A refusal is not a price
increase — it is a hard reject.

These are **UNVERIFIED for this repository's four templates.** Measuring
`metering_checks` requires the engine's own instrumentation, and no WASM tooling
(`wasm-objdump`, `wasm-tools`) is available on this machine. They can only be settled by a
publish dry-run against a 0.46.0 daemon. Mitigating evidence, stated as such: the four
templates build at 196–244 KB, essentially identical in size to their v0.45 builds, and
`tari_template_lib`/`tari_template_abi` did not change at all — so the module shape is
expected to be within the caps. **Expected is not verified.**

### 3.12 Validator metrics moved off JSON-RPC — **no action, verified negative**

The repository reads no metrics endpoint over JSON-RPC and contains no reference to
`127.0.0.1:18201`. Every "metrics" hit in the tree is pool-liquidity metrics or a CSS
font metric. **No impact.**

### 3.13 Confidential deposits rejected by the builtin liquidity pool — **no action required**

Upstream `#2900` added `Bucket::assert_contains_no_confidential_funds()` to the *upstream
builtin* pool. This repository's own pool template already refuses `ResourceType::Confidential`
at `Pool::new` (`templates/fungible_pool/src/lib.rs:438-450`), so no confidential bucket can
reach a vault. Adding the assertion would be optional defence-in-depth, not a fix for a
reachable defect.

### 3.14 m-of-n duplicate requirement rejection — **no action, verified negative**

Zero m-of-n rules exist in this repository. The largest rule set is the pool's nine
`AllowAll` entries, far under the new `MAX_ACCESS_RULE_NODES = 1024`.

### 3.15 `STEALTH_TARI_RESOURCE_ADDRESS` vs `TARI_TOKEN` — **no action required**

Both names exist at `cc8a83b`; only `XTR`/`ONE_XTR` are deprecated. Templates use the
former, tests the latter. Both are correct.

---

## 4. Pool v2 deployment: PRESERVED, not republished

This was verified live against **both** independent indexers, decoding with the same
strict `decodePoolState` the product quote path uses.

| Field | Value |
|---|---|
| Pool component | `component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2` |
| Template | `template_f47a330eee1bbf91f58d9ff4280b4279c3c4fe91fb59ab5812cd5128442819ab` (published epoch 11931) |
| `owner_rule` | **`None`** |
| method access | `add_liquidity`, `fee_bps`, `get_pool_balance`, `get_pool_balances`, `locked_lp_supply`, `lp_resource`, `lp_total_supply`, `remove_liquidity`, `swap` — all `AllowAll`; default `DenyAll` |
| Pair | `resource_0101…0101` (canonical tTARI) / `resource_87385b51…` |
| Reserves | `595664` / `604684` |
| Fee | `30` bps |
| LP total supply / locked | `600000` / `1000` |

**Both indexers returned byte-identical decoded state.** The values are also **identical to
the v0.45 record** (595664 / 604684 / 600000 / 1000 / 30), so no state changed across the
V2 activation.

`owner_rule: None` is the **OPUS-16** fix — the deployed pool is ownerless, so the deployer
cannot `SetAccessRules` and freeze LP funds. The #2759 class remains closed under v0.46.

### 4.1 All five protocol templates still present

Read from the live v0.46.0 catalogue:

| Template | Address | Published at epoch | Status |
|---|---|---|---|
| `Pool` (v2) | `template_f47a330e…2819ab` | 11931 | **audited, in use** |
| `FixedPriceListing` | `template_612114e3…a2329` | 11776 | published |
| `ItemOffer` | `template_083fef7d…22a6` | 11775 | published |
| `CollectionBid` | `template_999ef37f…06a54` | 11775 | published |
| `Pool` (v1) | `template_ef2bc1b0…d5649` | 11775 | **superseded, never seed new liquidity** |

**No template was republished.** A module published at the v0.42 cohort is re-executed by
the v0.46 engine, and the on-chain identities above all still work. Republishing would have
produced a second, differently-addressed Pool for no benefit and would have broken the
durable registry seed. Historical evidence in `live-op-ledger.jsonl` and the v0.42/v0.45
deployment reports is unchanged.

### 4.2 API observations worth recording

- `GET /templates/catalogue` **ignores `offset`** (verified: `limit=5&offset=0` and
  `limit=5&offset=50` return the same first page) and rejects `limit` outside 1–100.
  This repository already paginates by an `after=<template_address>` cursor, not `offset`,
  so the client is unaffected.
- `POST /substates/fetch` still accepts `{ requests: [id strings], cached_only: false }`
  and answers with a **map keyed by substate id** — the v0.43 contract, unchanged.
- Substate values still use the `@cbor` tagged encoding (`tag 131` = ResourceAddress,
  `tag 132` = VaultId), which is what `poolSubstate.ts` already decodes.

---

## 5. Cohort bump

Every Tari/Ootle git pin moved from `9c626062673760530ffb075b6b006a67becebe5a` to
`cc8a83bcab88e03e0fcf760d2652ab6f1e067d8a` — **8 manifests**:

| Manifest | Deps repinned |
|---|---|
| `audit_engine_tests/Cargo.toml` | all six tooling/transaction/engine crates |
| `audit_engine_tests/templates/{faucet,hostile,nft_faucet}/Cargo.toml` | `tari_template_lib` |
| `templates/fungible_pool/Cargo.toml` | `tari_template_abi`, `tari_template_lib` |
| `templates/nft_{marketplace,item_offer,collection_bid}/Cargo.toml` | both, each |

`tari_crypto = "0.24.0"` stays as-is (unchanged at v0.46.0, verified against the v0.46
workspace `Cargo.toml`).

### 5.1 Artifacts rebuilt under v0.46.0

All four build clean at `cc8a83b`:

| Template | bytes (v0.45 build) | bytes (v0.46 build) | SHA-256 (v0.46) |
|---|---|---|---|
| `fungible_pool` | 244 024 | **244 029** | `f330a7346c4fe492761cfedda036dcc756a29ed7fe1a48152e725a7c4a84e4b5` |
| `nft_marketplace` | 196 719 | **196 806** | `1e3cd9e4567adb3cc392315237017e77429af1063d2e304f8a9f562d94496a66` |
| `nft_item_offer` | 201 769 | **201 715** | `4a7e8732e1d5a2476cecb6ab47d8f7aa424c3fe5c2f71a107d648d24e9ddce1f` |
| `nft_collection_bid` | 201 633 | **201 096** | `86556978233c817c7c86c2857196ae6a55bcde9df8f7cccd9d4a8df9f96ddac3` |

Sizes moved by under 200 bytes, consistent with the template library being unchanged. These
are **development artifacts only**; the published templates remain those in §4.1.

---

## 6. Test evidence

| Suite | Result | Where |
|---|---|---|
| `tools/live-executor/walletd.test.mjs` | **13/13** (was 7; +6 v0.46 regressions) | local, Windows |
| protocol-client typecheck + build | clean | local |
| wallet-adapter build | clean | local |
| web typecheck | clean | local |
| `audit_engine_tests` | **cannot run on Windows** | see §7 |

Full local run recorded in `CHECKPOINT.md`.

## 7. Honest local limitation: the engine suite is CI-only

`audit_engine_tests` depends on `tari_engine`, which hard-codes
`wasmer = { features = ["cranelift"] }` with no V8 alternative exposed to a downstream
crate. On Windows the build fails at dependency compilation:

```
error: The Cranelift compiler backend is not supported on Windows. Use the V8 backend instead.
  --> wasmer-compiler-cranelift-7.5.0/src/lib.rs:22:1
```

This is a pre-existing, already-documented property of the harness, not something the v0.46
bump introduced. **The three Rust edits in §3.2 are therefore verified only by CI, not
locally.** They were written to reuse an expression (`IndexedValue::get_value`) that already
compiled at v0.45, specifically so that CI is the only new thing being asked to confirm.

## 8. What was NOT done, and why

- **No template republished.** §4 shows the existing deployments work.
- **No live state-changing transaction submitted.** The network is on Protocol V2 and the
  only local daemon is 0.45.0; that is exactly the incompatible-cohort case the runbook
  forbids.
- **No wallet database touched.** No daemon was started, so nothing could migrate or write.
- **No WASM shape-cap measurement.** No WASM tooling available; see §3.11.
- **Mainnet, L1 cross-chain and Created-Stealth lanes untouched**, as instructed.

## 9. Open items carried forward

| # | Item | Severity | Note |
|---|---|---|---|
| 1 | Wallet-extension behaviour under the new session requirement (`#2855`) | LOW | The app's own handling is verified correct by code inspection (§3.7): a session-gated approve degrades to a persisted `PENDING` resume, not an error. Only the extension's side needs a live integration test. |
| 2 | WASM shape caps for the four templates | MEDIUM | Needs a publish dry-run against a 0.46.0 daemon (§3.11). |
| 3 | Engine suite result under v0.46 | MEDIUM | CI is the only channel (§7). |
| 4 | `total_fees_required` reconciliation | LOW | Fee estimates recorded pre-v0.46 will not reproduce; re-measure before quoting a budget. Live v0.46 measurements now exist for the marketplace and swap paths (§10). |
| 5 | Substate proof verification | unchanged | `PROOF_AVAILABLE_NOT_YET_VERIFIED`; the verifier is not in this repo's dependency tree and is out of scope by policy. |
| 6 | Fee-paying-swap input requirement (`#2837`) | LOW | Our manifests always `account.withdraw(...)` first, so the input is explicit. The browser path deliberately never sends `inputs` — revisit if fee-paid-by-swap is ever adopted. |

## 10. Live session on v0.46.0: daemon upgrade, a decoder bug found by live data, and full marketplace verification

After the read-only verification in §4, the local wallet daemon was upgraded so that live
execution became possible. Everything in this section was performed against the live
esmeralda network with the 0.46.0 daemon.

### 10.1 Daemon upgrade — with a verified rollback point first

Sequence, in the order actually executed:

1. **Backup before any 0.46 binary ran.** `wallet.sqlite` (31 485 952 B,
   sha256 `4CD443163BA8C0237F51826AB06B7D4F78FCF7596AD6DDBFCEAC6EC2376E9F62`) plus config
   copied to `C:\Users\pdark\.tari\ootle\v042-esmeralda-bootstrap.backup-pre046-20261013-142449`.
   The backup was verified, not assumed: `PRAGMA integrity_check = ok`,
   `journal_mode = delete` (self-contained, no WAL dependency), 26 tables, 2 accounts.
2. **Binary verified against the official checksum.** `tari_ootle_walletd-0.46.0-cc8a83b-windows-x64.exe`
   (37 684 552 B) downloaded from the release; computed sha256
   `7e4b21c5c1a5e3aef438acc90360fccc9ca439ee12a3bd2275c179b10f733aa9` — **identical** to the
   official `.sha256` sidecar.
3. **The migration happened in place, as predicted.** After first start, the live DB hash
   changed to `A7934B40A9D808527803C127EA1F2EB4EF880C3A14C8097BE8D2BE8ECD552D5A`
   (31 494 144 B). Post-migration state verified read-only: `integrity_check = ok`,
   **27 tables** (one added), **both accounts intact** ("Purrivacy Swap" index 0,
   "V042_ATOMICSWAP_TEST_COUNTERPARTY" index 1), 690 transactions, 34 transaction
   requests, 512 shard state versions, diesel schema max version `20261008120000`.
4. **Daemon identity confirmed over JSON-RPC.** `wallet.get_info` →
   `{ network: "esmeralda", network_byte: 38, version: "0.46.0" }`; `settings.get` →
   `current_epoch 12234`, `indexer_url https://ootle-indexer-a.tari.com/`,
   `claimed_accounts: []`; `accounts.get_default` → "Purrivacy Swap",
   `component_de8ac076…`, `is_confirmed_on_chain: true`.

The daemon runs with `--authentication none` (loopback only), which is the mode the
executor's `authenticate()` was written for: `auth.request` with
`credentials: { None: null }` returns the short-lived Admin JWT. The config file itself was
**not** edited; the flag is passed on the command line.

### 10.2 A real decoder bug, found only because a live escrow was non-empty

The first read of the newly created Active listing failed:

```
vault_3e397b77…token_ids[0] is not a NonFungibleId enum
```

Root cause, established by reading the raw substates from both indexers: `NonFungibleId`
reaches this decoder in **two different renderings**, and the escrow path was using the
wrong one.

| Where | Wire shape | Example |
|---|---|---|
| Component `body.state` (CBOR) | positional enum tuple `[variant, [payload]]` | `[1, ["v042-soak-swap-a-cba74"]]` |
| Vault `resource_container` (plain serde substate) | **named variant object** | `{"String": "v042-soak-swap-a-cba74"}` |

`readEscrow` fed vault token ids through `nonFungibleId()`, which only accepted the tuple
form. The bug was invisible to the existing tests because the test fixture built
`nftVault(...)` with `ids.map(nftIdString)` — the component-state form — so the fixture
itself encoded the vault ids in a shape the real wire never uses. Every escrow the earlier
live run had inspected was **empty** (`token_ids: []`), so the broken line never executed
against real data either. Two independent layers of verification had both been exercised
only on the trivial case.

Fix (`packages/protocol-client/src/marketplaceSubstate.ts`): `nonFungibleId()` now accepts
both renderings — they are one type in two encodings — and still refuses anything else
(`{"Weird":"x"}` is an error, never a silent pass-through; `{"U64":n}` becomes `u64:n`).
The fixture now uses the real named-variant form, and three regression tests pin the
behaviour: both renderings decode, numeric ids are named rather than dropped, and a
malformed id is refused. The test file was also added to the package's `test` script, which
had never included it — the suite that ran in CI would not have executed these tests at all.

The re-read then proved the point of the escrow corroboration in the first place: the Active
listing reported `escrow.tokenIds: ["v042-soak-swap-a-cba74"]`, `empty: false`, and the
vault's declared resource matched the component's `collectionResource`.

### 10.3 All three marketplace lifecycles, executed live on v0.46

Six real transactions, all dry-run first, all committed, all reconciled by authoritative
reread. Fees are actual committed fees in micro-tTARI.

| Lifecycle | Op | Transaction | Fee | Final state |
|---|---|---|---|---|
| FixedPriceListing | create | `54b4ab30d09f9c22a73be7efcaaf24a7307b98a9d42b2a95d89b0f978602f6c8` | 3 291 | `component_3ed8a845…` Active, escrow holds the NFT |
| | buy | `cd8d111e3a57d9854a330f1c087e550da135302be1876b8185bb39561307ea22` | 4 419 | **SOLD**, escrow empty, NFT released to buyer |
| ItemOffer | create | `9164094ba299f97f875f75ef33fe0974b12a279424ac47f43887822a1622476b` | 3 657 | `component_b42b09ae…` Active, escrow holds **50 tTARI** |
| | accept | `00f6eba0fc6fdff65610e2a4c2c7399c02f25e56d77dd1c4c17ee7a436112e95` | 5 123 | **ACCEPTED**, escrow empty |
| CollectionBid | create | `30ebfe17dbc928537c8a4ac3f30148984b4374f1017a12c6695f88ea23f59eae` | 3 708 | `component_0d57aec2…` Active, escrow 50, remaining qty 1 |
| | fill | `c219b2ae19db635e7533e53d57e4f9490a93b285271ace02544c1733576e78a1` | 5 081 | **FILLED**, remaining qty 0, escrow empty |

Total fees: 25 279 micro-tTARI. This exercises **both escrow shapes**: the NFT escrow
(NonFungible container, token ids) and the fungible escrow (tTARI amount).

**Balances reconcile exactly**, which is the strongest form of settlement proof:

- A: 50 000 100 − 3 291 (create fee) + 100 (sale proceeds) − 5 123 (accept fee) + 50 (offer
  proceeds) − 3 708 (bid fee) − 50 (escrow paid to filler) = **49 987 978** — matches the
  measured balance exactly.
- B: 1 651 713 − 100 (purchase) − 4 419 − 50 (offered) − 3 657 + 50 (refunded on accept)
  + 50 (fill proceeds) − 5 081 = **1 638 456** — matches exactly.

### 10.4 One rejection, and it proved the v0.46 reject-reason work

The first buy attempt was rejected by the node:

```
Dry-run transaction rejected: Execution failure (InsufficientFunds):
At instruction #1: Resource did not contain sufficient balance:
Required: 2000000, Available: 1651713
```

This is live confirmation of §3.5: the v0.46 executor renders the **structured**
`ExecutionFailureCode` (`InsufficientFunds`) rather than prose-only. The cause was the
executor's default 2 000 000 micro-tTARI max-fee envelope against B's 1 651 713 balance;
re-running with `--max-fee 100000` (still ~28× the real fee) committed normally. The
envelope is a reservation ceiling, not a spend — but it must fit the balance.

### 10.5 The pool's write path on v0.46: a live swap

A 1000 tTARI → LPTESTA swap (`--min-out 900`), tx
`00557411b87d8d70a5aa479726a00288b57e897d627d8194771e61fa39bfc865`, fee 3 604, committed.

| | before | after |
|---|---|---|
| reserveA (tTARI) | 595 664 | **596 664** (+1 000, exact input) |
| reserveB (LPTESTA) | 604 684 | **603 674** (−1 010 out) |
| lpTotalSupply / locked | 600 000 / 1 000 | unchanged (correct — swaps mint nothing) |

The product invariant **increased** (≈360.189090×10⁹ → ≈360.190784×10⁹), which is the
signature of the 30 bps fee being retained rather than leaked, and the 1 010 out satisfied
the declared 900 minimum. The audited Pool v2 is fully functional as a trading venue under
Protocol V2.

### 10.6 The dry-run fee shape confirms v0.46 metering

The create-listing dry run's `fee_receipt.cost_breakdown` contains, as separate line items,
`WasmExecution: 180` and `NativeExecution: 877` alongside the familiar Storage/TemplateLoad/
TransactionWeight entries. These are the v0.46 metering categories (§3.4/§3.10) observed on
a live receipt, not inferred from release notes.

## 11. Evidence index

- `templates/fungible_pool/Cargo.toml`, `audit_engine_tests/Cargo.toml` — cohort pins
- `audit_engine_tests/tests/{pool_adversarial,opus08_eligibility,opus08_recall_demo}.rs` — return-value migration
- `tools/live-executor/walletd.mjs` — `describeRejectReason`, `authoritativeRequiredFees`
- `tools/live-executor/walletd.test.mjs` — v0.46 regressions
- `tools/live-executor/cli.mjs`, `nft-market-core.mjs`, `verify-decoder-live.mjs` — readback migration
- `apps/web/src/services/net.ts`, `ootleIndexer.ts`, `pools.ts`, `PoolsPage.tsx`, `state/AppContext.tsx` — rate limits
- `packages/protocol-client/src/marketplaceSubstate.ts` — the component-state decoders that replaced the getters; `nonFungibleId()` dual-rendering fix (§10.2)
- `packages/protocol-client/test/marketplace_substate.test.cjs` — escrow-rendering regressions; now part of the package test script
- `tools/live-executor/live-op-ledger.jsonl` — 130 entries; the six §10.3 transactions plus the §10.5 swap are the newest committed evidence
- Rollback point: `C:\Users\pdark\.tari\ootle\v042-esmeralda-bootstrap.backup-pre046-20261013-142449` (verified pre-migration wallet + config)