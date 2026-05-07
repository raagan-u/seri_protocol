# Block-Based Emission Mode — PoC Design

**Date:** 2026-05-04
**Branch:** `feat/block_based_cca`
**Status:** Approved, ready for implementation planning

## Goal

Add a block-based (slot-based) emission mode to the Seri Protocol CCA, modeled
after the Uniswap CCA Ethereum implementation. The current system emits tokens
based on elapsed wall-clock time (seconds). The new mode emits tokens based on
elapsed Solana slots, making the auction's progress tied to chain progression
instead of real time.

This is a **proof of concept** that runs end-to-end (program + backend + frontend)
on the `feat/block_based_cca` branch, with minimal disruption to the existing
time-based path.

## Non-Goals

- Not replacing the time-based auction. Both modes coexist.
- Not unifying the storage / API into a single schema. The block-based path is
  fully parallel.
- Not optimizing the slot conversion (a fixed 0.4s/slot constant is sufficient
  for a PoC).
- Not adding new emission presets — block-based reuses the existing presets
  (flat, frontloaded, backloaded, linear-decay).

## Architecture Overview

Two parallel auction-creation paths:

```
Time-based (existing):
  Frontend → POST /api/auctions/build-init-tx → auctions table → on-chain steps in seconds

Block-based (new):
  Frontend → POST /api/auctions-block/build-init-tx → auctions_block table → on-chain steps in slots
```

The on-chain program is the same in both modes, but it now has an
`Auction.mode` byte (`0` = time, `1` = block) and dispatches its "current
auction time" reads through a small `auction_now()` helper that returns
`clock.unix_timestamp` in time mode and `clock.slot` in block mode. Steps are
still opaque `(mps, duration)` tuples — the unit (seconds vs slots) is
implicit in the auction's mode.

## Data Model

### On-chain: `Auction.mode` byte

A new `mode: u8` field on the `Auction` account (`0` = time, `1` = block).
`start_time` / `end_time` / `claim_time` (`i64`) hold Unix timestamps in time
mode and slot numbers in block mode. Steps are unchanged in shape.

### New backend schema: `auctions_block`

A separate Postgres table that mirrors the existing `auctions` schema. All
columns are identical, with two additions to support display:
- `mode_marker` column (always `'block'`) — so the indexer / API knows how to
  interpret the on-chain numeric fields.
- `display_start_time`, `display_end_time`, `display_claim_time` columns —
  the original Unix timestamps the user requested. The on-chain
  `start_time`/etc. columns hold slot numbers; these display columns let the
  UI render human times without re-deriving them from slots.

Step storage is the same shape as `auctions`, but `step.duration` is slot
count and `step.mps` is tokens/slot.

### Frontend types

The existing `AuctionStepInput`, `EmissionPreset`, and `CreateAuctionPayload`
types are reused for both modes. The interpretation depends on which API endpoint
the frontend calls.

## Program Changes

**Program changes are required, but small and localized.** The on-chain
program currently reads `clock.unix_timestamp` (seconds) in every instruction
that needs the current auction time. For block-based mode, those reads must
return `clock.slot` instead.

### Mode field on Auction account

Add a single byte to the `Auction` account state:

```rust
pub mode: u8,  // 0 = TIME, 1 = BLOCK
```

This is a struct extension. Because the PoC runs on a fresh devnet program
with no production accounts to migrate, we add the field and increment the
account size. New accounts get the field at initialization; old accounts on
the prior deployed program are abandoned (this is a hackathon — no migration
concerns).

### Clock dispatch

Introduce a tiny helper:

```rust
fn auction_now(auction: &Auction, clock: &Clock) -> i64 {
    match auction.mode {
        0 => clock.unix_timestamp,
        _ => clock.slot as i64,
    }
}
```

Replace every direct read of `clock.unix_timestamp` in the instructions that
operate on a live auction with `auction_now(&auction, &clock)`. Files affected:
- `submit_bid.rs`
- `exit_bid.rs`
- `exit_partially_filled_bid.rs`
- `checkpoint.rs`
- `claim_tokens.rs`
- `finalize_auction.rs`

`initialize.rs` also gets the dispatch — its existing "start_time must be in
the future" check becomes:
```rust
let now = if mode == 1 { clock.slot as i64 } else { clock.unix_timestamp };
require!(params.start_time > now, ...);
```
so it works for both modes (the helper isn't reused here because at
initialize time the mode is in `params`, not yet on the account).

### Initialize accepts mode

`initialize_auction` ix params gain a `mode: u8` field. The instruction stores
it on the `Auction` account. The `start_time` / `end_time` interpretation
follows the mode: Unix timestamps in time mode, slot numbers in block mode.

### Step semantics unchanged

Steps remain `(mps, duration)` tuples. The `duration` unit follows the auction
mode (seconds in time mode, slots in block mode). The on-chain step-resolution
math is unit-agnostic — it just compares step durations against
`(auction_now() - start_time)`.

### Validation invariants

The existing invariants (steps sum to total duration, weights sum to
`MPS_TOTAL = 10_000_000`) work identically in both modes.

## Backend API

### New endpoint

```
POST /api/auctions-block/build-init-tx
```

**Request body:** Identical to the existing `/api/auctions/build-init-tx`
(same `CreateAuctionPayload` shape).

**Behavior:**
1. Read `startTime`, `endTime`, `claimTime` from the request (Unix
   timestamps — user's intent in real-world time).
2. Fetch the **current slot** from the Solana RPC (`getSlot`).
3. Convert the time range to slot offsets using a fixed constant:
   ```
   SLOT_DURATION_SECS = 0.4
   now_seconds            = chrono::Utc::now().timestamp()
   slot_offset_to_start   = floor((startTime - now_seconds) / SLOT_DURATION_SECS)
   total_slots            = floor((endTime  - startTime)    / SLOT_DURATION_SECS)
   claim_slot_offset      = floor((claimTime - endTime)     / SLOT_DURATION_SECS)
   start_slot             = current_slot + slot_offset_to_start
   end_slot               = start_slot   + total_slots
   claim_slot             = end_slot     + claim_slot_offset
   ```
4. Build emission steps using the chosen preset, distributing
   `MPS_TOTAL = 10_000_000` across `total_slots` slots.
5. Each step's `duration` is slot count, `mps` is tokens per slot.
6. Pass `mode = 1`, `start_time = start_slot`, `end_time = end_slot`,
   `claim_time = claim_slot` to the on-chain `initialize_auction` instruction.
   These `i64` fields now hold slot numbers, not timestamps. The program
   compares them against `clock.slot` via the new `auction_now()` helper.
7. Persist the auction record into `auctions_block`. Store both:
   - On-chain values: `start_slot`, `end_slot`, `claim_slot`
   - Original Unix timestamps from the user request (for UI display, so we
     can show "started at 12:34pm" alongside the slot number).

### Validation

Validation is identical to the time-based path with one addition:
- If `total_slots < N` (where `N` is the number of phases in the chosen preset,
  e.g., 4 for `linear-decay`), reject with **"Auction duration too short for
  this preset"**.

All other checks (creator balance, mint validity, recipient validity, weight
sum) are unchanged.

### New backend module

A new `init_tx_block.rs` module in the backend that mirrors `init_tx.rs` but
calls a slightly different step-building function. Most logic is shared with
`init_tx.rs` via existing `tx_utils` helpers.

## Frontend UI

### Mode toggle

Add a radio toggle at the top of the CreateAuction form, above "Token identity":

```
Auction mode:
  ● Time-based     ○ Block-based
```

Only the **endpoint URL** the frontend posts to changes based on this toggle.
All other form fields, validations, and presets are identical.

### Date defaults (for both modes)

Update the `defaultForm()` factory to use shorter durations for quick testing:
- `startTime` = now + 5 minutes
- `endTime` = startTime + 5 minutes
- `claimTime` = startTime + 5 minutes

(Previously: end and claim were start + 24 hours.)

### Steps preview

For block-based auctions, augment the existing single-line preview:
```
4 emission steps generated · total 5m (≈ 750 slots)
```

The slot estimate is computed in the frontend: `floor(durationSec / 0.4)`.
The frontend math is purely informational — the backend recomputes
authoritatively.

## Error Handling

- **Slot conversion underflow** (auction too short): backend rejects with HTTP
  400 "Auction duration too short for this preset"; frontend surfaces the
  message in the existing error banner.
- **Step generation failures**: same error path as time-based — surfaced via
  the existing `errors.steps` field on the form.
- **Phantom signing / RPC errors**: identical handling to existing flow
  (sign with Phantom, send via configured devnet RPC).

## Testing

End-to-end test path on `feat/block_based_cca`:
1. Switch mode toggle to "Block-based".
2. Create an auction with default form values (5-minute duration).
3. Verify the transaction builds without panic.
4. Verify the auction account is created on-chain.
5. Open the auction detail page; verify clearing price and supply released
   update correctly as slots progress.
6. Submit a bid; verify the bid lifecycle works identically to time-based.

## Configuration Constants

| Constant | Value | Location |
|----------|-------|----------|
| `SLOT_DURATION_SECS` | `0.4` | Backend `init_tx_block.rs` and frontend preview |
| `MPS_TOTAL` | `10_000_000` | Existing — reused unchanged |
| `MIN_TICK_SPACING` | `2` | Existing — reused unchanged |

## Open Questions / Decisions Made

- **Q:** Use seconds or slots in the user-facing date pickers?
  **A:** Seconds. User picks start/end times; backend converts to slot count.
- **Q:** Same table as `auctions` with a mode flag, or separate table?
  **A:** Separate table (`auctions_block`) — cleaner for the PoC, easier to
  remove if the experiment fails.
- **Q:** Modify the on-chain program?
  **A:** Yes — minimally. Add a `mode: u8` byte to `Auction`, accept it in
  `initialize_auction`, and dispatch every `clock.unix_timestamp` read in the
  6 live-auction instructions through an `auction_now()` helper that returns
  `clock.slot as i64` when `mode == 1`. Step durations and validation
  invariants are unchanged. No account migration since this is hackathon
  devnet.
- **Q:** Default auction duration?
  **A:** 5 minutes (start at now+5m, end at now+10m, claim at now+10m) —
  short enough for live demo testing.

## Out of Scope (Future Work)

- Production-quality slot-time conversion (e.g., dynamic slot-time observation
  via RPC).
- Unifying time-based and block-based into a single auction type with a mode
  field.
- New presets specific to block-based emission (e.g., per-block linear decay).
- Migrating existing auctions between modes.
