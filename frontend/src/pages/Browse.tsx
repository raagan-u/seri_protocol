import { useEffect, useState } from "react";
import type { Auction } from "../api/types";
import { fetchAuctions } from "../api/client";
import { MOCK_AUCTION } from "../api/mock";
import { fmtPrice, shortAddr } from "../format";
import { createAuctionUrl, goToAuction } from "../navigation";
import { StatusBadge, type AuctionStatusBadge } from "../components/primitives";
import { ConnectButton } from "../components/ConnectButton";

export function Browse() {
  const [auctions, setAuctions] = useState<Auction[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchAuctions()
      .then((list) => {
        if (!alive) return;
        setAuctions(list ?? []);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const hasReal = auctions && auctions.length > 0;
  const display: Auction[] = hasReal ? auctions! : [{ ...MOCK_AUCTION }];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--text)",
        padding: "48px 24px",
      }}
    >
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div
          style={{
            marginBottom: 32,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 32, letterSpacing: "-0.03em" }}>
              Seri Protocol
            </h1>
            <p style={{ marginTop: 8, color: "var(--text-muted)" }}>
              Continuous-clearing token auctions on Solana.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <a
              href={createAuctionUrl()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 38,
                padding: "0 18px",
                borderRadius: 999,
                background: "var(--accent)",
                color: "#0A0B0E",
                border: "1px solid var(--accent)",
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: "0.02em",
                textDecoration: "none",
              }}
            >
              Create auction
            </a>
            <ConnectButton />
          </div>
        </div>
        <div style={{ marginBottom: 32 }}>
          {err && (
            <div style={{ color: "var(--danger, #ef4444)", marginTop: 8 }}>
              {err}
            </div>
          )}
          {!hasReal && auctions !== null && (
            <div style={{ color: "var(--text-muted)", marginTop: 8, fontSize: 14 }}>
              No on-chain auctions indexed yet. Showing placeholder below.
            </div>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          }}
        >
          {display.map((a) => (
            <button
              key={a.address}
              onClick={() => goToAuction(a.address)}
              style={{
                textAlign: "left",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 20,
                cursor: "pointer",
                color: "inherit",
                font: "inherit",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 18, fontWeight: 500 }}>
                  {a.tokenName} <span style={{ color: "var(--text-muted)" }}>/ {a.tokenSymbol}</span>
                </div>
                <StatusBadge status={a.status as AuctionStatusBadge} />
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
                {shortAddr(a.address)}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                <span style={{ color: "var(--text-muted)" }}>Clearing</span>
                <span>{fmtPrice(Number(a.clearingPrice))}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}>
                <span style={{ color: "var(--text-muted)" }}>Raised</span>
                <span>
                  {a.currencyRaised} / {a.requiredCurrencyRaised} {a.currency}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}>
                <span style={{ color: "var(--text-muted)" }}>Bids</span>
                <span>{a.bidCount}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
