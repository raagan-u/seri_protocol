use anchor_lang::prelude::*;

use crate::errors::CCAError;
use crate::math::constants::*;
use crate::state::*;

use super::shared::checkpoint_at_time;

/// One-shot finalize: runs `checkpoint_at_time(end_time)` so the accumulators advance
/// through the final tail of the auction (which the crank otherwise skips since it
/// only ticks while `end_time > now`). This is what flips `auction.graduated` and
/// produces the canonical final clearing price.
///
/// Mirrors `_getFinalCheckpoint()` from the Solidity reference. Callable by anyone
/// once `clock.unix_timestamp >= end_time`. Reverts if already finalized.
#[derive(Accounts)]
pub struct FinalizeAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"auction", auction.token_mint.as_ref(), auction.creator.as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    #[account(
        mut,
        constraint = latest_checkpoint.auction == auction.key(),
        constraint = latest_checkpoint.next_timestamp == MAX_TIMESTAMP,
    )]
    pub latest_checkpoint: Box<Account<'info, Checkpoint>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Checkpoint::INIT_SPACE,
        seeds = [b"checkpoint", auction.key().as_ref(), &auction.end_time.to_le_bytes()],
        bump,
    )]
    pub new_checkpoint: Box<Account<'info, Checkpoint>>,

    #[account(
        constraint = auction_steps.auction == auction.key(),
    )]
    pub auction_steps: Account<'info, AuctionSteps>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_finalize_auction<'info>(
    ctx: Context<'_, '_, 'info, 'info, FinalizeAuction<'info>>,
) -> Result<()> {
    let clock = Clock::get()?;
    let program_id = *ctx.program_id;
    let end_time = ctx.accounts.auction.end_time;

    require!(
        clock.unix_timestamp >= end_time,
        CCAError::AuctionNotEnded
    );
    require!(
        ctx.accounts.auction.last_checkpointed_time < end_time,
        CCAError::AlreadyFinalized
    );

    let auction_key = ctx.accounts.auction.key();
    checkpoint_at_time(
        &mut ctx.accounts.auction,
        auction_key,
        &ctx.accounts.auction_steps,
        &mut ctx.accounts.latest_checkpoint,
        &mut ctx.accounts.new_checkpoint,
        end_time,
        ctx.remaining_accounts,
        &program_id,
    )
}
