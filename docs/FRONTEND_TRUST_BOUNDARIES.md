# FRONTEND TRUST BOUNDARIES

`apps/web` is a **consumer** of the protocol. It renders values the protocol
produces and forwards intents the protocol constructs. It never computes an
execution result.

This document is the architectural contract. The tests referenced in each
section are the enforcement; a change that breaks one of them is a change to the
trust model, not a refactor.

---

## 0. Status

| Property | State |
|---|---|
| Build status | `EXPERIMENTAL` |
| Network | `Esmeralda Testnet` only. Mainnet is not configurable. |
| Real cross-chain submission | `OFF` by default, gated by `TARI_LIQUIDITY_ENABLE_REAL_CROSSCHAIN_SUBMIT` |
| Browser atomic XTM↔TARI swaps | `BLOCKED_EXTERNAL` (upstream Minotari L1 SHA primitive) |
| Audit | Not audited. See `docs/AUDIT_CHECKLIST.md`. |

---

## 1. The one rule

> **Market data may populate a display value. It may never populate an amount,
> a `min_output`, a resource identity, a settlement proof, or a transaction
> builder input.**

Enforcement is layered, and each layer is tested:

| Layer | Mechanism | Test |
|---|---|---|
| Type | `DisplayOnly` is a branded object, structurally **not** assignable to `string`. `resolveSwap({ rawInputAmount })` will not compile with one. | `test/boundary.test.cjs` |
| Runtime | `asRawExecutionAmount` / `asResourceAddress` refuse branded values, numbers, and non-canonical strings. | `test/boundary.test.cjs` |
| Behavioural | A poisoned market-data price leaves `resolveSwap`'s output byte-identical. | `test/boundary.test.cjs` |
| Static | No constant-product expression exists anywhere under `apps/web/src`. | `test/security.test.cjs` |
| Read model | `MarketDataView` exposes formatted strings only; it has no accessor that returns a raw price. | `test/boundary.test.cjs` |

The single sanctioned exact → `Number` conversion is the protocol-client's own
`toDisplayPrice` / `toChartSeries`. The frontend calls it and does not
second-guess it (`test/security.test.cjs` asserts no local `toDisplayPrice`
exists).

---

## 2. What the frontend calls, and what it never calls

| Concern | Owner | Frontend entry point |
|---|---|---|
| Swap quote + `min_output` | `resolveSwap` | `components/SwapCard.tsx` |
| LP add / remove amounts | `resolveAddLiquidity` / `resolveRemoveLiquidity` | `components/LiquidityPanel.tsx` |
| Buy Now / Sell Now / accept offer | `resolveBuyNow` / `resolveSellNow` / `resolveAcceptItemOffer` | `components/NftDetailPanel.tsx` |
| Cross-layer coordination | `crosschain/coordinator.ts` | **never called from the UI** |
| Secret preimage `S` | `crosschain/secret.ts` | **never referenced** |
| Settlement proofs | `multihop/proof.ts` | **never constructed** |
| Route state machine | `applyRouteEvent` | **never driven**; the UI renders the resulting `RouteView` |
| Operation state | `OperationRecord` / `reconcileOperation` | `services/history.ts`, `pages/ActivityPage.tsx` |

`test/security.test.cjs` scans the source and fails if the app names
`initShaAtomicSwap`, `acceptQuote`, `beginL1Funding`, `revealAndClaim`,
`dangerouslySetInnerHTML`, or any secret-bearing field.

---

## 3. `window.tari`

One integration boundary, one direction of travel:

```
React UI  →  useApp()  →  WalletBridge  →  TariProvider  →  window.tari
```

- `services/tariWindow.ts` is the only module that reads `window.tari`. It
  allow-lists every method name, shape-checks every reply, and normalises the
  provider's capability advertisement.
- `services/walletService.ts` adapts that provider to the generic
  `WalletAdapter` seam and exposes `legCapabilities()`, `substateReader()` and
  `readbackProvider()`.
- No React component references `window`, `globalThis`, or a wallet brand.
  Behaviour is capability-driven (`lib/capabilities.ts`); wallet identity never
  reaches trading logic.
- A provider that cannot answer `tari_getCapabilities` is **not used at all**:
  `isSupported()` returns false and the app stays disconnected. A page script that
  installs a fake `window.tari` therefore cannot impersonate a wallet.
- The authoritative pool readback is `WALLET_PROVIDER`-backed
  (`createOotleReadbackProvider(reader, 'WALLET_PROVIDER')`), which throws at
  construction for any non-authoritative source. An indexer is never substituted.

### Capability-driven refusals

`lib/capabilities.ts` renders the browser L1 gap from the protocol-client's own
constants, not from hand-written copy:

- `BROWSER_MINOTARI_PROVIDER === 'BLOCKED_EXTERNAL'` ⇒ the atomic XTM route is
  disabled with the headline **"Wallet upgrade required for atomic XTM swaps"**.
- **No fallback to walletd** for normal users, in any build.
- The real-submit gate is *mirrored* for display only; the coordinator remains
  authoritative and the UI never attempts to bypass it.

---

## 4. Identity changes

A disconnect, account change, or network change clears the session, bumps
`wallet.identityEpoch`, and sets every execution control back to disabled. There
is no path that continues an in-flight execution under a changed identity
(`state/AppContext.tsx`, `services/walletService.ts`).

The page is pinned to a single network: a provider reporting a different one is a
hard connect failure with an instruction, not a warning.

---

## 5. Untrusted metadata

Token symbols, NFT names, descriptions, collection names, image URLs, and
provider labels are attacker-controlled. `lib/sanitize.ts` is the only judge:

- control characters, zero-width joiners and **bidi overrides** are stripped
  (a bidi override can visually reverse a resource name);
- `safeExternalUrl` rejects every scheme except `http(s)`, including obfuscated
  `javascript:` forms (`java\tscript:`, mixed case, leading whitespace), and
  rejects credentials in the authority;
- `safeImageUrl` additionally requires an https media shape;
- NFT metadata is fetched with a size cap, a content-type check, an abort
  timeout, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`;
- **no HTML is ever injected.** `test/security.test.cjs` fails on
  `dangerouslySetInnerHTML`, `.innerHTML`, `insertAdjacentHTML`, `document.write`
  and `eval`.

A symbol is a **label**. The exact `ResourceAddress` and `NonFungibleId` are
always reachable behind a focus/hover affordance, and two resources sharing a
symbol stay distinguishable everywhere
(`test/lib.test.cjs`, `test/nft.test.cjs`).

---

## 6. Honest emptiness

The app is designed to be useful when it knows nothing:

| Situation | What is shown |
|---|---|
| No market-data source | `Data Unavailable`; no canvas is mounted |
| Source has produced no trade | `No trades yet` + an explanation; the rest of the page works |
| Trades exist, none in the interval | `Empty market` |
| Source is behind | `Stale`, with the last confirmed data and a warning |
| Epoch-bucketed candles only | `Degraded` + a table, **never a fabricated time axis** |
| Metric the query API did not produce | `—` (never `0`) |
| No pool discovery endpoint | An explicit "no discovery configured" notice; no pool list is invented |
| No NFT discovery endpoint | An explicit notice; no collection is fabricated |

`test/lib.test.cjs`, `test/chart.test.cjs` and `test/render.test.cjs` assert each
of these.

### Time honesty

`formatTradeTime` shows a wall clock **only** when the source is
`CONSENSUS_TIMESTAMP`. `EPOCH_BOUNDARY` renders `Epoch N`. `INDEXER_OBSERVED`
and `LOCAL_RECEIPT` render `—`, because they are not a consensus clock.

### Liquidity is never faked

Liquidity is shown as native quantities only. There is no fiat TVL anywhere,
because nothing in this build has a defensible price to derive one from.

---

## 7. Development fixtures

`VITE_USE_FIXTURE_DATA` and `VITE_ENABLE_DEV_PROVIDERS` are honoured **only**
when `mode === 'development'`. Setting either in a production build is a
blocking configuration error, not a silent ignore
(`lib/networks.ts#localEndpointReason`, `services/config.ts`, asserted by
`test/lib.test.cjs` and `test/security.test.cjs`).

The build-time environment surface is a single explicit list injected by Vite's
`define` (`vite.config.ts` → `services/envSource.ts`). No variable outside that
list can influence the bundle, and no `127.0.0.1` default exists in the build
config.

---

## 8. Development trading fee

Zero, and structurally so. `RouteFeeBreakdown.developerTradingFeeRaw` is typed
`'0'`, `validateRouteRecord` rejects any other value, and
`test/security.test.cjs` fails if the app introduces a `developerFee` /
`platformFee` symbol. The UI always distinguishes **LP fee** (to LPs),
**provider spread** (to the cross-layer provider), and **network fees**.

---

## 9. Operation history

`PENDING`, `SUBMITTED`, `CONFIRMED`, `FAILED`, `UNKNOWN` are all rendered, and
`UNKNOWN` carries an explicit "reconciling, not retrying" state. There is no
retry button. `reconcileOperation`'s verdict is surfaced verbatim, including
`resubmissionAllowed: false`.

`JsonHistoryStore` degrades a corrupt payload to an empty list, which is
indistinguishable from "no history yet"; `historyIntegrity()` detects that and
the Activity page warns, so a silent data loss is never shown as a clean slate.

Explorer links are emitted **only** from a known-correct template. None exists
for Esmeralda in this repository, so `explorerUrl()` returns `undefined` and no
link is invented.

---

## 10. Test coverage map

| Suite | Tests | Covers |
|---|---|---|
| `test/lib.test.cjs` | 23 | BigInt formatting, unavailable markers, sanitisation, network gating, slippage policy, health, capabilities, config gates |
| `test/chart.test.cjs` | 11 | Display conversion, epoch-bucket refusal, interval support, incremental tail updates, all seven chart states |
| `test/boundary.test.cjs` | 6 | **Market-data trust boundary**, execution authority, no developer fee |
| `test/route.test.cjs` | 13 | Route chain, partial completion, requote, recovery, protected minimum, no preimage |
| `test/render.test.cjs` | 14 | Pool discovery, pool page, swap card, route panel, activity page, shell, testnet, accessibility |
| `test/nft.test.cjs` | 13 | Hostile metadata, stale listing, quote-swap refusal, BigInt bid escrow, readback adapter |
| `test/security.test.cjs` | 14 | XSS, secrets, no console logging, no reimplemented math, mainnet absence, fixture isolation, submit gate, chart lifecycle, responsive CSS, focus |
| **Total** | **94** | |

---

## 11. Open findings

| Sev | Finding | Where |
|---|---|---|
| LOW | `toDisplayPrice` returns `approximate: true` for every non-zero price, including an exact one. It is a conservative label, not a claim of inaccuracy, but a consumer could over-react to it. | `packages/protocol-client/src/marketdata/price.ts` |
| LOW | `wallet-adapter`'s `BrowserExtensionWalletAdapter` is a stub returning placeholder accounts and `pending` for every lookup. It is unreachable in this build (the app uses its own bridge), but it remains a trap for future callers. | `packages/wallet-adapter/src/browser_extension.ts` |
| INFO | There is no verified explorer URL template for Esmeralda, so the Activity page shows an abbreviated txid with the full value in a tooltip rather than a link. | `lib/sanitize.ts#explorerUrl` |
| INFO | No browser/E2E harness. Coverage is `node --test` plus `react-dom/server` renders; canvas behaviour, responsive layout at 360–1440px, and real provider interaction are unverified by automated tests. | — |
| INFO | `applyRouteEvent` shallow-copies the record while mutating hop objects. A React store must deep-clone before calling it. The frontend does not call it, so this is a hazard for the next consumer. | `packages/protocol-client/src/multihop/route.ts` |
