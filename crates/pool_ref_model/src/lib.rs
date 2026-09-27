//! Independent reference model of the `fungible_pool` template's integer semantics.
//!
//! DELIBERATELY INDEPENDENT: this crate shares NO code with `pool_math` or the
//! template. It re-implements the on-chain arithmetic from the spec (fee in basis
//! points out of 10_000, floor division everywhere, multiply-before-divide, 192-bit
//! intermediates modeled with a hand-checked 256-bit type) so differential testing can
//! compare two independent implementations.
//!
//! No floating point anywhere. All arithmetic is checked. The 256-bit type exists only
//! so THE MODEL cannot overflow and lie about production behavior.

// ---------------------------------------------------------------------------
// Minimal checked 256-bit unsigned integer (limbs little-endian u64 x4)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct U256 {
    limbs: [u64; 4],
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Lexicographic from the MOST significant limb (limbs are little-endian).
impl Ord for U256 {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        for i in (0..4).rev() {
            match self.limbs[i].cmp(&other.limbs[i]) {
                core::cmp::Ordering::Equal => continue,
                o => return o,
            }
        }
        core::cmp::Ordering::Equal
    }
}

fn mul64(x: u64, y: u64) -> (u64, u64) {
    let prod = (x as u128) * (y as u128);
    (prod as u64, (prod >> 64) as u64)
}

impl U256 {
    pub fn from_u128(v: u128) -> Self {
        U256 {
            limbs: [v as u64, (v >> 64) as u64, 0, 0],
        }
    }

    /// Exact product of two u128 values; cannot overflow 256 bits.
    pub fn mul_u128(a: u128, b: u128) -> Self {
        let a0 = a as u64;
        let a1 = (a >> 64) as u64;
        let b0 = b as u64;
        let b1 = (b >> 64) as u64;
        let mut out = U256::default();
        let (l, h) = mul64(a0, b0);
        out.add_prod(l, h, 0);
        let (l, h) = mul64(a0, b1);
        out.add_prod(l, h, 1);
        let (l, h) = mul64(a1, b0);
        out.add_prod(l, h, 1);
        let (l, h) = mul64(a1, b1);
        out.add_prod(l, h, 2);
        out
    }

    /// Add a 128-bit value `(hi:lo)` shifted by `shift` 64-bit limbs.
    /// Carries out of the top limb are mathematically impossible for true products,
    /// and a carry there indicates a bug in the model itself, so we panic.
    fn add_prod(&mut self, lo: u64, hi: u64, shift: usize) {
        debug_assert!(shift <= 2);
        let (s, c) = self.limbs[shift].overflowing_add(lo);
        self.limbs[shift] = s;
        let mut carry = c as u64;
        let (s1, c1) = self.limbs[shift + 1].overflowing_add(hi);
        let (s2, c2) = s1.overflowing_add(carry);
        self.limbs[shift + 1] = s2;
        carry = (c1 as u64) + (c2 as u64);
        let mut i = shift + 2;
        while carry > 0 && i < 4 {
            let (s, c) = self.limbs[i].overflowing_add(carry);
            self.limbs[i] = s;
            carry = c as u64;
            i += 1;
        }
        assert!(
            carry == 0,
            "U256 accumulation overflow (bug in reference model)"
        );
    }

    pub fn is_zero(&self) -> bool {
        self.limbs == [0u64; 4]
    }

    /// self - other for self >= other (u128-valued `other`).
    fn sub_u128(&mut self, other: u128) {
        let o = U256::from_u128(other);
        debug_assert!(Ord::cmp(self, &o) != core::cmp::Ordering::Less);
        let mut borrow;
        let o_lo = o.limbs[0];
        let o_hi = o.limbs[1];
        let (s, b) = self.limbs[0].overflowing_sub(o_lo);
        self.limbs[0] = s;
        borrow = b as u64;
        let (s1, b1) = self.limbs[1].overflowing_sub(o_hi);
        let (s2, b2) = s1.overflowing_sub(borrow);
        self.limbs[1] = s2;
        borrow = (b1 as u64) + (b2 as u64);
        let mut i = 2;
        while borrow > 0 && i < 4 {
            let (s, b) = self.limbs[i].overflowing_sub(borrow);
            self.limbs[i] = s;
            borrow = b as u64;
            i += 1;
        }
        assert!(borrow == 0, "U256 underflow (bug in reference model)");
    }

    /// Floor division by a u128 divisor. Returns `Err(Overflow)` when the quotient does
    /// not fit in u128 (mirrors the template's `Amount::try_from(..).expect(..)` abort).
    pub fn div_u128_floor(&self, d: u128) -> Result<u128, ModelError> {
        assert!(d != 0, "division by zero (caller must have checked)");
        let d256 = U256::from_u128(d);
        let mut q: u128 = 0;
        let mut r = U256::default();
        for bit in (0..256).rev() {
            let b = (self.limbs[bit / 64] >> (bit % 64)) & 1;
            // r = r*2 + b
            shl1_add_bit(&mut r, b);
            // q = q*2 (+1 if r >= d)
            q = q.checked_mul(2).ok_or(ModelError::Overflow)?;
            if r.cmp(&d256) != core::cmp::Ordering::Less {
                r.sub_u128(d);
                q = q.checked_add(1).ok_or(ModelError::Overflow)?;
            }
        }
        Ok(q)
    }

    /// Floor square root via binary search over u128 candidates.
    /// `self` is at most (u128::MAX)^2, so the root always fits in u128.
    pub fn isqrt(&self) -> u128 {
        let mut lo: u128 = 1;
        let mut hi: u128 = u128::MAX;
        while lo <= hi {
            let mid = lo + (hi - lo) / 2;
            let sq = U256::mul_u128(mid, mid);
            match sq.cmp(self) {
                core::cmp::Ordering::Less => lo = mid + 1,
                core::cmp::Ordering::Greater => hi = mid - 1,
                core::cmp::Ordering::Equal => return mid,
            }
        }
        hi
    }
}

fn shl1_add_bit(r: &mut U256, bit: u64) {
    // r = r*2 + bit  (bits flow upward through limbs)
    let mut carry = bit;
    for limb in r.limbs.iter_mut() {
        let new_carry = *limb >> 63;
        *limb = (*limb << 1) | carry;
        carry = new_carry;
    }
    assert!(carry == 0, "U256 shl overflow (bug in reference model)");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelError {
    InvalidFee,
    ZeroInput,
    ZeroReserve,
    ZeroOutput,
    ZeroShares,
    BelowMinOutput,
    ZeroLp,
    BelowMinInitialLiquidity,
    Overflow,
}

// ---------------------------------------------------------------------------
// Reference pool — mirrors templates/fungible_pool/src/lib.rs semantics exactly
// ---------------------------------------------------------------------------

pub const FEE_DENOMINATOR: u128 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000;
pub const MIN_INITIAL_LIQUIDITY: u128 = 1_000_000;
pub const MIN_LOCKED: u128 = 1_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    A,
    B,
}

/// Pure numeric replica of the template. Resource identity / access control are
/// engine-level concerns and are covered by engine tests, not here.
#[derive(Clone, Debug)]
pub struct RefPool {
    pub reserve_a: u128,
    pub reserve_b: u128,
    pub total_supply: u128,
    pub locked: u128,
    pub fee_bps: u16,
}

impl RefPool {
    pub fn new(fee_bps: u16) -> Result<Self, ModelError> {
        if fee_bps == 0 || fee_bps > MAX_FEE_BPS {
            return Err(ModelError::InvalidFee);
        }
        Ok(RefPool {
            reserve_a: 0,
            reserve_b: 0,
            total_supply: 0,
            locked: 0,
            fee_bps,
        })
    }

    pub fn reserves(&self) -> (u128, u128) {
        (self.reserve_a, self.reserve_b)
    }

    pub fn k(&self) -> U256 {
        U256::mul_u128(self.reserve_a, self.reserve_b)
    }

    /// add_liquidity — mirrors the template branch-for-branch.
    /// Returns LP minted to the caller (locked share excluded on first deposit).
    pub fn add_liquidity(&mut self, a: u128, b: u128) -> Result<u128, ModelError> {
        if a == 0 || b == 0 {
            return Err(ModelError::ZeroInput);
        }
        if self.reserve_a == 0 && self.reserve_b == 0 {
            // FIRST DEPOSIT branch
            if a < MIN_INITIAL_LIQUIDITY || b < MIN_INITIAL_LIQUIDITY {
                return Err(ModelError::BelowMinInitialLiquidity);
            }
            let product = U256::mul_u128(a, b);
            let shares = product.isqrt();
            if shares < MIN_LOCKED {
                return Err(ModelError::ZeroShares);
            }
            self.reserve_a += a;
            self.reserve_b += b;
            self.total_supply = shares;
            self.locked = MIN_LOCKED;
            return Ok(shares - MIN_LOCKED);
        }
        // SUBSEQUENT DEPOSIT branch: proportional against PRE-deposit reserves.
        let shares_a = U256::mul_u128(a, self.total_supply).div_u128_floor(self.reserve_a)?;
        let shares_b = U256::mul_u128(b, self.total_supply).div_u128_floor(self.reserve_b)?;
        let shares = shares_a.min(shares_b);
        if shares == 0 {
            return Err(ModelError::ZeroShares);
        }
        self.reserve_a += a;
        self.reserve_b += b;
        self.total_supply += shares;
        Ok(shares)
    }

    /// Effective (fee-reduced) input: floor(in * (10_000 - fee) / 10_000).
    pub fn effective_input(&self, input: u128) -> Result<u128, ModelError> {
        if self.fee_bps >= FEE_DENOMINATOR as u16 {
            return Err(ModelError::InvalidFee);
        }
        if input == 0 {
            return Err(ModelError::ZeroInput);
        }
        let factor = FEE_DENOMINATOR - self.fee_bps as u128;
        U256::mul_u128(input, factor).div_u128_floor(FEE_DENOMINATOR)
    }

    /// Quote only (no state change): floor(r_out * eff / (r_in + eff)).
    pub fn quote(&self, side: Side, input: u128) -> Result<u128, ModelError> {
        if input == 0 {
            return Err(ModelError::ZeroInput);
        }
        let (r_in, r_out) = match side {
            Side::A => (self.reserve_a, self.reserve_b),
            Side::B => (self.reserve_b, self.reserve_a),
        };
        if r_in == 0 || r_out == 0 {
            return Err(ModelError::ZeroReserve);
        }
        let eff = self.effective_input(input)?;
        if eff == 0 {
            return Err(ModelError::ZeroInput);
        }
        let out = U256::mul_u128(r_out, eff).div_u128_floor(r_in + eff)?;
        if out == 0 {
            return Err(ModelError::ZeroOutput);
        }
        Ok(out)
    }

    /// swap — mirrors the template. Full input is deposited; output is withdrawn.
    pub fn swap(&mut self, side: Side, input: u128, min_output: u128) -> Result<u128, ModelError> {
        let out = self.quote(side, input)?;
        if out < min_output {
            return Err(ModelError::BelowMinOutput);
        }
        match side {
            Side::A => {
                self.reserve_a += input;
                self.reserve_b -= out;
            }
            Side::B => {
                self.reserve_b += input;
                self.reserve_a -= out;
            }
        }
        Ok(out)
    }

    /// remove_liquidity — mirrors the template (floor both sides, both must be > 0).
    pub fn remove_liquidity(&mut self, lp: u128) -> Result<(u128, u128), ModelError> {
        if lp == 0 {
            return Err(ModelError::ZeroLp);
        }
        if self.total_supply == 0 {
            return Err(ModelError::ZeroLp);
        }
        let a_out = U256::mul_u128(lp, self.reserve_a).div_u128_floor(self.total_supply)?;
        let b_out = U256::mul_u128(lp, self.reserve_b).div_u128_floor(self.total_supply)?;
        if a_out == 0 || b_out == 0 {
            return Err(ModelError::ZeroShares);
        }
        self.reserve_a -= a_out;
        self.reserve_b -= b_out;
        self.total_supply -= lp;
        Ok((a_out, b_out))
    }
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (splitmix64) for reproducible fuzzing
// ---------------------------------------------------------------------------

pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, n)
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            return 0;
        }
        self.next_u64() % n
    }
}
