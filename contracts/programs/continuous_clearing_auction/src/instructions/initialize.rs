use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::errors::CCAError;
use crate::math::constants::*;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeAuctionParams {
    pub total_supply: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
    pub tick_spacing: u64,
    pub floor_price: u128,
    pub required_currency_raised: u64,
    pub tokens_recipient: Pubkey,
    pub funds_recipient: Pubkey,
    pub steps: Vec<AuctionStep>,
}

#[derive(Accounts)]
#[instruction(params: InitializeAuctionParams)]
pub struct InitializeAuction<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_mint: Account<'info, Mint>,
    pub currency_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        space = 8 + Auction::INIT_SPACE,
        seeds = [b"auction", token_mint.key().as_ref(), creator.key().as_ref()],
        bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    #[account(
        init,
        payer = creator,
        space = AuctionSteps::size(params.steps.len()),
        seeds = [b"steps", auction.key().as_ref()],
        bump,
    )]
    pub auction_steps: Account<'info, AuctionSteps>,

    #[account(
        init,
        payer = creator,
        space = 8 + Tick::INIT_SPACE,
        seeds = [b"tick", auction.key().as_ref(), &params.floor_price.to_le_bytes()],
        bump,
    )]
    pub floor_tick: Account<'info, Tick>,

    #[account(
        init,
        payer = creator,
        token::mint = token_mint,
        token::authority = auction,
        seeds = [b"token_vault", auction.key().as_ref()],
        bump,
    )]
    pub token_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        token::mint = currency_mint,
        token::authority = auction,
        seeds = [b"currency_vault", auction.key().as_ref()],
        bump,
    )]
    pub currency_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = creator_token_account.mint == token_mint.key(),
        constraint = creator_token_account.owner == creator.key(),
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        space = 8 + Checkpoint::INIT_SPACE,
        seeds = [b"checkpoint", auction.key().as_ref(), &params.start_time.to_le_bytes()],
        bump,
    )]
    pub initial_checkpoint: Box<Account<'info, Checkpoint>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle_initialize_auction(ctx: Context<InitializeAuction>, params: InitializeAuctionParams) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // --- Validations ---
    require!(params.start_time > now, CCAError::InvalidStepsConfig);
    require!(
        params.end_time > params.start_time,
        CCAError::InvalidStepsConfig
    );
    require!(
        params.claim_time >= params.end_time,
        CCAError::InvalidStepsConfig
    );
    require!(
        params.tick_spacing >= MIN_TICK_SPACING,
        CCAError::InvalidTickSpacing
    );
    require!(params.floor_price > 0, CCAError::BidPriceTooLow);
    require!(params.total_supply > 0, CCAError::ZeroAmount);

    // Steps must cover exactly the auction duration and sum to MPS
    let total_duration: i64 = params.steps.iter().map(|s| s.duration as i64).sum();
    require!(
        total_duration == params.end_time - params.start_time,
        CCAError::InvalidStepsConfig
    );
    let total_mps: u64 = params
        .steps
        .iter()
        .map(|s| (s.mps as u64) * (s.duration as u64))
        .sum();
    require!(total_mps == MPS as u64, CCAError::InvalidStepsConfig);

    // --- Compute max_bid_price ---
    let max_bid_price: u128 = if params.total_supply <= (1u64 << 32) {
        u128::MAX >> 2
    } else {
        let supply = params.total_supply as u128;
        let price_from_liquidity = ((1u128 << 90) / supply) * ((1u128 << 90) / supply);
        let price_from_currency = (1u128 << 126) / supply * Q64;
        price_from_liquidity.min(price_from_currency)
    };

    require!(
        params.floor_price + (params.tick_spacing as u128) <= max_bid_price,
        CCAError::BidPriceTooHigh
    );

    // --- Initialize Auction ---
    let auction = &mut ctx.accounts.auction;
    auction.token_mint = ctx.accounts.token_mint.key();
    auction.currency_mint = ctx.accounts.currency_mint.key();
    auction.token_vault = ctx.accounts.token_vault.key();
    auction.currency_vault = ctx.accounts.currency_vault.key();
    auction.creator = ctx.accounts.creator.key();
    auction.tokens_recipient = params.tokens_recipient;
    auction.funds_recipient = params.funds_recipient;
    auction.total_supply = params.total_supply;
    auction.start_time = params.start_time;
    auction.end_time = params.end_time;
    auction.claim_time = params.claim_time;
    auction.tick_spacing = params.tick_spacing;
    auction.floor_price = params.floor_price;
    auction.max_bid_price = max_bid_price;
    auction.required_currency_raised = params.required_currency_raised;
    auction.clearing_price = params.floor_price;
    auction.sum_currency_demand_above_clearing = 0;
    auction.next_active_tick_price = MAX_TICK_PRICE;
    auction.next_bid_id = 0;
    auction.last_checkpointed_time = params.start_time;
    auction.currency_raised_q64_x7 = 0;
    auction.total_cleared_q64_x7 = 0;
    auction.tokens_received = true;
    auction.sweep_currency_done = false;
    auction.sweep_tokens_done = false;
    auction.graduated = false;
    auction.bump = ctx.bumps.auction;

    // --- Initialize AuctionSteps ---
    let steps_account = &mut ctx.accounts.auction_steps;
    steps_account.auction = auction.key();
    steps_account.steps = params.steps;
    steps_account.current_step_index = 0;
    steps_account.bump = ctx.bumps.auction_steps;

    // --- Initialize floor Tick ---
    let floor_tick = &mut ctx.accounts.floor_tick;
    floor_tick.auction = auction.key();
    floor_tick.price = params.floor_price;
    floor_tick.next_price = MAX_TICK_PRICE;
    floor_tick.currency_demand_q64 = 0;
    floor_tick.bump = ctx.bumps.floor_tick;

    // --- Initialize seed checkpoint at start_time ---
    let cp = &mut ctx.accounts.initial_checkpoint;
    cp.auction = auction.key();
    cp.timestamp = params.start_time;
    cp.clearing_price = params.floor_price;
    cp.currency_raised_at_clearing_price_q64_x7 = 0;
    cp.cumulative_mps_per_price = 0;
    cp.cumulative_mps = 0;
    cp.prev_timestamp = MAX_TIMESTAMP;
    cp.next_timestamp = MAX_TIMESTAMP;
    cp.bump = ctx.bumps.initial_checkpoint;

    // --- Transfer tokens from creator to vault ---
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.creator_token_account.to_account_info(),
            to: ctx.accounts.token_vault.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, params.total_supply)?;

    Ok(())
}
