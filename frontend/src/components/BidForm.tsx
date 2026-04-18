import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { Button, Card, Label, StatusDot } from "./primitives";
import { fmtPrice, fmtTokens } from "../format";

export interface BidFormSubmission {
  maxPrice: number;
  amount: number;
}

export function BidForm({
  clearingPrice,
  floorPrice,
  maxBidPrice,
  onSubmit,
}: {
  clearingPrice: number;
  floorPrice: number;
  maxBidPrice: number;
  // tickSpacing is part of the protocol spec; unused in current form
  // but accepted so callers stay aligned with the API shape.
  tickSpacing?: number;
  onSubmit?: (s: BidFormSubmission) => void;
}) {
  const [maxPrice, setMaxPrice] = useState("0.40");
  const [amount, setAmount] = useState("1000");

  const maxP = parseFloat(maxPrice) || 0;
  const amt = parseFloat(amount) || 0;
  const estTokens = maxP > 0 && clearingPrice > 0 ? amt / clearingPrice : 0;
  const headroom =
    clearingPrice > 0 ? ((maxP - clearingPrice) / clearingPrice) * 100 : 0;

  let riskLabel: string | null = null;
  let riskColor = "var(--text-3)";
  if (maxP > 0 && maxP <= clearingPrice) {
    riskLabel = `Must be above current clearing (${fmtPrice(clearingPrice, 3)}) to submit`;
    riskColor = "var(--danger)";
  } else if (maxP > 0 && headroom < 8) {
    riskLabel = `${headroom.toFixed(1)}% above clearing — will pause accruing if clearing catches up`;
    riskColor = "var(--warn)";
  } else if (maxP > 0) {
    riskLabel = `${headroom.toFixed(1)}% headroom above clearing`;
    riskColor = "var(--accent)";
  }

  const submit = () => {
    if (onSubmit) onSubmit({ maxPrice: maxP, amount: amt });
  };

  return (
    <Card pad={20} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: "-0.01em" }}>
          Place a bid
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--text-3)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          USDC → AQUA
        </div>
      </div>

      <InputRow
        label="Max price"
        hint={`Floor ${fmtPrice(floorPrice, 2)} · Cap ${fmtPrice(maxBidPrice, 2)}`}
        value={maxPrice}
        onChange={setMaxPrice}
        suffix="USDC / AQUA"
        prefix="$"
      />

      <InputRow
        label="Amount to deposit"
        hint="You'll be refunded any overpayment"
        value={amount}
        onChange={setAmount}
        suffix="USDC"
      />

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          padding: "10px 0",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "var(--text-3)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          Target at current clearing
        </div>
        <div
          className="num"
          style={{ fontSize: 16, color: "var(--text)", fontWeight: 500 }}
        >
          {fmtTokens(estTokens, 2)}{" "}
          <span style={{ color: "var(--text-3)", fontSize: 11, fontWeight: 400 }}>
            AQUA
          </span>
        </div>
      </div>

      {riskLabel && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            background:
              riskColor === "var(--accent)"
                ? "var(--accent-bg)"
                : riskColor === "var(--warn)"
                  ? "var(--warn-bg)"
                  : "var(--danger-bg)",
            border: `1px solid ${riskColor}22`,
            borderRadius: 6,
            fontSize: 11,
            color: riskColor,
          }}
        >
          <StatusDot color={riskColor} />
          <span>{riskLabel}</span>
        </div>
      )}

      <Button variant="primary" size="lg" full onClick={submit}>
        Submit bid
      </Button>

      <div
        style={{
          fontSize: 10,
          color: "var(--text-3)",
          textAlign: "center",
          letterSpacing: "0.05em",
        }}
      >
        You accrue tokens while your max ≥ clearing price. If clearing rises above your
        max you pause — your accrued tokens are safe.
      </div>
    </Card>
  );
}

function InputRow({
  label,
  hint,
  value,
  onChange,
  prefix,
  suffix,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <Label>{label}</Label>
        {hint && <div style={{ fontSize: 10, color: "var(--text-3)" }}>{hint}</div>}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          background: "var(--bg-input)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "0 12px",
          height: 42,
          gap: 6,
        }}
      >
        {prefix && (
          <span className="num" style={{ color: "var(--text-3)", fontSize: 14 }}>
            {prefix}
          </span>
        )}
        <input
          className="num"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text)",
            fontSize: 15,
            fontWeight: 500,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        />
        {suffix && (
          <span
            style={{ color: "var(--text-3)", fontSize: 11, letterSpacing: "0.05em" }}
          >
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- Stat + Explainer ----

export function Stat({
  label,
  value,
  suffix,
  tone,
  large,
}: {
  label: string;
  value: string;
  suffix?: string;
  tone?: "accent";
  large?: boolean;
}) {
  const color = tone === "accent" ? "var(--accent)" : "var(--text)";
  return (
    <div>
      <Label>{label}</Label>
      <div
        className="num"
        style={{
          fontSize: large ? 22 : 15,
          fontWeight: 500,
          color,
          marginTop: 4,
          letterSpacing: "-0.01em",
        }}
      >
        {value}{" "}
        {suffix && (
          <span style={{ color: "var(--text-3)", fontSize: 11, fontWeight: 400 }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

type ExplainerTone = "accent" | "warn" | "danger" | "neutral";

const EXPLAINER_COLORS: Record<
  ExplainerTone,
  { bg: string; border: string; fg: string; dot: string }
> = {
  accent: {
    bg: "var(--accent-bg)",
    border: "rgba(127,224,194,0.16)",
    fg: "var(--text)",
    dot: "var(--accent)",
  },
  warn: {
    bg: "var(--warn-bg)",
    border: "rgba(232,184,96,0.18)",
    fg: "var(--text)",
    dot: "var(--warn)",
  },
  danger: {
    bg: "var(--danger-bg)",
    border: "rgba(224,112,98,0.18)",
    fg: "var(--text)",
    dot: "var(--danger)",
  },
  neutral: {
    bg: "rgba(255,255,255,0.03)",
    border: "var(--border)",
    fg: "var(--text-2)",
    dot: "var(--text-3)",
  },
};

export function ExplainerRow({
  children,
  tone = "neutral",
  style,
}: {
  children: ReactNode;
  tone?: ExplainerTone;
  style?: CSSProperties;
}) {
  const c = EXPLAINER_COLORS[tone];
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        padding: "10px 12px",
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.5,
        color: c.fg,
        ...style,
      }}
    >
      <div style={{ paddingTop: 5 }}>
        <StatusDot color={c.dot} />
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
