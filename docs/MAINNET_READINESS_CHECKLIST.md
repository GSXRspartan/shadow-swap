# Mainnet readiness checklist

What has to be true before Shadow Swap executes a real-money transaction, what is already true,
and what is blocked. Every row says which, with no aspirational entries.

## 0. The finding that reorders everything below

**Ootle L2 mainnet has not launched.** Two independent sources, both upstream:

* `crates/wallet/ootle-rs/src/helpers.rs` at cohort `6a25dbc` (v0.48.0):
  `Network::MainNet => unimplemented!("MainNet indexer URL is not set")`.
* Upstream's exchange-integration guide: *"Ootle mainnet has not launched yet"*, with MainNet
  (prefix `otl_`) listed as "Not launched yet", and a note that public indexer URLs and fee tables
  are placeholders that will change before launch.

A launch date of **2026-11-11** has been announced publicly. As of this commit it is in the future.

Minotari **L1** mainnet, by contrast, is live — which is why the XTM donation address works today.

So the honest readiness picture is asymmetric: the L1 side of everything has a real network, and
the L2 side — where every pool, every LP position and every trade lives — does not yet. No amount
of work in this repository changes that row.

## 1. The readiness ladder

Implemented in `assessReadiness` (`protocol-client/src/networks/readiness.ts`). Each rung requires
evidence; the last one requires a decision.

| Stage | Requires | Ootle mainnet today | Esmeralda today |
|---|---|---|---|
| `NETWORK_CONFIGURED` | A profile in the registry: identity, byte, address form, fees, finality | **Yes** | Yes |
| `CHAIN_REACHABLE` | An endpoint that answered, with network and byte matching | **No** — no endpoint exists | Blocked in this environment (indexers answered HTTP 000) |
| `WALLET_COMPATIBLE` | A connected wallet reporting the same network | No | Yes, with Sapient or Universe |
| `CONTRACTS_VERIFIED` | A manifest validated against the live chain, recording ≥1 template | No | **No** — nothing published |
| `MARKET_DATA_READY` | Read-only discovery returning a usable result | No | No |
| `TRADING_AUTHORIZED` | **Explicit operator authorization.** Not a date, not a build flag, not implied by any check above | No | No |

`canExecute` is true at exactly one rung, and `MAINNET_EXECUTION_AUTHORIZED` in
`apps/web/src/lib/networks.ts` is the constant that gates it. It ships `false`. It is deliberately
**not** an environment variable: a `VITE_*` value is public and set by whoever runs the build,
which would make "is mainnet live" a property of a CI configuration rather than of a reviewed
commit.

## 2. The checklist

### Network identity

| Item | State |
|---|---|
| L1 and L2 network bytes read from upstream source, not restated | **Done** — `chainIdentity.ts`, cross-checked between the Ootle and Minotari enums |
| Ootle address prefixes per network (`otl_`, `otl_esm_`, …) | **Done** |
| Real L1 address parsing: three-part base58, DammSum, size, network byte, feature bits | **Done** |
| Real L2 address parsing: bech32m with the checksum over the network prefix | **Done**, verified against upstream's own test vector |
| Unknown network fails closed, with no default and no fallback | **Done** |
| Mixed-value chain pairs (mainnet L1 with testnet L2) refused | **Done** |

### Template publication and components

| Item | State |
|---|---|
| Pool v2 published on mainnet | **Blocked** — no Ootle mainnet |
| RevealedAssetPool published on mainnet | **Blocked** |
| Marketplace templates published on mainnet | **Blocked** |
| SwapOffer published on mainnet | **Blocked** |
| `CrossLayerHtlc` published on mainnet | **Blocked** |
| A deployment manifest exists for mainnet | **Done, and empty** — `deploymentFor('mainnet', …)` returns a row with no templates. This is the point: before this change the function fell through to **Esmeralda's** row for any non-localnet network, so a mainnet session would have trusted a testnet template address. |
| Manifests are keyed by (network, generation) and validated against the live chain | **Done** |
| An older manifest cannot override a newer validated one | **Done** |
| A missing template disables only its own feature | **Done** |

### Resource metadata

| Item | State |
|---|---|
| Resources named from a reviewed manifest with provenance, never from token metadata | **Done** |
| The native TARI resource (`resource_0101…01`) is an **engine constant**, not a per-network address | **Verified** — `STEALTH_TARI_RESOURCE_ADDRESS` in `template_lib_types::constants`. It is correct on mainnet too, which is why the audit did not remove it |
| Stealth-typed is not described as "confidential support" | **Done** (pre-existing) |
| A mainnet resource registry | **Blocked** — nothing to register |

### Wallets

| Item | State |
|---|---|
| Sapient and Universe both speak the same 13-method dApp API | **Verified** (pre-existing conformance suite) |
| A wallet on a different network from the build is refused before any transaction | **Done** |
| A network change voids a prepared review | **Done** — the review fingerprint binds the network, and `verifyIdentity` refuses the change by name |
| Supported wallet versions on mainnet | **Blocked** — untestable until mainnet exists |

### Liquidity provision

| Item | State |
|---|---|
| Pool creation, deposits, LP positions, withdrawal, swap | **Implemented, testnet-only**, and engine-verified |
| The fee goes **entirely** to liquidity providers | **Verified** — there is no protocol fee, no treasury and no developer trading fee anywhere in the templates or the app; `apps/web/test/security.test.cjs` asserts none is introduced |
| "30 bps" is the fee | **Correction.** 30 bps is the conventional default, not a fixed rate: `fee_bps` is a **per-pool parameter** set at creation and asserted into `1..=1000` basis points (0.01%..10%) by `Pool::new`. A pool's actual fee is read from the pool, and the UI shows the pool's own figure |
| LP ownership, deposited quantities and withdrawable share | **Implemented** — `lpPosition` computes share of supply, the proportional claim on each reserve (floored exactly as the chain floors), and the permanently locked share. Surfaced in the liquidity panel from the same authoritative read as the removal preview, so a displayed figure is never a stale one |
| Pool composition change | **Implemented** — `poolCompositionChange` reports the difference between two reads, and flags reserves growing without a mint as the *shape* fee accrual takes without claiming it as fee income (a one-sided trade looks the same) |
| Realized fees per provider | **Not determinable, and refused.** A pool records no per-provider history; computing it from a single read would report price movement as fee income. Stated in the UI rather than approximated |
| Impermanent loss | **Not determinable, and refused.** It is defined against an entry price the app cannot see and an external market price that does not exist for most of these pairs |
| Trading volume | **Not from pool state.** It belongs to the market-data path, with its own freshness and trust labelling |
| APR / APY | **Never shown.** Fees accrue by growing reserves, so a return depends on volume that has not happened. The liquidity panel says so explicitly, and `lp_position.test.cjs` asserts no result field is a rate |
| No operator-controlled withdrawal mechanism | **Verified** — templates carry no admin method |
| LPs other than the pool creator are supported | **Implemented** |
| Pool v2 and RevealedAssetPool kept distinct | **Done** — separate template lists, and an address in both is reported as neither |
| Mainnet pool creation | **Blocked**, and out of scope: no pool is to be deployed on mainnet under this assignment |

### Cross-layer

| Item | State |
|---|---|
| L2 HTLC template | **ENGINE VERIFIED** |
| L2 browser builders | **BROWSER BUILDER VERIFIED** |
| L1 gRPC contract and companion policy | **Implemented**, no transport |
| Timeouts derived per chain pair, from live reads | **Done** |
| Refund and recovery paths | **Implemented**, simulated only |
| Live cross-layer settlement | **BLOCKED** — no L1 script has executed; see `CROSS_LAYER_ESMERALDA_ACCEPTANCE.md` |
| Cross-layer on mainnet | **Blocked** — the pair is recorded as unusable because the L2 leg has nowhere to settle |

### Frontend and hosting

| Item | State |
|---|---|
| Content Security Policy derived from one origin table, asserted against the shipped header | **Done** (pre-existing); no mainnet origin appears because none is published |
| Transaction preview and review before signing | **Done** (pre-existing) |
| Maximum fee controls | **Partly** — `max_fee_limit` is recorded in the registry (100 TARI default, from upstream's guide). A per-transaction cap enforced in the UI is **not implemented** |
| Emergency suspension of new UI-initiated activity | **Done, by configuration** — removing a template address from the registry disables new transactions for that feature. There is no in-protocol kill switch, because there is no operator: templates carry no admin method |
| Recovery without the website | **Done** — a funded escrow or an LP position is recoverable from its component address with a wallet alone; the records a user needs are public chain data |
| Independent security review | **Not done** |
| Safe limited-capital rollout plan | **Not written** — belongs with the launch decision, not with this change |

### Donations

| Item | State |
|---|---|
| XTM donation address verified for mainnet | **Done** — parses as a dual mainnet address (byte `0x00`), valid DammSum, `ONE_SIDED` feature |
| QR payload is the exact address | **Done** — asserted against the encoder's own output for the configured address |
| Ootle donation address | **Not supplied.** Unavailable state shown with its reason; no placeholder, no derivation, no testnet fallback |
| Donation configuration isolated from pools, LP, fees, metadata and the connected account | **Done** — `assertDonationIsolation` refuses anything not in the reviewed tables |
| Donations separate from exchange fees | **Done** — no transaction this app builds pays these addresses |

## 3. What must NOT happen before authorization

Stated so the absence of these is deliberate rather than accidental:

* No contract is published on mainnet, and nothing in this repository publishes one automatically.
* No pool is created on mainnet.
* No real asset moves. No operator wallet holding is used for testing, and no mainnet key, seed or
  credential exists anywhere in this application.
* No unattended mainnet signer. `L1_APPROVED_NETWORKS` in the cross-layer companion excludes
  mainnet outright, and every L1 operation returns a request for a person to approve.
* No privileged wallet that could withdraw another user's liquidity. The templates have no such
  method to call.
* No automatic activation on a date. The launch date above is information, not a trigger.

## 4. The order to do it in

1. Ootle mainnet launches and publishes an indexer. **Nothing below can start first.**
2. Record the mainnet endpoint in the network table and in `connect-src`; the deployment test fails
   until both agree.
3. Verify `GET /info` reports `mainnet` with byte `0x00`, and record the generation.
4. Publish templates, one feature at a time, and record each address. Each recording enables
   exactly one feature.
5. Complete the Esmeralda acceptance procedure first, end to end, including the abandonment and
   refund paths. A path nobody has exercised on a testnet is not a path to exercise on mainnet.
6. Independent security review.
7. Seed limited capital, as an ordinary liquidity provider with no privileged position.
8. Set `MAINNET_EXECUTION_AUTHORIZED` in a reviewed commit — last, and only after 1–7.
