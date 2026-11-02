# Network configuration

The typed registry: which networks exist, what is known about each, how a value proves which
network it belongs to, and where every operational constant came from.

Everything below was read from pinned upstream source or from upstream's own documentation. Where
a figure could not be verified it is absent rather than estimated, and the absence is stated.

## 1. Network identities

Both layers share the discriminant byte, and only because upstream requires it:
`crates/ootle_network/src/lib.rs` carries the comment *"The variants and assigned byte needs to
match the L1 network enum"*, and `base_layer/common_types/src/configuration/network.rs` in
`tari-project/tari` 6.3.0-pre.2 agrees byte for byte.

| Network | Byte | Ootle L2 address prefix | Testnet |
|---|---|---|---|
| mainnet | `0x00` | `otl_` | No |
| stagenet | `0x01` | `otl_stg_` | Yes |
| nextnet | `0x02` | `otl_nxt_` | Yes |
| localnet | `0x10` | `otl_loc_` | Yes |
| igor | `0x24` | `otl_igr_` | Yes |
| esmeralda | `0x26` | `otl_esm_` | Yes |

Source: `crates/ootle_network/src/lib.rs` and `crates/ootle_address/src/hrp.rs` at Ootle
`6a25dbc` (v0.48.0). `isTestnet` mirrors upstream's `is_testnet`: mainnet is the only network that
is not one.

**The frontend offers three of these** — mainnet, esmeralda, localnet. Igor, stagenet and nextnet
are real networks this build has no verified facts about, so they are refused rather than
half-supported.

## 2. The two layers are not interchangeable

| | Minotari L1 | Ootle L2 |
|---|---|---|
| Native asset | XTM | TARI |
| Address form | base58, three-part, network byte + features byte + keys + DammSum | bech32m, network-specific prefix |
| Address self-identifies network | Yes, via the leading byte | Yes, via the checksummed prefix |
| Public read endpoint | **None, on any network** — a wallet's gRPC is local-only | Per network; see §3 |
| Finality | 3 confirmations (`num_confirmations_required` default) | BFT: *"Once a transaction has been committed it is final"* |
| Fee asset | XTM, per gram of weight | TARI, with `max_fee_limit` default 100 TARI (100,000,000 µT) |
| Divisibility | 1e6 µXTM per XTM | 1e6 µT per TARI |

Upstream's exchange-integration guide states it plainly: *"The two are different assets on
different networks, with different addresses and different wallets."* Burn-and-claim moves value
one way only (L1 → L2, 1:1 less the claim fee) and Ootle TARI cannot move back — which is the
entire reason the cross-layer exchange exists.

`requireAddressFor` is the one function that answers "does this address belong to this layer and
network", and it parses rather than guessing. A valid address for the wrong chain is the dangerous
case, not a malformed one: it looks entirely normal until funds are irrecoverable.

### Address validation is real validation

The L1 encoding is **three separate base58 blocks** — byte 0, byte 1, then the rest — concatenated.
Decoding the whole string as one base58 number yields different bytes, so a plausible-looking
address that is not one. And the last byte is a DammSum checksum, which a regex over the base58
alphabet cannot check. `parseMinotariAddress` does both, in upstream's order.

The L2 bech32m checksum covers the human-readable prefix, so an L2 address **cannot be relabelled
onto another network**: `otl_esm_1…` cannot become `otl_1…` without breaking. That property is why
an L2 donation destination can be validated for its network with no chain read at all.

## 3. Endpoints

| Layer | Network | Endpoints | Note |
|---|---|---|---|
| L2 | esmeralda | `esme-indexer-a.ootle.tari.com`, `esme-indexer-b.ootle.tari.com` | The v0.48.0 defaults, from the config presets and `default_indexer_url` |
| L2 | esmeralda (pre-reset) | `ootle-indexer-a.tari.com`, `ootle-indexer-b.tari.com` | Not a default. Kept permitted so a build can be pointed at the pre-reset network while it is served |
| L2 | localnet | `http://127.0.0.1:9113` | Development builds only |
| L2 | **mainnet** | **none** | **Ootle mainnet has not launched.** `default_indexer_url(Network::MainNet)` is `unimplemented!("MainNet indexer URL is not set")`, and upstream's guide says *"Ootle mainnet has not launched yet"*. No URL is invented here |
| L1 | all | **none** | A Minotari wallet is reachable only over local gRPC. Every L1 read and signature needs a wallet beside the user |

`connect-src` is derived from the same table that configures the indexer, so an origin added in
one place and not the other fails the deployment test rather than failing at runtime.

## 4. Deployment manifests

A manifest records where a network's contracts and assets live. It is keyed by **(network,
generation)** together, because an Ootle reset invalidates templates, components, accounts,
resource addresses, LP positions and history in one step — everything observed before a reset
identifies nothing afterwards.

**A manifest is not transaction authorization.** The attractive shortcut is to fetch one from a
URL and trust its addresses; an editable URL, a stale cache or a downloaded file is
attacker-influenced. So a manifest is a candidate until `validateManifest` has checked it against
what the chain actually reported, and even then an address is trusted only for the feature it is
recorded under.

### The error taxonomy

Each case names one thing that is wrong, because "configuration error" tells an operator nothing:

| Rejection | Means |
|---|---|
| `MALFORMED_MANIFEST` | It is not a well-formed manifest at all |
| `MISMATCHED_CHAIN_IDENTITY` | Right shape, wrong network — by name or by byte |
| `UNSUPPORTED_NETWORK_GENERATION` | Right network, wrong incarnation of it |
| `STALE_MANIFEST_VERSION` | Older than the one already validated for this (network, generation) |
| `UNSUPPORTED_NETWORK` | No profile exists for this network |

Versions are **monotonic within a (network, generation)**. Downgrade is the cheapest attack on a
registry like this: re-serve yesterday's manifest and a template that has since been withdrawn
becomes trusted again. The version rule does not apply *across* generations, because a mainnet
manifest is not a downgrade of an Esmeralda one — that case is caught by the identity check.

**One missing entry disables one feature.** A manifest with no `P2P_OFFERS` template disables P2P
offers and nothing else, so a partial deployment is usable for what it actually covers.

### The frontend's own registry

`apps/web/src/services/protocolDeployment.ts` holds the recorded template addresses per
(network, generation). `deploymentFor` is **exhaustive** — every network has its own branch and a
`never` assignment makes adding one a compile error here.

That exhaustiveness is a fix, not a formality. The previous version returned an Esmeralda
deployment for every network that was not localnet, which was harmless while there were only two
testnets and became a live hazard the moment mainnet joined the type: a mainnet session would have
trusted Esmeralda's recorded Pool v2 template address.

## 5. What was audited and deliberately left alone

A sweep for hardcoded testnet assumptions found several things that look like them and are not:

| Thing | Verdict |
|---|---|
| `CANONICAL_TARI = resource_0101…01` | **Keep.** It is `STEALTH_TARI_RESOURCE_ADDRESS` in `template_lib_types::constants` — an engine constant, identical on every Ootle network, including mainnet |
| `networkName: ''` in the wallet-adapter builders | **Keep.** The builders deliberately carry no network: a transaction's network comes from the wallet that signs it |
| `LEGACY_ESMERALDA_INDEXER_URLS` | **Keep.** Not a default; an explicitly-configurable path to the pre-reset network |
| `L1_HTLC_REFUND_BLOCKS = 720` | **Keep.** Not a testnet value — it is fixed in the Minotari wallet for every network. Its wall-clock duration differs per network, and `CHAIN_TIMING` derives that from each network's own block time |
| The testnet faucet component address | **Absent already.** No shipped source references it |

And several that were real:

| Thing | Change |
|---|---|
| `FrontendNetworkId` could not express mainnet | Mainnet added, with execution gated separately |
| `looksLikeMainnet` refused the string "mainnet" outright | Narrowed to refuse mainnet-*shaped impostors* (`tari-mainnet`, `mainnet-2`), which is the shape a typo or substitution takes |
| `deploymentFor` fell through to Esmeralda | Made exhaustive, with a mainnet row |
| `realSubmitGate` allowed only two named testnets | Now uses the execution predicate, and refuses mainnet separately and permanently |
| `smoke-deployment.mjs` asserted `esmeralda` / byte 38 | Parameterised by `--network=`, with the byte from the shared table |
| An unrecognised `VITE_TARI_NETWORK` fell back to the default *and reported execution enabled* | Fixed: the gate is computed from the requested value, so no fallback network ever executes |

## 6. Readiness, not a boolean

"Is mainnet supported?" has no useful answer, so readiness is a ladder in
`protocol-client/src/networks/readiness.ts`, each rung requiring evidence:

`NETWORK_UNKNOWN` → `NETWORK_CONFIGURED` → `CHAIN_REACHABLE` → `WALLET_COMPATIBLE` →
`CONTRACTS_VERIFIED` → `MARKET_DATA_READY` → `TRADING_AUTHORIZED`

`canExecute` is true at the last rung and nowhere else. The last rung requires a human decision
that no check can imply — not a date, not a successful read, not a build flag. The current state
of every network is in `MAINNET_READINESS_CHECKLIST.md`.

A later piece of evidence never covers a missing earlier one: a validated manifest with no
reachable chain is not `CONTRACTS_VERIFIED`, because the validation had nothing to validate against.
