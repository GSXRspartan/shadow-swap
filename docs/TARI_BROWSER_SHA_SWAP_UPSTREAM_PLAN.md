# Upstream plan — L1 SHA atomic swap in the browser `window.tari` provider

Status: **PROPOSAL / NOT YET UPSTREAM.** Nothing in this document is implemented in our
repository. Our reference implementation lives in
`packages/protocol-client/src/chains/minotari_grpc.ts` and is labeled
`DEVELOPMENT_REFERENCE_PROVIDER` (local console-wallet gRPC + base-node readback,
development/test harness only).

Reference studied (no code copied):
`chironbuilds/tari-l1-wallet-ui`, tree `e76cc7289fde6e1d3b69c3dbe6ede571188138d1`,
CPAL-1.0, `REFERENCE_ONLY_PENDING_LICENSE_REVIEW`.
Gap analysis: `docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md`.
L1 primitive facts: `docs/MINOTARI_ATOMIC_SWAP_API.md`.

## 1. What is already ready

The L2 half of `FAST_XTM_TARI` needs nothing new:

| Need | Existing `window.tari` surface |
|---|---|
| L2 hashlock funding | `tari_createTransactionRequest({ kind: "htlcFund", resourceAddress, amount, claimantWalletAddress, hashLockHex, refundEpoch, maxFee })` |
| L2 claim (reveals S) | `tari_createTransactionRequest({ kind: "htlcClaim", …, preimageHex, maxFee })` |
| L2 refund | `tari_createTransactionRequest({ kind: "htlcRefund", …, outputMask, maxFee })` |
| L2 state readback | `tari_getSubstate`, `tari_getTransactionResult` |
| Approval + isolation | per-transaction approval in wallet chrome, cross-origin iframe, `source`+`origin` checked both directions, replies never `"*"` |

`hashLockHex` is plain SHA-256 with no domain separation, which is byte-for-byte the same
digest Minotari computes (`docs/MINOTARI_ATOMIC_SWAP_API.md`). So only the L1 leg is
missing.

## 2. What is missing

Minotari's SHA atomic swap lives in the wallet's **Rust services**, not in its WASM layer:
`TransactionService::send_sha_atomic_swap_transaction`,
`OutputManagerService::create_claim_sha_atomic_swap_transaction`,
`OutputManagerService::create_htlc_refund_transaction`. The wallet's vendored WASM
bindings expose only `WasmTxBuilder` (one-sided send) and `WasmBurnBuilder`
(burn → Ootle). There is **no** hashlock/scripted-output construction for L1, so a browser
dApp cannot create, inspect, claim, or refund a Minotari SHA swap today.

Critically: **do not fall back to a generic one-sided `send()`.** A plain payment is not an
HTLC — it has no `HashSha256`/`Equal`/`CheckHeightVerify` script, so there is nothing to
claim against and nothing to refund.

## 3. Upstream work, layer by layer

### Layer A (BLOCKING) — expose the primitive to WASM: `tari_l1_wasm`

The binding must reach the *same wallet services the console wallet uses*, not
re-implement HTLC construction in TypeScript. Required surface (exact wallet semantics —
see `docs/MINOTARI_ATOMIC_SWAP_API.md` for the traced behaviour):

| Binding | Must do | Must NOT |
|---|---|---|
| `initShaAtomicSwap(recipient, feePerGram)` | call `send_sha_atomic_swap_transaction`; the **wallet** generates `S` as `CompressedPublicKey::from_secret_key(PrivateKey::random())` and `H = SHA256(S)`; build the exact script; return `{ txId, preImage, outputHash }` | accept a caller-supplied `H`, `S`, refund key, or refund height |
| `inspectShaAtomicSwap(outputHash)` | base-node readback: UTXO query, deleted query, tip info; decode the output script; return `H`, claim pubkey, refund pubkey, refund height, mined height, confirmations, spent flag | report the caller's own values back as "observed" |
| `claimShaAtomicSwap(outputHash, preImage, feePerGram)` | call `claim_sha_atomic_swap_transaction` (fetches the UTXO, DH-decrypts with the claimant's view key, spends the recovered output) | construct the script in JS |
| `refundShaAtomicSwap(outputHash, feePerGram)` | call `create_htlc_refund_transaction` — sender-side only, from the wallet's own output manager | allow refund to any key |

Constraints the binding must preserve:
- Amounts stay `u64` microMinotari throughout; the bridge converts to `bigint`, never to a
  JS `number`.
- `S` is 32 bytes and must be a canonical valid Ristretto point encoding — a claim
  (`CommsPublicKey::from_hex`) fails otherwise.
- Refund height is `tip + 720`; if a caller needs a different timeout, that is a **wallet
  API change upstream**, not something the binding may invent.

### Layer B — dApp operation surface: `tari-l1-wallet-ui`

Mirror the existing `htlcFund` / `htlcClaim` / `htlcRefund` pattern exactly (this keeps the
approval, serialization, and origin-isolation machinery reusable):

```ts
// new Operation kinds + Capabilities flags
tari_createTransactionRequest({
  kind: "l1InitShaAtomicSwap",
  amountMicro: string,            // u64 microMinotari, decimal string
  claimRecipientAddress: string,  // dual/stealth one-sided Tari address
  maxFee?: string
}) // → { transactionId, outputHash, preimageHex, refundHeight, refundRecipientAddress? }

tari_createTransactionRequest({ kind: "l1ClaimShaAtomicSwap",  outputHash, preimageHex, maxFee? })
tari_createTransactionRequest({ kind: "l1RefundShaAtomicSwap", outputHash, maxFee? })

tari_getL1ShaAtomicSwap({ outputHash })
// → { outputHash, exists, spent, scriptHex, hashHex, claimPubKeyHex,
//     refundPubKeyHex, refundHeight, minedAtHeight, confirmations,
//     currentHeight, amountRaw, amountAuthoritative }
```

Capability advertisement must be explicit so a dApp can feature-detect before any funding:

```ts
tari_getCapabilities() // → …, l1ShaAtomicSwap: { init: boolean, inspect: boolean, claim: boolean, refund: boolean }
```

Modules to touch (same list as the existing gap analysis):
`vendor/tari-l1-wasm` (Layer A), `src/lib/dappRequests.ts` (operation type + validation),
`src/lib/dappBridge.ts` (handler + approval copy), `public/tari-connector.js` (surface),
`docs/dapp-api.md` (documentation). **Estimate: MODERATE** — the wallet-side plumbing is
pattern-matched on existing operations; Layer A is the real blocker.

### Layer C — our repository (ready to write once Layer B lands)

`packages/protocol-client/src/chains/` gains a `TariBrowserProvider` implementing the same
`MinotariWalletProvider` port the gRPC provider already implements, so the coordinator and
state machine do not change at all. It must:

1. call `tari_getCapabilities` and advertise `l1ShaInit/l1ShaInspect/l1ShaClaim/l1ShaRefund`
   from the real provider answer (never assume presence);
2. refuse mainnet and refuse any network other than the configured testnet;
3. ingest the wallet-generated preimage through the existing
   `CrossChainSecretStore.ingestExternalSecret` path used by the gRPC provider;
4. map `amountAuthoritative` exactly as the gRPC provider does — a blinded commitment is
   **not** an authoritative amount (see §5);
5. re-derive `H`, claim key, and refund key from the returned `scriptHex` rather than
   trusting the discovery message.

## 4. Secret boundary for `S`

- `S` exists in exactly two places: the funding wallet (it generated it) and the
  `CrossChainSecretStore` of the funding session.
- In `XTM_TO_TARI` the funder's wallet must hand `S` to the dApp so the coordinator can
  reveal it to the counterparty after the L2 leg is funded. That crossing must be an
  explicit, separately-labelled user consent ("this secret will be shared with the
  counterparty"), and `S` must never appear in URLs, console output, analytics, crash
  reports, or the wallet's own transaction history.
- In `TARI_TO_XTM` the counterparty's wallet generates `S`; the counterparty learns nothing
  new, and we bind `H` from the authoritative script readback instead.
- Existing enforcement in our repo: `assertNoSecretInJson`, `InMemorySecretStore` reveal
  gated on `CLAIM_ARMED`, and a 20 000-transition property suite that refuses premature
  reveal. The browser provider must not add a bypass.

## 5. Amount authority (known protocol limitation, not an implementation bug)

A Minotari one-sided output stores its value inside a **blinded commitment**. The
base-node wallet RPC returns the `TransactionOutput` with the commitment — not a revealed
amount. Therefore:

- `tari_getL1ShaAtomicSwap` should return `amountRaw` **and** `amountAuthoritative`, and
  must set `amountAuthoritative: false` unless the wallet can produce a chain-validated
  opening (e.g. it holds the blinding factor and validates the output's Bulletproof).
- Our coordinator treats `amountAuthoritative: false` as "amount not proven" and refuses to
  advance to the second leg. This is deliberate: refusing is correct, silently trusting the
  funding intent is not.
- Closing this gap properly needs either an upstream readback that reveals/validates the
  value, or a protocol change to commit the value publicly in the HTLC. Filed as an
  upstream question, not worked around.

## 6. Acceptance criteria before we treat the browser path as real

1. `tari_getCapabilities` advertises the four L1 SHA ops, and our adapter's capability
   negotiation passes without hardcoding.
2. Script parity: the script the wallet builds decodes with our `decodeShaHtlcScript` to
   the same `H`, claim pubkey, refund pubkey, and `refundHeight` the wallet reports — from
   `scriptHex`, not from the discovery message.
3. SHA parity: `SHA256(S)` from the wallet's returned preimage equals the `hashLockHex` we
   send for the L2 leg, for several preimages.
4. Claim parity: a wrong preimage is rejected **before** any transaction is built
   (`hashlock refused`), and a correct preimage yields exactly one claim.
5. Refund parity: refund succeeds only from the funding wallet and only at/after the
   observed refund height.
6. Fail-closed: missing capability, wrong network, account change, or disconnect all refuse
   before funding; no `walletd`, console wallet, PowerShell, or local gRPC anywhere in the
   normal-user path.
7. `amountAuthoritative` is honest (see §5) and the coordinator's fail-closed behavior is
   covered by tests.

## 7. Sequencing

1. File the Layer A request against `tari_l1_wasm` with this document as the specification
   (blocked today).
2. Implement `TariBrowserProvider` against a feature-detected stub so it is testable before
   Layer B lands (no capability assumptions, all paths fail closed).
3. On Layer B, run the §6 acceptance suite against a real Esmeralda wallet.
4. Only then remove the `DEVELOPMENT_REFERENCE_PROVIDER` label from anything a normal user
   would touch. The gRPC provider stays development-only regardless.
