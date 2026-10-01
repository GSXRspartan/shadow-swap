# LP RESIDUAL RISKS

Risks that remain after the hostile-security phase, with owner and mitigation. These are
NOT contract-level drains under the tested model; they are bounded externalities or
environment gaps.

> **Re-checked against the v0.42.0 cohort, 2026-10-01.** All conclusions below are frozen to
> Ootle `a43773e600b9503ed3fadcd3f0048f86131e3644` (tag `v0.42.0`, workspace 0.42.0), the
> cohort the post-reset Esmeralda validators run. The template source did not change in the
> cohort move — all four templates compile unchanged with no warnings — so every risk statement
> still describes the same code. **RR-01 was specifically re-verified and is NOT closed by the
> upgrade:** the v0.42.0 template ABI still exposes no access-rule introspection for a foreign
> resource, so the recall/freeze exposure remains a live, disclosed, in-code-mitigated external
> risk.

## RR-01 — Issuer-authority tokens pooled by type (OPUS-08 residual) — EXTERNAL_RISK, HIGH
The v0.42.0 template ABI (as the v0.41.1 one did) exposes no access-rule introspection, so a public fungible whose
issuer holds recall or freeze authority passes the on-chain type check. A malicious issuer can
recall the pool's holdings of that token (demonstrated in `opus08_recall_demo.rs`) or freeze
the vault (DoS). One side's drain does NOT violate the fee/k invariants of the other side.
- Owner: router/UI + future engine API.
- Mitigation: client `classifyResource` advisory verdicts (`unsafe_recallable`,
  `unsafe_freezable`, `unsafe_mutable_rules`) sourced from indexer facts; UI must block or
  loudly warn. Do NOT weaken the OPUS-08 type policy to "gain compatibility".

## RR-02 — Substate-lock contention not exercisable in tooling — BLOCKED, verify pre-mainnet
`tari_template_test_tooling` executes transactions sequentially; true concurrent substate-lock
contention (swap vs swap racing the same vault) is enforced at the consensus layer and cannot
be reproduced in the harness. Engine semantics imply at most one conflicting transaction
commits, but this is relied upon, not reproduced.
- Owner: pre-mainnet checklist. Mitigation: run the w11-class conflicting flows against a live
  Esmeralda node (see docs/ESMERALDA_VERSION_TARGET.md).

## RR-03 — Economic MEV (sandwiching, JIT liquidity) — EXTERNAL_RISK, MEDIUM
Permissionless ordering means sandwiches remain economically possible. The on-chain
`min_output` bound and transaction expiry limit victim loss; JIT fee capture is bounded to the
pro-rata fee share. These are market behaviors, not accounting bugs.
- Owner: wallet/router. Mitigation: default slippage bound from a trusted quote at sign time,
  expiry/max-epoch in intents, optional private-orderflow routing if the network supports it.

## RR-04 — No spot-price security consumers today — watch item
No collateral/minting/rewards/liquidation/governance/stablecoin-issuance logic reads pool spot
price, reserve ratio, quotes, or LP valuation anywhere in this repo (ATK-06/07/08 are
N/A_BY_CONSTRUCTION only under this fact). Any future consumer MUST use time-weighted or
delayed oracles, never spot, and re-open this audit.

## RR-05 — Client swap path not yet built — watch item
The pool has no TypeScript intent-builder yet (marketplace does). When built it MUST: derive
`min_output` from chain state read at sign time (never from indexer-only data or JS floating
point), set expiry/max epoch, use exact string/BigInt amounts, and treat indexer pool reads as
discovery only. The on-chain min_output assert is the authoritative backstop.

## RR-06 — Runtime pin aging — process risk
All conclusions are frozen to Ootle `a43773e600b9503ed3fadcd3f0048f86131e3644` (tag `v0.42.0`)
and rustc 1.97.1. A future engine upgrade that changes Amount semantics, resource access-rule
enforcement, or adds resource hooks invalidates ATK-02/03/25 classifications and requires a
full re-run of this suite plus re-recording `LP_BASELINE.md`.
