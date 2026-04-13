use crate::errors::CCAError;
use anchor_lang::prelude::*;

/// Compute (a * b) / c using u128 widening to avoid overflow.
pub fn mul_div(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c != 0, CCAError::MathOverflow);
    // Use 256-bit intermediate via splitting into hi/lo
    let (hi, lo) = wide_mul(a, b);
    wide_div(hi, lo, c)
}

/// Same as mul_div but rounds up.
pub fn mul_div_round_up(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c != 0, CCAError::MathOverflow);
    let (hi, lo) = wide_mul(a, b);
    let result = wide_div(hi, lo, c)?;
    // Check if there's a remainder
    let (remainder_hi, remainder_lo) = wide_mul(result, c);
    if remainder_hi != hi || remainder_lo != lo {
        result.checked_add(1).ok_or(error!(CCAError::MathOverflow))
    } else {
        Ok(result)
    }
}

pub fn saturating_sub(a: u128, b: u128) -> u128 {
    a.saturating_sub(b)
}

/// Widening multiply: returns (hi, lo) of a 256-bit product.
fn wide_mul(a: u128, b: u128) -> (u128, u128) {
    let a_lo = a & u64::MAX as u128;
    let a_hi = a >> 64;
    let b_lo = b & u64::MAX as u128;
    let b_hi = b >> 64;

    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;

    let mid = lh + hl;
    let lo = ll.wrapping_add(mid << 64);
    let carry = if lo < ll { 1u128 } else { 0u128 };
    let hi = hh + (mid >> 64) + carry;

    (hi, lo)
}

/// Divide a 256-bit number (hi, lo) by divisor, returning a u128 result.
/// Errors if the result doesn't fit in u128.
fn wide_div(hi: u128, lo: u128, divisor: u128) -> Result<u128> {
    require!(divisor != 0, CCAError::MathOverflow);
    if hi == 0 {
        return Ok(lo / divisor);
    }
    // Result must fit in u128, so hi must be < divisor.
    require!(hi < divisor, CCAError::MathOverflow);

    // Bit-by-bit shift-subtract long division. The conceptual remainder is up
    // to 129 bits wide after each shift; we track the overflow bit explicitly
    // so the u128 `rem` only ever holds the low 128 bits.
    let mut rem = hi;
    let mut quot: u128 = 0;
    for i in (0..128).rev() {
        let bit = (lo >> i) & 1;
        let high_bit = rem >> 127;
        rem = (rem << 1) | bit;
        // If high_bit is set, the conceptual remainder is rem + 2^128, which
        // is necessarily >= divisor (since divisor < 2^128). Otherwise compare
        // directly. wrapping_sub recovers the correct low 128 bits in either
        // case.
        if high_bit == 1 || rem >= divisor {
            rem = rem.wrapping_sub(divisor);
            quot = (quot << 1) | 1;
        } else {
            quot <<= 1;
        }
    }
    Ok(quot)
}
