use anchor_lang::prelude::*;

#[error_code]
pub enum CCAError {
    #[msg("Auction has not started yet")]
    AuctionNotStarted,
    #[msg("Auction has already ended")]
    AuctionEnded,
    #[msg("Auction has not ended yet")]
    AuctionNotEnded,
    #[msg("Claim time has not been reached")]
    ClaimTimeNotReached,
    #[msg("Bid price is too low")]
    BidPriceTooLow,
    #[msg("Bid price exceeds maximum")]
    BidPriceTooHigh,
    #[msg("Invalid tick spacing")]
    InvalidTickSpacing,
    #[msg("Invalid previous tick hint")]
    InvalidPrevTick,
    #[msg("Bid has already been exited")]
    BidAlreadyExited,
    #[msg("Bid has not been exited")]
    BidNotExited,
    #[msg("Auction did not graduate")]
    NotGraduated,
    #[msg("Already swept")]
    AlreadySwept,
    #[msg("Invalid checkpoint hint")]
    InvalidCheckpointHint,
    #[msg("Invalid steps configuration")]
    InvalidStepsConfig,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Tokens not received")]
    TokensNotReceived,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Invalid owner")]
    InvalidOwner,
    #[msg("No tokens to claim")]
    NoTokensToClaim,
    #[msg("Cannot exit bid")]
    CannotExitBid,
}
