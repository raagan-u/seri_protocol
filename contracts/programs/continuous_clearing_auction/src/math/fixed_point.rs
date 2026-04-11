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
/// Panics/errors if the result doesn't fit in u128.
fn wide_div(hi: u128, lo: u128, divisor: u128) -> Result<u128> {
    if hi == 0 {
        // Simple case: fits in u128
        return Ok(lo / divisor);
    }
    // Result must fit in u128, so hi must be < divisor
    require!(hi < divisor, CCAError::MathOverflow);

    // Long division: compute (hi * 2^128 + lo) / divisor
    // We do this in 64-bit chunks
    let d = divisor;
    // Split hi into two 64-bit pieces
    let _hi_hi = hi >> 64;
    let _hi_lo = hi & (u64::MAX as u128);

    // Step 1: (hi_hi * 2^64) / d — but we need to track remainder
    // Use a simple iterative approach for correctness
    // Since result fits in u128, we can use trial subtraction on 192-bit numbers
    // Simplified: use u128 with the knowledge that hi < d
    let mut remainder = hi;
    let mut result: u128 = 0;

    // Process lo in two 64-bit halves
    for shift in [64u32, 0u32] {
        remainder <<= 64;
        remainder |= (lo >> shift) & (u64::MAX as u128);
        let q = remainder / d;
        remainder %= d;
        result = (result << 64) | q;
    }

    Ok(result)
}
