/**
 * NEAR transport for the gateway. A signing session supplies the RPC, network,
 * contract accounts and role keys. Sandbox sessions remain the default; a
 * testnet signing session must be provisioned separately from deployment metadata.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
// @ts-ignore -- near-api-js ships no types in this install; the surface used
// here is narrow and declared below.
import * as nearAPI from "near-api-js";

const WALLET_ACCOUNTS_PATH = "data/wallet-accounts.json";
const INITIAL_WALLET_USDT_ATOMS = "5000000000"; // $5,000.00 USDT initial isolated sandbox balance

interface PersistedWalletAccount {
  roleKey: string;
  account: string;
  secret: string;
  displayAccount: string;
  initialized?: boolean;
}

export const TGAS = 100_000_000_000_000n; // 100 Tgas per call (supports cross-contract ft_transfer_call)

export interface Role {
  account: string;
  secret?: string;
}

export interface Session {
  rpc: string;
  network?: string;
  admin: Role;
  roles?: Record<string, Role>;
  contracts: { options: string; token: string; oracle: string };
}

/** NEAR amounts are u128 and the SDK reads them as strings; a BigInt would make
 * JSON.stringify throw, so every argument crosses the boundary as a string. */
function encode(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]),
  );
}

export interface CallResult {
  hash: string;
  gas: bigint;
  value: unknown;
}

/** NEAR nests a panic several envelopes deep, and near-api-js throws before the
 * status can be read: the sentence the contract chose — "pool full: this worst
 * case does not fit the equity left" — is in there somewhere, and a trader
 * reading `{"index":0,"kind":{...}}` learns nothing. */
export function failureText(value: unknown): string {
  const panic = findExecutionError(value) ?? findExecutionError(jsonOf(value));
  if (panic === null) return (value instanceof Error ? value.message : String(value ?? "")).slice(0, 240);
  return panic.replace(/^Smart contract panicked:\s*/, "");
}

function jsonOf(value: unknown): unknown {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function findExecutionError(node: unknown): string | null {
  if (node === null || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "ExecutionError" && typeof value === "string") return value;
    const nested = findExecutionError(value);
    if (nested !== null) return nested;
  }
  return null;
}

/** Resolve the SDK network and reject incomplete deployment metadata before
 * attempting to sign. Testnet metadata contains no private keys by design. */
export function sessionNetwork(session: Session): string {
  if (!session.rpc || !session.contracts?.options || !session.contracts?.token || !session.contracts?.oracle) {
    throw new Error("session must include RPC and all three contract accounts");
  }
  if (!session.admin?.account) throw new Error("session needs an admin account");
  return !session.network || session.network === "local-sandbox" ? "sandbox" : session.network;
}

export class Chain {
  readonly session: Session;
  private readonly near: any;
  private readonly keyStore: any;
  readonly options: string;
  readonly token: string;
  readonly oracle: string;
  transactions = 0;
  gasBurnt = 0n;
  private readonly cache = new Map<string, any>();
  private readonly reads = new Map<string, { expires: number; value: Promise<unknown> }>();
  private readonly walletAccounts = new Map<string, PersistedWalletAccount>();
  private readonly pendingWallets = new Map<string, Promise<void>>();

  private constructor(session: Session, near: any, keyStore?: any) {
    this.session = session;
    this.near = near;
    this.keyStore = keyStore;
    this.options = session.contracts.options;
    this.token = session.contracts.token;
    this.oracle = session.contracts.oracle;
    this.loadPersistedWallets();
  }

  private loadPersistedWallets(): void {
    try {
      if (!existsSync(WALLET_ACCOUNTS_PATH)) return;
      const raw = JSON.parse(readFileSync(WALLET_ACCOUNTS_PATH, "utf8")) as Record<string, PersistedWalletAccount>;
      const prefix = `${this.session.admin.account}:`;
      const network = sessionNetwork(this.session);
      if (!this.session.roles) this.session.roles = {};
      for (const [key, entry] of Object.entries(raw)) {
        if (!key.startsWith(prefix) || !entry?.account || !entry?.secret) continue;
        this.walletAccounts.set(key, entry);
        this.session.roles[entry.roleKey] = { account: entry.account, secret: entry.secret };
        if (this.keyStore) {
          void this.keyStore
            .setKey(network, entry.account, nearAPI.utils.key_pair.KeyPair.fromString(entry.secret as `ed25519:${string}`))
            .catch(() => null);
        }
      }
    } catch {}
  }

  private savePersistedWallets(): void {
    try {
      let existing: Record<string, PersistedWalletAccount> = {};
      if (existsSync(WALLET_ACCOUNTS_PATH)) {
        try {
          existing = JSON.parse(readFileSync(WALLET_ACCOUNTS_PATH, "utf8")) ?? {};
        } catch {}
      }
      for (const [k, v] of this.walletAccounts.entries()) {
        existing[k] = v;
      }
      mkdirSync(dirname(WALLET_ACCOUNTS_PATH), { recursive: true });
      writeFileSync(WALLET_ACCOUNTS_PATH, JSON.stringify(existing, null, 2));
    } catch {}
  }

  static async connect(sessionPath = "data/chain-session.json"): Promise<Chain> {
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as Session;
    const network = sessionNetwork(session);
    const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
    const credentialPath = process.env.NEAR_ADMIN_CREDENTIALS;
    if (credentialPath) {
      const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
      if ((credential.account_id ?? basename(credentialPath, ".json")) !== session.admin.account) throw new Error("admin credential account does not match deployment");
      session.admin.secret = credential.private_key ?? credential.secret_key;
    }
    for (const entry of [session.admin, ...Object.values(session.roles ?? {})]) {
      if (entry.secret) await keyStore.setKey(network, entry.account, nearAPI.utils.key_pair.KeyPair.fromString(entry.secret as `ed25519:${string}`));
    }
    if (network === "sandbox") {
      try {
        await keyStore.setKey(
          network,
          "test.near",
          nearAPI.utils.key_pair.KeyPair.fromString("ed25519:4QU1Y7EYeDmmsFpUQEwMvi5rKxGnBMop74QBhgmdbyFzwUYXNYMMkjkK2bAHRnVHg3nG4AQSsVf3zvhoJwgcupAB"),
        );
      } catch {}
    }
    const near = await nearAPI.connect({
      networkId: network,
      nodeUrl: session.rpc,
      keyStore,
      masterAccount: session.admin.account,
    });
    const chain = new Chain(session, near, keyStore);
    if (network === "sandbox") {
      void chain.refillSandboxGas("admin").catch(() => null);
      const timer = setInterval(() => {
        void chain.refillSandboxGas("admin").catch(() => null);
      }, 5 * 60 * 1000);
      timer.unref();
    }
    return chain;
  }

  /** Ensure sandbox accounts (especially `admin`, which continuously posts quotes) never run out of NEAR gas. */
  async refillSandboxGas(role = "admin", force = false): Promise<boolean> {
    if (sessionNetwork(this.session) !== "sandbox") return false;
    try {
      const targetId = this.id(role);
      const targetAcct = await this.near.account(targetId);
      const state = await targetAcct.state();
      const currentYocto = BigInt(state.amount ?? "0");
      const minThreshold = 25n * 10n ** 24n; // 25 NEAR
      if (!force && currentYocto >= minThreshold) return false;
      const topUpYocto = 50n * 10n ** 24n; // 50 NEAR
      try {
        const rootAcct = await this.near.account("test.near");
        await rootAcct.sendMoney(targetId, topUpYocto);
        return true;
      } catch {
        const donors = ["maker-3", "maker-2", "bidder-2", "bidder-1", "taker-3", "lp", "maker-1"];
        for (const donor of donors) {
          if (donor === role || !this.session.roles?.[donor]?.secret) continue;
          try {
            const donorAcct = await this.account(donor);
            const donorState = await donorAcct.state();
            if (BigInt(donorState.amount ?? "0") > 30n * 10n ** 24n) {
              await donorAcct.sendMoney(targetId, 20n * 10n ** 24n);
              return true;
            }
          } catch {}
        }
      }
    } catch {}
    return false;
  }

  id(role: string): string {
    const entry = role === "admin" ? this.session.admin : this.session.roles?.[role];
    if (!entry) throw new Error(`no configured account for ${role}`);
    return entry.account;
  }

  /**
   * Resolve a requested account or role name to a dedicated server-managed signing role (when on sandbox)
   * so that every connected wallet has its own strictly isolated on-chain account, balance, and positions.
   */
  resolveRole(requested?: string | null): { role: string; account: string; isDemo: boolean; displayAccount: string } {
    if (!this.session.roles) this.session.roles = {};
    const roles = this.session.roles;
    const defaultRole = roles.you ? "you" : Object.keys(roles)[0] ?? "admin";
    const defaultAccount = this.id(defaultRole);
    const trimmed = typeof requested === "string" ? requested.trim() : "";
    if (!trimmed) {
      return { role: defaultRole, account: defaultAccount, isDemo: true, displayAccount: defaultAccount };
    }
    if (trimmed === "admin" || trimmed === this.session.admin.account) {
      return { role: "admin", account: this.session.admin.account, isDemo: true, displayAccount: this.session.admin.account };
    }
    if (roles[trimmed] && !trimmed.startsWith("ext:")) {
      return { role: trimmed, account: roles[trimmed].account, isDemo: true, displayAccount: roles[trimmed].account };
    }
    for (const [roleName, entry] of Object.entries(roles)) {
      if (!roleName.startsWith("ext:") && entry.account === trimmed) {
        return { role: roleName, account: entry.account, isDemo: true, displayAccount: entry.account };
      }
    }
    // External wallet connected (e.g. Meteor Wallet / MyNearWallet / custom account ID).
    // On sandbox, each distinct wallet gets its own dedicated on-chain subaccount (`w-<slug>-<hash>.<admin>`)
    // so two different wallets NEVER share positions or balances.
    if (sessionNetwork(this.session) === "sandbox") {
      const lower = trimmed.toLowerCase();
      const storeKey = `${this.session.admin.account}:${lower}`;
      let persisted = this.walletAccounts.get(storeKey);
      if (!persisted) {
        const kp = nearAPI.utils.key_pair.KeyPairEd25519.fromRandom();
        const secret = kp.toString();
        const slug = lower.replace(/[^a-z0-9]/g, "").slice(0, 8) || "wallet";
        const hashInput = `${lower}:${secret}`;
        let hash = 2166136261;
        for (let i = 0; i < hashInput.length; i++) {
          hash ^= hashInput.charCodeAt(i);
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        const hash4 = hash.toString(36).slice(0, 4).padStart(4, "0");
        const roleKey = `ext:${lower}`;
        const subAccount = `w-${slug}-${hash4}.${this.session.admin.account}`;
        persisted = {
          roleKey,
          account: subAccount,
          secret,
          displayAccount: trimmed,
          initialized: false,
        };
        this.walletAccounts.set(storeKey, persisted);
        roles[roleKey] = { account: subAccount, secret };
        if (this.keyStore) {
          void this.keyStore.setKey("sandbox", subAccount, kp).catch(() => null);
        }
        this.savePersistedWallets();
      } else if (!roles[persisted.roleKey]) {
        roles[persisted.roleKey] = { account: persisted.account, secret: persisted.secret };
      }
      return {
        role: persisted.roleKey,
        account: persisted.account,
        isDemo: false,
        displayAccount: persisted.displayAccount || trimmed,
      };
    }
    return { role: defaultRole, account: trimmed, isDemo: false, displayAccount: trimmed };
  }

  /**
   * Ensure that an external wallet's dedicated sandbox subaccount exists on-chain
   * and has its initial independent USDT balance deposited into the venue.
   */
  async ensureWalletRole(requested?: string | null): Promise<{ role: string; account: string; isDemo: boolean; displayAccount: string }> {
    const resolved = this.resolveRole(requested);
    if (resolved.isDemo || sessionNetwork(this.session) !== "sandbox") {
      return resolved;
    }
    const lower = resolved.displayAccount.toLowerCase();
    const storeKey = `${this.session.admin.account}:${lower}`;
    const entry = this.walletAccounts.get(storeKey);
    if (!entry) return resolved;

    if (this.pendingWallets.has(storeKey)) {
      await this.pendingWallets.get(storeKey);
      return resolved;
    }

    const initTask = (async () => {
      try {
        const kp = nearAPI.utils.key_pair.KeyPair.fromString(entry.secret as `ed25519:${string}`);
        if (this.keyStore) {
          await this.keyStore.setKey("sandbox", entry.account, kp);
        }
        let existsOnChain = false;
        try {
          await this.accountExists(entry.account);
          existsOnChain = true;
        } catch {
          existsOnChain = false;
        }
        if (!existsOnChain) {
          await this.refillSandboxGas("admin").catch(() => null);
          const adminAcct = await this.account("admin");
          await adminAcct.createAccount(entry.account, kp.getPublicKey(), (5n * 10n ** 24n).toString());
        }
        if (!entry.initialized) {
          await this.call(
            entry.roleKey,
            "storage_deposit",
            { account_id: entry.account },
            { contract: this.token, deposit: "100000000000000000000000" },
          ).catch(() => null);
          await this.call(
            "admin",
            "mint",
            { account_id: entry.account, amount: INITIAL_WALLET_USDT_ATOMS },
            { contract: this.token },
          );
          await this.call(
            entry.roleKey,
            "ft_transfer_call",
            { receiver_id: this.options, amount: INITIAL_WALLET_USDT_ATOMS, msg: "deposit" },
            { contract: this.token, deposit: "1", gas: 100_000_000_000_000n },
          );
          entry.initialized = true;
          this.reads.clear();
          this.savePersistedWallets();
        }
      } catch {}
    })();

    this.pendingWallets.set(storeKey, initTask);
    try {
      await initTask;
    } finally {
      this.pendingWallets.delete(storeKey);
    }
    return resolved;
  }

  private async account(role: string): Promise<any> {
    const accountId = this.id(role);
    if (!this.cache.has(role)) this.cache.set(role, this.near.account(accountId));
    return this.cache.get(role);
  }

  async accountExists(accountId: string): Promise<void> {
    const account = await this.near.account(accountId);
    await account.state();
  }

  private async readContract(contractId: string, methodName: string, args: Record<string, unknown>): Promise<unknown> {
    const key = JSON.stringify([contractId, methodName, args]);
    const cached = this.reads.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const item = { expires: Number.POSITIVE_INFINITY, value: Promise.resolve() as Promise<unknown> };
    item.value = (async () => {
      const account = await this.near.account(this.options);
      return account.viewFunction({ contractId, methodName, args });
    })().then((value) => { item.expires = Date.now() + 3000; return value; }, (error) => { this.reads.delete(key); throw error; });
    if (this.reads.size >= 1024) for (const [name, entry] of this.reads) if (entry.expires < Date.now()) this.reads.delete(name);
    this.reads.set(key, item);
    return item.value;
  }

  async view(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.readContract(this.options, method, args);
  }

  /** One transaction, one hash. Returns the contract's own return value.
   * `contract` overrides the destination for calls that belong to the token. */
  async call(
    role: string,
    method: string,
    args: Record<string, unknown>,
    { gas = TGAS, deposit = "0", contract = this.options }: { gas?: bigint; deposit?: string; contract?: string } = {},
  ): Promise<CallResult> {
    const account = await this.account(role);
    let outcome: any;
    try {
      outcome = await account.functionCall({
        contractId: contract,
        methodName: method,
        args: encode(args),
        gas,
        attachedDeposit: BigInt(deposit),
      });
    } catch (error) {
      if (
        sessionNetwork(this.session) === "sandbox" &&
        /does not have enough balance|NotEnoughBalance/i.test(String(error))
      ) {
        const refilled = await this.refillSandboxGas(role, true);
        if (refilled) {
          outcome = await account.functionCall({
            contractId: contract,
            methodName: method,
            args: encode(args),
            gas,
            attachedDeposit: BigInt(deposit),
          });
        }
      }
      if (!outcome) {
        // The SDK throws on a failed transaction before the status below can be
        // read, so the contract's sentence has to be unwrapped here as well.
        throw new Error(`${method} reverted: ${failureText(error)}`);
      }
    }
    this.reads.clear();
    this.transactions += 1;
    const burnt = outcome.receipts_outcome.reduce((total: bigint, r: any) => total + BigInt(r.outcome.gas_burnt), 0n);
    this.gasBurnt += burnt;
    if (outcome.status?.Failure) {
      throw new Error(`${method} reverted: ${failureText(outcome.status.Failure)}`);
    }
    return {
      hash: outcome.transaction.hash,
      gas: burnt,
      value: outcome.status?.SuccessValue
        ? JSON.parse(Buffer.from(outcome.status.SuccessValue, "base64").toString())
        : null,
    };
  }

  /** Move tokens into the market and let its receiver hook act on them. `msg`
   * chooses the destination inside the contract: "deposit" credits a tradable
   * balance, "pool-deposit" mints vault shares against the pool's net assets. */
  depositTo(role: string, amountUnits: string | number | bigint, msg = "deposit"): Promise<CallResult> {
    return this.call(
      role,
      "ft_transfer_call",
      { receiver_id: this.options, amount: BigInt(amountUnits).toString(), msg },
      { contract: this.token, gas: TGAS * 2n, deposit: "1" },
    );
  }

  /** A read from the oracle. It is a separate contract from the market, and the
   * only party that knows which seats signed the price a ticket settled on. */
  async oracleView(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.readContract(this.oracle, method, args);
  }

  /** The contract returns U128, which serialises as a bare JSON string. */
  async balance(role: string): Promise<number> {
    return Number(await this.view("get_balance", { account_id: this.id(role) }));
  }

  /** What any account holds in the collateral token itself. */
  async ftBalance(accountId: string): Promise<number> {
    const value = (await this.readContract(this.token, "ft_balance_of", { account_id: accountId })) as { amount?: string } | string;
    // NEP-141 says Balance is an object; this token returns the U128 bare.
    return Number(typeof value === "object" ? value.amount : value);
  }

  /** What a role holds outside the market, used to watch an asynchronous
   * withdrawal land before spending it again. */
  tokenBalance(role: string): Promise<number> {
    return this.ftBalance(this.id(role));
  }

  /** What the contract believes it holds versus what the token says it holds. */
  async custody(): Promise<{ expected: number; held: number; conserved: boolean }> {
    const expected = Number(await this.view("expected_custody"));
    const held = await this.ftBalance(this.options);
    return { expected, held, conserved: expected === held };
  }
}
