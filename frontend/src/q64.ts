// Mirrors backend `decimal_to_q64` in tx_utils.rs so the bid form can
// validate `max_price % tick_spacing == 0` before submitting.

const Q64 = 1n << 64n;

export function decimalToQ64(s: string): bigint | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const dot = trimmed.indexOf(".");
  const intPart = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const fracPart = dot === -1 ? "" : trimmed.slice(dot + 1);
  if (intPart && !/^\d+$/.test(intPart)) return null;
  if (fracPart && !/^\d+$/.test(fracPart)) return null;
  if (fracPart.length > 18) return null;
  const intVal = intPart ? BigInt(intPart) : 0n;
  let q = intVal << 64n;
  if (fracPart.length > 0) {
    const fracNum = BigInt(fracPart);
    const fracDen = 10n ** BigInt(fracPart.length);
    q += (fracNum << 64n) / fracDen;
  }
  return q;
}

export function q64ToDecimalString(q: bigint, dp = 6): string {
  const whole = q >> 64n;
  const frac = q & (Q64 - 1n);
  const scale = 10n ** BigInt(dp);
  const fracScaled = (frac * scale) >> 64n;
  const fracStr = fracScaled.toString().padStart(dp, "0");
  return `${whole.toString()}.${fracStr}`;
}

/// Find the largest Q64 value <= `q` that is divisible by `tickSpacing`,
/// strictly greater than `clearingQ64` (so it's a valid bid), and <= `maxBidQ64`.
/// Returns null if no such value exists.
export function snapDownToTick(
  q: bigint,
  tickSpacing: bigint,
  clearingQ64: bigint,
  maxBidQ64: bigint,
): bigint | null {
  if (tickSpacing <= 0n) return null;
  let snapped = q - (q % tickSpacing);
  if (snapped > maxBidQ64) snapped = maxBidQ64 - (maxBidQ64 % tickSpacing);
  if (snapped <= clearingQ64) return null;
  return snapped;
}
