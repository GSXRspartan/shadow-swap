# Upstream L1 dApp bridge — capability gap and minimal extension

Date: 2026-11-08. Sources verified from live code, not documentation alone.

## Verified boundary (fetched live)

The dApp-side provider (`https://universe.tari.mw/tari-connector.js`) exposes
`window.tari.request({method, params})` with these methods only: `tari_requestAccounts`,
`tari_getAccounts`, `tari_getNetwork`, `tari_getWalletAddress`, `tari_getBalances`,
`tari_getCapabilities`, `tari_getSubstate`, `tari_getTransactionResult`,
`tari_signAndSubmitTransaction`, `tari_createTransactionRequest`,
`tari_getTransactionRequest`, `tari_submitTransactionRequest`, `tari_requestViewAccess`,
`tari_getViewAccess`, `tari_revokeViewAccess`, `tari_getPrivateBalances`,
`tari_getShieldedOutputs`, `tari_scanForPrivatePayments`, `tari_scanForResourceUtxos`,
`tari_claimPrivatePayment`, `tari_signOwnershipChallenge`,
`tari_signWalletOwnershipChallenge`, `tari_disconnect`.

There is **no L1/Minotari method, no `getL1Capabilities`, no `htlcFund` on L1, and no
capability flag for L1** in the provider or its capabilities object. The wallet can
still sign L1 transactions in the browser: Web Tari Universe embeds an L1 Minotari
wallet that builds and signs in WebAssembly locally (minotari wallet is in-process in
Universe v1.6.x: `feat: minotari wallet integration`, `feat(l2): layer 2 wallet panel
with the Ootle wallet in-process`).

The connector also has an origin allowlist (`KNOWN_WALLET_ORIGINS`) + iframe postMessage
bridge (`tari-dapp-bridge/1`), where the wallet is the parent and only replies to the
origin that embedded it.

**Upstream layout (verified from `tari-project/universe` tree):**
- Browser WASM L1 wallet UI: `chironbuilds/tari-l1-wallet-ui` (web wallet at
  universe.tari.mw) implements the parent-side bridge for the `tari-dapp-bridge/1`
  protocol and holds L1 keys/signing inside the page. Local storage is not exposed to
  the dApp iframe (the connector comment states the wallet iframe cannot reach the
  dApp page).
- L1 signing primitives on the wallet side: Minotari crypto/unit support in
  `tari-project/tari` (`infrastructure/tari_script` for TariScript evaluation,
  `base_layer/wallet/src/output_manager_service` for UTXO building/signing), plus the
  `SendShaAtomicSwapTransaction`/`ClaimShaAtomicSwapTransaction` gRPC surface in
  `applications/minotari_app_grpc/proto/wallet.proto` used by the console wallet.

## The exact missing API boundary

dApps can drive the entire Ootle L2 HTLC leg today (`htlcFund`/`htlcClaim`/`htlcRefund`
request kinds, gated on `capabilities.htlcFund` + `capabilities.scriptPathSpend`).
They cannot drive any Minotari L1 leg: no method exists. The minimum upstream surface
must therefore add, in the wallet (web bridge parent + provider contract + capability
advertisement):

| New dApp method | Wallet-side operation | Permission + approval |
|---|---|---|
| `tari_l1GetBalance` | read available/pending balances | connection only, no prompt |
| `tari_l1GetChainStatus` | tip height + sync status | connection only |
| `tari_l1GetCapabilities` | the 4 L1 HTLC primitives per account | connection only |
| `tari_l1HtlcInit` | `SendShaAtomicSwapTransaction` (wallet generates S, returns hash + commitment) | new L1 prompt |
| `tari_l1HtlcInspect` | base-node UTXO/deleted readback | connection only |
| `tari_l1HtlcClaim` | `ClaimShaAtomicSwapTransaction` | new L1 prompt |
| `tari_l1HtlcRefund` | `ClaimHtlcRefundTransaction` | new L1 prompt |
| `tari_l1EstimateFee` | fee estimation for the above | connection only |

Safety requirements for the extension (mirroring how `htlcFund` works today):
- Never expose seeds, private keys, view keys, or raw signatures to the dApp. The
  wallet constructs/signs locally; the dApp receives only the same class of artifacts
  `htlcFund` returns (commitment, conditions, output id).
- Explicit per-transaction approval inside the wallet (not the page), validated against
  origin + connected account + network + exact transaction contents.
- Capability-gated with one L1 permission prompt (separately granted from the Ootle
  connection), advertised via `l1Htlc`-style capability flags.
- Mainnet: refused or separately gated, same as Shadow Swap's own real-submit gate.

## Shadow Swap side (no upstream change needed)

Shadow Swap already defines this boundary as its `MinotariWalletProvider` port
(`packages/protocol-client/src/crosschain/provider.ts`, states READY/BLOCKED) and the
coordinator refuses atomic swaps from the browser until the provider advertises
`L1ShaInit/Inspect/Claim/Refund` (`requireLegCapabilities`, `BROWSER_MINOTARI_PROVIDER`).
Upgrading = wiring a `window.tari` L1 transport that satisfies that port; no protocol
change is required.

## Shadow Swap local diagnostic fallback (NOT the primary path)

`packages/protocol-client/src/chains/minotari_grpc.ts`
(`MinotariDevGrpcProvider`, `DEVELOPMENT_REFERENCE_PROVIDER = true`) implements the
same port against a local console wallet's gRPC (`127.0.0.1:18143`). It requires the
wallet's dev env gate and a local endpoint — never exposed to arbitrary websites and
never a substitute for the browser signer above. It exists for diagnosis and Esmeralda
testnet validation only.

Do NOT mix the L1 burn-and-claim flow (`claim_burn_authorization.rs` etc.) into this
border: burn-and-claim is a unilateral conversion requiring a co-signed claim with the
derived stealth key, not a two-party atomic swap.
