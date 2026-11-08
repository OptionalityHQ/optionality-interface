import type { Candle } from "./candles.ts";

/** Exponential Moving Average (EMA). Returns null until enough samples exist. */
export function calcEMA(values: number[], period: number): Array<number | null> {
  if (period < 1 || values.length === 0) return [];
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * k + ema;
    out[i] = ema;
  }
  return out;
}

/** Simple Moving Average (SMA). */
export function calcSMA(values: number[], period: number): Array<number | null> {
  if (period < 1 || values.length === 0) return [];
  const out: Array<number | null> = new Array(values.length).fill(null);
  let windowSum = 0;
  for (let i = 0; i < values.length; i++) {
    windowSum += values[i];
    if (i >= period) windowSum -= values[i - period];
    if (i >= period - 1) out[i] = windowSum / period;
  }
  return out;
}

export interface BollingerPoint {
  upper: number | null;
  middle: number | null;
  lower: number | null;
}

/** Bollinger Bands (default 20-period SMA +/- 2 standard deviations). */
export function calcBollingerBands(
  values: number[],
  period = 20,
  mult = 2,
): BollingerPoint[] {
  const sma = calcSMA(values, period);
  return values.map((_, idx) => {
    const mid = sma[idx];
    if (mid === null) return { upper: null, middle: null, lower: null };
    let sq = 0;
    for (let j = idx - period + 1; j <= idx; j++) {
      const diff = values[j] - mid;
      sq += diff * diff;
    }
    const std = Math.sqrt(sq / period);
    return {
      upper: mid + mult * std,
      middle: mid,
      lower: mid - mult * std,
    };
  });
}

/** Session Volume-Weighted Average Price (VWAP). */
export function calcVWAP(candles: Candle[]): Array<number | null> {
  let cumPV = 0;
  let cumVol = 0;
  return candles.map((c) => {
    const typical = (c.high + c.low + c.close) / 3;
    const v = Math.max(0, c.volume);
    cumPV += typical * v;
    cumVol += v;
    return cumVol > 0 ? cumPV / cumVol : typical;
  });
}

/** Wilder's Relative Strength Index (RSI, default 14). */
export function calcRSI(values: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= period || period < 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Papertrade-style exponential spring-damper for sub-second tick interpolation.
 * Smooths sudden discrete tick arrivals into continuous 60/120fps motion.
 */
export function createSmoothValue(tauMs = 115) {
  let current: number | null = null;
  let lastPerfMs: number | null = null;
  return {
    sample(target: number, perfMs: number, snap = false): number {
      const dt = lastPerfMs === null ? 0 : Math.max(0, perfMs - lastPerfMs);
      lastPerfMs = perfMs;
      if (current === null || snap || dt > 1200) {
        current = target;
      } else {
        current += (target - current) * (1 - Math.exp(-dt / tauMs));
      }
      return current;
    },
    get value(): number | null {
      return current;
    },
    reset(): void {
      current = null;
      lastPerfMs = null;
    },
  };
}
