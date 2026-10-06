# Live Wallet Trading UX — Pool v2 authoritative read

Scope of this pass: make the connected-wallet **authoritative Pool v2 state read**
correct against the real published template, and record exactly what is verified and
what is blocked. No Pool template was published, no asset created, no pool
instantiated here.

## Provider methods used

The browser wallet contract (`window.tari`, verified against the published
`tari-dapp` interface) — only official methods, no brand/`isEmbedded` detection:

- `tari_getCapabilities` — capability gate (support is decided by capabilities).
- `tari_requestAccounts` / `tari_getAccounts` — account component address.
- `tari_getNetwork` — network identity (must be esmeralda, byte-checked upstream).
- `tari_getWalletAddress`, `tari_getBalances` — wallet identity and balances.
- **`tari_getSubstate`** — authoritative substate reads (the Pool read path below).
- `tari_createTransactionRequest` / `tari_getTransactionRequest` /
  `tari_submitTransactionRequest` — durable request lifecycle (existing).

Capability requirement for reads: the provider must answer `tari_getSubstate`. The
app re-derives the live provider/network/account before every authorization
(`WalletService.liveIdentity`), and refuses a provider that was **replaced** or
**removed**, a **wrong network**, or a **missing account** — so a review created
under one account/network/provider can never be signed under another.

## Pool v2 authoritative read path (the fix)

The published `Pool` template stores its state as a struct, **not** flat fields:

```
state = [ pools: BTreeMap<ResourceAddress, Vault>,   // reserves live in VAULTS
          lp_resource: ResourceAddress,
          fee_bps: u16,
          locked_lp_vault: Vault ]
```

So a single component read gives neither reserves nor LP supply. The previous read
(`parsePoolState`) expected flat fields (`reserve_a`, `total_lp_supply`, …) that the
real substate does not carry, so it could not render a real pool. The read now does a
**multi-substate decode** (`packages/protocol-client/src/poolSubstate.ts`):

1. `tari_getSubstate(component)` → decode body `state`: the resource pair and their
   reserve **vault ids**, `lp_resource`, `fee_bps`, and the `locked_lp_vault` id.
   The pair comes from the component body, so the DenyAll `get_a_resource` /
   `get_b_resource` methods (which an ownerless v2 pool refuses) are **never called**.
2. `tari_getSubstate(each reserve vault)` → `resource_container.{Stealth.revealed_amount |
   Fungible.amount}` → `reserveA`, `reserveB`.
3. `tari_getSubstate(lp_resource)` → `total_supply` → `totalLpSupply`.
4. `tari_getSubstate(locked_lp_vault)` → amount → `lockedLpSupply` (the permanent lock).

All raw-integer (decimal strings); no floating point. **Fail-closed**: a missing or
malformed substate throws rather than inventing a reserve, so the UI keeps rendering
`—` rather than a fabricated number.

`WalletService.readPoolState` is rewired to this decoder over a raw-substate reader
(`readRawSubstate` → `tari_getSubstate`).

## Transaction request lifecycle, recovery, invalidation (existing, retained)

- Durable requests: `tari_createTransactionRequest` → persist `requestId` →
  `tari_getTransactionRequest` → submit only when APPROVED → reconcile by durable id
  (`services/execution.ts`, `history.ts`). The reviewed instructions are pinned and
  the signed transaction must equal the reviewed one; instructions are never rebuilt
  after approval.
- Reload recovery and duplicate-submission prevention are reconciliation-by-durable-id;
  UNKNOWN stays UNKNOWN and is never auto-resubmitted.
- Account/network/provider changes invalidate the review via `liveIdentity`.
- The durable pool **registry** identifies candidate components only; it is never
  execution authority — network, Pool template, component and resource pair are
  reverified on chain before use.

## Evidence classification

- **LIVE CHAIN READ VERIFIED** — the decoder produces the exact Pool v2 state
  (`reserveA=595664`, `reserveB=604684`, `totalLpSupply=600000`, `lockedLpSupply=1000`,
  `feeBps=30`) from the REAL on-chain substates captured for
  `component_8c20c644…`, matching the numbers independently verified via the executor.
  Tests: `packages/protocol-client/test/pool_substate.test.cjs`.
- **UNIT VERIFIED** — the wallet wiring `readRawSubstate` → `decodePoolState` decodes
  the same real substate bytes delivered through a mock `tari_getSubstate`
  (`apps/web/test/pool-state-read.test.cjs`).
- **BLOCKED (no provider)** — a real browser wallet provider is **not available in
  this environment**, so provider initialization, a live account/network handshake,
  a live `tari_getSubstate`, and any browser-originated swap/liquidity approval are
  **not** live-wallet verified. `MANUAL WALLET APPROVAL REQUIRED` for any
  browser-originated transaction. The executor is NOT a substitute for a browser-wallet
  test and its evidence is classified separately (`EXECUTOR VERIFIED`).

## Limitations / residual risks / next steps

- The **quote path** (`createOotleReadbackProvider` → `parsePoolState`) still assumes
  flat fields and must be moved onto the same multi-substate `decodePoolState` for a
  real pool before a connected-wallet swap can quote correctly. This is the exact next
  step; it is only exercised with a connected wallet (currently blocked), so it is
  documented rather than shipped unverified.
- The real wallet `tari_getSubstate` reply shape is UNVERIFIED; `readRawSubstate`
  unwraps the common envelopes defensively, but a live provider is needed to confirm.
- No secrets, JWTs, seeds, or wallet history are stored or logged.
