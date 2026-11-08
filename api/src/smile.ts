/**
 * The vol smile the engine publishes: implied vol against strike, one curve per
 * tenor, from the same smile function that prices the legs of every spread.
 *
 * The gateway does not compute a vol and does not invert a spread price into one —
 * a spread has two strikes and its "vol" explodes at the wings, which drew a chart
 * that was honest and unreadable. This module only names the tenors and hands the
 * numbers through.
 */
import { type Asset, expiryLabel, parseAsset } from "./gateway.ts";

export interface SmilePoint {
  strike: number;
  /** Fractional vol: 0.62 is 62%. */
  vol: number;
}

export interface SmileCurve {
  expiryNs: number;
  /** How the expiry strip names this tenor. */
  label: string;
  /** Years to expiry, so tenors are told apart without reading the stamps. */
  years: number;
  points: SmilePoint[];
}

export interface SmileView {
  asset: Asset;
  spot: number | null;
  atmVol: number;
  curves: SmileCurve[];
}

interface RawCurve {
  expiryNs: string | number;
  years: number;
  points: Array<{ strike: number; vol: number }>;
}

/** Name the tenors and drop anything malformed; the numbers stay the engine's. */
export function projectSmile(raw: unknown, nowMs: number): SmileView | null {
  const body = raw as { asset?: string; spot?: number | null; atmVol?: number; expiries?: RawCurve[] } | null;
  if (!body || !Array.isArray(body.expiries)) return null;
  const curves = body.expiries
    .map((curve) => {
      const expiryNs = Number(curve.expiryNs);
      const points = (curve.points ?? [])
        .filter((point) => Number.isFinite(point.strike) && Number.isFinite(point.vol) && point.vol > 0)
        .sort((a, b) => a.strike - b.strike);
      return { expiryNs, label: expiryLabel(expiryNs, nowMs), years: Number(curve.years) || 0, points };
    })
    .filter((curve) => curve.points.length > 1 && Number.isFinite(curve.expiryNs));
  return {
    asset: parseAsset(body.asset),
    spot: typeof body.spot === "number" ? body.spot : null,
    atmVol: Number(body.atmVol) || 0,
    curves,
  };
}
