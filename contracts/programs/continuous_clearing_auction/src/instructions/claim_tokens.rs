use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::CCAError;
use crate::state::*;

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(
        seeds = [b"auction", auction.token_mint.as_ref(), auction.creator.as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    #[account(
        mut,
        constraint = bid.auction == auction.key(),
    )]
    pub bid: Box<Account<'info, Bid>>,

    #[account(
        mut,
        constraint = token_vault.key() == auction.token_vault,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = bid_owner_token_account.mint == auction.token_mint,
        constraint = bid_owner_token_account.owner == bid.owner,
    )]
    pub bid_owner_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle_claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let auction = &ctx.accounts.auction;
    let bid = &mut ctx.accounts.bid;

    require!(now >= auction.claim_time, CCAError::ClaimTimeNotReached);
    require!(auction.graduated, CCAError::NotGraduated);
    require!(bid.exited_time != 0, CCAError::BidNotExited);
    require!(bid.tokens_filled > 0, CCAError::NoTokensToClaim);

    let tokens = bid.tokens_filled;
    bid.tokens_filled = 0;

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
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.token_vault.to_account_info(),
            to: ctx.accounts.bid_owner_token_account.to_account_info(),
            authority: ctx.accounts.auction.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, tokens)?;

    Ok(())
}
