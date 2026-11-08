import test from "node:test";
import assert from "node:assert/strict";
import { fetchCandles } from "../src/candles.ts";

test("history pages pass their ending timestamp and never return candles beyond it", async (t) => {
  let request = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    request = String(url);
    return new Response(
      JSON.stringify([
        [1000, 10, 12, 9, 11, 3],
        [3000, 11, 13, 10, 12, 2],
      ]),
      { status: 200 },
    );
  });
  const candles = await fetchCandles("ETH", "1m", 300, null, 2000);
  assert.match(request, /endTime=2000/);
  assert.match(request, /limit=300/);
  assert.deepEqual(
    candles.map((c) => c.time),
    [1000],
  );
});

test("Coinbase history fallback sends a bounded range and sorts before limiting", async (t) => {
  let request = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (String(url).includes("binance"))
      return new Response("", { status: 503 });
    request = String(url);
    return new Response(
      JSON.stringify([
        [400, 9, 12, 10, 11, 3],
        [200, 8, 11, 9, 10, 2],
      ]),
      { status: 200 },
    );
  });
  const candles = await fetchCandles("BTC", "15m", 10, null, 500000);
  assert.match(request, /start=/);
  assert.match(request, /end=/);
  assert.match(request, /granularity=900/);
  assert.deepEqual(
    candles.map((c) => c.time),
    [200000, 400000],
  );
});

test("a missing feed produces a gap rather than fabricated historical prices", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw Error("offline");
  });
  assert.deepEqual(await fetchCandles("ETH", "1s", 17, null, 1234567), []);
  assert.equal(calls, 1, "second data must not fall back to minute candles");
  assert.deepEqual(await fetchCandles("BTC", "1h", 17, null, 1234567), []);
});
