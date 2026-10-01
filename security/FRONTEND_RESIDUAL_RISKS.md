# Frontend and browser residual risks

What the audit did **not** establish. These are not open code defects — each was
traced to a boundary outside this repository, or to a decision that was taken
deliberately and is recorded here so it is not mistaken for a solved problem.

Severity is the consequence if the risk materialises, not the likelihood.

**Update at commit `8ef3d03`** and the provider verification that followed (live testnet productization): R-1 remains **OPEN** but is
now prepared rather than merely discussed; **R-4 is reclassified** — the endpoint that blocked it
was stale configuration and is now verified live; **R-13 is RESOLVED** against the deployed wallet
connector; **R-9 is now observed passing locally** (Firefox 49/49); **R-14 is new**. Full row-by-row

| ID | Risk | Severity | Status | Why it is not closed here |
|---|---|---|---|---|
| **R-1** | **The security response headers are not yet verified as delivered by a live deployment.** The build emits `dist/_headers` in valid Cloudflare Pages syntax, hosting is configured for Cloudflare Pages in `wrangler.jsonc`, and the policy's *semantics* are proven by driving the production bundle in a real browser against a server that enforces that file (17 flows, including a genuine cross-origin clickjacking attempt refused on both `/` and a deep route). What is missing is the one thing only a real deployment can provide: an HTTPS response from the deployed URL carrying the headers. No Cloudflare account is reachable from this environment. | HIGH | **OPEN** — prepared, not closed | Fixed in three of four parts: authoring, syntax, and enforcement semantics. The fourth part is deployment, which needs credentials. It is now *prepared* rather than merely discussed: a manual-dispatch deploy workflow with a pinned project name and an artifact gate, an explicit SPA rewrite so deep routes resolve directly on the host, and a one-command live verifier (`verify:live-headers`) that exits non-zero on any mismatch. See "What closing R-1 requires" below. |
| **R-2** | ~~The `frame-ancestors` allow-list names an unverified origin.~~ **RESOLVED → VERIFIED_REQUIRED.** `https://universe.tari.mw` is required, and is not a convenience allowance. `docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md` records the wallet's observed architecture: "`window.tari` is NOT injected into arbitrary pages: dApps run in a **cross-origin iframe inside the wallet** and load `https://universe.tari.mw/tari-connector.js`". **CORRECTED 2026-09-29:** the published contract is explicit that `window.tari` is implemented by **both** the Sapient browser extension (which injects into any page) and the Tari Universe web wallet (which frames the dApp). The app supports both placements, and an ordinary top-level tab is a first-class deployment, not a degraded one. | — | **VERIFIED_REQUIRED** | Two consequences were acted on, and both would have broken the product. (1) `frame-ancestors 'none'` or `'self'` is not available; the wallet must be framable. (2) `script-src 'self'` alone would have blocked the wallet's cross-origin connector, leaving the app with no `window.tari` and no ability to connect at all. The exact origin is now allowed in `script-src`, pinned, with tests asserting no wildcard, no bare Tari domain, and no `unsafe-eval`. The residual uncertainty in the injection mechanism is R-13, not R-2. |
| **R-3** | **Browser-side atomic SHA swaps do not exist upstream.** The capability check reports the blocker and there is deliberately no walletd fallback, so the multi-hop route cannot be completed in a browser. | HIGH | BLOCKED_EXTERNAL | Upstream. Recorded so the gap is not read as an untested feature. `security/MINOTARI_AUTHORITY_MODEL.md`. |
| **R-4** | ~~**No live indexer was reachable, so nothing could be read.**~~ **RECLASSIFIED ' the endpoint was stale configuration, not a dead network.** The previously configured hosts (`indexer.esmeralda.tari.com`, `indexer-fallback.tari.com`) really were authoritative NXDOMAIN, but the inference drawn from that was wrong: Esmeralda was up and serving. The current origins (`https://ootle-indexer-a.tari.com`, `https://ootle-indexer-b.tari.com`) were taken from official Tari tooling source (`tari-project/ootle.ts`, `defaultIndexerUrl(Network.Esmeralda)`) and then read live on 2026-09-28: `tari_indexer` 0.41.4, network `esmeralda`, byte `38` (0x26), epoch `11602`, `access-control-allow-origin: *`. Full evidence in `docs/LIVE_TESTNET_EVIDENCE.md`. | HIGH | **RESOLVED for the endpoint; the gap reappears downstream** | The read path is now proven. What remains is a *deployment* gap, not a reachability gap: this repository's four templates are **not published** on Esmeralda (four catalogue queries, zero entries), so there are no pools of ours to discover. That is an empty protocol deployment, and it is now classified as such in code and in tests, never as an outage. Still no live wallet, no funded account, and no submitted transaction, so R-5 is untouched. |
| **R-5** | **`UNKNOWN` reconciliation is implemented but unexercised end to end.** The rule is proven by unit tests and by a UI assertion that no retry control exists. No operation has actually reached `UNKNOWN` from a real lost submission response. | MEDIUM | OPEN by environment | Requires a real submission whose response is lost. |
| **R-6** | **Source maps are published deliberately.** They expose bundle structure and original source. The decision is recorded in `dist/SOURCE_MAP_POLICY.txt` and treated as non-security-critical on the grounds that the app holds no secrets — true *today*, and it would change if it ever did not. | LOW | ACCEPTED, with a stated condition | Reversible in one build flag. Re-open if any secret-bearing code is ever reachable from the frontend. |
| **R-7** | **The `style-src 'unsafe-inline'` directive is required by the current React code**, which sets layout styles as style attributes. There is no CSS-injection vector today because no untrusted value reaches a style property, asserted by a source scan. | LOW | ACCEPTED, with a condition | Removing it requires moving layout to classes. It is a live constraint on future work. |
| **R-8** | **Pool reserves are public by design**, so a submitted transaction's amounts are visible before settlement. For an XTM/TARI route the intermediate amount is observable. | MEDIUM | ACCEPTED by design | A property of the AMM, not a defect. The privacy disclosure in the signing context exists to state it rather than hide it. |
| **R-9** | ~~Firefox coverage is CI-only and has not been observed passing.~~ **NOW OBSERVED PASSING (2026-09-28).** The earlier row recorded that the Playwright Firefox build was not installed on this machine and that, when tried on a GPU-less host, software WebRender exhausted memory across a full run (`wr_renderer_render: OutOfMemory`) and failed a different test each time by contention. The build is installed now, and the full `firefox-desktop` project passes: **49/49**, no retries. | LOW | **CLOSED by observation** | Recorded with its condition rather than deleted, because the failure mode was contention- and host-dependent and could return. CI still runs Firefox on a real runner (`test:e2e:all`), which remains the authoritative cross-engine check. A local pass is one host and one run, so the residual is host variability, not coverage. |
| **R-10** | **Only Chromium and Firefox were exercised, at three viewport sizes.** No WebKit, no real iOS or Android device, no screen reader, no high-contrast or reduced-motion mode, no automated axe pass. | MEDIUM | OPEN | `test:e2e:install` would need WebKit added, and device coverage needs real hardware. The accessibility assertions are behavioural, not exhaustive. |
| **R-11** | **The test suite is the specification of what was checked, and a check that was not written is a check that did not happen.** The clearest evidence is finding F-01: a well-tested validator was not on the live path while 179 tests passed. | MEDIUM | ONGOING, structural | Mitigated by the browser suite and the wiring assertions added with F-01. Treat any new security module as unwired until an end-to-end flow exercises it. |
| **R-12** | ~~Two lockfiles coexist.~~ **CLOSED.** `package-lock.json` was removed. It was a stale npm lockfile (`lockfileVersion` 3) last written before the pnpm migration, referenced by no workflow, and declaring a different resolution than `pnpm-lock.yaml` — so `npm install` would produce a tree no CI run had verified. The canonical policy is now written down in `docs/DEPENDENCY_POLICY.md`. | — | **CLOSED** | Commit `50d75c6`. |
| **R-13** | ~~The wallet connector's injection mechanism is documented but not observed.~~ **RESOLVED → VERIFIED AGAINST SOURCE.** The connector at `https://universe.tari.mw/tari-connector.js` was fetched and read directly on 2026-09-28. Its own source states: "The wallet runs your dApp in a cross-origin iframe, so it cannot reach into this page … So the provider lives here and forwards every call to the wallet by postMessage." The wallet therefore **does** load the connector as a cross-origin script into the dApp document, which is exactly what the `script-src https://universe.tari.mw` allowance permits. | — | **RESOLVED** | Two conditions rode on R-13 and both held. (1) The allowance is required, not a convenience, and stays. (2) Detection is by object identity, never by the connector's `tari:announceProvider` / `tari#initialized` events, because an announcement is another thing a hostile page can emit. The same read also found that the connector publishes `isEmbedded` (its own doc comment names `isAvailable`, which does not exist — an upstream doc slip, recorded so nobody depends on it) and that `tari_getSubstate` takes `substateId`, not the `address` this app was sending. **SUPERSEDED 2026-09-29.** Those conclusions were drawn from the connector alone and two of them are now known to be WRONG. The published contract (<https://universe.tari.mw/integration/tari-dapp.d.ts>) marks `isEmbedded` **optional** and specific to the embedded provider, and states that a dApp never detects which wallet it has, so a non-embedded provider is **accepted**, not refused. The `address` alias is **removed**, not retained. The authoritative record is `docs/TARI_WALLET_INTEGRATION_CONFORMANCE.md`. The `script-src` conclusion here still holds. |
| **R-14** | ~~**Discovery speaks a query convention this indexer does not serve, so pointing it at a healthy endpoint still yields no pools.**~~ | MEDIUM | **RESOLVED — 2026-10-01, `c82ae99`** | Pool discovery now speaks the **real** `tari_indexer` v0.42.0 REST API instead of the invented `POST {base} {"query":"pool_discovery"}` envelope, verified read-only against the post-reset Esmeralda hosts. It reads `GET /templates/catalogue` — which **replaced `/templates/cached`, removed in v0.42.0** — then `GET /transaction-receipts` (chosen over the best-effort `/transactions/recent` because the indexer documents it as complete from genesis and recovered after downtime), then `POST /substates/fetch`, confirming each component's template from the component's **own header** rather than from the creating transaction. The removed endpoint is never requested and a test asserts it. **No synthetic record is ever produced**: an unpublished template resolves to `PROTOCOL_NOT_DEPLOYED`, an empty one to `PROTOCOL_DEPLOYED_EMPTY`, and a failure to `INDEXER_UNAVAILABLE` or `WRONG_NETWORK` — four distinct facts the UI renders separately. Note that discovery establishes only WHICH pools exist: the indexer returns component state as raw tagged CBOR and cannot decode a pool's fields, so reserves and fee come from the wallet's authoritative read. Discovery therefore remains informational and is never execution-authoritative. |

## What closing R-1 requires

R-1 is closed by **live deployed evidence**, not by configuration. All three of
these are required, and the first is the one that is missing:

1. **A deployed URL queried over HTTPS**, showing the headers on `/`, on a deep
   SPA route such as `/pools`, and on a hashed asset. The exact commands are in
   `docs/TESTNET_HOSTING.md`.
2. **The clickjacking test against that deployed URL**, not against the local
   enforcing server. The local server proves the policy's semantics; only the
   deployed URL proves delivery.
3. **A recorded verification date and the deployed git SHA**, added to this file
   and to `FRONTEND_HOSTILE_AUDIT_REPORT.md`.

Until then R-1 stays open, and the honest statement is: *the headers are
authored, syntactically valid, semantically enforced in a browser, and not yet
observed arriving from a real host.*


---

## F-01: the validator that was not on the path

Recorded separately because it is the audit's most transferable result, and
because it is the reason R-11 exists.

`apps/web/src/lib/storage.ts` contained a strict, fail-closed record validator:
it bounds its input, rebuilds every record from an allow-list, rejects a
malformed amount outright, drops records carrying secret fields, and caps the
record count. It was correct, and it was well tested — `storage: a tampered
amount, resource, or txid is dropped rather than coerced`, `storage: a record
carrying a secret field is dropped outright`, and a dozen more.

Those tests called `loadHistoryPayload` **directly**. The application never did.

The live read path, `apps/web/src/services/history.ts`, parsed `localStorage`
itself and filtered records with `typeof entry.operationId === 'string'`. So in
the shipped app:

- a record whose amounts had been tampered with rendered verbatim,
  `amounts: { a: 'not-a-number' }` displayed as the literal text `not-a-number`;
- an unrecognised field, including a `preimage` written by an older build,
  survived into application state;
- the input was unbounded, so a large payload was parsed in full;
- `historyIntegrity` reported "not an array" or nothing at all, so the interface
  could not tell the user that records had been dropped.

The suite was **179/179 green** while this was true.

The fix routes the read path through the validator and reports the rejected
count. The durable mitigation is the wiring assertion: a test now reads
`services/history.ts` and fails if the raw filter ever reappears, and a browser
flow writes forged records to `localStorage` before app code runs and asserts
they are not displayed. That flow is the one that would have caught this
originally, and it exists now only because the module-level tests had already
proven insufficient.

**The generalisable rule: a security module's tests prove the module, not its
reachability. Prove the wiring separately, or the control is documentation.**
