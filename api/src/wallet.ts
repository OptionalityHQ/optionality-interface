/** Browser-only NEAR Wallet Selector integration. Private keys remain in the wallet. */
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
// @ts-ignore -- bundled as CSS by esbuild
import "@near-wallet-selector/modal-ui/styles.css";

let selector: Awaited<ReturnType<typeof setupWalletSelector>> | null = null;
let config: any;
let account: string | null = null;
let modal: ReturnType<typeof setupModal>;

async function init() {
  config = await (await fetch("/config", { cache: "no-store" })).json();
  if (config.network !== "testnet") return config;
  selector = await setupWalletSelector({ network: { networkId: "testnet", nodeUrl: config.rpc, helperUrl: "https://helper.testnet.near.org", explorerUrl: "https://testnet.nearblocks.io", indexerUrl: "https://api-testnet.nearblocks.io/v1" }, modules: [setupMyNearWallet()] });
  modal = setupModal(selector, { contractId: config.contracts.options });
  const update = () => {
    account = selector!.store.getState().accounts.find((a: { active: boolean }) => a.active)?.accountId ?? null;
    window.dispatchEvent(new CustomEvent("optionality-wallet", { detail: { account } }));
  };
  selector.store.observable.subscribe(update);
  update();
  // Wallet redirects are pending until their transaction outcomes are checked.
  const query = new URLSearchParams(location.search);
  const hashes = query.get("transactionHashes");
  const error = query.get("errorMessage");
  if (hashes || error) {
    window.dispatchEvent(new CustomEvent("optionality-wallet-result", { detail: { hashes, error } }));
    query.delete("transactionHashes"); query.delete("errorCode"); query.delete("errorMessage");
    history.replaceState(null, "", `${location.pathname}${query.size ? `?${query}` : ""}${location.hash}`);
  }
  return config;
}

async function connect() {
  await ready;
  if (!selector) return;
  if (account) {
    if (confirm(`Disconnect ${account}?`)) await (await selector.wallet()).signOut();
  } else modal.show();
}

async function submit(body: Record<string, unknown>) {
  await ready;
  const testnet = config.network === "testnet";
  if (testnet && !account) { modal.show(); throw new Error("connect your NEAR testnet wallet, then try again"); }
  const response = await fetch(testnet ? "/plan" : "/action", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(testnet ? { ...body, account } : body),
  });
  const plan = await response.json();
  if (!response.ok || !plan.ok) throw new Error(plan.error ?? "the venue refused the request");
  if (!testnet || !plan.transactions.length) return plan;
  const results = await (await selector!.wallet()).signAndSendTransactions({ transactions: plan.transactions, callbackUrl: location.href });
  if (!results) return { ok: true, message: "complete the transaction in your wallet" };
  if (results.some((result: any) => typeof result.status === "object" && "Failure" in result.status)) throw new Error("transaction failed; inspect its receipt in your wallet");
  return { ok: true, message: plan.message, hashes: results.map((r: any) => r.transaction.hash) };
}

async function claim() {
  await ready;
  if (config.network !== "testnet") return (await fetch("/demo/reset", { method: "POST" })).json();
  if (!account) { modal.show(); throw new Error("connect your testnet wallet before claiming tokens"); }
  const response = await fetch("/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error ?? "faucet unavailable");
  return result;
}

const ready = init();
(window as any).optionalityWallet = { ready, connect, submit, claim, get account() { return account; }, get testnet() { return config?.network === "testnet"; } };
ready.catch((error) => window.dispatchEvent(new CustomEvent("optionality-wallet-result", { detail: { error: error.message } })));
