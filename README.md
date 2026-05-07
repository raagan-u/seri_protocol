# Seri Protocol

A fair-price token launch platform on Solana. Instead of "first come, first
served" sales — where bots and insiders win the floor — Seri runs a
**Continuous Clearing Auction (CCA)**: everyone bids what they're willing to
pay, and a single market-discovered price applies to all winners.

## What is a Continuous Clearing Auction?

Picture a Dutch auction running side-by-side with a live order book:

- The token's supply is **drip-released** over the auction window according to
  a schedule the creator picks (linear, frontloaded, etc.).
- Anyone can place a bid that says "I'll pay up to **X per token** with
  **Y of currency**."
- At every moment there is a single **clearing price** — the lowest price at
  which the cumulative supply released so far meets cumulative demand.
- As more demand arrives, the clearing price walks up. Bids whose max price
  was below the new clearing stop accruing tokens (they're "outbid"); the
  currency they deposited becomes refundable.
- When the auction ends, every winning bidder pays the **same final clearing
  price**, regardless of what they bid. If you bid higher than clearing, the
  difference is refunded.

Outcome for a bidder, given their max price vs. the final clearing price:

| Max price vs. clearing | What you get |
|---|---|
| Above clearing | Full fill at clearing; refund of the bid-vs-clearing difference |
| Equal to clearing | Partial fill (pro-rata at the clearing tick); refund of the unfilled portion |
| Below clearing | Outbid; full currency refund, no tokens |

A "graduation" check at end-of-auction enforces a creator-set fundraising
minimum: if total raised at clearing falls short, **everyone is fully refunded**
and no tokens are distributed.

> **Scope note:** This hackathon build covers price discovery, bid lifecycle,
> graduation, and claim/refund. **Bootstrapping liquidity from the raised
> currency** (auto-seeding a Raydium/Orca pool, paired LP minting, etc.) is
> *not* in scope. After a successful graduation, the creator sweeps the
> raised currency to their configured wallet and chooses what to do with it
> off-platform.

## Why this matters

- **Single fair price** for all buyers — no whale-vs-retail price gradient.
- **No race condition** at launch — bots can't beat human bidders to a fixed
  floor. The clearing price moves continuously as demand arrives.
- **Refunds are first-class** — overpayers, outbids, and failed-graduation
  bidders all redeem their currency back automatically.

## Repository layout

```
contracts/   Anchor program (the on-chain CCA implementation)
backend/     Axum REST + WebSocket server, Postgres indexer, on-chain crank
frontend/    Vite + React + TypeScript app (the marketplace UI)
docs/        Engineering specs (product brief, on-chain design, full-stack design)
```

Key components:

- **`contracts/programs/continuous_clearing_auction`** — the Anchor program.
  Auction, bid, tick, and checkpoint accounts; `initialize_auction`,
  `submit_bid`, `checkpoint`, `exit_bid`, `claim_bid`, `finalize_auction`.
- **`backend/src/indexer.rs`** — polls the chain and mirrors auction/bid/tick
  state into Postgres for fast UI queries.
- **`backend/src/crank.rs`** — periodically calls `checkpoint` on live
  auctions so price discovery keeps advancing without waiting for a bid.
- **`backend/src/{bid,exit,claim,init_tx,init_tx_block}.rs`** — build
  unsigned Solana transactions the frontend hands to the wallet to sign.
- **`frontend/src/pages/`** — Browse, AuctionDetail, CreateAuction, Docs.

## Auction modes

Auctions run in one of two time bases, picked at creation:

- **Time-based (`mode=0`)** — deltas measured in unix seconds. Default.
- **Block-based (`mode=1`)** — deltas measured in Solana slots. Useful when
  you need on-chain progress to be tied to network throughput rather than
  wall-clock.

The on-chain `auction_now()` helper returns either `clock.unix_timestamp` or
`clock.slot` accordingly; off-chain builders mirror that mapping when
constructing `params.now`.

## Running locally

Prereqs: Rust toolchain, Solana CLI, Anchor, Node 20+, Postgres.

```bash
# 1. On-chain program
cd contracts
anchor build && anchor deploy

# 2. Database + backend
cd ../backend
psql -f migrations.sql
cargo run

# 3. Frontend
cd ../frontend
npm install
npm run dev
```

Configuration (RPC URL, program ID, DB URL) is read from environment
variables; see `backend/src/config.rs`.

## Status

This is hackathon-stage software (Colosseum Frontier). The end-to-end happy
path works on devnet; rough edges and missing polish are expected.

**Explicitly out of scope for this hackathon:**

- Liquidity bootstrapping after graduation (DEX pool seeding, paired LP
  minting, lockup schedules). The protocol stops at "creator sweeps the
  raised currency"; what happens next is up to the creator.
- Validation hooks / bid gating (allowlists, KYC).
- Batch claim instructions (the client loops instead).
- `force_iterate_over_ticks` for very long tick lists.

## Further reading

The `docs/` directory contains the design specs that go several layers deeper
than this README:

- `docs/specs/2026-04-09-cca-product-brief-for-design.md` — user flows
- `docs/specs/2026-04-09-cca-solana-port-design.md` — on-chain account model
  and instruction surface
- `docs/specs/2026-04-17-backend-frontend-design.md` — full-stack architecture
