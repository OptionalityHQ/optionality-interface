#!/usr/bin/env node
// Build the screen. One template in, one file out:
//
//   node sim/build-demo.mjs        -> demo/index.html
//
// The page holds no market logic any more — no ledger, no Black–Scholes, no
// price feed, no pinned snapshot. It is a client of the gateway, which is a
// client of the contract, so there is nothing here to bundle and nothing to
// keep in step with Rust. What the builder still checks is the fonts: a page
// that silently falls back to the system face looks like a design choice and
// reads as a bug.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(here, "demo-template.html"), "utf8");
if (/\/\*BUNDLE\*\/|SNAPSHOT/.test(template)) {
  throw new Error("the template still carries a bundle or snapshot hook");
}

const target = resolve(here, "..", "demo", "index.html");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, template);

for (const file of ["geist-latin.woff2", "geist-mono-latin.woff2", "OFL.txt"]) {
  if (!existsSync(join(dirname(target), "fonts", file))) {
    throw new Error(`demo/fonts/${file} is missing · the screen would fall back to a system font`);
  }
}
console.log(`wrote ${target} (${(template.length / 1024).toFixed(1)} KiB) · served by the gateway at /`);

await build({ entryPoints: [join(here, "../api/src/wallet.ts")], bundle: true, outfile: join(here, "../demo/wallet.js"), platform: "browser", format: "iife", target: "es2022", minify: true });

await build({ entryPoints: [join(here, "../api/src/positions-chart.ts")], bundle: true, outfile: join(here, "../demo/positions-chart.js"), platform: "browser", format: "iife", target: "es2022", minify: true });
