// Shapes mirror docs/specs/2026-04-17-backend-frontend-design.md §5.
// Backend converts Q64 on-chain values to human-readable strings before
// sending; the frontend never sees raw Q64.

export type AuctionStatus =
  | "upcoming"
  | "live"
  | "ended"
  | "graduated"
  | "failed"
  | "claimable";

export type BidStatus =
  | "active"
  | "at_risk"
  | "outbid"
  | "partially_filled"
  | "exited"
  | "claimed";

export interface Auction {
  address: string;
  tokenMint: string;
  tokenName: string;
  tokenSymbol: string;
  tokenTagline?: string;
  tokenIconUrl?: string;
  tokenDescription?: string;
  creator: string;
  creatorWallet: string;

  status: AuctionStatus;

  clearingPrice: string; // human-readable decimal as string
  previousClearingPrice?: string;
  floorPrice: string;
  maxBidPrice: string;
  tickSpacing: string;

  currency: string; // e.g. "USDC"
  currencyRaised: string;
  requiredCurrencyRaised: string;
  progressPercent: number;

  totalSupply: number;
  totalCleared: number;
  supplyReleasedPercent: number;

  bidCount: number;
  activeBidders: number;

  startTime: number; // unix seconds
  endTime: number;
  claimTime: number;
  timeRemaining: number | null;

  fundRecipient?: string;
  unsoldRecipient?: string;
}

export interface PricePoint {
  t: number; // bucket index (monotonic)
  price: number;
  timestamp?: number; // unix seconds; optional for synthetic data
}

export interface BidBookRow {
  price: number;
  demand: number; // cumulative currency demanded at or above this price
  bids: number;
  isClearing?: boolean;
}

export interface Bid {
  address: string;
  auction: string;
  bidId: number;
  maxPrice: string;
  amount: string; // deposit in currency
  status: BidStatus;
  estimatedTokens: number;
  estimatedRefund: string;
  startTime: number;
  exitedTime: number;
  tokensFilled: number;
}

// ---- websocket events ----

export type WsEvent =
  | { type: "price_update"; auction: string; clearingPrice: string; timestamp: number }
  | { type: "new_bid"; auction: string; bidId: number; bidCount: number }
  | { type: "state_change"; auction: string; status: AuctionStatus }
  | {
      type: "checkpoint";
      auction: string;
      clearingPrice: string;
      currencyRaised: string;
      supplyReleasedPercent: number;
    };
