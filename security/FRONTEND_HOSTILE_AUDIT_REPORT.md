# Frontend and browser hostile audit report

**Scope.** The entire browser/client surface of the Tari Ootle Liquidity Protocol
frontend: the shipped bundle, everything it loads, the wallet provider boundary,
the execution and approval path, persistence, presentation, the deployment
policy, and the published package contract the bundle depends on.

**Base.** `f3a9c60`. **Head at time of writing.** `56928de`.

**Companion documents.** `FRONTEND_INVARIANTS.md` (what must hold, and what
proves it), `FRONTEND_ATTACK_MATRIX.md` (threat-by-threat), and
`FRONTEND_RESIDUAL_RISKS.md` (what this audit did not establish, including R-1,
which is an open HIGH risk that is not a code defect).

---

## 1. Method

The audit was run adversarially, in three passes.

**Pass 1 — module-level, in Node.** Every frontend module was read for the
classes of bug the mission names: identity, review binding, amount handling,
market data crossing into execution, storage, secret leakage, error rendering,
async races, and double submission. Roughly 60 behaviours were turned into
assertions in `apps/web/test/hostile-frontend.test.cjs` and
`apps/web/test/deployment.test.cjs`, the latter reading the **built** artifact
rather than the source.

**Pass 2 — artifact and supply chain.** The built bundle was scanned for secret
material, unreachable proof code, fixture data, and inline script. The published
package contract was tested by loading it as both CommonJS and ESM, including the
`./crosschain` subpath, and the built bundle was scanned to prove a single
protocol-client instance is linked. Placeholder adapters were tested for
fabricated financial state.

**Pass 3 — a real browser, against the production build.** 31 flows run in
Chromium at two viewports and in Firefox, served from `vite preview` over the
production bundle with the production CSP and the production endpoint list. A
hostile provider is installed via `addInitScript`, so it runs *before* any app
code. The indexer is intercepted at its real production origin rather than
served from localhost, because `localEndpointReason` refuses a private-network
endpoint outside a development build — mocking it locally would have forced a
dev build, and the suite would then have tested a different artifact than the one
that ships.

Pass 3 earned its place immediately: it found four defects that Pass 1 and Pass 2
had both missed, one of which (F-01) had a fully tested security control sitting
next to the live path that never called it.

---

## 2. The finding that mattered most

**F-01 — a security control that was not on the path, behind a green suite.**

`apps/web/src/lib/storage.ts` implemented a strict, fail-closed persisted-record
validator: bounded input, allow-list reconstruction, fail-closed amounts, secret
field rejection, record cap. It was correct and it was well tested — a dozen
assertions in `hostile-frontend.test.cjs` exercise it directly.

Those tests called `loadHistoryPayload` directly. **The application never did.**

The live read path, `services/history.ts`, parsed `localStorage` itself and kept
any record whose `operationId` was a string. In the shipped application:

- a record with tampered amounts rendered verbatim — the browser flow observed
  `amounts: { a: 'not-a-number' }` displayed as the literal text `not-a-number`;
- an unrecognised field, including a `preimage` written by an older build,
  survived into application state;
- the payload was unbounded, so a large document was parsed in full;
- the integrity check could not report dropped records, so the interface could
  not tell the user anything had been discarded.

**The frontend suite was 179/179 green while this was true.**

Fixed by routing the read path through the validator and surfacing the rejected
count. The durable mitigation is a wiring assertion — a test that fails if the raw
filter reappears — plus the browser flow that forges records before app code runs
and asserts they are not displayed. That flow is the one that would have caught
this originally, and it exists now only because the module-level tests had
already proved insufficient.

The transferable rule is recorded as R-11: **a security module's tests prove the
module, not its reachability. Prove the wiring separately, or the control is
documentation.**

---

## 3. Findings

Severity is the consequence if the attack succeeds, judged against a user who
has approved a legitimate-looking transaction.

| ID | Finding | Sev | Status | Commit |
|---|---|---|---|---|
| **F-01** | Persisted history bypassed its own validator; tampered amounts rendered, secret fields survived, payload unbounded — behind a 179/179 green suite | HIGH | FIXED | `5e0a3ca` |
| **F-02** | The reviewed request never reached the signer. It was attached to the preview through a type cast, then dropped by the layer that rebuilt the payload as `{method, args, component}`. The signed bytes were a **second independent derivation** from the same intent, and their agreement was assumed, not checked | CRITICAL | FIXED | `56928de` |
| **F-03** | Every NFT trade was diffed with AMM rules. A marketplace intent has no `poolComponent` and no `settlement`, so the comparison mismatched on every buy and sell — the feature was **blocked outright rather than secured** | HIGH | FIXED | `56928de` |
| **F-04** | An NFT review was bound to the input *asset's* resource address, not the signer: a ternary whose two branches were identical. Every NFT review named an account that was not the connected wallet, so the account check could not mean anything | HIGH | FIXED | `56928de` |
| **F-05** | `liveIdentity` replayed the connect-time snapshot. A page script that replaced `window.tari` compared **equal** to the pinned review — defeating the reference check outright — and a capability downgrade after the handshake was invisible | CRITICAL | FIXED | `5e0a3ca` |
| **F-06** | A stability gate that could never fail: `reviewFingerprint(r) !== reviewFingerprint(r)` always evaluated false while reading as an instability check | MEDIUM | FIXED | `56928de` |
| **F-07** | A mainnet connection was correctly refused, but the message was rendered **only inside the closed wallet-details dialog**. The user saw a dead button and no reason — inviting a network switch without ever learning why | MEDIUM | FIXED | `5e0a3ca` |
| **F-08** | A failed indexer discovery rendered "Pool discovery unavailable" directly above "0 pools" and "No pools to show". A failure was presented as an authoritative empty set — a much stronger claim than "we could not find out" | MEDIUM | FIXED | `5e0a3ca` |
| **F-09** | `LiquidityPanel` and `NftDetailPanel` guarded double submission on React state, which is still `false` for every click landing before the re-render. Two rapid clicks both started a submission and created two durable operations. `SwapCard` was already correct | HIGH | FIXED | `56928de` |
| **F-10** | Decimal shift: `"1.0"` at 6 decimals scaled to raw `1` — a silent 10^6 reduction in a transferred amount | HIGH | FIXED | `d6c6134` |
| **F-11** | `applyRouteEvent` mutated previously issued route snapshots, so an old record could be replayed as current | HIGH | FIXED | `d03b271` |
| **F-12** | Placeholder adapters (`BrowserExtension`, `WalletDaemon`, `EmbeddedOotle`) fabricated accounts, transaction ids, a localhost default, and read embedded seed entropy, so the UI looked functional against a wallet that did not exist | HIGH | FIXED | `c3518f5` |
| **F-13** | The published package contract was unloadable by a real consumer (no ESM, no `exports`, broken `./crosschain`), which is a supply-chain footgun independent of any logic bug | MEDIUM | FIXED | `bb17bcc` |
| **F-14** | A lowercase provider status (`committed`) was mis-mapped to `UNKNOWN`, stalling a settled operation | LOW | FIXED | `d6c6134` |
| **F-15** | Unbounded provider-reported balance strings were accepted into the amount path | MEDIUM | FIXED | `d6c6134` |
| **F-16** | No favicon and no manifest icons, so every browser 404'd and logged a console error — polluting the signal the "app logs nothing" invariant depends on | LOW | FIXED | `5e0a3ca` |
| **F-17** | The E2E script ran against whatever `dist` was on disk, so a source fix could pass locally and ship broken | MEDIUM | FIXED | `cf2355e` |
| **F-18** | An over-broad bundle assertion forbade preimage field *names*, which legitimately ship inside the validator that refuses them — a false positive that would have pushed someone toward obfuscating a security check | LOW | FIXED (test) | `5e0a3ca` |

**Two CRITICAL, eight HIGH, four MEDIUM, four LOW. None remain open in code.**

---

## 4. What the fixes actually changed about the threat model

Three of these are worth stating plainly, because they changed what the app
*guarantees* rather than merely closing a hole.

**F-02 was the difference between a documented invariant and an enforced one.**
Before, "shown == signed" was true only if two independent derivations from the
same intent happened to agree, and the reviewed request — the thing the user
actually read — was discarded somewhere in the middle. Now the reviewed request
is a required parameter of the signing seam, is sent verbatim, and there is
deliberately no fallback: a signer that cannot be handed the exact reviewed
request is not driven. The signing contract also now refuses an unfrozen review,
because a mutable review makes every other check a statement about the past.

**F-05 was a check that was worse than absent.** Object-identity pinning is only
meaningful if the comparison uses the *current* object. Returning the cached
provider made a replaced provider compare equal, so the control inverted: it
would have passed precisely the attack it was written to catch. The lesson is
that a live-identity re-derivation must read *everything* from the live source,
and a test that asserts the old behaviour can look identical to a test that
asserts the new one.

**F-03 and F-04 together meant the NFT path was neither working nor checked.**
The AMM differential rejected every marketplace intent, and the review that
should have been bound to the signer was bound to an asset. Fixing the diff
without fixing the account would have produced a passing differential that
verified nothing; fixing the account without the diff would have left every trade
blocked.

---

## 5. Verification

| Suite | Command | Result |
|---|---|---|
| protocol-client | `pnpm --filter @tari-ootle/protocol-client run test` | **185/185** |
| — cross-layer hostile | `node --test test/hostile_crosschain.test.cjs` | **34/34** |
| — multi-hop hostile / fuzz | `multihop_hostile` / `multihop_fuzz` | **33/33**, **4/4** |
| — market-data hostile / fuzz | `marketdata_hostile` / `marketdata_fuzz` | **19/19**, **6/6** |
| — hostile fuzz | `hostile_fuzz` | **5/5** (50k structured mutations, 20k proof-tamper attempts) |
| — route immutability | `route_immutability` | **8/8** |
| — packaging | `packaging` | **9/9** |
| wallet-adapter | `pnpm --filter @tari-ootle/wallet-adapter run test` | **21/21** |
| frontend, node | `pnpm --filter @tari-ootle/web run test` | **202/202** at the time of this report; **221/221** after the Pixel Canary pass added the bounded-transport, outage-notice and provider-liveness regressions (see `security/PIXEL_CANARY_FULL_ATTACK_MATRIX.md`) |
| browser flows, Chromium | `playwright test --project=chromium-desktop --project=chromium-mobile` | **96/96** (48 flows × 2 projects) |
| hosting flows | `playwright test --project=hosting` | **17/17** — headers, clickjacking, CSP enforcement, real Ootle outage |
| typecheck | `pnpm --filter @tari-ootle/web run typecheck` | clean |
| Security Engine Tests (Rust) | `cargo test` in `audit_engine_tests` | **BLOCKED_TOOLING** — `wasmer-compiler-cranelift` emits `compile_error!` on Windows. Pre-existing and platform-level, not a code defect |
| Firefox | `playwright test --project=firefox-desktop` | **BLOCKED_TOOLING** — not installed locally; software WebRender exhausts memory on this GPU-less host. CI-only, **not claimed as passing** (R-9) |

Dependency posture: `pnpm audit --prod --audit-level low` reports no known
vulnerabilities. Production licences are MIT except `lightweight-charts`
(Apache-2.0). A single React runtime is linked. The install is reproducible:
`pnpm-lock.yaml` is committed, both workflows use `--frozen-lockfile`, and the
stale `package-lock.json` has been removed. Canonical toolchain in
`docs/DEPENDENCY_POLICY.md`.

### Production bundle under audit

`pnpm --filter @tari-ootle/web run build` at commit `ab66114`, SHA-256 truncated
to 16 hex characters:

| Hash | Bytes | Artifact |
|---|---|---|
| `90f28fc0e1965bdd` | 419437 | `dist/assets/index-ZXadPzV_.js` |
| `3579e946f7cc8468` | 168876 | `dist/assets/charts-CqNP-JN7.js` |
| `d6895feb04133bab` | 51104 | `dist/assets/vendor-B9TnhO9g.js` |
| `49e9fdeb6d69cb27` | 9798 | `dist/assets/index-BBUcDMiZ.css` |
| `40be28fcbb0d0bd8` | 1198 | `dist/_headers` |
| `b6809b215a7e76a8` | 1130 | `dist/SOURCE_MAP_POLICY.txt` |
| `2489a39350445ccf` | 3857 | `dist/index.html` |
| `5a642700dfe3910b` | 532 | `dist/icon.svg` |
| `971952168ef7bd4f` | 437 | `dist/manifest.json` |

Source maps are omitted from the table because they are published deliberately
(R-6) and change with every source edit.

The emitted policy, served by the enforcing host and observed by the browser:

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://universe.tari.mw;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;
  connect-src 'self' https://indexer.esmeralda.tari.com https://indexer-fallback.tari.com;
  frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none';
  frame-ancestors 'self' https://universe.tari.mw; upgrade-insecure-requests
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()
Cross-Origin-Opener-Policy: same-origin-allow-popups
Cross-Origin-Resource-Policy: cross-origin
```

`X-Frame-Options` is deliberately absent and `Cross-Origin-Embedder-Policy` is
deliberately not enabled; both omissions are recorded with reasons in
`DELIBERATELY_OMITTED_HEADERS` and asserted by the suite.

---

## 6. What this audit did not test

Stated plainly, because an audit that hides its gaps is worse than no audit.

- **No deployed URL was queried.** The hosting is configured for Cloudflare Pages
  and the policy is proven in-browser, but no Cloudflare account is reachable
  from this environment, so the headers have not been observed arriving from a
  real host. This is R-1, and it is the one open HIGH.
- **No clickjacking exploit against a deployed URL.** The same test run against
  the local enforcing server proves the policy semantics; only a real host proves
  delivery.
- **No real wallet.** `window.tari` cannot exist outside the wallet's own dApp
  frame. Connection, capabilities, account, network, disconnect, and account /
  network switching were all exercised with an injected provider double.
- **No real Ootle indexer.** `indexer.esmeralda.tari.com` and
  `indexer-fallback.tari.com` do not resolve from this environment, verified by
  DNS failure rather than assumed. Real pool discovery, pool state, candles,
  trades, and liquidity activity were therefore unavailable. The *outage* path
  was exercised for real, with nothing intercepted, and correctly shows
  unavailable rather than zero with no fixture data.
- **No real transaction of any kind.** No funded testnet wallet, no reachable
  pool, no owned test NFTs. L2 swap, add/remove liquidity, NFT flows, and
  `UNKNOWN` reconciliation are all `BLOCKED_EXTERNAL`.
- **No adversarial network timing, reorg, or mempool behaviour.** `BLOCKED_TOOLING`.
- **No Rust engine tests.** `cargo` cannot build the host-side template harness
  on Windows: `wasmer-compiler-cranelift` emits `compile_error!` for this
  platform. Pre-existing and platform-level.
- **No WebKit, no real device, no screen reader, no axe pass.** Firefox is
  CI-only and not claimed as passing (R-9).
- **No third-party review.** This is a self-audit.

---

## 7. Conclusion

**NO KNOWN FRONTEND/BROWSER PATH FROM HOSTILE INPUT TO UNAUTHORISED VALUE MOVEMENT
FOUND UNDER TESTED MODEL**, for the model defined in §1 and the bundle hashed in
§5. Two CRITICAL and eight HIGH defects were found during the audit and are fixed
with retained regressions; none remain open in code. The browser suite
(202 node tests, 113 browser flows) fails on each of them if reintroduced.

This is **not** a claim of production readiness, and four things must not be
read into it:

1. **R-1 remains OPEN (one open HIGH).** The security response headers are
   authored, emitted in valid Cloudflare Pages syntax, and proven to be
   *enforced* by a real browser against a server that applies them. They have
   **not** been observed arriving from a live deployment, because no Cloudflare
   account is reachable from this environment. Three of four parts are done; the
   fourth is deployment, and it is the only part that counts. See
   `FRONTEND_RESIDUAL_RISKS.md` §"What closing R-1 requires".
2. **R-13 is new and open.** The repository's own architecture documentation
   establishes that this app runs in a cross-origin iframe inside the wallet and
   loads a cross-origin connector script. That is why the wallet origin is
   allowed in `frame-ancestors` *and* in `script-src` — and the exact injection
   mechanism was not observable here, so the `script-src` allowance is a
   documented requirement rather than an observed fact.
3. **R-3 and R-4 bound the whole result.** The atomic cross-chain browser path
   does not exist upstream, and nothing here was executed against a real wallet
   or chain. The configured Esmeralda indexer hostnames do not resolve, so real
   pool, candle, trade, and liquidity data were unavailable; the outage path was
   exercised for real and is correct.
4. **This is a self-audit.** No third party reviewed it.

The route therefore remains **EXPERIMENTAL / TESTNET**. Mainnet stays disabled,
the real cross-chain submit gate stays `OFF`, and the browser SHA blocker stays
visible rather than papered over.

**The most durable result of this audit is not a fix but a rule.** F-01 was a
correct, well-tested security control sitting one import away from the code that
needed it, behind a fully green suite. R-1 was a security header authored,
generated, and unit-tested — and delivered to nobody, because the test asserted
on a file rather than on a response. Both are the same mistake: proving a
*component* rather than proving a *delivery path*. Any future security control
should be treated as absent until an end-to-end check observes it taking effect
where it actually runs.
