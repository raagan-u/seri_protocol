use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
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