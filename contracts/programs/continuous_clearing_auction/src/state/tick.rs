use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Tick {
    pub auction: Pubkey,
    pub price: u128,
    pub next_price: u128,
    pub currency_demand_q64: u128,
    pub bump: u8,
}