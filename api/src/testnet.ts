/** Public testnet boundary. Planning never signs; the faucet only issues mock tokens. */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Call } from "./actions.ts";

export function accountId(value: unknown): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new Error("connect a valid NEAR testnet account");
  }
  return value;
}

export function walletTransactions(calls: Call[], account: string, contracts: { options: string; token: string }) {
  accountId(account);
  return calls.map((call) => ({
    signerId: account,
    receiverId: call.contract === "token" ? contracts.token : contracts.options,
    actions: [{ type: "FunctionCall", params: {
      methodName: call.method,
      args: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, value === null && key === "receiver_id" ? contracts.options : value])),
      gas: (BigInt(call.tgas) * 1_000_000_000_000n).toString(),
      deposit: (call.depositYocto ?? 0n).toString(),
    } }],
  }));
}

/** Reserve before broadcasting: failures consume the allowance, so a crash cannot
 * issue an unlimited number of grants. One gateway process owns this journal. */
export class FaucetLedger {
  private data: { day: string; accounts: string[]; total: number };
  private path: string;
  private dailyLimit: number;
  private now: () => number;
  constructor(path: string, dailyLimit = 100, now = () => Date.now()) {
    this.path = path; this.dailyLimit = dailyLimit; this.now = now;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { day: "", accounts: [], total: 0 };
    if (!Array.isArray(this.data.accounts) || !Number.isSafeInteger(this.data.total)) throw new Error("invalid faucet journal; refusing to issue tokens");
  }
  reserve(account: string): void {
    accountId(account);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.data.day !== day) this.data = { day, accounts: [], total: 0 };
    if (this.data.accounts.includes(account)) throw new Error("this account already claimed test tokens today; try again after 00:00 UTC");
    if (this.data.total >= this.dailyLimit) throw new Error("today's test-token faucet limit has been reached");
    this.data.accounts.push(account);
    this.data.total += 1;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
