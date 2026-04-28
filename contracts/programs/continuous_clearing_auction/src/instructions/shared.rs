use anchor_lang::prelude::*;

use crate::errors::CCAError;
use crate::math::constants::*;
use crate::math::fixed_point::*;
use crate::state::*;

/// Result of `sell_tokens_at_clearing_price` — all values in raw Q64×x7 scale.
struct SellResult {
    currency_delta_q64x7: u128,
    currency_at_clearing_q64x7: u128,
    tokens_delta_q64x7: u128,
}

/// Compute clearing = sum_demand × 10^token_decimals / (total_supply × 10^currency_decimals)
/// in Q64 × (human currency / human token).
fn compute_clearing_price(
    sum_demand: u128,
    total_supply: u64,
    token_scale: u128,
    currency_scale: u128,
) -> Result<u128> {
    if sum_demand == 0 || total_supply == 0 {
        return Ok(0);
    }
    let supply_scaled = (total_supply as u128)
        .checked_mul(currency_scale)
        .ok_or(error!(CCAError::MathOverflow))?;
    mul_div_round_up(sum_demand, token_scale, supply_scaled)
}

/// Threshold at `tick_price`: the value of `sum_demand` above which the entire supply could
/// be cleared at `tick_price`. Used to detect when a tick has been fully overtaken by demand.
fn supply_threshold_at_tick(
    total_supply: u64,
    tick_price: u128,
    token_scale: u128,
    currency_scale: u128,
) -> Result<u128> {
    let price_scaled = tick_price
        .checked_mul(currency_scale)
        .ok_or(error!(CCAError::MathOverflow))?;
    mul_div(total_supply as u128, price_scaled, token_scale)
}

/// Iterate ticks (price-ascending, starting at `auction.next_active_tick_price`) and evict
/// any whose price is at-or-below the implied clearing price. Mirrors
/// `_iterateOverTicksAndFindClearingPrice` from the Solidity reference.
///
/// `tick_accounts` must be the eviction queue, optionally followed by the post-eviction
/// clearing tick (the one whose price equals the new clearing). Returns
/// `(consumed, demand_at_clearing_q64)`:
///   - `consumed`: number of accounts consumed by eviction
///   - `demand_at_clearing_q64`: `currency_demand_q64` of the last evicted tick (0 if no
///     eviction happened — the caller may then pass an additional clearing tick)
fn iterate_over_ticks_and_find_clearing_price<'info>(
    auction: &mut Auction,
    auction_key: Pubkey,
    tick_accounts: &'info [AccountInfo<'info>],
    program_id: &Pubkey,
    token_scale: u128,
    currency_scale: u128,
) -> Result<(usize, u128)> {
    if auction.total_supply == 0 {
        return Ok((0, 0));
    }

    let mut sum_demand = auction.sum_currency_demand_above_clearing;
    let mut next_active = auction.next_active_tick_price;
    let mut minimum_clearing = auction.clearing_price;
    let mut demand_at_evicted = 0u128;
    let mut clearing =
        compute_clearing_price(sum_demand, auction.total_supply, token_scale, currency_scale)?;

    let mut consumed = 0usize;

    loop {
        if next_active == MAX_TICK_PRICE {
            break;
        }

        let threshold =
            supply_threshold_at_tick(auction.total_supply, next_active, token_scale, currency_scale)?;
        let evict = sum_demand >= threshold || clearing == next_active;
        if !evict {
            break;
        }

        let info = tick_accounts
            .get(consumed)
            .ok_or(error!(CCAError::MissingTickAccount))?;
        let tick: Account<Tick> = Account::try_from(info)?;
        require!(tick.auction == auction_key, CCAError::InvalidTickAccount);
        require!(tick.price == next_active, CCAError::InvalidTickAccount);
        let (expected, _) = Pubkey::find_program_address(
            &[b"tick", auction_key.as_ref(), &tick.price.to_le_bytes()],
            program_id,
        );
        require!(info.key == &expected, CCAError::InvalidTickAccount);

        sum_demand = sum_demand
            .checked_sub(tick.currency_demand_q64)
            .ok_or(error!(CCAError::MathOverflow))?;
        minimum_clearing = next_active;
        demand_at_evicted = tick.currency_demand_q64;
        next_active = tick.next_price;

        clearing =
            compute_clearing_price(sum_demand, auction.total_supply, token_scale, currency_scale)?;
        consumed += 1;
    }

    auction.sum_currency_demand_above_clearing = sum_demand;
    auction.next_active_tick_price = next_active;

    let new_clearing = clearing.max(minimum_clearing);
    if new_clearing > auction.clearing_price {
        auction.clearing_price = new_clearing;
    }

    // demand_at_evicted is only meaningful if clearing landed exactly on the last evicted
    // tick's price (it always does when eviction happened, since minimum_clearing wins ties).
    let demand_at_clearing = if consumed > 0 && auction.clearing_price == minimum_clearing {
        demand_at_evicted
    } else {
        0
    };
    Ok((consumed, demand_at_clearing))
}

/// Mirrors `_sellTokensAtClearingPrice`. Splits the per-checkpoint currency raised into the
/// "above clearing" portion (`sum_demand × delta_mps`) and the "at clearing" portion (a tick
/// at exactly the clearing price contributing partial fills, capped at `min(supply×price, tick_demand)`).
fn sell_tokens_at_clearing_price(
    auction: &Auction,
    delta_mps: u32,
    demand_at_clearing_q64: u128,
    token_scale: u128,
    currency_scale: u128,
) -> Result<SellResult> {
    let sum_above = auction.sum_currency_demand_above_clearing;
    let above_q64x7 = sum_above
        .checked_mul(delta_mps as u128)
        .ok_or(error!(CCAError::MathOverflow))?;

    let mut currency_delta = above_q64x7;
    let mut currency_at_clearing = 0u128;

    if demand_at_clearing_q64 > 0 && auction.clearing_price > 0 {
        // total_currency_for_delta = supply × clearing × delta_mps × currency_scale / token_scale
        let supply_x_delta = (auction.total_supply as u128)
            .checked_mul(delta_mps as u128)
            .ok_or(error!(CCAError::MathOverflow))?;
        let clearing_x_currency = auction
            .clearing_price
            .checked_mul(currency_scale)
            .ok_or(error!(CCAError::MathOverflow))?;
        let total_currency_for_delta = mul_div(supply_x_delta, clearing_x_currency, token_scale)?;

        // (A) implied at-clearing = total minus already-counted "above clearing"
        let calc_at_clearing = saturating_sub(total_currency_for_delta, above_q64x7);
        // (B) capped by tick demand × delta_mps
        let max_at_clearing = demand_at_clearing_q64
            .checked_mul(delta_mps as u128)
            .ok_or(error!(CCAError::MathOverflow))?;
        currency_at_clearing = core::cmp::min(calc_at_clearing, max_at_clearing);

        currency_delta = above_q64x7
            .checked_add(currency_at_clearing)
            .ok_or(error!(CCAError::MathOverflow))?;
    }

    let tokens_delta = if auction.clearing_price > 0 {
        mul_div_round_up(currency_delta, Q64, auction.clearing_price)?
    } else {
        0
    };

    Ok(SellResult {
        currency_delta_q64x7: currency_delta,
        currency_at_clearing_q64x7: currency_at_clearing,
        tokens_delta_q64x7: tokens_delta,
    })
}

/// Core checkpoint logic shared by submit_bid and the standalone checkpoint instruction.
///
/// `tick_accounts` is the eviction queue (price-ascending, starting at
/// `auction.next_active_tick_price`), optionally followed by ONE additional account: the
/// tick at the post-eviction clearing price. The latter is needed to credit at-clearing
/// partial fills on checkpoints that don't themselves trigger eviction.
pub fn checkpoint_at_time<'info>(
    auction: &mut Auction,
    auction_key: Pubkey,
    auction_steps: &AuctionSteps,
    latest_checkpoint: &mut Account<'info, Checkpoint>,
    new_checkpoint: &mut Account<'info, Checkpoint>,
    now: i64,
    tick_accounts: &'info [AccountInfo<'info>],
    program_id: &Pubkey,
) -> Result<()> {
    if now == auction.last_checkpointed_time {
        return Ok(());
    }

    let delta_mps = auction_steps.calculate_delta_mps(
        auction.start_time,
        auction.last_checkpointed_time,
        now,
    );

    let token_scale = 10u128
        .checked_pow(auction.token_decimals as u32)
        .ok_or(error!(CCAError::MathOverflow))?;
    let currency_scale = 10u128
        .checked_pow(auction.currency_decimals as u32)
        .ok_or(error!(CCAError::MathOverflow))?;

    // 1. Run eviction (mutates auction.clearing_price, sum_currency_demand_above_clearing,
    //    next_active_tick_price).
    let (consumed, demand_via_eviction) = iterate_over_ticks_and_find_clearing_price(
        auction,
        auction_key,
        tick_accounts,
        program_id,
        token_scale,
        currency_scale,
    )?;

    // 2. If eviction did not produce the clearing-tick demand and another account remains,
    //    treat it as the clearing tick at auction.clearing_price (used for at-clearing
    //    partial-fill accounting).
    let demand_at_clearing = if demand_via_eviction > 0 {
        demand_via_eviction
    } else if consumed < tick_accounts.len() {
        let info = &tick_accounts[consumed];
        let tick: Account<Tick> = Account::try_from(info)?;
        require!(tick.auction == auction_key, CCAError::InvalidTickAccount);
        require!(tick.price == auction.clearing_price, CCAError::InvalidTickAccount);
        let (expected, _) = Pubkey::find_program_address(
            &[b"tick", auction_key.as_ref(), &tick.price.to_le_bytes()],
            program_id,
        );
        require!(info.key == &expected, CCAError::InvalidTickAccount);
        require!(consumed + 1 == tick_accounts.len(), CCAError::ExtraTickAccount);
        tick.currency_demand_q64
    } else {
        require!(consumed == tick_accounts.len(), CCAError::ExtraTickAccount);
        0
    };

    // 3. Sell tokens at the (possibly updated) clearing price.
    let sell = sell_tokens_at_clearing_price(
        auction,
        delta_mps as u32,
        demand_at_clearing,
        token_scale,
        currency_scale,
    )?;

    auction.currency_raised_q64_x7 = auction
        .currency_raised_q64_x7
        .checked_add(sell.currency_delta_q64x7)
        .ok_or(error!(CCAError::MathOverflow))?;
    auction.total_cleared_q64_x7 = auction
        .total_cleared_q64_x7
        .checked_add(sell.tokens_delta_q64x7)
        .ok_or(error!(CCAError::MathOverflow))?;

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

    // currency_raised_at_clearing_price_q64_x7 tracks currency raised exactly at the current
    // clearing price; reset when clearing changes, otherwise accumulate.
    let price_changed = auction.clearing_price != latest_checkpoint.clearing_price;
    let currency_at_price = if price_changed {
        sell.currency_at_clearing_q64x7
    } else {
        latest_checkpoint
            .currency_raised_at_clearing_price_q64_x7
            .checked_add(sell.currency_at_clearing_q64x7)
            .ok_or(error!(CCAError::MathOverflow))?
    };

    new_checkpoint.auction = auction_key;
    new_checkpoint.timestamp = now;
    new_checkpoint.clearing_price = auction.clearing_price;
    new_checkpoint.currency_raised_at_clearing_price_q64_x7 = currency_at_price;
    new_checkpoint.cumulative_mps_per_price = new_cumulative_mps_per_price;
    new_checkpoint.cumulative_mps = new_cumulative_mps;
    new_checkpoint.prev_timestamp = latest_checkpoint.timestamp;
    new_checkpoint.next_timestamp = MAX_TIMESTAMP;

    latest_checkpoint.next_timestamp = now;

    auction.last_checkpointed_time = now;

    if now >= auction.end_time && !auction.graduated {
        auction.graduated = auction.is_graduated();
    }

    Ok(())
}
