# Frontend and browser attack matrix

Every row is a threat, the control that answers it, and the test that fails if
the control regresses. `FIXED` means the control is implemented *and* proven by a
test that exercises the shipped artifact. `BLOCKED_EXTERNAL` means the threat is
real but cannot be closed in this codebase. `EXTERNAL_RISK` means the control is
outside the code entirely.

Evidence keys are defined in `FRONTEND_INVARIANTS.md`.

Test totals at the time of writing: 194 node tests in `apps/web`, 62 Playwright
flows green locally on `chromium-desktop` and `chromium-mobile` (31 flows x 2
projects), plus 31 on `firefox-desktop` in CI, 185 in `protocol-client`,
21 in `wallet-adapter`.

---

## 1. Provider spoofing and session hijack

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 1.1 | Page script installs a `window.tari` with a convincing shape before app code runs | Capability handshake is mandatory; `getTariProvider` refuses a provider without a callable `request`; identity is compared by object reference | FIXED | `HF spoof: a provider with the right shape is not accepted without a capability handshake`, `E2E:<all> without a provider the app is disconnected and says so` |
| 1.2 | Provider object is replaced after the user approves a review | `liveIdentity` re-resolves `window.tari` at authorization time; a different object is a hard mismatch | FIXED | `HF identity: a replaced provider object is detected by reference`, `E2E:<all> a provider replaced mid-session is refused at authorization, not trusted` |
| 1.3 | `request` is swapped on the *same* object to redirect signing to attacker code | `providerFingerprint` hashes function source, not just object identity | FIXED | `HF spoof: swapping the provider implementation on the same object is detected` |
| 1.4 | Provider inherits `request` from its prototype to look different from an own-property provider | Prototype constructor name is folded into the fingerprint | FIXED | `HF spoof: a provider that inherits its request method is still fingerprinted` |
| 1.5 | Provider downgrades capabilities after the handshake, then the UI still offers the action | Capabilities re-fetched live and fingerprinted | FIXED | `HF identity: a capability downgrade after approval is detected`, `E2E:<all> a provider that downgrades its capabilities cannot keep an enabled control` |
| 1.6 | Review from a previous session replayed against a new one | Per-session nonce, checked first | FIXED | `HF identity: a stale review from a previous session cannot be re-authorized` |
| 1.7 | Provider calls methods outside the Tari allow-list | `TARI_METHODS` allow-list | FIXED | `HF spoof: only allow-listed Tari methods are callable` |
| 1.8 | Provider stalls forever, wedging the page | The shell renders independently of any provider call | FIXED | `E2E:<all> a provider hanging forever cannot wedge the page` |
| 1.9 | Provider removed after connect | `getTariProvider` throws; there is no empty-identity fallback | FIXED | `HF spoof: getTariProvider throws a typed refusal rather than returning a stub` |
| 1.10 | Provider claims a capability with an unrecognised flag name | Treated as NOT ADVERTISED, never as true | FIXED | `HF spoof: a capability reply with no recognisable flag is treated as NOT ADVERTISED` |
| 1.11 | A second copy of the protocol client is linked, so an internal brand or a route record is accepted from the wrong module | Single-instance proof scanning the built bundle | FIXED | `INST` |
| 1.12 | A real browser extension with a different adapter is silently driven as if it were Minotari | Placeholder adapters refuse every state-bearing operation instead of fabricating results | FIXED | `packages/wallet-adapter/test/adapter_honesty.test.cjs` |

## 2. Approval and signing

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 2.1 | **The provider is asked to sign something other than what the user approved.** The reviewed request was attached to a preview through a type cast, then dropped by the layer that built the payload, so the signed bytes were a second independent derivation from the same intent. | Reviewed request is a required parameter of the signing seam and is sent verbatim; no reconstruction, no fallback | FIXED | `HF signing: the reviewed request is required and is sent verbatim, not re-derived` |
| 2.2 | A review is mutated after approval but before signing | Deep freeze on construction, re-verified at signing time | FIXED | `HF integrity: a review cannot be edited after the user approves it` |
| 2.3 | A gate that reads as a check but cannot fail | Self-comparison removed; a regression rejects any `x !== x` in `execution.ts` | FIXED | `HF signing: the removed tautology cannot come back` |
| 2.4 | Review describes a different pool, operation, account, amount, or `min_output` than the intent | AMM differential review against the intent and against the actual call arguments | FIXED | `HF integrity: a tampered review is detected by the differential check` |
| 2.5 | **Every NFT trade is diffed with AMM rules.** A marketplace intent has no `poolComponent` and no `settlement`, so the comparison mismatched on every buy and sell — the feature was blocked rather than secured. | Marketplace-specific differential, dispatched on intent kind | FIXED | `HF review: a marketplace intent is diffed with the marketplace rules`, `...rejects a review bound to the wrong account`, `...rejects a tampered amount`, `...rejects a review for a different order` |
| 2.6 | An NFT review names an *asset* as the account, so any account can "match" it | Review binds to `wallet.account`; absent account blocks submission | FIXED | `HF review: an NFT review is bound to the signer, not to the asset` |
| 2.7 | Zero `min_output` is shown as an offer | Refused in the resolver, before display | FIXED | `HF integrity: a zero min_output is refused before the user ever sees an offer` |
| 2.8 | A review with no named amounts, network, account, or operation id is displayed | `createReview` validation refuses it | FIXED | `HF integrity: a review with no named amounts is refused`, `...a review must name its network, account, and operation id` |
| 2.9 | Signing is requested with no named assets, operation, or network context | `tariWindow.signAndSubmit` pre-flight assertions refuse | FIXED | `HF secrets: no secret-bearing protocol field is read, logged, or rendered by the app` (pre-flight cases) |
| 2.10 | A previously seen transaction result is replayed as fresh | Result is matched to the submission that produced it | FIXED | `HF spoof: a replayed or stale transaction result cannot be mistaken for a fresh one` |

## 3. Amount and price manipulation

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 3.1 | **Decimal shift.** `"1.0"` at 6 decimals scaled to raw `1` — a silent 10^6 reduction in a transferred amount. | Scaling on fractional digit count, not numeric value | FIXED | `HF integrity: a decimal-shift is impossible because no Number is involved`, `HF amounts: the hostile input corpus behaves as specified` |
| 3.2 | Excess precision silently rounded in the user's favour or against it | Refused | FIXED | `HF amounts: excess precision is refused, never rounded` |
| 3.3 | A display-formatted price (`1.23`, `1e6`, `$1.23`) reaches an execution input | `asRawExecutionAmount` accepts raw integer strings only | FIXED | `HF boundary: a display value can never become a review amount`, `DEP boundary: no display-formatted price is fed into an execution input` |
| 3.4 | IEEE-754 precision loss above 2^53 | BigInt throughout | FIXED | `HF amounts: 2^53, 2^64, and 2^128 boundaries survive exactly` |
| 3.5 | A hostile numeric string exhausts memory during parsing | Length bound plus strict character class | FIXED | `HF amounts: a huge malicious numeric string is refused, not parsed` |
| 3.6 | A provider reports a fractional, negative, or unbounded balance | Refused | FIXED | `HF spoof: a balance reply with a non-integer amount is refused` |
| 3.7 | A lowercase provider status (`committed`) is mis-mapped to `UNKNOWN`, stalling a settled operation | Normalised before mapping; anything unrecognised is `UNKNOWN` | FIXED | `HF errors: an explicit code always wins over inference` |
| 3.8 | The frontend re-derives AMM math and disagrees with the protocol | No reserve or constant-product arithmetic in `apps/web/src` | FIXED | `DEP boundary: the frontend does not reimplement AMM or route math` |

## 4. Market data as an execution vector

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 4.1 | Chart candles are crafted so a displayed price is used as an execution input | The market bundle is not an authoritative reader; resolvers use the wallet readback | FIXED | `HF poisoning: hostile chart data cannot reach a resolver input` |
| 4.2 | A market-data health claim is used to make an execution source authoritative | Health is a display type with no resolver role | FIXED | `HF poisoning: a market-data health claim cannot make an execution source authoritative` |
| 4.3 | Future-dated or out-of-order candles distort the displayed price | Refused at the display boundary (`ChartBasisError`) | FIXED | `HF poisoning: a future-dated or malformed candle is refused at the display boundary` |
| 4.4 | **A failed discovery is rendered as "0 pools" and "No pools to show"**, telling a user their money has no market | Count suppressed and the failure named when discovery did not answer | FIXED | `E2E:<all> an indexer outage produces an explicit unavailable state, not an empty list` |
| 4.5 | Missing metrics render as `0` rather than as unavailable | `UNAVAILABLE` sentinel, em dash in the table | FIXED | `E2E:<all> pool discovery renders both pools with the full metric set` |
| 4.6 | Hostile discovery payload injects script or spoofs a safety class | Strict parser; text rendering only | FIXED | `E2E:<all> a hostile discovery payload cannot inject script or break the layout` |
| 4.7 | Dev fixtures are enabled in a shipped build | `__OOTLE_ENV__` replaced at build; `FIXTURE_*` absent from the artifact | FIXED | `DEP fixtures`, `HF policy: the development fixtures cannot be enabled by a shipped flag` |
| 4.8 | An indexer URL pointing at a private network ships as a dependency | Build fails instead | FIXED | `DEP` endpoint cases |

## 5. Persistence

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 5.1 | **The live read path bypasses the validator.** `history.ts` did `JSON.parse` plus an `operationId` type check, so a tampered amount rendered verbatim and an unknown field (including a `preimage`) survived into app state. The strict validator in `storage.ts` was never called. | Read path routes through `loadHistoryPayload` | FIXED | `HF persisted history: the live read path is the validating parser, not a raw JSON.parse`, `E2E:<all> a tampered operation record is dropped, not displayed` |
| 5.2 | A malformed amount is silently omitted, reading as "zero" | Whole record fails closed | FIXED | `HF storage: a tampered amount, resource, or txid is dropped rather than coerced` |
| 5.3 | A record carrying a secret field is displayed | Dropped outright | FIXED | `HF storage: a record carrying a secret field is dropped outright` |
| 5.4 | A forged `CONFIRMED` is presented as settled | Shown as a claim until an authoritative lookup agrees | FIXED | `HF storage: a tampered CONFIRMED record is downgraded to a claim`, `E2E:<all> a tampered confirmation is shown as a claim, not as settled` |
| 5.5 | A tampered freshness stamp replays a stale readback as fresh | Freshness is never restored from storage | FIXED | `HF storage: freshness is never restored, so a tampered readback cannot be replayed` |
| 5.6 | A huge payload exhausts memory | 4 MiB input cap, record cap, sort after truncation | FIXED | `HF storage: the record count is bounded so a huge payload cannot exhaust memory` |
| 5.7 | Corrupt storage is silently emptied, implying a clean history | Reported as corrupt | FIXED | `HF storage: a corrupt or oversized payload is reported, not silently emptied` |
| 5.8 | Dropped records vanish without the user being told | Rejected count surfaced via `historyIntegrity` | FIXED | `HF persisted history: the live read path is the validating parser, not a raw JSON.parse` |
| 5.9 | A secret is persisted to `localStorage` | No secret reaches the app; asserted against the running app | FIXED | `E2E:<all> no secret is ever written to storage` |
| 5.10 | A second storage key is introduced that holds something sensitive | Inventory is exactly two keys, neither secret-bearing | FIXED | `HF storage: the inventory declares exactly two keys and neither holds secrets` |

## 6. Submission and recovery

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 6.1 | **Rapid double click creates two durable operations.** `LiquidityPanel` and `NftDetailPanel` guarded on React state, which is still `false` before the re-render; `SwapCard` was already correct. | Synchronous `submitGuard` ref claimed before the first await, released in `finally` | FIXED | `HF double submit: every submission path uses a synchronous in-flight guard`, `E2E:<all> a rapid double submit cannot create two durable operations` |
| 6.2 | A slow earlier result overwrites a newer one | Per-slot versioning; invalidation discards in-flight work | FIXED | `HF race` (4 cases) |
| 6.3 | A stale pool result populates a pool page the user has navigated away from | Slot invalidation on route change | FIXED | `HF race: a stale pool result cannot populate the current pool page` |
| 6.4 | `UNKNOWN` is auto-retried, double-spending a possibly-submitted operation | No generic retry control; `resubmissionAllowed` only on a proven `REJECTED` / `NOT_FOUND` | FIXED | `E2E:<all> the Activity page documents UNKNOWN as reconciling, not retryable` |
| 6.5 | A review is submitted with no verified identity | `liveExecutionIdentity` returning `undefined` aborts | FIXED | `HF toctou` (4 cases) |

## 7. Injection and content

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 7.1 | Raw HTML injection via metadata, labels, or errors | React text rendering only; no `dangerouslySetInnerHTML` | FIXED | `HF xss: the app never injects raw HTML` |
| 7.2 | `javascript:`, `data:`, or obfuscated scheme in an `href`/`src` | URL validator: https only, no credentials, length-bounded | FIXED | `HF urls: every non-http scheme is refused, including obfuscated forms` |
| 7.3 | Remote SVG carrying script is treated as a safe raster | Refused | FIXED | `HF urls: a remote SVG is not treated as a safe raster` |
| 7.4 | Bidi override or confusable character spoofs a token identity | `safeLabel`; identity is the exact address with the label adjacent | FIXED | `HF unicode: a confusable symbol never becomes the identity` |
| 7.5 | A secret or a file path is rendered in an error message | Fixed message set; the thrown text is never displayed | FIXED | `HF errors: a secret-bearing error is reduced to a code and a safe message` |
| 7.6 | NFT metadata document with `onerror`/`javascript:` is loaded | https-only loader, per-URL validation | FIXED | `E2E:<all> a hostile NFT metadata document cannot execute or inject` |
| 7.7 | The app writes diagnostics to the console | No `console.*` in `apps/web/src` | FIXED | `HF secrets: the app never logs to the console`, `E2E:<all> the app logs nothing to the console` |
| 7.8 | Explorer URL is constructed from an attacker-influenced tx id | Never constructed | FIXED | `HF explorer: no explorer URL is ever constructed` |

## 8. Deployment, headers, and supply chain

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 8.1 | Inline script or `eval` executes injected code | `script-src 'self'`; Vite emits a module script only | FIXED | `DEP csp` |
| 8.2 | The page is framed and clickjacked | `frame-ancestors` **is not** set in the meta CSP, because a meta CSP ignores it. The build emits the header; delivery depends on the host. | EXTERNAL_RISK (R-1) | `DEP csp`, `E2E:<all> the app logs nothing to the console` (page boots under policy) |
| 8.3 | The app is embedded by an untrusted origin | Same as 8.2. The allow-listed `https://universe.tari.mw` is **unverified** | EXTERNAL_RISK (R-2) | `DEP csp` |
| 8.4 | A private-network indexer becomes a build-time dependency | Build fails | FIXED | `DEP` endpoint cases |
| 8.5 | A dependency changes between review and deploy | `pnpm-lock.yaml` committed; `--frozen-lockfile` in both workflows | FIXED | CI `Node Tests` |
| 8.6 | The published package cannot be loaded by a consumer, or loads two module instances | Dual CJS/ESM build, correct `exports`, single-instance proof | FIXED | `PKG` (9), `INST` (10) |
| 8.7 | A placeholder adapter fabricates an account, tx id, or seed so the UI looks functional | All three placeholders refuse every state-bearing operation | FIXED | `adapter_honesty.test.cjs` |
| 8.8 | A route transition mutates a previously issued snapshot, so an old record can be replayed as current | `cloneRouteRecord` + deep freeze on every accepted transition | FIXED | `route_immutability.test.cjs` (8) |
| 8.9 | A browser 404s the favicon and logs to the console, polluting real signal | Icon shipped and declared | FIXED | `DEP manifest: the app ships an icon, so no browser gets a 404 for it` |
| 8.10 | Source maps leak internals | Published deliberately; documented in the artifact | FIXED (accepted) | `DEP` source-map cases, `dist/SOURCE_MAP_POLICY.txt` |

## 9. Policy and network

| # | Attack | Control | Status | Evidence |
|---|---|---|---|---|
| 9.1 | Mainnet is reachable by configuration | No mainnet configuration exists in the app | FIXED | `HF policy: mainnet is not configurable anywhere in the app` |
| 9.2 | **A mainnet provider is refused, but the refusal is invisible** — the message was only rendered inside the closed wallet-details dialog, so the user saw a dead button and no reason | `role="alert"` banner in the page | FIXED | `E2E:<all> a mainnet provider is refused and the page never reads as mainnet` |
| 9.3 | Mainnet is reached by switching the provider's network mid-session | Pinned-network comparison at connect; live re-derivation before signing | FIXED | `HF toctou: mainnet cannot be reached by switching the provider network` |
| 9.4 | Mainnet is reached by query parameter | The network is build-time configuration | FIXED | `E2E:<all> a query parameter cannot change the displayed network` |
| 9.5 | Real cross-chain submission is enabled from the URL | Build-time gate, mirrored and displayed | FIXED | `HF policy: the real cross-chain submit gate is mirrored, never bypassed`, `E2E:<all> the real-submit gate is displayed as off and cannot be set from the URL` |
| 9.6 | A developer fee skims from a trade | Exactly zero, and validated | FIXED | `HF policy: no developer trading fee is introduced` |
| 9.7 | Atomic SHA swaps are presented as available | Capability check surfaces the blocker, with no walletd fallback | BLOCKED_EXTERNAL (R-3) | `E2E:<all> the browser SHA swap blocker is shown, not a working button` |
| 9.8 | User is not warned that the software is experimental and unaudited | Stated in the shell footer and page description | FIXED | `DEP`, shell scan |

## 10. Accessibility and presentation

| # | Threat | Control | Status | Evidence |
|---|---|---|---|---|
| 10.1 | Focus is lost, so a keyboard user cannot reach the action | Visible focus ring; skip link is the first focus stop | FIXED | `DEP accessibility`, `E2E:<all> the skip link is the first focus stop` |
| 10.2 | Status is conveyed by colour alone | Every badge has text and a glyph; warnings are sentences | FIXED | `E2E:<all> critical status is not colour-only` |
| 10.3 | Layout breaks at narrow widths, hiding a rejection or a balance | Stylesheet; asserted at 360/390/1440 against the running app | FIXED | `DEP responsive`, three `E2E:<all>` overflow flows |
| 10.4 | A third-party link can reach back through `window.opener` | `rel="noopener noreferrer"` | FIXED | `E2E:<all> the TradingView attribution is present, linked, and opener-safe` |

---

## Rows deliberately not claimed

- **No live wallet, indexer, or chain interaction occurred.** Every network-level
  claim is traced from source or modelled with an injected provider. There is no
  evidence here about the behaviour of a real Minotari build.
- **No adversarial network timing, reorg, or mempool behaviour was tested.**
  `BLOCKED_TOOLING`.
- **No clickjacking exploit was attempted**, because the control is a response
  header the app does not itself deliver (R-1).
- **No claim of atomicity across layers.** Inherited from
  `CROSS_LAYER_HOSTILE_AUDIT_REPORT.md`; the browser leg is upstream-blocked.
