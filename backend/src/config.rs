use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub rpc_url: String,
    pub program_id: String,
    pub bind_addr: String,
    pub indexer_interval_secs: u64,
    pub cors_origin: String,
    pub crank_keypair_path: Option<String>,
    pub crank_interval_secs: u64,
    pub crank_staleness_secs: i64,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            database_url: env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5433/postgres".into()),
            rpc_url: env::var("SOLANA_RPC_URL")
                .unwrap_or_else(|_| "https://api.devnet.solana.com".into()),
            program_id: env::var("PROGRAM_ID")
                .unwrap_or_else(|_| "vZ6194M81Y4CsuQ43y5kShFu4udkjY3UekVnMKYAySm".into()),
            bind_addr: env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3001".into()),
            indexer_interval_secs: env::var("INDEXER_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(5),
            cors_origin: env::var("CORS_ORIGIN")
                .unwrap_or_else(|_| "http://localhost:5173".into()),
            crank_keypair_path: env::var("CRANK_KEYPAIR_PATH").ok(),
            crank_interval_secs: env::var("CRANK_INTERVAL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(15),
            crank_staleness_secs: env::var("CRANK_STALENESS_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(20),
        }
    }
}
