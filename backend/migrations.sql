-- Seri Protocol backend schema.
-- u128 on-chain values are stored as TEXT. Times are UNIX seconds as BIGINT.

CREATE TABLE IF NOT EXISTS auctions (
    address         TEXT PRIMARY KEY,
    token_mint      TEXT NOT NULL,
    currency_mint   TEXT NOT NULL,
    token_decimals  SMALLINT NOT NULL DEFAULT 0,
    currency_decimals SMALLINT NOT NULL DEFAULT 0,
    creator         TEXT NOT NULL,
    total_supply    BIGINT NOT NULL,
    start_time      BIGINT NOT NULL,
    end_time        BIGINT NOT NULL,
    claim_time      BIGINT NOT NULL,
    floor_price     TEXT NOT NULL,
    max_bid_price   TEXT NOT NULL,
    required_currency_raised BIGINT NOT NULL,
    tick_spacing    BIGINT NOT NULL,

    clearing_price  TEXT NOT NULL,
    sum_currency_demand TEXT NOT NULL,
    next_bid_id     BIGINT NOT NULL DEFAULT 0,
    last_checkpointed_time BIGINT NOT NULL,
    currency_raised_q64_x7 TEXT NOT NULL,
    total_cleared_q64_x7 TEXT NOT NULL,
    graduated       BOOLEAN NOT NULL DEFAULT FALSE,

    token_name      TEXT,
    token_symbol    TEXT,
    token_tagline   TEXT,
    token_icon_url  TEXT,
    description     TEXT,

    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bids (
    address         TEXT PRIMARY KEY,
    auction         TEXT NOT NULL,
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
    auction         TEXT NOT NULL,
    timestamp       BIGINT NOT NULL,
    clearing_price  TEXT NOT NULL,
    cumulative_mps  BIGINT NOT NULL,
    cumulative_mps_per_price TEXT NOT NULL,
    currency_raised_at_clearing_q64_x7 TEXT NOT NULL,

    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_auction_time ON checkpoints(auction, timestamp);

CREATE TABLE IF NOT EXISTS users (
    wallet      TEXT PRIMARY KEY,
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_history (
    auction         TEXT NOT NULL,
    timestamp       BIGINT NOT NULL,
    clearing_price  TEXT NOT NULL,
    currency_raised TEXT NOT NULL,
    total_cleared   TEXT NOT NULL,
    PRIMARY KEY (auction, timestamp)
);

-- Decimal-cache columns added after initial schema; safe to re-run.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS token_decimals    SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS currency_decimals SMALLINT NOT NULL DEFAULT 0;

-- Tick eviction support (post fix #3): store the active-tick pointer + every Tick account
-- so the crank / bid builder can compute the eviction queue off-chain.
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS next_active_tick_price TEXT NOT NULL
    DEFAULT '340282366920938463463374607431768211455'; -- u128::MAX sentinel

CREATE TABLE IF NOT EXISTS ticks (
    address              TEXT PRIMARY KEY,
    auction              TEXT NOT NULL,
    price                TEXT NOT NULL,
    next_price           TEXT NOT NULL,
    currency_demand_q64  TEXT NOT NULL,

    indexed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticks_auction ON ticks(auction);
