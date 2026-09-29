# Deployment security matrix

Every row is classified. There are no `UNKNOWN` rows: where evidence does not
exist, the row says so and says why.

**Scope of evidence.** The frontend's hosting, headers, CSP, and the browser
security boundaries, assessed at commit `8ef3d03` on
`feat/live-testnet-productization`. The bundle hashed in A–3 was served to a
real browser and the policy was observed being enforced. Rows added at `8ef3d03`
are marked **NEW**.

**Headline:** R-1 is **NOT closed**. The configuration and the policy semantics
are proven and the deployment is now fully prepared, but delivery from a live
deployment URL is not, because no Cloudflare account is reachable from this
environment. R-13 is open. R-4 is reclassified (see section 6); R-14 is new.

---

## 1. Response headers and transport

| # | Control | Class | Evidence |
|---|---|---|---|
| D-1.1 | A real `Content-Security-Policy` **response** header is emitted (not a meta tag) | FIXED | `dist/_headers`, `DEP csp: the generated response headers include...` |
| D-1.2 | The emitted `_headers` uses the grammar a static host actually parses | FIXED | Previously prose-as-indented-line with unindented headers — never parsed by anything. `DEP headers file: the emitted syntax is what Cloudflare Pages actually parses` |
| D-1.3 | `X-Content-Type-Options: nosniff` is sent | FIXED | `E2E:hosting the SPA document at / carries the security headers` |
| D-1.4 | `Referrer-Policy: no-referrer` is sent | FIXED | Same; resource addresses must not leak via referrer |
| D-1.5 | `Permissions-Policy` denies camera, microphone, geolocation, payment, usb, serial, bluetooth | FIXED | Same; `DEP` asserts every feature is denied |
| D-1.6 | `Cross-Origin-Opener-Policy: same-origin-allow-popups` is sent | FIXED | Same. Governs top-level contexts only, so it does not interfere with the wallet framing this app |
| D-1.7 | `Cross-Origin-Resource-Policy` is not `same-origin` | FIXED | `same-origin` is enforced on cross-origin document loads and would block the wallet iframe. `DEP csp: CORP is not same-origin` |
| D-1.8 | `X-Frame-Options` is **omitted** deliberately | FIXED | Cannot express a cross-origin allow-list; `SAMEORIGIN` would block the wallet and `ALLOW-FROM` is obsolete. `DEP csp: X-Frame-Options is omitted deliberately` |
| D-1.9 | `Cross-Origin-Embedder-Policy` is not enabled | FIXED | COEP would require every cross-origin subresource to opt in, breaking the wallet connector and NFT media. Recorded in `DELIBERATELY_OMITTED_HEADERS` |
| D-1.10 | HTTPS on the deployment, and `upgrade-insecure-requests` in the policy | BLOCKED_EXTERNAL | The directive is authored. No deployed URL exists to query, so HTTPS enforcement is unobserved |
| D-1.11 | **The headers are actually delivered by the live deployment** | **EXTERNAL_RISK (R-1)** | Configuration authored, policy semantics proven in-browser against an enforcing server, and the deployment path prepared. **Delivery from a real URL is unverified** |
| D-1.12 | **NEW** — `connect-src` is derived from the same network table the client resolves, not written out independently | FIXED | Previously two hand-maintained strings. `DEP csp: connect-src covers exactly the configured esmeralda indexer origins` |
| D-1.13 | **NEW** — `dist/_redirects` emits `/* /index.html 200`, so deep SPA routes resolve directly on the host | FIXED | `DEP spa: the build emits an explicit SPA fallback as a 200 rewrite, not a redirect`. A 30x would have made `/pools` — the deep route the clickjacking test depends on — not directly checkable |
| D-1.14 | **NEW** — `dist/_redirects` carries no header rules and cannot weaken the policy | FIXED | `DEP spa: the redirects file carries no header rules, so it cannot weaken the policy` |
| D-1.15 | **NEW** — a live-origin verifier exists and refuses a non-HTTPS origin | FIXED | `DEP live-headers verifier: it refuses a non-https origin, because R-1 needs HTTPS`. `apps/web/scripts/verify-live-headers.mjs`, read-only, exits non-zero on any mismatch |

## 2. Clickjacking

| # | Control | Class | Evidence |
|---|---|---|---|
| D-2.1 | `frame-ancestors` is a real response header, absent from the meta CSP | FIXED | `index.html` asserts the meta tag does not claim it; a meta CSP silently ignores it |
| D-2.2 | An untrusted cross-origin page cannot frame the app | FIXED | `E2E:hosting clickjacking › an untrusted origin cannot frame the app` — the browser's own `frame-ancestors` refusal, from a genuine cross-origin attacker page |
| D-2.3 | The refusal also holds on a deep SPA route, not just the entry point | FIXED | `E2E:hosting clickjacking › the refusal holds on a deep SPA route` — a host protecting only `/` would pass a shallow check |
| D-2.4 | The app is still framable by the wallet's dApp frame | BLOCKED_EXTERNAL | The policy allows it; the wallet iframe could not be exercised without a wallet |

## 3. CSP enforcement, observed in a real browser

All against the production bundle, served with the policy enforced.

| # | Attack | Class | Result |
|---|---|---|---|
| D-3.1 | Unapproved external script origin | FIXED | Blocked. Browser reports `script-src` |
| D-3.2 | Inline `<script>` element | FIXED | Blocked. Browser names `script-src 'self' https://universe.tari.mw` and the missing nonce/hash |
| D-3.3 | Unapproved frame (`frame-src`) | FIXED | Blocked, no document committed |
| D-3.4 | Unapproved `connect-src` target | FIXED | Blocked, fetch rejects |
| D-3.5 | `javascript:` URL | FIXED | Does not execute |
| D-3.6 | Non-https image scheme (`blob:`, `ftp:`, `file:`) | FIXED | Blocked |
| D-3.7 | Arbitrary **https** image | N/A_BY_CONSTRUCTION | `img-src ... https:` is deliberate: NFT media is attacker-controlled and must render. The control for that case is per-URL `safeImageUrl` validation, not CSP. Asserting CSP would block it would be asserting something the policy intentionally does not do |
| D-3.8 | The app still boots and functions under its own policy | FIXED | `E2E:hosting the production bundle boots and renders with the enforcing server` — the regression against a CSP too strict to run the product |
| D-3.9 | `unsafe-eval` never introduced | FIXED | `DEP csp: the script policy names the wallet connector origin and nothing wider` |
| D-3.10 | No wildcard or bare Tari domain in any origin allow-list | FIXED | Same test; the wallet origin stays exactly pinned |

## 4. Provider origin and trust

| # | Control | Class | Evidence |
|---|---|---|---|
| D-4.1 | The provider is untrusted and compared by object identity | FIXED | `HF identity: a replaced provider object is detected by reference` |
| D-4.2 | Live identity is re-derived at authorization, never replayed | FIXED | `HF liveIdentity: the bridge reads the CURRENT provider and capabilities`; `E2E a provider replaced mid-session is refused at authorization` |
| D-4.3 | The wallet connector origin is allowed in `script-src`, pinned | FIXED | `DEP csp: the script policy names the wallet connector origin and nothing wider` |
| D-4.4 | The exact connector injection mechanism (script element vs postMessage-only) | **EXTERNAL_RISK (R-13)** | The repository documents a cross-origin connector loaded into this document. The precise mechanism was not observable here, so the `script-src` allowance is a documented requirement, not an observed fact |
| D-4.5 | A real wallet connection, capability handshake, and account/network switch | BLOCKED_EXTERNAL | No Tari wallet is installed and `window.tari` cannot be provided outside the wallet's own dApp frame. All provider evidence is from an injected double |

## 5. Build reproducibility and supply chain

| # | Control | Class | Evidence |
|---|---|---|---|
| D-5.1 | One canonical pnpm version, declared in four agreeing places | FIXED | `docs/DEPENDENCY_POLICY.md`; `packageManager`, `engines.pnpm`, both workflows, local env all 9.15.9 |
| D-5.2 | `pnpm install --frozen-lockfile` in all CI jobs | FIXED | Verified passing locally; both workflows |
| D-5.3 | A single authoritative lockfile | FIXED | `package-lock.json` removed — a stale npm lockfile declaring a different resolution. Closes R-12 |
| D-5.4 | No known production dependency vulnerabilities | FIXED | `pnpm audit --prod --audit-level low`: none |
| D-5.5 | A single React runtime; module identity proven | FIXED | `INST` (10 cases) |
| D-5.6 | The published package contract loads as CJS and ESM | FIXED | `PKG` (9 cases) |
| D-5.7 | Hosting build matches the CI-verified build | EXTERNAL_RISK | `wrangler.jsonc` and `docs/TESTNET_HOSTING.md` pin output dir, Node, pnpm, and the build command. Not yet exercised by a real deployment |
| D-5.8 | The deployment runs the commit CI tested | BLOCKED_EXTERNAL | No deployment performed. SHA recorded in §3 for the commit that was tested |

## 6. Testnet / mainnet gating

| # | Control | Class | Evidence |
|---|---|---|---|
| D-6.1 | Mainnet is not configurable anywhere in the app | FIXED | `HF policy: mainnet is not configurable anywhere in the app` |
| D-6.2 | Mainnet is refused by provider, by mid-session switch, and by query parameter | FIXED | 3 E2E flows plus `HF toctou: mainnet cannot be reached by switching the provider network` |
| D-6.3 | The real cross-chain submit gate is build-time and cannot be flipped from the URL | FIXED | `E2E the real-submit gate is displayed as off and cannot be set from the URL` |
| D-6.4 | The deployment does not secretly enable the gate | FIXED | `wrangler.jsonc` declares no environment variables at all; the gate is a build literal |
| D-6.5 | The browser SHA-swap blocker stays visible, with no walletd fallback | FIXED | `E2E the browser SHA swap blocker is shown, not a working button` |

## 7. Endpoint trust and Ootle states

| # | Control | Class | Evidence |
|---|---|---|---|
| D-7.1 | Indexer data is never an execution source | FIXED | `HF poisoning` (4 cases) |
| D-7.2 | A private-network indexer URL fails the build | FIXED | `DEP` endpoint cases |
| D-7.3 | **Stale** Ootle state is displayed as stale | FIXED | Resolver `STALE` refuses submission; `HF` and component assertions |
| D-7.4 | **Degraded / unavailable** Ootle is displayed honestly, never as zero | FIXED | `E2E:hosting with the real indexer unreachable` — the outage path, with nothing intercepted: shows "Pool discovery unavailable" and "Pool list unavailable", never "0 pools", zero table rows, no fixture marker |
| D-7.5 | No fabricated pools, candles, balances, or NFTs while Ootle is down | FIXED | Same test, plus the NFT-page equivalent; `DEP` bundle scans for `FIXTURE_*` |
| D-7.6 | Real **read** access to the Ootle chain (epoch, network identity, resources, transactions) | **FIXED at `8ef3d03`** | Verified live 2026-09-28 against `ootle-indexer-a`/`-b.tari.com`: `tari_indexer` 0.41.4, network `esmeralda`, byte `38`, epoch `11602`, 147,754 receipts. `docs/LIVE_TESTNET_EVIDENCE.md` |
| D-7.7 | The configured indexer origin's **network identity is verified before discovery content is trusted** | **FIXED at `8ef3d03`** | `apps/web/src/services/indexerIdentity.ts`; `OUT discovery: a wrong-network endpoint never reaches the discovery query`. Name **and** byte checked; the byte is required because the name is a self-assertion |
| D-7.8 | A wrong-network or unverifiable endpoint produces a typed refusal, never an empty list | **FIXED at `8ef3d03`** | `OUT identity: …` (9 cases: right name/wrong byte, other network, unnamed, no byte, non-object, array, hostile markup, unreachable, malformed origin) |
| D-7.9 | `UNREACHABLE` is worded so it cannot be read as "the network is down" | **FIXED at `8ef3d03`** | `OUT identity: UNREACHABLE says nothing about the network being down` |
| D-7.10 | An empty protocol deployment is distinguished from an indexer outage | **FIXED at `8ef3d03`** | `OUT discovery: a verified endpoint returning a real empty list is an empty list, not a refusal`. This repository's templates are unpublished, which is the empty case |
| D-7.11 | Real pool discovery of **our** pools | **BLOCKED_EXTERNAL** | Our four templates are not published on Esmeralda (four catalogue queries, zero entries). Requires a publication step; no pool is faked meanwhile. R-14 |
| D-7.12 | Discovery query convention matches the live indexer's API shape | **OPEN (R-14)** | Discovery issues `POST {base} {"query":"pool_discovery"}`; the live indexer is REST and answers `404`. Reported honestly as unavailable. No shim, because a shim would mean injecting fabricated records |
| D-7.13 | Indexer origins are browser-reachable without a relay | **FIXED at `8ef3d03`** | Observed `access-control-allow-origin: *` on both origins; `connect-src` lists them explicitly, so the CSP is a real restriction rather than a formality |

## 8. Browser, account, and storage boundaries

| # | Control | Class | Evidence |
|---|---|---|---|
| D-8.1 | **F-01** persisted history is validated on the live read path | FIXED | `HF persisted history: the live read path is the validating parser, not a raw JSON.parse` |
| D-8.2 | F-01 payload classes rejected by the production bundle: invalid amount, secret field, wrong state | FIXED | `E2E a tampered operation record is dropped, not displayed` (forged amounts and a `preimage` field), `E2E a tampered confirmation is shown as a claim, not as settled` |
| D-8.3 | F-01 oversized payload rejected | FIXED | `HF storage: the record count is bounded so a huge payload cannot exhaust memory` (4 MiB input cap, record cap) |
| D-8.4 | Rejected records are reported, not silently dropped | FIXED | `HF persisted history: the live read path is the validating parser` — `historyIntegrity` returns the rejected count |
| D-8.5 | **F-02** shown == signed, at the provider boundary | FIXED | `HF F-02: the provider receives the reviewed request itself, byte for byte` — a recording provider, deep-cloned at call time, compared against the review |
| D-8.6 | The reviewed request has a single source and is deeply frozen | FIXED | `HF F-02: the request is derived from the review`; mutation of a nested arg throws |
| D-8.7 | F-02 with a **real** wallet signing prompt | BLOCKED_EXTERNAL | No wallet available. The provider boundary is proven with a recording double, not a real wallet |
| D-8.8 | **F-05** provider replacement refused at authorization | FIXED | `E2E a provider replaced mid-session is refused at authorization, not trusted`; `HF liveIdentity: the bridge reads the CURRENT provider` |
| D-8.9 | Capability downgrade refused | FIXED | `E2E a provider that downgrades its capabilities cannot keep an enabled control` |
| D-8.10 | Rapid double submit creates one operation | FIXED | `HF double submit: every submission path uses a synchronous in-flight guard`; `E2E a rapid double submit cannot create two durable operations` |
| D-8.11 | No secret written to storage or the console | FIXED | `E2E no secret is ever written to storage`; `E2E the app logs nothing to the console` |
| D-8.12 | `UNKNOWN` reconciles by durable id, never blind-retries | FIXED | `E2E the Activity page documents UNKNOWN as reconciling, not retryable` |

## 9. Real transaction execution

| # | Control | Class | Evidence |
|---|---|---|---|
| D-9.1 | A real ordinary L2 testnet swap, end to end | BLOCKED_EXTERNAL | No funded testnet wallet, no reachable pool, no wallet provider |
| D-9.2 | Real add / remove liquidity | BLOCKED_EXTERNAL | Same |
| D-9.3 | Real NFT buy / offer / bid | BLOCKED_EXTERNAL | Same; and no owned test NFT fixtures |
| D-9.4 | Atomic XTM route remains gated behind the upstream browser SHA blocker | N/A_BY_CONSTRUCTION | Upstream capability does not exist; surfaced as a blocker, never bypassed. No walletd fallback |
| D-9.5 | Real `UNKNOWN` reconciliation from a lost submission response | BLOCKED_EXTERNAL | Requires a real submission |

## 10. Responsive and accessibility

| # | Control | Class | Evidence |
|---|---|---|---|
| D-10.1 | 390 px mobile viewport, no horizontal overflow | FIXED | `E2E the mobile layout has no horizontal overflow at 390px` |
| D-10.2 | 360 px narrowest supported width | FIXED | `E2E the smallest supported width does not overflow` |
| D-10.3 | 1440 px desktop | FIXED | `E2E the desktop layout has no horizontal overflow at 1440px` |
| D-10.4 | Skip link is the first focus stop | FIXED | `E2E the skip link is the first focus stop` |
| D-10.5 | Status never colour-only | FIXED | `E2E critical status is not colour-only` |
| D-10.6 | A real phone browser, real device | BLOCKED_TOOLING | No device farm or physical handset |
| D-10.7 | Firefox cross-engine | BLOCKED_TOOLING | CI-only. Not installed locally; on this GPU-less host the Playwright Firefox build's software WebRender exhausts memory across a full run (`wr_renderer_render: OutOfMemory`), failing a different test by contention. Not claimed as passing |
| D-10.8 | WebKit / Safari, screen reader, axe | BLOCKED_TOOLING | Not in the harness |

## 11. Rust engine tests

| # | Control | Class | Evidence |
|---|---|---|---|
| D-11.1 | Security Engine Tests (host-side template harness) | BLOCKED_TOOLING | `cargo test` fails to compile on this platform: `wasmer-compiler-cranelift` emits `compile_error!("The Cranelift compiler backend is not supported on Windows. Use the V8 backend instead.")`. Pre-existing and platform-level, not a code defect |

---

## Totals

Counted from the rows above, at `8ef3d03`.

| Class | Count |
|---|---|
| PASS (verified working) | 0 |
| FIXED (control implemented and regression-proven) | 66 |
| N/A_BY_CONSTRUCTION | 2 |
| EXTERNAL_RISK | 3 |
| BLOCKED_EXTERNAL | 10 |
| BLOCKED_TOOLING | 4 |
| OPEN (real gap, accepted and documented) | 1 |
| **UNKNOWN** | **0** |
| **Total rows** | **86** |

Open CRITICAL: **0**. Open HIGH: **1** (D-1.11 / R-1).

Counts are of rows, not of distinct problems. The `8ef3d03` pass moved **6 rows
from `BLOCKED_EXTERNAL` to `FIXED`** because the Ootle indexer turned out to be
reachable after all and its identity is now verified (D-7.6 through D-7.10,
D-7.13), added 4 rows for the CSP/`connect-src` derivation, the SPA rewrite, the
`_redirects`/policy separation, and the live-origin verifier (D-1.12–D-1.15), and
added **1 row the previous state could not have had** — D-7.12 / R-14, a genuine
protocol mismatch that only became *visible* once the endpoint began answering.
Being able to see a defect is not the same as being free of it; the row is
recorded as `OPEN`, not moved.

The 10 remaining `BLOCKED_EXTERNAL` rows cluster into four causes: no real wallet
provider, no deployed URL, no published protocol templates, and no physical
device. The 66 `FIXED` rows likewise cluster, and several rows exist because one
underlying fix needed asserting from more than one angle (for example F-02 is
asserted at the provider boundary, at the request-derivation level, and at the
freeze level).

**No row is `UNKNOWN`.** Where evidence does not exist, the row says so and says
why. Historical attack matrices elsewhere in `security/` are kept as historical
records and are deliberately not rewritten to suggest that an earlier condition
never existed.
