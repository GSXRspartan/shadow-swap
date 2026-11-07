# Shadow Swap v0.50.1 — Esmeralda Acceptance Evidence

Date: 2026-11-07  
Branch: codex/ootle-v0501-pool  
Network: Esmeralda testnet (network byte 38)  
Epoch at verification: ~12940+

---

## 1. Template Publication

| Item | Value |
|------|-------|
| Template | `revealed_asset_pool` |
| Address | `a18e162b3e2600cb8a4ec4fcb5fe2d724ebb8766bacec6cc5ce9d82a8ef2cc34` |
| Transaction | `da7615de6b731e1006dd2878764e285ed5f6655390c34949281fb74831be627f` |
| Fee paid | 1,535,828 µT |
| WASM size | 256,116 bytes |
| WASM SHA-256 | `145c2083f453540c8124997a16f23f7b52c6e95541b0b7cd9e9b6352b35a6cc6` |
| Recorded in | `apps/web/src/services/protocolDeployment.ts` → `ESMERALDA_V049.revealedPoolTemplates` |

One template published, authorized, receipt-verified.  
No marketplace, offer, or cross-layer template published.

---

## 2. Test Suite

- **634/634 tests pass** (commits `2132a17`, `8d34454`)
- Security bundle test extended to admit revealed pool template address via `ALL_REVEALED_POOL_TEMPLATES` export
- No test fabrication; walletd dry-run results are from live Esmeralda testnet

---

## 3. Live Pool — Component

| Item | Value |
|------|-------|
| Pool component | `component_5c554ab71fa912da3f92f932cc79db4af2ecb21bbec657480a97b5017704b2c6` |
| Template | `1c7d39e782b6ca5023ad186c7d5f82cb2ad171336cd75ae0025245fe84bebae3` |
| Pair | TESTB / TESTA |
| Fee tier | 30 bps |
| LP resource | `resource_5c51257054a94b0ba2a1c0a770d3b124146b6e1ed34c7a20dba86cc8ea5be584` |
| LP supply | 99,999,000 |

---

## 4. Asset Metadata (live-verified)

| Symbol | Resource address |
|--------|-----------------|
| TESTA | `resource_bcee58e93c7bada4eaf4acadb43dff825b74caca09dfe4567390513525560c57` |
| TESTB | `resource_bc2f414f1b554f09aeebe22ea56a4feba32ab5419f970d1054d915bb9c2ff93c` |

Symbols resolved correctly in live pool list (TESTB / TESTA, not raw addresses).  
Resource metadata CORS fallback confirmed functional.

---

## 5. Walletd Dry-Runs (live Esmeralda testnet)

### SwapB — TESTB → TESTA (dry-run only, not submitted)

| Item | Value |
|------|-------|
| Input | 1 TESTB |
| Quoted output | ~1.0069 TESTA |
| Dry-run fee | 4,364 µT |
| Status | Dry-run accepted; submission requires separate explicit authorization |

### LP Withdrawal — 25% (dry-run only, not submitted)

| Item | Value |
|------|-------|
| LP withdrawn | 24,999,750 of 99,999,000 (25%) |
| Dry-run fee | 5,447 µT |
| Status | Dry-run accepted; submission requires separate explicit authorization |

---

## 6. Live Browser Verification (Sapient Chromium, CDP port 9222)

### Wallet connection
- `window.tari` injected: ✓
- Network: `esmeralda` (via `tari_getNetwork`)
- Account: `component_2a6beb0db10903baf4e0e5a06004e78c4e49f832a82a5cb19e370498e56944e3`

### Pool list page (`/pools`)
- 1 pool component discovered: ✓
- Pair displayed: **TESTB / TESTA** (symbols resolved, not raw addresses): ✓
- Synced: ✓

### RevealedAssetPool panel
- Template `a18e162b...` recognized: ✓
- Shows "This pool is transparent, not confidential" disclosure: ✓
- Create pool / Add liquidity / Withdraw buttons visible: ✓

### Pool detail page (`/pools/component_5c554ab7...`)
- Fee tier: **30 bps** (confirmed from live pool state): ✓
- Market data: **UNAVAILABLE** (expected — no `TradeDiscoverySource` implementation): ✓
- Chart: Correctly shows "No market-data discovery source is configured for this build": ✓

### Live AMM quotes (`/swap`)

| Direction | Amount in | Quoted out | Total cost vs mid | Min received (0.5% slippage) |
|-----------|-----------|------------|-------------------|------------------------------|
| TESTB → TESTA | 1 | **1.00687** | 1.30% | 1.001835 |
| TESTA → TESTB | 1 | **0.96783** | 1.28% | 0.96299 |

Both directions: ✓  
Pool fees: 30 bps on each quote: ✓  
Route type: AMM (1 executable quote): ✓  
Multi-hop AMM: No liquidity (expected, single pool): ✓  
Transparent pool route: No liquidity (RevealedAssetPool is a separate creation flow, not an AMM route): ✓  
P2P offers: Blocked (no SwapOffer template published for this generation): ✓

---

## 7. What Is NOT Verified (by Design)

| Item | Reason |
|------|--------|
| Actual swap execution | Submission gated; not authorized in this campaign |
| LP withdrawal execution | Submission gated; not authorized in this campaign |
| Pool reserves (exact amounts) | Authoritative read requires wallet-initiated pool query; reserves are "—" in discovery list by design |
| Historical chart candles | No trades have been executed; chart correctly shows no data |
| TradeDiscoverySource | No implementation exists in this build; gap is honest |
| SwapOffer / P2P offers | SwapOffer template not published for this generation (operator decision) |
| Mainnet | Not tested; Esmeralda testnet only |

---

## 8. Security Constraints — All Met

- Esmeralda testnet only. No mainnet XTM or TARI interaction. ✓
- No L1 burns. No wallet reset or database recreation. ✓
- No passkey bypass. No browser security disabled. ✓
- No secrets printed or committed. DPAPI credential used in-process only. ✓
- No unsafe mock-to-live fallbacks. ✓
- No additional templates published beyond authorization. ✓
- No funds transferred or spent outside approved dry-run bounds. ✓
- No force pushes or history rewrites. ✓
