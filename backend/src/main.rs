mod accounts;
mod api;
mod bid_tx;
mod config;
mod crank;
mod db;
mod indexer;
mod rpc;
mod ws;

use axum::routing::get;
use axum::Router;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{fmt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("backend=info,tower_http=info")))
        .init();

    let cfg = config::Config::from_env();
    tracing::info!("starting backend with config: {:?}", cfg);

    let db = db::connect(&cfg.database_url).await?;
    let rpc = rpc::RpcClient::new(cfg.rpc_url.clone());
    let ws_tx = ws::new_channel();

    tokio::spawn(indexer::run(
        rpc.clone(),
        db.clone(),
        ws_tx.clone(),
        cfg.program_id.clone(),
        Duration::from_secs(cfg.indexer_interval_secs),
    ));

    if let Some(path) = cfg.crank_keypair_path.as_deref() {
        match crank::load_keypair_from_file(path) {
            Ok(kp) => match cfg.program_id.parse() {
                Ok(program_id) => {
                    let crank_cfg = crank::CrankConfig {
                        program_id,
                        keypair: kp,
                        interval: Duration::from_secs(cfg.crank_interval_secs),
                        staleness_secs: cfg.crank_staleness_secs,
                    };
                    tokio::spawn(crank::run(rpc.clone(), db.clone(), crank_cfg));
                }
                Err(e) => tracing::error!("bad program_id for crank: {e}"),
            },
            Err(e) => tracing::error!("failed to load crank keypair at {path}: {e:#}"),
        }
    } else {
        tracing::info!("CRANK_KEYPAIR_PATH not set, crank disabled");
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_state = api::ApiState { db: db.clone() };

    let api_router = Router::new()
        .route("/auctions", get(api::list_auctions))
        .route("/auctions/:address", get(api::get_auction))
        .route("/auctions/:address/price-history", get(api::get_price_history))
        .route("/auctions/:address/bid-book", get(api::get_bid_book))
        .route("/auctions/:address/bids", get(api::get_auction_bids))
        .route("/auctions/:address/metadata", axum::routing::post(api::set_metadata))
        .route("/auctions/:address/bid/build-tx", axum::routing::post(bid_tx::build_bid_tx))
        .route("/users/:wallet/bids", get(api::get_user_bids))
        .route("/users/:wallet/auctions", get(api::get_user_auctions))
        .route("/users/:wallet/connect", axum::routing::post(api::wallet_connect))
        .route("/health", get(api::health))
        .with_state(api_state);

    let app = Router::new()
        .nest("/api", api_router)
        .route("/ws", get(ws::ws_handler))
        .with_state(ws_tx)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(&cfg.bind_addr).await?;
    tracing::info!("listening on http://{}", cfg.bind_addr);
    axum::serve(listener, app).await?;
    Ok(())
}
