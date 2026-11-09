# Overnight engineering progress — Shadow Swap (2026-11-08)

Branch: `codex/ootle-v0501-pool`. Stacked on `ff465c6aa` → see `git log`.

## Active objective
Make the market-data layer honest AND visibly functional: own settled swaps are now
recorded as verified trade observations; the chart renders epoch-bucketed data as an
epoch-axis SVG line instead of an empty state. Web Tari Universe remains the primary
wallet target; Cloudflare/VPS deploy need operator credentials (approved gates).

## Completed (verified)
- `ff465c6aa` — `docs/UPSTREAM_L1_DAPP_BRIDGE.md` (8 new `tari_l1*` methods spec; upstream shape verified from live `tari-connector.js`).
- `3af115373` — `services/marketObservations.ts`:
  - `PrePoolSnapshot` persisted at swap submit (`ootle.prePool.v1`, 7-day pruning), consumed at reconcile.
  - `settledObservation()` pure synthesis from authoritative before/after reserve deltas (BigInt, direction-correct).
  - `attributesToOurSwap()` — strict attribution; contended pools record nothing.
  - `reconcile(record, lookup, settle)` — post-CONFIRMED: readback → attribute → validate → `bundle.ingest()`.
  - `SwapCard` saves the snapshot at submit (`pool.poolComponent`, before-pool, fee, freshness identity).
- `3af115373` — `components/EpochChart.tsx` (SVG: price line + volume bars, epoch-only honest axes; tooltip from exact `baseVolumeRaw`; uses protocol `toChartSeries` display boundary).
- `PoolPage` renders `EpochChart` when `chartTimeBasis(candles).kind === 'EPOCH_ONLY' && candles.length > 0`.
- Tests: `apps/web/test/market-observations.test.cjs` — 6/6 pass. `apps/web/test/epoch-chart.test.cjs` — 2/2 pass. **Web suite 663/663**, build clean. `protocol-client` 268/268 green (inherited).

## Files/assumptions to remember
- Observation attribution needs wallet-connected readback; without it, charts stay honestly empty (never fabricated).
- `Record.resources[0]` assumed input resource — AMM_SWAP records that way (verify if multi-hop reuses).
- `settledObservation` signature changed during dev: direction now `input = in-side delta`, `output = out-side positive delta`.

## Open items (priority order)
1. Receipt-level history for other users' swaps (needs indexer client-side scan; out of tonight's scope).
2. SwapCard → readback path unchanged; pre-snapshot not backfilled for pre-existing CONFIRMED records (intentional — no fabrication).
3. Cloudflare preview deploy — needs `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` + manual workflow dispatch (operator).
4. Upstream L1 bridge patch (#15) — needs Tari Universe repo work + user approval.
5. VPS compose already complete — no action.

## Resume steps
```
git log --oneline -3
pnpm --filter @tari-ootle/web test
pnpm --filter @tari-ootle/web build
```
