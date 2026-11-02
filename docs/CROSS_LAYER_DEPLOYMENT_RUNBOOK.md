# Cross-layer deployment runbook

How the cross-layer subsystem reaches a running environment, what must be recorded before it will
offer a trade, and what it refuses to do when those records are missing.

This is the operational companion to `CROSS_LAYER_ESMERALDA_ACCEPTANCE.md` (which is the
*verification* procedure). Deployment comes first; acceptance comes after.

## 1. What is deployed, and what is not

| Component | Deployed as | Status |
|---|---|---|
| `CrossLayerHtlc` L2 template | A published Ootle template, address recorded per deployment | **Not published on any network** |
| Taker and maker surfaces | Part of the existing `apps/web` static bundle | Built; reachable at `/market` |
| Client modules | Part of `@tari-ootle/protocol-client`, bundled into the frontend | Built |
| L1 companion transport | A process beside the operator's Minotari wallet | **Does not exist** — see §5 |
| Offer discovery service | None. Offers travel as direct invitations. | Not built, and deliberately so — see §6 |

The frontend needs **no new infrastructure**: the market page is another route in the existing
single-page app, discovery is a paste-in invitation, and every authoritative read goes through the
user's own wallet. Deployment of the frontend is therefore the existing procedure in
`SHADOW_SWAP_EXISTING_INFRASTRUCTURE_DEPLOYMENT.md` with nothing added.

**The operator's existing infrastructure is untouched.** Nothing in this subsystem changes DNS,
services, databases, certificates, tunnels or deployment configuration for anything the operator
already runs, and nothing here requires a backend. (Shadow Swap's public identity is deliberately
separate from the operator's other projects, so this document names none of them —
`tools/release-hygiene.mjs` enforces that on every tracked file.)

## 2. The one thing that must be recorded: the template address

Until a `CrossLayerHtlc` template address is recorded for a network's deployment,
`crossLayerAvailability` reports the feature unavailable and the market page says so. That is the
intended state, not a bug, and it fails closed in two distinguishable ways:

| `crossLayerAvailability` result | Meaning | What the UI shows |
|---|---|---|
| `NOT_RECORDED` | The generation is known but no cross-layer template is recorded for it | "Not available yet", with the reason |
| `INCOMPATIBLE_GENERATION` | The live generation does not match a recorded deployment | "Not available on this network", as a danger notice |

`crossLayerHtlcTemplates` is **empty for all three deployments** in
`apps/web/src/services/protocolDeployment.ts` as of this commit.

### Recording one

1. Build the template to WASM and publish it to the target network's live generation.
2. Add its address to that deployment's `crossLayerHtlcTemplates` in `protocolDeployment.ts`.
3. Ship the frontend.

`isTrustedCrossLayerTemplate` compares every decoded escrow's template address against that list.
This is load-bearing: a component that merely *decodes* like a cross-layer HTLC can be anything at
all, so an unrecorded template is refused with the address named.

**Do not publish a v0.48-only template on an incompatible generation.** It produces a component
nothing can call, and the address would then be recorded against a deployment where it does not
work.

## 3. Deployment order

The dependency chain is strict, because each step's evidence is the next step's input.

```
live indexer answers, network byte verified
        ↓
L2 generation read and recorded
        ↓
CrossLayerHtlc published to that generation
        ↓
template address recorded, frontend shipped
        ↓
L1 companion transport running beside a synced wallet   ← independent, see §5
        ↓
acceptance procedure (CROSS_LAYER_ESMERALDA_ACCEPTANCE.md)
        ↓
only then: a trade may be offered to a real counterparty
```

The L1 companion is independent of the first four steps, and the two halves can be built in
parallel — but **neither direction is tradeable without both**, because every direction needs an
L1 leg and `planSigners` refuses a plan with any unsignable operation, refunds included.

## 4. What each surface needs at runtime

| Surface | Needs | Without it |
|---|---|---|
| Taker panel, entry offers | A browser wallet, a recorded template, a reachable indexer | An invitation can be pasted but not verified, and no quote is offered |
| Taker panel, exit offers | The above, plus an L1 companion | Shown, never offered as tradeable |
| Maker panel, entry offers | A browser wallet (for the L2 balance read) | Inventory reads as unknown, and publishing is refused |
| Maker panel, exit offers | An L1 companion (for the L1 balance read) | Publishing is refused outright, rather than advertising an unverifiable balance |

Note the asymmetry, because it decides what can be demonstrated first: **the entry direction is
fully operable from a browser except for its L1 leg; the exit direction cannot even be priced
honestly without the companion.** An L1 balance is not readable from a page.

## 5. The L1 companion

Not built. What it must be:

* A **local** process on the same machine as the Minotari wallet, speaking
  `minotari_app_grpc` to it. The wallet's gRPC is local-only, which is the reason this cannot be
  a hosted service and should not become one.
* An implementation of `L1AtomicSwapTransport` (three methods:
  `sendShaAtomicSwap`, `claimShaAtomicSwap`, `claimHtlcRefund`), plus balance and height reads for
  `L1WalletFacts`.
* Driven by `l1Companion.ts`, which holds the policy: the sync gate, capability discovery, script
  rendering for inspection, observed-output verification, and submission classification.

What it must **not** be, and these are the campaign's constraints, not preferences:

* **No seed, spend key or view key** passes through it. Signing happens in the wallet under its own
  authorization. No module in this subsystem takes a key as an input.
* **No unattended signer.** Every operation is a request a person approves. `planL1Funding`,
  `planClaim` and `planRefund` all return a request and a review line; none of them submits.
* **No remote custody**, no hosted wallet, no key escrow.
* **No mainnet.** `L1_APPROVED_NETWORKS` is esmeralda, igor, localnet and stagenet.
  `assessCapabilities` returns no capabilities at all for anything else, and the refusal says why.
  Enabling mainnet is a deliberate change a person makes, with its own authorization.

### The secret, and where it lives

`send_sha_atomic_swap` generates the preimage inside the wallet and returns it once. Whoever funds
the L1 leg holds the secret for the whole trade, and they need it later to claim the counterparty's
L2 escrow.

**Its durable home is the companion, beside the wallet that produced it.** The browser holds only
the hash. `swapLifecycle`'s record type has no field for a secret and `assertRecordIsSafe` refuses
one; `redactSendResult` is what a send result becomes before it is shared; `assertNoPreimage`
throws on any payload leaving the machine that still carries secret-shaped material.

## 6. Why there is no discovery service

Offers travel as direct invitations: a bounded, prefixed string a maker hands a taker.
`CROSS_LAYER_INVITATION_MAX_CHARS` is 4096, and an imported invitation is untrusted input that is
fully validated before any of it is shown.

A discovery service would be the natural next piece, and it is deliberately absent, because the
honest version of it adds nothing to safety: `verifyCrossLayerInvitation` already reads the
maker's escrow **from chain** and returns the chain's terms as the thing to act on, so a service
could only make offers easier to find — never more trustworthy. Building one before a single trade
has settled would be building distribution for something unproven.

If one is built later: it must not become a source of transaction terms, and an advertised offer
from it must go through the same chain read as a pasted invitation.

## 7. Rollback

The frontend rolls back by the existing mechanism (Pages deployment rollback, or the release
symlink on the VPS). Two cross-layer-specific notes:

* **Removing a template address from the registry disables new trades and nothing else.** An escrow
  already funded on chain is unaffected: it is claimable by its named claimant until its deadline
  and refundable by its funder after, and neither depends on the website being online.
* **Recovery does not need this frontend.** A funded escrow's recovery is a transaction against a
  component address, and the record a user needs (component, hash, deadline, amounts) is public
  chain data. `CROSS_LAYER_ESMERALDA_ACCEPTANCE.md` §4 lists the reads; a user with their wallet
  and the component address does not need the page that created it.

## 8. Emergency stop

There is no operator kill switch inside the protocol, because there is no operator: the template
has `OwnerRule::None`, no admin method and no discretionary withdrawal, and nothing can seize or
freeze an escrow.

What *can* be stopped is the venue offering new trades:

| To stop | Do | Effect on funded escrows |
|---|---|---|
| New trades from the UI | Remove the template address from the deployment registry and ship | None — they settle or refund on their own terms |
| A maker's own quoting | `setOfferAvailability(..., { paused: true })`, or `{ withdrawn: true }` | None — live promises and escrows are untouched by either |

A maker pausing or withdrawing an advertisement does **not** unmake a promise already given or an
escrow already funded. That is deliberate: a promise a maker can retract at will is not a promise,
and the taker may already have funded their own leg against it.

## 9. Status

| Item | Status |
|---|---|
| Frontend routes and surfaces | **Built** — `/market`, both sides |
| Client modules | **Built** — see `CROSS_LAYER_HTLC_TEST_EVIDENCE.md` |
| L2 template | **BLOCKED** — not published on any network |
| Template address recorded | **BLOCKED** — `crossLayerHtlcTemplates` is empty for all deployments |
| L1 companion transport | **BLOCKED** — not built |
| Discovery service | **Not built**, by design |
| Any deployment of this subsystem | **Not performed** |
| The operator's existing infrastructure | **Untouched** |
