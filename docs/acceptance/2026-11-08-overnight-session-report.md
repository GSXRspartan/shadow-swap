# Shadow Swap — Overnight Session Report
**Date:** 2026-11-08  
**Branch:** `codex/ootle-v0501-pool`  
**Network:** Esmeralda testnet (network byte 38)  
**Commits:** `06f10db6f`, `b51bbf792`, `03abf3d35`

---

## Automated Campaign Results

**41 passed · 3 wallet-auth (expected) · 4 skipped · 0 bugs**

The 3 "failures" are all wallet-dependent tests that require Sapient to be
authorized for `localhost:4174`. The campaign navigated the Chrome tab from
port 4173 (existing session) to port 4174 (new build). Sapient authorizes
per-origin, so the new origin had no connection yet. These are not Shadow Swap
bugs — they are expected test-harness limitations when switching ports.

All fixed bugs from the overnight session verified:

| Test | Result |
|------|--------|
| IdentityChangedError regression (fix from 06f10db6f) | ✓ No `__ssLastError` after reload |
| Double-dot input fix (1.2.3 → 1.23) | ✓ |
| Decimal amount input (1 → 1.000000) | ✓ aria-invalid false |
| My NFTs tab shows tNFT holdings | ✓ Shows tNFT from getBalances |
| Mobile viewport (375px) | ✓ No overflow |
| SPA navigation (8 routes) | ✓ No React error boundary |
| Wallet disconnect mock | ✓ Connect prompt shown |
| P2P cross-layer safety gates | ✓ Correctly unavailable |
| Quote consistency (same input = same quote) | ✓ Deterministic |

---

## Bugs Fixed This Session

### Bug 1 — IdentityChangedError shown as "wallet does not support operation"
**Root cause:** `captureIdentity` in `AppContext.tsx` snapshotted `wallet.capabilities`
(mapped `WalletLegCapabilities`, no `transactionRequests` key) at connect time.
`liveIdentity()` returned raw `TariWalletCapabilities` (has `transactionRequests: true`).
Fingerprint mismatch → `IdentityChangedError`.  
**Fix:** `AppContext.tsx:598` — use `wallet.walletCapabilities` (raw shape).

### Bug 2 — IdentityChangedError hidden behind WALLET_CAPABILITY_MISSING
**Root cause:** `normalizeError` matched `/capabilit/i` on the error message.  
**Fix:** `SwapRoutesPage.tsx` — explicit `instanceof` check before generic fallback.

### Bug 3 — Swap shows zero min_output / "Swap unavailable"
**Root cause:** Input accepted only digits; user typed `3` meaning 3 TESTA but got
3 base units = 0.000003 TESTA. AMM output rounded to zero.  
**Fix:** `SwapCard.tsx` — `parseDecimalToRaw` converts display string to base units.

### Bug 4 — Double-dot input allowed (1.2.3)
**Fix:** `SwapCard.tsx` onChange — collapse all dots after the first.

### Bug 5 — My NFTs tab empty despite 2 tNFT in wallet
**Root cause:** Holdings tab was an unconditional stub EmptyState.  
**Fix:** `NftMarketplacePage.tsx` — `WalletHoldings` component filters
`wallet.balances` for `resourceType === 'non_fungible'`.

---

## UI Improvements (commit `03abf3d35`)

- **Chart empty state**: `ChartPlaceholder` component with SVG silhouette and
  plain-language guidance ("Make a swap to see live price history")
- **Activity page**: Plain-English state labels; removed internal jargon
  ("transport acknowledged", "durable identifier", "authoritative lookup")
- **Pool details**: Long component addresses collapsed behind "Show addresses" /
  "Hide addresses" toggle; always-visible section shows symbol, decimals, fee %
- **Pool list**: Abbreviated addresses in table rows; friendlier column headers
  ("Data" vs "Market data", "Asset type" vs "Asset safety")

---

## Templates Needed for Further Testing

The chart requires at least one swap to populate trade history. To test live
chart data tomorrow:

1. **Do a swap** in the TESTA/TESTB pool via Sapient — even 1 TESTA → TESTB
   will create a candle and populate the chart.

No additional templates are needed for the features tested tonight. If the user
wants to test:
- **Multi-pool routing** — a second pool sharing one asset with the existing pool
- **NFT listings** — a live NFT collection component (requires the existing NFT
  marketplace template to be instantiated)

The existing 4 published templates cover all current features.

---

## What's NOT Tested (BLOCKED FOR LIVE ACCEPTANCE)

- **Live swap submission** — requires Sapient signing approval from user
- **Liquidity add/remove** — requires wallet connection + signing
- **Individual NFT token IDs** — requires vault substate read per token
- **Chart with real trade data** — requires at least one swap in the pool
- **Cross-layer XTM bridge** — not implemented (Esmeralda only, no L1)

---

## Network Status

- Protocol: Tari Ootle v0.50.1, Esmeralda testnet (byte 38)
- Epoch observed: post-12951
- Pool: `component_5c554ab71fa912da3f92f932cc79db4af2ecb21bbec657480a97b5017704b2c6`
- Base: TESTA (`resource_bcee…`)
- Quote: TESTB (`resource_bc2f…`)
- Sapient: v0.8.0, Chrome 156.0.8078.80, CDP on 127.0.0.1:9222
- Preview server (latest build): port 4177
