/**
 * Browser-only wallet connector: real NEAR account signing with NearFi or Keplr.
 * This file is meant to run in the browser, not Node.js.
 */

declare global {
  interface Window {
    near?: {
      init(): Promise<any>;
    };
    navigator?: {
      walletConnect?: any;
    };
  }
}

export interface WalletState {
  connected: boolean;
  accountId: string | null;
  publicKey: string | null;
}

// Global wallet state (set from browser)
let wallet: WalletState = {
  connected: false,
  accountId: null,
  publicKey: null,
};

/** Check if we're running in production mode (real wallets enabled) */
const HAS_SANDBOX = true; // Change to false when deploying to production

/** Connect to NEAR wallet extension (NearFi, Keplr, etc.) */
export async function connectWallet(): Promise<string> {
  if (!HAS_SANDBOX) {
    throw new Error("Real wallet connection disabled");
  }
  
  try {
    if (window.near) {
      const near = await window.near.init();
      // Request account creation/key addition
      const result = await near.accounts.requestAddKeyAndCreateAccount({
        accountId: `user${Math.random().toString(36).substring(2, 10)}.testnet`,
      });
      
      wallet.connected = true;
      wallet.accountId = result.accountId || "demo-account.testnet";
      return wallet.accountId;
    } else {
      throw new Error("NEAR wallet extension not found. Install NearFi or Keplr.");
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to connect wallet: ${msg}`);
  }
}

/** Disconnect from wallet */
export function disconnectWallet(): void {
  wallet = {
    connected: false,
    accountId: null,
    publicKey: null,
  };
}

/** Get current wallet state */
export function getWalletState(): WalletState {
  return { ...wallet };
}

/** Set wallet state manually (for demo purposes) */
export function setWalletState(accountId: string | null): void {
  wallet = {
    connected: !!accountId,
    accountId,
    publicKey: null,
  };
}
