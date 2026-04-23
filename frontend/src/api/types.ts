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

// ---- create auction (initialize) ----

export interface AuctionStepInput {
  mps: number;      // u32 weight per second
  duration: number; // u32 seconds
}

export type EmissionPreset =
  | "flat"
  | "frontloaded"
  | "backloaded"
  | "linear-decay";

// Shape posted to backend /api/auctions/build-init-tx. Decimals + Q64 scaling
// happen server-side from mint metadata; frontend sends human-readable decimals.
export interface InitializeAuctionParamsInput {
  totalSupply: string;            // decimal, e.g. "1000000"
  startTime: number;              // unix seconds
  endTime: number;
  claimTime: number;
  tickSpacing: number;            // integer, >= 2
  floorPrice: string;             // decimal, e.g. "0.40"
  requiredCurrencyRaised: string; // decimal in currency units
  tokensRecipient: string;        // base58 wallet
  fundsRecipient: string;         // base58 wallet
  steps: AuctionStepInput[];
}

export interface AuctionMetadataInput {
  tokenName: string;
  tokenSymbol: string;
  tokenTagline?: string;
  tokenDescription?: string;
  tokenIconUrl?: string;
}

export interface CreateAuctionPayload {
  creator: string;      // base58
  tokenMint: string;    // base58
  currencyMint: string; // base58
  preset: EmissionPreset;
  params: InitializeAuctionParamsInput;
  metadata: AuctionMetadataInput;
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
