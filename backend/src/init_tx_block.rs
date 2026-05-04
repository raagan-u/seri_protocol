//! Builds an unsigned initialize_auction transaction for BLOCK-BASED auctions.
//!
//! User picks start/end/claim as Unix timestamps. We convert via a fixed
//! 0.4s/slot constant to slot offsets, fetch current slot, and submit the
//! initialize_auction ix with mode=1 and `start_time`/`end_time`/`claim_time`
//! holding slot numbers (not timestamps).

use crate::rpc::{RpcClient, TokenAccountInfo};
use crate::tx_utils::{
    bs58_to_hash, decimal_to_q64, decimal_to_u64_scaled, derive_ata, system_program_id,
    token_program_id,
};
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
const MODE_BLOCK: u8 = 1;

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
    /// Unix timestamp the user picked. Backend converts to slot.
    pub start_time: i64,
    /// Unix timestamp the user picked. Backend converts to slot.
    pub end_time: i64,
    /// Unix timestamp the user picked. Backend converts to slot.
    pub claim_time: i64,
    pub tick_spacing: u64,
    pub floor_price: String,
    pub required_currency_raised: String,
    pub tokens_recipient: String,
    pub funds_recipient: String,
    /// Steps from the frontend are in seconds. We rebuild them in slot space.
    #[serde(default)]
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
    start_time: i64,
    end_time: i64,
    claim_time: i64,
    tick_spacing: u64,
    floor_price: u128,
    required_currency_raised: u64,
    tokens_recipient: [u8; 32],
    funds_recipient: [u8; 32],
    steps: Vec<AuctionStepInput>,
    mode: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInitBlockTxResponse {
    pub tx: String,
    pub auction_pda: String,
    pub token_vault: String,
    pub currency_vault: String,
    pub creator_token_account: String,
    pub start_slot: i64,
    pub end_slot: i64,
    pub claim_slot: i64,
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

    let token_decimals = fetch_mint_decimals(&rpc, &token_mint).await?;
    let currency_decimals = fetch_mint_decimals(&rpc, &currency_mint).await?;

    let total_supply =
        decimal_to_u64_scaled(&body.params.total_supply, token_decimals as u32)?;
    let floor_price = decimal_to_q64(&body.params.floor_price)?;
    let required_currency_raised = decimal_to_u64_scaled(
        &body.params.required_currency_raised,
        currency_decimals as u32,
    )?;

    // --- Convert wall-clock times to slot numbers ---
    let now_secs = chrono::Utc::now().timestamp();
    let current_slot: i64 = rpc.get_slot().await?.try_into()?;

    let secs_to_start = (body.params.start_time - now_secs) as f64;
    let secs_total = (body.params.end_time - body.params.start_time) as f64;
    let secs_to_claim = (body.params.claim_time - body.params.end_time) as f64;
    anyhow::ensure!(secs_total > 0.0, "endTime must be after startTime");
    anyhow::ensure!(secs_to_claim >= 0.0, "claimTime must be >= endTime");

    let slot_offset_to_start = (secs_to_start / SLOT_DURATION_SECS).floor() as i64;
    let total_slots = (secs_total / SLOT_DURATION_SECS).floor() as i64;
    let claim_slot_offset = (secs_to_claim / SLOT_DURATION_SECS).floor() as i64;

    let start_slot = current_slot + slot_offset_to_start;
    let end_slot = start_slot + total_slots;
    let claim_slot = end_slot + claim_slot_offset;

    anyhow::ensure!(start_slot > current_slot, "startTime must be in the future");
    anyhow::ensure!(total_slots > 0, "auction duration must be > 0 slots");

    // --- Build slot-based steps from preset ---
    let preset = body.preset.as_deref().unwrap_or("flat");
    let steps = build_block_steps_for_preset(preset, total_slots as u64)?;
    anyhow::ensure!(!steps.is_empty(), "could not build steps from duration");

    // Sanity: steps must sum to total_slots and weights to MPS_TOTAL.
    let dur_sum: u64 = steps.iter().map(|s| s.duration as u64).sum();
    anyhow::ensure!(
        dur_sum as i64 == total_slots,
        "internal: step durations {dur_sum} != total_slots {total_slots}"
    );
    let weight_sum: u64 = steps.iter().map(|s| (s.mps as u64) * (s.duration as u64)).sum();
    anyhow::ensure!(
        weight_sum == MPS_TOTAL,
        "internal: step weights {weight_sum} != MPS_TOTAL"
    );

    validate_block_params(
        &body.params,
        total_supply,
        floor_price,
        required_currency_raised,
    )?;

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
        mode: MODE_BLOCK,
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
        start_slot,
        end_slot,
        claim_slot,
    })
}

// ---- step builders (slot-based) -------------------------------------------

fn build_block_steps_for_preset(
    preset: &str,
    total_slots: u64,
) -> anyhow::Result<Vec<AuctionStepInput>> {
    if total_slots == 0 {
        return Ok(vec![]);
    }
    let steps = match preset {
        "flat" => exact_block_steps(MPS_TOTAL, total_slots),
        "frontloaded" => build_block_phases(total_slots, &[0.7, 0.3]),
        "backloaded" => build_block_phases(total_slots, &[0.3, 0.7]),
        "linear-decay" => build_block_phases(total_slots, &[0.4, 0.3, 0.2, 0.1]),
        _ => anyhow::bail!("unknown preset {preset}"),
    };
    Ok(steps)
}

fn exact_block_steps(weight: u64, duration: u64) -> Vec<AuctionStepInput> {
    if duration == 0 || weight == 0 {
        return vec![];
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
    out
}

fn build_block_phases(total_slots: u64, weight_fractions: &[f64]) -> Vec<AuctionStepInput> {
    let n = weight_fractions.len();
    let base_dur = total_slots / n as u64;
    let mut durations = vec![base_dur; n];
    durations[n - 1] = total_slots - base_dur * (n as u64 - 1);

    let ideal: Vec<f64> = weight_fractions.iter().map(|f| f * MPS_TOTAL as f64).collect();
    let mut weights: Vec<u64> = ideal.iter().map(|w| w.floor() as u64).collect();
    let deficit = MPS_TOTAL - weights.iter().sum::<u64>();

    let mut order: Vec<(usize, f64)> = ideal
        .iter()
        .enumerate()
        .map(|(i, w)| (i, w - w.floor()))
        .collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    for j in 0..deficit as usize {
        weights[order[j % n].0] += 1;
    }

    let mut out = vec![];
    for i in 0..n {
        out.extend(exact_block_steps(weights[i], durations[i]));
    }
    out
}

// ---- validation -----------------------------------------------------------

fn validate_block_params(
    params: &InitializeAuctionParamsInput,
    total_supply: u64,
    floor_price: u128,
    required_currency_raised: u64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        params.tick_spacing >= MIN_TICK_SPACING,
        "tickSpacing must be at least {MIN_TICK_SPACING}"
    );
    anyhow::ensure!(floor_price > 0, "floorPrice must be > 0");
    anyhow::ensure!(total_supply > 0, "totalSupply must be > 0");
    anyhow::ensure!(
        required_currency_raised > 0,
        "requiredCurrencyRaised must be > 0"
    );

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

// ---- rpc helpers (mirrored from init_tx.rs) -------------------------------

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
