# LP INVARIANTS — executable properties

Every invariant below is enforced by at least one running test. Test keys refer to:
`ref:*` = crates/pool_ref_model tests, `eng:*` = audit_engine_tests (real engine, Linux CI).

## I-01 Conservation of underlying assets
Total A and total B in existence (all actor holdings + pool reserves) never changes.
- Enforced on EVERY one of 100,000 fuzz operations: `ref:fuzz (conservation_ok)`

## I-02 LP supply accounting
`Σ actor LP balances + locked_lp == lp_total_supply` on every operation.
- `ref:fuzz (lp_supply_ok)`

## I-03 Locked LP
Locked LP = 1_000, created exactly once at bootstrap, always ≤ total supply, never re-minted,
and its existence keeps reserves nonzero (so the bootstrap branch is unreachable while the
pool logically exists).
- `ref:locked_lp_created_once_and_never_reminted`, `eng:w05`

## I-04 Swap positivity and boundedness
Successful swap requires input > 0, effective_input > 0 (else abort), output > 0 (else abort),
and output < pre-swap output reserve. Zero-effective-input trades are impossible (1-unit swaps
abort; 2/3-unit floors verified exactly).
- `ref:fee_table_exact_30_bps`, `ref:output_never_exceeds_pre_swap_reserve` (10,000 randomized),
  `eng:w01`, `eng:w02`

## I-05 Exact reserve accounting
After a successful swap: `reserve_in' == reserve_in + full_input` (fee retained in reserve for
LPs) and `reserve_out' == reserve_out − output`. After failed ops: byte-identical state.
- `ref:fuzz` (every swap), `eng:e03` (exact deposit of full input), `eng:w09` (atomicity)

## I-06 Constant-product growth (fee retention)
`k_after ≥ k_before` for every successful swap, computed in wide (256-bit in the model;
192-bit on-chain) precision so the CHECK cannot overflow and lie. Strict growth for the
30 bps tier; the trader must receive strictly less than the fee-free output.
- `ref:fuzz` (every swap), `eng:e03/e03b` (k_delta pinned exact: +272,802,100,000,000)

## I-07 Round-trip no-profit
A→B→A and B→A→B end with ≤ starting balance: single loops, hundreds/thousands of loops,
dust to full-reserve sizes, 5,000 randomized pool states per direction.
- `ref:round_trip_*`, `eng:w03`

## I-08 Rounding never compounds into profit
Same-direction outputs are monotone non-increasing over 10,000 iterations; fragmented trades
(k = 2..1000) never outperform one aggregate trade; alternating micro-swaps only lose;
LP self-trading (100% LP, fees returned to self) still nets ≤ 0.
- `ref:repeated_same_direction_tiny_swaps_no_extraction`, `ref:split_trade_never_beats_single_trade`,
  `ref:alternating_tiny_swaps_attacker_only_loses`, `ref:add_swap_remove_loops_no_compounding_profit`

## I-09 Proportional mint / redemption (exact floor identity)
Mint = `min(floor(a·S/r_a), floor(b·S/r_b))` against PRE-deposit reserves; redemption =
`floor(lp·r/S)` on both sides, both > 0 or abort. Zero-share mints and dust redemptions abort
atomically.
- `ref:fuzz` (every add/remove), `eng:w04`, `eng:w05`

## I-10 First-depositor defense
Bootstrap requires ≥ 1_000_000 both sides, mints `floor(sqrt(a·b))` with 1_000 locked; a
victim depositing 1000× the attacker receives exactly proportional LP and exact redemption;
the attacker redeems strictly less than deposited.
- `ref:first_depositor_cannot_capture_victim_value`, `eng:w04`

## I-11 Fee coherence (Uranium class)
One fee model: 30 bps of 10_000. Exact effective inputs pinned for inputs
1, 2, 3, 10, 100, 333, 334, 999, 1000, 9999, 10000, 10001 and 2^100. Engine output pinned
exactly (90_661_089) — a per-mil regression would produce 88_422_971 and fail.
- `ref:fee_table_exact_30_bps`, `eng:e03`, `ref:differential (fee table)`

## I-12 Authorization
LP mint and burn only when the acting frame is the pool component; `OwnerRule::None` removes
owner override; rules Locked. Untrusted-component mint/burn rejected. No admin/fee-withdrawal
entry points exist at all.
- `eng:w06`, `eng:w07`, `eng:w10`, `eng:e01`

## I-13 Resource identity
All identity decisions use exact ResourceAddress (canonical pair ordering, LP bucket check,
swap output routing). Symbol/metadata forgery has no effect.
- `eng:R03`, `eng:R10`, `eng:w08` (wrong-resource swap rejects inside the boundary)

## I-14 Failed-transaction atomicity
Every aborting condition leaves reserves, LP supply, locked LP, and attacker balances
unchanged (snapshot-compared).
- `eng:w09`, `ref:fuzz` (every failed op snapshot-compared)

## I-15 Reinitialization safety
After all ordinary LP exits, reserves are proportional nonzero dust; re-entry mints
proportional shares; locked supply never changes; re-entering LP redeems exactly their
deposit.
- `ref:zero_user_lp_reinit_is_proportional`, `ref:reinit_multiple_providers_sequential`, `eng:w05`

## I-16 Differential agreement
Two INDEPENDENT implementations (reference model with hand-checked 256-bit arithmetic vs
production pool_math) agree exactly across 22 boundary values × reserve matrices and 20,000
randomized cases.
- `ref:differential`
