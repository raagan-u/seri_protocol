import { useEffect, useRef, useState } from "react";
import type { BidBookRow } from "../api/types";
import { fmt } from "../format";

export type DemandStyle = "bars" | "curve" | "off";

export function BidBook({
  data,
  clearingPrice,
  style = "bars",
}: {
  data: BidBookRow[];
  clearingPrice: number;
  style?: DemandStyle;
}) {
  if (style === "off") return null;
  if (style === "curve") return <DemandCurve data={data} clearingPrice={clearingPrice} />;
  return <BidBookBars data={data} clearingPrice={clearingPrice} />;
}

function BidBookBars({
  data,
  clearingPrice,
}: {
  data: BidBookRow[];
  clearingPrice: number;
}) {
  const maxDemand = Math.max(...data.map((d) => d.demand), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "80px 1fr 70px 50px",
          fontSize: 10,
          letterSpacing: "0.12em",
          color: "var(--text-3)",
          textTransform: "uppercase",
          padding: "0 2px 10px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div>Price</div>
        <div>Cumulative demand</div>
        <div style={{ textAlign: "right" }}>USDC</div>
        <div style={{ textAlign: "right" }}>Bids</div>
      </div>
      {data.map((row, i) => {
        const above = row.price >= clearingPrice;
        const pct = (row.demand / maxDemand) * 100;
        const isClearing = !!row.isClearing;
        return (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "80px 1fr 70px 50px",
              alignItems: "center",
              padding: "6px 2px",
              position: "relative",
              borderTop: isClearing ? "1px solid var(--accent)" : "1px solid transparent",
              borderBottom: isClearing
                ? "1px solid var(--accent)"
                : "1px solid transparent",
              background: isClearing ? "var(--accent-bg)" : "transparent",
            }}
          >
            <div
              className="num"
              style={{
                fontSize: 12,
                color: isClearing
                  ? "var(--accent)"
                  : above
                    ? "var(--text)"
                    : "var(--text-2)",
                fontWeight: isClearing ? 500 : 400,
              }}
            >
              ${row.price.toFixed(3)}
              {isClearing && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 9,
                    letterSpacing: "0.12em",
                    color: "var(--accent)",
                  }}
                >
                  ← CLEARING
                </span>
              )}
            </div>
            <div style={{ position: "relative", height: 14 }}>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: pct + "%",
                  background: above ? "rgba(127,224,194,0.18)" : "rgba(255,255,255,0.05)",
                  borderLeft: above
                    ? "1px solid var(--accent)"
                    : "1px solid var(--text-dim)",
                }}
              />
            </div>
            <div
              className="num"
              style={{ fontSize: 11, color: "var(--text-2)", textAlign: "right" }}
            >
              {fmt(row.demand, { d: 2 })}
            </div>
            <div
              className="num"
              style={{ fontSize: 11, color: "var(--text-3)", textAlign: "right" }}
            >
              {row.bids}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DemandCurve({
  data,
  clearingPrice,
  height = 220,
}: {
  data: BidBookRow[];
  clearingPrice: number;
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0].contentRect.width)));
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const pad = { l: 48, r: 16, t: 12, b: 28 };
  const chartW = Math.max(10, w - pad.l - pad.r);
  const chartH = Math.max(10, height - pad.t - pad.b);

  const sorted = [...data].sort((a, b) => a.price - b.price);
  const prices = sorted.map((d) => d.price);
  const demands = sorted.map((d) => d.demand);

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const maxD = Math.max(...demands, 1);

  const x = (p: number) => pad.l + ((p - minP) / (maxP - minP || 1)) * chartW;
  const y = (d: number) => pad.t + (1 - d / maxD) * chartH;

  const path = sorted
    .map(
      (d, i) => `${i === 0 ? "M" : "L"} ${x(d.price).toFixed(2)} ${y(d.demand).toFixed(2)}`
    )
    .join(" ");
  const area =
    path + ` L ${x(maxP)} ${pad.t + chartH} L ${x(minP)} ${pad.t + chartH} Z`;

  return (
    <div ref={wrapRef} style={{ width: "100%", height }}>
      <svg width={w} height={height} style={{ display: "block" }}>
        <defs>
          <linearGradient id="demandFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <line
          x1={pad.l}
          x2={pad.l + chartW}
          y1={pad.t + chartH}
          y2={pad.t + chartH}
          stroke="var(--border)"
        />
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
          const price = minP + (maxP - minP) * f;
          return (
            <text
              key={i}
              x={pad.l + f * chartW}
              y={pad.t + chartH + 18}
              textAnchor="middle"
              fontSize="10"
              fill="var(--text-3)"
              fontFamily="'JetBrains Mono', monospace"
            >
              ${price.toFixed(2)}
            </text>
          );
        })}
        {[0, 0.5, 1].map((f, i) => {
          const d = maxD * (1 - f);
          return (
            <text
              key={i}
              x={pad.l - 10}
              y={pad.t + f * chartH + 4}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-3)"
              fontFamily="'JetBrains Mono', monospace"
            >
              {fmt(d, { d: 1 })}
            </text>
          );
        })}

        <path d={area} fill="url(#demandFill)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />

        <line
          x1={x(clearingPrice)}
          x2={x(clearingPrice)}
          y1={pad.t}
          y2={pad.t + chartH}
          stroke="var(--accent)"
          strokeDasharray="3 3"
          opacity="0.7"
        />
        <text
          x={x(clearingPrice)}
          y={pad.t - 4}
          textAnchor="middle"
          fontSize="9"
          letterSpacing="0.12em"
          fill="var(--accent)"
          fontFamily="'JetBrains Mono', monospace"
        >
          CLEARING ${clearingPrice.toFixed(3)}
        </text>

        <text
          x={pad.l + chartW / 2}
          y={height - 4}
          textAnchor="middle"
          fontSize="9"
          letterSpacing="0.12em"
          fill="var(--text-3)"
        >
          PRICE →
        </text>
      </svg>
    </div>
  );
}
