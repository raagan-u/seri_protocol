// Shared formatters lifted from the design prototype (data.jsx).

export function fmt(n: number | null | undefined, opts: { d?: number } = {}): string {
  const d = opts.d ?? 2;
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(d) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(d) + "K";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPrice(n: number, d = 3): string {
  return "$" + n.toFixed(d);
}

export function fmtCurrency(n: number, sym = "USDC", d = 0): string {
  return (
    n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) +
    " " +
    sym
  );
}

export function fmtTokens(n: number, d = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export interface CountdownParts {
  h: string;
  m: string;
  s: string;
  total: number;
}

export function countdown(ms: number): CountdownParts {
  if (ms <= 0) return { h: "00", m: "00", s: "00", total: 0 };
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return {
    h: String(h).padStart(2, "0"),
    m: String(m).padStart(2, "0"),
    s: String(s).padStart(2, "0"),
    total: totalSec,
  };
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return "";
  if (a.length <= 10) return a;
  return a.slice(0, 4) + "…" + a.slice(-4);
}
