import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { maxPayout, payout, settlement, splitSettlement, unitPremium } from "../accounting.mjs";
import { Ledger, Rejection } from "../market.mjs";
import { runScenario } from "../scenario.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, "..", "..", "testdata", "accounting-vectors.json"), "utf8"),
);
const SCALE = 1_000_000n;
const T0 = 1_760_000_000_000_000_000n;
const seconds = (value) => BigInt(value) * 1_000_000_000n;

const asBig = (value) => (value === null ? null : BigInt(value));

test("the simulator reproduces every contract accounting vector", () => {
  assert.equal(vectors.rows.length > 50, true);
  for (const [index, row] of vectors.rows.entries()) {
    const input = row.input;
    const actual = settlement(
      BigInt(input.quantity),
      BigInt(input.scale),
      BigInt(input.low_strike),
      BigInt(input.high_strike),
      BigInt(input.price),
      BigInt(input.premium),
    );
    assert.equal(actual.valid, row.valid, `row ${index} validity`);
    assert.equal(actual.collateral, asBig(row.collateral), `row ${index} collateral`);
    assert.equal(actual.payout, asBig(row.payout), `row ${index} payout`);
    if (!row.valid) {
      assert.equal(row.fixed, null);
      assert.equal(actual.fixed, null);
      assert.equal(actual.voided, null);
      continue;
    }
    assert.equal(actual.fixed.buyer, BigInt(row.fixed.buyer), `row ${index} buyer credit`);
    assert.equal(actual.fixed.maker, BigInt(row.fixed.maker), `row ${index} maker credit`);
    assert.equal(actual.voided.buyer, BigInt(row.voided.buyer), `row ${index} void buyer`);
    assert.equal(actual.voided.maker, BigInt(row.voided.maker), `row ${index} void maker`);
    assert.equal(
      actual.fixed.buyer + actual.fixed.maker,
      actual.collateral + BigInt(input.premium),
      `row ${index} conserves value`,
    );
  }
});

test("math helpers match the documented rounding direction", () => {
  assert.equal(maxPayout(3n, 10n, 6n), 5n);
  assert.equal(payout(3n, 6n, 110n, 100n, 105n), 2n);
  assert.equal(splitSettlement(10n, 3n, 0n, false).maker, 13n);
  assert.equal(splitSettlement(10n, 3n, 0n, true).buyer, 3n);
  assert.equal(splitSettlement(10n, 3n, 11n, false), null);
  assert.equal(unitPremium(5n, 2n), 2_500_000n);
});

function openSeries(extra = {}) {
  return {
    scale: SCALE,
    low: 100n * SCALE,
    high: 110n * SCALE,
    expiryNs: T0 + seconds(30),
    acceptUntilNs: T0 + seconds(90),
    finalizeUntilNs: T0 + seconds(150),
    minConfidenceBps: 5_000n,
    ...extra,
  };
}

function fundedLedger(names) {
  const ledger = new Ledger(openSeries());
  for (const name of names) ledger.deposit(name, 100n * SCALE);
  return ledger;
}

/// Mirrors integration-tests/tests/e2e.rs::market_order_sweeps_the_book_and_settles_every_ticket
test("a sweep of the book settles every ticket with the same numbers as the sandbox test", () => {
  const ledger = fundedLedger(["alice", "bob", "carol"]);
  const bob = ledger.postOffer({
    maker: "bob",
    quantity: SCALE,
    premium: 2n * SCALE,
    expiresNs: T0 + seconds(29),
    nowNs: T0,
  });
  const carol = ledger.postOffer({
    maker: "carol",
    quantity: 2n * SCALE,
    premium: 5n * SCALE,
    expiresNs: T0 + seconds(29),
    nowNs: T0,
  });
  assert.deepEqual(
    ledger.book(T0, 50).map((offer) => offer.offerId),
    [bob, carol],
  );

  assert.throws(
    () =>
      ledger.fillMarketOrder({
        buyer: "alice",
        quantity: 5n * SCALE,
        maxTotalPremium: 50n * SCALE,
        minQuantity: 5n * SCALE,
        nowNs: T0,
      }),
    Rejection,
  );
  assert.equal(ledger.balance("alice"), 100n * SCALE);

  const fill = ledger.fillMarketOrder({
    buyer: "alice",
    quantity: 3n * SCALE,
    maxTotalPremium: 9n * SCALE,
    minQuantity: 3n * SCALE,
    nowNs: T0,
  });
  assert.equal(fill.filledQuantity, 3n * SCALE);
  assert.equal(fill.totalPremium, 7n * SCALE);
  assert.equal(fill.unfilledQuantity, 0n);
  assert.equal(fill.worstUnitPremium, 2_500_000n);
  assert.equal(ledger.book(T0, 50).length, 0);
  assert.equal(ledger.balance("alice"), 93n * SCALE);
  assert.equal(ledger.balance("bob"), 90n * SCALE);
  assert.equal(ledger.balance("carol"), 80n * SCALE);
  assert.equal(ledger.conservationOk(), true);

  const settledAt = ledger.series.expiryNs + seconds(10);
  const fixed = ledger.requestSettlement({
    observations: [{ price: 105n * SCALE, publishTimeNs: settledAt, confidenceBps: 9_000n }],
    nowNs: settledAt,
  });
  assert.deepEqual(fixed, { price: 105n * SCALE, publishTimeNs: settledAt });
  for (const id of [...ledger.tickets.keys()]) ledger.settleTicket({ id });

  assert.equal(ledger.balance("alice"), 108n * SCALE);
  assert.equal(ledger.balance("bob"), 97n * SCALE);
  assert.equal(ledger.balance("carol"), 95n * SCALE);
  assert.equal(ledger.expectedCustody(), 300n * SCALE);
  assert.equal(ledger.conservationOk(), true);
});

test("a premium budget caps the sweep and reports the unfilled size", () => {
  const ledger = fundedLedger(["alice", "bob", "carol"]);
  ledger.postOffer({ maker: "bob", quantity: SCALE, premium: 2n * SCALE, expiresNs: T0 + seconds(29), nowNs: T0 });
  const dear = ledger.postOffer({
    maker: "carol",
    quantity: SCALE,
    premium: 9n * SCALE,
    expiresNs: T0 + seconds(29),
    nowNs: T0,
  });
  const fill = ledger.fillMarketOrder({
    buyer: "alice",
    quantity: 2n * SCALE,
    maxTotalPremium: 5n * SCALE,
    nowNs: T0,
  });
  assert.equal(fill.filledQuantity, SCALE);
  assert.equal(fill.totalPremium, 2n * SCALE);
  assert.equal(fill.unfilledQuantity, SCALE);
  const book = ledger.book(T0, 50);
  assert.equal(book.length, 1);
  assert.equal(book[0].offerId, dear);
  assert.equal(ledger.conservationOk(), true);
});

test("reserved, expired and self-crossed offers are never swept", () => {
  const ledger = fundedLedger(["alice", "bob", "carol"]);
  const reserved = ledger.postOffer({
    maker: "bob",
    quantity: SCALE,
    premium: SCALE,
    taker: "carol",
    expiresNs: T0 + seconds(29),
    nowNs: T0,
  });
  ledger.postOffer({ maker: "bob", quantity: SCALE, premium: 4n * SCALE, expiresNs: T0 + seconds(29), nowNs: T0 });

  const asTaker = (buyer) =>
    ledger.fillMarketOrder({ buyer, quantity: 2n * SCALE, maxTotalPremium: 20n * SCALE, nowNs: T0 });

  assert.equal(asTaker("alice").totalPremium, 4n * SCALE);
  assert.equal(ledger.book(T0, 50).length, 1);
  assert.throws(() => asTaker("bob"), Rejection);
  asTaker("carol");
  assert.equal(ledger.book(T0, 50).length, 0);
  assert.equal(reserved < 2n, true);

  const expired = ledger.postOffer({
    maker: "bob",
    quantity: SCALE,
    premium: SCALE,
    expiresNs: T0 + seconds(5),
    nowNs: T0,
  });
  assert.throws(
    () => ledger.fillMarketOrder({ buyer: "alice", quantity: SCALE, maxTotalPremium: 10n * SCALE, nowNs: T0 + seconds(6) }),
    Rejection,
  );
  assert.equal(ledger.offers.has(expired), true);
  assert.equal(ledger.conservationOk(), true);
});

test("an outage voids the series and refunds both sides", () => {
  const ledger = fundedLedger(["alice", "bob"]);
  ledger.postOffer({ maker: "bob", quantity: SCALE, premium: 3n * SCALE, expiresNs: T0 + seconds(29), nowNs: T0 });
  const ticket = ledger.fillOffer({ id: 0n, buyer: "alice", nowNs: T0 });
  assert.equal(ledger.balance("alice"), 97n * SCALE);

  const settledAt = ledger.series.expiryNs + seconds(10);
  const rejected = ledger.requestSettlement({
    observations: [{ price: 105n * SCALE, publishTimeNs: settledAt, confidenceBps: 100n }],
    nowNs: settledAt,
  });
  assert.equal(rejected, null);
  assert.throws(() => ledger.settleTicket({ id: ticket }), Rejection);

  ledger.voidSeries({ nowNs: ledger.series.finalizeUntilNs });
  ledger.settleTicket({ id: ticket });
  assert.equal(ledger.balance("alice"), 100n * SCALE);
  assert.equal(ledger.balance("bob"), 100n * SCALE);
  assert.equal(ledger.conservationOk(), true);
});

test("a settlement print outside the price band cannot fix the series", () => {
  const ledger = fundedLedger(["alice", "bob"]);
  ledger.postOffer({ maker: "bob", quantity: SCALE, premium: 3n * SCALE, expiresNs: T0 + seconds(29), nowNs: T0 });
  ledger.fillOffer({ id: 0n, buyer: "alice", nowNs: T0 });
  const settledAt = ledger.series.expiryNs + seconds(10);
  for (const price of [105n * 100n * SCALE, 0n, 105n * SCALE / 1000n]) {
    assert.equal(
      ledger.requestSettlement({
        observations: [{ price, publishTimeNs: settledAt, confidenceBps: 9_000n }],
        nowNs: settledAt,
      }),
      null,
      `price ${price} must be refused`,
    );
  }
});

test("the simulator is as strict as the contract at the boundaries", () => {
  // A negative strike width is None in Rust, not a BigInt wrap.
  assert.equal(maxPayout(1n, 100n - 110n, 7n), null);
  assert.equal(payout(1n, 7n, 100n, 110n, 105n), null);

  const ledger = fundedLedger(["alice", "bob"]);
  const offer = ledger.postOffer({
    maker: "bob",
    quantity: SCALE,
    premium: SCALE,
    expiresNs: T0 + seconds(29),
    nowNs: T0,
  });
  assert.equal(ledger.index.length, 1);

  // Settlement may only be requested inside [expiry, finalize_until).
  assert.throws(
    () => ledger.requestSettlement({ observations: [{ price: 105n * SCALE, publishTimeNs: T0, confidenceBps: 9_000n }], nowNs: T0 }),
    Rejection,
    "not expired yet",
  );
  assert.throws(
    () =>
      ledger.requestSettlement({
        observations: [{ price: 105n * SCALE, publishTimeNs: ledger.series.finalizeUntilNs, confidenceBps: 9_000n }],
        nowNs: ledger.series.finalizeUntilNs,
      }),
    Rejection,
    "past the finalize window the contract rejects the request and the series must void",
  );

  // The oracle hands the contract the earliest 100 prints only.
  const buried = [
    ...Array.from({ length: 100 }, (_, index) => ({
      price: 105n * SCALE,
      publishTimeNs: ledger.series.expiryNs + BigInt(index),
      confidenceBps: 100n,
    })),
    { price: 105n * SCALE, publishTimeNs: ledger.series.expiryNs + 1_000n, confidenceBps: 9_000n },
  ];
  assert.equal(
    ledger.requestSettlement({ observations: buried, nowNs: ledger.series.expiryNs + seconds(10) }),
    null,
    "a valid print hidden behind 100 rejected ones is never seen on-chain",
  );

  // Pruning drops expired quotes from the matching index but keeps collateral.
  const stale = ledger.postOffer({
    maker: "bob",
    quantity: SCALE,
    premium: SCALE,
    expiresNs: T0 + seconds(5),
    nowNs: T0,
  });
  assert.equal(ledger.index.length, 2);
  const later = T0 + seconds(6);
  assert.equal(ledger.pruneOffers({ limit: 50n, nowNs: later }), 1n);
  assert.equal(ledger.index.length, 1);
  assert.equal(ledger.offers.has(stale), true, "the record survives pruning");
  assert.equal(ledger.totals.offerCollateral, 20n * SCALE, "collateral stays escrowed");
  assert.equal(ledger.balance("alice"), 100n * SCALE);
  const cancelled = ledger.cancelOffer({ id: stale, caller: "bob" });
  assert.equal(cancelled.collateral, 10n * SCALE);
  assert.equal(ledger.balance("bob"), 100n * SCALE - ledger.totals.offerCollateral);
  assert.equal(ledger.offers.has(offer), true);

  // Withdrawal moves value out of the ledger and the invariant stays honest.
  ledger.withdraw("alice", 5n * SCALE);
  assert.equal(ledger.balance("alice"), 95n * SCALE);
  assert.equal(ledger.bank.netDeposited, 195n * SCALE);
  assert.equal(ledger.conservationOk(), true);

  // Conservation catches a totals/balances split, not just the grand sum.
  ledger.bank.balances.set("alice", ledger.balance("alice") + 1n);
  assert.equal(
    ledger.conservationOk(),
    false,
    "a one-unit credit without a totals update must be detected",
  );
});

test("a full simulated week conserves custody in every run", () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const run = runScenario({
      seed,
      steps: 18,
      sweepEvery: 2,
      funding: 1_000_000_000_000n,
      outage: seed % 4 === 0,
    });
    assert.equal(run.stats.conserved, true, `seed ${seed} ledger`);
    assert.equal(run.ledger.expectedCustody(), run.ledger.bank.netDeposited);
    assert.equal(run.ledger.tickets.size, 0, "every ticket settles");
    for (const [account, balance] of Object.entries(run.balances)) {
      assert.ok(balance >= 0n, `${account} went negative`);
    }
    assert.equal(
      run.settlements.reduce((total, ticket) => total + ticket.buyerCredit + ticket.makerCredit, 0n),
      run.settlements.reduce((total, ticket) => total + ticket.collateral + ticket.premium, 0n),
    );
    const pnl = Object.values(run.pnl).reduce((total, value) => total + value, 0n);
    assert.equal(pnl, 0n, "zero sum between maker and taker");
  }
});

/// Mirrors lib.rs::closing_a_ticket_pays_the_seller_and_moves_the_position
test("closing a ticket pays the seller, moves the position and conserves custody", () => {
  const ledger = fundedLedger(["alice", "maker", "bidder"]);
  const bid = ledger.postBid({ owner: "alice", quantity: SCALE, premium: 3n * SCALE, expiresNs: T0 + seconds(20), nowNs: T0 });
  const ticket = ledger.fillBid({ id: bid, seller: "maker", nowNs: T0 });
  assert.equal(ledger.tickets.get(ticket).cost, 3n * SCALE, "basis starts at the premium paid");

  ledger.postBid({ owner: "bidder", quantity: SCALE, premium: 4n * SCALE, expiresNs: T0 + seconds(25), nowNs: T0 + seconds(1) });
  const closed = ledger.closeTicket({
    id: ticket, seller: "alice", minUnitPremium: 4n * SCALE, nowNs: T0 + seconds(2),
  });
  assert.equal(closed.proceeds, 4n * SCALE);

  const moved = ledger.tickets.get(ticket);
  assert.equal(moved.buyer, "bidder", "the bidder holds it");
  assert.equal(moved.maker, "maker", "the maker never moves");
  assert.equal(moved.cost, 4n * SCALE, "the new holder's basis is their price");
  assert.equal(ledger.balance("alice"), 101n * SCALE, "paid 3, closed at 4");
  assert.equal(ledger.balance("bidder"), 96n * SCALE);
  assert.equal(ledger.totals.bidEscrow, 0n);
  assert.equal(ledger.totals.ticketPremium, 3n * SCALE, "the maker is owed the original premium");
  assert.equal(ledger.conservationOk(), true);
  assert.deepEqual(ledger.positions_("bidder").map((row) => row.side), ["long"]);
  assert.deepEqual(ledger.positions_("maker").map((row) => row.side), ["short"]);
  assert.equal(ledger.positions_("alice").length, 0, "closed out");

  const settledAt = ledger.series.expiryNs + seconds(10);
  ledger.requestSettlement({
    observations: [{ price: 105n * SCALE, publishTimeNs: settledAt, confidenceBps: 9_000n }],
    nowNs: settledAt,
  });
  const payout = ledger.settleTicket({ id: ticket });
  assert.equal(payout.buyer, 5n * SCALE);
  assert.equal(payout.maker, 8n * SCALE);
  assert.equal(ledger.balance("bidder"), 101n * SCALE, "settlement follows the holder, not the first buyer");
  assert.equal(ledger.conservationOk(), true);
});

/// Mirrors lib.rs::close_only_matches_a_whole_foreign_bid_above_the_floor
test("close refuses a self-crossed, odd-sized or underpriced bid", () => {
  const ledger = fundedLedger(["alice", "maker", "bidder"]);
  const bid = ledger.postBid({ owner: "alice", quantity: SCALE, premium: 3n * SCALE, expiresNs: T0 + seconds(20), nowNs: T0 });
  const ticket = ledger.fillBid({ id: bid, seller: "maker", nowNs: T0 });

  ledger.postBid({ owner: "alice", quantity: SCALE, premium: 9n * SCALE, expiresNs: T0 + seconds(25), nowNs: T0 });
  ledger.postBid({ owner: "alice", quantity: SCALE / 2n, premium: 8n * SCALE, expiresNs: T0 + seconds(25), nowNs: T0 });
  for (const attempt of [
    () => ledger.closeTicket({ id: ticket, seller: "alice", nowNs: T0 + seconds(1) }),
  ]) {
    assert.throws(attempt, Rejection, "own and odd-size bids are not counterparties");
  }

  ledger.postBid({ owner: "bidder", quantity: SCALE, premium: 4n * SCALE, expiresNs: T0 + seconds(25), nowNs: T0 });
  assert.throws(
    () => ledger.closeTicket({ id: ticket, seller: "alice", minUnitPremium: 5n * SCALE, nowNs: T0 + seconds(2) }),
    Rejection,
    "a floor above the book must refuse",
  );
  assert.equal(ledger.bids.size, 3, "a refused close consumes nothing");
  assert.equal(ledger.conservationOk(), true);
});
