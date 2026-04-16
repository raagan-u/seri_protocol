use anchor_lang::prelude::*;

use crate::errors::CCAError;
use crate::math::constants::*;
use crate::state::*;
use crate::state::checkpoint::Checkpoint as CheckpointState;

use super::shared::checkpoint_at_time;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CheckpointParams {
    pub now: i64,
}

#[derive(Accounts)]
#[instruction(params: CheckpointParams)]
pub struct CheckpointAccounts<'info> {
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
    pub latest_checkpoint: Box<Account<'info, CheckpointState>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + CheckpointState::INIT_SPACE,
        seeds = [b"checkpoint", auction.key().as_ref(), &params.now.to_le_bytes()],
        bump,
    )]
    pub new_checkpoint: Box<Account<'info, CheckpointState>>,

    #[account(
        constraint = auction_steps.auction == auction.key(),
    )]
    pub auction_steps: Account<'info, AuctionSteps>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_checkpoint(ctx: Context<CheckpointAccounts>, params: CheckpointParams) -> Result<()> {
    let clock = Clock::get()?;
    let now = params.now;
    let auction = &ctx.accounts.auction;

    require!(
        now >= auction.last_checkpointed_time && now <= clock.unix_timestamp,
        CCAError::InvalidCheckpointHint
    );

    let auction_key = auction.key();
    checkpoint_at_time(
        &mut ctx.accounts.auction,
        auction_key,
        &ctx.accounts.auction_steps,
        &mut ctx.accounts.latest_checkpoint,
        &mut ctx.accounts.new_checkpoint,
        now,
    )
}
