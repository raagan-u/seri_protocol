use anchor_lang::prelude::*;

#[account]
pub struct Checkpoint {
    pub auction: Pubkey,
    pub timestamp: i64,
    pub clearing_price: u128,
    pub currency_raised_at_clearing_price_q64_x7: u128,
    pub cumulative_mps_per_price: u128,
    pub cumulative_mps: u32,
    pub prev_timestamp: i64,
    pub next_timestamp: i64,
    pub bump: u8,
}

impl Checkpoint {
    pub const SIZE: usize = 8   // discriminator
        + 32                    // auction
        + 8                     // timestamp
        + 16 * 3                // clearing_price, currency_raised_..., cumulative_mps_per_price
        + 4                     // cumulative_mps
        + 8 * 2                 // prev/next timestamp
        + 1;                    // bump
}
