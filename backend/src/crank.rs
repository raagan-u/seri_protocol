//! Crank: periodically sends the `checkpoint` instruction for live auctions.
//!
//! For each live auction in the DB:
//!   1. Derive auction_steps PDA (["steps", auction])
//!   2. Pick the latest known checkpoint from DB as `latest_checkpoint`
//!   3. Derive new_checkpoint PDA (["checkpoint", auction, now_i64_le])
//!   4. Build + sign + send the instruction

use crate::rpc::RpcClient;
use solana_sdk::hash::Hash;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::sysvar;

const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);
use solana_sdk::transaction::Transaction;
use sqlx::PgPool;
use std::str::FromStr;
use std::time::Duration;
use tracing::{debug, error, info, warn};

const CHECKPOINT_DISCRIMINATOR: [u8; 8] = [213, 200, 19, 204, 240, 143, 184, 252];

pub struct CrankConfig {
    pub program_id: Pubkey,
    pub keypair: Keypair,
    pub interval: Duration,
    pub staleness_secs: i64,
}

pub async fn run(rpc: RpcClient, db: PgPool, cfg: CrankConfig) {
    info!(
        "crank started, signer={}, interval={:?}, staleness={}s",
        cfg.keypair.pubkey(),
        cfg.interval,
        cfg.staleness_secs
    );

    loop {
        if let Err(e) = tick(&rpc, &db, &cfg).await {
            error!("crank tick failed: {e:#}");
        }
        tokio::time::sleep(cfg.interval).await;
    }
}

async fn tick(rpc: &RpcClient, db: &PgPool, cfg: &CrankConfig) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp();
    let rows = sqlx::query_as::<_, (String, i64)>(
        r#"SELECT address, last_checkpointed_time
           FROM auctions
           WHERE graduated = FALSE
             AND start_time <= $1
             AND end_time > $1"#,
    )
    .bind(now)
    .fetch_all(db)
    .await?;

    for (auction_addr, last_cp) in rows {
        if now - last_cp < cfg.staleness_secs {
            continue;
        }

        match checkpoint_one(rpc, db, cfg, &auction_addr, now).await {
            Ok(sig) => info!("checkpointed auction {auction_addr} at {now}: {sig}"),
            Err(e) => warn!("checkpoint {auction_addr} failed: {e:#}"),
        }
    }
    Ok(())
}

async fn checkpoint_one(
    rpc: &RpcClient,
    db: &PgPool,
    cfg: &CrankConfig,
    auction_addr: &str,
    now: i64,
) -> anyhow::Result<String> {
    let auction = Pubkey::from_str(auction_addr)?;
    let program_id = cfg.program_id;

    let (auction_steps, _) = Pubkey::find_program_address(&[b"steps", auction.as_ref()], &program_id);

    let (new_checkpoint, _) = Pubkey::find_program_address(
        &[b"checkpoint", auction.as_ref(), &now.to_le_bytes()],
        &program_id,
    );

    // Pick latest known checkpoint for this auction.
    let latest_cp_addr: Option<String> = sqlx::query_scalar(
        "SELECT address FROM checkpoints WHERE auction = $1 ORDER BY timestamp DESC LIMIT 1",
    )
    .bind(auction_addr)
    .fetch_optional(db)
    .await?;
    let latest_checkpoint = match latest_cp_addr {
        Some(s) => Pubkey::from_str(&s)?,
        None => {
            anyhow::bail!("no latest checkpoint in DB yet for {auction_addr}");
        }
    };

    // Instruction data = 8B disc + borsh(CheckpointParams { now: i64 }).
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&CHECKPOINT_DISCRIMINATOR);
    data.extend_from_slice(&now.to_le_bytes());

    let ix = Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(cfg.keypair.pubkey(), true),      // payer
            AccountMeta::new(auction, false),                   // auction
            AccountMeta::new(latest_checkpoint, false),         // latest_checkpoint
            AccountMeta::new(new_checkpoint, false),            // new_checkpoint
            AccountMeta::new_readonly(auction_steps, false),    // auction_steps
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
        ],
        data,
    };

    let blockhash_str = rpc.get_latest_blockhash().await?;
    let blockhash = bs58_to_hash(&blockhash_str)?;

    let msg = Message::new(&[ix], Some(&cfg.keypair.pubkey()));
    let mut tx = Transaction::new_unsigned(msg);
    tx.sign(&[&cfg.keypair], blockhash);

    let bytes = bincode::serialize(&tx)?;
    let sig = rpc.send_transaction(&bytes).await?;
    debug!("new_checkpoint pda for now={now}: {}", new_checkpoint);
    Ok(sig)
}

fn bs58_to_hash(s: &str) -> anyhow::Result<Hash> {
    let bytes = bs58::decode(s).into_vec()?;
    if bytes.len() != 32 {
        anyhow::bail!("bad blockhash length");
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(Hash::new_from_array(arr))
}

/// Load a Solana CLI-format keypair (JSON array of 64 bytes).
pub fn load_keypair_from_file(path: &str) -> anyhow::Result<Keypair> {
    let raw = std::fs::read_to_string(path)?;
    let bytes: Vec<u8> = serde_json::from_str(&raw)?;
    if bytes.len() != 64 {
        anyhow::bail!("expected 64-byte keypair array, got {}", bytes.len());
    }
    let kp = Keypair::try_from(bytes.as_slice())?;
    Ok(kp)
}

