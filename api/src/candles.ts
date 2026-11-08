export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const cache = new Map<string, { data: Candle[]; fetchedAt: number }>();

function ttlForInterval(interval: string): number {
  if (interval === "1s") return 800;
  if (interval === "1m") return 900;
  if (interval === "5m") return 2_500;
  if (interval === "15m") return 5_000;
  return 15_000;
}

const spotTickCache = new Map<string, { price: number; fetchedAt: number }>();

export async function fetchLiveSpotTick(asset: string): Promise<number | null> {
  const normAsset: "ETH" | "BTC" = asset.toUpperCase() === "BTC" ? "BTC" : "ETH";
  const cached = spotTickCache.get(normAsset);
  if (cached && Date.now() - cached.fetchedAt < 450) {
    return cached.price;
  }
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${normAsset}USDT`,
      { signal: AbortSignal.timeout(1500) },
    );
    if (res.ok) {
      const d = (await res.json()) as { price?: string | number };
      const px = Number(d.price);
      if (Number.isFinite(px) && px > 0) {
        spotTickCache.set(normAsset, { price: px, fetchedAt: Date.now() });
        return px;
      }
    }
  } catch {}
  return cached?.price ?? null;
}

export async function fetchCandles(
  asset: string,
  interval = "1m",
  limit = 60,
  _fallbackSpot: number | null = null,
  endTimeMs?: number,
): Promise<Candle[]> {
  const normAsset = asset.toUpperCase() === "BTC" ? "BTC" : "ETH";
  const lowerInterval = String(interval || "1m").toLowerCase();
  const mappedInterval =
    lowerInterval === "7d"
      ? "4h"
      : lowerInterval === "1d"
        ? "1d"
        : lowerInterval === "1w"
          ? "1w"
          : lowerInterval;
  const normInterval = ["1s", "1m", "5m", "15m", "1h", "4h", "1d", "1w"].includes(
    mappedInterval,
  )
    ? mappedInterval
    : "1m";
  const normLimit = Math.min(
    300,
    Math.max(10, Number.isFinite(limit) ? Math.floor(limit) : 60),
  );
  const end =
    Number.isFinite(endTimeMs) && endTimeMs! > 0
      ? Math.floor(endTimeMs!)
      : undefined;
  const cacheKey = `${normAsset}:${normInterval}:${normLimit}:${end ?? "live"}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttlForInterval(normInterval)) {
    return cached.data;
  }

  // 1. Try Binance
  try {
    const symbol = `${normAsset}USDT`;
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${normInterval}&limit=${normLimit}${end ? `&endTime=${end}` : ""}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const raw = (await res.json()) as Array<Array<number | string>>;
      if (Array.isArray(raw) && raw.length > 0) {
        const candles: Candle[] = raw
          .map((d) => ({
            time: Number(d[0]),
            open: Number(d[1]),
            high: Number(d[2]),
            low: Number(d[3]),
            close: Number(d[4]),
            volume: Number(d[5]),
          }))
          .filter(
            (c) =>
              (!end || c.time <= end) &&
              [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite),
          )
          .sort((a, b) => a.time - b.time);
        if (cache.size > 500) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, { data: candles, fetchedAt: Date.now() });
        return candles;
      }
    }
  } catch {}

  // Coinbase has no second candles. Never substitute minute bars for 1s history.
  if (normInterval === "1s") return [];
  // 2. Try Coinbase fallback (for minute / hour / day)
  try {
    const granMap: Record<string, number> = {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "1h": 3600,
      "4h": 14400,
      "1d": 86400,
      "1w": 86400,
    };
    const gran = granMap[normInterval] ?? 60;
    const pair = `${normAsset}-USD`;
    const range = end
      ? `&start=${new Date(end - normLimit * gran * 1000).toISOString()}&end=${new Date(end).toISOString()}`
      : "";
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${gran}${range}`,
      {
        headers: { "User-Agent": "Optionality" },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (res.ok) {
      const raw = (await res.json()) as Array<
        [number, number, number, number, number, number]
      >;
      if (Array.isArray(raw) && raw.length > 0) {
        const sorted = raw
          .map((d) => ({
            time: d[0] * 1000,
            low: Number(d[1]),
            high: Number(d[2]),
            open: Number(d[3]),
            close: Number(d[4]),
            volume: Number(d[5]),
          }))
          .filter(
            (c) =>
              (!end || c.time <= end) &&
              [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite),
          )
          .sort((a, b) => a.time - b.time)
          .slice(-normLimit);
        if (cache.size > 500) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, { data: sorted, fetchedAt: Date.now() });
        return sorted;
      }
    }
  } catch {}

  // An unavailable feed is a gap, never invented market history.
  return [];
}

export interface MarketStats24h {
  asset: "ETH" | "BTC";
  lastPrice: number;
  change24h: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  volumeBase24h: number;
  volumeUsd24h: number;
  trades24h: number | null;
}

const statsCache = new Map<string, { data: MarketStats24h; fetchedAt: number }>();

export async function fetchMarketStats(asset: string): Promise<MarketStats24h | null> {
  const normAsset: "ETH" | "BTC" = asset.toUpperCase() === "BTC" ? "BTC" : "ETH";
  const cached = statsCache.get(normAsset);
  if (cached && Date.now() - cached.fetchedAt < 4_000) {
    return cached.data;
  }

  // 1. Binance 24hr ticker
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${normAsset}USDT`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (res.ok) {
      const d = (await res.json()) as Record<string, string | number>;
      const stats: MarketStats24h = {
        asset: normAsset,
        lastPrice: Number(d.lastPrice),
        change24h: Number(d.priceChange),
        changePct24h: Number(d.priceChangePercent),
        high24h: Number(d.highPrice),
        low24h: Number(d.lowPrice),
        volumeBase24h: Number(d.volume),
        volumeUsd24h: Number(d.quoteVolume),
        trades24h: Number.isFinite(Number(d.count)) ? Number(d.count) : null,
      };
      if ([stats.lastPrice, stats.high24h, stats.low24h].every((v) => Number.isFinite(v) && v > 0)) {
        statsCache.set(normAsset, { data: stats, fetchedAt: Date.now() });
        return stats;
      }
    }
  } catch {}

  // 2. Coinbase 24hr stats fallback
  try {
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/${normAsset}-USD/stats`,
      {
        headers: { "User-Agent": "Optionality" },
        signal: AbortSignal.timeout(2500),
      },
    );
    if (res.ok) {
      const d = (await res.json()) as Record<string, string>;
      const open = Number(d.open);
      const last = Number(d.last);
      const high = Number(d.high);
      const low = Number(d.low);
      const vol = Number(d.volume);
      if ([open, last, high, low].every((v) => Number.isFinite(v) && v > 0)) {
        const stats: MarketStats24h = {
          asset: normAsset,
          lastPrice: last,
          change24h: last - open,
          changePct24h: ((last - open) / open) * 100,
          high24h: high,
          low24h: low,
          volumeBase24h: vol,
          volumeUsd24h: vol * last,
          trades24h: null,
        };
        statsCache.set(normAsset, { data: stats, fetchedAt: Date.now() });
        return stats;
      }
    }
  } catch {}

  return cached?.data ?? null;
}

