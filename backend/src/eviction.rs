//! Off-chain mirror of the on-chain `iterate_over_ticks_and_find_clearing_price` loop.
//! Used by the crank (for `checkpoint` / `finalize_auction`) and the bid-tx builder
//! (for `submit_bid`) to compute the `remaining_accounts` slice that the program
//! consumes as the eviction queue.

use solana_sdk::pubkey::Pubkey;
use sqlx::{PgPool, Row};

/// u128 sentinel matching the on-chain `MAX_TICK_PRICE`.
const MAX_TICK_PRICE: u128 = u128::MAX;

#[derive(Debug, Clone)]
pub struct TickRow {
    pub price: u128,
    pub next_price: u128,
    pub currency_demand_q64: u128,
}

/// Plan for the `remaining_accounts` slice of a checkpoint-style ix.
///
/// `eviction_queue` is the price-ascending list of tick PDAs the on-chain loop will evict
/// (starting at `auction.next_active_tick_price`). `clearing_tick` is the post-eviction tick
/// whose price equals the new clearing — needed when the loop didn't itself evict the
/// clearing tick (which is the common case for steady-state checkpoints with no demand
/// changes).
#[derive(Debug, Clone, Default)]
pub struct EvictionPlan {
    pub eviction_queue: Vec<Pubkey>,
    pub clearing_tick: Option<Pubkey>,
}

impl EvictionPlan {
    pub fn into_account_metas(self) -> Vec<Pubkey> {
        let mut out = self.eviction_queue;
        if let Some(p) = self.clearing_tick {
            out.push(p);
        }
        out
    }
}

/// Load every tick row for `auction`, indexed by price.
pub async fn load_ticks(db: &PgPool, auction: &str) -> anyhow::Result<Vec<TickRow>> {
    let rows = sqlx::query(
        "SELECT price, next_price, currency_demand_q64 FROM ticks WHERE auction = $1",
    )
    .bind(auction)
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let price: String = r.get("price");
        let next_price: String = r.get("next_price");
        let demand: String = r.get("currency_demand_q64");
        out.push(TickRow {
            price: price.parse().unwrap_or(0),
            next_price: next_price.parse().unwrap_or(0),
            currency_demand_q64: demand.parse().unwrap_or(0),
        });
    }
    Ok(out)
}

/// Mirror of the on-chain eviction loop. Given the auction's pre-checkpoint state,
/// returns the queue of tick PDAs the on-chain loop will evict + (optionally) the
/// post-eviction clearing tick PDA.
///
/// Decimal math matches `compute_clearing_price` / `supply_threshold_at_tick` in
/// `contracts/.../shared.rs`: prices live at Q64×(human currency / human token).
pub fn plan_eviction(
    program_id: &Pubkey,
    auction: &Pubkey,
    ticks: &[TickRow],
    sum_demand_in: u128,
    next_active_in: u128,
    clearing_in: u128,
    total_supply: u64,
    token_decimals: u8,
    currency_decimals: u8,
) -> EvictionPlan {
    if total_supply == 0 {
        return EvictionPlan::default();
    }

    let token_scale = match 10u128.checked_pow(token_decimals as u32) {
        Some(v) => v,
        None => return EvictionPlan::default(),
    };
    let currency_scale = match 10u128.checked_pow(currency_decimals as u32) {
        Some(v) => v,
        None => return EvictionPlan::default(),
    };

    use std::collections::HashMap;
    let by_price: HashMap<u128, &TickRow> = ticks.iter().map(|t| (t.price, t)).collect();

    let mut sum_demand = sum_demand_in;
    let mut next_active = next_active_in;
    let mut minimum_clearing = clearing_in;
    let mut clearing = compute_clearing(sum_demand, total_supply, token_scale, currency_scale);

    let mut queue: Vec<Pubkey> = Vec::new();
    let mut last_evicted_price: Option<u128> = None;

    loop {
        if next_active == MAX_TICK_PRICE {
            break;
        }
        let threshold = match supply_threshold(total_supply, next_active, token_scale, currency_scale) {
            Some(v) => v,
            None => break,
        };
        let evict = sum_demand >= threshold || clearing == next_active;
        if !evict {
            break;
        }
        let Some(t) = by_price.get(&next_active) else { break };

        queue.push(tick_pda(program_id, auction, next_active));
        sum_demand = sum_demand.saturating_sub(t.currency_demand_q64);
        minimum_clearing = next_active;
        last_evicted_price = Some(next_active);
        next_active = t.next_price;

        clearing = compute_clearing(sum_demand, total_supply, token_scale, currency_scale);
    }

    let new_clearing = clearing.max(minimum_clearing);

    // The on-chain loop already consumed the clearing tick if eviction happened AND the
    // new clearing equals the last-evicted price. Otherwise (clearing landed on an
    // initialized tick whose demand is sitting "at clearing"), we must pass it as the
    // trailing account.
    let clearing_tick = if last_evicted_price == Some(new_clearing) {
        None
    } else if by_price.contains_key(&new_clearing) {
        Some(tick_pda(program_id, auction, new_clearing))
    } else {
        None
    };

    EvictionPlan {
        eviction_queue: queue,
        clearing_tick,
    }
}

fn compute_clearing(sum_demand: u128, total_supply: u64, token_scale: u128, currency_scale: u128) -> u128 {
    if sum_demand == 0 || total_supply == 0 {
        return 0;
    }
    // mul_div_round_up(sum_demand, token_scale, total_supply * currency_scale)
    let supply_scaled = match (total_supply as u128).checked_mul(currency_scale) {
        Some(v) => v,
        None => return u128::MAX,
    };
    mul_div_round_up_u256(sum_demand, token_scale, supply_scaled)
}

fn supply_threshold(total_supply: u64, tick_price: u128, token_scale: u128, currency_scale: u128) -> Option<u128> {
    let price_scaled = tick_price.checked_mul(currency_scale)?;
    mul_div_u256(total_supply as u128, price_scaled, token_scale)
}

fn tick_pda(program_id: &Pubkey, auction: &Pubkey, price: u128) -> Pubkey {
    let (pda, _) = Pubkey::find_program_address(
        &[b"tick", auction.as_ref(), &price.to_le_bytes()],
        program_id,
    );
    pda
}

// --- u256 helpers (mirrors of math/fixed_point.rs) ---

fn wide_mul(a: u128, b: u128) -> (u128, u128) {
    let a_lo = a & u64::MAX as u128;
    let a_hi = a >> 64;
    let b_lo = b & u64::MAX as u128;
    let b_hi = b >> 64;
    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;
    let mid = lh + hl;
    let lo = ll.wrapping_add(mid << 64);
    let carry = if lo < ll { 1u128 } else { 0u128 };
    let hi = hh + (mid >> 64) + carry;
    (hi, lo)
}

fn wide_div(hi: u128, lo: u128, divisor: u128) -> Option<u128> {
    if divisor == 0 {
        return None;
    }
    if hi == 0 {
        return Some(lo / divisor);
    }
    if hi >= divisor {
        return None;
    }
    let mut rem = hi;
    let mut quot: u128 = 0;
    for i in (0..128).rev() {
        let bit = (lo >> i) & 1;
        let high_bit = rem >> 127;
        rem = (rem << 1) | bit;
        if high_bit == 1 || rem >= divisor {
            rem = rem.wrapping_sub(divisor);
            quot = (quot << 1) | 1;
        } else {
            quot <<= 1;
        }
    }
    Some(quot)
}

fn mul_div_u256(a: u128, b: u128, c: u128) -> Option<u128> {
    let (hi, lo) = wide_mul(a, b);
    wide_div(hi, lo, c)
}

fn mul_div_round_up_u256(a: u128, b: u128, c: u128) -> u128 {
    let (hi, lo) = wide_mul(a, b);
    let q = match wide_div(hi, lo, c) {
        Some(v) => v,
        None => return u128::MAX,
    };
    let (rhi, rlo) = wide_mul(q, c);
    if rhi != hi || rlo != lo {
        q.saturating_add(1)
    } else {
        q
    }
}
