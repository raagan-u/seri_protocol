use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::CCAError;
use crate::math::constants::*;
use crate::state::*;

use super::shared::checkpoint_at_time;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SubmitBidParams {
    pub max_price: u128,
    pub amount: u64,
    pub prev_tick_price: u128,
    pub now: i64,
}

#[derive(Accounts)]
#[instruction(params: SubmitBidParams)]
pub struct SubmitBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    #[account(
        mut,
        seeds = [b"auction", auction.token_mint.as_ref(), auction.creator.as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    #[account(
        init,
        payer = bidder,
        space = 8 + Bid::INIT_SPACE,
        seeds = [b"bid", auction.key().as_ref(), &auction.next_bid_id.to_le_bytes()],
        bump,
    )]
    pub bid: Box<Account<'info, Bid>>,

    #[account(
        init_if_needed,
        payer = bidder,
        space = 8 + Tick::INIT_SPACE,
        seeds = [b"tick", auction.key().as_ref(), &params.max_price.to_le_bytes()],
        bump,
    )]
    pub tick: Account<'info, Tick>,

    #[account(
        mut,
        seeds = [b"tick", auction.key().as_ref(), &params.prev_tick_price.to_le_bytes()],
        bump = prev_tick.bump,
        constraint = prev_tick.auction == auction.key(),
    )]
    pub prev_tick: Account<'info, Tick>,

    #[account(
        mut,
        constraint = latest_checkpoint.auction == auction.key(),
        constraint = latest_checkpoint.next_timestamp == MAX_TIMESTAMP,
    )]
    pub latest_checkpoint: Box<Account<'info, Checkpoint>>,

    #[account(
        init_if_needed,
        payer = bidder,
        space = 8 + Checkpoint::INIT_SPACE,
        seeds = [b"checkpoint", auction.key().as_ref(), &params.now.to_le_bytes()],
        bump,
    )]
    pub new_checkpoint: Box<Account<'info, Checkpoint>>,

    #[account(
        constraint = auction_steps.auction == auction.key(),
    )]
    pub auction_steps: Account<'info, AuctionSteps>,

    #[account(
        mut,
        constraint = bidder_currency_account.mint == auction.currency_mint,
        constraint = bidder_currency_account.owner == bidder.key(),
    )]
    pub bidder_currency_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = currency_vault.key() == auction.currency_vault,
    )]
    pub currency_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_submit_bid<'info>(
    ctx: Context<'_, '_, 'info, 'info, SubmitBid<'info>>,
    params: SubmitBidParams,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = params.now;
    let program_id = *ctx.program_id;
    let auction = &mut ctx.accounts.auction;

    // params.now must be in [last_checkpointed_time, clock.unix_timestamp]
    require!(
        now >= auction.last_checkpointed_time && now <= clock.unix_timestamp,
        CCAError::InvalidCheckpointHint
    );
    require!(now >= auction.start_time, CCAError::AuctionNotStarted);
    require!(now < auction.end_time, CCAError::AuctionEnded);
    require!(params.amount > 0, CCAError::ZeroAmount);
    require!(
        params.max_price <= auction.max_bid_price,
        CCAError::BidPriceTooHigh
    );
    require!(
        params.max_price == auction.floor_price
            || params.max_price % (auction.tick_spacing as u128) == 0,
        CCAError::InvalidTickSpacing
    );

    // Checkpoint runs eviction first; consumes ctx.remaining_accounts as the eviction queue
    // (optionally followed by the post-eviction clearing tick).
    let auction_key = auction.key();
    checkpoint_at_time(
        auction,
        auction_key,
        &ctx.accounts.auction_steps,
        &mut ctx.accounts.latest_checkpoint,
        &mut ctx.accounts.new_checkpoint,
        now,
        ctx.remaining_accounts,
        &program_id,
    )?;

    // Re-validate against the post-eviction clearing price. The reference does this implicitly
    // via the next-iteration eviction loop pinning bids at-or-below clearing; we enforce here
    // so a single late bid that pushed clearing past its own max can never escape unbounded.
    require!(
        params.max_price > auction.clearing_price,
        CCAError::BidPriceTooLow
    );

    // Create bid
    let bid = &mut ctx.accounts.bid;
    bid.auction = auction.key();
    bid.bid_id = auction.next_bid_id;
    bid.owner = ctx.accounts.bidder.key();
    bid.max_price = params.max_price;
    bid.amount_q64 = (params.amount as u128) << 64;
    bid.start_time = now;
    bid.start_cumulative_mps = ctx.accounts.new_checkpoint.cumulative_mps;
    bid.exited_time = 0;
    bid.tokens_filled = 0;
    bid.bump = ctx.bumps.bid;

    // Init or update tick
    let tick = &mut ctx.accounts.tick;
    let is_new_tick = tick.auction == Pubkey::default();
    if is_new_tick {
        let prev_tick = &mut ctx.accounts.prev_tick;
        require!(
            prev_tick.price < params.max_price,
            CCAError::InvalidPrevTick
        );
        require!(
            prev_tick.next_price > params.max_price
                || prev_tick.next_price == MAX_TICK_PRICE,
            CCAError::InvalidPrevTick
        );

        tick.auction = auction.key();
        tick.price = params.max_price;
        tick.next_price = prev_tick.next_price;
        tick.currency_demand_q64 = 0;
        tick.bump = ctx.bumps.tick;

        prev_tick.next_price = params.max_price;
    }

    // Update demand
    let effective = bid.effective_amount();
    tick.currency_demand_q64 = tick
        .currency_demand_q64
        .checked_add(effective)
        .ok_or(error!(CCAError::MathOverflow))?;
    auction.sum_currency_demand_above_clearing = auction
        .sum_currency_demand_above_clearing
        .checked_add(effective)
        .ok_or(error!(CCAError::MathOverflow))?;

    auction.next_bid_id += 1;

    // Transfer currency from bidder to vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.bidder_currency_account.to_account_info(),
            to: ctx.accounts.currency_vault.to_account_info(),
            authority: ctx.accounts.bidder.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, params.amount)?;

    Ok(())
}
