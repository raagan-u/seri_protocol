//! REST API. Returns frontend-ready JSON (camelCase, human-readable values).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

use crate::indexer::q64_to_decimal_string;

#[derive(Clone)]
pub struct ApiState {
    pub db: PgPool,
}

// --- shared helpers ---

fn q64_to_f64(x_str: &str) -> f64 {
    let x: u128 = x_str.parse().unwrap_or(0);
    (x as f64) / (1u128 << 64) as f64
}

fn pow10(d: i16) -> f64 {
    10f64.powi(d.max(0) as i32)
}

/// `amount_q64` (a bid's `(amount_raw_bu << 64)`) → human currency units.
fn amount_q64_to_human(x_str: &str, currency_decimals: i16) -> f64 {
    q64_to_f64(x_str) / pow10(currency_decimals)
}

/// Currency-side accumulator (`currency_raised_q64_x7`) → human currency units.
/// Same divisor applies to `total_cleared_q64_x7` because after the Option-B
/// clearing-price fix, both end up scaled by 10^currency_decimals when decoded.
fn q64_x7_to_human_currency(x_str: &str, currency_decimals: i16) -> f64 {
    q64_to_f64(x_str) / 1e7 / pow10(currency_decimals)
}

fn compute_status(
    graduated: bool,
    start_time: i64,
    end_time: i64,
    claim_time: i64,
    currency_raised: f64,
    required: f64,
) -> &'static str {
    let now = chrono::Utc::now().timestamp();
    if graduated {
        return "graduated";
    }
    if now < start_time {
        return "upcoming";
    }
    if now < end_time {
        return "live";
    }
    if currency_raised >= required {
        if now < claim_time {
            "ended"
        } else {
            "claimable"
        }
    } else {
        "failed"
    }
}

// --- Auction ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuctionDto {
    address: String,
    token_mint: String,
    token_name: String,
    token_symbol: String,
    token_tagline: Option<String>,
    token_icon_url: Option<String>,
    token_description: Option<String>,
    creator: String,
    creator_wallet: String,

    status: String,

    clearing_price: String,
    floor_price: String,
    max_bid_price: String,
    tick_spacing: String,

    currency: String,
    currency_raised: String,
    required_currency_raised: String,
    progress_percent: f64,

    total_supply: i64,
    total_cleared: i64,
    supply_released_percent: f64,

    bid_count: i64,
    active_bidders: i64,

    start_time: i64,
    end_time: i64,
    claim_time: i64,
    time_remaining: Option<i64>,
}

pub async fn get_auction(
    State(s): State<ApiState>,
    Path(address): Path<String>,
) -> Result<Json<AuctionDto>, StatusCode> {
    let row = sqlx::query(
        r#"
        SELECT address, token_mint, currency_mint, token_decimals, currency_decimals,
               creator, total_supply,
               start_time, end_time, claim_time, floor_price, max_bid_price,
               required_currency_raised, tick_spacing, clearing_price,
               next_bid_id, currency_raised_q64_x7, total_cleared_q64_x7,
               graduated, token_name, token_symbol, token_tagline,
               token_icon_url, description
        FROM auctions WHERE address = $1
        "#,
    )
    .bind(&address)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?
    .ok_or(StatusCode::NOT_FOUND)?;

    let active_bidders: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT owner) FROM bids WHERE auction = $1 AND exited_time = 0",
    )
    .bind(&address)
    .fetch_one(&s.db)
    .await
    .map_err(internal)?;

    let floor_price_raw: String = row.get("floor_price");
    let max_bid_price_raw: String = row.get("max_bid_price");
    let clearing_price_raw: String = row.get("clearing_price");
    let currency_raised_q64_x7: String = row.get("currency_raised_q64_x7");
    let total_cleared_q64_x7: String = row.get("total_cleared_q64_x7");
    let required_raw: i64 = row.get("required_currency_raised");
    let total_supply_raw: i64 = row.get("total_supply");
    let token_decimals: i16 = row.get("token_decimals");
    let currency_decimals: i16 = row.get("currency_decimals");
    let start_time: i64 = row.get("start_time");
    let end_time: i64 = row.get("end_time");
    let claim_time: i64 = row.get("claim_time");
    let graduated: bool = row.get("graduated");

    let currency_raised = q64_x7_to_human_currency(&currency_raised_q64_x7, currency_decimals);
    let total_cleared = q64_x7_to_human_currency(&total_cleared_q64_x7, currency_decimals);
    let required = (required_raw as f64) / pow10(currency_decimals);
    let total_supply_human = (total_supply_raw as f64) / pow10(token_decimals);

    let status = compute_status(
        graduated,
        start_time,
        end_time,
        claim_time,
        currency_raised,
        required,
    );

    let now = chrono::Utc::now().timestamp();
    let time_remaining = if now < end_time { Some(end_time - now) } else { None };

    let progress_percent = if required > 0.0 {
        (currency_raised / required) * 100.0
    } else {
        0.0
    };
    let supply_released_percent = if total_supply_human > 0.0 {
        (total_cleared / total_supply_human) * 100.0
    } else {
        0.0
    };

    let dto = AuctionDto {
        address: row.get("address"),
        token_mint: row.get("token_mint"),
        token_name: row
            .get::<Option<String>, _>("token_name")
            .unwrap_or_else(|| "Token".into()),
        token_symbol: row
            .get::<Option<String>, _>("token_symbol")
            .unwrap_or_else(|| "TKN".into()),
        token_tagline: row.get("token_tagline"),
        token_icon_url: row.get("token_icon_url"),
        token_description: row.get("description"),
        creator: row.get("creator"),
        creator_wallet: row.get("creator"),

        status: status.to_string(),

        clearing_price: q64_to_decimal_string(clearing_price_raw.parse().unwrap_or(0)),
        floor_price: q64_to_decimal_string(floor_price_raw.parse().unwrap_or(0)),
        max_bid_price: q64_to_decimal_string(max_bid_price_raw.parse().unwrap_or(0)),
        tick_spacing: row.get::<i64, _>("tick_spacing").to_string(),

        currency: "USDC".into(),
        currency_raised: format!("{:.2}", currency_raised),
        required_currency_raised: format!("{:.2}", required),
        progress_percent,

        total_supply: total_supply_human as i64,
        total_cleared: total_cleared as i64,
        supply_released_percent,

        bid_count: row.get("next_bid_id"),
        active_bidders,

        start_time,
        end_time,
        claim_time,
        time_remaining,
    };
    Ok(Json(dto))
}

// --- Price history ---

#[derive(Serialize)]
pub struct PricePointDto {
    t: i64,
    price: f64,
    timestamp: i64,
}

pub async fn get_price_history(
    State(s): State<ApiState>,
    Path(address): Path<String>,
) -> Result<Json<Vec<PricePointDto>>, StatusCode> {
    let rows = sqlx::query(
        "SELECT timestamp, clearing_price FROM checkpoints WHERE auction = $1 ORDER BY timestamp ASC",
    )
    .bind(&address)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let out = rows
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let ts: i64 = r.get("timestamp");
            let cp: String = r.get("clearing_price");
            PricePointDto {
                t: i as i64,
                price: q64_to_f64(&cp),
                timestamp: ts,
            }
        })
        .collect();
    Ok(Json(out))
}

// --- Bid book ---

#[derive(Serialize)]
pub struct BidBookRowDto {
    price: f64,
    demand: f64,
    bids: i64,
    #[serde(rename = "isClearing")]
    is_clearing: bool,
}

pub async fn get_bid_book(
    State(s): State<ApiState>,
    Path(address): Path<String>,
) -> Result<Json<Vec<BidBookRowDto>>, StatusCode> {
    let auction_row = sqlx::query(
        "SELECT clearing_price, currency_decimals FROM auctions WHERE address = $1",
    )
    .bind(&address)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;
    let (clearing_f, currency_decimals) = match auction_row {
        Some(r) => (
            q64_to_f64(r.get::<String, _>("clearing_price").as_str()),
            r.get::<i16, _>("currency_decimals"),
        ),
        None => (0.0, 0),
    };

    let rows = sqlx::query(
        "SELECT max_price, amount_q64 FROM bids WHERE auction = $1 AND exited_time = 0",
    )
    .bind(&address)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    // Group bids by price, sum amounts, count.
    use std::collections::BTreeMap;
    let mut agg: BTreeMap<u64, (f64, i64)> = BTreeMap::new(); // key = price * 1e6 for ordering
    for r in rows {
        let mp: String = r.get("max_price");
        let amt: String = r.get("amount_q64");
        let price = q64_to_f64(&mp);
        let amount = amount_q64_to_human(&amt, currency_decimals);
        let key = (price * 1_000_000.0) as u64;
        let entry = agg.entry(key).or_insert((0.0, 0));
        entry.0 += amount;
        entry.1 += 1;
    }

    // Descending price, cumulative demand.
    let mut ordered: Vec<(f64, f64, i64)> = agg
        .into_iter()
        .map(|(k, v)| (k as f64 / 1_000_000.0, v.0, v.1))
        .collect();
    ordered.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut cum = 0.0f64;
    let out: Vec<BidBookRowDto> = ordered
        .into_iter()
        .map(|(price, amt, n)| {
            cum += amt;
            BidBookRowDto {
                price,
                demand: cum,
                bids: n,
                is_clearing: (price - clearing_f).abs() < 1e-9,
            }
        })
        .collect();
    Ok(Json(out))
}

// --- User bids ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BidDto {
    address: String,
    auction: String,
    bid_id: i64,
    max_price: String,
    amount: String,
    status: String,
    estimated_tokens: i64,
    estimated_refund: String,
    start_time: i64,
    exited_time: i64,
    tokens_filled: i64,
}

pub async fn get_user_bids(
    State(s): State<ApiState>,
    Path(wallet): Path<String>,
) -> Result<Json<Vec<BidDto>>, StatusCode> {
    let rows = sqlx::query(
        r#"
        SELECT b.address, b.auction, b.bid_id, b.max_price, b.amount_q64,
               b.start_time, b.exited_time, b.tokens_filled,
               a.clearing_price, a.currency_decimals
        FROM bids b
        LEFT JOIN auctions a ON a.address = b.auction
        WHERE b.owner = $1
        ORDER BY b.start_time DESC
        "#,
    )
    .bind(&wallet)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;

    let out = rows
        .into_iter()
        .map(|r| {
            let max_price: String = r.get("max_price");
            let amount_q64: String = r.get("amount_q64");
            let exited_time: i64 = r.get("exited_time");
            let tokens_filled: i64 = r.get("tokens_filled");
            let clearing: Option<String> = r.get("clearing_price");
            let currency_decimals: i16 = r.try_get("currency_decimals").unwrap_or(0);

            let mp_f = q64_to_f64(&max_price);
            let amt_f = amount_q64_to_human(&amount_q64, currency_decimals);
            let cp_f = clearing.as_deref().map(q64_to_f64).unwrap_or(0.0);

            let status = if exited_time != 0 {
                "exited"
            } else if tokens_filled > 0 {
                "claimed"
            } else if cp_f > mp_f {
                "outbid"
            } else {
                "active"
            };

            let est_tokens = if cp_f > 0.0 { (amt_f / cp_f) as i64 } else { 0 };

            BidDto {
                address: r.get("address"),
                auction: r.get("auction"),
                bid_id: r.get("bid_id"),
                max_price: q64_to_decimal_string(max_price.parse().unwrap_or(0)),
                amount: format!("{:.2}", amt_f),
                status: status.to_string(),
                estimated_tokens: est_tokens,
                estimated_refund: "0".into(),
                start_time: r.get("start_time"),
                exited_time,
                tokens_filled,
            }
        })
        .collect();
    Ok(Json(out))
}

// --- Error helper ---

fn internal<E: std::fmt::Display>(e: E) -> StatusCode {
    tracing::error!("db error: {e}");
    StatusCode::INTERNAL_SERVER_ERROR
}

pub async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

// --- List auctions ---

#[derive(Deserialize)]
pub struct ListAuctionsQuery {
    pub status: Option<String>,
    pub creator: Option<String>,
}

pub async fn list_auctions(
    State(s): State<ApiState>,
    Query(q): Query<ListAuctionsQuery>,
) -> Result<Json<Vec<AuctionDto>>, StatusCode> {
    let mut sql = String::from(
        r#"SELECT address, token_mint, currency_mint, token_decimals, currency_decimals,
                  creator, total_supply,
                  start_time, end_time, claim_time, floor_price, max_bid_price,
                  required_currency_raised, tick_spacing, clearing_price,
                  next_bid_id, currency_raised_q64_x7, total_cleared_q64_x7,
                  graduated, token_name, token_symbol, token_tagline,
                  token_icon_url, description
           FROM auctions"#,
    );
    let mut args: Vec<String> = Vec::new();
    if let Some(c) = q.creator.as_ref() {
        args.push(format!("creator = '{}'", c.replace('\'', "''")));
    }
    if !args.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&args.join(" AND "));
    }
    sql.push_str(" ORDER BY start_time DESC");

    let rows = sqlx::query(&sql).fetch_all(&s.db).await.map_err(internal)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let dto = auction_dto_from_row(&s.db, &row).await.map_err(internal)?;
        if let Some(filter) = q.status.as_deref() {
            if dto.status != filter {
                continue;
            }
        }
        out.push(dto);
    }
    Ok(Json(out))
}

async fn auction_dto_from_row(db: &PgPool, row: &sqlx::postgres::PgRow) -> anyhow::Result<AuctionDto> {
    let address: String = row.get("address");
    let active_bidders: i64 = sqlx::query_scalar(
        "SELECT COUNT(DISTINCT owner) FROM bids WHERE auction = $1 AND exited_time = 0",
    )
    .bind(&address)
    .fetch_one(db)
    .await?;

    let floor_price_raw: String = row.get("floor_price");
    let max_bid_price_raw: String = row.get("max_bid_price");
    let clearing_price_raw: String = row.get("clearing_price");
    let currency_raised_q64_x7: String = row.get("currency_raised_q64_x7");
    let total_cleared_q64_x7: String = row.get("total_cleared_q64_x7");
    let required_raw: i64 = row.get("required_currency_raised");
    let total_supply_raw: i64 = row.get("total_supply");
    let token_decimals: i16 = row.get("token_decimals");
    let currency_decimals: i16 = row.get("currency_decimals");
    let start_time: i64 = row.get("start_time");
    let end_time: i64 = row.get("end_time");
    let claim_time: i64 = row.get("claim_time");
    let graduated: bool = row.get("graduated");

    let currency_raised = q64_x7_to_human_currency(&currency_raised_q64_x7, currency_decimals);
    let total_cleared = q64_x7_to_human_currency(&total_cleared_q64_x7, currency_decimals);
    let required = (required_raw as f64) / pow10(currency_decimals);
    let total_supply_human = (total_supply_raw as f64) / pow10(token_decimals);

    let status = compute_status(graduated, start_time, end_time, claim_time, currency_raised, required);
    let now = chrono::Utc::now().timestamp();
    let time_remaining = if now < end_time { Some(end_time - now) } else { None };
    let progress_percent = if required > 0.0 { (currency_raised / required) * 100.0 } else { 0.0 };
    let supply_released_percent = if total_supply_human > 0.0 { (total_cleared / total_supply_human) * 100.0 } else { 0.0 };

    Ok(AuctionDto {
        address,
        token_mint: row.get("token_mint"),
        token_name: row.get::<Option<String>, _>("token_name").unwrap_or_else(|| "Token".into()),
        token_symbol: row.get::<Option<String>, _>("token_symbol").unwrap_or_else(|| "TKN".into()),
        token_tagline: row.get("token_tagline"),
        token_icon_url: row.get("token_icon_url"),
        token_description: row.get("description"),
        creator: row.get("creator"),
        creator_wallet: row.get("creator"),
        status: status.to_string(),
        clearing_price: q64_to_decimal_string(clearing_price_raw.parse().unwrap_or(0)),
        floor_price: q64_to_decimal_string(floor_price_raw.parse().unwrap_or(0)),
        max_bid_price: q64_to_decimal_string(max_bid_price_raw.parse().unwrap_or(0)),
        tick_spacing: row.get::<i64, _>("tick_spacing").to_string(),
        currency: "USDC".into(),
        currency_raised: format!("{:.2}", currency_raised),
        required_currency_raised: format!("{:.2}", required),
        progress_percent,
        total_supply: total_supply_human as i64,
        total_cleared: total_cleared as i64,
        supply_released_percent,
        bid_count: row.get("next_bid_id"),
        active_bidders,
        start_time,
        end_time,
        claim_time,
        time_remaining,
    })
}

// --- Bids for an auction ---

pub async fn get_auction_bids(
    State(s): State<ApiState>,
    Path(address): Path<String>,
) -> Result<Json<Vec<BidDto>>, StatusCode> {
    let rows = sqlx::query(
        r#"SELECT b.address, b.auction, b.bid_id, b.max_price, b.amount_q64,
                  b.start_time, b.exited_time, b.tokens_filled,
                  a.clearing_price, a.currency_decimals
           FROM bids b
           LEFT JOIN auctions a ON a.address = b.auction
           WHERE b.auction = $1
           ORDER BY b.bid_id ASC"#,
    )
    .bind(&address)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(rows.into_iter().map(row_to_bid_dto).collect()))
}

fn row_to_bid_dto(r: sqlx::postgres::PgRow) -> BidDto {
    let max_price: String = r.get("max_price");
    let amount_q64: String = r.get("amount_q64");
    let exited_time: i64 = r.get("exited_time");
    let tokens_filled: i64 = r.get("tokens_filled");
    let clearing: Option<String> = r.get("clearing_price");
    let currency_decimals: i16 = r.try_get("currency_decimals").unwrap_or(0);

    let mp_f = q64_to_f64(&max_price);
    let amt_f = amount_q64_to_human(&amount_q64, currency_decimals);
    let cp_f = clearing.as_deref().map(q64_to_f64).unwrap_or(0.0);

    let status = if exited_time != 0 {
        "exited"
    } else if tokens_filled > 0 {
        "claimed"
    } else if cp_f > mp_f {
        "outbid"
    } else {
        "active"
    };
    let est_tokens = if cp_f > 0.0 { (amt_f / cp_f) as i64 } else { 0 };

    BidDto {
        address: r.get("address"),
        auction: r.get("auction"),
        bid_id: r.get("bid_id"),
        max_price: q64_to_decimal_string(max_price.parse().unwrap_or(0)),
        amount: format!("{:.2}", amt_f),
        status: status.to_string(),
        estimated_tokens: est_tokens,
        estimated_refund: "0".into(),
        start_time: r.get("start_time"),
        exited_time,
        tokens_filled,
    }
}

// --- User auctions (created by wallet) ---

pub async fn get_user_auctions(
    State(s): State<ApiState>,
    Path(wallet): Path<String>,
) -> Result<Json<Vec<AuctionDto>>, StatusCode> {
    let rows = sqlx::query(
        r#"SELECT address, token_mint, currency_mint, token_decimals, currency_decimals,
                  creator, total_supply,
                  start_time, end_time, claim_time, floor_price, max_bid_price,
                  required_currency_raised, tick_spacing, clearing_price,
                  next_bid_id, currency_raised_q64_x7, total_cleared_q64_x7,
                  graduated, token_name, token_symbol, token_tagline,
                  token_icon_url, description
           FROM auctions WHERE creator = $1 ORDER BY start_time DESC"#,
    )
    .bind(&wallet)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(auction_dto_from_row(&s.db, &row).await.map_err(internal)?);
    }
    Ok(Json(out))
}

// --- Wallet connect ---

pub async fn wallet_connect(
    State(s): State<ApiState>,
    Path(wallet): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    sqlx::query(
        r#"INSERT INTO users (wallet) VALUES ($1)
           ON CONFLICT (wallet) DO UPDATE SET last_seen = NOW()"#,
    )
    .bind(&wallet)
    .execute(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true, "wallet": wallet })))
}

// --- Auction metadata (creator-supplied off-chain fields) ---
// MVP: no signature verification; treat as trusted for hackathon demo.

#[derive(Deserialize)]
pub struct MetadataBody {
    pub token_name: Option<String>,
    pub token_symbol: Option<String>,
    pub token_tagline: Option<String>,
    pub token_icon_url: Option<String>,
    pub description: Option<String>,
}

pub async fn set_metadata(
    State(s): State<ApiState>,
    Path(address): Path<String>,
    Json(body): Json<MetadataBody>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let res = sqlx::query(
        r#"UPDATE auctions SET
              token_name     = COALESCE($2, token_name),
              token_symbol   = COALESCE($3, token_symbol),
              token_tagline  = COALESCE($4, token_tagline),
              token_icon_url = COALESCE($5, token_icon_url),
              description    = COALESCE($6, description),
              updated_at     = NOW()
           WHERE address = $1"#,
    )
    .bind(&address)
    .bind(body.token_name)
    .bind(body.token_symbol)
    .bind(body.token_tagline)
    .bind(body.token_icon_url)
    .bind(body.description)
    .execute(&s.db)
    .await
    .map_err(internal)?;

    if res.rows_affected() == 0 {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}
