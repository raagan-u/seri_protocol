use anchor_lang::prelude::*;
use crate::math::constants::MPS;

#[account]
pub struct Bid {
    pub auction: Pubkey,
    pub bid_id: u64,
    pub owner: Pubkey,
    pub max_price: u128,
    pub amount_q64: u128,
    pub start_time: i64,
    pub start_cumulative_mps: u32,
    pub exited_time: i64,
    pub tokens_filled: u64,
    pub bump: u8,
}

impl Bid {
    pub const SIZE: usize = 8   // discriminator
        + 32                    // auction
        + 8                     // bid_id
        + 32                    // owner
        + 16 * 2                // max_price, amount_q64
        + 8                     // start_time
        + 4                     // start_cumulative_mps
        + 8                     // exited_time
        + 8                     // tokens_filled
        + 1;                    // bump

    /// Effective currency amount, scaled by remaining fill percentage.
    pub fn effective_amount(&self) -> u128 {
        let remaining = (MPS - self.start_cumulative_mps) as u128;
        // amount_q64 * MPS / remaining
        if remaining == 0 {
            return 0;
        }
        self.amount_q64
            .saturating_mul(MPS as u128)
            .checked_div(remaining)
            .unwrap_or(0)
    }
}
