/**
 * The adversarial browser suite: what a trader, a script and a stranger can do
 * to the screen, checked against the live gateway and the live chain.
 *
 *   node sim/suite.mts --url http://127.0.0.1:8790 --out evidence/suite
 *
 * The other journey (`e2e.mts`) walks the happy path. This one tries the edges a
 * financial UI has to get right:
 *
 * - a hold for more than one contract is funded for the whole ticket, not one
 *   contract's mid (a bug this suite was written to catch);
 * - a held ticket is refused a close by the planner, not by a reverted chain
 *   transaction;
 * - an order the account cannot afford is refused and moves nothing;
 * - a fill-or-kill larger than the book leaves the book where it was;
 * - a request from another origin cannot make the gateway sign;
 * - the page's index, ladder and custody all agree with `/state`, and the
 *   custody sum is conserved;
 * - every control has a name and the toast is announced.
 *
 * It records a video, a trace and `report.json`, and exits non-zero on a
 * blocker. Everything is executed with the machine's Chrome: no mocked chain.
 */
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};
const BASE = arg("--url", "http://127.0.0.1:8790").replace(/\/$/, "");
const OUT = arg("--out", "evidence/suite");
const HEADED = process.argv.includes("--headed");
const VIDEO = !process.argv.includes("--no-video");

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

interface Row {
  strike: number;
  call: Cell | null;
  put: Cell | null;
}
interface Cell {
  ask: number;
  takeAskFrom: string | null;
  bestOfferId: number | null;
  poolAsk: number | null;
  poolMid: number | null;
}
interface State {
  spot: number | null;
  chain: Row[];
  positions: { rows: Array<Record<string, any>> };
  orders: Array<Record<string, any>>;
  you: { account: string; available: number; wallet: number };
  pool: {
    equity: number;
    reserved: number;
    venueLocked: number;
    venue: number;
    freeEquity: number;
    utilisationBps: number;
    openTickets: number;
  };
  custody: { expected: number; held: number; conserved: boolean; buckets: unknown[] };
  oracle: { seats: Array<{ source: string; fresh: boolean }> };
}

const fetchState = async (): Promise<State> => {
  const response = await fetch(`${BASE}/state?asset=ETH`, { cache: "no-store" });
  if (!response.ok) throw new Error(`state ${response.status}`);
  return (await response.json()) as State;
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: !HEADED, slowMo: VIDEO ? 70 : 0 });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: VIDEO ? { dir: join(OUT, "video-raw"), size: { width: 1280, height: 800 } } : undefined,
});
const page = await context.newPage();
const video = VIDEO ? page.video() : null;

const consoleErrors: string[] = [];
const failedRequests: string[] = [];
const badResponses: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("response", (response) => {
  if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
});
page.on("requestfailed", (request) => {
  if (!request.url().includes("/stream")) failedRequests.push(`${request.method()} ${request.url()}`);
});
await context.tracing.start({ screenshots: true, snapshots: true });

const text = async (selector: string) =>
  (await page.locator(selector).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
const shot = async (name: string) =>
  page.screenshot({ path: join(OUT, `${name}.jpg`), type: "jpeg", quality: 80 });
const cta = page.locator("#cta");

const toastAfter = async (before: string, timeout = 25_000) => {
  // Return the sentence the predicate observed, not a second read: the toast
  // can expire between the wait resolving and the read, and an empty string
  // then looks like "nothing happened" when something did.
  const observed = await page
    .waitForFunction(
      (prior) => {
        const now = (document.getElementById("s-toast")?.textContent ?? "").trim();
        return now.length > 0 && now !== prior ? now : "";
      },
      before,
      { timeout, polling: 100 },
    )
    .catch(() => null);
  if (observed) return String(await observed.jsonValue()).trim();
  return text("#s-toast");
};

const waitCta = async (timeout = 12_000) => {
  await page
    .waitForFunction(
      () => {
        const button = document.getElementById("cta");
        return Boolean(button) && !button!.hasAttribute("disabled") && !/Loading/i.test(button!.textContent ?? "");
      },
      undefined,
      { timeout },
    )
    .catch(() => undefined);
  return !(await cta.isDisabled());
};

const waitForVaultCell = async (timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await fetchState().catch(() => null);
    if (state) {
      const spot = Number(state.spot ?? 0);
      const cells = state.chain
        .flatMap((row) =>
          (["call", "put"] as const).map((kind) => ({
            strike: row.strike,
            kind: kind === "call" ? "Call" : "Put",
            price: Number(row[kind]?.poolAsk ?? 0),
            from: row[kind]?.takeAskFrom ?? null,
          })),
        )
        .filter((cell) => cell.from === "pool" && cell.price > 0.001)
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
      if (cells.length > 0) return cells;
    }
    await page.waitForTimeout(2_000);
  }
  return [];
};

const setToggle = async (id: string, on: boolean) => {
  const toggle = page.locator(`#${id}`);
  const pressed = (await toggle.getAttribute("aria-pressed")) === "true";
  if (pressed !== on) await toggle.click();
  const now = (await toggle.getAttribute("aria-pressed")) === "true";
  if (now !== on) note("warn", "controls", `could not set #${id} to ${on}`);
};

const selectCell = async (strike: number, kind: string) => {
  await page.locator(`#chain tr[data-strike="${strike}"] td.price.ask[data-kind="${kind}"]`).click();
  await page
    .waitForFunction(
      () => {
        const button = document.getElementById("cta");
        return Boolean(button) && !/Loading/i.test(button!.textContent ?? "");
      },
      undefined,
      { timeout: 8_000 },
    )
    .catch(() => undefined);
};

const submit = async () => {
  const before = await text("#s-toast");
  await cta.click();
  return toastAfter(before);
};

const go = async (name: string) => {
  await page.locator(`[data-page="${name}"]`).click();
  await page.waitForTimeout(450);
};

console.log(`suite: ${BASE} at 1440x900 · ${(await browser.version()).split(" ")[0]}`);

/* 1 · live, funded, and tradeable ------------------------------------------ */
console.log("\n1. open");
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator("#chain tr[data-strike]").first().waitFor({ timeout: 30_000 });
const reset = await page.evaluate(async () => {
  const response = await fetch("/demo/reset", { method: "POST" });
  return { status: response.status, body: await response.json() };
});
steps.push({ step: "open", data: reset });
if (reset.status !== 200 || !reset.body.ok) note("bad", "open", `demo reset failed: ${JSON.stringify(reset)}`);
else note("ok", "open", `demo account ${reset.body.account.slice(0, 18)}… · ${Number(reset.body.available).toFixed(2)} available`);
await shot("01-open");

const cells = await waitForVaultCell();
if (cells.length === 0) note("bad", "warm", "no vault quote after 180 s");
else note("ok", "warm", `${cells.length} vault-priced cells, nearest ${cells[0].kind} ${cells[0].strike}`);

/* 2 · a hold for more than one contract ------------------------------------ */
console.log("\n2. multi-contract hold");
const beforeHold = await fetchState();
let heldTicket: Record<string, any> | null = null;
if (cells.length === 0) {
  note("bad", "hold", "no cell to buy");
} else {
  const cell = cells[0];
  await go("trade");
  await page.locator('#dirs button[data-dir="buy"]').click();
  await setToggle("post-only", false);
  await selectCell(cell.strike, cell.kind);
  await setToggle("hold", true);
  await page.locator("#order-type").selectOption("limit");
  await page.locator("#amount").fill("2");
  const ready = await waitCta();
  const label = await text("#cta");
  steps.push({ step: "hold", data: { cell, label, ready } });
  if (!ready) note("bad", "hold", `the CTA is disabled: ${label}`);
  else if (!/no fee/i.test(label)) note("bad", "hold", `the CTA does not name the fee-free path: ${label}`);
  else {
    const toast = await submit();
    await shot("02-held");
    if (!/held/i.test(toast)) note("bad", "hold", `"${label}" → ${toast || "no toast"}`);
    else note("ok", "hold", `${label} → ${toast}`);
  }
  const after = await fetchState();
  const maximumBefore = Math.max(-1, ...beforeHold.positions.rows.map((row) => Number(row.ticketId)));
  heldTicket = after.positions.rows.find((row) => Number(row.ticketId) > maximumBefore && row.held === true) ?? null;
  steps.push({ step: "hold:state", data: heldTicket });
  if (!heldTicket) note("bad", "hold", "the chain has no new held ticket");
  else if (heldTicket.contracts !== 2) note("bad", "hold", `the held ticket is for ${heldTicket.contracts} contracts, not 2`);
  else note("ok", "hold", `ticket ${heldTicket.ticketId} · 2 contracts · cost ${heldTicket.cost}`);
}

/* 3 · the held ticket has no exit ------------------------------------------ */
console.log("\n3. a held ticket cannot leave");
if (heldTicket) {
  await go("positions");
  await page.locator("#pf-table tbody tr").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  const rows = await page.locator("#pf-table tbody tr").allInnerTexts();
  const row = rows.find((line) => /held to expiry/i.test(line));
  const closeButtons = await page.locator(`#pf-table button[data-close*="#${heldTicket.ticketId}"]`).count();
  steps.push({ step: "held:positions", data: { row, closeButtons } });
  if (!row) note("bad", "held", `no row reads as held: ${rows.join(" / ").slice(0, 160)}`);
  else note("ok", "held", row.replace(/\s+/g, " ").slice(0, 140));
  if (closeButtons !== 0) note("bad", "held", `the held ticket still offers ${closeButtons} close button(s)`);

  // The planner, not the chain, has to refuse this: a revert is a transaction
  // the trader paid for and learned nothing from.
  const seriesKey = String(heldTicket.seriesKey);
  const [, , kind, strike] = seriesKey.split("|");
  const refusal = await page.evaluate(
    async ({ ticket, kind, strike }) => {
      const response = await fetch("/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "close", asset: "ETH", kind, strike: Number(strike), ticket, quantity: 2 }),
      });
      return { status: response.status, body: await response.json() };
    },
    { ticket: Number(heldTicket.ticketId), kind, strike },
  );
  steps.push({ step: "held:refusal", data: refusal });
  if (refusal.status === 200 && refusal.body.ok) note("bad", "held", "the gateway signed a close for a held ticket");
  else if (!/hold/i.test(String(refusal.body.error))) {
    note("warn", "held", `refused, but not in words about holding: ${refusal.body.error}`);
  } else note("ok", "held", `refused before signing: ${refusal.body.error}`);
  await shot("03-held");
}

/* 4 · an order larger than the venue can carry ----------------------------- */
console.log("\n4. an over-sized order");
const beforePoor = await fetchState();
const poorCell = cells[0];
if (poorCell) {
  await go("trade");
  await page.locator('#dirs button[data-dir="buy"]').click();
  // Hold forces the vault, so a resting offer cannot absorb the order and turn a
  // size test into a partial book fill.
  await setToggle("hold", true);
  await setToggle("post-only", false);
  await selectCell(poorCell.strike, poorCell.kind);
  await page.locator("#order-type").selectOption("limit");
  await page.locator("#amount").fill("1000000");
  const ready = await waitCta();
  if (!ready) note("warn", "funds", `the CTA is disabled at a million contracts: ${await text("#cta")}`);
  else {
    const toast = await submit();
    await shot("04-refused");
    steps.push({ step: "funds", data: { toast } });
    if (!/rejected/i.test(toast)) note("bad", "funds", `a million-contract hold was not refused: ${toast}`);
    else note("ok", "funds", toast.slice(0, 150));
    const afterPoor = await fetchState();
    if (afterPoor.positions.rows.length !== beforePoor.positions.rows.length) {
      note("bad", "funds", "a refused buy still opened a position");
    } else if (Math.abs(afterPoor.you.available - beforePoor.you.available) > 1e-6) {
      note("bad", "funds", `a refused buy moved ${beforePoor.you.available - afterPoor.you.available} tokens`);
    } else note("ok", "funds", "nothing moved");
  }
} else note("warn", "funds", "no vault cell to attempt");

/* 5 · fill or kill larger than the book ------------------------------------ */
console.log("\n5. fill or kill, larger than the book");
const beforeFok = await fetchState();
const spot = Number(beforeFok.spot ?? 0);
const bookCell = beforeFok.chain
  .flatMap((row) =>
    (["call", "put"] as const).map((kind) => ({
      strike: row.strike,
      kind: kind === "call" ? "Call" : "Put",
      ask: Number(row[kind]?.ask ?? 0),
      from: row[kind]?.takeAskFrom ?? null,
      offerId: row[kind]?.bestOfferId ?? null,
    })),
  )
  .filter((cell) => cell.from === "book" && cell.offerId !== null && cell.ask > 0)
  .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
if (!bookCell) note("warn", "fok", "no book-priced cell is standing right now");
else {
  await go("trade");
  await page.locator('#dirs button[data-dir="buy"]').click();
  await setToggle("hold", false);
  await setToggle("post-only", false);
  await selectCell(bookCell.strike, bookCell.kind);
  await page.locator("#order-type").selectOption("fok");
  await page.locator("#amount").fill("9999");
  const ready = await waitCta();
  if (!ready) note("warn", "fok", `the CTA is disabled: ${await text("#cta")}`);
  else {
    const toast = await submit();
    await shot("05-fok");
    steps.push({ step: "fok", data: { bookCell, toast } });
    if (!/rejected/i.test(toast)) note("bad", "fok", `a 9999-contract FOK was not refused: ${toast}`);
    else note("ok", "fok", toast.slice(0, 150));
    const afterFok = await fetchState();
    if (afterFok.positions.rows.length !== beforeFok.positions.rows.length) {
      note("bad", "fok", "a refused FOK still opened a position");
    }
    const stillThere = afterFok.orders.some((order) => Number(order.id) === Number(bookCell.offerId));
    if (!stillThere) note("warn", "fok", `offer ${bookCell.offerId} is gone; it may have been taken or repriced by the maker`);
    else note("ok", "fok", "the book is exactly where it was");
  }
}

/* 5b · a partial market fill is reported as partial ------------------------- */
console.log("\n5b. partial fill");
const beforePartial = await fetchState();
const spot2 = Number(beforePartial.spot ?? 0);
const partialCell = beforePartial.chain
  .flatMap((row) =>
    (["call", "put"] as const).map((kind) => ({
      strike: row.strike,
      kind: kind === "call" ? "Call" : "Put",
      ask: Number(row[kind]?.ask ?? 0),
      from: row[kind]?.takeAskFrom ?? null,
      offerId: row[kind]?.bestOfferId ?? null,
    })),
  )
  .filter((cell) => cell.from === "book" && cell.offerId !== null && cell.ask > 0)
  .sort((a, b) => Math.abs(a.strike - spot2) - Math.abs(b.strike - spot2))[0];
const resting = partialCell
  ? Number(beforePartial.orders.find((order) => Number(order.id) === Number(partialCell.offerId))?.size ?? 0)
  : 0;
if (!partialCell || resting < 1) note("warn", "partial", "no resting offer to take partially");
else {
  await go("trade");
  await page.locator('#dirs button[data-dir="buy"]').click();
  await setToggle("hold", false);
  await setToggle("post-only", false);
  await selectCell(partialCell.strike, partialCell.kind);
  await page.locator("#order-type").selectOption("limit");
  await page.locator("#amount").fill(String(resting + 2));
  const ready = await waitCta();
  if (!ready) note("warn", "partial", `the CTA is disabled: ${await text("#cta")}`);
  else {
    const toast = await submit();
    const afterPartial = await fetchState();
    const added = afterPartial.positions.rows
      .filter((row) => !beforePartial.positions.rows.some((before) => before.ticketId === row.ticketId))
      .reduce((sum, row) => sum + Number(row.contracts), 0);
    steps.push({ step: "partial", data: { resting, toast, added } });
    const partial = /took (\d+(?:\.\d+)?) of (\d+(?:\.\d+)?)x off the book/.exec(toast);
    if (partial) {
      const filled = Number(partial[1]);
      if (Math.abs(added - filled) > 1e-9) {
        note("bad", "partial", `the message says ${filled} filled but the position is ${added}`);
      } else if (filled >= resting + 2) {
        note("warn", "partial", `the book covered the whole ${resting + 2}x after all`);
      } else note("ok", "partial", `reported ${filled} of ${resting + 2}x honestly · ${added}x on the ticket`);
    } else if (/took .* off the book/.test(toast)) note("warn", "partial", "the book covered the whole order");
    else if (/bought/.test(toast)) note("warn", "partial", "the take went to the vault; the book moved");
    else note("bad", "partial", `unexpected fill message: ${toast || "no toast"}`);
    await shot("05b-partial");
  }
}

/* 6 · a stranger cannot make the gateway sign ------------------------------ */
console.log("\n6. origin and input attacks");
const foreign = await fetch(`${BASE}/action`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://evil.example" },
  body: JSON.stringify({ type: "deposit", amount: 1 }),
});
const foreignBody = await foreign.text();
steps.push({ step: "origin", data: { status: foreign.status, body: foreignBody.slice(0, 200) } });
if (foreign.status !== 403) note("bad", "origin", `a foreign origin got ${foreign.status}: ${foreignBody.slice(0, 120)}`);
else note("ok", "origin", "403 for another origin");

const unknown = await page.evaluate(async () => {
  const response = await fetch("/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "buy", asset: "ETH", kind: "Call", strike: 999_999, quantity: 1, limit: 1 }),
  });
  return { status: response.status, body: await response.json() };
});
steps.push({ step: "unknown", data: unknown });
if (unknown.status === 200 && unknown.body.ok) note("bad", "unknown", "an unlisted strike was signed");
else if (unknown.status >= 500) note("bad", "unknown", `an unlisted strike broke the gateway: ${unknown.body.error}`);
else note("ok", "unknown", `refused: ${unknown.body.error}`);

const zero = await page.evaluate(async () => {
  const response = await fetch("/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "buy", asset: "ETH", kind: "Call", strike: 2225, quantity: 0, limit: 1 }),
  });
  return { status: response.status, body: await response.json() };
});
steps.push({ step: "zero", data: zero });
if (zero.status === 200 && zero.body.ok) note("bad", "zero", "a zero-contract buy was signed");
else note("ok", "zero", `refused: ${zero.body.error}`);

/* 7 · the screen, the state and the custody sum agree ----------------------- */
console.log("\n7. reconciliation");
const state = await fetchState();
const indexText = await text("#idx-ETH [data-px]");
const shown = Number(indexText.replace(/[^0-9.]/g, ""));
const drift = Math.abs(shown - Number(state.spot ?? 0)) / Math.max(1, Number(state.spot ?? 0));
steps.push({ step: "reconcile", data: { shown, spot: state.spot, drift } });
if (!Number.isFinite(shown) || drift > 0.01) note("bad", "index", `page index ${shown} vs state ${state.spot}`);
else note("ok", "index", `${shown.toFixed(2)} vs ${Number(state.spot).toFixed(2)}`);

const custody = state.custody;
const pool = state.pool;
steps.push({ step: "custody", data: custody });
if (!custody.conserved) note("bad", "custody", `custody is not conserved: expected ${custody.expected}, held ${custody.held}`);
else if (Math.abs(custody.expected - custody.held) > 0.01) {
  note("bad", "custody", `expected ${custody.expected} but the chain holds ${custody.held}`);
} else note("ok", "custody", `${Number(custody.held).toFixed(2)} tokens accounted for in ${custody.buckets.length} buckets`);

if (pool.reserved > pool.equity + 1e-6) note("bad", "vault", `reserved ${pool.reserved} exceeds equity ${pool.equity}`);
else if (Math.abs(pool.freeEquity - (pool.equity - pool.reserved)) > 0.01) {
  note("bad", "vault", `free equity ${pool.freeEquity} is not equity ${pool.equity} less reserved ${pool.reserved}`);
} else if (pool.utilisationBps < 0 || pool.utilisationBps > 10_000) {
  note("bad", "vault", `utilisation ${pool.utilisationBps} bps is out of range`);
} else note("ok", "vault", `${pool.utilisationBps} bps committed · ${pool.openTickets} open`);

for (const row of state.positions.rows) {
  for (const field of ["cost", "mark", "open", "maxPayout", "exitUnit"]) {
    const value = row[field];
    if (value !== null && value !== undefined && !Number.isFinite(Number(value))) {
      note("bad", "numbers", `ticket ${row.ticketId} has a non-finite ${field}: ${value}`);
    }
  }
}
const visible = await page.evaluate(() => document.body.innerText);
if (/NaN|Infinity/.test(visible)) note("bad", "numbers", `the page renders a non-finite number: ${visible.match(/.{0,40}(NaN|Infinity).{0,40}/)?.[0]}`);
else note("ok", "numbers", "every position number is finite or deliberately blank");

const freshSeats = state.oracle.seats.filter((seat) => seat.fresh).length;
steps.push({ step: "oracle", data: { fresh: freshSeats, seats: state.oracle.seats } });
if (freshSeats < 2) note("warn", "oracle", `${freshSeats} fresh seat(s): settlement is not currently possible`);
else note("ok", "oracle", `${freshSeats}/${state.oracle.seats.length} seats fresh`);

/* 8 · reset and accessibility ---------------------------------------------- */
console.log("\n8. reset and accessibility");
const topUp = await page.evaluate(async () => {
  const response = await fetch("/demo/reset", { method: "POST" });
  return { status: response.status, body: await response.json() };
});
steps.push({ step: "reset", data: topUp });
if (topUp.status !== 200 || !topUp.body.ok) note("bad", "reset", `demo reset failed: ${JSON.stringify(topUp)}`);
else note("ok", "reset", `${Number(topUp.body.available).toFixed(2)} available · topped up ${Number(topUp.body.toppedUp).toFixed(2)}`);

const a11y = await page.evaluate(() => {
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };
  const nameOf = (el: Element) =>
    (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent ?? "").trim();
  const buttons = [...document.querySelectorAll("button, [role='button']")].filter(shown);
  const nameless = buttons.filter((el) => nameOf(el).length === 0).map((el) => el.outerHTML.slice(0, 90));
  const controls = [...document.querySelectorAll("input, select")].filter(shown);
  const unlabeled = controls
    .filter((el) => {
      if (el.getAttribute("aria-label")) return false;
      const id = el.getAttribute("id");
      if (id && document.querySelector(`label[for="${id}"]`)) return false;
      return !el.closest("label");
    })
    .map((el) => el.getAttribute("id") ?? el.tagName);
  const toast = document.getElementById("s-toast");
  const canvases = [...document.querySelectorAll("canvas")].filter(shown).map((canvas) => ({
    id: canvas.getAttribute("id"),
    label: canvas.getAttribute("aria-label"),
  }));
  return {
    buttons: buttons.length,
    nameless,
    controls: controls.length,
    unlabeled,
    live: (toast?.getAttribute("aria-live") ?? toast?.getAttribute("role") ?? "") as string,
    toggles: [...document.querySelectorAll("[role='button'][aria-pressed]")].length,
    canvases,
  };
});
steps.push({ step: "a11y", data: a11y });
if (a11y.nameless.length) note("bad", "a11y", `${a11y.nameless.length} unnamed button(s): ${a11y.nameless[0]}`);
else if (a11y.unlabeled.length) note("bad", "a11y", `${a11y.unlabeled.length} unlabelled control(s): ${a11y.unlabeled.join(", ")}`);
else if (!a11y.live) note("bad", "a11y", "the toast is not a live region");
else if (a11y.toggles < 2) note("warn", "a11y", `expected two aria-pressed toggles, found ${a11y.toggles}`);
else {
  const unlabeledCanvases = a11y.canvases.filter((canvas) => canvas.label === null);
  if (unlabeledCanvases.length) note("warn", "a11y", `unlabelled canvas: ${unlabeledCanvases.map((c) => c.id).join(", ")}`);
  else note("ok", "a11y", `${a11y.buttons} named buttons · ${a11y.controls} labelled controls · live toast`);
  await shot("08-a11y");
}

/* 9 · console and network -------------------------------------------------- */
console.log("\n9. console and network");
const refusals = badResponses.filter((entry) => /\/action/.test(entry)).length;
const unexpectedConsole = consoleErrors.filter((line) => !/status of 400/.test(line));
if (unexpectedConsole.length) note("warn", "console", `${unexpectedConsole.length} console error(s): ${unexpectedConsole[0].slice(0, 160)}`);
else if (consoleErrors.length === refusals) note("ok", "console", `no page errors; the ${refusals} console lines are the deliberate refusals`);
else if (consoleErrors.length) note("warn", "console", `${consoleErrors.length} console error(s): ${consoleErrors[0].slice(0, 160)}`);
else note("ok", "console", "no console errors, no page exceptions");
const expectedHttp = badResponses.filter((entry) => !/\/action/.test(entry));
if (expectedHttp.length) note("warn", "network", `${expectedHttp.length} unexpected HTTP error(s): ${expectedHttp[0]}`);
else note("ok", "network", "no unexpected HTTP errors");
steps.push({ step: "net", data: { consoleErrors, failedRequests, badResponses } });

await context.tracing.stop({ path: join(OUT, "trace.zip") });
let videoPath: string | null = null;
if (video) {
  await context.close();
  const webm = join(OUT, "journey-suite.webm");
  await video.saveAs(webm);
  const mp4 = join(OUT, "journey-suite.mp4");
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
  } else videoPath = webm;
} else {
  await context.close();
}
writeFileSync(
  join(OUT, "report.json"),
  JSON.stringify({ base: BASE, at: new Date().toISOString(), driver: "playwright", journey: "suite", video: videoPath, steps, findings }, null, 2),
);
const blockers = findings.filter((finding) => finding.kind === "bad").length;
const rough = findings.filter((finding) => finding.kind === "warn").length;
console.log(`\nsuite: ${blockers} blocker(s), ${rough} rough edge(s) · evidence in ${OUT}`);
await browser.close();
process.exit(blockers === 0 ? 0 : 1);
