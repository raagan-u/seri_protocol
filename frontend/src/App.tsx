import { AuctionDetail } from "./pages/AuctionDetail";
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
  const auctionAddress =
    url.searchParams.get("auction") ?? "AucMock1111111111111111111111111111111111111";
  const wallet = url.searchParams.get("wallet");

  const bidParam = url.searchParams.get("bid") as MockBidMode | null;
  const mockBidMode: MockBidMode =
    bidParam && VALID_BID_MODES.includes(bidParam) ? bidParam : "active";

  return (
    <AuctionDetail
      auctionAddress={auctionAddress}
      wallet={wallet}
      mockBidMode={mockBidMode}
    />
  );
}
