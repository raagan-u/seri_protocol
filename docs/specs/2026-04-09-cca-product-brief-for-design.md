# Continuous Clearing Auction — Product Brief for Design

## What Is This?

A fair-price token launch platform on Solana. Instead of a traditional "first come, first served" token sale (where bots and insiders win), this uses a **continuous clearing auction** — everyone bids what they're willing to pay, and the market finds a fair price over time.

Think of it like a Dutch auction meets a stock market opening — the price discovers itself based on real demand.

## Who Uses It?

### 1. Auction Creator (Token Launcher)
A project/team launching a new token. They configure:
- Which token they're selling, and how much
- What currency they accept (e.g., USDC, SOL)
- When the auction starts and ends
- A floor price (minimum price)
- A fundraising goal (minimum amount to raise for the auction to "succeed")
- A supply schedule (how fast tokens become available — e.g., slow at first, faster later)

### 2. Bidder (Token Buyer)
Someone who wants to buy the token at a fair price. They:
- Place a bid: "I'll pay up to **X price** for **Y amount** of currency"
- Watch the auction's clearing price move in real-time
- After the auction ends: claim their tokens (and get refunded any overpayment)

---

## Core Concept: How the Auction Works (Designer Must Understand This)

1. **Auction is live** — tokens are released gradually over time according to the creator's schedule
2. **Bidders place bids** — each bid says "I'll buy at up to this price" with a currency deposit
3. **Clearing price rises** — as more people bid, the price where supply meets demand goes up
4. **Bids can be outbid** — if the clearing price rises above your max price, your bid is no longer active (you'll get a refund)
5. **Auction ends** — final clearing price is set
6. **Graduation check** — did the auction raise enough currency? If yes: tokens are distributed. If no: everyone gets a full refund.
7. **Claim phase** — bidders claim their tokens and any currency refund (you paid your max price but the clearing price was lower = you get the difference back)

**Key insight for the designer:** A bidder's final outcome depends on where their max price sits relative to the final clearing price:
- **Max price > clearing price** → Fully filled. Gets tokens at clearing price, refund of the difference.
- **Max price = clearing price** → Partially filled. Gets some tokens, some refund.
- **Max price < clearing price** → Outbid. Full refund, no tokens.

---

## User Flows

### Flow 1: Create Auction

```
Landing Page → "Launch a Token" → Create Auction Form → Review & Confirm → Auction Created (shareable link)
```

**Create Auction Form fields:**
- Token to sell (select from wallet or paste mint address)
- Total supply to sell
- Currency to accept (USDC, SOL, etc.)
- Floor price (minimum starting price)
- Start time & End time (date/time pickers)
- Claim time (when bidders can claim — usually same as end time or slightly after)
- Fundraising goal (minimum currency to raise)
- Supply schedule (simple: "Linear" / advanced: custom steps)
- Fund recipient wallet
- Unsold token recipient wallet

### Flow 2: Browse / Discover Auctions

```
Landing Page → Browse Active Auctions → Auction Detail Page
```

**Auction card shows:**
- Token name/icon
- Status badge: Upcoming / Live / Ended / Graduated / Failed
- Current clearing price
- Time remaining (countdown)
- Total raised vs. goal (progress bar)
- Number of bids

### Flow 3: Place a Bid

```
Auction Detail Page → Connect Wallet → Enter Bid → Confirm Transaction → Bid Placed
```

**Bid form:**
- Max price (what's the most you'll pay per token)
- Amount (how much currency to deposit)
- Shows: estimated tokens you'd receive at current clearing price
- Warning if max price is close to current clearing price (risk of being outbid)

### Flow 4: Monitor Auction (Real-time)

```
Auction Detail Page — live updating
```

**What the bidder sees:**
- Live clearing price chart (price over time)
- Their bid status: Active / Partially Filled / Outbid
- Estimated tokens if auction ended now
- Supply released so far vs total (progress bar)
- Total currency raised vs goal (progress bar)
- Bid book / demand visualization

### Flow 5: Post-Auction (Claim / Refund)

```
Auction Detail Page (ended) → "Claim Tokens" or "Get Refund" → Confirm Transaction → Done
```

**If auction graduated (succeeded):**
- Show: tokens you received, currency refunded
- Button: "Claim Tokens"
- Button: "Exit Bid" (must exit before claiming)

**If auction failed (didn't meet goal):**
- Show: "Auction did not reach its fundraising goal"
- Button: "Get Full Refund"

### Flow 6: Creator Post-Auction

```
Auction Detail Page (ended) → "Sweep Funds" / "Sweep Unsold Tokens"
```

- If graduated: "Collect Raised Funds" button
- Always: "Collect Unsold Tokens" button

---

## Key Screens

### 1. Landing Page
- Hero: "Fair-price token launches on Solana"
- CTA: "Launch a Token" / "Browse Auctions"
- Featured/active auctions

### 2. Browse Auctions
- Grid/list of auction cards
- Filter: Status (Live / Upcoming / Ended), Currency, Sort by
- Search by token name or auction address

### 3. Auction Detail Page (THE most important screen)
This is where bidders spend most of their time. Needs to communicate:

**Header:**
- Token name, icon, description
- Status badge
- Countdown timer

**Price Section:**
- Current clearing price (big, prominent)
- Floor price
- Price chart over time (line chart, x = time, y = price)

**Supply & Demand Section:**
- Tokens released: X / Total (progress bar)
- Currency raised: X / Goal (progress bar with graduation threshold marked)
- Visual demand curve or bid book (prices on Y axis, demand on X axis)

**My Bid Section** (if connected + has bid):
- My max price
- My deposit
- Status: Active / Outbid / Partially Filled
- Estimated tokens at current price
- Action buttons: Exit Bid / Claim Tokens (contextual based on auction state)

**Bid Form** (if auction is live):
- Max price input
- Amount input
- Submit bid button

**Info Section:**
- Auction parameters (start, end, floor price, goal, tick spacing)
- Supply schedule visualization (stepped bar chart showing token release rate over time)
- Creator info / links

### 4. Create Auction Page
- Step-by-step form or single page with sections
- Preview of auction parameters before confirming
- Supply schedule builder (simple = linear slider, advanced = add custom steps)

### 5. My Bids Dashboard
- List of all bids across auctions
- Status of each
- Quick actions: claim, exit, refund

---

## States & Visual Indicators

### Auction States
| State | Visual | Description |
|---|---|---|
| **Upcoming** | Grey/Blue badge, countdown to start | Created but not started |
| **Live** | Green pulsing badge, countdown to end | Accepting bids |
| **Ended - Graduated** | Gold/Success badge | Raised enough, tokens distributing |
| **Ended - Failed** | Red badge | Didn't meet goal, refunds available |
| **Claimable** | Gold badge + CTA | Claim time reached, tokens ready |

### Bid States
| State | Visual | Description |
|---|---|---|
| **Active** | Green | Max price > clearing price, fully in the auction |
| **At Risk** | Yellow/Orange | Max price is close to clearing price |
| **Partially Filled** | Orange | Max price = clearing price |
| **Outbid** | Red | Max price < clearing price |
| **Exited** | Grey | Bid has been exited, awaiting claim |
| **Claimed** | Checkmark | Tokens claimed |

---

## Design Priorities (for MVP)

1. **Auction Detail Page** — this is 80% of the product. Get this right.
2. **Bid Form** — must be dead simple. Two inputs + submit.
3. **Price chart** — real-time clearing price over time. The signature visual.
4. **Claim/Refund flow** — clear, no confusion about what the user gets.
5. **Create Auction** — can be more utilitarian for MVP. Power users only at first.

## What Can Be Simple / Later

- Browse page can be a basic list for now
- No notifications/alerts for MVP
- No mobile optimization needed initially
- Supply schedule builder can default to "linear" with no custom option for MVP
- No social features (comments, sharing) needed

---

## Visual References & Inspiration

- **Auction/price discovery:** Pendle Finance (yield trading UI), Copper Launch (fair launch auctions)
- **Real-time charts:** any DEX trading view (Jupiter, Raydium)
- **Token launch platforms:** Pump.fun (simple UX), Legion (curated launches)
- **Bid/order book visualization:** any exchange order book

---

## Technical Notes for Frontend Dev (not for designer, but FYI)

- Solana blockchain — wallet connect via Phantom/Solflare
- All data reads from on-chain accounts (no backend needed for MVP)
- Real-time updates via Solana websocket subscriptions
- Price values are in Q64 fixed-point format (frontend converts to human-readable)
- Currency amounts in token base units (frontend converts using decimals)
