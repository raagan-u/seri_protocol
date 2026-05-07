# Block-Based Emission PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a parallel block-based (slot-based) emission mode for Seri Protocol CCA alongside the existing time-based path.

**Architecture:** The on-chain program gains a `mode: u8` field on `Auction` and dispatches clock reads through an `auction_now()` helper. The backend spawns a parallel `init_tx_block.rs` module with a new `/api/auctions-block/build-init-tx` route and `auctions_block` Postgres table. The frontend adds a mode toggle and calls the appropriate endpoint. Both paths emit steps identically; only the time unit (seconds vs slots) differs.

**Tech Stack:** Anchor (Solana programs), Axum (backend HTTP), PostgreSQL, React + TypeScript (frontend)

---

## File Structure

**On-Chain Program:**
- Modify: `contracts/programs/continuous_clearing_auction/src/state/auction.rs` — add `mode: u8` field
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/shared.rs` — add `auction_now()` helper
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/initialize.rs` — accept mode param
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/submit_bid.rs` — use `auction_now()`
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/exit_bid.rs` — use `auction_now()`
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/exit_partially_filled_bid.rs` — use `auction_now()`
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/checkpoint.rs` — use `auction_now()`
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/claim_tokens.rs` — use `auction_now()`
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/finalize_auction.rs` — use `auction_now()`

**Backend:**
- Create: `backend/src/init_tx_block.rs` — new module for block-based auction building
- Modify: `backend/src/main.rs` — add POST `/api/auctions-block/build-init-tx` route
- Create: `backend/migrations/YYYY_create_auctions_block_table.sql` — Postgres table
- Modify: `backend/src/indexer.rs` — add block-mode auction indexing
- Modify: `backend/src/rpc.rs` — add `get_slot()` method if needed

**Frontend:**
- Modify: `frontend/src/pages/CreateAuction.tsx` — add mode toggle, update defaults, use conditional endpoint
- Modify: `frontend/src/api/client.ts` — add `buildInitBlockTx()` function
- Modify: `frontend/src/api/types.ts` — export types if needed (likely no changes needed)

---

## Tasks

### Task 1: Extend Auction state with mode field

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/state/auction.rs`

- [ ] **Step 1: Read current Auction struct**

Read the full `auction.rs` file to understand the current structure.

- [ ] **Step 2: Add mode field to Auction**

After the `required_currency_raised: u64` field, add:

```rust
pub mode: u8,  // 0 = TIME_BASED, 1 = BLOCK_BASED
```

The `#[derive(InitSpace)]` macro will automatically account for the extra byte.

- [ ] **Step 3: Build and verify no errors**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | head -50
```

Expected: Compilation succeeds (may have warnings about unused fields, that's fine).

- [ ] **Step 4: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/state/auction.rs
git commit -m "feat: add mode field to Auction state (0=time, 1=block)"
```

---

### Task 2: Add auction_now() helper

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/shared.rs`

- [ ] **Step 1: Read shared.rs**

Check what's already in `shared.rs` — it likely has utility functions.

- [ ] **Step 2: Add auction_now helper at top of file (after imports)**

```rust
use anchor_lang::prelude::*;

/// Returns the current time in the appropriate unit for the auction.
/// For TIME_BASED auctions: clock.unix_timestamp (seconds)
/// For BLOCK_BASED auctions: clock.slot as i64 (slot numbers)
pub fn auction_now(mode: u8, clock: &Clock) -> i64 {
    match mode {
        0 => clock.unix_timestamp,
        _ => clock.slot as i64,
    }
}
```

- [ ] **Step 3: Build to verify syntax**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | grep -E "error|warning" | head -20
```

Expected: No errors related to `auction_now`.

- [ ] **Step 4: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/shared.rs
git commit -m "feat: add auction_now() helper for time vs block dispatch"
```

---

### Task 3: Update initialize.rs to accept and store mode

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/initialize.rs`

- [ ] **Step 1: Add mode to InitializeAuctionParams**

Find the `InitializeAuctionParams` struct (around line 8) and add a field after `steps`:

```rust
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
    pub mode: u8,  // 0 = TIME_BASED, 1 = BLOCK_BASED
}
```

- [ ] **Step 2: Update the validation in handle_initialize_auction**

Find the line `require!(params.start_time > now, ...)` around line 105.
Replace it with:

```rust
let now = if params.mode == 1 {
    clock.slot as i64
} else {
    clock.unix_timestamp
};
require!(params.start_time > now, CCAError::InvalidStepsConfig);
```

- [ ] **Step 3: Store mode on the Auction account**

Find the section where `auction.start_time = params.start_time;` is set (around line 155).
Add after `auction.bump = ctx.bumps.auction;`:

```rust
auction.mode = params.mode;
```

- [ ] **Step 4: Build and verify**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | grep -E "error" | head -10
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/initialize.rs
git commit -m "feat: accept mode param in initialize_auction and store on Auction"
```

---

### Task 4: Update submit_bid.rs to use auction_now()

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/submit_bid.rs`

- [ ] **Step 1: Add import for auction_now**

At the top of `submit_bid.rs`, after the existing `use crate::` imports, add:

```rust
use crate::instructions::shared::auction_now;
```

- [ ] **Step 2: Find all clock.unix_timestamp reads in this file**

```bash
grep -n "clock.unix_timestamp" /Users/raagan/personal/seri_protocol/contracts/programs/continuous_clearing_auction/src/instructions/submit_bid.rs
```

You should find them around lines 100-110. Record the line numbers.

- [ ] **Step 3: Replace the first instance (the "now" variable)**

Find the line `let now = clock.unix_timestamp;` (around line 105).
Replace it with:

```rust
let now = auction_now(auction.mode, &clock);
```

- [ ] **Step 4: Replace other instances if any**

If there are other direct `clock.unix_timestamp` reads in comparisons, replace with:

```rust
auction_now(auction.mode, &clock)
```

Example: if you see `clock.unix_timestamp <= ...`, change to `auction_now(auction.mode, &clock) <= ...`

- [ ] **Step 5: Build and verify**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | grep -E "error.*submit_bid" | head -5
```

Expected: No errors in submit_bid.

- [ ] **Step 6: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/submit_bid.rs
git commit -m "fix: use auction_now() in submit_bid for time/block dispatch"
```

---

### Task 5: Update exit_bid.rs to use auction_now()

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/exit_bid.rs`

- [ ] **Step 1: Add import for auction_now**

```rust
use crate::instructions::shared::auction_now;
```

- [ ] **Step 2: Find clock.unix_timestamp reads**

```bash
grep -n "clock.unix_timestamp" /Users/raagan/personal/seri_protocol/contracts/programs/continuous_clearing_auction/src/instructions/exit_bid.rs
```

- [ ] **Step 3: Replace all instances**

For each `clock.unix_timestamp` read involving the auction, replace with `auction_now(auction.mode, &clock)`.

Typical line to replace (around line 60):
```rust
let now = clock.unix_timestamp;
```
becomes:
```rust
let now = auction_now(auction.mode, &clock);
```

- [ ] **Step 4: Build and verify**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | grep -E "error" | head -5
```

- [ ] **Step 5: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/exit_bid.rs
git commit -m "fix: use auction_now() in exit_bid for time/block dispatch"
```

---

### Task 6: Update exit_partially_filled_bid.rs to use auction_now()

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/exit_partially_filled_bid.rs`

- [ ] **Step 1: Add import for auction_now**

```rust
use crate::instructions::shared::auction_now;
```

- [ ] **Step 2: Find and replace clock.unix_timestamp**

```bash
grep -n "clock.unix_timestamp" /Users/raagan/personal/seri_protocol/contracts/programs/continuous_clearing_auction/src/instructions/exit_partially_filled_bid.rs
```

Replace all instances with `auction_now(auction.mode, &clock)`.

- [ ] **Step 3: Build and verify**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | grep -E "error" | head -5
```

- [ ] **Step 4: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/exit_partially_filled_bid.rs
git commit -m "fix: use auction_now() in exit_partially_filled_bid for time/block dispatch"
```

---

### Task 7: Update checkpoint.rs to use auction_now()

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/checkpoint.rs`

- [ ] **Step 1: Add import for auction_now**

```rust
use crate::instructions::shared::auction_now;
```

- [ ] **Step 2: Find clock.unix_timestamp references**

```bash
grep -n "clock.unix_timestamp" /Users/raagan/personal/seri_protocol/contracts/programs/continuous_clearing_auction/src/instructions/checkpoint.rs
```

- [ ] **Step 3: Replace all instances**

The key line is typically `let now = clock.unix_timestamp;` around line 60.
Replace with:
```rust
let now = auction_now(auction.mode, &clock);
```

- [ ] **Step 4: Build and verify**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | grep -E "error" | head -5
```

- [ ] **Step 5: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/checkpoint.rs
git commit -m "fix: use auction_now() in checkpoint for time/block dispatch"
```

---

### Task 8: Update claim_tokens.rs to use auction_now()

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/claim_tokens.rs`

- [ ] **Step 1: Add import for auction_now**

```rust
use crate::instructions::shared::auction_now;
```

- [ ] **Step 2: Find and replace clock.unix_timestamp**

```bash
grep -n "clock.unix_timestamp" /Users/raagan/personal/seri_protocol/contracts/programs/continuous_clearing_auction/src/instructions/claim_tokens.rs
```

Replace with `auction_now(auction.mode, &clock)`.

- [ ] **Step 3: Build and verify**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | grep -E "error" | head -5
```

- [ ] **Step 4: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/claim_tokens.rs
git commit -m "fix: use auction_now() in claim_tokens for time/block dispatch"
```

---

### Task 9: Update finalize_auction.rs to use auction_now()

**Files:**
- Modify: `contracts/programs/continuous_clearing_auction/src/instructions/finalize_auction.rs`

- [ ] **Step 1: Add import for auction_now**

```rust
use crate::instructions::shared::auction_now;
```

- [ ] **Step 2: Find and replace clock.unix_timestamp**

```bash
grep -n "clock.unix_timestamp" /Users/raagan/personal/seri_protocol/contracts/programs/continuous_clearing_auction/src/instructions/finalize_auction.rs
```

- [ ] **Step 3: Replace with auction_now() dispatch**

Typical replacement around line 60:
```rust
let now = auction_now(auction.mode, &clock);
require!(now >= auction.end_time, ...);
```

- [ ] **Step 4: Build and deploy**

```bash
cd /Users/raagan/personal/seri_protocol/contracts && anchor build 2>&1 | tail -5
```

Expected: "Finished `release` profile..."

Then deploy:
```bash
anchor deploy --provider.cluster devnet 2>&1 | tail -20
```

Expected: "Deploy success" message with new program ID confirmation.

- [ ] **Step 5: Commit**

```bash
git add contracts/programs/continuous_clearing_auction/src/instructions/finalize_auction.rs
git commit -m "fix: use auction_now() in finalize_auction for time/block dispatch"
```

---

### Task 10: Create init_tx_block.rs backend module

**Files:**
- Create: `backend/src/init_tx_block.rs`

- [ ] **Step 1: Copy and adapt init_tx.rs**

Read `backend/src/init_tx.rs` completely, then create a new file `backend/src/init_tx_block.rs` with the same structure but with these changes:

```rust
//! Builds an unsigned initialize_auction transaction for block-based auctions.

use crate::rpc::{RpcClient, TokenAccountInfo};
use crate::tx_utils::*;
use axum::http::StatusCode;
use axum::Json;
use base64::Engine;
use borsh::BorshSerialize;
use serde::{Deserialize, Serialize};
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::sysvar;
use solana_sdk::transaction::Transaction;
use std::str::FromStr;

const INITIALIZE_AUCTION_DISCRIMINATOR: [u8; 8] = [37, 10, 117, 197, 208, 88, 117, 62];
const MPS_TOTAL: u64 = 10_000_000;
const MIN_TICK_SPACING: u64 = 2;
const SLOT_DURATION_SECS: f64 = 0.4;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInitBlockTxBody {
    pub creator: String,
    pub token_mint: String,
    pub currency_mint: String,
    #[serde(default)]
    pub preset: Option<String>,
    pub params: InitializeAuctionParamsInput,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeAuctionParamsInput {
    pub total_supply: String,
    pub start_time: i64,   // Unix timestamp (user intent)
    pub end_time: i64,     // Unix timestamp (user intent)
    pub claim_time: i64,   // Unix timestamp (user intent)
    pub tick_spacing: u64,
    pub floor_price: String,
    pub required_currency_raised: String,
    pub tokens_recipient: String,
    pub funds_recipient: String,
    pub steps: Vec<AuctionStepInput>,
}

#[derive(Debug, Clone, Deserialize, BorshSerialize)]
pub struct AuctionStepInput {
    pub mps: u32,
    pub duration: u32,
}

#[derive(BorshSerialize)]
struct InitializeAuctionParamsData {
    total_supply: u64,
    start_time: i64,       // Will be start_slot
    end_time: i64,         // Will be end_slot
    claim_time: i64,       // Will be claim_slot
    tick_spacing: u64,
    floor_price: u128,
    required_currency_raised: u64,
    tokens_recipient: [u8; 32],
    funds_recipient: [u8; 32],
    steps: Vec<AuctionStepInput>,
    mode: u8,              // NEW: 1 for block-based
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInitBlockTxResponse {
    pub tx: String,
    pub auction_pda: String,
    pub token_vault: String,
    pub currency_vault: String,
    pub creator_token_account: String,
}

pub async fn build_init_block_tx(
    Json(body): Json<BuildInitBlockTxBody>,
) -> Result<Json<BuildInitBlockTxResponse>, (StatusCode, String)> {
    build_inner(body).await.map(Json).map_err(|e| {
        tracing::warn!("build_init_block_tx failed: {e:#}");
        (StatusCode::BAD_REQUEST, e.to_string())
    })
}

async fn build_inner(body: BuildInitBlockTxBody) -> anyhow::Result<BuildInitBlockTxResponse> {
    let cfg = crate::config::Config::from_env();
    let rpc = RpcClient::new(cfg.rpc_url);
    let program_id: Pubkey = cfg.program_id.parse()?;

    let creator = Pubkey::from_str(&body.creator)?;
    let token_mint = Pubkey::from_str(&body.token_mint)?;
    let currency_mint = Pubkey::from_str(&body.currency_mint)?;
    let tokens_recipient = Pubkey::from_str(&body.params.tokens_recipient)?;
    let funds_recipient = Pubkey::from_str(&body.params.funds_recipient)?;

    // --- Fetch mint decimals ---
    let token_decimals = fetch_mint_decimals(&rpc, &token_mint).await?;
    let currency_decimals = fetch_mint_decimals(&rpc, &currency_mint).await?;

    let total_supply =
        decimal_to_u64_scaled(&body.params.total_supply, token_decimals as u32)?;
    let floor_price = decimal_to_q64(&body.params.floor_price)?;
    let required_currency_raised = decimal_to_u64_scaled(
        &body.params.required_currency_raised,
        currency_decimals as u32,
    )?;

    // --- Convert Unix timestamps to slot numbers ---
    let current_slot: i64 = rpc.get_slot().await?.try_into()?;
    let now_secs = chrono::Utc::now().timestamp();
    
    let slot_offset_to_start = ((body.params.start_time - now_secs) as f64 / SLOT_DURATION_SECS).floor() as i64;
    let total_slots = ((body.params.end_time - body.params.start_time) as f64 / SLOT_DURATION_SECS).floor() as i64;
    let claim_slot_offset = ((body.params.claim_time - body.params.end_time) as f64 / SLOT_DURATION_SECS).floor() as i64;
    
    let start_slot = current_slot + slot_offset_to_start;
    let end_slot = start_slot + total_slots;
    let claim_slot = end_slot + claim_slot_offset;

    anyhow::ensure!(
        total_slots > 0,
        "Computed total_slots must be > 0"
    );

    // --- Build steps for the slot-based duration ---
    // Reuse the same step-building logic but apply to slot count
    let steps = build_block_steps_for_preset(&body.preset.unwrap_or("flat".to_string()), total_slots as u64)?;
    anyhow::ensure!(!steps.is_empty(), "steps must not be empty");

    // --- Validate params ---
    validate_block_params(
        &body.params,
        total_supply,
        floor_price,
        required_currency_raised,
        total_slots as u64,
    )?;

    // --- Derive PDAs ---
    let (auction_pda, _) = Pubkey::find_program_address(
        &[b"auction", token_mint.as_ref(), creator.as_ref()],
        &program_id,
    );
    anyhow::ensure!(
        rpc.get_account(&auction_pda.to_string()).await?.is_none(),
        "auction already exists for this creator + token mint"
    );

    let (auction_steps_pda, _) =
        Pubkey::find_program_address(&[b"steps", auction_pda.as_ref()], &program_id);
    let (floor_tick_pda, _) = Pubkey::find_program_address(
        &[b"tick", auction_pda.as_ref(), &floor_price.to_le_bytes()],
        &program_id,
    );
    let (token_vault, _) =
        Pubkey::find_program_address(&[b"token_vault", auction_pda.as_ref()], &program_id);
    let (currency_vault, _) =
        Pubkey::find_program_address(&[b"currency_vault", auction_pda.as_ref()], &program_id);
    let (initial_checkpoint, _) = Pubkey::find_program_address(
        &[
            b"checkpoint",
            auction_pda.as_ref(),
            &start_slot.to_le_bytes(),
        ],
        &program_id,
    );

    let creator_token_account =
        pick_creator_token_account(&rpc, &creator, &token_mint, total_supply).await?;

    // --- Build params with SLOT numbers and mode=1 ---
    let params_data = InitializeAuctionParamsData {
        total_supply,
        start_time: start_slot,
        end_time: end_slot,
        claim_time: claim_slot,
        tick_spacing: body.params.tick_spacing,
        floor_price,
        required_currency_raised,
        tokens_recipient: tokens_recipient.to_bytes(),
        funds_recipient: funds_recipient.to_bytes(),
        steps,
        mode: 1,  // BLOCK_BASED
    };

    let mut data = Vec::with_capacity(8 + 128 + params_data.steps.len() * 8);
    data.extend_from_slice(&INITIALIZE_AUCTION_DISCRIMINATOR);
    data.extend_from_slice(&borsh::to_vec(&params_data)?);

    let token_program = token_program_id()?;
    let system_program = system_program_id();

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(creator, true),
            AccountMeta::new_readonly(token_mint, false),
            AccountMeta::new_readonly(currency_mint, false),
            AccountMeta::new(auction_pda, false),
            AccountMeta::new(auction_steps_pda, false),
            AccountMeta::new(floor_tick_pda, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(currency_vault, false),
            AccountMeta::new(creator_token_account, false),
            AccountMeta::new(initial_checkpoint, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(system_program, false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
        ],
        data,
    };

    let blockhash_str = rpc.get_latest_blockhash().await?;
    let blockhash = bs58_to_hash(&blockhash_str)?;
    let msg = Message::new_with_blockhash(&[ix], Some(&creator), &blockhash);
    let tx = Transaction::new_unsigned(msg);
    let bytes = bincode::serialize(&tx)?;

    Ok(BuildInitBlockTxResponse {
        tx: base64::engine::general_purpose::STANDARD.encode(&bytes),
        auction_pda: auction_pda.to_string(),
        token_vault: token_vault.to_string(),
        currency_vault: currency_vault.to_string(),
        creator_token_account: creator_token_account.to_string(),
    })
}

fn build_block_steps_for_preset(preset: &str, total_slots: u64) -> anyhow::Result<Vec<AuctionStepInput>> {
    if total_slots <= 0 {
        return Ok(vec![]);
    }
    match preset {
        "flat" => exact_block_steps(MPS_TOTAL, total_slots),
        "frontloaded" => build_block_phases(total_slots, vec![0.7, 0.3]),
        "backloaded" => build_block_phases(total_slots, vec![0.3, 0.7]),
        "linear-decay" => build_block_phases(total_slots, vec![0.4, 0.3, 0.2, 0.1]),
        _ => exact_block_steps(MPS_TOTAL, total_slots),
    }
}

fn exact_block_steps(weight: u64, duration: u64) -> anyhow::Result<Vec<AuctionStepInput>> {
    if duration <= 0 || weight <= 0 {
        return Ok(vec![]);
    }
    let k = weight / duration;
    let r = weight - k * duration;
    let mut out = vec![];
    if r > 0 {
        out.push(AuctionStepInput {
            mps: (k + 1) as u32,
            duration: r as u32,
        });
    }
    if duration - r > 0 && k > 0 {
        out.push(AuctionStepInput {
            mps: k as u32,
            duration: (duration - r) as u32,
        });
    }
    Ok(out)
}

fn build_block_phases(total_slots: u64, weight_fractions: Vec<f64>) -> anyhow::Result<Vec<AuctionStepInput>> {
    let n = weight_fractions.len() as u64;
    let base_dur = total_slots / n;
    let mut durations = vec![base_dur; n as usize];
    durations[(n - 1) as usize] = total_slots - base_dur * (n - 1);

    let ideal: Vec<f64> = weight_fractions.iter().map(|f| f * MPS_TOTAL as f64).collect();
    let mut weights: Vec<u64> = ideal.iter().map(|w| *w as u64).collect();
    let mut deficit = MPS_TOTAL - weights.iter().sum::<u64>();
    
    let mut order: Vec<(usize, f64)> = ideal
        .iter()
        .enumerate()
        .map(|(i, w)| (i, w - (w.floor())))
        .collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    
    for j in 0..deficit as usize {
        weights[order[j % n as usize].0] += 1;
    }

    let mut out = vec![];
    for i in 0..n as usize {
        out.extend(exact_block_steps(weights[i], durations[i])?);
    }
    Ok(out)
}

fn validate_block_params(
    params: &InitializeAuctionParamsInput,
    total_supply: u64,
    floor_price: u128,
    required_currency_raised: u64,
    total_slots: u64,
) -> anyhow::Result<()> {
    anyhow::ensure!(params.tick_spacing >= MIN_TICK_SPACING, "tickSpacing too small");
    anyhow::ensure!(floor_price > 0, "floorPrice must be > 0");
    anyhow::ensure!(total_supply > 0, "totalSupply must be > 0");
    anyhow::ensure!(required_currency_raised > 0, "requiredCurrencyRaised must be > 0");
    anyhow::ensure!(total_slots > 0, "auction duration must be > 0 slots");
    anyhow::ensure!(total_slots >= 4, "total_slots must be at least 4 for presets");

    let max_bid_price = compute_max_bid_price(total_supply);
    anyhow::ensure!(
        floor_price
            .checked_add(params.tick_spacing as u128)
            .map(|p| p <= max_bid_price)
            .unwrap_or(false),
        "floorPrice + tickSpacing exceeds max supported bid price"
    );
    Ok(())
}

fn compute_max_bid_price(total_supply: u64) -> u128 {
    if total_supply <= (1u64 << 32) {
        u128::MAX >> 2
    } else {
        let supply = total_supply as u128;
        let price_from_liquidity = ((1u128 << 90) / supply) * ((1u128 << 90) / supply);
        let price_from_currency = ((1u128 << 126) / supply).saturating_mul(1u128 << 64);
        price_from_liquidity.min(price_from_currency)
    }
}

async fn fetch_mint_decimals(rpc: &RpcClient, mint: &Pubkey) -> anyhow::Result<u8> {
    let data = rpc
        .get_account(&mint.to_string())
        .await?
        .ok_or_else(|| anyhow::anyhow!("mint account {mint} not found"))?;
    anyhow::ensure!(
        data.len() >= 45,
        "mint account {mint} too short ({} bytes) — not an SPL Mint",
        data.len()
    );
    Ok(data[44])
}

async fn pick_creator_token_account(
    rpc: &RpcClient,
    creator: &Pubkey,
    token_mint: &Pubkey,
    min_amount: u64,
) -> anyhow::Result<Pubkey> {
    let preferred_ata = derive_ata(creator, token_mint);
    let accounts = rpc
        .get_token_accounts_by_owner_and_mint(&creator.to_string(), &token_mint.to_string())
        .await?;
    select_creator_token_account(accounts, preferred_ata, min_amount)
}

fn select_creator_token_account(
    accounts: Vec<TokenAccountInfo>,
    preferred_ata: Pubkey,
    min_amount: u64,
) -> anyhow::Result<Pubkey> {
    anyhow::ensure!(
        !accounts.is_empty(),
        "creator has no token account for the selected mint"
    );

    let mut best: Option<(u64, Pubkey)> = None;
    for account in &accounts {
        let pubkey = Pubkey::from_str(&account.pubkey)?;
        if pubkey == preferred_ata && account.amount >= min_amount {
            return Ok(pubkey);
        }
        if account.amount >= min_amount
            && best
                .as_ref()
                .map(|(amount, _)| account.amount > *amount)
                .unwrap_or(true)
        {
            best = Some((account.amount, pubkey));
        }
    }

    if let Some((_, pubkey)) = best {
        return Ok(pubkey);
    }

    let best_available = accounts.into_iter().map(|a| a.amount).max().unwrap_or(0);
    anyhow::bail!(
        "creator token balance is too low: need {min_amount} raw units, best account has {best_available}"
    );
}
```

- [ ] **Step 2: Update backend/src/rpc.rs to add get_slot() method if missing**

Check if `get_slot()` exists:
```bash
grep -n "get_slot\|fn get_slot" /Users/raagan/personal/seri_protocol/backend/src/rpc.rs
```

If it doesn't exist, add this method to the `RpcClient` impl:

```rust
pub async fn get_slot(&self) -> anyhow::Result<u64> {
    let response = reqwest::Client::new()
        .post(&self.url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getSlot"
        }))
        .send()
        .await?;
    
    let result: serde_json::Value = response.json().await?;
    result["result"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("Failed to get slot from RPC"))
}
```

- [ ] **Step 3: Verify init_tx_block.rs compiles**

```bash
cd /Users/raagan/personal/seri_protocol/backend && cargo check 2>&1 | grep -E "error\[" | head -10
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/init_tx_block.rs backend/src/rpc.rs
git commit -m "feat: add init_tx_block module for block-based auction creation"
```

---

### Task 11: Register init_tx_block route in main.rs

**Files:**
- Modify: `backend/src/main.rs`

- [ ] **Step 1: Add module declaration**

At the top of `main.rs` where other modules are declared (near `mod init_tx;`), add:

```rust
mod init_tx_block;
```

- [ ] **Step 2: Add the route in the router setup**

Find the section where routes are registered (likely in a `Router::new()` call).
Add after the existing `/api/auctions/build-init-tx` route:

```rust
.post("/api/auctions-block/build-init-tx", 
    axum::routing::post(init_tx_block::build_init_block_tx))
```

- [ ] **Step 3: Verify compilation**

```bash
cd /Users/raagan/personal/seri_protocol/backend && cargo build 2>&1 | tail -10
```

Expected: "Finished `dev` profile..."

- [ ] **Step 4: Commit**

```bash
git add backend/src/main.rs
git commit -m "feat: register /api/auctions-block/build-init-tx route"
```

---

### Task 12: Create auctions_block Postgres table

**Files:**
- Create: `backend/migrations/<timestamp>_create_auctions_block_table.sql`

- [ ] **Step 1: Read existing auctions table schema**

```bash
cat /Users/raagan/personal/seri_protocol/backend/migrations/*.sql | grep -A 50 "CREATE TABLE.*auction"
```

Or check the existing migration files for the schema.

- [ ] **Step 2: Create the migration file**

Run:
```bash
date +%s
```
to get a timestamp, e.g., `1714867200`. Use that as the migration filename.

Create `/Users/raagan/personal/seri_protocol/backend/migrations/1714867200_create_auctions_block_table.sql`:

```sql
-- Create auctions_block table for block-based auctions
-- Mirrors auctions schema with block-specific metadata columns

CREATE TABLE auctions_block (
  address TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  currency_mint TEXT NOT NULL,
  token_decimals INT NOT NULL,
  currency_decimals INT NOT NULL,
  token_vault TEXT NOT NULL,
  currency_vault TEXT NOT NULL,
  tokens_recipient TEXT NOT NULL,
  funds_recipient TEXT NOT NULL,
  total_supply BIGINT NOT NULL,
  start_time BIGINT NOT NULL,        -- Slot number (on-chain)
  end_time BIGINT NOT NULL,          -- Slot number (on-chain)
  claim_time BIGINT NOT NULL,        -- Slot number (on-chain)
  display_start_time BIGINT,         -- Original Unix timestamp for UI
  display_end_time BIGINT,           -- Original Unix timestamp for UI
  display_claim_time BIGINT,         -- Original Unix timestamp for UI
  tick_spacing BIGINT NOT NULL,
  floor_price NUMERIC(80) NOT NULL,
  required_currency_raised BIGINT NOT NULL,
  clearing_price NUMERIC(80) NOT NULL,
  tokens_received BOOLEAN NOT NULL DEFAULT FALSE,
  sweep_currency_done BOOLEAN NOT NULL DEFAULT FALSE,
  sweep_tokens_done BOOLEAN NOT NULL DEFAULT FALSE,
  graduated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  mode_marker TEXT DEFAULT 'block'
);

CREATE INDEX idx_auctions_block_creator ON auctions_block(creator);
CREATE INDEX idx_auctions_block_token_mint ON auctions_block(token_mint);
CREATE INDEX idx_auctions_block_created_at ON auctions_block(created_at);
```

- [ ] **Step 3: Run the migration**

```bash
cd /Users/raagan/personal/seri_protocol/backend && sqlx migrate run
```

Expected: Migration runs without error.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/
git commit -m "feat: create auctions_block table for block-based auctions"
```

---

### Task 13: Add block-mode indexing support

**Files:**
- Modify: `backend/src/indexer.rs`

- [ ] **Step 1: Read the indexing logic**

```bash
head -100 /Users/raagan/personal/seri_protocol/backend/src/indexer.rs
```

- [ ] **Step 2: Add a branch in the indexer to handle block-based auctions**

Find the main indexing function (likely `pub async fn index_auction(...)`).
After the existing auction indexing logic, add:

```rust
// Index into auctions_block if mode == 1 (block-based)
if auction_data.mode == 1 {
    let display_start = request_params.start_time;  // Original Unix timestamp
    let display_end = request_params.end_time;
    let display_claim = request_params.claim_time;
    
    sqlx::query(
        r#"
        INSERT INTO auctions_block (address, creator, token_mint, currency_mint, ...)
        VALUES ($1, $2, $3, $4, ..., $N, $N+1, $N+2, $N+3)
        ON CONFLICT(address) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
        "#
    )
    .bind(&auction_address)
    .bind(&creator)
    // ... (bind all fields)
    .bind(display_start)
    .bind(display_end)
    .bind(display_claim)
    .execute(&pool)
    .await?;
}
```

Adapt the exact field names and counts to match your schema.

- [ ] **Step 3: Build and test**

```bash
cd /Users/raagan/personal/seri_protocol/backend && cargo build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/indexer.rs
git commit -m "feat: add block-mode auction indexing to auctions_block table"
```

---

### Task 14: Add buildInitBlockTx to frontend client

**Files:**
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: Read the existing buildInitTx function**

Check lines around where `buildInitTx` is defined.

- [ ] **Step 2: Add buildInitBlockTx function**

After the existing `buildInitTx` export, add:

```typescript
export async function buildInitBlockTx(
  payload: CreateAuctionPayload
): Promise<BuildInitTxResponse> {
  const r = await fetch(`${API_BASE}/api/auctions-block/build-init-tx`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "build-init-block-tx failed");
    throw new Error(msg || `build-init-block-tx failed (${r.status})`);
  }
  return (await r.json()) as BuildInitTxResponse;
}
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/raagan/personal/seri_protocol/frontend && npx tsc --noEmit 2>&1 | head -20
```

Expected: No errors related to buildInitBlockTx.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat: add buildInitBlockTx client function"
```

---

### Task 15: Add mode toggle to CreateAuction form

**Files:**
- Modify: `frontend/src/pages/CreateAuction.tsx`

- [ ] **Step 1: Add mode to FormState interface**

Find `interface FormState` and add after `preset: EmissionPreset;`:

```typescript
mode: "time" | "block";
```

- [ ] **Step 2: Add mode to BLANK constant**

Add after `preset: "flat",`:

```typescript
mode: "time",
```

- [ ] **Step 3: Update defaultForm() to include mode**

The mode should remain `"time"` in defaultForm (user can toggle).

- [ ] **Step 4: Add mode toggle UI in render**

In the JSX, after the heading but before "Token identity" section, add:

```typescript
<div style={{ marginTop: 16, marginBottom: 24 }}>
  <Label>Auction mode</Label>
  <div style={{ marginTop: 8, display: "flex", gap: 16 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
      <input
        type="radio"
        name="mode"
        value="time"
        checked={form.mode === "time"}
        onChange={() => set("mode")("time")}
      />
      <span>Time-based</span>
    </label>
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
      <input
        type="radio"
        name="mode"
        value="block"
        checked={form.mode === "block"}
        onChange={() => set("mode")("block")}
      />
      <span>Block-based</span>
    </label>
  </div>
</div>
```

- [ ] **Step 5: Type-check**

```bash
cd /Users/raagan/personal/seri_protocol/frontend && npx tsc --noEmit 2>&1 | head -10
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/CreateAuction.tsx
git commit -m "feat: add auction mode toggle (time vs block)"
```

---

### Task 16: Update handleSubmit to use mode-based endpoint

**Files:**
- Modify: `frontend/src/pages/CreateAuction.tsx`

- [ ] **Step 1: Import buildInitBlockTx**

At the top of the file with other imports, add:

```typescript
import { buildInitTx, buildInitBlockTx, ... } from "../api/client";
```

(Update the import to include `buildInitBlockTx` if not already there.)

- [ ] **Step 2: Update handleSubmit logic**

Find the `handleSubmit` function. Around the line where `const resp = await buildInitTx(payload);` is called, replace with:

```typescript
const buildFn = form.mode === "block" ? buildInitBlockTx : buildInitTx;
const resp = await buildFn(payload);
```

- [ ] **Step 3: Type-check**

```bash
cd /Users/raagan/personal/seri_protocol/frontend && npx tsc --noEmit 2>&1 | head -10
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/CreateAuction.tsx
git commit -m "feat: dispatch to buildInitBlockTx based on mode toggle"
```

---

### Task 17: Update steps preview for block-based auctions

**Files:**
- Modify: `frontend/src/pages/CreateAuction.tsx`

- [ ] **Step 1: Locate the steps preview rendering**

Find the JSX that renders `{stepsPreview && (...)}`

- [ ] **Step 2: Update preview to show slot estimate for block mode**

Replace the preview rendering with:

```typescript
{stepsPreview && (
  <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
    {stepsPreview.length} emission step{stepsPreview.length !== 1 ? "s" : ""} generated
    {form.mode === "block" 
      ? ` · total ${humanDur(stepsPreview.reduce((a, s) => a + s.duration, 0))} (≈ ${Math.floor(
          (stepsPreview.reduce((a, s) => a + s.duration, 0) * 1000) / 400
        )} slots)`
      : ` · total ${humanDur(stepsPreview.reduce((a, s) => a + s.duration, 0))}`
    }
  </div>
)}
```

This shows both the duration and estimated slot count for block-based mode.

- [ ] **Step 3: Type-check**

```bash
cd /Users/raagan/personal/seri_protocol/frontend && npx tsc --noEmit 2>&1
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/CreateAuction.tsx
git commit -m "feat: show slot estimate in steps preview for block-based mode"
```

---

### Task 18: Update default auction duration to 5 minutes

**Files:**
- Modify: `frontend/src/pages/CreateAuction.tsx`

- [ ] **Step 1: Already updated in Task 1 during the earlier session**

The `defaultForm()` function already sets:
- `startTime = now + 5 min`
- `endTime = startTime + 5 min`
- `claimTime = startTime + 5 min`

Verify this is in place:
```bash
grep -A 5 "function defaultForm" /Users/raagan/personal/seri_protocol/frontend/src/pages/CreateAuction.tsx
```

If not, update it now in the existing `defaultForm()` function.

- [ ] **Step 2: No additional changes needed**

This was already done in the earlier session.

---

### Task 19: End-to-end test

**Files:**
- Test: Manual testing via UI

- [ ] **Step 1: Start backend (if not already running)**

```bash
cd /Users/raagan/personal/seri_protocol/backend && cargo run 2>&1 | grep -E "listening|error" &
```

Wait a few seconds for the server to start.

- [ ] **Step 2: Start frontend dev server (if not already running)**

```bash
cd /Users/raagan/personal/seri_protocol/frontend && npm run dev 2>&1 | grep -E "Local:|error" &
```

- [ ] **Step 3: Open frontend in browser**

Navigate to `http://localhost:5173` (or whatever port Vite uses).

- [ ] **Step 4: Test time-based auction (baseline)**

1. Toggle mode to "Time-based" (already selected).
2. Fill in token info (name, symbol, icon, etc.).
3. Set token/currency mints.
4. Verify default times: start = now+5m, end = now+10m.
5. Click "Create auction".
6. Approve in Phantom.
7. Verify transaction succeeds and auction is created.

Expected: Auction appears on Browse page with time-based clearing.

- [ ] **Step 5: Test block-based auction (new feature)**

1. Reload the page.
2. Toggle mode to "Block-based".
3. Fill in same token info.
4. Verify default times are still set correctly (start = now+5m, end = now+10m).
5. Observe the steps preview shows `(≈ 750 slots)` or similar.
6. Click "Create auction".
7. Approve in Phantom.
8. Verify transaction succeeds.

Expected: Auction is created with mode=1 on-chain. Can fetch it and verify it exists.

- [ ] **Step 6: Verify on-chain**

Query the auction account to check mode field:

```bash
solana account <AUCTION_PDA> --url devnet --keypair ~/.config/solana/id.json
```

Decode the account data (or use a script) to verify the `mode` byte is set to 1.

- [ ] **Step 7: Test bid submission (lifecycle)**

1. Open the newly created block-based auction detail page.
2. Submit a test bid (e.g., 100 units at max price 2.0).
3. Verify bid is accepted and recorded.

Expected: Bid submission works identically to time-based auctions.

- [ ] **Step 8: Commit final test results**

```bash
git add -A
git commit -m "test: end-to-end block-based auction PoC verification"
```

---

## Summary

This plan implements the block-based emission PoC in three phases:

1. **On-Chain Program (Tasks 1–9):** Add `mode` field to `Auction`, introduce `auction_now()` dispatch helper, update all 7 instruction files to use the helper.

2. **Backend (Tasks 10–13):** Create `init_tx_block.rs` module with slot-time conversion, register new route, create `auctions_block` table, add indexer support.

3. **Frontend (Tasks 14–18):** Add `buildInitBlockTx()` client function, add mode toggle UI, dispatch to correct endpoint, update preview, verify defaults (already done).

4. **Testing (Task 19):** Manual end-to-end test of both modes.

**Total estimated effort:** ~4-6 hours for a skilled engineer familiar with Rust, Solana, and the codebase. Tasks are ordered for maximum parallelization: all on-chain tasks (1–9) can run in parallel after each other, backend (10–13) depends on program deployment, frontend (14–18) is independent of backend.
