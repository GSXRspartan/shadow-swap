> **SUPERSEDED IN PART (2026-09-29).** This document reverse-engineered the
> provider from `tari-connector.js` alone. Tari has since published the dApp
> integration contract, and the provider boundary is now coded against
> <https://universe.tari.mw/integration/tari-dapp.d.ts> instead. The claims below
> about `isEmbedded` gating, the `address` compatibility alias, and the
> "Sapient-shaped" interface are **no longer correct**. The authoritative record
> is [`docs/TARI_WALLET_INTEGRATION_CONFORMANCE.md`](TARI_WALLET_INTEGRATION_CONFORMANCE.md).
# Tari browser atomic-swap provider gap analysis

Reference: `chironbuilds/tari-l1-wallet-ui` (commit tree `e76cc7289fde6e1d3b69c3dbe6ede571188138d1`, master, 25 commits, inspected 2026-09-25).
License: **CPAL-1.0** (network-serving = distribution; attribution Exhibit B). Status: `REFERENCE_ONLY_PENDING_LICENSE_REVIEW` — architecture and public interfaces studied; **no code copied**.

## DIRECT verification against the deployed connector (2026-09-28)

The section below was reconstructed from a third-party repository. That is
`REFERENCE_ONLY` evidence. The connector itself was then fetched and read
directly:

```
GET https://universe.tari.mw/tari-connector.js    → 200, 18,589 bytes
GET https://universe.tari.mw/                      → 200
```

This is stronger evidence than the reconstruction, and it **changed two things
in this repository**.

### 1. The method surface is confirmed, and ours is a strict subset

Every one of the thirteen methods in `TARI_METHODS`
(`apps/web/src/services/tariWindow.ts`) exists verbatim in the deployed
connector:

`tari_getNetwork` · `tari_requestAccounts` · `tari_getAccounts` ·
`tari_getWalletAddress` · `tari_getCapabilities` · `tari_disconnect` ·
`tari_getBalances` · `tari_getSubstate` · `tari_getTransactionResult` ·
`tari_signAndSubmitTransaction` · `tari_createTransactionRequest` ·
`tari_getTransactionRequest` · `tari_submitTransactionRequest`

Nothing this app calls is invented. This is now asserted as a test
(`provider: every allow-listed method exists in the live upstream connector`),
because an allow-list is fail-closed: a wrong name is not a harmless typo, it is
a call that can never succeed with a denial that would point at the wallet.

The connector additionally exposes a confidential surface this app
**deliberately does not call**: `tari_getViewAccess`,
`tari_requestViewAccess`, `tari_revokeViewAccess`, `tari_getPrivateBalances`,
`tari_getShieldedOutputs`, `tari_scanForResourceUtxos`,
`tari_scanForPrivatePayments`, `tari_claimPrivatePayment`,
`tari_signOwnershipChallenge`, `tari_signWalletOwnershipChallenge`. This is a
public constant-product AMM and a public marketplace; widening what the app asks
a wallet for is not an improvement. Asserted negatively in the same test file.

### 2. `tari_getSubstate` takes `substateId`, not `address` — a real defect, fixed

The connector calls this method in three separate places:

```js
getSubstate: function (substateId, version) {
  return request("tari_getSubstate", { substateId: substateId, version: version == null ? null : version });
}
```

`address` appears 13 times as `substateId` and never as a `getSubstate`
parameter. This app was sending `{ address }` — the name it uses internally.

That mattered because this is the **authoritative readback path**: the port
`AuthoritativeSubstateReader` feeds every resolver reread. Against a real wallet
the call would have failed. The failure mode is *safe* — the resolvers fail
closed rather than settling on unvouchable state — but it would have made the
product non-functional for every real user while looking like a wallet problem.

Fixed: `substateId` is now the primary key, `address` is retained as a
compatibility alias carrying the identical string, and a reply is accepted under
either key. Pinned by
`provider: tari_getSubstate is called with substateId, the name the connector uses`.

### 3. `isEmbedded`, not `isAvailable` — and it resolves R-13

The connector's published object is:

```js
var provider = {
  isTariWallet: true,
  isEmbedded: embedded,               // window.parent !== window
  info: { name: "Tari Universe", rdns: "mw.tari.universe", embedded: true },
  request: function (args) { ... },
  ...
};
```

Its own doc comment says *"Outside the wallet … `window.tari.isAvailable` is
false"* — `isAvailable` is **not** defined on the object. That is an upstream
documentation slip, not a contract, and it is recorded here so nobody later
"fixes" this app to depend on a property that does not exist. The real signal is
`isEmbedded`, and `request` rejects immediately when it is false.

`getTariProvider` now refuses an explicit `isEmbedded === false` **before** any
call is made, with a typed `NOT_INJECTED`, so a page that merely loaded the
connector script outside a wallet frame reports "not connected" instead of
appearing to be a wallet that rejects everything. An absent field is not
refused — only a positive `false` is — so a provider that does not publish
`isEmbedded` keeps working.

### 4. R-13 is RESOLVED: the `script-src` allowance is now observed, not assumed

R-13 recorded that we did not know whether the wallet injects a `<script>`
element (which `script-src https://universe.tari.mw` permits) or establishes
`window.tari` purely by `postMessage`. The connector's own source answers it:

> "Why a script rather than an injected object: a browser extension injects its
> provider from a content script, which a web page cannot do. The wallet runs
> your dApp in a cross-origin iframe, so it cannot reach into this page — and
> that isolation is exactly what stops a dApp reading the wallet's storage. So
> the provider lives here and forwards every call to the wallet by postMessage."

So the wallet **does** load `tari-connector.js` as a cross-origin script into the
dApp document. The `script-src` allowance was required, and remains correct.
R-13 moves from `UNVERIFIED_EXTERNAL` to **RESOLVED — VERIFIED AGAINST SOURCE**.

One more consequence, recorded because it is a detection surface: the connector
dispatches `tari:announceProvider` and `tari#initialized` and maintains
`window.tariProviders`. **This app does not listen to any of them.** Provider
detection here is by object *identity* — the object captured at connect is
compared by reference at authorization time — because an announcement event is
just another thing a hostile page can emit. The events are not trusted, and this
is deliberate rather than an omission.

---

## The real `window.tari` API (reconstructed reference: `docs/dapp-api.md`, `public/tari-connector.js`, `src/lib/dappBridge.ts`)

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