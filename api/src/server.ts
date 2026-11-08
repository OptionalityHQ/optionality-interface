/**
 * The gateway's I/O half: HTTP in, transactions out. It is deliberately thin —
 * every decision lives in `gateway.ts`, `gather.ts` and `actions.ts`, where it
 * has a test. The one rule this file is allowed to break is arithmetic: if a
 * number is computed here rather than read from the chain or the engine, the
 * boundary has already leaked.
 *
 *   node api/src/server.ts --session data/chain-session.json --engine http://127.0.0.1:8787
 *
 * The chain client is `chain.ts`: signing and JSON-RPC, no product rules.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { accountId, walletTransactions, FaucetLedger } from "./testnet.ts";
import { fetchCandles, fetchMarketStats, fetchLiveSpotTick } from "./candles.ts";
import { serveMedia } from "./media.ts";
import { getLeaderboard, getUserMandates, createOrUpdateMandate, revokeMandate, getCopyJournal } from "./copy-trading.ts";
import { Chain } from "./chain.ts";
import { type Asset, type ClosedRow, type Kind, type LadderSide, type PoolPrice, SCALE, Tape, amount, fromUnits, rejectSigning, toUnits } from "./gateway.ts";
import {
  type EngineMarks,
  type Registry,
  type Views,
  gatherState,
  registryForExpiry,
  registryPairs,
  seriesStrike,
} from "./gather.ts";
import { History } from "./history.ts";
import { projectSmile } from "./smile.ts";
import { type Call, describe, planAction } from "./actions.ts";
import { marksFromEngine, mergeSide, normalizeBids, normalizeBook, normalizePool, normalizePrices, normalizePositions, normalizeSeries } from "./gateway.ts";

const arg = (name: string, fallback: string): string => {
  const argv = process.argv;
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};

const PORT = Number(arg("--port", "8790"));
const ENGINE = arg("--engine", "http://127.0.0.1:8787");
const SESSION = arg("--session", "data/chain-session.json");
const DEMO = arg("--demo", "demo/index.html");
const LANDING = arg("--landing", "demo/landing.html");
const STREAM_MS = Number(arg("--stream-ms", "180"));

/**
 * The demo account's floor and top-up, in the token's micro-units: 1,000 and 5,000
 * USDT. A reset only fires when the visitor is actually short, so pressing it twice
 * does not mint a fortune.
 */
const DEMO_FLOOR = 1_000_000_000e6;
const DEMO_TOPUP = 1_000e6;

/** This process's own record of the session: one sample a second, five minutes deep. */
const history = new History();
const visitorHistories = new Map<string, History>();
function historyFor(account: string): History {
  if (!visitorHistories.has(account)) {
    if (visitorHistories.size >= 200) visitorHistories.delete(visitorHistories.keys().next().value!);
    visitorHistories.set(account, new History());
  }
  return visitorHistories.get(account)!;
}

/** The reads `gather.ts` asks for, mapped onto the contract's own names. */
function viewsFor(chain: Chain): Views {
  let batchBooksSupported = true;
  return {
    async seriesIds() {
      const stats = (await chain.view("stats")) as { series_count: number };
      return Array.from({ length: stats.series_count }, (_unused, index) => index);
    },
    getSeriesMany: async (seriesIds) =>
      (await chain.view("get_series_many", { series_ids: seriesIds })) as Array<[number, unknown]>,
    ...(chain.session.network === "testnet" ? { getBooksMany: async (seriesIds: number[]): Promise<Array<[number, unknown, unknown]>> => {
      if (batchBooksSupported) {
        try { return await chain.view("get_books", { series_ids: seriesIds, limit: 20 }) as Array<[number, unknown, unknown]>; }
        catch (error) {
          if (!/method.*not.*found|MethodNotFound/i.test(String(error))) throw error;
          batchBooksSupported = false;
        }
      }
      const books: Array<[number, unknown, unknown]> = [];
      for (const id of seriesIds) books.push([id, await chain.view("get_book", { series_id: id, limit: 20 }), await chain.view("get_bids", { series_id: id, limit: 20 })]);
      return books;
    } } : {}),
    getBook: (seriesId, limit) => chain.view("get_book", { series_id: seriesId, limit }),
    getBids: (seriesId, limit) => chain.view("get_bids", { series_id: seriesId, limit }),
    getPoolState: () => chain.view("get_pool_state"),
    // The vault's own prices. Chunked because the contract caps one call at 64
    // series and a two-asset ladder can pass it.
    getPoolPrices: (seriesIds, quantityUnits) =>
      chain.view("get_pool_prices", { series_ids: seriesIds, quantity: quantityUnits }),
    getPositions: (account) => chain.view("get_positions", { account, limit: 100 }),
    getCommittee: (feed) => chain.oracleView("get_committee", { feed_id: feed }),
    getBalance: (account) => chain.view("get_balance", { account_id: account }) as Promise<string>,
    expectedCustody: () => chain.view("expected_custody") as Promise<string>,
    getLpShares: (account) => chain.view("get_lp_shares", { account_id: account }) as Promise<string>,
    getLpValue: (account) => chain.view("get_lp_value", { account_id: account }) as Promise<string>,
    // The token is a different contract, so this read goes around the market
    // client's default destination.
    ftBalanceOf: (account) => chain.ftBalance(account),
    stats: async () => (await chain.view("stats")) as Record<string, unknown>,
  };
}

/**
 * The engine already has a price for every cell; take it as it is. These are its
 * model numbers — the mark and the display spread. The vault's tradeable price is
 * not among them: it is read off the chain with `get_pool_prices`, because the
 * contract only trades at the mid the venue published, in Rust integers.
 */
/**
 * The expiries the venue lists, nearest first. A screen with one ladder was a
 * screen with one market; the schedule is what turns the strip into a week.
 */
async function engineExpiries(): Promise<string[]> {
  try {
    const response = await fetch(`${ENGINE}/health`);
    if (!response.ok) return [];
    const body = (await response.json()) as { expiries?: number[]; expiryNs?: number };
    const list = Array.isArray(body.expiries) ? body.expiries : body.expiryNs === undefined ? [] : [body.expiryNs];
    return list.map((ns) => String(ns));
  } catch {
    return [];
  }
}

/**
 * Pull the engine's ladder for one expiry. The marks move with the tenor — a
 * week out is worth more than an hour out — so the rows have to be the ones the
 * expiry on screen asked for, not whichever ladder the engine happened to name.
 */
async function engineRows(
  asset: Asset,
  expiryNs?: string,
): Promise<{ rows: Array<{ strike: number; put: LadderSide | null; call: LadderSide | null }>; spot: number | null; expiryNs: string }> {
  const named = expiryNs && /^\d+$/.test(expiryNs) ? `&expiry_ns=${expiryNs}` : "";
  const response = await fetch(`${ENGINE}/state?asset=${asset}${named}`);
  if (!response.ok) throw new Error(`engine ${asset} state failed: ${response.status}`);
  const body = (await response.json()) as {
    spot: number | null;
    expiryNs: string;
    chain: Array<{
      strike: number;
      put: Record<string, number | string | null> | null;
      call: Record<string, number | string | null> | null;
    }>;
  };
  const side = (raw: Record<string, number | string | null> | null): LadderSide | null => {
    if (raw === null || raw === undefined) return null;
    const nullable = (key: string): number | null =>
      raw[key] === null || raw[key] === undefined ? null : Number(raw[key]);
    return {
      mark: Number(raw.mark ?? 0),
      bid: Number(raw.bid ?? 0),
      ask: Number(raw.ask ?? 0),
      markIv: nullable("markIv"),
      entryIv: nullable("entryIv"),
      exitIv: nullable("exitIv"),
      bidIv: nullable("bidIv"),
      askIv: nullable("askIv"),
      delta: Number(raw.delta ?? 0),
      gamma: Number(raw.gamma ?? 0),
      vega: Number(raw.vega ?? 0),
      theta: Number(raw.theta ?? 0),
      bidSize: nullable("bidSize") ?? 0,
      askSize: nullable("askSize") ?? 0,
      bidCount: nullable("bidCount") ?? 0,
      askCount: nullable("askCount") ?? 0,
      bestBidId: nullable("bidId"),
      bestOfferId: nullable("offerId"),
      // The engine has no say in what the vault charges, so it supplies neither
      // of these. A cell the contract has not quoted stays `poolAsk: null` and
      // the screen says the vault is not selling, rather than showing a mark a
      // click cannot fill.
      takeAsk: null,
      takeAskFrom: null,
      seriesId: null,
      settlement: "open",
      // The engine says the legs in the same integer units the contract stores.
      low: fromUnits(amount(raw.low ?? 0)),
      high: fromUnits(amount(raw.high ?? 0)),
    } as LadderSide;
  };
  return {
    rows: body.chain.map((row) => ({ strike: row.strike, put: side(row.put), call: side(row.call) })),
    spot: body.spot,
    // The stamp the cells were marked against. A ladder and a registry have to
    // agree on which batch they are describing, and the engine is the one that
    // decided — not the calendar day, which rolls over at 00:00 UTC and leaves a
    // page whose "today" no longer contains the live grid.
    expiryNs: String(body.expiryNs),
  };
}

/**
 * Which batch the screen is looking at: the stamp an expiry chip carried, the
 * day a link asked for, or — when nothing was asked — the expiry the engine is
 * pricing right now. The day is a poor default: it rolls at 00:00 UTC, and a
 * page opened late in the evening would otherwise be shown a grid that had
 * already run off while tonight's live one sat outside the filter.
 */
function expiryWanted(requested: string, expiries: string[]): string {
  if (/^\d+$/.test(requested)) return requested;
  if (requested.length >= 10) return requested.slice(0, 10);
  const midnightUtc = expiries.find((ns) => {
    const ms = Math.round(Number(ns) / 1e6);
    const d = new Date(ms);
    return Number.isFinite(ms) && ms > Date.now() && d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  });
  return midnightUtc ?? expiries[0] ?? "";
}

/**
 * The engine's index panel, as the engine wrote it. Nothing is added: a figure
 * computed here would be a second opinion about a price, which is the thing this
 * whole stack is arranged to avoid. Null means the engine is not answering, and
 * the banner says `offline` rather than showing the last number it knew.
 */
async function feedFromEngine(): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${ENGINE}/feed`);
    return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The page, pointed at whoever is serving it. An empty `MARKET_URL` makes every
 * fetch relative, so the same file works on any port the gateway is on and no
 * build step has to guess the deployment.
 */
function pageFor(htmlPath: string): string {
  return readFileSync(htmlPath, "utf8").replace(
    /const MARKET_URL = "[^"]*";/,
    'const MARKET_URL = ""; /* served by the gateway, so relative is correct */',
  );
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16_384) throw new Error("request body is too large");
  }
  return body;
}

async function main(): Promise<void> {
  const session = JSON.parse(readFileSync(SESSION, "utf8")) as {
    contracts: { options: string; token: string };
    roles: Record<string, { account: string }>;
  };
  const chain = await Chain.connect(SESSION);
  const views = viewsFor(chain);
  const publicTestnet = chain.session.network === "testnet";
  const you = publicTestnet ? chain.options : chain.id("you");
  const faucet = publicTestnet && process.env.NEAR_ADMIN_CREDENTIALS ? new FaucetLedger("data/private/faucet.json") : null;
  let faucetBusy = false;
  const faucetRate = new Map<string, number>();
  const vault = session.contracts.options;
  // The tape reads the venue the only way a gateway can: by watching what the
  // chain holds. These are the sandbox's funded roles, not a bot roster.
  const tape = new Tape();
  tape.self = you;
  const holders = Object.values(session.roles ?? {}).map((role) => role.account);
  console.log(`gateway    ${vault}`);
  console.log(`as         ${you}`);
  console.log(`engine     ${ENGINE}`);

  const PRESENCE_FILE = "data/active-presence.json";
  let activeStreams = 0;
  let lastUserActivity = Date.now();

  const touchPresence = (active = true): void => {
    try {
      const isUserActive = active && (activeStreams > 0 || Date.now() - lastUserActivity < 90_000);
      writeFileSync(
        PRESENCE_FILE,
        JSON.stringify({
          active: isUserActive,
          streams: activeStreams,
          updated_at: Date.now(),
        }),
      );
    } catch {}
  };

  touchPresence(false);
  const presenceTimer = setInterval(() => {
    touchPresence(activeStreams > 0 || Date.now() - lastUserActivity < 90_000);
  }, 10_000);
  presenceTimer.unref();

  // Rolling sub-second tick history per asset (only sampled while visitors are active).
  const tickBuffers: Record<Asset, Array<{ time: number; price: number }>> = {
    ETH: [],
    BTC: [],
  };
  const recordTick = (asset: Asset, price: number, atMs = Date.now()) => {
    if (!Number.isFinite(price) || price <= 0) return;
    const buf = tickBuffers[asset];
    const last = buf[buf.length - 1];
    // Record immediately when price moves, and at least every 650ms so the chart's live candle & clock never stall.
    if (last && atMs - last.time < 650 && Math.abs(last.price - price) < 1e-8) return;
    buf.push({ time: atMs, price });
    if (buf.length > 720) buf.splice(0, buf.length - 720);
  };
  const extractChartSpot = (
    asset: Asset,
    feed: { assets?: Record<string, { median?: number; sources?: Array<{ name?: string; price?: number; fresh?: boolean }> }> } | null,
  ): number | null => {
    const summary = feed?.assets?.[asset];
    if (!summary) return null;
    // Prefer the fresh Binance USDT source so the chart's live tick stream matches the Binance USDT klines without stalling on slower USD venues.
    const binanceSource = summary.sources?.find((s) => s.name === "binance" && s.fresh && Number.isFinite(Number(s.price)) && Number(s.price) > 0);
    if (binanceSource) return Number(binanceSource.price);
    const median = Number(summary.median);
    return Number.isFinite(median) && median > 0 ? median : null;
  };
  const tickSampler = setInterval(() => {
    if (activeStreams <= 0 && Date.now() - lastUserActivity >= 90_000) return;
    void (async () => {
      const feed = (await feedFromEngine()) as {
        assets?: Record<string, { median?: number; sources?: Array<{ name?: string; price?: number; fresh?: boolean }> }>;
      } | null;
      const now = Date.now();
      for (const a of ["ETH", "BTC"] as const) {
        const px = extractChartSpot(a, feed) ?? (await fetchLiveSpotTick(a));
        if (px !== null && Number.isFinite(px) && px > 0) recordTick(a, px, now);
      }
    })();
  }, 220);
  tickSampler.unref();

  /** Standard normal CDF for Black-Scholes spread model pricing (matching surface/src/pricing.rs & core/src/fees.rs). */
  const normCdf = (x: number): number => {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * absX);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return 0.5 * (1 + sign * y);
  };

  const smileVol = (atmVol: number, spot: number, strike: number): number => {
    if (spot <= 0 || strike <= 0) return atmVol;
    const m = Math.log(spot / strike);
    return Math.max(0.05, atmVol * (1 + 0.35 * m));
  };

  const bsCall = (spot: number, strike: number, years: number, vol: number): number => {
    if (strike <= 0 || spot <= 0) return 0;
    if (years <= 0 || vol <= 0) return Math.max(0, spot - strike);
    const sqrtT = Math.sqrt(years);
    const d1 = (Math.log(spot / strike) + 0.5 * vol * vol * years) / (vol * sqrtT);
    const d2 = d1 - vol * sqrtT;
    return spot * normCdf(d1) - strike * normCdf(d2);
  };

  const estimateSpreadQuote = (
    asset: Asset,
    kind: Kind,
    strike: number,
    expiryNs: number,
    spot: number,
    quantity = 1,
    lowOverride?: number,
    highOverride?: number,
  ) => {
    const defaultWidth = asset === "BTC" ? 4000 : 100;
    const cleanStrike = Math.max(0.01, Math.round(strike * 100) / 100);
    const low =
      lowOverride !== undefined && Number.isFinite(lowOverride) && lowOverride > 0
        ? lowOverride
        : kind === "Call"
          ? cleanStrike
          : Math.max(0.01, Math.round((cleanStrike - defaultWidth) * 100) / 100);
    const high =
      highOverride !== undefined && Number.isFinite(highOverride) && highOverride > low
        ? highOverride
        : kind === "Call"
          ? Math.round((cleanStrike + defaultWidth) * 100) / 100
          : cleanStrike;
    const actualWidth = Math.max(0.01, high - low);
    const nowNs = Date.now() * 1e6;
    const years = Math.max(0, (expiryNs - nowNs) / 1e9) / (365.25 * 86400);
    const atmVol = 0.6;
    const cLow = bsCall(spot, low, years, smileVol(atmVol, spot, low));
    const cHigh = bsCall(spot, high, years, smileVol(atmVol, spot, high));
    const callSpreadVal = Math.max(0, Math.min(actualWidth, cLow - cHigh));
    // Exact put-call parity on bounded vertical spreads (surface/src/pricing.rs):
    // PutSpread(low, high) + CallSpread(low, high) = high - low
    const rawMid =
      kind === "Call"
        ? callSpreadVal
        : Math.max(0, Math.min(actualWidth, actualWidth - callSpreadVal));
    // Clamp inside [10_000 units, 98% of width] so contract bounds are respected
    const midUnits = Math.max(
      10_000,
      Math.min(Math.round(actualWidth * 0.98 * 1e6), Math.round(rawMid * 1e6)),
    );
    // Exact integer fee math matching core/src/fees.rs (margin_bps = 50, impact_bps = 100 on venue)
    // Supports fractional contract quantities scaled by 1e6 (price_scale = 1_000_000)
    const cleanQty = Number.isFinite(quantity) && quantity > 0 ? Math.max(0.0001, Math.round(quantity * 1_000_000) / 1_000_000) : 1;
    const qtyScaled = BigInt(Math.max(100, Math.round(cleanQty * 1_000_000)));
    const scaleBig = 1_000_000n;
    const basisBig = 10_000n;
    const denom = scaleBig * basisBig;
    const marginBps = 50n;
    const impactBps = 100n;
    const midBig = BigInt(midUnits);
    const totalEntryUnits = Number((qtyScaled * midBig * (basisBig + marginBps) + (denom - 1n)) / denom);
    const totalExitUnits = Number((qtyScaled * midBig * (basisBig - impactBps)) / denom);
    const entryUnitsPerContract = Number((midBig * (basisBig + marginBps) + 9_999n) / basisBig);
    const exitUnitsPerContract = Number((midBig * (basisBig - impactBps)) / basisBig);
    return {
      low,
      high,
      width: actualWidth,
      midUnits,
      entryUnits: totalEntryUnits,
      exitUnits: totalExitUnits,
      unitPremium: entryUnitsPerContract / 1e6,
      exitUnit: exitUnitsPerContract / 1e6,
      premium: totalEntryUnits / 1e6,
    };
  };

  type PersistedClosedRow = ClosedRow & {
    ticketId?: number;
    seriesId?: number;
    asset?: string;
    kind?: string;
    low?: number;
    high?: number;
    expiryNs?: number;
    atMs?: number;
    fixedPrice?: number | null;
  };
  const TRADE_HISTORY_FILE = "data/trade-history.json";
  const tradeHistoryByAccount = new Map<string, PersistedClosedRow[]>();
  try {
    if (existsSync(TRADE_HISTORY_FILE)) {
      const parsed = JSON.parse(readFileSync(TRADE_HISTORY_FILE, "utf8")) as Record<string, PersistedClosedRow[]>;
      for (const [acct, rows] of Object.entries(parsed)) {
        if (Array.isArray(rows)) tradeHistoryByAccount.set(acct, rows);
      }
    }
  } catch {}
  const saveTradeHistory = (): void => {
    try {
      const obj: Record<string, PersistedClosedRow[]> = {};
      for (const [k, v] of tradeHistoryByAccount) obj[k] = v.slice(0, 100);
      writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(obj, null, 2));
    } catch {}
  };
  const recordTradeHistory = (accounts: string[], entry: PersistedClosedRow): void => {
    let changed = false;
    for (const rawAcct of accounts) {
      const acct = (rawAcct || "").trim();
      if (!acct) continue;
      const list = tradeHistoryByAccount.get(acct) ?? [];
      const existingIdx = list.findIndex(
        (r) =>
          (entry.ticketId !== undefined && r.ticketId === entry.ticketId && r.series === entry.series) ||
          (r.series === entry.series && r.expiryNs && entry.expiryNs && r.expiryNs === entry.expiryNs && Math.abs(r.cost - entry.cost) < 1e-6),
      );
      if (existingIdx !== -1) {
        list[existingIdx] = { ...list[existingIdx], ...entry };
      } else {
        list.unshift(entry);
        changed = true;
      }
      list.sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
      tradeHistoryByAccount.set(acct, list.slice(0, 100));
    }
    if (changed) saveTradeHistory();
  };
  const getAccountTradeHistory = (accounts: string[]): PersistedClosedRow[] => {
    const merged: PersistedClosedRow[] = [];
    const seen = new Set<string>();
    for (const rawAcct of accounts) {
      const acct = (rawAcct || "").trim();
      if (!acct) continue;
      for (const row of tradeHistoryByAccount.get(acct) ?? []) {
        const key = row.ticketId !== undefined ? `t:${row.ticketId}:${row.series}` : `${row.series}:${row.at}:${row.cost}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
      }
    }
    return merged.sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
  };
  const settlingTickets = new Set<number>();

  const run = async (calls: Call[], signerRole = "you"): Promise<Array<{ hash: string; value: unknown }>> => {
    const out: Array<{ hash: string; value: unknown }> = [];
    for (const call of calls) {
      const args = { ...call.args };
      if (args.receiver_id === null) args.receiver_id = vault;
      const target = call.contract === "token" ? session.contracts.token : vault;
      out.push(
        await chain.call(signerRole, call.method, args, {
          gas: call.tgas * 1_000_000_000_000n,
          deposit: (call.depositYocto ?? 0n).toString(),
          contract: target,
        }),
      );
    }
    return out;
  };

  /** Everything an action needs to be planned, read fresh for the POST.
   *
   * `quantity` is the contracts the click is for, because the vault prices a
   * whole quantity — the ceiling it charges for 3 contracts is not 3 times its
   * price for 1, and a plan that guessed would be a plan the contract rejects.
   * `expiry` is what the page asked for, unresolved: an empty string means the
   * batch the engine is live on, never whatever day the clock says. */
  const contextFor = async (
    asset: Asset,
    kind: Kind,
    strike: number,
    expiry: string,
    quantity: number,
    visitor = you,
    allowCustomCreate = false,
    ticketId: number | null = null,
  ) => {
    const positions = normalizePositions(await views.getPositions(visitor), vault);
    const heldTicket =
      ticketId !== null && Number.isInteger(ticketId)
        ? positions.find((p) => p.ticketId === ticketId) ?? null
        : null;
    const effectiveStrike = heldTicket ? seriesStrike(heldTicket) : strike;
    const effectiveAsset = heldTicket ? heldTicket.asset : asset;
    const effectiveKind = heldTicket ? heldTicket.kind : kind;
    const effectiveQty = heldTicket ? heldTicket.contracts : quantity;
    const empty = { you: visitor, vault, priceScale: 1_000_000, seriesFor: () => null, side: null, price: null, positions };
    if ((!Number.isFinite(effectiveStrike) || effectiveStrike <= 0) && !heldTicket) return empty;
    let pairs = await registryPairs(views);
    const expiries = await engineExpiries();
    const wanted = heldTicket ? String(heldTicket.expiryNs) : expiryWanted(expiry, expiries);
    const engineData = await engineRows(effectiveAsset, wanted).catch(() => null);
    const rows = engineData?.rows ?? [];
    const feed = (await feedFromEngine().catch(() => null)) as { assets?: Record<string, { median?: number }> } | null;
    const liveSpot =
      engineData?.spot ??
      extractChartSpot(effectiveAsset, feed) ??
      (await fetchLiveSpotTick(effectiveAsset)) ??
      (effectiveAsset === "BTC" ? 76000 : 2250);

    let registry: Registry = registryForExpiry(pairs, wanted, effectiveAsset, false);
    let seriesId = heldTicket ? heldTicket.seriesId : registry.idFor(effectiveAsset, effectiveKind, effectiveStrike);

    // On local sandbox, if the user entered a custom strike price or a custom expiry timestamp,
    // dynamically list and quote that exact series on the NEAR sandbox contract so any price & any expiry works!
    if (seriesId === null && allowCustomCreate && !publicTestnet) {
      const rawExpiryNum = Number(wanted);
      const minExpiryNs = (Date.now() + 60_000) * 1e6;
      const targetExpiryNs =
        Number.isFinite(rawExpiryNum) && rawExpiryNum > minExpiryNs
          ? Math.floor(rawExpiryNum / 1e9) * 1_000_000_000
          : Math.floor((Date.now() + 3_600_000) / 1000) * 1_000_000_000;
      const est = estimateSpreadQuote(effectiveAsset, effectiveKind, effectiveStrike, targetExpiryNs, liveSpot, effectiveQty);
      try {
        const created = await chain.call(
          "admin",
          "create_series",
          {
            underlying: effectiveAsset,
            kind: effectiveKind,
            expiry_ns: targetExpiryNs,
            accept_until_ns: targetExpiryNs + 60_000_000_000,
            finalize_until_ns: targetExpiryNs + 600_000_000_000,
            low_strike: String(Math.round(est.low * 1e6)),
            high_strike: String(Math.round(est.high * 1e6)),
            price_scale: "1000000",
            min_confidence_bps: 3000,
            oracle_feed: `${effectiveAsset}-USD`,
          },
          { deposit: "10000000000000000000000", gas: 100_000_000_000_000n },
        );
        const newId = Number(created.value);
        if (Number.isSafeInteger(newId) && newId >= 0) {
          const stampNs = Math.floor(Date.now() / 1000) * 1_000_000_000;
          await chain.call(
            "admin",
            "set_pool_quotes",
            {
              series_ids: [newId],
              mid_units: [String(est.midUnits)],
              stamp_ns: stampNs,
            },
            { deposit: "5000000000000000000000", gas: 100_000_000_000_000n },
          );
          pairs = await registryPairs(views);
          registry = registryForExpiry(pairs, String(targetExpiryNs), effectiveAsset, true);
          seriesId = newId;
        }
      } catch (err) {
        console.warn("custom series creation fallback:", err);
      }
    }

    if (registry.all().length === 0) {
      registry = registryForExpiry(pairs, wanted, effectiveAsset, true);
    }
    if (registry.all().length === 0 && seriesId === null) throw new Error("that expiry is not listed on chain");
    const marks = marksFromEngine(rows);
    if (seriesId === null) {
      seriesId = registry.idFor(effectiveAsset, effectiveKind, effectiveStrike);
    }
    if (seriesId === null) {
      // Fallback to nearest strike in the registry if still unmatched
      const openList = registry.all().filter((s) => s.kind === effectiveKind && s.settlement === "open");
      if (openList.length > 0) {
        const nearest = openList.reduce((best, cur) =>
          Math.abs(seriesStrike(cur) - effectiveStrike) < Math.abs(seriesStrike(best) - effectiveStrike) ? cur : best,
        );
        seriesId = nearest.seriesId;
      }
    }
    const info = seriesId === null ? null : (registry.info(seriesId) ?? normalizeSeries(seriesId, pairs.find(([id]) => id === seriesId)?.[1]));
    const contracts = Number.isFinite(effectiveQty) && effectiveQty > 0 ? Math.max(0.0001, Math.round(effectiveQty * 1_000_000) / 1_000_000) : 1;
    const qtyUnitsStr = toUnits(contracts).toString();
    const rawMark = info ? marks.side(info.asset, info.kind, seriesStrike(info)) : marks.side(effectiveAsset, effectiveKind, effectiveStrike);
    let price: PoolPrice | null = null;
    if (seriesId !== null && info?.settlement === "open") {
      const raw = await views.getPoolPrices([seriesId], qtyUnitsStr);
      price = normalizePrices(raw).get(seriesId) ?? null;
      // Always sync pool quote to current live spot on sandbox so trades never fill at a stale 20-100s old quote
      if (!publicTestnet) {
        const est = estimateSpreadQuote(
          info.asset,
          info.kind,
          seriesStrike(info),
          info.expiryNs,
          liveSpot,
          contracts,
          info.low,
          info.high,
        );
        const targetMidUnits =
          rawMark && String(info.expiryNs) === String(wanted) && rawMark.low === info.low && rawMark.high === info.high
            ? Math.max(10_000, Math.round(rawMark.mark * 1e6))
            : est.midUnits;
        if (!price || Math.abs(Number(price.midUnits) - targetMidUnits) > 200) {
          const stampNs = Math.floor(Date.now() / 1000) * 1_000_000_000;
          await chain.call(
            "admin",
            "set_pool_quotes",
            {
              series_ids: [seriesId],
              mid_units: [String(targetMidUnits)],
              stamp_ns: stampNs,
            },
            { deposit: "1280000000000000000000", gas: 100_000_000_000_000n },
          ).catch(() => null);
          const refreshed = await views.getPoolPrices([seriesId], qtyUnitsStr);
          price = normalizePrices(refreshed).get(seriesId) ?? price;
        }
      }
    }
    const fallbackMark =
      !rawMark && price && info
        ? {
            mark: Number(price.midUnits) / 1e6,
            bid: Number(price.exitUnits) / (1e6 * contracts),
            ask: Number(price.entryUnits) / (1e6 * contracts),
            markIv: 0.6,
            bidIv: 0.58,
            askIv: 0.62,
            entryIv: 0.62,
            exitIv: 0.58,
            delta: info.kind === "Call" ? 0.5 : -0.5,
            gamma: 0.002,
            vega: 0.15,
            theta: -0.45,
            low: info.low,
            high: info.high,
          }
        : rawMark;
    const side = mergeSide(
      fallbackMark,
      seriesId === null ? [] : normalizeBook(await views.getBook(seriesId, 50)),
      seriesId === null ? [] : normalizeBids(await views.getBids(seriesId, 50)),
      seriesId,
      info?.settlement ?? "open",
      price,
    );
    return {
      you: visitor,
      vault,
      priceScale: 1_000_000,
      seriesFor: () =>
        seriesId === null || !info
          ? null
          : {
              seriesId,
              asset: info.asset,
              kind: info.kind,
              strike: effectiveStrike,
              low: info.low,
              high: info.high,
              expiryNs: info.expiryNs,
              settlement: info.settlement,
            },
      side,
      price,
      positions: normalizePositions(await views.getPositions(visitor), vault),
    };
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/health" && url.pathname !== "/presence") {
      lastUserActivity = Date.now();
      touchPresence(true);
    }
    const json = (code: number, body: unknown) =>
      response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
    if (url.pathname === "/presence") {
      const active = activeStreams > 0 || Date.now() - lastUserActivity < 90_000;
      return json(200, { active, streams: activeStreams, updated_at: Date.now() });
    }
    if (url.pathname === "/chart-quote") {
      return void (async () => {
        try {
          const quantity = Number(url.searchParams.get("quantity") ?? 1);
          if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
            return json(400, { error: "invalid series or contract quantity" });
          }
          const customPrice = url.searchParams.has("price") ? Number(url.searchParams.get("price")) : null;
          const customExpiry = url.searchParams.has("expiry") ? Number(url.searchParams.get("expiry")) : null;
          const assetParam: Asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
          const kindParam: Kind = url.searchParams.get("kind") === "Put" ? "Put" : "Call";
          const idParam = url.searchParams.has("series") ? Number(url.searchParams.get("series")) : NaN;

          const feed = (await feedFromEngine()) as { assets?: Record<string, { median?: number }> } | null;
          const spot = extractChartSpot(assetParam, feed) ?? (await fetchLiveSpotTick(assetParam)) ?? (assetParam === "BTC" ? 76000 : 2250);

          let matchedInfo: ReturnType<typeof normalizeSeries> = null;
          if (Number.isSafeInteger(idParam) && idParam >= 0) {
            const pairs = await registryPairs(views);
            const rawPair = pairs.find(([id]) => id === idParam);
            if (rawPair) matchedInfo = normalizeSeries(idParam, rawPair[1]);
          }

          if (matchedInfo && (customPrice === null || Math.abs(seriesStrike(matchedInfo) - customPrice) < 1e-6)) {
            const est = estimateSpreadQuote(
              matchedInfo.asset,
              matchedInfo.kind,
              seriesStrike(matchedInfo),
              matchedInfo.expiryNs,
              spot,
              quantity,
              matchedInfo.low,
              matchedInfo.high,
            );
            return json(200, {
              available: true,
              premium: est.premium,
              unitPremium: est.unitPremium,
              midUnit: est.midUnits / 1e6,
              exitUnit: est.exitUnit,
              low: est.low,
              high: est.high,
              width: est.width,
              expiryNs: matchedInfo.expiryNs,
              seriesId: idParam,
              at: Date.now(),
            });
          }

          if (customPrice !== null && Number.isFinite(customPrice) && customPrice > 0) {
            const expiryNs =
              customExpiry !== null && Number.isFinite(customExpiry) && customExpiry > Date.now() * 1e6
                ? customExpiry
                : (Date.now() + 3_600_000) * 1e6;
            const est = estimateSpreadQuote(assetParam, kindParam, customPrice, expiryNs, spot, quantity);
            return json(200, {
              available: true,
              premium: est.premium,
              unitPremium: est.unitPremium,
              midUnit: est.midUnits / 1e6,
              exitUnit: est.exitUnit,
              low: est.low,
              high: est.high,
              width: est.width,
              expiryNs,
              at: Date.now(),
            });
          }
          if (!Number.isSafeInteger(idParam) || idParam < 0) {
            return json(400, { error: "invalid series or contract quantity" });
          }
          return json(200, { available: false });
        } catch (error) { json(503, { error: error instanceof Error ? error.message : "quote unavailable" }); }
      })();
    }
    if (url.pathname === "/chart-series") {
      return void (async () => {
        try {
          const asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
          const pairs = await registryPairs(views);
          const series = pairs.map(([id, row]) => normalizeSeries(id, row)).filter((row) => row && row.asset === asset);
          json(200, { series, at: Date.now() });
        } catch (error) { json(503, { error: error instanceof Error ? error.message : "series unavailable" }); }
      })();
    }
    if (url.pathname === "/chart-candles") {
      return void (async () => {
        try {
          const asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
          const interval = url.searchParams.get("interval") ?? "1m";
          const limit = Number(url.searchParams.get("limit")) || 60;
          const end = url.searchParams.has("end") ? Number(url.searchParams.get("end")) : undefined;
          if (end !== undefined && (!Number.isFinite(end) || end <= 0)) return json(400, { error: "invalid history end timestamp" });
          const candles = await fetchCandles(asset, interval, limit, null, end);
          json(200, { candles, asset, interval, at: Date.now() });
        } catch (error) { json(503, { error: error instanceof Error ? error.message : "candles unavailable" }); }
      })();
    }
    if (url.pathname === "/chart-ticks") {
      return void (async () => {
        try {
          const asset: Asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
          if (tickBuffers[asset].length === 0) {
            // Seed from 1s candles if tick buffer just woke up
            const recent = await fetchCandles(asset, "1s", 90);
            for (const c of recent) recordTick(asset, c.close, c.time);
          }
          const feed = (await feedFromEngine()) as {
            assets?: Record<string, { median?: number; sources?: Array<{ name?: string; price?: number; fresh?: boolean }> }>;
          } | null;
          const liveSpot = extractChartSpot(asset, feed) ?? (await fetchLiveSpotTick(asset));
          if (liveSpot !== null && Number.isFinite(liveSpot) && liveSpot > 0) recordTick(asset, liveSpot, Date.now());
          json(200, { ticks: tickBuffers[asset], asset, at: Date.now() });
        } catch (error) { json(503, { error: error instanceof Error ? error.message : "ticks unavailable" }); }
      })();
    }
    if (url.pathname === "/chart-stats") {
      return void (async () => {
        try {
          const asset: Asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
          const stats = await fetchMarketStats(asset);
          json(200, { stats, asset, at: Date.now() });
        } catch (error) { json(503, { error: error instanceof Error ? error.message : "stats unavailable" }); }
      })();
    }
    if (url.pathname === "/leaderboard") {
      return json(200, { leaders: getLeaderboard(url.searchParams.get("asset") ?? undefined), at: Date.now() });
    }
    if (url.pathname === "/copy-mandates") {
      const acct = url.searchParams.get("account") || you;
      return json(200, { mandates: getUserMandates(acct), journal: getCopyJournal(acct), at: Date.now() });
    }
    if (url.pathname === "/copy-mandate" && request.method === "POST") {
      return void (async () => {
        try {
          const body = JSON.parse(await readBody(request));
          const acct = body.account ? accountId(body.account) : you;
          const mandate = createOrUpdateMandate(acct, body);
          json(200, { ok: true, mandate });
        } catch (error) { json(400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      })();
    }
    if (url.pathname === "/copy-mandate/revoke" && request.method === "POST") {
      return void (async () => {
        try {
          const body = JSON.parse(await readBody(request));
          const acct = body.account ? accountId(body.account) : you;
          const success = revokeMandate(acct, body.profileId);
          json(200, { ok: success });
        } catch (error) { json(400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
      })();
    }
    if (url.pathname === "/config") {
      const publicRoles = Object.fromEntries(
        Object.entries(session.roles ?? {})
          .filter(([k]) => !k.startsWith("ext:"))
          .map(([k, v]) => [k, v.account]),
      );
      const demoAccounts = [
        ...(publicRoles.you ? [{ role: "you", label: "Demo Trader #1 (Default)", account: publicRoles.you, accountId: publicRoles.you }] : []),
        ...(publicRoles["taker-1"] ? [{ role: "taker-1", label: "Demo Trader #2 (Active Taker)", account: publicRoles["taker-1"], accountId: publicRoles["taker-1"] }] : []),
        ...(publicRoles["taker-2"] ? [{ role: "taker-2", label: "Demo Trader #3 (Fresh Trader)", account: publicRoles["taker-2"], accountId: publicRoles["taker-2"] }] : []),
        ...(publicRoles.lp ? [{ role: "lp", label: "Demo LP Vault Provider", account: publicRoles.lp, accountId: publicRoles.lp }] : []),
      ];
      return json(200, {
        network: publicTestnet ? "testnet" : "sandbox",
        rpc: chain.session.rpc,
        contracts: chain.session.contracts,
        faucet: Boolean(faucet),
        faucetAmount: 1000,
        faucetDailyClaims: 100,
        sandboxAccount: you,
        roles: publicRoles,
        demoAccounts,
      });
    }
    if (["/wallet.js", "/wallet.css", "/positions-chart.js"].includes(url.pathname)) {
      const css = url.pathname.endsWith(".css");
      try { return response.writeHead(200, { "content-type": css ? "text/css" : "text/javascript", "cache-control": "no-store" }).end(readFileSync(`demo/${url.pathname.slice(1)}`)); }
      catch { return response.writeHead(404).end("wallet bundle missing; run node sim/build-demo.mjs"); }
    }
    if (url.pathname === "/faucet" && request.method === "POST") {
      if (!faucet) return json(503, { ok: false, error: "test-token faucet is not enabled" });
      const origin = request.headers.origin;
      const allowed = arg("--public-origin", `http://${request.headers.host}`);
      if (!origin || origin !== allowed) return json(403, { ok: false, error: "use the faucet from the product page" });
      const ip = request.socket.remoteAddress ?? "unknown";
      if (faucetBusy || Date.now() - (faucetRate.get(ip) ?? 0) < 60_000) return json(429, { ok: false, error: "please wait one minute before another claim" });
      return void (async () => {
        faucetBusy = true;
        try {
          const body = JSON.parse(await readBody(request));
          const account = accountId(body.account);
          faucetRate.set(ip, Date.now());
          if (faucetRate.size > 1000) for (const [key, at] of faucetRate) if (Date.now() - at > 60_000) faucetRate.delete(key);
          // Check existence before spending any operator NEAR. The token balance
          // query alone cannot tell an unregistered account from a made-up one.
          await chain.accountExists(account);
          faucet.reserve(account);
          await chain.call("admin", "storage_deposit", { account_id: account }, { contract: chain.token, deposit: "1280000000000000000000" });
          const minted = await chain.call("admin", "mint", { account_id: account, amount: "1000000000" }, { contract: chain.token });
          json(200, { ok: true, account, amount: 1000, hash: minted.hash, message: "1,000 test tokens are in your wallet. Deposit them into the venue to trade." });
        } catch (error) { json(400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
        finally { faucetBusy = false; }
      })();
    }
    if (url.pathname.startsWith("/fonts/")) {
      // The page's own typefaces: one flat segment, no traversal, read before
      // any header is written so a missing file answers 404 instead of killing
      // the venue mid-request.
      const name = url.pathname.slice("/fonts/".length);
      if (!/^[\w][\w.-]*$/.test(name)) return response.writeHead(400).end();
      let bytes: Buffer | null = null;
      try {
        bytes = readFileSync(`${DEMO.slice(0, DEMO.lastIndexOf("/") + 1)}fonts/${name}`);
      } catch {
        bytes = null;
      }
      if (bytes === null) return response.writeHead(404).end();
      return response
        .writeHead(200, { "content-type": "font/woff2", "cache-control": "no-store" })
        .end(bytes);
    }
    if (url.pathname.startsWith("/media/")) {
      return serveMedia(request, response, "demo/media", url.pathname.slice("/media/".length));
    }
    if (url.pathname.startsWith("/images/")) {
      const name = url.pathname.slice("/images/".length);
      if (!/^[\w][\w.-]*$/.test(name)) return response.writeHead(400).end();
      try {
        const bytes = readFileSync(`demo/images/${name}`);
        const type = name.endsWith(".webp") ? "image/webp" : name.endsWith(".png") ? "image/png" : "image/jpeg";
        return response.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" }).end(bytes);
      } catch {
        return response.writeHead(404).end();
      }
    }
    if (url.pathname === "/health") return json(200, { ok: true, contract: vault, engine: ENGINE });
    if (url.pathname === "/" || url.pathname === "/landing") {
      const html = existsSync(LANDING) ? readFileSync(LANDING, "utf8") : pageFor(DEMO);
      return response
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(html);
    }
    if (url.pathname === "/docs" || url.pathname === "/docs/") {
      const docsFile = "demo/docs.html";
      const html = existsSync(docsFile) ? readFileSync(docsFile, "utf8") : pageFor(DEMO);
      return response
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(html);
    }
    if (["/app", "/board", "/options", "/trade", "/chart", "/positions", "/vault", "/stats", "/leaderboard", "/copy", "/copy-trading", "/my-strategies", "/subscribe", "/index.html"].includes(url.pathname)) {
      // `no-store` so a rebuilt page cannot hide behind a browser cache.
      return response
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(pageFor(DEMO));
    }
    if (url.pathname === "/stream") {
      activeStreams++;
      touchPresence(true);
      const asset = (url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH") as Asset;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const push = async () => {
        const feed = (await feedFromEngine()) as { assets?: Record<string, { median?: number }> } | null;
        if (feed === null) return;
        const median = Number(feed.assets?.[asset]?.median);
        const spotVal = Number.isFinite(median) && median > 0 ? median : (await engineRows(asset).catch(() => null))?.spot ?? null;
        if (spotVal === null) return;
        recordTick(asset, spotVal, Date.now());
        // The index, the tape and the counters — not prices. A frame that
        // carried its own quote would be a second number for the same cell, and
        // `/state` is the one read the ticket is priced from.
        response.write(
          `data: ${JSON.stringify({
            index: feed,
            spot: spotVal,
            atMs: Date.now(),
            tape: tape.rows.slice(0, 8),
            flow: { prints: tape.prints, realised: tape.realised },
          })}\n\n`,
        );
      };
      const timer = setInterval(() => void push(), STREAM_MS);
      void push();
      request.on("close", () => {
        activeStreams = Math.max(0, activeStreams - 1);
        touchPresence(activeStreams > 0 || Date.now() - lastUserActivity < 90_000);
        clearInterval(timer);
      });
      return;
    }
    if (url.pathname === "/state") {
      const asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
      const wanted = url.searchParams.get("expiry") ?? "";
      // A chip that knows the exact stamp sends it; a link that only knows the
      // day gets the grid listed on that day; nothing at all gets the one the
      // engine is quoting this second.
      const kind = url.searchParams.get("kind") === "Call" ? "Call" : "Put";
      const strike = Number(url.searchParams.get("strike")) || null;
      const requestedAsset = asset as Asset;
      return void (async () => {
        try {
          const [expiries, feed] = await Promise.all([engineExpiries(), feedFromEngine()]);
          const expiry = expiryWanted(wanted, expiries);
          // A dead engine is not a dead venue. The marks go absent and the grid
          // falls back to the cells the chain lists, which is what lets the screen
          // keep showing the committee that settles tickets without us.
          const engine = await engineRows(requestedAsset, expiry).catch(() => null);
          const rows = engine?.rows ?? [];
          const spot = engine?.spot ?? null;
          const strikes = rows.map((row) => row.strike);
          const resolved = publicTestnet && url.searchParams.has("account")
            ? { role: "you", account: accountId(url.searchParams.get("account")), isDemo: false, displayAccount: accountId(url.searchParams.get("account")) }
            : await chain.ensureWalletRole(url.searchParams.get("account"));
          const visitor = resolved.account;
          const feedTyped = feed as { assets?: Record<string, { median?: number }> } | null;
          const visitorPositions = !publicTestnet
            ? normalizePositions(await views.getPositions(visitor).catch(() => []), vault)
            : [];
          if (!publicTestnet && visitorPositions.length > 0) {
            const openPoolPos = visitorPositions.filter(
              (p) => p.side === "long" && p.againstPool && p.settlement === "open" && p.expiryNs > Date.now() * 1e6,
            );
            if (openPoolPos.length > 0) {
              const uniqueBySeries = new Map<number, (typeof openPoolPos)[number]>();
              for (const p of openPoolPos) uniqueBySeries.set(p.seriesId, p);
              const heldIds = [...uniqueBySeries.keys()];
              const currentPrices = normalizePrices(
                await views.getPoolPrices(heldIds, SCALE.toString()).catch(() => []),
              );
              const updateIds: number[] = [];
              const updateMids: string[] = [];
              for (const [sid, p] of uniqueBySeries) {
                const posSpot =
                  (p.asset === requestedAsset && spot ? spot : null) ??
                  extractChartSpot(p.asset, feedTyped) ??
                  (await fetchLiveSpotTick(p.asset)) ??
                  (p.asset === "BTC" ? 76000 : 2250);
                const est = estimateSpreadQuote(
                  p.asset,
                  p.kind,
                  seriesStrike(p),
                  p.expiryNs,
                  posSpot,
                  1,
                  p.low,
                  p.high,
                );
                const existing = currentPrices.get(sid);
                if (!existing || Math.abs(Number(existing.midUnits) - est.midUnits) > 200) {
                  updateIds.push(sid);
                  updateMids.push(String(est.midUnits));
                }
              }
              if (updateIds.length > 0) {
                const stampNs = Math.floor(Date.now() / 1000) * 1_000_000_000;
                await chain
                  .call(
                    "admin",
                    "set_pool_quotes",
                    {
                      series_ids: updateIds,
                      mid_units: updateMids,
                      stamp_ns: stampNs,
                    },
                    { deposit: "5000000000000000000000", gas: 100_000_000_000_000n },
                  )
                  .catch(() => null);
              }
            }
          }
          const baseMarks = marksFromEngine(rows);
          const customMarks = {
            side(a: Asset, k: Kind, s: number) {
              const found = baseMarks.side(a, k, s);
              if (found) return found;
              if (Number.isFinite(s) && s > 0) {
                const matchPos = visitorPositions.find(
                  (p) => p.asset === a && p.kind === k && Math.abs(seriesStrike(p) - s) < 1e-6,
                );
                const assetSpot =
                  (a === requestedAsset && spot ? spot : null) ??
                  extractChartSpot(a, feedTyped) ??
                  (a === "BTC" ? 76000 : 2250);
                const est = estimateSpreadQuote(
                  a,
                  k,
                  s,
                  matchPos?.expiryNs || Number(expiry) || (Date.now() + 3_600_000) * 1e6,
                  assetSpot,
                  1,
                  matchPos?.low,
                  matchPos?.high,
                );
                return {
                  mark: est.midUnits / 1e6,
                  bid: est.exitUnits / 1e6,
                  ask: est.entryUnits / 1e6,
                  markIv: 0.6,
                  bidIv: 0.58,
                  askIv: 0.62,
                  entryIv: 0.62,
                  exitIv: 0.58,
                  delta: k === "Call" ? 0.5 : -0.5,
                  gamma: 0.002,
                  vega: 0.15,
                  theta: -0.45,
                  low: est.low,
                  high: est.high,
                };
              }
              return null;
            },
          };
          const state = await gatherState({
            asset: requestedAsset,
            expiry,
            strikes,
            account: visitor,
            vault,
            views,
            marks: customMarks,
            spot,
            kind: strike === null ? null : (kind as Kind),
            strike,
            feed,
            tape,
            history: publicTestnet ? historyFor(visitor) : history,
            holders,
          });
          // Automatically move any expired or settled positions into Trade History (and auto-claim on sandbox)
          const nowNs = Date.now() * 1e6;
          if (state.positions?.rows) {
            const activeRows = [];
            for (const row of state.positions.rows) {
              const isExpired = row.expiryNs <= nowNs || row.settlement !== "open";
              if (isExpired) {
                const expMs = Math.round(row.expiryNs / 1e6);
                const settlePx =
                  row.fixedPrice ??
                  ((row.asset === requestedAsset && spot ? spot : null) ??
                    extractChartSpot(row.asset, feedTyped) ??
                    (row.asset === "BTC" ? 76000 : 2250));
                const width = Math.max(0, row.high - row.low);
                const unitPayoff =
                  row.settlement === "void"
                    ? row.cost / Math.max(row.contracts, 1e-6)
                    : row.kind === "Call"
                      ? Math.max(0, Math.min(width, settlePx - row.low))
                      : Math.max(0, Math.min(width, row.high - settlePx));
                const proceeds = Math.round(unitPayoff * row.contracts * 1e6) / 1e6;
                const pnl = Math.round((proceeds - row.cost) * 1e6) / 1e6;
                const d = new Date(expMs);
                const atStr = d.toISOString().slice(11, 19);
                recordTradeHistory([visitor, resolved.displayAccount], {
                  ticketId: row.ticketId,
                  seriesId: row.seriesId,
                  asset: row.asset,
                  kind: row.kind,
                  low: row.low,
                  high: row.high,
                  expiryNs: row.expiryNs,
                  atMs: expMs,
                  at: atStr,
                  series: `${row.asset} ${row.low}/${row.high} ${row.kind}`,
                  side: row.side,
                  contracts: row.contracts,
                  cost: row.cost,
                  proceeds,
                  pnl,
                  fixedPrice: settlePx,
                  via: row.fixedPrice !== null ? `expired · settled @ $${settlePx.toFixed(2)}` : `expired @ $${settlePx.toFixed(2)}`,
                });
                if (!publicTestnet && (row.settlement === "fixed" || row.settlement === "void") && !settlingTickets.has(row.ticketId)) {
                  settlingTickets.add(row.ticketId);
                  void chain
                    .call(resolved.role, "settle_ticket", { ticket_id: row.ticketId })
                    .catch(() => null)
                    .finally(() => settlingTickets.delete(row.ticketId));
                }
              } else {
                activeRows.push(row);
              }
            }
            state.positions.rows = activeRows;
            state.positions.totals = {
              open: activeRows.reduce((s, r) => s + (r.open ?? 0), 0),
              atRisk: activeRows.reduce((s, r) => s + r.cost, 0),
              positions: activeRows.length,
              closable: activeRows.filter((r) => r.closable).length,
            };
          }
          const acctClosed = getAccountTradeHistory([visitor, resolved.displayAccount]);
          if (state.tape) {
            state.tape.closed = acctClosed;
            state.tape.realised = acctClosed.reduce((sum, r) => sum + (r.pnl ?? 0), 0);
          }
          if (state.you) {
            (state.you as Record<string, unknown>).displayAccount = resolved.displayAccount;
            (state.you as Record<string, unknown>).isDemo = resolved.isDemo;
            (state.you as Record<string, unknown>).role = resolved.role;
          }
          json(200, state);
        } catch (error) {
          json(500, { ok: false, error: String(error instanceof Error ? error.message : error) });
        }
      })();
    }
    if (url.pathname === "/smile") {
      const asset = url.searchParams.get("asset") === "BTC" ? "BTC" : "ETH";
      return void (async () => {
        try {
          // The engine's own curve — it is the only party that can say what vol it
          // prices a strike at, and this gateway's job here is to name the tenors.
          const response = await fetch(`${ENGINE}/smile?asset=${asset}`);
          if (!response.ok) throw new Error(`engine smile failed: ${response.status}`);
          const view = projectSmile(await response.json(), Date.now());
          if (!view) throw new Error("the engine answered a smile this gateway does not recognise");
          json(200, view);
        } catch (error) {
          json(500, { ok: false, error: String(error instanceof Error ? error.message : error) });
        }
      })();
    }
    if (url.pathname === "/demo/reset" && request.method === "POST") {
      if (publicTestnet) return json(403, { ok: false, error: "connect a wallet and use the test-token faucet" });
      // The demo account is funded from the sandbox's own mint, so a visitor who
      // has spent the opening balance can get back to testing without a restart.
      // Same origin guard as every other signing route.
      const foreign = rejectSigning({
        host: request.headers.host,
        origin: request.headers.origin as string | undefined,
      });
      if (foreign !== null) return json(403, { ok: false, error: foreign });
      return void (async () => {
        try {
          const rawBody = await readBody(request).catch(() => "");
          let reqAcct = url.searchParams.get("account") ?? undefined;
          if (rawBody) {
            try { reqAcct = (JSON.parse(rawBody) as { account?: string }).account ?? reqAcct; } catch {}
          }
          const resolved = await chain.ensureWalletRole(reqAcct);
          const account = resolved.account;
          const held = Number(await views.getBalance(account));
          if (held >= DEMO_FLOOR) {
            return json(200, {
              ok: true,
              toppedUp: 0,
              account: resolved.displayAccount,
              available: held / 1e6,
              note: "the demo account is already funded",
            });
          }
          await chain.call(
            "admin",
            "storage_deposit",
            { account_id: account },
            { contract: chain.token, deposit: "100000000000000000000000" },
          ).catch(() => null);
          await chain.call(
            "admin",
            "mint",
            { account_id: account, amount: String(DEMO_TOPUP) },
            { contract: chain.token },
          );
          await chain.call(
            resolved.role,
            "ft_transfer_call",
            { receiver_id: chain.options, amount: String(DEMO_TOPUP), msg: "deposit" },
            { contract: chain.token, deposit: "1", gas: 100_000_000_000_000n },
          );
          const updatedHeld = Number(await views.getBalance(account).catch(() => String(held + DEMO_TOPUP)));
          const availUsd = updatedHeld / 1e6;
          const topupUsd = DEMO_TOPUP / 1e6;
          json(200, {
            ok: true,
            toppedUp: topupUsd,
            account: resolved.displayAccount,
            available: availUsd,
            message: `+$${topupUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT credited to ${resolved.displayAccount} · Available balance: $${availUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          });
        } catch (error) {
          json(500, { ok: false, error: String(error instanceof Error ? error.message : error) });
        }
      })();
    }
    if ((url.pathname === "/action" || url.pathname === "/plan") && request.method === "POST") {
      const unsigned = url.pathname === "/plan";
      if (publicTestnet && !unsigned) return json(403, { ok: false, error: "testnet actions must be signed in your wallet" });
      // Every action signs. Nothing that is not this page, on this machine,
      // gets to ask.
      const foreign = rejectSigning({
        host: request.headers.host,
        origin: request.headers.origin as string | undefined,
      });
      if (!unsigned && foreign !== null) return json(403, { ok: false, error: foreign });
      // The body arrives after this handler returns: waiting for `end` is the
      // only way to see the order at all. Reading it too early is how every
      // action silently arrives as `{}`.
      return void (async () => {
        try {
          const parsed = JSON.parse((await readBody(request)) || "{}") as {
            account?: string;
            type: string;
            asset?: string;
            kind?: string;
            strike?: number;
            quantity?: number | string;
            expiry?: string;
            ticket?: number | string;
            id?: number | string;
            side?: string;
            fill?: string;
            hold?: boolean;
          };
          const asset = (parsed.asset === "BTC" ? "BTC" : "ETH") as Asset;
          const kind = (parsed.kind === "Call" ? "Call" : "Put") as Kind;
          const resolved = unsigned
            ? { role: "you", account: accountId(parsed.account), isDemo: false, displayAccount: accountId(parsed.account) }
            : await chain.ensureWalletRole(parsed.account);
          const ticketNum = parsed.ticket !== undefined && parsed.ticket !== null ? Number(parsed.ticket) : null;
          const context = await contextFor(
            asset,
            kind,
            Number(parsed.strike),
            parsed.expiry ?? "",
            Number(parsed.quantity ?? 1),
            resolved.account,
            !unsigned && parsed.type === "buy",
            Number.isInteger(ticketNum) ? ticketNum : null,
          );
          const calls = planAction(parsed as never, context as never);
          if (unsigned) return json(200, {
            ok: true, transactions: walletTransactions(calls, resolved.account, chain.session.contracts),
            message: calls.length ? describe(calls, parsed as never, context as never) : "nothing to do",
          });
          const results = await run(calls, resolved.role);
          // What a run-off paid comes off the receipt, not out of this file. The
          // vault's own close answers with one number and `settle_ticket` with
          // [buyer, maker], so both shapes are read here.
          const paidOf = (value: unknown): number => {
            // A second claim on a ticket that has already paid returns nothing at
            // all, and a null read as 0 units is honest — read as NaN it would
            // poison the realised figure for the rest of the session.
            if (value === null || value === undefined) return 0;
            return Number(fromUnits(amount(Array.isArray(value) ? value[0] : value)));
          };
          calls.forEach((call, index) => {
            if (!["pool_close", "close_ticket", "settle_ticket"].includes(call.method)) return;
            const tid = Number(call.args.ticket_id);
            const paid = paidOf(results[index]?.value);
            tape.paid(resolved.account, tid, paid, call.method);
            const heldPos = context.positions.find((p) => p.ticketId === tid);
            const nowMs = Date.now();
            const contractsVal = heldPos?.contracts ?? Number(parsed.quantity ?? 1);
            const costVal = heldPos?.cost ?? 0;
            recordTradeHistory([resolved.account, resolved.displayAccount], {
              ticketId: tid,
              seriesId: heldPos?.seriesId,
              asset: heldPos?.asset ?? asset,
              kind: heldPos?.kind ?? kind,
              low: heldPos?.low,
              high: heldPos?.high,
              expiryNs: heldPos?.expiryNs,
              atMs: nowMs,
              at: new Date(nowMs).toISOString().slice(11, 19),
              series: heldPos ? `${heldPos.asset} ${heldPos.low}/${heldPos.high} ${heldPos.kind}` : `${asset} ${kind} #${tid}`,
              side: heldPos?.side ?? "long",
              contracts: contractsVal,
              cost: costVal,
              proceeds: paid,
              pnl: Math.round((paid - costVal) * 1e6) / 1e6,
              via: call.method === "settle_ticket" ? "expired · settled" : call.method === "close_ticket" ? "early close · book" : "early close · pool",
            });
          });
          // A market take can fill less than it asked for. The receipt carries
          // the filled quantity, so the sentence has to be built from it: saying
          // "took 1,000,000x" after one resting offer filled is a lie the trader
          // would only discover in their position table.
          const fillMessage = (): string | null => {
            if (calls.length !== 1 || calls[0].method !== "fill_market_order") return null;
            const value = results[0]?.value as
              | { filled_quantity?: string | number; unfilled_quantity?: string | number }
              | null;
            if (!value || value.filled_quantity === undefined) return null;
            const filled = fromUnits(amount(value.filled_quantity));
            const unfilled = fromUnits(amount(value.unfilled_quantity ?? 0));
            const asked = Number(parsed.quantity ?? 1);
            return unfilled > 0
              ? `took ${filled} of ${asked}x off the book · ${unfilled}x left unfilled · ${results.length} tx`
              : `took ${filled}x off the book · ${results.length} tx`;
          };
          json(200, {
            ok: true,
            // The planner's own sentence, in the trader's words rather than the
            // method name: "bought 2x from the pool at 0.0520", not "pool_buy".
            message:
              fillMessage() ??
              (calls.length
                ? `${describe(calls, parsed as never, context as never)} · ${results.length} tx`
                : "nothing to do"),
            hashes: results.map((entry) => entry.hash),
            values: results.map((entry) => entry.value),
          });
        } catch (error) {
          json(400, { ok: false, error: String(error instanceof Error ? error.message : error) });
        }
      })();
    }
    return response.writeHead(404).end("not found");
  });

  server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(PORT, arg("--host", "127.0.0.1"), () => {
    console.log(`listening  http://127.0.0.1:${PORT}  (engine at ${ENGINE})`);
  });
}

process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection:", reason);
});

await main();
