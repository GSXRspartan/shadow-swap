# OOTLE v0.54/v0.55 UPSTREAM COMPATIBILITY AUDIT

Date: 2026-11-20. Branch `codex/ootle-v0501-pool`.
Upstream evidence: tari-ootle release notes v0.54.0 (`3a92eb7`, 2026-11-17) and v0.55.0
(`b7c964c`, 2026-11-20), PR bodies #3827/#3807/#3829/#3831/#3862, upstream source read at tag
v0.55.0, and live read-only probes of both indexers. Local security fixes (commits
`18a642f24`, `30ed44e5d`, `09b09e399`, `cdd4bc096`, `807f39668`) are preserved untouched.

**Live-verified network facts (2026-11-20):**
Esmeralda `esme-indexer-{a,b}.ootle.tari.com/info` → `0.55.0 / esmeralda / byte 38 / epoch 13268`.
MAINNET `indexer-a.ootle.tari.com/info` → `0.55.0 / mainnet / byte 0 / epoch 39096`.
`POST /substates/versions` verified live on BOTH (shape below).

## Classification legend
Already supported & verified (A&V) / Supported, lacking execution tests (S/LT) /
Requires code modification (RCM) / Requires new template publication (RNTP) /
Requires an upstream wallet feature (RUWF) / Not relevant (NR).

## 1. Transaction schema V2 + authorizer-set binding (#3827)

V2 binds each authorization to the whole authorizer set and makes the transaction id independent
of signature bytes. Upstream states: **"V1 keeps its rules, messages and ids, and stays accepted
for verification. Clients build V2."**

- Shadow Swap builds NO transactions: every financial operation goes through
  `tari_createTransactionRequest` → wallet review → `tari_submitTransactionRequest` (requestId
  only; no payload reconstruction). The WALLET (extension/Universe) builds the transaction and
  its schema version.
- Classification: **A&V for V1 acceptance; RUWF for V2** (the connected wallet's own build emits
  V2 when its version does). No code change required or permitted here — our instruction payloads
  are schema-independent and our durable request ledger holds no payload by design.
- Regression coverage: `wallet-approval.test.cjs` pins the requestId-only submission contract.

## 2. Component access-rule instructions + RulesUpdater (#3807, #3831, #3862)

- New instructions `SetComponentAccessRules` / `SetComponentOwnerRule` exist under a per-component
  rules updater; template_lib 0.42.0 defaults NEW components to `RulesUpdater::Locked`.
- #3862: rules naming non-methods are rejected at creation/update — **our templates name only real
  component methods** (verified against each template's own ABI), so they are compliant at publish.
- #3831: walletd displays rule changes before signing and requires `admin` to submit them
  directly. Shadow Swap **never emits** rule-change instructions (grep: no
  `SetComponentAccessRules`/`SetComponentOwnerRule` in any builder).
- Our deployed components: `OwnerRule::None` + locked rules, no updater badge exists → the new
  instructions cannot authorize anything against them.
- Classification: **A&V** (posture unchanged, defensively reinforced by upstream).

## 3. Removal of in-place component-template upgrades (#3824, v0.54.0)

Validators reject `UpdateComponentTemplate`; `ComponentBuilder::with_upgrade_rule` is REMOVED from
template_lib 0.41.0; `TransactionBuilder::update_component_template` removed.

- Our deployed templates run unchanged on-chain (their code was published under 0.50.1 semantics;
  removal is forward-looking). We never emitted the instruction.
- **Our template SOURCES call `.with_upgrade_rule(UpdateRule::Locked)` in all 7 templates**
  (fungible_pool, revealed_asset_pool, 3× NFT, p2p_offer, cross_layer_htlc). Against
  template_lib ≥ 0.41.0 they will NOT COMPILE.
- Classification: **RCM + RNTP for any future republish** — remove the calls when the cohort pin
  moves past 0.50.1, together with a fresh reproducible-build manifest (see §10). Deliberately NOT
  changed now: the current pin (0.50.1 / template_lib 0.38 / `WASM_SHA256SUMS.v0501` /
  audit_engine_tests at rev `0b3f364d`) must stay coherent, and publication is blocked by P7-M1
  anyway. Recorded in this document as a gate; grep verification: 7 occurrences listed above.

## 4. Wallet RPC / SDK changes

- `keys.create/list/set_active` removed (#3864): our walletd adapter is a declared refuse-everything
  stub that calls NO RPC methods. **NR.**
- Validator fee permission renames (#3796): **NR.**
- Rules-change warnings + admin gate (#3831): we never emit such instructions; walletd is not our
  signing surface. **NR** (ecosystem-positive).
- Stealth transfer fixes (#3832/#3666: dry-run-priced inputs, read-only badge inputs): wallet-side;
  our `stealthWithdraw` path benefits passively. **S/LT** (re-verify live when wallet testing resumes).
- `ootle_sdk_core` lowercase-hex-only (#3738): our hex handling is lowercase-only by construction
  (`/^[0-9a-f]{64}$/` throughout). **A&V.**
- `WalletNetworkInterface::get_substate_versions` new REQUIRED Rust-SDK method (#3829): we do not
  embed the Rust SDK; the browser talks HTTP to the indexer. **NR** (see §5).
- 1,000-substate-output limit (#3767, v0.53.4): our largest transaction (create pool + first
  deposit, or an NFT fill) persists far fewer than 1,000 substates. **A&V by scale.**

## 5. Indexer `POST /substates/versions` (#3829)

Verified live: body `{"substate_ids": [ ... ]}` (≤20) → `{"versions": { "<id>": <version> }}`,
values and proofs omitted. Upstream's own contract: *"The versions are unverified… fit for pinning
transaction inputs, where a wrong version makes the transaction fail rather than spend or read
anything it should not, and for nothing that takes a version as evidence of what the chain holds."*

- Assessment: it improves SAFE FRESHNESS (cheap input pinning before signing) but must never be
  used as settlement/reconciliation evidence — our existing freshness identity
  (`substateVersion` + `producingTxHash` from `/substates/fetch`) remains the authoritative pair.
- Classification: **S/LT — optional adoption.** Deliberately not wired in this pass: adding a
  client without changing the flow would be dead code; the correct integration (pin versions at
  execution review time) belongs with the next wallet-acceptance pass. Recorded here with the
  verified wire shape.

## 6. Mainnet network configuration — LIVE (documentation corrected)

**Ootle L2 mainnet is live**: `indexer-a.ootle.tari.com/info` → 0.55.0 / mainnet / byte 0 /
epoch 39096; upstream v0.55.0 ships `default_indexer_url(Network::MainNet) =
"https://indexer-a.ootle.tari.com/"`. The previous "has not launched" claims (accurate at cohort
`6a25dbc`) were stale and have been corrected in:
`packages/protocol-client/src/networks/registry.ts` (mainnet L2 profile now `launched: true` with
the verified evidence; endpoint deliberately NOT onboarded), `networks/donations.ts`,
`apps/web/src/lib/networks.ts` (header + indexerReason), `apps/web/src/services/protocolDeployment.ts`,
`.env.example`, `docs/MAINNET_READINESS_CHECKLIST.md`, `docs/NETWORK_CONFIGURATION.md`,
`docs/SUPPORT_DEVELOPMENT_DONATIONS.md`, `apps/web/scripts/smoke-deployment.mjs` — plus the tests
pinning those strings (network_registry, donations, donations-ui, network-isolation, lib).

UNCHANGED and verified by tests: `MAINNET_EXECUTION_AUTHORIZED = false`; the execution gate, the
readiness ladder (mainnet stays at `NETWORK_CONFIGURED` with the corrected blocker text), the
mainnet chain pair (`usable: false`), crosschain/crossLayer mainnet refusals, walletd mainnet
refusals, and the donation-address absence (no placeholder). Mainnet byte 0 confirmed live and
already correct in `chainIdentity.ts`.

- walletd `--network` defaults to mainnet since v0.53.2 (#3694): recorded here as an OPERATOR NOTE
  for local acceptance tooling — always pass `--network esmeralda` for the Shadow Swap live wallet.
- Classification: documentation correction **done**; execution hold **A&V**; mainnet read-endpoint
  onboarding = **RCM (deliberate, deferred, reviewed-change-only)**.

## 7. Brale / upstream stablecoin compatibility

Upstream `tari-project/stable-coin` is ACTIVE and has MOVED since our pinned review commit
`bef1a89` (2026-09-22): latest commits on 2026-11-20 include
`feat(issuer-minimal)!: keep roles in the component's access rules (#49)` — a BREAKING issuer
template change (roles move into access rules) — and `fix(stablecoin): add frozen UTXOs as
transaction inputs`.

- Our lanes (docs/STABLECOIN_INTEGRATION.md): public `w<SYMBOL>` wrapper in a public-fungible pool =
  the only permitted lane; direct private-stablecoin lane DESIGN_ONLY; private↔wrapper gateway
  BLOCKED (issuer-admin-gated conversion; the project must never hold the admin badge).
- The pinned commit's wrapper remains mint/burn-only-by-component, non-recallable/non-freezable —
  the facts our `ISSUER_CONTROLLED_QUOTE_ASSET` classification rests on are pinned-source facts.
- Classification: **S/LT for the wrapper lane** (no code change; engine execution untested),
  **RCM for any activation** — re-review the upstream template at a NEW pinned commit before any
  stablecoin lane goes live; the breaking issuer change makes our current pin a snapshot, not a
  live representation.

## 8. Wrapped Tari vs native L2 TARI

No Shadow Swap route requires wrapped Tari. The canonical settlement asset is native L2 TARI — the
engine-defined `STEALTH_TARI_RESOURCE_ADDRESS`, admitted by exact address in the pool template,
listing templates, and offers. Wrapped/wTARI appears only in the stablecoin research as a
stablecoin-issuer wrapper concept, not as a Tari wrapper.

- Classification: **A&V — native TARI only.** A "wrapped TARI" resource would be an ordinary
  public fungible and would be classified `PUBLIC_IMMUTABLE_OR_VETTED`/`UNKNOWN` by the routing
  layer, never canonical.

## 9. L1 XTM HTLC provider capability gap (unchanged)

The browser wallet provider still lacks the L1 SHA atomic-swap primitives (`l1ShaInit/Inspect/
Claim/Refund`); the coordinator's real-submission gate stays OFF and `TARI_LIQUIDITY_ENABLE_REAL_
CROSSCHAIN_SUBMIT` remains unset. Ootle 0.54/0.55 change none of the L1 (Minotari) primitives.
- Classification: **RUWF** — unchanged from docs/TARI_BROWSER_ATOMIC_SWAP_PROVIDER_GAP.md and
  `crossLayer/walletCapabilities.ts`. Submarine swaps stay BLOCKED by design.

## 10. P7-M1 pinned WASM reproducibility (unchanged, now compounded)

- Still unresolved: `tools/build-templates.sh --check` fails in a second environment (all 7 hashes
  differ systematically). The v0.55 release's validator-side wasm-cache change (#3867) does not
  affect the reproducible-build question.
- Compounding factor: any republish now ALSO requires the template_lib 0.41+ source changes (§3)
  and a NEW manifest generated in a known-good, recorded environment against the chosen cohort
  (0.50.1 pin stays for now; a 0.55 pin would additionally require re-running the engine suites
  at the v0.55 tag, including the three unexecuted suites).
- Classification: **OPEN — must be resolved before ANY template publication**, per the audit ledger.

## Live verification performed this pass (read-only)

1. Esmeralda /info, /templates/{Pool}, /transaction-receipts, /substates/fetch — all compatible
   with the app's CBOR/base64 decoding; seeded Pool v2 component intact at version 0.
2. MAINNET /info — live, byte 0, 0.55.0, epoch 39096.
3. /substates/versions on both networks — exact wire shape captured (see §5); mainnet correctly
   returns `{}` for a testnet component id.
4. Browser capture against the production bundle (real Chromium, `_headers` enforced): home, swap,
   pools (Data: Synced, 1 pool component), NFTs, market, activity, support, mobile.
5. Release hygiene: clean.

## NOT performed (and why)

- **Non-submitting walletd dry runs on 0.55**: the local walletd at
  `127.0.0.1:5100` is not running, and starting the operator's funded-wallet environment is out of
  scope for this session (tools/live-executor/dryrun-pool-v0501.mjs documents the exact procedure;
  the last recorded live dry-run acceptance was on the v0.50.1 cohort). Required before declaring
  0.55 FINANCIAL-operation compatibility.
- No template publication, no transactions, no wallet migration, no mainnet enablement.
