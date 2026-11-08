import test from "node:test";
import assert from "node:assert/strict";
import { createChartClock } from "../src/chart-clock.ts";

test("presentation time advances between market updates and resets after clock jumps", () => {
  const clock = createChartClock();
  assert.equal(clock.sample(100000, 10), 100000);
  assert.equal(clock.sample(100000, 26), 100016);
  assert.equal(clock.sample(100000, 42), 100032);
  assert.equal(clock.sample(200000, 58), 200000);
  clock.reset();
  assert.equal(clock.sample(300000, 90), 300000);
});
