# Shadow Swap frontend completion record

**Status: COMPLETE for this pass — PR [#7](https://github.com/GSXRspartan/shadow-swap/pull/7), all 10 CI checks green.**
Not to be confused with the contract/protocol record, which lives in `OOTLE_V046_MIGRATION.md`
and `CHECKPOINT.md`. This file records the frontend, the asset question, and what
still needs an operator.

---

## 1. Starting point

| Item | Value |
|---|---|
| Branch started from | `feat/shadow-swap-frontend-redesign` (uncommitted WIP on top of `main`) |
| Base SHA | `1a21b9e` — "Merge pull request #6 from GSXRspartan/feat/v046-browser-marketplace-ux" |
| `origin/main` at start | `1a21b9e` (identical) |
| PR #5 | **MERGED** 2026-10-14 04:35 — Ootle v0.46 migration |
| PR #6 | **MERGED** 2026-10-14 06:33 — browser marketplace UX + Shadow Swap rebrand |
| Final branch HEAD | `3fadb83` |
| Final PR | [#7](https://github.com/GSXRspartan/shadow-swap/pull/7) → `main` |

Both foundation PRs were verified merged directly against the GitHub API, so this
work is built on `main`, not on a stale dependency. No rebase or reset was needed
and none was performed.

The WIP found on the branch was **preserved and finished**, not discarded. Three
genuine defects in it were fixed rather than reverted: a template literal written
as a plain string (inert placeholder rotation), a collection name truncating to a
mid-word fragment with no ellipsis, and the eyebrow chip stretching full-width
into what read as a stray rule.

---

## 2. Missing images: root cause, established not assumed

**No image file was ever deleted from this repository.** `git log --diff-filter=D`
over the full history shows the only deleted image-adjacent files were test
fixtures and a `package-lock.json`. `apps/web` has never carried raster assets
beyond the icons.

The missing pictures were **five separate real failures**, each invisible to the
suite that was supposed to catch it:

### 2.1 The NFT marketplace: a Content-Security-Policy that made the fetch impossible (fixed before this pass, verified here)

`connect-src` permitted only `'self'` plus the two indexers, so every collection
whose `metadataUri` lived on an IPFS gateway or Arweave was blocked at the fetch.
`img-src` was always permissive enough — the document simply never arrived. The
uncommitted WIP added the gateway origins; this pass verified the pairing is
enforced by test (`deployment.test.cjs` asserts the header matches the table in
`networks.ts`, both directions).

### 2.2 Marketplace discovery POSTed to a route that does not exist — the main one

`IndexerMarketplaceSource` was constructed with the **bare indexer origin** and
POSTed a `{query, params}` JSON-RPC-style document to it. The Ootle indexer
serves no such route:

```
POST  https://ootle-indexer-a.tari.com/            -> 404, no CORS headers
OPTIONS https://ootle-indexer-a.tari.com/           -> 404
OPTIONS https://ootle-indexer-a.tari.com/substates/fetch -> 200, ACAO: *
POST    https://ootle-indexer-a.tari.com/substates/fetch (batch shape) -> 200
```

Every marketplace query failed, the catch returned a fallback with no
collections, and the page asserted a chain as empty that has all three
marketplace templates published and readable. The prior tests could not catch it
because every one of them stubbed the protocol the live host does not speak.

The console error in the capture harness confirmed it independently:
`Access to fetch at 'https://ootle-indexer-a.tari.com/' … blocked by CORS policy`
— note the bare origin, not a path.

### 2.3 The social preview image was an SVG, which every scraper refuses

`og:image` and `twitter:image` pointed at `og-card.svg`. Twitter/X, Facebook,
LinkedIn, Slack and Discord all **reject SVG** for preview images and render the
card with no picture at all. A committed, reachable file that never appeared
anywhere. Now `og-card.png` at 1200×630 with explicit `og:image:width/height/
type/alt`; the SVG is retained for favicons and PWA use, where SVG is supported.

### 2.4 The homepage had no hero artwork at all

`/` redirected to `/pools`, so there was no homepage and nothing to render.
The landing page now exists and carries original artwork (§4).

### 2.5 Two false negatives presented as data

The homepage stat band rendered `market.discovery.pools.length`, which reads `0`
until discovery finishes and stays `0` on any error path — asserting "0 pools
discovered" about a pool this repository has verified on-chain. The pools page
had the same defect one level down: a header reading "0 pools" above a table
listing one component. Both are fixed; neither count is derived from a
background job any more.

**Recovered images:** none needed restoring — nothing public was ever lost.
The correct classification of every missing picture is #2 (present but broken by
paths/policy) or #5 (genuinely absent, now created). Category #4 (private/
unreleased) applies to nothing in this diff, verified by scan.

---

## 3. Chain evidence gathered this pass (2026-10-16)

All read-only, against the public Esmeralda indexer.

| Claim | Method | Result |
|---|---|---|
| Pool v2 is live and ownerless | `POST /substates/fetch component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2` | `owner_rule: "None"`; `template_address: f47a330eee…` (the pinned Pool v2) |
| Swap fee is 30 bps | decoded `state[2]` of the same component's `[pools, lp_resource, fee_bps, locked_lp_vault]` tuple | **30** — the homepage figure is chain-read, not doc-copied |
| Pool state shape matches the decoder | same read | 4-field tuple, as `poolSubstate.ts` requires |
| FixedPriceListing published | `GET /templates/612114e382c28205…` | 200 |
| ItemOffer published | `GET /templates/083fef7d75857d…` | 200 |
| CollectionBid published | `GET /templates/999ef37f1da524…` | 200 |
| Indexer identity | `GET /info` | `0.46.1`, `network: esmeralda`, `network_byte: 38` (0x26) |
| Catalogue omission is a red herring | `GET /templates/catalogue` | 20 entries, none of ours — but `/templates/{bare-hex}` answers 200 for all four. **Catalogue absence ≠ not published**; the component header is authoritative |
| A "list components by template" route | probed `/index`, `/rpc`, `/graphql`, `/query`, `/transactions` | none exist |

**Why no marketplace component is seeded.** A bounded receipt scan (4 000
receipts, 2 142 distinct components, back to epoch 12 212, current epoch 12 355)
surfaced **no** component carrying any of the three marketplace template
addresses. The three settlement lifecycles `OOTLE_V046_MIGRATION.md` records were
exercised through a local wallet daemon; they are real committed transactions,
but the resulting components are not discoverable from the public indexer today.
`MARKETPLACE_REGISTRY_SEED` is therefore **empty on purpose** and documented as a
chain fact. Adding an entry is a one-line change that is reverified on every
read, so a wrong or stale address degrades to "ignored", never to a wrong listing.

Receipt-scan pagination was also observed to be **non-monotonic in epoch order**
around pages 26–34 (12 225 → 12 238 → 12 231…), which is a further reason
receipt scanning alone cannot be trusted to enumerate anything. The pool
registry already exists for exactly this reason; the marketplace registry now
mirrors it.

---

## 4. Original imagery and Meshy usage

| Item | Detail |
|---|---|
| MCP status | `@meshy-ai/meshy-mcp-server` connected and working (verified with a free balance read: 908 credits available) |
| Jobs run | **2** text-to-image jobs, `nano-banana-2`, 16:9 |
| Credits consumed | **12** (6 + 6) — inside the approved cap of 3 jobs / 50 credits |
| Approval | Explicitly granted by the operator before either job was submitted |
| Output 1 | Hero backdrop — abstract liquidity curves converging on a priced node over depth-of-market ladders. Committed as `apps/web/public/hero-liquidity.webp`, **35 290 bytes** from a 1 062 945-byte source (FFmpeg lanczos, q82) |
| Output 2 | OG/social card — centred symmetrical convergence geometry. Committed as `og-card.webp` (32 102 B) and `og-card.png` (277 864 B, 1200×630) |
| Inspection | Both inspected visually before shipping; both match the brief (dark charcoal, Tari green, teal, restrained violet, no text/character/mascot/silhouette) |
| Style | `assets.test.cjs` enforces the budget: decorative full-bleed art < 250 kB, any raster asset < 1.5 MB |

**Confidentiality:** the artwork is pure abstract geometry. No character, no
mascot, no animal, no face, no silhouette, and nothing derived from any private
design. A scan of the full diff for character/mascot/cross-product references
returns clean, and the README's "Shadow Swap and Atomic Swap" section was
**removed** as a disclosure this repository should not publish.

---

## 5. Frontend changes

**Design system** (`tokens.css`, `global.css`): brand/teal/violet trio with a
documented job each (interaction, liquidity surfaces, NFT marketplace), six
surface steps, AA text tokens with the ratios stated in comments, tabular
figures wherever a number renders, `forced-colors` and `prefers-reduced-motion`
support.

**Landing page** (`/`): states only figures that are independently checkable —
30 bps (chain-read), 0 admin keys (`owner_rule: None`, chain-read), 4 published
templates (HTTP 200 × 4), Esmeralda byte 38 (`/info`). No TVL, APR, volume,
trade count or pool count, because a testnet has no honest source for them.

**Honesty fixes:** the pools header now describes the rows below it ("1 pool
component discovered" when a wallet is needed to decode reserves); health is
derived once in `AppContext` instead of twice with different rules (the page
badge and header badge disagreed on the live network); the marketplace page
renders **one** notice instead of the two contradictory ones it showed before,
and never leaks a raw `TypeError: Failed to fetch` to a user.

**Rendering defects fixed:** inert placeholder rotation (plain-string template
literal), mid-word truncation without an ellipsis, stretched eyebrow chip,
duplicated TESTNET badge (one per breakpoint now, travelling with the network
name), header overlap at 360/390 px, clipped search input at 360 px.

**Marketplace discovery** (`OotleIndexerMarketplaceSource` + `marketplaceRegistry.ts`):
reads the chain through the routes that actually exist, re-verifies every
candidate against its own header template, decodes with the protocol-client's
dual-form decoders, counts undecodable components, and distinguishes "empty"
from "could not read". An optional `VITE_NFT_DISCOVERY_URL` still selects the
old `{query, params}` source for an operator-run service.

---

## 6. Wallet integration status

Nothing in the durable-approval security boundary changed. Specifically
preserved and re-tested: live `window.tari` object identity by reference,
provider implementation fingerprint, network pinning, account re-derivation,
fail-closed capability checks, `shown == signed` over serialised instructions,
authoritative rereads, raw BigInt amounts, and the market-data trust boundary.

| Item | Status |
|---|---|
| `tari-provider-conformance.test.cjs` | 63 pass |
| `wallet-conformance.spec.ts` (e2e) | 25 pass |
| All ten browser conformance scenarios | pass, including provider replacement, account/network switch, user rejection (4001), not-connected (4100), unsupported method (4200) |
| `CallFunction` wire spelling | unit-asserted (`marketplace-actions.test.cjs`: `{ CallFunction: { address, function, args } }`, address = the pinned FixedPriceListing template) |
| **LIVE WALLETD VERIFIED** | prior sessions (see `OOTLE_V046_MIGRATION.md`) — create→buy, offer→accept, bid→fill, pool swap, all committed on Esmeralda |
| **REAL BROWSER WALLET VERIFIED** | **NOT DONE — BLOCKED**, no Tari browser extension is installable in this environment |

### Exact manual steps to close the real-extension gap

1. Install the Tari browser extension (Sapient) in Chromium and let it inject `window.tari`.
2. Build and serve locally with the production configuration:
   `pnpm --filter @tari-ootle/web build && pnpm --filter @tari-ootle/web exec vite preview --host 127.0.0.1 --port 4188`
   (serve the built bundle — the CSP under test is the shipped one, and `--host 127.0.0.1`
   is required because `vite preview` binds `::1` first on IPv6-preferring hosts).
3. Open the preview URL, press **Connect wallet**, and approve in the extension.
   Record: the account, the network the extension reports, and the `tari_getNetwork` /
   `tari_getCapabilities` replies.
4. Prepare **one** Esmeralda-only swap on the live Pool v2 component
   (`component_8c20c6448cd1d9840a1506d27166fb82621a67f5d1604ed03435c0d0a92c59a2`).
   Before submitting, verify the review screen shows the expected `CallFunction`
   — that is the wire-spelling check that has only ever been unit-asserted.
5. Approve **in the extension**, by hand. Do not submit without the operator's
   own approval of that exact transaction.
6. Reconcile: confirm the committed receipt, reread the pool reserves through the
   wallet, and record the tx id, fee, and pre/post reserves in `LIVE_TESTNET_EVIDENCE.md`.
7. Record the strict testnet fee ceiling observed, and whether
   `tari_submitTransactionRequest` accepted the persisted `requestId` after a
   page reload (the durable-approval property that `requestTransaction()` cannot provide).

**Nothing in this pass claims real browser-wallet verification.** The distinction
between reference-provider verification (done) and real extension verification
(blocked) is maintained throughout.

---

## 7. Test evidence

| Suite | Count | Result |
|---|---|---|
| `pnpm -r typecheck` | — | clean |
| `pnpm -r test` | **714** — web 435, protocol-client 258, wallet-adapter 21 | pass, 0 fail |
| Playwright **all projects, `--retries=0`** | **278** | pass, 0 fail |
| of which new: `marketplace-discovery.test.cjs` | 18 | pass |
| of which new: `assets.test.cjs` | 11 | pass |
| GitHub CI (PR #7) | 10/10 checks | **green** — web, protocol-client, wallet-adapter, browser-security ×2, engine-tests ×2, protocol-client ×2, wallet-adapter ×2 |

Baseline at start: web **405 pass / 1 fail**, e2e reported "259 passed" **with
retries enabled**. Two things changed and both matter:

- The 1 failing web test was expectation drift (the NFT placeholder copy had
  changed); the test was updated to assert the new contract **and strengthened**
  (now also asserts no `<img>` is emitted for an unvalidated URL).
- The e2e count moved from 259 (retries on) to 278 (retries off) because flaky
  retries had been masking failures. Two real spec bugs were exposed and fixed:
  specs asserting the literal old copy `/No collections/`, and one pinning the
  brand link's `href` to `/pools` after it correctly moved to `/`. Both specs
  now assert the property rather than the implementation detail, and the
  anti-fabrication assertions were kept and strengthened.

**Rust engine tests remain CI-only** (`audit_engine_tests` cannot build on
Windows — Cranelift). They are green in CI on this PR, which is the only place
they can run.

Secret scan on the full diff (49 files): clean — no API key, token, private key,
password or credential-shaped literal. `.claude/` (local agent config) is
git-ignored and was never staged.

---

## 8. Deployment status

**No site is being served.** `https://ootle-liquidity-testnet.pages.dev` does not
resolve (NXDOMAIN). The deploy workflow is correctly built for this — manual
`workflow_dispatch` only, three-way gated (explicit project confirmation,
credential fail-closed, pinned project name) with pre-deploy artifact checks and
a post-deploy `verify:live-headers` command printed for the operator.

**BLOCKED on operator credentials.** To deploy:

1. Add repository secrets `CLOUDFLARE_API_TOKEN` (scoped `Account / Cloudflare
   Pages / Edit` for this project only) and `CLOUDFLARE_ACCOUNT_ID`.
2. Dispatch `.github/workflows/cloudflare-pages.yml` with
   `confirm_project: true` and a reason.
3. Run the printed `pnpm --filter @tari-ootle/web run verify:live-headers <url>`
   against the deployment, and record the observed headers.

Nothing was deployed, and no DNS or hosting change was made.

---

## 9. Remaining blockers and recommended next milestone

| # | Blocker | Owner |
|---|---|---|
| 1 | Real `window.tari` extension approval + `CallFunction` wire spelling against a deployed provider | Operator (steps in §6) |
| 2 | Cloudflare Pages deployment (NXDOMAIN today) | Operator (steps in §8) |
| 3 | Seed `MARKETPLACE_REGISTRY_SEED` with real marketplace component addresses once any are instantiated from the three published templates | Next agent — one line each, self-verifying |
| 4 | NFT artwork for real collections — blocked on real metadata existing on-chain; the identity-fingerprint placeholder is the correct fallback until then | Next agent |

**Recommended next milestone:** close #1 and #2 (both are operator actions with
written steps), then #3 the moment a real marketplace component exists on chain —
at which point the marketplace grid fills with real, reverified data and the
eight browser marketplace operations become exercisable end to end through the UI.

**LIVE CHAIN VERIFIED** · **LIVE WALLETD VERIFIED (prior sessions)** ·
**REFERENCE PROVIDER VERIFIED** · **E2E/UNIT VERIFIED** · **REAL BROWSER WALLET: BLOCKED**