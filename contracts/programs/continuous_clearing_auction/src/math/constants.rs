/// 100% in milli-basis-points (10^7)
pub const MPS: u32 = 10_000_000;

/// Q64 fixed-point denominator (1 << 64)
pub const Q64: u128 = 1 << 64;

/// Sentinel for end of tick linked list
pub const MAX_TICK_PRICE: u128 = u128::MAX;

/// Sentinel for end of checkpoint linked list
pub const MAX_TIMESTAMP: i64 = i64::MAX;

/// Overflow guard for X7 accumulator
pub const X7_UPPER_BOUND: u128 = u128::MAX / 10_000_000;

/// Minimum allowed tick spacing
pub const MIN_TICK_SPACING: u64 = 2;
