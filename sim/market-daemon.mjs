#!/usr/bin/env node
// Headless market service: owns the book, runs bot makers/bidders and taker
// flow on live prices, and serves the trading screen over HTTP.
//
//   node sim/market-daemon.mjs            # http://127.0.0.1:8787
//   node sim/market-daemon.mjs --port 9000 --quiet
//
// The screen is a thin client: it polls /state and posts /action. If this
// process is not running, the screen falls back to model quotes and says so.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bank, Ledger } from "./market.mjs";
import { PriceFeed, contractAcceptsObservation } from "./feed.mjs";
import { spreadValue, spreadGreeks, strikeLadder, putGreeks, smileVol } from "./pricing.mjs";
import { payout, payoutCall } from "./accounting.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = JSON.parse(readFileSync(join(here, "..", "data", "market-snapshot.json"), "utf8"));

const SCALE = 1_000_000n;
const MAKERS = ["maker-1", "maker-2", "maker-3"];
const BIDDERS = ["bidder-1", "bidder-2"];
const TAKERS = ["taker-1", "taker-2", "taker-3"];
const YOU = "you";
const ACCOUNTS = [...MAKERS, ...BIDDERS, ...TAKERS, YOU];
const FUNDING = 5_000_000n * SCALE;
const MIN_CONFIDENCE = 3_000n;
const WIDTH_RUNGS = 4;
const QUOTE_CONTRACTS = 3;
const TARGET_TPS = 25;
// A series holding this many open tickets gets fixed and settled by the
// recycler, which is what returns the makers' collateral to circulation.
const RECYCLE_TICKETS = 40;
// Orders posted from the screen outlive the demo of a click: an hour is long
// enough for a maker to come back and take it, short enough that the book the
// next visitor sees is not littered with yesterday's quotes.
const HOUR_NS = 3_600_000_000_000n;
// Derive's public stats, read from its Stats page on 2026-10-28:
// $68.79M 24h volume, $43.09B lifetime, 5.23M trades, $10.93M fees, $4.21B OI.
const DERIVE_REFERENCE = {
  volume24h: 68_790_000,
  volumeLifetime: 43_090_000_000,
  tradesLifetime: 5_230_000,
  feesLifetime: 10_930_000,
  openInterest: 4_210_000_000,
  uniqueTraders: 27_208,
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const PORT = Number(flag("port", 8787));
const RATE = Math.max(1, Number(flag("tps", TARGET_TPS)));
const QUIET = args.includes("--quiet");

/* ---------------- expiries ---------------- */
function expiryList(now = new Date()) {
  const at8 = (date) => {
    const copy = new Date(date);
    copy.setUTCHours(8, 0, 0, 0);
    return copy;
  };
  const dates = [];
  for (let index = 1; index <= 4; index += 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + index);
    dates.push(at8(date));
  }
  const friday = new Date(now);
  friday.setUTCDate(friday.getUTCDate() + ((5 - friday.getUTCDay() + 7) % 7 || 7));
  for (let index = 0; index < 7; index += 1) {
    const date = at8(new Date(friday));
    date.setUTCDate(date.getUTCDate() + index * 7);
    dates.push(date);
  }
  const unique = [...new Map(dates.map((date) => [date.toISOString(), date])).values()]
    .filter((date) => date.getTime() > now.getTime() + 3_600_000)
    .sort((a, b) => a - b);
  return unique.map((date) => ({
    iso: date.toISOString(),
    date,
    label: date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getUTCFullYear() !== now.getUTCFullYear() ? "numeric" : undefined,
      timeZone: "UTC",
    }),
    dte: Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 86_400_000)),
  }));
}

let EXPIRIES = expiryList();

/// The expiry the screen is on. Bots quote it, /state and /action read it, so
/// picking a date in the UI changes the market rather than only the caption.
function selectedExpiry() {
  return EXPIRIES.find((expiry) => expiry.iso === market.expiryIso) ?? EXPIRIES[0];
}

function chooseExpiry(value) {
  if (!value) return;
  const wanted = String(value);
  const match = EXPIRIES.find(
    (expiry) => expiry.iso === wanted || expiry.iso.slice(0, 10) === wanted.slice(0, 10) || expiry.label === wanted,
  );
  if (match) market.expiryIso = match.iso;
}

/* ---------------- market ---------------- */
const bank = new Bank();
for (const account of ACCOUNTS) bank.deposit(account, FUNDING);

const market = {
  bank,
  ledgers: new Map(),
  trades: [],
  expiryIso: null,
  ladderCache: new Map(),
  fills: [],
  ops: [],
  prints: 0,
  volume: { premium: 0, notional: 0, contracts: 0 },
  buckets: [],
  /// Per-venue index prints: the exchanges keep trading even when no option
  /// does, and this is what makes the tape honest rather than decorative.
  indexPrints: [],
  /// Structured fills, newest first, for the streaming tape.
  tape: [],
  /// Closed and settled tickets for the demo user, with the realised number.
  realised: 0,
  closed: [],
  /// The series the screen is on: the recycler leaves it alone so a viewer
  /// never watches their own selection settle out from under them.
  focus: null,
  /// Live SSE clients and the last broadcast value per channel, so a client
  /// only ever receives a frame whose numbers actually moved.
  clients: new Set(),
  lastSent: {},
};

function stamp(list) {
  const now = Date.now();
  list.push(now);
  const cutoff = now - 1_000;
  while (list.length && list[0] < cutoff) list.shift();
  return list.length;
}

/// Ticker-style instrument tag. Only abbreviate where the thousands digit is
/// not load bearing: ETH strikes sit 25 apart, so 2.1k/2.2k would print two
/// different instruments identically.
const kfmt = (value) => (value >= 100_000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k` : `${value}`);
const tickerOf = (entry) => `${entry.asset} ${entry.kind === "Put" ? "P" : "C"}${kfmt(entry.low)}/${kfmt(entry.high)}`;

function stepFor(asset) {
  return asset === "BTC" ? 1_000 : 25;
}

function widthFor(asset) {
  return WIDTH_RUNGS * stepFor(asset);
}

function legsFor(kind, strike, asset) {
  const width = widthFor(asset);
  return kind === "Put" ? { low: strike - width, high: strike } : { low: strike, high: strike + width };
}

function spotFor(asset) {
  return feed?.state().assets?.[asset]?.median ?? SNAPSHOT.assets[asset]?.series?.spot ?? null;
}

function volFor(asset) {
  const vol = SNAPSHOT.assets[asset]?.vol;
  return typeof vol === "number" && vol > 0.05 ? vol : 0.6;
}

function yearsTo(expiry) {
  return Math.max((expiry.date.getTime() - Date.now()) / 1000 / (365 * 86_400), 0);
}

function ladderFor(asset) {
  const spot = spotFor(asset);
  if (spot === null) return [];
  const step = stepFor(asset);
  const bucket = Math.round(spot / step);
  const cached = market.ladderCache.get(asset);
  if (cached && cached.bucket === bucket) return cached.ladder;
  const ladder = strikeLadder(spot, { step, nearSteps: 0, count: 18 });
  market.ladderCache.set(asset, { bucket, ladder });
  return ladder;
}

function ledgerFor(asset, expiry, kind, strike) {
  const key = `${asset}|${expiry.iso.slice(0, 10)}|${kind}|${strike}`;
  if (!market.ledgers.has(key)) {
    const { low, high } = legsFor(kind, strike, asset);
    if (!(high > low) || low <= 0) return null;
    const expiryNs = BigInt(expiry.date.getTime()) * 1_000_000n;
    const ledger = new Ledger(
      {
        scale: SCALE,
        low: BigInt(Math.round(low * Number(SCALE))),
        high: BigInt(Math.round(high * Number(SCALE))),
        kind,
        expiryNs,
        acceptUntilNs: expiryNs + 60n * 1_000_000_000n,
        finalizeUntilNs: expiryNs + 900n * 1_000_000_000n,
        minConfidenceBps: MIN_CONFIDENCE,
      },
      bank,
    );
    market.ledgers.set(key, { key, ledger, asset, expiry, kind, strike, low, high, stamp: 0 });
  }
  return market.ledgers.get(key);
}

function quoteOf(entry) {
  const spot = spotFor(entry.asset);
  const years = yearsTo(entry.expiry);
  const atmVol = volFor(entry.asset);
  if (spot === null || years <= 0) return null;
  const mark = spreadValue({ spot, low: entry.low, high: entry.high, kind: entry.kind, atmVol, years });
  const half = Math.max(mark * 0.04, 0.02);
  const greeks = spreadGreeks({ spot, low: entry.low, high: entry.high, kind: entry.kind, atmVol, years });
  return { spot, years, mark, bid: Math.max(0.01, mark - half), ask: mark + half, delta: greeks.delta };
}

function solveIv({ price, spot, low, high, kind, years }) {
  if (!(price > 0) || years <= 0) return null;
  let lo = 0.03;
  let hi = 3;
  for (let index = 0; index < 40; index += 1) {
    const mid = (lo + hi) / 2;
    if (spreadValue({ spot, low, high, kind, atmVol: mid, years, skew: 0 }) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/// Bots: keep two-sided quotes on every listed series for the active expiry.
/// A series is repriced when its mark has moved enough to show on screen, not
/// on a fixed clock: that is what makers do, and it is why the chain tracks the
/// live index instead of ticking once a second.
const REQUOTE_INTERVAL_MS = 250;
const REQUOTE_IDLE_GRACE_MS = 2_000;

function requoteThreshold(mark) {
  // A quarter of one percent of the premium, wherever in the chain it is. The
  // old one-display-cent floor froze the cheap ends: a $0.05 spread needed a
  // 20% move before its quote followed the index at all.
  return mark * 0.0025 + 1e-5;
}

function requoteAll(force = false) {
  const now = Date.now();
  for (const asset of ["ETH", "BTC"]) {
    const expiry = selectedExpiry();
    for (const strike of ladderFor(asset)) {
      for (const kind of ["Put", "Call"]) {
        let entry = ledgerFor(asset, expiry, kind, strike);
        if (!entry) continue;
        // A settled series with nothing left in it is finished: drop it so the
        // same strike can host a live book again instead of sitting on the
        // ladder as a row nobody can trade.
        if (
          entry.ledger.settlement !== "Open" &&
          entry.ledger.tickets.size === 0 &&
          entry.ledger.offers.size === 0 &&
          entry.ledger.bids.size === 0
        ) {
          market.ledgers.delete(entry.key);
          entry = ledgerFor(asset, expiry, kind, strike);
          if (!entry) continue;
        }
        const q = quoteOf(entry);
        if (!q) continue;
        const moved =
          entry.lastMark === undefined || Math.abs(q.mark - entry.lastMark) >= requoteThreshold(entry.lastMark ?? q.mark);
        if (!force && !moved && now - entry.stamp < REQUOTE_IDLE_GRACE_MS) continue;
        entry.lastMark = q.mark;
        entry.stamp = now;
        const simNow = BigInt(now) * 1_000_000n;
        const life = BigInt(Math.max(1, Math.round(Number(entry.ledger.series.expiryNs - simNow) / 2)));
        const premiumOf = (mult) => BigInt(Math.max(1, Math.round(mult * Number(SCALE) * QUOTE_CONTRACTS)));
        MAKERS.forEach((maker, index) => {
          for (const offer of [...entry.ledger.offers.values()]) {
            if (offer.maker === maker) {
              try { entry.ledger.cancelOffer({ id: offer.id, caller: maker }); } catch { /* filled */ }
            }
          }
          try {
            entry.ledger.postOffer({
              maker, quantity: SCALE * BigInt(QUOTE_CONTRACTS),
              premium: premiumOf(q.ask * [1, 1.01, 1.02][index % 3]),
              expiresNs: simNow + life, nowNs: simNow,
            });
            stamp(market.ops);
          } catch { /* capacity */ }
        });
        BIDDERS.forEach((owner, index) => {
          for (const bid of [...entry.ledger.bids.values()]) {
            if (bid.owner === owner) {
              try { entry.ledger.cancelBid({ id: bid.id, caller: owner }); } catch { /* filled */ }
            }
          }
          try {
            entry.ledger.postBid({
              owner, quantity: SCALE * BigInt(QUOTE_CONTRACTS),
              premium: premiumOf(q.bid * [1, 0.99][index % 2]),
              expiresNs: simNow + life, nowNs: simNow,
            });
            stamp(market.ops);
          } catch { /* capacity */ }
        });
      }
    }
  }
}

/// `fill` carries what was traded, so the tape and the volume counters agree.
function record(text, fill = null) {
  const at = new Date().toISOString().slice(11, 23);
  market.trades.unshift(`${at.slice(0, 8)} ${text}`);
  market.trades = market.trades.slice(0, 240);
  const print = {
    at,
    text,
    side: fill ? (/\bbought\b|\bbid\b/.test(text) ? "buy" : "sell") : "quote",
    series: fill?.series ?? null,
    size: null,
    price: null,
  };
  if (fill) {
    market.prints += 1;
    stamp(market.fills);
    const contracts = Number(fill.contracts);
    const notional = contracts * (fill.spot ?? 0);
    const premium = Number(fill.premium);
    market.volume.contracts += contracts;
    market.volume.notional += notional;
    market.volume.premium += premium;
    print.size = contracts;
    print.price = contracts ? premium / contracts : null;
    print.notional = notional;
    const second = Math.floor(Date.now() / 1000);
    let bucket = market.buckets[market.buckets.length - 1];
    if (!bucket || bucket.t !== second) {
      bucket = { t: second, notional: 0, premium: 0, trades: 0, contracts: 0 };
      market.buckets.push(bucket);
      while (market.buckets.length > 60) market.buckets.shift();
    }
    bucket.notional += notional;
    bucket.premium += premium;
    bucket.trades += 1;
    bucket.contracts += contracts;
  }
  market.tape.unshift(print);
  if (market.tape.length > 60) market.tape.pop();
  if (!QUIET) console.log(text);
}

/// Taker flow: anonymous takers cross the spread, so trades print without the
/// user doing anything. Sizes come in whole quote lots because the book fills
/// offers whole: a 1-contract order against a 3-contract offer is an attempt
/// that never prints, which is what made the tape look dead.
const LOTS = [1, 1, 1, 2, 3];

/// Real option flow concentrates near the money: pick a ladder rung with a
/// triangular weight so the tape is not mostly $0.01 deep-OTM noise.
function pickStrike(ladder) {
  const centre = (ladder.length - 1) / 2;
  const weights = ladder.map((_, index) => 1 / (1 + Math.abs(index - centre) ** 1.6));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let draw = Math.random() * total;
  for (let index = 0; index < ladder.length; index += 1) {
    draw -= weights[index];
    if (draw <= 0) return ladder[index];
  }
  return ladder[Math.round(centre)];
}

function takerFlow() {
  const asset = Math.random() < 0.5 ? "ETH" : "BTC";
  const ladder = ladderFor(asset);
  if (!ladder.length) return;
  const strike = pickStrike(ladder);
  const kind = Math.random() < 0.55 ? "Put" : "Call";
  const entry = ledgerFor(asset, selectedExpiry(), kind, strike);
  if (!entry || entry.ledger.settlement !== "Open") return;
  if (entry.ledger.tickets.size > 80) return;
  const taker = TAKERS[Math.floor(Math.random() * TAKERS.length)];
  const quantity = SCALE * BigInt(QUOTE_CONTRACTS * LOTS[Math.floor(Math.random() * LOTS.length)]);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const label = `${kind.toLowerCase()} $${entry.low}/${entry.high} ${asset}`;
  const ticker = tickerOf(entry);
  try {
    if (Math.random() < 0.6) {
      const q = quoteOf(entry);
      // Premiums are scaled by SCALE per contract, so the budget has to be too:
      // a contracts-times-ask figure alone is a million times too small and
      // every sweep would bounce off the budget check.
      const fill = entry.ledger.fillMarketOrder({
        buyer: taker, quantity,
        maxTotalPremium: BigInt(Math.round(Number(quantity / SCALE) * (q.ask + 0.5))) * SCALE,
        nowNs,
      });
      const contracts = Number(fill.filledQuantity / SCALE);
      record(`${taker} bought ${contracts}x ${label} @ ${(Number(fill.totalPremium) / Number(SCALE) / contracts).toFixed(2)}`, {
        contracts,
        premium: Number(fill.totalPremium) / Number(SCALE),
        spot: spotFor(asset),
        series: ticker,
      });
    } else {
      const bids = entry.ledger.bids_(nowNs, 50);
      if (!bids.length) return;
      const best = bids[0];
      if (best.quantity > quantity) return;
      const sell = entry.ledger.fillBid({ id: best.bidId, seller: taker, nowNs });
      record(`${taker} sold ${Number(best.quantity) / Number(SCALE)}x ${label} to ${best.owner}`, {
        contracts: Number(best.quantity) / Number(SCALE),
        premium: Number(best.premium) / Number(SCALE),
        spot: spotFor(asset),
        series: ticker,
      });
      void sell;
    }
  } catch { /* thin book on that strike: skip silently */ }
}

/// Settlement recycler: a series whose book is heavy gets fixed on the live
/// print and settled, which is what releases the makers' collateral for the
/// next round. Without it the bots quote themselves out of capital in minutes.
function recycle() {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const focused = market.focus;
  const busy = [...market.ledgers.values()]
    .filter((item) => item.ledger.settlement === "Open" && item.ledger.tickets.size >= RECYCLE_TICKETS)
    .filter((item) => !(focused && item.asset === focused.asset && item.kind === focused.kind && item.strike === focused.strike))
    .sort((a, b) => b.ledger.tickets.size - a.ledger.tickets.size)
    .slice(0, 6);
  for (const entry of busy) {
    try {
      expireSeries(entry, nowNs);
      const settled = settleSeries(entry);
      if (settled) retireSeries(entry);
    } catch { /* a print arrived too late for this round */ }
  }
}

/* ---------------- feed ---------------- */
let feed = null;
function startFeed() {
  feed = new PriceFeed({
    handlers: {
      // Every venue print is kept: the exchanges trade continuously even when
      // no option crosses, and that is the honest source of the tape's motion.
      onTick: (print) => {
        market.indexPrints.unshift({
          at: new Date().toISOString().slice(11, 23),
          venue: print.source,
          asset: print.asset,
          price: print.price,
        });
        if (market.indexPrints.length > 80) market.indexPrints.pop();
      },
      onStatus: () => {},
    },
    options: { staleMs: 15_000, degenerateSpreadBps: 40, confidencePenaltyPerBp: 12 },
  });
  feed.start();
}

/* ---------------- stream ---------------- */
/// The screen's fast numbers come from here, not from polling /state: index
/// prints, book heads and fills are pushed as they happen. /state stays the
/// heavy snapshot (accounts, tickets, IV) and is polled far less often.
function quoteRows(asset) {
  const expiry = selectedExpiry();
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  return ladderFor(asset).map((strike) => {
    const side = (kind) => {
      const entry = ledgerFor(asset, expiry, kind, strike);
      if (!entry) return null;
      const q = quoteOf(entry);
      const offers = entry.ledger.book(nowNs, 5);
      const bids = entry.ledger.bids_(nowNs, 5);
      return {
        low: entry.low,
        high: entry.high,
        mark: q ? q.mark : null,
        delta: q ? q.delta : null,
        bid: bids.length ? Number(bids[0].unitPremium) / Number(SCALE) : q ? q.bid : null,
        ask: offers.length ? Number(offers[0].unitPremium) / Number(SCALE) : q ? q.ask : null,
        // A price with nothing resting behind it is the model talking, not the
        // market: the screen must be able to tell the two apart.
        bidModel: bids.length === 0,
        askModel: offers.length === 0,
        bidSize: bids.length ? Number(bids[0].quantity) / Number(SCALE) : 0,
        askSize: offers.length ? Number(offers[0].quantity) / Number(SCALE) : 0,
        depth: entry.ledger.offers.size + entry.ledger.bids.size,
      };
    };
    return { strike, call: side("Call"), put: side("Put") };
  });
}

function indexFrame() {
  const state = feed?.state();
  if (!state) return null;
  return {
    status: state.status,
    connected: state.connectedSources,
    ticks: state.ticks,
    reconnects: state.reconnects,
    assets: Object.fromEntries(
      Object.entries(state.assets).map(([asset, value]) => [
        asset,
        {
          median: value.median,
          spreadBps: value.spreadBps,
          confidenceBps: value.confidenceBps,
          freshSources: value.freshSources,
          ageMs: value.ageMs,
          sources: (value.sources ?? []).map((source) => ({
            name: source.name,
            price: source.price,
            ageMs: source.ageMs,
            ticks: source.ticks ?? 0,
          })),
        },
      ]),
    ),
  };
}

function flowFrame() {
  // Trailing rate over the last ten whole seconds: a lifetime average would
  // hide whether the market is live right now.
  const whole = market.buckets.slice(-11, -1);
  const sum = (key) => whole.reduce((total, bucket) => total + bucket[key], 0);
  const seconds = whole.length || 1;
  return {
    fillsPerSecond: market.fills.length,
    opsPerSecond: market.ops.length,
    prints: market.prints,
    series: market.ledgers.size,
    rate: {
      trades: sum("trades") / seconds,
      notional: sum("notional") / seconds,
      premium: sum("premium") / seconds,
      contracts: sum("contracts") / seconds,
      window: whole.length,
    },
    volume: {
      premium: market.volume.premium,
      notional: market.volume.notional,
      contracts: market.volume.contracts,
    },
  };
}

function send(client, frame) {
  try {
    client.res.write(`data: ${JSON.stringify(frame)}\n\n`);
  } catch {
    market.clients.delete(client);
  }
}

function pumpStream() {
  if (!market.clients.size) return;
  for (const client of market.clients) {
    const index = indexFrame();
    const signature = `${index?.ticks ?? 0}|${market.tape.length ? market.tape[0].at + market.tape[0].text : ""}|${market.prints}`;
    if (client.last === signature) continue;
    client.last = signature;
    send(client, {
      at: Date.now(),
      index,
      quotes: quoteRows(client.asset),
      tape: market.tape.slice(0, 14),
      prints: market.indexPrints.slice(0, 16),
      flow: flowFrame(),
      spot: spotFor(client.asset),
    });
  }
}

/* ---------------- state ---------------- */
function chainState(asset) {
  const expiry = selectedExpiry();
  const spot = spotFor(asset);
  return ladderFor(asset).map((strike) => {
    const side = (kind) => {
      const entry = ledgerFor(asset, expiry, kind, strike);
      if (!entry) return null;
      const q = quoteOf(entry);
      if (!q) return null;
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const offers = entry.ledger.book(nowNs, 50);
      const bids = entry.ledger.bids_(nowNs, 50);
      const bestOffer = offers.length ? offers[0] : null;
      const bestBid = bids.length ? bids[0] : null;
      const ask = bestOffer ? Number(bestOffer.unitPremium) / Number(SCALE) : q.ask;
      const bid = bestBid ? Number(bestBid.unitPremium) / Number(SCALE) : q.bid;
      const seed = (strike * 7919 + (kind === "Put" ? 13 : 29)) % 97;
      // Deep in-the-money spreads barely respond to vol; a solved IV there is
      // noise, and a solution pinned to a search bound identifies nothing.
      const legStrike = kind === "Put" ? entry.high : entry.low;
      const legVega = putGreeks({
        spot: q.spot, strike: legStrike,
        vol: smileVol({ spot: q.spot, strike: legStrike, atmVol: volFor(entry.asset) }),
        years: q.years,
      }).vega;
      const quoteIv = (price) => {
        if (legVega < 0.05) return null;
        const iv = solveIv({ price, spot: q.spot, low: entry.low, high: entry.high, kind, years: q.years });
        return iv === null || iv < 0.06 || iv > 2.4 ? null : iv;
      };
      return {
        bid,
        ask,
        mark: q.mark,
        bidIv: quoteIv(bid),
        askIv: quoteIv(ask),
        markIv: quoteIv(q.mark),
        delta: q.delta,
        bidSize: bestBid ? Number(bestBid.quantity) / Number(SCALE) : 0,
        askSize: bestOffer ? Number(bestOffer.quantity) / Number(SCALE) : 0,
        bidCount: bids.length,
        offerCount: offers.length,
        low: entry.low,
        high: entry.high,
        seed,
      };
    };
    return { strike, call: side("Call"), put: side("Put") };
  });
}

function custody() {
  const escrow = [...market.ledgers.values()].reduce((total, item) => total + item.ledger.escrow(), 0n);
  const total = bank.available + escrow;
  return {
    total: Number(total) / Number(SCALE),
    ok: bank.netDeposited === total && bank.balanceSum() === bank.available,
    escrow: Number(escrow) / Number(SCALE),
  };
}

function accountsState() {
  const rows = [];
  for (const account of ACCOUNTS) {
    const escrow = [...market.ledgers.values()].reduce((total, item) => {
      const offers = [...item.ledger.offers.values()].filter((offer) => offer.maker === account)
        .reduce((sum, offer) => sum + offer.collateral, 0n);
      const bids = [...item.ledger.bids.values()].filter((bid) => bid.owner === account)
        .reduce((sum, bid) => sum + bid.premium, 0n);
      const tickets = [...item.ledger.tickets.values()]
        .filter((ticket) => ticket.maker === account || ticket.buyer === account)
        .reduce((sum, ticket) => sum + (ticket.maker === account ? ticket.collateral : ticket.premium), 0n);
      return total + offers + bids + tickets;
    }, 0n);
    const cash = bank.balance(account);
    rows.push({
      account,
      available: Number(cash) / Number(SCALE),
      escrow: Number(escrow) / Number(SCALE),
      net: Number(cash + escrow - FUNDING) / Number(SCALE),
      role: MAKERS.includes(account) ? "maker" : BIDDERS.includes(account) ? "bidder" : TAKERS.includes(account) ? "taker" : "you",
    });
  }
  return rows;
}

function ticketsState() {
  const rows = [];
  for (const item of market.ledgers.values()) {
    for (const ticket of item.ledger.tickets.values()) {
      rows.push({
        id: Number(ticket.id),
        series: `${item.expiry.label} $${item.low}/${item.high} ${item.kind}`,
        buyer: ticket.buyer,
        maker: ticket.maker,
        quantity: Number(ticket.quantity) / Number(SCALE),
        premium: Number(ticket.premium) / Number(SCALE),
        collateral: Number(ticket.collateral) / Number(SCALE),
      });
    }
  }
  return rows.slice(0, 60);
}

/// Every ticket an account holds, marked against the live book. A long is
/// worth the payoff the current print would produce, a short owes exactly that,
/// and the close price is the best whole-size quote on the right side.
function positionsState(account) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const rows = [];
  let unrealised = 0;
  let atRisk = 0;
  for (const item of market.ledgers.values()) {
    const spot = spotFor(item.asset);
    for (const held of item.ledger.positions_(account)) {
      const contracts = Number(held.quantity) / Number(SCALE);
      const cost = Number(held.cost) / Number(SCALE);
      const premium = Number(held.premium) / Number(SCALE);
      const collateral = Number(held.collateral) / Number(SCALE);
      const q = quoteOf(item);
      const payoffAt = spot === null || q === null
        ? null
        : Number(payoutFor(item, spot, held.quantity)) / Number(SCALE);
      // A close needs a whole-size quote from somebody who is not the holder.
      const whole = (list) =>
        list.find((row) => row.quantity === held.quantity && row.owner !== account && row.maker !== account);
      const exitBid = whole(item.ledger.bids_(nowNs, 50));
      const exitAsk = whole(item.ledger.book(nowNs, 50));
      const exitUnit = held.side === "long"
        ? (exitBid ? Number(exitBid.unitPremium) / Number(SCALE) : null)
        : (exitAsk ? Number(exitAsk.unitPremium) / Number(SCALE) : null);
      // Unrealised is what the ticket is worth on the book now, not what it
      // would pay out if the series fixed this second: the mark column sits
      // beside it, so the two have to agree. `payoff` keeps the expiry figure.
      const markValue = q === null ? null : q.mark * contracts;
      // Long: mark minus what was paid. Short: premium kept minus mark owed.
      const open = markValue === null ? null : held.side === "long" ? markValue - cost : premium - markValue;
      const closed =
        exitUnit === null || markValue === null
          ? null
          : held.side === "long"
            ? exitUnit * contracts - cost
            : premium - exitUnit * contracts;
      if (open !== null) unrealised += open;
      if (held.side === "short") atRisk += collateral;
      rows.push({
        ticketId: Number(held.id),
        seriesKey: item.key,
        series: `${item.asset} ${item.kind === "Put" ? "P" : "C"}${kfmt(item.low)}/${kfmt(item.high)}`,
        expiry: item.expiry.label,
        expiryIso: item.expiry.iso,
        side: held.side,
        contracts,
        cost,
        premium,
        collateral,
        payoff: payoffAt,
        mark: q ? q.mark : null,
        exitUnit,
        exitSize: exitUnit === null ? 0 : contracts,
        open,
        ifClosed: closed,
        settlement: item.ledger.settlement,
        fixedPrice: item.ledger.fixed ? Number(item.ledger.fixed.price) / Number(SCALE) : null,
        closable: held.side === "long" && item.ledger.settlement === "Open" && exitBid !== undefined,
        closeBlock: held.side === "short"
          ? "a short needs a new maker to take the collateral"
          : item.ledger.settlement !== "Open"
            ? "series already settled"
            : exitBid === undefined
              ? "no whole-size bid to sell into"
              : null,
      });
    }
  }
  rows.sort((a, b) => Math.abs(b.open ?? 0) - Math.abs(a.open ?? 0));
  return {
    rows,
    totals: {
      open: unrealised,
      atRisk,
      positions: rows.length,
      closable: rows.filter((row) => row.closable).length,
    },
  };
}

/// Payoff the current print would produce for a held quantity, scaled.
function payoutFor(item, spot, quantity) {
  const price = BigInt(Math.round(spot * Number(SCALE)));
  const value = item.kind === "Call"
    ? payoutCall(quantity, SCALE, item.ledger.series.high, item.ledger.series.low, price)
    : payout(quantity, SCALE, item.ledger.series.high, item.ledger.series.low, price);
  return value ?? 0n;
}

function ordersState() {
  const rows = [];
  for (const item of market.ledgers.values()) {
    for (const offer of item.ledger.offers.values()) {
      rows.push({ series: `${item.expiry.label} $${item.low}/${item.high} ${item.kind}`, side: "ask", who: offer.maker, quantity: Number(offer.quantity) / Number(SCALE), premium: Number(offer.premium) / Number(SCALE) });
    }
    for (const bid of item.ledger.bids.values()) {
      rows.push({ series: `${item.expiry.label} $${item.low}/${item.high} ${item.kind}`, side: "bid", who: bid.owner, quantity: Number(bid.quantity) / Number(SCALE), premium: Number(bid.premium) / Number(SCALE) });
    }
  }
  return rows.slice(0, 80);
}

function seriesState(asset, kind, strike) {
  const entry = ledgerFor(asset, selectedExpiry(), kind, strike);
  if (!entry) return null;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const offers = entry.ledger.book(nowNs, 50).map((offer) => ({ who: offer.maker, quantity: Number(offer.quantity) / Number(SCALE), premium: Number(offer.premium) / Number(SCALE) }));
  const bids = entry.ledger.bids_(nowNs, 50).map((bid) => ({ who: bid.owner, quantity: Number(bid.quantity) / Number(SCALE), premium: Number(bid.premium) / Number(SCALE) }));
  return {
    kind,
    strike,
    low: entry.low,
    high: entry.high,
    expiry: entry.expiry.label,
    expiryIso: entry.expiry.iso,
    settlement: entry.ledger.settlement,
    settledPrice: entry.ledger.fixed ? Number(entry.ledger.fixed.price) / Number(SCALE) : null,
    offers,
    bids,
  };
}

function fullState(query) {
  const asset = query.asset === "BTC" ? "BTC" : "ETH";
  const kind = query.kind === "Call" ? "Call" : "Put";
  const strike = Number(query.strike) || null;
  market.focus = strike ? { asset, kind, strike } : null;
  const feedState = feed?.state();
  return {
    now: Date.now(),
    feed: feedState
      ? {
          status: feedState.status,
          connectedSources: feedState.connectedSources,
          ticks: feedState.ticks,
          reconnects: feedState.reconnects,
          assets: Object.fromEntries(
            Object.entries(feedState.assets).map(([key, value]) => [
              key,
              {
                median: value.median,
                spreadBps: value.spreadBps,
                confidenceBps: value.confidenceBps,
                ageMs: value.ageMs,
                freshSources: value.freshSources,
                sources: (value.sources ?? []).map((source) => ({ name: source.name, price: source.price, ageMs: source.ageMs })),
              },
            ]),
          ),
        }
      : null,
    snapshot: { fetched_at: SNAPSHOT.fetched_at, vol: { ETH: volFor("ETH"), BTC: volFor("BTC") } },
    expiries: EXPIRIES.map((expiry) => ({ iso: expiry.iso, label: expiry.label, dte: expiry.dte })),
    chain: chainState(asset),
    spot: spotFor(asset),
    series: strike ? seriesState(asset, kind, strike) : null,
    accounts: accountsState(),
    tickets: ticketsState(),
    positions: positionsState(YOU),
    portfolio: { realised: market.realised, closed: market.closed },
    orders: ordersState(),
    trades: market.trades,
    custody: custody(),
    seriesCount: market.ledgers.size,
    throughput: flowFrame(),
    volumeBuckets: market.buckets.map((bucket) => ({
      t: bucket.t,
      notional: bucket.notional,
      premium: bucket.premium,
      trades: bucket.trades,
      contracts: bucket.contracts,
    })),
    reference: DERIVE_REFERENCE,
    targetTps: RATE,
  };
}

/* ---------------- settlement ---------------- */

/// Fix a series on the live composite print. A demo cannot wait days for the
/// real expiry, so the print is stamped at expiry + 5 s. That is an accelerated
/// settlement clock, not a claim that this print was ever accepted on chain.
function expireSeries(entry, nowNs = BigInt(Date.now()) * 1_000_000n) {
  const observation = feed?.observation(entry.asset);
  if (!observation) throw new Error("feed is not live");
  const at = entry.ledger.series.expiryNs + 5n * 1_000_000_000n;
  const verdict = contractAcceptsObservation(
    { ...observation, publishTimeNs: at },
    {
      scale: SCALE,
      low: entry.ledger.series.low,
      high: entry.ledger.series.high,
      expiryNs: entry.ledger.series.expiryNs,
      acceptUntilNs: entry.ledger.series.acceptUntilNs,
      minConfidenceBps: entry.ledger.series.minConfidenceBps,
    },
    at,
  );
  if (!verdict.ok) throw new Error(verdict.reason);
  const fixed = entry.ledger.requestSettlement({
    observations: [{ price: verdict.scaled, publishTimeNs: at, confidenceBps: BigInt(observation.confidenceBps) }],
    nowNs: at,
  });
  if (!fixed) throw new Error("no print accepted");
  record(`series_fixed ${seriesLabel(entry)} @ ${observation.price.toFixed(2)} (conf ${observation.confidenceBps} bps) · accelerated clock`);
  return observation;
}

/// A closed ticket is the only place a realised number exists: the open book
/// shows what a position is worth now, this shows what it actually returned.
function bookRealised(row) {
  market.realised += row.pnl;
  market.closed.unshift(row);
  market.closed = market.closed.slice(0, 80);
}

function settleSeries(entry) {
  let count = 0;
  for (const id of [...entry.ledger.tickets.keys()]) {
    const held = entry.ledger.tickets.get(id);
    const result = entry.ledger.settleTicket({ id });
    const contracts = Number(held.quantity) / Number(SCALE);
    const buyerCredit = Number(result.buyer) / Number(SCALE);
    const makerCredit = Number(result.maker) / Number(SCALE);
    const at = new Date().toISOString().slice(11, 19);
    const series = tickerOf(entry);
    if (held.buyer === YOU) {
      const cost = Number(held.cost) / Number(SCALE);
      bookRealised({ at, series, side: "long", contracts, cost, proceeds: buyerCredit, pnl: buyerCredit - cost, via: "settled" });
    }
    if (held.maker === YOU) {
      const collateral = Number(held.collateral) / Number(SCALE);
      bookRealised({ at, series, side: "short", contracts, cost: collateral, proceeds: makerCredit, pnl: makerCredit - collateral, via: "settled" });
    }
    record(
      `ticket_settled #${id} ${seriesLabel(entry)} buyer +${(Number(result.buyer) / Number(SCALE)).toFixed(2)} maker +${(Number(result.maker) / Number(SCALE)).toFixed(2)}`,
    );
    count += 1;
  }
  return count;
}

/// A settled series stops being tradable, so its resting quotes are pulled and
/// the cleanup pass can drop it instead of leaking ledgers forever.
function retireSeries(entry) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  for (const offer of [...entry.ledger.offers.values()]) {
    try { entry.ledger.cancelOffer({ id: offer.id, caller: offer.maker }); } catch { /* settled */ }
  }
  for (const bid of [...entry.ledger.bids.values()]) {
    try { entry.ledger.cancelBid({ id: bid.id, caller: bid.owner }); } catch { /* settled */ }
  }
  void nowNs;
}

const seriesLabel = (entry) => `${entry.kind.toLowerCase()} $${entry.low}/${entry.high} ${entry.asset}`;

/* ---------------- actions ---------------- */
function handleAction(body) {
  const asset = body.asset === "BTC" ? "BTC" : "ETH";
  const kind = body.kind === "Call" ? "Call" : "Put";
  chooseExpiry(body.expiry);
  const strike = Number(body.strike);
  const entry = ledgerFor(asset, selectedExpiry(), kind, strike);
  if (!entry) throw new Error("unknown series");
  const quantity = BigInt(Math.max(1, Math.floor(Number(body.quantity) || 1))) * SCALE;
  const limit = Number(body.limit);
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const premiumOf = (mult) => BigInt(Math.max(1, Math.round(Number(quantity) * mult)));
  const label = `${kind.toLowerCase()} $${entry.low}/${entry.high} ${asset}`;
  const ticker = tickerOf(entry);
  switch (body.type) {
    case "buy": {
      if (body.postOnly) {
        const bestOffer = entry.ledger.book(nowNs, 50)[0];
        const askUnit = bestOffer ? Number(bestOffer.unitPremium) / Number(SCALE) : null;
        if (bestOffer && limit >= askUnit) {
          throw new Error(`post-only bid ${limit.toFixed(2)} would cross the ask ${askUnit.toFixed(2)}`);
        }
        const id = entry.ledger.postBid({ owner: YOU, quantity, premium: premiumOf(limit), expiresNs: nowNs + HOUR_NS, nowNs });
        record(`${YOU} posted bid #${id} ${Number(quantity) / Number(SCALE)}x ${label} @ ${limit.toFixed(4)}`, null);
        return { ok: true, message: `bid #${id} resting` };
      }
      const rest = (why) => {
        // A limit order that finds nothing to take does not disappear: it
        // rests, which is what the GTC on the ticket says it will do.
        const id = entry.ledger.postBid({ owner: YOU, quantity, premium: premiumOf(limit), expiresNs: nowNs + HOUR_NS, nowNs });
        record(`${YOU} posted bid #${id} ${Number(quantity) / Number(SCALE)}x ${label} @ ${limit.toFixed(4)}`, null);
        return { ok: true, message: `${why} · bid #${id} rests at ${limit.toFixed(4)}` };
      };
      let fill;
      try {
        fill = entry.ledger.fillMarketOrder({
          buyer: YOU, quantity,
          maxTotalPremium: premiumOf(limit * 1.02),
          nowNs,
        });
      } catch (error) {
        // Other refusals (expired series, ticket capacity) are already exact and
        // already the user's problem. The matching one is a repriced book.
        if (!/no matching offers/.test(String(error.message))) throw error;
        const lots = entry.ledger.book(nowNs, 50).map((offer) => Number(offer.quantity) / Number(SCALE));
        if (lots.length === 0) return rest(`no offers rest in ${ticker}`);
        return rest(`nothing offered at or under ${limit.toFixed(4)} (smallest lot here is ${Math.min(...lots)})`);
      }
      record(`${YOU} bought ${fill.filledQuantity / SCALE}x ${label} for ${(Number(fill.totalPremium) / Number(SCALE)).toFixed(2)}`, {
        contracts: Number(fill.filledQuantity) / Number(SCALE),
        premium: Number(fill.totalPremium) / Number(SCALE),
        spot: spotFor(asset),
        series: ticker,
      });
      return { ok: true, message: `filled ${fill.filledQuantity / SCALE}x` };
    }
    case "sell": {
      if (body.postOnly) {
        const bestBid = entry.ledger.bids_(nowNs, 50)[0];
        const bidUnit = bestBid ? Number(bestBid.unitPremium) / Number(SCALE) : null;
        if (bestBid && limit <= bidUnit) {
          throw new Error(`post-only offer ${limit.toFixed(2)} would cross the bid ${bidUnit.toFixed(2)}`);
        }
        const id = entry.ledger.postOffer({ maker: YOU, quantity, premium: premiumOf(limit), expiresNs: nowNs + HOUR_NS, nowNs });
        record(`${YOU} posted offer #${id} ${Number(quantity) / Number(SCALE)}x ${label} @ ${limit.toFixed(4)}`, null);
        return { ok: true, message: `offer #${id} resting` };
      }
      const restOffer = (why) => {
        const id = entry.ledger.postOffer({ maker: YOU, quantity, premium: premiumOf(limit), expiresNs: nowNs + HOUR_NS, nowNs });
        record(`${YOU} posted offer #${id} ${Number(quantity) / Number(SCALE)}x ${label} @ ${limit.toFixed(4)}`, null);
        return { ok: true, message: `${why} · offer #${id} rests at ${limit.toFixed(4)}` };
      };
      const bids = entry.ledger.bids_(nowNs, 50).filter((bid) => bid.owner !== YOU);
      // Whole fills only: taking a 3-contract bid with a 1-contract order would
      // silently sell three times what the user asked for. The price floor is
      // the same discipline as a buy: the book may have repriced under the
      // limit between rendering the cell and receiving the order.
      const takeable = bids.find(
        (bid) => bid.quantity === quantity && bid.unitPremium >= BigInt(Math.round(limit * 0.98 * Number(SCALE))),
      );
      if (!takeable) {
        if (bids.length === 0) return restOffer(`no bids rest in ${ticker}`);
        return restOffer(`no whole-size bid at or above ${limit.toFixed(4)} (best is ${Number(bids[0].unitPremium) / Number(SCALE)} for ${Number(bids[0].quantity) / Number(SCALE)})`);
      }
      const id = entry.ledger.fillBid({ id: takeable.bidId, seller: YOU, nowNs });
      record(`${YOU} sold ${Number(quantity) / Number(SCALE)}x ${label} to ${takeable.owner} (ticket ${id})`, {
        contracts: Number(quantity) / Number(SCALE),
        premium: Number(takeable.premium) / Number(SCALE),
        spot: spotFor(asset),
        series: ticker,
      });
      return { ok: true, message: `sold ${Number(quantity) / Number(SCALE)} into bid #${takeable.bidId} of ${takeable.owner}` };
    }
    case "expire": {
      const observation = expireSeries(entry);
      return { ok: true, message: `fixed @ ${observation.price.toFixed(2)}` };
    }
    case "settle": {
      const count = settleSeries(entry);
      return { ok: true, message: `settled ${count} ticket(s)` };
    }
    case "close": {
      const ticketId = BigInt(Number(body.ticket));
      const held = entry.ledger.tickets.get(ticketId);
      if (!held) throw new Error("ticket not found");
      if (held.buyer !== YOU) throw new Error("only the buyer can close a ticket");
      const best = entry.ledger
        .bids_(nowNs, 50)
        .find((bid) => bid.owner !== YOU && bid.quantity === held.quantity);
      if (!best) throw new Error("no whole-size bid to sell into");
      const floor = BigInt(Math.round(Number(body.limit || 0) * Number(SCALE)));
      // closeTicket rewrites the ticket's basis to the buyer's own cost, so the
      // figure this leg paid has to be read before the ledger call, not after.
      const paidBasis = Number(held.cost) / Number(SCALE);
      const result = entry.ledger.closeTicket({
        id: ticketId, seller: YOU, minUnitPremium: floor, nowNs,
      });
      const proceeds = Number(result.proceeds) / Number(SCALE);
      const contracts = Number(held.quantity) / Number(SCALE);
      bookRealised({
        at: new Date().toISOString().slice(11, 19),
        series: tickerOf(entry),
        side: "long",
        contracts,
        cost: paidBasis,
        proceeds,
        pnl: proceeds - paidBasis,
        via: "closed",
      });
      record(
        `${YOU} closed ${seriesLabel(entry)} ticket ${ticketId} · ${contracts} @ ${(proceeds / contracts).toFixed(4)} = ${proceeds.toFixed(4)}`,
        {
          contracts,
          premium: proceeds,
          spot: spotFor(asset),
          series: tickerOf(entry),
        },
      );
      return {
        ok: true,
        message: `sold ${contracts} into bid #${result.bidId} @ ${(proceeds / contracts).toFixed(4)} · ${proceeds.toFixed(4)} received`,
      };
    }
    case "prune": {
      const removed = entry.ledger.pruneOffers({ limit: 50n, nowNs });
      removeMissing(entry);
      return { ok: true, message: `pruned ${removed} expired quotes` };
    }
    default:
      throw new Error(`unknown action ${body.type}`);
  }
}

/// The sim prunes its index without deleting records; drop expired records too
/// so the daemon's memory does not grow with every bot cycle.
function removeMissing(entry) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  for (const offer of [...entry.ledger.offers.values()]) {
    if (nowNs >= offer.expiresNs) {
      try { entry.ledger.cancelOffer({ id: offer.id, caller: offer.maker }); } catch { /* ignore */ }
    }
  }
  for (const bid of [...entry.ledger.bids.values()]) {
    if (nowNs >= bid.expiresNs) {
      try { entry.ledger.cancelBid({ id: bid.id, caller: bid.owner }); } catch { /* ignore */ }
    }
  }
}

/* ---------------- http ---------------- */
// Serving the screen from the same port as the book means one command opens
// the product, and the no-store header above is then the only cache rule that
// matters. A separate static server is what let a stale bundle hide a fix.
const DEMO_DIR = join(here, "..", "demo");

function staticAsset(pathname) {
  if (pathname === "/" || pathname === "/index.html") return join(DEMO_DIR, "index.html");
  const font = /^\/fonts\/([a-z0-9-]+\.woff2|OFL\.txt)$/.exec(pathname);
  return font === null ? null : join(DEMO_DIR, "fonts", font[1]);
}

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("cache-control", "no-store");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }

  const file = staticAsset(url.pathname);
  if (file !== null) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      response.writeHead(404).end("bundle not built · node sim/build-demo.mjs");
      return;
    }
    response.writeHead(200, { "content-type": file.endsWith(".woff2") ? "font/woff2" : "text/html; charset=utf-8" });
    // The bundle hard-codes this origin; rewriting it means `--port` needs no
    // second edit, and a page served from this port talks to this port.
    if (file.endsWith(".html")) {
      bytes = Buffer.from(bytes.toString("utf8").replaceAll("127.0.0.1:8787", `127.0.0.1:${PORT}`));
    }
    response.end(bytes);
    return;
  }

  if (url.pathname === "/stream") {
    const asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    response.write("retry: 1500\n\n");
    const client = { res: response, asset, last: null };
    market.clients.add(client);
    pumpStream();
    request.on("close", () => market.clients.delete(client));
    return;
  }
  if (url.pathname === "/state") {
    const query = Object.fromEntries(url.searchParams);
    chooseExpiry(query.expiry);
    const payload = JSON.stringify(fullState(query));
    response.writeHead(200, { "content-type": "application/json" }).end(payload);
    return;
  }
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, series: market.ledgers.size }));
    return;
  }
  if (url.pathname === "/action" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const result = handleAction(JSON.parse(body || "{}"));
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: String(error.message ?? error) }));
      }
    });
    return;
  }
  response.writeHead(404).end("not found");
});

startFeed();
requoteAll(true);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`market daemon listening on http://127.0.0.1:${PORT} (Ctrl-C to stop)`);
  console.log(`expiry ${selectedExpiry().label} · ${market.ledgers.size} series quoted · ${ACCOUNTS.length} accounts`);
});

setInterval(() => requoteAll(), REQUOTE_INTERVAL_MS);
// One taker action per (1000 / RATE) ms, plus a jittery extra.
const FLOW_MS = Math.max(10, Math.round(1_000 / RATE));
setInterval(() => {
  takerFlow();
  if (Math.random() < 0.35) takerFlow();
}, FLOW_MS);
setInterval(pumpStream, 100);
setInterval(recycle, 4_000);
setInterval(() => {
  // Rebuild the ladder and drop series the bots no longer quote.
  EXPIRIES = expiryList();
  requoteAll();
  const keep = new Set();
  for (const asset of ["ETH", "BTC"]) {
    for (const strike of ladderFor(asset)) {
      for (const kind of ["Put", "Call"]) keep.add(`${asset}|${selectedExpiry().iso.slice(0, 10)}|${kind}|${strike}`);
    }
  }
  for (const [key, entry] of market.ledgers) {
    if (!keep.has(key) && entry.ledger.offers.size === 0 && entry.ledger.bids.size === 0 && entry.ledger.tickets.size === 0) {
      market.ledgers.delete(key);
    }
  }
}, 60_000);

process.on("SIGINT", () => {
  console.log(`\nstopping · ${market.trades.length} trades recorded`);
  process.exit(0);
});
