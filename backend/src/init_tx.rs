//! Builds an unsigned initialize_auction transaction for the creator's wallet to sign.

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

const INITIALIZE_AUCTION_DISCRIMINATOR: [u8; 8] = [66, 23, 27, 85, 188, 0, 109, 101];
const MPS_TOTAL: u64 = 10_000_000;
const MIN_TICK_SPACING: u64 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInitTxBody {
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
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
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
    start_time: i64,
    end_time: i64,
    claim_time: i64,
    tick_spacing: u64,
    floor_price: u128,
    required_currency_raised: u64,
    tokens_recipient: [u8; 32],
    funds_recipient: [u8; 32],
    steps: Vec<AuctionStepInput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInitTxResponse {
    pub tx: String,
    pub auction_pda: String,
    pub token_vault: String,
    pub currency_vault: String,
    pub creator_token_account: String,
}

pub async fn build_init_tx(
    Json(body): Json<BuildInitTxBody>,
) -> Result<Json<BuildInitTxResponse>, (StatusCode, String)> {
    build_inner(body).await.map(Json).map_err(|e| {
        tracing::warn!("build_init_tx failed: {e:#}");
        (StatusCode::BAD_REQUEST, e.to_string())
    })
}

async fn build_inner(body: BuildInitTxBody) -> anyhow::Result<BuildInitTxResponse> {
    let cfg = crate::config::Config::from_env();
    let rpc = RpcClient::new(cfg.rpc_url);
    let program_id: Pubkey = cfg.program_id.parse()?;

    let creator = Pubkey::from_str(&body.creator)?;
    let token_mint = Pubkey::from_str(&body.token_mint)?;
    let currency_mint = Pubkey::from_str(&body.currency_mint)?;
    let tokens_recipient = Pubkey::from_str(&body.params.tokens_recipient)?;
    let funds_recipient = Pubkey::from_str(&body.params.funds_recipient)?;

    let total_supply = decimal_to_u64_scaled(&body.params.total_supply, 0)?;
    let floor_price = decimal_to_q64(&body.params.floor_price)?;
    let required_currency_raised = decimal_to_u64_scaled(&body.params.required_currency_raised, 0)?;

    validate_params(
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
            &body.params.start_time.to_le_bytes(),
        ],
        &program_id,
    );

    let creator_token_account =
        pick_creator_token_account(&rpc, &creator, &token_mint, total_supply).await?;

    let params_data = InitializeAuctionParamsData {
        total_supply,
        start_time: body.params.start_time,
        end_time: body.params.end_time,
        claim_time: body.params.claim_time,
        tick_spacing: body.params.tick_spacing,
        floor_price,
        required_currency_raised,
        tokens_recipient: tokens_recipient.to_bytes(),
        funds_recipient: funds_recipient.to_bytes(),
        steps: body.params.steps,
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

    Ok(BuildInitTxResponse {
        tx: base64::engine::general_purpose::STANDARD.encode(&bytes),
        auction_pda: auction_pda.to_string(),
        token_vault: token_vault.to_string(),
        currency_vault: currency_vault.to_string(),
        creator_token_account: creator_token_account.to_string(),
    })
}

fn validate_params(
    params: &InitializeAuctionParamsInput,
    total_supply: u64,
    floor_price: u128,
    required_currency_raised: u64,
) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    anyhow::ensure!(params.start_time > now, "startTime must be in the future");
    anyhow::ensure!(
        params.end_time > params.start_time,
        "endTime must be after startTime"
    );
    anyhow::ensure!(
        params.claim_time >= params.end_time,
        "claimTime must be at or after endTime"
    );
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
    anyhow::ensure!(!params.steps.is_empty(), "steps must not be empty");

    let total_duration: u64 = params.steps.iter().map(|s| s.duration as u64).sum();
    anyhow::ensure!(
        total_duration as i64 == params.end_time - params.start_time,
        "steps must cover the full auction duration"
    );
    let total_weight: u64 = params
        .steps
        .iter()
        .map(|s| (s.mps as u64) * (s.duration as u64))
        .sum();
    anyhow::ensure!(
        total_weight == MPS_TOTAL,
        "steps must sum to {MPS_TOTAL} weighted milli-basis-points"
    );

    let max_bid_price = compute_max_bid_price(total_supply);
    anyhow::ensure!(
        floor_price
            .checked_add(params.tick_spacing as u128)
            .map(|p| p <= max_bid_price)
            .unwrap_or(false),
        "floorPrice + tickSpacing exceeds the max supported bid price for this supply"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_ata_when_balance_is_sufficient() {
        let preferred = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let selected = select_creator_token_account(
            vec![
                TokenAccountInfo {
                    pubkey: other.to_string(),
                    amount: 1_500,
                },
                TokenAccountInfo {
                    pubkey: preferred.to_string(),
                    amount: 1_000,
                },
            ],
            preferred,
            1_000,
        )
        .unwrap();
        assert_eq!(selected, preferred);
    }

    #[test]
    fn falls_back_to_largest_sufficient_balance() {
        let preferred = Pubkey::new_unique();
        let rich = Pubkey::new_unique();
        let selected = select_creator_token_account(
            vec![
                TokenAccountInfo {
                    pubkey: preferred.to_string(),
                    amount: 999,
                },
                TokenAccountInfo {
                    pubkey: rich.to_string(),
                    amount: 2_000,
                },
            ],
            preferred,
            1_000,
        )
        .unwrap();
        assert_eq!(selected, rich);
    }
}
