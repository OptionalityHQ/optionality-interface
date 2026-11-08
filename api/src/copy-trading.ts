/**
 * Private Copy Trading Subscription & Leaderboard data models.
 * Backed by private-ledger specifications with enclave attestation metadata.
 * CEX-style top traders: nicknames only (zero wallet exposure), X & Telegram
 * contact links, volume, ROI, 1-word strategy, and copy-trader counts.
 */

export type OneWordStrategy =
  | "bull"
  | "bear"
  | "cross-bull"
  | "cross-bear"
  | "neutral"
  | "volatility";

export interface TraderContacts {
  x: string | null;
  telegram: string | null;
}

export interface LeaderStrategy {
  id: string;
  rank: number;
  nickname: string;
  name: string; // alias for nickname / display compatibility
  avatarUrl?: string;
  nftBadge?: string;
  tagline: string;
  asset: "ETH" | "BTC" | "NEAR" | "ALL";
  strategy: OneWordStrategy; // strictly 1-word strategy
  style: "Delta-Neutral" | "Income Harvesting" | "Tail Hedge" | "Volatility Arbitrage";
  contacts: TraderContacts;
  volumeUsd: number;
  roiPct: number;
  copyTradersCount: number;
  maxCopyTraders: number;
  price: number; // monthly subscription fee in USDT / bUSD
  periodMs: number;
  subscribersCount: number;
  aumUsd: number;
  sharpeRatio: number;
  performance: {
    closedTrades: number;
    openPositions: number;
    winRate: number; // percentage (e.g. 88.2)
    entryPremiums: number;
    realizedPnl: number;
    roiPct: number;
    volumeUsd: number;
  };
  enclaveVerified: boolean;
  enclaveTaskId: number;
}

export interface CopyMandate {
  id: string;
  account: string;
  profileId: string;
  maxContracts: number;
  maxEachUsd: number;
  maxTotalUsd: number;
  spentUsd: number;
  maxExitLossBps: number; // e.g. 1500 = 15% max haircut
  asset: "ETH" | "BTC" | "NEAR" | "ALL";
  maxExpiryDays: number;
  subscriptionMonths?: number;
  subscriptionPaidUsd?: number;
  renewsAt?: number;
  copiedPnlUsd?: number;
  copiedRoiPct?: number;
  copiedTrades?: number;
  active: boolean;
  createdAt: number;
}

export interface CopyJournalEntry {
  id: string;
  profileId: string;
  strategyName: string;
  traderNickname: string;
  strategyWord: OneWordStrategy;
  action: "Auto-Buy" | "Auto-Exit" | "Settlement Payout";
  asset: "ETH" | "BTC" | "NEAR";
  kind: "Call" | "Put";
  strike: string;
  contracts: number;
  premium: number;
  outcome: string;
  timestamp: number;
  enclaveSeq: number;
}

const DEFAULT_LEADERS: LeaderStrategy[] = [
  {
    id: "convexity-long-vol",
    rank: 1,
    nickname: "KaitoVol",
    name: "KaitoVol",
    avatarUrl: "/images/nft-ape-3.png",
    nftBadge: "BAYC #2087",
    tagline: "Breakout call spreads & low-IV wing sweeps ahead of macro catalysts",
    asset: "BTC",
    strategy: "cross-bull",
    style: "Volatility Arbitrage",
    contacts: {
      x: "https://x.com/KaitoVol_opt",
      telegram: "https://t.me/KaitoVolSignals",
    },
    volumeUsd: 4_820_000,
    roiPct: 184.6,
    copyTradersCount: 312,
    maxCopyTraders: 400,
    price: 35,
    periodMs: 30 * 86_400_000,
    subscribersCount: 312,
    aumUsd: 640_000,
    sharpeRatio: 3.42,
    performance: {
      closedTrades: 142,
      openPositions: 2,
      winRate: 86.4,
      entryPremiums: 69_800,
      realizedPnl: 128_850,
      roiPct: 184.6,
      volumeUsd: 4_820_000,
    },
    enclaveVerified: true,
    enclaveTaskId: 20887,
  },
  {
    id: "algo-eth-harvester",
    rank: 2,
    nickname: "VegaWhale",
    name: "VegaWhale",
    avatarUrl: "/images/nft-penguin-2.png",
    nftBadge: "Pudgy #88",
    tagline: "High-conviction directional ETH vertical call spreads on daily 00:00 UTC closes",
    asset: "ETH",
    strategy: "bull",
    style: "Income Harvesting",
    contacts: {
      x: "https://x.com/VegaWhale_eth",
      telegram: null, // Telegram unavailable -> light gray
    },
    volumeUsd: 3_490_000,
    roiPct: 143.4,
    copyTradersCount: 248,
    maxCopyTraders: 300,
    price: 25,
    periodMs: 30 * 86_400_000,
    subscribersCount: 248,
    aumUsd: 495_000,
    sharpeRatio: 2.95,
    performance: {
      closedTrades: 114,
      openPositions: 3,
      winRate: 84.2,
      entryPremiums: 58_000,
      realizedPnl: 83_170,
      roiPct: 143.4,
      volumeUsd: 3_490_000,
    },
    enclaveVerified: true,
    enclaveTaskId: 20887,
  },
  {
    id: "skew-arb-matrix",
    rank: 3,
    nickname: "SatoshiHedge",
    name: "SatoshiHedge",
    avatarUrl: "/images/nft-ape-4.png",
    nftBadge: "BAYC #3749",
    tagline: "Systematic downside put spreads capturing skew dislocations with zero liquidation risk",
    asset: "ALL",
    strategy: "cross-bear",
    style: "Tail Hedge",
    contacts: {
      x: null, // X unavailable -> light gray
      telegram: "https://t.me/SatoshiHedgeDesk",
    },
    volumeUsd: 2_760_000,
    roiPct: 118.2,
    copyTradersCount: 194,
    maxCopyTraders: 250,
    price: 20,
    periodMs: 30 * 86_400_000,
    subscribersCount: 194,
    aumUsd: 380_000,
    sharpeRatio: 2.78,
    performance: {
      closedTrades: 93,
      openPositions: 2,
      winRate: 90.6,
      entryPremiums: 46_400,
      realizedPnl: 54_840,
      roiPct: 118.2,
      volumeUsd: 2_760_000,
    },
    enclaveVerified: true,
    enclaveTaskId: 20887,
  },
  {
    id: "trader-delta-neutral",
    rank: 4,
    nickname: "DeltaApex",
    name: "DeltaApex",
    avatarUrl: "/images/nft-penguin-3.png",
    nftBadge: "Pudgy #420",
    tagline: "OTM put spread protection & intraday volatility scalping across ETH ladders",
    asset: "ETH",
    strategy: "bear",
    style: "Delta-Neutral",
    contacts: {
      x: "https://x.com/DeltaApexTrader",
      telegram: "https://t.me/DeltaApexAlpha",
    },
    volumeUsd: 2_140_000,
    roiPct: 94.8,
    copyTradersCount: 164,
    maxCopyTraders: 250,
    price: 20,
    periodMs: 30 * 86_400_000,
    subscribersCount: 164,
    aumUsd: 310_000,
    sharpeRatio: 2.61,
    performance: {
      closedTrades: 88,
      openPositions: 2,
      winRate: 88.2,
      entryPremiums: 38_500,
      realizedPnl: 36_500,
      roiPct: 94.8,
      volumeUsd: 2_140_000,
    },
    enclaveVerified: true,
    enclaveTaskId: 20887,
  },
  {
    id: "gamma-scalp-prime",
    rank: 5,
    nickname: "GammaSniper",
    name: "GammaSniper",
    avatarUrl: "/images/nft-ape-1.png",
    nftBadge: "BAYC #8817",
    tagline: "Short-tenor intraday momentum spreads around key liquidity levels",
    asset: "BTC",
    strategy: "bull",
    style: "Volatility Arbitrage",
    contacts: {
      x: null, // both unavailable -> both light gray
      telegram: null,
    },
    volumeUsd: 1_580_000,
    roiPct: 81.5,
    copyTradersCount: 118,
    maxCopyTraders: 200,
    price: 15,
    periodMs: 30 * 86_400_000,
    subscribersCount: 118,
    aumUsd: 215_000,
    sharpeRatio: 2.34,
    performance: {
      closedTrades: 76,
      openPositions: 1,
      winRate: 80.3,
      entryPremiums: 29_200,
      realizedPnl: 23_800,
      roiPct: 81.5,
      volumeUsd: 1_580_000,
    },
    enclaveVerified: true,
    enclaveTaskId: 20887,
  },
  {
    id: "zero-liq-macro",
    rank: 6,
    nickname: "ZeroLiqMacro",
    name: "ZeroLiqMacro",
    avatarUrl: "/images/nft-penguin-4.png",
    nftBadge: "Pudgy #777",
    tagline: "Cross-asset ETH, BTC & NEAR macro swing spreads held to 12:00 AM UTC+0 settlement",
    asset: "ALL",
    strategy: "cross-bull",
    style: "Income Harvesting",
    contacts: {
      x: "https://x.com/ZeroLiqMacro",
      telegram: "https://t.me/ZeroLiqMacro",
    },
    volumeUsd: 1_190_000,
    roiPct: 68.9,
    copyTradersCount: 92,
    maxCopyTraders: 150,
    price: 15,
    periodMs: 30 * 86_400_000,
    subscribersCount: 92,
    aumUsd: 175_000,
    sharpeRatio: 2.18,
    performance: {
      closedTrades: 54,
      openPositions: 1,
      winRate: 83.3,
      entryPremiums: 22_000,
      realizedPnl: 15_160,
      roiPct: 68.9,
      volumeUsd: 1_190_000,
    },
    enclaveVerified: true,
    enclaveTaskId: 20887,
  },
  {
    id: "near-penguin-alpha",
    rank: 7,
    nickname: "PudgyNear",
    name: "PudgyNear",
    avatarUrl: "/images/nft-penguin-1.jpg",
    nftBadge: "Pudgy #108",
    tagline: "Native NEAR ecosystem momentum spreads & volatility capture around 00:00 UTC",
    asset: "NEAR",
    strategy: "bull",
    style: "Income Harvesting",
    contacts: {
      x: "https://x.com/PudgyNear_opt",
      telegram: "https://t.me/PudgyNearDesk",
    },
    volumeUsd: 940_000,
    roiPct: 62.4,
    copyTradersCount: 74,
    maxCopyTraders: 150,
    price: 12,
    periodMs: 30 * 86_400_000,
    subscribersCount: 74,
    aumUsd: 142_000,
    sharpeRatio: 2.11,
    performance: {
      closedTrades: 48,
      openPositions: 2,
      winRate: 81.2,
      entryPremiums: 18_400,
      realizedPnl: 11_480,
      roiPct: 62.4,
      volumeUsd: 940_000,
    },
    enclaveVerified: true,
    enclaveTaskId: 20887,
  },
];

// In-memory mandate store keyed by `${account}:${profileId}`
const userMandates = new Map<string, CopyMandate>();

// Pre-populate demo user strategies so "My Strategies" has active traders immediately
userMandates.set("you:convexity-long-vol", {
  id: "mandate-demo-1",
  account: "you",
  profileId: "convexity-long-vol",
  maxContracts: 3,
  maxEachUsd: 150,
  maxTotalUsd: 1000,
  spentUsd: 340.0,
  maxExitLossBps: 1500,
  asset: "BTC",
  maxExpiryDays: 7,
  subscriptionMonths: 1,
  subscriptionPaidUsd: 35,
  renewsAt: Date.now() + 26 * 86_400_000,
  copiedPnlUsd: 218.4,
  copiedRoiPct: 64.2,
  copiedTrades: 9,
  active: true,
  createdAt: Date.now() - 4 * 86_400_000,
});

userMandates.set("you:trader-delta-neutral", {
  id: "mandate-demo-2",
  account: "you",
  profileId: "trader-delta-neutral",
  maxContracts: 2,
  maxEachUsd: 100,
  maxTotalUsd: 500,
  spentUsd: 142.5,
  maxExitLossBps: 1500,
  asset: "ETH",
  maxExpiryDays: 7,
  subscriptionMonths: 1,
  subscriptionPaidUsd: 20,
  renewsAt: Date.now() + 27 * 86_400_000,
  copiedPnlUsd: 68.5,
  copiedRoiPct: 48.1,
  copiedTrades: 6,
  active: true,
  createdAt: Date.now() - 3 * 86_400_000,
});

export function getLeaderboard(assetFilter?: string): LeaderStrategy[] {
  if (!assetFilter || assetFilter === "ALL") return DEFAULT_LEADERS;
  return DEFAULT_LEADERS.filter((l) => l.asset === assetFilter || l.asset === "ALL");
}

const LEADER_ALIASES: Record<string, string> = {
  "trader-kaito": "convexity-long-vol",
  "trader-vega": "algo-eth-harvester",
  "trader-satoshi": "skew-arb-matrix",
  "trader-delta": "trader-delta-neutral",
  "trader-gamma": "gamma-scalp-prime",
  "trader-zeroliq": "zero-liq-macro",
};

export function getLeaderById(id: string): LeaderStrategy | undefined {
  const canonical = LEADER_ALIASES[id] ?? id;
  return DEFAULT_LEADERS.find(
    (l) => l.id === canonical || l.nickname.toLowerCase() === canonical.toLowerCase()
  );
}

export function getUserMandates(account: string): CopyMandate[] {
  const result: CopyMandate[] = [];
  for (const m of userMandates.values()) {
    if (m.account === account) {
      result.push({ ...m });
    }
  }
  // If visitor has no custom mandates yet, provide demo template mandates as initial state
  if (result.length === 0) {
    for (const m of userMandates.values()) {
      if (m.account === "you") result.push({ ...m, account });
    }
  }
  return result;
}

export function createOrUpdateMandate(
  account: string,
  params: {
    profileId: string;
    maxContracts?: number;
    maxEachUsd?: number;
    maxTotalUsd?: number;
    maxExitLossBps?: number;
    asset?: "ETH" | "BTC" | "NEAR" | "ALL";
    maxExpiryDays?: number;
    subscriptionMonths?: number;
    active?: boolean;
  }
): CopyMandate {
  const leader = getLeaderById(params.profileId);
  if (!leader) throw new Error("Trader strategy not found");

  const key = `${account}:${params.profileId}`;
  const existing = userMandates.get(key) ?? userMandates.get(`you:${params.profileId}`);
  const months = params.subscriptionMonths ?? existing?.subscriptionMonths ?? 1;

  const mandate: CopyMandate = {
    id: existing?.id ?? `mandate-${Date.now().toString(36)}`,
    account,
    profileId: params.profileId,
    maxContracts: params.maxContracts ?? existing?.maxContracts ?? 2,
    maxEachUsd: params.maxEachUsd ?? existing?.maxEachUsd ?? 100,
    maxTotalUsd: params.maxTotalUsd ?? existing?.maxTotalUsd ?? 500,
    spentUsd: existing?.spentUsd ?? 0,
    maxExitLossBps: params.maxExitLossBps ?? existing?.maxExitLossBps ?? 1500,
    asset: params.asset ?? existing?.asset ?? leader.asset,
    maxExpiryDays: params.maxExpiryDays ?? existing?.maxExpiryDays ?? 7,
    subscriptionMonths: months,
    subscriptionPaidUsd: leader.price * months,
    renewsAt: existing?.renewsAt ?? Date.now() + months * 30 * 86_400_000,
    copiedPnlUsd: existing?.copiedPnlUsd ?? 0,
    copiedRoiPct: existing?.copiedRoiPct ?? 0,
    copiedTrades: existing?.copiedTrades ?? 0,
    active: params.active ?? true,
    createdAt: existing?.createdAt ?? Date.now(),
  };

  userMandates.set(key, mandate);
  if (account !== "you") {
    userMandates.set(`you:${params.profileId}`, { ...mandate, account: "you" });
  }
  if (!existing && mandate.active) {
    leader.copyTradersCount += 1;
    leader.subscribersCount = leader.copyTradersCount;
  }
  return mandate;
}

export function revokeMandate(account: string, profileId: string): boolean {
  const key = `${account}:${profileId}`;
  const existing = userMandates.get(key) ?? userMandates.get(`you:${profileId}`);
  if (!existing) return false;
  existing.active = false;
  userMandates.set(key, { ...existing, account, active: false });
  if (account !== "you") {
    userMandates.set(`you:${profileId}`, { ...existing, account: "you", active: false });
  }
  return true;
}

export function getCopyJournal(_account?: string): CopyJournalEntry[] {
  const now = Date.now();
  return [
    {
      id: "entry-1",
      profileId: "convexity-long-vol",
      strategyName: "KaitoVol",
      traderNickname: "KaitoVol",
      strategyWord: "cross-bull",
      action: "Auto-Buy",
      asset: "BTC",
      kind: "Call",
      strike: "74000/75000",
      contracts: 2,
      premium: 64.0,
      outcome: "Executed in SGX enclave (Seq #4812)",
      timestamp: now - 18_000_000,
      enclaveSeq: 4812,
    },
    {
      id: "entry-2",
      profileId: "trader-delta-neutral",
      strategyName: "DeltaApex",
      traderNickname: "DeltaApex",
      strategyWord: "bear",
      action: "Auto-Buy",
      asset: "ETH",
      kind: "Put",
      strike: "2225/2325",
      contracts: 2,
      premium: 48.5,
      outcome: "Executed in SGX enclave (Seq #4790)",
      timestamp: now - 54_000_000,
      enclaveSeq: 4790,
    },
    {
      id: "entry-3",
      profileId: "convexity-long-vol",
      strategyName: "KaitoVol",
      traderNickname: "KaitoVol",
      strategyWord: "cross-bull",
      action: "Settlement Payout",
      asset: "BTC",
      kind: "Call",
      strike: "73000/74000",
      contracts: 2,
      premium: 52.0,
      outcome: "Settled at 00:00 UTC · +138% ROI",
      timestamp: now - 142_000_000,
      enclaveSeq: 4621,
    },
  ];
}
