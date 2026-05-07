//! Builds an unsigned submit_bid transaction for a bidder's wallet to sign.
//!
//! The backend derives PDAs, finds the correct prev_tick and latest_checkpoint,
//! then returns a base64-encoded legacy Transaction for the frontend to
//! sign+send via Phantom.

use crate::accounts::{discriminator, pubkey_to_base58, strip_discriminator, AuctionAccount, TickAccount};
use crate::api::ApiState;
use crate::eviction::{load_ticks, plan_eviction};
use crate::rpc::RpcClient;
use crate::tx_utils::{
    bs58_to_hash, create_ata_idempotent_ix, decimal_to_q64, decimal_to_u64_scaled, derive_ata,
    system_program_id, token_program_id,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use base64::Engine;
use borsh::BorshDeserialize;
use serde::{Deserialize, Serialize};
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::sysvar;
use solana_sdk::transaction::Transaction;
use sqlx::Row;
use std::str::FromStr;

const SUBMIT_BID_DISCRIMINATOR: [u8; 8] = [19, 164, 237, 254, 64, 139, 237, 93];
const USDC_DECIMALS: u32 = 6;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildBidTxBody {
    pub bidder: String,
    /// Human-readable decimal price string, e.g. "0.42".
    pub max_price: String,
    /// Human-readable USDC amount (e.g. "1000"), not yet scaled by mint decimals.
    pub amount: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildBidTxResponse {
    /// Base64-encoded unsigned legacy Transaction ready for Phantom to sign+send.
    pub tx: String,
    pub bid_pda: String,
    pub now: i64,
}

pub async fn build_bid_tx(
    State(s): State<ApiState>,
    Path(auction_addr): Path<String>,
    Json(body): Json<BuildBidTxBody>,
) -> Result<Json<BuildBidTxResponse>, (StatusCode, String)> {
    build_inner(&s, &auction_addr, body)
        .await
        .map(Json)
        .map_err(|e| {
            tracing::warn!("build_bid_tx failed for {auction_addr}: {e:#}");
            (StatusCode::BAD_REQUEST, e.to_string())
        })
}

async fn build_inner(
    s: &ApiState,
    auction_addr: &str,
    body: BuildBidTxBody,
) -> anyhow::Result<BuildBidTxResponse> {
    let rpc = RpcClient::new(crate::config::Config::from_env().rpc_url);
    let program_id: Pubkey = crate::config::Config::from_env().program_id.parse()?;

    let bidder = Pubkey::from_str(&body.bidder)?;
    let auction = Pubkey::from_str(auction_addr)?;

    let max_price = decimal_to_q64(&body.max_price)?;
    let amount_raw = decimal_to_u64_scaled(&body.amount, USDC_DECIMALS)?;
    anyhow::ensure!(amount_raw > 0, "amount must be > 0");

    // --- Load auction from DB ---
    let row = sqlx::query(
        r#"SELECT token_mint, currency_mint, creator, clearing_price, floor_price,
                  max_bid_price, tick_spacing, next_bid_id,
                  sum_currency_demand, next_active_tick_price, total_supply,
                  token_decimals, currency_decimals, mode
           FROM auctions WHERE address = $1"#,
    )
    .bind(auction_addr)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("auction not found"))?;

    let clearing_price: u128 = row.get::<String, _>("clearing_price").parse()?;
    let floor_price: u128 = row.get::<String, _>("floor_price").parse()?;
    let max_bid_price: u128 = row.get::<String, _>("max_bid_price").parse()?;
    let tick_spacing: u128 = row.get::<i64, _>("tick_spacing") as u128;
    let next_bid_id: u64 = row.get::<i64, _>("next_bid_id") as u64;
    let currency_mint = Pubkey::from_str(&row.get::<String, _>("currency_mint"))?;
    let sum_currency_demand: u128 = row.get::<String, _>("sum_currency_demand").parse()?;
    let next_active_tick_price: u128 = row.get::<String, _>("next_active_tick_price").parse()?;
    let total_supply: u64 = row.get::<i64, _>("total_supply") as u64;
    let token_decimals: u8 = row.get::<i16, _>("token_decimals") as u8;
    let mode: i16 = row.get("mode");
    let currency_decimals: u8 = row.get::<i16, _>("currency_decimals") as u8;

    // --- Validate bid params mirror the on-chain checks (early fail) ---
    anyhow::ensure!(
        max_price > clearing_price,
        "max_price must be strictly greater than clearing_price"
    );
    anyhow::ensure!(
        max_price <= max_bid_price,
        "max_price exceeds max_bid_price"
    );
    anyhow::ensure!(
        max_price == floor_price || (tick_spacing > 0 && max_price % tick_spacing == 0),
        "max_price does not align to tick_spacing"
    );

    // --- Derive PDAs ---
    let (bid_pda, _) = Pubkey::find_program_address(
        &[b"bid", auction.as_ref(), &next_bid_id.to_le_bytes()],
        &program_id,
    );
    let (tick_pda, _) = Pubkey::find_program_address(
        &[b"tick", auction.as_ref(), &max_price.to_le_bytes()],
        &program_id,
    );
    let (auction_steps_pda, _) =
        Pubkey::find_program_address(&[b"steps", auction.as_ref()], &program_id);
    let currency_vault = derive_currency_vault(&auction, &program_id);
    let bidder_currency_ata = derive_ata(&bidder, &currency_mint);

    // --- Find prev_tick: existing tick with largest price < max_price ---
    let tick_disc = discriminator("Tick");
    let all_ticks = rpc
        .get_program_accounts_with_disc(&program_id.to_string(), &tick_disc)
        .await?;
    let mut best: Option<(u128, Pubkey)> = None;
    for acc in &all_ticks {
        let Some(body) = strip_discriminator(&acc.data, &tick_disc) else {
            continue;
        };
        let Ok(parsed) = TickAccount::try_from_slice(body) else {
            continue;
        };
        if pubkey_to_base58(&parsed.auction) != auction_addr {
            continue;
        }
        if parsed.price < max_price {
            if best
                .as_ref()
                .map(|(p, _)| parsed.price > *p)
                .unwrap_or(true)
            {
                best = Some((parsed.price, Pubkey::from_str(&acc.pubkey)?));
            }
        }
    }
    let (prev_tick_price, prev_tick_pda) =
        best.ok_or_else(|| anyhow::anyhow!("no prev_tick found; auction not initialized?"))?;

    // Derive latest_checkpoint from on-chain auction state. The DB-indexed view
    // can lag the chain (e.g., a crank tx between the indexer poll and this
    // build), and the on-chain submit_bid enforces
    // `latest_checkpoint.next_timestamp == MAX_TIMESTAMP` — a stale "latest" cp
    // whose successor was just written triggers ConstraintRaw (0x7d3).
    let raw = rpc
        .get_account(auction_addr)
        .await?
        .ok_or_else(|| anyhow::anyhow!("auction account not found on-chain"))?;
    anyhow::ensure!(raw.len() > 8, "auction account data too short");
    let auction_acc: AuctionAccount = borsh::from_slice(&raw[8..])?;
    let onchain_last_checkpointed_time = auction_acc.last_checkpointed_time;
    let (latest_checkpoint, _) = Pubkey::find_program_address(
        &[
            b"checkpoint",
            auction.as_ref(),
            &onchain_last_checkpointed_time.to_le_bytes(),
        ],
        &program_id,
    );
    // `now` must match the program's `auction_now()` semantics: unix
    // timestamp in time mode, slot number in block mode.
    let mut now: i64 = if mode == 1 {
        rpc.get_slot().await?.try_into()?
    } else {
        chrono::Utc::now().timestamp()
    };
    if now <= onchain_last_checkpointed_time {
        now = onchain_last_checkpointed_time + 1;
    }
    let (new_checkpoint_pda, _) = Pubkey::find_program_address(
        &[b"checkpoint", auction.as_ref(), &now.to_le_bytes()],
        &program_id,
    );

    // --- Instruction data: 8B disc + borsh SubmitBidParams ---
    let mut data = Vec::with_capacity(8 + 16 + 8 + 16 + 8);
    data.extend_from_slice(&SUBMIT_BID_DISCRIMINATOR);
    data.extend_from_slice(&max_price.to_le_bytes());
    data.extend_from_slice(&amount_raw.to_le_bytes());
    data.extend_from_slice(&prev_tick_price.to_le_bytes());
    data.extend_from_slice(&now.to_le_bytes());

    let token_program = token_program_id()?;
    let system_program = system_program_id();

    // --- Eviction queue + clearing tick for the embedded checkpoint_at_time call ---
    let ticks = load_ticks(&s.db, auction_addr).await?;
    let plan = plan_eviction(
        &program_id,
        &auction,
        &ticks,
        sum_currency_demand,
        next_active_tick_price,
        clearing_price,
        total_supply,
        token_decimals,
        currency_decimals,
    );

    let mut accounts = vec![
        AccountMeta::new(bidder, true),         // bidder (signer, writable)
        AccountMeta::new(auction, false),       // auction
        AccountMeta::new(bid_pda, false),       // bid
        AccountMeta::new(tick_pda, false),      // tick
        AccountMeta::new(prev_tick_pda, false), // prev_tick
        AccountMeta::new(latest_checkpoint, false), // latest_checkpoint
        AccountMeta::new(new_checkpoint_pda, false), // new_checkpoint
        AccountMeta::new_readonly(auction_steps_pda, false),
        AccountMeta::new(bidder_currency_ata, false), // bidder_currency_account
        AccountMeta::new(currency_vault, false),      // currency_vault
        AccountMeta::new_readonly(token_program, false),
        AccountMeta::new_readonly(system_program, false),
        AccountMeta::new_readonly(sysvar::rent::id(), false),
    ];
    for pda in plan.into_account_metas() {
        accounts.push(AccountMeta::new_readonly(pda, false));
    }

    let submit_bid_ix = Instruction { program_id, accounts, data };

    // Prepend create-ATA (idempotent) so a fresh bidder doesn't need to fund
    // their currency ATA up front. If the ATA exists, the instruction is a
    // no-op.
    let create_ata_ix =
        create_ata_idempotent_ix(&bidder, &bidder_currency_ata, &bidder, &currency_mint)?;

    let blockhash_str = rpc.get_latest_blockhash().await?;
    let blockhash = bs58_to_hash(&blockhash_str)?;
    let msg =
        Message::new_with_blockhash(&[create_ata_ix, submit_bid_ix], Some(&bidder), &blockhash);
    let tx = Transaction::new_unsigned(msg);
    let bytes = bincode::serialize(&tx)?;

    Ok(BuildBidTxResponse {
        tx: base64::engine::general_purpose::STANDARD.encode(&bytes),
        bid_pda: bid_pda.to_string(),
        now,
    })
}

fn derive_currency_vault(auction: &Pubkey, program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"currency_vault", auction.as_ref()], program_id).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u64_scaled_basic() {
        assert_eq!(decimal_to_u64_scaled("1000", 6).unwrap(), 1_000_000_000);
        assert_eq!(decimal_to_u64_scaled("1.5", 6).unwrap(), 1_500_000);
        assert_eq!(decimal_to_u64_scaled("0.000001", 6).unwrap(), 1);
    }
}
