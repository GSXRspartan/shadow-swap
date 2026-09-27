# UPSTREAM BASELINE

Inspected on: 2026-09-22 (L2 entries); 2026-09-25 (L1 Minotari pin and SHA trace)

## Minotari L1 (`tari-project/tari`) — SOURCE OF TRUTH FOR THE SHA ATOMIC SWAP
- Repository: https://github.com/tari-project/tari
- Local checkout: `C:\tmp-tari-l1` (pinned, used for all SHA swap tracing)
- Tag: `v6.0.0` (workspace version 6.0.0)
- Commit: `97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3` — "chore: v6.0.0 release"
- Wallet inspected: `minotari_console_wallet` (gRPC + automation commands)
- Network targeted: Esmeralda (testnet only; mainnet refused in our provider)
- Why we use: the ONLY real L1 SHA atomic-swap primitive available
  (`TransactionService::send_sha_atomic_swap_transaction`,
  `OutputManagerService::create_claim_sha_atomic_swap_transaction`,
  `create_htlc_refund_transaction`) and the base-node wallet RPC used for authoritative
  readback
- Key traced facts (full detail in `docs/MINOTARI_ATOMIC_SWAP_API.md`):
  wallet generates `S` = 32-byte compressed Ristretto point, `H = SHA256(S)` with no
  domain separation, script
  `HashSha256 PushHash(H) Equal IfThen PushPubKey(claimant) Else CheckHeightVerify(tip+720) PushPubKey(sender) EndIf`,
  refund key is the funding wallet's own spend key, refund height hardcoded to tip+720,
  amounts are u64 microMinotari, the value lives in a blinded commitment
- Risks/limitations:
  - No caller control over `S`/`H`/refund key/refund height — the wallet API cannot express
    our coordinator's intent, so those intent fields are expectations verified by readback
  - The funded amount is not independently provable from base-node evidence (blinded
    commitment); our provider reports `amountAuthoritative: false` rather than guessing
  - Claim requires the preimage to be a canonical valid Ristretto point encoding
  - WASM bindings (`tari_l1_wasm`) do NOT expose the SHA swap; only the console wallet does
    → browser path is blocked upstream (see `docs/TARI_BROWSER_SHA_SWAP_UPSTREAM_PLAN.md`)

## tari-ootle (core L2 protocol)
- Repository: https://github.com/tari-project/tari-ootle
- Local checkout: `C:\tmp-tari` (pinned, used for SHA256 interop verification)
- Branch: development
- Latest inspected commit: `2d6083e6cc7c98cde93dacebe2fb76b17703f588` (workspace 0.41.1)
- Date inspected: 2026-09-25
- License: BSD-3-Clause
- Why we use: Source of the stealth hashlock semantics our L2 HTLC leg relies on
  (`crates/engine_types/src/stealth/hashlock.rs` — plain SHA-256, deliberately
  domain-separation-free for cross-chain interop, NIST "abc" vector tested), the
  `PayTo::Conditions` two-leaf (hashlock + AfterEpoch) condition trees, and the WASM
  `build_script_path_witness` input builder
- Risks/limitations: Heavy development; TariSwap is in engine test templates, not production-grade library; access rules are `.with_access_rules(AccessRules::allow_all())` in the test template

## ootle-sdk-ts / @chironbuilder/ootle-sdk
- Repository: https://github.com/chironbuilds/ootle-sdk-ts
- Package: @chironbuilder/ootle-sdk
- Version inspected: 0.1.11 (npm, published 6 days before inspection)
- Commit/reference: master branch, 16 commits total
- License: MIT
- Why we use: Shared TypeScript wallet SDK extracted from Sapient and Tari L1 web wallet; provides account derivation, balances, transaction building, storage abstraction
- Risks/limitations: Explicitly EARLY 0.x; README states "not yet wired back" into consuming wallets; vendors two patches (`@tari-project/ootle` serialization gap, `@tari-project/ootle-wasm` confidential withdraw proof); treat as experimental

## tari-cli
- Repository: https://github.com/tari-project/tari-cli
- Branch: main
- Latest commit: 120 commits on main
- License: BSD-3-Clause
- Why we use: Template development, WASM build, publish reference
- Risks/limitations: Template CLI is evolving; requires wallet daemon API key for publish

## stable-coin
- Repository: https://github.com/tari-project/stable-coin
- Branch: main
- Latest commit: 92 commits on main
- License: BSD 3-Clause
- Why we use: Confidential/stablecoin template reference; shows admin controls (pause, freeze, recall) we must avoid in public AMM
- Risks/limitations: Admin-controlled templates must NOT be used for permissionless liquidity; our protocol must be admin-free

## TariSwap Reference (inside tari-ootle)
- Paths:
  - crates/engine/tests/templates/tariswap/src/lib.rs
  - crates/engine/tests/templates/tariswap/Cargo.toml
  - crates/engine/tests/tariswap.rs
  - utilities/tariswap_test_bench/src/tariswap.rs
- License: BSD-3-Clause (same repo)
- Why we reference: Constant-product AMM with fee as per-mil (0..100 = 0%..10%), vault-based reserves, public fungible resource pair checks, LP token mint/burn via ResourceManager
- Risks/limitations:
  - Fee uses integer division by 1000: `amount - (amount * fee) / 1000` — this rounds DOWN in favor of the protocol/LP, not the trader (acceptable for fee collection but must be documented)
  - `check_resource_is_fungible` allows `ResourceType::Fungible | ResourceType::Confidential | ResourceType::Stealth` — but the AMM logic does not handle stealth/confidential math correctly without additional privacy leakage modeling
  - `AccessRules::allow_all()` is a placeholder; production pools need explicit rules
  - `new_lp_amount = a_ratio * a_amount + b_ratio * b_amount` uses ratios derived from pool balance; vulnerable to first-deposit ratio manipulation if initial liquidity is tiny
  - `remove_liquidity` uses `.div_ceil()` which can over-round; must verify no reserve drain over repeated operations
  - No minimum liquidity lock; first depositor can take full share and then manipulate ratios
  - `lp_total_supply()` reads from `ResourceManager::get(resource).total_supply()`; this is safe if mint/burn are restricted

## Sapient Wallet
- Source reference: https://github.com/chironbuilds/tari-wallet (referenced in SDK docs; not copied into this repo)
- License: PolyForm Noncommercial (per SDK docs: "The two wallets this was extracted from are licensed separately, under PolyForm Noncommercial")
- Action taken: NOT copied into this repo. Only adapter interface is implemented here; actual integration requires separate license review
