//! Polling indexer. Fetches Anchor accounts, upserts to Postgres, broadcasts changes.

use crate::accounts::{
    discriminator, pubkey_to_base58, strip_discriminator, AuctionAccount, BidAccount,
    CheckpointAccount,
};
use crate::rpc::RpcClient;
use crate::ws::{WsEvent, WsSender};
use borsh::BorshDeserialize;
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration;
use tracing::{debug, error, info, warn};

pub async fn run(
    rpc: RpcClient,
    db: PgPool,
    tx: WsSender,
    program_id: String,
    interval: Duration,
) {
    let auction_disc = discriminator("Auction");
    let bid_disc = discriminator("Bid");
    let checkpoint_disc = discriminator("Checkpoint");

    info!("indexer started, program={program_id}, interval={:?}", interval);

    loop {
        if let Err(e) = tick(
            &rpc,
            &db,
            &tx,
            &program_id,
            &auction_disc,
            &bid_disc,
            &checkpoint_disc,
        )
        .await
        {
            error!("indexer tick failed: {e:#}");
        }
        tokio::time::sleep(interval).await;
    }
}

async fn tick(
    rpc: &RpcClient,
    db: &PgPool,
    tx: &WsSender,
    program_id: &str,
    auction_disc: &[u8; 8],
    bid_disc: &[u8; 8],
    checkpoint_disc: &[u8; 8],
) -> anyhow::Result<()> {
    // --- Auctions ---
    let raw_auctions = rpc
        .get_program_accounts_with_disc(program_id, auction_disc)
        .await?;
    debug!("fetched {} auction accounts", raw_auctions.len());

    let mut prev_state: HashMap<String, (String, i64, bool)> = HashMap::new();
    for row in sqlx::query_as::<_, (String, String, i64, bool)>(
        "SELECT address, clearing_price, next_bid_id, graduated FROM auctions",
    )
    .fetch_all(db)
    .await?
    {
        prev_state.insert(row.0, (row.1, row.2, row.3));
    }

    for acc in &raw_auctions {
        let Some(body) = strip_discriminator(&acc.data, auction_disc) else { continue };
        let parsed = match AuctionAccount::try_from_slice(body) {
            Ok(a) => a,
            Err(e) => {
                warn!("failed to decode Auction {}: {e}", acc.pubkey);
                continue;
            }
        };
        let addr = acc.pubkey.clone();
        upsert_auction(db, &addr, &parsed).await?;

        let new_cp = parsed.clearing_price.to_string();
        let new_bid_id = parsed.next_bid_id as i64;
        let new_grad = parsed.graduated;

        if let Some((old_cp, old_bid_id, old_grad)) = prev_state.get(&addr) {
            if *old_cp != new_cp {
                let _ = tx.send(WsEvent::PriceUpdate {
                    auction: addr.clone(),
                    clearing_price: q64_to_decimal_string(parsed.clearing_price),
                    timestamp: chrono::Utc::now().timestamp(),
                });
            }
            if *old_bid_id != new_bid_id {
                let _ = tx.send(WsEvent::NewBid {
                    auction: addr.clone(),
                    bid_id: new_bid_id.saturating_sub(1),
                    bid_count: new_bid_id,
                });
            }
            if *old_grad != new_grad && new_grad {
                let _ = tx.send(WsEvent::StateChange {
                    auction: addr.clone(),
                    status: "graduated".into(),
                });
            }
        }
    }

    // --- Bids ---
    let raw_bids = rpc
        .get_program_accounts_with_disc(program_id, bid_disc)
        .await?;
    debug!("fetched {} bid accounts", raw_bids.len());
    for acc in &raw_bids {
        let Some(body) = strip_discriminator(&acc.data, bid_disc) else { continue };
        let parsed = match BidAccount::try_from_slice(body) {
            Ok(b) => b,
            Err(e) => {
                warn!("failed to decode Bid {}: {e}", acc.pubkey);
                continue;
            }
        };
        upsert_bid(db, &acc.pubkey, &parsed).await?;
    }

    // --- Checkpoints ---
    let raw_cps = rpc
        .get_program_accounts_with_disc(program_id, checkpoint_disc)
        .await?;
    debug!("fetched {} checkpoint accounts", raw_cps.len());

    let mut known_cp: std::collections::HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT address FROM checkpoints")
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();

    // Cache auction totals (for price_history denominators).
    let auctions_map: HashMap<String, (String, String)> = sqlx::query_as::<_, (String, String, String)>(
        "SELECT address, currency_raised_q64_x7, total_cleared_q64_x7 FROM auctions",
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(a, c, t)| (a, (c, t)))
    .collect();

    for acc in &raw_cps {
        let Some(body) = strip_discriminator(&acc.data, checkpoint_disc) else { continue };
        let parsed = match CheckpointAccount::try_from_slice(body) {
            Ok(c) => c,
            Err(e) => {
                warn!("failed to decode Checkpoint {}: {e}", acc.pubkey);
                continue;
            }
        };
        let is_new = !known_cp.remove(&acc.pubkey);
        upsert_checkpoint(db, &acc.pubkey, &parsed).await?;

        if is_new {
            let auction_pda = pubkey_to_base58(&parsed.auction);
            let (raised_q64, cleared_q64) = auctions_map
                .get(&auction_pda)
                .cloned()
                .unwrap_or_else(|| ("0".into(), "0".into()));

            // price_history row (strings for big ints).
            let _ = sqlx::query(
                r#"
                INSERT INTO price_history (auction, timestamp, clearing_price, currency_raised, total_cleared)
                VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT (auction, timestamp) DO NOTHING
                "#,
            )
            .bind(&auction_pda)
            .bind(parsed.timestamp)
            .bind(parsed.clearing_price.to_string())
            .bind(raised_q64.clone())
            .bind(cleared_q64.clone())
            .execute(db)
            .await;

            let raised_f = q64_x7_to_f64(&raised_q64);
            let total_supply: i64 = sqlx::query_scalar(
                "SELECT total_supply FROM auctions WHERE address = $1",
            )
            .bind(&auction_pda)
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
            .unwrap_or(0);
            let total_cleared = q64_x7_to_f64(&cleared_q64);
            let supply_pct = if total_supply > 0 {
                (total_cleared / total_supply as f64) * 100.0
            } else {
                0.0
            };

            let _ = tx.send(WsEvent::Checkpoint {
                auction: auction_pda,
                clearing_price: q64_to_decimal_string(parsed.clearing_price),
                currency_raised: format!("{:.2}", raised_f),
                supply_released_percent: supply_pct,
            });
        }
    }

    Ok(())
}

fn q64_x7_to_f64(x_str: &str) -> f64 {
    let x: u128 = x_str.parse().unwrap_or(0);
    let q64 = (x as f64) / (1u128 << 64) as f64;
    q64 / 1e7
}

async fn upsert_auction(db: &PgPool, address: &str, a: &AuctionAccount) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO auctions (
            address, token_mint, currency_mint, creator, total_supply,
            start_time, end_time, claim_time, floor_price, max_bid_price,
            required_currency_raised, tick_spacing, clearing_price,
            sum_currency_demand, next_bid_id, last_checkpointed_time,
            currency_raised_q64_x7, total_cleared_q64_x7, graduated, updated_at
        ) VALUES (
            $1,$2,$3,$4,$5,
            $6,$7,$8,$9,$10,
            $11,$12,$13,
            $14,$15,$16,
            $17,$18,$19, NOW()
        )
        ON CONFLICT (address) DO UPDATE SET
            total_supply = EXCLUDED.total_supply,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            claim_time = EXCLUDED.claim_time,
            floor_price = EXCLUDED.floor_price,
            max_bid_price = EXCLUDED.max_bid_price,
            required_currency_raised = EXCLUDED.required_currency_raised,
            tick_spacing = EXCLUDED.tick_spacing,
            clearing_price = EXCLUDED.clearing_price,
            sum_currency_demand = EXCLUDED.sum_currency_demand,
            next_bid_id = EXCLUDED.next_bid_id,
            last_checkpointed_time = EXCLUDED.last_checkpointed_time,
            currency_raised_q64_x7 = EXCLUDED.currency_raised_q64_x7,
            total_cleared_q64_x7 = EXCLUDED.total_cleared_q64_x7,
            graduated = EXCLUDED.graduated,
            updated_at = NOW()
        "#,
    )
    .bind(address)
    .bind(pubkey_to_base58(&a.token_mint))
    .bind(pubkey_to_base58(&a.currency_mint))
    .bind(pubkey_to_base58(&a.creator))
    .bind(a.total_supply as i64)
    .bind(a.start_time)
    .bind(a.end_time)
    .bind(a.claim_time)
    .bind(a.floor_price.to_string())
    .bind(a.max_bid_price.to_string())
    .bind(a.required_currency_raised as i64)
    .bind(a.tick_spacing as i64)
    .bind(a.clearing_price.to_string())
    .bind(a.sum_currency_demand_above_clearing.to_string())
    .bind(a.next_bid_id as i64)
    .bind(a.last_checkpointed_time)
    .bind(a.currency_raised_q64_x7.to_string())
    .bind(a.total_cleared_q64_x7.to_string())
    .bind(a.graduated)
    .execute(db)
    .await?;
    Ok(())
}

async fn upsert_bid(db: &PgPool, address: &str, b: &BidAccount) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO bids (
            address, auction, bid_id, owner, max_price, amount_q64,
            start_time, start_cumulative_mps, exited_time, tokens_filled, updated_at
        ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW()
        )
        ON CONFLICT (address) DO UPDATE SET
            max_price = EXCLUDED.max_price,
            amount_q64 = EXCLUDED.amount_q64,
            exited_time = EXCLUDED.exited_time,
            tokens_filled = EXCLUDED.tokens_filled,
            updated_at = NOW()
        "#,
    )
    .bind(address)
    .bind(pubkey_to_base58(&b.auction))
    .bind(b.bid_id as i64)
    .bind(pubkey_to_base58(&b.owner))
    .bind(b.max_price.to_string())
    .bind(b.amount_q64.to_string())
    .bind(b.start_time)
    .bind(b.start_cumulative_mps as i64)
    .bind(b.exited_time)
    .bind(b.tokens_filled as i64)
    .execute(db)
    .await?;
    Ok(())
}

async fn upsert_checkpoint(
    db: &PgPool,
    address: &str,
    c: &CheckpointAccount,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        INSERT INTO checkpoints (
            address, auction, timestamp, clearing_price, cumulative_mps,
            cumulative_mps_per_price, currency_raised_at_clearing_q64_x7
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (address) DO UPDATE SET
            clearing_price = EXCLUDED.clearing_price,
            cumulative_mps = EXCLUDED.cumulative_mps,
            cumulative_mps_per_price = EXCLUDED.cumulative_mps_per_price,
            currency_raised_at_clearing_q64_x7 = EXCLUDED.currency_raised_at_clearing_q64_x7
        "#,
    )
    .bind(address)
    .bind(pubkey_to_base58(&c.auction))
    .bind(c.timestamp)
    .bind(c.clearing_price.to_string())
    .bind(c.cumulative_mps as i64)
    .bind(c.cumulative_mps_per_price.to_string())
    .bind(c.currency_raised_at_clearing_price_q64_x7.to_string())
    .execute(db)
    .await?;
    Ok(())
}

/// Convert a Q64.64 fixed-point u128 to a decimal string with 6 digits of precision.
/// This is a lossy display helper — use the raw TEXT column for math.
pub fn q64_to_decimal_string(x: u128) -> String {
    let whole = x >> 64;
    let frac = x & ((1u128 << 64) - 1);
    // 6 decimal digits of fractional precision.
    let scale: u128 = 1_000_000;
    let frac_scaled = (frac as u128).saturating_mul(scale) >> 64;
    format!("{whole}.{:06}", frac_scaled)
}
