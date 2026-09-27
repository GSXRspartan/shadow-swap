# Market-data source model

Status: **traced against pinned upstream; discovery-only, never execution authority.**
Ootle revision: `2d6083e6cc7c98cde93dacebe2fb76b17703f588` (workspace 0.41.1),
local checkout `C:\tmp-tari`. Tari L1 (Minotari, unrelated to L2 market data):
`v6.0.0` / `97aa59ecfaf70d8334f14e71d8f7afd6bd40e5e3`.

Every path below was read from the pinned source, not assumed. Where a capability does not
exist, that is stated as a finding rather than worked around.

---

## 1. What the Ootle indexer actually exposes

| # | Endpoint | Payload | Source file |
|---|---|---|---|
| S1 | `GET /events` (SSE) | `NewEpochEvent { epoch }` and `TransactionFinalizedEvent { transaction_id, outcome }` | `applications/tari_indexer/src/rest_api/server.rs:256`, `clients/tari_indexer_client/src/event.rs:42-51` |
| S2 | `GET /transactions/events/stream` (SSE) | `TransactionEvent { id, transaction_id, event }` where `id` is the DB autoincrement id, transmitted as the SSE `id:` field; catch-up via `after_id` or `Last-Event-ID`; `MAX_REPLAY_EVENTS = 10_000`, `REPLAY_PAGE_SIZE = 500` | `src/rest_api/handlers/transaction_events.rs:26-70`, `clients/tari_indexer_client/src/event.rs:54-64` |
| S3 | GraphQL `get_events(topic, substate_id, resource_address, offset, limit)` | `Event { substate_id, template_address, tx_hash, topic, payload, resource_address }`; `limit ≤ 1000` | `src/graphql/model/events.rs:39-95` |
| S4 | `GET /substates/{id}`, `POST /substates/fetch` | authoritative component state incl. `state_version`, `producingTxHash`, epoch | `src/rest_api/server.rs:168-177`; our `src/ootle.ts` `AuthoritativeSubstateReader` |
| S5 | (internal, not public) `get_events_after_id(after_id, topic, substate_id, template_address, resource_address)` | id-cursor replay used by S2 | `src/storage_sqlite/reader.rs:368` |

## 2. Classification

| Source | Authoritative or discovery | Historical | Live/streaming | Ordering | Tx identity | Epoch/version | Timestamp | Trust assumption |
|---|---|---|---|---|---|---|---|---|
| S1 `/events` | **DISCOVERY** (indexer-reported finalization) | No (live only) | Yes, broadcast | Arrival order only | Yes | Epoch via `NewEpoch` | **None** | The indexer finalizes correctly; still not a consensus read |
| S2 `/transactions/events/stream` | **DISCOVERY** | Yes, replay from `after_id` (≤10k) | Yes, SSE | **DB autoincrement `id`** (monotonic) | Yes | No | **None in payload** | DB insertion order approximates commit order; ids are gaps-safe |
| S3 GraphQL `get_events` | **DISCOVERY** | Yes (offset/limit) | No | DB insertion order (proxy) | Yes | No | **None** | Offset pagination is unstable under concurrent inserts |
| S4 substate read | **AUTHORITATIVE** | Current state only | Poll | `state_version` | `producingTxHash` of the *state* | `state_version` + epoch | None | Chain-backed; the only source execution may trust |
| S5 internal id cursor | Internal | Yes | — | `id` | Yes | No | None | Not exposed publicly |

## 3. Findings that constrain the design

1. **There is no consensus timestamp anywhere in the indexer API.** Neither `Event`
   (S3) nor `TransactionEvent` (S2) carries a timestamp. The underlying `events` table has
   `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP` (`src/storage_sqlite/migrations/2023-02-16-145719_initial/up.sql:33-42`),
   but that is **indexer-local ingestion time** and it is **not exposed** by the GraphQL
   type. `NewEpoch` (S1) gives epoch *numbers*, not times.
   → Consequence: wall-clock OHLCV at 1m/5m/15m/1h **cannot be built from a trustworthy
   clock today**. The design therefore buckets by **epoch boundary** and marks
   sub-resolution intervals `UNSUPPORTED_NO_TRUSTWORTHY_TIMESTAMP` rather than
   fabricating them. See `src/marketdata/candle.ts` and `PriceIntervalSupport`.

2. **There is no GraphQL subscription** — the schema is
   `Schema<EventQuery, EmptyMutation, EmptySubscription>` (`src/graphql/model/events.rs:65`).
   Live capability exists, but through **SSE**, not GraphQL. We use SSE (S2) and do not
   invent websocket support.

3. **Our own pool template emits no events.** `templates/fungible_pool/src/lib.rs` has no
   `emit`/`EventEmitter`/topic call. So today there are **no template events to index at
   all** for swaps, and event-sourced indexing would find nothing.
   → Consequence: the ingestion layer is **source-pluggable** and is fed by (a) our own
   execution layer's confirmed swap receipts, and (b) authoritative substate-diff detection
   (`producingTxHash`/reserve change between authoritative reads). Third-party and
   all-pool indexing requires a **template change to emit swap events** — recorded as
   `BLOCKED_EXTERNAL` upstream work, not faked.

4. **No reorg/invalidation signal exists.** `TransactionFinalizedEvent` reports the outcome
   but there is no "unfinalized"/"reverted" event and no reorg depth query in the indexer
   API. Append-only indexing is therefore **not reorg-proof**.
   → Consequence: the trade record carries an explicit `provisional | finalized |
   invalidated` state and the store supports invalidation + candle rebuild, but
   *automatic* invalidation detection is `BLOCKED_EXTERNAL`. Documented as residual risk
   rather than claimed as reorg-safe.

5. **A `TransactionEvent` identifies a template event, not a trade.** A swap is not a
   first-class object upstream: there is no "trade id" concept. Trade identity must
   therefore be **derived** (txid + pool component + instruction/index) per §4, never
   randomly generated.

## 4. Chosen source precedence for the market-data layer

1. **S4 (authoritative substate)** — used to *verify* any candidate trade before it is
   recorded: the pool's `producingTxHash` and reserves must match what the trade claims.
2. **S2 (SSE, discovery)** — the live feed for template events, when a template emits them.
3. **S1 (SSE, discovery)** — epoch boundaries (for epoch-bucketed candles) and finalized
   transaction outcomes (for the finality state of a recorded trade).
4. **S3 (GraphQL, discovery)** — historical backfill with a persisted cursor.

Nothing in this list may ever be used to set an execution amount, a `min_output`, or to
create a settlement proof. That boundary is enforced by types and covered by tests
(`packages/protocol-client/test/marketdata_hostile.test.cjs`).

## 5. What a live deployment would still need

| Need | Blocker | Class |
|---|---|---|
| Wall-clock 1m/5m/15m candles | No consensus timestamp exposed | EXTERNAL_RISK (upstream) |
| Indexing *other* pools' trades | Our template emits no events; other templates unknown | BLOCKED_EXTERNAL |
| Automatic reorg invalidation | No unfinalize/reorg API in the indexer | BLOCKED_EXTERNAL |
| Confirmed trade amounts for arbitrary pools | No first-class trade object upstream | BLOCKED_EXTERNAL |
