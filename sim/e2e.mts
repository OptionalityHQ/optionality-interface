/**
 * Playwright end-to-end of the venue, against the live screen and the live chain.
 *
 *   node sim/e2e.ts --url http://127.0.0.1:8790 --out evidence/e2e [--settle] [--headed]
 *
 * This is the journey the CDP script walks, with the things a real driver adds:
 *
 * - **Actionability.** `locator.click()` waits for the element to be visible,
 *   stable, enabled and to actually receive the event — a modal or an overlay
 *   covering the button fails the test instead of being clicked through.
 * - **Errors are evidence.** Console errors, page exceptions and failed
 *   requests are collected and reported, not just screenshots.
 * - **A trace.** `trace.zip` replays the whole run frame by frame.
 *
 * Executed with playwright-core and the machine's own Chrome (`channel: "chrome"`),
 * so nothing downloads a browser. Every action lands on a signed transaction
 * against the sandbox chain; there is no mocked backend anywhere.
 */
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};
const BASE = arg("--url", "http://127.0.0.1:8790").replace(/\/$/, "");
const OUT = arg("--out", "evidence/e2e");
const SETTLE = process.argv.includes("--settle");
const HEADED = process.argv.includes("--headed");
/**
 * Recorded unless `--no-video`. A journey is easier to hand to somebody as a file
 * than as a description, and the video shows the *timing* a screenshot cannot: the
 * toast landing, the ladder repricing under the click, the settle button arriving.
 */
const VIDEO = !process.argv.includes("--no-video");
const JOURNEY = SETTLE ? "journey-settle" : "journey-fast";

type Kind = "ok" | "warn" | "bad";
interface Finding {
  kind: Kind;
  step: string;
  text: string;
}
const findings: Finding[] = [];
const steps: Array<{ step: string; data: unknown }> = [];
const note = (kind: Kind, step: string, text: string) => {
  findings.push({ kind, step, text });
  console.log(`  ${kind === "bad" ? "X" : kind === "warn" ? "!" : "."} [${step}] ${text}`);
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: !HEADED,
  // A quarter-second between actions is the difference between a recording a
  // person can follow and a blur of state changes.
  slowMo: VIDEO ? 80 : 0,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: VIDEO ? { dir: join(OUT, "video-raw"), size: { width: 1280, height: 800 } } : undefined,
});
const page = await context.newPage();
const video = VIDEO ? page.video() : null;

const consoleErrors: string[] = [];
const failedRequests: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
const badResponses: string[] = [];
page.on("response", (response) => {
  if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
});
page.on("requestfailed", (request) => {
  // The SSE stream is deliberately long-lived; aborting it on close is not a fault.
  if (!request.url().includes("/stream")) failedRequests.push(`${request.method()} ${request.url()}`);
});
await context.tracing.start({ screenshots: true, snapshots: true });

const cta = page.locator("#cta");
const shot = async (name: string) => {
  await page.screenshot({ path: join(OUT, `${name}.jpg`), type: "jpeg", quality: 80 });
};
const text = async (selector: string) =>
  (await page.locator(selector).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
/** The first toast of any kind, so a refusal is named instead of timing out. */
const firstToast = async (timeout = 15_000) => {
  await page
    .waitForFunction(() => (document.getElementById("s-toast")?.textContent ?? "").trim().length > 0, undefined, {
      timeout,
      polling: 100,
    })
    .catch(() => undefined);
  return text("#s-toast");
};
const waitToast = async (pattern: RegExp, timeout = 15_000) => {
  await page.locator("#s-toast").filter({ hasText: pattern }).first().waitFor({ timeout });
  return text("#s-toast");
};

console.log(`e2e: ${BASE} at 1440x900 · ${(await browser.version()).split(" ")[0]}`);

/* 1 · the page is alive ---------------------------------------------------- */
console.log("\n1. cold open");
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator("#chain tr[data-strike]").first().waitFor({ timeout: 30_000 });
const rows = await page.locator("#chain tr[data-strike]").count();
const banner = await text("#banner");
const asks = await page.locator("#chain td.price.ask[data-kind]").count();
steps.push({ step: "open", data: { rows, asks, banner } });
await shot("01-open");
if (rows < 5) note("bad", "open", `the ladder has ${rows} rows`);
else if (!/median of/i.test(banner)) note("bad", "open", `the banner does not say where the index comes from: ${banner}`);
else if (!/No wallet/.test(await text("#wallet"))) note("warn", "open", "the account button does not say it is simulated");
else note("ok", "open", `${rows} rows · ${asks} priced sides · ${banner.slice(0, 90)}`);

/* 1b · wait for the venue to be sellable ----------------------------------- */
// A freshly booted venue is listed before it is quoted, so the ladder can be
// full of dashes for a minute. A person waits; a script has to say so, or it
// tests the boot rather than the product.
console.log("\n1b. waiting for a quote to trade against");
const warm = await page
  .waitForFunction(
    () =>
      [...document.querySelectorAll("#chain td.price.ask[data-kind]")].some(
        (cell) => Number((cell.textContent ?? "").replace(/[^0-9.]/g, "")) > 0.001,
      ),
    undefined,
    { timeout: 150_000, polling: 1_000 },
  )
  .then(() => true)
  .catch(() => false);
steps.push({ step: "warm", data: { tradeable: warm } });
if (!warm) note("bad", "warm", "no cell carried a vault quote after 150 s");
else note("ok", "warm", "the ladder is selling");

/* 2 · buy ------------------------------------------------------------------ */
console.log("\n2. buy near the money");
const spot = Number((await text("#idx-ETH [data-px]")).replace(/[^0-9.]/g, ""));
// Buy from the **vault**, not from whatever a person happens to be resting.
// A pool ticket can always be closed back to the pool, so the rest of the journey
// is deterministic; a book fill would make the close depend on a bidder.
const state = (await (await fetch(`${BASE}/state?asset=ETH`)).json()) as {
  chain: Array<{
    strike: number;
    call: { ask: number; takeAskFrom: string | null } | null;
    put: { ask: number; takeAskFrom: string | null } | null;
  }>;
};
const ordered = state.chain
  .flatMap((row) =>
    (["call", "put"] as const).map((kind) => ({
      strike: row.strike,
      kind: kind === "call" ? "Call" : "Put",
      price: Number(row[kind]?.ask ?? 0),
      from: row[kind]?.takeAskFrom ?? null,
    })),
  )
  .filter((cell) => cell.from === "pool" && cell.price > 0.001)
  .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
if (ordered.length === 0) note("warn", "buy", "no cell is quoting from the vault right now");
let bought: { label: string; toast: string } | null = null;
for (const cell of ordered.slice(0, 6)) {
  const cellLocator = page.locator(
    `#chain tr[data-strike="${cell.strike}"] td.price.ask[data-kind="${cell.kind}"]`,
  );
  await cellLocator.click();
  // A click starts a series read; the CTA says "Loading this series" until it
  // lands. Waiting for it to settle is the difference between testing the screen
  // and testing the network's latency.
  await page
    .waitForFunction(() => {
      const button = document.getElementById("cta");
      return Boolean(button) && (!button!.hasAttribute("disabled") || !/Loading/i.test(button!.textContent ?? ""));
    }, undefined, { timeout: 5_000 })
    .catch(() => undefined);
  const label = (await cta.innerText()).trim();
  if (await cta.isDisabled()) {
    note("warn", "select", `"${label}"`);
    continue;
  }
  await cta.click();
  const toast = await firstToast();
  // Two fills are legitimate: the vault's own price, or a person's resting offer.
  if (/bought|took \d+x off the book/i.test(toast)) {
    bought = { label, toast };
    break;
  }
  note("warn", "buy", `"${label}" refused: ${toast || "no toast at all"}`);
}
steps.push({ step: "buy", data: bought });
await shot("02-bought");
if (!bought) note("bad", "buy", "no cell near the money filled");
else note("ok", "buy", `${bought.label} → ${bought.toast}`);

/* 3 · the position and the close ------------------------------------------- */
console.log("\n3. positions and one-click close");
await page.locator('[data-page="positions"]').click();
await page.locator("#pf-table tbody tr").first().waitFor({ timeout: 20_000 });
const positionRow = await text("#pf-table tbody tr");
steps.push({ step: "positions", data: { row: positionRow, realised: await text("#pf-realised") } });
await shot("03-positions");
if (!/long/.test(positionRow)) note("bad", "positions", `the row does not read as a long: ${positionRow}`);
else if (/^>?\$?0(\.0+)? \|/.test(positionRow)) note("bad", "positions", `sub-cent money printed as zero: ${positionRow}`);
else note("ok", "positions", positionRow.slice(0, 140));

const close = page.locator("#pf-table tbody button[data-close]").first();
if ((await close.count()) === 0) note("warn", "close", "nothing on the page can be closed");
else {
  const label = (await close.innerText()).trim();
  await close.click();
  const toast = await waitToast(/sold/i).catch(async () => text("#s-toast"));
  steps.push({ step: "close", data: { label, toast } });
  await shot("04-closed");
  if (/sold/i.test(toast)) note("ok", "close", `"${label}" → ${toast}`);
  else note("bad", "close", `"${label}" → ${toast || "no toast"}`);
}

/* 4 · rest an offer, then take it back ------------------------------------- */
console.log("\n4. rest an offer, then take it back");
await page.locator('[data-page="trade"]').click();
await page.locator('#dirs button[data-dir="sell"]').click();
const postOnly = page.locator("#post-only");
if ((await postOnly.getAttribute("aria-pressed")) !== "true") await postOnly.click();
await page.locator("#amount").fill("1");
await cta.waitFor();
if (await cta.isDisabled()) note("warn", "rest", `the CTA is disabled: ${(await cta.innerText()).trim()}`);
else {
  const label = (await cta.innerText()).trim();
  await cta.click();
  const restToast = await waitToast(/resting/i).catch(async () => text("#s-toast"));
  await page.locator('#bottom-tabs [data-panel="orders"]').click();
  await page.locator("#bottom-body tbody tr").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  const mine = page.locator("#bottom-body [data-cancel]").first();
  steps.push({ step: "rest", data: { label, toast: restToast } });
  if ((await mine.count()) === 0) note("bad", "rest", `no cancelable row: ${restToast}`);
  else {
    note("ok", "rest", `"${label}" → ${restToast}`);
    const id = await mine.getAttribute("data-cancel");
    await mine.click();
    await waitToast(/cancel/i).catch(() => undefined);
    await shot("05-rested");
    const still = await page.locator(`#bottom-body [data-cancel="${id}"]`).count();
    if (still > 0) note("bad", "cancel", `row ${id} is still on the book`);
    else note("ok", "cancel", `${await text("#s-toast")} · book now ${await page.locator("#bottom-body tbody tr").count()} row(s)`);
  }
}

/* 5 · the panels ----------------------------------------------------------- */
console.log("\n5. the panels");
for (const [panel, check] of [
  ["oracle", /signatures inside/i],
  ["session", /this session/i],
] as const) {
  await page.locator(`#bottom-tabs [data-panel="${panel}"]`).click();
  await page.waitForTimeout(900);
  const body = await text("#bottom-body");
  steps.push({ step: `panel:${panel}`, data: body.slice(0, 300) });
  await shot(`06-${panel}`);
  if (!check.test(body)) note("warn", panel, `the panel does not say what it is: ${body.slice(0, 120)}`);
  else note("ok", panel, body.slice(0, 120));
}
const sessionCharts = await page.locator("#bottom-body canvas.sess-chart").count();
if (sessionCharts < 3) note("bad", "session", `expected three charts, found ${sessionCharts}`);

await page.locator('#bottom-tabs [data-panel="smile"]').click();
await page.locator("#smile-chart").waitFor({ timeout: 20_000 });
// The panel fetches three ladders on its own clock; on a fresh venue that can
// take a few seconds, so poll for ink instead of sampling once.
let drawn = false;
for (let attempt = 0; attempt < 12 && !drawn; attempt += 1) {
  drawn = await page.locator("#smile-chart").evaluate((canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("2d");
  if (!context) return false;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) return true;
    return false;
  });
  if (!drawn) await page.waitForTimeout(2_000);
}
const smileLegend = await text("#smile-legend");
steps.push({ step: "smile", data: { drawn, legend: smileLegend } });
await shot("07-smile");
if (!drawn) note("bad", "smile", "the smile canvas is blank");
else note("ok", "smile", smileLegend || "drawn");

/* 6 · phone width ---------------------------------------------------------- */
console.log("\n6. phone width");
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('[data-page="trade"]').click();
await page.waitForTimeout(1200);
const overflow = await page.evaluate(() => ({
  doc: document.documentElement.scrollWidth,
  body: document.body.scrollWidth,
  width: window.innerWidth,
}));
steps.push({ step: "phone", data: overflow });
await shot("08-phone");
if (overflow.doc > overflow.width + 1 || overflow.body > overflow.width + 1) {
  note("bad", "phone", `overflows: doc ${overflow.doc}px, body ${overflow.body}px at ${overflow.width}px`);
} else note("ok", "phone", `${overflow.width}px fits exactly`);

/* 7 · hold to expiry and settle (opt-in) ----------------------------------- */
if (SETTLE) {
  console.log("\n7. hold to expiry, then settle");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-page="trade"]').click();
  await page.locator('#dirs button[data-dir="buy"]').click();
  if ((await postOnly.getAttribute("aria-pressed")) === "true") await postOnly.click();
  const near = await page
    .locator("#chain tr[data-strike]")
    .evaluateAll((rows) => {
      const cells = rows.flatMap((row) => {
        const strike = Number((row as HTMLElement).dataset.strike);
        return [...row.querySelectorAll("td.price.ask[data-kind]")]
          .map((cell) => ({
            strike,
            kind: (cell as HTMLElement).dataset.kind ?? "",
            price: Number((cell.textContent ?? "").replace(/[^0-9.]/g, "")),
          }))
          .filter((cell) => cell.price > 0.001);
      });
      return cells[0] ?? null;
    });
  if (!near) note("bad", "settle", "no live cell to hold");
  else {
    await page.locator(`#chain tr[data-strike="${near.strike}"] td.price.ask[data-kind="${near.kind}"]`).click();
    await cta.click();
    const toast = await waitToast(/bought/i).catch(async () => text("#s-toast"));
    note(/bought/i.test(toast) ? "ok" : "bad", "settle", `held ${near.kind} ${near.strike} → ${toast}`);
    const state = (await (await fetch(`${BASE}/state?asset=ETH`)).json()) as {
      positions: { rows: Array<{ expiryNs: number }> };
    };
    const expiryNs = state.positions.rows[0]?.expiryNs ?? 0;
    const waitMs = Math.max(0, (expiryNs - Date.now() * 1e6) / 1e6) + 20_000;
    // The guard is against a twelve-hour ladder, not against a long hold: a
    // quarter-hour tenor is a perfectly good settlement demo.
    if (waitMs > 15 * 60_000) note("warn", "settle", `the series expires in ${(waitMs / 60_000).toFixed(0)} min: run with EXPIRY_HOURS=0.2`);
    else {
      console.log(`  ... holding for ${Math.round(waitMs / 1000)}s`);
      await page.waitForTimeout(waitMs);
      let settled = false;
      for (let attempt = 0; attempt < 30 && !settled; attempt += 1) {
        await page.locator('[data-page="positions"]').click();
        const button = page.locator("#pf-table [data-settle]").first();
        if ((await button.count()) > 0) {
          const label = (await button.innerText()).trim();
          await button.click();
          const done = await waitToast(/settled/i).catch(async () => text("#s-toast"));
          await shot("09-settled");
          note(/settled/i.test(done) ? "ok" : "bad", "settle", `"${label}" → ${done}`);
          settled = true;
          break;
        }
        await page.waitForTimeout(4000);
      }
      if (!settled) {
        await shot("09-not-settled");
        note("bad", "settle", "the series never offered Settle");
      }
    }
  }
}

/* 8 · what the console said ------------------------------------------------ */
console.log("\n8. console and network");
if (consoleErrors.length) note("warn", "console", `${consoleErrors.length} console error(s): ${consoleErrors[0].slice(0, 160)}`);
else note("ok", "console", "no console errors, no page exceptions");
if (badResponses.length) note("warn", "network", `${badResponses.length} HTTP error(s): ${badResponses[0]}`);
else if (failedRequests.length) note("warn", "network", `${failedRequests.length} failed request(s): ${failedRequests[0]}`);
else note("ok", "network", "no failed requests");
steps.push({ step: "console", data: { consoleErrors, failedRequests, badResponses } });

await context.tracing.stop({ path: join(OUT, "trace.zip") });
let videoPath: string | null = null;
if (video) {
  // The file only exists once the context is closed; save it, then transcode to
  // mp4 with whatever ffmpeg is on the machine, because webm is not what people
  // paste into a deck.
  await context.close();
  const webm = join(OUT, `${JOURNEY}.webm`);
  await video.saveAs(webm);
  const mp4 = join(OUT, `${JOURNEY}.mp4`);
  // Always transcode the recording that was just made: an existing file from a
  // previous run is not this run's video, and short-circuiting on it deleted the
  // fresh webm and kept the stale mp4.
  const converted =
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]).status === 0;
  const seconds = converted
    ? Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]).stdout?.toString().trim() ?? 0)
    : 0;
  console.log(`  video: ${converted ? mp4 : webm} (${seconds.toFixed(1)}s of activity)`);
  if (converted) {
    rmSync(webm, { force: true });
    rmSync(join(OUT, "video-raw"), { recursive: true, force: true });
    videoPath = mp4;
  } else {
    videoPath = webm;
  }
} else {
  await context.close();
}
writeFileSync(
  join(OUT, "report.json"),
  JSON.stringify(
    { base: BASE, at: new Date().toISOString(), driver: "playwright", journey: JOURNEY, video: videoPath, steps, findings },
    null,
    2,
  ),
);
const blockers = findings.filter((finding) => finding.kind === "bad").length;
const rough = findings.filter((finding) => finding.kind === "warn").length;
console.log(`\ne2e: ${blockers} blocker(s), ${rough} rough edge(s) · evidence in ${OUT}`);
await browser.close();
process.exit(blockers === 0 ? 0 : 1);
