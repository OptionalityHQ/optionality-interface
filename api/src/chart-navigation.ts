export interface AxisRange {
  min: number;
  max: number;
}

/** Keep the value under the pointer fixed while zooming. */
export function zoomAxis(
  range: AxisRange,
  anchor: number,
  factor: number,
  minSpan: number,
  maxSpan: number,
): AxisRange {
  const span = range.max - range.min;
  const next = Math.max(minSpan, Math.min(maxSpan, span * factor));
  const fraction = (anchor - range.min) / span;
  return { min: anchor - fraction * next, max: anchor + (1 - fraction) * next };
}

export function panAxis(range: AxisRange, fraction: number): AxisRange {
  const shift = (range.max - range.min) * fraction;
  return { min: range.min + shift, max: range.max + shift };
}

export function listedStrike<
  T extends {
    asset: string;
    kind: string;
    low: number;
    high: number;
    expiryNs: number;
    settlement: string;
  },
>(
  rows: T[],
  asset: string,
  kind: string,
  expiry: number | null,
  price: number,
): T | null {
  return (
    rows.find(
      (s) =>
        s.asset === asset &&
        s.kind === kind &&
        s.expiryNs === expiry &&
        s.settlement === "open" &&
        Math.abs((kind === "Call" ? s.low : s.high) - price) < 1e-8,
    ) ?? null
  );
}
