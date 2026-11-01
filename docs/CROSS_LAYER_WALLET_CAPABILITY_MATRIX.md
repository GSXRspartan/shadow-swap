# Cross-layer wallet capability matrix

What each wallet can **actually** do for a cross-layer atomic exchange, read from source at the
revisions below rather than from documentation or memory.

| Component | Revision read |
|---|---|
| Minotari L1 | `tari-project/tari` **6.3.0-pre.2**, `3994846` (2026-10-30) |
| Ootle L2 | `tari-project/tari-ootle` **v0.48.0**, `6a25dbc` |
| Sapient | v0.6.17 documented provider surface |
| Tari Universe | `tari-project/universe` `22366ad` (2026-10-30) |

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
| Any of the above from a browser | — | **No** — including from a Universe Tapplet, whose only L1 send is a plain `sendOneSided`; see §3 |

`applications/minotari_mcp_wallet/src/tools/atomic_swap_tools.rs` wraps the first four as MCP
tools (`send_sha_atomic_swap`, `claim_sha_atomic_swap`, `claim_htlc_refund`,
`atomic_swap_status`), all over `WalletGrpcClient`. That is a **local** wallet surface.

## 3. Tari Universe reaches BOTH layers from a web context — but exposes no HTLC on either

**Correction to an earlier claim in this document.** It previously said there is "no
browser-reachable L1 signing API". That was wrong. Tari Universe hosts **Tapplets** — web
applications running in the app — and its `TappletSigner` exposes **both** L1 and L2 operations
to them. Any statement that a web page cannot reach L1 at all is incorrect.

What matters for this protocol is *which* operations. The signer's dispatch is an explicit
allowlist, with the source comment: *"Dispatch is an explicit allowlist - never a dynamic lookup
on the prototype - so a tapplet can't reach anything beyond the methods below"*, and *"do not
widen without a security review"*. The complete set:

| Tapplet method | Layer | What it does |
|---|---|---|
| `getAccount`, `getTariBalance`, `getBaseNodeStatus` | L1 | read address, balance, node status |
| **`sendOneSided{amount,address,paymentId}`** | L1 | **the only L1 send** — a plain one-sided payment |
| `getOotleAccount`, `getOotleBalance` | L2 | read account and balance |
| **`sendOotleStealth{amount,address,payRef}`** | L2 | **the only L2 send** — a plain stealth transfer to an address |
| `waitOotleTransaction` | L2 | poll a transaction this tapplet sent to a final status |
| `getBridgeEnvs`, `get`/`set`/`removeOngoingBridgeTx`, `getBackendBridgeTxs` | — | bookkeeping for Universe's built-in **wXTM** bridge tapplet |
| `isConnected`, `getNetwork`, `getAppLanguage` | — | environment |

**There is no HTLC capability on either layer**, and no atomic-swap or HTLC code anywhere in the
Universe repository. Consequences, both load-bearing:

1. **`sendOneSided` cannot carry a custom TariScript.** An L1 HTLC output *is* a custom script
   (`HashSha256 … CheckHeightVerify …`), so a Tapplet cannot fund, claim or refund one.
2. **`sendOotleStealth` is a transfer to an address, not a template call.** So a Tapplet cannot
   call `CrossLayerHtlc::fund` / `claim` / `refund` either. Universe's L2 surface is **narrower**
   than Sapient's for this purpose, which is the opposite of what one might assume from it being
   the richer application.

Universe's own internals go much further than the Tapplet allowlist — `l2_claim_burn`,
`l2_claimable_burns`, `l2_send_memo`, `l2_validate_address` and more, and it embeds an Ootle
wallet module. Notably it implements the **native burn/claim** itself. None of that is
Tapplet-reachable, and its built-in bridge is for **wXTM** (exchange-facing wrapped XTM), not for
Ootle HTLCs.

### So the best available configuration today

| Leg | Best available signer | Why |
|---|---|---|
| **L1 HTLC** (fund / claim / refund) | **local wallet gRPC** (console wallet or walletd) | the only surface that builds the HTLC script at all |
| **L2 HTLC** (fund / claim / refund) | **Sapient** (browser) | transaction requests can call a template method |
| Reading either layer, plain payments | **Universe Tapplet** | both layers, but payments only |

### The exact missing capabilities, now sharply named

- **For a Universe-hosted Shadow Swap:** one generic L2 **transaction-request** method in the
  Tapplet allowlist — the equivalent of what Sapient already does — would let a Tapplet call
  template methods and therefore drive the whole L2 leg. This is the smaller and more plausible
  of the two asks, and it alone would make the L2 side browser-complete inside Universe.
- **For a fully browser-only cross-layer swap:** an L1 method that signs
  `send_sha_atomic_swap` / `claim_sha_atomic_swap` / `claim_htlc_refund`. Until that exists, the
  L1 leg needs a local wallet regardless of which browser wallet is used.

Until either lands, the L1 leg is driven by a **local-wallet adapter** against gRPC, and any
browser-only configuration keeps the route disabled.

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
| Browser-only cross-layer trading | **Blocked by upstream** — Universe Tapplets reach both layers but expose plain payments only; no HTLC on either (§3) |

**The composed exchange is not called atomic anywhere in this repository**, and will not be until
a real L1 script execution and a reconciled two-layer settlement have both been observed.
