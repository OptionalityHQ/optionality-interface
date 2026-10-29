#!/usr/bin/env node
// Bundle the simulator modules and the pinned market snapshot into a single
// double-clickable HTML file:
//   node sim/data.mjs --write     # refresh the pinned snapshot (network)
//   node sim/build-demo.mjs       # inline modules + snapshot into demo/index.html
// The modules are inlined verbatim minus their import/export keywords, so the
// browser runs exactly the code the parity and feed tests assert.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const modules = ["accounting.mjs", "pricing.mjs", "market.mjs", "feed.mjs"];
const snapshotPath = join(here, "..", "data", "market-snapshot.json");

if (!existsSync(snapshotPath)) {
  console.error(`missing ${snapshotPath} — run: node sim/data.mjs --write`);
  process.exit(1);
}
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

const bundle = modules
  .map((name) => {
    const source = readFileSync(join(here, name), "utf8");
    const stripped = source
      .replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
      .replace(/^export\s+/gm, "");
    return `// ---- sim/${name} ----\n${stripped.trim()}\n`;
  })
  .join("\n");

// Parse *and* exercise the bundle: the sweep must still produce the on-chain
// numbers, and the feed plumbing must exist with the snapshot's assets.
const smoke = `
const SCALE = 1_000_000n;
const T0 = 1_760_000_000_000_000_000n;
const ledger = new Ledger({
  scale: SCALE, low: 100n * SCALE, high: 110n * SCALE,
  expiryNs: T0 + 30_000_000_000n, acceptUntilNs: T0 + 90_000_000_000n,
  finalizeUntilNs: T0 + 150_000_000_000n, minConfidenceBps: 5_000n,
});
for (const account of ["alice", "bob", "carol"]) ledger.deposit(account, 100n * SCALE);
ledger.postOffer({ maker: "bob", quantity: SCALE, premium: 2n * SCALE, expiresNs: T0 + 29_000_000_000n, nowNs: T0 });
ledger.postOffer({ maker: "carol", quantity: 2n * SCALE, premium: 5n * SCALE, expiresNs: T0 + 29_000_000_000n, nowNs: T0 });
const fill = ledger.fillMarketOrder({ buyer: "alice", quantity: 3n * SCALE, maxTotalPremium: 9n * SCALE, minQuantity: 3n * SCALE, nowNs: T0 });
const at = ledger.series.expiryNs + 10_000_000_000n;
ledger.requestSettlement({ observations: [{ price: 105n * SCALE, publishTimeNs: at, confidenceBps: 9_000n }], nowNs: at });
for (const id of [...ledger.tickets.keys()]) ledger.settleTicket({ id });
for (const [account, value] of Object.entries({ alice: 108n, bob: 97n, carol: 95n })) {
  if (ledger.balance(account) !== value * SCALE) throw new Error(account + " = " + ledger.balance(account));
}
if (!ledger.conservationOk()) throw new Error("custody not conserved");
if (fill.worstUnitPremium !== 2_500_000n) throw new Error("worst unit premium");
const greeks = putSpreadGreeks({ spot: 108.5, low: 100, high: 110, vol: 0.6, years: 7 / 365 });
if (!(greeks.delta < 0 && greeks.delta > -1)) throw new Error("spread delta out of range: " + greeks.delta);
const normalised = normalizeBinance('{"e":"trade","s":"BTCUSDT","p":"81350.5","T":1}');
if (!normalised || normalised.asset !== "BTC" || normalised.price !== 81350.5) throw new Error("binance normaliser");
const summary = summarise({ binance: { price: 100, tsMs: 0, ticks: 1 }, bybit: { price: 100.02, tsMs: 0, ticks: 1 } }, 0);
// Two central prints average, so compare with a tolerance: float addition of
// money values is never exact, and the display rounds to the same cent.
if (!(Math.abs(summary.median - 100.01) < 1e-9) || summary.status !== "live") throw new Error("summarise: " + summary.median);
if (typeof PriceFeed !== "function" || typeof contractAcceptsObservation !== "function") throw new Error("feed exports");
console.log("bundle smoke test ok: 108 / 97 / 95, greeks, feed normalisers, custody conserved");
`;
const scratch = join(here, ".bundle-check.mjs");
writeFileSync(scratch, `${bundle}\n${smoke}\n`);
try {
  execFileSync(process.execPath, [scratch], { stdio: "inherit" });
} finally {
  rmSync(scratch);
}

const template = readFileSync(join(here, "demo-template.html"), "utf8");
if (!template.includes("/*BUNDLE*/")) throw new Error("template lost its bundle marker");
if (!template.includes("/*SNAPSHOT*/null/*END*/")) throw new Error("template lost its snapshot marker");
const withSnapshot = template.replace(
  "/*SNAPSHOT*/null/*END*/",
  JSON.stringify(snapshot, null, 2),
);
const output = withSnapshot.replace("/*BUNDLE*/", `${bundle}\n`);

const target = resolve(here, "..", "demo", "index.html");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, output);
// The screen names Geist and Geist Mono and loads them from demo/fonts. A
// missing file silently degrades the page to the system face, so fail here.
for (const file of ["geist-latin.woff2", "geist-mono-latin.woff2", "OFL.txt"]) {
  if (!existsSync(join(dirname(target), "fonts", file))) {
    throw new Error(`demo/fonts/${file} is missing · the screen would fall back to a system font`);
  }
}
const assets = Object.entries(snapshot.assets)
  .map(([asset, entry]) => `${asset} ${entry.series.spot.toFixed(2)}`)
  .join(", ");
console.log(`wrote ${target} (${(output.length / 1024).toFixed(1)} KiB) · snapshot ${snapshot.fetched_at} · ${assets}`);
