//! Anchor account layouts (manually mirrored from the IDL).
//! First 8 bytes of every account are the discriminator: sha256("account:<Name>")[0..8].

use borsh::BorshDeserialize;
use sha2::{Digest, Sha256};

pub fn discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("account:{name}").as_bytes());
    let h = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

#[derive(BorshDeserialize, Debug, Clone)]
pub struct AuctionAccount {
    pub token_mint: [u8; 32],
    pub currency_mint: [u8; 32],
    pub token_vault: [u8; 32],
    pub currency_vault: [u8; 32],
    pub creator: [u8; 32],
    pub tokens_recipient: [u8; 32],
    pub funds_recipient: [u8; 32],
    pub total_supply: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
    pub tick_spacing: u64,
    pub floor_price: u128,
    pub max_bid_price: u128,
    pub required_currency_raised: u64,
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

#[derive(BorshDeserialize, Debug, Clone)]
pub struct BidAccount {
    pub auction: [u8; 32],
    pub bid_id: u64,
    pub owner: [u8; 32],
    pub max_price: u128,
    pub amount_q64: u128,
    pub start_time: i64,
    pub start_cumulative_mps: u32,
    pub exited_time: i64,
    pub tokens_filled: u64,
    pub bump: u8,
}

#[derive(BorshDeserialize, Debug, Clone)]
pub struct CheckpointAccount {
    pub auction: [u8; 32],
    pub timestamp: i64,
    pub clearing_price: u128,
    pub currency_raised_at_clearing_price_q64_x7: u128,
    pub cumulative_mps_per_price: u128,
    pub cumulative_mps: u32,
    pub prev_timestamp: i64,
    pub next_timestamp: i64,
    pub bump: u8,
}

pub fn pubkey_to_base58(bytes: &[u8; 32]) -> String {
    bs58::encode(bytes).into_string()
}

pub fn strip_discriminator<'a>(data: &'a [u8], disc: &[u8; 8]) -> Option<&'a [u8]> {
    if data.len() < 8 || &data[..8] != disc {
        return None;
    }
    Some(&data[8..])
}
