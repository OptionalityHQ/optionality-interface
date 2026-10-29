#!/usr/bin/env node
// Run the simulated market N times and report the economics, anchored on the
// pinned live snapshot (real spot, realised vol and strikes for BTC/ETH).
//   node sim/simulate.mjs --runs 200 --asset ETH
//   node sim/simulate.mjs --asset BTC --edge-bps 400
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./scenario.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(join(here, "..", "data", "market-snapshot.json"), "utf8"));

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
const num = (name, fallback) => Number(flag(name, fallback));
const boolFlag = (name) => args.includes(`--${name}`);

const asset = String(flag("asset", "ETH")).toUpperCase();
const pinned = snapshot.assets[asset];
if (!pinned) throw new Error(`unknown asset ${asset}; snapshot has ${Object.keys(snapshot.assets)}`);

const config = {
  asset,
  runs: num("runs", 200),
  seed: num("seed", 1),
  spot: num("spot", pinned.series.spot),
  vol: num("vol", pinned.vol ?? 0.6),
  days: num("days", pinned.series.days),
  low: num("low-strike", pinned.series.low_strike),
  high: num("high-strike", pinned.series.high_strike),
  steps: num("steps", 42),
  edgeBps: BigInt(num("edge-bps", 150)),
  maxSlippageBps: BigInt(num("slippage-bps", 500)),
  sweepEvery: num("sweep-every", 3),
  fundingMultiple: num("funding-multiple", 100),
};

const scale = 1_000_000n;
const runs = [];
for (let index = 0; index < config.runs; index += 1) {
  runs.push(
    runScenario({
      seed: config.seed + index * 7919,
      spot: config.spot,
      vol: config.vol,
      years: config.days / 365,
      steps: config.steps,
      scale,
      low: BigInt(Math.round(config.low * Number(scale))),
      high: BigInt(Math.round(config.high * Number(scale))),
      unitQuantity: scale,
      edgeBps: config.edgeBps,
      maxSlippageBps: config.maxSlippageBps,
      sweepEvery: config.sweepEvery,
      // Fund each account for ~100 contracts' worth of collateral, so the
      // instrument's size (not a fixed number) decides the wallet.
      funding:
        BigInt(Math.round(Math.max(10_000, (config.high - config.low) * config.fundingMultiple))) *
        1_000_000n,
      outage: index % 25 === 24,
    }),
  );
}

const sum = (values) => values.reduce((total, value) => total + value, 0n);
const pct = (numerator, denominator) =>
  denominator === 0n ? "   n/a" : `${((Number(numerator) / Number(denominator)) * 100).toFixed(2)}%`;
const points = (value) => (Number(value) / Number(scale)).toFixed(3);
const fmt = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });

const voids = runs.filter((run) => run.settlement === "Void").length;
const settled = runs.filter((run) => run.settlement === "Fixed").length;
const sweeps = runs.flatMap((run) => run.sweeps);
const filledSweeps = sweeps.filter((sweep) => sweep.tickets !== undefined);
const requested = sum(sweeps.map((sweep) => sweep.requested));
const received = sum(filledSweeps.map((sweep) => sweep.filledQuantity));
const paid = sum(filledSweeps.map((sweep) => sweep.totalPremium));
const fair = sum(filledSweeps.map((sweep) => sweep.fair));
const settlements = runs.flatMap((run) => run.settlements);
const fixedTickets = settlements.filter((ticket) => ticket.settledAs === "Fixed");
const collateral = sum(settlements.map((ticket) => ticket.collateral));
const fixedCollateral = sum(fixedTickets.map((ticket) => ticket.collateral));
const premiums = sum(settlements.map((ticket) => ticket.premium));
const makerNet = sum(settlements.map((ticket) => ticket.pnlMaker));
const takerNet = sum(settlements.map((ticket) => ticket.pnlBuyer));
const inProfit = fixedTickets.filter((ticket) => ticket.payout > ticket.premium).length;
const payoutTotal = sum(fixedTickets.map((ticket) => ticket.payout));
const fixedPremiums = sum(fixedTickets.map((ticket) => ticket.premium));
const conserved = runs.filter((run) => run.stats.conserved).length;
const rejections = sum(runs.map((run) => BigInt(run.stats.rejections)));
const residual = sum(runs.map((run) => run.stats.residualCancelled));

// Compare the unit premium actually paid for the size that filled against the
// fair unit premium of the size requested: that is the taker's slippage.
const unitSlippage = filledSweeps
  .filter((sweep) => sweep.filledQuantity > 0n && sweep.requested > 0n && sweep.fair > 0n)
  .map(
    (sweep) =>
      Number(sweep.totalPremium) /
      Number(sweep.filledQuantity) /
      (Number(sweep.fair) / Number(sweep.requested)) -
      1,
  )
  .sort((a, b) => a - b);
const quantile = (fraction) =>
  unitSlippage.length === 0
    ? "n/a"
    : `${(unitSlippage[Math.min(unitSlippage.length - 1, Math.floor(fraction * unitSlippage.length))] * 100).toFixed(2)}%`;
const meanSlippage =
  unitSlippage.length === 0
    ? "n/a"
    : `${((unitSlippage.reduce((total, value) => total + value, 0) / unitSlippage.length) * 100).toFixed(2)}%`;
const weeklyRoi = (net, deployed) => (deployed === 0n ? "n/a" : `${((Number(net) / Number(deployed)) * 100).toFixed(2)}%`);
const annualised = (net, deployed) =>
  deployed === 0n
    ? "n/a"
    : `${(((Number(net) / Number(deployed)) * (365 / config.days)) * 100).toFixed(1)}%`;

const row = (label, value) => `${label.padEnd(24)}${value}`;

console.log(
  `\nbounded-options simulated market - ${config.runs} x ${config.asset} ${fmt(config.low)}/${fmt(config.high)} put spread, ${config.days}d`,
);
console.log(
  `spot ${fmt(config.spot)}  realised vol ${(config.vol * 100).toFixed(1)}%  maker edge ${config.edgeBps}bps  ` +
    `sweep cap ${config.maxSlippageBps}bps  ${config.steps} quote steps  ` +
    `funding ${fmt(Math.max(10_000, (config.high - config.low) * config.fundingMultiple))} tokens  ` +
    `snapshot ${snapshot.fetched_at.slice(0, 16)}\n`,
);
console.log(row("Series", `${settled} fixed / ${voids} void / ${runs.length - settled - voids} other`));
console.log(row("Tickets settled", `${settlements.length} (${fixedTickets.length} fixed)`));
console.log(row("Collateral deployed", `${points(collateral)} tokens  ${points(collateral / BigInt(settlements.length || 1))}/contract`));
console.log(row("Premium collected", `${points(premiums)} tokens  ${pct(premiums, collateral)} of collateral  ${points(premiums / BigInt(settlements.length || 1))}/contract`));
console.log(row("Payoff paid out", `${points(payoutTotal)} tokens  ${pct(payoutTotal, fixedPremiums)} of fixed premium (void series refund)`));
console.log(row("Seller retention", `${pct(makerNet, fixedPremiums)} of premium on fixed series kept (quoted edge ${config.edgeBps}bps)`));
console.log(row("Seller P&L", `${points(makerNet)} tokens  ${weeklyRoi(makerNet, fixedCollateral)} of collateral on fixed series over ${config.days}d  x${(365 / config.days).toFixed(0)} = ${annualised(makerNet, fixedCollateral)}`));
console.log(row("Buyer P&L", `${points(takerNet)} tokens  on ${points(paid)} spent (void series refund included)`));
console.log(row("Buyer tickets in profit", `${inProfit}/${fixedTickets.length} (${pct(BigInt(inProfit), BigInt(fixedTickets.length || 1))})`));
console.log(row("Market sweeps", `${sweeps.length} sent, ${filledSweeps.length} filled`));
console.log(row("Size filled", `${pct(received, requested)} of ${points(requested)} contracts (whole offers only)`));
console.log(row("Slippage vs quoted", `median ${quantile(0.5)}  mean ${meanSlippage}  p95 ${quantile(0.95)} (vs the edge-inclusive fair level)`));
console.log(row("Quotes left on book", `${residual} cancelled at expiry`));
console.log(row("Ledger rejections", `${rejections}`));
console.log(row("Custody conserved", `${conserved}/${config.runs} runs`));

if (boolFlag("json")) {
  const payload = {
    config,
    summary: {
      settled,
      voids,
      tickets: settlements.length,
      collateral: collateral.toString(),
      premiums: premiums.toString(),
      makerNet: makerNet.toString(),
      takerNet: takerNet.toString(),
      requested: requested.toString(),
      received: received.toString(),
      paid: paid.toString(),
      fair: fair.toString(),
      conserved,
      rejections: rejections.toString(),
    },
    finalPrices: runs.map((run) => Number(run.finalPrice.toFixed(4))),
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
