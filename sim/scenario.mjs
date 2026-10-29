// One simulated trading week: makers quote the put spread off a random walk,
// a taker sweeps the book with a slippage budget, then the series settles from
// a single oracle print. Every number the report shows comes from the Ledger,
// which mirrors the contract, so the economics and the code cannot disagree.
import { Ledger, Rejection } from "./market.mjs";
import { pricePath, quotePremium, yearsUntil, SECONDS_PER_YEAR } from "./pricing.mjs";

const T0 = 1_760_000_000_000_000_000n;

export function seriesOf({ scale, low, high, years, acceptSeconds = 60, finalizeSeconds = 900 }) {
  const expiryNs = T0 + BigInt(Math.round(years * SECONDS_PER_YEAR * 1e9));
  return {
    scale,
    low,
    high,
    expiryNs,
    acceptUntilNs: expiryNs + BigInt(acceptSeconds * 1e9),
    finalizeUntilNs: expiryNs + BigInt(finalizeSeconds * 1e9),
    minConfidenceBps: 5_000n,
  };
}

export function runScenario(options) {
  const {
    seed = 1,
    spot = 108.5,
    vol = 0.6,
    drift = 0,
    years = 7 / 365,
    steps = 42,
    scale = 1_000_000n,
    low = 100_000_000n,
    high = 110_000_000n,
    makers = ["maker-a", "maker-b"],
    taker = "taker",
    unitQuantity = 1_000_000n,
    edgeBps = 150n,
    maxSlippageBps = 500n,
    sweepEvery = 3,
    outage = false,
    funding = 100_000_000_000n,
  } = options;

  const series = seriesOf({ scale, low, high, years });
  const ledger = new Ledger(series);
  const accounts = [...makers, taker];
  for (const account of accounts) ledger.deposit(account, funding);

  const { path, rng } = pricePath({ seed, spot, vol, years, steps, drift });
  const timeline = [];
  const sweeps = [];
  const posted = new Map();
  let rejections = 0;

  for (let step = 1; step <= steps; step += 1) {
    const price = path[step];
    const nowNs = T0 + BigInt(Math.round((step / steps) * Number(series.expiryNs - T0)));
    const remaining = yearsUntil(series.expiryNs, nowNs);
    const quoteLifeNs = BigInt(Math.max(Math.round(Number(series.expiryNs - nowNs) / 3), 1));

    if (nowNs < series.expiryNs) {
      for (const maker of makers) {
        const previous = posted.get(maker);
        if (previous !== undefined && ledger.offers.has(previous)) {
          try {
            ledger.cancelOffer({ id: previous, caller: maker });
          } catch (error) {
            if (!(error instanceof Rejection)) throw error;
          }
        }
        const jitter = 1 + (rng() - 0.5) * 0.1;
        const fair = quotePremium({
          quantity: unitQuantity,
          scale,
          spot: price,
          low,
          high,
          vol,
          years: remaining,
          edgeBps,
        });
        const premium = (fair * BigInt(Math.round(1000 * jitter))) / 1000n;
        try {
          const id = ledger.postOffer({
            maker,
            quantity: unitQuantity,
            premium: premium > 0n ? premium : 1n,
            expiresNs: nowNs + quoteLifeNs,
            nowNs,
          });
          posted.set(maker, id);
        } catch (error) {
          if (!(error instanceof Rejection)) throw error;
          rejections += 1;
        }
      }
    }

    if (step % sweepEvery === 0 && remaining > 0.4 * years) {
      const size = unitQuantity * BigInt(1 + Math.floor(rng() * 3));
      const fair = quotePremium({ quantity: size, scale, spot: price, low, high, vol, years: remaining, edgeBps });
      const budget = (fair * (10_000n + maxSlippageBps)) / 10_000n;
      try {
        const fill = ledger.fillMarketOrder({ buyer: taker, quantity: size, maxTotalPremium: budget, nowNs });
        sweeps.push({ step, nowNs, requested: size, fair, budget, ...fill });
      } catch (error) {
        if (!(error instanceof Rejection)) throw error;
        rejections += 1;
        sweeps.push({ step, nowNs, requested: size, fair, budget, rejected: error.message });
      }
    }

    timeline.push({
      step,
      nowNs,
      price,
      book: ledger.book(nowNs, 50).map((offer) => ({ ...offer })),
      openTickets: ledger.tickets.size,
    });
  }

  // Offers do not auto-cancel on-chain: an unfillable quote keeps its maker's
  // collateral locked until they cancel it, so the sim releases the book.
  let residualCancelled = 0;
  for (const [id, offer] of [...ledger.offers.entries()]) {
    ledger.cancelOffer({ id, caller: offer.maker });
    residualCancelled += 1;
  }

  const finalPrice = path[steps];
  const scaledPrice = BigInt(Math.round(finalPrice * Number(scale)));
  const settledNs = series.expiryNs + 10n * 1_000_000_000n;
  const observation = {
    price: scaledPrice,
    publishTimeNs: settledNs,
    confidenceBps: outage ? 1_000n : 9_000n,
  };
  const fixed = ledger.requestSettlement({ observations: [observation], nowNs: settledNs });
  if (fixed === null) {
    // The feed never produced an acceptable print: the outage path.
    ledger.voidSeries({ nowNs: series.finalizeUntilNs });
  }

  const settlements = [];
  for (const id of [...ledger.tickets.keys()]) {
    const ticket = ledger.tickets.get(id);
    const result = ledger.settleTicket({ id });
    settlements.push({
      id,
      settledAs: ledger.settlement,
      payout: ledger.settlement === "Fixed" ? ledger.payoffOf(ticket) : 0n,
      buyer: ticket.buyer,
      maker: ticket.maker,
      quantity: ticket.quantity,
      collateral: ticket.collateral,
      premium: ticket.premium,
      buyerCredit: result.buyer,
      makerCredit: result.maker,
      pnlBuyer: result.buyer - ticket.premium,
      pnlMaker: result.maker - ticket.collateral,
    });
  }

  const net = (account) => ledger.balance(account) - funding;
  const makerNet = makers.reduce((sum, maker) => sum + net(maker), 0n);
  const filled = sweeps.filter((sweep) => sweep.tickets !== undefined);
  const requested = sweeps.reduce((sum, sweep) => sum + sweep.requested, 0n);
  const received = filled.reduce((sum, sweep) => sum + sweep.filledQuantity, 0n);
  const paid = filled.reduce((sum, sweep) => sum + sweep.totalPremium, 0n);
  const fairValue = filled.reduce((sum, sweep) => sum + sweep.fair, 0n);
  const worst = filled.reduce(
    (max, sweep) => (sweep.worstUnitPremium > max ? sweep.worstUnitPremium : max),
    0n,
  );

  return {
    settlement: ledger.settlement,
    finalPrice,
    scaledPrice,
    fixed: ledger.fixed,
    timeline,
    sweeps,
    settlements,
    ledger,
    funding,
    balances: Object.fromEntries(accounts.map((account) => [account, ledger.balance(account)])),
    pnl: Object.fromEntries(accounts.map((account) => [account, net(account)])),
    stats: {
      offersOutstanding: BigInt(ledger.offers.size),
      residualCancelled: BigInt(residualCancelled),
      ticketsSettled: BigInt(settlements.length),
      sweepsRequested: sweeps.length,
      requested,
      received,
      paid,
      fairValue,
      worstUnitPremium: worst,
      rejections,
      makerNet,
      takerNet: net(taker),
      conserved: ledger.conservationOk(),
    },
  };
}
