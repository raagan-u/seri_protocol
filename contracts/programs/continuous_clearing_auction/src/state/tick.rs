use anchor_lang::prelude::*;

#[account]
pub struct Tick {
    pub auction: Pubkey,
    pub price: u128,
    pub next_price: u128,
    pub currency_demand_q64: u128,
    pub bump: u8,
}

impl Tick {
    pub const SIZE: usize = 8   // discriminator
        + 32                    // auction
        + 16 * 3                // price, next_price, currency_demand_q64
        + 1;                    // bump
}
