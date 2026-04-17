# Seri Protocol — Backend & Frontend Design Spec

## Overview

Full-stack application layer for the Continuous Clearing Auction (CCA) Solana program. The on-chain program handles all auction logic; this spec covers the backend service (indexer, crank, API) and frontend (marketplace UI with real-time auction interaction).

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│  Vite + React + TypeScript + Tailwind                        │
│  Phantom Connect SDK  |  TradingView Lightweight Charts      │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Marketplace│  │ Auction Detail│  │ Create Auction Form  │  │
│  │  (browse)  │  │  (hero page)  │  │                      │  │
│  └──────────┘  └──────────────┘  └───────────────────────┘  │
└────────────────────────┬────────────────────────────────────┘
                         │ REST + WebSocket
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                     Backend (Rust / Axum)                     │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌──────────────┐  │
│  │ REST API │  │ WebSocket│  │ Crank  │  │   Indexer    │  │
│  │  Server  │  │  Server  │  │ Service│  │   Service    │  │
│  └────┬─────┘  └────┬─────┘  └───┬────┘  └──────┬───────┘  │
│       │              │            │               │          │
│       └──────────────┴────────────┴───────────────┘          │
│                           │                                  │
│                     ┌─────┴─────┐                            │
│                     │ PostgreSQL│                             │
│                     └─────┬─────┘                            │
└───────────────────────────┼──────────────────────────────────┘
                            │
                     ┌──────┴──────┐
                     │ Solana RPC  │
                     │ (validator) │
                     └─────────────┘
```

### Backend Services (single binary, multiple async tasks)

1. **Indexer** — subscribes to program accounts via `accountSubscribe` / polling, deserializes Anchor account data, writes to Postgres
2. **Crank** — periodically calls `checkpoint` instruction to advance auction state on-chain
3. **REST API** — serves cached data to frontend (auctions, bids, user data, chart history)
4. **WebSocket Server** — pushes real-time updates (price changes, new bids, state transitions) to connected frontends

### Why a single binary?

Hackathon simplicity. All four services run as tokio tasks in one process. The indexer and crank share an RPC client. The API and WS server share a DB pool. No orchestration needed.

---

## 2. Database Schema

```sql
-- Cached on-chain auction state
CREATE TABLE auctions (
    address         TEXT PRIMARY KEY,       -- auction PDA pubkey
    token_mint      TEXT NOT NULL,
    currency_mint   TEXT NOT NULL,
    creator         TEXT NOT NULL,
    total_supply    BIGINT NOT NULL,
    start_time      BIGINT NOT NULL,
    end_time        BIGINT NOT NULL,
    claim_time      BIGINT NOT NULL,
    floor_price     TEXT NOT NULL,          -- u128 as string
    max_bid_price   TEXT NOT NULL,
    required_currency_raised BIGINT NOT NULL,
    tick_spacing    BIGINT NOT NULL,

    -- Live state (updated by indexer)
    clearing_price  TEXT NOT NULL,
    sum_currency_demand TEXT NOT NULL,
    next_bid_id     BIGINT NOT NULL DEFAULT 0,
    last_checkpointed_time BIGINT NOT NULL,
    currency_raised_q64_x7 TEXT NOT NULL,
    total_cleared_q64_x7 TEXT NOT NULL,
    graduated       BOOLEAN NOT NULL DEFAULT FALSE,

    -- Metadata (off-chain, set by creator via API)
    token_name      TEXT,
    token_icon_url  TEXT,
    description     TEXT,

    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cached on-chain bids
CREATE TABLE bids (
    address         TEXT PRIMARY KEY,       -- bid PDA pubkey
    auction         TEXT NOT NULL REFERENCES auctions(address),
    bid_id          BIGINT NOT NULL,
    owner           TEXT NOT NULL,           -- bidder wallet
    max_price       TEXT NOT NULL,
    amount_q64      TEXT NOT NULL,
    start_time      BIGINT NOT NULL,
    start_cumulative_mps BIGINT NOT NULL,
    exited_time     BIGINT NOT NULL DEFAULT 0,
    tokens_filled   BIGINT NOT NULL DEFAULT 0,

    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bids_auction ON bids(auction);
CREATE INDEX idx_bids_owner ON bids(owner);

-- Checkpoints (for chart history)
CREATE TABLE checkpoints (
    address         TEXT PRIMARY KEY,
    auction         TEXT NOT NULL REFERENCES auctions(address),
    timestamp       BIGINT NOT NULL,
    clearing_price  TEXT NOT NULL,
    cumulative_mps  BIGINT NOT NULL,
    cumulative_mps_per_price TEXT NOT NULL,

    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checkpoints_auction_time ON checkpoints(auction, timestamp);

-- User wallet cache
CREATE TABLE users (
    wallet          TEXT PRIMARY KEY,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Price history for charts (derived from checkpoints, one row per interval)
CREATE TABLE price_history (
    auction         TEXT NOT NULL REFERENCES auctions(address),
    timestamp       BIGINT NOT NULL,
    clearing_price  TEXT NOT NULL,          -- human-readable (converted from Q64)
    currency_raised BIGINT NOT NULL,        -- human-readable
    total_cleared   BIGINT NOT NULL,
    PRIMARY KEY (auction, timestamp)
);
```

### Notes on u128 storage

Solana u128 values (prices, Q64 amounts) are stored as TEXT. The backend converts to human-readable numbers in API responses. The frontend never deals with raw Q64.

---

## 3. Backend API

### REST Endpoints

**Auctions**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auctions` | List auctions (filterable by status, currency, creator) |
| GET | `/api/auctions/:address` | Single auction detail (full state + computed fields) |
| GET | `/api/auctions/:address/price-history` | Chart data: `[{timestamp, price, raised, cleared}]` |
| GET | `/api/auctions/:address/bids` | All bids for an auction |

**User / Wallet**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/:wallet/bids` | All bids for a wallet (across auctions) |
| GET | `/api/users/:wallet/auctions` | Auctions created by this wallet |
| POST | `/api/users/:wallet/connect` | Register/update wallet last_seen |

**Auction Metadata (creator only)**
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auctions/:address/metadata` | Set token name, icon, description (signed by creator wallet) |

### Computed Fields in API Responses

The API returns pre-computed values so the frontend stays simple:

```json
// GET /api/auctions/:address
{
  "address": "...",
  "tokenMint": "...",
  "status": "live",                     // computed: upcoming|live|ended|graduated|failed|claimable
  "clearingPrice": "1.25",             // human-readable, converted from Q64
  "floorPrice": "0.50",
  "currencyRaised": "50000",           // human-readable
  "requiredCurrencyRaised": "100000",
  "progressPercent": 50.0,             // currencyRaised / required * 100
  "totalSupply": 1000000,
  "totalCleared": 500000,
  "supplyReleasedPercent": 45.0,       // from cumulative_mps
  "timeRemaining": 3600,              // seconds, null if ended
  "bidCount": 42,
  "tokenName": "SERI",
  "tokenIconUrl": "...",
  // ... all config fields
}
```

```json
// GET /api/users/:wallet/bids  (each bid)
{
  "address": "...",
  "auction": "...",
  "bidId": 3,
  "maxPrice": "2.00",
  "amount": "1000",                    // human-readable currency deposited
  "status": "active",                  // computed: active|at_risk|outbid|partially_filled|exited|claimed
  "estimatedTokens": 800,             // what you'd get if auction ended now
  "estimatedRefund": "200",
  "startTime": 1713300000,
  "exitedTime": 0,
  "tokensFilled": 0
}
```

### WebSocket Events

Client connects to `ws://host/ws` and subscribes to auction(s):

```json
// Client → Server: subscribe
{ "type": "subscribe", "auctions": ["<address>"] }

// Server → Client: price update
{ "type": "price_update", "auction": "<address>", "clearingPrice": "1.30", "timestamp": 1713300060 }

// Server → Client: new bid
{ "type": "new_bid", "auction": "<address>", "bidId": 43, "bidCount": 43 }

// Server → Client: state change
{ "type": "state_change", "auction": "<address>", "status": "graduated" }

// Server → Client: checkpoint
{ "type": "checkpoint", "auction": "<address>", "clearingPrice": "1.35", "currencyRaised": "55000", "supplyReleasedPercent": 50.0 }
```

---

## 4. Backend Internals

### Indexer

```
loop {
    1. Fetch all Auction accounts owned by program (getProgramAccounts with filters, or accountSubscribe)
    2. Deserialize each Anchor account (skip 8-byte discriminator, borsh deserialize)
    3. Upsert into auctions table
    4. For each auction, fetch associated bids and checkpoints
    5. Upsert bids, checkpoints
    6. Derive price_history rows from new checkpoints
    7. Broadcast changes to WebSocket subscribers
    8. Sleep 2-5 seconds (configurable)
}
```

For MVP, polling is fine. We can move to `accountSubscribe` (Solana WebSocket) for lower latency later.

### Crank

```
loop {
    1. Query DB for all live auctions (start_time <= now < end_time)
    2. For each, check if last_checkpointed_time is stale (> threshold seconds old)
    3. If stale, build and send checkpoint transaction
       - Derive checkpoint PDA for current timestamp
       - Sign with crank keypair (pays fees)
    4. Sleep 10-30 seconds (configurable per auction)
}
```

The crank keypair needs SOL for tx fees. For hackathon, airdrop on localnet/devnet.

### Anchor Account Deserialization

Use `anchor-client` or raw borsh deserialization to parse on-chain account data. Each account type has an 8-byte discriminator prefix followed by borsh-encoded fields. The backend knows the account layouts from the IDL.

---

## 5. Frontend Structure

```
frontend/
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx                    # entry point
    ├── App.tsx                     # router setup
    ├── api/                        # backend API client
    │   ├── client.ts               # axios/fetch wrapper, base URL config
    │   ├── auctions.ts             # auction endpoints
    │   ├── users.ts                # user/wallet endpoints
    │   └── websocket.ts            # WS connection + event handling
    ├── components/
    │   ├── layout/
    │   │   ├── Navbar.tsx           # logo, nav links, wallet connect button
    │   │   ├── Footer.tsx
    │   │   └── PageContainer.tsx
    │   ├── auction/
    │   │   ├── AuctionCard.tsx      # card for browse grid
    │   │   ├── PriceChart.tsx       # TradingView Lightweight Charts wrapper
    │   │   ├── BidForm.tsx          # max price + amount inputs
    │   │   ├── BidStatusCard.tsx    # current bid state + actions
    │   │   ├── AuctionStats.tsx     # progress bars, counters
    │   │   ├── AuctionHeader.tsx    # token info, status badge, countdown
    │   │   └── AuctionInfo.tsx      # params table, supply schedule
    │   ├── common/
    │   │   ├── StatusBadge.tsx      # colored auction/bid status badges
    │   │   ├── Countdown.tsx        # live countdown timer
    │   │   ├── ProgressBar.tsx      # reusable progress bar
    │   │   ├── Card.tsx             # base card component
    │   │   └── Button.tsx           # styled button variants
    │   └── wallet/
    │       └── ConnectButton.tsx    # Phantom Connect wrapper
    ├── hooks/
    │   ├── useAuction.ts            # fetch + subscribe to single auction
    │   ├── useAuctions.ts           # fetch auction list
    │   ├── useUserBids.ts           # fetch bids for connected wallet
    │   ├── useWebSocket.ts          # WS connection management
    │   └── usePriceHistory.ts       # fetch chart data
    ├── pages/
    │   ├── Landing.tsx              # hero + featured auctions
    │   ├── Browse.tsx               # auction grid with filters
    │   ├── AuctionDetail.tsx        # THE main page
    │   ├── CreateAuction.tsx        # auction creation form
    │   └── MyBids.tsx               # user's bids dashboard
    ├── lib/
    │   ├── format.ts                # number formatting, price display, time
    │   ├── constants.ts             # API URLs, program ID, status enums
    │   └── types.ts                 # TypeScript interfaces matching API responses
    └── styles/
        └── theme.ts                 # design tokens (exported as Tailwind config)
```

---

## 6. Design System (Tailwind Tokens)

```ts
// styles/theme.ts — extends tailwind.config.ts
// Inspired by Across Protocol's design language: dark, minimal, aqua/green accent
// Font: Barlow (same as Across) — clean, slightly condensed, technical feel
// Key patterns from Across:
//   - accent color at 5% opacity for subtle backgrounds (bg-accent/[.05])
//   - accent color borders also at 5% opacity
//   - pill-shaped buttons with ghost fills
//   - tight negative letter-spacing on headings
//   - grey-400 for labels/secondary text, light-100 for primary
//   - lining-nums tabular-nums on all numeric displays

const theme = {
  colors: {
    // Base — dark charcoal (not pure black — matches Across feel)
    bg: {
      primary: '#2D2E33',          // main background (Across grey-dark)
      secondary: '#34353B',        // card backgrounds (Across black-700)
      tertiary: '#3E4047',         // hover states, inputs (Across grey-600)
      deep: '#151518',             // footer, deepest backgrounds (Across black-800)
      border: '#ffffff08',         // ultra-subtle borders (Across white-translucent)
    },
    text: {
      primary: '#ffffff',          // headings, primary text
      secondary: '#C5D5E0',       // body text (Across light-300)
      muted: '#9DAAB3',           // labels, captions (Across grey-400)
      dim: '#4C4E57',             // disabled, placeholder (Across grey-500)
    },
    // Accent — Solana-green / Across-aqua hybrid
    accent: {
      primary: '#14f195',          // Solana green — primary CTAs, active states
      soft: '#6CF9D8',            // Across aqua — softer green for secondary elements
      bg: 'rgba(20, 241, 149, 0.05)',  // 5% opacity fills (Across pattern)
      border: 'rgba(20, 241, 149, 0.05)', // 5% opacity borders
    },
    // Status
    status: {
      live: '#14f195',
      upcoming: '#9DAAB3',         // grey
      graduated: '#14f195',
      failed: '#ef4444',
      claimable: '#6CF9D8',        // soft aqua
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
    // Chart
    chart: {
      line: '#14f195',
      area: 'rgba(20, 241, 149, 0.06)',
      grid: '#3E4047',
    },
  },
  // Typography — Barlow font, tight letter-spacing on headings
  fontSize: {
    xs: ['0.75rem', '1.05rem'],       // 12px — small labels
    sm: ['0.875rem', '1.225rem'],     // 14px — body small
    md: ['1rem', '1.4rem'],           // 16px — body
    lg: ['1.125rem', '1.575rem'],     // 18px — body large
    'heading-5': ['1.25rem', '1.375rem'],   // 20px
    'heading-4': ['1.5rem', '1.65rem'],     // 24px
    'heading-3': ['2rem', '2.2rem'],        // 32px
    'heading-2': ['3rem', '3.3rem'],        // 48px — hero
  },
  letterSpacing: {
    tight: '-0.04rem',             // headings
    tighter: '-0.12rem',           // large headings
    wide: '0.12rem',               // uppercase labels (like Across footer labels)
  },
  spacing: {
    page: '2rem',
    card: '1.25rem',
    section: '2.5rem',
  },
  borderRadius: {
    card: '0.75rem',
    button: '9999px',              // pill buttons (Across pattern)
    badge: '9999px',
  },
  // Glow effects (from Across dropShadow-aqua)
  dropShadow: {
    glow: [
      '0px 0px 13.8px #14f195',
      '0px 0px 9.8px #00A27C',
      '0px 0px 2.6px rgba(0, 0, 0, 0.25)',
    ],
    'glow-sm': [
      '0px 0px 8.3px #14f195',
      '0px 0px 5.9px #00A27C',
      '0px 0px 1.6px rgba(0, 0, 0, 0.25)',
    ],
  },
};
```

All components use these tokens via Tailwind classes (extended in config). No hardcoded colors anywhere.

### Font

**Barlow** (Google Fonts) — same font Across uses. Clean, slightly condensed, technical feel. Weights: 300 (light), 400 (regular), 500 (medium).

### Key styling patterns (borrowed from Across)

- **Ghost buttons**: pill-shaped, `bg-accent/[.05] border-accent/[.05]` — barely visible fill, hover with `opacity-80`
- **Numeric text**: always `lining-nums tabular-nums` for alignment
- **Uppercase labels**: `text-xs uppercase tracking-wide text-muted` for section headers, filter labels
- **Cards**: `bg-secondary` with `border border-border` — ultra-subtle separation
- **Glow accents**: green drop-shadow on primary CTAs and live indicators (sparingly)

---

## 7. Page Designs

### 7.1 Landing Page

- Dark background, hero section: "Fair-price token launches on Solana"
- Two CTAs: "Launch a Token" / "Browse Auctions"
- Below: grid of 3 featured/active auction cards (1 real, 2 placeholder)
- Minimal — gets users to the auction page fast

### 7.2 Browse Auctions

- Grid of `AuctionCard` components (3 columns desktop, 1 mobile)
- Top bar: status filter tabs (All | Live | Upcoming | Ended), sort dropdown
- Cards show: token name, status badge, clearing price, time remaining, progress bar
- 1 real auction card is interactive, rest are skeleton/placeholder cards with "Coming Soon" overlay

### 7.3 Auction Detail Page (primary page)

Layout (desktop — two columns):

```
┌─────────────────────────────────────────────────────┐
│  AuctionHeader                                       │
│  [Token Icon] Token Name    [Status Badge] [Timer]   │
├──────────────────────────────┬──────────────────────┤
│                              │                      │
│  PriceChart                  │  BidForm             │
│  (TradingView lightweight)   │  - Max price input   │
│  Clearing price over time    │  - Amount input      │
│  ~60% width                  │  - Est. tokens       │
│                              │  - Submit button     │
│                              │                      │
│                              ├──────────────────────┤
│                              │                      │
│                              │  BidStatusCard       │
│                              │  (if has active bid) │
│                              │  - Status, amounts   │
│                              │  - Action buttons    │
│                              │                      │
├──────────────────────────────┴──────────────────────┤
│                                                      │
│  AuctionStats (full width)                           │
│  [Supply Released ████░░░░ 45%]  [Raised ██░░ 50%]  │
│                                                      │
├──────────────────────────────────────────────────────┤
│                                                      │
│  AuctionInfo                                         │
│  Parameters table + supply schedule                  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**PriceChart details:**
- TradingView Lightweight Charts `createChart` with `addAreaSeries`
- X axis: time (auction start → end)
- Y axis: clearing price (human-readable)
- Floor price shown as horizontal dashed line
- Data from `/api/auctions/:address/price-history`
- Real-time updates via WebSocket `price_update` events appended to series
- Extensible: more series/charts can be added below (demand curve, supply released, etc.)

**Post-auction state:**
- Chart stays visible (historical)
- BidForm replaced with claim/refund actions
- Status badge updates to Graduated/Failed
- BidStatusCard shows final tokens + refund amounts

### 7.4 Create Auction Page

Single-page form with sections:
1. **Token** — mint address input (paste or select from wallet)
2. **Currency** — dropdown/input for accepted currency mint
3. **Pricing** — floor price, max bid price, tick spacing
4. **Schedule** — start time, end time, claim time (datetime pickers)
5. **Supply** — total supply, supply schedule (linear only for MVP)
6. **Goal** — required currency raised
7. **Recipients** — funds recipient, unsold tokens recipient
8. **Review** — summary of all params before confirm

Submit builds and sends the `initialize_auction` transaction via Phantom.

### 7.5 My Bids Dashboard

- Table/card list of all user bids across auctions
- Columns: auction name, max price, amount, status, estimated tokens, actions
- Quick action buttons: Exit Bid, Claim Tokens (contextual)
- Data from `/api/users/:wallet/bids`

---

## 8. Frontend ↔ Solana Transactions

The frontend sends transactions directly to Solana (not through the backend). The backend is read-only from the frontend's perspective (except metadata POST).

| Action | Transaction | Built by frontend |
|--------|------------|-------------------|
| Create auction | `initialize_auction` | Yes — form params → instruction data |
| Place bid | `submit_bid` | Yes — bid params → instruction data |
| Exit bid | `exit_bid` or `exit_partially_filled_bid` | Yes — derives PDAs from bid data |
| Claim tokens | `claim_tokens` | Yes — derives PDAs |
| Checkpoint | `checkpoint` | No — crank does this |

For building transactions, the frontend uses the Anchor IDL TypeScript client (already generated in `contracts/target/types/`). The frontend imports these types and uses `@coral-xyz/anchor` to build instructions.

---

## 9. Real-Time Data Flow

```
On-chain state changes (new bid, checkpoint, exit)
        │
        ▼
  Indexer (polls every 2-5s)
        │
        ├─── Upserts to Postgres
        │
        └─── Broadcasts to WebSocket hub
                    │
                    ▼
            Connected frontends receive events
                    │
                    ├─── Update React state (auction, bids)
                    └─── Append to chart series
```

Latency budget: ~3-7 seconds from on-chain tx confirmation to frontend update. Acceptable for an auction that runs minutes to hours.

---

## 10. Crank Strategy

The crank is critical — without it, the auction's checkpoint state goes stale and the clearing price doesn't update.

- **Frequency:** every 10-30 seconds for live auctions (configurable)
- **Smart scheduling:** more frequent when demand is changing fast (new bids detected), less frequent when idle
- **End-of-auction:** crank sends a final checkpoint at `end_time` and triggers graduation check
- **Fee source:** crank keypair funded with SOL (airdrop on localnet/devnet)
- **Single auction for MVP:** the crank just targets the one real auction

---

## 11. Scope for MVP (Hackathon)

### In scope
- Backend: indexer, crank, REST API, WebSocket server, Postgres
- Frontend: landing, browse (1 real + placeholders), auction detail (full), create auction, my bids
- Phantom Connect wallet integration
- Clearing price chart (TradingView)
- Full bid lifecycle: submit, monitor, exit, claim
- Design tokens + consistent styling

### Out of scope (later)
- Mobile optimization
- Notifications / alerts
- Advanced supply schedule builder
- Social features
- Token metadata from on-chain registries (Metaplex)
- Multiple simultaneous real auctions
- Analytics dashboard for creators
- Rate limiting / auth beyond wallet signature

---

## 12. Key Dependencies

### Backend (Cargo.toml)
- `axum` — HTTP + WebSocket server
- `tokio` — async runtime
- `sqlx` — Postgres driver (compile-time checked queries)
- `solana-client` / `solana-sdk` — RPC interaction
- `anchor-client` — Anchor account deserialization
- `serde` / `serde_json` — serialization
- `tower-http` — CORS middleware
- `tracing` — structured logging

### Frontend (package.json)
- `react` + `react-dom` + `react-router-dom`
- Phantom Connect SDK — wallet connection (TODO: Raagan to integrate per Phantom docs, leave placeholder hook)
- `@coral-xyz/anchor` — transaction building + IDL types
- `@solana/web3.js` — Solana primitives
- `lightweight-charts` — TradingView charts
- `tailwindcss` — styling
- `axios` or native fetch — API calls
