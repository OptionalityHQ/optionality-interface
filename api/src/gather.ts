/**
 * Reading the chain into the shape the screen wants. Everything here is driven
 * through a `Views` interface, so the mapping is testable with a fake and the
 * real client stays a thin adapter.
 *
 * The series registry is *derived*, not stored: the contract is the only record
 * of which strikes exist and when they expire, so the gateway reads them back.
 * A side table of ids would be a second truth to keep in agreement — exactly the
 * thing this whole migration exists to remove.
 */
import {
  type Asset,
  type Kind,
  type LadderRow,
  type MarkSide,
  type PoolPrice,
  type PoolView,
  type PositionRow,
  type SeriesInfo,
  SCALE,
  Tape,
  amount,
  buildCustody,
  buildLadder,
  buildOrders,
  buildPortfolio,
  buildState,
  EMPTY_HISTORY,
  expiryChips,
  fromUnits,
  normalizeBids,
  feedFor,
  normalizeBook,
  normalizeCommittee,
  normalizePool,
  normalizePrices,
  normalizePositions,
  normalizeSeries,
  seriesDetail,
  seriesStrike,
  tickerFor,
} from "./gateway.ts";
import type { StatePayload } from "./gateway.ts";
import type { History } from "./history.ts";

export { seriesStrike } from "./gateway.ts";

/** Every read the gateway needs, as the contract exposes it. */
export interface Views {
  seriesIds(): Promise<number[]>;
  /** Several series in one round trip, as `[[id, series | null]]`. The registry
   * is derived — the contract is the only record of which strikes exist — and one
   * read per series made every screen refresh hundreds of round trips. */
  getSeriesMany(seriesIds: number[]): Promise<Array<[number, unknown]>>;
  getBooksMany?(seriesIds: number[]): Promise<Array<[number, unknown, unknown]>>;
  getBook(seriesId: number, limit: number): Promise<unknown>;
  getBids(seriesId: number, limit: number): Promise<unknown>;
  getPoolState(): Promise<unknown>;
  /** The vault's published prices, for up to 64 series at a time. A series the
   * venue has not quoted — or has quoted too long ago — is simply absent. */
  getPoolPrices(seriesIds: number[], quantityUnits: string): Promise<unknown>;
  getPositions(account: string): Promise<unknown>;
  /** The settlement committee's own view of one feed, read from the oracle — a
   * different contract from the market, and the only party that knows who signed
   * a settlement price. */
  getCommittee(feed: string): Promise<unknown>;
  getBalance(account: string): Promise<string | number | bigint>;
  getLpShares(account: string): Promise<string | number | bigint>;
  getLpValue(account: string): Promise<string | number | bigint>;
  expectedCustody(): Promise<string | number | bigint>;
  ftBalanceOf(account: string): Promise<string | number | bigint>;
  stats(): Promise<Record<string, unknown>>;
}

/** The engine's quote for one series, keyed the way the screen addresses cells. */
export interface EngineMarks {
  /** `${kind}|${strike}` → the loaded/haircut quotes and the model's spread. */
  side(asset: Asset, kind: Kind, strike: number): MarkSide | null;
}

/**
 * Which cell a series belongs to lives in `gateway.seriesStrike`, next to the
 * payload that prints it: a put is struck at its high leg and a call at its low
 * one, and two copies of that rule is how a screen and a chain drift apart.
 */

/** Expiry to a day. Nanosecond timestamps lose ~256 ns through JSON numbers,
 * which is days-resolution irrelevant and one fewer format to invent. */
export function expiryDate(expiryNs: number): string {
  return new Date(Math.round(expiryNs / 1e6)).toISOString().slice(0, 10);
}

export interface Registry {
  /** The ladder's address for a cell, or null when this market has none listed. */
  idFor(asset: Asset, kind: Kind, strike: number): number | null;
  info(seriesId: number): SeriesInfo | null;
  all(): SeriesInfo[];
}

/**
 * Registry for one expiry and one asset: the screen shows a single market at a
 * time, so the expiry and the underlying are the filter and the cell is
 * `(kind, strike)`.
 *
 * `expiry` is either a `YYYY-MM-DD` day or the nanosecond stamp the chips carry.
 * The day was enough while a venue listed one batch a day; an hourly engine puts
 * two grids on the same day, and a cell that resolves to whichever series the
 * read happened to see last is a price nobody quoted.
 *
 * A stamp matches within a millisecond, not to the digit: the contract's
 * nanoseconds cross a JSON float on the way in and lose up to 256 of them, and
 * an exact string comparison would then find no series at all. An hour separates
 * two batches, so a millisecond is nothing but slack.
 */
export function registryForExpiry(
  pairs: Array<[number, unknown]>,
  expiry: string,
  asset: Asset,
  fallback = true,
): Registry & { list: SeriesInfo[]; expiries: SeriesInfo[] } {
  const byId = new Map<number, SeriesInfo>();
  const byCell = new Map<string, number>();
  const list: SeriesInfo[] = [];
  const exact = /^\d+$/.test(expiry);
  const stamp = exact ? Number(expiry) : 0;
  const all: SeriesInfo[] = [];
  for (const [seriesId, raw] of pairs) {
    const info = normalizeSeries(seriesId, raw);
    if (info && info.asset === asset) all.push(info);
  }
  const matching = (wanted: number | string) =>
    all.filter((info) =>
      typeof wanted === "number" ? Math.abs(info.expiryNs - wanted) <= 1e6 : expiryDate(info.expiryNs) === wanted,
    );
  let chosen = matching(exact ? stamp : expiry);
  if (fallback && chosen.length === 0 && all.length > 0) {
    // The engine names the ladder it is marking and the operator lists that
    // expiry a tick later, so for a minute the chain holds no series with the
    // stamp the screen was given. An empty grid is the wrong answer to that:
    // the nearest expiry the chain does hold is the market the trader can
    // actually trade, and it is what the ladder shows until the listing lands.
    const open = all.filter((info) => info.settlement === "open");
    const candidates = open.length > 0 ? open : all;
    const nearest = candidates.reduce((best, info) =>
      Math.abs(info.expiryNs - stamp) < Math.abs(best.expiryNs - stamp) ? info : best,
    );
    chosen = matching(nearest.expiryNs);
  }
  for (const info of chosen) {
    byId.set(info.seriesId, info);
    byCell.set(`${info.kind}|${seriesStrike(info)}`, info.seriesId);
    list.push(info);
  }
  return {
    idFor: (wanted, kind, strike) =>
      wanted === asset ? (byCell.get(`${kind}|${strike}`) ?? null) : null,
    info: (seriesId) => byId.get(seriesId) ?? null,
    all: () => list,
    list,
    expiries: all,
  };
}

/** How many series one read covers: a week of ladders, newest first. The trade
 * path reads the same window, because a window that missed the nearest ladder
 * made a click on it resolve to a week out. */
export const SERIES_WINDOW = 640;

/** The listed series, newest `SERIES_WINDOW` of them, in as few calls as the
 * contract allows. Both the screen and the trade path read the registry this way
 * so neither can invent a second answer about what exists. */
export async function registryPairs(
  views: Views,
  take = SERIES_WINDOW,
): Promise<Array<[number, unknown]>> {
  const ids = (await views.seriesIds()).slice(-take);
  const pairs: Array<[number, unknown]> = [];
  for (let start = 0; start < ids.length; start += 128) {
    const batch = await views.getSeriesMany(ids.slice(start, start + 128));
    for (const [seriesId, raw] of batch) pairs.push([seriesId, raw]);
  }
  return pairs;
}

export interface GatherInput {
  asset: Asset;
  expiry: string;
  strikes: number[];
  account: string;
  vault: string;
  /** Reads from the chain. */
  views: Views;
  /** Reads from the engine. */
  marks: EngineMarks;
  spot: number | null;
  /** The cell the page has selected, for the series card. */
  kind?: Kind | null;
  strike?: number | null;
  /** The engine's own index panel, passed through as read. */
  feed?: Record<string, unknown> | null;
  /** The venue tape, advanced by what the chain holds now. */
  tape?: Tape | null;
  /** This session's samples, advanced by the same read that marks the positions. */
  history?: History | null;
  /** Accounts whose open tickets belong on the tape — the demo's roles, not a
   * bot list: the venue only ever reports what it can read back. */
  holders?: string[];
}

/** Read one snapshot of the chain and turn it into the screen's payload. */
export async function gatherState(input: GatherInput): Promise<StatePayload> {
  const pairs = await registryPairs(input.views);
  const registry = registryForExpiry(pairs, input.expiry, input.asset);
  // Cap the read: a live venue accumulates series every day, and the screen only
  // shows the ones it can price. The schedule lists seven ladders of about
  // seventy-five series, so the window has to hold all of them — newest first,
  // because that is the order the operator listed them in.

  // The engine names the grid it is marking. When it is not answering — and it
  // will be stopped in front of a reviewer at least once, to show that a ticket
  // still settles without it — the chain's own listed cells are the grid, so the
  // screen shows resting quotes, the vault's last prices and the committee rather
  // than an error. A cell with no mark already renders as an absent mark.
  const strikes =
    input.strikes.length > 0
      ? input.strikes
      : [...new Set(registry.list.map((info) => seriesStrike(info)))].sort((a, b) => a - b);

  const books: Record<number, ReturnType<typeof normalizeBook>> = {};
  const bids: Record<number, ReturnType<typeof normalizeBids>> = {};
  if (input.views.getBooksMany) {
    for (let i = 0; i < registry.list.length; i += 32) {
      const batch = await input.views.getBooksMany(registry.list.slice(i, i + 32).map((info) => info.seriesId));
      for (const [id, offers, restingBids] of batch) { books[id] = normalizeBook(offers); bids[id] = normalizeBids(restingBids); }
    }
  } else {
    for (const info of registry.list) {
      books[info.seriesId] = normalizeBook(await input.views.getBook(info.seriesId, 50));
      bids[info.seriesId] = normalizeBids(await input.views.getBids(info.seriesId, 50));
    }
  }

  const marksByCell: Record<string, MarkSide> = {};
  for (const kind of ["Put", "Call"] as const) {
    for (const strike of strikes) {
      const side = input.marks.side(input.asset, kind, strike);
      // A cell the engine cannot price stays absent: the ladder shows the chain's
      // resting quotes for it and no mark, rather than inventing a mid.
      if (side) marksByCell[`${kind}|${strike}`] = side;
    }
  }

  const pool: PoolView = normalizePool(await input.views.getPoolState());
  const holders = [...new Set([input.account, ...(input.holders ?? [])])];
  const byHolder = new Map<string, PositionRow[]>();
  for (const who of holders) byHolder.set(who, normalizePositions(await input.views.getPositions(who), input.vault));
  const positions = byHolder.get(input.account) ?? [];
  const observed: Array<{ who: string; position: PositionRow }> = [];
  for (const [who, rows] of byHolder) for (const position of rows) observed.push({ who, position });
  input.tape?.observe(observed, input.spot);

  // The vault's prices, in the integers it charges, for one contract. Read in the
  // batches the contract allows rather than one call per cell: a ladder is forty
  // cells and forty reads would be forty chances to disagree about one block.
  //
  // Held tickets are in the same read even when their series is not on screen —
  // the rail has to say what a position can actually be sold back for, and that
  // is the venue's quote for its series, whatever expiry it belongs to.
  const toPrice = [
    ...new Set([
      ...registry.list.filter((info) => info.settlement === "open").map((info) => info.seriesId),
      ...[...byHolder.values()]
        .flat()
        .filter((position) => position.side === "long" && position.settlement === "open")
        .map((position) => position.seriesId),
    ]),
  ];
  const prices: Record<number, PoolPrice> = {};
  for (let start = 0; start < toPrice.length; start += 64) {
    const batch = toPrice.slice(start, start + 64);
    const raw = await input.views.getPoolPrices(batch, SCALE.toString());
    for (const [seriesId, price] of normalizePrices(raw)) prices[seriesId] = price;
  }

  const chain: LadderRow[] = buildLadder({
    strikes,
    marks: marksByCell,
    books,
    bids,
    series: Object.fromEntries(registry.list.map((info) => [info.seriesId, info])),
    prices,
    idFor: (kind, strike) => registry.idFor(input.asset, kind, strike),
  });

  // A person's ticket can sit on an expiry the screen is not showing, so its
  // bidders are read for the held series as well as the listed ones.
  for (const rows of byHolder.values()) {
    for (const position of rows) {
      if (position.againstPool || position.side !== "long" || position.settlement !== "open") continue;
      if (bids[position.seriesId] === undefined) {
        bids[position.seriesId] = normalizeBids(await input.views.getBids(position.seriesId, 50));
      }
    }
  }

  // A ticket is marked from its own cell, not from the expiry the screen happens
  // to be looking at. What a holder can actually take is a chain number, not the
  // model's: the vault pays its own published exit for a ticket it made, and a
  // ticket a person made is worth the best resting bid. The model's haircut is a
  // number the contract has never agreed to, and offering it would be a close
  // that reverts — or a button that names a price nobody will pay.
  const marksBySeries: Record<number, { mark: number; exitValue: number | null; bid: number | null }> = {};
  for (const rows of byHolder.values()) {
    for (const position of rows) {
      const strikeVal = seriesStrike(position);
      const model =
        marksByCell[`${position.kind}|${strikeVal}`] ??
        input.marks.side(position.asset, position.kind, strikeVal);
      if (!model) continue;
      const quoted = prices[position.seriesId];
      marksBySeries[position.seriesId] = {
        mark: model.mark,
        exitValue: quoted === undefined ? null : fromUnits(amount(quoted.exitUnits)),
        bid: (bids[position.seriesId] ?? [])[0]?.unitPremium ?? null,
      };
    }
  }

  // The committee is read from the oracle rather than the market: the point of
  // the panel is that these are not the venue's numbers.
  const oracle = normalizeCommittee(await input.views.getCommittee(feedFor(input.asset)));

  const stats = await input.views.stats();
  const custody = buildCustody(
    await input.views.expectedCustody(),
    await input.views.ftBalanceOf(input.vault),
    stats,
    pool,
  );
  const orders = buildOrders(
    registry.list.map((info) => ({
      seriesId: info.seriesId,
      ticker: tickerFor(info.asset, info.kind, info.low, info.high),
      levels: books[info.seriesId] ?? [],
    })),
    registry.list.map((info) => ({
      seriesId: info.seriesId,
      ticker: tickerFor(info.asset, info.kind, info.low, info.high),
      levels: bids[info.seriesId] ?? [],
    })),
    input.vault,
  );

  const expiries = expiryChips(registry.expiries, Date.now());
  const selectedNs = registry.list[0]?.expiryNs ?? null;
  const chip =
    selectedNs === null
      ? null
      : expiries.find((entry) => BigInt(entry.ns) === BigInt(selectedNs)) ?? null;
  const selectedId =
    input.kind && input.strike !== null && input.strike !== undefined
      ? registry.idFor(input.asset, input.kind, input.strike)
      : null;
  const series = seriesDetail(
    selectedId === null ? null : registry.info(selectedId),
    selectedId === null ? [] : (books[selectedId] ?? []),
    selectedId === null ? [] : (bids[selectedId] ?? []),
    chip,
  );

  // The rail says what a ticket costs *you*, so it reads your balance off the
  // contract instead of trusting a copy kept beside it.
  const youAvailable = fromUnits(amount(await input.views.getBalance(input.account)));
  // Two different balances, and the difference between them is exactly what a
  // deposit moves: what the contract has credited you, and what the token still
  // holds for you. Showing one and asking for the other is how a screen ends up
  // reporting "insufficient token balance" above a five-million-dollar balance.
  const youWallet = fromUnits(amount(await input.views.ftBalanceOf(input.account)));
  // The seat in the vault, quoted by the contract: `get_lp_value` is the exit's
  // own arithmetic, and the test for leaving is the one the contract applies —
  // free equity has to still cover every open worst case afterwards. One read,
  // so the quoted value and the exit test cannot come from two snapshots.
  const lpValueUnits = amount(await input.views.getLpValue(input.account));
  const lp = {
    account: input.account,
    shares: fromUnits(amount(await input.views.getLpShares(input.account))),
    value: fromUnits(lpValueUnits),
    exitable: fromUnits(lpValueUnits) > 0 && fromUnits(lpValueUnits) <= pool.freeEquity,
  };

  const portfolio = buildPortfolio(positions, marksBySeries);
  // One sample per read is the honest resolution: the index and the marked
  // positions are read together, so the two lines are always of the same moment.
  input.history?.push(input.asset, {
    atMs: Date.now(),
    spot: input.spot,
    open: portfolio.rows.some((row) => row.open !== null) ? portfolio.totals.open : null,
    // The committee's state travels with the same read, so the consensus chart and
    // the price chart are of one moment rather than two polls apart.
    agreeing: oracle?.agreeingSeats ?? null,
    fix: oracle?.lastFix?.price ?? null,
  });

  return buildState({
    now: Date.now(),
    spot: input.spot,
    chain,
    positions: portfolio,
    orders,
    custody,
    pool,
    seriesCount: Number(stats.series_count ?? registry.list.length),
    openTickets: Number(stats.open_ticket_count ?? 0),
    expiries,
    series,
    feed: input.feed ?? null,
    oracle,
    history: input.history?.series(input.asset) ?? EMPTY_HISTORY,
    tape: input.tape ?? new Tape(),
    you: { account: input.account, available: youAvailable, wallet: youWallet },
    lp,
    contract: input.vault,
  });
}

/** The per-account balances the rail shows, in one pass. */
export async function balancesOf(views: Views, accounts: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const account of accounts) {
    out[account] = Number(amount(await views.getBalance(account))) / 1e6;
  }
  return out;
}
