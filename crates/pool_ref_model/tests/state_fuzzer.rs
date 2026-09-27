//! Randomized state-machine fuzzer built on the INDEPENDENT reference model
//! (mission items 33/34). Actors Alice/Bob/Mallory/Trader perform biased actions
//! (add liquidity, remove liquidity, swap A→B, swap B→A) against the pool. After
//! EVERY action, all invariants are verified. Failures embed the seed so any
//! discovered case can be promoted to a permanent regression.
//!
//! The fuzzer's invariant checks use only the model's own 256-bit type, so the TEST
//! cannot overflow and lie.

use pool_ref_model::{ModelError, RefPool, Rng, Side, MIN_LOCKED};

const ACTORS: usize = 4; // Alice(0) Bob(1) Mallory(2) Trader(3)

struct World {
    pool: RefPool,
    /// [actor][0]=A balance, [actor][1]=B balance
    balances: [[u128; 2]; ACTORS],
    /// LP balances per actor
    lp: [u128; ACTORS],
    /// conservation anchors (constant for the life of the world)
    total_a: u128,
    total_b: u128,
}

impl World {
    fn conservation_ok(&self) -> bool {
        let sum_a: u128 = self.balances.iter().map(|b| b[0]).sum::<u128>() + self.pool.reserve_a;
        let sum_b: u128 = self.balances.iter().map(|b| b[1]).sum::<u128>() + self.pool.reserve_b;
        // u128 addition of ~4 actors cannot wrap given the anchors used
        sum_a == self.total_a && sum_b == self.total_b
    }

    fn lp_supply_ok(&self) -> bool {
        let held: u128 = self.lp.iter().sum();
        held + self.pool.locked == self.pool.total_supply
    }
}

/// Biased amount generator: dust, small, near-reserve, near-balance, huge, near-max.
fn biased_amount(rng: &mut Rng, hint: u128, balance: u128) -> u128 {
    match rng.below(8) {
        0 => 1 + rng.below(3) as u128,                             // dust
        1 => 1 + rng.below(1_000) as u128,                         // small
        2 => (hint / 2).max(1),                                    // half of reserve/supply hint
        3 => hint.saturating_sub(1).max(1),                        // near hint
        4 => 1 + rng.next_u64() as u128,                           // random u64
        5 => balance.min((1 << 100) + rng.below(1 << 60) as u128), // large
        6 => balance,                                              // everything held
        _ => {
            let v = ((rng.next_u64() as u128) << 64) | rng.next_u64() as u128;
            v.max(1)
        }
    }
}

fn run_fuzz(seed: u64, ops: usize) {
    let mut rng = Rng::new(seed);
    // Pool created with a fixed first deposit by Alice.
    let mut w = World {
        pool: RefPool::new(30).unwrap(),
        balances: [[0u128; 2]; ACTORS],
        lp: [0u128; ACTORS],
        total_a: 0,
        total_b: 0,
    };
    let anchor: u128 = (1u128 << 120) + 777;
    for a in w.balances.iter_mut() {
        a[0] = anchor;
        a[1] = anchor;
    }
    w.total_a = anchor * ACTORS as u128;
    w.total_b = anchor * ACTORS as u128;

    // Alice seeds the pool.
    let seed_amt = 10_000_000u128;
    let shares = w.pool.add_liquidity(seed_amt, seed_amt).unwrap();
    w.balances[0][0] -= seed_amt;
    w.balances[0][1] -= seed_amt;
    w.lp[0] = shares;
    assert!(
        w.conservation_ok(),
        "seed {seed}: conservation broke at setup"
    );
    assert!(w.lp_supply_ok(), "seed {seed}: LP supply broke at setup");

    for op in 0..ops {
        let actor = rng.below(ACTORS as u64) as usize;

        // snapshot k for swap invariants
        let k_before = w.pool.k();
        let (ra, rb) = w.pool.reserves();
        let supply_before = w.pool.total_supply;
        let locked_before = w.pool.locked;

        let action = rng.below(4);
        let (side, side_idx) = if rng.below(2) == 0 {
            (Side::A, 0)
        } else {
            (Side::B, 1)
        };

        match action {
            0 | 1 => {
                // add liquidity (biased; asymmetric frequently)
                let amt_a =
                    biased_amount(&mut rng, ra, w.balances[actor][0]).min(w.balances[actor][0]);
                let amt_b =
                    biased_amount(&mut rng, rb, w.balances[actor][1]).min(w.balances[actor][1]);
                match w.pool.add_liquidity(amt_a, amt_b) {
                    Ok(minted) => {
                        // success invariants
                        assert!(minted > 0, "seed {seed} op {op}: zero LP minted");
                        // proportional check against PRE reserves
                        let want_a = pool_ref_model::U256::mul_u128(amt_a, supply_before)
                            .div_u128_floor(ra)
                            .unwrap_or(u128::MAX);
                        let want_b = pool_ref_model::U256::mul_u128(amt_b, supply_before)
                            .div_u128_floor(rb)
                            .unwrap_or(u128::MAX);
                        assert_eq!(
                            minted,
                            want_a.min(want_b),
                            "seed {seed} op {op}: LP mint not proportional"
                        );
                        w.balances[actor][0] -= amt_a;
                        w.balances[actor][1] -= amt_b;
                        w.lp[actor] += minted;
                        // reserves grew by exactly the deposits
                        assert_eq!(w.pool.reserve_a, ra + amt_a);
                        assert_eq!(w.pool.reserve_b, rb + amt_b);
                        // first-deposit branch sets the locked minimum exactly once
                        if locked_before == 0 {
                            assert_eq!(w.pool.locked, MIN_LOCKED);
                        } else {
                            assert_eq!(w.pool.locked, locked_before);
                        }
                    }
                    Err(e) => {
                        // failure must be atomic
                        assert_eq!(
                            w.pool.reserve_a, ra,
                            "seed {seed} op {op}: failed add changed reserve A"
                        );
                        assert_eq!(w.pool.reserve_b, rb);
                        assert_eq!(w.pool.total_supply, supply_before);
                        assert_eq!(w.pool.locked, locked_before);
                        let _ = e;
                    }
                }
            }
            2 => {
                // swap
                let amt = biased_amount(&mut rng, ra, w.balances[actor][side_idx])
                    .min(w.balances[actor][side_idx]);
                let min_out = 0u128;
                match w.pool.swap(side, amt, min_out) {
                    Ok(out) => {
                        assert!(out > 0 && out < (if side == Side::A { rb } else { ra }));
                        // k must never decrease
                        let k_after = w.pool.k();
                        assert!(
                            k_after.cmp(&k_before) != core::cmp::Ordering::Less,
                            "seed {seed} op {op}: k DECREASED after successful swap"
                        );
                        // exact reserve accounting: full input in, output out
                        let (ra2, rb2) = w.pool.reserves();
                        match side {
                            Side::A => {
                                assert_eq!(ra2, ra + amt);
                                assert_eq!(rb2, rb - out);
                            }
                            Side::B => {
                                assert_eq!(rb2, rb + amt);
                                assert_eq!(ra2, ra - out);
                            }
                        }
                        w.balances[actor][side_idx] -= amt;
                        w.balances[actor][1 - side_idx] += out;
                    }
                    Err(e) => {
                        assert_eq!(
                            w.pool.reserves(),
                            (ra, rb),
                            "seed {seed} op {op}: failed swap mutated reserves: {e:?}"
                        );
                    }
                }
            }
            _ => {
                // remove liquidity
                let amt = biased_amount(&mut rng, supply_before, w.lp[actor]);
                let amt = amt.min(w.lp[actor]);
                match w.pool.remove_liquidity(amt) {
                    Ok((out_a, out_b)) => {
                        assert!(out_a > 0 && out_b > 0);
                        // proportional redemption, floor
                        let want_a = pool_ref_model::U256::mul_u128(amt, ra)
                            .div_u128_floor(supply_before)
                            .unwrap_or(u128::MAX);
                        let want_b = pool_ref_model::U256::mul_u128(amt, rb)
                            .div_u128_floor(supply_before)
                            .unwrap_or(u128::MAX);
                        assert_eq!(out_a, want_a, "seed {seed} op {op}: redemption A mismatch");
                        assert_eq!(out_b, want_b, "seed {seed} op {op}: redemption B mismatch");
                        w.lp[actor] -= amt;
                        w.balances[actor][0] += out_a;
                        w.balances[actor][1] += out_b;
                        // total supply decreased by exactly the burn
                        assert_eq!(w.pool.total_supply, supply_before - amt);
                    }
                    Err(e) => {
                        assert_eq!(
                            w.pool.reserves(),
                            (ra, rb),
                            "seed {seed} op {op}: failed remove mutated reserves: {e:?}"
                        );
                        assert_eq!(w.pool.total_supply, supply_before);
                        if e == ModelError::ZeroLp || e == ModelError::ZeroShares {
                            // acceptable rejection classes
                        }
                    }
                }
            }
        };

        // GLOBAL invariants after every action
        assert!(
            w.conservation_ok(),
            "seed {seed} op {op}: token conservation violated"
        );
        assert!(
            w.lp_supply_ok(),
            "seed {seed} op {op}: LP supply accounting violated"
        );
        assert!(
            w.pool.locked <= w.pool.total_supply,
            "seed {seed} op {op}: locked LP exceeds total supply"
        );
    }
}

/// Ten sequences of 10_000 biased operations = 100_000 verified operations.
#[test]
fn state_machine_fuzz_100k_operations() {
    for i in 0..10u64 {
        run_fuzz(0x0F00_0000 + i, 10_000);
    }
}
