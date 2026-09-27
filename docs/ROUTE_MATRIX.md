# ROUTE SUPPORT MATRIX

Source of truth: `crates/protocol_types/src/lib.rs` (`initial_route_matrix()`)
UI must read from this source; never hardcode route status independently.

| Route Pair | Asset Types | Status | Fee Tier | Blocker / Note |
|------------|-------------|--------|----------|----------------|
| Public Fungible / Tari Native | Fungible / canonical Tari | EXPERIMENTAL | 30 bp (0.30%) | Public AMM boundary; canonical address only |
| Public Fungible / Public Fungible | Fungible / Fungible | Experimental | 30 bp (0.30%) | Standard AMM; tested with integer math; requires deployment |
| Public Fungible / wSTABLE | Public fungible / public fungible | EXPERIMENTAL | 30 bp (0.30%) | Existing AMM primitive; wrapper must be a reviewed `ISSUER_CONTROLLED_QUOTE_ASSET`; public market |
| Tari / wSTABLE | Canonical Tari / public fungible | EXPERIMENTAL | 30 bp (0.30%) | Existing AMM primitive; public market; wrapper remains issuer-controlled |
| Stealth Asset / Tari Native | Stealth / canonical Tari | BLOCKED | 30 bp (0.30%) | Requires a dedicated revealed-boundary adapter and real engine proof |
| Stealth Asset / wSTABLE | Stealth / public fungible | BLOCKED | 30 bp (0.30%) | Requires a dedicated revealed-boundary adapter and real engine proof |
| Private Stablecoin / Tari | Stealth private coin / canonical Tari | DESIGN_ONLY | 30 bp (0.30%) | Holder reveal into a same-resource bucket is source-proven; separate revealed-boundary adapter is not yet engine-proven |
| Private Stablecoin / Public Fungible | Stealth private coin / public fungible | DESIGN_ONLY | 30 bp (0.30%) | Same holder-controlled reveal boundary; issuer-controlled reserve risk must be tested |
| Private Stablecoin / wSTABLE | Stealth private coin / public wrapper | BLOCKED | N/A | Wrapper conversion is issuer-admin-gated and per-user limited; distinct from direct revealed-boundary trading |
| NFT Collection / Tari Native | Non-fungible / canonical Tari | BLOCKED | N/A | Requires separate NFT inventory design; no upstream pool exists |
| NFT Collection / wSTABLE | Non-fungible / public fungible | BLOCKED | N/A | Requires separate NFT inventory design and reviewed wrapper configuration |
| Generic Confidential / Tari | Confidential / canonical Tari | BLOCKED | N/A | Constant-product arithmetic cannot be claimed over hidden amounts |
| Generic Confidential / wSTABLE | Confidential / public fungible | BLOCKED | N/A | Constant-product arithmetic cannot be claimed over hidden amounts |

Status definitions:
- TESTED: Executed on testnet with verified results.
- EXPERIMENTAL: Functionally designed and partially verified; may require further testing.
- DESIGN_ONLY: Architecture documented; no executable path.
- BLOCKED: Missing upstream feature, unsafe today, or conflicts with security model.
- DISABLED: Not applicable or deprecated.

## Changing status
- A BLOCKED route must NOT become clickable just because a UI component exists.
- Status updates require:
  1. Implementation of template/code.
  2. Adversarial tests passing.
  3. Upstream blocker resolved (if applicable).
  4. Documentation updated (this file and protocol_types source).
  5. Feature gate removed explicitly.
