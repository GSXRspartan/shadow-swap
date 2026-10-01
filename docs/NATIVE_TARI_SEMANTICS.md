# NATIVE TARI SEMANTICS IN AMM

Source reference: upstream tari-ootle **tag `v0.42.0`**, commit
`a43773e600b9503ed3fadcd3f0048f86131e3644`
Workspace version: `0.42.0`

> Re-verified 2026-10-01 against the v0.42.0 tag **and** against live post-reset
> Esmeralda. The token's identity did **not** change across the reset — only the node
> software was upgraded. `docs/LIVE_TESTNET_EVIDENCE.md` §0.3 records the live read.

## Exact upstream constant
File: `crates/template_lib_types/src/constants.rs`
```
pub const STEALTH_TARI_RESOURCE_ADDRESS: ResourceAddress =
    ResourceAddress::new(ObjectKey::from_array([1u8; ObjectKey::LENGTH]));

/// Shorthand version of the `STEALTH_TARI_RESOURCE_ADDRESS` constant
pub const TARI_TOKEN: ResourceAddress = STEALTH_TARI_RESOURCE_ADDRESS;
#[deprecated(since = "0.24.5", note = "Use TARI_TOKEN instead")]
pub const XTR: ResourceAddress = STEALTH_TARI_RESOURCE_ADDRESS;
```
Which resolves to the literal address:
```
resource_0101010101010101010101010101010101010101010101010101010101010101
```
Divisibility: 6 (from `constants.rs` comment: "divisibility of 6, meaning smallest unit is 0.000001 TARI").
Unit definition: `pub const TARI: u64 = 1_000_000;` (1 TARI = 1,000,000 micro-tari).

### Live confirmation (2026-10-01, post-reset Esmeralda)

`GET https://ootle-indexer-a.tari.com/resources/tari`:

| Property | Value |
| --- | --- |
| `resource_type` | **`Stealth`** |
| `metadata.SYMBOL` | `tTARI` |
| `divisibility` | `6` |
| `owner_rule` | `None` |
| access rules | `mint`/`burn`/`recall`/`freeze` = `DenyAll`; `withdraw`/`deposit` = `AllowAll` |
| `version` | `0` (post-reset genesis state) |

### Identity rule

Canonical TARI is bound to the **ADDRESS**, never to the ticker. `tTARI` is a
symbol and `XTR` is a deprecated alias; neither is an identity, because any
issuer can print `tTARI` on a worthless token. `apps/web/src/services/ootleIndexer.ts`
pins `CANONICAL_TARI_RESOURCE` to the exact address and
`apps/web/test/ootleV042Contract.test.cjs` asserts that a symbol lookalike never
classifies as canonical.

## Resource type
Native Tari is a `ResourceType::Stealth` (per `resource_type.rs` and TariSwap validation). The TariSwap template accepts `Stealth` through:
```
assert!(
    matches!(
        resource_type,
        ResourceType::Fungible | ResourceType::Confidential | ResourceType::Stealth
    ),
    "Resource {} is not fungible",
    resource
);
```
Our `fungible_pool/src/lib.rs` uses the same `matches!()` pattern.

## Privacy boundary (critical)
Native Tari wallet balances are stealth (hidden) before interaction with the pool. The wallet must construct a valid stealth/revealed withdrawal statement (`StealthTransferStatement` / `StealthWithdrawProof`) before depositing Tari into the pool component. The component itself does NOT handle stealth cryptography; it only sees revealed `Bucket` amounts.

Therefore:
- Tari wallet balance: PRIVATE (stealth UTXOs)
- Pool component reserve: PUBLIC (revealed amount in vault)
- AMM price/reserve data: PUBLIC (any observer can read vault balances)
- Withdrawal output: PUBLIC amount returned to wallet; wallet may optionally shield it again through separate wallet mechanisms

This is the correct architectural boundary. The AMM component should NEVER claim to maintain confidential reserves. Any claim that the AMM itself is "confidential" is false.

Documented in `docs/STEALTH_ASSET_DESIGN.md`.
