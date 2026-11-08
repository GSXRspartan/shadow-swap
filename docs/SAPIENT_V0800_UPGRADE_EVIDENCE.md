# Sapient v0.8.0 Upgrade — Acceptance Evidence

**Date:** 2026-11-08  
**Branch:** codex/ootle-v0501-pool  
**Network:** Esmeralda testnet (network byte 38)

## Upgrade Method

In-place file replacement of the unpacked extension directory. The existing extension was NOT removed or uninstalled. `chrome.storage.local` (wallet vault, account, connected sites) was untouched throughout.

- Script: `C:\Users\pdark\.tari\ootle\sapient-src-0800\scripts\patch-manifest-for-sideload.ps1`
- Source build: `sapient-src-0800/dist` (pnpm 11.9.0 + Vite production build from `ootle-0.50` branch commit b457e8f)
- Rollback backup: `C:\Users\pdark\.tari\ootle\sapient-autoload-0614.rollback-v0614` (638 files, 46.7 MB)
- Profile backup: `C:\Users\pdark\.tari\ootle\sapient-test-profile-v0492.backup-pre0800`

## Extension Identity

| Field | Value |
|-------|-------|
| Extension ID | `demkeckolenopkgnfbnpflkpbbdhpgkl` |
| RSA key (first 20 chars) | `MIIBIjANBgkqhkiG9w0B…` (392 chars, unchanged) |
| Version (pre-upgrade) | 0.6.14 |
| Version (post-upgrade) | **0.8.0** |
| `update_url` | removed (sideload safe) |

## Post-Upgrade Acceptance Checks

### Identity preserved
- `chrome.runtime.getManifest().version` → **"0.8.0"** (verified via CDP, 2026-11-08)
- Extension ID unchanged: `demkeckolenopkgnfbnpflkpbbdhpgkl`
- Wallet address unchanged: `otl_esm_1cgng8ep06xajw9pn95vz87m05qaqzkes29vsgjfp5n6y9mvcz4rjf2862rs4vpsun924j66spq8kdwgxcsu3rw3m79s88az74tph7vg9eja04`

### Balances (user-confirmed in Sapient popup, 2026-11-08)
- **10 TESTA** ✅
- **121 tTARI** ✅ (native stealth TARI; additional funds deposited since original test session)
- **2 NFTs** ✅ (sent from walletd during acceptance testing)

### Storage migration
- `migrateOotleStorageOnce()` runs on first service worker cold start
- Guarded by `ootleSdkStorageMigrationDone` key — idempotent, additive only
- Migrates: `shieldedOutputs`, `pendingShields`, `privatePaymentScanCursors`, `knownSubstateVersions` → ootle-sdk shape
- Does NOT delete old keys; does NOT touch `vault`, `accountCount`, `activeAccountId`, `connectedSites`

## New WASM Structure (v0.8.0 vs v0.6.14)

| v0.6.14 | v0.8.0 |
|---------|--------|
| `ootle_wasm_bg-B1X73Zl9.wasm` (1,297,711 B) | `ootle_wasm_bg-DuVXkqz3.wasm` (1,350,888 B) |
| `ootle_wasm_bg-CnEFbGVt.wasm` (1,284,881 B) | `ootle_wasm_bg-TPa1OW4k.wasm` (1,326,298 B) |
| `ootle_wasm_bg-ljEmjhtJ.wasm` (1,308,957 B) | `ootle_wasm_bor_bg-pNGCIMqe.wasm` (467,027 B) ← NEW BOR module |

The new `ootle_wasm_bor_bg` module is `@tari-project/ootle-wasm-bor` (Bulletproofs Or range proofs), introduced in ootle-sdk 0.50.1.

## CDP Verification (2026-11-08)

Connected via system Chrome 156.0.8078.80 (`--remote-debugging-port=9222`) with `sapient-test-profile-v0492`:

```
Browser: Chrome/156.0.8078.80
Extension popup: chrome-extension://demkeckolenopkgnfbnpflkpbbdhpgkl/popup.html
chrome.runtime.getManifest().version → "0.8.0"
```

Note: `tari_getCapabilities` returns "not running inside Tari Universe" in standard Chrome — this is expected; the provider API requires the Tari Universe desktop app context. Wallet balances and identity verified directly through the extension popup.

## Notes

- Playwright Chromium 1194 crashes (STATUS_BREAKPOINT, exit 0x80000003) with v0.8.0 loaded — root cause: likely DCHECK in older Chromium build conflicting with the new BOR WASM module or launch flag combination. System Chrome 156 is unaffected.
- Shadow Swap preview server running at http://localhost:4173 throughout upgrade.
