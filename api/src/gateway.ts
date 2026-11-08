/**
 * The gateway's pure half: everything the screen renders, derived from contract
 * views and engine marks. No I/O and no pricing here on purpose — every number
 * that decides what a trade *costs* was computed in Rust (`core` in the contract,
 * `surface` in the engine). This module only converts units, normalises the
 * contract's uneven JSON, compares quotes and assembles the payload.
 *
 * That boundary is the whole reason the parity test suite could be deleted: if
 * this file ever multiplies a price by a margin, it has become the thing it is
 * supposed to be reading.
 */

import type { EngineMarks } from "./gather.ts";

/** The collateral token has six decimals; one contract is one price point. */
export const SCALE = 1_000_000n;

export type Asset = "ETH" | "BTC" | "NEAR";

export function parseAsset(value: unknown): Asset {
  const up = String(value ?? "").toUpperCase();
  if (up === "BTC") return "BTC";
  if (up === "NEAR") return "NEAR";
  return "ETH";
}
export type Kind = "Put" | "Call";
export type Side = "long" | "short";
/** The four states a series can be in. `get_positions` spells the last one as a
 * Rust Debug string, `get_series` as a JSON object; both land here. */
export type Settlement = "open" | "pending" | "fixed" | "void";

/** One read's index and open PnL, as the gateway recorded them. */
export interface HistoryPoint {
  atMs: number;
  spot: number | null;
  open: number | null;
  agreeing: number | null;
  fix: number | null;
}

/** What the session chart draws, and how to describe it honestly. */
export interface SessionHistory {
  points: HistoryPoint[];
  spanS: number;
  sampledEveryS: number;
}

export const EMPTY_HISTORY: SessionHistory = { points: [], spanS: 0, sampledEveryS: 1 };

/**
 * Amounts leave the contract as `U128` wrappers (JSON strings) or as raw `u128`
 * (JSON numbers) depending on which struct they sit in, and a `number` above
 * 2^53−1 is silently wrong. Everything crosses into `bigint` at this one seam.
 */
export function amount(value: unknown): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`amount ${value} is beyond float precision`);
    }
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new RangeError(`amount "${value}" is not an integer`);
  return BigInt(value);
}

/**
 * Integer token units from a screen-facing number. Rounded to the nearest atom,
 * because a price a human typed means the atom it looks like: `0.156` is 156000,
 * not the 156001 that `Math.ceil(0.156 * 1e6)` returns off a float artifact. The
 * contract still rounds its own way — collateral up, payout down — in integers.
 */
export function toUnits(tokens: number): bigint {
  const scaled = tokens * Number(SCALE);
  if (!Number.isFinite(scaled)) throw new RangeError(`tokens ${tokens} is not a price`);
  return BigInt(Math.round(scaled));
}

/** Token units to the number the ladder prints. */
export function fromUnits(units: bigint): number {
  return Number(units) / Number(SCALE);
}

export function stepFor(asset: Asset): number {
  return asset === "BTC" ? 1_000 : asset === "NEAR" ? 0.25 : 25;
}

/** A spread is four ladder steps wide, the same shape every maker quotes. */
export function widthFor(asset: Asset): number {
  return 4 * stepFor(asset);
}

/**
 * Which two strikes a cell on the ladder means. A put is struck *at* the cell
 * and bought below it; a call is struck at the cell and bought above it.
 */
export function legsFor(kind: Kind, strike: number, asset: Asset): { low: number; high: number } {
  const width = widthFor(asset);
  return kind === "Put" ? { low: strike - width, high: strike } : { low: strike, high: strike + width };
}

/** The screen's address for a series; the contract's is `series_id`. */
export function seriesKey(asset: Asset, expiryIso: string, kind: Kind, strike: number): string {
  return `${asset}|${expiryIso.slice(0, 10)}|${kind}|${strike}`;
}

/** Only abbreviate where the thousands digit is not load bearing. ETH strikes
 * sit 25 apart, so a 1k abbreviation prints 2375/2475 and 2400/2500 as the same
 * instrument — which is the reason the daemon moved this threshold once already.
 */
export function kfmt(value: number): string {
  return value >= 100_000 ? `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k` : `${value}`;
}

/** `ETH C2375/2475`, `BTC C100k/104k` — the label the tape and the ticket show. */
export function tickerFor(asset: Asset, kind: Kind, low: number, high: number): string {
  return `${asset} ${kind === "Put" ? "P" : "C"}${kfmt(low)}/${kfmt(high)}`;
}

export function settlementOf(value: unknown): Settlement {
  if (typeof value === "string") {
    if (value.startsWith("Fixed")) return "fixed";
    if (value === "Void") return "void";
    if (value === "Pending") return "pending";
    return "open";
  }
  if (value && typeof value === "object" && "Fixed" in value) return "fixed";
  if (value === "Void") return "void";
  return "open";
}

/** The print a series fixed on, in screen units, or null until it has. Read from
 * the contract's own `{Fixed: {price, …}}`, never recomputed. */
export function fixedPriceOf(value: unknown): number | null {
  if (value && typeof value === "object" && "Fixed" in value) {
    const inner = (value as RawRecord).Fixed as RawRecord | null;
    return inner && inner.price !== undefined && inner.price !== null ? fromUnits(amount(inner.price)) : null;
  }
  if (typeof value === "string" && value.startsWith("Fixed")) {
    const price = /price:\s*(\d+)/.exec(value)?.[1];
    return price === undefined ? null : fromUnits(BigInt(price));
  }
  return null;
}

// ---------- contract views ----------

/** One resting offer, as `get_book` returns it. */
export interface BookLevel {
  offerId: number;
  maker: string;
  quantity: number;
  unitPremium: number;
  premium: number;
  expiresNs: number;
  taker: string | null;
}

export interface BidLevel {
  bidId: number;
  owner: string;
  quantity: number;
  unitPremium: number;
  premium: number;
  expiresNs: number;
}

/** `get_pool_state`, in screen units. `venueLocked` is the margin a void can
 * still call for, `venue` is the margin the venue may take today. */
export interface PoolView {
  equity: number;
  reserved: number;
  venueLocked: number;
  venue: number;
  consolation: number;
  shares: number;
  freeEquity: number;
  utilisationBps: number;
  openTickets: number;
  venueAccount: string;
  marginBps: number;
  impactBps: number;
}

export interface PositionRow {
  ticketId: number;
  seriesId: number;
  side: Side;
  series: string;
  asset: Asset;
  kind: Kind;
  contracts: number;
  cost: number;
  premium: number;
  maxPayout: number;
  low: number;
  high: number;
  expiryNs: number;
  settlement: Settlement;
  fixedPrice: number | null;
  /** Which seats signed the price a finished ticket paid out on. */
  settleSources: string[];
  againstPool: boolean;
  /** Held to expiry: no fee was charged and the ticket cannot be closed. */
  held: boolean;
}

export interface SeriesInfo {
  seriesId: number;
  asset: Asset;
  kind: Kind;
  low: number;
  high: number;
  expiryNs: number;
  settlement: Settlement;
  /** The print the series fixed on, once it has. */
  fixedPrice: number | null;
  minConfidenceBps: number;
}

// ---------- the settlement committee ----------

/** One seat's last answer, as the oracle holds it. */
export interface OracleSeat {
  source: string;
  /** Dollars. Null when this seat has never spoken about the feed. */
  price: number | null;
  /** Seconds since the oracle last accepted a price from this seat, measured on
   * the chain's own clock rather than the reader's. */
  ageS: number;
  fresh: boolean;
  confidenceBps: number;
}

export interface OracleFix {
  price: number;
  timeNs: number;
  dispersionBps: number;
  confidenceBps: number;
  sources: string[];
}

/**
 * Who is allowed to settle a ticket, and what they said.
 *
 * The screen shows this because the claim is a public one: a settlement needs a
 * quorum of independently signed prices, and the venue's own index is one seat at
 * that table rather than the referee. `disagreementBps` is the honest version of
 * "how far was our number from the one that paid out".
 */
export interface OracleView {
  feed: string;
  quorum: number;
  toleranceBps: number;
  seats: OracleSeat[];
  freshSeats: number;
  agreeingSeats: number;
  canFix: boolean;
  lastFix: OracleFix | null;
  disagreementBps: number | null;
}

export function normalizeCommittee(raw: unknown): OracleView | null {
  const committee = raw as RawRecord | null;
  if (!committee || typeof committee !== "object") return null;
  const seats = rows(committee.seats).map((seat) => ({
    source: String(seat.source),
    price: seat.price === null || seat.price === undefined ? null : fromUnits(amount(seat.price)),
    // Nanoseconds do not fit a float and are not meant to: `amount` refuses them,
    // so the stamps come over as numbers and keep the same ~256 ns of slack the
    // series' own `expiryNs` already has.
    ageS: Number(seat.age_ns) / 1e9,
    fresh: seat.fresh === true,
    confidenceBps: Number(amount(seat.confidence_bps)),
  }));
  const fix = committee.last_fix as RawRecord | null | undefined;
  const lastFix: OracleFix | null =
    fix === null || fix === undefined
      ? null
      : {
          price: fromUnits(amount(fix.price)),
          timeNs: Number(fix.publish_time_ns),
          dispersionBps: Number(amount(fix.dispersion_bps)),
          confidenceBps: Number(amount(fix.confidence_bps)),
          sources: Array.isArray(fix.sources) ? fix.sources.map(String) : [],
        };
  const ours = seats.find((seat) => seat.source === "venue-index");
  return {
    feed: String(committee.feed_id ?? ""),
    quorum: Number(amount(committee.quorum)),
    toleranceBps: Number(amount(committee.tolerance_bps)),
    seats,
    freshSeats: Number(amount(committee.fresh_sources)),
    agreeingSeats: Number(amount(committee.agreeing_sources)),
    canFix: committee.can_fix === true,
    lastFix,
    // Only when both exist. The venue's index and the committee's fix are two
    // different numbers, and a screen that quietly substituted one for the other
    // is how a trader stops believing either.
    disagreementBps:
      ours?.price === null || ours?.price === undefined || !lastFix || lastFix.price <= 0
        ? null
        : Math.round((Math.abs(ours.price - lastFix.price) / lastFix.price) * 10_000),
  };
}

/** The feed a settlement price is read from for an asset. */
export function feedFor(asset: Asset): string {
  return `${asset}-USD`;
}

interface RawRecord {
  [key: string]: unknown;
}

function rows(value: unknown): RawRecord[] {
  return Array.isArray(value) ? (value as RawRecord[]) : [];
}

export function normalizeBook(raw: unknown): BookLevel[] {
  return rows(raw).map((entry) => ({
    offerId: Number(entry.offer_id),
    maker: String(entry.maker),
    quantity: fromUnits(amount(entry.quantity)),
    unitPremium: fromUnits(amount(entry.unit_premium)),
    premium: fromUnits(amount(entry.premium)),
    expiresNs: Number(entry.expires_ns),
    taker: entry.taker === null || entry.taker === undefined ? null : String(entry.taker),
  }));
}

export function normalizeBids(raw: unknown): BidLevel[] {
  return rows(raw).map((entry) => ({
    bidId: Number(entry.bid_id),
    owner: String(entry.owner),
    quantity: fromUnits(amount(entry.quantity)),
    unitPremium: fromUnits(amount(entry.unit_premium)),
    premium: fromUnits(amount(entry.premium)),
    expiresNs: Number(entry.expires_ns),
  }));
}

export function normalizePool(raw: unknown): PoolView {
  const entry = (raw ?? {}) as RawRecord;
  return {
    equity: fromUnits(amount(entry.equity)),
    reserved: fromUnits(amount(entry.reserved)),
    venueLocked: fromUnits(amount(entry.venue_locked)),
    venue: fromUnits(amount(entry.venue)),
    consolation: fromUnits(amount(entry.consolation)),
    shares: fromUnits(amount(entry.shares)),
    freeEquity: fromUnits(amount(entry.free_equity)),
    utilisationBps: Number(amount(entry.utilisation_bps)),
    openTickets: Number(entry.open_tickets ?? 0),
    venueAccount: String(entry.venue_account ?? ""),
    marginBps: Number(entry.margin_bps ?? 0),
    impactBps: Number(entry.impact_bps ?? 0),
  };
}

export function normalizeSeries(seriesId: number, raw: unknown): SeriesInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as RawRecord;
  // `Series` stores raw u128 strikes, so these arrive as JSON numbers rather
  // than the strings the U128-wrapped views use.
  const low = fromUnits(amount(entry.low_strike));
  const high = fromUnits(amount(entry.high_strike));
  return {
    seriesId,
    asset: parseAsset(entry.underlying),
    kind: String(entry.kind) === "Call" ? "Call" : "Put",
    low,
    high,
    expiryNs: Number(entry.expiry_ns),
    settlement: settlementOf(entry.settlement),
    fixedPrice: fixedPriceOf(entry.settlement),
    minConfidenceBps: Number(entry.min_confidence_bps ?? 0),
  };
}

/**
 * The vault's own price for one series, as `get_pool_prices` answered it. The
 * integers are what `pool_buy` will charge and `pool_close` will pay, so a
 * ladder that showed anything else would be quoting a trade the contract does
 * not make — the engine's float marks the market, this marks the ticket.
 */
export interface PoolPrice {
  seriesId: number;
  midUnits: string;
  entryUnits: string;
  exitUnits: string;
  stampNs: number;
  ageNs: number;
}

/** `get_pool_prices` answers with the series it can price and drops the rest,
 * so a missing key is the venue saying it has no live quote here. A row whose
 * mid is zero is read the same way: it is not a price of 0.00, it is no price,
 * and trading on it would be trading on nothing. */
export function normalizePrices(raw: unknown): Map<number, PoolPrice> {
  const out = new Map<number, PoolPrice>();
  for (const entry of rows(raw)) {
    const seriesId = Number(entry.series_id);
    const midUnits = amount(entry.mid_units);
    const entryUnits = amount(entry.entry_units);
    if (!Number.isInteger(seriesId) || midUnits <= 0n || entryUnits <= 0n) continue;
    out.set(seriesId, {
      seriesId,
      midUnits: midUnits.toString(),
      entryUnits: entryUnits.toString(),
      exitUnits: amount(entry.exit_units).toString(),
      stampNs: Number(entry.stamp_ns ?? 0),
      ageNs: Number(entry.age_ns ?? 0),
    });
  }
  return out;
}

export function normalizePositions(raw: unknown, vaultAccount: string): PositionRow[] {  return rows(raw)
    .filter((entry) => entry.side === "long" || entry.side === "short")
    .map((entry) => {
      const low = fromUnits(amount(entry.low_strike));
      const high = fromUnits(amount(entry.high_strike));
      const asset = parseAsset(entry.underlying);
      const kind = String(entry.kind) === "Call" ? "Call" : "Put";
      return {
        ticketId: Number(entry.ticket_id),
        seriesId: Number(entry.series_id),
        side: entry.side as Side,
        series: tickerFor(asset, kind, low, high),
        asset,
        kind,
        contracts: fromUnits(amount(entry.quantity)),
        cost: fromUnits(amount(entry.cost)),
        premium: fromUnits(amount(entry.premium)),
        maxPayout: fromUnits(amount(entry.collateral)),
        low,
        high,
        expiryNs: Number(entry.expiry_ns),
        settlement: settlementOf(entry.settlement),
        fixedPrice: entry.fixed_price === null ? null : fromUnits(amount(entry.fixed_price)),
        settleSources: Array.isArray(entry.settle_sources) ? entry.settle_sources.map(String) : [],
        // The contract itself is the maker of a vault ticket; no account can be
        // its own predecessor, so this identity cannot be forged by a user.
        againstPool: String(entry.maker ?? "") === vaultAccount,
        held: entry.held === true,
      };
    });
}

// ---------- the ladder ----------

/**
 * What the engine says a series is worth. These are model numbers: the mark, and
 * the spread the engine would show a maker. The vault's own two-sided price is
 * not here — it comes from `PoolPrice`, because the contract is what decides
 * whether a trade happens and at what integer.
 */
export interface MarkSide {
  mark: number;
  bid: number;
  ask: number;
  markIv: number | null;
  bidIv: number | null;
  askIv: number | null;
  /** The vol at the vault's own entry, which is the price its ask column shows. */
  entryIv: number | null;
  /** The vol at the vault's exit, which is what a close pays. */
  exitIv: number | null;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  /** The two legs, so the payoff diagram never has to invent a width. */
  low: number;
  high: number;
}

export interface LadderSide {
  mark: number;
  bid: number;
  ask: number;
  bidIv: number | null;
  askIv: number | null;
  markIv: number | null;
  entryIv: number | null;
  exitIv: number | null;
  delta: number;
  /** Straight from the engine's model — the screen shows them, so they travel
   * with the quote rather than being re-derived in the browser. */
  gamma: number;
  vega: number;
  theta: number;
  bidSize: number;
  askSize: number;
  bidCount: number;
  askCount: number;
  bestBidId: number | null;
  bestOfferId: number | null;
  poolAsk: number | null;
  poolBid: number | null;
  /** The mid the vault published, before its margin — the price a held ticket
   * pays. Null when the venue has no live quote. */
  poolMid: number | null;
  /** How old the venue's standing quote was when the contract answered, in
   * seconds. The vault trades at the price it published, so on a moving index
   * that price is a moment old by the time a click lands — the screen says how
   * long a moment rather than letting the trader find it in the fill. */
  poolQuoteAgeS: number | null;
  /** The ask a taker would actually pay, and who would take it: the book if it
   * beats the vault, the vault otherwise. A comparison, not a calculation. */
  takeAsk: number | null;
  takeAskFrom: "book" | "pool" | null;
  seriesId: number | null;
  settlement: Settlement;
  low: number;
  high: number;
}

export interface LadderRow {
  strike: number;
  put: LadderSide | null;
  call: LadderSide | null;
}

/**
 * One cell: the engine's marks, the chain's resting liquidity, and the vault's
 * own published price for it.
 *
 * `pool` is `get_pool_prices` for this series, or null when the venue has no
 * live quote — and then the vault is simply not a counterparty here.
 */
export function mergeSide(
  mark: MarkSide | null,
  book: BookLevel[],
  bids: BidLevel[],
  seriesId: number | null,
  settlement: Settlement,
  pool: PoolPrice | null = null,
): LadderSide | null {
  if (!mark && book.length === 0 && bids.length === 0) return null;
  const bestOffer = book[0] ?? null;
  const bestBid = bids[0] ?? null;
  const base = mark ?? {
    // With no model there is nothing but what people committed: the resting
    // quotes are the mark, and the side nobody is quoting is simply absent.
    mark: bestOffer?.unitPremium ?? bestBid?.unitPremium ?? 0,
    bid: bestBid?.unitPremium ?? 0,
    ask: bestOffer?.unitPremium ?? 0,
    markIv: null,
    bidIv: null,
    askIv: null,
    entryIv: null,
    exitIv: null,
    delta: 0,
    gamma: 0,
    vega: 0,
    theta: 0,
    low: 0,
    high: 0,
  };
  // The vault's two-sided price is the contract's own integers when it has a
  // live quote, and nothing at all when it has not. An engine mark is not a
  // tradeable price any more: `pool_buy` answers only to the mid the venue
  // published, so a cell whose quote is missing or expired is a cell the vault
  // is not selling — which the screen has to say rather than round off to zero.
  const poolAsk = pool ? fromUnits(amount(pool.entryUnits)) : null;
  const poolBid = pool ? fromUnits(amount(pool.exitUnits)) : null;
  const poolMid = pool ? fromUnits(amount(pool.midUnits)) : null;
  // What a buyer is charged: a person's offer if one is resting, otherwise the
  // vault's published price. The model's spread is only a chart line, and a
  // ladder that shows it as the ask shows a number the click will not fill at —
  // between two polls the index moves and the trader reads that as a broken venue.
  // A person's offer, or the vault's published price — and nothing else. The
  // model's ask used to be the last fallback, which meant the column advertised a
  // price that `pool_buy` refuses ("the venue is not selling it") and the trader
  // read the refusal as a broken venue. No quote is a dash, not a model number.
  const ask = bestOffer ? bestOffer.unitPremium : (poolAsk ?? 0);
  // The bid stays the book's or the model's: the vault pays its exit to a holder
  // closing a ticket, which is not a bid a seller can write into. The rail shows
  // that number where it belongs, beside the button that uses it.
  const bid = bestBid ? bestBid.unitPremium : base.bid;
  const candidates: Array<{ price: number; from: "book" | "pool" }> = [];
  if (bestOffer) candidates.push({ price: bestOffer.unitPremium, from: "book" });
  if (poolAsk !== null) candidates.push({ price: poolAsk, from: "pool" });
  const takeAsk = candidates.length
    ? candidates.reduce((cheapest, next) => (next.price < cheapest.price ? next : cheapest))
    : null;
  return {
    mark: base.mark,
    bid,
    ask,
    // The IV columns name the price in the same row. A person's offer or bid is
    // their own number and no model explains it, so the column says "—" rather
    // than describing some other price; the vault's ask is its *entry*, so that
    // is the vol the ask column carries.
    bidIv: bestBid ? null : base.bidIv,
    askIv: bestOffer ? null : base.entryIv,
    markIv: base.markIv,
    entryIv: base.entryIv,
    exitIv: base.exitIv,
    delta: base.delta,
    gamma: base.gamma,
    vega: base.vega,
    theta: base.theta,
    bidSize: bestBid ? bestBid.quantity : 0,
    askSize: bestOffer ? bestOffer.quantity : 0,
    bidCount: bids.length,
    askCount: book.length,
    bestBidId: bestBid ? bestBid.bidId : null,
    bestOfferId: bestOffer ? bestOffer.offerId : null,
    poolAsk,
    poolBid,
    poolMid,
    poolQuoteAgeS: pool ? pool.ageNs / 1e9 : null,
    takeAsk: takeAsk ? takeAsk.price : null,
    takeAskFrom: takeAsk ? takeAsk.from : null,
    seriesId,
    settlement,
    low: base.low,
    high: base.high,
  };
}

/** The screen's `state.chain`: one row per strike, both sides. */
export function buildLadder(input: {
  strikes: number[];
  marks: Partial<Record<string, MarkSide>>;
  books: Partial<Record<number, BookLevel[]>>;
  bids: Partial<Record<number, BidLevel[]>>;
  series: Partial<Record<number, SeriesInfo | null>>;
  /** The vault's published price per series, from `get_pool_prices`. A series
   * that is not in here has no live quote, and the vault is not its maker. */
  prices: Partial<Record<number, PoolPrice>>;
  idFor: (kind: Kind, strike: number) => number | null;
}): LadderRow[] {
  const sideOf = (kind: Kind, strike: number): LadderSide | null => {
    const seriesId = input.idFor(kind, strike);
    const info = seriesId === null ? undefined : input.series[seriesId];
    return mergeSide(
      input.marks[`${kind}|${strike}`] ?? null,
      seriesId === null ? [] : (input.books[seriesId] ?? []),
      seriesId === null ? [] : (input.bids[seriesId] ?? []),
      seriesId,
      info?.settlement ?? "open",
      seriesId === null ? null : (input.prices[seriesId] ?? null),
    );
  };
  return input.strikes.map((strike) => ({
    strike,
    put: sideOf("Put", strike),
    call: sideOf("Call", strike),
  }));
}

// ---------- the rest of the payload ----------

export interface OrderRow {
  /** The offer or bid id on its own book, for `cancel_offer`/`cancel_bid`. */
  id: number;
  series: string;
  seriesId: number;
  side: "buy" | "sell";
  who: string;
  size: number;
  price: number;
  expiresNs: number;
  againstPool: boolean;
}

/** Everything resting on-chain, newest series first within each price level. */
export function buildOrders(
  books: Array<{ seriesId: number; ticker: string; levels: BookLevel[] }>,
  bids: Array<{ seriesId: number; ticker: string; levels: BidLevel[] }>,
  vaultAccount: string,
): OrderRow[] {
  const rows: OrderRow[] = [];
  for (const entry of books) {
    for (const level of entry.levels) {
      rows.push({
        id: level.offerId,
        series: entry.ticker,
        seriesId: entry.seriesId,
        side: "sell",
        who: level.maker === vaultAccount ? "the pool" : level.maker,
        size: level.quantity,
        price: level.unitPremium,
        expiresNs: level.expiresNs,
        againstPool: level.maker === vaultAccount,
      });
    }
  }
  for (const entry of bids) {
    for (const level of entry.levels) {
      rows.push({
        id: level.bidId,
        series: entry.ticker,
        seriesId: entry.seriesId,
        side: "buy",
        who: level.owner === vaultAccount ? "the pool" : level.owner,
        size: level.quantity,
        price: level.unitPremium,
        expiresNs: level.expiresNs,
        againstPool: level.owner === vaultAccount,
      });
    }
  }
  return rows.sort((a, b) => b.price - a.price);
}

export interface PortfolioRow {
  ticketId: number;
  series: string;
  side: Side;
  contracts: number;
  cost: number;
  mark: number | null;
  /** What closing one contract pays now: the vault's exit for its own ticket, the best bid for a person's. */
  exitUnit: number | null;
  /** What a close pays now, minus cost, over the whole position. Null when nothing prices it. */
  open: number | null;
  expiry: string;
  /** The same instant in nanoseconds, so a caller can wait it out or sort by it. */
  expiryNs: number;
  /** `asset|expiry|kind|strike`, the address the close button posts back. */
  seriesKey: string;
  maxPayout: number;
  againstPool: boolean;
  settlement: Settlement;
  /** The print the series settled at, and the seats behind it. */
  fixedPrice: number | null;
  settleSources: string[];
  closable: boolean;
  closeBlock: string | null;
}

export interface PortfolioTotals {
  open: number;
  atRisk: number;
  positions: number;
  closable: number;
}

export interface PortfolioView {
  rows: PortfolioRow[];
  totals: PortfolioTotals;
}

/**
 * The position table. A realisable price is required to show a PnL at all:
 * without one the row states the facts (cost, worst case) and leaves the number
 * blank rather than inventing a zero the trader would read as a flat position.
 */
export function buildPortfolio(
  positions: PositionRow[],
  marks: Partial<Record<number, { mark: number; exitValue: number | null; bid: number | null }>>,
  nowMs = Date.now(),
): PortfolioView {
  const rows = positions.map((position) => {
    const quote = marks[position.seriesId];
    const live = position.side === "long" && position.settlement === "open";
    const mark = live && quote ? quote.mark : null;
    // What a close pays, per contract, out of the chain's own numbers: the vault
    // buys its own ticket back at the exit of the mid it published, and a ticket
    // a person made is worth the best resting bid. Marking either with the
    // model's mid showed +$0.0168 unrealised on a ticket the next click sold
    // back for −$0.0081, and a button naming a price nobody has to pay.
    // A held ticket has no exit at all, so it has no exit price and no PnL: the
    // number would be one the holder cannot take, which is the whole reason the
    // entry was free.
    const exitUnit = !live || position.held
      ? null
      : position.againstPool
        ? (quote?.exitValue ?? null)
        : (quote?.bid ?? null);
    const expiry = expiryLabel(position.expiryNs, nowMs);
    const closeBlock =
      position.held
        ? "held to expiry · no early close"
        : position.side !== "long"
        ? "a short waits for the print"
        : position.settlement !== "open"
          ? `series ${position.settlement}`
          : mark === null
            ? "no mark yet"
            : // A vault ticket is only sellable while the venue is quoting it:
              // `pool_close` answers to the published mid, so offering the button
              // without one is offering a reverted transaction. A person's ticket
              // needs a bidder for the same reason.
              position.againstPool
              ? exitUnit === null || exitUnit === 0
                ? "the venue has no price to buy it back at"
                : null
              : exitUnit === null
                ? "no bidder has priced this ticket"
                : null;
    return {
      ticketId: position.ticketId,
      series: position.series,
      side: position.side,
      contracts: position.contracts,
      cost: position.cost,
      mark,
      exitUnit,
      // The unit price is one contract's and the cost is the whole ticket's, so
      // the subtraction has to be made at the ticket's size. Mixing them was a
      // −$90 "open" on a −$5 position.
      open: exitUnit === null ? null : exitUnit * position.contracts - position.cost,
      expiry,
      expiryNs: position.expiryNs,
      asset: position.asset,
      kind: position.kind,
      low: position.low,
      high: position.high,
      seriesId: position.seriesId,
      seriesKey: `${position.asset}|${expiry}|${position.kind}|${seriesStrike(position)}`,
      maxPayout: position.maxPayout,
      againstPool: position.againstPool,
      settlement: position.settlement,
      fixedPrice: position.fixedPrice,
      settleSources: position.settleSources,
      held: position.held,
      closable: closeBlock === null,
      closeBlock,
    };
  });
  return {
    rows,
    totals: {
      open: rows.reduce((sum, row) => sum + (row.open ?? 0), 0),
      // A long spread cannot lose more than it cost: the ticket is bounded by
      // its own width and the vault stands behind the rest.
      atRisk: rows.reduce((sum, row) => sum + row.cost, 0),
      positions: rows.length,
      closable: rows.filter((row) => row.closable).length,
    },
  };
}

/** The expiry the way a chip shows it: a clock within a day, a date beyond it. */
export function expiryLabel(expiryNs: number, nowMs: number): string {
  const date = new Date(Math.round(expiryNs / 1e6));
  const clock = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  const hours = expiryNs / 1e9 / 3600 - nowMs / 3_600_000;
  return hours <= 24 ? `${clock} UTC` : `${date.toISOString().slice(8, 10)} ${MONTHS[date.getUTCMonth()]} ${clock}`;
}

export interface Custody {
  expected: number;
  held: number;
  conserved: boolean;
  buckets: { name: string; tokens: number }[];
}

/**
 * The reconciliation the whole design rests on: what the contract says it holds
 * against what the token says it holds. `conserved` is the only claim this file
 * makes about money, and it is a comparison of two numbers the chain produced.
 */
export function buildCustody(
  expected: string | number | bigint,
  held: string | number | bigint,
  stats: RawRecord,
  pool: PoolView,
): Custody {
  const expectedUnits = amount(expected);
  const heldUnits = amount(held);
  return {
    expected: fromUnits(expectedUnits),
    held: fromUnits(heldUnits),
    conserved: expectedUnits === heldUnits,
    buckets: [
      { name: "available", tokens: fromUnits(amount(stats.total_available)) },
      { name: "offer collateral", tokens: fromUnits(amount(stats.total_offer_collateral)) },
      { name: "bid escrow", tokens: fromUnits(amount(stats.total_bid_escrow)) },
      { name: "ticket collateral", tokens: fromUnits(amount(stats.total_ticket_collateral)) },
      { name: "ticket premium", tokens: fromUnits(amount(stats.total_ticket_premium)) },
      { name: "pending withdrawals", tokens: fromUnits(amount(stats.total_pending_withdrawals)) },
      { name: "pool equity", tokens: pool.equity },
      { name: "margin locked", tokens: pool.venueLocked },
      { name: "margin earned", tokens: pool.venue },
      { name: "consolation", tokens: pool.consolation },
    ],
  };
}

// ---------- the strip, the detail, the tape ----------

export interface ExpiryChip {
  /** The exact nanosecond the chain stored, as text so a round trip through the
   * page cannot lose the last digits a float would drop. */
  ns: string;
  iso: string;
  label: string;
  dte: number;
}

/**
 * The expiry strip, derived from the series the chain has rather than from a
 * calendar kept beside it. Two batches on the same UTC day are two chips: the
 * engine lists a new one every hour, and a day-wide key would silently merge
 * their grids into one registry.
 */
export function expiryChips(infos: SeriesInfo[], nowMs: number): ExpiryChip[] {
  // A ladder past its expiry is not a market any more: its series still sit on
  // chain until they settle or void, but a chip for them opens a grid with no
  // venue behind it — and, being the oldest, it was also the one the page
  // defaulted to. The whole list comes back only when every ladder is past, so a
  // stopped venue still renders one.
  const live = infos.filter((info) => info.expiryNs > nowMs * 1e6);
  const stamps: number[] = [];
  for (const info of live.length > 0 ? live : infos) {
    if (!stamps.includes(info.expiryNs)) stamps.push(info.expiryNs);
  }
  return stamps
    .sort((a, b) => a - b)
    .map((expiryNs) => {
      const date = new Date(Math.round(expiryNs / 1e6));
      return {
        ns: String(BigInt(expiryNs)),
        iso: date.toISOString(),
        label: expiryLabel(expiryNs, nowMs),
        // Whole days elapsed-to-expiry, floored: an expiry five hours out is
        // today, not "1d", which is what rounding up used to print.
        dte: Math.max(0, Math.floor((date.getTime() - nowMs) / 86_400_000)),
      };
    });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface QuoteRow {
  who: string;
  quantity: number;
  premium: number;
  price: number;
}

const quoteRows = (levels: Array<{ maker?: string; owner?: string; quantity: number; premium: number; unitPremium: number }>): QuoteRow[] =>
  levels.map((level) => ({
    who: String(level.maker ?? level.owner ?? ""),
    quantity: level.quantity,
    premium: level.premium,
    price: level.unitPremium,
  }));

export interface SeriesDetail {
  seriesId: number;
  asset: Asset;
  kind: Kind;
  strike: number;
  low: number;
  high: number;
  expiry: string | null;
  expiryIso: string | null;
  settlement: Settlement;
  settledPrice: number | null;
  minConfidenceBps: number;
  offers: QuoteRow[];
  bids: QuoteRow[];
}

/** The right-hand panel's series card: what the chain says this cell is. */
export function seriesDetail(
  info: SeriesInfo | null,
  offers: BookLevel[],
  bids: BidLevel[],
  expiry: ExpiryChip | null,
): SeriesDetail | null {
  if (!info) return null;
  return {
    seriesId: info.seriesId,
    asset: info.asset,
    kind: info.kind,
    strike: seriesStrike(info),
    low: info.low,
    high: info.high,
    expiry: expiry?.label ?? null,
    expiryIso: expiry?.iso ?? null,
    settlement: info.settlement,
    settledPrice: info.fixedPrice,
    minConfidenceBps: info.minConfidenceBps,
    offers: quoteRows(offers),
    bids: quoteRows(bids),
  };
}

/** A put is struck at its high leg, a call at its low one. */
export function seriesStrike(info: Pick<SeriesInfo, "kind" | "low" | "high">): number {
  return info.kind === "Put" ? info.high : info.low;
}

export interface PrintRow {
  /** "HH:MM:SS.mmm", the tape's own clock. */
  at: string;
  text: string;
  series: string;
  side: "buy" | "close";
  who: string;
  /** Contracts for an entry; 0 for a run-off, which has no size to show. */
  size: number;
  price: number | null;
  premium: number;
}

export interface Bucket {
  t: number;
  notional: number;
  premium: number;
  trades: number;
  contracts: number;
}

export interface ClosedRow {
  /** When the gateway watched it leave the chain, `HH:MM:SS`. */
  at: string;
  series: string;
  side: Side;
  contracts: number;
  cost: number;
  proceeds: number;
  pnl: number;
  via: string;
}

/**
 * The venue tape, from what the chain did. It holds no book and prices nothing:
 * an entry is a ticket the contract wrote at the premium the contract escrowed,
 * and a ticket that has gone is recorded with the payout the transaction
 * reported. `realised` is the one subtraction here, and both of its operands
 * came off the chain.
 */
export class Tape {
  rows: PrintRow[] = [];
  buckets: Bucket[] = [];
  closed: ClosedRow[] = [];
  realised = 0;
  prints = 0;
  /** The account the screen is signed in as: its rows say `you`, not a 40-character
   * sandbox name. Keys stay the real account, so a receipt still finds its ticket. */
  self: string | null = null;
  /** A run-off has no size to show, so the last hour of history is enough. */
  private readonly closedLimit = 60;
  private held = new Map<string, { position: PositionRow; who: string }>();

  /** Diff the chain's open tickets against the last pass. */
  observe(entries: Array<{ who: string; position: PositionRow }>, spot: number | null, nowMs = Date.now()): PrintRow[] {
    const fresh = new Map<string, { who: string; position: PositionRow }>();
    for (const entry of entries) fresh.set(`${entry.who}|${entry.position.ticketId}`, entry);
    const added: PrintRow[] = [];
    for (const [key, entry] of fresh) {
      if (this.held.has(key)) continue;
      const unit = entry.position.premium / Math.max(entry.position.contracts, 1);
      const row = this.entry(entry.who, entry.position, spot, nowMs, "buy", `${this.nameOf(entry.who)} bought ${entry.position.contracts} ${entry.position.series} @ ${unit.toFixed(4)}`);
      added.push(row);
    }
    for (const [key, entry] of this.held) {
      if (fresh.has(key)) continue;
      added.push(
        this.entry(entry.who, entry.position, spot, nowMs, "close", `${this.nameOf(entry.who)} · ${entry.position.series} ran off`),
      );
    }
    this.held = fresh;
    return added;
  }

  private nameOf(account: string): string {
    return this.self !== null && account === this.self ? "you" : account;
  }

  /** What a settlement or an early close actually paid, from its receipt. */
  paid(who: string, ticketId: number, paidTokens: number, method = "pool_close"): void {
    const key = `${who}|${ticketId}`;
    const held = this.held.get(key);
    const contracts = held?.position.contracts ?? 0;
    const cost = held?.position.cost ?? 0;
    const series = held?.position.series ?? `ticket ${ticketId}`;
    this.closed.unshift({
      at: new Date().toISOString().slice(11, 19),
      series,
      side: held?.position.side ?? "long",
      contracts,
      cost,
      proceeds: paidTokens,
      pnl: paidTokens - cost,
      // The route that paid, not the ticket's maker: a settled ticket was not
      // sold to anyone, and calling that a pool sale is a trade that never
      // happened. "the print" is the oracle price the series fixed on.
      via: method === "settle_ticket" ? "the print" : method === "close_ticket" ? "the book" : "the pool",
    });
    this.closed = this.closed.slice(0, this.closedLimit);
    this.realised += paidTokens - cost;
  }

  private entry(
    who: string,
    position: PositionRow,
    spot: number | null,
    nowMs: number,
    side: "buy" | "close",
    text: string,
  ): PrintRow {
    const at = new Date(nowMs).toISOString().slice(11, 23);
    const premium = side === "buy" ? position.premium : 0;
    const contracts = side === "buy" ? position.contracts : 0;
    const row: PrintRow = {
      at,
      text: `${at.slice(0, 8)} ${text}`,
      series: position.series,
      side,
      who,
      size: contracts,
      price: contracts > 0 ? premium / contracts : null,
      premium,
    };
    this.rows.unshift(row);
    this.rows = this.rows.slice(0, 240);
    this.prints += 1;
    if (contracts > 0) {
      const second = Math.floor(nowMs / 1000);
      let bucket = this.buckets[this.buckets.length - 1];
      if (!bucket || bucket.t !== second) {
        bucket = { t: second, notional: 0, premium: 0, trades: 0, contracts: 0 };
        this.buckets.push(bucket);
        this.buckets = this.buckets.slice(-60);
      }
      bucket.premium += premium;
      bucket.contracts += contracts;
      bucket.trades += 1;
      bucket.notional += contracts * (spot ?? 0);
    }
    return row;
  }
}

/**
 * An LP's own position in the vault. `value` is `get_lp_value`, which is
 * `pool_withdraw`'s arithmetic read-only, and `exitable` compares it with the
 * free equity — the rule the contract applies when somebody actually leaves.
 */
export interface LpPosition {
  account: string;
  shares: number;
  value: number;
  exitable: boolean;
}

export interface StatePayload {
  now: number;
  spot: number | null;
  chain: LadderRow[];
  positions: PortfolioView;
  orders: OrderRow[];
  custody: Custody;
  pool: PoolView;
  seriesCount: number;
  openTickets: number;
  /** The expiry strip, read off the chain's own series. */
  expiries: ExpiryChip[];
  /** The cell the page asked about, or null when no strike is selected. */
  series: SeriesDetail | null;
  /** The engine's `/feed` body: index, venues behind it, socket counters. */
  feed: RawRecord | null;
  /** The oracle's committee for this asset's feed: who may settle, and what they said. */
  oracle: OracleView | null;
  /** This session's index and open PnL. Gone when the gateway is. */
  history: SessionHistory;
  trades: string[];
  volumeBuckets: Bucket[];
  tape: { prints: number; realised: number; closed: ClosedRow[] };
  you: { account: string; available: number; wallet: number } | null;
  /** The signed-in account's seat in the vault, priced by the contract itself. */
  lp: LpPosition;
  /** The contract every figure on this payload was read from. */
  contract: string;
  source: "contract";
}

/** The `/state` body, in the key order a reader of the screen expects. */
export function buildState(input: {
  now: number;
  spot: number | null;
  chain: LadderRow[];
  positions: PortfolioView;
  orders: OrderRow[];
  custody: Custody;
  pool: PoolView;
  seriesCount: number;
  openTickets: number;
  expiries: ExpiryChip[];
  series: SeriesDetail | null;
  feed: RawRecord | null;
  oracle: OracleView | null;
  history: SessionHistory;
  tape: Tape;
  you: { account: string; available: number; wallet: number } | null;
  lp: LpPosition;
  contract: string;
}): StatePayload {
  return {
    now: input.now,
    spot: input.spot,
    chain: input.chain,
    positions: input.positions,
    orders: input.orders,
    custody: input.custody,
    pool: input.pool,
    seriesCount: input.seriesCount,
    openTickets: input.openTickets,
    expiries: input.expiries,
    series: input.series,
    feed: input.feed,
    oracle: input.oracle,
    history: input.history,
    trades: input.tape.rows.map((row) => row.text),
    volumeBuckets: input.tape.buckets.slice(-60),
    tape: { prints: input.tape.prints, realised: input.tape.realised, closed: input.tape.closed },
    you: input.you,
    lp: input.lp,
    contract: input.contract,
    source: "contract",
  };
}

export function marksFromEngine(rows: Array<{ strike: number; put: LadderSide | null; call: LadderSide | null }>): EngineMarks {
  const cell = (kind: Kind, strike: number): MarkSide | null => {
    const row = rows.find((entry) => entry.strike === strike);
    const side = kind === "Put" ? row?.put : row?.call;
    if (!side) return null;
    return {
      mark: side.mark,
      bid: side.bid,
      ask: side.ask,
      markIv: side.markIv,
      bidIv: side.bidIv,
      askIv: side.askIv,
      entryIv: side.entryIv,
      exitIv: side.exitIv,
      delta: side.delta,
      gamma: side.gamma,
      vega: side.vega,
      theta: side.theta,
      low: side.low,
      high: side.high,
    };
  };
  // Keyed by cell, never by series id: the engine's ladder knows strikes, the
  // chain's registry knows ids, and the two are only joined in `contextFor`.
  return { side: (_asset, kind, strike) => cell(kind, strike) };
}

/**
 * Who is allowed to ask this gateway to sign.
 *
 * The gateway holds a key and trades as one account, so anything that reaches
 * the port can spend it. That is fine for a loopback tool and not fine for a
 * browser: a page on another origin can post to `http://127.0.0.1:<port>` from
 * the visitor's own machine, and a domain with a short TTL can rebind to it. A
 * scripted client sends no `Origin` and is judged on `Host` alone; a browser
 * has to show it came from the page this venue serves.
 */
const LOOPBACK = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
  "optionality.pro",
  "www.optionality.pro",
  "45.76.181.201",
]);

function hostOf(value: string): string {
  return value.replace(/:\d+$/, "");
}

export function rejectSigning(headers: { host?: string; origin?: string }): string | null {
  const host = hostOf(headers.host ?? "");
  if (!LOOPBACK.has(host)) {
    return headers.host ? `this venue answers only on loopback, not ${headers.host}` : "a request to sign must name its host";
  }
  if (headers.origin === undefined) return null;
  const from = hostOf(headers.origin.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  return from === host ? null : `origin ${headers.origin} is not this venue`;
}
