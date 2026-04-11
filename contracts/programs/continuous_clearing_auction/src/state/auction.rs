use anchor_lang::prelude::*;
use crate::math::constants::MPS;

#[account]
pub struct Auction {
    // Config (immutable after init)
    pub token_mint: Pubkey,
    pub currency_mint: Pubkey,
    pub token_vault: Pubkey,
    pub currency_vault: Pubkey,
    pub creator: Pubkey,
    pub tokens_recipient: Pubkey,
    pub funds_recipient: Pubkey,
    pub total_supply: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
    pub tick_spacing: u64,
    pub floor_price: u128,
    pub max_bid_price: u128,
    pub required_currency_raised: u64,

    // Live state
    pub clearing_price: u128,
    pub sum_currency_demand_above_clearing: u128,
    pub next_active_tick_price: u128,
    pub next_bid_id: u64,
    pub last_checkpointed_time: i64,
    pub currency_raised_q64_x7: u128,
    pub total_cleared_q64_x7: u128,
    pub tokens_received: bool,
    pub sweep_currency_done: bool,
    pub sweep_tokens_done: bool,
    pub graduated: bool,
    pub bump: u8,
}

impl Auction {
    pub const SIZE: usize = 8   // discriminator
        + 32 * 7                // 7 Pubkeys
        + 8                     // total_supply
        + 8 * 3                 // start/end/claim_time
        + 8                     // tick_spacing
        + 16 * 4                // floor_price, max_bid_price, clearing_price, sum_currency_demand
        + 16                    // next_active_tick_price
        + 8                     // next_bid_id
        + 8                     // last_checkpointed_time
        + 16 * 2                // currency_raised_q64_x7, total_cleared_q64_x7
        + 8                     // required_currency_raised
        + 1 * 4                 // 4 bools
        + 1;                    // bump

    pub fn is_graduated(&self) -> bool {
        let currency_raised = (self.currency_raised_q64_x7 / (MPS as u128)) >> 64;
        currency_raised >= self.required_currency_raised as u128
    }

    pub fn total_cleared(&self) -> u64 {
        (self.total_cleared_q64_x7 / (MPS as u128) >> 64) as u64
    }
}
