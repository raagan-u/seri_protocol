use anchor_lang::prelude::*;

declare_id!("CCA1111111111111111111111111111111111111111");

#[program]
pub mod continuous_clearing_auction {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
