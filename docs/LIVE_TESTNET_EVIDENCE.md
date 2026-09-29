> **PARTIALLY SUPERSEDED (2026-09-29).** The provider-shape findings in this
> document were derived from `tari-connector.js` alone and are now known to be
> wrong in several places: a non-embedded provider is **not** refused, and the
> `address` compatibility alias is **not** retained. The authoritative record is
> [`docs/TARI_WALLET_INTEGRATION_CONFORMANCE.md`](TARI_WALLET_INTEGRATION_CONFORMANCE.md).
# Live testnet evidence — Esmeralda endpoints

**Captured:** 2026-09-28, read-only, from a developer machine.
**Method:** HTTP `GET`/`HEAD` only, plus one rejected `POST` with a JSON-RPC body.
**No transaction was constructed, signed, or submitted. No funds were moved.**

This document records what was *observed*, and distinguishes it from what was
*assumed*. Everything below is reproducible with the commands given.

---

## 1. Why this document exists

On 2026-09-27 this repository recorded that the configured indexer endpoints were
unreachable and concluded that no Ootle integration could be executed:

> `indexer.esmeralda.tari.com`, `indexer-fallback.tari.com`, `esmeralda.tari.com` —
> authoritative NXDOMAIN.

**That conclusion was wrong in its implication.** The DNS observation was
correct, but the inference drawn from it — that the network was unavailable —
was not supported. What had actually happened is that the repository's
configuration was **stale**. The Ootle testnet was up and serving.

The gap was a missing check: nothing in this codebase ever asked a configured
endpoint *what network it was*. A hostname that resolves and answers HTTP 200
was therefore indistinguishable from one that had been decommissioned, pointed
at the wrong chain, or replaced by something that is not an indexer at all.

That gap is now closed in code (`apps/web/src/services/indexerIdentity.ts`), and
this document is the evidence behind it.

---

## 2. Endpoint discovery: how the current origins were found

The origins were not guessed. They were taken from official Tari source and then
independently verified.

### 2.1 Official source evidence

`tari-project/ootle.ts`, `packages/ootle/src/helpers/network.ts` (BSD-3-Clause,
The Tari Project), fetched 2026-09-28:

```ts
const DEFAULT_INDEXER_URLS: Partial<Record<Network, string>> = {
  [Network.LocalNet]: "http://localhost:12500",
  [Network.Esmeralda]: "https://ootle-indexer-a.tari.com",
};
```

The same file states it *"Mirrors `default_indexer_url()` from the Rust
`ootle-rs` crate"*, so the Rust client and the TypeScript SDK agree.

`tari-project/ootle.ts`, `packages/ootle/src/network.ts`:

```ts
export enum Network {
  MainNet = 0x00,
  StageNet = 0x01,
  NextNet = 0x02,
  LocalNet = 0x10,
  Igor    = 0x24,
  Esmeralda = 0x26,
}
```

`0x26` = **38**. That number is the cross-check used below.

### 2.2 Corroboration

- The published indexer API documentation at <https://ootle.tari.com/indexer/indexer-api.html>
  documents `tari_indexer` **0.41.0** and its full REST surface.
- A third-party explorer, <https://explorer.tari.mw/>, states on its own front
  page that it *"reads live from the public Ootle indexer at
  `ootle-indexer-a.tari.com`"*. This is independent corroboration, not
  authority, and is recorded as such.

### 2.3 A legacy address that is still reachable

The `ootle-rs` documentation also lists `http://217.182.93.35:50124` for
Esmeralda. A TCP connect to that host and port succeeded from this environment.
It is **not** adopted: it is plain HTTP, so it cannot satisfy
`upgrade-insecure-requests`, cannot be listed in `connect-src` alongside an HTTPS
policy without weakening the deployment story, and carries no identity guarantee.
Recorded here so the option is not silently re-discovered later.

---

## 3. Verified endpoints

| | `ootle-indexer-a.tari.com` | `ootle-indexer-b.tari.com` |
|---|---|---|
| Scheme | HTTPS | HTTPS |
| DNS | resolves (Cloudflare-proxied) | resolves (Cloudflare-proxied) |
| `GET /info` | 200 | 200 |
| Reported version | `tari_indexer` **0.41.4** | `tari_indexer` **0.41.4** |
| Reported network | `esmeralda` | `esmeralda` |
| Reported network byte | `38` (= `0x26`) | `38` |
| Reported epoch at capture | **11602** | **11602** |

The network name **and** the network byte match the official enum. Both are
checked in code, because the name alone is a self-assertion any substituted host
could make while the byte is independent evidence.

### 3.1 Response headers on `/info`

Requested with `Origin: https://example.pages.dev`:

```
access-control-allow-origin: *
access-control-expose-headers: *
cache-control: public, max-age=30, s-maxage=15, stale-while-revalidate=7
strict-transport-security: max-age=2592000; includeSubDomains; preload
x-content-type-options: nosniff
vary: origin, access-control-request-method, access-control-request-headers
server: cloudflare
```

**Consequence:** `access-control-allow-origin: *` means these origins are
**directly browser-safe** — a cross-origin `fetch` from the deployed frontend
works without a proxy. This is why the design needs no server-side relay and why
Cloudflare Pages can host the whole thing statically.

It also means the CSP `connect-src` list is load-bearing in the other direction:
with a wildcard-permitting server, an *over*-broad CSP would be the only thing
adding restriction, so listing the exact origins is a real control rather than
formality.

---

## 4. Read-only integration results

Every request below returned 200. Nothing was submitted.

| Read | Endpoint | Observed |
|---|---|---|
| Readiness | `GET /wait-until-ready` | `{}` — indexer ready to serve |
| Identity | `GET /info` | version `0.41.4`, network `esmeralda`, byte `38`, epoch `11602` |
| Epoch + height | `GET /epoch-manager/stats` | epoch `11602`, block height `928232`, block hash `a1ea5524…` |
| Epoch checkpoint | `GET /epoch-checkpoints/latest` | checkpoint for epoch `11601` with a quorum-signed header, `"network":38` |
| Network | `GET /network` | `{"network":"esmeralda","network_byte":38,"epoch":11602}` |
| Economics | `GET /network/economics` | `transaction_receipt_count: 147754`, fee volume `1004843685`, target burn rate 500 bps |
| Sync stats | `GET /network/stats` | `num_preshards: "P256"`, per-shard-group state versions |
| Canonical TARI | `GET /resources/tari` | `resource_type: Stealth`, `SYMBOL: tTARI`, divisibility `6` |
| Recent transactions | `GET /transactions/recent?limit=3` | live transactions, each carrying `"network":38` |

**The chain is alive and serving.** 147,754 transaction receipts and a current
epoch of 11602 are not a stalled or resetting network.

### 4.1 What does *not* exist: our own deployment

Queried `GET /templates/catalogue?name_filter=<name>` for each of this
repository's four templates, in several casings:

| Template | Entries |
|---|---|
| `fungible_pool` / `FungiblePool` | **0** |
| `nft_marketplace` / `NftMarketplace` | **0** |
| `nft_item_offer` / `NftItemOffer` | **0** |
| `nft_collection_bid` / `NftCollectionBid` | **0** |

The catalogue itself is healthy — it returns 100 entries on an unfiltered
request, including community work (`EventTicketing`, `SooonPoolV1`,
`SooonCurveV5`, `PredictionMarketV1`, …) and the built-in
`TwoResourceLiquidityPool` at genesis template address
`0000000000000000000000000000000000000000000000000000000000000002`.

**Therefore:**

> **endpoint works** ✅ and **our protocol deployment currently has no matching live state** ✅

These are two different facts and the application must never conflate them. An
empty protocol deployment is not an indexer outage, and the outage path is not
the honest description of "we have not published our templates".

This is now asserted in code and tests: a verified endpoint returning a genuinely
empty list produces an **empty list with no unavailable reason**, while an
unverifiable or wrong-network endpoint produces a **typed refusal**.

### 4.2 Publication readiness — verified, and deliberately not performed

All four templates were built locally on 2026-09-28 (`cargo` 1.97.1,
`wasm32-unknown-unknown --release`, offline, non-destructive):

| Template | Bytes |
|---|---|
| `fungible_pool` | 242,679 |
| `nft_marketplace` | 196,014 |
| `nft_item_offer` | 198,624 |
| `nft_collection_bid` | 198,829 |

Publication is therefore **mechanically ready**: the artifacts exist and compile.

**It was not performed.** Publishing spends testnet funds, mutates shared testnet
state, and is irreversible for the resulting template address. It is also exactly
the kind of action that must not happen as a side effect of a test run or a CI
job. The procedure is documented in
[docs/TESTNET_RUNBOOK.md](TESTNET_RUNBOOK.md) § *"Publish the protocol templates"*,
including the explicit prohibitions: no automated publish, no hand-written publish
script, and no substituting fabricated pool records for a real deployment.

So the exact next requirement is a **human publication step**, not a code change:
publish the four templates from the wallet web UI, then point discovery at the REST
endpoints that serve the resulting components.

---

## 5. API shape: REST, and there is no GraphQL endpoint

The question "what is the current GraphQL endpoint?" has a factual answer:
**there isn't one on this indexer.** `tari_indexer` 0.41.x serves REST at fixed
paths. Publishing the previous `POST /` JSON-RPC `get_version` envelope returns
`404 Not Found` on both origins — the old configuration assumed a JSON-RPC root
that does not exist.

The documented surface:

| Area | Endpoints |
|---|---|
| Info | `GET /info`, `GET /wait-until-ready`, `GET /identity` |
| Epoch | `GET /epoch-checkpoints/latest`, `GET /epoch-checkpoints`, `GET /epoch-manager/stats` |
| Network | `GET /network`, `/network/connections`, `/network/economics`, `/network/stats` |
| Substates | `GET /substates/{substate_id}`, `POST /substates/fetch` |
| Resources | `GET /resources/tari`, `GET /resources/{resource_address}` |
| NFTs | `POST /non-fungibles` |
| Templates | `GET /templates/cached`, `/templates/catalogue`, `/templates/catalogue/{addr}`, `/templates/{addr}` |
| Transactions | `POST /transactions`, `POST /transactions/dry-run`, `GET /transactions/recent`, `/transactions/{id}`, `/transactions/{id}/result` |
| Receipts | `GET /transaction-receipts`, `/transaction-receipts/{address}` |
| Events (SSE) | `GET /events`, `GET /transactions/events/stream` |
| UTXOs | `GET /utxos`, `POST /utxos/fetch`, `POST /utxos/stream` |
| Validators | `GET /validators` |

**Event endpoint:** yes, SSE exists — `/events` (indexer events) and
`/transactions/events/stream` (template-emitted transaction events, with
`topic`, `substate_id`, `template_address`, `resource_address` filters and
`after_id` catch-up). Not exercised beyond confirming the endpoint exists.

### 5.1 What this means for this repository, stated plainly

This app's pool and NFT discovery layers issue
`POST {base}` with an envelope such as `{"query":"pool_discovery"}` and expect a
record array. That is an application-specific query convention, **not** the
indexer's own API. Pointing `VITE_INDEXER_URL` at a working indexer therefore
produces `404`, which this app already reports honestly as an unavailable
discovery endpoint rather than as an empty pool list.

**What was done:** the hosts were corrected and the network-identity gate was
added, so the endpoint is now genuinely reachable and its identity verified.

**What was deliberately not done:** rewriting discovery onto the indexer's
REST API was out of scope for this pass, and would produce nothing useful while
this repository's templates are unpublished — there are no pool components to
find. There is no "compatibility shim" faking the old envelope, because that
would mean injecting fabricated discovery data, which this codebase refuses to do
in any path.

**The exact next requirement** is a publication step, not a coding step: publish
`templates/fungible_pool` (and the marketplace templates) to Esmeralda through
the wallet web UI, then point discovery at the REST endpoints that serve those
components.

---

## 6. Wallet / provider network identity

`GET /info` reports `network: "esmeralda"` and `network_byte: 38`. The
frontend's allowlist already uses the id `esmeralda`, and
`NETWORK_BYTES.esmeralda = 0x26` is asserted in tests against this observation.

### 6.1 The provider connector was read directly

The Tari Universe connector was fetched and read — not a copy of it:

```
GET https://universe.tari.mw/                      → 200
GET https://universe.tari.mw/tari-connector.js    → 200, 18,589 bytes
```

Three findings came out of that and are recorded in full in
[docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md](TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md):

1. **All thirteen allow-listed `window.tari` methods exist upstream.** Nothing
   this app calls is invented. The connector's confidential/shielded methods are
   deliberately unused — this is a public AMM.
2. **`tari_getSubstate` takes `substateId`, not `address`.** This app was sending
   `{ address }`. That is the **authoritative readback path**, so a real wallet
   would have failed every reread. The failure mode is safe (the resolvers fail
   closed) but the product would have been non-functional. Fixed, with `address`
   kept as an identical-value alias.
3. **The `script-src https://universe.tari.mw` allowance is observed, not
   assumed** (resolves R-13). The connector's own source states the wallet loads
   it as a cross-origin script into the dApp document and forwards by
   `postMessage`.

Also learned: the provider publishes `isEmbedded`, not the `isAvailable` its own
doc comment names — an upstream doc slip, recorded so nobody depends on a
property that does not exist. The app refuses an explicit `isEmbedded === false`
before making any call.

### 6.2 What was not verified

**No real wallet was available in this environment.** Every provider interaction
in the test suites is an injected double. No claim is made that a real wallet
completed a real flow, and none of the connector's *runtime* behaviour — approval
prompts, rejections, account switching, capability advertisement — has been
observed, only its declared interface and source.

---

## 7. Reproducing these observations

```bash
# Identity — the check the app itself performs
curl -sS https://ootle-indexer-a.tari.com/info
curl -sS https://ootle-indexer-b.tari.com/info

# CORS
curl -sSI -H 'Origin: https://example.pages.dev' https://ootle-indexer-a.tari.com/info | grep -i access-control

# Epoch / height
curl -sS https://ootle-indexer-a.tari.com/epoch-manager/stats

# Canonical TARI
curl -sS https://ootle-indexer-a.tari.com/resources/tari

# Are our templates published?
for n in fungible_pool nft_marketplace nft_item_offer nft_collection_bid; do
  echo -n "$n: "
  curl -sS "https://ootle-indexer-a.tari.com/templates/catalogue?name_filter=$n&limit=100"
  echo
done
```

The verbatim values quoted throughout this document are what these commands
returned; they are reproducible, so a reader does not have to trust the capture.
A machine-readable dump of this session's `/info`, `/epoch-manager/stats`,
`/network`, and `/resources/tari` responses was written to
`.research/live-endpoint-evidence-2026-09-28.json`, but **`.research/` is
gitignored** and that file is therefore a local artifact, not committed
evidence. Everything a reviewer needs is in the tables above.

---

## 8. Status classification

| Claim | Class | Basis |
|---|---|---|
| Esmeralda testnet indexer reachable over HTTPS | **VERIFIED LIVE** | `/info` 200 on two origins |
| Network identity `esmeralda` / byte 38 | **VERIFIED LIVE** | matches official SDK enum |
| Indexer version 0.41.4, epoch 11602 | **VERIFIED LIVE** | `/info`, `/epoch-manager/stats` |
| Browser-safe (direct CORS) | **VERIFIED LIVE** | `access-control-allow-origin: *` |
| All 13 allow-listed `tari_*` methods exist | **VERIFIED AGAINST DEPLOYED SOURCE** | `universe.tari.mw/tari-connector.js` fetched and read |
| `tari_getSubstate` param name (`substateId`) | **VERIFIED AGAINST DEPLOYED SOURCE** | three call sites in the connector; fixed a real defect here |
| `script-src` wallet allowance is required | **VERIFIED AGAINST DEPLOYED SOURCE** | resolves R-13 |
| This protocol's templates published on-chain | **NOT PRESENT** | 4 catalogue queries, 0 entries |
| Live pool / NFT discovery of our pools | **BLOCKED_EXTERNAL** | requires the publication step |
| Discovery query convention matches the indexer API | **OPEN (R-14)** | `POST {base}` vs REST; reported honestly, no shim |
| Any transaction executed | **NOT ATTEMPTED** | out of scope and gated |
| Real wallet provider **runtime** behaviour exercised | **NOT ATTEMPTED** | no wallet available; interface verified, behaviour not |
| Deployed HTTPS host serving `_headers` | **NOT ATTEMPTED** | no Cloudflare credentials; R-1 open |
