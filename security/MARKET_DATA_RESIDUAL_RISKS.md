# Market-data residual risks

Companion to `CROSS_LAYER_RESIDUAL_RISKS.md` and `MULTIHOP_RESIDUAL_RISKS.md`.
Market data is **informational only**; every risk here can cause wrong, missing, or delayed
*display*, and none can move funds.

| # | Risk | Class | Why it is still open | What retires it |
|---|---|---|---|---|
| MDR-1 | **No consensus timestamp exists in the indexer API.** Wall-clock candles at 1m/5m/15m are therefore reported UNSUPPORTED rather than fabricated; only epoch-resolution buckets (and intervals at or above the epoch cadence) are produced. | EXTERNAL_RISK (upstream) | The `events` table has an indexer-local `created_at` that the GraphQL type does not expose, and it is not consensus time anyway. | An indexer field exposing the committed block/transaction time, or a chain-derived per-epoch timestamp. |
| MDR-2 | **Our pool template emits no events.** Event-sourced indexing finds nothing for our own pool, so trades must be sourced from the execution layer or authoritative substate diffing. | BLOCKED_EXTERNAL | A template change is required. | Emit a swap event (topic + input/output resources and amounts) from `templates/fungible_pool`, which also makes third-party indexing possible. |
| MDR-3 | **No reorg/unfinalize signal.** Append-only indexing is not reorg-proof; a reverted trade stays until something calls `invalidate`. | BLOCKED_EXTERNAL | The indexer exposes `TransactionFinalized` but no reversion event and no reorg depth query. | An unfinalize/reorg API in the indexer, or periodic authoritative re-verification of recent trades (planned but not built). |
| MDR-4 | **Trade discovery is currently limited to a verified single-pool path.** The indexer refuses to record anything without an authoritative readback for that pool, so a multi-pool deployment needs a readback per pool. | Accepted risk (documented) | Deliberate: an unverified chart is worse than an incomplete one. | A multi-pool authoritative readback plus per-pool pairing configuration. |
| MDR-5 | **The in-memory store is not durable.** Cursors, trades, and candles live in process; a restart loses market data until a backfill re-runs (which is safe, because ingestion is idempotent). | Accepted risk (documented) | `MarketDataStore` is an interface with an in-memory implementation. | An application-owned persistent implementation following existing project conventions; no heavy database was added. |
| MDR-6 | **`TradeObservation.traderIdentity` is caller-supplied.** It is optional and included only if a producer asserts a genuinely public identity. | EXTERNAL_RISK (LOW) | Nothing verifies publicity. | A policy that only accepts identities that the chain itself exposes, or dropping the field entirely. |
| MDR-7 | **LP fee totals are derived from the trade input and `fee_bps`,** which is exact for the traced AMM semantics but assumes the fee is always charged on the input. | Accepted risk (documented) | Matches `quoteSwapOutput` in `src/amm.ts`. | Re-derive from an authoritative fee field if the template ever changes where the fee is taken. |
| MDR-8 | **`intervalSupport` decides wall-clock eligibility from a declared time source.** A producer that mislabels `LOCAL_RECEIPT` as `CONSENSUS_TIMESTAMP` would enable fabricated precision. | Accepted risk (documented) | The label is a contract on the producer. | Producers must construct `TradeTime` from the actual source; the type is a string union, not a branded token. |
| MDR-9 | **Cross-pool and cross-pair contamination is prevented by configuration, not by a global registry.** Two indexes for the same pool component with different pairs would each accept their own trades. | Accepted risk (documented) | A registry keyed by pool component would be needed. | A process-level pool registry that refuses duplicate pool components. |
| MDR-10 | **Backfill cursor semantics assume the discovery source's `nextAfterId` is stable.** A source that returns a non-monotonic cursor could re-read or skip rows. | Accepted risk (documented) | Ingestion is idempotent, so re-reads are harmless; skips are detected by a low row count per page. | A source contract guaranteeing monotonic ids (the real `TransactionEvent.id` is an autoincrement). |
| MDR-11 | **Metrics windows are expressed in the trade time domain** (epoch keys), so a "24h" window is only as meaningful as the epoch cadence the caller supplies. | Accepted risk (documented) | Deliberate: no wall-clock claim without a clock. | A consensus clock (MDR-1). |

## Explicitly NOT claimed

- Not real-time-accurate, not reorg-safe, and not a substitute for an authoritative read.
- Market data can be wrong, stale, or absent. It can never set an execution amount, a
  `min_output`, a resource, a settlement proof, or trigger a hop — enforced by module
  boundaries and covered by `test/marketdata_hostile.test.cjs`.
