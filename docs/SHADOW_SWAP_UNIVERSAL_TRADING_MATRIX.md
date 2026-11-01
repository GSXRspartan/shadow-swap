# Shadow Swap — universal trading matrix (Phase 3)

Cohort: tari-ootle **v0.48.0** (`6a25dbc`), still the latest upstream tag on 2026-10-31.
Branches: `feat/universal-trading-v048` (PR #11), `feat/cross-layer-v048` (PR #12),
`feat/mixed-route-execution-v048` (PR #13).
Start commit: `838cbb6` (`main`, with PRs #9 and #10 merged).

## Verification levels

| Level | Meaning |
|---|---|
| **LIVE VERIFIED** | Settled on Esmeralda with a recorded transaction and reconciled balances. **Nothing in Phase 3 is.** |
| **ENGINE VERIFIED** | Executed in the real v0.48.0 engine (`audit_engine_tests`), balances asserted. |
| **BROWSER REFERENCE-PROVIDER VERIFIED** | Checked against a model transcribed from shipped wallet code (Sapient v0.6.17, `@chironbuilder/ootle-sdk` 0.1.30), not a running wallet. |
| **IMPLEMENTED, REQUIRES REAL WALLET TEST** | The browser builds, reviews and serialises it; no live wallet run yet. |
| **EXPERIMENTAL / DISABLED** | Behind a production gate; unavailable until an operator records a template address. |
| **BLOCKED BY UPSTREAM** | A required engine or wallet primitive does not exist. |
| **NOT IMPLEMENTED** | — |

Live verification was impossible in this environment: `esme-indexer-a/b.ootle.tari.com` and
`universe.tari.mw` are refused by the sandbox's egress policy (checked again this session).

## Before → after

"Before" is `main` at `838cbb6`; "after" is this campaign's two PRs.

| Route | Before | After |
|---|---|---|
| Public fungible ↔ public fungible (direct) | IMPLEMENTED, REQUIRES REAL WALLET TEST | unchanged |
| 2–3 hop public AMM | IMPLEMENTED, REQUIRES REAL WALLET TEST | unchanged |
| Permissionless public pool creation | IMPLEMENTED, REQUIRES REAL WALLET TEST | unchanged (plus the `e07e` defect finding below) |
| Native tTARI ↔ public fungible | IMPLEMENTED (Sapient seed accounts via `withdrawStealthAndExecute`) | unchanged |
| NFT ↔ public fungible (marketplace) | IMPLEMENTED | unchanged |
| **NFT ↔ public fungible (P2P, maker's own price)** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`p11`), browser-built |
| **Public fungible ↔ ONE named NFT** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`p12`), browser-built |
| **NFT ↔ created-Stealth revealed payment** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`p13`), browser-built |
| **NFT ↔ revealed Confidential payment** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`c04`), browser-built |
| NFT ↔ NFT barter | ENGINE VERIFIED, browser-built | unchanged; the offered item is now **picked from chain-read holdings** |
| created-Stealth ↔ anything (P2P) | ENGINE VERIFIED, browser-built | unchanged |
| revealed Confidential ↔ anything (P2P) | ENGINE VERIFIED, browser-built | unchanged |
| **created-Stealth ↔ public fungible (AMM)** | BLOCKED (Pool v2 refuses the type) | **ENGINE VERIFIED** (`r02`), **signable from `/swap`**, EXPERIMENTAL / DISABLED until published |
| **created-Stealth ↔ created-Stealth (AMM)** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`r03`), signable from `/swap`, gated |
| **revealed Confidential ↔ public fungible (AMM)** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`r04`), signable from `/swap`, gated |
| **Native tTARI ↔ public fungible (revealed pool)** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`r05`), signable from `/swap`, gated |
| **Revealed-pool liquidity (create / add / withdraw)** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`r06`–`r08`), browser-built, gated |
| **Mixed multi-hop: revealed pool → public pool, atomic** | NOT IMPLEMENTED | **ENGINE VERIFIED** (`r11`) and **wire-verified** (`mixed_multi_hop_swap`), **signable from `/swap`**, gated |
| **Multi-hop wholly inside revealed pools, atomic** | NOT IMPLEMENTED | **ENGINE VERIFIED** (same shape as `r11`), signable from `/swap`, gated |
| Blinded (non-revealed) Confidential trading | BLOCKED BY UPSTREAM | unchanged, and now **refused in the engine** (`r09`) rather than merely avoided |
| **Minotari L1 → Ootle L2 conversion** | NOT IMPLEMENTED | **IMPLEMENTED for every step this app can do**; the claim is BLOCKED BY UPSTREAM for browser wallets and is performed by the user's own wallet |
| **Ootle L2 → Minotari L1** | not investigated | **BLOCKED BY UPSTREAM — no such route exists** (see §4) |
| L1↔L2 atomic HTLC swap | BLOCKED BY UPSTREAM (L1 leg) | unchanged (`docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md`) |

## 1. What makes the new AMM routes possible

`templates/revealed_asset_pool` (`RevealedAssetPool`) is a separate constant-product AMM for
assets whose value is an exact revealed integer. Full design: `SHADOW_SWAP_PRIVATE_LIQUIDITY_IMPLEMENTATION.md`.

Pool v2's eligibility guard is untouched. `r01` proves the same resources the new pool admits
are still refused by Pool v2, so this is an addition and never a bypass.

## 2. Engine findings produced by this campaign

1. **A Confidential vault can pay out a partial revealed amount** (`r04`). The P2P escrow had
   only ever withdrawn a whole vault, so this was the open question that decided whether a
   Confidential resource could be an AMM side at all.
2. **`Bucket::take` asserts `amount.is_positive()` in template_lib**, so `take(0)` always
   panics. Pool v2's `add_liquidity_exact` builds its empty refunds that way and therefore
   **cannot serve a first deposit**: `pool_engine` `e07e` pins it. This corrects the open
   release blocker "switch the add-liquidity builder to `add_liquidity_exact`" — pool creation
   must keep `add_liquidity`.
3. **Both pool templates share one `swap` signature**, so a route may cross a revealed pool and
   a Pool v2 in one atomic transaction (`r11`), and only the transaction's **input** needs a
   Stealth-capable withdrawal; intermediates stay on the workspace. The corollary matters for
   honesty: because the venues are indistinguishable on the wire, nothing in the transaction
   tells a signer that a hop was a transparent pool. The browser must carry that itself, from
   each component's own template address — which is why the venue is a required, chain-read
   input to the builder rather than a label the route graph attaches.
4. **An account's NFT ids are not available from the wallet** (Sapient's documented
   `DappTokenBalance` has no token-id field), but they are public chain data in the account's
   own vaults. `readAccountInventory` reads them, which is authoritative rather than advisory.
5. **A Stealth container has no commitment field at all** upstream, so a Stealth bucket's value
   is entirely revealed; a Confidential container can carry commitments beside the revealed
   amount. That asymmetry is what makes the revealed-value pool safe, enforced by
   `assert_contains_no_confidential_funds` and proved against a real blinded commitment (`r09`).

## 3. Route selection

`apps/web/src/lib/routeResolver.ts` reports every mechanism for a pair with its availability,
its exact blocker, its privacy disclosure and its required wallet capabilities.

**Which of them the Swap page can SIGN** is the exported `SIGNABLE_MECHANISMS`: `AMM`,
`MULTI_HOP_AMM`, `REVEALED_POOL` and `MIXED_MULTI_HOP`. All four are AMM-shaped, because both
pool templates expose the same `swap(Bucket, ResourceAddress, Amount)` — so one hop or
several, in one venue or across both, is one atomic transaction of the same instruction shape.
A test asserts every mechanism in that set has a builder behind it, so no button can exist
that cannot construct its transaction.

**The venue of each hop is read from chain, never from discovery.** `PoolState.templateAddress`
carries the template the component's own header names; `resolveMultiHopSwap` reports each hop's
in route order; `ammRouteIntentBuilder` classifies them against the recorded registry and
picks the builder, the operation name (`revealed_swap`, `revealed_multi_hop_swap`,
`mixed_multi_hop_swap`) and the disclosure from the result. A hop whose template is unrecorded,
or which reports none, is **refused** rather than assumed public — assuming public would be
the less revealing of the two descriptions, which is exactly the wrong direction to guess in.
`hostile-frontend` pins that a discovery hint claiming "public" cannot make a transparent-pool
hop read as public.

Properties the tests pin:

- a privacy-typed asset is **never** offered to Pool v2;
- an NFT is **never** offered a revealed-value pool (a token id has no divisible amount);
- the two pool graphs are kept apart, so a revealed pool is never quoted as a public one;
- a mixed route is only reported as mixed when it genuinely crosses both kinds;
- a revealed pool's privacy text says the amount is **revealed** and never says "confidential";
- P2P and revealed-pool routes are `EXECUTABLE` only where the template address is **recorded**
  for the verified network generation; otherwise `BLOCKED` with the reason.

The Swap page offers only routes it can sign today and shows the rest with their reason, so no
button exists that cannot build its transaction.

## 4. L2 → L1: the investigation result

The complete v0.48 instruction set is `CreateAccount`, `CallFunction`, `CallMethod`,
`PutLastInstructionOutputOnWorkspace`, `ClaimBurn`, `ClaimValidatorFees`,
`DropAllProofsInWorkspace`, `Assert`, `TakeFromBucket`, `PublishTemplate`, `AllocateAddress`,
`StealthTransfer`, `PayFeeFromBucket`, `UpdateComponentTemplate`, `PutIntoBucket`.

`ClaimBurn` is strictly one-way (L1 burn → L2 mint). There is **no** L2-side burn or exit
instruction and **no** base-layer verifier that would accept an L2 commitment proof.
`tari_watcher` is validator-node registration tooling, not a bridge.

**Missing primitives, exactly:** (a) an L2 instruction that destroys or escrows value and emits
a provable, consensus-attested exit receipt; (b) a base-layer verifier that accepts that
receipt and releases L1 funds. Until both exist, any "L2 → L1" offering would be an operator
holding the L1 funds, which this project will not build. The direction stays disabled and the
page says so.

## 5. Test results

| Suite | Result |
|---|---|
| Real v0.48 engine (`audit_engine_tests`) | **93/93** across 16 binaries |
| web | **560/560** |
| wallet-adapter | 31/31 |
| protocol-client | 268/268 |
| Browser e2e (Chromium desktop) | 91 passed, 4 skipped, 1 failed only on the sandbox's blocked connector host (passes in CI) |
| Reproducible WASM | 6 templates, hashes verified from two different checkout paths |

## 6. What an operator must do before any of the new routes can trade

1. Publish the templates through walletd and record the addresses
   (`SHADOW_SWAP_PRIVATE_LIQUIDITY_IMPLEMENTATION.md` §5 and
   `SHADOW_SWAP_P2P_SWAPOFFER_BROWSER.md` §8). The raw WASM carries custom sections the v0.48
   engine rejects; walletd's own `wasm-opt` pass strips them.
2. Keep `add_liquidity` for pool creation (finding 2 above).
3. Run the acceptance lists: `SHADOW_SWAP_BROWSER_P2P_ACCEPTANCE.md` and
   `SHADOW_SWAP_WINDOWS_LIVE_TESTS.md`.

Nothing was published, deployed or merged by this campaign.
