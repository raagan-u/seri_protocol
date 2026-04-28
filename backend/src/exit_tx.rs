//! Builds an unsigned exit transaction for the bidder to sign.
//!
//! Branches between:
//!   - `exit_bid` — bid was fully above clearing, fully below clearing, or auction
//!     didn't graduate (full refund / full fill cases).
//!   - `exit_partially_filled_bid` — bid landed exactly at clearing (end-of-auction)
//!     OR was outbid mid-auction (clearing rose above bid.max_price during auction).
//!
//! The branch is decided from indexed state: presence of any checkpoint where
//! `clearing_price > bid.max_price` after `bid.start_time` ⇒ outbid path; final
//! checkpoint clearing == bid.max_price ⇒ at-clearing path; else simple `exit_bid`.

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
pub struct BuildExitTxBody {
    pub bidder: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExitTxResponse {
    pub tx: String,
    /// "exit_bid" or "exit_partially_filled_bid" — for the frontend to decide
    /// what success message to show.
    pub flow: String,
}

pub async fn build_exit_tx(
    State(s): State<ApiState>,
    Path((auction_addr, bid_addr)): Path<(String, String)>,
    Json(body): Json<BuildExitTxBody>,
) -> Result<Json<BuildExitTxResponse>, (StatusCode, String)> {
    build_inner(&s, &auction_addr, &bid_addr, body)
        .await
        .map(Json)
        .map_err(|e| {
            tracing::warn!("build_exit_tx failed for {auction_addr}/{bid_addr}: {e:#}");
            (StatusCode::BAD_REQUEST, e.to_string())
        })
}

async fn build_inner(
    s: &ApiState,
    auction_addr: &str,
    bid_addr: &str,
    body: BuildExitTxBody,
) -> anyhow::Result<BuildExitTxResponse> {
    let rpc = RpcClient::new(crate::config::Config::from_env().rpc_url);
    let program_id: Pubkey = crate::config::Config::from_env().program_id.parse()?;

    let bidder = Pubkey::from_str(&body.bidder)?;
    let auction = Pubkey::from_str(auction_addr)?;
    let bid = Pubkey::from_str(bid_addr)?;

    // --- Auction + bid state ---
    let auction_row = sqlx::query(
        r#"SELECT currency_mint FROM auctions WHERE address = $1"#,
    )
    .bind(auction_addr)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("auction not found"))?;
    let currency_mint = Pubkey::from_str(&auction_row.get::<String, _>("currency_mint"))?;

    let bid_row = sqlx::query(
        r#"SELECT max_price, start_time, exited_time
           FROM bids WHERE address = $1 AND auction = $2"#,
    )
    .bind(bid_addr)
    .bind(auction_addr)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("bid not found"))?;

    let bid_max_price: u128 = bid_row.get::<String, _>("max_price").parse()?;
    let bid_start_time: i64 = bid_row.get("start_time");
    let bid_exited_time: i64 = bid_row.get("exited_time");
    anyhow::ensure!(bid_exited_time == 0, "bid already exited");

    let (currency_vault, _) =
        Pubkey::find_program_address(&[b"currency_vault", auction.as_ref()], &program_id);
    let bid_owner_currency_account = derive_ata(&bidder, &currency_mint);
    let token_program = token_program_id()?;
    let bid_max_price_str = bid_max_price.to_string();

    // --- start_checkpoint at bid.start_time (always required) ---
    let start_cp: String = sqlx::query_scalar(
        "SELECT address FROM checkpoints WHERE auction = $1 AND timestamp = $2",
    )
    .bind(auction_addr)
    .bind(bid_start_time)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("start_checkpoint not indexed"))?;
    let start_checkpoint = Pubkey::from_str(&start_cp)?;

    // --- Decide branch ---
    // Outbid case: exists a checkpoint after bid.start_time where clearing > max_price.
    let outbid_cp_row: Option<(String, i64)> = sqlx::query_as(
        r#"SELECT address, timestamp FROM checkpoints
           WHERE auction = $1
             AND timestamp >= $2
             AND CAST(clearing_price AS NUMERIC) > CAST($3 AS NUMERIC)
           ORDER BY timestamp ASC LIMIT 1"#,
    )
    .bind(auction_addr)
    .bind(bid_start_time)
    .bind(&bid_max_price_str)
    .fetch_optional(&s.db)
    .await?;

    if let Some((outbid_addr, outbid_ts)) = outbid_cp_row {
        return build_partial(
            &rpc,
            &s,
            &program_id,
            &auction,
            &bid,
            &bidder,
            &bid_owner_currency_account,
            &currency_vault,
            &currency_mint,
            &token_program,
            start_checkpoint,
            bid_max_price_str.clone(),
            bid_max_price,
            auction_addr,
            bid_start_time,
            Some((Pubkey::from_str(&outbid_addr)?, outbid_ts)),
        )
        .await;
    }

    // Final checkpoint
    let final_cp_row: (String, String) = sqlx::query_as(
        r#"SELECT address, clearing_price FROM checkpoints
           WHERE auction = $1
           ORDER BY timestamp DESC LIMIT 1"#,
    )
    .bind(auction_addr)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("no checkpoints indexed"))?;
    let final_clearing: u128 = final_cp_row.1.parse()?;
    let final_checkpoint = Pubkey::from_str(&final_cp_row.0)?;

    if final_clearing == bid_max_price {
        // End-of-auction at-clearing partial fill
        return build_partial(
            &rpc,
            &s,
            &program_id,
            &auction,
            &bid,
            &bidder,
            &bid_owner_currency_account,
            &currency_vault,
            &currency_mint,
            &token_program,
            start_checkpoint,
            bid_max_price_str,
            bid_max_price,
            auction_addr,
            bid_start_time,
            None,
        )
        .await;
    }

    // Simple exit_bid
    let data = ix_discriminator("exit_bid").to_vec();
    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(auction, false),
            AccountMeta::new(bid, false),
            AccountMeta::new_readonly(start_checkpoint, false),
            AccountMeta::new_readonly(final_checkpoint, false),
            AccountMeta::new(currency_vault, false),
            AccountMeta::new(bid_owner_currency_account, false),
            AccountMeta::new_readonly(token_program, false),
        ],
        data,
    };

    let create_ata_ix = create_ata_idempotent_ix(
        &bidder,
        &bid_owner_currency_account,
        &bidder,
        &currency_mint,
    )?;

    let blockhash_str = rpc.get_latest_blockhash().await?;
    let blockhash = bs58_to_hash(&blockhash_str)?;
    let msg = Message::new_with_blockhash(&[create_ata_ix, ix], Some(&bidder), &blockhash);
    let tx = Transaction::new_unsigned(msg);
    let bytes = bincode::serialize(&tx)?;

    Ok(BuildExitTxResponse {
        tx: base64::engine::general_purpose::STANDARD.encode(&bytes),
        flow: "exit_bid".into(),
    })
}

#[allow(clippy::too_many_arguments)]
async fn build_partial(
    rpc: &RpcClient,
    s: &ApiState,
    program_id: &Pubkey,
    auction: &Pubkey,
    bid: &Pubkey,
    bidder: &Pubkey,
    bid_owner_currency_account: &Pubkey,
    currency_vault: &Pubkey,
    currency_mint: &Pubkey,
    token_program: &Pubkey,
    start_checkpoint: Pubkey,
    bid_max_price_str: String,
    bid_max_price: u128,
    auction_addr: &str,
    bid_start_time: i64,
    outbid: Option<(Pubkey, i64)>,
) -> anyhow::Result<BuildExitTxResponse> {
    // last_fully_filled = last checkpoint with clearing < max_price after bid.start_time
    // For outbid case: must also be < outbid_timestamp
    // For end-of-auction case: any time after bid_start_time
    let last_ff_row: (String, i64) = if let Some((_, outbid_ts)) = outbid {
        sqlx::query_as(
            r#"SELECT address, timestamp FROM checkpoints
               WHERE auction = $1
                 AND timestamp >= $2
                 AND timestamp < $3
                 AND CAST(clearing_price AS NUMERIC) < CAST($4 AS NUMERIC)
               ORDER BY timestamp DESC LIMIT 1"#,
        )
        .bind(auction_addr)
        .bind(bid_start_time)
        .bind(outbid_ts)
        .bind(&bid_max_price_str)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no last_fully_filled_checkpoint found"))?
    } else {
        sqlx::query_as(
            r#"SELECT address, timestamp FROM checkpoints
               WHERE auction = $1
                 AND timestamp >= $2
                 AND CAST(clearing_price AS NUMERIC) < CAST($3 AS NUMERIC)
               ORDER BY timestamp DESC LIMIT 1"#,
        )
        .bind(auction_addr)
        .bind(bid_start_time)
        .bind(&bid_max_price_str)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no last_fully_filled_checkpoint found"))?
    };
    let last_ff_pda = Pubkey::from_str(&last_ff_row.0)?;
    let last_ff_ts = last_ff_row.1;

    // next_of_last_fully_filled = checkpoint immediately after last_ff
    let next_ff: String = sqlx::query_scalar(
        r#"SELECT address FROM checkpoints
           WHERE auction = $1 AND timestamp > $2
           ORDER BY timestamp ASC LIMIT 1"#,
    )
    .bind(auction_addr)
    .bind(last_ff_ts)
    .fetch_optional(&s.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("no next_of_last_fully_filled checkpoint"))?;
    let next_of_last_ff = Pubkey::from_str(&next_ff)?;

    // upper_checkpoint:
    //   outbid: prev of outbid_cp (last cp with clearing <= max_price before outbid)
    //   end-of-auction: final checkpoint (clearing == max_price)
    let (upper_pda, outbid_meta_pda) = if let Some((outbid_pda, outbid_ts)) = outbid {
        let prev: String = sqlx::query_scalar(
            r#"SELECT address FROM checkpoints
               WHERE auction = $1 AND timestamp < $2
               ORDER BY timestamp DESC LIMIT 1"#,
        )
        .bind(auction_addr)
        .bind(outbid_ts)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no upper_checkpoint before outbid"))?;
        (Pubkey::from_str(&prev)?, Some(outbid_pda))
    } else {
        let final_addr: String = sqlx::query_scalar(
            r#"SELECT address FROM checkpoints
               WHERE auction = $1 ORDER BY timestamp DESC LIMIT 1"#,
        )
        .bind(auction_addr)
        .fetch_one(&s.db)
        .await?;
        (Pubkey::from_str(&final_addr)?, None)
    };

    // tick at bid.max_price
    let (tick_pda, _) = Pubkey::find_program_address(
        &[b"tick", auction.as_ref(), &bid_max_price.to_le_bytes()],
        program_id,
    );

    let data = ix_discriminator("exit_partially_filled_bid").to_vec();

    let mut accounts = vec![
        AccountMeta::new(*auction, false),
        AccountMeta::new(*bid, false),
        AccountMeta::new_readonly(start_checkpoint, false),
        AccountMeta::new_readonly(last_ff_pda, false),
        AccountMeta::new_readonly(next_of_last_ff, false),
        AccountMeta::new_readonly(upper_pda, false),
    ];
    // Anchor `Option<Box<Account>>` accepts EITHER nothing or the account at this slot.
    // For Some, push the account. For None, push nothing — Anchor walks accounts in order
    // and detects the absence by reaching the next required account.
    if let Some(outbid_pda) = outbid_meta_pda {
        accounts.push(AccountMeta::new_readonly(outbid_pda, false));
    }
    accounts.extend([
        AccountMeta::new_readonly(tick_pda, false),
        AccountMeta::new(*currency_vault, false),
        AccountMeta::new(*bid_owner_currency_account, false),
        AccountMeta::new_readonly(*token_program, false),
    ]);

    let ix = Instruction { program_id: *program_id, accounts, data };

    let create_ata_ix =
        create_ata_idempotent_ix(bidder, bid_owner_currency_account, bidder, currency_mint)?;

    let blockhash_str = rpc.get_latest_blockhash().await?;
    let blockhash = bs58_to_hash(&blockhash_str)?;
    let msg = Message::new_with_blockhash(&[create_ata_ix, ix], Some(bidder), &blockhash);
    let tx = Transaction::new_unsigned(msg);
    let bytes = bincode::serialize(&tx)?;

    Ok(BuildExitTxResponse {
        tx: base64::engine::general_purpose::STANDARD.encode(&bytes),
        flow: "exit_partially_filled_bid".into(),
    })
}
