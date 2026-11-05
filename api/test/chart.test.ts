import test from "node:test";
import assert from "node:assert/strict";
import { intrinsicValue, contractQuantity } from "../src/chart-model.ts";

test("spread moneyness follows both strikes and caps at its width", () => {
  assert.equal(intrinsicValue("Call", 2000, 2100, 1999), 0);
  assert.equal(intrinsicValue("Call", 2000, 2100, 2000), 0);
  assert.equal(intrinsicValue("Call", 2000, 2100, 2050), 50);
  assert.equal(intrinsicValue("Call", 2000, 2100, 2200), 100);
  assert.equal(intrinsicValue("Put", 2000, 2100, 2100), 0);
  assert.equal(intrinsicValue("Put", 2000, 2100, 2050), 50);
  assert.equal(intrinsicValue("Put", 2000, 2100, 1900), 100);
  assert.equal(intrinsicValue("Put", 2000, 2100, null), null);
  assert.equal(intrinsicValue("Put", 2000, 2100, NaN), null);
});

test("chart orders accept only bounded whole contract quantities", () => {
  assert.equal(contractQuantity(1), 1);
  assert.equal(contractQuantity(10000), 10000);
  for (const value of [0, -1, 1.5, NaN, Infinity, 10001, "2", null]) assert.throws(() => contractQuantity(value));
});
