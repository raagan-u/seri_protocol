import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { countdown } from "../format";

export function StatusDot({
  color = "var(--accent)",
  pulse = false,
}: {
  color?: string;
  pulse?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        boxShadow: pulse ? `0 0 0 0 ${color}` : "none",
        animation: pulse ? "sdPulse 2s infinite" : "none",
        flexShrink: 0,
      }}
    />
  );
}

export type AuctionStatusBadge =
  | "live"
  | "upcoming"
  | "graduated"
  | "failed"
  | "claimable"
  | "ended";

const STATUS_MAP: Record<
  AuctionStatusBadge,
  { label: string; color: string; pulse?: boolean }
> = {
  live: { label: "LIVE", color: "var(--accent)", pulse: true },
  upcoming: { label: "UPCOMING", color: "var(--text-2)" },
  graduated: { label: "GRADUATED", color: "var(--accent)" },
  failed: { label: "FAILED", color: "var(--danger)" },
  claimable: { label: "CLAIMABLE", color: "var(--accent)" },
  ended: { label: "ENDED", color: "var(--text-2)" },
};

export function StatusBadge({ status }: { status: AuctionStatusBadge }) {
  const s = STATUS_MAP[status] ?? STATUS_MAP.live;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 10px 4px 8px",
        border: "1px solid var(--border)",
        borderRadius: 999,
        fontSize: 11,
        letterSpacing: "0.12em",
        fontWeight: 500,
        color: s.color,
        textTransform: "uppercase",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <StatusDot color={s.color} pulse={s.pulse} />
      {s.label}
    </span>
  );
}

export type BidPillStatus =
  | "active"
  | "at_risk"
  | "outbid"
  | "partial"
  | "claimable"
  | "claimed"
  | "failed";

const BID_PILL_MAP: Record<BidPillStatus, { label: string; color: string; bg: string }> = {
  active: { label: "Active", color: "var(--accent)", bg: "var(--accent-bg)" },
  at_risk: { label: "At risk", color: "var(--warn)", bg: "var(--warn-bg)" },
  outbid: { label: "Outbid", color: "var(--danger)", bg: "var(--danger-bg)" },
  partial: { label: "Partially filled", color: "var(--warn)", bg: "var(--warn-bg)" },
  claimable: { label: "Ready to claim", color: "var(--accent)", bg: "var(--accent-bg)" },
  claimed: { label: "Claimed", color: "var(--text-2)", bg: "rgba(255,255,255,0.04)" },
  failed: { label: "Refund ready", color: "var(--text-2)", bg: "rgba(255,255,255,0.04)" },
};

export function BidStatusPill({ status }: { status: BidPillStatus }) {
  const s = BID_PILL_MAP[status] ?? BID_PILL_MAP.active;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 11,
        letterSpacing: "0.08em",
        fontWeight: 500,
        color: s.color,
        textTransform: "uppercase",
        background: s.bg,
        border: `1px solid ${s.color}22`,
      }}
    >
      <StatusDot color={s.color} />
      {s.label}
    </span>
  );
}

type ButtonVariant = "primary" | "ghost" | "accent_ghost" | "danger_ghost";
type ButtonSize = "sm" | "md" | "lg";

const BTN_SIZES: Record<ButtonSize, { fs: number; px: number; h: number }> = {
  sm: { fs: 12, px: 14, h: 30 },
  md: { fs: 13, px: 18, h: 38 },
  lg: { fs: 14, px: 22, h: 46 },
};

const BTN_VARIANTS: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: "var(--accent)",
    color: "#0A0B0E",
    border: "1px solid var(--accent)",
  },
  ghost: {
    background: "transparent",
    color: "var(--text)",
    border: "1px solid var(--border-strong)",
  },
  accent_ghost: {
    background: "var(--accent-bg)",
    color: "var(--accent)",
    border: "1px solid rgba(127,224,194,0.18)",
  },
  danger_ghost: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    border: "1px solid rgba(224,112,98,0.18)",
  },
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  onClick,
  disabled,
  style,
  full,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  onClick?: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  full?: boolean;
}) {
  const sz = BTN_SIZES[size];
  const v = BTN_VARIANTS[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...v,
        height: sz.h,
        padding: `0 ${sz.px}px`,
        fontSize: sz.fs,
        fontWeight: 500,
        letterSpacing: "0.02em",
        borderRadius: 999,
        transition: "all .15s ease",
        opacity: disabled ? 0.4 : 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        width: full ? "100%" : "auto",
        cursor: disabled ? "not-allowed" : "pointer",
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.filter = "brightness(1.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = "none";
      }}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  style,
  pad = 20,
  subtle = false,
}: {
  children: ReactNode;
  style?: CSSProperties;
  pad?: number;
  subtle?: boolean;
}) {
  return (
    <div
      style={{
        background: subtle ? "transparent" : "var(--bg-raised)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: pad,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Label({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: "0.14em",
        fontWeight: 500,
        color: "var(--text-3)",
        textTransform: "uppercase",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Hairline({
  vertical = false,
  style,
}: {
  vertical?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--border)",
        width: vertical ? 1 : "100%",
        height: vertical ? "100%" : 1,
        ...style,
      }}
    />
  );
}

export function ProgressBar({
  value,
  max = 100,
  markerAt,
  color = "var(--accent)",
  height = 4,
}: {
  value: number;
  max?: number;
  markerAt?: number;
  color?: string;
  height?: number;
}) {
  const pct = Math.min(100, (value / max) * 100);
  const markerPct =
    markerAt !== undefined ? Math.min(100, (markerAt / max) * 100) : null;
  return (
    <div
      style={{
        position: "relative",
        height,
        background: "rgba(255,255,255,0.05)",
        borderRadius: 0,
        overflow: "visible",
      }}
    >
      <div
        style={{
          height: "100%",
          width: pct + "%",
          background: color,
          transition: "width .4s ease",
        }}
      />
      {markerPct !== null && (
        <div
          style={{
            position: "absolute",
            top: -3,
            bottom: -3,
            left: markerPct + "%",
            width: 1,
            background: "var(--text-2)",
            transform: "translateX(-0.5px)",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -14,
              left: 0,
              transform: "translateX(-50%)",
              fontSize: 9,
              letterSpacing: "0.1em",
              color: "var(--text-3)",
              whiteSpace: "nowrap",
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            GOAL
          </div>
        </div>
      )}
    </div>
  );
}

export function Countdown({
  target,
  compact = false,
}: {
  target: number; // unix ms
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const c = countdown(target - now);
  const seg = (label: string, val: string) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        minWidth: compact ? 24 : 36,
      }}
    >
      <div
        className="num"
        style={{
          fontSize: compact ? 14 : 20,
          fontWeight: 500,
          lineHeight: 1,
          color: "var(--text)",
        }}
      >
        {val}
      </div>
      {!compact && (
        <div
          style={{
            fontSize: 9,
            letterSpacing: "0.14em",
            color: "var(--text-3)",
            marginTop: 4,
            textTransform: "uppercase",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
  const sep = (
    <div
      className="num"
      style={{
        fontSize: compact ? 14 : 20,
        color: "var(--text-dim)",
        margin: "0 2px",
      }}
    >
      :
    </div>
  );
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: compact ? "baseline" : "flex-start",
      }}
    >
      {seg("hrs", c.h)}
      {sep}
      {seg("min", c.m)}
      {sep}
      {seg("sec", c.s)}
    </div>
  );
}

export function Delta({ value, suffix = "" }: { value: number; suffix?: string }) {
  const up = value >= 0;
  return (
    <span
      className="num"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        color: up ? "var(--accent)" : "var(--danger)",
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      <span style={{ fontSize: 9 }}>{up ? "▲" : "▼"}</span>
      {Math.abs(value).toFixed(2)}
      {suffix}
    </span>
  );
}

export function AnimatedNum({
  value,
  format = (v: number) => v.toFixed(3),
  flashOnChange = true,
  style,
}: {
  value: number;
  format?: (v: number) => string;
  flashOnChange?: boolean;
  style?: CSSProperties;
}) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value && flashOnChange) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 500);
      prev.current = value;
      return () => clearTimeout(t);
    }
  }, [value, flashOnChange]);
  return (
    <span
      className="num"
      style={{
        color: flash ? "var(--accent)" : "inherit",
        transition: "color .5s ease",
        ...style,
      }}
    >
      {format(value)}
    </span>
  );
}
