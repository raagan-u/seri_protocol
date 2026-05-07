use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::CCAError;
use crate::math::constants::*;
use crate::math::fixed_point::*;
use crate::state::*;

use super::shared::auction_now;

#[derive(Accounts)]
pub struct ExitPartiallyFilledBid<'info> {
    #[account(
        mut,
        seeds = [b"auction", auction.token_mint.as_ref(), auction.creator.as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    #[account(
        mut,
        constraint = bid.auction == auction.key(),
    )]
    pub bid: Box<Account<'info, Bid>>,

    /// Checkpoint at bid.start_time
    #[account(
        constraint = start_checkpoint.auction == auction.key(),
        constraint = start_checkpoint.timestamp == bid.start_time,
    )]
    pub start_checkpoint: Box<Account<'info, Checkpoint>>,

    /// Hint: last checkpoint where clearing_price < bid.max_price
    #[account(
        constraint = last_fully_filled_checkpoint.auction == auction.key(),
    )]
    pub last_fully_filled_checkpoint: Box<Account<'info, Checkpoint>>,

    /// The checkpoint after last_fully_filled (validates the hint)
    #[account(
        constraint = next_of_last_fully_filled.auction == auction.key(),
    )]
    pub next_of_last_fully_filled: Box<Account<'info, Checkpoint>>,

    /// Last checkpoint where clearing_price == bid.max_price (partial fill endpoint)
    #[account(
        constraint = upper_checkpoint.auction == auction.key(),
    )]
    pub upper_checkpoint: Box<Account<'info, Checkpoint>>,

    /// Optional: checkpoint where clearing_price > bid.max_price (outbid case).
    /// Pass None for end-of-auction partial exit.
    pub outbid_checkpoint: Option<Box<Account<'info, Checkpoint>>>,

    /// Tick at bid.max_price for pro-rata demand calculation
    #[account(
        constraint = tick.auction == auction.key(),
        constraint = tick.price == bid.max_price,
    )]
    pub tick: Box<Account<'info, Tick>>,

    #[account(
        mut,
        constraint = currency_vault.key() == auction.currency_vault,
    )]
    pub currency_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = bid_owner_currency_account.mint == auction.currency_mint,
        constraint = bid_owner_currency_account.owner == bid.owner,
    )]
    pub bid_owner_currency_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_exit_partially_filled_bid(ctx: Context<ExitPartiallyFilledBid>) -> Result<()> {
    let auction = &ctx.accounts.auction;
    let bid = &mut ctx.accounts.bid;

    require!(bid.exited_time == 0, CCAError::BidAlreadyExited);

    let clock = Clock::get()?;
    let now = auction_now(auction.mode, &clock);

    // Graduation gate
    if !auction.graduated {
        if now >= auction.end_time {
            // Not graduated, auction over → full refund
            return process_exit(
                bid,
                auction,
                0,
                0,
                now,
                &ctx.accounts.currency_vault,
                &ctx.accounts.bid_owner_currency_account,
                &ctx.accounts.token_program,
                &ctx.accounts.auction.to_account_info(),
            );
        }
        return Err(error!(CCAError::CannotPartiallyExitBidBeforeGraduation));
    }

    let bid_max_price = bid.max_price;
    let bid_start_time = bid.start_time;

    // Validate last_fully_filled_checkpoint hint
    let last_ff = &ctx.accounts.last_fully_filled_checkpoint;
    let next_ff = &ctx.accounts.next_of_last_fully_filled;

    require!(
        last_ff.clearing_price < bid_max_price,
        CCAError::InvalidLastFullyFilledCheckpointHint
    );
    require!(
        next_ff.clearing_price >= bid_max_price,
        CCAError::InvalidLastFullyFilledCheckpointHint
    );
    require!(
        last_ff.timestamp >= bid_start_time,
        CCAError::InvalidLastFullyFilledCheckpointHint
    );
    // Validate linked list: last_ff.next_timestamp == next_ff.timestamp
    require!(
        last_ff.next_timestamp == next_ff.timestamp,
        CCAError::InvalidLastFullyFilledCheckpointHint
    );

    // --- Fully filled portion: start_checkpoint → last_fully_filled_checkpoint ---
    let start_cp = &ctx.accounts.start_checkpoint;
    let mps_delta = (last_ff.cumulative_mps - start_cp.cumulative_mps) as u128;
    let mps_per_price_delta = last_ff
        .cumulative_mps_per_price
        .saturating_sub(start_cp.cumulative_mps_per_price);
    let mps_remaining = (MPS - bid.start_cumulative_mps) as u128;

    let mut currency_spent_q64: u128 = if mps_delta > 0 && mps_remaining > 0 {
        mul_div_round_up(bid.amount_q64, mps_delta, mps_remaining)?
    } else {
        0
    };

    let tokens_denom = mps_remaining
        .checked_mul(1u128 << 96)
        .ok_or(error!(CCAError::MathOverflow))?;
    let mut tokens_filled: u128 = if mps_per_price_delta > 0 && tokens_denom > 0 {
        mul_div(bid.amount_q64, mps_per_price_delta, tokens_denom)?
    } else {
        0
    };

    // --- Determine upper checkpoint and validate ---
    let upper = &ctx.accounts.upper_checkpoint;

    if let Some(ref outbid_cp) = ctx.accounts.outbid_checkpoint {
        // Outbid case: outbid_cp.clearing_price > bid.max_price
        require!(
            outbid_cp.auction == auction.key(),
            CCAError::InvalidOutbidCheckpointHint
        );
        require!(
            outbid_cp.clearing_price > bid_max_price,
            CCAError::InvalidOutbidCheckpointHint
        );
        // upper must be the prev of outbid
        require!(
            upper.clearing_price <= bid_max_price,
            CCAError::InvalidOutbidCheckpointHint
        );
        require!(
            outbid_cp.prev_timestamp == upper.timestamp,
            CCAError::InvalidOutbidCheckpointHint
        );
    } else {
        // End-of-auction case
        require!(
            now >= auction.end_time,
            CCAError::CannotPartiallyExitBidBeforeEndBlock
        );
        require!(
            upper.clearing_price == bid_max_price,
            CCAError::CannotExitBid
        );
        // upper must be the final checkpoint
        require!(
            upper.next_timestamp == MAX_TIMESTAMP,
            CCAError::CannotExitBid
        );
    }

    // --- Partially filled portion ---
    if upper.clearing_price == bid_max_price {
        let tick_demand_q64 = ctx.accounts.tick.currency_demand_q64;
        require!(tick_demand_q64 > 0, CCAError::MathOverflow);

        // Pro-rata currency spent in q64_x7 units:
        // bid.amount_q64 * upper.currency_raised_at_clearing_price_q64_x7 / tick_demand_q64
        let partial_currency_spent_q64_x7 = mul_div(
            bid.amount_q64,
            upper.currency_raised_at_clearing_price_q64_x7,
            tick_demand_q64,
        )?;

        // Normalize from q64_x7 to q64 by dividing by MPS
        let partial_currency_spent_q64 = partial_currency_spent_q64_x7 / (MPS as u128);

        // Tokens from partial fill: currency_spent_q64 / max_price
        // currency_spent_q64 is Q64, max_price is raw → result is Q64/raw
        // But we need raw tokens. Since amount_q64 = raw_amount << 64,
        // currency_spent_q64 is also in Q64 scale. Dividing by price gives tokens in Q64? No.
        //
        // Actually: currency_raised_at_clearing_price_q64_x7 tracks demand*mps where demand is Q64.
        // partial_currency_spent_q64 = (bid_q64 * demand_q64 * mps) / (tick_demand_q64 * MPS)
        // This simplifies to: bid_fraction * total_currency_at_price (in Q64).
        // To get tokens: partial_currency_q64 / price.
        // price = currency_per_token in same units. If price is raw and currency is Q64:
        // tokens = partial_currency_q64 / price → gives Q64 tokens → shift right 64 for raw.
        // BUT looking at existing exit_bid: tokens = mul_div(amount_q64, mps_per_price_delta, mps_remaining * 2^96)
        // and this gives raw token count directly.
        //
        // Let's match the Solidity: tokensFilled = currencySpent / maxPrice
        // In their system both are Q96. In ours, partial_currency_spent_q64 is Q64 and max_price...
        // From checkpoint: clearing_price = sum_currency_demand_above_clearing / total_supply
        // sum_currency_demand_above_clearing is in Q64 (effective amounts are Q64)
        // total_supply is raw. So clearing_price is Q64/raw = Q64-per-token.
        // Therefore: tokens = partial_currency_q64 / clearing_price = Q64 / (Q64/token) = tokens. Raw!
        let partial_tokens = if bid_max_price > 0 {
            partial_currency_spent_q64 / bid_max_price
        } else {
            0
        };

        tokens_filled = tokens_filled.checked_add(partial_tokens)
            .ok_or(error!(CCAError::MathOverflow))?;
        currency_spent_q64 = currency_spent_q64.checked_add(partial_currency_spent_q64)
            .ok_or(error!(CCAError::MathOverflow))?;
    }

    process_exit(
        bid,
        auction,
        tokens_filled as u64,
        currency_spent_q64,
        now,
        &ctx.accounts.currency_vault,
        &ctx.accounts.bid_owner_currency_account,
        &ctx.accounts.token_program,
        &ctx.accounts.auction.to_account_info(),
    )
}

fn process_exit<'info>(
    bid: &mut Account<'info, Bid>,
    auction: &Account<'info, Auction>,
    tokens_filled: u64,
    currency_spent_q64: u128,
    now: i64,
    currency_vault: &Account<'info, TokenAccount>,
    bid_owner_currency_account: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    auction_info: &AccountInfo<'info>,
) -> Result<()> {
    // Clamp: in edge cases rounding can make spent slightly > amount
    let refund_q64 = saturating_sub(bid.amount_q64, currency_spent_q64);
    let refund = (refund_q64 >> 64) as u64;

    bid.exited_time = now;
    bid.tokens_filled = tokens_filled;

    if refund > 0 {
        let token_mint = auction.token_mint;
        let creator = auction.creator;
        let bump = auction.bump;
        let seeds = &[
            b"auction".as_ref(),
            token_mint.as_ref(),
            creator.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: currency_vault.to_account_info(),
                to: bid_owner_currency_account.to_account_info(),
                authority: auction_info.clone(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, refund)?;
    }

    Ok(())
}
