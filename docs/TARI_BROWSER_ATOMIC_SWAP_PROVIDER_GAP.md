# Tari browser atomic-swap provider gap analysis

Reference: `chironbuilds/tari-l1-wallet-ui` (commit tree `e76cc7289fde6e1d3b69c3dbe6ede571188138d1`, master, 25 commits, inspected 2026-09-25).
License: **CPAL-1.0** (network-serving = distribution; attribution Exhibit B). Status: `REFERENCE_ONLY_PENDING_LICENSE_REVIEW` — architecture and public interfaces studied; **no code copied**.

## The real `window.tari` API (verified: `docs/dapp-api.md`, `public/tari-connector.js`, `src/lib/dappBridge.ts`)

Every method callable as `window.tari.request({method, params})` — **identical shape to the
Sapient extension provider** — plus named sugar. Method names/params/results deliberately
match the extension; feature-detect via `tari_getCapabilities`, never wallet-detect.

Verified method surface (exact names): `tari_getNetwork`, `tari_requestAccounts`,
`tari_getAccounts`, `tari_getWalletAddress`, `tari_getCapabilities`, `tari_disconnect`,
`tari_getBalances`, `tari_getSubstate`, `tari_getTransactionResult`,
`tari_requestViewAccess`, `tari_getViewAccess`, `tari_revokeViewAccess`,
`tari_getPrivateBalances`, `tari_getShieldedOutputs`, `tari_scanForPrivatePayments`,
`tari_claimPrivatePayment`, `tari_createTransactionRequest`, `tari_getTransactionRequest`,
`tari_submitTransactionRequest`, `tari_signAndSubmitTransaction`, `proveFunds`,
`verifyFunds`.

**Transaction operations (exact shapes)** include:

```
{ kind: "htlcFund";   resourceAddress; amount; claimantWalletAddress;
  hashLockHex; refundEpoch; maxFee }
{ kind: "htlcClaim";  resourceAddress; commitment; conditions; preimageHex; maxFee }
{ kind: "htlcRefund"; resourceAddress; commitment; conditions; amount; outputMask; maxFee }
{ kind: "withdrawStealthAndExecute"; resourceAddress; amount; workspaceVarName;
  followUpInstructions; relatedComponents?; maxFee? }
{ kind: "shield" | "unshield" | "sendPrivately"; …; minimumValuePromise? }
```

Amounts cross the bridge as **real `bigint`s** (structured clone) — no JS-number exposure.
Result shapes: `htlcFund` → `{ transactionId, conditions, ownCommitment, outputMask }`;
`htlcClaim` → `{ transactionId }` (reveals the preimage); `htlcRefund` → `{ transactionId }`.

**These are Ootle L2 outputs** (bech32m `otl_…` wallet addresses, epochs) — i.e. the
already-verified stealth `PayTo::Conditions` ScriptPath HTLC primitives exposed through a
browser provider with per-transaction approval, connection/private-view/ownership-proof
grants, and cross-origin postMessage isolation (source/origin checked both sides; replies
never `"*"`).

## Capability matrix (evidence-based)

| Capability | window.tari (dApp provider) | local wallet/gRPC | Needed by FAST_XTM_TARI |
|---|---|---|---|
| Network (`tari_getNetwork`) | YES (L2; pre-connect answerable) | YES | YES |
| Account/address | YES — component addr + `otl_…` wallet addr (`tari_getWalletAddress`) | YES | YES |
| Balance (`tari_getBalances`) | YES (`TokenBalance`, bigint) | YES | YES |
| Normal send | YES (`instructions`/`sendPrivately`) | YES | YES |
| Transaction sign | YES (wallet-side, per-tx approval) | YES | YES |
| Transaction submit | YES (`tari_submitTransactionRequest`, atomic single-winner claim) | YES | YES |
| Tx status (`tari_getTransactionResult`) | YES | YES | YES |
| Confirmation count | PARTIAL (epoch/height via `tari_getSubstate`/tip; no dedicated method) | YES | YES |
| UTXO/output lookup (`tari_getSubstate`) | YES (raw substate) | YES | YES |
| Custom script output (L2 hashlock/AfterEpoch) | **YES** (`htlcFund` + `conditions`) | YES | YES (L2 leg) |
| SHA hashlock (L2) | **YES** (`hashLockHex`, Sha256, interop-grade digest) | YES | YES |
| Refund epoch (L2) | **YES** (`refundEpoch`, `htlcRefund` with `outputMask`) | YES | YES |
| Atomic-swap finalise (L2) | **YES** (`htlcClaim` with `preimageHex`) | YES | YES |
| Atomic-swap refund (L2) | **YES** (`htlcRefund`) | YES | YES |
| **L1 tXTM SHA atomic swap** | **NO** — dApp operations are Ootle-side only; L1 txs are built in-page via `vendor/tari-l1-wasm` (burn/send only) | YES (console wallet commands; FULLY TRACED against v6.0.0 — see `docs/MINOTARI_ATOMIC_SWAP_API.md`) | **YES — L1 leg** |
| Restart recovery | PARTIAL (requestIds in wallet memory; lost when wallet closes — documented) | YES | YES |

## Verdict

- **L2 leg via browser: READY (capabilities already exist).** `htlcFund`/`htlcClaim`/
  `htlcRefund` + `tari_getSubstate` + `tari_getCapabilities` map 1:1 onto our
  `OotleScriptPathLegPort` and the same `SHA256` hashlock semantics verified in the Ootle
  engine (`crates/engine_types/src/stealth/hashlock.rs` — domain-separation-free, NIST
  vector tested).
- **L1 leg via browser: SHA atomic swap MISSING.** The wallet's L1 stack
  (`vendor/tari-l1-wasm`) exposes `WasmTxBuilder` (one-sided send) and `WasmBurnBuilder`
  (burn→Ootle) only. No hashlock/scripted-output construction for L1 exists in the vendored
  API. **Do NOT fall back to generic `send()`** — a one-sided payment cannot be a HTLC.
- Our earlier `BROWSER_MINOTARI_PROVIDER = BLOCKED_EXTERNAL` conclusion stands for the L1
  leg, with a materially better production path now identified: the L2 browser leg is
  ready, and the L1 leg needs a provider extension.

## Proposed minimum provider extension (based on the ACTUAL existing design)

The wallet already has the needed trust model (per-transaction approval, in-page signing,
`source`+`origin` checks). The minimal extension mirrors the existing operation pattern —
add to `Operation` (and `Capabilities`, e.g. `l1ShaAtomicSwap: boolean`), implemented in
the wallet page over a `tari_l1_wasm` extension:

```
tari_createTransactionRequest({
  kind: "l1InitShaAtomicSwap",
  amountMicro: string,          // micro-Minotari raw integer
  hashLockHex: string,          // SHA256(S), 32-byte hex — same H as the L2 leg
  refundHeight: string,         // absolute L1 block height
  claimRecipientAddress: string // dual one-sided address
})
inspectShaAtomicSwap({ l1TxId })         // authoritative output observation
claimShaAtomicSwap({ l1TxId, preimageHex, claimRecipientAddress })
refundShaAtomicSwap({ l1TxId, refundRecipientAddress })
```

Lower-level alternative (if the wallet prefers generic primitives): expose
`buildL1CustomScriptOutput({ script, covenant, features, refund_height })` on
`WasmTxBuilder` + a `spendScriptOutput` op — but the named swap ops are safer and match
the existing `htlcFund/Claim/Refund` naming.

The full layer-by-layer extension request (WASM primitive → wallet dApp surface → our
adapter), the secret-boundary rules for `S`, the blinded-amount limitation, and the
acceptance criteria are specified in `docs/TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md`.

## Upstream contribution estimate

Modules to change in `tari-l1-wallet-ui`: `vendor/tari-l1-wasm` (needs the L1 HTLC builder
upstream in `tari_l1_wasm` — the real dependency), `src/lib/dappRequests.ts` (operation
type + validation), `src/lib/dappBridge.ts` (handler + approval dialog copy),
`public/tari-connector.js` (surface), `docs/dapp-api.md` (API doc). **Estimate:
MODERATE** — the wallet-side plumbing is small and pattern-matched on existing ops, but it
is BLOCKED_BY_UPSTREAM on the L1 primitive itself: `tari_l1_wasm` must first expose the
Minotari SHA atomic-swap construction (the console-wallet commands live in tari-project/tari
wallet code, not yet vendored as WASM).

## Mobile / desktop evidence

- The wallet is a responsive web app (mobile screenshots `shots/mobile-dashboard.png`,
  `shots/mobile-send.png`); browser-only runtime, no install.
- `window.tari` is NOT injected into arbitrary pages: dApps run in a **cross-origin iframe
  inside the wallet** and load `https://universe.tari.mw/tari-connector.js` (same-page
  wallet model). A phone webpage therefore reaches the wallet through the wallet's own
  dApp frame/app catalogue — NOT via an injected extension provider. Desktop and mobile
  browsers both work under this model; there is no evidence of a WebView/deep-link bridge
  for third-party pages.
- Keys: CipherSeed encrypted at rest with PIN (`src/lib/pinLock.ts`); L1 keys in
  `tari-l1-wasm`; Ootle account derived **from the same recovery phrase**
  (`src/ootle/index.ts`, `@chironbuilder/ootle-sdk`). Seed never crosses the bridge.

## Self-custody / secret boundary

- L1/L2 private keys never leave the wallet page (WASM signing; cross-origin isolation).
- For our SHA preimage S: protocol client owns and stores S in `CrossChainSecretStore`;
  the provider API never needs S. `htlcClaim`/`htlcRefund` accept the preimage as a
  per-transaction parameter — it must NEVER travel through URLs, logs, or ordinary history
  (enforced by our `CrossChainSecretStore` + `assertNoSecretInJson`).
- `htlcFund` warns the funder cannot decrypt the claimant-addressed output — the funder
  must persist `outputMask`/`amount` for `htlcRefund`. Our session store captures this
  evidence class at funding time.

## Provider spoofing / origin security (from source docs)

Origin+source checked both directions; replies never posted to `"*"`; approvals drawn in
wallet chrome outside the iframe; prompts serialized; grants per-origin in wallet
localStorage; `tari_disconnect`/user revocation supported. Our integration must
fail-closed on: wrong `tari_getNetwork`, capability mismatch (`tari_getCapabilities`:
`htlcFund`/`scriptPathSpend` false), account change, disconnect, and must re-verify view
grants rather than cache them.

## Final structure

```text
FAST_XTM_TARI
      │
MinotariAdapter (protocol-client/crosschain/provider.ts ports)
      ├── TariBrowserProvider  → window.tari (Sapient-shaped)  [L2 leg READY; L1 swap PENDING]
      └── LocalGrpcProvider    → development/test harness ONLY
```

`OOTLE_VIA_SAME_PROVIDER: YES — the same provider exposes L1 burn + L2 TARI/stealth (same
seed), so one wallet could eventually serve both legs of the route.`

**Normal-user walletd requirement for production: NO (browser model above).** Local gRPC
remains development-only for the L1 leg until the upstream primitive exists.