# CCA

1. We create an auction with token_supply, token, addresses for sweeps, tickSpacing and auctionSteps
2. floorPrice - startingPrice of the auction
3. tickSpacing - granularity for allowed ticks(prices) minimum allowed val is 2
  3.1. lets say floorPrice is 10 and tickSpacing is 5, on every bid the maxPrice should be chosen by the bidder in a way that bidMaxPrice = floorPrice + (k* tickSpacing)
4. Ticks - hold the data for one particular tick/price - it holds totalCurrencyDemand at that tick from every bid
5. AuctionSteps - determine how much tokens are released per block
6. Checkpoint - is a snapshot of the auction at any given time which sees
  6.1. 
``Steps decide how much supply is up for sale between two checkpoints; ticks decide at what price the demand curve currently clears; checkpoints are the moments when those two facts collide and actual tokens get sold``


Ticks are used in one critical place: _iterateOverTicksAndFindClearingPrice(), which runs inside every checkpoint.

  What it does

  The clearing price formula is:

  clearingPrice = $sumCurrencyDemandAboveClearingQ96 / TOTAL_SUPPLY

  But as the clearing price rises (because new demand came in), some ticks that were previously above clearing may
  now be at or below it — they got outbid. Their demand no longer counts toward the "above clearing" sum. The tick
  linked list is how the contract efficiently finds and removes them.

  The walk

  The linked list is sorted ascending by price. $nextActiveTickPrice points to the lowest tick that's still above
  clearing. The algorithm:

  1. New demand arrives → sumCurrencyDemandAboveClearing increases → clearing price rises
  2. Check: is $nextActiveTickPrice still above the new clearing price?
  3. If no — that tick just got outbid:
    - Subtract its currencyDemandQ96 from sumCurrencyDemandAboveClearing
    - Advance $nextActiveTickPrice = tick.next (move up the linked list)
    - Recalculate clearing price with reduced demand
    - Repeat from (2) — the next tick might also be outbid now
  4. If yes — stable. Done.

  This is why ticks exist as a sorted linked list rather than just a flat mapping — the contract needs to walk
  upward from the cheapest active tick to peel off outbid price levels one by one until the clearing price
  stabilizes.

  Where else ticks matter

  - submitBid — inserts/updates a tick (adds demand)
  - forceIterateOverTicks(priceHint) — the anti-DoS escape hatch. If so many ticks got outbid in one jump that a
  single checkpoint would run out of gas walking them all, anyone can call this to manually advance the tick pointer
   in a separate transaction with a price hint.

  That's it. Ticks serve exactly one purpose: maintaining a sorted index of demand-by-price so the clearing price
  loop can efficiently shed outbid price levels. Once the auction ends, ticks are never touched again — exits use
  checkpoint accumulators, not ticks.


