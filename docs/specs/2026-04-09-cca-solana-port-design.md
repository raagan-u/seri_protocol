# CCA Solana Port — Design Specification

## Overview

Port the Continuous Clearing Auction (CCA) protocol from EVM/Solidity to Solana/Anchor. The CCA generalizes uniform-price auctions into continuous time for fair token price discovery during liquidity bootstrapping.

**Goal:** Prove end-to-end that the CCA mechanism works on Solana — from auction creation through bid submission, clearing price discovery, bid exit, token claims, and fund sweeps.

**What's deferred to phase 2:**
- DEX pool seeding (Raydium/Orca integration)
- Validation hooks (bid gating)
- `claim_tokens_batch` (client-side loop instead)
- `force_iterate_over_ticks` (only needed for very long tick lists)

---

## Key Translation Decisions

| EVM Concept | Solana Translation | Rationale |
|---|---|---|
| Block numbers | Unix timestamps (`Clock::unix_timestamp`) | Solana slots are too fast/unpredictable; timestamps are user-friendly |
| Solidity mappings | PDAs (one account per entity) | Clean separation, easy to query, standard Anchor pattern |
| u256 / Q96 math | u128 / Q64 math | Solana has no native u256; Q64 gives ~18 decimal digits of precision |
| ERC20 transfers | SPL Token transfers (CPI) | Standard Solana token program |
| CREATE2 factory | PDA derivation | Deterministic addresses from seeds |
| Lazy checkpoint | Lazy checkpoint | Recompute clearing price on every `submit_bid` / `checkpoint` call |
| SSTORE2 steps | Serialized vec in dedicated PDA | Anchor handles serialization |

---

## Account Architecture

### Auction (main state PDA)

**Seeds:** `["auction", token_mint, creator]`

```rust
pub struct Auction {
    // Config (immutable after init)
    pub token_mint: Pubkey,
    pub currency_mint: Pubkey,
    pub token_vault: Pubkey,
    pub currency_vault: Pubkey,
    pub creator: Pubkey,
    pub tokens_recipient: Pubkey,
    pub funds_recipient: Pubkey,
    pub total_supply: u64,            // token base units
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
    pub tick_spacing: u64,
    pub floor_price: u128,            // Q64 fixed-point
    pub max_bid_price: u128,          // Q64
    pub required_currency_raised: u64,

    // Live state (mutated during auction)
    pub clearing_price: u128,                        // Q64
    pub sum_currency_demand_above_clearing: u128,    // Q64, effective demand
    pub next_active_tick_price: u128,                // Q64
    pub next_bid_id: u64,
    pub last_checkpointed_time: i64,
    pub currency_raised_q64_x7: u128,               // cumulative currency raised
    pub total_cleared_q64_x7: u128,                  // cumulative tokens sold
    pub tokens_received: bool,
    pub sweep_currency_done: bool,
    pub sweep_tokens_done: bool,
    pub graduated: bool,                             // cached after end_time
    pub bump: u8,
}
```

### Tick (price linked list node)

**Seeds:** `["tick", auction, price.to_le_bytes()]`

```rust
pub struct Tick {
    pub auction: Pubkey,
    pub price: u128,               // Q64, this tick's price
    pub next_price: u128,          // Q64, next tick in linked list (u128::MAX = sentinel)
    pub currency_demand_q64: u128, // total effective demand at this price
    pub bump: u8,
}
```

### Checkpoint (time snapshot linked list node)

**Seeds:** `["checkpoint", auction, timestamp.to_le_bytes()]`

```rust
pub struct Checkpoint {
    pub auction: Pubkey,
    pub timestamp: i64,
    pub clearing_price: u128,                              // Q64
    pub currency_raised_at_clearing_price_q64_x7: u128,   // resets on price change
    pub cumulative_mps_per_price: u128,                    // accumulator for lazy fill calc
    pub cumulative_mps: u32,                               // total % sold so far (max 10^7)
    pub prev_timestamp: i64,                               // previous checkpoint
    pub next_timestamp: i64,                               // next checkpoint (i64::MAX = sentinel)
    pub bump: u8,
}
```

### Bid

**Seeds:** `["bid", auction, bid_id.to_le_bytes()]`

```rust
pub struct Bid {
    pub auction: Pubkey,
    pub bid_id: u64,
    pub owner: Pubkey,
    pub max_price: u128,            // Q64
    pub amount_q64: u128,           // currency amount << 64
    pub start_time: i64,
    pub start_cumulative_mps: u32,
    pub exited_time: i64,           // 0 = not exited
    pub tokens_filled: u64,         // tokens allocated
    pub bump: u8,
}
```

### AuctionSteps (supply schedule)

**Seeds:** `["steps", auction]`

```rust
pub struct AuctionSteps {
    pub auction: Pubkey,
    pub steps: Vec<AuctionStep>,
    pub current_step_index: u32,
    pub bump: u8,
}

pub struct AuctionStep {
    pub mps: u32,        // milli-basis-points of supply to sell per second
    pub duration: u32,   // seconds this step lasts
}
```

---

## Constants

```rust
pub const MPS: u32 = 10_000_000;          // 100% in milli-basis-points
pub const Q64: u128 = 1 << 64;            // fixed-point denominator
pub const MAX_TICK_PRICE: u128 = u128::MAX; // sentinel for linked list end
pub const MAX_TIMESTAMP: i64 = i64::MAX;    // sentinel for checkpoint list end
pub const X7_UPPER_BOUND: u128 = u128::MAX / 10_000_000; // overflow guard
```

---

## Fixed-Point Math

**Core helper:**

```rust
/// Compute (a * b) / c without u128 overflow.
/// Uses u128 -> (high, low) widening for the intermediate product.
fn mul_div(a: u128, b: u128, c: u128) -> u128

/// Same but rounds up.
fn mul_div_round_up(a: u128, b: u128, c: u128) -> u128
```

**Formula translations from EVM:**

| Formula | EVM | Solana |
|---|---|---|
| Scale bid amount | `amount << 96` | `amount << 64` |
| Effective amount | `amountQ96 * MPS / mpsRemaining` | same, u128 safe |
| Clearing price | `sumAbove / totalSupply` | same |
| MPS per price | `(mps << 192) / price` | `(mps << 96) / price` |
| Tokens from currency | `fullMulDivUp(currency, Q96, price)` | `mul_div_round_up(currency, Q64, price)` |
| Currency delta | `sumAboveClearing * deltaMps` | same, overflow check via X7_UPPER_BOUND |

**ValueX7** stays the same — multiply by MPS (10^7) to avoid intermediate division. All u128 safe for reasonable auction sizes.

---

## Instruction Specifications

### 1. `initialize_auction`

**Signers:** creator (pays for accounts)

**Accounts created:** Auction, AuctionSteps, floor-price Tick, token_vault (ATA), currency_vault (ATA)

**Logic:**
1. Validate parameters:
   - `claim_time >= end_time`
   - `floor_price > 0`, `tick_spacing >= 2`
   - `floor_price + tick_spacing <= max_bid_price`
   - Sum of `step.mps * step.duration` == MPS (10^7)
   - Sum of `step.duration` == `end_time - start_time`
2. Compute `max_bid_price` from `total_supply` (simplified version of MaxBidPriceLib)
3. Initialize floor price Tick with `next_price = MAX_TICK_PRICE`
4. Transfer `total_supply` tokens from creator to `token_vault`
5. Set `clearing_price = floor_price`, `next_active_tick_price = MAX_TICK_PRICE`

### 2. `submit_bid`

**Signers:** bidder (pays for Bid PDA)

**Accounts:** Auction, Bid (init), Tick at max_price (init_if_needed), prev Tick (for linked list insertion), latest Checkpoint, new Checkpoint (init), AuctionSteps, bidder token account, currency_vault, Clock sysvar

**Logic:**
1. Verify `now >= start_time && now < end_time`
2. Verify `max_price > clearing_price && max_price <= max_bid_price`
3. Verify `max_price % tick_spacing == 0` (or `max_price == floor_price`)
4. Run `_checkpoint_at_time(now)` (see checkpoint logic below)
5. Create Bid:
   - `amount_q64 = amount << 64`
   - `start_time = now`
   - `start_cumulative_mps = checkpoint.cumulative_mps`
6. Initialize Tick PDA if new, insert into linked list using `prev_tick_price` hint
7. Update `tick.currency_demand_q64 += bid.effective_amount()`
8. Update `auction.sum_currency_demand_above_clearing += bid.effective_amount()`
9. Transfer currency from bidder to `currency_vault`

### 3. `checkpoint`

**Signers:** anyone (permissionless)

**Accounts:** Auction, latest Checkpoint, new Checkpoint (init), AuctionSteps, relevant Tick accounts (for iteration), Clock sysvar

**Logic (`_checkpoint_at_time`):**
1. If `now == last_checkpointed_time`: return (no-op)
2. Load latest checkpoint
3. Calculate `delta_mps`:
   - Walk through auction steps from `last_checkpointed_time` to `now`
   - Accumulate `mps * time_elapsed_in_step` for each step covered
4. If `remaining_mps > 0`: iterate ticks to find new clearing price
   - `clearing_price = sum_above / total_supply` (rounded up)
   - While `next_active_tick_price <= clearing_price`: remove tick demand, advance
5. Sell tokens at clearing price:
   - `currency_delta = sum_above_clearing * delta_mps`
   - Handle partial fill at clearing tick (pro-rata)
   - `tokens_delta = mul_div_round_up(currency_delta, Q64, clearing_price)`
   - Update `total_cleared_q64_x7`, `currency_raised_q64_x7`
6. Update checkpoint fields: `cumulative_mps`, `cumulative_mps_per_price`, `clearing_price`
7. If clearing price changed: reset `currency_raised_at_clearing_price_q64_x7`
8. Link checkpoint into doubly-linked list
9. Update `auction.last_checkpointed_time = now`

### 4. `exit_bid`

**Signers:** anyone (permissionless, tokens go to bid.owner)

**Accounts:** Auction, Bid, start Checkpoint (at bid.start_time), final Checkpoint (at end_time), currency_vault, bid owner's currency account

**Logic:**
1. Verify `bid.exited_time == 0`
2. Ensure end_time is checkpointed
3. If not graduated: full refund (`tokens_filled = 0`, refund full amount)
4. If graduated and `bid.max_price > final_checkpoint.clearing_price`:
   - `mps_delta = final_cp.cumulative_mps - start_cp.cumulative_mps`
   - `mps_per_price_delta = final_cp.cumulative_mps_per_price - start_cp.cumulative_mps_per_price`
   - `currency_spent = mul_div_round_up(bid.amount_q64, mps_delta, Q64 * (MPS - bid.start_cumulative_mps))`
   - `tokens_filled = bid.amount_q64 * mps_per_price_delta / (Q64 * MPS * (MPS - start_cumulative_mps))`
   - `refund = saturating_sub(bid.amount_q64, currency_spent) >> 64`
5. Mark `bid.exited_time = now`, store `bid.tokens_filled`
6. Transfer refund currency to bid.owner

### 5. `exit_partially_filled_bid`

**Signers:** anyone

**Accounts:** Auction, Bid, start Checkpoint, last-fully-filled Checkpoint, upper Checkpoint (outbid or final), Tick at bid.max_price, currency_vault, bid owner's currency account

**Logic:**
1. Validate checkpoint hints:
   - `last_fully_filled_cp.clearing_price < bid.max_price`
   - Next checkpoint's clearing price `>= bid.max_price`
2. Calculate fully-filled portion (same as `exit_bid`)
3. Calculate partially-filled portion:
   - `pro_rata = bid.amount_q64 / (tick.currency_demand_q64 * (MPS - bid.start_cumulative_mps))`
   - `partial_currency = pro_rata * upper_cp.currency_raised_at_clearing_price_q64_x7`
   - `partial_tokens = partial_currency / bid.max_price`
4. Sum both portions, process exit

### 6. `claim_tokens`

**Signers:** anyone

**Accounts:** Auction, Bid, token_vault, bid owner's token account

**Logic:**
1. Verify `now >= claim_time`
2. Verify graduated
3. Verify `bid.exited_time != 0` and `bid.tokens_filled > 0`
4. Transfer `bid.tokens_filled` tokens from vault to bid.owner
5. Set `bid.tokens_filled = 0`

### 7. `sweep_currency`

**Signers:** anyone (one-time, permissionless)

**Accounts:** Auction, currency_vault, funds_recipient's currency account

**Logic:**
1. Verify `now > end_time`, not already swept, graduated
2. Transfer currency_vault balance to funds_recipient
3. Set `sweep_currency_done = true`

### 8. `sweep_unsold_tokens`

**Signers:** anyone (one-time, permissionless)

**Accounts:** Auction, token_vault, tokens_recipient's token account

**Logic:**
1. Verify `now > end_time`, not already swept
2. If graduated: `unsold = total_supply - total_cleared()`
3. If not graduated: `unsold = total_supply`
4. Transfer unsold tokens to tokens_recipient
5. Set `sweep_tokens_done = true`

---

## State Transitions

```
    CREATED            ACTIVE             ENDED            CLAIMABLE
  ┌──────────┐     ┌───────────┐     ┌──────────┐     ┌───────────┐
  │ init     │────>│ submit_bid│────>│ exit_bid │────>│claim_tokens│
  │ auction  │     │ checkpoint│     │ exit_part│     │sweep_curr  │
  │          │     │           │     │ sweep_*  │     │sweep_tokens│
  └──────────┘     └───────────┘     └──────────┘     └───────────┘
   now < start      start <= now       now >= end       now >= claim
                     < end

  Graduation checked at end_time:
    currency_raised >= required  →  GRADUATED (tokens claimable)
    currency_raised < required   →  NOT GRADUATED (full refunds)
```

---

## Error Codes

```rust
pub enum CCAError {
    AuctionNotStarted,
    AuctionEnded,
    AuctionNotEnded,
    ClaimTimeNotReached,
    BidPriceTooLow,          // max_price <= clearing_price
    BidPriceTooHigh,         // max_price > max_bid_price
    InvalidTickSpacing,      // max_price % tick_spacing != 0
    InvalidPrevTick,         // prev tick hint is wrong
    BidAlreadyExited,
    BidNotExited,
    NotGraduated,
    AlreadySwept,
    InvalidCheckpointHint,
    InvalidStepsConfig,      // mps*duration doesn't sum to MPS
    MathOverflow,
    TokensNotReceived,
    ZeroAmount,
    InvalidOwner,
}
```

---

## Testing Strategy

**Unit tests (Anchor test suite in TypeScript):**
1. Initialize auction with valid params
2. Submit single bid, verify state changes
3. Submit multiple bids at different prices, verify tick list
4. Checkpoint advances clearing price correctly
5. Exit bid after graduation — correct tokens + refund
6. Exit bid after non-graduation — full refund
7. Partial fill exit with checkpoint hints
8. Claim tokens after claim_time
9. Sweep currency and unsold tokens
10. Error cases: bid too low, auction not started, double exit, etc.

**Integration test:**
- Full lifecycle: create auction → N bids → checkpoints → end → exit all → claim all → sweep

---

## Project Structure

```
solana-cca/
├── Anchor.toml
├── Cargo.toml
├── programs/
│   └── continuous-clearing-auction/
│       └── src/
│           ├── lib.rs              # program entrypoint, instruction dispatch
│           ├── state/
│           │   ├── mod.rs
│           │   ├── auction.rs      # Auction account
│           │   ├── tick.rs         # Tick account
│           │   ├── checkpoint.rs   # Checkpoint account
│           │   ├── bid.rs          # Bid account
│           │   └── steps.rs        # AuctionSteps account
│           ├── instructions/
│           │   ├── mod.rs
│           │   ├── initialize.rs   # initialize_auction
│           │   ├── submit_bid.rs   # submit_bid
│           │   ├── checkpoint.rs   # checkpoint
│           │   ├── exit_bid.rs     # exit_bid
│           │   ├── exit_partial.rs # exit_partially_filled_bid
│           │   ├── claim.rs        # claim_tokens
│           │   ├── sweep.rs        # sweep_currency, sweep_unsold_tokens
│           │   └── shared.rs       # shared checkpoint/clearing logic
│           ├── math/
│           │   ├── mod.rs
│           │   ├── fixed_point.rs  # Q64, mul_div, mul_div_round_up
│           │   └── constants.rs    # MPS, Q64, sentinels
│           └── errors.rs           # CCAError enum
├── tests/
│   └── cca.ts                     # Anchor integration tests
└── app/                            # Frontend (phase 2)
```
