#!/usr/bin/env node
// Headless consumer for the live feed. Same module the demo inlines, so this
// is the reference behaviour the browser must match.
//   node sim/live.mjs                  # 12 seconds of live ticks
//   node sim/live.mjs --seconds 30
//   node sim/live.mjs --json           # final state only
import { PriceFeed, SOURCE_CONFIG } from "./feed.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const seconds = Number(flag("seconds", 12));
const asJson = args.includes("--json");
const quiet = args.includes("--quiet");

const latest = { state: null };
const feed = new PriceFeed({
  handlers: {
    onStatus: (state) => {
      latest.state = state;
      if (quiet || asJson) return;
      render(state);
    },
  },
});

function render(state) {
  const stamp = new Date().toISOString().slice(11, 19);
  const parts = Object.entries(state.assets).map(([asset, value]) => {
    if (value.median === null) return `${asset} n/a`;
    const sources = value.sources
      .map((source) => `${source.name.slice(0, 3)} ${source.price.toFixed(2)}`)
      .join(" ");
    return (
      `${asset} ${value.median.toFixed(2)} spread ${value.spreadBps === null ? "n/a" : value.spreadBps.toFixed(1) + "bps"} ` +
      `conf ${Math.round(value.confidenceBps)} age ${value.ageMs === null ? "n/a" : (value.ageMs / 1000).toFixed(1) + "s"} ` +
      `[${sources}]`
    );
  });
  console.log(`${stamp} ${state.status.toUpperCase().padEnd(8)} ${parts.join("  |  ")}`);
}

console.log(`streams: ${Object.values(SOURCE_CONFIG).map((c) => c.label).join(", ")}`);
feed.start();

setTimeout(() => {
  const state = feed.state();
  feed.stop();
  if (asJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log("");
  for (const [asset, value] of Object.entries(state.assets)) {
    const observation = feed.observation(asset);
    console.log(
      `${asset}: status=${value.status} median=${value.median?.toFixed(2)} ` +
        `spread=${value.spreadBps?.toFixed(1)}bps conf=${Math.round(value.confidenceBps)} ` +
        `sources=${value.freshSources}/${value.sources.length} ` +
        `observation=${observation ? `${observation.price.toFixed(2)} conf ${observation.confidenceBps}` : "none"}`,
    );
  }
  console.log(`ticks=${state.ticks} reconnects=${state.reconnects} sockets=${state.connectedSources}`);
  process.exit(0);
}, seconds * 1000);
