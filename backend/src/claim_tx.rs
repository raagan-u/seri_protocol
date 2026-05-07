//! Builds an unsigned `claim_tokens` transaction for the bidder to sign.
//!
//! Pre-requirements:
//!   - Auction graduated and `claim_time` reached.
//!   - Bid has been exited via `exit_bid` or `exit_partially_filled_bid`.
//!   - `bid.tokens_filled > 0`.

use crate::api::ApiState;
use crate::rpc::RpcClient;
use crate::tx_utils::{
    bs58_to_hash, create_ata_idempotent_ix, derive_ata, ix_discriminator, token_program_id,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::Transaction;
use sqlx::Row;
use std::str::FromStr;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildClaimTxBody {
    pub bidder: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildClaimTxResponse {
    pub tx: String,
}

pub async fn build_claim_tx(
    State(s): State<ApiState>,
    Path((auction_addr, bid_addr)): Path<(String, String)>,
    Json(body): Json<BuildClaimTxBody>,
) -> Result<Json<BuildClaimTxResponse>, (StatusCode, String)> {
    build_inner(&s, &auction_addr, &bid_addr, body)
        .await
        .map(Json)
        .map_err(|e| {
            tracing::warn!("build_claim_tx failed for {auction_addr}/{bid_addr}: {e:#}");
            (StatusCode::BAD_REQUEST, e.to_string())
        })
}

async fn build_inner(
    s: &ApiState,
    auction_addr: &str,
    bid_addr: &str,
    body: BuildClaimTxBody,
) -> anyhow::Result<BuildClaimTxResponse> {
    let rpc = RpcClient::new(crate::config::Config::from_env().rpc_url);
    let program_id: Pubkey = crate::config::Config::from_env().program_id.parse()?;

    let bidder = Pubkey::from_str(&body.bidder)?;
    let auction = Pubkey::from_str(auction_addr)?;
    let bid = Pubkey::from_str(bid_addr)?;

    let row = sqlx::query(
        "SELECT token_mint, claim_time, graduated, mode FROM auctions WHERE address = $1",
    )
    .bind(auction_addr)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("auction not found"))?;
    let token_mint = Pubkey::from_str(&row.get::<String, _>("token_mint"))?;
    let claim_time: i64 = row.get("claim_time");
    let mode: i16 = row.get("mode");
    let graduated: bool = row.get("graduated");

    let bid_row = sqlx::query(
        "SELECT exited_time, tokens_filled FROM bids WHERE address = $1 AND auction = $2",
    )
    .bind(bid_addr)
    .bind(auction_addr)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("bid not found"))?;
    let exited_time: i64 = bid_row.get("exited_time");
    let tokens_filled: i64 = bid_row.get("tokens_filled");

    let now: i64 = if mode == 1 {
        rpc.get_slot().await?.try_into()?
    } else {
        chrono::Utc::now().timestamp()
    };
    anyhow::ensure!(graduated, "auction did not graduate — nothing to claim");
    anyhow::ensure!(
        now >= claim_time,
        "claim window not open yet (opens at {} {})",
        claim_time,
        if mode == 1 { "slot" } else { "unix" }
    );
    anyhow::ensure!(exited_time != 0, "bid not exited yet — call exit first");
    anyhow::ensure!(tokens_filled > 0, "bid filled 0 tokens — nothing to claim");

    let (token_vault, _) =
        Pubkey::find_program_address(&[b"token_vault", auction.as_ref()], &program_id);
    let bid_owner_token_account = derive_ata(&bidder, &token_mint);

    let data = ix_discriminator("claim_tokens").to_vec();
    let token_program = token_program_id()?;

    let claim_ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(auction, false),
            AccountMeta::new(bid, false),
            AccountMeta::new(token_vault, false),
            AccountMeta::new(bid_owner_token_account, false),
            AccountMeta::new_readonly(token_program, false),
        ],
        data,
    };

    let create_ata_ix =
        create_ata_idempotent_ix(&bidder, &bid_owner_token_account, &bidder, &token_mint)?;

    let blockhash_str = rpc.get_latest_blockhash().await?;
    let blockhash = bs58_to_hash(&blockhash_str)?;
    let msg = Message::new_with_blockhash(&[create_ata_ix, claim_ix], Some(&bidder), &blockhash);
    let tx = Transaction::new_unsigned(msg);
    let bytes = bincode::serialize(&tx)?;

    Ok(BuildClaimTxResponse {
        tx: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}
