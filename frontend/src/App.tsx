import { AuctionDetail } from "./pages/AuctionDetail";
import { Browse } from "./pages/Browse";
import type { MockBidMode } from "./api/mock";

const VALID_BID_MODES: MockBidMode[] = [
  "none",
  "active",
  "at_risk",
  "outbid",
  "partially_filled",
  "graduated",
  "failed",
];

export default function App() {
  const url = new URL(window.location.href);
  const auctionAddress = url.searchParams.get("auction");
  const wallet = url.searchParams.get("wallet");

  const bidParam = url.searchParams.get("bid") as MockBidMode | null;
  const mockBidMode: MockBidMode =
    bidParam && VALID_BID_MODES.includes(bidParam) ? bidParam : "active";

  if (!auctionAddress) return <Browse />;

  return (
    <AuctionDetail
      auctionAddress={auctionAddress}
      wallet={wallet}
      mockBidMode={mockBidMode}
    />
  );
}
