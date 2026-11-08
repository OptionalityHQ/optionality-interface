import test from "node:test";
import assert from "node:assert/strict";
import {
  calcEMA,
  calcSMA,
  calcBollingerBands,
  calcVWAP,
  calcRSI,
  createSmoothValue,
} from "../src/indicators.ts";

test("EMA and SMA compute expected moving averages", () => {
  const vals = [10, 20, 30, 40, 50];
  const sma = calcSMA(vals, 3);
  assert.deepEqual(sma, [null, null, 20, 30, 40]);

  const ema = calcEMA(vals, 3);
  assert.equal(ema[0], null);
  assert.equal(ema[1], null);
  assert.equal(ema[2], 20);
  assert.equal(ema[3], 30);
  assert.equal(ema[4], 40);
});

test("Bollinger Bands expand on volatility and collapse on flat series", () => {
  const flat = new Array(20).fill(100);
  const bbFlat = calcBollingerBands(flat, 20, 2);
  assert.deepEqual(bbFlat[19], { upper: 100, middle: 100, lower: 100 });

  const varied = Array.from({ length: 25 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -5));
  const bbVar = calcBollingerBands(varied, 20, 2);
  const last = bbVar[24];
  assert(last.upper !== null && last.lower !== null && last.middle !== null);
  assert(last.upper > last.middle && last.lower < last.middle);
});

test("VWAP weights price by candle volume", () => {
  const vwap = calcVWAP([
    { time: 1, open: 100, high: 100, low: 100, close: 100, volume: 10 },
    { time: 2, open: 200, high: 200, low: 200, close: 200, volume: 30 },
  ]);
  assert.equal(vwap[0], 100);
  assert.equal(vwap[1], 175); // (100*10 + 200*30) / 40
});

test("RSI stays bounded between 0 and 100", () => {
  const rising = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
  const rsiUp = calcRSI(rising, 14);
  assert.equal(rsiUp[19], 100);

  const mixed = [44, 44.3, 44.1, 43.6, 44.3, 44.8, 45.1, 45.4, 45.8, 46.1, 45.9, 46.0, 45.6, 46.3, 46.3, 46.0];
  const rsiMixed = calcRSI(mixed, 14);
  const v = rsiMixed[15];
  assert(v !== null && v > 0 && v < 100);
});

test("createSmoothValue interpolates smoothly toward target and snaps after gaps", () => {
  const s = createSmoothValue(100);
  assert.equal(s.sample(1000, 0), 1000);
  const mid = s.sample(1100, 50);
  assert(mid > 1000 && mid < 1100);
  const snapped = s.sample(1200, 2000); // > 1200ms gap snaps cleanly
  assert.equal(snapped, 1200);
});
