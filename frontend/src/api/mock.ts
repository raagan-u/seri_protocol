import type { Auction, Bid, BidBookRow, BidStatus, PricePoint } from "./types";

// Mirrors the synthetic data from the design handoff (data.jsx) so the UI has
// something to render before the backend is live.

export const MOCK_AUCTION: Auction = {
  address: "AucMock1111111111111111111111111111111111111",
  tokenMint: "7xKXMockMintAQUA111111111111111111111111mQr3",
  tokenName: "Aperture",
  tokenSymbol: "AQUA",
  tokenTagline: "Data availability for ZK-rollups",
  tokenDescription:
    "AQUA is the staking and data-fee token for the Aperture DA layer. 1.2B total supply — 8% (96M) is being distributed via this fair-price auction. Remaining allocation: 35% ecosystem, 22% team (4yr vest), 20% treasury, 15% investors (2yr vest).",
  creator: "Aperture Labs",
  creatorWallet: "3xNMockBidderWallet111111111111111111111bF92",

  status: "live",

  clearingPrice: "0.342",
  previousClearingPrice: "0.338",
  floorPrice: "0.18",
  maxBidPrice: "2.50",
  tickSpacing: "0.01",

  currency: "USDC",
  currencyRaised: "7840221",
  requiredCurrencyRaised: "12000000",
  progressPercent: 65.335175,

  totalSupply: 96_000_000,
  totalCleared: 96_000_000 * 0.47,
  supplyReleasedPercent: 47,

  bidCount: 1284,
  activeBidders: 962,

  startTime: Math.floor((Date.now() - 1000 * 60 * 60 * 18) / 1000),
  endTime: Math.floor((Date.now() + 1000 * 60 * 60 * 29 + 1000 * 60 * 47) / 1000),
  claimTime: Math.floor((Date.now() + 1000 * 60 * 60 * 30) / 1000),
  timeRemaining: 29 * 3600 + 47 * 60,

  fundRecipient: "Aperture Treasury · 9Ax…tRz7",
  unsoldRecipient: "Aperture Ecosystem · 4Nm…pK21",
};

function genPriceHistory(endPrice: number): PricePoint[] {
  const points: PricePoint[] = [];
  const n = 216;
  let p = 0.18;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let target: number;
    if (t < 0.12) target = 0.18 + t * 0.3;
    else if (t < 0.35) target = 0.22 + (t - 0.12) * 0.5;
    else if (t < 0.55) target = 0.28 + Math.sin(t * 18) * 0.015;
    else if (t < 0.78) target = 0.29 + (t - 0.55) * 0.18;
    else target = 0.33 + (t - 0.78) * 0.4;
    p = p * 0.78 + target * 0.22 + (Math.random() - 0.5) * 0.006;
    points.push({ t: i, price: Math.max(0.18, p) });
  }
  points[points.length - 1].price = endPrice;
  return points;
}

export const MOCK_PRICE_HISTORY: PricePoint[] = genPriceHistory(
  Number(MOCK_AUCTION.clearingPrice)
);

export const MOCK_BID_BOOK: BidBookRow[] = [
  { price: 0.5, demand: 142_000, bids: 18 },
  { price: 0.45, demand: 380_000, bids: 42 },
  { price: 0.42, demand: 610_000, bids: 61 },
  { price: 0.4, demand: 920_000, bids: 88 },
  { price: 0.38, demand: 1_420_000, bids: 127 },
  { price: 0.36, demand: 2_080_000, bids: 168 },
  { price: 0.35, demand: 2_690_000, bids: 201 },
  { price: 0.342, demand: 3_410_000, bids: 239, isClearing: true },
  { price: 0.33, demand: 4_120_000, bids: 274 },
  { price: 0.32, demand: 5_020_000, bids: 318 },
  { price: 0.3, demand: 6_180_000, bids: 389 },
  { price: 0.28, demand: 7_240_000, bids: 447 },
  { price: 0.25, demand: 8_510_000, bids: 528 },
  { price: 0.22, demand: 9_380_000, bids: 612 },
  { price: 0.2, demand: 10_120_000, bids: 698 },
  { price: 0.18, demand: 10_820_000, bids: 784 },
];

// Dev-only helper: a scenario selector to exercise every BidStatusCard mode
// without a tweaks panel. Selectable via `?bid=<mode>` URL param in main.tsx.
export type MockBidMode =
  | "none"
  | "active"
  | "at_risk"
  | "outbid"
  | "partially_filled"
  | "graduated"
  | "failed";

export function mockBid(mode: MockBidMode): Bid | null {
  if (mode === "none") return null;
  const base = {
    address: "BidMock111111111111111111111111111111111111",
    auction: MOCK_AUCTION.address,
    bidId: 1,
    exitedTime: 0,
    tokensFilled: 0,
  };
  const fourHoursAgoSec = Math.floor((Date.now() - 4 * 3600_000) / 1000);
  const twentyEightHoursAgoSec = Math.floor((Date.now() - 28 * 3600_000) / 1000);

  const map: Record<Exclude<MockBidMode, "none">, Bid> = {
    active: {
      ...base,
      maxPrice: "0.45",
      amount: "2500",
      status: "active",
      estimatedTokens: 7309.94,
      estimatedRefund: "0",
      startTime: fourHoursAgoSec,
    },
    at_risk: {
      ...base,
      maxPrice: "0.36",
      amount: "1800",
      status: "at_risk" as BidStatus,
      estimatedTokens: 5263.16,
      estimatedRefund: "0",
      startTime: Math.floor((Date.now() - 2 * 3600_000) / 1000),
    },
    // Outbid mid-auction: bidder was active and accruing, then clearing rose
    // above their max. They keep everything accrued before that point and can
    // either raise their max to resume or exit_partially_filled_bid to claim.
    outbid: {
      ...base,
      maxPrice: "0.32",
      amount: "1200",
      status: "outbid",
      estimatedTokens: 2843.75,
      estimatedRefund: "290",
      startTime: Math.floor((Date.now() - 6 * 3600_000) / 1000),
    },
    partially_filled: {
      ...base,
      maxPrice: "0.342",
      amount: "1500",
      status: "partially_filled",
      estimatedTokens: 2193.25,
      estimatedRefund: "750",
      startTime: Math.floor((Date.now() - 3 * 3600_000) / 1000),
    },
    graduated: {
      ...base,
      maxPrice: "0.45",
      amount: "2500",
      status: "claimed",
      estimatedTokens: 7309.94,
      estimatedRefund: "0",
      startTime: twentyEightHoursAgoSec,
      tokensFilled: 7309.94,
    },
    failed: {
      ...base,
      maxPrice: "0.45",
      amount: "2500",
      status: "exited",
      estimatedTokens: 0,
      estimatedRefund: "2500",
      startTime: twentyEightHoursAgoSec,
    },
  };

  return map[mode];
}
