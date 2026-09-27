# Frontend and browser security invariants

Scope: the browser client and everything it loads, signs, renders, persists, or
claims. These invariants are the contract the audit defends. Each names the code
that enforces it and the test that would fail if it broke.

Evidence keys:

- `HF` = `apps/web/test/hostile-frontend.test.cjs` (module-level, Node)
- `DEP` = `apps/web/test/deployment.test.cjs` (built artifact, Node)
- `PKG` = `packages/protocol-client/test/packaging.test.cjs`
- `E2E:<project>` = `apps/web/e2e/security.spec.ts`, run against the production
  bundle. Projects: `chromium-desktop`, `chromium-mobile`, `firefox-desktop`
  (the last is CI-only; see `FRONTEND_RESIDUAL_RISKS.md` R-9)
- `INST` = `apps/web/test/instance-identity.test.cjs`

A test that exercises a module directly proves the module is correct. It does
**not** prove the module is on the path. Where a control could be bypassed by
wiring, an `E2E` row is the one that counts. See `FRONTEND_HOSTILE_AUDIT_REPORT.md`
§2 for the one time this distinction hid a real defect.

---

## 1. Execution identity

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-I1** | **A review is bound to the exact provider object that was present when it was created, and to nothing else.** | `captureIdentity` stores `providerRef` by reference; `verifyIdentity` compares `expected.providerRef !== live.provider` before any other field. A page script may install a `window.tari` of any shape; only object identity is accepted. | `HF spoof: a provider with the right shape is not accepted without a capability handshake`, `HF identity: a replaced provider object is detected by reference`, `E2E:<all> a provider replaced mid-session is refused at authorization, not trusted` |
| **FI-I2** | **The live identity is re-derived at authorization time, never replayed from the connect-time snapshot.** | `TariBridgeWalletAdapter.liveIdentity` re-resolves the provider via `getTariProvider()` and re-fetches capabilities. It must not return `this.provider` or `this.capabilities`. | `HF liveIdentity: the bridge reads the CURRENT provider and capabilities, not the connect-time cache` |
| **FI-I3** | **A provider implementation swap is detected, including a method inherited from the prototype chain.** | `providerFingerprint` hashes own function *source*, own primitives, and the prototype constructor name, so an inherited `request` is distinguishable from an own one. | `HF spoof: swapping the provider implementation on the same object is detected`, `HF spoof: a provider that inherits its request method is still fingerprinted` |
| **FI-I4** | **A capability downgrade after the handshake is detected.** | `capabilityFingerprint` over the sorted advertisement; compared live. A capability with no recognisable flag counts as NOT ADVERTISED. | `HF spoof: a capability downgrade after the handshake is detected`, `HF identity: a capability downgrade after approval is detected`, `E2E:<all> a provider that downgrades its capabilities cannot keep an enabled control` |
| **FI-I5** | **A review from a previous wallet session can never be re-authorized.** | Per-session nonce issued at connect; `verifyIdentity` checks the nonce first and reports `changed: 'nonce'`. | `HF spoof: a replayed review from a previous session is refused`, `HF identity: a stale review from a previous session cannot be re-authorized` |
| **FI-I6** | **A provider that has been removed, or that stops answering, throws. It never yields an empty identity.** | `getTariProvider` throws `NOT_INJECTED` / `MALFORMED_REPLY`; `liveIdentity` lets the throw propagate. | `HF spoof: getTariProvider throws a typed refusal rather than returning a stub`, `HF spoof: isTariInjected rejects a provider without a callable request`, `E2E:<all> a provider that cannot answer the capability handshake is not used` |
| **FI-I7** | **A provider may not answer anything outside the allow-listed method set.** | `TARI_METHODS` allow-list in `tariWindow.ts`; anything else is refused before a request is issued. | `HF spoof: only allow-listed Tari methods are callable` |
| **FI-I8** | **Identity verification runs immediately before EVERY signing call, not once per session.** | `executeSwap` calls `verifyIdentity` inside the submission path, so it cannot be hoisted into a mount effect. | `HF toctou: an account switch between review and approval aborts`, `HF toctou: a network switch between review and approval aborts`, `HF toctou: a stale review is refused even when nothing else changed` |
| **FI-I9** | **A connection refusal is visible in the page, not only in a closed dialog.** | `AppShell` renders `wallet.error` as a `role="alert"` banner whenever `wallet.status === 'ERROR'`. | `E2E:<all> a mainnet provider is refused and the page never reads as mainnet` |

## 2. "Shown == signed"

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-R1** | **The request the provider is asked to sign is the frozen request generated from the review, sent verbatim.** | `ExecutionWallets.signAndSubmit(preview, context, reviewedRequest)` requires the reviewed request; `TariBridgeWalletAdapter.signAndSubmitReviewed` passes it to the provider. No reconstruction from the preview, and no fallback. | `HF signing: the reviewed request is required and is sent verbatim, not re-derived`, `HF signing: execution passes the reviewed request and requires it to be frozen` |
| **FI-R2** | **The review and its wallet request are deeply frozen, and are verified frozen at signing time.** | `freezeDeep` in `createReview`; `executeSwap` refuses on `Object.isFrozen` for both. A mutable review would make FI-R3..R5 statements about the past. | `HF integrity: a review cannot be edited after the user approves it`, `HF signing: execution passes the reviewed request and requires it to be frozen` |
| **FI-R3** | **An AMM review is diffed against the intent with the AMM rules: pool, operation, settlement account, every instruction amount, and `min_output` against the actual call argument.** | `diffReviewAgainstIntent` in `lib/review.ts`; dispatched by `diffReviewForIntent`. | `HF integrity: the review is built from the intent, and the diff is clean`, `HF integrity: a tampered review is detected by the differential check` |
| **FI-R4** | **A marketplace review is diffed against the intent with the marketplace rules: target order, settling account, NFT id and resource, every fungible amount, the called method, and the wallet request contents.** | `diffReviewAgainstMarketplaceIntent`. A marketplace intent has no `poolComponent` and no `settlement`, so reusing the AMM rules reported a mismatch on every NFT trade and blocked the feature. | `HF review: a marketplace differential rejects a review bound to the wrong account`, `...rejects a tampered amount`, `...rejects a review for a different order`, `HF review: a marketplace intent is diffed with the marketplace rules` |
| **FI-R5** | **The review names the signer, never an asset.** | `NftDetailPanel` binds `account` to `wallet.account` and refuses when it is absent. It previously used a ternary with two identical branches and always bound the input asset's resource address. | `HF review: an NFT review is bound to the signer, not to the asset` |
| **FI-R6** | **A gate that can never fail is not a gate.** | `execution.ts` contains no self-comparison. The removed `reviewFingerprint(r) !== reviewFingerprint(r)` always evaluated false while reading as an instability check. | `HF signing: the removed tautology cannot come back` |
| **FI-R7** | **A review with no named amounts, network, account, or operation id is refused before the user sees an offer.** | `createReview` validation. | `HF integrity: a review with no named amounts is refused`, `HF integrity: a review must name its network, account, and operation id` |
| **FI-R8** | **A zero `min_output` is refused before the user ever sees the offer.** | Resolver and `deriveMinOutput` in the protocol-client; the frontend never computes it. | `HF integrity: a zero min_output is refused before the user ever sees an offer` |
| **FI-R9** | **The secret-bearing coordination module is unreachable from the frontend.** | `mintTerminalSettlementProof` / `verifyTerminalSettlementProof` / `CrossChainSecretStore` and the coordination entry points `revealAndClaim`, `beginL1Funding`, `acceptQuote`, `applyRouteEvent` are absent from the built bundle. | `DEP secrets: the built bundle contains no secret-bearing protocol code`, `INST` (all 10 cases) |

## 3. Amounts

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-A1** | **A display value can never become an execution input.** | `asRawExecutionAmount` / `asResourceAddress` in `lib/tradeBoundary.ts` reject anything that is not already a raw integer string or an exact address. | `HF boundary: a display value can never become a review amount`, `DEP boundary: no display-formatted price is fed into an execution input` |
| **FI-A2** | **No `Number` participates in any amount conversion.** | `amountInput.ts` converts with string operations and BigInt only. | `HF integrity: a decimal-shift is impossible because no Number is involved` |
| **FI-A3** | **Trailing zeros do not shift the scale.** A decimal shift is a silent 10^N change in a transferred amount. | `parseDecimalToRaw` scales on the fractional digit count, not on numeric value. `"1.0"` at 6 decimals is `1000000`, not `1`. | `HF amounts: the hostile input corpus behaves as specified` |
| **FI-A4** | **Excess precision is refused, never rounded.** | `parseDecimalToRaw` rejects more fractional digits than the asset supports. | `HF amounts: excess precision is refused, never rounded` |
| **FI-A5** | **Amounts are exact at and beyond the IEEE-754 safe integer range, bounded at 2^128-1.** | BigInt throughout; `requireRaw` in the client. | `HF amounts: 2^53, 2^64, and 2^128 boundaries survive exactly`, `HF amounts: display -> input -> raw is lossless for every supported divisibility` |
| **FI-A6** | **A zero-decimal asset cannot take a fraction.** | `parseDecimalToRaw` with `decimals === 0` rejects any fractional part. | `HF amounts: a zero-decimal asset cannot take a fraction` |
| **FI-A7** | **A hostile numeric string is refused, not parsed.** | Length bound plus strict character class before conversion. | `HF amounts: a huge malicious numeric string is refused, not parsed` |
| **FI-A8** | **A non-integer or unbounded provider-reported amount is refused.** | `tariWindow` balance validation; a lowercase `committed` status is mapped to `COMMITTED`, and anything unrecognised to `UNKNOWN` rather than to a guess. | `HF spoof: a balance reply with a non-integer amount is refused` |
| **FI-A9** | **The frontend does not reimplement AMM or route math.** | No constant-product or reserve arithmetic in `apps/web/src`. | `DEP boundary: the frontend does not reimplement AMM or route math` |

## 4. Market data is never execution data

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-M1** | **Hostile chart data cannot reach a resolver input.** | `MarketDataService.bundleFor` is not an `AuthoritativeSubstateReader`; resolvers take the wallet readback. | `HF poisoning: hostile chart data cannot reach a resolver input`, `HF poisoning: a display price is never consumed by the exact rational path` |
| **FI-M2** | **A market-data health claim cannot make an execution source authoritative.** | Health is a display type with no resolver role. | `HF poisoning: a market-data health claim cannot make an execution source authoritative` |
| **FI-M3** | **A malformed, non-monotonic, or future-dated candle is refused at the display boundary.** | Chart bucket validation raises `ChartBasisError`. | `HF poisoning: a future-dated or malformed candle is refused at the display boundary` |
| **FI-M4** | **An unconnected metric reads as unavailable, never as zero.** | `UNAVAILABLE` sentinel; the pools table renders an em dash. | `E2E:<all> pool discovery renders both pools with the full metric set` |
| **FI-M5** | **A failed discovery is never presented as an empty result.** A failure is not an authoritative zero. | `PoolsPage` suppresses the count and names the failure when `unavailableReason` is set. It previously showed "Pool discovery unavailable" directly above "0 pools". | `E2E:<all> an indexer outage produces an explicit unavailable state, not an empty list` |
| **FI-M6** | **A hostile discovery payload cannot inject script, and an unknown safety classification is not treated as vetted.** | Strict descriptor parser; React text rendering only. | `E2E:<all> a hostile discovery payload cannot inject script or break the layout` |
| **FI-M7** | **No fixture data is compiled into the production bundle.** | `__OOTLE_ENV__` replaced at build time; `FIXTURE_*` markers absent from the artifact; the dev fixtures are unreachable from a shipped flag. | `DEP fixtures` (2 cases), `DEP policy: the development fixtures cannot be enabled by a shipped flag` |

## 5. Storage

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-S1** | **The live read path is the validating parser.** Every displayed record passes `validateOperationRecord`, which rebuilds the record from an allow-list so unknown fields cannot survive. | `history.ts` calls `loadHistoryPayload`. It previously did `JSON.parse` plus an `operationId` type check. | `HF persisted history: the live read path is the validating parser, not a raw JSON.parse`, `E2E:<all> a tampered operation record is dropped, not displayed` |
| **FI-S2** | **A malformed amount fails the whole record closed.** Dropping the field reads as "zero" or "unknown" to someone deciding whether their money moved. | `validateOperationRecord` returns `undefined` on a bad amount. | `HF storage: a tampered amount, resource, or txid is dropped rather than coerced` |
| **FI-S3** | **A record carrying a secret field is dropped outright, not sanitised.** | `SECRET_FIELD_NAMES` in `storage.ts`. | `HF storage: a record carrying a secret field is dropped outright` |
| **FI-S4** | **A persisted `CONFIRMED` is a claim, not a fact.** | `trustLevel` returns `CLAIMED_BY_STORAGE` until an authoritative lookup agrees. | `HF storage: a tampered CONFIRMED record is downgraded to a claim`, `E2E:<all> a tampered confirmation is shown as a claim, not as settled` |
| **FI-S5** | **Freshness is never restored from storage, so a tampered readback cannot be replayed.** | `loadHistoryPayload` does not carry a freshness field. | `HF storage: freshness is never restored, so a tampered readback cannot be replayed` |
| **FI-S6** | **The payload is size-bounded and the record count is capped.** | 4 MiB input cap and `MAX_RECORDS` in `loadHistoryPayload`. | `HF storage: the record count is bounded so a huge payload cannot exhaust memory`, `HF storage: a corrupt or oversized payload is reported, not silently emptied` |
| **FI-S7** | **Records that fail validation are reported, not silently dropped.** | `historyIntegrity` returns `ok: false` with the rejected count. | `HF persisted history: the live read path is the validating parser, not a raw JSON.parse` |
| **FI-S8** | **Exactly two storage keys exist, and neither holds secrets.** | `storageInventory`. | `HF storage: the inventory declares exactly two keys and neither holds secrets`, `DEP` (storage scans) |
| **FI-S9** | **No secret is ever written to storage.** | End-to-end check against the running app. | `E2E:<all> no secret is ever written to storage` |

## 6. Secrets

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-X1** | **No secret-bearing protocol field is read, logged, or rendered by the app.** | The proof module is not bundled; no call site exists. | `HF secrets: no secret-bearing protocol field is read, logged, or rendered by the app` |
| **FI-X2** | **A secret-shaped error is reduced to a code and a fixed message from this app.** The thrown text is never rendered. | `lib/errorMessage.ts`. | `HF errors: a secret-bearing error is reduced to a code and a safe message`, `HF errors: the message is always a fixed string from this app, never the thrown text` |
| **FI-X3** | **The app logs nothing to the console.** | No `console.*` in `apps/web/src`. | `HF secrets: the app never logs to the console`, `E2E:<all> the app logs nothing to the console` |
| **FI-X4** | **The bundle contains no secret material.** Preimage field *names* ship inside the validator that refuses them, so the rule is on values, not identifiers. | `DEP secrets: preimage names may appear only as rejection rules, never with a value`. | `DEP secrets: preimage names may appear only as rejection rules, never with a value` |
| **FI-X5** | **No preimage, seed, mnemonic, or private key is named outside the detector and validator modules.** | Source scan with an explicit two-module exemption. | `DEP secrets: no secret-bearing protocol field is read, logged, or rendered by the app` |

## 7. Submission

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-C1** | **A rapid double click cannot create two durable operations, on any submission path.** | `submitGuard` ref claimed before the first await and released in `finally`, in `SwapCard`, `LiquidityPanel`, and `NftDetailPanel`. State alone is `false` until the re-render. | `HF double submit: every submission path uses a synchronous in-flight guard`, `E2E:<all> a rapid double submit cannot create two durable operations` |
| **FI-C2** | **A stale async result can never overwrite a newer one.** | `asyncGuard` versions per slot; invalidation discards everything in flight. | `HF race: a slow old result cannot overwrite a newer one`, `...a stale pool result cannot populate the current pool page`, `...invalidation discards everything in flight` |
| **FI-C3** | **The swap control is bound to a resolver result, and no result exists without an authoritative reread.** | `SwapCard` enables only on a `READY` resolution. | `E2E:<all> swap is refused without an authoritative pool reread`, `...a hostile market-data price cannot reach the swap control` |
| **FI-C4** | **A submission with no verified live identity is refused.** | `liveExecutionIdentity` returning `undefined` aborts with "Not submitted". | `HF toctou` (4 cases) |

## 8. Policy

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-P1** | **Mainnet is not reachable by configuration, by provider, or by query string.** | `checkNetwork` allow-list; the pinned network is compared to the provider's; the badge is derived from configuration. | `HF policy: mainnet is not configurable anywhere in the app`, `HF spoof: a provider that claims mainnet after connecting is refused by the network guard`, `E2E:<all> a mainnet provider is refused and the page never reads as mainnet`, `...mainnet is never offered as a network anywhere in the UI`, `...a query parameter cannot change the displayed network` |
| **FI-P2** | **Real cross-chain submission is mirrored from build-time configuration and cannot be flipped from the URL.** | The gate is a build-time literal, and the UI states it. | `HF policy: the real cross-chain submit gate is mirrored, never bypassed`, `E2E:<all> the real-submit gate is displayed as off and cannot be set from the URL` |
| **FI-P3** | **The developer trading fee is exactly zero.** | `buildRouteFees` returns `'0'`. | `HF policy: no developer trading fee is introduced` |
| **FI-P4** | **The browser SHA-swap blocker is displayed as a blocker, with no local-wallet fallback.** | Capability check; the UI states the requirement. | `E2E:<all> the browser SHA swap blocker is shown, not a working button` |
| **FI-P5** | **`UNKNOWN` reconciles by durable identifier and is never blindly retried.** | `reconcileOperation` sets `resubmissionAllowed` only on a proven `REJECTED` / `NOT_FOUND`. No generic retry control is rendered. | `E2E:<all> the Activity page documents UNKNOWN as reconciling, not retryable` |

## 9. Supply chain and module identity

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-D1** | **The frontend cannot accidentally link a second copy of the protocol client.** | Single instance proven by scanning the built bundle for the module-private brand symbol and the route state machine. | `INST` (all 10 cases) |
| **FI-D2** | **The published package contract is loadable as CommonJS and as ESM, with a correct `./crosschain` subpath.** | Dual build; `type: module` marker; extensionless ESM re-exports. | `PKG` (9 cases) |
| **FI-D3** | **The install is reproducible.** A manifest/lockfile disagreement fails CI. | `pnpm-lock.yaml` committed; `--frozen-lockfile` in both workflows. | CI `Node Tests` |
| **FI-D4** | **A placeholder adapter never fabricates financial state.** | `BrowserExtensionWalletAdapter`, `WalletDaemonAdapter`, and `EmbeddedOotleWalletAdapter` report unsupported and throw for every state-bearing operation. | `packages/wallet-adapter/test/adapter_honesty.test.cjs` |
| **FI-D5** | **A route transition cannot mutate a previously issued snapshot.** | `cloneRouteRecord` + `deepFreezeRouteRecord` in `applyRouteEvent`. | `packages/protocol-client/test/route_immutability.test.cjs` (8 cases) |

## 10. Presentation

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-U1** | **The app never injects raw HTML.** | React text rendering only; no `dangerouslySetInnerHTML`. | `HF xss: the app never injects raw HTML` |
| **FI-U2** | **Every `href`/`src` comes from the URL validator, never from raw data.** | `safeImageUrl` / link validator: https only, no credentials, length-bounded, obfuscated schemes refused, remote SVG refused. | `HF urls: every non-http scheme is refused, including obfuscated forms`, `...a remote SVG is not treated as a safe raster`, `HF xss: every href/src comes from the URL validator, never from raw data` |
| **FI-U3** | **A confusable symbol never becomes the identity.** | `safeLabel`; identity is the exact address, with the label shown alongside a tooltip. | `HF unicode: a confusable symbol never becomes the identity` |
| **FI-U4** | **Token metadata containing markup, quotes, bidi overrides, or long strings is neutralised.** | `safeLabel` + length caps. | `HF unicode: token metadata with markup, quotes, and long strings is neutralised` |
| **FI-U5** | **Critical status is never colour-only.** | Every `Badge` carries a text label and a glyph; a warning is a sentence. | `E2E:<all> critical status is not colour-only` |
| **FI-U6** | **Focus is always visible and the skip link is the first focus stop.** | Stylesheet; skip link precedes the nav in DOM order. | `DEP accessibility: focus is always visible and the skip link exists`, `E2E:<all> the skip link is the first focus stop` |
| **FI-U7** | **No horizontal overflow at 360, 390, or 1440 px.** | Responsive stylesheet; asserted against the running app. | `DEP responsive: the stylesheet handles the narrow widths in scope and never overflows`, `E2E:<all> the mobile layout has no horizontal overflow at 390px`, `...the desktop layout has no horizontal overflow at 1440px`, `...the smallest supported width does not overflow` |
| **FI-U8** | **Third-party attribution is present, linked, and opener-safe.** | TradingView link with `rel="noopener noreferrer"`. | `E2E:<all> the TradingView attribution is present, linked, and opener-safe` |
| **FI-U9** | **The app ships an icon, so no browser receives a 404 for it.** | `public/icon.svg`, declared in `index.html` and the manifest. | `DEP manifest: the app ships an icon, so no browser gets a 404 for it` |

## 11. Deployment

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **FI-T1** | **The meta CSP omits `frame-ancestors`, because a meta CSP silently ignores it.** Declaring it there would be false assurance. | `index.html` comment plus the absence of the directive. | `DEP csp` (all cases) |
| **FI-T2** | **The intended response headers are generated by the build and are reviewable in the repository.** | `write-deployment-headers.mjs` emits `dist/_headers`; CI asserts the file and the directive exist. | `DEP csp`, CI "Verify the deployment headers were emitted" |
| **FI-T3** | **The app loads nothing from a CDN and no inline script.** | `script-src 'self'`; Vite emits a module script and nothing else. | `DEP csp` |
| **FI-T4** | **A configured indexer that resolves to a private network address fails the build** rather than shipping a localhost dependency. | `localEndpointReason`. | `HF policy`, `DEP` (endpoint cases) |
| **FI-T5** | **Source maps are published deliberately, not by accident,** and the decision is stated in the artifact. | `dist/SOURCE_MAP_POLICY.txt`. | `DEP` source-map cases |

**Not established by any test in this file:** FI-T2 is necessary but not
sufficient. Whether the headers are actually *delivered* is a property of the
host, not the build, and is tracked as `FRONTEND_RESIDUAL_RISKS.md` R-1.
