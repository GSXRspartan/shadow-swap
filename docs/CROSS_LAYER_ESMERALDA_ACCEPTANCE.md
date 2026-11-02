# Cross-layer Esmeralda acceptance

The procedure for taking this subsystem from "offline-verified" to "both chains settled", and the
exact state it is in before that procedure has been run.

**Nothing in this document has been executed.** No L1 script has run, no preimage has been
observed crossing layers, and no pair of balances has been reconciled. The readiness label for the
composed exchange is **BLOCKED**, and it stays there until §5's evidence exists.

## 1. Why it is blocked, precisely

Three separate blockers, with different remedies:

| Blocker | Why | Remedy |
|---|---|---|
| **No L1 transport** | `l1Adapter.ts` and `l1Companion.ts` are pure contract and policy. Nothing in this repository opens a gRPC socket to a Minotari wallet, by design — the wallet is reachable only over local gRPC, so the transport belongs beside the wallet. | A local process that speaks `minotari_app_grpc` and implements `L1AtomicSwapTransport`. |
| **No funded Esmeralda L1 account** | An HTLC needs real (testnet) XTM to escrow, and a second account to claim it. | Two disposable Esmeralda wallets, funded from a faucet. **Not the operator's mainnet wallet** — see §6. |
| **Esmeralda was unreachable from this environment** | Both recorded indexers (`ootle-indexer-a.tari.com`, `ootle-indexer-b.tari.com`) answered HTTP 000 throughout this campaign, so the live generation could not be read and the L2 templates could not be published. | A reachable indexer, then template publication (§3). |

The third is the one that gates everything else: without a live L2 generation there is nothing to
publish the template to, and `crossLayerAvailability` correctly reports `NOT_RECORDED` rather than
offering a trade against a template that does not exist.

## 2. What must be true before the first transaction

A checklist, in order. Each item is a thing the code already checks, so the check is the gate
rather than a note to be careful.

1. **The indexer answers and names its network.** `GET /info` must report `esmeralda` with
   `network_byte: 38`. A mismatched network byte is an authoritative refusal, not a retry.
2. **The L2 generation is recorded.** `activeDeployment(network)` must return a deployment whose
   `generation` matches the live cohort (`6a25dbc524581bfaa0a3c6ef120f8d59cc827572`). An
   incompatible generation makes `crossLayerAvailability` return `INCOMPATIBLE_GENERATION`, and
   publishing v0.48-only HTLC templates on an incompatible network is explicitly out of bounds.
3. **The `CrossLayerHtlc` template is published and its address is recorded** in
   `crossLayerHtlcTemplates` for that deployment. Until then the list is empty and
   `isTrustedCrossLayerTemplate` refuses every escrow — which is the correct behaviour, because
   an escrow that merely *decodes* like a cross-layer HTLC can be any component at all.
4. **A browser wallet is connected** (Sapient's extension provider or Tari Universe's embedded
   provider — both speak the same 13-method dApp API, and a dApp never detects which).
5. **The L1 companion reports `FUND`, `CLAIM` and `REFUND`.** `assessCapabilities` must return
   `complete: true`. A wallet that cannot refund must not fund: the refund is the only way back
   if the counterparty never claims, and `planL1Funding` refuses outright.
6. **The L1 wallet is synced.** `assessSync` must pass. The wallet locks the refund branch at its
   own scanned height + 720, so a wallet *n* blocks behind produces an output that refunds *n*
   blocks early and silently shortens the claimant's window.
7. **Both L1 accounts are disposable and funded**, and the amounts are small enough that losing
   both legs to a timeout is uninteresting.

## 3. Publishing the L2 template

Required, and not yet done. `templates/cross_layer_htlc` must be built to WASM and published to
the live Esmeralda generation, and the resulting template address recorded in
`apps/web/src/services/protocolDeployment.ts` under that deployment's `crossLayerHtlcTemplates`.

Two constraints on this step:

* **Do not publish to an incompatible generation.** The template is built against v0.48 template
  lib; publishing it where the engine generation differs produces a component nothing can call.
* **Record the address, do not infer it.** `isTrustedCrossLayerTemplate` compares against a
  recorded list precisely so that a trade is never offered against an unrecorded template.

## 4. The acceptance sequence

Run in this order. Stop at the first failure and record it; do not proceed past a step whose
evidence is missing.

| # | Step | Evidence required |
|---|---|---|
| E1 | Read the live generation and record it | `/info` response, generation hash |
| E2 | Publish `CrossLayerHtlc`, record the address | template address, publishing transaction id |
| E3 | Read both L1 balances and the L1 tip and scanned heights | the four figures, with timestamps |
| E4 | Read the L2 account balance through the wallet | raw balance, epoch of the read |
| E5 | Derive the deadlines with `deriveTimeouts` from the **scanned** height | `l1RefundHeight`, `l2ExpiresAtEpoch`, margin, and the justification string |
| E6 | Fund the L1 HTLC (maker, for an exit) | `transaction_id`, `output_hash`; the preimage stays on the funding machine |
| E7 | Read the funded output back and verify it | `verifyFundedOutput` verdict with **no** `unverified` entries |
| E8 | Fund the L2 escrow against the hash **read from the output** | transaction id, escrow component address |
| E9 | Decode the escrow from L2 state and verify it | `decodeCrossLayerEscrow` output: amount, hash, claimant, expiry, status `Funded` |
| E10 | Claim the L2 escrow (secret holder) | transaction id, and the escrow's status reading `Claimed` |
| E11 | Read the published secret from L2 state | the value, read by the *other* party, from chain |
| E12 | Claim the L1 output with it | `transaction_id`, `is_success: true` |
| E13 | Reconcile both balances against their baselines | two balance deltas, each ≥ the agreed amount |
| E14 | Repeat E3–E13 for the entry direction | the same evidence, with the roles swapped |
| E15 | Abandonment: fund L1, never fund L2, refund L1 at its height | refund transaction id, and the output reading spent-by-refund |
| E16 | Abandonment: fund both, never claim L2, refund L2 at its epoch, refund L1 at its height | both refund transaction ids, both statuses |

E15 and E16 matter more than the happy paths. A protocol that settles when both parties cooperate
is easy; the question is whether a party who is left hanging gets their funds back, and that is
the path nobody exercises until it happens to them.

## 5. What "BOTH CHAINS SETTLED" requires

The label is earned only by E1–E14 completing with all evidence recorded, plus E15 and E16. Short
of that the correct labels are:

| Evidence present | Label |
|---|---|
| Engine tests only | **ENGINE VERIFIED** |
| Plus builders matching the engine's executed wire format | **BROWSER BUILDER VERIFIED** |
| Plus a real wallet approving a real L2 transaction on Esmeralda | **REAL WALLET APPROVED** |
| Plus an L1 HTLC funded and its script observed on chain | **L1 EXECUTION VERIFIED** |
| Plus E10–E13: the secret crossing layers and both balances reconciled | **BOTH CHAINS SETTLED** |
| Any step blocked | **BLOCKED**, naming the step |

A transaction id is **not** settlement evidence at any step. `reconcileSettlement` and
`reconcileL1Settlement` both require a balance delta, because an id proves a submission and not an
arrival.

## 6. The operator's holding

The operator holds roughly 7 million XTM on mainnet. That is **not** a development resource and
nothing in this procedure touches it:

* No step imports, exports or derives a mainnet key. No seed, spend key or view key is an input to
  any module in this subsystem.
* `l1Companion` refuses mainnet outright: `L1_APPROVED_NETWORKS` is esmeralda, igor, localnet and
  stagenet, and `assessCapabilities` returns no capabilities at all for anything else.
* Every acceptance step uses disposable Esmeralda wallets funded from a faucet.
* No amount of that holding is assumed available as liquidity, and nothing here promises a return
  on any of it.

If mainnet operation is ever wanted, it is a separate decision with its own authorization, and the
one-line change that would enable it is deliberately a change a person has to make.

## 7. Handling an ambiguous result during acceptance

The step most likely to go wrong in an interesting way is a submission whose outcome is unclear —
a transport that dies after the wallet accepted the transaction looks exactly like one that died
before.

`classifySubmission` returns **UNKNOWN**, not failed, and sets `mustCheckChainBeforeRetry`. During
acceptance that means: stop, read the chain for that output or escrow, and record what was found.
Do not retry. A retried funding escrows twice out of the same inventory; a retried claim is at best
wasted fees and at worst a second reveal of a secret that should only ever be published once.

## 8. Current status

| Item | Status |
|---|---|
| L2 template behaviour | **ENGINE VERIFIED** |
| L2 instruction wire format | **BROWSER BUILDER VERIFIED** |
| Client stack (timeouts, quoting, inventory, lifecycle, invitations, decoder, companion) | **ENGINE VERIFIED** (unit) |
| Composed exchange, against simulated chains | **ENGINE VERIFIED** — 23 scenarios; the chains are simulated |
| Esmeralda reachability | **BLOCKED** — both indexers answered HTTP 000 throughout |
| L2 template published on Esmeralda | **BLOCKED** — step E2 not run |
| Real wallet approval of an L2 cross-layer transaction | **BLOCKED** — step E10 not run |
| L1 script execution | **BLOCKED** — no transport, no funded account |
| Composed exchange, live | **BLOCKED** — steps E6–E14 not run |
