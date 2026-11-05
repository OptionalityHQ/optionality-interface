/** Intrinsic spread value per contract; PnL additionally depends on premium and side. */
export function intrinsicValue(
  kind: "Put" | "Call",
  low: number,
  high: number,
  spot: number | null,
): number | null {
  if (
    spot === null ||
    !Number.isFinite(spot) ||
    spot <= 0 ||
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    high <= low
  )
    return null;
  return kind === "Call"
    ? Math.max(0, Math.min(spot - low, high - low))
    : Math.max(0, Math.min(high - spot, high - low));
}

export function contractQuantity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10000
  )
    throw new Error("Enter between 1 and 10,000 whole contracts.");
  return value;
}
