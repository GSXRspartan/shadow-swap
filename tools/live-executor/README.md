# live-executor — guarded Esmeralda testnet AMM executor

A small, reviewed developer tool that executes the Liquidity Protocol's AMM
lifecycle against a **local** Tari Ootle wallet daemon on the **Esmeralda
testnet**, by submitting human-readable Tari **manifests** through the daemon's
documented `transactions.submit_manifest` JSON-RPC.

## Why this is the supported, safe submission path

The wallet daemon parses the manifest, selects inputs, pays fees from its own
default account, and **signs with the account owner key that it holds**. This tool
therefore:

- **never sees, derives, exports or reconstructs a private key**, and never
  hand-encodes instructions or forges a signature — all crypto stays in the
  daemon's normal signing path (this is the "delegate to walletd" model, not a raw
  ad-hoc publisher);
- **only ever talks to a loopback daemon** (`127.0.0.1` / `::1` / `localhost`) — a
  non-loopback URL is refused at construction;
- **verifies network identity** (`esmeralda`, network byte `38`) before building a
  transaction, and refuses anything mainnet-shaped;
- **dry-runs every state-changing op first** for an authoritative fee estimate,
  enforces a per-transaction fee ceiling (hard max 5 tTARI), then submits **once**;
- **records every op to a durable append-only ledger** (`live-op-ledger.jsonl`)
  before trusting the result, so an interrupted run is reconciled, never
  blind-retried.

Testnet only. No mainnet. No L1 burns. No cross-chain.

## Published templates used

- Public fungible test coins: `TestCoinFactory` (published on Esmeralda,
  `template_93aa539e…`) — `create_public_fungible_test_coin(symbol, div, supply)`.
- AMM pool: this repository's `Pool` template (`template_ef2bc1b0…`).

## Commands

```bash
node cli.mjs account
node cli.mjs create-token  LPTESTA --supply 1000000000 --div 6
node cli.mjs create-pool   --a <resA> --b <resB> --fee-bps 30
node cli.mjs add-liquidity --pool <c> --res-a <r> --amt-a N --res-b <r> --amt-b N
node cli.mjs swap          --pool <c> --in <res> --amt N --out <res> --min-out N
node cli.mjs remove-liquidity --pool <c> --lp <res> --amt N
node cli.mjs read-pool     --pool <c> --json
```

Global flags: `--max-fee <micro>` (≤ 5_000_000), `--dry-run` (estimate only, no
state change), `--url <loopback>`, `--json`.

All amounts are **raw integer units** (the test coins and tTARI use divisibility
6, so 1 token = 1_000_000 units). Nothing here uses floating point.

## Files

| File | Purpose |
|---|---|
| `walletd.mjs` | Core client: auth, network preflight, dry-run + submit + reconcile, guards. |
| `ledger.mjs` | Durable append-only JSONL operation ledger. |
| `cli.mjs` | Reviewed command surface over the core. |
| `walletd.test.mjs` | Unit tests for the guards and the v0.43 result parser. |
| `live-op-ledger.jsonl` | The record of the live vertical-slice run (evidence). |

## Tests

```bash
node --test ./walletd.test.mjs
```

The authoritative live evidence (addresses, transaction ids, fees, verified
invariants) is in `docs/ESMERALDA_LIVE_VERTICAL_SLICE_REPORT.md`.
