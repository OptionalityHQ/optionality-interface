import test from "node:test";
import assert from "node:assert/strict";
import {
  PriceFeed,
  SOURCE_CONFIG,
  contractAcceptsObservation,
  median,
  normalizeBinance,
  normalizeBybit,
  normalizeCoinbase,
  summarise,
} from "../feed.mjs";

const T0 = 1_760_000_000_000;
const SCALE = 1_000_000n;

test("normalisers map each exchange payload and ignore control frames", () => {
  assert.deepEqual(
    normalizeBinance('{"stream":"btcusdt@trade","data":{"e":"trade","p":"81234.50","T":1793182536001,"s":"BTCUSDT"}}'),
    { asset: "BTC", price: 81234.5, tsMs: 1793182536001 },
  );
  assert.equal(normalizeBinance('{"result":null,"id":1}'), null);
  assert.equal(normalizeBinance("not json"), null);

  assert.deepEqual(
    normalizeCoinbase('{"type":"ticker","product_id":"ETH-USD","price":"2372.71","time":"2026-10-28T10:16:24.500Z"}'),
    { asset: "ETH", price: 2372.71, tsMs: Date.parse("2026-10-28T10:16:24.500Z") },
  );
  assert.equal(normalizeCoinbase('{"type":"subscriptions"}'), null);

  assert.deepEqual(
    normalizeBybit('{"topic":"publicTrade.BTCUSDT","data":[{"s":"BTCUSDT","p":"81240.10","T":1793182536100}]}'),
    { asset: "BTC", price: 81240.1, tsMs: 1793182536100 },
  );
  assert.equal(normalizeBybit('{"success":true,"op":"subscribe"}'), null);
});

test("a three-source median resists one bad quote and reports dispersion", () => {
  const tight = summarise(
    {
      binance: { price: 100_000, tsMs: T0, ticks: 5 },
      coinbase: { price: 100_010, tsMs: T0, ticks: 3 },
      bybit: { price: 99_995, tsMs: T0, ticks: 4 },
    },
    T0,
  );
  assert.equal(tight.status, "live");
  assert.equal(tight.median, 100_000);
  assert.equal(tight.freshSources, 3);
  assert.ok(tight.confidenceBps > 9_900, `confidence ${tight.confidenceBps}`);

  // One source diverging by 5% cannot move the median of three.
  const diverged = summarise(
    {
      binance: { price: 100_000, tsMs: T0, ticks: 5 },
      coinbase: { price: 105_000, tsMs: T0, ticks: 3 },
      bybit: { price: 100_010, tsMs: T0, ticks: 4 },
    },
    T0,
  );
  assert.equal(diverged.median, 100_010);
  assert.equal(diverged.freshSources, 3);
  assert.ok(diverged.spreadBps > 290, `spread ${diverged.spreadBps}`);
  assert.ok(diverged.confidenceBps < 5_000, "dispersion must destroy confidence");
});

test("an even number of venues averages its two central prints", () => {
  // Taking the upper middle element held a two-venue index on the older quote
  // until the ordering itself flipped, which is what made the screen look
  // frozen while all three sockets were printing.
  assert.equal(median([100, 102]), 101);
  assert.equal(median([102, 100]), 101);
  assert.equal(median([100, 100, 102, 106]), 101);
  assert.equal(median([100]), 100);

  const first = summarise(
    { binance: { price: 100, tsMs: T0, ticks: 1 }, coinbase: { price: 102, tsMs: T0, ticks: 1 } },
    T0,
  );
  const moved = summarise(
    { binance: { price: 101, tsMs: T0, ticks: 2 }, coinbase: { price: 102, tsMs: T0, ticks: 1 } },
    T0,
  );
  assert.equal(first.median, 101);
  assert.equal(moved.median, 101.5, "a one-tick move at either venue must move the index");
});

test("staleness is explicit, and a stale feed publishes no observation", () => {
  const prints = { binance: { price: 100_000, tsMs: T0 - 20_000, ticks: 5 } };
  const stale = summarise(prints, T0, { staleMs: 15_000 });
  assert.equal(stale.status, "stale");
  assert.equal(stale.freshSources, 0);
  assert.equal(stale.confidenceBps, 0);

  const empty = summarise({}, T0);
  assert.equal(empty.status, "offline");
  assert.equal(median([]), null);

  const feed = new PriceFeed({ handlers: {}, WebSocketImpl: null });
  assert.equal(feed.observation("BTC", T0), null);
});

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.created.push(this);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  push(payload) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
  }
}
FakeSocket.created = [];

test("the feed reaches live state from three sockets and reconnects after a drop", async () => {
  FakeSocket.created = [];
  const statuses = [];
  const feed = new PriceFeed({
    handlers: { onStatus: (state) => statuses.push(state.status) },
    options: { maxBackoffMs: 1 },
    WebSocketImpl: FakeSocket,
  });
  feed.start();
  assert.equal(FakeSocket.created.length, 3);
  assert.deepEqual(
    FakeSocket.created.map((socket) => socket.url),
    Object.values(SOURCE_CONFIG).map((config) => config.url),
  );

  for (const socket of FakeSocket.created) socket.open();
  // Coinbase and Bybit must be subscribed explicitly; Binance is stream-encoded.
  const coinbase = FakeSocket.created.find((socket) => socket.url.includes("coinbase"));
  assert.equal(coinbase.sent[0].type, "subscribe");

  const [binance, , bybit] = FakeSocket.created;
  binance.push({ stream: "btcusdt@trade", data: { e: "trade", s: "BTCUSDT", p: "81234.5", T: Date.now() } });
  coinbase.push({ type: "ticker", product_id: "BTC-USD", price: "81230.0", time: new Date().toISOString() });
  bybit.push({ topic: "publicTrade.BTCUSDT", data: [{ s: "BTCUSDT", p: "81240.1", T: Date.now() }] });
  binance.push({ stream: "ethusdt@trade", data: { e: "trade", s: "ETHUSDT", p: "2372.7", T: Date.now() } });
  coinbase.push({ type: "ticker", product_id: "ETH-USD", price: "2371.1", time: new Date().toISOString() });
  bybit.push({ topic: "publicTrade.ETHUSDT", data: [{ s: "ETHUSDT", p: "2373.2", T: Date.now() }] });

  const state = feed.state();
  assert.equal(state.status, "live");
  assert.equal(state.assets.BTC.freshSources, 3);
  assert.equal(state.assets.ETH.freshSources, 3);
  assert.ok(state.assets.BTC.spreadBps < 5);
  assert.equal(feed.ticks, 6);
  assert.ok(statuses.includes("live"));

  const observation = feed.observation("BTC");
  assert.ok(observation.price > 81_000 && observation.price < 81_500);
  assert.ok(observation.confidenceBps > 9_900);
  assert.equal(typeof observation.publishTimeNs, "bigint");

  // A dropped socket schedules a reconnect and is counted.
  binance.close();
  assert.equal(feed.reconnects, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(FakeSocket.created.length > 3, "a replacement socket must be created");
  feed.stop();
});

test("the demo may only settle on a print the contract would accept", () => {
  const expiryNs = BigInt(T0) * 1_000_000n;
  const series = {
    scale: SCALE,
    low: 220n * SCALE,
    high: 230n * SCALE,
    expiryNs,
    acceptUntilNs: expiryNs + 60n * 1_000_000_000n,
    minConfidenceBps: 5_000n,
  };
  const nowNs = expiryNs + 10n * 1_000_000_000n;
  const good = { price: 2_250, publishTimeNs: nowNs, confidenceBps: 9_700 };
  assert.equal(contractAcceptsObservation(good, series, nowNs).ok, true);

  const cases = [
    [{ ...good, confidenceBps: 4_000 }, "confidence below floor"],
    [{ ...good, price: 4_600 }, "price outside band"],
    [{ ...good, price: 0 }, "price must be positive"],
    [{ ...good, publishTimeNs: series.expiryNs - 1n }, "print predates expiry"],
    [{ ...good, publishTimeNs: series.acceptUntilNs + 1n }, "print after accept window"],
    [{ ...good, publishTimeNs: nowNs + 1n }, "print is in the future"],
    [null, "no live print"],
  ];
  for (const [observation, reason] of cases) {
    const verdict = contractAcceptsObservation(observation, series, nowNs);
    assert.equal(verdict.ok, false, reason);
    assert.equal(verdict.reason, reason);
  }
});

test("a diverged asset degrades the whole feed instead of producing a mark", () => {
  const feed = new PriceFeed({ assets: ["BTC"], handlers: {}, options: { degenerateSpreadBps: 20 }, WebSocketImpl: null });
  feed.prints.BTC = {
    binance: { price: 100_000, tsMs: Date.now(), ticks: 1 },
    bybit: { price: 103_000, tsMs: Date.now(), ticks: 1 },
  };
  const state = feed.state();
  assert.equal(state.status, "degraded");
  assert.equal(state.assets.BTC.status, "degraded");
  assert.ok(state.assets.BTC.spreadBps > 290);
});
