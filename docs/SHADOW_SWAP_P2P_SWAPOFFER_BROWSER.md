# Shadow Swap — Phase 2: browser SwapOffer and live-trading readiness

Branch `claude/shadow-swap-swapoffer-browser`, stacked on PR #9
(`claude/shadow-swap-v047-release-25lmq7` @ `7b325f9`). Cohort: tari-ootle **v0.48.0**
(`6a25dbc`), still the latest upstream tag on 2026-10-31.

**Status: browser-complete, unpublished.** Every P2P maker/taker flow is built, reviewed,
serialised and verified in this build, and every wire shape is engine-executed. **No SwapOffer
template is published or recorded**, so in production all P2P routes are shown as unavailable
with the reason. Nothing was published, merged or deployed.

## 0. Verification levels used in this document

| Label | Meaning |
|---|---|
| **engine-verified** | Executed in the real v0.48.0 engine (`audit_engine_tests`, `TemplateTest`), balances asserted. |
| **reference-provider verified** | Checked against a model transcribed from the shipped wallet code (Sapient v0.6.17 / `@chironbuilder/ootle-sdk` 0.1.30), not a running wallet. |
| **real-wallet verified** | Observed with a real Sapient/walletd. **Nothing in this phase is real-wallet verified.** |
| **live-Esmeralda verified** | Observed on the public network. **Nothing in this phase is.** The indexers were unreachable from this environment (§7). |

## 1. Critical finding: the browser's instruction JSON was not v0.48 JSON

Measured against upstream `tari_ootle_transaction::Instruction` serde at `6a25dbc`, every
browser write before this phase would have been refused by the wallet's deserializer:

| Defect | Was | Now (engine-verified) |
|---|---|---|
| Arguments | bare JSON strings, e.g. `"resource_…"`, `"1000"` | `{ "Literal": "<hex of tari_bor CBOR>" }`, encoded from the callee's declared ABI type |
| Expiry | an extra `{ "WithMaxEpoch": … }` instruction | no such instruction exists; `max_epoch` is a transaction field the **wallet** sets (Sapient: current epoch + 10) |
| NFT withdrawal | `Account::withdraw(resource, id)` | `Account::withdraw_non_fungible(resource, NonFungibleId)` |
| `CallFunction.address` | `template_<hex>` | bare 64-hex `TemplateAddress` |

`audit_engine_tests/tests/instruction_wire_v048.rs` builds every browser operation with the
upstream Rust builder (pool create, add/remove liquidity, swap, multi-hop, SwapOffer
create/fill/claim/cancel incl. NFT barter, listing create/buy), serialises it, **deserialises the
JSON and executes the result**, and asserts balances. `apps/web/test/instruction-wire-v048.test.cjs`
requires the browser's own builders and serializer to produce **identical** JSON from the same
parameters, and reproduces all 38 engine-produced CBOR literal encodings byte for byte (Amount
up to u128 as a tag-2 bignum, `Option::None` = `f6`, `Some(x)` = `x`, `Vec<u8>` = an array of
uints, NonFungibleId `[variant,[payload]]`, tagged addresses 128/131). Every call now carries
`argTypes`; an undeclared or mismatched type is refused, never guessed. The review differential
now matches encoded literals instead of substrings.

NonFungibleId decoding now covers all four v0.48 variants (U256/String/Uint32/Uint64; the old
decoder mislabelled variant 0) and yields upstream canonical strings (`uuid_…`, `str_…`,
`u32_…`, `u64_…`), the only form the encoder accepts.

## 2. Newly executable browser routes

"Executable" means the browser builds, reviews and serialises the transaction end to end, and
the shape is engine-verified. Live execution additionally needs the template published and
recorded (§8) and real-wallet acceptance (§10).

| Route | Browser | Engine | Production state |
|---|---|---|---|
| P2P offer, public fungible ↔ public fungible (incl. a pair with no AMM route) | create / fill / claim / cancel | p01, wire scenarios | unavailable: SwapOffer unpublished |
| P2P offer, created-Stealth (revealed) ↔ fungible / Stealth | create / fill via `withdrawStealthAndExecute` (seed) or plain withdraw (relayed) | p02, p03, **p10** | unavailable: unpublished |
| P2P offer, revealed Confidential ↔ fungible | create / fill (plain withdraw) | c01, **c03** | unavailable: unpublished |
| NFT ↔ specific NFT barter | create / fill (`withdraw_non_fungible`) | p04, wire scenarios | unavailable: unpublished |
| Designated taker, hash lock, expiry, cancel/refund, claim | all | p05, p06, p08, p09 | unavailable: unpublished |
| AMM / multi-hop with **tTARI input** from a Sapient seed account | `withdrawStealthAndExecute` | m01–m08 (follow-ups) | needs a recorded v0.48 Pool (none yet) |
| AMM, all other routes | unchanged, now with a valid wire format | as before | needs a recorded v0.48 Pool |

Still not executable, with the stated reason in the UI: blinded Confidential balances (needs a
wallet-built `ConfidentialWithdrawProof`, which no browser wallet exposes); a two-input
operation with a Stealth side from a Sapient seed account (the wallet only accepts a Stealth
asset as a transaction's single input); cross-layer.

## 3. Maker / taker workflows

| Step | Instructions (all engine-verified) | Returned assets |
|---|---|---|
| Create | `withdraw` or `withdraw_non_fungible` → `SwapOffer::create(bucket, want_resource, want_amount, want_nft, designated_taker, hash_lock, expires_at_epoch)` | escrowed in the component |
| Fill | `withdraw(payment)` → `offer.fill(bucket, preimage)` → **deposit** | escrow deposited into the taker's account |
| Claim | `offer.claim()` → **deposit** | proceeds deposited into the maker's account |
| Cancel | `offer.cancel()` → **deposit** | escrow refunded to the maker's account |

Every returned bucket is deposited in the same transaction (the engine rejects a dangling
bucket, m05). The asset's resource and container type are never changed: the escrow vault keeps
the asset's container kind (asserted in p10/c03), the decoder reports it, and an invitation can
only describe what the chain holds.

The fill is built from **chain** terms (payment = exactly what the offer wants), never from the
invitation. Fill, claim and cancel reviews cannot be created without the chain-read release
(`RECEIVE` / `REFUND`), and the SwapOffer review differential requires the wallet instructions to
equal a fresh serialisation of the intent.

## 4. Shareable invitations

Format `shadowswap-offer:v1:<base64url(canonical JSON)>`, at most 4096 characters:

```
{ v: 1, network, generation, template, component,
  offered:   { kind: "fungible", resource, amount } | { kind: "nft", resource, nftId },
  requested: { kind: "fungible", resource, amount } | { kind: "nft", resource, nftId },
  maker, designatedTaker | null, hashLock | null, expiresAtEpoch, memo? (≤140, display only) }
```

- Copy (My offers), paste and validate (Import). Unknown fields are refused; secret-like fields
  (`preimage`, `seed`, `privateKey`, `viewKey`, `mnemonic`, …) are refused with "invitations never
  carry secrets". The hash-lock **preimage is never in an invitation**.
- On import the component is **re-read from chain** (`decodeSwapOffer`, recorded templates only):
  escrow from the escrow vault (resource must match), requested terms, hash lock, expiry, status,
  and WHO may act from the immutable access rules (maker key from `claim`/`cancel`, designated
  taker from `fill`; any other rule shape is refused). `verifyInvitation` compares every term. A
  forged or stale invitation (amount, resource, dropped taker, hash lock, expiry, maker,
  template, network, generation: 11 forgery cases tested) is **unfillable**, and the UI shows the
  chain terms with the exact differences.
- Blockers: not open (filled/cancelled), expired, unknown epoch with an expiry set, a different
  known taker key, own offer. Warnings: the designated-taker rule (no wallet API reports the
  account's signing key, so it cannot be pre-checked; the engine enforces it, p05), and that a
  hash-locked fill reveals the preimage.
- There is no matching server. The "My offers" list is a per-browser convenience holding only
  `{network, generation, transactionId, component}`; every status is read from chain, and the
  created component is found from the transaction receipt (`createdComponentsOf`, tested on the
  engine's own execute result).
- A hash lock alone is not a complete cross-chain HTLC protocol; the UI says so.

## 5. `/swap` integration

The Swap page keeps the AMM route comparison and adds the P2P panel below it (Create offer /
Import invitation / My offers). The pair resolver now reports a P2P offer for every typed pair
(including public pairs with no AMM liquidity) and NFT barter for NFT↔NFT; they are
`EXECUTABLE` only when a SwapOffer template is recorded for the verified network generation,
otherwise `BLOCKED` with the reason. In the shipped build the panel shows "P2P offers are
unavailable on this network" and offers no create/fill control; a pasted invitation can only be
inspected and is labelled **UNVERIFIED** (browser e2e: `e2e/p2p-offers.spec.ts`). Progress,
pending-approval resumption, duplicate-submit refusal and reconciliation reuse the existing
review → submit-once pipeline unchanged.

## 6. Sapient tTARI / Stealth-typed input

Implemented from Sapient's real API (tari-wallet v0.6.17 `src/lib/messages.ts`,
`docs/integration/provider-api.md`; `@chironbuilder/ootle-sdk` 0.1.30):

```
tari_createTransactionRequest {
  kind: "withdrawStealthAndExecute", resourceAddress, amount, workspaceVarName,
  followUpInstructions, relatedComponents? }
```

- Selected only when the account advertises `stealthWithdraw` **and** `transactionRequests` and
  the operation's single input is Stealth-typed (tTARI by exact address, or a balance the wallet
  reports as `stealth`). **walletd-relayed accounts (no `stealthWithdraw`) keep the existing plain
  path, unchanged.** The engine accepts a plain withdraw of a revealed Stealth balance (p10);
  Sapient's own client-side signer is what refuses it for seed accounts.
- Follow-ups are raw instruction JSON (the wallet appends them without name resolution). Read
  from the shipped SDK (`buildWithdrawStealthAndExecute` and the vendored builder's
  `emitInstructions`): the wallet's own withdraw is workspace id 0 and the revealed bucket id 1,
  so follow-ups reference the input as `{Workspace:{id:1}}` and allocate from 2. Pinned by tests
  against a reference model of the wallet's final assembly (every reference defined earlier, no
  id reused, nothing dangling): **reference-provider verified, not real-wallet verified**.
- Follow-ups never call the account except `deposit*` (the wallet refuses otherwise; mirrored).
  Every called component is listed in `relatedComponents`.
- Only the durable request trio is used for it (no one-shot fallback). Exactly the documented
  fields are sent; every other private kind (`shield`, `sendPrivately`, HTLC, redeem…) remains
  refused. A two-input operation with a Stealth side from such an account is refused with the
  reason before anything is signed.

## 7. v0.48 network compatibility findings

| Question | Finding | Level |
|---|---|---|
| Latest published release | v0.48.0 (`6a25dbc`, 2026-10-29); no newer tag; `@tari-project/ootle-wasm-bor` 0.48.0 and `@tari-project/ootle` 0.11.1 are current | upstream source |
| Running Esmeralda version | **Not observable here**: `esme-indexer-a/b.ootle.tari.com` were unreachable from this environment. Operator check below. | unverified |
| walletd requirement | walletd **v0.48.0** for the reset network (V0 genesis, sr25519 signing). Publishing needs a token with `Templates(Create)`; `max_fee` is capped by walletd's `enforce_max_fee_limit`. | upstream source |
| Template ABI | All five templates compile unchanged against `tari_template_lib` 0.36.0 / abi 0.22.0; the argument encodings in §1 are what the engine decodes. | engine-verified |
| Did Pool v2 addresses survive? | **No.** v0.48.0 is a reset, and a template address is `H(author key, binary hash)`, so a v0.48 Pool has a new address even from identical source. Pre-reset addresses are recorded only for `PRE_V048_RESET`. | upstream source |
| Can SwapOffer be published? | Builds for wasm32 (188,271 bytes, under the 1 MiB `max_template_binary_size_bytes`), clippy-clean, reproducible (§8), but only through walletd's optimiser or after stripping custom sections (§8). | build-verified |

Operator check of the running network (any machine with access):

```bash
curl -s https://esme-indexer-a.ootle.tari.com/info    # expect version 0.48.x and the current epoch
curl -s https://esme-indexer-b.ootle.tari.com/info
```

## 8. Publication requirements (prepared, NOT executed)

**Finding:** the raw `cargo build` output carries `name`, `producers` and `target_features`
custom sections, and the v0.48 engine **rejects** any custom section other than `tari_tdef` at
registration (`crates/engine/src/wasm/module.rs`, `DisallowedCustomSection`). walletd's
`transactions.publish_template` always runs `wasm-opt` (crate 0.116.1: optimise-for-size,
bulk-memory + reference-types, SIMD off, strip debug/producers/target-features) before
publishing, so **the published bytes are walletd's optimised output, not our build's bytes**.
The earlier Windows instructions are corrected accordingly.

1. Reproduce the build and its hashes (Rust 1.97.1):
   ```bash
   tools/build-templates.sh --check   # now includes p2p_offer: 920439dd…d4b4, 188,271 bytes
   ```
   Verified here from two different checkout paths.
2. Dry run through walletd v0.48.0 (JSON-RPC; base64 binary; the fee account must hold tTARI):
   ```json
   {"jsonrpc":"2.0","id":1,"method":"transactions.publish_template",
    "params":{"binary":"<base64 of the p2p_offer.wasm built in step 1>","fee_account":null,
              "max_fee":"<cap>","detect_inputs":true,"dry_run":true}}
   ```
   The reply's `dry_run_fee` is the fee; walletd logs the optimised size. Then repeat with
   `"dry_run": false`. Permissions: a walletd token with `Templates(Create)`; the fee is paid
   from the fee account. No other authority is created: the template has no admin and no fee,
   and every offer is `OwnerRule::None`.
3. Verify what was published: `templates.list_authored` / `templates.get` on walletd, and the
   indexer's template substate, give the address and binary. Check
   (a) `address == PublishedTemplateAddress::from_author_and_binary_hash(author_public_key, binary_hash)`,
   and (b) that the binary is walletd's optimisation of the `--check`-verified build (rerun the
   same `wasm-opt` 0.116.1 passes and compare hashes). Record the result.
4. Record the address in `apps/web/src/services/protocolDeployment.ts` → `ESMERALDA_V048.offerTemplates`
   (and the Pool in `poolTemplates`), in a reviewed PR. That single change is what turns the P2P
   routes from `BLOCKED` to `EXECUTABLE`; nothing else enables them.

Before publishing the Pool, also switch the **existing-pool** add-liquidity builder to
`add_liquidity_exact` (release blocker 3 in `SHADOW_SWAP_V047_RELEASE_READINESS.md`, still
open). Do **not** switch pool creation: `add_liquidity_exact` cannot serve a first deposit
(`pool_engine` `e07e`), so creation keeps `add_liquidity`.

## 9. Test results (this phase)

Final counts are in `CHECKPOINT.md` F3. Covered explicitly:

- maker/taker in both directions (fungible↔fungible, created-Stealth, Confidential, NFT↔NFT);
- cancel, expiry and refund;
- NFT identity: all four id variants, exact ids on both sides;
- designated taker;
- forged invitations (11 cases);
- insufficient funds (UI gate);
- wallet rejection and reload: the existing request-trio and pending-ledger suites, now also
  exercised for the Stealth operation;
- malformed, oversized and secret-carrying invitations.

Nothing is real-wallet or live-Esmeralda verified (§0).

## 10. Windows acceptance steps for this phase

Prerequisite: SwapOffer (and Pool) published and recorded per §8, walletd v0.48.0, the current
Sapient release, two accounts (maker and taker), disposable assets only.

1. **Wire format, before anything else**: one tiny public swap. The wallet's approval card must
   show the call, the pool and amounts. If the wallet reports an instruction deserialisation
   error, stop and file it with the request JSON (DevTools).
2. **Fungible offer**: the maker creates `1000 X → 2500 Y` and copies the invitation from My
   offers. The taker imports it; the terms shown must be the chain's. Fill: the taker gets
   1000 X, and the maker claims 2500 Y. Reconcile both accounts.
3. **Forged invitation**: edit one amount in a copy of the invitation. Import must show the
   mismatch and offer no fill.
4. **Designated taker + hash lock**: create with the taker's key and a generated preimage. A third
   account's fill must be refused by the network; the named taker fills with the preimage.
5. **Expiry / cancel**: create with a short expiry. After it passes, fill is blocked and the
   maker cancels; the escrow returns.
6. **NFT barter**: NFT A for the specific NFT B; both land with the exact ids.
7. **tTARI from a Sapient seed account**: swap tTARI→X on a recorded pool, and fill an offer
   paying tTARI. The wallet must show a `withdrawStealthAndExecute` approval (not an instruction
   list), and the result must commit with the output deposited. This is the first real-wallet
   check of the workspace-id derivation in §6; record it.
8. **tTARI from a walletd-relayed account**: the same swap through the plain path; record the
   result.
9. **Created-Stealth offer** (if a created-Stealth balance is available): create from a seed
   account. The approval is `withdrawStealthAndExecute` for that resource, and the taker receives
   the same Stealth-typed resource.
10. **Reload during approval** of an offer create: the same request id resumes, and exactly one
    transaction is created.

Record each against gates F, G and I of `SHADOW_SWAP_V047_RELEASE_READINESS.md`.

## 11. Known limitations

- Unpublished: nothing P2P can run until the operator completes §8.
- No wallet API exposes the account's signing public key, so a designated-taker offer cannot be
  pre-checked in the browser; the network enforces it.
- Wallet balances carry no NFT ids; the maker types the canonical id of the NFT to offer.
- Blinded Confidential balances remain out of reach (no browser wallet builds the proof).
- The workspace-id convention for `withdrawStealthAndExecute` follow-ups is derived from shipped
  wallet code, not observed live (§10 step 7 is that check).
