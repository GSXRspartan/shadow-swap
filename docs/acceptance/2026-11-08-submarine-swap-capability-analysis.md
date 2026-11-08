# Submarine Swap Capability Analysis — 2026-11-08

## Question answered

> Can our existing Tari Universe Web and Sapient wallet integrations complete both sides of an
> Esmeralda tXTM ↔ tTARI atomic swap, including independent claims and refunds?

**Short answer: No — neither wallet alone covers both legs. Together they can.**

---

## Capability matrix (read from source, not assumed)

| Surface | L1_FUND | L1_CLAIM | L1_REFUND | L2_FUND | L2_CLAIM | L2_REFUND | L1_READ | L2_READ |
|---------|---------|----------|-----------|---------|----------|-----------|---------|---------|
| **SAPIENT** | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ |
| **LOCAL_WALLETD_GRPC** | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| **UNIVERSE_CONNECTOR** | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **UNIVERSE_TAPPLET** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |

Sources: `packages/protocol-client/src/crossLayer/walletCapabilities.ts`

---

## Why no single wallet covers both legs

### Sapient v0.8.0
- L2 only. Its `tari_createTransactionRequest` / `tari_submitTransactionRequest` methods carry Ootle
  L2 instruction lists and can call the `CrossLayerHtlc::fund`, `::claim`, `::refund` template methods.
- Has no Minotari L1 surface. It cannot build, sign or submit a Minotari `sha_atomic_swap`
  TariScript output.

### Tari Universe Web (`UNIVERSE_CONNECTOR`)
- Same 13-method dApp API as Sapient, so it covers the same L2 operations.
- Adds `L1_READ` (can read Minotari state via its embedded wallet layer).
- Still cannot build an L1 HTLC: its transaction-request API is Ootle instruction lists only;
  a custom TariScript cannot be expressed through it.
- Also requires HTTPS — cannot be used at `http://localhost`.

### Tari Universe Web (`UNIVERSE_TAPPLET` path)
- The in-app Tapplet channel only allows plain sends; it cannot call a template method on L2 and
  cannot build a custom TariScript on L1. Only usable for reads.

### LOCAL_WALLETD_GRPC (Minotari walletd / console wallet)
- The only surface that builds the L1 HTLC output via
  `SendShaAtomicSwapTransaction` / `ClaimShaAtomicSwapTransaction` / `ClaimHtlcRefundTransaction`.
- Has no Ootle L2 surface at all.

---

## Two-layer pairing that DOES work

| Direction | L1 leg signer | L2 leg signer | L1 READ | L2 READ |
|-----------|--------------|---------------|---------|---------|
| L2_TO_L1 | LOCAL_WALLETD_GRPC (maker) | SAPIENT (user) | GRPC | SAPIENT |
| L1_TO_L2 | LOCAL_WALLETD_GRPC (user) | SAPIENT (maker) | GRPC | SAPIENT |

This pair satisfies all 8 required operations. `LOCAL_WALLETD_GRPC` needs a Minotari
wallet running locally with gRPC enabled — `--grpc-address 127.0.0.1:18142`.

---

## Current blockers (as of 2026-11-08)

### Blocker 1: CrossLayerHtlc template NOT published on `esmeralda@v049`

`protocolDeployment.ts:ESMERALDA_V049.crossLayerHtlcTemplates` is `[]`.

The template source exists at `templates/cross_layer_htlc/src/lib.rs` and is correct. It needs
to be compiled to WASM and published via the walletd web UI.

**Commands for the user (PowerShell from the repo root):**

```powershell
cd templates\cross_layer_htlc
rustup target add wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release
```

WASM output: `target\wasm32-unknown-unknown\release\cross_layer_htlc.wasm`

Then open `http://127.0.0.1:5100` → Publish template → upload the WASM.
Record the returned template address in `protocolDeployment.ts:ESMERALDA_V049.crossLayerHtlcTemplates`.

### Blocker 2: No L1 Minotari wallet connected

The `/market` page shows "Local Minotari wallet: Not connected". Start the Minotari console
wallet with gRPC enabled:

```powershell
tari_console_wallet --grpc-address 127.0.0.1:18142
```

The app connects to it at `http://127.0.0.1:18142` for L1 operations. No L1 operations are
possible until this is running.

### Blocker 3: `crossLayerAvailability` returns NOT_RECORDED

After publishing, the UI's `/market` page will continue showing "Not available" until the
template address is added to `protocolDeployment.ts`. That is a one-line code change.

---

## What can be tested TODAY (L2-only, with Sapient)

Once the CrossLayerHtlc template is published:

1. **L2 HTLC fund (dry_run)**: Build a `CallFunction(CrossLayerHtlc::fund, ...)` transaction with
   a fake hash lock and far-future epoch. Use walletd `transactions.dry_run`. This proves the L2
   escrow instruction builds correctly.

2. **L2 HTLC claim (dry_run)**: Call `::claim` on a funded component with the correct preimage.
   Verifies the hash check logic.

3. **L2 HTLC refund (dry_run)**: Call `::refund` after expiry. For testing, fund with
   `expires_at_epoch = current_epoch + 1`, wait for epoch advance, then dry_run the refund. This
   proves the strict-abutment property (no race between claim and refund).

A test harness script (`walletd-htlc-dry-run.ps1`) can exercise all three paths once the
template address is known.

---

## What UNIVERSE_CONNECTOR adds over Sapient for submarine swaps

- `L1_READ`: Universe's embedded wallet can read Minotari L1 state (UTXO set, HTLC outputs). This
  means a user on Universe does NOT need a local Minotari wallet to verify that the maker's L1
  leg is properly funded before locking their L2 funds.
- For the L2 leg: identical to Sapient.
- Still cannot sign L1 HTLC fund/claim/refund — that remains LOCAL_WALLETD_GRPC only.

**Summary**: Universe Connector reduces the barrier for the TAKER (they need no local wallet to
verify L1 state before funding L2), but the MAKER still needs LOCAL_WALLETD_GRPC to build the
L1 HTLC output. For a fully noncustodial swap, this means at least one party always needs a
locally running Minotari wallet.

---

## Shortest viable implementation path to real swap

1. User compiles and publishes `CrossLayerHtlc` template via walletd web UI
2. Record template address in `protocolDeployment.ts`
3. Build L2 HTLC dry_run test (this codebase can do this now once template is published)
4. User starts `tari_console_wallet --grpc-address 127.0.0.1:18142`
5. Full L2→L1 swap with real amounts: maker funds L1, user (Sapient) funds L2, maker claims L2
   (revealing preimage), user claims L1 with preimage

Steps 1–3 can be done without an L1 wallet. Steps 4–5 require the Minotari console wallet.

---

## Engine test status

Engine tests exist: `audit_engine_tests/tests/cross_layer_htlc.rs` (h01–h09).
These run against the template binary and cover: fund, claim (correct/wrong preimage), refund
(before/after epoch), expired claim, double-spend prevention.

**These tests do NOT require a live network or a published template.** They run offline via
`tari_template_test_tooling`. They can be run now:

```powershell
cd audit_engine_tests
cargo test cross_layer_htlc
```
