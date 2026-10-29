// Live multi-source price feed, for the JavaScript market daemon and the browser
// demo. The Rust engine does its own sockets and its own median
// (`engine/src/feed.rs` + `surface/src/index.rs`) and does not read this file —
// the two are independent, and the rules here are the ones that were ported.
//
// Three independent exchange streams are normalised to one price per asset,
// combined by median, and published with a dispersion-derived confidence so a
// diverging or stale source cannot silently set the mark.
//
// Pyth Hermes was the intended oracle leg; its price endpoint now answers
// 401 unauthorized without an API key, so the oracle role is played by a
// median-of-exchanges composite and the Pyth adapter stays a wiring task.

export const SOURCE_CONFIG = {
  binance: {
    label: "Binance",
    url: "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/ethusdt@trade",
  },
  coinbase: { label: "Coinbase", url: "wss://ws-feed.exchange.coinbase.com" },
  bybit: { label: "Bybit", url: "wss://stream.bybit.com/v5/public/spot" },
};

const SUBSCRIBE = {
  coinbase: {
    type: "subscribe",
    product_ids: ["BTC-USD", "ETH-USD"],
    channels: ["ticker"],
  },
  bybit: { op: "subscribe", args: ["publicTrade.BTCUSDT", "publicTrade.ETHUSDT"] },
  binance: null,
};

export const FEED_DEFAULTS = {
  staleMs: 15_000,
  degenerateSpreadBps: 20,
  maxBackoffMs: 15_000,
  confidencePenaltyPerBp: 20,
};

/// Pure parsers: message -> { asset, price, tsMs } | null.
export function normalizeBinance(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  const payload = message?.data ?? message;
  if (payload?.e !== "trade" || typeof payload.p !== "string") return null;
  const asset = payload.s === "BTCUSDT" ? "BTC" : payload.s === "ETHUSDT" ? "ETH" : null;
  if (!asset) return null;
  return { asset, price: Number(payload.p), tsMs: Number(payload.T ?? payload.E) };
}

export function normalizeCoinbase(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (message?.type !== "ticker" || typeof message.price !== "string") return null;
  const asset = message.product_id === "BTC-USD" ? "BTC" : message.product_id === "ETH-USD" ? "ETH" : null;
  if (!asset) return null;
  return { asset, price: Number(message.price), tsMs: Date.parse(message.time) || Date.now() };
}

export function normalizeBybit(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (message?.topic?.startsWith("publicTrade") !== true) return null;
  const trade = message.data?.[0];
  if (!trade || typeof trade.p !== "string") return null;
  const asset = trade.s === "BTCUSDT" ? "BTC" : trade.s === "ETHUSDT" ? "ETH" : null;
  if (!asset) return null;
  return { asset, price: Number(trade.p), tsMs: Number(trade.T ?? Date.now()) };
}

export const NORMALIZERS = {
  binance: normalizeBinance,
  coinbase: normalizeCoinbase,
  bybit: normalizeBybit,
};

/// Median of the fresh prints. An even count has no middle element, so the
/// two central prints are averaged: taking the upper one holds the index on a
/// stale quote until the ordering itself changes.
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/// The contract's own acceptance test, applied to a live print before the demo
/// is allowed to settle a series. Mirrors the callback filter in
/// contracts/bounded-options/src/lib.rs so a stale or diverged feed cannot
/// produce a settlement the chain would refuse.
const toNs = (value) => (typeof value === "bigint" ? value : BigInt(Math.round(value)));

export function contractAcceptsObservation(observation, series, nowNs) {
  if (!observation) return { ok: false, reason: "no live print" };
  const scaled = BigInt(Math.round(observation.price * Number(series.scale)));
  const lower = series.low / 10n;
  const upper = series.high * 10n;
  if (scaled <= 0n) return { ok: false, reason: "price must be positive" };
  if (scaled < lower || scaled > upper) return { ok: false, reason: "price outside band" };
  // Epoch nanoseconds exceed Number.MAX_SAFE_INTEGER; a float here can shift a
  // boundary comparison by a few hundred nanoseconds.
  const publishTimeNs = toNs(observation.publishTimeNs);
  if (publishTimeNs < series.expiryNs) return { ok: false, reason: "print predates expiry" };
  if (publishTimeNs > series.acceptUntilNs) return { ok: false, reason: "print after accept window" };
  if (publishTimeNs > nowNs) return { ok: false, reason: "print is in the future" };
  if (BigInt(Math.round(observation.confidenceBps)) < series.minConfidenceBps) {
    return { ok: false, reason: "confidence below floor" };
  }
  return { ok: true, scaled };
}

/// One asset's live state from its per-source last prints.
export function summarise(perSource, nowMs, options = {}) {
  const { staleMs, confidencePenaltyPerBp } = { ...FEED_DEFAULTS, ...options };
  const entries = Object.entries(perSource).map(([name, tick]) => ({
    name,
    price: tick.price,
    ageMs: Math.max(0, nowMs - tick.tsMs),
    ticks: tick.ticks,
  }));
  const fresh = entries.filter((entry) => entry.ageMs <= staleMs).map((entry) => entry.price);
  if (fresh.length === 0) {
    const newest = entries.reduce((best, entry) => (best === null || entry.ageMs < best.ageMs ? entry : best), null);
    return {
      status: entries.length === 0 ? "offline" : "stale",
      median: median(entries.map((entry) => entry.price)),
      spreadBps: null,
      confidenceBps: 0,
      ageMs: newest ? newest.ageMs : null,
      sources: entries,
      freshSources: 0,
    };
  }
  const centre = median(fresh);
  const spreadBps = ((Math.max(...fresh) - Math.min(...fresh)) / centre) * 10_000;
  // One source is not a cross-check: cap confidence so the UI never reads a
  // single lagging exchange as a high-confidence oracle.
  const raw = Math.max(0, Math.min(10_000, 10_000 - spreadBps * confidencePenaltyPerBp));
  const confidenceBps = fresh.length < 2 ? Math.min(raw, 6_000) : raw;
  return {
    status: "live",
    median: centre,
    spreadBps,
    confidenceBps,
    ageMs: Math.min(...entries.map((entry) => entry.ageMs)),
    sources: entries,
    freshSources: fresh.length,
  };
}

export class PriceFeed {
  constructor({ assets = ["BTC", "ETH"], sources = Object.keys(SOURCE_CONFIG), options = {}, handlers = {}, WebSocketImpl } = {}) {
    this.assets = assets;
    this.sourceNames = sources;
    this.options = { ...FEED_DEFAULTS, ...options };
    this.onTick = handlers.onTick ?? (() => {});
    this.onStatus = handlers.onStatus ?? (() => {});
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    this.prints = Object.fromEntries(assets.map((asset) => [asset, {}]));
    this.sockets = new Map();
    this.reconnects = 0;
    this.ticks = 0;
    this.running = false;
    this.timer = null;
    this.statusKey = null;
  }

  start() {
    if (this.running) return this;
    if (typeof this.WebSocketImpl !== "function") {
      this.emitStatus("offline", "WebSocket unavailable in this runtime");
      return this;
    }
    this.running = true;
    for (const name of this.sourceNames) this.connect(name, 0);
    this.timer = setInterval(() => this.tick(), 1_000);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.sockets.values()) {
      entry.closing = true;
      try {
        entry.socket?.close();
      } catch {
        /* already closed */
      }
    }
    this.sockets.clear();
  }

  connect(name, attempt) {
    const config = SOURCE_CONFIG[name];
    if (!config) return;
    // Placeholder paths in this module's config are documented in the README;
    // an unreachable source degrades the feed instead of throwing.
    const entry = { attempt, socket: null, closing: false, name };
    this.sockets.set(name, entry);
    const socket = new this.WebSocketImpl(config.url);
    entry.socket = socket;
    socket.onopen = () => {
      entry.attempt = 0;
      const subscription = SUBSCRIBE[name];
      if (subscription) socket.send(JSON.stringify(subscription));
      this.tick();
    };
    socket.onmessage = (event) => this.ingest(name, event.data);
    socket.onclose = () => this.reconnect(name, entry);
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* noop */
      }
    };
  }

  reconnect(name, entry) {
    if (!this.running || entry.closing) return;
    this.reconnects += 1;
    const delay = Math.min(this.options.maxBackoffMs, 1_000 * 2 ** Math.min(entry.attempt, 4));
    entry.attempt += 1;
    setTimeout(() => {
      if (this.running && !entry.closing) this.connect(name, entry.attempt);
    }, delay);
    this.tick();
  }

  ingest(name, raw) {
    const normalizer = NORMALIZERS[name];
    const parsed = normalizer ? normalizer(raw) : null;
    if (!parsed || !Number.isFinite(parsed.price) || parsed.price <= 0) return;
    if (!this.prints[parsed.asset]) this.prints[parsed.asset] = {};
    const previous = this.prints[parsed.asset][name];
    this.prints[parsed.asset][name] = {
      price: parsed.price,
      tsMs: parsed.tsMs,
      ticks: (previous?.ticks ?? 0) + 1,
    };
    this.ticks += 1;
    this.onTick({ source: name, asset: parsed.asset, price: parsed.price, tsMs: parsed.tsMs });
    this.tick();
  }

  state(nowMs = Date.now()) {
    const assets = {};
    for (const asset of this.assets) {
      const summary = summarise(this.prints[asset], nowMs, this.options);
      const degraded =
        summary.status === "live" &&
        (summary.freshSources < 2 || summary.spreadBps > this.options.degenerateSpreadBps);
      assets[asset] = { ...summary, status: degraded ? "degraded" : summary.status };
    }
    const entries = Object.values(assets);
    const anyFresh = entries.some((entry) => entry.freshSources > 0);
    const allLive = entries.length > 0 && entries.every((entry) => entry.status === "live");
    return {
      status: allLive ? "live" : anyFresh ? "degraded" : "offline",
      assets,
      ticks: this.ticks,
      reconnects: this.reconnects,
      connectedSources: [...this.sockets.values()].filter((entry) => entry.socket?.readyState === 1).length,
      timestamp: new Date(nowMs).toISOString(),
    };
  }

  tick() {
    const state = this.state();
    const key = `${state.status}:${Object.entries(state.assets)
      .map(([asset, value]) => `${asset}${value.status}${value.freshSources}`)
      .join(",")}`;
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.onStatus(state);
    }
  }

  emitStatus(status, reason) {
    this.onStatus({ status, reason, assets: {}, ticks: 0, reconnects: 0, connectedSources: 0 });
  }

  /// Contract-shaped observation for the freshest acceptable print.
  observation(asset, nowMs = Date.now()) {
    const summary = summarise(this.prints[asset], nowMs, this.options);
    if (summary.status !== "live" || summary.median === null) return null;
    return {
      price: summary.median,
      publishTimeNs: BigInt(nowMs) * 1_000_000n,
      confidenceBps: Math.round(summary.confidenceBps),
      spreadBps: summary.spreadBps,
      sources: summary.freshSources,
    };
  }
}
