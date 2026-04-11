use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AuctionStep {
    pub mps: u32,
    pub duration: u32,
}

#[account]
pub struct AuctionSteps {
    pub auction: Pubkey,
    pub steps: Vec<AuctionStep>,
    pub current_step_index: u32,
    pub bump: u8,
}

impl AuctionSteps {
    pub fn size(num_steps: usize) -> usize {
        8           // discriminator
        + 32        // auction
        + 4         // vec length prefix
        + num_steps * (4 + 4)  // each AuctionStep: mps (u32) + duration (u32)
        + 4         // current_step_index
        + 1         // bump
    }

    pub fn get_step_at_time(&self, start_time: i64, t: i64) -> Option<(u32, i64, i64)> {
        let mut cursor = start_time;
        for step in &self.steps {
            let step_end = cursor + step.duration as i64;
            if t < step_end {
                return Some((step.mps, cursor, step_end));
            }
            cursor = step_end;
        }
        None
    }

    pub fn calculate_delta_mps(&self, start_time: i64, from: i64, to: i64) -> u64 {
        let mut total: u64 = 0;
        let mut cursor = start_time;
        for step in &self.steps {
            let step_end = cursor + step.duration as i64;
            let overlap_start = from.max(cursor);
            let overlap_end = to.min(step_end);
            if overlap_start < overlap_end {
                total += step.mps as u64 * (overlap_end - overlap_start) as u64;
            }
            cursor = step_end;
        }
        total
    }
}
