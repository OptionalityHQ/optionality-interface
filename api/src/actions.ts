/**
 * What a click on the screen turns into on-chain. Planning is separate from
 * executing so that every routing rule is a pure function with a test: which
 * counterparty a trade goes to, what the buyer's budget is, how much gas a call
 * needs because it chains a transfer.
 *
 * The rule that matters: the vault is the default counterparty. The book is used
 * only when a resting offer actually beats the vault's loaded ask, and the
 * gateway knows that from numbers the chain and the engine already produced.
 */
import {
  type Asset,
  type Kind,
  type LadderSide,
  type PoolPrice,
  type PositionRow,
  type Settlement,
  SCALE,
  amount,
  legsFor,
  toUnits,
} from "./gateway.ts";

export interface ResolvedSeries {
  seriesId: number;
  asset: Asset;
  kind: Kind;
  strike: number;
  low: number;
  high: number;
  expiryNs: number;
  settlement: Settlement;
}

export interface Context {
  /** The account the gateway signs with, and the contract's own account. */
  you: string;
  vault: string;
  priceScale: number;
  seriesFor: (asset: Asset, kind: Kind, strike: number) => ResolvedSeries | null;
  /** The ladder cell the trader is looking at, already merged with the chain. */
  side: LadderSide | null;
  /**
   * The vault's published price for this cell at the clicked quantity, read off
   * the contract. This is the only number a pool trade may carry: `pool_buy` and
   * `pool_close` refuse a mid that is not the venue's own, so a planner working
   * from the engine's float would plan a trade the chain will not make.
   */
  price: PoolPrice | null;
  positions: PositionRow[];
}

export interface Call {
  contract: "options" | "token" | "oracle";
  method: string;
  args: Record<string, string | number | null>;
  /** Tgas. A call that chains a cross-contract transfer must prepay for the
   * transfer *and* its callback, or the contract panics before any state write. */
  tgas: bigint;
  /** NEP-141 `ft_transfer*` refuses anything but exactly 1 yoctoNEAR attached,
   * so the deposit is part of the plan rather than something a runner guesses. */
  depositYocto?: bigint;
}

export interface ActionBody {
  type: string;
  asset?: string;
  kind?: string;
  strike?: number | string;
  quantity?: number | string;
  limit?: number | string;
  postOnly?: boolean;
  ticket?: number | string;
  amount?: number | string;
  shares?: number | string;
  expiry?: string;
  /**
   * Fill semantics for a market take: `"fok"` refuses a partial. The vault always
   * writes the whole quantity at one price, so this only changes what happens when
   * the fill would come from a person's resting offer.
   */
  fill?: string;
  /**
   * Hold to expiry: buy from the vault at the mid, with no venue margin, and give
   * up the right to close or sell on. The contract enforces the commitment.
   */
  hold?: boolean;
  /** A resting order's id, for the cancel path. */
  id?: number | string;
  /** Which book the id belongs to: offers and bids number their own. */
  side?: string;
}

const TGAS = 30n;
/** `withdraw` attaches 20 Tgas to the transfer and 25 to its callback. */
const CHAINED = 90n;

export function assetOf(value: unknown): Asset {
  const up = String(value ?? "").toUpperCase();
  if (up === "BTC") return "BTC";
  if (up === "NEAR") return "NEAR";
  return "ETH";
}

export function kindOf(value: unknown): Kind {
  return value === "Call" ? "Call" : "Put";
}

/** Whole contracts only: the contract does not split a ticket, and neither does
 * this planner pretend to. */
export function contractsOf(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 1));
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new RangeError("quantity must be at least one contract");
  }
  return parsed;
}

/** Supports fractional/decimal contract sizing (e.g. from arbitrary USDT amounts) down to 0.0001 contracts (6-decimal on-chain units). */
export function sizeOf(value: unknown): number {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RangeError("quantity must be at least one contract");
  }
  return Math.max(0.0001, Math.round(parsed * 1_000_000) / 1_000_000);
}

function requireSeries(context: Context, body: ActionBody): ResolvedSeries {
  const series = context.seriesFor(assetOf(body.asset), kindOf(body.kind), Number(body.strike));
  if (!series) throw new Error("unknown series");
  return series;
}

function requireOpen(series: ResolvedSeries): void {
  if (series.settlement !== "open") throw new Error("this series has already expired");
}

/**
 * A market buy: take the book if a resting offer is cheaper than the vault,
 * otherwise buy from the vault at its loaded price. The buyer names a price only
 * as a bound — the vault prices itself (`pool_buy` has no price argument), so
 * what this decides is how much movement to accept between the screen and the
 * chain, and when to say the click was never an agreement to this trade.
 */
const MARKET_SLIPPAGE_BPS = 100n;

/** The budget to sign for an order paying `ask` in total, given a trader who saw
 * `limit` per contract. Inside the tolerance the order takes the venue's price;
 * outside it there is no fill to plan. */
function marketBudget(limit: number, contracts: number, ask: bigint): bigint {
  const shown = toUnits(limit * contracts);
  if (ask <= shown) return shown;
  const ceiling = (shown * (10_000n + MARKET_SLIPPAGE_BPS)) / 10_000n;
  if (ask > ceiling) {
    throw new Error(
      `the ask moved to ${(Number(ask) / Number(SCALE) / contracts).toFixed(4)} · ` +
        `more than 1% past your ${limit.toFixed(4)}`,
    );
  }
  return ask;
}

/** The same, on the way out: a seller's floor, 1% under what the screen showed.
 * The vault pays its own exit, and the floor is the trader's refusal right. */
function marketFloor(limit: number, contracts: number): bigint {
  const shown = toUnits(limit * contracts);
  return (shown * (10_000n - MARKET_SLIPPAGE_BPS)) / 10_000n;
}

function planBuy(context: Context, body: ActionBody): Call[] {
  const series = requireSeries(context, body);
  requireOpen(series);
  const contracts = sizeOf(body.quantity);
  const limit = Number(body.limit);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("a buy needs a limit price");
  if (body.postOnly) {
    const resting = context.side?.takeAsk;
    if (resting !== null && resting !== undefined && limit >= resting) {
      throw new Error(`post-only bid ${limit.toFixed(2)} would cross the ask ${resting.toFixed(2)}`);
    }
    return [
      {
        contract: "options",
        method: "post_bid",
        args: {
          series_id: series.seriesId,
          quantity: toUnits(contracts).toString(),
          premium: toUnits(limit * contracts).toString(),
          expires_ns: Math.min(series.expiryNs, Date.now() * 1e6 + 3_600e9),
        },
        tgas: TGAS,
      },
    ];
  }
  // Hold to expiry is a commitment, not a price preference: the ticket has to
  // come from the vault at the mid, because only that ticket carries the no-exit
  // rule the holder chose. A cheaper resting offer is a different trade — one
  // the holder can still sell later — so it is not a substitute, even though it
  // would cost less. `midUnits` is one contract's mid, while the contract's
  // budget is over the whole ticket, so the ceiling is the mid times the size.
  if (body.hold) {
    const price = context.price;
    if (price === null) {
      throw new Error("the vault has no live price for this spread, so there is no held ticket to buy");
    }
    const mid = amount(price.midUnits) * toUnits(contracts) / SCALE;
    return [
      {
        contract: "options",
        method: "pool_buy_held",
        args: {
          series_id: series.seriesId,
          quantity: toUnits(contracts).toString(),
          max_total_premium: (mid + mid / 100n).toString(),
        },
        tgas: TGAS,
      },
    ];
  }
  // Two things can sell this spread: a person resting an offer on chain, and the
  // vault at the price the venue published. `takeAsk` is the cheaper of the two,
  // and null only when neither has one — so a null is not a cheap fill, it is no
  // market, and signing anyway would only buy a reverted transaction.
  const take = context.side?.takeAsk ?? null;
  if (take === null) {
    throw new Error("nothing is offering this spread: the venue has no live price and no one is resting one");
  }
  if (context.side?.takeAskFrom === "book" && context.side?.bestOfferId !== null) {
    return [
      {
        contract: "options",
        method: "fill_market_order",
        args: {
          series_id: series.seriesId,
          quantity: toUnits(contracts).toString(),
          max_total_premium: marketBudget(limit, contracts, toUnits(take * contracts)).toString(),
          // Fill or kill: the contract refuses the fill if the book cannot cover
          // the whole quantity, which is the difference between "I will take what
          // is there" and "I want this size or nothing".
          min_quantity: body.fill === "fok" ? toUnits(contracts).toString() : null,
        },
        tgas: TGAS,
      },
    ];
  }
  // The vault's half. It prices itself — there is no price argument to send —
  // and the budget is the total the contract charges for this quantity, read
  // from `get_pool_prices`: its premium is one ceiling over the whole ticket, so
  // a per-contract multiplication would be a different number from the one
  // execution uses.
  const price = context.price;
  if (price === null) {
    throw new Error("the vault is not writing this spread: the venue has no live price for it");
  }
  return [
    {
      contract: "options",
      method: "pool_buy",
      args: {
        series_id: series.seriesId,
        quantity: toUnits(contracts).toString(),
        max_total_premium: marketBudget(limit, contracts, amount(price.entryUnits)).toString(),
      },
      tgas: TGAS,
    },
  ];
}

/**
 * A sell. Two different things wear the same word, and the plan has to tell them
 * apart: naming a ticket hands one back (to the vault, or to a bidder), and
 * naming none *writes* one — into a resting bid if one pays, otherwise as an
 * offer that waits.
 */
function planSell(context: Context, body: ActionBody): Call[] {
  const series = requireSeries(context, body);
  const limit = Number(body.limit ?? 0);
  const contracts = sizeOf(body.quantity);
  const offer = (): Call => {
    requireOpen(series);
    return {
      contract: "options",
      method: "post_offer",
      args: {
        series_id: series.seriesId,
        quantity: toUnits(contracts).toString(),
        premium: toUnits(limit * contracts).toString(),
        taker: null,
        expires_ns: Math.min(series.expiryNs, Date.now() * 1e6 + 3_600e9),
      },
      tgas: TGAS,
    };
  };
  if (body.postOnly) {
    const bestBid = context.side?.bid ?? 0;
    if (bestBid > 0 && limit <= bestBid) {
      throw new Error(`post-only offer ${limit.toFixed(2)} would cross the bid ${bestBid.toFixed(2)}`);
    }
    return [offer()];
  }
  const ticket = Number(body.ticket);
  if (Number.isInteger(ticket)) {
    const held = context.positions.find(
      (row) => row.ticketId === ticket && row.side === "long" && row.againstPool,
    );
    if (held) {
      // A held ticket gave up both exits at entry in exchange for the mid with
      // no fee. The contract refuses this, so the planner refuses it in words
      // rather than signing a transaction whose only outcome is a revert.
      if (held.held) {
        throw new Error("this ticket was bought to hold to expiry: it cannot be closed or sold");
      }
      // The vault buys the ticket back at its own quote — there is no price to
      // send, and a cell that happens to be on screen is not the holder's
      // series, so the quote has to be that series' before anything is planned.
      const price = context.price;
      if (price === null || price.seriesId !== held.seriesId) {
        throw new Error("the venue has no live price for this series: the vault cannot buy the ticket back");
      }
      const exit = amount(price.exitUnits);
      // Someone who clicked "Close @ 0.0822" agreed to about that, not to
      // whatever the index does before the transaction lands. The floor is 1%
      // under the price shown; a quote already under it is refused here, in
      // words the holder can act on, rather than as a reverted close.
      const floor = limit > 0 ? marketFloor(limit, held.contracts) : null;
      if (floor !== null && exit < floor) {
        throw new Error(
          `the exit fell to ${(Number(exit) / Number(SCALE) / held.contracts).toFixed(4)} · ` +
            `more than 1% under your ${limit.toFixed(4)}`,
        );
      }
      return [
        {
          contract: "options",
          method: "pool_close",
          args: { ticket_id: ticket, min_exit_units: floor === null ? null : floor.toString() },
          tgas: TGAS,
        },
      ];
    }
    // Not the vault's: hand it to a bidder instead, at or above the trader's floor.
    return [
      {
        contract: "options",
        method: "close_ticket",
        args: {
          ticket_id: ticket,
          min_unit_premium: limit > 0 ? toUnits(limit).toString() : null,
        },
        tgas: TGAS,
      },
    ];
  }
  // No ticket named, so this sell writes one. A resting bid that pays the price
  // asked is the counterparty already standing there: the contract hands the
  // writer the bidder's premium and posts the width as collateral. With nothing
  // to take, the order rests as an offer instead.
  const bestBidId = context.side?.bestBidId ?? null;
  const bestBid = context.side?.bid ?? 0;
  const bestBidSize = context.side?.bidSize ?? 0;
  if (limit <= 0) throw new Error("writing a ticket needs a price");
  // `fill_bid` takes the whole bid, so it is only the trader's order if the size
  // is what they asked for. Anything else rests, rather than filling a ticket of
  // a size nobody agreed to write.
  if (bestBidId !== null && bestBid >= limit && bestBidSize === contracts) {
    return [{ contract: "options", method: "fill_bid", args: { bid_id: bestBidId }, tgas: TGAS }];
  }
  return [offer()];
}

/** Fix the series from the oracle, then claim every ticket on it. Settlement is
 * two transactions because the print arrives in a callback the chain has to run
 * first — planning them together is what lets the screen say "settled N". */
function planExpire(context: Context, body: ActionBody): Call[] {
  const series = requireSeries(context, body);
  if (series.settlement !== "open" && series.settlement !== "pending") {
    throw new Error("this series is already settled");
  }
  return [
    {
      contract: "options",
      method: "request_settlement",
      args: { series_id: series.seriesId },
      tgas: CHAINED,
    },
  ];
}

function planSettle(context: Context, body: ActionBody): Call[] {
  // A ticket outlives the ladder it was written on. By the time its series is
  // fixed the screen may be looking at a tenor that did not exist when the
  // ticket was bought, so a settle addressed by ticket id needs nothing on the
  // ladder to resolve — the contract already knows which series it belongs to.
  const ticket = Number(body.ticket);
  if (Number.isInteger(ticket)) {
    return [{ contract: "options", method: "settle_ticket", args: { ticket_id: ticket }, tgas: TGAS }];
  }
  const series = requireSeries(context, body);
  if (series.settlement !== "fixed" && series.settlement !== "void") {
    throw new Error("this series has not settled yet");
  }
  return context.positions
    .filter((row) => row.seriesId === series.seriesId)
    .map((row) => ({
      contract: "options" as const,
      method: "settle_ticket",
      args: { ticket_id: row.ticketId },
      tgas: TGAS,
    }));
}

export function planDeposit(body: ActionBody): Call {
  const value = Number(body.amount);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("amount must be positive");
  return {
    contract: "token",
    method: "ft_transfer_call",
    args: {
      receiver_id: null, // filled by the runner, which alone knows the account ids
      amount: toUnits(value).toString(),
      msg: "deposit",
    },
    tgas: CHAINED,
    depositYocto: 1n,
  };
}

/** Enter the vault with money already at the venue. The contract holds that
 * cash either way, so an FT round trip would only force an LP to withdraw
 * first; `pool_deposit_from_balance` moves the bucket and mints the shares in
 * one call. Wallets holding tokens can still use the `"pool-deposit"` message. */
export function planPoolDeposit(body: ActionBody): Call {
  const value = Number(body.amount);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("amount must be positive");
  return {
    contract: "options",
    method: "pool_deposit_from_balance",
    args: { amount: toUnits(value).toString() },
    tgas: TGAS,
  };
}

export function planPoolWithdraw(body: ActionBody): Call {
  const shares = Number(body.shares ?? body.amount);
  if (!Number.isFinite(shares) || shares <= 0) throw new RangeError("shares must be positive");
  return {
    contract: "options",
    method: "pool_withdraw",
    args: { shares: toUnits(shares).toString() },
    tgas: TGAS,
  };
}

export function planWithdraw(body: ActionBody): Call {
  const value = Number(body.amount);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("amount must be positive");
  return {
    contract: "options",
    method: "withdraw",
    args: { amount: toUnits(value).toString() },
    tgas: CHAINED,
  };
}

/**
 * Take a resting order back off the book.
 *
 * `cancel_offer` and `cancel_bid` number their own rows, so the side decides
 * which method the id belongs to. The premium or the collateral the order holds
 * comes back to its owner in the same call — there is nothing to reconcile.
 */
export function planCancel(body: ActionBody): Call {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 0) throw new Error("cancelling needs the order id");
  const buying = body.side === "buy";
  return {
    contract: "options",
    method: buying ? "cancel_bid" : "cancel_offer",
    args: buying ? { bid_id: id } : { offer_id: id },
    tgas: TGAS,
  };
}

/** One entry point, the same shape the screen already posts. */
export function planAction(body: ActionBody, context: Context): Call[] {
  switch (body.type) {
    case "buy":
      return planBuy(context, body);
    case "sell":
    case "close":
      return planSell(context, body);
    case "expire":
      return planExpire(context, body);
    case "settle":
      return planSettle(context, body);
    case "deposit":
      return [planDeposit(body)];
    case "pool-deposit":
      return [planPoolDeposit(body)];
    case "pool-withdraw":
      return [planPoolWithdraw(body)];
    case "withdraw":
      return [planWithdraw(body)];
    case "cancel":
      return [planCancel(body)];
    default:
      throw new Error(`unknown action "${body.type}"`);
  }
}

/**
 * What the trader should be told after a planned call succeeded. Kept separate
 * from the call so the wording is testable without a chain.
 */
export function describe(calls: Call[], body: ActionBody, context: Context): string {
  const call = calls[0];
  const contracts = Number(body.quantity ?? 1);
  switch (call?.method) {
    case "pool_buy": {
      // The contract's own total for the quantity, not the screen's older mark:
      // this is the number that left the trader's balance.
      const entry = context.price ? Number(amount(context.price.entryUnits)) / Number(SCALE) : 0;
      return `bought ${contracts}x from the pool at ${(entry / contracts).toFixed(4)} all-in`;
    }
    case "pool_buy_held":
      return `bought and held ${contracts}x at the mid, no fee — no early close`;
    case "fill_market_order":
      return `took ${contracts}x off the book`;
    case "pool_close":
      return `sold ${contracts}x back to the pool`;
    case "close_ticket":
      return `sold ${contracts}x into a resting bid`;
    case "fill_bid":
      return `wrote ${contracts}x into a resting bid`;
    case "post_bid":
      return `bid resting at ${Number(body.limit).toFixed(4)}`;
    case "post_offer":
      return `offer resting at ${Number(body.limit).toFixed(4)}`;
    case "cancel_offer":
      return `cancelled the offer holding ${Number(body.quantity ?? 1).toFixed(0)}x`;
    case "cancel_bid":
      return `cancelled the bid holding ${Number(body.quantity ?? 1).toFixed(0)}x`;
    case "request_settlement":
      return "asked the oracle to fix the series";
    case "settle_ticket":
      return `settled ${calls.length} ticket(s)`;
    case "ft_transfer_call":
      return `deposited ${Number(body.amount).toFixed(2)}`;
    case "pool_deposit_from_balance":
      return `deposited ${Number(body.amount).toFixed(2)} into the pool`;
    case "pool_withdraw":
      return `redeemed ${Number(body.shares ?? body.amount).toFixed(2)} shares`;
    case "withdraw":
      return `withdrew ${Number(body.amount).toFixed(2)}`;
    default:
      return "done";
  }
}

export function legsOf(asset: Asset, kind: Kind, strike: number): { low: number; high: number } {
  return legsFor(kind, strike, asset);
}
