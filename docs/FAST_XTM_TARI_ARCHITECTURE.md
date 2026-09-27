# FAST_XTM↔TARI cross-layer route — architecture

Status: **EXPERIMENTAL / TESTNET.** This phase IMPLEMENTS the route architecture; a dedicated
hostile cross-layer security audit follows. Do not read this as a certification of atomicity.

## Route

```text
XTM (Minotari L1, testnet tXTM)  ↔  TARI (Ootle L2, Esmeralda)
provider-backed, noncustodial, atomic via shared SHA-256 hashlock
```

## Components

| Component | Path | Role |
|---|---|---|
| Route kind | `packages/protocol-client/src/crosschain/` (`FAST_XTM_TARI`) | single-hop route; later composes: XTM → FAST_XTM_TARI → TARI → AMM → wSTABLE |
| Quotes | `crosschain/quote.ts` | provider advertisement + immutable bound quote (BigInt only; spread ≠ developer fee; developer rake = 0) |
| Reservations | `crosschain/reservation.ts` | race-checked inventory (AVAILABLE/RESERVED/FUNDED/RELEASE_PENDING/RELEASED); quote expiry never releases FUNDED inventory |
| Secrets | `crosschain/secret.ts` | `CrossChainSecretStore`: S never serialized into history/JSON/URLs/telemetry; reveal requires CLAIM_ARMED; verifyPreimage(S,H) before any use |
| Deadlines | `crosschain/deadlines.ts` | asymmetric-margin derivation in SEPARATE domains (L1 height vs L2 epoch, never compared); safety recheck before every irreversible phase |
| Sessions | `crosschain/session.ts` | durable state machine, explicit transition table, no arbitrary jumps; terminal states terminal |
| Provider ports | `crosschain/provider.ts` | `MinotariWalletProvider` (L1) + `OotleScriptPathLegPort` (L2); layers CONSTRUCT/SIGN/SUBMIT/OBSERVE/CLAIM/REFUND/RECONCILE kept separate; no opaque `swap()` |
| Coordinator | `crosschain/coordinator.ts` | orchestration, REAL-SUBMIT GATE (default OFF), UNKNOWN reconciliation, restart recovery |

## Hashlock interop (verified in source)

- L2: Ootle engine `engine_types/src/stealth/hashlock.rs` hashes the preimage with **no
  domain separation** (`HashAlg::Sha256`) explicitly so hashlocks interoperate with external
  chains byte-for-byte (NIST SHA-256("abc") test).
- L2 browser provider (`window.tari` — Sapient-shaped dApp API): `htlcFund`
  (`hashLockHex`, `refundEpoch`), `htlcClaim` (`preimageHex`), `htlcRefund`
  (`outputMask`/`conditions`), `tari_getSubstate` (authoritative readback),
  `tari_getCapabilities` (feature detection).
- L1: `minotari_console_wallet` SHA atomic-swap commands (init/finalise/claim-refund) —
  implementation trace PENDING (docs/MINOTARI_ATOMIC_SWAP_API.md); the L1 adapter refuses
  real submission until `primitivesStatus() === 'VERIFIED'`.

## Funding order & asymmetric deadlines

1. Taker funds L1 (XTM HTLC) first; provider verifies AUTHORITATIVELY (exact hash H, exact
   amount, claim conditions, refund height, network, confirmations).
2. Provider funds L2 (TARI hashlock) only then.
3. CLAIM_ARMED gates any secret disclosure: both legs verified + deadlines safe + claim
   constructible.
4. First-funded leg (L1) carries the LATER refund deadline; the margin is derived
   explicitly (`deadline.ts`), never "+10 blocks".

## Providers (custody stays with wallets)

Provider advertisements (per-provider inventories, no pooled custodial vault), signed/bound
quotes with a provider-authentication seam (no invented signature scheme), durable
reservations with inventory-race protection.

## Providers (wallet transport)

```text
MinotariAdapter
├── TariBrowserProvider → window.tari (Sapient-shaped)   L2 leg READY; L1 swap PENDING upstream
└── LocalGrpcProvider   → development/test harness only (walletd/consoleWallet)
```

Production users never need walletd/console-wallet/PowerShell (see
docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md for the exact browser gap on the L1 leg).

## Security & docs

- `security/CROSS_LAYER_THREAT_MODEL.md`, `CROSS_LAYER_INVARIANTS.md`,
  `CROSS_LAYER_TEST_MATRIX.md` (written in the audit phase; the coordinator + state machine
  are built to the invariants stated there).
- Unknown handling: every fund/claim/refund timeout → UNKNOWN (never FAILED) → reconcile by
  durable ids (`TransactionLookup`) before any resubmission (reuses execution-layer policy).
- Restart recovery: load sessions → query BOTH chains → decide CONTINUE/ARM/CLAIM/
  WAIT_OR_REFUND/RECONCILE — never trust pre-crash state alone.
- Quote expiry governs only UNFUNDED reservations; funded sessions live by chain deadlines.
- Price movement cannot alter an accepted funded session (amounts/hash/recipients/deadlines
  are immutable in the session record).