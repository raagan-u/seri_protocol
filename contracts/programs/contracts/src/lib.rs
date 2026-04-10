use anchor_lang::prelude::*;

declare_id!("AM817BiyR3TYbceKp7XeLkn9HfUzvdoLAXLZxw7sZM7D");

#[program]
pub mod contracts {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
