import { useEffect, useRef, useState } from "react";
import type { PricePoint } from "../api/types";

export type ChartStyle = "area" | "line" | "stepped";

export function PriceChart({
  data,
  height = 280,
  style = "area",
  floorPrice = 0.18,
  maxPrice,
  showAxes = true,
  live = true,
  onHover,
}: {
  data: PricePoint[];
  height?: number;
  style?: ChartStyle;
  floorPrice?: number;
  maxPrice?: number;
  showAxes?: boolean;
  live?: boolean;
  onHover?: (p: PricePoint | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.floor(e.contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  if (data.length === 0) {
    return <div ref={wrapRef} style={{ width: "100%", height }} />;
  }

  const pad = {
    l: showAxes ? 54 : 0,
    r: showAxes ? 16 : 0,
    t: 16,
    b: showAxes ? 28 : 0,
  };
  const w = width;
  const h = height;
  const chartW = Math.max(10, w - pad.l - pad.r);
  const chartH = Math.max(10, h - pad.t - pad.b);

  const prices = data.map((d) => d.price);
  const minP = Math.min(floorPrice, ...prices);
  const maxP = maxPrice ?? Math.max(...prices) * 1.08;
  const range = maxP - minP || 1;

  const x = (i: number) => pad.l + (i / (data.length - 1)) * chartW;
  const y = (p: number) => pad.t + (1 - (p - minP) / range) * chartH;

  let linePath = "";
  let areaPath = "";
  if (style === "line" || style === "area") {
    linePath = data
      .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(d.price).toFixed(2)}`)
      .join(" ");
    areaPath =
      linePath +
      ` L ${x(data.length - 1).toFixed(2)} ${pad.t + chartH} L ${x(0).toFixed(2)} ${pad.t + chartH} Z`;
  } else {
    let p = "";
    data.forEach((d, i) => {
      if (i === 0) p += `M ${x(i).toFixed(2)} ${y(d.price).toFixed(2)}`;
      else
        p += ` L ${x(i).toFixed(2)} ${y(data[i - 1].price).toFixed(2)} L ${x(i).toFixed(
          2
        )} ${y(d.price).toFixed(2)}`;
    });
    linePath = p;
    areaPath =
      p +
      ` L ${x(data.length - 1).toFixed(2)} ${pad.t + chartH} L ${x(0).toFixed(2)} ${pad.t + chartH} Z`;
  }

  const yTicks = 4;
  const yTickVals: number[] = [];
  for (let i = 0; i <= yTicks; i++) {
    yTickVals.push(minP + (range * i) / yTicks);
  }
  const xTickFracs = [0, 0.33, 0.66, 1];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, (px - pad.l) / chartW));
    const idx = Math.round(frac * (data.length - 1));
    setHoverIdx(idx);
    onHover?.(data[idx]);
  };
  const onLeave = () => {
    setHoverIdx(null);
    onHover?.(null);
  };

  const latest = data[data.length - 1];
  const hovered = hoverIdx !== null ? data[hoverIdx] : null;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height }}>
      <svg
        width={w}
        height={h}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        style={{ display: "block", cursor: "crosshair" }}
      >
        <defs>
          <linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {showAxes &&
          yTickVals.map((v, i) => (
            <g key={i}>
              <line
                x1={pad.l}
                x2={pad.l + chartW}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--border)"
                strokeDasharray={i === 0 ? "0" : "2 4"}
              />
              <text
                x={pad.l - 10}
                y={y(v) + 3}
                textAnchor="end"
                fontSize="10"
                fontFamily="'JetBrains Mono', monospace"
                fill="var(--text-3)"
              >
                ${v.toFixed(2)}
              </text>
            </g>
          ))}

        <line
          x1={pad.l}
          x2={pad.l + chartW}
          y1={y(floorPrice)}
          y2={y(floorPrice)}
          stroke="var(--text-3)"
          strokeDasharray="3 3"
          strokeWidth="1"
          opacity="0.5"
        />
        {showAxes && (
          <text
            x={pad.l + chartW - 6}
            y={y(floorPrice) - 6}
            textAnchor="end"
            fontSize="9"
            letterSpacing="0.12em"
            fontFamily="'JetBrains Mono', monospace"
            fill="var(--text-3)"
          >
            FLOOR ${floorPrice.toFixed(2)}
          </text>
        )}

        {style === "area" && <path d={areaPath} fill="url(#areaFill)" />}

        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <circle cx={x(data.length - 1)} cy={y(latest.price)} r="3.5" fill="var(--accent)" />
        <circle cx={x(data.length - 1)} cy={y(latest.price)} r="7" fill="var(--accent)" opacity="0.18">
          {live && (
            <animate attributeName="r" values="7;11;7" dur="2s" repeatCount="indefinite" />
          )}
          {live && (
            <animate
              attributeName="opacity"
              values="0.25;0;0.25"
              dur="2s"
              repeatCount="indefinite"
            />
          )}
        </circle>

        {showAxes &&
          xTickFracs.map((f, i) => {
            const hoursAgo = Math.round((1 - f) * 18);
            return (
              <text
                key={i}
                x={pad.l + f * chartW}
                y={pad.t + chartH + 18}
                textAnchor={
                  i === 0 ? "start" : i === xTickFracs.length - 1 ? "end" : "middle"
                }
                fontSize="10"
                fontFamily="'JetBrains Mono', monospace"
                fill="var(--text-3)"
              >
                {hoursAgo === 0 ? "NOW" : `-${hoursAgo}h`}
              </text>
            );
          })}

        {hovered && hoverIdx !== null && (
          <g>
            <line
              x1={x(hoverIdx)}
              x2={x(hoverIdx)}
              y1={pad.t}
              y2={pad.t + chartH}
              stroke="var(--text-3)"
              strokeDasharray="2 3"
              opacity="0.5"
            />
            <circle
              cx={x(hoverIdx)}
              cy={y(hovered.price)}
              r="3"
              fill="var(--bg)"
              stroke="var(--accent)"
              strokeWidth="1.5"
            />
          </g>
        )}
      </svg>

      {hovered && hoverIdx !== null && (
        <div
          style={{
            position: "absolute",
            left: Math.max(pad.l, Math.min(w - 140, x(hoverIdx) - 70)),
            top: 10,
            background: "var(--bg-deep)",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 11,
            pointerEvents: "none",
            boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
            minWidth: 130,
          }}
        >
          <div
            style={{
              color: "var(--text-3)",
              letterSpacing: "0.08em",
              fontSize: 9,
              textTransform: "uppercase",
            }}
          >
            {Math.round((1 - hoverIdx / (data.length - 1)) * 18 * 60)}m ago
          </div>
          <div
            className="num"
            style={{ color: "var(--accent)", fontSize: 15, fontWeight: 500, marginTop: 2 }}
          >
            ${hovered.price.toFixed(3)}
          </div>
        </div>
      )}
    </div>
  );
}

export function Sparkline({
  data,
  width = 120,
  height = 28,
  color = "var(--accent)",
}: {
  data: PricePoint[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length === 0) return <svg width={width} height={height} />;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = data
    .map((d, i) => `${(i / (data.length - 1)) * width},${(1 - (d.price - min) / range) * height}`)
    .join(" ");
  return (
    <svg width={width} height={height}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}
