#!/usr/bin/env node
// New-user journey: opens the screen in a real browser from a cold start, does
// what a first-time visitor would try (pick an expiry, click a price, buy,
// check the portfolio, close), and records both a photograph and the DOM text
// at every step. The text is what surfaces the flaws a screenshot hides: an
// empty state that reads as a broken state, a disabled button with no reason,
// a figure that rounds to zero.
//
//   node sim/journey.mjs                       # against http://127.0.0.1:8787
//   node sim/journey.mjs --url http://host:port --out evidence/journey
//
// Needs an installed Chrome/Edge/Chromium and nothing else: it speaks CDP over
// the devtools HTTP + WebSocket endpoints with node's built-in fetch and
// WebSocket. Exit 0 = no blocker found, 1 = at least one blocker.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};

const BASE = flag("url", "http://127.0.0.1:8787");
const OUT = resolve(flag("out", join(process.cwd(), "evidence", "journey")));
const WIDTH = Number(flag("width", 1440));
const HEIGHT = Number(flag("height", 900));
const PORT = Number(flag("cdp-port", 9333));
const PROFILE = `/tmp/optionality-journey-${PORT}`;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const chrome = CHROME_CANDIDATES.find(existsSync);
if (chrome === undefined) {
  console.error("journey: no Chrome/Chromium/Edge found — a real browser is required.");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = [];
const steps = [];

function note(step, kind, text) {
  findings.push({ step, kind, text });
  console.log(`  ${kind === "ok" ? "." : kind === "warn" ? "!" : "X"} [${step}] ${text}`);
}

async function boot() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((target) => target.type === "page");
      if (page) return { child, socket: new WebSocket(page.webSocketDebuggerUrl) };
    } catch {
      /* the debug port is not listening yet */
    }
    await sleep(250);
  }
  child.kill();
  throw new Error("journey: chrome never opened a devtools port");
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!entry) return;
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  ready() {
    return new Promise((res, rej) => {
      this.socket.addEventListener("open", res, { once: true });
      this.socket.addEventListener("error", () => rej(new Error("cdp socket failed")), { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} timed out`));
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), res(v)),
        reject: (e) => (clearTimeout(timer), rej(e)),
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
  }

  // Runs a list of statements in the page, so a step can read the DOM and click
  // in one round trip. Awaited, so steps can settle between the two.
  run(body) {
    return this.evaluate(`(async () => { ${body} })()`);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression: `(${expression})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async goto(url, settleMs = 2000) {
    const loaded = new Promise((res) => this.on("Page.loadEventFired", res));
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(15000)]);
    await sleep(settleMs);
  }

  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 78 });
    const path = join(OUT, `${name}.jpg`);
    writeFileSync(path, Buffer.from(data, "base64"));
    return path;
  }
}

/* ---------------- page-side steps ----------------
   Each is a statement list whose last line returns a plain object. Kept as
   strings because they execute in the page, not in node. */

const readLanding = `
  const texts = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.replace(/\\s+/g, " ").trim());
  const cta = document.getElementById("cta");
  const chain = document.getElementById("chain");
  return {
    brand: document.querySelector(".brand")?.textContent.trim(),
    nav: texts(".nav button"),
    expiries: texts("#expiries button"),
    chips: texts("#chips *"),
    headerIndex: texts(".index").slice(0, 4),
    chainRows: chain.querySelectorAll("tr").length,
    liveAsks: [...chain.querySelectorAll("td.price.ask")].filter((c) => !c.classList.contains("model")).length,
    modelAsks: [...chain.querySelectorAll("td.price.ask")].filter((c) => c.classList.contains("model")).length,
    cta: cta ? { label: cta.textContent.trim(), disabled: cta.disabled } : null,
    hint: document.getElementById("price-hint")?.textContent.replace(/\\s+/g, " ").trim(),
    banner: document.getElementById("banner")?.textContent.replace(/\\s+/g, " ").trim(),
    wallet: document.getElementById("wallet")?.textContent.trim(),
    bottom: texts("#bottom-tabs button"),
    book: document.getElementById("bottom-body")?.textContent.replace(/\\s+/g, " ").trim().slice(0, 200),
    font: getComputedStyle(document.body).fontFamily,
    mono: getComputedStyle(document.querySelector(".num") || document.body).fontFamily,
  };`;

const liveCells = `
  const cells = [...document.querySelectorAll("#chain td.price.ask")].filter((c) => !c.classList.contains("model"));
  return cells.map((c) => ({
    strike: c.closest("tr").dataset.strike,
    kind: c.dataset.kind,
    price: c.textContent.trim(),
    numeric: Number(c.textContent.replace(/[^0-9.]/g, "")),
  }));`;

const clickCell = (strike, kind) => `
  const cell = [...document.querySelectorAll('#chain tr[data-strike="${strike}"] td.price.ask')]
    .find((c) => c.dataset.kind === "${kind}");
  if (!cell) return { error: "the cell moved before the click" };
  cell.click();
  await new Promise((r) => setTimeout(r, 1200));
  const cta = document.getElementById("cta");
  return {
    title: document.getElementById("title")?.textContent.trim(),
    subtitle: document.getElementById("subtitle")?.textContent.trim(),
    hint: document.getElementById("price-hint")?.textContent.replace(/\\s+/g, " ").trim(),
    price: document.getElementById("price")?.value,
    amount: document.getElementById("amount")?.value,
    cta: { label: cta.textContent.trim(), disabled: cta.disabled },
    margin: document.getElementById("k-margin")?.textContent.trim(),
    cost: document.getElementById("k-cost")?.textContent.trim(),
    routes: [...document.querySelectorAll("#routes button")].map((b) => b.textContent.trim() + (b.className.includes("on") ? "*" : "")),
    payoff: document.getElementById("rbody")?.textContent.replace(/\\s+/g, " ").trim().slice(0, 220),
  };`;

const pressCta = `
  const cta = document.getElementById("cta");
  if (!cta || cta.disabled) return { error: "CTA disabled: " + (cta ? cta.textContent.trim() : "missing") };
  const label = cta.textContent.trim();
  cta.click();
  await new Promise((r) => setTimeout(r, 1600));
  return { label, toast: document.getElementById("s-toast")?.textContent.trim() || null,
           hint: document.getElementById("price-hint")?.textContent.replace(/\\s+/g, " ").trim() };`;

const readPositions = `
  const t = document.getElementById("pf-table");
  const row = (tr) => [...tr.children].map((c) => c.textContent.replace(/\\s+/g, " ").trim()).join(" | ");
  return {
    kpi: [...document.querySelectorAll("#page-positions .kpi")].map((k) => k.textContent.replace(/\\s+/g, " ").trim()),
    sub: document.getElementById("pf-sub")?.textContent.replace(/\\s+/g, " ").trim(),
    rows: [...t.querySelectorAll("tbody tr")].map(row),
    buttons: [...t.querySelectorAll("tbody button[data-close]")].map((b) => ({ label: b.textContent.trim(), limit: b.dataset.limit })),
    history: [...document.querySelectorAll("#pf-history tbody tr")].map(row).slice(0, 5),
  };`;

const closeFirst = `
  const button = document.querySelector("#pf-table tbody button[data-close]");
  if (!button) return { error: "nothing on the page can be closed" };
  const label = button.textContent.trim();
  const before = document.getElementById("pf-realised")?.textContent.trim();
  button.click();
  await new Promise((r) => setTimeout(r, 1800));
  return { label, before, after: document.getElementById("pf-realised")?.textContent.trim(),
           toast: document.getElementById("s-toast")?.textContent.trim() || null,
           rows: [...document.querySelectorAll("#pf-table tbody tr")].map((tr) => tr.textContent.replace(/\\s+/g, " ").trim()) };`;

const pageText = (page) => `
  document.querySelector('[data-page="${page}"]').click();
  await new Promise((r) => setTimeout(r, 1400));
  const main = document.getElementById("page-${page}");
  return {
    visible: !!main && main.offsetParent !== null,
    words: main ? main.textContent.replace(/\\s+/g, " ").trim().length : 0,
    head: main ? main.textContent.replace(/\\s+/g, " ").trim().slice(0, 260) : null,
    tables: [...(main?.querySelectorAll("table") || [])].length,
    numbers: [...(main?.querySelectorAll(".value, .num") || [])].map((n) => n.textContent.trim()).slice(0, 14),
  };`;

const overflowScan = `
  const limit = document.documentElement.clientWidth;
  const clipped = (n) => { for (let p = n.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden") return true;
    } return false; };
  const off = [...document.querySelectorAll("body *")].filter((n) => {
    const r = n.getBoundingClientRect();
    return r.width > 0 && (r.right > limit + 2 || r.left < -2) && !clipped(n);
  });
  return { docScroll: document.documentElement.scrollWidth, viewport: limit,
           offenders: off.slice(0, 6).map((n) => n.tagName + "." + String(n.className).split(" ")[0] + "@" + Math.round(n.getBoundingClientRect().right)) };`;

/* ---------------- walk ---------------- */

mkdirSync(OUT, { recursive: true });
console.log(`journey: ${BASE} at ${WIDTH}x${HEIGHT} · ${chrome.split("/").slice(-2).join("/")}`);
const { child, socket } = await boot();
const cdp = new Cdp(socket);
await cdp.ready();
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

console.log("\n1. cold open");
await cdp.goto(`${BASE}/`, 2500);
await sleep(4000); // the feed needs prints before the chain has real quotes
const landing = await cdp.run(readLanding);
steps.push({ step: "open", data: landing });
await cdp.shot("01-open");
if (!/Geist/.test(landing.font)) note("open", "bad", `body type is ${landing.font}: the vendored face did not load`);
else note("open", "ok", `type ${landing.font.split(",")[0]}, mono ${landing.mono.split(",")[0]}`);
if (landing.chainRows === 0) note("open", "bad", "the chain renders no rows on a cold open");
else note("open", "ok", `${landing.chainRows} chain rows · ${landing.liveAsks} live asks, ${landing.modelAsks} model-only`);
if (landing.liveAsks === 0) note("open", "bad", "no live ask to click on arrival: the first order is impossible");
// The banner is the one place that explains where prices come from. Untranslated
// venue codes or a stuck "connecting" line are what a first visitor trips over.
if (/BIN |COI |BYB |disp |conf /.test(landing.banner || "")) {
  note("open", "bad", `the index banner still speaks in codes: ${landing.banner}`);
} else if (/connecting/.test(landing.banner || "")) {
  note("open", "bad", "the banner never left the connecting state");
} else {
  note("open", "ok", `banner: ${landing.banner}`);
}
note("open", landing.wallet?.includes("No wallet") ? "warn" : "ok", `the account button reads "${landing.wallet}"`);

console.log("\n2. click a live price and buy");
let opened = null;
const cells = await cdp.run(liveCells);
if (!cells.length) {
  note("select", "bad", "no live cell exists to click — the book is empty on arrival");
} else {
  // A live market reprices under the click, so the attempt repeats on the next
  // price: one refusal is a finding, but the journey must still reach the
  // portfolio page to be audited at all.
  const targets = cells.filter((c) => c.numeric > 0.05).sort((a, b) => a.numeric - b.numeric).slice(0, 4);
  for (const [index, target] of targets.entries()) {
    const picked = await cdp.run(clickCell(target.strike, target.kind));
    steps.push({ step: `select:${index}`, data: picked });
    if (index === 0) await cdp.shot("02-selected");
    if (picked.error) {
      note("select", "bad", picked.error);
      continue;
    }
    note("select", picked.cta.disabled ? "bad" : "ok", `${picked.title} · cta "${picked.cta.label}" disabled=${picked.cta.disabled} · cost ${picked.cost}`);
    if (picked.cta.disabled) continue;
    const bought = await cdp.run(pressCta);
    steps.push({ step: `buy:${index}`, data: bought });
    if (index === 0) await cdp.shot("03-bought");
    if (bought.error) {
      note("buy", "bad", bought.error);
      continue;
    }
    const toast = bought.toast || "";
    // A fill is the venue's own sentence with a transaction count on the end:
    // "bought 1x from the pool at 1.1576 all-in · 1 tx" or "took 2x off the
    // book · 1 tx". A refusal also has a tx count of 0 and never matches.
    if (/(bought|took) .*· \d+ tx/.test(toast)) {
      note("buy", "ok", `"${bought.label}" → ${toast}`);
      opened = picked;
      break;
    }
    if (/rests/.test(toast)) {
      note("buy", "ok", `nothing to take, so the limit rested (correct GTC behaviour): ${toast}`);
      continue;
    }
    note("buy", "bad", `"${bought.label}" → ${toast || `no confirmation; hint says "${bought.hint}"`}`);
  }
  if (!opened) note("buy", "warn", "clicked four live prices and no ticket opened");
}

console.log("\n4. positions");
const positions = await cdp.run(`document.querySelector('[data-page="positions"]').click();
  await new Promise((r) => setTimeout(r, 1500)); ${readPositions}`);
steps.push({ step: "positions", data: positions });
await cdp.shot("04-positions");
const empty = !positions.rows.length || /No open tickets/.test(positions.rows[0] || "");
if (empty) note("positions", opened ? "bad" : "warn", `portfolio is empty after the buy: ${positions.rows[0] || "(no rows)"}`);
else {
  note("positions", "ok", `${positions.kpi.join(" / ")}`);
  note("positions", "ok", `row: ${positions.rows[0]}`);
  const zeros = positions.rows[0].split(" | ").filter((c) => /^\$0(\.0+)?$/.test(c));
  if (zeros.length) note("positions", "bad", `real money printed as $0 (sub-cent rounding): ${zeros.join(", ")}`);
  if (!positions.buttons.length) note("positions", "bad", "the row offers no one-click close");
  else note("positions", "ok", `close button reads "${positions.buttons[0].label}" (limit ${positions.buttons[0].limit})`);
}

console.log("\n5. one-click close");
const closed = await cdp.run(closeFirst);
steps.push({ step: "close", data: closed });
await cdp.shot("05-closed");
if (closed.error) note("close", "warn", closed.error);
else if (closed.after === closed.before && !closed.toast) note("close", "bad", `clicking Close changed nothing: ${closed.rows.join(" / ")}`);
else note("close", "ok", `"${closed.label}" → toast ${closed.toast || "none"} · realised ${closed.before} → ${closed.after}`);

console.log("\n6. the other pages");
for (const page of ["stats", "fees"]) {
  const info = await cdp.run(pageText(page));
  steps.push({ step: `page:${page}`, data: info });
  await cdp.shot(`06-${page}`);
  if (!info.visible) note(`page:${page}`, "bad", `the ${page} tab shows nothing at all`);
  else if (info.words < 120) note(`page:${page}`, "warn", `${page} carries only ${info.words} characters`);
  else note(`page:${page}`, "ok", `${page}: ${info.words} chars, ${info.tables} table(s) · ${info.numbers.slice(0, 6).join(" ")}`);
}

console.log("\n7. phone width");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await cdp.run(`document.querySelector('[data-page="trade"]').click(); await new Promise((r) => setTimeout(r, 1500));`);
const phone = await cdp.run(overflowScan);
steps.push({ step: "phone", data: phone });
await cdp.shot("07-phone-trade");
if (phone.offenders.length || phone.docScroll > phone.viewport) {
  note("phone", "bad", `390px overflows (${phone.docScroll}px): ${phone.offenders.join(", ")}`);
} else {
  note("phone", "ok", `390px fits exactly, nothing hangs off the edge`);
}
const phonePositions = await cdp.run(`document.querySelector('[data-page="positions"]').click();
  await new Promise((r) => setTimeout(r, 1200)); ${overflowScan}`);
steps.push({ step: "phone:positions", data: phonePositions });
await cdp.shot("08-phone-positions");
if (phonePositions.offenders.length) note("phone:positions", "bad", `overflow: ${phonePositions.offenders.join(", ")}`);
else note("phone:positions", "ok", "positions fits 390px");

writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, at: new Date().toISOString(), steps, findings }, null, 2));
const bad = findings.filter((f) => f.kind === "bad").length;
const warn = findings.filter((f) => f.kind === "warn").length;
console.log(`\njourney: ${bad} blocker(s), ${warn} rough edge(s) · evidence in ${OUT}`);

await cdp.send("Browser.close").catch(() => {});
socket.close();
child.kill();
// Chrome is still writing its scratch profile when it dies, so the sweep
// retries instead of throwing after a clean run.
for (let attempt = 0; attempt < 8; attempt += 1) {
  try {
    rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    break;
  } catch {
    await sleep(400);
  }
}
process.exit(bad ? 1 : 0);
