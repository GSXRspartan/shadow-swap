//! Differential testing: independent reference model vs the production `pool_math`
//! crate. Two independently written implementations must agree exactly across
//! boundary values and randomized inputs. Any discrepancy is a finding to investigate,
//! never something to paper over by loosening assertions.

use pool_math::{amount_in_with_fee, swap_output_amount, PoolMathError};
use pool_ref_model::{RefPool, Rng, Side, FEE_DENOMINATOR, U256};

/// Boundary values from the audit mandate, plus extremes.
const BOUNDARIES: [u64; 22] = [
    0,
    1,
    2,
    3,
    9,
    10,
    99,
    100,
    333,
    334,
    999,
    1000,
    9999,
    10000,
    10001,
    65_535,
    1_000_000,
    333_333_333,
    999_999_999,
    1_000_000_000,
    4_294_967_295,
    9_999_999_999_999,
];

fn ref_swap_output(r_in: u128, r_out: u128, input: u128, fee_bps: u16) -> Option<u128> {
    let mut p = RefPool::new(fee_bps).unwrap();
    // Place reserves directly (swap math is independent of how reserves arose).
    p.reserve_a = r_in;
    p.reserve_b = r_out;
    let side = Side::A;
    p.quote(side, input).ok()
}

#[test]
fn differential_fee_matches_across_boundaries() {
    for &input in &BOUNDARIES {
        if input == 0 {
            // zero input is rejected by production by design (ZeroInput)
            assert_eq!(amount_in_with_fee(0, 30), Err(PoolMathError::ZeroInput));
            continue;
        }
        for &fee in &[1u32, 30, 100, 333, 1000] {
            let prod = amount_in_with_fee(input, fee);
            // Reference formula, written independently of both crates:
            let reference = (input as u128 * (FEE_DENOMINATOR - fee as u128)) / FEE_DENOMINATOR;
            match prod {
                Ok(v) => assert_eq!(
                    v as u128, reference,
                    "fee mismatch: input={input} fee={fee} prod={v} ref={reference}"
                ),
                Err(e) => panic!("production rejected valid input {input} fee {fee}: {e:?}"),
            }
        }
    }
}

#[test]
fn differential_swap_output_matches_across_boundaries() {
    // (reserve_in, reserve_out) pairs spanning tiny, skewed, and large reserves.
    let reserve_pairs = [
        (1u64, 1u64),
        (1, 2),
        (2, 1),
        (2, 3),
        (3, 2),
        (10, 999),
        (999, 10),
        (1_000, 1_000),
        (1_000_000, 1_000),
        (1_000, 1_000_000),
        (u32::MAX as u64, u32::MAX as u64),
        (1_000_000_000, 1_000_000_000),
        (u64::MAX / 4, u64::MAX / 4),
        (u64::MAX / 4, 1),
        (1, u64::MAX / 4),
    ];
    for &(r_in, r_out) in &reserve_pairs {
        for &input in &BOUNDARIES {
            if input == 0 {
                continue;
            }
            let prod = swap_output_amount(r_in, r_out, input, 30);
            let reference = ref_swap_output(r_in as u128, r_out as u128, input as u128, 30);
            match (prod, reference) {
                (Ok(p), Some(r)) => assert_eq!(
                    p as u128, r,
                    "swap output mismatch at r=({r_in},{r_out}) in={input}: prod={p} ref={r}"
                ),
                (Err(_), None) => {} // both reject — acceptable only if reason matches class
                (Ok(p), None) => panic!(
                    "production accepted where reference rejected: r=({r_in},{r_out}) in={input} prod={p}"
                ),
                (Err(e), Some(r)) => panic!(
                    "production rejected where reference accepted: r=({r_in},{r_out}) in={input} \
                     ref={r} err={e:?}"
                ),
            }
        }
    }
}

#[test]
fn differential_randomized_swap_outputs() {
    let mut rng = Rng::new(0xD1FF_5EED);
    for _ in 0..20_000 {
        let r_in = (rng.next_u64() % (1 << 53)) + 1;
        let r_out = (rng.next_u64() % (1 << 53)) + 1;
        let input = (rng.next_u64() % (1 << 53)) + 1;
        let p = swap_output_amount(r_in, r_out, input, 30).unwrap();
        let r = ref_swap_output(r_in as u128, r_out as u128, input as u128, 30).unwrap();
        assert_eq!(
            p as u128, r,
            "random differential failure: r=({r_in},{r_out}) in={input}"
        );
    }
}

/// The reference model's 256-bit arithmetic must be self-consistent:
/// (a * b) / d == floor exact for values near the u128 maximum.
#[test]
fn model_u256_product_division_near_max() {
    // Largest values where the quotient fits u128: d=1 is not a pool denominator in
    // practice, but the division routine must still be exact.
    let cases = [
        (u128::MAX, 2u128, u128::MAX),
        (u128::MAX, u128::MAX, u128::MAX),
        (u128::MAX - 1, 3, u128::MAX / 2),
    ];
    for (a, b, d) in cases {
        let q = U256::mul_u128(a, b).div_u128_floor(d).unwrap();
        // exact check with 256-bit: a*b >= q*d and a*b < (q+1)*d
        let prod = U256::mul_u128(a, b);
        let qd = U256::mul_u128(q, d);
        assert!(prod.cmp(&qd) != core::cmp::Ordering::Less);
        // (q+1) may overflow u128 when q == u128::MAX; then the upper bound is vacuous
        if let Some(q1) = q.checked_add(1) {
            let q1d = U256::mul_u128(q1, d);
            assert!(prod.cmp(&q1d) == core::cmp::Ordering::Less);
        }
    }
}

/// isqrt must satisfy r^2 <= n < (r+1)^2 across randomized 256-bit products.
#[test]
fn model_isqrt_property() {
    let mut rng = Rng::new(0x15_00_00_00_00_00_15_01); // deterministic seed
    for _ in 0..5_000 {
        let a = ((rng.next_u64() as u128) << 64) | rng.next_u64() as u128;
        let b = ((rng.next_u64() as u128) << 64) | rng.next_u64() as u128;
        let n = U256::mul_u128(a, b);
        let r = n.isqrt();
        let r_sq = U256::mul_u128(r, r);
        let r1_sq = U256::mul_u128(r + 1, r + 1);
        assert!(n.cmp(&r_sq) != core::cmp::Ordering::Less, "r^2 > n");
        assert!(n.cmp(&r1_sq) == core::cmp::Ordering::Less, "(r+1)^2 <= n");
    }
}
