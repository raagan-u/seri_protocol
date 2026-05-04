use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::CCAError;
use crate::math::constants::*;
use crate::math::fixed_point::*;
use crate::state::*;

use super::shared::auction_now;

#[derive(Accounts)]
pub struct ExitBid<'info> {
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

    #[account(
        constraint = start_checkpoint.auction == auction.key(),
        constraint = start_checkpoint.timestamp == bid.start_time,
    )]
    pub start_checkpoint: Box<Account<'info, Checkpoint>>,

    #[account(
        constraint = final_checkpoint.auction == auction.key(),
        constraint = final_checkpoint.timestamp >= auction.end_time,
        constraint = final_checkpoint.next_timestamp == MAX_TIMESTAMP,
    )]
    pub final_checkpoint: Box<Account<'info, Checkpoint>>,

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

pub fn handle_exit_bid(ctx: Context<ExitBid>) -> Result<()> {
    let auction = &ctx.accounts.auction;
    let bid = &mut ctx.accounts.bid;

    require!(bid.exited_time == 0, CCAError::BidAlreadyExited);

    let clock = Clock::get()?;
    let now = auction_now(auction.mode, &clock);
    require!(now >= auction.end_time, CCAError::AuctionNotEnded);

    let (tokens_filled, refund) = if !auction.graduated {
        // Not graduated: full refund
        (0u64, (bid.amount_q64 >> 64) as u64)
    } else {
        let final_cp = &ctx.accounts.final_checkpoint;

        // Partially filled bids must use exit_partially_filled_bid
        require!(
            bid.max_price != final_cp.clearing_price,
            CCAError::CannotExitBid
        );
        // Bid is below clearing price: no fill, full refund
        if bid.max_price < final_cp.clearing_price {
            (0u64, (bid.amount_q64 >> 64) as u64)
        } else {
            // Fully filled: max_price > clearing_price
            let start_cp = &ctx.accounts.start_checkpoint;
            let mps_delta = (final_cp.cumulative_mps - start_cp.cumulative_mps) as u128;
            let mps_per_price_delta = final_cp
                .cumulative_mps_per_price
                .saturating_sub(start_cp.cumulative_mps_per_price);
            let mps_remaining = (MPS - bid.start_cumulative_mps) as u128;

            // currency_spent in Q64 units: amount_q64 * (mps_delta / mps_remaining)
            let currency_spent_q64 =
                mul_div_round_up(bid.amount_q64, mps_delta, mps_remaining)?;

            // cumulative_mps_per_price is scaled by 2^96, so the token formula
            // is amount_q64 * mps_per_price_delta / (mps_remaining * 2^96).
            let tokens_denom = mps_remaining
                .checked_mul(1u128 << 96)
                .ok_or(error!(CCAError::MathOverflow))?;
            let tokens = mul_div(bid.amount_q64, mps_per_price_delta, tokens_denom)?;

            let refund_q64 = saturating_sub(bid.amount_q64, currency_spent_q64);
            ((tokens as u64), (refund_q64 >> 64) as u64)
        }
    };

    bid.exited_time = now;
    bid.tokens_filled = tokens_filled;

    // Transfer refund
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
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.currency_vault.to_account_info(),
                to: ctx.accounts.bid_owner_currency_account.to_account_info(),
                authority: ctx.accounts.auction.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, refund)?;
    }

    Ok(())
}
