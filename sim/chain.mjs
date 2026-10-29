// Chain client: the Node side of the real NEAR integration. It signs with the
// sandbox accounts the chain host created and talks to the sandbox over its
// JSON-RPC, so every order the market places is an actual transaction with an
// actual hash against the actual contract.
//
//   const chain = await Chain.connect("data/chain-session.json");
//   await chain.call("maker-1", "post_offer", { series_id: 0, ... });
//
// Nothing here needs a key of yours and nothing reaches testnet: the RPC is
// 127.0.0.1 and the keys are the ones tools/chain-host printed.
import { readFileSync } from "node:fs";
import * as nearAPI from "near-api-js";

export const TGAS = 30_000_000_000_000n; // 30 Tgas per call

/// NEAR amounts are u128 and the SDK reads them as strings; a BigInt would make
/// JSON.stringify throw, so every argument crosses the boundary as a string.
const encode = (args) =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]),
  );

export class Chain {
  static async connect(sessionPath = "data/chain-session.json") {
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
    for (const entry of [session.admin, ...Object.values(session.roles)]) {
      await keyStore.setKey("sandbox", entry.account, nearAPI.utils.key_pair.KeyPair.fromString(entry.secret));
    }
    const near = await nearAPI.connect({
      networkId: "sandbox",
      nodeUrl: session.rpc,
      keyStore,
      masterAccount: session.roles.you.account,
    });
    return new Chain(session, near, keyStore);
  }

  constructor(session, near, keyStore) {
    this.session = session;
    this.near = near;
    this.connection = near.connection;
    this.options = session.contracts.options;
    this.token = session.contracts.token;
    this.oracle = session.contracts.oracle;
    this.transactions = 0;
    this.gasBurnt = 0n;
    this.cache = new Map();
  }

  id(role) {
    const entry = role === "admin" ? this.session.admin : this.session.roles[role];
    if (!entry) throw new Error(`no sandbox account for ${role}`);
    return entry.account;
  }

  async account(role) {
    const accountId = this.id(role);
    if (!this.cache.has(role)) this.cache.set(role, this.near.account(accountId));
    return this.cache.get(role);
  }

  async view(method, args = {}) {
    const account = await this.account("you");
    return account.viewFunction({ contractId: this.options, methodName: method, args });
  }

  /// One transaction, one hash. Returns the contract's own return value.
  /// `contract` overrides the destination for calls that belong to the token.
  async call(role, method, args, { gas = TGAS, deposit = "0", contract = this.options } = {}) {
    const account = await this.account(role);
    const outcome = await account.functionCall({
      contractId: contract,
      methodName: method,
      args: encode(args),
      gas,
      attachedDeposit: BigInt(deposit),
    });
    this.transactions += 1;
    const burnt = outcome.receipts_outcome.reduce((total, r) => total + BigInt(r.outcome.gas_burnt), 0n);
    this.gasBurnt += burnt;
    if (outcome.status?.Failure) {
      throw new Error(`${method} reverted: ${JSON.stringify(outcome.status.Failure).slice(0, 400)}`);
    }
    return {
      hash: outcome.transaction.hash,
      gas: burnt,
      value: outcome.status?.SuccessValue ? JSON.parse(Buffer.from(outcome.status.SuccessValue, "base64").toString()) : null,
    };
  }

  /// Move tokens into the market and let its receiver hook act on them. `msg`
  /// chooses the destination inside the contract: "deposit" credits a tradable
  /// balance, "pool-deposit" mints vault shares against the pool's net assets.
  depositTo(role, amount, msg = "deposit") {
    return this.call(
      role,
      "ft_transfer_call",
      { receiver_id: this.options, amount: BigInt(amount).toString(), msg },
      { contract: this.token, gas: TGAS * 2n, deposit: "1" },
    );
  }

  /// The settlement print. The oracle's reporter is the admin account.
  async report(price, { feed = "ETH-USD", confidenceBps = 9000 } = {}) {
    const account = await this.account("admin");
    const outcome = await account.functionCall({
      contractId: this.oracle,
      methodName: "report",
      args: {
        feed_id: feed,
        // The oracle stores a raw u128, which the SDK reads as a JSON number;
        // the market's own amounts are U128 wrappers and read as strings.
        price: Number(price),
        publish_time_ns: Number(BigInt(Date.now()) * 1_000_000n),
        confidence_bps: confidenceBps,
      },
      gas: TGAS,
      attachedDeposit: 0n,
    });
    return { hash: outcome.transaction.hash };
  }

  /// The contract returns U128, which serialises as a bare JSON string.
  async balance(role) {
    return Number(await this.view("get_balance", { account_id: this.id(role) }));
  }

  /// What any account holds in the collateral token itself.
  async ftBalance(accountId) {
    const account = await this.account("you");
    const value = await account.viewFunction({
      contractId: this.token,
      methodName: "ft_balance_of",
      args: { account_id: accountId },
    });
    // NEP-141 says Balance is an object; this token returns the U128 bare.
    return Number(typeof value === "object" ? value.amount : value);
  }

  /// What a role holds outside the market, used to watch an asynchronous
  /// withdrawal land before spending it again.
  async tokenBalance(role) {
    return this.ftBalance(this.id(role));
  }

  /// What the contract believes it holds versus what the token says it holds.
  async custody() {
    const expected = Number(await this.view("expected_custody"));
    const held = await this.ftBalance(this.options);
    return { expected, held, conserved: expected === held };
  }
}
