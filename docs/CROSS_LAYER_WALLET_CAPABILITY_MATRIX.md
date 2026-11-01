# Cross-layer wallet capability matrix

What each wallet can **actually** do for a cross-layer atomic exchange, read from source at the
revisions below rather than from documentation or memory.

| Component | Revision read |
|---|---|
| Minotari L1 | `tari-project/tari` **6.3.0-pre.2**, `3994846` (2026-10-30) |
| Ootle L2 | `tari-project/tari-ootle` **v0.48.0**, `6a25dbc` |
| Sapient | v0.6.17 documented provider surface |

## 1. The L1 leg exists, and this is exactly what it is

`base_layer/wallet/src/transaction_service/service.rs::send_sha_atomic_swap_transaction` builds:

```text
HashSha256 PushHash(h) Equal IfThen
    PushPubKey(destination)                       // claim: the recipient, with the preimage
Else
    CheckHeightVerify(height) PushPubKey(sender)  // refund: the sender, at/after height
EndIf
```

Three properties drive the whole protocol design, and none of them is a choice we get to make:

1. **The sender's wallet generates the preimage.** `SendShaAtomicSwapRequest` carries only a
   `PaymentRecipient` — there is **no hash parameter** — and `SendShaAtomicSwapResponse` returns
   `pre_image` and `output_hash`. So **the L1 funder is necessarily the secret holder**, which
   fixes the funding order and which leg must expire first in both directions.
2. **The timeout is not configurable.** `const BLOCKS_PER_DAY: u64 = 24 * 30;` then
   `height = tip_height + BLOCKS_PER_DAY`. A fixed **720 blocks**, with the comment "2 min
   blocks … 24 hours". That comment is mainnet's block time; see §4.
3. **Ledger wallets cannot fund.** The call refuses for `LegacyWalletType::Ledger`, because the
   device signs only the standard stealth script it builds itself. Claiming and refunding are
   explicitly unaffected.

The preimage is a random `CompressedPublicKey`'s 32 bytes, and the hash is `Sha256` of those
bytes — so the L2 leg must hash the same 32 bytes with SHA-256, which it does.

## 2. L1 capability matrix

| Operation | gRPC | Available |
|---|---|---|
| Fund an HTLC | `SendShaAtomicSwapTransaction(SendShaAtomicSwapRequest)` | **Yes** — wallet gRPC, not browser |
| Claim with a preimage | `ClaimShaAtomicSwapTransaction{output, pre_image, fee_per_gram}` | **Yes** |
| Refund after expiry | `ClaimHtlcRefundTransaction{output_hash, fee_per_gram}` | **Yes**, original sender only |
| Status / discovery | `atomic_swap_status` (MCP), `GetTransactionInfo` | **Yes** |
| Choose the hash | — | **No**: the wallet generates it |
| Choose the timeout | — | **No**: hardcoded 720 blocks |
| Fund from a Ledger device | — | **No**: refused by design |
| Any of the above from a browser | — | **No**: see §3 |

`applications/minotari_mcp_wallet/src/tools/atomic_swap_tools.rs` wraps the first four as MCP
tools (`send_sha_atomic_swap`, `claim_sha_atomic_swap`, `claim_htlc_refund`,
`atomic_swap_status`), all over `WalletGrpcClient`. That is a **local** wallet surface.

## 3. What is missing for a browser-only experience

Every L1 operation above requires a local wallet gRPC endpoint. There is **no browser-reachable
L1 signing API** for HTLC funding, claiming or refunding, and Sapient is an L2 provider with no
L1 surface at all. So:

- **A browser alone cannot complete a cross-layer swap.** The L1 leg needs the user's own
  console wallet or walletd reachable over gRPC.
- The precise missing capability, if a browser experience is ever wanted: an L1 provider API that
  signs a `send_sha_atomic_swap` / `claim_sha_atomic_swap` / `claim_htlc_refund` request for a
  key the wallet holds — i.e. the L1 equivalent of what Sapient does for L2 transaction requests.
- Until that exists, the L1 leg is driven by a **local-wallet adapter** against gRPC, and the
  route stays disabled in any browser-only configuration.

## 4. The timing discrepancy that must not be guessed

720 blocks is a fixed **block count**, so its wall-clock length depends on the network:

| Network | `target_time` per PoW algo | Effective block | 720 blocks | `vn_epoch_length` | One L2 epoch |
|---|---|---|---|---|---|
| **Esmeralda** | 60 s × 2 algos | **~30 s** | **~6 h** | 80 blocks | **~40 min** |
| **Mainnet** | 240 s × 2 algos | 120 s | 24 h | 60 blocks | 2 h |

The dual-PoW combination `t/n` reproduces mainnet's known 2-minute block time from
`target_time: 240`, which is why it is the formula used.

**A genuine upstream inconsistency:** Esmeralda's `vn_epoch_length: 80` carries the comment
`// 15s per block * 80 ±= 20 mins`, but its configured `target_time` is 60 for both algorithms,
giving ~30 s blocks and ~40 min epochs. The comment appears stale. `atomicSwap.ts` follows the
configured constants **and** takes the observed tip height and epoch as inputs, so a live network
that disagrees with its own constants cannot silently shorten a refund window.

Consequence worth stating plainly: on Esmeralda the L1 refund window is about **six hours, not
twenty-four**. A protocol that assumed the comment would give a counterparty a quarter of the
margin it believed it had.

## 5. L2 capability matrix

| Operation | Mechanism | Status |
|---|---|---|
| One-sided HTLC escrow | `templates/cross_layer_htlc` | **ENGINE VERIFIED** (`cross_layer_htlc.rs` h01–h09, 8/8) |
| Claim with a preimage | `claim(preimage)`, claimant key only | **ENGINE VERIFIED** |
| Refund after expiry | `refund()`, funder key only | **ENGINE VERIFIED** |
| Preimage publication | persisted in component state on claim | **ENGINE VERIFIED** |
| Externally supplied hash | `fund(..., hash_lock, ...)` | **ENGINE VERIFIED** — required, since L1 picks the preimage |
| Deadline in L2 epochs | `Consensus::current_epoch()` | **ENGINE VERIFIED** |
| Same-chain escrow (NFT/P2P) | `templates/p2p_offer` | unchanged, still **ENGINE VERIFIED** |
| Native TARI withdrawal | Sapient `withdrawStealthAndExecute` | IMPLEMENTED, REQUIRES REAL WALLET TEST |
| Publishing either template | operator decision | **NOT DONE** — nothing is published |

**`SwapOffer` cannot serve as the cross-layer leg.** `fill(payment: Bucket, preimage)` requires
the counter-asset as an L2 `Bucket` in the same transaction; a cross-layer counter-asset is on L1
and can never be one. That is why a separate one-sided template exists.

## 6. Verification levels, per operation

| Operation | Level |
|---|---|
| L2 escrow: fund / claim / refund / publication / authorization / single-settlement | **Local engine verified** |
| L2 timeout arithmetic and direction mapping | **Local engine verified** (unit, 275/275 protocol-client) |
| L1 script shape and gRPC surface | **Source verified** — read at `3994846`; no L1 script has been executed here |
| L1 funding / claiming / refunding | **Blocked in this environment** — needs a local wallet and a funded L1 account |
| Composed two-layer exchange | **NOT VERIFIED.** Neither simulated nor live |
| Browser-only cross-layer trading | **Blocked by upstream** — no L1 browser signing API |

**The composed exchange is not called atomic anywhere in this repository**, and will not be until
a real L1 script execution and a reconciled two-layer settlement have both been observed.
