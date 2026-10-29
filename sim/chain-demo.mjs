#!/usr/bin/env node
// On-chain market: runs full lifecycles of this product against a real NEAR
// sandbox — makers quote, you take, you close, the oracle prints, the ticket
// settles — and then does the same against the vault, where the counterparty is
// the pool instead of a person. Every step is a transaction with a hash and a
// gas figure, because this is the proof that the contract is the market.
//
//   cargo run -p chain-host -- --out data/chain-session.json   # terminal 1
//   node sim/chain-demo.mjs                                     # terminal 2
import { Chain, TGAS } from "./chain.mjs";
import { spreadValue } from "./pricing.mjs";

const SCALE = 1_000_000n;
const SCALE_N = 1_000_000;
const tokens = (value) => `${(Number(value) / Number(SCALE)).toFixed(6)}`;
const tgas = (gas) => `${(Number(gas) / 1e12).toFixed(1)} Tgas`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// u64 nanoseconds: the SDK JSON takes numbers for u64, strings only for u128.
const SEC = 1e9;
const nowNs = () => Date.now() * 1e6;

const chain = await Chain.connect(process.argv[2] || "data/chain-session.json");
console.log(`chain      ${chain.session.rpc}`);
console.log(`contract   ${chain.options}`);
console.log(`accounts   ${Object.keys(chain.session.roles).join(" ")}`);

const spot = Number(process.env.SPOT || 2350);
const low = Math.round(spot / 100) * 100;
const high = low + 100;

/// One expiry series on the live strike ladder, so the strikes are the ones a
/// screen would actually offer at this price.
async function newSeries(label, kind, seconds) {
  const expiry = nowNs() + seconds * SEC;
  const created = await chain.call("admin", "create_series", {
    underlying: "ETH",
    kind,
    expiry_ns: expiry,
    accept_until_ns: expiry + 30 * SEC,
    finalize_until_ns: expiry + 300 * SEC,
    low_strike: (BigInt(low) * SCALE).toString(),
    high_strike: (BigInt(high) * SCALE).toString(),
    price_scale: SCALE.toString(),
    min_confidence_bps: 3000,
    oracle_feed: "ETH-USD",
  });
  console.log(`\nseries     #${created.value} ${label}: ETH ${low}/${high} ${kind} · expires in ${seconds}s · ${created.hash}`);
  return { id: created.value, expiry };
}

// What the model says the spread is worth right now, and what the makers ask
// for it. The same pricing module the screen uses, so the numbers agree.
const years = 45 / (365 * 24 * 3600);
const mark = spreadValue({ spot, low, high, kind: "Call", atmVol: 0.45, years });
const unit = Math.max(0.05, Number(mark.toFixed(6)));
console.log(`spot       ETH ${spot} · model marks the 45s ${low}/${high} call at ${unit.toFixed(4)} per contract`);

const book = await newSeries("against a maker", "Call", 45);
const vault = await newSeries("against the pool", "Call", 60);

for (const [index, maker] of ["maker-1", "maker-2", "maker-3"].entries()) {
  const premium = BigInt(Math.round((unit + index * 0.02) * 3 * SCALE_N));
  const offer = await chain.call(maker, "post_offer", {
    series_id: book.id,
    quantity: (3n * SCALE).toString(),
    premium: premium.toString(),
    taker: null,
    expires_ns: nowNs() + 40 * SEC,
  });
  console.log(`quote      ${maker} 3 @ ${tokens(premium)}/3 · offer #${offer.value} · ${offer.hash}`);
}

const levels = await chain.view("get_book", { series_id: book.id, limit: 10 });
console.log(`book       ${levels.map((entry) => `${entry.maker} ${tokens(entry.premium)}`).join("  ")}`);

const fill = await chain.call("you", "fill_market_order", {
  series_id: book.id,
  quantity: (3n * SCALE).toString(),
  max_total_premium: (BigInt(Math.round(unit * 1.1 * 3 * SCALE_N))).toString(),
  min_quantity: null,
});
const tickets = fill.value.tickets;
console.log(`\nbought     ${tickets.length} ticket(s) #${tickets.join(" #")} for ${tokens(fill.value.total_premium)} · ${fill.hash}`);
console.log(`budget     worst unit ${tokens(fill.value.worst_unit_premium)} · ${tokens(fill.value.unfilled_quantity)} left unfilled`);
console.log(`you        ${tokens(await chain.balance("you"))} available on the contract`);

// A resting bid is what a close sells into. Somebody else has to make it.
const bidPremium = BigInt(Math.round(unit * 0.8 * 3 * SCALE_N));
const bid = await chain.call("bidder-1", "post_bid", {
  series_id: book.id,
  quantity: (3n * SCALE).toString(),
  premium: bidPremium.toString(),
  expires_ns: nowNs() + 30 * SEC,
});
console.log(`\nbid        bidder-1 3 @ ${tokens(bidPremium)} · bid #${bid.value} · ${bid.hash}`);
const before = await chain.balance("you");
const closed = await chain.call("you", "close_ticket", {
  ticket_id: tickets[0],
  min_unit_premium: null,
});
const after = await chain.balance("you");
console.log(`closed     ticket #${tickets[0]} for ${tokens(closed.value)} · ${closed.hash}`);
console.log(`you        ${tokens(before)} → ${tokens(after)} (${tokens(BigInt(after) - BigInt(before))})`);

// ---------- player vs pool ----------
// The same contract with the book on the shelf. The vault is the maker, the fee
// is inside the premium, and the pool can only write what it can prove it can
// pay: `reserved ≤ equity`, checked in integers on every entry.
console.log(`\n--- vault ---`);
const principal = 1_000_000n * SCALE;
// An LP already has credit inside the contract, so it takes some back out to
// its own wallet and puts it in the pool instead. Two destinations, two msgs.
// A withdrawal is a cross-contract transfer plus its own callback, so it needs
// more than one call's worth of gas and it lands a second later, not now.
const out = await chain.call("maker-2", "withdraw", { amount: principal }, { gas: TGAS * 3n });
let wallet = 0;
for (let attempt = 0; attempt < 15 && wallet < Number(principal); attempt += 1) {
  await sleep(1000);
  wallet = await chain.tokenBalance("maker-2");
}
if (wallet < Number(principal)) {
  throw new Error(`withdrawal did not land: ${tokens(wallet)} of ${tokens(principal)}`);
}
console.log(`lp         maker-2 moved ${tokens(principal)} back to its wallet · ${out.hash} · ${tgas(out.gas)}`);
const minted = await chain.depositTo("maker-2", principal, "pool-deposit");
console.log(`lp         ${tokens(principal)} into the pool · ${minted.hash} · ${tgas(minted.gas)}`);
const lpShares = await chain.view("get_lp_shares", { account_id: chain.id("maker-2") });
console.log(`lp         shares held ${tokens(lpShares)} at 1 token per share (empty pool, so par)`);

const midUnits = BigInt(Math.round(unit * SCALE_N));
const entry = await chain.call("you", "pool_buy", {
  series_id: vault.id,
  quantity: 3n * SCALE,
  mid_units: midUnits,
  max_total_premium: BigInt(Math.round(unit * 1.2 * 3 * SCALE_N)),
});
const poolTicket = entry.value;
const bought = await chain.view("get_ticket", { ticket_id: poolTicket });
const state = await chain.view("get_pool_state");
console.log(`\npool_buy   ticket #${poolTicket} · 3 contracts at a ${tokens(midUnits)} mid`);
console.log(`           premium ${tokens(bought.premium)} all-in · worst case ${tokens(bought.collateral)} · margin inside it ${tokens(bought.venue_cut)}`);
console.log(`           ${tgas(entry.gas)} burned for one entry, fee included`);
console.log(`pool       equity ${tokens(state.equity)} · reserved ${tokens(state.reserved)} · free ${tokens(state.free_equity)}`);
console.log(`           utilisation ${Number(state.utilisation_bps) / 100}% · margin ${state.margin_bps} bps · exit haircut ${state.impact_bps} bps`);
console.log(`           margin locked ${tokens(state.venue_locked)} (refundable) · earned ${tokens(state.venue)} (sweepable)`);

// The vault's own worst case is on the ticket, and the buyer's basis already
// carries the fee — there is nothing else to itemise.
const held = await chain.view("get_positions", { account: chain.id("you"), limit: 20 });
const mine = held.filter((position) => position.series_id === vault.id);
console.log(`positions  you hold ${mine.length} pool ticket(s) at cost ${tokens(mine[0]?.cost ?? 0n)}`);

// A sweep while the ticket is open must come back empty: that margin is what a
// void would refund, so taking it now would strand the settlement.
const early = await chain.call("admin", "pool_sweep", {});
console.log(`sweep      while open: venue takes ${tokens(early.value)} · ${early.hash}`);

// The venue can be paid only once the ticket has run off. Wait for the vault's
// own series to expire, print a settlement below the low strike, and settle.
console.log(`\nwaiting for expiry (${Math.round((vault.expiry - nowNs()) / SEC)}s for the vault series)`);
while (nowNs() < book.expiry) await sleep(1000);
await chain.report(BigInt(Math.round(spot * 1.03 * SCALE_N)));
// Settlement is a cross-contract call to the oracle plus its callback, so it
// gets most of the 100 Tgas a single NEAR transaction may carry.
const settledBook = await chain.call("admin", "request_settlement", { series_id: book.id }, { gas: TGAS * 3n });
console.log(`oracle     ETH-USD printed at ${(spot * 1.03).toFixed(2)} · book settlement ${settledBook.hash}`);
await sleep(3000);
const bookSeries = await chain.view("get_series", { series_id: book.id });
console.log(`series     #${book.id} settlement ${JSON.stringify(bookSeries.settlement)}`);

const ours = await chain
  .view("get_positions", { account: chain.id("bidder-1"), limit: 20 })
  .then((rows) => rows.filter((row) => row.series_id === book.id));
for (const position of ours) {
  const payout = await chain.call("bidder-1", "settle_ticket", { ticket_id: position.ticket_id });
  console.log(`settled    book ticket #${position.ticket_id} paid ${tokens(payout.value[0])} to the holder, ${tokens(payout.value[1])} back to the maker · ${payout.hash}`);
}

// The vault's series expires later, and this print falls: the call the player
// bought is worthless, so the pool keeps the premium and the fee becomes takeable.
while (nowNs() < vault.expiry) await sleep(1000);
await chain.report(BigInt(Math.round(spot * 0.94 * SCALE_N)));
const settledVault = await chain.call("admin", "request_settlement", { series_id: vault.id }, { gas: TGAS * 3n });
console.log(`oracle     ETH-USD printed at ${(spot * 0.94).toFixed(2)} · vault settlement ${settledVault.hash}`);
await sleep(3000);
const paid = await chain.call("you", "settle_ticket", { ticket_id: poolTicket });
console.log(`settled    pool ticket #${poolTicket} paid ${tokens(paid.value[0])} to the buyer, ${tokens(paid.value[1])} to the maker (the vault keeps its premium) · ${paid.hash}`);
const swept = await chain.call("admin", "pool_sweep", {});
console.log(`sweep      venue takes ${tokens(swept.value)} now that no void can call for it · ${swept.hash}`);
const after2 = await chain.view("get_pool_state");
console.log(`pool       equity ${tokens(after2.equity)} · reserved ${tokens(after2.reserved)} · utilisation ${Number(after2.utilisation_bps) / 100}%`);
const redeemed = await chain.call("maker-2", "pool_withdraw", { shares: (await chain.view("get_lp_shares", { account_id: chain.id("maker-2") })).toString() });
console.log(`lp         redeemed ${tokens(redeemed.value)} against ${tokens(principal)} in · ${redeemed.hash}`);

const custody = await chain.custody();
console.log(`\ncustody    expected ${tokens(custody.expected)} · token says ${tokens(custody.held)} · ${custody.conserved ? "conserved" : "MISMATCH"}`);
const stats = await chain.view("stats");
const pool = await chain.view("get_pool_state");
console.log(`stats      ${stats.ticket_count} tickets ever · ${stats.open_ticket_count} open · ${stats.series_count} series`);
console.log(`           makers hold ${tokens(stats.total_ticket_premium)} premium · the vault holds ${tokens(pool.equity)} equity and ${tokens(pool.venue_locked)} refundable margin`);
console.log(`gas        ${chain.transactions} transactions · ${tgas(chain.gasBurnt)}`);
if (!custody.conserved) process.exitCode = 1;
