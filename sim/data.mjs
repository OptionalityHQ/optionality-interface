#!/usr/bin/env node
// Live market data ingestion. Everything downstream (strikes, premiums, vol,
// the demo header) comes from this file rather than a hardcoded 100/110 example,
// so the prototype is anchored to real BTC/ETH prices.
//
//   node sim/data.mjs            # fetch and print
//   node sim/data.mjs --write    # also write data/market-snapshot.json
//
// The snapshot is committed so tests and the demo builder stay offline and
// reproducible; refetching is an explicit action.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { strikeLadder } from "./pricing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", "market-snapshot.json");

export const SCALE = 1_000_000n;
export const ASSETS = {
  BTC: { coinbase: "BTC-USD", binance: "BTCUSDT", kraken: "XXBTZUSD", step: 500, widthSteps: 4 },
  ETH: { coinbase: "ETH-USD", binance: "ETHUSDT", kraken: "XETHZUSD", step: 50, widthSteps: 2 },
};

const HOURS_PER_YEAR = 24 * 365;

async function getJson(url, timeoutMs = 10_000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json", "user-agent": "bounded-options-prototype/0.1" },
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const text = await response.text();
  return { text, json: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") };
}

async function spot(asset) {
  const config = ASSETS[asset];
  const results = {};
  const attempts = [
    ["coinbase", `https://api.coinbase.com/v2/prices/${config.coinbase}/spot`, (j) => Number(j?.data?.amount)],
    ["binance", `https://api.binance.com/api/v3/ticker/price?symbol=${config.binance}`, (j) => Number(j?.price)],
    [
      "kraken",
      `https://api.kraken.com/0/public/Ticker?pair=${config.kraken}`,
      (j) => Number(Object.values(j?.result ?? {})[0]?.c?.[0]),
    ],
  ];
  for (const [name, url, pick] of attempts) {
    try {
      const { json, sha256 } = await getJson(url);
      const price = pick(json);
      if (Number.isFinite(price) && price > 0) results[name] = { price, url, sha256 };
      else results[`${name}_error`] = "unparsable payload";
    } catch (error) {
      results[`${name}_error`] = String(error.message ?? error);
    }
  }
  const prices = Object.values(results).filter((v) => typeof v?.price === "number").map((v) => v.price);
  if (prices.length === 0) throw new Error(`no spot source reachable for ${asset}`);
  prices.sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const spreadBps = ((Math.max(...prices) - Math.min(...prices)) / median) * 10_000;
  return { prices: results, median, sources: prices.length, spread_bps: Number(spreadBps.toFixed(2)) };
}

function realisedVol(closes) {
  const returns = [];
  for (let index = 1; index < closes.length; index += 1) {
    if (closes[index] > 0 && closes[index - 1] > 0) returns.push(Math.log(closes[index] / closes[index - 1]));
  }
  if (returns.length < 24) return null;
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * HOURS_PER_YEAR);
}

async function candles(asset, hours) {
  const config = ASSETS[asset];
  const sources = {};
  try {
    const { json, sha256 } = await getJson(
      `https://api.binance.com/api/v3/klines?symbol=${config.binance}&interval=1h&limit=${hours}`,
    );
    sources.binance = { closes: json.map((row) => Number(row[4])), url: "binance klines 1h", sha256 };
  } catch (error) {
    sources.binance_error = String(error.message ?? error);
  }
  try {
    const { json, sha256 } = await getJson(
      `https://api.exchange.coinbase.com/products/${config.coinbase}/candles?granularity=3600`,
      15_000,
    );
    const rows = json.slice(0, hours).reverse();
    sources.coinbase = { closes: rows.map((row) => Number(row[4])), url: "coinbase candles 1h", sha256 };
  } catch (error) {
    sources.coinbase_error = String(error.message ?? error);
  }
  const vols = Object.values(sources)
    .filter((entry) => Array.isArray(entry?.closes))
    .map((entry) => realisedVol(entry.closes))
    .filter((value) => value !== null);
  const median = vols.length ? vols.sort((a, b) => a - b)[Math.floor(vols.length / 2)] : null;
  return { candle_sources: sources, hourly_samples: vols.length ? Math.max(...Object.values(sources).map((s) => s?.closes?.length ?? 0)) : 0, vol: median, vol_by_source: vols };
}

/// A put spread whose short strike sits `otmPct` below spot, `widthSteps` rungs
/// wide. Returns integer contract terms at SCALE, matching the contract's
/// "1 price point = 1 token unit per contract" equivalence.
export function putSpreadSeries(spotPrice, { step, widthSteps, otmPct, days, nowNs }) {
  const ladder = strikeLadder(spotPrice, { step });
  const ceiling = spotPrice * (1 - otmPct);
  const high = [...ladder].reverse().find((strike) => strike <= ceiling) ?? ladder[0];
  const low = high - widthSteps * step;
  const scale = SCALE;
  const expiryNs = nowNs + BigInt(Math.round(days * 24 * 60 * 60 * 1e9));
  return {
    underlying: null,
    spot: spotPrice,
    low_strike: low,
    high_strike: high,
    width: high - low,
    moneyness_pct: Number((((spotPrice - high) / spotPrice) * 100).toFixed(2)),
    collateral_per_contract: Math.round((high - low) * Number(scale)),
    premium_collateral_ratio_hint: null,
    days,
    expiry_ns: expiryNs.toString(),
    accept_until_ns: (expiryNs + 60n * 1_000_000_000n).toString(),
    finalize_until_ns: (expiryNs + 900n * 1_000_000_000n).toString(),
    low_scaled: (BigInt(Math.round(low * Number(scale))) * 1n).toString(),
    high_scaled: (BigInt(Math.round(high * Number(scale))) * 1n).toString(),
    price_scale: scale.toString(),
    ladder,
  };
}

export async function buildSnapshot({ days = 7, otmPct = 0.02, hours = 720 } = {}) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const assets = {};
  for (const asset of Object.keys(ASSETS)) {
    const [price, candle] = await Promise.all([spot(asset), candles(asset, hours)]);
    const series = putSpreadSeries(price.median, {
      step: ASSETS[asset].step,
      widthSteps: ASSETS[asset].widthSteps,
      otmPct,
      days,
      nowNs,
    });
    series.underlying = asset;
    assets[asset] = { ...price, ...candle, series };
  }
  return {
    schema: "bounded-options/market-snapshot/1",
    fetched_at: new Date().toISOString(),
    window_hours: hours,
    terms: { days, otm_pct: otmPct },
    note: "Median of public spot endpoints; realised volatility from hourly closes. Real prices, simulated liquidity.",
    assets,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const snapshot = await buildSnapshot({
    days: Number(process.argv.includes("--days") ? process.argv[process.argv.indexOf("--days") + 1] : 7),
    otmPct: Number(
      process.argv.includes("--otm") ? process.argv[process.argv.indexOf("--otm") + 1] : 0.02,
    ),
    hours: Number(process.argv.includes("--hours") ? process.argv[process.argv.indexOf("--hours") + 1] : 720),
  });
  for (const [asset, entry] of Object.entries(snapshot.assets)) {
    const s = entry.series;
    console.log(
      `${asset}  spot ${s.spot.toLocaleString("en-US", { maximumFractionDigits: 2 })}  ` +
        `sources ${entry.sources} (${entry.spread_bps}bps apart)  ` +
        `realised vol ${entry.vol === null ? "n/a" : (entry.vol * 100).toFixed(1) + "%"}  ` +
        `put spread ${s.low_strike}/${s.high_strike} (${s.moneyness_pct}% OTM, ${s.days}d)  ` +
        `collateral ${s.collateral_per_contract / 1e6} per contract  ladder ${s.ladder.length} strikes`,
    );
  }
  if (process.argv.includes("--write")) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`\nwrote ${OUT}`);
  }
}
