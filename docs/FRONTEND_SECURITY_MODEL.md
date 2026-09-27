# Frontend security model

How the browser client is allowed to behave, and why. This is the design
document; the audit results are in `security/FRONTEND_HOSTILE_AUDIT_REPORT.md`.

Status: **EXPERIMENTAL / TESTNET**. Mainnet is disabled. The real cross-chain
submit gate is `OFF`.

---

## 1. Trust boundary

```
  untrusted                         trusted by this app
  ---------------------------------------------------------------------------
  anything the indexer returns       nothing, for execution purposes
  anything in localStorage           nothing; displayed only as a claim
  anything the user types            nothing until parsed to an exact integer
  ---------------------------------------------------------------------------
                     |
     +---------------+----------------+
     |  window.tari  (the provider)    |  <- the ONLY component that can move value
     +---------------------------------+
```

The provider is **not** trusted. It is a transport that the app verifies on every
use. It is not a source of truth: the app re-reads chain state through it, and it
is compared by object identity before anything is signed.

Three consequences follow, and they explain most of the code:

1. **The provider can be hostile.** A page script can install a `window.tari` of
   any shape before the app runs, or replace it mid-session, or swap its `request`
   implementation. Nothing in the app assumes good faith. See FI-I1..I9.
2. **The indexer can be hostile.** Pool discovery, NFT discovery, and market data
   are untrusted input, parsed strictly and never used as execution data. See
   FI-M1..M7.
3. **`localStorage` can be hostile.** The user or another script can write
   anything. Records are validated, rebuilt from an allow-list, and displayed as
   claims. See FI-S1..S10.

**What the app trusts:** its own code, the exact strings it parsed, the
arithmetic it performed on BigInt, and the values the user typed after strict
parsing. Nothing else.

## 2. The three rules everything else serves

**R-1. Shown == signed.** The request the provider signs is the frozen request
generated from the review the user approved, sent verbatim. There is no second
derivation and no fallback. Enforced by FI-R1..R9.

This is the invariant the audit found to be documented-but-not-enforced twice
(F-02: the reviewed request was dropped before it reached the signer; F-06: a
gate that compared a value with itself). It is stated here because it is the one
rule that, if broken, loses user funds directly.

**R-2. An approval is bound to a specific identity.** A review is bound to the
provider *object*, its implementation fingerprint, the network, the account, the
advertised capabilities, and a session nonce. All of it is re-derived live
immediately before every signature. Any change aborts and says which field
changed. Enforced by FI-I1..I9.

**R-3. Market data is never execution data.** Prices, volumes, and health from
the indexer are display-only. Resolvers re-read authoritative state through the
provider, and the market bundle is structurally not a resolver input. Enforced by
FI-M1..M7.

A fourth rule is not an invariant but a policy, and it is absolute: **a failure is
never rendered as an authoritative value.** Not a zero, not an empty set, not a
"0 pools" list, not a `—`. F-08 existed because this was violated on one screen.

## 3. Why the browser re-implements nothing

The app contains no constant-product math, no reserve arithmetic, no
`min_output` derivation, and no route pricing. Those live in
`packages/protocol-client`, which is the only thing allowed to decide what a
transaction does. The browser contributes strict parsing, identity verification,
review construction, and presentation.

This is enforced, not aspirational: FI-A9 asserts the absence of the arithmetic,
and FI-A1 makes any attempt to feed a display value into an execution input a
typed refusal rather than a coercion.

The reason is auditability. Code that only parses and compares can be read
exhaustively. Code that computes money is a second implementation of the rules,
and two implementations disagree.

## 4. Amounts

Every amount crosses the boundary as an exact raw integer string, bounded at
2^128-1, produced by string and BigInt operations with no `Number` anywhere in
the path. Display values and raw values are different types with different
functions between them; there is no conversion that goes the wrong way.

The subtlest bug this prevents is a **decimal shift** (F-10): `"1.0"` at 6
decimals is `1000000`, not `1`. Scaling on the numeric value rather than the
fractional digit count is a silent 10^6 error in a transferred amount, and no
type system catches it. FI-A3 is a regression on exactly this.

Excess precision is refused rather than rounded, in either direction. Rounding
is a decision about someone else's money that the app has no basis to make.

## 5. Secrets

The frontend never holds a preimage, seed, private key, or wallet service
credential, and the module that would mint or verify one is not bundled at all.
This is structural: `apps/web` has no import path to the proof module, and the
bundle is scanned to prove the secret-bearing symbols are absent.

Errors are the usual accidental leak, so a thrown message is never rendered. The
UI shows a fixed string chosen by an error *code*, and the thrown text is
discarded. Persisted records carrying a secret-shaped field are dropped, not
sanitised — a sanitised record invites a future render path for the field.

Source maps are published deliberately (R-6). That is acceptable only because
nothing secret is reachable, which is a condition and not a permanent property.

## 6. Storage

Exactly two keys, neither secret-bearing, both documented in
`storageInventory`. Records are validated on **read**, rebuilt from an allow-list
so unknown fields cannot survive, and bounded in both size and count.

The read path is the point worth stating loudly, because it is where the audit
found its sharpest defect. `services/history.ts` must call the validator in
`lib/storage.ts`; a regression asserts the raw path cannot return, because the
validator being correct and unused is indistinguishable from the control working
until someone reads the import (F-01, R-11).

A persisted `CONFIRMED` is a claim. It is rendered as a claim and stays one until
an authoritative lookup agrees. `UNKNOWN` reconciles by durable identifier and is
never retried blindly, because a retried submission of an already-submitted
operation is a double spend.

## 7. Deployment policy

The meta CSP is deliberately conservative and deliberately *incomplete*:

- `default-src 'self'`, `script-src 'self'` — no CDN, no inline script, no
  `eval`. Vite emits a module script and nothing else, so this is satisfiable
  without a nonce and without a hash list.
- `connect-src 'self'` plus the two allow-listed Esmeralda indexer origins. A
  configured indexer resolving to a private-network address **fails the build**
  rather than shipping a localhost dependency.
- `img-src 'self' data: https:` — NFT media is attacker-controlled, so every URL
  is additionally validated by `safeImageUrl` (scheme, no credentials, length).
  Remote SVG is refused: it is a script container.
- `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`.
- `style-src 'self' 'unsafe-inline'` — required by React style attributes today;
  no untrusted value reaches a style property. Recorded as R-7 with its condition.

**`frame-ancestors` is absent from the meta CSP on purpose.** A meta CSP silently
ignores it, so declaring it there would be false assurance. The build emits
`dist/_headers` with the real header, and CI asserts the file exists.

**That file is not sufficient, and the app does not pretend otherwise.** The
current host is GitHub Pages, which does not read `_headers`, so none of those
response headers are delivered in production today. This is open risk **R-1**, and
`https://universe.tari.mw` in the allow-list is an unverified assumption
(**R-2**). Both are deployment decisions, and both are called out in
`security/FRONTEND_RESIDUAL_RISKS.md` rather than left implicit in a config file.

## 8. Network policy

- **Mainnet is not configurable anywhere in the app.** There is no code path that
  produces a mainnet network identifier.
- **The provider's network is compared to the pinned network at connect**, and
  re-derived live before every signature. A provider claiming mainnet is refused
  even if it looks otherwise.
- **A refusal is shown in the page**, as a `role="alert"` banner. F-07 was a
  correct refusal the user could not see, which invites a network switch without
  understanding and is therefore its own hazard.
- **Query parameters cannot change the network or the submit gate.** Both are
  build-time configuration.
- **The developer trading fee is exactly zero**, and validated.
- **The real cross-chain submit gate is mirrored from build configuration**, and
  the UI states its state rather than implying capability.

## 9. Accessibility is a security property

A rejection a user cannot perceive is a rejection that will be worked around. The
concrete cases found in this audit were a failed discovery rendered as a count
(F-08) and an invisible connection refusal (F-07) — both were, in effect,
accessibility failures that turned into honesty failures.

So: critical status is never colour-only, warnings are sentences rather than
badges, the skip link is the first focus stop, focus is always visible, and the
layout is asserted not to overflow at 360, 390, and 1440 px — an overflow can
hide a balance or a rejection at exactly the width a user is most likely to be
holding a phone.

## 10. What would change this model

- A real funded wallet and a reachable Esmeralda indexer, which would replace
  every injected double in the browser suite with a real counterpart (R-4).
- A host that can deliver response headers, closing R-1 and restoring the
  clickjacking control.
- A confirmed wallet embedding origin, closing R-2.
- Upstream atomic SHA swaps, which would move the multi-hop route from blocked
  to testable (R-3).
- Any future secret-bearing code reachable from the frontend, which would
  immediately re-open R-6.
