# Frontend and browser residual risks

What the audit did **not** establish. These are not open code defects — each was
traced to a boundary outside this repository, or to a decision that was taken
deliberately and is recorded here so it is not mistaken for a solved problem.

Severity is the consequence if the risk materialises, not the likelihood.

**Update at commit `ab66114`** (testnet hosting and deployment-security phase):
R-1 remains **OPEN** with materially better prepared evidence, R-2 is
**resolved to VERIFIED_REQUIRED**, R-12 is **closed**, and R-13 is **new**. Full
row-by-row classification is in `DEPLOYMENT_SECURITY_MATRIX.md`.

| ID | Risk | Severity | Status | Why it is not closed here |
|---|---|---|---|---|
| **R-1** | **The security response headers are not yet verified as delivered by a live deployment.** The build emits `dist/_headers` in valid Cloudflare Pages syntax, hosting is configured for Cloudflare Pages in `wrangler.jsonc`, and the policy's *semantics* are proven by driving the production bundle in a real browser against a server that enforces that file (17 flows, including a genuine cross-origin clickjacking attempt refused on both `/` and a deep route). What is missing is the one thing only a real deployment can provide: an HTTPS response from the deployed URL carrying the headers. No Cloudflare account is reachable from this environment. | HIGH | **OPEN** — mitigated, not closed | Fixed in three of four parts: authoring, syntax, and enforcement semantics. The fourth part is deployment, which needs credentials. See §"What closing R-1 requires" below. |
| **R-2** | ~~The `frame-ancestors` allow-list names an unverified origin.~~ **RESOLVED → VERIFIED_REQUIRED.** `https://universe.tari.mw` is required, and is not a convenience allowance. `docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md` records the wallet's observed architecture: "`window.tari` is NOT injected into arbitrary pages: dApps run in a **cross-origin iframe inside the wallet** and load `https://universe.tari.mw/tari-connector.js`". This app is therefore *not* a top-level page in its intended deployment. | — | **VERIFIED_REQUIRED** | Two consequences were acted on, and both would have broken the product. (1) `frame-ancestors 'none'` or `'self'` is not available; the wallet must be framable. (2) `script-src 'self'` alone would have blocked the wallet's cross-origin connector, leaving the app with no `window.tari` and no ability to connect at all. The exact origin is now allowed in `script-src`, pinned, with tests asserting no wildcard, no bare Tari domain, and no `unsafe-eval`. The residual uncertainty in the injection mechanism is R-13, not R-2. |
| **R-3** | **Browser-side atomic SHA swaps do not exist upstream.** The capability check reports the blocker and there is deliberately no walletd fallback, so the multi-hop route cannot be completed in a browser. | HIGH | BLOCKED_EXTERNAL | Upstream. Recorded so the gap is not read as an untested feature. `security/MINOTARI_AUTHORITY_MODEL.md`. |
| **R-4** | **No live wallet, indexer, or chain was contacted.** Every provider interaction was an injected double; the indexer was intercepted at its production origin. The configured Esmeralda indexer hostnames (`indexer.esmeralda.tari.com`, `indexer-fallback.tari.com`) **do not resolve** from this environment — verified, not assumed — so real pool discovery, candles, trades, and liquidity activity were unavailable. | HIGH | OPEN by environment | No credentials, no funded wallet, no reachable Esmeralda endpoint. The outage path *was* exercised for real (nothing intercepted) and is correct. |
| **R-5** | **`UNKNOWN` reconciliation is implemented but unexercised end to end.** The rule is proven by unit tests and by a UI assertion that no retry control exists. No operation has actually reached `UNKNOWN` from a real lost submission response. | MEDIUM | OPEN by environment | Requires a real submission whose response is lost. |
| **R-6** | **Source maps are published deliberately.** They expose bundle structure and original source. The decision is recorded in `dist/SOURCE_MAP_POLICY.txt` and treated as non-security-critical on the grounds that the app holds no secrets — true *today*, and it would change if it ever did not. | LOW | ACCEPTED, with a stated condition | Reversible in one build flag. Re-open if any secret-bearing code is ever reachable from the frontend. |
| **R-7** | **The `style-src 'unsafe-inline'` directive is required by the current React code**, which sets layout styles as style attributes. There is no CSS-injection vector today because no untrusted value reaches a style property, asserted by a source scan. | LOW | ACCEPTED, with a condition | Removing it requires moving layout to classes. It is a live constraint on future work. |
| **R-8** | **Pool reserves are public by design**, so a submitted transaction's amounts are visible before settlement. For an XTM/TARI route the intermediate amount is observable. | MEDIUM | ACCEPTED by design | A property of the AMM, not a defect. The privacy disclosure in the signing context exists to state it rather than hide it. |
| **R-9** | **Firefox coverage is CI-only and has not been observed passing.** The Playwright Firefox build is not installed on the developer machine used for this work, and on that GPU-less host its software WebRender exhausts memory across a full suite run (`wr_renderer_render: OutOfMemory`), failing a different test each time by contention. Forcing the basic compositor did not fix it and was reverted. | LOW | **BLOCKED_TOOLING** | `test:e2e` runs Chromium desktop, mobile, and the hosting project; `test:e2e:all` adds Firefox and is what CI runs. **Not claimed as passing.** No test was weakened or skipped to achieve this. |
| **R-10** | **Only Chromium and Firefox were exercised, at three viewport sizes.** No WebKit, no real iOS or Android device, no screen reader, no high-contrast or reduced-motion mode, no automated axe pass. | MEDIUM | OPEN | `test:e2e:install` would need WebKit added, and device coverage needs real hardware. The accessibility assertions are behavioural, not exhaustive. |
| **R-11** | **The test suite is the specification of what was checked, and a check that was not written is a check that did not happen.** The clearest evidence is finding F-01: a well-tested validator was not on the live path while 179 tests passed. | MEDIUM | ONGOING, structural | Mitigated by the browser suite and the wiring assertions added with F-01. Treat any new security module as unwired until an end-to-end flow exercises it. |
| **R-12** | ~~Two lockfiles coexist.~~ **CLOSED.** `package-lock.json` was removed. It was a stale npm lockfile (`lockfileVersion` 3) last written before the pnpm migration, referenced by no workflow, and declaring a different resolution than `pnpm-lock.yaml` — so `npm install` would produce a tree no CI run had verified. The canonical policy is now written down in `docs/DEPENDENCY_POLICY.md`. | — | **CLOSED** | Commit `50d75c6`. |
| **R-13** | **The wallet connector's injection mechanism is documented but not observed.** R-2 established from repository evidence that dApps run in a cross-origin iframe and load `https://universe.tari.mw/tari-connector.js` into the document. Whether the frame injects a `<script>` element (which the `script-src` allowance permits) or establishes `window.tari` purely by `postMessage` with no cross-origin script in our document (which would make the allowance unnecessary) was **not determinable from this repository or this environment**. | MEDIUM | **EXTERNAL_RISK / UNVERIFIED_EXTERNAL** | The `script-src` allowance is a documented requirement of the recorded architecture, not an observed fact. It is the narrowest form the requirement can take — one exact origin, no wildcard, no bare Tari domain, no `unsafe-eval` — and closing it means loading the app inside a real wallet dApp frame and reading the browser's actual report. If the mechanism turns out to be postMessage-only, the allowance should be removed. |

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
