#!/usr/bin/env node
// Emits the reference vectors for the Rust pricing port. The JavaScript is the
// implementation being retired, so it is the source of truth for what the port
// must reproduce — `surface` asserts against this file rather than against a
// hand-written expectation someone could have guessed.
//
//   node sim/gen-surface-vectors.mjs        # writes testdata/surface-vectors.json
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  callPrice,
  normalCdf,
  putGreeks,
  putValue,
  quotePremium,
  smileVol,
  spreadGreeks,
  spreadValue,
  strikeLadder,
} from "./pricing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCALE = 1_000_000n;

const spots = [100, 105, 110, 2_350, 2_400, 80_000];
const vols = [0.05, 0.45, 0.8];
const years = [0, 1 / 365, 7 / 365, 30 / 365];

const rows = [];
for (const spot of spots) {
  for (const vol of vols) {
    for (const term of years) {
      const low = Math.round(spot * 0.95);
      const high = Math.round(spot * 1.05);
      rows.push({
        input: { spot, low, high, vol, years: term },
        normalCdf: [normalCdf(-3), normalCdf(-0.5), normalCdf(0), normalCdf(1.7)],
        put: putValue({ spot, strike: high, vol, years: term }),
        call: callPrice({ spot, strike: high, vol, years: term }),
        smileLow: smileVol({ spot, strike: low, atmVol: vol }),
        putGreeks: putGreeks({ spot, strike: high, vol, years: term }),
        putSpread: spreadValue({ spot, low, high, kind: "Put", atmVol: vol, years: term }),
        callSpread: spreadValue({ spot, low, high, kind: "Call", atmVol: vol, years: term }),
        putSpreadFlat: spreadValue({ spot, low, high, kind: "Put", atmVol: vol, years: term, skew: 0 }),
        putGreeksSpread: spreadGreeks({ spot, low, high, kind: "Put", atmVol: vol, years: term }),
        callGreeksSpread: spreadGreeks({ spot, low, high, kind: "Call", atmVol: vol, years: term }),
        ladder: strikeLadder(spot, { step: spot >= 10_000 ? 1000 : 25 }),
        premium: String(
          quotePremium({
            quantity: 3n * SCALE,
            scale: SCALE,
            spot,
            low: BigInt(low) * SCALE,
            high: BigInt(high) * SCALE,
            vol,
            years: term,
            edgeBps: 25n,
          }),
        ),
      });
    }
  }
}

const document = { generatedBy: "sim/gen-surface-vectors.mjs", rows };
const target = join(here, "..", "testdata", "surface-vectors.json");
writeFileSync(target, JSON.stringify(document));
console.log(`${rows.length} vectors -> ${target}`);
