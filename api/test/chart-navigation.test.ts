import test from "node:test";
import assert from "node:assert/strict";
import { zoomAxis, panAxis, listedStrike } from "../src/chart-navigation.ts";

test("zoom preserves the pointer value and clamps the span", () => {
  assert.deepEqual(zoomAxis({ min: 0, max: 100 }, 25, 0.5, 10, 1000), {
    min: 12.5,
    max: 62.5,
  });
  assert.equal(
    zoomAxis({ min: 0, max: 100 }, 25, 0.001, 10, 1000).max -
      zoomAxis({ min: 0, max: 100 }, 25, 0.001, 10, 1000).min,
    10,
  );
});
test("pan translates the window without changing its scale", () => {
  assert.deepEqual(panAxis({ min: 100, max: 200 }, -0.25), {
    min: 75,
    max: 175,
  });
});
test("an entered strike never silently changes side, expiry, or price", () => {
  const rows = [
    {
      asset: "ETH",
      kind: "Call",
      low: 2200,
      high: 2300,
      expiryNs: 100,
      settlement: "open",
    },
    {
      asset: "ETH",
      kind: "Put",
      low: 2200,
      high: 2300,
      expiryNs: 200,
      settlement: "open",
    },
  ];
  assert.equal(listedStrike(rows, "ETH", "Call", 100, 2200), rows[0]);
  assert.equal(listedStrike(rows, "ETH", "Call", 100, 2201), null);
  assert.equal(listedStrike(rows, "ETH", "Put", 100, 2300), null);
  assert.equal(listedStrike(rows, "BTC", "Call", 100, 2200), null);
});
