//! Hostile security gauntlet against the independent reference model.
//!
//! Every test encodes an attack class from the historical AMM matrix and proves the
//! ROOT CLASS cannot translate to the pool's integer semantics. Conclusions are backed
//! by exact integer computation — never by inspection.

use pool_ref_model::{ModelError, RefPool, Rng, Side, MIN_LOCKED, U256};

fn pool_with_reserves(ra: u128, rb: u128) -> RefPool {
    let mut p = RefPool::new(30).unwrap();
    p.reserve_a = ra;
    p.reserve_b = rb;
    p
}

fn k_cmp(a: &RefPool, b: &RefPool) -> core::cmp::Ordering {
    a.k().cmp(&b.k())
}

// ---------------------------------------------------------------------------
// Round-trip no-profit invariant (mission item 9)
// ---------------------------------------------------------------------------

/// A→B→A must never profit: final A <= initial A, for single loops, hundreds and
/// thousands of loops, dust sizes, large sizes and near-reserve sizes.
#[test]
fn round_trip_a_b_a_never_profits() {
    let scenarios: [(u128, u128, u128); 7] = [
        (1_000_000, 1_000_000, 1),
        (1_000_000, 1_000_000, 3),
        (1_000_000, 1_000_000, 999),
        (1_000_000, 1_000_000, 100_000),
        (1_000_000, 1_000_000, 1_000_000), // full-reserve trade
        (1_000, 100_000_000, 500),         // extreme ratio
        (100_000_000, 1_000, 500),         // extreme ratio, other side
    ];
    for (ra, rb, size) in scenarios {
        let mut p = pool_with_reserves(ra, rb);
        let mut held = size;
        for i in 0..1_000u32 {
            let b_got = match p.swap(Side::A, held, 0) {
                Ok(o) => o,
                Err(_) => break, // dust exhausted: acceptable termination
            };
            let a_back = p.swap(Side::B, b_got, 0).unwrap_or(0);
            assert!(
                a_back <= held,
                "round-trip profit! scenario=({ra},{rb}) size={size} loop={} \
                 in={held} back={a_back} (gained {})",
                i + 1,
                a_back - held
            );
            held = a_back;
            if held == 0 {
                break;
            }
        }
    }
}

/// B→A→B direction through thousands of randomized pool states.
/// (All legs are tracked in their own currency: size and the final leg are B units.)
#[test]
fn round_trip_b_a_b_never_profits_randomized() {
    let mut rng = Rng::new(0x007E_A71A);
    for case in 0..5_000 {
        let ra = ((rng.next_u64() as u128 * rng.next_u64() as u128) % (1 << 100)) + 2;
        let rb = ((rng.next_u64() as u128 * rng.next_u64() as u128) % (1 << 100)) + 2;
        let size = 1 + rng.next_u64() as u128 % rb.min(1 << 60);
        let mut p = pool_with_reserves(ra, rb);
        let a_got = p.swap(Side::B, size, 0).unwrap(); // B -> A
        let b_back = p.swap(Side::A, a_got, 0).unwrap(); // A -> B
        assert!(
            b_back <= size,
            "case={case} r=({ra},{rb}) size={size} a={a_got} back={b_back}"
        );
    }
}

/// Thousands of randomized A→B→A loops with shrinking dust.
#[test]
fn round_trip_thousands_of_randomized_loops() {
    let mut rng = Rng::new(0xBEEF_0001);
    for case in 0..2_000 {
        let ra = 1 + rng.below(1 << 60) as u128;
        let rb = 1 + rng.below(1 << 60) as u128;
        let mut size = 1 + rng.below(1 << 40) as u128;
        let mut p = pool_with_reserves(ra, rb);
        for loop_i in 0..1_000u32 {
            let b = p
                .swap(Side::A, size, 0)
                .unwrap_or_else(|e| panic!("case={case} loop={loop_i} unexpected failure {e:?}"));
            let a = p.swap(Side::B, b, 0).unwrap_or(0);
            assert!(
                a <= size,
                "profit in case={case} loop={loop_i}: {a} > {size}"
            );
            size = a;
            if size == 0 {
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Rounding / precision drain gauntlet (mission item 8)
// ---------------------------------------------------------------------------

/// Repeated same-direction tiny swaps: output strictly non-increasing, k strictly
/// growing, and 10_001 fragmented trades must never outperform one aggregate trade.
#[test]
fn repeated_same_direction_tiny_swaps_no_extraction() {
    for &(ra, rb, size) in &[
        (1_000_000u128, 1_000_000u128, 3u128),
        (10_000_000, 7_777_777, 9),
        (1_000_000, 33_000_000, 2),
        (999, 1_000_000, 3),
    ] {
        let mut p = pool_with_reserves(ra, rb);
        let mut prev_out = p.swap(Side::A, size, 0).unwrap();
        let mut prev_k = p.k();
        let mut total_in = size;
        let mut total_out = prev_out;
        for i in 0..10_000u32 {
            let out = p
                .swap(Side::A, size, 0)
                .unwrap_or_else(|e| panic!("unexpected failure at iter {i}: {e:?}"));
            assert!(
                out <= prev_out,
                "same-direction output INCREASED (rounding extraction!): {out} > {prev_out}"
            );
            let k = p.k();
            assert!(
                k.cmp(&prev_k) != core::cmp::Ordering::Less,
                "k decreased at iter {i}"
            );
            prev_k = k;
            prev_out = out;
            total_in += size;
            total_out += out;
        }
        let mut single = pool_with_reserves(ra, rb);
        let single_out = single.swap(Side::A, total_in, 0).unwrap();
        assert!(
            total_out <= single_out,
            "fragmented trades outperformed the aggregate: {total_out} > {single_out}"
        );
    }
}

/// Alternating tiny swaps (A→B→A→B…) thousands of iterations: the attacker can only
/// lose. (They are not an LP, so they receive no fee income at all.)
#[test]
fn alternating_tiny_swaps_attacker_only_loses() {
    for &(ra, rb, size) in &[
        (1_000_000u128, 1_000_000u128, 3u128),
        (1_000_000, 1_000_000, 1_001),
        (50_000_000, 50_000_000, 997),
    ] {
        let mut p = pool_with_reserves(ra, rb);
        let start_a = size;
        let mut held_a = size;
        let mut held_b = 0u128;
        let mut holding_a = true;
        for i in 0..5_000u32 {
            let (got, spent) = if holding_a {
                let got = p.swap(Side::A, held_a, 0).unwrap_or(0);
                (got, if got > 0 { held_a } else { 0 })
            } else {
                let got = p.swap(Side::B, held_b, 0).unwrap_or(0);
                (got, if got > 0 { held_b } else { 0 })
            };
            if holding_a {
                held_a -= spent;
                held_b += got;
            } else {
                held_b -= spent;
                held_a += got;
                // each completed A→B→A round must not exceed the starting A
                assert!(
                    held_a <= start_a,
                    "iter={i}: attacker holds {held_a} > {start_a} (free value)"
                );
            }
            if got > 0 {
                holding_a = !holding_a;
            }
        }
        assert!(
            held_a <= start_a,
            "attacker ended with more A: {held_a} > {start_a}"
        );
    }
}

/// add→swap→remove loops (LP self-trading): a 100% LP pays fees to itself, so the net
/// effect must still be <= 0 — rounding must never compound into attacker profit.
#[test]
fn add_swap_remove_loops_no_compounding_profit() {
    for &(run, trade) in &[(1u32, 997u128), (2, 3), (3, 100_003)] {
        let mut p = RefPool::new(30).unwrap();
        let initial = 1_000_000u128;
        let lp = p.add_liquidity(initial, initial).unwrap(); // 999_000
                                                             // The deposit is consumed by add_liquidity; the attacker holds LP plus a
                                                             // separate trading float of `initial` A (the currency they will trade).
        let float = initial;
        let mut held_a = float;
        let mut held_b = 0u128;
        for i in 0..2_000u32 {
            let chunk = trade.min(held_a);
            if chunk > 0 {
                if let Ok(b) = p.swap(Side::A, chunk, 0) {
                    held_a -= chunk;
                    held_b += b;
                    if let Ok(back) = p.swap(Side::B, b, 0) {
                        held_b -= b;
                        held_a += back;
                        assert!(back <= chunk, "run={run} iter={i}: round-trip profit");
                    }
                    // else: B chunk too small to swap back — attacker is stuck holding
                    // it (strictly worse for them; no free value was created).
                }
            }
        }
        let (ra, rb) = p.remove_liquidity(lp).unwrap();
        held_a += ra;
        held_b += rb;
        // 100% LP receives all fees back, so the ONLY possible deltas are rounding
        // losses: total holdings must never exceed what the attacker put in.
        assert!(
            held_a + held_b <= float + 2 * initial,
            "run={run}: LP self-trading profited: a={held_a} b={held_b}"
        );
        assert!(held_a <= float + 2 * initial);
    }
}

/// Extreme reserve ratios with randomized trades: output must always be strictly below
/// the pre-swap output reserve, and equal to the exact floor identity.
#[test]
fn output_never_exceeds_pre_swap_reserve() {
    let mut rng = Rng::new(0x0777_1234);
    for _ in 0..10_000 {
        let ra = 1 + (rng.next_u64() as u128) % (1 << 90);
        let rb = 1 + (rng.next_u64() as u128) % (1 << 90);
        let input = 1 + (rng.next_u64() as u128) % (1 << 90);
        let p = pool_with_reserves(ra, rb);
        if let Ok(out) = p.quote(Side::A, input) {
            assert!(out < rb, "output {out} >= reserve {rb}");
            let eff = p.effective_input(input).unwrap();
            assert_eq!(
                out,
                U256::mul_u128(rb, eff).div_u128_floor(ra + eff).unwrap()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Split-trade fee attack (mission item 10)
// ---------------------------------------------------------------------------

/// One trade of X vs k trades of X/k for k = 2, 3, 10, 100, 1000.
/// Fragmenting must never outperform the single trade (fee is superadditive and each
/// subtrade floors against the trader).
#[test]
fn split_trade_never_beats_single_trade() {
    let cases = [
        (1_000_000u128, 1_000_000u128, 100_000u128),
        (1_000_000, 1_000_000, 3),
        (1_000_000, 1_000_000, 10_001),
        (7_000_000, 3_000_000, 999),
        (1, 1, 1),
        (u64::MAX as u128, u64::MAX as u128, 1 << 32),
    ];
    for &(ra, rb, x) in &cases {
        let mut single = pool_with_reserves(ra, rb);
        let single_out = match single.swap(Side::A, x, 0) {
            Ok(o) => o,
            Err(_) => continue,
        };
        for &k in &[2u128, 3, 10, 100, 1000] {
            let chunk = x / k;
            if chunk == 0 {
                continue;
            }
            let mut split = pool_with_reserves(ra, rb);
            let mut total = 0u128;
            for _ in 0..k {
                if let Ok(o) = split.swap(Side::A, chunk, 0) {
                    total += o;
                } else {
                    break;
                }
            }
            assert!(
                total <= single_out,
                "split outperformed single: r=({ra},{rb}) x={x} k={k} \
                 split={total} single={single_out}"
            );
        }
    }
}

/// The 30-bps fee table: exact effective inputs for the mandated probe values.
#[test]
fn fee_table_exact_30_bps() {
    let p = RefPool::new(30).unwrap();
    // (input, expected effective input) — hand-derived floor(in*9970/10_000)
    let table: [(u128, u128); 12] = [
        (1, 0),     // 9_970/10_000 = 0 -> swap must abort (never a free trade)
        (2, 1),     // 19_940/10_000
        (3, 2),     // 29_910/10_000
        (10, 9),    // 99_700/10_000
        (100, 99),  // 997_000/10_000
        (333, 332), // 3_320_010/10_000
        (334, 332), // 3_329_980/10_000
        (999, 996), // 9_960_030/10_000
        (1000, 997),
        (9999, 9969), // 99_690_030/10_000
        (10000, 9970),
        (10001, 9970), // 99_709_970/10_000
    ];
    for (input, expected) in table {
        let eff = p.effective_input(input).unwrap();
        assert_eq!(eff, expected, "fee table mismatch at input {input}");
        if expected == 0 {
            // with live reserves, a zero-effective input must abort (never a free trade)
            let funded = pool_with_reserves(1_000_000, 1_000_000);
            assert_eq!(
                funded.quote(Side::A, input),
                Err(ModelError::ZeroInput),
                "input {input} must abort (free trade)"
            );
        }
    }
    // huge input: 2^100 * 9970 / 10_000, exact
    let big = 1u128 << 100;
    let expected = (big / 10_000) * 9_970 + ((big % 10_000) * 9_970) / 10_000;
    assert_eq!(p.effective_input(big).unwrap(), expected);
}

// ---------------------------------------------------------------------------
// First-depositor / share inflation (mission item 12)
// ---------------------------------------------------------------------------

/// Attacker seeds the pool; a much larger victim joins; attacker redeems.
/// The attacker must end up with LESS than they deposited (their locked-LP dilution is
/// a cost), and the victim must receive exactly proportional LP and redemption.
#[test]
fn first_depositor_cannot_capture_victim_value() {
    let mut p = RefPool::new(30).unwrap();
    let attacker_deposit = 1_000_000u128;
    let attacker_lp = p.add_liquidity(attacker_deposit, attacker_deposit).unwrap();
    assert_eq!(attacker_lp, 999_000);
    assert_eq!(p.total_supply, 1_000_000);
    assert_eq!(p.locked, MIN_LOCKED);

    let victim_deposit = 1_000_000_000u128; // 1000x the attacker
    let victim_lp = p.add_liquidity(victim_deposit, victim_deposit).unwrap();
    assert_eq!(victim_lp, 1_000_000_000);

    let (a_out, b_out) = p.remove_liquidity(attacker_lp).unwrap();
    assert!(
        a_out < attacker_deposit,
        "attacker redeemed a profit: {a_out}"
    );
    assert!(
        b_out < attacker_deposit,
        "attacker redeemed a profit: {b_out}"
    );

    let victim_holds = p.total_supply - p.locked;
    let (va, vb) = p.remove_liquidity(victim_holds).unwrap();
    assert_eq!(va, victim_deposit, "victim under-redeemed A");
    assert_eq!(vb, victim_deposit, "victim under-redeemed B");
    assert_eq!(p.total_supply, MIN_LOCKED);
    assert_eq!(p.locked, MIN_LOCKED);
    assert!(p.locked <= p.total_supply);
}

/// dust/dust first deposits and extreme asymmetry must be rejected or handled
/// proportionally — never mint disproportionate shares.
#[test]
fn first_deposit_extremes() {
    let mut p = RefPool::new(30).unwrap();
    assert_eq!(
        p.add_liquidity(999_999, 1_000_000),
        Err(ModelError::BelowMinInitialLiquidity)
    );
    assert_eq!(
        p.add_liquidity(1, 1),
        Err(ModelError::BelowMinInitialLiquidity)
    );
    assert_eq!(
        p.total_supply, 0,
        "failed first deposit must leave no state"
    );

    // valid but asymmetric: shares = floor(sqrt(a*b)) - locked
    let mut p2 = RefPool::new(30).unwrap();
    let shares = p2.add_liquidity(10_000_000, 1_000_000).unwrap();
    assert_eq!(shares, 3_162_277 - MIN_LOCKED); // floor(sqrt(1e13)) = 3_162_277
    assert_eq!(p2.locked, MIN_LOCKED);
}

// ---------------------------------------------------------------------------
// Zero-supply / reinitialization (mission item 15)
// ---------------------------------------------------------------------------

/// Empty the pool to only-locked-LP and re-deposit. The pool must NOT re-enter the
/// first-deposit branch (reserves remain nonzero dust backed by locked LP), and the
/// re-entering LP must not over-mint or over-redeem beyond proportionality.
#[test]
fn zero_user_lp_reinit_is_proportional() {
    let mut p = RefPool::new(30).unwrap();
    let initial = 10_000_000u128;
    let lp = p.add_liquidity(initial, initial).unwrap();
    let (a_out, b_out) = p.remove_liquidity(lp).unwrap();
    assert_eq!(p.total_supply, MIN_LOCKED);
    assert_eq!(p.locked, MIN_LOCKED);
    let dust_a = initial - a_out;
    let dust_b = initial - b_out;
    assert_eq!(dust_a, 1_000); // 1e7 * 1000 / 1e7
    assert!(dust_a > 0 && dust_b > 0, "bootstrap must not be reachable");

    let newcomer = 1_000_000u128;
    let shares = p.add_liquidity(newcomer, newcomer).unwrap();
    // proportional against PRE-deposit dust: 1e6 * 1000 / 1000 = 1e6 (both sides equal)
    assert_eq!(shares, newcomer * p_locked_supply_for_test() / dust_a);
    assert_eq!(p.locked, MIN_LOCKED, "bootstrap branch must not re-lock");

    // Newcomer redeems: gets back their deposit; the locked dust stays with locked LP.
    let (ra, rb) = p.remove_liquidity(shares).unwrap();
    assert_eq!(ra, newcomer, "reinit over-redemption: {ra}");
    assert_eq!(rb, newcomer, "reinit over-redemption: {rb}");
    assert_eq!(p.total_supply, MIN_LOCKED);
    assert_eq!(p.reserve_a, dust_a);
    assert_eq!(p.reserve_b, dust_b);
}

/// Sequential re-entry by MULTIPLE providers after full exit must remain proportional
/// and let no provider over-redeem.
#[test]
fn reinit_multiple_providers_sequential() {
    let mut p = RefPool::new(30).unwrap();
    let lp0 = p.add_liquidity(2_000_000, 2_000_000).unwrap();
    let _ = p.remove_liquidity(lp0).unwrap();
    assert_eq!(p.total_supply, MIN_LOCKED);
    let dust = p.reserve_a;
    let s1 = p.add_liquidity(5_000_000, 5_000_000).unwrap();
    assert_eq!(s1, 5_000_000 * p_locked_supply_for_test() / dust);
    let s2 = p.add_liquidity(1_000_000, 1_000_000).unwrap();
    let (a1, b1) = p.remove_liquidity(s1).unwrap();
    assert!(a1 <= 5_000_000, "provider 1 over-redeemed: {a1}");
    assert!(b1 <= 5_000_000, "provider 1 over-redeemed: {b1}");
    let (a2, b2) = p.remove_liquidity(s2).unwrap();
    assert!(a2 <= 1_000_000, "provider 2 over-redeemed: {a2}");
    assert!(b2 <= 1_000_000, "provider 2 over-redeemed: {b2}");
    assert_eq!(p.total_supply, MIN_LOCKED);
}

fn p_locked_supply_for_test() -> u128 {
    MIN_LOCKED
}

// ---------------------------------------------------------------------------
// Locked LP supply (mission item 13)
// ---------------------------------------------------------------------------

/// Locked LP is created exactly once, is part of total supply, and while it exists the
/// reserves can never reach zero — so the first-deposit (bootstrap) branch is
/// unreachable while the pool logically exists. (The engine-level proof that nobody can
/// withdraw/burn/transfer the locked shares lives in the real-engine tests: the locked
/// vault is component-owned and no method exposes it.)
#[test]
fn locked_lp_created_once_and_never_reminted() {
    let mut p = RefPool::new(30).unwrap();
    let _ = p.add_liquidity(1_000_000, 1_000_000).unwrap();
    assert_eq!(p.locked, MIN_LOCKED);
    for i in 0..50u128 {
        let _ = p.add_liquidity(1_000_000 + i, 1_000_000 + i).unwrap();
        assert_eq!(p.locked, MIN_LOCKED, "locked supply changed after mint {i}");
    }
    assert!(p.locked <= p.total_supply);
    let user = p.total_supply - p.locked;
    let _ = p.remove_liquidity(user).unwrap();
    assert_eq!(p.total_supply, MIN_LOCKED);
    assert!(
        p.reserve_a > 0 && p.reserve_b > 0,
        "dust must remain backed"
    );
    // Bootstrap branch condition (both reserves zero) is unreachable:
    assert!(p.reserve_a > 0 || p.reserve_b > 0);
}

// ---------------------------------------------------------------------------
// Overflow / underflow boundaries (mission item 29)
// ---------------------------------------------------------------------------

#[test]
fn arithmetic_near_amount_max() {
    // near-u128::MAX reserves: 192-bit intermediates in production; 256-bit here
    let ra = u128::MAX / 4;
    let rb = u128::MAX / 4;
    let before = pool_with_reserves(ra, rb);
    let mut p = pool_with_reserves(ra, rb);
    let input = u128::MAX / 4;
    let out = p.swap(Side::A, input, 0).unwrap();
    assert!(out > 0 && out < rb);
    assert_eq!(p.reserve_a, ra + input);
    assert_eq!(p.reserve_b, rb - out);
    assert_eq!(k_cmp(&p, &before), core::cmp::Ordering::Greater);

    // add_liquidity near max
    let mut p2 = RefPool::new(30).unwrap();
    // asymmetric first deposit: reserve_a >> supply, so a 1-unit deposit floors to
    // zero shares on the A side and must abort, never mint free shares
    let shares = p2.add_liquidity(1u128 << 127, 1u128 << 64).unwrap();
    assert!(shares > 0);
    assert_eq!(p2.add_liquidity(1, 1), Err(ModelError::ZeroShares));

    // remove_liquidity near max
    let mut p3 = RefPool::new(30).unwrap();
    let b3 = u128::MAX / 8;
    let lp3 = p3.add_liquidity(b3, b3).unwrap();
    let (x, y) = p3.remove_liquidity(lp3).unwrap();
    assert!(x > 0 && y > 0);
    assert_eq!(p3.total_supply, MIN_LOCKED);
}

/// Division-by-zero and zero-reserve behavior at the exact boundaries.
#[test]
fn zero_reserve_boundaries() {
    let p = pool_with_reserves(0, 0);
    // quote with zero reserves must fail, never divide by zero or return free output
    assert_eq!(p.quote(Side::A, 1_000), Err(ModelError::ZeroReserve));
    let p2 = pool_with_reserves(1, 0);
    assert_eq!(p2.quote(Side::A, 1_000), Err(ModelError::ZeroReserve));
    let p3 = pool_with_reserves(0, 1);
    assert_eq!(p3.quote(Side::A, 1_000), Err(ModelError::ZeroReserve));
}
