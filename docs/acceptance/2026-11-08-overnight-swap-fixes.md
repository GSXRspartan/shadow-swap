# Overnight Swap Fix Acceptance — 2026-11-08

## Summary

Three bugs investigated and fixed on branch `codex/ootle-v0501-pool`, commit `06f10db6f`.

---

## Bug 1 — IdentityChangedError displayed as "wallet does not support operation"

**Root cause:** `captureIdentity` in `AppContext.tsx` was snapshotting `wallet.capabilities`
(`WalletLegCapabilities`, keys: `l2HtlcFund`, `l2HtlcClaim`, …) at connect time.
`liveIdentity()` in `walletService.ts` calls `fetchCapabilities()` which returns raw
`TariWalletCapabilities` (keys: `transactionRequests`, `stealthWithdraw`).

`ACTION_CAPABILITY_KEYS = ['stealthWithdraw', 'transactionRequests']` — both keys exist on
the raw shape but neither exists on the mapped shape.  
Connect-time fingerprint: `transactionRequests=0` (key absent → 0).  
Execution-time fingerprint: `transactionRequests=1` (key present → 1).  
Mismatch → `IdentityChangedError`.

**Fix:** `AppContext.tsx` line 598 — changed `wallet.capabilities` → `wallet.walletCapabilities`
(the raw `TariWalletCapabilities`) and updated the dependency array accordingly.

**Evidence:** `window.__ssLastError` confirmed `IdentityChangedError` as the actual thrown error
before the fix. The mapped/raw capability shapes were confirmed by reading `tariWindow.ts`
(`mapLegCapabilities`) and `walletService.ts` (`liveIdentity`).

---

## Bug 2 — IdentityChangedError hidden behind WALLET_CAPABILITY_MISSING

**Root cause:** `SwapRoutesPage.tsx` error handler passed all errors through `normalizeError`,
which pattern-matches `/capabilit/i` on the message string.
`IdentityChangedError.message` contains "capabilities" → matched → code `WALLET_CAPABILITY_MISSING`
→ displayed as "The wallet does not support an operation this route requires."

**Fix:** `SwapRoutesPage.tsx` — added `IdentityChangedError` and `ReviewMismatchError` to the
import, added explicit `instanceof` handling before the generic fallback.
`SwapCard.tsx` already had the correct handler (`normalizeSubmissionFailure`).

---

## Bug 3 — "Swap unavailable" / min_output zero on SwapCard pool detail page

**Root cause:** The input field accepted only digits (no decimal point), so the user typed `3`
thinking 3 TESTA but the value was 3 base units = 0.000003 TESTA. AMM output ≈ 1–2 base units,
`min_output = floor(1 × 9990 / 10000) = 0` → `deriveMinOutput` throws "floors to zero".

**Fix:** `SwapCard.tsx` — renamed state `amountRaw` → `amountDisplay` (the decimal string the
user types). A `useMemo` derives the exact raw base-unit string via `parseDecimalToRaw(amountDisplay,
Number(from.decimals))`. Mid-typing states (e.g. `"1."`) parse as `undefined`, suppressing the
quote without an error. The input field uses `inputMode="decimal"` and allows `.` characters.

**Type fix:** `from.decimals` is typed as `string` on `AssetChip`; wrapped with `Number()` before
passing to `parseDecimalToRaw`.

---

## Build result

```
pnpm --filter @tari-ootle/web build  → ✓ built in 26.74s (TypeScript + Vite)
```

No TypeScript errors. No runtime errors on home, /swap, /pools pages in the in-app browser.

---

## What was not tested

- Live swap submission through Sapient v0.8.0 (requires the user's Chrome + Sapient extension).
  The fix is structurally correct — both identity snapshots now use the same capability shape —
  but the final verification requires a real wallet connection.
- Playwright automated campaign phases 2–6 (failure mocks, regression suites, stability run).
  These require the CDP harness and Chrome 156, which are outside the in-app browser.

## Manual verification step for user

1. Open `http://localhost:4173/pools/component_5c...` in Chrome with Sapient connected.
2. Type `3` in the "From" amount field — the quote should resolve (3 TESTA, not 3 microTESTA).
3. Click Swap — should NOT show "wallet does not support operation"; either prompts wallet or shows
   the correct IdentityChangedError message if fingerprint still differs.
