import { useEffect, useState } from "react";
import { Transaction } from "@solana/web3.js";
import type { Auction, Bid, BidBookRow, PricePoint } from "../api/types";
import {
  buildBidTx,
  fetchAuction,
  fetchBidBook,
  fetchPriceHistory,
  fetchUserBid,
} from "../api/client";
import type { MockBidMode } from "../api/mock";
import { fmt, fmtPrice, shortAddr } from "../format";
import {
  Card,
  Countdown,
  Delta,
  Hairline,
  Label,
  ProgressBar,
  StatusBadge,
  type AuctionStatusBadge,
} from "../components/primitives";
import { PriceChart } from "../components/PriceChart";
import { BidBook } from "../components/BidBook";
import { BidForm, type BidFormSubmission } from "../components/BidForm";
import { BidStatusCard, type BidCardMode } from "../components/BidStatusCard";
import { ConnectButton } from "../components/ConnectButton";
import { useWallet } from "../hooks/useWallet";

// Map backend status → UI badge. They're mostly 1:1 but "claimable" is a
// post-graduation state we show as "graduated" in the header.
function toBadgeStatus(s: Auction["status"]): AuctionStatusBadge {
  if (s === "claimable") return "graduated";
  return s;
}

// Map user bid's backend status → BidStatusCard mode.
function deriveBidMode(
  bid: Bid | null,
  auctionStatus: Auction["status"]
): BidCardMode {
  if (!bid) return "none";
  if (auctionStatus === "graduated" || auctionStatus === "claimable") return "graduated";
  if (auctionStatus === "failed") return "failed";
  switch (bid.status) {
    case "active":
      return "active";
    case "at_risk":
      return "at_risk";
    case "outbid":
      return "outbid";
    case "partially_filled":
      return "partially_filled";
    case "claimed":
      return "graduated";
    case "exited":
      return "none";
    default:
      return "active";
  }
}

export function AuctionDetail({
  auctionAddress,
  wallet,
  mockBidMode,
}: {
  auctionAddress: string;
  wallet: string | null;
  mockBidMode?: MockBidMode;
}) {
  const [auction, setAuction] = useState<Auction | null>(null);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [bidBook, setBidBook] = useState<BidBookRow[]>([]);
  const [userBid, setUserBid] = useState<Bid | null>(null);
  const { publicKey, isConnected, signAndSendTransaction } = useWallet();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [a, ph, bb, ub] = await Promise.all([
        fetchAuction(auctionAddress),
        fetchPriceHistory(auctionAddress),
        fetchBidBook(auctionAddress),
        fetchUserBid(wallet, auctionAddress, mockBidMode),
      ]);
      if (cancelled) return;
      setAuction(a);
      setPriceHistory(ph);
      setBidBook(bb);
      setUserBid(ub);
    })();
    return () => {
      cancelled = true;
    };
  }, [auctionAddress, wallet, mockBidMode]);

  if (!auction) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          color: "var(--text-3)",
          fontSize: 12,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        Loading auction…
      </div>
    );
  }

  const clearingPrice = Number(auction.clearingPrice);
  const prevClearing = Number(auction.previousClearingPrice ?? auction.clearingPrice);
  const floorPrice = Number(auction.floorPrice);
  const maxBidPrice = Number(auction.maxBidPrice);
  const tickSpacing = Number(auction.tickSpacing);
  const currencyRaised = Number(auction.currencyRaised);
  const requiredRaise = Number(auction.requiredCurrencyRaised);
  const supplyReleased = auction.supplyReleasedPercent / 100;

  const isLive = auction.status === "live";
  const isGraduated = auction.status === "graduated" || auction.status === "claimable";
  const isFailed = auction.status === "failed";

  const auctionStatus: AuctionStatusBadge = toBadgeStatus(auction.status);
  const badgeStatus: AuctionStatusBadge = isLive
    ? "live"
    : isGraduated
      ? "graduated"
      : isFailed
        ? "failed"
        : auctionStatus;

  const bidMode = deriveBidMode(userBid, auction.status);
  const pageMax = 1280;
  const gap = 28;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <TopBar wallet={wallet} />

      <div
        style={{
          maxWidth: pageMax,
          margin: "0 auto",
          padding: "32px 32px 80px",
        }}
      >
        <div style={{ marginBottom: 24 }}>
          <a
            style={{
              fontSize: 12,
              color: "var(--text-3)",
              letterSpacing: "0.08em",
              cursor: "pointer",
            }}
          >
            ← ALL AUCTIONS
          </a>
        </div>

        <TokenHeader auction={auction} status={badgeStatus} />

        <div
          style={{
            marginTop: 32,
            display: "grid",
            gridTemplateColumns: "1fr 380px",
            gap,
            alignItems: "start",
          }}
        >
          {/* Left column */}
          <div style={{ display: "flex", flexDirection: "column", gap }}>
            <ClearingPriceBlock
              auction={auction}
              priceHistory={priceHistory}
              clearingPrice={clearingPrice}
              prevClearing={prevClearing}
              floorPrice={floorPrice}
              live={isLive}
            />
            <SupplyDemandBlock
              currencyRaised={currencyRaised}
              requiredRaise={requiredRaise}
              totalSupply={auction.totalSupply}
              supplyReleased={supplyReleased}
              graduated={isGraduated}
              failed={isFailed}
            />
            <DemandBlock
              bidBook={bidBook}
              clearingPrice={clearingPrice}
              bidCount={auction.bidCount}
            />
            <ParamsBlock
              auction={auction}
              floorPrice={floorPrice}
              maxBidPrice={maxBidPrice}
              tickSpacing={tickSpacing}
              requiredRaise={requiredRaise}
            />
          </div>

          {/* Right column */}
          <div
            style={{
              position: "sticky",
              top: 20,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
          >
            {isLive && bidMode !== "none" && (
              <BidStatusCard
                mode={bidMode}
                bid={userBid}
                clearingPrice={clearingPrice}
                requiredRaise={requiredRaise}
              />
            )}
            {isLive && (
              <BidForm
                clearingPrice={clearingPrice}
                floorPrice={floorPrice}
                maxBidPrice={maxBidPrice}
                tickSpacing={tickSpacing}
                disabled={!isConnected || !publicKey}
                disabledReason={
                  !isConnected || !publicKey ? "Connect wallet to bid" : undefined
                }
                onSubmit={async (s: BidFormSubmission) => {
                  if (!publicKey) throw new Error("Wallet not connected");
                  const { tx } = await buildBidTx(auctionAddress, {
                    bidder: publicKey,
                    maxPrice: s.maxPriceStr,
                    amount: s.amountStr,
                  });
                  const raw = Uint8Array.from(atob(tx), (c) => c.charCodeAt(0));
                  const transaction = Transaction.from(raw);
                  const { signature } = await signAndSendTransaction(transaction);
                  // Surface the signature in the form's success message by
                  // re-throwing with a friendly label isn't great — instead,
                  // we rely on the form's default "Bid submitted." success
                  // state, and log the signature for the user.
                  console.info("submit_bid signature:", signature);
                }}
              />
            )}
            {!isLive && (
              <BidStatusCard
                mode={bidMode}
                bid={userBid}
                clearingPrice={clearingPrice}
                requiredRaise={requiredRaise}
              />
            )}
            <AuctionTimelineMini status={auction.status} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TopBar(_props: { wallet: string | null }) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "16px 32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "var(--bg)",
        position: "sticky",
        top: 0,
        zIndex: 50,
        backdropFilter: "blur(8px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        <Logo />
        <nav style={{ display: "flex", gap: 22, fontSize: 13, color: "var(--text-2)" }}>
          <a style={{ color: "var(--text)", cursor: "pointer" }}>Auctions</a>
          <a style={{ cursor: "pointer" }}>Launch</a>
          <a style={{ cursor: "pointer" }}>Docs</a>
        </nav>
      </div>
      <ConnectButton />
    </div>
  );
}

function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <svg width="20" height="20" viewBox="0 0 20 20">
        <rect
          x="1"
          y="1"
          width="18"
          height="18"
          rx="4"
          stroke="var(--accent)"
          strokeWidth="1.5"
          fill="none"
        />
        <path d="M 5 10 L 10 5 L 15 10 L 10 15 Z" fill="var(--accent)" opacity="0.3" />
        <path
          d="M 5 10 L 10 5 L 15 10"
          stroke="var(--accent)"
          strokeWidth="1.5"
          fill="none"
        />
      </svg>
      <div style={{ fontSize: 15, letterSpacing: "-0.01em", fontWeight: 500 }}>
        seri<span style={{ color: "var(--text-3)" }}>.</span>protocol
      </div>
    </div>
  );
}

function TokenHeader({
  auction,
  status,
}: {
  auction: Auction;
  status: AuctionStatusBadge;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 24,
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        <TokenMark />
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 6,
            }}
          >
            <div
              style={{ fontSize: 28, fontWeight: 500, letterSpacing: "-0.02em" }}
            >
              {auction.tokenSymbol}
            </div>
            <div style={{ fontSize: 14, color: "var(--text-3)" }}>{auction.tokenName}</div>
            <StatusBadge status={status} />
          </div>
          <div style={{ fontSize: 13, color: "var(--text-2)", maxWidth: 560 }}>
            {auction.tokenTagline ?? ""} · by{" "}
            <span style={{ color: "var(--text)" }}>{auction.creator}</span>
          </div>
        </div>
      </div>

      {status === "live" ? (
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "var(--text-3)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Ends in
          </div>
          <Countdown target={auction.endTime * 1000} />
        </div>
      ) : (
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "var(--text-3)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Ended
          </div>
          <div className="num" style={{ fontSize: 18, color: "var(--text-2)" }}>
            2h 14m ago
          </div>
        </div>
      )}
    </div>
  );
}

function TokenMark() {
  return (
    <div
      style={{
        width: 54,
        height: 54,
        borderRadius: 12,
        background: "var(--bg-raised)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg width="30" height="30" viewBox="0 0 30 30">
        <defs>
          <linearGradient id="aquaGrad" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#7FE0C2" />
            <stop offset="100%" stopColor="#4FA086" />
          </linearGradient>
        </defs>
        <circle cx="15" cy="15" r="11" fill="none" stroke="url(#aquaGrad)" strokeWidth="1.5" />
        <path
          d="M 8 17 Q 11 12, 15 17 T 22 17"
          stroke="url(#aquaGrad)"
          strokeWidth="1.5"
          fill="none"
        />
        <path
          d="M 9 13 Q 12 9, 15 13 T 21 13"
          stroke="url(#aquaGrad)"
          strokeWidth="1.2"
          fill="none"
          opacity="0.6"
        />
      </svg>
    </div>
  );
}

function ClearingPriceBlock({
  auction,
  priceHistory,
  clearingPrice,
  prevClearing,
  floorPrice,
  live,
}: {
  auction: Auction;
  priceHistory: PricePoint[];
  clearingPrice: number;
  prevClearing: number;
  floorPrice: number;
  live: boolean;
}) {
  const [hover, setHover] = useState<PricePoint | null>(null);
  const displayPrice = hover ? hover.price : clearingPrice;
  const delta = prevClearing > 0 ? ((clearingPrice - prevClearing) / prevClearing) * 100 : 0;
  const hoverIdx = hover ? hover.t : null;

  return (
    <Card pad={0} style={{ overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          padding: "20px 22px 16px",
        }}
      >
        <div>
          <Label>Clearing price</Label>
          <div
            style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 8 }}
          >
            <div
              className="num"
              style={{
                fontSize: 40,
                fontWeight: 400,
                letterSpacing: "-0.03em",
                color: "var(--accent)",
                lineHeight: 1,
              }}
            >
              ${displayPrice.toFixed(3)}
            </div>
            {!hover && <Delta value={delta} suffix="%" />}
            {hover && hoverIdx !== null && priceHistory.length > 1 && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-3)",
                  letterSpacing: "0.08em",
                }}
              >
                HOVER ·{" "}
                {Math.round(
                  (1 - hoverIdx / (priceHistory.length - 1)) * 18 * 60
                )}
                m ago
              </div>
            )}
          </div>
          <div
            className="num"
            style={{ fontSize: 12, color: "var(--text-3)", marginTop: 6 }}
          >
            per {auction.tokenSymbol} · {auction.currency}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 0,
            alignItems: "stretch",
            borderLeft: "1px solid var(--border)",
          }}
        >
          <MiniStat
            label="24h range"
            value={
              <span className="num">
                ${Math.min(...priceHistory.map((p) => p.price), clearingPrice).toFixed(2)}{" "}
                – ${Math.max(...priceHistory.map((p) => p.price), clearingPrice).toFixed(2)}
              </span>
            }
          />
          <MiniStat
            label="Floor"
            value={<span className="num">${floorPrice.toFixed(2)}</span>}
          />
          <MiniStat
            label="Bidders"
            value={<span className="num">{auction.activeBidders}</span>}
            last
          />
        </div>
      </div>

      <Hairline />

      <div style={{ padding: "8px 22px 18px" }}>
        <PriceChart
          data={priceHistory}
          height={260}
          style="area"
          floorPrice={floorPrice}
          live={live}
          onHover={setHover}
        />
      </div>
    </Card>
  );
}

function MiniStat({
  label,
  value,
  last,
}: {
  label: string;
  value: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: "2px 22px",
        borderRight: last ? "none" : "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        minWidth: 110,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.14em",
          color: "var(--text-3)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, color: "var(--text)", marginTop: 4 }}>{value}</div>
    </div>
  );
}

function SupplyDemandBlock({
  currencyRaised,
  requiredRaise,
  totalSupply,
  supplyReleased,
  graduated,
  failed,
}: {
  currencyRaised: number;
  requiredRaise: number;
  totalSupply: number;
  supplyReleased: number;
  graduated: boolean;
  failed: boolean;
}) {
  const raisedPct = requiredRaise > 0 ? (currencyRaised / requiredRaise) * 100 : 0;
  return (
    <Card pad={22}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 36,
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <Label>Currency raised</Label>
            <div
              style={{
                fontSize: 11,
                color: graduated
                  ? "var(--accent)"
                  : failed
                    ? "var(--danger)"
                    : "var(--text-3)",
                letterSpacing: "0.08em",
              }}
            >
              {graduated
                ? "GOAL REACHED"
                : failed
                  ? "GOAL MISSED"
                  : `${raisedPct.toFixed(1)}% TO GOAL`}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginTop: 10,
              marginBottom: 14,
            }}
          >
            <div
              className="num"
              style={{ fontSize: 24, fontWeight: 500, letterSpacing: "-0.02em" }}
            >
              {fmt(currencyRaised, { d: 2 })}
            </div>
            <div className="num" style={{ fontSize: 12, color: "var(--text-3)" }}>
              / {fmt(requiredRaise, { d: 0 })} USDC
            </div>
          </div>
          <ProgressBar
            value={currencyRaised}
            max={requiredRaise * 1.15}
            markerAt={requiredRaise}
            color={failed ? "var(--danger)" : "var(--accent)"}
            height={5}
          />
        </div>

        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <Label>Supply released</Label>
            <div
              className="num"
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                letterSpacing: "0.08em",
              }}
            >
              {(supplyReleased * 100).toFixed(1)}%
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              marginTop: 10,
              marginBottom: 14,
            }}
          >
            <div
              className="num"
              style={{ fontSize: 24, fontWeight: 500, letterSpacing: "-0.02em" }}
            >
              {fmt(totalSupply * supplyReleased, { d: 2 })}
            </div>
            <div className="num" style={{ fontSize: 12, color: "var(--text-3)" }}>
              / {fmt(totalSupply, { d: 0 })} AQUA
            </div>
          </div>
          <ProgressBar
            value={supplyReleased * 100}
            max={100}
            color="var(--text-2)"
            height={5}
          />
        </div>
      </div>
    </Card>
  );
}

function DemandBlock({
  bidBook,
  clearingPrice,
  bidCount,
}: {
  bidBook: BidBookRow[];
  clearingPrice: number;
  bidCount: number;
}) {
  return (
    <Card pad={22}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 18,
        }}
      >
        <div>
          <Label>Demand at price</Label>
          <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4 }}>
            {bidCount.toLocaleString()} bids · cumulative USDC at each max price
          </div>
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            letterSpacing: "0.08em",
          }}
        >
          SORTED HIGH → LOW
        </div>
      </div>
      <BidBook data={bidBook} clearingPrice={clearingPrice} style="bars" />
    </Card>
  );
}

function ParamsBlock({
  auction,
  floorPrice,
  maxBidPrice,
  tickSpacing,
  requiredRaise,
}: {
  auction: Auction;
  floorPrice: number;
  maxBidPrice: number;
  tickSpacing: number;
  requiredRaise: number;
}) {
  const rows: [string, string][] = [
    ["Token mint", `${auction.tokenSymbol} · ${shortAddr(auction.tokenMint)}`],
    ["Currency", auction.currency],
    ["Total supply", `${fmt(auction.totalSupply, { d: 0 })} ${auction.tokenSymbol}`],
    ["Floor price", fmtPrice(floorPrice, 2)],
    ["Max bid cap", fmtPrice(maxBidPrice, 2)],
    ["Tick spacing", fmtPrice(tickSpacing, 2)],
    ["Start", fmtUnix(auction.startTime)],
    ["End", fmtUnix(auction.endTime)],
    ["Claim opens", fmtUnix(auction.claimTime)],
    ["Fundraising goal", `${fmt(requiredRaise, { d: 0 })} USDC`],
    ["Fund recipient", auction.fundRecipient ?? "—"],
    ["Unsold recipient", auction.unsoldRecipient ?? "—"],
  ];
  return (
    <Card pad={22}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Label>Auction parameters</Label>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>
          immutable · set at launch
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          rowGap: 1,
          columnGap: 36,
        }}
      >
        {rows.map(([k, v], i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              padding: "10px 0",
              borderBottom:
                i < rows.length - 2 ? "1px solid var(--border)" : "none",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {k}
            </div>
            <div
              className="num"
              style={{ fontSize: 12, color: "var(--text)" }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>

      {auction.tokenDescription && (
        <div
          style={{
            marginTop: 20,
            paddingTop: 18,
            borderTop: "1px solid var(--border)",
          }}
        >
          <Label style={{ marginBottom: 8 }}>About {auction.tokenSymbol}</Label>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-2)",
              lineHeight: 1.6,
              maxWidth: 720,
            }}
          >
            {auction.tokenDescription}
          </div>
        </div>
      )}
    </Card>
  );
}

function fmtUnix(sec: number): string {
  const d = new Date(sec * 1000);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mon} ${day}, ${hh}:${mm} UTC`;
}

function AuctionTimelineMini({ status }: { status: Auction["status"] }) {
  const isLive = status === "live";
  const isGraduated = status === "graduated" || status === "claimable";
  const isFailed = status === "failed";

  type StepState = "done" | "active" | "failed" | "pending";
  const steps: { label: string; state: StepState; time: string }[] = [
    { label: "Started", state: "done", time: "Apr 16, 14:00" },
    {
      label: "Bidding",
      state: isLive ? "active" : "done",
      time: isLive ? "in progress" : "closed",
    },
    {
      label: "Graduation",
      state: isGraduated ? "done" : isFailed ? "failed" : "pending",
      time: isLive ? "Apr 18, 14:00" : isGraduated ? "reached" : "missed",
    },
    {
      label: "Claim opens",
      state: isGraduated ? "active" : "pending",
      time: "Apr 18, 14:10",
    },
  ];

  return (
    <Card pad={18}>
      <Label style={{ marginBottom: 14 }}>Timeline</Label>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {steps.map((s, i) => {
          const color =
            s.state === "done"
              ? "var(--accent)"
              : s.state === "active"
                ? "var(--accent)"
                : s.state === "failed"
                  ? "var(--danger)"
                  : "var(--text-dim)";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div
                style={{
                  position: "relative",
                  width: 10,
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: s.state === "pending" ? "transparent" : color,
                    border: `1.5px solid ${color}`,
                  }}
                />
                {i < steps.length - 1 && (
                  <div
                    style={{
                      position: "absolute",
                      top: 12,
                      left: "50%",
                      transform: "translateX(-50%)",
                      width: 1,
                      height: 16,
                      background:
                        s.state === "done" ? "var(--accent)" : "var(--text-dim)",
                    }}
                  />
                )}
              </div>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    color: s.state === "pending" ? "var(--text-3)" : "var(--text)",
                  }}
                >
                  {s.label}
                </div>
                <div className="num" style={{ fontSize: 11, color: "var(--text-3)" }}>
                  {s.time}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

