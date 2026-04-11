use anchor_lang::prelude::*;

use crate::errors::CCAError;
use crate::math::constants::*;
use crate::math::fixed_point::*;
use crate::state::*;

/// Core checkpoint logic shared by submit_bid and the standalone checkpoint instruction.
pub fn checkpoint_at_time<'info>(
    auction: &mut Auction,
    auction_key: Pubkey,
    auction_steps: &AuctionSteps,
    latest_checkpoint: &mut Account<'info, Checkpoint>,
    new_checkpoint: &mut Account<'info, Checkpoint>,
    now: i64,
) -> Result<()> {
    if now == auction.last_checkpointed_time {
        return Ok(());
    }

    let delta_mps = auction_steps.calculate_delta_mps(
        auction.start_time,
        auction.last_checkpointed_time,
        now,
    );

    // Recompute clearing price
    if auction.sum_currency_demand_above_clearing > 0 && auction.total_supply > 0 {
        let new_clearing = mul_div_round_up(
            auction.sum_currency_demand_above_clearing,
            1,
            auction.total_supply as u128,
        )?;
        if new_clearing > auction.clearing_price {
            auction.clearing_price = new_clearing;
        }
    }

    // Sell tokens at clearing price
    let currency_delta = auction
        .sum_currency_demand_above_clearing
        .checked_mul(delta_mps as u128)
        .ok_or(error!(CCAError::MathOverflow))?;
    require!(currency_delta <= X7_UPPER_BOUND, CCAError::MathOverflow);

    let tokens_delta = if auction.clearing_price > 0 {
        mul_div_round_up(currency_delta, Q64, auction.clearing_price)?
    } else {
        0
    };

    auction.currency_raised_q64_x7 = auction
        .currency_raised_q64_x7
        .checked_add(currency_delta)
        .ok_or(error!(CCAError::MathOverflow))?;
    auction.total_cleared_q64_x7 = auction
        .total_cleared_q64_x7
        .checked_add(tokens_delta)
        .ok_or(error!(CCAError::MathOverflow))?;

    // cumulative_mps_per_price delta: (delta_mps << 96) / clearing_price
    let mps_per_price_delta = if auction.clearing_price > 0 {
        mul_div(delta_mps as u128, 1u128 << 96, auction.clearing_price)?
    } else {
        0
    };

    let new_cumulative_mps = latest_checkpoint.cumulative_mps + delta_mps as u32;
    let new_cumulative_mps_per_price = latest_checkpoint
        .cumulative_mps_per_price
        .checked_add(mps_per_price_delta)
        .ok_or(error!(CCAError::MathOverflow))?;

    let price_changed = auction.clearing_price != latest_checkpoint.clearing_price;
    let currency_at_price = if price_changed {
        currency_delta
    } else {
        latest_checkpoint
            .currency_raised_at_clearing_price_q64_x7
            .checked_add(currency_delta)
            .ok_or(error!(CCAError::MathOverflow))?
    };

    // Write new checkpoint
    new_checkpoint.auction = auction_key;
    new_checkpoint.timestamp = now;
    new_checkpoint.clearing_price = auction.clearing_price;
    new_checkpoint.currency_raised_at_clearing_price_q64_x7 = currency_at_price;
    new_checkpoint.cumulative_mps_per_price = new_cumulative_mps_per_price;
    new_checkpoint.cumulative_mps = new_cumulative_mps;
    new_checkpoint.prev_timestamp = latest_checkpoint.timestamp;
    new_checkpoint.next_timestamp = MAX_TIMESTAMP;

    // Link into doubly-linked list
    latest_checkpoint.next_timestamp = now;

    auction.last_checkpointed_time = now;

    // Cache graduation status at or past end_time
    if now >= auction.end_time && !auction.graduated {
        auction.graduated = auction.is_graduated();
    }

    Ok(())
}
