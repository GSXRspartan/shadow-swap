# Minotari atomic-swap API — exact-source trace

Status: **FULLY TRACED (L1 + L2).** This document records only facts verified against the
pinned upstream revisions, with exact source paths. Updated: 2026-09-25, branch
`feat/multi-asset-stablecoin-markets`.

## Environments

| Repo | Local path | Revision | Role |
|---|---|---|---|
| tari-ootle (L2) | `C:\tmp-tari` | `2d6083e6cc7c98cde93dacebe2fb76b17703f588` (development HEAD, workspace 0.41.1) | L2 engine + walletd — FULLY TRACED |
| tari L1 (Minotari) | `C:\tmp-tari-l1` | tag `v6.0.0`, commit `97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3` (`chore: v6.0.0 release`) | L1 HTLC primitive — FULLY TRACED |

## VERIFIED L2: Ootle stealth ScriptPath HTLC (interop-grade)

| Fact | Evidence (exact path, repo `2d6083e`) |
|---|---|
| Domain-separation-free hash digest designed for external-chain interop | `crates/engine_types/src/stealth/hashlock.rs` — module doc: "The preimage is hashed with no domain separation so a hashlock can interoperate with an external chain's HTLC"; `hashlock_digest(HashAlg::Sha256, preimage)` |
| SHA-256 byte-for-byte agreement with external chains | same file, test: SHA-256("abc") NIST vector must agree byte-for-byte |
| HTLC-shaped condition tree is a first-class engine structure | `crates/engine_types/src/stealth/condition_structure.rs` — two-leaf trees: claim leaf `[[{"Builtin":{"HashLock":{"hash":"<32B hex>","alg":"Sha256"}}}]]`, refund leaf `[[{"Builtin":{"AfterEpoch":<epoch>}}]]`; bounded by `TooManyConditions` |
| Witness construction is WASM-exposed (browser-compatible) | `crates/ootle_wasm/core/src/stealth/inputs.rs` — `build_script_path_witness(conditions_json, claim_leaf_json, preimage)`; tests at lines 195–232 cover two-leaf HTLC trees (claim + refund) and reject witnesses without `condition_root` |
| Spend path proven in-engine | `crates/ootle_wasm/wasm/src/lib.rs`, `crates/ootle_wasm/core/src/stealth/{inputs,types,transfer}.rs`; engine test `crates/engine/tests/spend_script.rs` |
| This repository does NOT yet consume it cross-chain | the only prior "atomic swap" artifact is a research template (C:\tari-old-clean\atomic-swap-template) using **domain-separated Blake2b** — explicitly NOT the interop path and NOT used by this phase |

The L2 leg therefore uses native stealth `PayTo::Conditions` outputs with
`HashLock(Sha256) + AfterEpoch` condition trees and `build_script_path_witness` witnesses.
No new swap template is introduced.

## VERIFIED L1: real SHA atomic-swap commands (tari v6.0.0)

All command names below are real; every fact is source-backed. Revision: `v6.0.0`
(`97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3`), network Esmeralda.

### 1. INIT — `init-sha-atomic-swap`

| Fact | Source evidence |
|---|---|
| CLI parser → command handler | `applications/minotari_console_wallet/src/cli.rs:182` `InitShaAtomicSwap(SendMinotariArgs)`; handler `automation/commands.rs:263 init_sha_atomic_swap` |
| Wallet service entry | `base_layer/wallet/src/transaction_service/handle.rs:1897` → `transaction_service/service.rs:2184 send_sha_atomic_swap_transaction` |
| WHO GENERATES S | **The init wallet itself**: `let pre_image = CompressedPublicKey::from_secret_key(&PrivateKey::random(&mut rand::rng()));` (service.rs:2203). The caller CANNOT provide S or H — neither the wallet API nor the gRPC request (`SendShaAtomicSwapRequest` has only `recipient`) carries them. |
| Preimage requirements | 32-byte canonical compressed Ristretto255 point (`CompressedPublicKey`). Claim side parses it with `CommsPublicKey::from_hex`. |
| Hash algorithm / representation | `let hash: [u8;32] = Sha256::digest(pre_image.as_bytes()).into();` (service.rs:2204) — plain SHA-256 over the raw 32-byte point encoding, no domain separation, big-endian digest bytes as emitted. |
| Amount units | microMinotari (µT), `u64`. |
| Claimant identity | `destination.public_spend_key()` — the recipient address's spend key (claim branch). |
| Refund identity | the INIT wallet's own one-sided address spend key (`RecipientScriptKey::OwnSpendKey`, service.rs:2260). |
| Refund height | **ABSOLUTE block height**, hardcoded `tip + BLOCKS_PER_DAY` where `BLOCKS_PER_DAY = 24*30 = 720` blocks (≈24h at 2-min blocks) — NOT a caller parameter (service.rs:2210-2211). |
| Script | `HashSha256 PushHash(H) Equal IfThen PushPubKey(claimant) Else CheckHeightVerify(height) PushPubKey(sender) EndIf` (service.rs:2214). Opcodes: HashSha256=0xb1, PushHash=0x7a(+32B), Equal=0x80, IfThen=0x61, Else=0x62, EndIf=0x63, PushPubKey=0x7e(+32B), CheckHeightVerify=0x66(+u64 LEB128 varint) — `infrastructure/tari_script/src/op_codes.rs`. |
| Covenant / output features | `Covenant::default()`, `OutputFeatures::default()` (service.rs:2223-2224). |
| Tx type | `TxType::ClaimAtomicSwap` (service.rs:2249). |
| Submission | IMMEDIATE one-sided broadcast (service.rs:2300 `submit_transaction`); output stored sender-side with `SpendingPriority::HtlcSpendAsap` (service.rs:2289) for refund. |
| Return value | `(tx_id, pre_image, TransactionOutput)` (service.rs:2325) — the INITIATOR receives S and must hand it to the claimant out-of-band. |

### 2. FINALISE (CLAIM) — `finalise-sha-atomic-swap`

| Fact | Source |
|---|---|
| Console command args | `cli.rs:183 FinaliseShaAtomicSwapArgs`: `--output-hash <hex>` (repeated), `--pre-image <UniPublicKey>`, `--payment-id`; handler `automation/commands.rs:285 finalise_sha_atomic_swap` |
| Output manager entry | `base_layer/wallet/src/output_manager_service/service.rs:2841 create_claim_sha_atomic_swap_transaction` — first `claim_sha_atomic_swap_with_hash` (service.rs:614) FETCHES the full UTXO from the base node by output hash (`fetch_utxo`) |
| Preimage semantics | input stack = `inputs!(pre_image)` — the script executes `HashSha256(S) == PushHash(H)`, then the claim branch pushes the claimant spend key; the script SIGNATURE is verified against that final PushPubKey value, so the claimant signs with the destination spend key. |
| Tx construction | `TransactionBuilder` with `with_tx_type(TxType::ClaimAtomicSwap)`, memo `"SHA-XTR atomic swap"`, input = recovered HTLC output (decrypted via DH(view_key, sender_offset_pubkey) — the claimant must be the intended recipient), fee per gram, change output. |
| Submission | `transaction_service.submit_transaction(tx_id, tx, amount, payment_id)` (commands.rs:296-298). |
| Failure modes | `EncryptedData` decrypt failure → `Atomic swap: Encrypted value could not be decrypted!`; commitment mask mismatch → `Blinding factor could not open the commitment!` (service.rs:2911-2920). A wrong-length or non-canonical preimage fails at `CommsPublicKey::from_hex`; a wrong but canonical preimage fails the script's `Equal`. |

### 3. REFUND — `claim-sha-atomic-swap-refund`

| Fact | Source |
|---|---|
| Console command | `cli.rs:184 ClaimShaAtomicSwapRefund(ClaimShaAtomicSwapRefundArgs)`; handler `automation/commands.rs:303 claim_htlc_refund` |
| Validation semantics | `CheckHeightVerify(height)` in the script: passable ONLY when `block_height >= height` (absolute block height; `infrastructure/tari_script/src/script.rs:340 handle_check_height_verify`). |
| Who can refund | ONLY the original funding wallet: the HTLC output was persisted in the SENDER's output manager at init (`add_output_with_tx_id(..., Some(SpendingPriority::HtlcSpendAsap))`, service.rs:2289) with script key `RecipientScriptKey::OwnSpendKey`; `create_htlc_refund_transaction` (output_manager_service/service.rs:2923) spends it from the wallet's own output manager DB. |
| Tx type | `TxType::HtlcAtomicSwapRefund`, memo `"SHA-XTR atomic refund"`. |

### gRPC surface (wallet + base-node)

| Method | Source |
|---|---|
| `SendShaAtomicSwapTransaction(recipient)` → `{transaction_id, pre_image, output_hash, is_success, failure_message}` | `applications/minotari_app_grpc/proto/wallet.proto:1321` (request 2042, response 2082); server impl `applications/minotari_console_wallet/src/grpc/wallet_grpc_server.rs:708` |
| `ClaimShaAtomicSwapTransaction(output, pre_image, fee_per_gram)` → `TransferResult` | wallet.proto:2112-2120; server `wallet_grpc_server.rs:784` |
| `ClaimHtlcRefundTransaction(output_hash, fee_per_gram)` → `TransferResult` | wallet.proto:2122-2129; server `wallet_grpc_server.rs:860` |
| `GetBalance` → available/pending_incoming/pending_outgoing (µT u64) | wallet.proto:2227-2246 |
| `GetTransactionInfo` → `TransactionInfo{status, excess_sig, mined_in_block_height, …}`; `TransactionStatus` enum: COMPLETED=0, BROADCAST=1, MINED_UNCONFIRMED=2, IMPORTED=3, PENDING=4, COINBASE=5, MINED_CONFIRMED=6 | wallet.proto:2131-2186 |
| Base-node wallet RPC `t/bnwallet/1` | `base_layer/core/src/base_node/rpc/mod.rs`: `submit_transaction`, `transaction_query(kernel excess sig)` → `{location: none/mempool/mined, confirmations, best_block_height, is_synced}`, `fetch_matching_utxos`, `get_tip_info` → `{ChainMetadata, is_synced}`, `query_deleted(hashes, chain_must_include_header)` → mined/deleted heights |

### Hash/preimage byte representation (L1 vs Ootle Hash32)

- L1: `H = Sha256::digest(pre_image.as_bytes())` — the 32 canonical bytes of a compressed
  Ristretto255 point. No domain separation, no prefix, standard SHA-256 digest byte order.
- L2: `hashlock_digest(HashAlg::Sha256, preimage)` — identical plain SHA-256 over the bytes
  (verified by the engine's SHA-256("abc") NIST test).
- **Result: Minotari H == Ootle H for identical S bytes.** Constraint: L1 requires S to be a
  canonical valid Ristretto point encoding; a coordinator that generates S itself must
  generate a valid point (the L1 wallet always does, because it derives S from its key
  manager). Fixed-vector proof: `packages/protocol-client/test/minotari.test.cjs`.

### Restart/recovery of in-flight swap outputs (L1 output manager)

| Fact | Source |
|---|---|
| HTLC output persisted at init in the SENDER's output manager with `SpendingPriority::HtlcSpendAsap` and `OutputSource::AtomicSwap` change outputs | service.rs:2289, 2894-2900 |
| Refund reconstruction reads the unspent output by hash from the wallet DB | `create_htlc_refund_transaction` → `db.get_unspent_output(output_hash, &key_manager)` (service.rs:2928-2932) |
| Claimant-side import path | `WalletOutput::new_imported(...)` derives script private key + input stack from the imported UTXO (`calculate_script_private_key_id`, `transaction_components/src/transaction_components/wallet_output.rs:342`) |

## Known limits — what our reference provider does NOT prove

These are deliberate fail-closed behaviours, tracked in code and tests, not oversights:

1. **The funded amount is not authoritatively provable from base-node evidence.** A Minotari
   one-sided output stores its value in a blinded commitment, so the base-node wallet RPC
   returns a `TransactionOutput` with a commitment, not a revealed value.
   `MinotariBaseNodeReadback.fetchUtxos` therefore accepts an OPTIONAL `amountRaw` that an
   adapter may only populate with a chain-validated commitment opening. When absent,
   `observeHtlc` reports `amountRaw` (the remembered funding intent) with
   `amountAuthoritative: false`, and `verifyL1Funded` refuses to count the amount as proven
   (`evidence.amountExact === false`) rather than silently trusting the intent. Closing
   this properly requires an upstream readback that reveals/validates the value, or a
   protocol change committing the value publicly in the HTLC.
2. **The refund key is wallet-derived, never caller-supplied.** `SendShaAtomicSwapTransaction`
   carries no refund recipient, and the script's refund branch is the funding wallet's own
   one-sided spend key. `L1HtlcFundingIntent.refundRecipient`/`refundHeight` are documented
   as expectations and are never transmitted; the authoritative refund identity comes from
   `observation.refundRecipient`, re-decoded from the output script by the provider.
3. **`L1HtlcFundingIntent.hash` cannot be honoured by the real wallet.** The RPC request is
   `{recipient}` only, so `H` is whatever the wallet generates. The coordinator therefore
   ingests the wallet-returned `pre_image`, computes `H = SHA256(S)` itself, and refuses to
   continue if that disagrees with an already-accepted quote hash.
4. **The transport is an interface, not a shipped client.** `MinotariWalletGrpcTransport`
   and `MinotariBaseNodeReadback` are ports; no concrete tonic/base-node client is
   committed in this repository, so nothing here has been exercised against a live node.
5. **In-flight funding state is in-memory only.** `MinotariDevGrpcProvider.fundings` does
   not survive a process restart, so `listInFlightSwaps` is a development aid; restart-safe
   recovery must come from the wallet's own output manager plus a persisted
   `operationId → outputHash` binding.
6. **Fee-per-gram is a hint.** `fundingFeeTPerGram` (default
   `MINOTARI_REFERENCE_FEE_PER_GRAM = 5`) is forwarded on the wire, but the wallet
   recomputes fees from its own fee policy; a caller cannot force a fee.
7. **The script verifier is byte-level, not a wallet acceptance test.**
   `executeShaHtlcBranch` reproduces the traced opcode semantics to fail *before* any
   wallet call, but a fixed test vector is not a canonical Ristretto point, so the suite
   does not prove the wallet would accept that particular `S`. Real acceptance is covered
   only by live execution against a wallet.
8. **Capability advertisement is derived from wiring, not from a handshake.**
   `primitivesStatus()` reports `VERIFIED` when a wallet transport is injected; it does not
   perform a live `GetVersion` check against the pinned v6.0.0 surface.

## Browser path status

`chironbuilds/tari-l1-wallet-ui` (tree `e76cc7289fde6e1d3b69c3dbe6ede571188138d1`,
CPAL-1.0, REFERENCE_ONLY_PENDING_LICENSE_REVIEW) exposes the L2 hashlock leg via its
`window.tari` dApp API but contains NO L1 SHA atomic-swap construction. Gap analysis:
`docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md`. The minimum secure provider extension
(init/inspect/claim/refund SHA swap operations, WASM primitive layer, secret boundary,
blinded-amount limitation, acceptance criteria) is specified in
`docs/TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md`. Local wallet/gRPC remains
DEVELOPMENT_REFERENCE infrastructure only (`src/chains/minotari_grpc.ts`).

## RFC-0310 relation (guidance only)

Tari RFC-0310 (submarine swaps) is treated as design/timeout/adversarial-model guidance.
This repository does NOT claim RFC-0310 conformance. Traced divergences from the RFC
model are now documented: the wallet generates S at INIT time (so the L1 funder holds the
preimage), the refund timeout is an absolute block height hardcoded to tip+720, and HTLC
claim requires the preimage as a canonical Ristretto pubkey encoding.