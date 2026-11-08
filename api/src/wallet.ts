/**
 * Browser-only NEAR Wallet Selector integration (Meteor Wallet extension + MyNearWallet)
 * alongside Server-Managed Demo Accounts (where private keys remain strictly behind the server).
 */
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
// @ts-ignore -- bundled as CSS by esbuild
import "@near-wallet-selector/modal-ui/styles.css";

let selector: Awaited<ReturnType<typeof setupWalletSelector>> | null = null;
let selectorMainnet: Awaited<ReturnType<typeof setupWalletSelector>> | null = null;
let config: any;
let account: string | null = null;
let walletType: "demo" | "meteor" | "my-near-wallet" | "extension" | null = "demo";
let modal: ReturnType<typeof setupModal> | null = null;

const SANDBOX_STORAGE_KEY = "optionality_wallet_account";
const WALLET_TYPE_KEY = "optionality_wallet_type";

export const WALLET_ICONS = {
  meteor: "/images/meteor-icon.png",
  mynear: "/images/my-near-wallet-icon.png",
  near: `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="10" fill="#11161C"/><path d="M26.9 11.4L21.6 19.3C21.3 19.7 21.8 20.2 22.2 19.9L27.4 15.4C27.6 15.2 27.9 15.4 27.9 15.7V24.1C27.9 24.4 27.5 24.6 27.3 24.3L14.5 9.8C13.9 9.1 13 8.8 12.1 8.8H11.4C9.8 8.8 8.5 10.1 8.5 11.7V28.3C8.5 29.9 9.8 31.2 11.4 31.2C12.4 31.2 13.3 30.7 13.9 29.8L19.2 21.9C19.5 21.5 19 21 18.6 21.3L13.4 25.8C13.2 26 12.9 25.8 12.9 25.5V17.1C12.9 16.8 13.3 16.6 13.5 16.9L26.3 31.4C26.9 32.1 27.8 32.4 28.7 32.4H29.4C31 32.4 32.3 31.1 32.3 29.5V11.7C32.3 10.1 31 8.8 29.4 8.8C28.4 8.8 27.5 9.3 26.9 10.2V11.4Z" fill="#F4EDE4"/></svg>`,
  )}`,
  demo: `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="10" fill="#0F1D19"/><path d="M20 8L30 12.2V19.6C30 26.1 25.7 31.8 20 33.6C14.3 31.8 10 26.1 10 19.6V12.2L20 8Z" fill="#5FC39C" fill-opacity="0.16" stroke="#5FC39C" stroke-width="2" stroke-linejoin="round"/><path d="M16 20.5L18.8 23.3L24.5 17.6" stroke="#C6F24E" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  )}`,
};

function isExtensionDetected(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).meteorCom || (window as any).near);
}

function readMeteorAuthAccount(): string | null {
  try {
    for (const key of ["near_app_meteor_wallet_auth_key", "meteor_wallet_auth_key", "default_meteor_wallet_auth_key"]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.accountId === "string" && parsed.accountId.trim()) {
        return parsed.accountId.trim();
      }
    }
  } catch {}
  return null;
}

function emitWallet() {
  window.dispatchEvent(
    new CustomEvent("optionality-wallet", {
      detail: {
        account,
        walletType,
        extensionDetected: isExtensionDetected(),
        network: config?.network ?? "sandbox",
        roles: config?.roles ?? {},
        demoAccounts: config?.demoAccounts ?? [],
      },
    }),
  );
}

async function ensureSelector() {
  if (selector) return selector;
  try {
    const isTestnet = config?.network === "testnet";
    const walletModules = [
      setupMeteorWallet({ iconUrl: "/images/meteor-icon.png" }),
      setupMyNearWallet({ iconUrl: "/images/my-near-wallet-icon.png" }),
    ];
    selector = await setupWalletSelector({
      network: {
        networkId: "testnet",
        nodeUrl: isTestnet && config?.rpc ? config.rpc : "https://rpc.testnet.near.org",
        helperUrl: "https://helper.testnet.near.org",
        explorerUrl: "https://testnet.nearblocks.io",
        indexerUrl: "https://api-testnet.nearblocks.io/v1",
      },
      modules: walletModules,
    });
    selector.store.observable.subscribe(() => {
      if (localStorage.getItem(SANDBOX_STORAGE_KEY) === "__disconnected__") return;
      const state = selector!.store.getState();
      const active = state.accounts.find((a: { active: boolean }) => a.active)?.accountId ?? null;
      if (active && active !== account) {
        account = active;
        const selectedId = state.selectedWalletId;
        walletType = selectedId === "meteor-wallet" ? "meteor" : selectedId === "my-near-wallet" ? "my-near-wallet" : "extension";
        localStorage.setItem(SANDBOX_STORAGE_KEY, active);
        localStorage.setItem(WALLET_TYPE_KEY, walletType);
        emitWallet();
      }
    });
    try {
      // Pass empty contractId so connecting a wallet never requires a 0.25 NEAR FunctionCall key allowance
      modal = setupModal(selector, {
        contractId: "",
      });
    } catch {}
  } catch (err) {
    console.warn("NEAR Wallet Selector init note:", err);
  }
  return selector;
}

async function init() {
  try {
    config = await (await fetch("/config", { cache: "no-store" })).json();
  } catch {
    config = { network: "sandbox", roles: {}, demoAccounts: [] };
  }
  await ensureSelector();

  const selectorAccount =
    selector?.store.getState().accounts.find((a: { active: boolean }) => a.active)?.accountId ??
    readMeteorAuthAccount();
  const savedAccount = localStorage.getItem(SANDBOX_STORAGE_KEY);
  const savedType = localStorage.getItem(WALLET_TYPE_KEY) as typeof walletType;

  if (savedAccount === "__disconnected__") {
    account = null;
    walletType = null;
  } else if (selectorAccount && (savedType === "meteor" || savedType === "my-near-wallet" || savedType === "extension")) {
    account = selectorAccount;
    walletType = savedType;
  } else if (config.network !== "testnet") {
    const validDemoAccounts = Object.values(config.roles ?? {}) as string[];
    if (savedAccount && (savedType === "meteor" || savedType === "my-near-wallet" || savedType === "extension")) {
      account = savedAccount;
      walletType = savedType;
    } else if (savedAccount && validDemoAccounts.includes(savedAccount)) {
      account = savedAccount;
      walletType = "demo";
    } else {
      account = config.sandboxAccount || config.roles?.you || config.roles?.alice || "alice.test.near";
      walletType = "demo";
      localStorage.setItem(SANDBOX_STORAGE_KEY, account!);
      localStorage.setItem(WALLET_TYPE_KEY, "demo");
    }
  } else {
    account = selectorAccount;
    walletType = selectorAccount ? "extension" : null;
  }

  emitWallet();

  // Wallet redirects are pending until their transaction outcomes are checked.
  const query = new URLSearchParams(location.search);
  const hashes = query.get("transactionHashes");
  const error = query.get("errorMessage");
  if (hashes || error) {
    window.dispatchEvent(
      new CustomEvent("optionality-wallet-result", { detail: { hashes, error } }),
    );
    query.delete("transactionHashes");
    query.delete("errorCode");
    query.delete("errorMessage");
    history.replaceState(
      null,
      "",
      `${location.pathname}${query.size ? `?${query}` : ""}${location.hash}`,
    );
  }
  return config;
}

/**
 * Connect either a specific Demo Account (or custom account string) or open the Wallet Modal.
 */
async function connect(targetAccount?: string, typeOverride?: "demo" | "meteor" | "my-near-wallet" | "extension") {
  if (targetAccount) {
    account = targetAccount.trim();
    const isDemoRole =
      Object.values(config?.roles ?? {}).includes(account) ||
      Object.keys(config?.roles ?? {}).includes(account) ||
      account.endsWith(".test.near");
    walletType = typeOverride ?? (isDemoRole ? "demo" : "extension");
    localStorage.setItem(SANDBOX_STORAGE_KEY, account);
    localStorage.setItem(WALLET_TYPE_KEY, walletType);
    emitWallet();
    return account;
  }
  await ready.catch(() => null);
  window.dispatchEvent(new CustomEvent("optionality-open-wallet-modal"));
  return account;
}

/**
 * Connect directly to a browser wallet extension (Meteor Wallet or MyNearWallet) via NEAR Wallet Selector.
 * Uses contractId: "" so connecting never locks 0.25 NEAR on-chain for a FunctionCall key,
 * and reuses any existing authorized wallet session so the user does not have to re-approve on every visit.
 */
async function connectExtension(walletId: "meteor-wallet" | "my-near-wallet" = "meteor-wallet") {
  await ready.catch(() => null);
  await ensureSelector();
  if (!selector) throw new Error("NEAR Wallet Selector is unavailable in this browser");

  // Clear disconnected flag before initiating extension sign-in
  if (localStorage.getItem(SANDBOX_STORAGE_KEY) === "__disconnected__") {
    localStorage.removeItem(SANDBOX_STORAGE_KEY);
  }

  let signedAcct: string | null = null;
  let lastError: any = null;

  try {
    const w = await selector.wallet(walletId);
    // 1. Check if the wallet already has an active authorized session in localStorage / extension
    const existingAccounts = await (w as any).getAccounts?.().catch(() => []);
    const existingAcct =
      existingAccounts?.[0]?.accountId ??
      (walletId === "meteor-wallet" ? readMeteorAuthAccount() : null);

    if (existingAcct) {
      signedAcct = existingAcct;
    } else {
      // 2. Sign in with empty contractId ("") -> 0 NEAR cost (no 0.25 NEAR FunctionCall access key deposit required)
      const accounts = await (w as any).signIn({ contractId: "", methodNames: [] });
      signedAcct =
        accounts?.[0]?.accountId ??
        selector.store.getState().accounts.find((a: { active: boolean }) => a.active)?.accountId ??
        readMeteorAuthAccount();
    }
  } catch (err1: any) {
    lastError = err1;
    const authAcct = readMeteorAuthAccount();
    if (authAcct) signedAcct = authAcct;
  }

  if (signedAcct) {
    account = signedAcct;
    walletType = walletId === "meteor-wallet" ? "meteor" : "my-near-wallet";
    localStorage.setItem(SANDBOX_STORAGE_KEY, account);
    localStorage.setItem(WALLET_TYPE_KEY, walletType);
    emitWallet();
    return signedAcct;
  }

  throw new Error(
    lastError?.message ||
      (walletId === "meteor-wallet"
        ? "Meteor Wallet sign-in did not complete"
        : "MyNearWallet sign-in did not complete"),
  );
}

async function disconnect() {
  const prevType = walletType;
  account = null;
  walletType = null;
  localStorage.setItem(SANDBOX_STORAGE_KEY, "__disconnected__");
  localStorage.removeItem(WALLET_TYPE_KEY);
  localStorage.removeItem("near_app_meteor_wallet_auth_key");
  localStorage.removeItem("meteor_wallet_auth_key");
  localStorage.removeItem("default_meteor_wallet_auth_key");
  emitWallet();
  try {
    if (selector && (prevType === "meteor" || prevType === "my-near-wallet" || prevType === "extension")) {
      const w = await selector.wallet().catch(() => null);
      if (w) await w.signOut().catch(() => null);
    }
  } catch {}
}

async function openSelectorModal() {
  await ready;
  await ensureSelector();
  if (modal) {
    modal.show();
  }
}

async function submit(body: Record<string, unknown>) {
  await ready;
  const testnet = config.network === "testnet";
  if (!account) {
    window.dispatchEvent(new CustomEvent("optionality-open-wallet-modal"));
    throw new Error("Connect your NEAR wallet or select a demo account first, then try again");
  }
  const response = await fetch(testnet ? "/plan" : "/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, account }),
  });
  const plan = await response.json();
  if (!response.ok || !plan.ok) throw new Error(plan.error ?? "the venue refused the request");
  if (!testnet || !plan.transactions?.length) return plan;
  const results = await (await selector!.wallet()).signAndSendTransactions({
    transactions: plan.transactions,
    callbackUrl: location.href,
  });
  if (!results) return { ok: true, message: "complete the transaction in your wallet" };
  if (
    results.some((result: any) => typeof result.status === "object" && "Failure" in result.status)
  )
    throw new Error("transaction failed; inspect its receipt in your wallet");
  return {
    ok: true,
    message: plan.message,
    hashes: results.map((r: any) => r.transaction.hash),
  };
}

async function claim() {
  await ready;
  if (!account) {
    window.dispatchEvent(new CustomEvent("optionality-open-wallet-modal"));
    throw new Error("Connect your wallet before topping up USDT");
  }
  if (config.network !== "testnet") {
    const response = await fetch("/demo/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error ?? "top up failed");
    return result;
  }
  const response = await fetch("/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error ?? "faucet unavailable");
  return result;
}

const ready = init();
(window as any).optionalityWallet = {
  ready,
  connect,
  connectExtension,
  disconnect,
  openSelectorModal,
  submit,
  claim,
  icons: WALLET_ICONS,
  get account() {
    return account;
  },
  get walletType() {
    return walletType;
  },
  get extensionDetected() {
    return isExtensionDetected();
  },
  get config() {
    return config;
  },
  get testnet() {
    return config?.network === "testnet";
  },
};
ready.catch((error) =>
  window.dispatchEvent(
    new CustomEvent("optionality-wallet-result", { detail: { error: error.message } }),
  ),
);
