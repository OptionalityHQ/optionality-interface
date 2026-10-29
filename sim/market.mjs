// In-memory mirror of the bounded-options contract, plus the rules needed to
// drive it. Matching, caps and the settlement filter follow
// contracts/bounded-options/src/lib.rs deliberately so a simulated run
// predicts what the deployed contract will do. The one deliberate difference
// is that withdrawals and the oracle query are synchronous here: on-chain they
// are cross-contract calls with a Pending state in between.
import { maxPayout, payout, payoutCall, splitSettlement, unitPremium } from "./accounting.mjs";

export const LIMITS = {
  maxOpenOffers: 10_000n,
  maxOpenTickets: 10_000n,
  maxOffersPerSeries: 200n,
  maxObservations: 100n,
  priceBoundFactor: 10n,
  settlementGraceNs: 300_000_000_000n,
};

export class Rejection extends Error {}

const reject = (message) => {
  throw new Rejection(message);
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/// Cash shared by every series a trader can see: balances and the free-cash
/// total. Series ledgers hold their own escrow on top of it.
export class Bank {
  constructor() {
    this.balances = new Map();
    this.available = 0n;
    this.netDeposited = 0n;
  }

  balance(account) {
    return this.balances.get(account) ?? 0n;
  }

  credit(account, amount) {
    if (amount === 0n) return;
    this.balances.set(account, this.balance(account) + amount);
    this.available += amount;
  }

  debit(account, amount) {
    if (this.balance(account) < amount) reject("insufficient available balance");
    this.balances.set(account, this.balance(account) - amount);
    this.available -= amount;
  }

  balanceSum() {
    let summed = 0n;
    for (const amount of this.balances.values()) summed += amount;
    return summed;
  }

  deposit(account, amount) {
    if (amount <= 0n) reject("amount must be positive");
    this.credit(account, amount);
    this.netDeposited += amount;
  }

  withdraw(account, amount) {
    if (amount <= 0n) reject("amount must be positive");
    this.debit(account, amount);
    this.netDeposited -= amount;
  }
}

export class Ledger {
  constructor(
    { scale = 1_000_000n, low, high, kind = "Put", expiryNs, acceptUntilNs, finalizeUntilNs, minConfidenceBps = 0n },
    bank = new Bank(),
  ) {
    if (!(high > low)) reject("invalid strikes");
    this.series = { scale, low, high, kind, expiryNs, acceptUntilNs, finalizeUntilNs, minConfidenceBps };
    this.bank = bank;
    this.settlement = "Open";
    this.fixed = null;
    this.offers = new Map();
    // Matching index of live offer ids, the mirror of the contract's
    // series_offers: expired quotes stay out of it so a sweep never pays for
    // dead reads and the per-series cap counts live quotes only.
    this.index = [];
    this.tickets = new Map();
    this.nextOffer = 0n;
    this.nextTicket = 0n;
    this.totals = {
      offerCollateral: 0n,
      bidEscrow: 0n,
      ticketCollateral: 0n,
      ticketPremium: 0n,
    };
    this.bids = new Map();
    this.bidIndex = [];
    this.nextBid = 0n;
  }

  balance(account) {
    return this.bank.balance(account);
  }

  /// Escrow held by this series only.
  escrow() {
    const { offerCollateral, bidEscrow, ticketCollateral, ticketPremium } = this.totals;
    return offerCollateral + bidEscrow + ticketCollateral + ticketPremium;
  }

  expectedCustody() {
    return this.bank.available + this.escrow();
  }

  conservationOk() {
    let summed = 0n;
    for (const amount of this.bank.balances.values()) summed += amount;
    return (
      this.bank.netDeposited === this.expectedCustody() && summed === this.bank.available
    );
  }

  balanceSum() {
    let summed = 0n;
    for (const amount of this.bank.balances.values()) summed += amount;
    return summed;
  }

  deposit(account, amount) {
    this.bank.deposit(account, amount);
  }

  withdraw(account, amount) {
    this.bank.withdraw(account, amount);
  }

  credit(account, amount) {
    this.bank.credit(account, amount);
  }

  debit(account, amount) {
    this.bank.debit(account, amount);
  }

  collateralFor(quantity) {
    const collateral = maxPayout(quantity, this.series.high - this.series.low, this.series.scale);
    if (collateral === null) reject("numeric overflow");
    return collateral;
  }

  postOffer({ maker, quantity, premium, expiresNs, taker = null, nowNs }) {
    if (this.settlement !== "Open") reject("series not open");
    if (nowNs >= this.series.expiryNs) reject("series expired");
    if (quantity <= 0n) reject("quantity must be positive");
    if (premium <= 0n) reject("premium must be positive");
    if (!(expiresNs > nowNs && expiresNs <= this.series.expiryNs)) reject("invalid offer expiry");
    if (taker !== null && taker === maker) reject("maker cannot reserve own offer");
    if (BigInt(this.index.length) >= LIMITS.maxOffersPerSeries) reject("series offer capacity reached");
    if (BigInt(this.offers.size) >= LIMITS.maxOpenOffers) reject("offer capacity reached");
    const collateral = this.collateralFor(quantity);
    this.debit(maker, collateral);
    const offer = { id: this.nextOffer, maker, quantity, premium, collateral, expiresNs, taker };
    this.nextOffer += 1n;
    this.offers.set(offer.id, offer);
    this.index.push(offer.id);
    this.totals.offerCollateral += collateral;
    return offer.id;
  }

  cancelOffer({ id, caller }) {
    const offer = this.offers.get(id);
    if (!offer) reject("offer not found");
    if (offer.maker !== caller) reject("only maker");
    this.offers.delete(id);
    this.index = this.index.filter((entry) => entry !== id);
    this.totals.offerCollateral -= offer.collateral;
    this.credit(offer.maker, offer.collateral);
    return offer;
  }

  /// Mirror of the contract's prune_offers: drop expired quotes from the
  /// matching index only. Their records and collateral stay with the maker.
  pruneOffers({ limit = 50n, nowNs }) {
    const doomed = [];
    const kept = [];
    for (const id of this.index) {
      const offer = this.offers.get(id);
      const expired = offer === undefined || offer.expiresNs <= nowNs;
      if (expired && BigInt(doomed.length) < limit) doomed.push(id);
      else kept.push(id);
    }
    this.index = kept;
    return BigInt(doomed.length);
  }

  /// Rest a bid: escrow the premium you will pay for a protection ticket.
  postBid({ owner, quantity, premium, expiresNs, nowNs }) {
    if (this.settlement !== "Open") reject("series not open");
    if (nowNs >= this.series.expiryNs) reject("series expired");
    if (quantity <= 0n) reject("quantity must be positive");
    if (premium <= 0n) reject("premium must be positive");
    if (!(expiresNs > nowNs && expiresNs <= this.series.expiryNs)) reject("invalid bid expiry");
    if (BigInt(this.bidIndex.length) >= LIMITS.maxOffersPerSeries) reject("series bid capacity reached");
    this.debit(owner, premium);
    const bid = { id: this.nextBid, owner, quantity, premium, expiresNs };
    this.nextBid += 1n;
    this.bids.set(bid.id, bid);
    this.bidIndex.push(bid.id);
    this.totals.bidEscrow += premium;
    return bid.id;
  }

  cancelBid({ id, caller }) {
    const bid = this.bids.get(id);
    if (!bid) reject("bid not found");
    if (bid.owner !== caller) reject("only bidder");
    this.bids.delete(id);
    this.bidIndex = this.bidIndex.filter((entry) => entry !== id);
    this.totals.bidEscrow -= bid.premium;
    this.credit(bid.owner, bid.premium);
    return bid;
  }

  /// A seller takes the bid and becomes the maker.
  fillBid({ id, seller, nowNs }) {
    const bid = this.bids.get(id);
    if (!bid) reject("bid not found");
    if (nowNs >= bid.expiresNs) reject("bid expired");
    if (nowNs >= this.series.expiryNs) reject("series expired");
    if (this.settlement !== "Open") reject("series not open");
    if (bid.owner === seller) reject("bidder cannot fill own bid");
    if (BigInt(this.tickets.size) >= LIMITS.maxOpenTickets) reject("ticket capacity reached");
    const collateral = this.collateralFor(bid.quantity);
    this.debit(seller, collateral);
    this.totals.bidEscrow -= bid.premium;
    this.totals.ticketPremium += bid.premium;
    this.totals.ticketCollateral += collateral;
    this.bids.delete(id);
    this.bidIndex = this.bidIndex.filter((entry) => entry !== id);
    const ticketId = this.nextTicket;
    this.nextTicket += 1n;
    this.tickets.set(ticketId, {
      id: ticketId,
      buyer: bid.owner,
      maker: seller,
      quantity: bid.quantity,
      collateral,
      premium: bid.premium,
      cost: bid.premium,
    });
    return ticketId;
  }

  /// Sell a long ticket into the best resting bid on the series. The bidder's
  /// escrowed premium pays the exiting buyer and the bidder takes the ticket
  /// over, so the maker's collateral never moves and the custody sum is
  /// unchanged. Mirrors `close_ticket` in the contract.
  closeTicket({ id, seller, minUnitPremium = 0n, nowNs }) {
    const ticket = this.tickets.get(id);
    if (!ticket) reject("ticket not found");
    if (ticket.buyer !== seller) reject("only the buyer can close a ticket");
    if (this.settlement !== "Open") reject("series not open");
    if (nowNs >= this.series.expiryNs) reject("series expired");
    // Whole positions only: a bid for another size cannot absorb this ticket.
    const bid = this.bids_(nowNs, 50).find(
      (entry) => entry.owner !== seller && entry.quantity === ticket.quantity,
    );
    if (!bid) reject("no resting bid for this whole ticket");
    if (bid.unitPremium < minUnitPremium) reject("close below the minimum unit premium");
    this.totals.bidEscrow -= bid.premium;
    this.bids.delete(bid.bidId);
    this.bidIndex = this.bidIndex.filter((entry) => entry !== bid.bidId);
    this.credit(seller, bid.premium);
    ticket.buyer = bid.owner;
    ticket.cost = bid.premium;
    return { proceeds: bid.premium, buyer: bid.owner, bidId: bid.bidId };
  }

  /// Tickets this account is exposed to, long or short.
  positions_(account) {
    return [...this.tickets.values()]
      .filter((ticket) => ticket.buyer === account || ticket.maker === account)
      .map((ticket) => ({ ...ticket, side: ticket.buyer === account ? "long" : "short" }));
  }

  bids_(nowNs, limit = 50) {
    return this.bidIndex
      .map((id) => this.bids.get(id))
      .filter((bid) => bid !== undefined && nowNs < bid.expiresNs)
      .sort(
        (a, b) =>
          cmp(unitPremium(b.premium, b.quantity), unitPremium(a.premium, a.quantity)) ||
          cmp(a.id, b.id),
      )
      .slice(0, Math.min(Number(limit), 50))
      .map((bid) => ({
        bidId: bid.id,
        owner: bid.owner,
        quantity: bid.quantity,
        premium: bid.premium,
        unitPremium: unitPremium(bid.premium, bid.quantity),
        expiresNs: bid.expiresNs,
      }));
  }

  pruneBids({ limit = 50n, nowNs }) {
    const doomed = [];
    const kept = [];
    for (const id of this.bidIndex) {
      const bid = this.bids.get(id);
      if ((bid === undefined || bid.expiresNs <= nowNs) && BigInt(doomed.length) < limit) doomed.push(id);
      else kept.push(id);
    }
    this.bidIndex = kept;
    return BigInt(doomed.length);
  }

  fillOffer({ id, buyer, nowNs }) {
    const offer = this.offers.get(id);
    if (!offer) reject("offer not found");
    if (nowNs >= offer.expiresNs) reject("offer expired");
    if (nowNs >= this.series.expiryNs) reject("series expired");
    if (this.settlement !== "Open") reject("series not open");
    if (BigInt(this.tickets.size) >= LIMITS.maxOpenTickets) reject("ticket capacity reached");
    if (offer.maker === buyer) reject("maker cannot fill own offer");
    if (offer.taker !== null && offer.taker !== buyer) reject("offer reserved for another taker");
    this.debit(buyer, offer.premium);
    return this.openTicket(offer, buyer);
  }

  candidates(buyer, quantity, maxTotalPremium, nowNs) {
    const list = [];
    for (const id of this.index) {
      const offer = this.offers.get(id);
      if (!offer) continue;
      if (offer.maker === buyer) continue;
      if (nowNs >= offer.expiresNs) continue;
      if (offer.quantity > quantity) continue;
      if (offer.premium > maxTotalPremium) continue;
      if (offer.taker !== null && offer.taker !== buyer) continue;
      list.push(offer);
    }
    // Same total order as the contract: scaled unit premium, then offer id.
    list.sort(
      (a, b) =>
        cmp(unitPremium(a.premium, a.quantity), unitPremium(b.premium, b.quantity)) ||
        cmp(a.id, b.id),
    );
    return list;
  }

  fillMarketOrder({ buyer, quantity, maxTotalPremium, minQuantity = 1n, nowNs }) {
    if (this.settlement !== "Open") reject("series not open");
    if (quantity <= 0n) reject("quantity must be positive");
    if (maxTotalPremium <= 0n) reject("premium budget must be positive");
    if (nowNs >= this.series.expiryNs) reject("series expired");
    if (BigInt(this.tickets.size) >= LIMITS.maxOpenTickets) reject("ticket capacity reached");

    const taken = [];
    let remaining = quantity;
    let budget = maxTotalPremium;
    for (const offer of this.candidates(buyer, quantity, maxTotalPremium, nowNs)) {
      if (remaining === 0n) break;
      if (offer.quantity > remaining || offer.premium > budget) continue;
      remaining -= offer.quantity;
      budget -= offer.premium;
      taken.push(offer);
    }
    const filledQuantity = quantity - remaining;
    if (filledQuantity === 0n) reject("no matching offers");
    if (filledQuantity < minQuantity) reject("minimum quantity not filled");
    const totalPremium = maxTotalPremium - budget;
    if (BigInt(taken.length) + BigInt(this.tickets.size) > LIMITS.maxOpenTickets) {
      reject("ticket capacity reached");
    }
    this.debit(buyer, totalPremium);

    const tickets = [];
    let worstUnitPremium = 0n;
    for (const offer of taken) {
      worstUnitPremium =
        unitPremium(offer.premium, offer.quantity) > worstUnitPremium
          ? unitPremium(offer.premium, offer.quantity)
          : worstUnitPremium;
      tickets.push(this.openTicket(offer, buyer));
    }
    return { tickets, filledQuantity, totalPremium, unfilledQuantity: remaining, worstUnitPremium };
  }

  openTicket(offer, buyer) {
    this.offers.delete(offer.id);
    this.index = this.index.filter((entry) => entry !== offer.id);
    this.totals.offerCollateral -= offer.collateral;
    this.totals.ticketCollateral += offer.collateral;
    this.totals.ticketPremium += offer.premium;
    const id = this.nextTicket;
    this.nextTicket += 1n;
    this.tickets.set(id, {
      id,
      buyer,
      maker: offer.maker,
      quantity: offer.quantity,
      collateral: offer.collateral,
      premium: offer.premium,
      cost: offer.premium,
    });
    return id;
  }

  /// Applies the contract's acceptance filter: the first observation inside the
  /// window, inside a 10x price band and above the confidence floor wins. The
  /// oracle truncates to the earliest 100 prints before the contract sees them.
  requestSettlement({ observations, nowNs }) {
    if (this.settlement !== "Open") reject("already fixed or voided");
    if (nowNs < this.series.expiryNs) reject("series not expired");
    if (nowNs >= this.series.finalizeUntilNs) reject("acceptance window over");
    const lower = this.series.low / LIMITS.priceBoundFactor;
    const upper = this.series.high * LIMITS.priceBoundFactor;
    const chosen = (observations ?? [])
      .slice(0, Number(LIMITS.maxObservations))
      .find(
      (o) =>
        o.price > 0n &&
        o.price >= lower &&
        o.price <= upper &&
        BigInt(o.publishTimeNs) <= nowNs &&
        BigInt(o.publishTimeNs) >= this.series.expiryNs &&
        BigInt(o.publishTimeNs) <= this.series.acceptUntilNs &&
        BigInt(o.confidenceBps) >= this.series.minConfidenceBps,
    );
    if (chosen === undefined) return null;
    this.settlement = "Fixed";
    this.fixed = { price: BigInt(chosen.price), publishTimeNs: BigInt(chosen.publishTimeNs) };
    return this.fixed;
  }

  voidSeries({ nowNs }) {
    if (this.settlement !== "Open") reject("already fixed or voided");
    if (nowNs < this.series.finalizeUntilNs) reject("finalize window still open");
    this.settlement = "Void";
  }

  payoffOf(ticket) {
    return this.series.kind === "Call"
      ? payoutCall(ticket.quantity, this.series.scale, this.series.high, this.series.low, this.fixed.price)
      : payout(ticket.quantity, this.series.scale, this.series.high, this.series.low, this.fixed.price);
  }

  settleTicket({ id }) {
    const ticket = this.tickets.get(id);
    if (!ticket) reject("ticket not found");
    let split;
    if (this.settlement === "Fixed") {
      const value = this.payoffOf(ticket);
      if (value === null) reject("settlement rejected");
      split = splitSettlement(ticket.collateral, ticket.premium, value, false);
    } else if (this.settlement === "Void") {
      split = splitSettlement(ticket.collateral, ticket.premium, 0n, true);
    } else {
      reject("series not settled");
    }
    if (split === null) reject("settlement rejected");
    this.tickets.delete(id);
    this.totals.ticketCollateral -= ticket.collateral;
    this.totals.ticketPremium -= ticket.premium;
    this.credit(ticket.buyer, split.buyer);
    this.credit(ticket.maker, split.maker);
    return { ...split, ticket };
  }

  book(nowNs, limit = 50) {
    const offers = this.index
      .map((id) => this.offers.get(id))
      .filter((offer) => offer !== undefined && nowNs < offer.expiresNs)
      .sort(
        (a, b) =>
          cmp(unitPremium(a.premium, a.quantity), unitPremium(b.premium, b.quantity)) ||
          cmp(a.id, b.id),
      );
    return offers.slice(0, Math.min(Number(limit), 50)).map((offer) => ({
      offerId: offer.id,
      maker: offer.maker,
      quantity: offer.quantity,
      premium: offer.premium,
      unitPremium: unitPremium(offer.premium, offer.quantity),
      taker: offer.taker,
      expiresNs: offer.expiresNs,
    }));
  }
}
