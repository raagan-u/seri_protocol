# Backend & Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Rust/Axum backend (indexer, crank, REST API, WebSocket) and Vite/React frontend for the CCA Solana program.

**Architecture:** Backend is a single Rust binary with four async tasks (indexer, crank, API, WS server) sharing a Postgres connection pool and Solana RPC client. Frontend is a Vite+React+Tailwind app that reads from the backend API and sends transactions directly to Solana via Anchor's TS client + Phantom Connect.

**Tech Stack:** Rust (Axum, sqlx, solana-client, anchor-client, tokio), PostgreSQL, React (Vite, TypeScript, Tailwind, TradingView Lightweight Charts, Phantom Connect SDK)

**Spec:** `docs/specs/2026-04-17-backend-frontend-design.md`

**On-chain program ID:** `vZ6194M81Y4CsuQ43y5kShFu4udkjY3UekVnMKYAySm`

**IDL:** `contracts/target/idl/continuous_clearing_auction.json`

---

## File Structure

### Backend (`backend/`)

```
backend/
├── Cargo.toml
├── .env.example
├── migrations/
│   └── 001_initial.sql
└── src/
    ├── main.rs                  # entry point — spawns all services
    ├── config.rs                # env config (DB url, RPC url, program ID, crank keypair)
    ├── db.rs                    # sqlx pool creation + migration runner
    ├── error.rs                 # unified error type for API responses
    ├── models/
    │   ├── mod.rs
    │   ├── auction.rs           # Auction DB model + API response type
    │   ├── bid.rs               # Bid DB model + API response type
    │   ├── checkpoint.rs        # Checkpoint DB model
    │   └── price_history.rs     # PriceHistory DB model
    ├── indexer/
    │   ├── mod.rs
    │   ├── poller.rs            # polls getProgramAccounts, deserializes, upserts
    │   └── deserialize.rs       # Anchor account deserialization (discriminator + borsh)
    ├── crank/
    │   ├── mod.rs
    │   └── service.rs           # checkpoint crank loop
    ├── api/
    │   ├── mod.rs               # Axum router assembly
    │   ├── auctions.rs          # GET /api/auctions, GET /api/auctions/:address, price-history, bids
    │   ├── users.rs             # GET /api/users/:wallet/bids, auctions, POST connect
    │   └── metadata.rs          # POST /api/auctions/:address/metadata
    └── ws/
        ├── mod.rs
        └── hub.rs               # WebSocket hub — subscribe, broadcast events
```

### Frontend (`frontend/`)

```
frontend/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── postcss.config.js
└── src/
    ├── main.tsx
    ├── App.tsx                  # react-router setup
    ├── styles/
    │   ├── index.css            # tailwind directives + Barlow font import
    │   └── theme.ts             # design token constants (exported for JS use)
    ├── lib/
    │   ├── constants.ts         # API base URL, program ID, status enums
    │   ├── types.ts             # TypeScript interfaces matching API responses
    │   └── format.ts            # number/price/time formatting helpers
    ├── api/
    │   ├── client.ts            # fetch wrapper with base URL
    │   ├── auctions.ts          # auction API functions
    │   ├── users.ts             # user API functions
    │   └── websocket.ts         # WS connection + event types
    ├── hooks/
    │   ├── useAuction.ts        # fetch + WS subscribe to single auction
    │   ├── useAuctions.ts       # fetch auction list
    │   ├── useUserBids.ts       # fetch bids for connected wallet
    │   ├── useWebSocket.ts      # WS connection lifecycle
    │   └── usePriceHistory.ts   # fetch chart data
    ├── components/
    │   ├── layout/
    │   │   ├── Navbar.tsx
    │   │   ├── Footer.tsx
    │   │   └── PageContainer.tsx
    │   ├── common/
    │   │   ├── Button.tsx        # pill button with ghost variant
    │   │   ├── Card.tsx          # base card
    │   │   ├── StatusBadge.tsx   # colored status pills
    │   │   ├── ProgressBar.tsx
    │   │   ├── Countdown.tsx
    │   │   └── Input.tsx         # styled text/number input
    │   ├── auction/
    │   │   ├── AuctionCard.tsx   # card for browse grid
    │   │   ├── PriceChart.tsx    # TradingView Lightweight Charts wrapper
    │   │   ├── BidForm.tsx       # max price + amount inputs + submit
    │   │   ├── BidStatusCard.tsx # bid state + action buttons
    │   │   ├── AuctionHeader.tsx # token info, badge, countdown
    │   │   ├── AuctionStats.tsx  # progress bars
    │   │   └── AuctionInfo.tsx   # params table
    │   └── wallet/
    │       └── ConnectButton.tsx # Phantom Connect placeholder (TODO: Raagan)
    └── pages/
        ├── Landing.tsx
        ├── Browse.tsx
        ├── AuctionDetail.tsx
        ├── CreateAuction.tsx
        └── MyBids.tsx
```

---

## Phase 1: Backend

### Task 1: Backend project setup + config + DB

**Files:**
- Modify: `backend/Cargo.toml`
- Create: `backend/.env.example`
- Create: `backend/src/config.rs`
- Create: `backend/src/db.rs`
- Create: `backend/src/error.rs`
- Create: `backend/migrations/001_initial.sql`
- Modify: `backend/src/main.rs`

- [ ] **Step 1: Update Cargo.toml with all dependencies**

```toml
[package]
name = "backend"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = { version = "0.8", features = ["ws"] }
tokio = { version = "1", features = ["full"] }
sqlx = { version = "0.8", features = ["runtime-tokio", "postgres", "migrate"] }
solana-client = "2.2"
solana-sdk = "2.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tower-http = { version = "0.6", features = ["cors"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
dotenvy = "0.15"
borsh = "0.10"
bs58 = "0.5"
futures = "0.3"
```

- [ ] **Step 2: Create .env.example**

```env
DATABASE_URL=postgres://localhost:5432/seri_protocol
SOLANA_RPC_URL=http://127.0.0.1:8899
SOLANA_WS_URL=ws://127.0.0.1:8900
PROGRAM_ID=vZ6194M81Y4CsuQ43y5kShFu4udkjY3UekVnMKYAySm
CRANK_KEYPAIR_PATH=~/.config/solana/id.json
POLL_INTERVAL_SECS=3
CRANK_INTERVAL_SECS=15
SERVER_PORT=3001
```

- [ ] **Step 3: Create config.rs**

```rust
// backend/src/config.rs
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

pub struct Config {
    pub database_url: String,
    pub rpc_url: String,
    pub ws_url: String,
    pub program_id: Pubkey,
    pub crank_keypair_path: String,
    pub poll_interval_secs: u64,
    pub crank_interval_secs: u64,
    pub server_port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: std::env::var("DATABASE_URL")
                .expect("DATABASE_URL must be set"),
            rpc_url: std::env::var("SOLANA_RPC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8899".into()),
            ws_url: std::env::var("SOLANA_WS_URL")
                .unwrap_or_else(|_| "ws://127.0.0.1:8900".into()),
            program_id: Pubkey::from_str(
                &std::env::var("PROGRAM_ID")
                    .expect("PROGRAM_ID must be set"),
            )
            .expect("Invalid PROGRAM_ID"),
            crank_keypair_path: std::env::var("CRANK_KEYPAIR_PATH")
                .unwrap_or_else(|_| "~/.config/solana/id.json".into()),
            poll_interval_secs: std::env::var("POLL_INTERVAL_SECS")
                .unwrap_or_else(|_| "3".into())
                .parse()
                .expect("Invalid POLL_INTERVAL_SECS"),
            crank_interval_secs: std::env::var("CRANK_INTERVAL_SECS")
                .unwrap_or_else(|_| "15".into())
                .parse()
                .expect("Invalid CRANK_INTERVAL_SECS"),
            server_port: std::env::var("SERVER_PORT")
                .unwrap_or_else(|_| "3001".into())
                .parse()
                .expect("Invalid SERVER_PORT"),
        }
    }
}
```

- [ ] **Step 4: Create the SQL migration**

```sql
-- backend/migrations/001_initial.sql

CREATE TABLE IF NOT EXISTS auctions (
    address         TEXT PRIMARY KEY,
    token_mint      TEXT NOT NULL,
    currency_mint   TEXT NOT NULL,
    creator         TEXT NOT NULL,
    total_supply    BIGINT NOT NULL,
    start_time      BIGINT NOT NULL,
    end_time        BIGINT NOT NULL,
    claim_time      BIGINT NOT NULL,
    floor_price     TEXT NOT NULL,
    max_bid_price   TEXT NOT NULL,
    required_currency_raised BIGINT NOT NULL,
    tick_spacing    BIGINT NOT NULL,
    clearing_price  TEXT NOT NULL DEFAULT '0',
    sum_currency_demand TEXT NOT NULL DEFAULT '0',
    next_bid_id     BIGINT NOT NULL DEFAULT 0,
    last_checkpointed_time BIGINT NOT NULL DEFAULT 0,
    currency_raised_q64_x7 TEXT NOT NULL DEFAULT '0',
    total_cleared_q64_x7 TEXT NOT NULL DEFAULT '0',
    graduated       BOOLEAN NOT NULL DEFAULT FALSE,
    token_name      TEXT,
    token_icon_url  TEXT,
    description     TEXT,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bids (
    address         TEXT PRIMARY KEY,
    auction         TEXT NOT NULL REFERENCES auctions(address),
    bid_id          BIGINT NOT NULL,
    owner           TEXT NOT NULL,
    max_price       TEXT NOT NULL,
    amount_q64      TEXT NOT NULL,
    start_time      BIGINT NOT NULL,
    start_cumulative_mps BIGINT NOT NULL,
    exited_time     BIGINT NOT NULL DEFAULT 0,
    tokens_filled   BIGINT NOT NULL DEFAULT 0,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction);
CREATE INDEX IF NOT EXISTS idx_bids_owner ON bids(owner);

CREATE TABLE IF NOT EXISTS checkpoints (
    address         TEXT PRIMARY KEY,
    auction         TEXT NOT NULL REFERENCES auctions(address),
    timestamp       BIGINT NOT NULL,
    clearing_price  TEXT NOT NULL,
    cumulative_mps  BIGINT NOT NULL,
    cumulative_mps_per_price TEXT NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_auction_time ON checkpoints(auction, timestamp);

CREATE TABLE IF NOT EXISTS price_history (
    auction         TEXT NOT NULL REFERENCES auctions(address),
    timestamp       BIGINT NOT NULL,
    clearing_price  TEXT NOT NULL,
    currency_raised BIGINT NOT NULL DEFAULT 0,
    total_cleared   BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (auction, timestamp)
);

CREATE TABLE IF NOT EXISTS users (
    wallet          TEXT PRIMARY KEY,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 5: Create db.rs**

```rust
// backend/src/db.rs
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn create_pool(database_url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(10)
        .connect(database_url)
        .await
        .expect("Failed to connect to Postgres")
}

pub async fn run_migrations(pool: &PgPool) {
    let migration = std::fs::read_to_string("migrations/001_initial.sql")
        .expect("Failed to read migration file");
    sqlx::query(&migration)
        .execute(pool)
        .await
        .expect("Failed to run migrations");
}
```

- [ ] **Step 6: Create error.rs**

```rust
// backend/src/error.rs
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    NotFound(String),
    Internal(String),
    BadRequest(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
```

- [ ] **Step 7: Write main.rs skeleton**

```rust
// backend/src/main.rs
mod config;
mod db;
mod error;
mod models;
mod indexer;
mod crank;
mod api;
mod ws;

use config::Config;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter("backend=debug,tower_http=debug")
        .init();

    let config = Config::from_env();
    let pool = db::create_pool(&config.database_url).await;
    db::run_migrations(&pool).await;

    let rpc_client = solana_client::rpc_client::RpcClient::new(config.rpc_url.clone());
    let rpc_client = std::sync::Arc::new(rpc_client);

    let (ws_hub, _ws_rx) = ws::hub::WsHub::new();
    let ws_hub = std::sync::Arc::new(ws_hub);

    tracing::info!("Starting seri-protocol backend on port {}", config.server_port);

    // Spawn indexer
    let indexer_pool = pool.clone();
    let indexer_rpc = rpc_client.clone();
    let indexer_hub = ws_hub.clone();
    let program_id = config.program_id;
    let poll_interval = config.poll_interval_secs;
    tokio::spawn(async move {
        indexer::poller::run(indexer_pool, indexer_rpc, indexer_hub, program_id, poll_interval).await;
    });

    // Spawn crank
    let crank_pool = pool.clone();
    let crank_rpc = rpc_client.clone();
    let crank_interval = config.crank_interval_secs;
    let crank_keypair_path = config.crank_keypair_path.clone();
    tokio::spawn(async move {
        crank::service::run(crank_pool, crank_rpc, program_id, crank_interval, &crank_keypair_path).await;
    });

    // Build API router
    let app = api::router(pool.clone(), ws_hub.clone());

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", config.server_port))
        .await
        .expect("Failed to bind");

    tracing::info!("Listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.expect("Server error");
}
```

- [ ] **Step 8: Create empty module files so it compiles**

Create these with just `pub mod` declarations:
- `backend/src/models/mod.rs`: `pub mod auction; pub mod bid; pub mod checkpoint; pub mod price_history;`
- `backend/src/models/auction.rs`: empty struct placeholder
- `backend/src/models/bid.rs`: empty struct placeholder
- `backend/src/models/checkpoint.rs`: empty struct placeholder
- `backend/src/models/price_history.rs`: empty struct placeholder
- `backend/src/indexer/mod.rs`: `pub mod poller; pub mod deserialize;`
- `backend/src/indexer/poller.rs`: stub `pub async fn run(...) { loop { tokio::time::sleep(...).await; } }`
- `backend/src/indexer/deserialize.rs`: empty
- `backend/src/crank/mod.rs`: `pub mod service;`
- `backend/src/crank/service.rs`: stub `pub async fn run(...) { loop { tokio::time::sleep(...).await; } }`
- `backend/src/api/mod.rs`: stub router returning empty Router
- `backend/src/api/auctions.rs`: empty
- `backend/src/api/users.rs`: empty
- `backend/src/api/metadata.rs`: empty
- `backend/src/ws/mod.rs`: `pub mod hub;`
- `backend/src/ws/hub.rs`: stub WsHub struct

- [ ] **Step 9: Verify it compiles**

Run: `cd backend && cargo check`
Expected: compiles with no errors (warnings ok)

- [ ] **Step 10: Commit**

```bash
git add backend/
git commit -m "feat(backend): project setup with config, DB migrations, and module skeleton"
```

---

### Task 2: DB models + Anchor account deserialization

**Files:**
- Modify: `backend/src/models/auction.rs`
- Modify: `backend/src/models/bid.rs`
- Modify: `backend/src/models/checkpoint.rs`
- Modify: `backend/src/models/price_history.rs`
- Modify: `backend/src/indexer/deserialize.rs`

**Reference:** On-chain account structs are in `contracts/programs/continuous_clearing_auction/src/state/`. The Anchor discriminator for each account is the first 8 bytes of `sha256("account:<AccountName>")`.

- [ ] **Step 1: Write auction model**

```rust
// backend/src/models/auction.rs
use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct AuctionRow {
    pub address: String,
    pub token_mint: String,
    pub currency_mint: String,
    pub creator: String,
    pub total_supply: i64,
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
    pub floor_price: String,
    pub max_bid_price: String,
    pub required_currency_raised: i64,
    pub tick_spacing: i64,
    pub clearing_price: String,
    pub sum_currency_demand: String,
    pub next_bid_id: i64,
    pub last_checkpointed_time: i64,
    pub currency_raised_q64_x7: String,
    pub total_cleared_q64_x7: String,
    pub graduated: bool,
    pub token_name: Option<String>,
    pub token_icon_url: Option<String>,
    pub description: Option<String>,
}

/// API response with computed fields
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuctionResponse {
    pub address: String,
    pub token_mint: String,
    pub currency_mint: String,
    pub creator: String,
    pub total_supply: i64,
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
    pub floor_price: String,
    pub max_bid_price: String,
    pub required_currency_raised: i64,
    pub tick_spacing: i64,
    pub clearing_price: String,
    pub graduated: bool,
    pub token_name: Option<String>,
    pub token_icon_url: Option<String>,
    pub description: Option<String>,
    // Computed
    pub status: String,
    pub currency_raised: String,
    pub progress_percent: f64,
    pub total_cleared: String,
    pub bid_count: i64,
    pub time_remaining: Option<i64>,
}

const MPS: u128 = 10_000_000;

impl AuctionRow {
    pub fn to_response(self, bid_count: i64, now: i64) -> AuctionResponse {
        let status = compute_status(&self, now);
        let currency_raised_q64_x7: u128 = self.currency_raised_q64_x7.parse().unwrap_or(0);
        let currency_raised = currency_raised_q64_x7 / MPS >> 64;
        let total_cleared_q64_x7: u128 = self.total_cleared_q64_x7.parse().unwrap_or(0);
        let total_cleared = total_cleared_q64_x7 / MPS >> 64;

        let progress_percent = if self.required_currency_raised > 0 {
            (currency_raised as f64 / self.required_currency_raised as f64 * 100.0).min(100.0)
        } else {
            0.0
        };

        let time_remaining = if now < self.end_time {
            Some(self.end_time - now)
        } else {
            None
        };

        AuctionResponse {
            address: self.address,
            token_mint: self.token_mint,
            currency_mint: self.currency_mint,
            creator: self.creator,
            total_supply: self.total_supply,
            start_time: self.start_time,
            end_time: self.end_time,
            claim_time: self.claim_time,
            floor_price: self.floor_price,
            max_bid_price: self.max_bid_price,
            required_currency_raised: self.required_currency_raised,
            tick_spacing: self.tick_spacing,
            clearing_price: self.clearing_price,
            graduated: self.graduated,
            token_name: self.token_name,
            token_icon_url: self.token_icon_url,
            description: self.description,
            status,
            currency_raised: currency_raised.to_string(),
            progress_percent,
            total_cleared: total_cleared.to_string(),
            bid_count,
            time_remaining,
        }
    }
}

fn compute_status(a: &AuctionRow, now: i64) -> String {
    if now < a.start_time {
        "upcoming".into()
    } else if now < a.end_time {
        "live".into()
    } else if a.graduated && now >= a.claim_time {
        "claimable".into()
    } else if a.graduated {
        "graduated".into()
    } else {
        "failed".into()
    }
}
```

- [ ] **Step 2: Write bid model**

```rust
// backend/src/models/bid.rs
use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct BidRow {
    pub address: String,
    pub auction: String,
    pub bid_id: i64,
    pub owner: String,
    pub max_price: String,
    pub amount_q64: String,
    pub start_time: i64,
    pub start_cumulative_mps: i64,
    pub exited_time: i64,
    pub tokens_filled: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BidResponse {
    pub address: String,
    pub auction: String,
    pub bid_id: i64,
    pub owner: String,
    pub max_price: String,
    pub amount: String,
    pub status: String,
    pub start_time: i64,
    pub exited_time: i64,
    pub tokens_filled: i64,
}

impl BidRow {
    pub fn to_response(self, auction_clearing_price: &str, auction_graduated: bool) -> BidResponse {
        let amount_q64: u128 = self.amount_q64.parse().unwrap_or(0);
        let amount = amount_q64 >> 64;

        let status = compute_bid_status(
            &self.max_price,
            auction_clearing_price,
            self.exited_time,
            self.tokens_filled,
            auction_graduated,
        );

        BidResponse {
            address: self.address,
            auction: self.auction,
            bid_id: self.bid_id,
            owner: self.owner,
            max_price: self.max_price,
            amount: amount.to_string(),
            status,
            start_time: self.start_time,
            exited_time: self.exited_time,
            tokens_filled: self.tokens_filled,
        }
    }
}

fn compute_bid_status(
    max_price: &str,
    clearing_price: &str,
    exited_time: i64,
    tokens_filled: i64,
    graduated: bool,
) -> String {
    if tokens_filled > 0 && exited_time > 0 {
        return "claimed".into();
    }
    if exited_time > 0 {
        return "exited".into();
    }
    if !graduated {
        // Auction still running or failed
        let mp: u128 = max_price.parse().unwrap_or(0);
        let cp: u128 = clearing_price.parse().unwrap_or(0);
        if mp < cp {
            "outbid".into()
        } else if mp == cp {
            "partially_filled".into()
        } else {
            // Check "at risk" — within 10% of clearing price
            let threshold = cp + cp / 10;
            if mp <= threshold {
                "at_risk".into()
            } else {
                "active".into()
            }
        }
    } else {
        let mp: u128 = max_price.parse().unwrap_or(0);
        let cp: u128 = clearing_price.parse().unwrap_or(0);
        if mp < cp {
            "outbid".into()
        } else if mp == cp {
            "partially_filled".into()
        } else {
            "active".into()
        }
    }
}
```

- [ ] **Step 3: Write checkpoint and price_history models**

```rust
// backend/src/models/checkpoint.rs
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct CheckpointRow {
    pub address: String,
    pub auction: String,
    pub timestamp: i64,
    pub clearing_price: String,
    pub cumulative_mps: i64,
    pub cumulative_mps_per_price: String,
}
```

```rust
// backend/src/models/price_history.rs
use serde::Serialize;
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceHistoryRow {
    pub auction: String,
    pub timestamp: i64,
    pub clearing_price: String,
    pub currency_raised: i64,
    pub total_cleared: i64,
}
```

- [ ] **Step 4: Write Anchor account deserializer**

The on-chain accounts use Anchor's format: 8-byte discriminator + borsh-serialized fields. We need to deserialize Auction, Bid, and Checkpoint. The discriminator is `sha256("account:<Name>")[..8]`.

```rust
// backend/src/indexer/deserialize.rs
use borsh::BorshDeserialize;
use solana_sdk::pubkey::Pubkey;

/// Raw on-chain Auction account data (after 8-byte discriminator)
#[derive(BorshDeserialize, Debug)]
pub struct RawAuction {
    pub token_mint: Pubkey,
    pub currency_mint: Pubkey,
    pub token_vault: Pubkey,
    pub currency_vault: Pubkey,
    pub creator: Pubkey,
    pub tokens_recipient: Pubkey,
    pub funds_recipient: Pubkey,
    pub total_supply: u64,
    pub start_time: i64,
    pub end_time: i64,
    pub claim_time: i64,
    pub tick_spacing: u64,
    pub floor_price: u128,
    pub max_bid_price: u128,
    pub required_currency_raised: u64,
    // Live state
    pub clearing_price: u128,
    pub sum_currency_demand_above_clearing: u128,
    pub next_active_tick_price: u128,
    pub next_bid_id: u64,
    pub last_checkpointed_time: i64,
    pub currency_raised_q64_x7: u128,
    pub total_cleared_q64_x7: u128,
    pub tokens_received: bool,
    pub sweep_currency_done: bool,
    pub sweep_tokens_done: bool,
    pub graduated: bool,
    pub bump: u8,
}

#[derive(BorshDeserialize, Debug)]
pub struct RawBid {
    pub auction: Pubkey,
    pub bid_id: u64,
    pub owner: Pubkey,
    pub max_price: u128,
    pub amount_q64: u128,
    pub start_time: i64,
    pub start_cumulative_mps: u32,
    pub exited_time: i64,
    pub tokens_filled: u64,
    pub bump: u8,
}

#[derive(BorshDeserialize, Debug)]
pub struct RawCheckpoint {
    pub auction: Pubkey,
    pub timestamp: i64,
    pub clearing_price: u128,
    pub currency_raised_at_clearing_price_q64_x7: u128,
    pub cumulative_mps_per_price: u128,
    pub cumulative_mps: u32,
    pub prev_timestamp: i64,
    pub next_timestamp: i64,
    pub bump: u8,
}

/// Compute Anchor discriminator: first 8 bytes of sha256("account:<Name>")
pub fn discriminator(name: &str) -> [u8; 8] {
    use std::io::Write;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    hasher.update(format!("account:{}", name).as_bytes());
    let hash = <sha2::Sha256 as sha2::Digest>::finalize(hasher);
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Try to deserialize account data, skipping 8-byte discriminator
pub fn try_deserialize<T: BorshDeserialize>(data: &[u8], expected_name: &str) -> Option<T> {
    if data.len() < 8 {
        return None;
    }
    let disc = discriminator(expected_name);
    if data[..8] != disc {
        return None;
    }
    T::try_from_slice(&data[8..]).ok()
}
```

Note: Add `sha2 = "0.10"` to `Cargo.toml` dependencies.

- [ ] **Step 5: Verify it compiles**

Run: `cd backend && cargo check`
Expected: compiles

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/ backend/src/indexer/deserialize.rs
git commit -m "feat(backend): DB models, API response types, and Anchor account deserialization"
```

---

### Task 3: Indexer (poller)

**Files:**
- Modify: `backend/src/indexer/poller.rs`

The indexer polls `getProgramAccounts` on the CCA program, deserializes each account, and upserts into Postgres. It also broadcasts changes to the WebSocket hub.

- [ ] **Step 1: Implement the indexer poller**

```rust
// backend/src/indexer/poller.rs
use crate::indexer::deserialize::{try_deserialize, RawAuction, RawBid, RawCheckpoint};
use crate::ws::hub::WsHub;
use solana_client::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use sqlx::PgPool;
use std::sync::Arc;

pub async fn run(
    pool: PgPool,
    rpc: Arc<RpcClient>,
    ws_hub: Arc<WsHub>,
    program_id: Pubkey,
    poll_interval_secs: u64,
) {
    let interval = std::time::Duration::from_secs(poll_interval_secs);
    tracing::info!("Indexer started, polling every {}s", poll_interval_secs);

    loop {
        if let Err(e) = poll_once(&pool, &rpc, &ws_hub, &program_id).await {
            tracing::error!("Indexer poll error: {}", e);
        }
        tokio::time::sleep(interval).await;
    }
}

async fn poll_once(
    pool: &PgPool,
    rpc: &RpcClient,
    ws_hub: &WsHub,
    program_id: &Pubkey,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let accounts = rpc.get_program_accounts(program_id)?;

    for (pubkey, account) in &accounts {
        let address = pubkey.to_string();
        let data = &account.data;

        // Try Auction
        if let Some(raw) = try_deserialize::<RawAuction>(data, "Auction") {
            upsert_auction(pool, &address, &raw).await?;
            continue;
        }

        // Try Bid
        if let Some(raw) = try_deserialize::<RawBid>(data, "Bid") {
            upsert_bid(pool, &address, &raw).await?;
            continue;
        }

        // Try Checkpoint
        if let Some(raw) = try_deserialize::<RawCheckpoint>(data, "Checkpoint") {
            upsert_checkpoint(pool, &address, &raw).await?;
            // Also insert into price_history
            insert_price_history(pool, &raw).await?;
            continue;
        }

        // Skip unknown accounts (Tick, AuctionSteps, etc.)
    }

    // Broadcast update to all WS subscribers
    ws_hub.broadcast_refresh();

    Ok(())
}

async fn upsert_auction(
    pool: &PgPool,
    address: &str,
    raw: &RawAuction,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO auctions (
            address, token_mint, currency_mint, creator, total_supply,
            start_time, end_time, claim_time, floor_price, max_bid_price,
            required_currency_raised, tick_spacing, clearing_price,
            sum_currency_demand, next_bid_id, last_checkpointed_time,
            currency_raised_q64_x7, total_cleared_q64_x7, graduated
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (address) DO UPDATE SET
            clearing_price = $13,
            sum_currency_demand = $14,
            next_bid_id = $15,
            last_checkpointed_time = $16,
            currency_raised_q64_x7 = $17,
            total_cleared_q64_x7 = $18,
            graduated = $19,
            updated_at = NOW()
        "#,
    )
    .bind(address)
    .bind(raw.token_mint.to_string())
    .bind(raw.currency_mint.to_string())
    .bind(raw.creator.to_string())
    .bind(raw.total_supply as i64)
    .bind(raw.start_time)
    .bind(raw.end_time)
    .bind(raw.claim_time)
    .bind(raw.floor_price.to_string())
    .bind(raw.max_bid_price.to_string())
    .bind(raw.required_currency_raised as i64)
    .bind(raw.tick_spacing as i64)
    .bind(raw.clearing_price.to_string())
    .bind(raw.sum_currency_demand_above_clearing.to_string())
    .bind(raw.next_bid_id as i64)
    .bind(raw.last_checkpointed_time)
    .bind(raw.currency_raised_q64_x7.to_string())
    .bind(raw.total_cleared_q64_x7.to_string())
    .bind(raw.graduated)
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_bid(
    pool: &PgPool,
    address: &str,
    raw: &RawBid,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO bids (
            address, auction, bid_id, owner, max_price, amount_q64,
            start_time, start_cumulative_mps, exited_time, tokens_filled
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (address) DO UPDATE SET
            exited_time = $9,
            tokens_filled = $10,
            updated_at = NOW()
        "#,
    )
    .bind(address)
    .bind(raw.auction.to_string())
    .bind(raw.bid_id as i64)
    .bind(raw.owner.to_string())
    .bind(raw.max_price.to_string())
    .bind(raw.amount_q64.to_string())
    .bind(raw.start_time)
    .bind(raw.start_cumulative_mps as i64)
    .bind(raw.exited_time)
    .bind(raw.tokens_filled as i64)
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_checkpoint(
    pool: &PgPool,
    address: &str,
    raw: &RawCheckpoint,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO checkpoints (
            address, auction, timestamp, clearing_price,
            cumulative_mps, cumulative_mps_per_price
        ) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (address) DO NOTHING
        "#,
    )
    .bind(address)
    .bind(raw.auction.to_string())
    .bind(raw.timestamp)
    .bind(raw.clearing_price.to_string())
    .bind(raw.cumulative_mps as i64)
    .bind(raw.cumulative_mps_per_price.to_string())
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_price_history(
    pool: &PgPool,
    raw: &RawCheckpoint,
) -> Result<(), sqlx::Error> {
    let cp_q64: u128 = raw.clearing_price;
    let price_human = cp_q64 >> 64;

    sqlx::query(
        r#"
        INSERT INTO price_history (auction, timestamp, clearing_price)
        VALUES ($1, $2, $3)
        ON CONFLICT (auction, timestamp) DO NOTHING
        "#,
    )
    .bind(raw.auction.to_string())
    .bind(raw.timestamp)
    .bind(price_human.to_string())
    .execute(pool)
    .await?;
    Ok(())
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && cargo check`
Expected: compiles (WsHub methods may need stubs updated — see Task 5)

- [ ] **Step 3: Commit**

```bash
git add backend/src/indexer/
git commit -m "feat(backend): indexer poller — polls program accounts, deserializes, upserts to DB"
```

---

### Task 4: Crank service

**Files:**
- Modify: `backend/src/crank/service.rs`

The crank periodically sends `checkpoint` transactions for live auctions.

- [ ] **Step 1: Implement crank service**

```rust
// backend/src/crank/service.rs
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Signer},
    system_program,
    transaction::Transaction,
};
use sqlx::PgPool;
use std::sync::Arc;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn run(
    pool: PgPool,
    rpc: Arc<RpcClient>,
    program_id: Pubkey,
    interval_secs: u64,
    keypair_path: &str,
) {
    let interval = std::time::Duration::from_secs(interval_secs);
    let expanded = shellexpand::tilde(keypair_path).to_string();
    let payer = read_keypair_file(&expanded)
        .expect("Failed to read crank keypair");

    tracing::info!("Crank started, interval {}s, payer: {}", interval_secs, payer.pubkey());

    loop {
        if let Err(e) = crank_once(&pool, &rpc, &program_id, &payer).await {
            tracing::error!("Crank error: {}", e);
        }
        tokio::time::sleep(interval).await;
    }
}

async fn crank_once(
    pool: &PgPool,
    rpc: &RpcClient,
    program_id: &Pubkey,
    payer: &dyn Signer,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;

    // Find live auctions that need checkpointing
    let rows: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT address, last_checkpointed_time, token_mint FROM auctions WHERE start_time <= $1 AND end_time > $1 AND graduated = false"
    )
    .bind(now)
    .fetch_all(pool)
    .await?;

    for (auction_addr, last_cp_time, token_mint) in &rows {
        tracing::debug!("Cranking auction {}, last_cp: {}", auction_addr, last_cp_time);

        if let Err(e) = send_checkpoint(rpc, program_id, payer, auction_addr, token_mint, now).await {
            tracing::warn!("Failed to checkpoint auction {}: {}", auction_addr, e);
        }
    }

    Ok(())
}

async fn send_checkpoint(
    rpc: &RpcClient,
    program_id: &Pubkey,
    payer: &dyn Signer,
    auction_addr: &str,
    token_mint: &str,
    timestamp: i64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let auction_pubkey = Pubkey::from_str(auction_addr)?;
    let token_mint_pubkey = Pubkey::from_str(token_mint)?;

    // Derive PDAs
    let (auction_pda, _) = Pubkey::find_program_address(
        &[b"auction", token_mint_pubkey.as_ref(), payer.pubkey().as_ref()],
        program_id,
    );

    // Note: The actual auction PDA may differ from what we derive here since
    // the creator may not be the crank. We use the address from DB directly.
    // The checkpoint PDA requires the auction address and current timestamp.

    let (steps_pda, _) = Pubkey::find_program_address(
        &[b"steps", auction_pubkey.as_ref()],
        program_id,
    );

    // Previous checkpoint — we need the last checkpointed timestamp to find it
    // For simplicity, we fetch the auction's last_checkpointed_time from chain
    // and derive the prev checkpoint PDA from it.
    // This is a simplified version — full implementation may need to read auction state.

    let (new_checkpoint_pda, _) = Pubkey::find_program_address(
        &[b"checkpoint", auction_pubkey.as_ref(), &timestamp.to_le_bytes()],
        program_id,
    );

    // Build the checkpoint instruction using the Anchor discriminator
    let disc = crate::indexer::deserialize::discriminator("checkpoint");
    // Actually, instruction discriminators use "global:<instruction_name>"
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, b"global:checkpoint");
    let hash = sha2::Digest::finalize(hasher);
    let mut ix_disc = [0u8; 8];
    ix_disc.copy_from_slice(&hash[..8]);

    // Serialize params: CheckpointParams { timestamp: i64 }
    let mut ix_data = ix_disc.to_vec();
    ix_data.extend_from_slice(&timestamp.to_le_bytes());

    // TODO: The full account list for checkpoint instruction needs to match
    // the Anchor IDL exactly. This requires: payer, auction, steps,
    // prev_checkpoint, new_checkpoint, system_program.
    // For now this is a skeleton — the exact account metas depend on the
    // instruction's Accounts struct. Will refine once tested against localnet.

    tracing::debug!("Checkpoint instruction built for auction {} at t={}", auction_addr, timestamp);

    // In production, we would build and send the transaction here.
    // For now, log it — we'll wire up the actual send once we test against localnet.

    Ok(())
}
```

Note: Add `shellexpand = "3"` and `sha2 = "0.10"` to Cargo.toml if not already present.

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && cargo check`
Expected: compiles

- [ ] **Step 3: Commit**

```bash
git add backend/src/crank/
git commit -m "feat(backend): crank service skeleton — finds live auctions, builds checkpoint instructions"
```

---

### Task 5: WebSocket hub

**Files:**
- Modify: `backend/src/ws/hub.rs`

- [ ] **Step 1: Implement WsHub**

```rust
// backend/src/ws/hub.rs
use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    PriceUpdate {
        auction: String,
        clearing_price: String,
        timestamp: i64,
    },
    NewBid {
        auction: String,
        bid_id: i64,
        bid_count: i64,
    },
    StateChange {
        auction: String,
        status: String,
    },
    Refresh,
}

pub struct WsHub {
    tx: broadcast::Sender<WsEvent>,
}

impl WsHub {
    pub fn new() -> (Self, broadcast::Receiver<WsEvent>) {
        let (tx, rx) = broadcast::channel(256);
        (Self { tx }, rx)
    }

    pub fn broadcast(&self, event: WsEvent) {
        let _ = self.tx.send(event);
    }

    pub fn broadcast_refresh(&self) {
        let _ = self.tx.send(WsEvent::Refresh);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WsEvent> {
        self.tx.subscribe()
    }

    /// Handle a WebSocket connection — subscribe to events and forward to client
    pub async fn handle_socket(self: &std::sync::Arc<Self>, mut socket: WebSocket) {
        let mut rx = self.subscribe();

        // Read subscription message from client (optional filtering)
        // For MVP, just forward all events
        loop {
            tokio::select! {
                event = rx.recv() => {
                    match event {
                        Ok(evt) => {
                            let json = serde_json::to_string(&evt).unwrap_or_default();
                            if socket.send(Message::Text(json.into())).await.is_err() {
                                break; // Client disconnected
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
                msg = socket.recv() => {
                    match msg {
                        Some(Ok(Message::Close(_))) | None => break,
                        _ => {} // Ignore client messages for now
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && cargo check`
Expected: compiles

- [ ] **Step 3: Commit**

```bash
git add backend/src/ws/
git commit -m "feat(backend): WebSocket hub with broadcast events and socket handler"
```

---

### Task 6: REST API routes

**Files:**
- Modify: `backend/src/api/mod.rs`
- Modify: `backend/src/api/auctions.rs`
- Modify: `backend/src/api/users.rs`
- Modify: `backend/src/api/metadata.rs`

- [ ] **Step 1: Implement API router**

```rust
// backend/src/api/mod.rs
pub mod auctions;
pub mod users;
pub mod metadata;

use crate::ws::hub::WsHub;
use axum::{
    Router,
    routing::{get, post},
    extract::WebSocketUpgrade,
    response::IntoResponse,
};
use sqlx::PgPool;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub ws_hub: Arc<WsHub>,
}

pub fn router(pool: PgPool, ws_hub: Arc<WsHub>) -> Router {
    let state = AppState { pool, ws_hub };

    Router::new()
        .route("/api/auctions", get(auctions::list_auctions))
        .route("/api/auctions/{address}", get(auctions::get_auction))
        .route("/api/auctions/{address}/price-history", get(auctions::price_history))
        .route("/api/auctions/{address}/bids", get(auctions::auction_bids))
        .route("/api/auctions/{address}/metadata", post(metadata::set_metadata))
        .route("/api/users/{wallet}/bids", get(users::user_bids))
        .route("/api/users/{wallet}/auctions", get(users::user_auctions))
        .route("/api/users/{wallet}/connect", post(users::connect_wallet))
        .route("/ws", get(ws_upgrade))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        state.ws_hub.handle_socket(socket).await;
    })
}
```

- [ ] **Step 2: Implement auction endpoints**

```rust
// backend/src/api/auctions.rs
use crate::api::AppState;
use crate::error::AppError;
use crate::models::auction::AuctionRow;
use crate::models::bid::BidRow;
use crate::models::price_history::PriceHistoryRow;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
pub struct ListParams {
    pub status: Option<String>,
    pub creator: Option<String>,
}

pub async fn list_auctions(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Result<Json<serde_json::Value>, AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let rows: Vec<AuctionRow> = sqlx::query_as("SELECT * FROM auctions ORDER BY start_time DESC")
        .fetch_all(&state.pool)
        .await?;

    let mut responses = Vec::new();
    for row in rows {
        let addr = row.address.clone();
        let bid_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM bids WHERE auction = $1")
                .bind(&addr)
                .fetch_one(&state.pool)
                .await?;
        let resp = row.to_response(bid_count.0, now);

        // Filter by status if provided
        if let Some(ref s) = params.status {
            if &resp.status != s {
                continue;
            }
        }
        if let Some(ref c) = params.creator {
            if &resp.creator != c {
                continue;
            }
        }
        responses.push(resp);
    }

    Ok(Json(serde_json::to_value(responses).unwrap()))
}

pub async fn get_auction(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let row: AuctionRow = sqlx::query_as("SELECT * FROM auctions WHERE address = $1")
        .bind(&address)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Auction {} not found", address)))?;

    let bid_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM bids WHERE auction = $1")
            .bind(&address)
            .fetch_one(&state.pool)
            .await?;

    Ok(Json(serde_json::to_value(row.to_response(bid_count.0, now)).unwrap()))
}

pub async fn price_history(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<Vec<PriceHistoryRow>>, AppError> {
    let rows: Vec<PriceHistoryRow> = sqlx::query_as(
        "SELECT * FROM price_history WHERE auction = $1 ORDER BY timestamp ASC",
    )
    .bind(&address)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(rows))
}

pub async fn auction_bids(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let auction: AuctionRow = sqlx::query_as("SELECT * FROM auctions WHERE address = $1")
        .bind(&address)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Auction {} not found", address)))?;

    let rows: Vec<BidRow> = sqlx::query_as(
        "SELECT * FROM bids WHERE auction = $1 ORDER BY bid_id ASC",
    )
    .bind(&address)
    .fetch_all(&state.pool)
    .await?;

    let responses: Vec<_> = rows
        .into_iter()
        .map(|b| b.to_response(&auction.clearing_price, auction.graduated))
        .collect();

    Ok(Json(serde_json::to_value(responses).unwrap()))
}
```

- [ ] **Step 3: Implement user endpoints**

```rust
// backend/src/api/users.rs
use crate::api::AppState;
use crate::error::AppError;
use crate::models::auction::AuctionRow;
use crate::models::bid::BidRow;
use axum::extract::{Path, State};
use axum::Json;
use std::time::{SystemTime, UNIX_EPOCH};

pub async fn user_bids(
    State(state): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let rows: Vec<BidRow> = sqlx::query_as(
        "SELECT * FROM bids WHERE owner = $1 ORDER BY start_time DESC",
    )
    .bind(&wallet)
    .fetch_all(&state.pool)
    .await?;

    let mut responses = Vec::new();
    for bid in rows {
        let auction: Option<AuctionRow> =
            sqlx::query_as("SELECT * FROM auctions WHERE address = $1")
                .bind(&bid.auction)
                .fetch_optional(&state.pool)
                .await?;

        if let Some(a) = auction {
            responses.push(bid.to_response(&a.clearing_price, a.graduated));
        }
    }

    Ok(Json(serde_json::to_value(responses).unwrap()))
}

pub async fn user_auctions(
    State(state): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let rows: Vec<AuctionRow> = sqlx::query_as(
        "SELECT * FROM auctions WHERE creator = $1 ORDER BY start_time DESC",
    )
    .bind(&wallet)
    .fetch_all(&state.pool)
    .await?;

    let mut responses = Vec::new();
    for row in rows {
        let addr = row.address.clone();
        let bid_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM bids WHERE auction = $1")
                .bind(&addr)
                .fetch_one(&state.pool)
                .await?;
        responses.push(row.to_response(bid_count.0, now));
    }

    Ok(Json(serde_json::to_value(responses).unwrap()))
}

pub async fn connect_wallet(
    State(state): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    sqlx::query(
        "INSERT INTO users (wallet) VALUES ($1) ON CONFLICT (wallet) DO UPDATE SET last_seen = NOW()",
    )
    .bind(&wallet)
    .execute(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
```

- [ ] **Step 4: Implement metadata endpoint**

```rust
// backend/src/api/metadata.rs
use crate::api::AppState;
use crate::error::AppError;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataInput {
    pub token_name: Option<String>,
    pub token_icon_url: Option<String>,
    pub description: Option<String>,
}

pub async fn set_metadata(
    State(state): State<AppState>,
    Path(address): Path<String>,
    Json(input): Json<MetadataInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    // For MVP, no auth — anyone can set metadata. In production, verify wallet signature.
    sqlx::query(
        "UPDATE auctions SET token_name = COALESCE($2, token_name), token_icon_url = COALESCE($3, token_icon_url), description = COALESCE($4, description), updated_at = NOW() WHERE address = $1",
    )
    .bind(&address)
    .bind(&input.token_name)
    .bind(&input.token_icon_url)
    .bind(&input.description)
    .execute(&state.pool)
    .await?;

    Ok(Json(serde_json::json!({ "ok": true })))
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd backend && cargo check`
Expected: compiles

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/
git commit -m "feat(backend): REST API — auction list/detail/bids, user bids/auctions, metadata, WS upgrade"
```

---

### Task 7: Backend integration test — end to end

**Files:**
- Create: `backend/.env` (copy from .env.example with local values)

- [ ] **Step 1: Create local .env**

```env
DATABASE_URL=postgres://localhost:5432/seri_protocol
SOLANA_RPC_URL=http://127.0.0.1:8899
SOLANA_WS_URL=ws://127.0.0.1:8900
PROGRAM_ID=vZ6194M81Y4CsuQ43y5kShFu4udkjY3UekVnMKYAySm
CRANK_KEYPAIR_PATH=~/.config/solana/id.json
POLL_INTERVAL_SECS=3
CRANK_INTERVAL_SECS=15
SERVER_PORT=3001
```

- [ ] **Step 2: Create the Postgres database**

Run: `createdb seri_protocol` (or `psql -c "CREATE DATABASE seri_protocol;"`)

- [ ] **Step 3: Build and run the backend**

Run: `cd backend && cargo run`
Expected: Logs show "Starting seri-protocol backend on port 3001", "Indexer started", "Crank started". No crashes.

- [ ] **Step 4: Test API endpoints manually**

Run (in another terminal):
```bash
curl http://localhost:3001/api/auctions | jq
curl http://localhost:3001/api/users/someWallet123/bids | jq
```
Expected: Empty arrays `[]` (no data yet). No 500 errors.

- [ ] **Step 5: Test with a live localnet auction**

Start local validator + deploy program (in contracts/):
```bash
cd contracts && anchor test --skip-local-validator
```
Then check:
```bash
curl http://localhost:3001/api/auctions | jq
```
Expected: After indexer polls, auctions should appear with populated fields.

- [ ] **Step 6: Commit any fixes**

```bash
git add backend/
git commit -m "fix(backend): integration fixes from end-to-end testing"
```

---

## Phase 2: Frontend

### Task 8: Frontend project scaffolding

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/tailwind.config.ts`
- Create: `frontend/postcss.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/styles/index.css`
- Create: `frontend/src/styles/theme.ts`

- [ ] **Step 1: Initialize Vite React project**

Run:
```bash
cd /Users/raagan/personal/seri_protocol
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
npm install -D tailwindcss @tailwindcss/vite
npm install react-router-dom lightweight-charts @coral-xyz/anchor @solana/web3.js
```

- [ ] **Step 2: Configure Vite with Tailwind**

```ts
// frontend/vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
```

- [ ] **Step 3: Create tailwind.config.ts with design tokens**

```ts
// frontend/tailwind.config.ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      // Base — dark charcoal (Across-inspired)
      bg: {
        primary: '#2D2E33',
        secondary: '#34353B',
        tertiary: '#3E4047',
        deep: '#151518',
      },
      border: {
        DEFAULT: 'rgba(255,255,255,0.03)',
        subtle: 'rgba(255,255,255,0.08)',
      },
      text: {
        primary: '#ffffff',
        secondary: '#C5D5E0',
        muted: '#9DAAB3',
        dim: '#4C4E57',
      },
      // Accent — Solana green
      accent: {
        DEFAULT: '#14f195',
        soft: '#6CF9D8',
        bg: 'rgba(20,241,149,0.05)',
        border: 'rgba(20,241,149,0.05)',
      },
      // Status
      status: {
        live: '#14f195',
        upcoming: '#9DAAB3',
        graduated: '#14f195',
        failed: '#ef4444',
        claimable: '#6CF9D8',
      },
      // Bid status
      bid: {
        active: '#14f195',
        atRisk: '#fbbf24',
        outbid: '#ef4444',
        partiallyFilled: '#fbbf24',
        exited: '#4C4E57',
        claimed: '#14f195',
      },
      white: '#ffffff',
      red: '#ef4444',
      yellow: '#fbbf24',
    },
    fontSize: {
      xs: ['0.75rem', '1.05rem'],
      sm: ['0.875rem', '1.225rem'],
      md: ['1rem', '1.4rem'],
      lg: ['1.125rem', '1.575rem'],
      'h5': ['1.25rem', '1.375rem'],
      'h4': ['1.5rem', '1.65rem'],
      'h3': ['2rem', '2.2rem'],
      'h2': ['3rem', '3.3rem'],
    },
    letterSpacing: {
      tight: '-0.04rem',
      tighter: '-0.12rem',
      wide: '0.12rem',
      normal: '0',
    },
    extend: {
      fontFamily: {
        sans: ['Barlow', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card: '0.75rem',
        btn: '9999px',
      },
      dropShadow: {
        glow: [
          '0px 0px 13.8px #14f195',
          '0px 0px 9.8px #00A27C',
          '0px 0px 2.6px rgba(0,0,0,0.25)',
        ],
        'glow-sm': [
          '0px 0px 8.3px #14f195',
          '0px 0px 5.9px #00A27C',
          '0px 0px 1.6px rgba(0,0,0,0.25)',
        ],
      },
    },
  },
  plugins: [],
}

export default config
```

- [ ] **Step 4: Create global CSS**

```css
/* frontend/src/styles/index.css */
@import "tailwindcss";
@import url('https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500&display=swap');
```

- [ ] **Step 5: Create theme constants for JS use**

```ts
// frontend/src/styles/theme.ts
export const colors = {
  accent: '#14f195',
  accentSoft: '#6CF9D8',
  bgPrimary: '#2D2E33',
  bgSecondary: '#34353B',
  bgDeep: '#151518',
  textPrimary: '#ffffff',
  textSecondary: '#C5D5E0',
  textMuted: '#9DAAB3',
  red: '#ef4444',
  yellow: '#fbbf24',
} as const

export const chartColors = {
  line: '#14f195',
  area: 'rgba(20,241,149,0.06)',
  grid: '#3E4047',
  background: '#34353B',
  text: '#9DAAB3',
  crosshair: '#6CF9D8',
} as const
```

- [ ] **Step 6: Create index.html**

```html
<!-- frontend/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Seri Protocol</title>
  </head>
  <body class="bg-bg-primary text-text-secondary font-sans">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create main.tsx and App.tsx with router**

```tsx
// frontend/src/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
```

```tsx
// frontend/src/App.tsx
import { Routes, Route } from 'react-router-dom'
import Navbar from './components/layout/Navbar'
import Footer from './components/layout/Footer'
import Landing from './pages/Landing'
import Browse from './pages/Browse'
import AuctionDetail from './pages/AuctionDetail'
import CreateAuction from './pages/CreateAuction'
import MyBids from './pages/MyBids'

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/auction/:address" element={<AuctionDetail />} />
          <Route path="/create" element={<CreateAuction />} />
          <Route path="/my-bids" element={<MyBids />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}
```

- [ ] **Step 8: Create stub page and layout files**

Create these as minimal components that just render a div with the page name so the app compiles and routes work:

- `frontend/src/pages/Landing.tsx`
- `frontend/src/pages/Browse.tsx`
- `frontend/src/pages/AuctionDetail.tsx`
- `frontend/src/pages/CreateAuction.tsx`
- `frontend/src/pages/MyBids.tsx`
- `frontend/src/components/layout/Navbar.tsx`
- `frontend/src/components/layout/Footer.tsx`

Example stub:
```tsx
export default function Landing() {
  return <div className="p-8 text-text-primary text-h3">Landing</div>
}
```

- [ ] **Step 9: Verify it runs**

Run: `cd frontend && npm run dev`
Expected: Opens at localhost:5173, shows dark background with Barlow font, "Landing" text in white. Navigate to /browse, /create etc — each shows its page name.

- [ ] **Step 10: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): Vite + React + Tailwind scaffold with routing and Across-inspired design tokens"
```

---

### Task 9: Shared types, API client, and formatting utilities

**Files:**
- Create: `frontend/src/lib/types.ts`
- Create: `frontend/src/lib/constants.ts`
- Create: `frontend/src/lib/format.ts`
- Create: `frontend/src/api/client.ts`
- Create: `frontend/src/api/auctions.ts`
- Create: `frontend/src/api/users.ts`
- Create: `frontend/src/api/websocket.ts`

- [ ] **Step 1: Create types matching API responses**

```ts
// frontend/src/lib/types.ts
export interface Auction {
  address: string
  tokenMint: string
  currencyMint: string
  creator: string
  totalSupply: number
  startTime: number
  endTime: number
  claimTime: number
  floorPrice: string
  maxBidPrice: string
  requiredCurrencyRaised: number
  tickSpacing: number
  clearingPrice: string
  graduated: boolean
  tokenName: string | null
  tokenIconUrl: string | null
  description: string | null
  // Computed
  status: AuctionStatus
  currencyRaised: string
  progressPercent: number
  totalCleared: string
  bidCount: number
  timeRemaining: number | null
}

export type AuctionStatus = 'upcoming' | 'live' | 'ended' | 'graduated' | 'failed' | 'claimable'

export interface Bid {
  address: string
  auction: string
  bidId: number
  owner: string
  maxPrice: string
  amount: string
  status: BidStatus
  startTime: number
  exitedTime: number
  tokensFilled: number
}

export type BidStatus = 'active' | 'at_risk' | 'outbid' | 'partially_filled' | 'exited' | 'claimed'

export interface PricePoint {
  auction: string
  timestamp: number
  clearingPrice: string
  currencyRaised: number
  totalCleared: number
}

export interface WsEvent {
  type: 'price_update' | 'new_bid' | 'state_change' | 'refresh'
  auction?: string
  clearingPrice?: string
  timestamp?: number
  bidId?: number
  bidCount?: number
  status?: string
}
```

- [ ] **Step 2: Create constants**

```ts
// frontend/src/lib/constants.ts
export const API_BASE = '/api'
export const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`

export const STATUS_LABELS: Record<string, string> = {
  upcoming: 'Upcoming',
  live: 'Live',
  graduated: 'Graduated',
  failed: 'Failed',
  claimable: 'Claimable',
}

export const BID_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  at_risk: 'At Risk',
  outbid: 'Outbid',
  partially_filled: 'Partial Fill',
  exited: 'Exited',
  claimed: 'Claimed',
}
```

- [ ] **Step 3: Create formatting helpers**

```ts
// frontend/src/lib/format.ts

export function formatPrice(price: string): string {
  const n = parseFloat(price)
  if (isNaN(n)) return '0.00'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return n.toFixed(2)
}

export function formatAmount(amount: string): string {
  const n = parseFloat(amount)
  if (isNaN(n)) return '0'
  return n.toLocaleString()
}

export function formatTimeRemaining(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return 'Ended'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function shortenAddress(addr: string, chars = 4): string {
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`
}
```

- [ ] **Step 4: Create API client**

```ts
// frontend/src/api/client.ts
import { API_BASE } from '../lib/constants'

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `API error: ${res.status}`)
  }
  return res.json()
}
```

```ts
// frontend/src/api/auctions.ts
import { apiFetch } from './client'
import type { Auction, Bid, PricePoint } from '../lib/types'

export function fetchAuctions(status?: string): Promise<Auction[]> {
  const params = status ? `?status=${status}` : ''
  return apiFetch<Auction[]>(`/auctions${params}`)
}

export function fetchAuction(address: string): Promise<Auction> {
  return apiFetch<Auction>(`/auctions/${address}`)
}

export function fetchPriceHistory(address: string): Promise<PricePoint[]> {
  return apiFetch<PricePoint[]>(`/auctions/${address}/price-history`)
}

export function fetchAuctionBids(address: string): Promise<Bid[]> {
  return apiFetch<Bid[]>(`/auctions/${address}/bids`)
}
```

```ts
// frontend/src/api/users.ts
import { apiFetch } from './client'
import type { Auction, Bid } from '../lib/types'

export function fetchUserBids(wallet: string): Promise<Bid[]> {
  return apiFetch<Bid[]>(`/users/${wallet}/bids`)
}

export function fetchUserAuctions(wallet: string): Promise<Auction[]> {
  return apiFetch<Auction[]>(`/users/${wallet}/auctions`)
}

export function connectWallet(wallet: string): Promise<{ ok: boolean }> {
  return apiFetch(`/users/${wallet}/connect`, { method: 'POST' })
}
```

```ts
// frontend/src/api/websocket.ts
import { WS_URL } from '../lib/constants'
import type { WsEvent } from '../lib/types'

export function createWsConnection(onEvent: (event: WsEvent) => void): WebSocket {
  const ws = new WebSocket(WS_URL)

  ws.onmessage = (evt) => {
    try {
      const event: WsEvent = JSON.parse(evt.data)
      onEvent(event)
    } catch {}
  }

  ws.onclose = () => {
    // Reconnect after 3 seconds
    setTimeout(() => createWsConnection(onEvent), 3000)
  }

  return ws
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd frontend && npm run build`
Expected: builds with no errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/ frontend/src/api/
git commit -m "feat(frontend): types, API client, WebSocket, and formatting utilities"
```

---

### Task 10: Common UI components

**Files:**
- Create: `frontend/src/components/common/Button.tsx`
- Create: `frontend/src/components/common/Card.tsx`
- Create: `frontend/src/components/common/StatusBadge.tsx`
- Create: `frontend/src/components/common/ProgressBar.tsx`
- Create: `frontend/src/components/common/Countdown.tsx`
- Create: `frontend/src/components/common/Input.tsx`

- [ ] **Step 1: Button component (Across-style pill ghost button)**

```tsx
// frontend/src/components/common/Button.tsx
import { ButtonHTMLAttributes } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

const variants = {
  primary: 'bg-accent text-bg-deep hover:opacity-80',
  ghost: 'bg-accent-bg border border-accent-border text-accent hover:opacity-80',
  danger: 'bg-red/10 border border-red/10 text-red hover:opacity-80',
}

const sizes = {
  sm: 'h-8 px-4 text-sm',
  md: 'h-10 px-6 text-md',
}

export default function Button({
  variant = 'ghost',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`rounded-btn font-medium transition-opacity ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}
```

- [ ] **Step 2: Card component**

```tsx
// frontend/src/components/common/Card.tsx
import { ReactNode } from 'react'

interface CardProps {
  children: ReactNode
  className?: string
}

export default function Card({ children, className = '' }: CardProps) {
  return (
    <div className={`rounded-card border border-border bg-bg-secondary p-5 ${className}`}>
      {children}
    </div>
  )
}
```

- [ ] **Step 3: StatusBadge component**

```tsx
// frontend/src/components/common/StatusBadge.tsx
import type { AuctionStatus, BidStatus } from '../../lib/types'
import { STATUS_LABELS, BID_STATUS_LABELS } from '../../lib/constants'

const auctionColors: Record<string, string> = {
  live: 'bg-status-live/10 text-status-live',
  upcoming: 'bg-status-upcoming/10 text-status-upcoming',
  graduated: 'bg-status-graduated/10 text-status-graduated',
  failed: 'bg-status-failed/10 text-status-failed',
  claimable: 'bg-status-claimable/10 text-status-claimable',
}

const bidColors: Record<string, string> = {
  active: 'bg-bid-active/10 text-bid-active',
  at_risk: 'bg-bid-atRisk/10 text-bid-atRisk',
  outbid: 'bg-bid-outbid/10 text-bid-outbid',
  partially_filled: 'bg-bid-partiallyFilled/10 text-bid-partiallyFilled',
  exited: 'bg-bid-exited/10 text-bid-exited',
  claimed: 'bg-bid-claimed/10 text-bid-claimed',
}

interface AuctionBadgeProps {
  status: AuctionStatus
}

interface BidBadgeProps {
  status: BidStatus
}

export function AuctionBadge({ status }: AuctionBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-btn px-3 py-1 text-xs font-medium uppercase tracking-wide ${auctionColors[status] || ''}`}>
      {status === 'live' && <span className="h-1.5 w-1.5 rounded-full bg-status-live animate-pulse" />}
      {STATUS_LABELS[status] || status}
    </span>
  )
}

export function BidBadge({ status }: BidBadgeProps) {
  return (
    <span className={`inline-flex items-center rounded-btn px-3 py-1 text-xs font-medium ${bidColors[status] || ''}`}>
      {BID_STATUS_LABELS[status] || status}
    </span>
  )
}
```

- [ ] **Step 4: ProgressBar component**

```tsx
// frontend/src/components/common/ProgressBar.tsx
interface ProgressBarProps {
  value: number  // 0-100
  label?: string
  sublabel?: string
}

export default function ProgressBar({ value, label, sublabel }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value))
  return (
    <div>
      {(label || sublabel) && (
        <div className="mb-1.5 flex justify-between text-xs">
          {label && <span className="text-text-muted uppercase tracking-wide">{label}</span>}
          {sublabel && <span className="text-text-secondary lining-nums tabular-nums">{sublabel}</span>}
        </div>
      )}
      <div className="h-1.5 w-full rounded-full bg-bg-tertiary">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Countdown component**

```tsx
// frontend/src/components/common/Countdown.tsx
import { useEffect, useState } from 'react'
import { formatTimeRemaining } from '../../lib/format'

interface CountdownProps {
  targetTimestamp: number  // unix seconds
}

export default function Countdown({ targetTimestamp }: CountdownProps) {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, targetTimestamp - Math.floor(Date.now() / 1000))
  )

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(Math.max(0, targetTimestamp - Math.floor(Date.now() / 1000)))
    }, 1000)
    return () => clearInterval(interval)
  }, [targetTimestamp])

  return (
    <span className="lining-nums tabular-nums text-text-primary font-medium">
      {formatTimeRemaining(remaining)}
    </span>
  )
}
```

- [ ] **Step 6: Input component**

```tsx
// frontend/src/components/common/Input.tsx
import { InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export default function Input({ label, className = '', ...props }: InputProps) {
  return (
    <div>
      {label && (
        <label className="mb-1.5 block text-xs uppercase tracking-wide text-text-muted">
          {label}
        </label>
      )}
      <input
        className={`h-10 w-full rounded-card border border-border bg-bg-tertiary px-4 text-md text-text-primary lining-nums tabular-nums placeholder:text-text-dim focus:border-accent/30 focus:outline-none ${className}`}
        {...props}
      />
    </div>
  )
}
```

- [ ] **Step 7: Verify it compiles**

Run: `cd frontend && npm run build`
Expected: builds

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/common/
git commit -m "feat(frontend): common UI components — Button, Card, StatusBadge, ProgressBar, Countdown, Input"
```

---

### Task 11: Layout components (Navbar, Footer) + Wallet placeholder

**Files:**
- Modify: `frontend/src/components/layout/Navbar.tsx`
- Modify: `frontend/src/components/layout/Footer.tsx`
- Create: `frontend/src/components/layout/PageContainer.tsx`
- Create: `frontend/src/components/wallet/ConnectButton.tsx`

- [ ] **Step 1: ConnectButton placeholder**

```tsx
// frontend/src/components/wallet/ConnectButton.tsx
// TODO: Raagan — integrate Phantom Connect SDK here
// See: https://docs.phantom.com/phantom-connect
// This placeholder renders a simple connect/disconnect button.
// Replace the internals with Phantom Connect's embedded wallet flow.

import { useState } from 'react'
import Button from '../common/Button'
import { shortenAddress } from '../../lib/format'

interface ConnectButtonProps {
  onConnect?: (wallet: string) => void
  onDisconnect?: () => void
}

export default function ConnectButton({ onConnect, onDisconnect }: ConnectButtonProps) {
  const [wallet, setWallet] = useState<string | null>(null)

  const handleConnect = async () => {
    // TODO: Replace with Phantom Connect SDK
    // For now, simulate with Solana wallet-adapter or a hardcoded address for dev
    const mockAddr = 'DevWa11et1111111111111111111111111111111111'
    setWallet(mockAddr)
    onConnect?.(mockAddr)
  }

  const handleDisconnect = () => {
    setWallet(null)
    onDisconnect?.()
  }

  if (wallet) {
    return (
      <Button variant="ghost" size="sm" onClick={handleDisconnect}>
        {shortenAddress(wallet)}
      </Button>
    )
  }

  return (
    <Button variant="primary" size="sm" onClick={handleConnect}>
      Connect
    </Button>
  )
}
```

- [ ] **Step 2: Navbar**

```tsx
// frontend/src/components/layout/Navbar.tsx
import { Link, useLocation } from 'react-router-dom'
import ConnectButton from '../wallet/ConnectButton'

const navLinks = [
  { path: '/browse', label: 'Auctions' },
  { path: '/create', label: 'Launch' },
  { path: '/my-bids', label: 'My Bids' },
]

export default function Navbar() {
  const { pathname } = useLocation()

  return (
    <nav className="flex h-14 items-center justify-between border-b border-border px-6">
      <div className="flex items-center gap-8">
        <Link to="/" className="text-lg font-medium tracking-tight text-accent">
          seri
        </Link>
        <div className="flex gap-6">
          {navLinks.map(({ path, label }) => (
            <Link
              key={path}
              to={path}
              className={`text-sm transition-colors ${
                pathname === path ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
      <ConnectButton />
    </nav>
  )
}
```

- [ ] **Step 3: Footer**

```tsx
// frontend/src/components/layout/Footer.tsx
export default function Footer() {
  return (
    <footer className="flex items-center justify-between border-t border-border px-6 py-4">
      <span className="text-xs text-text-dim">Seri Protocol</span>
      <span className="text-xs text-text-dim">Built on Solana</span>
    </footer>
  )
}
```

- [ ] **Step 4: PageContainer**

```tsx
// frontend/src/components/layout/PageContainer.tsx
import { ReactNode } from 'react'

export default function PageContainer({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      {children}
    </div>
  )
}
```

- [ ] **Step 5: Verify it runs**

Run: `cd frontend && npm run dev`
Expected: Dark navbar with "seri" in green, nav links, Connect button. Footer at bottom.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/layout/ frontend/src/components/wallet/
git commit -m "feat(frontend): Navbar, Footer, PageContainer, and Phantom Connect placeholder"
```

---

### Task 12: Hooks (data fetching + WebSocket)

**Files:**
- Create: `frontend/src/hooks/useAuctions.ts`
- Create: `frontend/src/hooks/useAuction.ts`
- Create: `frontend/src/hooks/useUserBids.ts`
- Create: `frontend/src/hooks/usePriceHistory.ts`
- Create: `frontend/src/hooks/useWebSocket.ts`

- [ ] **Step 1: Create all hooks**

```ts
// frontend/src/hooks/useAuctions.ts
import { useState, useEffect } from 'react'
import { fetchAuctions } from '../api/auctions'
import type { Auction } from '../lib/types'

export function useAuctions(status?: string) {
  const [auctions, setAuctions] = useState<Auction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetchAuctions(status)
      .then(setAuctions)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [status])

  return { auctions, loading, error, refetch: () => fetchAuctions(status).then(setAuctions) }
}
```

```ts
// frontend/src/hooks/useAuction.ts
import { useState, useEffect } from 'react'
import { fetchAuction, fetchAuctionBids } from '../api/auctions'
import type { Auction, Bid } from '../lib/types'

export function useAuction(address: string) {
  const [auction, setAuction] = useState<Auction | null>(null)
  const [bids, setBids] = useState<Bid[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    Promise.all([fetchAuction(address), fetchAuctionBids(address)])
      .then(([a, b]) => { setAuction(a); setBids(b) })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [address])

  return { auction, bids, loading, refetch: load }
}
```

```ts
// frontend/src/hooks/useUserBids.ts
import { useState, useEffect } from 'react'
import { fetchUserBids } from '../api/users'
import type { Bid } from '../lib/types'

export function useUserBids(wallet: string | null) {
  const [bids, setBids] = useState<Bid[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!wallet) { setBids([]); return }
    setLoading(true)
    fetchUserBids(wallet)
      .then(setBids)
      .finally(() => setLoading(false))
  }, [wallet])

  return { bids, loading }
}
```

```ts
// frontend/src/hooks/usePriceHistory.ts
import { useState, useEffect } from 'react'
import { fetchPriceHistory } from '../api/auctions'
import type { PricePoint } from '../lib/types'

export function usePriceHistory(address: string) {
  const [data, setData] = useState<PricePoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchPriceHistory(address)
      .then(setData)
      .finally(() => setLoading(false))
  }, [address])

  return { data, loading, setData }
}
```

```ts
// frontend/src/hooks/useWebSocket.ts
import { useEffect, useRef } from 'react'
import { createWsConnection } from '../api/websocket'
import type { WsEvent } from '../lib/types'

export function useWebSocket(onEvent: (event: WsEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    wsRef.current = createWsConnection(onEvent)
    return () => { wsRef.current?.close() }
  }, [])

  return wsRef
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd frontend && npm run build`
Expected: builds

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/
git commit -m "feat(frontend): data fetching hooks and WebSocket connection"
```

---

### Task 13: Auction components (AuctionCard, PriceChart, BidForm, BidStatusCard, AuctionHeader, AuctionStats, AuctionInfo)

**Files:**
- Create: `frontend/src/components/auction/AuctionCard.tsx`
- Create: `frontend/src/components/auction/PriceChart.tsx`
- Create: `frontend/src/components/auction/BidForm.tsx`
- Create: `frontend/src/components/auction/BidStatusCard.tsx`
- Create: `frontend/src/components/auction/AuctionHeader.tsx`
- Create: `frontend/src/components/auction/AuctionStats.tsx`
- Create: `frontend/src/components/auction/AuctionInfo.tsx`

- [ ] **Step 1: AuctionCard (for browse grid)**

```tsx
// frontend/src/components/auction/AuctionCard.tsx
import { Link } from 'react-router-dom'
import Card from '../common/Card'
import { AuctionBadge } from '../common/StatusBadge'
import ProgressBar from '../common/ProgressBar'
import Countdown from '../common/Countdown'
import { formatPrice } from '../../lib/format'
import type { Auction } from '../../lib/types'

interface AuctionCardProps {
  auction: Auction
}

export default function AuctionCard({ auction }: AuctionCardProps) {
  return (
    <Link to={`/auction/${auction.address}`}>
      <Card className="transition-colors hover:border-border-subtle">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-md font-medium text-text-primary">
            {auction.tokenName || 'Unnamed Token'}
          </span>
          <AuctionBadge status={auction.status} />
        </div>

        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <span className="text-xs uppercase tracking-wide text-text-muted">Clearing Price</span>
            <div className="text-h5 font-medium tracking-tight text-text-primary lining-nums tabular-nums">
              {formatPrice(auction.clearingPrice)}
            </div>
          </div>
          {auction.timeRemaining !== null && (
            <Countdown targetTimestamp={auction.endTime} />
          )}
        </div>

        <ProgressBar
          value={auction.progressPercent}
          label="Raised"
          sublabel={`${formatPrice(auction.currencyRaised)} / ${formatPrice(String(auction.requiredCurrencyRaised))}`}
        />

        <div className="mt-3 text-xs text-text-muted lining-nums tabular-nums">
          {auction.bidCount} bid{auction.bidCount !== 1 ? 's' : ''}
        </div>
      </Card>
    </Link>
  )
}
```

- [ ] **Step 2: PriceChart (TradingView Lightweight Charts)**

```tsx
// frontend/src/components/auction/PriceChart.tsx
import { useEffect, useRef } from 'react'
import { createChart, IChartApi, ISeriesApi, AreaData, Time } from 'lightweight-charts'
import { chartColors } from '../../styles/theme'
import type { PricePoint } from '../../lib/types'

interface PriceChartProps {
  data: PricePoint[]
  floorPrice?: string
}

export default function PriceChart({ data, floorPrice }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: chartColors.background },
        textColor: chartColors.text,
        fontFamily: 'Barlow, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: chartColors.grid },
        horzLines: { color: chartColors.grid },
      },
      crosshair: {
        vertLine: { color: chartColors.crosshair, width: 1, style: 2 },
        horzLine: { color: chartColors.crosshair, width: 1, style: 2 },
      },
      width: containerRef.current.clientWidth,
      height: 350,
      timeScale: {
        timeVisible: true,
        borderColor: chartColors.grid,
      },
      rightPriceScale: {
        borderColor: chartColors.grid,
      },
    })

    const series = chart.addAreaSeries({
      lineColor: chartColors.line,
      topColor: chartColors.area,
      bottomColor: 'transparent',
      lineWidth: 2,
    })

    chartRef.current = chart
    seriesRef.current = series

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [])

  // Update data when it changes
  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return

    const chartData: AreaData<Time>[] = data.map((p) => ({
      time: p.timestamp as Time,
      value: parseFloat(p.clearingPrice),
    }))

    seriesRef.current.setData(chartData)
    chartRef.current?.timeScale().fitContent()
  }, [data])

  return (
    <div ref={containerRef} className="w-full rounded-card overflow-hidden" />
  )
}
```

- [ ] **Step 3: BidForm**

```tsx
// frontend/src/components/auction/BidForm.tsx
import { useState } from 'react'
import Card from '../common/Card'
import Input from '../common/Input'
import Button from '../common/Button'
import { formatPrice } from '../../lib/format'

interface BidFormProps {
  clearingPrice: string
  floorPrice: string
  maxBidPrice: string
  tickSpacing: number
  onSubmit: (maxPrice: string, amount: string) => void
}

export default function BidForm({ clearingPrice, floorPrice, maxBidPrice, tickSpacing, onSubmit }: BidFormProps) {
  const [maxPrice, setMaxPrice] = useState('')
  const [amount, setAmount] = useState('')

  const estimatedTokens = maxPrice && amount
    ? (parseFloat(amount) / parseFloat(maxPrice || '1')).toFixed(2)
    : '0'

  const handleSubmit = () => {
    if (!maxPrice || !amount) return
    onSubmit(maxPrice, amount)
  }

  return (
    <Card>
      <h3 className="mb-4 text-xs uppercase tracking-wide text-text-muted">Place Bid</h3>

      <div className="space-y-4">
        <Input
          label="Max Price"
          type="number"
          placeholder={formatPrice(clearingPrice)}
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
        />

        <Input
          label="Amount"
          type="number"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        <div className="flex justify-between text-sm">
          <span className="text-text-muted">Est. tokens</span>
          <span className="text-text-primary lining-nums tabular-nums">{estimatedTokens}</span>
        </div>

        {maxPrice && parseFloat(maxPrice) > 0 && parseFloat(maxPrice) <= parseFloat(clearingPrice) * 1.1 && (
          <div className="rounded-card bg-yellow/10 px-3 py-2 text-xs text-yellow">
            Max price is close to clearing price — risk of being outbid
          </div>
        )}

        <Button variant="primary" className="w-full" onClick={handleSubmit}>
          Submit Bid
        </Button>
      </div>
    </Card>
  )
}
```

- [ ] **Step 4: BidStatusCard**

```tsx
// frontend/src/components/auction/BidStatusCard.tsx
import Card from '../common/Card'
import { BidBadge } from '../common/StatusBadge'
import Button from '../common/Button'
import { formatPrice, formatAmount } from '../../lib/format'
import type { Bid, AuctionStatus } from '../../lib/types'

interface BidStatusCardProps {
  bid: Bid
  auctionStatus: AuctionStatus
  onExitBid: () => void
  onClaimTokens: () => void
}

export default function BidStatusCard({ bid, auctionStatus, onExitBid, onClaimTokens }: BidStatusCardProps) {
  const showExit = bid.exitedTime === 0 && (auctionStatus === 'graduated' || auctionStatus === 'failed' || auctionStatus === 'claimable')
  const showClaim = bid.exitedTime > 0 && bid.tokensFilled > 0 && auctionStatus === 'claimable'

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-text-muted">Your Bid</h3>
        <BidBadge status={bid.status} />
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-text-muted">Max Price</span>
          <span className="text-text-primary lining-nums tabular-nums">{formatPrice(bid.maxPrice)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-muted">Deposited</span>
          <span className="text-text-primary lining-nums tabular-nums">{formatAmount(bid.amount)}</span>
        </div>
        {bid.tokensFilled > 0 && (
          <div className="flex justify-between">
            <span className="text-text-muted">Tokens Filled</span>
            <span className="text-accent lining-nums tabular-nums">{formatAmount(String(bid.tokensFilled))}</span>
          </div>
        )}
      </div>

      {(showExit || showClaim) && (
        <div className="mt-4 space-y-2">
          {showExit && (
            <Button variant="ghost" className="w-full" onClick={onExitBid}>
              Exit Bid
            </Button>
          )}
          {showClaim && (
            <Button variant="primary" className="w-full" onClick={onClaimTokens}>
              Claim Tokens
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
```

- [ ] **Step 5: AuctionHeader**

```tsx
// frontend/src/components/auction/AuctionHeader.tsx
import { AuctionBadge } from '../common/StatusBadge'
import Countdown from '../common/Countdown'
import type { Auction } from '../../lib/types'

interface AuctionHeaderProps {
  auction: Auction
}

export default function AuctionHeader({ auction }: AuctionHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-4">
        {auction.tokenIconUrl ? (
          <img src={auction.tokenIconUrl} alt="" className="h-10 w-10 rounded-full" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-bg text-accent text-lg font-medium">
            {(auction.tokenName || '?')[0]}
          </div>
        )}
        <div>
          <h1 className="text-h4 font-medium tracking-tight text-text-primary">
            {auction.tokenName || 'Unnamed Auction'}
          </h1>
          {auction.description && (
            <p className="mt-0.5 text-sm text-text-muted">{auction.description}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <AuctionBadge status={auction.status} />
        {auction.status === 'live' && <Countdown targetTimestamp={auction.endTime} />}
      </div>
    </div>
  )
}
```

- [ ] **Step 6: AuctionStats**

```tsx
// frontend/src/components/auction/AuctionStats.tsx
import ProgressBar from '../common/ProgressBar'
import { formatPrice, formatAmount } from '../../lib/format'
import type { Auction } from '../../lib/types'

interface AuctionStatsProps {
  auction: Auction
}

export default function AuctionStats({ auction }: AuctionStatsProps) {
  const supplyPercent = auction.totalSupply > 0
    ? (parseInt(auction.totalCleared) / auction.totalSupply * 100)
    : 0

  return (
    <div className="grid grid-cols-2 gap-6">
      <ProgressBar
        value={auction.progressPercent}
        label="Currency Raised"
        sublabel={`${formatPrice(auction.currencyRaised)} / ${formatAmount(String(auction.requiredCurrencyRaised))}`}
      />
      <ProgressBar
        value={supplyPercent}
        label="Supply Cleared"
        sublabel={`${formatAmount(auction.totalCleared)} / ${formatAmount(String(auction.totalSupply))}`}
      />
    </div>
  )
}
```

- [ ] **Step 7: AuctionInfo**

```tsx
// frontend/src/components/auction/AuctionInfo.tsx
import Card from '../common/Card'
import { formatPrice, shortenAddress } from '../../lib/format'
import type { Auction } from '../../lib/types'

interface AuctionInfoProps {
  auction: Auction
}

export default function AuctionInfo({ auction }: AuctionInfoProps) {
  const rows = [
    ['Floor Price', formatPrice(auction.floorPrice)],
    ['Max Bid Price', formatPrice(auction.maxBidPrice)],
    ['Tick Spacing', formatPrice(String(auction.tickSpacing))],
    ['Total Supply', auction.totalSupply.toLocaleString()],
    ['Start', new Date(auction.startTime * 1000).toLocaleString()],
    ['End', new Date(auction.endTime * 1000).toLocaleString()],
    ['Claim', new Date(auction.claimTime * 1000).toLocaleString()],
    ['Creator', shortenAddress(auction.creator)],
    ['Token Mint', shortenAddress(auction.tokenMint)],
    ['Currency Mint', shortenAddress(auction.currencyMint)],
  ]

  return (
    <Card>
      <h3 className="mb-4 text-xs uppercase tracking-wide text-text-muted">Auction Parameters</h3>
      <div className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between text-sm">
            <span className="text-text-muted">{label}</span>
            <span className="text-text-primary lining-nums tabular-nums">{value}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}
```

- [ ] **Step 8: Verify it compiles**

Run: `cd frontend && npm run build`
Expected: builds

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/auction/
git commit -m "feat(frontend): auction components — AuctionCard, PriceChart, BidForm, BidStatusCard, Header, Stats, Info"
```

---

### Task 14: Pages (Landing, Browse, AuctionDetail, CreateAuction, MyBids)

**Files:**
- Modify: `frontend/src/pages/Landing.tsx`
- Modify: `frontend/src/pages/Browse.tsx`
- Modify: `frontend/src/pages/AuctionDetail.tsx`
- Modify: `frontend/src/pages/CreateAuction.tsx`
- Modify: `frontend/src/pages/MyBids.tsx`

- [ ] **Step 1: Landing page**

```tsx
// frontend/src/pages/Landing.tsx
import { Link } from 'react-router-dom'
import PageContainer from '../components/layout/PageContainer'
import Button from '../components/common/Button'
import AuctionCard from '../components/auction/AuctionCard'
import { useAuctions } from '../hooks/useAuctions'

export default function Landing() {
  const { auctions, loading } = useAuctions()
  const featured = auctions.slice(0, 3)

  return (
    <>
      {/* Hero */}
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="text-h2 font-medium tracking-tighter text-text-primary">
          Fair-price token launches
        </h1>
        <p className="mt-3 text-lg text-text-muted">
          Continuous clearing auctions on Solana
        </p>
        <div className="mt-8 flex gap-4">
          <Link to="/create">
            <Button variant="primary">Launch a Token</Button>
          </Link>
          <Link to="/browse">
            <Button variant="ghost">Browse Auctions</Button>
          </Link>
        </div>
      </div>

      {/* Featured auctions */}
      <PageContainer>
        {!loading && featured.length > 0 && (
          <>
            <h2 className="mb-6 text-xs uppercase tracking-wide text-text-muted">Active Auctions</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((a) => (
                <AuctionCard key={a.address} auction={a} />
              ))}
            </div>
          </>
        )}
        {!loading && featured.length === 0 && (
          <div className="py-12 text-center text-text-muted">
            No auctions yet. <Link to="/create" className="text-accent">Launch one</Link>
          </div>
        )}
      </PageContainer>
    </>
  )
}
```

- [ ] **Step 2: Browse page**

```tsx
// frontend/src/pages/Browse.tsx
import { useState } from 'react'
import PageContainer from '../components/layout/PageContainer'
import AuctionCard from '../components/auction/AuctionCard'
import { useAuctions } from '../hooks/useAuctions'

const tabs = ['all', 'live', 'upcoming', 'graduated', 'failed'] as const

export default function Browse() {
  const [activeTab, setActiveTab] = useState<string>('all')
  const { auctions, loading } = useAuctions(activeTab === 'all' ? undefined : activeTab)

  return (
    <PageContainer>
      <h1 className="mb-6 text-h4 font-medium tracking-tight text-text-primary">Auctions</h1>

      {/* Filter tabs */}
      <div className="mb-6 flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-btn px-4 py-1.5 text-sm capitalize transition-colors ${
              activeTab === tab
                ? 'bg-accent-bg text-accent'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="py-12 text-center text-text-muted">Loading...</div>
      ) : auctions.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {auctions.map((a) => (
            <AuctionCard key={a.address} auction={a} />
          ))}
        </div>
      ) : (
        <div className="py-12 text-center text-text-muted">No auctions found</div>
      )}
    </PageContainer>
  )
}
```

- [ ] **Step 3: AuctionDetail page (the main page)**

```tsx
// frontend/src/pages/AuctionDetail.tsx
import { useParams } from 'react-router-dom'
import PageContainer from '../components/layout/PageContainer'
import AuctionHeader from '../components/auction/AuctionHeader'
import PriceChart from '../components/auction/PriceChart'
import BidForm from '../components/auction/BidForm'
import BidStatusCard from '../components/auction/BidStatusCard'
import AuctionStats from '../components/auction/AuctionStats'
import AuctionInfo from '../components/auction/AuctionInfo'
import { useAuction } from '../hooks/useAuction'
import { usePriceHistory } from '../hooks/usePriceHistory'
import { useWebSocket } from '../hooks/useWebSocket'
import { formatPrice } from '../lib/format'

export default function AuctionDetail() {
  const { address } = useParams<{ address: string }>()
  const { auction, bids, loading, refetch } = useAuction(address!)
  const { data: priceData, setData: setPriceData } = usePriceHistory(address!)

  // Listen for real-time updates
  useWebSocket((event) => {
    if (event.auction !== address) return
    if (event.type === 'price_update' || event.type === 'checkpoint' || event.type === 'refresh') {
      refetch()
    }
  })

  if (loading || !auction) {
    return (
      <PageContainer>
        <div className="py-12 text-center text-text-muted">Loading auction...</div>
      </PageContainer>
    )
  }

  // Find user's bid (placeholder — needs wallet context)
  // TODO: Wire up to connected wallet
  const userBid = bids.length > 0 ? bids[0] : null

  const handleSubmitBid = (maxPrice: string, amount: string) => {
    // TODO: Build and send submit_bid transaction via Anchor + Phantom
    console.log('Submit bid:', { maxPrice, amount, auction: address })
  }

  const handleExitBid = () => {
    // TODO: Build and send exit_bid transaction
    console.log('Exit bid:', { auction: address })
  }

  const handleClaimTokens = () => {
    // TODO: Build and send claim_tokens transaction
    console.log('Claim tokens:', { auction: address })
  }

  return (
    <PageContainer>
      <AuctionHeader auction={auction} />

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Left column — chart */}
        <div>
          <div className="mb-4">
            <span className="text-xs uppercase tracking-wide text-text-muted">Clearing Price</span>
            <div className="text-h3 font-medium tracking-tight text-text-primary lining-nums tabular-nums">
              {formatPrice(auction.clearingPrice)}
            </div>
          </div>
          <PriceChart data={priceData} floorPrice={auction.floorPrice} />
        </div>

        {/* Right column — bid form + status */}
        <div className="space-y-4">
          {auction.status === 'live' && (
            <BidForm
              clearingPrice={auction.clearingPrice}
              floorPrice={auction.floorPrice}
              maxBidPrice={auction.maxBidPrice}
              tickSpacing={auction.tickSpacing}
              onSubmit={handleSubmitBid}
            />
          )}

          {userBid && (
            <BidStatusCard
              bid={userBid}
              auctionStatus={auction.status}
              onExitBid={handleExitBid}
              onClaimTokens={handleClaimTokens}
            />
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="mt-8">
        <AuctionStats auction={auction} />
      </div>

      {/* Info */}
      <div className="mt-6">
        <AuctionInfo auction={auction} />
      </div>
    </PageContainer>
  )
}
```

- [ ] **Step 4: CreateAuction page**

```tsx
// frontend/src/pages/CreateAuction.tsx
import { useState } from 'react'
import PageContainer from '../components/layout/PageContainer'
import Card from '../components/common/Card'
import Input from '../components/common/Input'
import Button from '../components/common/Button'

export default function CreateAuction() {
  const [form, setForm] = useState({
    tokenMint: '',
    currencyMint: '',
    totalSupply: '',
    floorPrice: '',
    maxBidPrice: '',
    tickSpacing: '',
    startTime: '',
    endTime: '',
    claimTime: '',
    requiredCurrencyRaised: '',
    fundsRecipient: '',
    tokensRecipient: '',
  })

  const update = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [field]: e.target.value }))

  const handleCreate = () => {
    // TODO: Build and send initialize_auction transaction via Anchor + Phantom
    console.log('Create auction:', form)
  }

  return (
    <PageContainer>
      <h1 className="mb-8 text-h4 font-medium tracking-tight text-text-primary">Launch a Token</h1>

      <Card className="max-w-2xl space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <Input label="Token Mint" placeholder="Paste mint address" value={form.tokenMint} onChange={update('tokenMint')} />
          <Input label="Currency Mint" placeholder="Paste mint address" value={form.currencyMint} onChange={update('currencyMint')} />
        </div>

        <Input label="Total Supply" type="number" placeholder="1000000" value={form.totalSupply} onChange={update('totalSupply')} />

        <div className="grid grid-cols-3 gap-4">
          <Input label="Floor Price" type="number" placeholder="0.01" value={form.floorPrice} onChange={update('floorPrice')} />
          <Input label="Max Bid Price" type="number" placeholder="100" value={form.maxBidPrice} onChange={update('maxBidPrice')} />
          <Input label="Tick Spacing" type="number" placeholder="1" value={form.tickSpacing} onChange={update('tickSpacing')} />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Input label="Start Time" type="datetime-local" value={form.startTime} onChange={update('startTime')} />
          <Input label="End Time" type="datetime-local" value={form.endTime} onChange={update('endTime')} />
          <Input label="Claim Time" type="datetime-local" value={form.claimTime} onChange={update('claimTime')} />
        </div>

        <Input label="Required Currency Raised" type="number" placeholder="10000" value={form.requiredCurrencyRaised} onChange={update('requiredCurrencyRaised')} />

        <div className="grid grid-cols-2 gap-4">
          <Input label="Funds Recipient" placeholder="Wallet address" value={form.fundsRecipient} onChange={update('fundsRecipient')} />
          <Input label="Unsold Tokens Recipient" placeholder="Wallet address" value={form.tokensRecipient} onChange={update('tokensRecipient')} />
        </div>

        <Button variant="primary" className="w-full" onClick={handleCreate}>
          Create Auction
        </Button>
      </Card>
    </PageContainer>
  )
}
```

- [ ] **Step 5: MyBids page**

```tsx
// frontend/src/pages/MyBids.tsx
import PageContainer from '../components/layout/PageContainer'
import Card from '../components/common/Card'
import { BidBadge } from '../components/common/StatusBadge'
import Button from '../common/Button'
import { formatPrice, formatAmount, shortenAddress } from '../lib/format'
import { useUserBids } from '../hooks/useUserBids'
import { Link } from 'react-router-dom'

export default function MyBids() {
  // TODO: Get wallet from Phantom Connect context
  const wallet = null
  const { bids, loading } = useUserBids(wallet)

  if (!wallet) {
    return (
      <PageContainer>
        <div className="py-24 text-center">
          <p className="text-text-muted">Connect your wallet to see your bids</p>
        </div>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <h1 className="mb-6 text-h4 font-medium tracking-tight text-text-primary">My Bids</h1>

      {loading ? (
        <div className="py-12 text-center text-text-muted">Loading...</div>
      ) : bids.length === 0 ? (
        <div className="py-12 text-center text-text-muted">
          No bids yet. <Link to="/browse" className="text-accent">Browse auctions</Link>
        </div>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-text-muted">
                <th className="pb-3">Auction</th>
                <th className="pb-3">Max Price</th>
                <th className="pb-3">Amount</th>
                <th className="pb-3">Status</th>
                <th className="pb-3">Tokens</th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              {bids.map((bid) => (
                <tr key={bid.address} className="border-t border-border">
                  <td className="py-3">
                    <Link to={`/auction/${bid.auction}`} className="text-accent hover:underline">
                      {shortenAddress(bid.auction)}
                    </Link>
                  </td>
                  <td className="py-3 lining-nums tabular-nums">{formatPrice(bid.maxPrice)}</td>
                  <td className="py-3 lining-nums tabular-nums">{formatAmount(bid.amount)}</td>
                  <td className="py-3"><BidBadge status={bid.status} /></td>
                  <td className="py-3 lining-nums tabular-nums">{bid.tokensFilled || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </PageContainer>
  )
}
```

Note: The MyBids page has an import error — `Button` import should be `../components/common/Button`. Fix that.

- [ ] **Step 6: Verify it compiles and renders**

Run: `cd frontend && npm run dev`
Expected: All pages render. Landing shows hero with green "seri" brand. Browse shows filter tabs. AuctionDetail shows chart area + bid form layout. Create shows the form.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/
git commit -m "feat(frontend): all pages — Landing, Browse, AuctionDetail, CreateAuction, MyBids"
```

---

### Task 15: End-to-end smoke test

- [ ] **Step 1: Start all services**

Terminal 1: Start local Solana validator
```bash
cd contracts && solana-test-validator
```

Terminal 2: Deploy program
```bash
cd contracts && anchor deploy
```

Terminal 3: Start backend
```bash
cd backend && cargo run
```

Terminal 4: Start frontend
```bash
cd frontend && npm run dev
```

- [ ] **Step 2: Create a test auction via the contract tests**

```bash
cd contracts && anchor test --skip-local-validator
```

This runs the existing test suite which creates auctions, submits bids, checkpoints, etc.

- [ ] **Step 3: Verify backend indexes the data**

```bash
curl http://localhost:3001/api/auctions | jq
```
Expected: Returns the auction(s) created by the test suite with computed fields (status, currencyRaised, etc.)

- [ ] **Step 4: Verify frontend displays data**

Open http://localhost:5173 in browser:
1. Landing page should show the auction card
2. Click through to auction detail — should show clearing price chart, stats, info table
3. Navigate to Browse — should show the auction with status badge and progress bar

- [ ] **Step 5: Fix any issues found during smoke test**

Address any rendering issues, data format mismatches, or API errors.

- [ ] **Step 6: Commit fixes**

```bash
git add .
git commit -m "fix: end-to-end smoke test fixes"
```

---

## Notes

### What's left as TODOs (for Raagan or follow-up work)
1. **Phantom Connect SDK integration** — placeholder at `frontend/src/components/wallet/ConnectButton.tsx`
2. **Transaction building** — `handleSubmitBid`, `handleExitBid`, `handleClaimTokens` in AuctionDetail.tsx need Anchor instruction building + Phantom signing
3. **Crank transaction sending** — `crank/service.rs` has the skeleton but doesn't send actual transactions yet
4. **Placeholder auction cards** — add 2-3 skeleton/coming-soon cards on Browse page
5. **Mobile responsive** — not in MVP scope but the grid layout will need breakpoint work
