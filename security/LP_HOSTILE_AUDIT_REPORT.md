# LP HOSTILE AUDIT REPORT — fungible liquidity pool

Scope: try to DRAIN or BREAK the pool. This is a security phase report, not a feature report.
The pool is NOT claimed to be unhackable; conclusions are bounded to the tested model below.

## Audited binary/runtime

| Item | Value |
|---|---|
| Branch / HEAD | `feat/multi-asset-stablecoin-markets` / `6425c660f8f5274aea1fff2d7e47d53c7ef52879` |
| Ootle revision | `4732f65ec17a96547050989d78fd70a4e3d94113` (v0.41.1-era; template_lib 0.32 lineage) |
| Rust | 1.97.1 (8bab26f4f 2026-07-14) |
| WASM | `fungible_pool.wasm`, 242,679 bytes, SHA256 `e83980a22b4b3faeae46fa542dfd0d6f720acd61e507967a360226626d0ea705` |

Full frozen baseline: `security/LP_BASELINE.md`. Attack matrix: `security/LP_HISTORICAL_ATTACK_MATRIX.md`.

## Historical attack matrix totals

26 rows: **PASS 13 · N/A_BY_CONSTRUCTION 8 · FIXED 1 · EXTERNAL_RISK 3 · BLOCKED 1 · UNKNOWN 0**

## Findings

| Severity | Open | Resolved/Classified |
|---|---|---|
| CRITICAL | 0 | historical OPUS-01/02/03/04/05/06/14 classes — all fixed earlier, all reproducers re-executed at this HEAD (below) |
| HIGH | 0 | issuer recall/freeze (ATK-15) = EXTERNAL_RISK (RR-01); substate-lock contention (ATK-22) = BLOCKED (RR-02) |
| MEDIUM | 0 | sandwich/JIT = economic behavior with bounded on-chain loss (RR-03) |
| LOW | 0 | reinit dust-capture scenario analyzed and DISPROVEN: after full exit the supply:reserve ratio stays 1:1 (locked LP is minted from the bootstrap mint, not a constant), so re-entry mints exactly proportional shares — proven in `ref:zero_user_lp_reinit_is_proportional` and `eng:w05` |

No NEW contract-level drain was found in this phase. Every historical attack family either
failed to translate (executable evidence) or is external to the contract.

## Previous OPUS regressions (re-verified at this HEAD)

| ID | Class | Current executable regression | Status |
|---|---|---|---|
| OPUS-01 | LP redemption integer truncation (trapped funds) | `eng:e02` (mul_div, multiply-before-divide, full redemption returns reserves) | FIXED — regression green |
| OPUS-02 | LP mint authorization (creator implicit mint badge) | `eng:e01` (non-creator provider receives LP) + `eng:w06/w07` (untrusted mint/burn rejected) + `eng:w10` (no admin entry points) | FIXED — regression green |
| OPUS-03 | Fee bypass | `eng:e03/e03b` (k strictly grows; output < fee-free output; full input deposited) | FIXED — regression green |
| OPUS-04 | LP mint on post-deposit reserves (under-mint leak) | `eng:w04` (victim LP exactly 1_000_000_000 — the PRE-reserve value; post-reserve math would mint 999_001) + `ref:fuzz` proportional assert per op | FIXED — regression green |
| OPUS-05 | Missing min_output protection | `eng:e04`, `eng:w01`, `eng:w09` (on-chain abort + atomic rollback) | FIXED — regression green |
| OPUS-06 | Overflow / precision | template 192-bit `into_precision_amount` checked math; `ref:arithmetic_near_amount_max` (near-u128::MAX); differential boundary matrix | FIXED — regression green |
| OPUS-08 | Hostile recall/freeze resource risk | `eng:R01–R10` eligibility matrix + `eng:opus08_recall_demo` (drain demonstrated = EXTERNAL_RISK, RR-01); type policy NOT weakened | DOCUMENTED — external |
| OPUS-09 | Tests not exercising the real engine | entire `audit_engine_tests/` suite (30 pool-relevant tests) runs the real WASM in the engine on Linux CI | FIXED — regression green |
| OPUS-14 | Fee denominator mismatch (per-mil vs bps) | `eng:e03` pins exact 90_661_089 (a per-mil regression yields 88_422_971 and fails); `pool_math:fee_tier_policy_bps_scale`; `ref:fee_table_exact_30_bps` | FIXED — regression green |

## Reference model

Status: **complete, independent, green.** `crates/pool_ref_model` shares no code with
`pool_math` or the template; hand-checked 256-bit arithmetic (no floats anywhere) so the model
cannot overflow and lie. 22 tests: differential (exact agreement vs production across 22
boundary values × 15 reserve matrices + 20,000 randomized cases), security gauntlet (16
attack-class reproductions), state-machine fuzzer.

## Property testing / fuzzing

- Sequences: 10 (seeds `0x0F00_0000 + 0..10`) · Operations: **100,000** biased ops
  (dust/small/near-reserve/near-balance/huge/near-max; add/swap/remove × A/B; 4 actors)
- Invariants verified after EVERY op: conservation (I-01), LP supply (I-02), k-growth (I-06),
  exact proportional mint/redeem (I-09), atomicity of every failed op (I-14)
- Failing seeds: **0** (no discovered failure to promote)
- Additional randomized properties: 5,000 B→A→B states, 2,000×1,000 round-trip loops,
  10,000 boundedness quotes, 5,000 isqrt properties

## Rounding gauntlet

**PASS.** Reserves 1/1 … 3/2, near-empty, huge/tiny ratios; 10,000-iteration same-direction
micro-swaps (monotone non-increasing output; fragmented ≤ aggregate); alternating micro-swaps;
A→B→A loops to dust; add→swap→remove LP self-trading (≤ 0). KyberSwap/Balancer root classes
cannot translate: every division floors against the caller and both LP legs floor toward the pool.

## First-depositor

**PASS.** Attacker seeds 1e6/1e6 → 999_000 LP; victim 1e9/1e9 → exactly 1e9 LP; attacker
redeems LESS than deposited; victim redeems exactly deposit. Engine-verified (`eng:w04`).

## Zero-supply / reinit

**PASS.** Pool emptied to locked-only: reserves reduce proportionally to 1000/1000 dust,
supply = locked = 1_000; re-entry is proportional (never bootstraps; locked never re-mints);
re-entering LP redeems exactly their deposit (`eng:w05`, `ref:zero_user_lp_reinit*`).

## Uranium class

**PASS.** One fee denominator (10_000 bps) drives output AND invariant; tiny inputs floor to
abort or ≤1 unit; disproportionate min_output aborts atomically (`eng:w01`, `ref:fee_table`).

## Reentrancy

**N/A_BY_CONSTRUCTION** for this architecture: no external component calls, no resource
callbacks (fungible buckets are inert), no cross-template calls on any state-changing path;
Ootle substate locking serializes same-component mutations. Interleaved-op fuzzing plus
sequential-conflict engine test provide the runtime evidence available (`eng:w11`).

## Oracle / flash

**N/A — no consumer.** Repo-wide search found NO use of pool spot price, reserve ratio, swap
quotes, or LP valuation as input to collateral, minting, rewards, liquidation, governance, or
stablecoin issuance. Recorded as watch item RR-04.

## MEV

**Bounded, not eliminated.** On-chain `min_output` + atomic abort cap sandwich loss
(`eng:e04/w09`); JIT fee capture is exactly pro-rata. Ordering is permissionless — this is
market behavior, not a drain. RR-03.

## Hostile resources

**EXECUTED (engine).** Eligibility matrix RESOURCE01–10: canonical Tari ✓, ordinary fungible ✓,
fake-Tari-metadata ≠ canonical ✓, stealth/confidential/NFT rejected ✓, same-resource pair
rejected ✓; recallable/freezable fungibles accepted-by-type with the drain demonstrated and
classified EXTERNAL_RISK (RR-01). Pool refuses confidential/stealth/NFT ride-alongs by
authoritative type.

## Real Ootle engine

Tests executed (pool-relevant): **43** total engine tests = pool_engine 7 + pool_economics 4 +
opus08 9 + pool_adversarial 11 (w01–w11) + NFT suites 12. **Executed result (CI run
36097235958, commit 3445c46, Linux/wasmer): pool-relevant 31 passed · 0 failed · 0 ignored;
pool_adversarial specifically 11 passed · 0 failed · 0 ignored — the adversarial suite
EXECUTED, not merely compiled.** Off-chain: 32 pool_math + 22 ref model + 10 protocol_types
all green locally and in CI.

## Client / router

**Documented.** `ProtocolClient` pool reads are discovery-only; indexer data is untrusted and
must never be a quote source. On-chain `min_output` is authoritative. The pool swap intent
builder does not exist yet — requirements recorded in RR-05 (BigInt amounts, re-quote at sign,
expiry/max-epoch, exact ResourceAddress identity). `classifyResource` advisory verdicts are
the UI-side recall/freeze mitigation for RR-01.

## Open external risks

RR-01 issuer-authority tokens (HIGH, external) · RR-03 economic MEV (MEDIUM) ·
RR-04 spot-price consumer policy (watch) · RR-05 client swap path requirements (watch) ·
RR-06 pin aging (process)

## Open blockers

RR-02 substate-lock contention not reproducible in `tari_template_test_tooling` (sequential
harness only) — verify on live Esmeralda pre-mainnet.

## FINAL CONCLUSION

**NO KNOWN CONTRACT-LEVEL DRAIN FOUND UNDER TESTED MODEL**

(The model = Ootle `4732f65…` engine + this WASM hash + all suites above. Untrusted
issuer-authority tokens and consensus-layer ordering remain external; see residual risks.)
