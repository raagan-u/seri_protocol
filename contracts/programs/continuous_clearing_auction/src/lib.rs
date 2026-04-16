use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

use instructions::*;

declare_id!("vZ6194M81Y4CsuQ43y5kShFu4udkjY3UekVnMKYAySm");

#[program]
pub mod continuous_clearing_auction {
    use super::*;

    pub fn initialize_auction(
        ctx: Context<InitializeAuction>,
        params: InitializeAuctionParams,
    ) -> Result<()> {
        instructions::initialize::handle_initialize_auction(ctx, params)
    }

    pub fn submit_bid(ctx: Context<SubmitBid>, params: SubmitBidParams) -> Result<()> {
        instructions::submit_bid::handle_submit_bid(ctx, params)
    }

    pub fn checkpoint(ctx: Context<CheckpointAccounts>, params: CheckpointParams) -> Result<()> {
        instructions::checkpoint::handle_checkpoint(ctx, params)
    }

    pub fn exit_bid(ctx: Context<ExitBid>) -> Result<()> {
        instructions::exit_bid::handle_exit_bid(ctx)
    }

    pub fn claim_tokens(ctx: Context<ClaimTokens>) -> Result<()> {
        instructions::claim_tokens::handle_claim_tokens(ctx)
    }

    pub fn exit_partially_filled_bid(ctx: Context<ExitPartiallyFilledBid>) -> Result<()> {
        instructions::exit_partially_filled_bid::handle_exit_partially_filled_bid(ctx)
    }
}
