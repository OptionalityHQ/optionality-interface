import { contractQuantity } from "./chart-model.ts";
import { sceneNode as node, paintScene } from "./chart-canvas.ts";
import { createChartClock } from "./chart-clock.ts";
import {
  calcEMA,
  calcBollingerBands,
  calcVWAP,
  createSmoothValue,
} from "./indicators.ts";
import {
  zoomAxis,
  panAxis,
  listedStrike,
  type AxisRange,
} from "./chart-navigation.ts";

type Kind = "Call" | "Put";
type Series = {
  seriesId: number;
  asset: string;
  kind: Kind;
  low: number;
  high: number;
  expiryNs: number;
  settlement: string;
};
type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type View = { time: AxisRange; price: AxisRange };
let asset = "ETH",
  interval = "1m",
  current: any = null;
let series: Series[] = [],
  candles: Candle[] = [];
let expiry: number | null = null,
  customExpiryMinutes: number | null = null,
  selected: Series | null = null;
let draft: { price: number; kind: Kind; quantity: number } | null = null;
let latestQuote: any = null,
  quoteSequence = 0,
  quoteTimer: ReturnType<typeof setTimeout> | undefined;
let busy = false,
  generation = 0,
  seriesAt = 0,
  loadingSeries = false,
  loadingCandles = false,
  candlesAt = 0;
let historyRetryAt = 0;
let historyLoading = false,
  historyEnd: number | null = null,
  historyNotice = "";
let view: View | null = null,
  follow = true,
  renderFrame = 0;
let plot = {
  left: 14,
  right: 900,
  top: 35,
  bottom: 420,
  width: 1000,
  height: 480,
};
let crosshair: { x: number; y: number } | null = null;
let gesture: {
  x: number;
  y: number;
  startX: number;
  startY: number;
  view: View;
  moved: boolean;
  axis: boolean;
} | null = null;
const pointers = new Map<number, { x: number; y: number }>();
let pinch: {
  distance: number;
  view: View;
  anchorTime: number;
  anchorPrice: number;
} | null = null;
const COLOR = { Call: "#14e091", Put: "#f03c56" };
const chartIconSvg = (sym: string, s = 13) => {
  const k = sym.toUpperCase();
  if (k === "ETH")
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="11" fill="#627EEA"/><path d="M12 4.5v5.55l4.7 2.1L12 4.5z" fill="#C0CBF6"/><path d="M12 4.5L7.3 12.15l4.7-2.1V4.5z" fill="#FFF"/><path d="M12 15.75v3.75l4.7-6.5-4.7 2.75z" fill="#C0CBF6"/><path d="M12 19.5v-3.75L7.3 13l4.7 6.5z" fill="#FFF"/><path d="M12 14.85l4.7-2.7-4.7-2.1v4.8z" fill="#8197EE"/><path d="M7.3 12.15l4.7 2.7v-4.8l-4.7 2.1z" fill="#C0CBF6"/></svg>`;
  if (k === "BTC")
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="11" fill="#F7931A"/><path d="M15.9 10.6c.2-1.3-.8-2-2.2-2.5l.4-1.8-1.1-.3-.4 1.7c-.3-.1-.6-.1-.9-.2l.4-1.7-1.1-.3-.4 1.8c-.2-.1-.5-.1-.7-.2l-1.5-.4-.3 1.2s.8.2.8.2c.4.1.5.4.5.6l-.5 2.1c.1 0 .1 0 .2.1l-.2 0-.8 3c-.1.2-.3.4-.6.3 0 0-.8-.2-.8-.2l-.5 1.3 1.4.4c.3.1.5.1.8.2l-.5 1.8 1.1.3.4-1.8c.3.1.6.2.9.2l-.4 1.8 1.1.3.5-1.8c1.9.4 3.3.2 3.9-1.5.5-1.4 0-2.2-1-2.7.7-.2 1.2-.6 1.4-1.6zm-2.5 3.5c-.3 1.4-2.7.6-3.5.4l.6-2.5c.8.2 3.2.6 2.9 2.1zm.3-3.5c-.3 1.2-2.3.6-2.9.5l.6-2.2c.6.1 2.6.4 2.3 1.7z" fill="#FFF"/></svg>`;
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="11" fill="#26A17B"/><path d="M13.3 12.8v-.02c-.1 0-.6.04-1.3.04-.7 0-1.15-.03-1.32-.04v.02c-2.6-.11-4.54-.56-4.54-1.1s1.94-.98 4.54-1.1v1.75c.18.01.64.05 1.33.05.78 0 1.2-.04 1.29-.05v-1.75c2.6.12 4.53.56 4.53 1.1s-1.93.99-4.53 1.1zm0-2.38V8.85h3.62V6.5H7.08v2.35h3.6v1.57c-2.93.13-5.14.71-5.14 1.4s2.21 1.27 5.14 1.4v5.03h2.62v-5.03c2.92-.13 5.13-.71 5.13-1.4s-2.21-1.27-5.13-1.4z" fill="#FFF"/></svg>`;
};
type MarketStats = {
  lastPrice: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  volumeUsd24h: number;
  trades24h: number | null;
};
let ticks: Array<{ time: number; price: number }> = [];
let marketStats: MarketStats | null = null;
let indicators = { ema: true, bb: false, vwap: true };
const smoother = createSmoothValue(95);
let smoothSpot: number | null = null;
let animating = false;
let ticksLoading = false;
let canvas: HTMLCanvasElement | null = null;
let displayNow = Date.now();
let lastPaintTime = 0;
let lastPaintPrice = 0;
let lastPaintSecond = 0;
let lastStatsText = "";
let lastPositionsSig = "";
let indicatorCache: {
  source: Candle[];
  lastClose: number;
  lastHigh: number;
  lastLow: number;
  len: number;
  ema: Array<number | null>;
  vwap: Array<number | null>;
  bands: ReturnType<typeof calcBollingerBands>;
} | null = null;
const displayClock = createChartClock();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const $ = (id: string) => document.getElementById(id)!;
const money = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 2 : n < 1 ? 8 : 4,
  }).format(n);
const step = () =>
  interval === "1s"
    ? 1000
    : interval === "1m"
      ? 60000
      : interval === "5m"
        ? 300000
        : interval === "15m"
          ? 900000
          : interval === "1h"
            ? 3600000
            : interval === "7D"
              ? 14400000
              : interval === "1D"
                ? 86400000
                : interval === "1W"
                  ? 604800000
                  : 3600000;

const detectedTimeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();
const localOffsetMinutes = (() => {
  try {
    const off = -new Date().getTimezoneOffset();
    return Number.isFinite(off) ? off : 0;
  } catch {
    return 0;
  }
})();
const formatOffsetLabel = (offsetMin: number) => {
  if (!Number.isFinite(offsetMin) || offsetMin === 0) return "UTC+0";
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m ? `UTC${sign}${h}:${String(m).padStart(2, "0")}` : `UTC${sign}${h}`;
};
const localOffsetLabel = formatOffsetLabel(localOffsetMinutes);

const TZ_OFFSETS = [
  -720, -660, -600, -540, -480, -420, -360, -300, -240, -180, -120, -60,
  0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 540, 570, 600, 660, 720, 780, 840,
];

let tzMode: string = (() => {
  try {
    const saved = localStorage.getItem("optionality_tz_mode");
    if (saved) return saved;
    const legacy = localStorage.getItem("optionality_use_local_tz");
    if (legacy === "false" || legacy === "0") return "0";
    return "local";
  } catch {
    return "local";
  }
})();

const activeOffsetMinutes = (): number => {
  if (tzMode === "local") return localOffsetMinutes;
  const parsed = Number(tzMode);
  return Number.isFinite(parsed) ? parsed : 0;
};
const tzLabel = () => formatOffsetLabel(activeOffsetMinutes());

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const date = (ms: number) => {
  const d = new Date(ms + activeOffsetMinutes() * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())} ${MONTHS_SHORT[d.getUTCMonth()] ?? "Jan"} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const timeOfDay = (ms: number, withSeconds = false) => {
  const d = new Date(ms + activeOffsetMinutes() * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return withSeconds
    ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const toDatetimeInput = (ms: number) => {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms + activeOffsetMinutes() * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const parseDatetimeInput = (raw: string) => {
  if (!raw) return NaN;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? `${raw}:00Z` : raw.endsWith("Z") ? raw : `${raw}Z`;
  const utcMs = Date.parse(normalized);
  if (!Number.isFinite(utcMs)) return NaN;
  return utcMs - activeOffsetMinutes() * 60_000;
};

const fmtQty = (q: number) => {
  if (!Number.isFinite(q)) return "1";
  return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(4)));
};
const isValidOrderQuantity = (q: unknown): q is number =>
  typeof q === "number" && Number.isFinite(q) && q >= 0.0001 && q <= 100000;

let sizingMode: "usdt" | "contracts" = "usdt";
let targetUsdSpend: number | null = 25;
let bottomPanelTab: "open" | "history" = "open";

type DraftDragState = {
  mode: "both" | "price" | "expiry";
  startX: number;
  startY: number;
  moved: boolean;
};
let draftDrag: DraftDragState | null = null;
let draftDragQuoteTimer: ReturnType<typeof setTimeout> | undefined;

type PositionHitRegion = {
  pos: any;
  yStrike: number;
  yBreakEven: number;
  yHigh: number;
  yLow: number;
  xStart: number;
  xEnd: number;
  badgeRect: { x: number; y: number; width: number; height: number } | null;
};
let positionHitRegions: PositionHitRegion[] = [];
let hoveredPositionKey: string | null = null;
let popupPosition: any | null = null;

const posKeyOf = (pos: any) =>
  `${pos?.seriesKey ?? pos?.asset ?? ""}:${pos?.ticketId ?? ""}:${pos?.low ?? ""}:${pos?.high ?? ""}`;

function computePositionBreakEven(pos: any): number {
  const kind: Kind = pos?.kind === "Put" ? "Put" : "Call";
  const low = Number(pos?.low ?? 0);
  const high = Number(pos?.high ?? 0);
  const contracts = Math.max(0.0001, Number(pos?.contracts || 1));
  const unitCost = Math.max(0, Number(pos?.cost ?? 0) / contracts);
  return kind === "Call"
    ? Math.min(high, low + unitCost)
    : Math.max(low, high - unitCost);
}

function hitTestPosition(p: { x: number; y: number }): any | null {
  for (let i = positionHitRegions.length - 1; i >= 0; i--) {
    const reg = positionHitRegions[i];
    if (
      reg.badgeRect &&
      p.x >= reg.badgeRect.x &&
      p.x <= reg.badgeRect.x + reg.badgeRect.width &&
      p.y >= reg.badgeRect.y &&
      p.y <= reg.badgeRect.y + reg.badgeRect.height
    ) {
      return reg.pos;
    }
    // Hit along the horizontal strike line or break-even line up to its expiry endpoint
    if (
      p.x >= reg.xStart - 4 &&
      p.x <= reg.xEnd + 10 &&
      (Math.abs(p.y - reg.yStrike) <= 8 || Math.abs(p.y - reg.yBreakEven) <= 7)
    ) {
      return reg.pos;
    }
    // Hit along the vertical terminal bracket at expiryX
    const topY = Math.min(reg.yHigh, reg.yLow) - 6;
    const botY = Math.max(reg.yHigh, reg.yLow) + 6;
    if (Math.abs(p.x - reg.xEnd) <= 8 && p.y >= topY && p.y <= botY) {
      return reg.pos;
    }
  }
  return null;
}

function closePositionPopup() {
  popupPosition = null;
  const popup = document.getElementById("chart-pos-popup");
  if (popup) popup.hidden = true;
  scheduleDraw();
}

function openPositionPopup(pos: any, anchor?: { x: number; y: number }) {
  popupPosition = pos;
  const popup = document.getElementById("chart-pos-popup");
  const stage = document.getElementById("timeline-stage");
  if (!popup || !stage) return;
  const kind: Kind = pos.kind === "Put" ? "Put" : "Call";
  const strike = kind === "Call" ? Number(pos.low) : Number(pos.high);
  const breakEvenPx = computePositionBreakEven(pos);
  const expMs = Number(pos.expiryNs) / 1e6;
  const pnl = Number(pos.open ?? 0);
  const cost = Number(pos.cost ?? 0);
  const roi = cost > 0 ? (pnl / cost) * 100 : 0;
  const contracts = Math.max(0.0001, Number(pos.contracts || 1));
  const exitUnit = Number(
    pos.exitUnit ?? pos.mark ?? Number(pos.value ?? 0) / contracts,
  );
  const exitTotal = Number(pos.value ?? exitUnit * contracts);
  const pnlColor = pnl >= 0 ? "#34d399" : "#ff5a65";
  const badgeCls = kind === "Call" ? "call" : "put";

  popup.innerHTML = `
    <div class="cpp-head">
      <div>
        <span class="chart-pos-badge ${badgeCls}">${kind.toUpperCase()} SPREAD</span>
        <b style="margin-left:6px">${pos.asset} ${money(Number(pos.low))}–${money(Number(pos.high))}</b>
      </div>
      <span class="cpp-ticket">Ticket #${pos.ticketId ?? "—"}</span>
    </div>
    <div class="cpp-grid">
      <div><span>Strike / Break-Even</span><b>${money(strike)} / <span style="color:#d8f894">${money(breakEvenPx)}</span></b></div>
      <div><span>Size</span><b>${fmtQty(contracts)} contract${contracts === 1 ? "" : "s"}</b></div>
      <div><span>Entry Cost</span><b>${money(cost)} USDT</b></div>
      <div><span>Max Payout</span><b>${money(Number(pos.maxPayout ?? 0))} USDT</b></div>
      <div><span>Pool Exit Value</span><b id="cpp-exit-val">${money(exitTotal)} (${money(exitUnit)}/ct)</b></div>
      <div><span>Unrealized P&L</span><b id="cpp-pnl-val" style="color:${pnlColor}">${pnl >= 0 ? "+" : ""}${money(pnl)} (${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%)</b></div>
    </div>
    <div class="cpp-expiry">Ends ${date(expMs)} ${tzLabel()} · <b>${formatCountdown(expMs - Date.now())}</b></div>
    <p class="cpp-prompt">Close this position back to the pool now or keep it open?</p>
    <div class="cpp-actions">
      <button type="button" class="cpp-btn close-pos" id="cpp-close-now">Close Position @ ${money(exitUnit)}</button>
      <button type="button" class="cpp-btn keep-open" id="cpp-keep-open">Keep Open</button>
    </div>
    <div class="cpp-status" id="cpp-status"></div>
  `;

  popup.hidden = false;
  if (anchor) {
    const stageW = stage.clientWidth || 700;
    const stageH = stage.clientHeight || 420;
    const popW = 310;
    const popH = 235;
    const left = Math.max(12, Math.min(stageW - popW - 14, anchor.x - popW / 2));
    const top = Math.max(
      14,
      anchor.y > stageH - popH - 20 ? anchor.y - popH - 14 : anchor.y + 14,
    );
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  const keepBtn = document.getElementById("cpp-keep-open");
  if (keepBtn) {
    keepBtn.onclick = (ev) => {
      ev.stopPropagation();
      closePositionPopup();
    };
  }
  const closeBtn = document.getElementById("cpp-close-now") as HTMLButtonElement | null;
  if (closeBtn) {
    closeBtn.onclick = async (ev) => {
      ev.stopPropagation();
      closeBtn.disabled = true;
      closeBtn.textContent = "Closing position…";
      const statusEl = document.getElementById("cpp-status");
      if (statusEl) statusEl.textContent = "Submitting pool close on NEAR…";
      try {
        await window.optionalityWallet.submit({
          type: "close",
          asset: pos.asset,
          kind: pos.kind,
          strike,
          ticket: pos.ticketId,
          limit: exitUnit,
          quantity: Number(pos.contracts),
          expiry: String(pos.expiryNs),
        });
        window.dispatchEvent(new CustomEvent("optionality-refresh-state"));
        closePositionPopup();
      } catch (err: any) {
        closeBtn.disabled = false;
        closeBtn.textContent = `Retry Close @ ${money(exitUnit)}`;
        if (statusEl) statusEl.textContent = err?.message || "Close failed";
      }
    };
  }
  scheduleDraw();
}
const formatCountdown = (msRemaining: number) => {
  if (msRemaining <= 0) return "Expired";
  const totalSec = Math.max(0, Math.floor(msRemaining / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
};
const spreadWidthForAsset = (sym: string, refPrice: number) => {
  if (sym === "BTC") return 4000;
  if (sym === "NEAR") return 1;
  if (sym === "ETH") return 100;
  return Math.max(1, Math.round(refPrice * 0.04));
};
const computeSpreadBounds = (sym: string, kind: Kind, strikePrice: number, matched?: Series | null) => {
  if (matched) return { low: matched.low, high: matched.high };
  const w = spreadWidthForAsset(sym, strikePrice);
  const clean = Math.round(strikePrice * 100) / 100;
  return kind === "Call"
    ? { low: clean, high: Math.round((clean + w) * 100) / 100 }
    : { low: Math.max(0.01, Math.round((clean - w) * 100) / 100), high: clean };
};
const spot = () =>
  ticks.at(-1)?.price ??
  (Number(current?.spot) > 0
    ? Number(current.spot)
    : (candles.at(-1)?.close ?? 0));

function syncLiveCandle(livePrice: number, nowMs = Date.now()) {
  if (!Number.isFinite(livePrice) || livePrice <= 0 || !candles.length) return;
  const barStep = step();
  const bucket = Math.floor(nowMs / barStep) * barStep;
  const last = candles.at(-1)!;
  if (bucket === last.time) {
    last.close = livePrice;
    if (livePrice > last.high) last.high = livePrice;
    if (livePrice < last.low) last.low = livePrice;
  } else if (bucket > last.time && bucket - last.time <= barStep * 4) {
    candles.push({
      time: bucket,
      open: last.close,
      high: Math.max(last.close, livePrice),
      low: Math.min(last.close, livePrice),
      close: livePrice,
      volume: Math.max(0.01, (last.volume || 1) * 0.08),
    });
    if (candles.length > 650) candles.shift();
  } else {
    last.close = livePrice;
    if (livePrice > last.high) last.high = livePrice;
    if (livePrice < last.low) last.low = livePrice;
  }
}

function scheduleDraw() {
  if (!renderFrame)
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      draw();
    });
}
function xAt(time: number) {
  return (
    plot.left +
    ((time - view!.time.min) / (view!.time.max - view!.time.min)) *
      (plot.right - plot.left)
  );
}
function yAt(price: number) {
  return (
    plot.bottom -
    ((price - view!.price.min) / (view!.price.max - view!.price.min)) *
      (plot.bottom - plot.top)
  );
}
function timeAt(x: number) {
  return (
    view!.time.min +
    ((x - plot.left) / (plot.right - plot.left)) *
      (view!.time.max - view!.time.min)
  );
}
function priceAt(y: number) {
  return (
    view!.price.max -
    ((y - plot.top) / (plot.bottom - plot.top)) *
      (view!.price.max - view!.price.min)
  );
}
function point(e: { clientX: number; clientY: number }) {
  const r = $("timeline-stage").getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function inside(p: { x: number; y: number }) {
  return (
    p.x >= plot.left &&
    p.x <= plot.right &&
    p.y >= plot.top &&
    p.y <= plot.bottom
  );
}
function resetView() {
  follow = true;
  const now = Date.now(),
    span = interval === "7D" ? 7 * 86_400_000 : step() * 85;
  const prices = candles
    .filter((c) => c.time >= now - span)
    .flatMap((c) => [c.low, c.high]);
  if (spot()) prices.push(spot());
  const openPos = getOpenPositionsForAsset();
  let futureMaxMs = now + span * 0.35;
  for (const p of openPos) {
    if (Number.isFinite(p.low) && p.low > 0) prices.push(Number(p.low));
    if (Number.isFinite(p.high) && p.high > 0) prices.push(Number(p.high));
    const expMs = Number(p.expiryNs) / 1e6;
    if (Number.isFinite(expMs) && expMs > now && expMs <= now + span * 2.5) {
      futureMaxMs = Math.max(futureMaxMs, expMs + span * 0.12);
    }
  }
  if (!prices.length) return;
  const low = Math.min(...prices),
    high = Math.max(...prices),
    padding = Math.max((high - low) * 0.18, spot() * 0.0015);
  view = {
    time: { min: now - span, max: futureMaxMs },
    price: { min: low - padding, max: high + padding },
  };
  scheduleDraw();
}
function focusPositionOnChart(pos: any) {
  if (!pos) return;
  follow = false;
  const now = Date.now();
  const expMs = Number(pos.expiryNs) / 1e6;
  const timeMin = Math.min(now - step() * 30, expMs - step() * 40);
  const timeMax = Math.max(expMs + (expMs - timeMin) * 0.18, now + step() * 15);
  const curSpot = smoothSpot ?? spot();
  const prices = [Number(pos.low), Number(pos.high)];
  if (curSpot > 0) prices.push(curSpot);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const pad = Math.max((high - low) * 0.35, (curSpot || high) * 0.004);
  view = {
    time: { min: timeMin, max: timeMax },
    price: { min: low - pad, max: high + pad },
  };
  scheduleDraw();
}
function getOpenPositionsForAsset(targetAsset = asset): any[] {
  const rows = Array.isArray(current?.positions?.rows) ? current.positions.rows : [];
  return rows.filter(
    (r: any) =>
      (!targetAsset || r.asset === targetAsset) &&
      (r.settlement === "open" || !r.settlement) &&
      Number(r.contracts) > 0,
  );
}
let chartStyle: "line" | "candles" = "candles";
function getNextUtcMidnightNs(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0) * 1e6;
}

function populateExpirySelects() {
  const topSel = document.getElementById("timeline-expiry-select") as HTMLSelectElement | null;
  const edSel = document.getElementById("o-expiry-select") as HTMLSelectElement | null;
  if (!topSel && !edSel) return;

  const nowMs = Date.now();
  const nextUtc0Ns = getNextUtcMidnightNs(nowMs);
  if (!expiry || expiry / 1e6 <= nowMs) {
    expiry = nextUtc0Ns;
  }

  const listedExpiries = [
    ...new Set(
      series
        .filter(
          (s) =>
            s.asset === asset &&
            s.settlement === "open" &&
            s.expiryNs / 1e6 > nowMs + 30_000,
        )
        .map((s) => s.expiryNs),
    ),
  ].sort((a, b) => a - b);

  if (!listedExpiries.some((e) => Math.abs(e - nextUtc0Ns) < 60_000 * 1e6)) {
    listedExpiries.unshift(nextUtc0Ns);
    listedExpiries.sort((a, b) => a - b);
  }

  const buildOptions = () => {
    const opts: HTMLOptionElement[] = [];
    for (const e of listedExpiries) {
      const o = document.createElement("option");
      o.value = String(e);
      const isDailyUtc0 = Math.floor(e / 1e9) % 86400 === 0;
      o.textContent = isDailyUtc0
        ? `${date(e / 1e6)} ${tzLabel()} (00:00 UTC Daily Default)`
        : `${date(e / 1e6)} ${tzLabel()} (${formatCountdown(e / 1e6 - nowMs)})`;
      opts.push(o);
    }
    const presetMins = [1, 5, 15, 60, 240, 1440];
    for (const m of presetMins) {
      const o = document.createElement("option");
      o.value = `custom:${m}`;
      const targetStr = date(nowMs + m * 60_000);
      const lbl = m === 60 ? "+1h" : m === 240 ? "+4h" : m === 1440 ? "+1d (24h)" : `+${m}m`;
      o.textContent = `Custom ${lbl} · Ends ${targetStr} ${tzLabel()}`;
      opts.push(o);
    }
    if (customExpiryMinutes !== null && !presetMins.includes(customExpiryMinutes) && expiry) {
      const o = document.createElement("option");
      o.value = `custom:${customExpiryMinutes}`;
      o.textContent = `Custom +${customExpiryMinutes}m · Ends ${date(expiry / 1e6)} ${tzLabel()}`;
      opts.unshift(o);
    } else if (customExpiryMinutes === null && expiry && !listedExpiries.includes(expiry)) {
      const o = document.createElement("option");
      o.value = String(expiry);
      o.textContent = `${date(expiry / 1e6)} ${tzLabel()} (${formatCountdown(expiry / 1e6 - nowMs)})`;
      opts.unshift(o);
    }
    return opts;
  };

  if (topSel) topSel.replaceChildren(...buildOptions());
  if (edSel) edSel.replaceChildren(...buildOptions());
}

function syncExpiryInputs() {
  if (!expiry || expiry / 1e6 <= Date.now()) {
    expiry = getNextUtcMidnightNs();
  }
  populateExpirySelects();
  const topSel = document.getElementById("timeline-expiry-select") as HTMLSelectElement | null;
  const edSel = document.getElementById("o-expiry-select") as HTMLSelectElement | null;
  const dtInput = document.getElementById("o-expiry-datetime") as HTMLInputElement | null;
  const minInput = document.getElementById("chart-custom-min") as HTMLInputElement | null;
  const tzLbl = document.getElementById("o-expiry-tz-label");
  if (tzLbl) {
    tzLbl.textContent = `Expiry date & time (${tzLabel()} · any expiry)`;
  }
  const desiredVal = customExpiryMinutes !== null ? `custom:${customExpiryMinutes}` : String(expiry);
  if (topSel && [...topSel.options].some((o) => o.value === desiredVal)) topSel.value = desiredVal;
  if (edSel && [...edSel.options].some((o) => o.value === desiredVal)) edSel.value = desiredVal;
  if (customExpiryMinutes !== null && minInput) {
    minInput.value = String(customExpiryMinutes);
  }
  if (dtInput && document.activeElement !== dtInput) {
    dtInput.value = toDatetimeInput(Math.round(expiry / 1e6));
  }
}
function applyExpirySelection(val: string) {
  if (val.startsWith("custom:")) {
    const mins = Math.max(1, Number(val.slice("custom:".length)) || 1);
    customExpiryMinutes = mins;
    expiry = (Date.now() + mins * 60_000) * 1e6;
  } else {
    const parsed = Number(val);
    if (Number.isFinite(parsed) && parsed > 0) {
      customExpiryMinutes = null;
      expiry = parsed;
    }
  }
  syncExpiryInputs();
  editDraft();
  scheduleDraw();
}
function setCustomExpiryMinutes(mins: number) {
  const cleanMins = Math.max(1, Math.round(mins));
  customExpiryMinutes = cleanMins;
  expiry = (Date.now() + cleanMins * 60_000) * 1e6;
  syncExpiryInputs();
  editDraft();
  scheduleDraw();
}
function ensure() {
  const root = document.getElementById("positions-chart");
  if (!root || root.childElementCount) return;
  root.innerHTML = `<style>
  .chart-container{display:flex;flex-direction:column;height:100%;min-height:0;background:transparent;border:0;border-radius:0;padding:8px 12px 10px;color:#f0f0f0;font-family:var(--sans,'Satoshi','Plus Jakarta Sans',system-ui,sans-serif);font-variant-numeric:tabular-nums;gap:6px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.16) transparent}
  .chart-stats{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;margin:0;font:500 12.5px var(--sans,'Satoshi','Plus Jakarta Sans',sans-serif);font-variant-numeric:tabular-nums;color:#8f9399}
  .chart-stats b{color:#f0f0f0;font-weight:600;font-size:18px;display:inline-flex;align-items:center}
  .chart-stats .up{color:#14e091}.chart-stats .down{color:#f03c56}
  .chart-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .chart-group{display:flex;gap:3px}.chart-nav button,.chart-nav select,.chart-nearest{background:#1f1f1f;border:1px solid #2b2b2b;border-radius:6px;padding:6px 11px;color:#8f9399;font:500 12.5px var(--sans,'Satoshi','Plus Jakarta Sans',sans-serif);font-variant-numeric:tabular-nums;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center}
  .chart-nav button.active{color:#f0f0f0;background:#2c2c2c;border-color:#3d3d3d;font-weight:600}.chart-nav button:hover{color:#fff}
  .chart-hud{margin-left:auto;font:600 12px var(--sans,'Satoshi','Plus Jakarta Sans',sans-serif);color:#8f9399;background:#1f1f1f;border:1px solid #2b2b2b;border-radius:999px;padding:4px 11px;cursor:pointer}
  .chart-hud.live{color:#14e091;border-color:#333;background:#1f1f1f}
  .chart-workspace{display:grid;grid-template-columns:minmax(0,1fr) 304px;gap:14px;min-height:360px;flex:1}.chart-workspace.editing{grid-template-columns:minmax(0,1fr) 304px}
  .chart-stage{position:relative;flex:1;height:auto;min-height:340px;min-width:0;touch-action:none;user-select:none;cursor:crosshair;overflow:hidden;outline:none;border:1px solid #262626;border-radius:8px;background:#141414}
  .chart-stage:focus-visible{outline:1px solid #8f9399}.chart-stage.dragging{cursor:grabbing}.chart-stage canvas{display:block;width:100%;height:100%;pointer-events:none}
  .chart-pos-popup{position:absolute;z-index:20;width:312px;background:#181818;border:1px solid #333333;border-radius:8px;box-shadow:0 14px 36px rgba(0,0,0,.78);padding:12px 14px;font:500 12px var(--sans,'Satoshi','Plus Jakarta Sans',sans-serif);font-variant-numeric:tabular-nums;color:#f0f0f0;user-select:none}
  .chart-pos-popup[hidden]{display:none}
  .cpp-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #262626}
  .cpp-ticket{color:#8f9399;font-size:11px}
  .cpp-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin-bottom:8px}
  .cpp-grid div{display:flex;flex-direction:column;gap:1px}
  .cpp-grid span{color:#8f9399;font-size:10.5px}
  .cpp-grid b{color:#f0f0f0;font-size:12px;font-weight:600}
  .cpp-expiry{font-size:11px;color:#8f9399;background:#1f1f1f;border:1px solid #2e2e2e;border-radius:5px;padding:4px 8px;margin-bottom:8px}
  .cpp-expiry b{color:#f0f0f0;font-weight:600}
  .cpp-prompt{margin:0 0 8px;color:#d0d4da;font-family:var(--sans,'Satoshi','Plus Jakarta Sans',sans-serif);font-size:11.5px;line-height:1.4}
  .cpp-actions{display:flex;gap:7px}
  .cpp-btn{flex:1;padding:7px 9px;border-radius:6px;font:600 11.5px var(--sans,'Satoshi','Plus Jakarta Sans',sans-serif);cursor:pointer;border:1px solid transparent}
  .cpp-btn.close-pos{background:#f03c56;color:#fff;border-color:#f03c56}
  .cpp-btn.close-pos:hover{background:#ff546d}
  .cpp-btn.close-pos:disabled{opacity:.5;cursor:not-allowed}
  .cpp-btn.keep-open{background:#252525;color:#f0f0f0;border-color:#383838}
  .cpp-btn.keep-open:hover{border-color:#505050}
  .cpp-status{font-size:11px;color:#8f9399;margin-top:5px;min-height:13px}
  .chart-help{margin:2px 0 0;color:#8f9399;font-family:var(--sans,'Satoshi','Plus Jakarta Sans',sans-serif);font-size:11.5px;line-height:1.5}
  .chart-editor{min-width:0;border-left:1px solid #262626;padding-left:14px;display:flex;flex-direction:column;gap:2px;overflow-y:auto;scrollbar-width:thin}.chart-editor>*{flex-shrink:0}.chart-editor[hidden]{display:none}
  .chart-editor h3{font-family:var(--display,var(--sans,'Satoshi',sans-serif));font-size:15.5px;font-weight:600;margin:0 0 2px}.chart-editor .editor-expiry{color:#8f9399;font:500 11.5px var(--sans,'Satoshi',sans-serif);margin:0 0 8px}
  .chart-editor label{display:block;color:#8f9399;font-family:var(--sans,'Satoshi',sans-serif);font-size:11.5px;font-weight:500;margin:8px 0 4px}
  .chart-editor input,.chart-editor select{box-sizing:border-box;min-width:0;width:100%;padding:8px 10px;border:1px solid #333333;border-radius:6px;background:#252525;color:#f0f0f0;font:500 13px var(--sans,'Satoshi',sans-serif);font-variant-numeric:tabular-nums}
  .chart-editor input#o-price{font-size:15px;font-weight:600}
  .chart-expiry-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
  .chart-expiry-chips button{flex:1;min-width:44px;padding:4px 6px;font:500 11px var(--sans,'Satoshi',sans-serif);background:#1f1f1f;border:1px solid #2e2e2e;border-radius:5px;color:#8f9399;cursor:pointer}
  .chart-expiry-chips button:hover{color:#f0f0f0;border-color:#444}
  .chart-side{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:#1f1f1f;padding:3px;border-radius:7px;border:1px solid #262626}.chart-side button{padding:7px;background:transparent;border:1px solid transparent;border-radius:5px;color:#8f9399;cursor:pointer;font:600 12.5px var(--sans,'Satoshi',sans-serif)}
  .chart-side button.call-active{border-color:#2e6b52;color:#f0f0f0;background:#255440}.chart-side button.put-active{border-color:#7d2e3b;color:#f0f0f0;background:#682430}
  .chart-size-mode{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px;background:#1f1f1f;padding:3px;border-radius:6px;border:1px solid #262626}
  .chart-size-mode button{padding:5px 6px;border:1px solid transparent;border-radius:4px;background:transparent;color:#8f9399;font:500 11.5px var(--sans,'Satoshi',sans-serif);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  .chart-size-mode button.active{background:#2c2c2c;color:#f0f0f0;font-weight:600;border:1px solid #3d3d3d}
  .chart-size-grid{display:grid;grid-template-columns:1.1fr 0.9fr;gap:8px;align-items:end;margin-top:6px}
  .chart-size-grid label{margin:0 0 4px}
  .chart-size-grid input.primary-size{border-color:#484848;background:#252525}
  .chart-usd-chips{display:flex;gap:4px;margin-top:5px}
  .chart-usd-chips button{flex:1;padding:4px 6px;font:500 11px var(--sans,'Satoshi',sans-serif);background:#1f1f1f;border:1px solid #2e2e2e;border-radius:5px;color:#8f9399;cursor:pointer}
  .chart-usd-chips button:hover{color:#f0f0f0;border-color:#444}
  .chart-editor .chart-quote{font:500 12.5px var(--sans,'Satoshi',sans-serif);font-variant-numeric:tabular-nums;margin-top:8px;height:auto;flex-shrink:0;line-height:1.45;color:#f0f0f0}
  .chart-cost-card{background:#1f1f1f;border:1px solid #2e2e2e;border-radius:7px;padding:10px 11px;margin-top:4px;box-sizing:border-box}
  .chart-cost-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:5px}
  .chart-cost-usd{font-size:15px;font-weight:700;color:#f0f0f0;line-height:1.25}
  .chart-cost-sub{font-size:11.5px;color:#8f9399;line-height:1.45;word-break:break-word}
  .cost-tip-wrap{position:relative;display:inline-flex;align-items:center;flex-shrink:0}
  .cost-tip-trigger{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;background:#252525;border:1px solid #383838;color:#8f9399;font:500 10.5px var(--sans,'Satoshi',sans-serif);cursor:help;user-select:none;white-space:nowrap}
  .cost-tip-trigger:hover{color:#f0f0f0;border-color:#484848}
  .cost-tip-box{display:none;position:absolute;right:0;bottom:calc(100% + 7px);width:272px;z-index:45;background:#1f1f1f;border:1px solid #363636;border-radius:8px;padding:10px 12px;box-shadow:0 14px 34px rgba(0,0,0,0.85);font:500 11.5px var(--sans,'Satoshi',sans-serif);font-variant-numeric:tabular-nums;color:#f0f0f0;line-height:1.45}
  .cost-tip-wrap:hover .cost-tip-box,.cost-tip-wrap:focus-within .cost-tip-box{display:block}
  .cost-tip-row{display:flex;justify-content:space-between;gap:8px;padding:2.5px 0;border-bottom:1px solid rgba(255,255,255,0.05)}
  .cost-tip-row:last-child{border-bottom:0;padding-top:5px;font-weight:600}
  .cost-tip-row span{color:#8f9399}
  .chart-bal-row{display:flex;justify-content:space-between;align-items:center;font:500 11.5px var(--sans,'Satoshi',sans-serif);font-variant-numeric:tabular-nums;color:#8f9399;margin-top:6px;padding:4px 2px;flex-shrink:0}
  .chart-bal-warn{margin-top:6px;padding:8px 9px;border-radius:6px;background:rgba(240,60,86,0.12);border:1px solid rgba(240,60,86,0.45);color:#ffb8c0;font:11.5px var(--sans,'Satoshi',sans-serif);line-height:1.4;flex-shrink:0}
  .chart-bal-warn[hidden]{display:none}
  .chart-bal-topup{margin-top:6px;width:100%;padding:6px 8px;border-radius:6px;border:0;background:#e5e5e5;color:#121212;font:600 11.5px var(--sans,'Satoshi',sans-serif);cursor:pointer}
  .chart-bal-topup:hover{background:#ffffff}
  .chart-submit{width:100%;padding:11px;background:#e5e5e5;color:#121212;border:0;border-radius:6px;font:600 13px var(--sans,'Satoshi',system-ui,sans-serif);cursor:pointer;margin-top:6px;flex-shrink:0}.chart-submit:hover:not(:disabled){background:#ffffff}.chart-submit:disabled{opacity:1;cursor:not-allowed;background:#242424;color:#666a70}
  .chart-submit.insufficient{background:rgba(240,60,86,0.16);color:#ffb8c0;border:1px solid rgba(240,60,86,0.45);opacity:1}
  .chart-close{width:100%;padding:7px;background:transparent;border:0;color:#8f9399;cursor:pointer;font:500 12px var(--sans,'Satoshi',system-ui,sans-serif);flex-shrink:0}
  .chart-message{font-family:var(--sans,'Satoshi',system-ui,sans-serif);font-size:11.5px;color:#8f9399;line-height:1.45;min-height:16px;margin:4px 0 0;flex-shrink:0}.chart-nearest{width:100%;margin-top:6px;white-space:normal;font-size:11.5px;padding:5px 8px;flex-shrink:0}
  .expiry-line{stroke:rgba(240,240,240,.4);stroke-width:1;transition:stroke .15s}.expiry-wall:hover .expiry-line{stroke:#f0f0f0;stroke-width:2}
  .chart-expiry-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;background:#1f1f1f;border:1px solid #2e2e2e;color:#8f9399;font:500 11.5px var(--sans,'Satoshi',sans-serif);white-space:nowrap}
  .chart-custom-expiry{display:flex;align-items:center;gap:4px;font:500 11.5px var(--sans,'Satoshi',sans-serif);color:#8f9399}
  .chart-custom-expiry input{width:54px;padding:5px 6px;border:1px solid #333;border-radius:6px;background:#252525;color:#f0f0f0;font:600 11.5px var(--sans,'Satoshi',sans-serif);font-variant-numeric:tabular-nums}
  .chart-positions-panel{border:1px solid #262626;border-radius:8px;background:#181818;padding:8px 12px;margin-top:4px}
  .chart-positions-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px;font:500 12px var(--sans,'Satoshi',sans-serif)}
  .chart-positions-head b{color:#f0f0f0;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .chart-pos-tabs{display:inline-flex;gap:4px}
  .chart-pos-tabs button{background:#1f1f1f;border:1px solid #2e2e2e;color:#8f9399;border-radius:6px;padding:4px 10px;font:500 11.5px var(--sans,'Satoshi',sans-serif);cursor:pointer}
  .chart-pos-tabs button.active{background:#2c2c2c;color:#f0f0f0;font-weight:600;border-color:#3d3d3d}
  .chart-positions-summary{display:flex;gap:14px;color:#8f9399;font-size:11.5px;flex-wrap:wrap}
  .chart-positions-table-wrap{overflow-x:auto;max-height:155px;overflow-y:auto;scrollbar-width:thin}
  .chart-positions-table{width:100%;border-collapse:collapse;font:500 12px var(--sans,'Satoshi',sans-serif);font-variant-numeric:tabular-nums;text-align:left}
  .chart-positions-table th{color:#8f9399;font-weight:500;padding:6px 8px;border-bottom:1px solid #262626;white-space:nowrap;font-size:11.5px}
  .chart-positions-table td{padding:6px 8px;border-bottom:1px solid #212121;color:#f0f0f0;white-space:nowrap}
  .chart-positions-table tr:hover td{background:rgba(255,255,255,.025)}
  .chart-pos-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-weight:600;font-size:10.5px}
  .chart-pos-badge.call{background:rgba(20,224,145,.12);color:#14e091;border:1px solid rgba(20,224,145,.3)}
  .chart-pos-badge.put{background:rgba(240,60,86,.12);color:#f03c56;border:1px solid rgba(240,60,86,.3)}
  .chart-pos-btn{background:#1f1f1f;border:1px solid #333;color:#f0f0f0;border-radius:5px;padding:3px 9px;font:500 11.5px var(--sans,'Satoshi',sans-serif);cursor:pointer;margin-right:4px}
  .chart-pos-btn:hover{border-color:#555;background:#282828}
  .chart-pos-btn.close:hover{border-color:#f03c56;color:#f03c56}
  @media(max-width:800px){.chart-workspace,.chart-workspace.editing{grid-template-columns:minmax(0,1fr)}.chart-editor{border-left:0;border-top:1px solid #262626;padding:14px 0 0}.chart-stage{min-height:240px;flex:1}.chart-workspace.editing .chart-stage{position:sticky;top:0;height:220px;align-self:start;z-index:2;background:#141414}.chart-hud{width:100%;margin:0}.chart-container{padding:10px}}
  </style><div class="chart-container">
  <div class="chart-stats" id="chart-stats" aria-live="polite"></div>
  <div class="chart-nav"><div class="chart-group" id="chart-assets"></div><div class="chart-group" id="chart-intervals"></div>
  <div class="chart-group" id="chart-indicators"></div><div class="chart-group"><button id="chart-candles" class="active">Candles</button><button id="chart-line">Line</button></div>
  <select id="timeline-expiry-select" aria-label="Order expiry"></select>
  <div class="chart-custom-expiry" title="Set any custom expiry at least 1 minute from entry on Testnet (at least 1 day on Mainnet)">
    <span>Custom (min):</span>
    <input id="chart-custom-min" type="number" min="1" max="43200" step="1" placeholder="≥1m" aria-label="Custom expiry minutes from now">
    <button id="chart-apply-min" type="button">Set</button>
  </div>
  <select id="chart-tz-select" aria-label="Select display timezone" title="Choose any timezone for timestamps (defaults to your local timezone, or UTC+0)"></select>
  <span class="chart-expiry-pill">Drag Order on Chart to Adjust Strike &amp; Expiry</span>
  <button id="chart-reset" type="button">Reset view</button><button type="button" class="chart-hud live" id="timeline-hud" title="Click to follow live price">● Live</button></div>
  <div class="chart-workspace" id="chart-workspace"><div class="chart-stage" id="timeline-stage" tabindex="0" role="application" aria-label="Price chart. Drag pending order to adjust strike price and expiry date, drag background to pan, scroll to zoom."><div id="chart-pos-popup" class="chart-pos-popup" hidden></div></div>
  <aside class="chart-editor" id="chart-order-editor" aria-label="Chart order editor">
  <h3>New order</h3><p class="editor-expiry" id="o-expiry"></p>
  <label for="o-price">Strike / Entry Price (USD · or drag order on chart)</label><input id="o-price" type="number" min="0.01" step="0.01" placeholder="Enter any strike price…" inputmode="decimal" autocomplete="off" list="chart-strikes"><datalist id="chart-strikes"></datalist>
  <label for="o-expiry-select" id="o-expiry-tz-label">Expiry date & time (${tzLabel()} · any expiry)</label>
  <select id="o-expiry-select" aria-label="Expiry preset or listed series"></select>
  <input id="o-expiry-datetime" type="datetime-local" aria-label="Custom expiry date and time" style="margin-top:5px" title="Pick any custom expiry date and time, or drag the vertical expiry line on the chart">
  <div class="chart-expiry-chips">
    <button type="button" data-exp-min="1">+1m</button>
    <button type="button" data-exp-min="5">+5m</button>
    <button type="button" data-exp-min="15">+15m</button>
    <button type="button" data-exp-min="60">+1h</button>
    <button type="button" data-exp-utc0="1">00:00 UTC</button>
    <button type="button" data-exp-min="1440">+1d</button>
  </div>
  <label>Side</label><div class="chart-side"><button id="o-put" type="button" aria-pressed="false">Put</button><button id="o-call" type="button" aria-pressed="true">Call</button></div>
  <div class="chart-size-mode" role="group" aria-label="Choose sizing unit">
    <button type="button" id="o-mode-usdt" class="active">${chartIconSvg("USDT", 12)}Size in USDT ($)</button>
    <button type="button" id="o-mode-contracts">Size in Contracts</button>
  </div>
  <div class="chart-size-grid">
    <div>
      <label for="o-usd-budget" id="o-usd-label">${chartIconSvg("USDT", 11)}Amount (USDT $)</label>
      <input id="o-usd-budget" class="primary-size" type="number" min="0.1" step="0.01" placeholder="e.g. 25.00" inputmode="decimal" title="Enter any dollar/USDT amount (decimals supported); fractional contracts are calculated automatically">
    </div>
    <div>
      <label for="o-amount" id="o-contracts-label">Contracts (Decimal)</label>
      <input id="o-amount" type="number" min="0.01" max="100000" step="0.01" value="1" inputmode="decimal" title="Enter any whole or decimal contract size (e.g. 0.5, 1.25)">
    </div>
  </div>
  <div class="chart-usd-chips" id="o-usd-chips">
    <button type="button" data-usd-chip="10">$10</button>
    <button type="button" data-usd-chip="25">$25</button>
    <button type="button" data-usd-chip="50">$50</button>
    <button type="button" data-usd-chip="100">$100</button>
    <button type="button" data-usd-chip="250">$250</button>
  </div>
  <p class="chart-message" id="o-match" aria-live="polite"></p><button type="button" class="chart-nearest" id="o-nearest" hidden></button>
  <div class="chart-quote" id="o-px" aria-live="polite">—</div>
  <div class="chart-bal-row"><span>${chartIconSvg("USDT", 11)}Your Available Balance (USDT)</span><b id="o-avail-bal" style="color:#f0f0f0">$0.00</b></div>
  <div class="chart-bal-warn" id="o-balance-warn" hidden>
    <div id="o-balance-warn-text">⚠️ Insufficient balance to place this order.</div>
    <button type="button" class="chart-bal-topup" id="o-inline-topup">+ Top Up $1,000 USDT Now</button>
  </div>
  <button type="button" class="chart-submit" id="o-buy" disabled>Buy</button><button type="button" class="chart-close" id="o-cancel">Reset order</button><p class="chart-message" id="o-status" role="status"></p>
  </aside></div>
  <section class="chart-positions-panel" id="chart-positions-panel" aria-label="Positions and trade history">
    <div class="chart-positions-head">
      <div class="chart-pos-tabs">
        <button type="button" id="chart-tab-open" class="active">Positions (Active)</button>
        <button type="button" id="chart-tab-history">Trade History (Expired / Closed)</button>
      </div>
      <div class="chart-positions-summary" id="chart-positions-summary">No open positions</div>
    </div>
    <div class="chart-positions-table-wrap" id="chart-positions-body"></div>
  </section>
  <p class="chart-help" id="chart-help">Drag pending order on the chart to change Strike Price &amp; Expiry Date · Click any open position line to Close or Keep Open · Timezone: ${tzLabel()}</p></div>`;
  for (const mode of ["candles", "line"] as const) {
    $("chart-" + mode).onclick = () => {
      chartStyle = mode;
      for (const m of ["candles", "line"])
        $("chart-" + m).classList.toggle("active", m === mode);
      scheduleDraw();
    };
  }
  for (const symbol of ["ETH", "BTC", "NEAR"]) {
    const b = document.createElement("button");
    b.innerHTML = `${chartIconSvg(symbol, 13)}${symbol}`;
    b.dataset.asset = symbol;
    b.onclick = () =>
      window.dispatchEvent(
        new CustomEvent("optionality-chart-asset", { detail: symbol }),
      );
    $("chart-assets").append(b);
  }
  for (const value of ["1s", "1m", "5m", "15m", "1h", "1D", "7D", "1W"]) {
    const b = document.createElement("button");
    b.textContent = value;
    b.dataset.interval = value;
    b.onclick = () => {
      interval = value;
      resetData();
      void loadCandles(true);
    };
    $("chart-intervals").append(b);
  }
  for (const [key, label] of [
    ["ema", "EMA 20"],
    ["vwap", "VWAP"],
    ["bb", "BB"],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.indicator = key;
    b.setAttribute("aria-pressed", String(indicators[key]));
    b.classList.toggle("active", indicators[key]);
    b.onclick = () => {
      indicators[key] = !indicators[key];
      b.classList.toggle("active", indicators[key]);
      b.setAttribute("aria-pressed", String(indicators[key]));
      scheduleDraw();
    };
    $("chart-indicators").append(b);
  }
  const populateTzSelect = () => {
    const sel = document.getElementById("chart-tz-select") as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = "";
    const autoOpt = document.createElement("option");
    autoOpt.value = "local";
    autoOpt.textContent = `🕒 Auto Local (${localOffsetLabel} · ${detectedTimeZone})`;
    sel.append(autoOpt);
    for (const off of TZ_OFFSETS) {
      const opt = document.createElement("option");
      opt.value = String(off);
      const lbl = formatOffsetLabel(off);
      opt.textContent = off === 0 ? `🌐 ${lbl} (00:00 UTC Standard)` : `🌐 ${lbl}`;
      sel.append(opt);
    }
    if ([...sel.options].some((o) => o.value === tzMode)) {
      sel.value = tzMode;
    } else {
      sel.value = "local";
    }
    const helpEl = document.getElementById("chart-help");
    if (helpEl) {
      helpEl.textContent = `Drag pending order on the chart to change Strike Price & Expiry Date · Click any open position line to Close or Keep Open · Timezone: ${tzLabel()}`;
    }
  };
  populateTzSelect();
  $("chart-tz-select").onchange = () => {
    const sel = $("chart-tz-select") as HTMLSelectElement;
    tzMode = sel.value || "local";
    try {
      localStorage.setItem("optionality_tz_mode", tzMode);
    } catch {}
    populateTzSelect();
    window.dispatchEvent(new CustomEvent("optionality-tz-change", { detail: { tzMode } }));
    lastPositionsSig = "";
    seriesAt = 0;
    syncExpiryInputs();
    reconcileDraft();
    renderPositionsPanel();
    scheduleDraw();
  };
  window.addEventListener("optionality-tz-change", (ev: any) => {
    const next = ev?.detail?.tzMode;
    if (!next || next === tzMode) return;
    tzMode = String(next);
    populateTzSelect();
    lastPositionsSig = "";
    seriesAt = 0;
    syncExpiryInputs();
    reconcileDraft();
    renderPositionsPanel();
    scheduleDraw();
  });
  const setBottomTab = (tab: "open" | "history") => {
    bottomPanelTab = tab;
    document.getElementById("chart-tab-open")?.classList.toggle("active", tab === "open");
    document.getElementById("chart-tab-history")?.classList.toggle("active", tab === "history");
    lastPositionsSig = "";
    renderPositionsPanel();
  };
  $("chart-tab-open").onclick = () => setBottomTab("open");
  $("chart-tab-history").onclick = () => setBottomTab("history");
  $("chart-reset").onclick = resetView;
  $("timeline-hud").onclick = () => {
    resetView();
  };
  $("timeline-expiry-select").onchange = () => {
    applyExpirySelection(($("timeline-expiry-select") as HTMLSelectElement).value);
  };
  $("o-expiry-select").onchange = () => {
    applyExpirySelection(($("o-expiry-select") as HTMLSelectElement).value);
  };
  $("o-expiry-datetime").onchange = () => {
    const raw = ($("o-expiry-datetime") as HTMLInputElement).value;
    if (!raw) return;
    const ms = parseDatetimeInput(raw);
    if (Number.isFinite(ms) && ms > Date.now() + 30_000) {
      customExpiryMinutes = Math.max(1, Math.round((ms - Date.now()) / 60_000));
      expiry = ms * 1e6;
      syncExpiryInputs();
      editDraft();
      scheduleDraw();
    }
  };
  for (const chip of document.querySelectorAll<HTMLButtonElement>(".chart-expiry-chips button")) {
    chip.onclick = () => {
      if (chip.dataset.expUtc0) {
        const now = new Date();
        const nextMidnightMs = Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + 1,
          0,
          0,
          0,
        );
        customExpiryMinutes = null;
        expiry = nextMidnightMs * 1e6;
        syncExpiryInputs();
        editDraft();
        scheduleDraw();
        return;
      }
      const mins = Number(chip.dataset.expMin);
      if (Number.isFinite(mins) && mins > 0) {
        setCustomExpiryMinutes(mins);
      }
    };
  }
  $("chart-apply-min").onclick = () => {
    const mins = Math.max(
      1,
      Number(($("chart-custom-min") as HTMLInputElement).value) || 1,
    );
    setCustomExpiryMinutes(mins);
  };
  const syncSizingModeUi = () => {
    const isUsdt = sizingMode === "usdt";
    document.getElementById("o-mode-usdt")?.classList.toggle("active", isUsdt);
    document.getElementById("o-mode-contracts")?.classList.toggle("active", !isUsdt);
    document.getElementById("o-usd-budget")?.classList.toggle("primary-size", isUsdt);
    document.getElementById("o-amount")?.classList.toggle("primary-size", !isUsdt);
  };
  $("o-mode-usdt").onclick = () => {
    sizingMode = "usdt";
    syncSizingModeUi();
    ($("o-usd-budget") as HTMLInputElement).focus();
  };
  $("o-mode-contracts").onclick = () => {
    sizingMode = "contracts";
    targetUsdSpend = null;
    syncSizingModeUi();
    ($("o-amount") as HTMLInputElement).focus();
  };
  $("o-price").oninput = () => {
    const val = Number(($("o-price") as HTMLInputElement).value);
    if (!draft) {
      draft = { price: val, kind: "Call", quantity: 1 };
    } else {
      draft.price = val;
    }
    editDraft();
  };
  $("o-amount").oninput = () => {
    sizingMode = "contracts";
    targetUsdSpend = null;
    syncSizingModeUi();
    if (!draft) {
      draft = { price: Number(($("o-price") as HTMLInputElement).value) || spot(), kind: "Call", quantity: 1 };
    }
    const rawQty = Number(($("o-amount") as HTMLInputElement).value);
    draft.quantity = Number.isFinite(rawQty) && rawQty > 0 ? Number(rawQty.toFixed(4)) : 0;
    editDraft();
  };
  const applyUsdBudget = (usdTarget: number) => {
    if (!Number.isFinite(usdTarget) || usdTarget <= 0) return;
    sizingMode = "usdt";
    targetUsdSpend = usdTarget;
    syncSizingModeUi();
    if (!draft || !(draft.price > 0)) {
      const defStrike =
        Number(($("o-price") as HTMLInputElement).value) ||
        (asset === "NEAR"
          ? Math.round((spot() || 3.75) * 4) / 4
          : Math.round(spot() || (asset === "BTC" ? 76000 : 2250)));
      draft = { price: defStrike, kind: draft?.kind ?? "Call", quantity: 1 };
      ($("o-price") as HTMLInputElement).value = String(draft.price);
    }
    const unitPx =
      latestQuote && latestQuote.quantity > 0
        ? latestQuote.premium / latestQuote.quantity
        : asset === "BTC"
          ? 900
          : asset === "NEAR"
            ? 0.4
            : 25;
    const contracts = Number(Math.max(0.0001, Math.min(100000, usdTarget / Math.max(0.01, unitPx))).toFixed(4));
    draft.quantity = contracts;
    ($("o-amount") as HTMLInputElement).value = fmtQty(contracts);
    editDraft();
  };
  $("o-usd-budget").oninput = () => {
    const val = Number(($("o-usd-budget") as HTMLInputElement).value);
    if (Number.isFinite(val) && val > 0) {
      applyUsdBudget(val);
    }
  };
  for (const chip of document.querySelectorAll<HTMLButtonElement>("#o-usd-chips button")) {
    chip.onclick = () => {
      const usdVal = Number(chip.dataset.usdChip);
      if (Number.isFinite(usdVal) && usdVal > 0) {
        ($("o-usd-budget") as HTMLInputElement).value = String(usdVal);
        applyUsdBudget(usdVal);
      }
    };
  }
  $("o-inline-topup").onclick = () => {
    document.getElementById("topup")?.click();
  };
  for (const kind of ["Put", "Call"] as const)
    $(`o-${kind.toLowerCase()}`).onclick = () => {
      if (!draft) {
        draft = { price: Number(($("o-price") as HTMLInputElement).value) || spot(), kind, quantity: 1 };
      } else {
        draft.kind = kind;
      }
      editDraft();
    };
  $("o-buy").onclick = () => void buy();
  $("o-cancel").onclick = closeEditor;
  syncExpiryInputs();
  refreshBalanceState();
  wireGestures();
  canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  $("timeline-stage").append(canvas);
  const header = document.querySelector<HTMLElement>(".topbar");
  if (header)
    new ResizeObserver(() => {
      document.documentElement.style.setProperty(
        "--chart-header-height",
        `${header.getBoundingClientRect().height}px`,
      );
    }).observe(header);
  let width = $("timeline-stage").clientWidth;
  let height = $("timeline-stage").clientHeight;
  new ResizeObserver(() => {
    const next = $("timeline-stage").clientWidth;
    const nextHeight = $("timeline-stage").clientHeight;
    if (next !== width || nextHeight !== height) {
      width = next;
      height = nextHeight;
      scheduleDraw();
    }
  }).observe($("timeline-stage"));
  setInterval(() => {
    if (document.getElementById("page-chart")?.classList.contains("on"))
      void loadCandles();
  }, 1000);
  setInterval(() => {
    if (document.getElementById("page-chart")?.classList.contains("on"))
      void loadTicks();
  }, 250);
  void loadTicks();
  void loadStats();
  setInterval(() => void loadStats(), 8000);
}
function resetData() {
  generation++;
  candles = [];
  candlesAt = 0;
  loadingCandles = false;
  historyLoading = false;
  historyEnd = null;
  historyNotice = "";
  view = null;
  follow = true;
  scheduleDraw();
}
function openEditor(price: number) {
  if (!expiry) {
    expiry = (Date.now() + 3600_000) * 1e6;
  }
  draft = {
    price: Math.max(0.01, Math.round(price * 100) / 100),
    kind: draft?.kind ?? "Call",
    quantity: draft?.quantity && draft.quantity > 0 ? draft.quantity : 1,
  };
  ($("o-price") as HTMLInputElement).value = String(draft.price);
  ($("o-amount") as HTMLInputElement).value = fmtQty(draft.quantity);
  syncExpiryInputs();
  $("chart-order-editor").hidden = false;
  $("chart-workspace").classList.add("editing");
  editDraft();
  ($("o-price") as HTMLInputElement).focus({ preventScroll: true });
  if (window.innerWidth <= 800)
    requestAnimationFrame(() =>
      $("o-price").scrollIntoView({ block: "center", behavior: "smooth" }),
    );
}
function closeEditor() {
  quoteSequence++;
  clearTimeout(quoteTimer);
  draft = { price: 0, kind: "Call", quantity: 1 };
  selected = null;
  latestQuote = null;
  targetUsdSpend = null;
  if (document.getElementById("chart-order-editor")) {
    ($("o-price") as HTMLInputElement).value = "";
    $("o-px").textContent = "Click chart or enter any strike price above";
    ($("o-buy") as HTMLButtonElement).disabled = true;
    ($("o-amount") as HTMLInputElement).value = "1";
    reconcileDraft();
  }
  scheduleDraw();
}
function editDraft() {
  quoteSequence++;
  latestQuote = null;
  clearTimeout(quoteTimer);
  $("o-status").textContent = "";
  reconcileDraft();
  if (
    draft &&
    draft.price > 0 &&
    Number.isFinite(draft.price) &&
    view &&
    !draftDrag &&
    (draft.price < view.price.min || draft.price > view.price.max)
  ) {
    const span = view.price.max - view.price.min;
    view.price = { min: draft.price - span / 2, max: draft.price + span / 2 };
  }
  crosshair = null;
  scheduleDraw();
  if (draft && Number.isFinite(draft.price) && draft.price > 0 && expiry && expiry / 1e6 > Date.now()) {
    quoteTimer = setTimeout(() => void quote(), 120);
  }
}
function reconcileDraft() {
  if (!draft) return;
  if (!expiry || expiry / 1e6 <= Date.now()) {
    expiry = (Date.now() + 3600_000) * 1e6;
  }
  const effectiveExpiry = (() => {
    if (!expiry) return null;
    const exactMatch = series.some(
      (s) => s.asset === asset && s.expiryNs === expiry && s.settlement === "open",
    );
    if (exactMatch) return expiry;
    const openExpiries = [
      ...new Set(
        series
          .filter((s) => s.asset === asset && s.settlement === "open")
          .map((s) => s.expiryNs),
      ),
    ];
    if (!openExpiries.length) return expiry;
    return openExpiries.reduce(
      (best, cur) =>
        Math.abs(cur - expiry!) < Math.abs(best - expiry!) ? cur : best,
      openExpiries[0],
    );
  })();
  selected = listedStrike(
    series,
    asset,
    draft.kind,
    effectiveExpiry,
    draft.price,
  );
  const quantityValid = isValidOrderQuantity(draft.quantity);
  if (!quantityValid) selected = null;
  ($("o-buy") as HTMLButtonElement).disabled = true;
  $("o-buy").textContent = "Buy";
  if (!draftDrag) {
    $("o-px").textContent = "—";
  }
  const isMidnight = expiry
    ? new Date(Math.round(expiry / 1e6)).getUTCHours() === 0 &&
      new Date(Math.round(expiry / 1e6)).getUTCMinutes() === 0
    : false;
  $("o-expiry").textContent = expiry
    ? `${asset} · Ends ${date(expiry / 1e6)} ${tzLabel()} (${formatCountdown(expiry / 1e6 - Date.now())})${isMidnight ? " · 00:00 UTC Daily" : customExpiryMinutes ? ` · +${customExpiryMinutes}m Custom` : ""}`
    : "Select or enter any expiry";
  syncExpiryInputs();
  $("o-put").className = draft.kind === "Put" ? "put-active" : "";
  $("o-call").className = draft.kind === "Call" ? "call-active" : "";
  $("o-put").setAttribute("aria-pressed", String(draft.kind === "Put"));
  $("o-call").setAttribute("aria-pressed", String(draft.kind === "Call"));
  const candidates = series.filter(
    (s) =>
      s.asset === asset &&
      s.expiryNs === effectiveExpiry &&
      s.kind === draft!.kind &&
      s.settlement === "open",
  );
  const strike = (s: Series) => (s.kind === "Call" ? s.low : s.high);
  const nearest = [...candidates].sort(
    (a, b) =>
      Math.abs(strike(a) - draft!.price) - Math.abs(strike(b) - draft!.price),
  )[0];
  const list = $("chart-strikes");
  list.replaceChildren(
    ...candidates.map((s) => {
      const o = document.createElement("option");
      o.value = String(strike(s));
      return o;
    }),
  );
  if (!quantityValid) {
    $("o-match").textContent = "Enter a valid size in USDT ($) or Contracts (0.01–100,000).";
  } else if (!Number.isFinite(draft.price) || draft.price <= 0) {
    $("o-match").textContent = "Click chart or enter any positive strike price.";
  } else if (selected && selected.expiryNs === expiry) {
    $("o-match").textContent = `Listed ${selected.kind} spread · ${money(selected.low)}–${money(selected.high)} (Max payout ${money((selected.high - selected.low) * draft.quantity)})`;
  } else {
    const bounds = computeSpreadBounds(asset, draft.kind, draft.price, null);
    $("o-match").textContent = `Custom ${draft.kind} spread · ${money(bounds.low)}–${money(bounds.high)} · Ends ${date(expiry / 1e6)} ${tzLabel()} (Max payout ${money((bounds.high - bounds.low) * draft.quantity)})`;
  }
  $("o-nearest").hidden =
    !!(selected && selected.expiryNs === expiry) ||
    !nearest ||
    !quantityValid ||
    !Number.isFinite(draft.price) ||
    draft.price <= 0;
  if (nearest) {
    $("o-nearest").textContent = `Optional: Snap to listed strike ${money(strike(nearest))}`;
    $("o-nearest").onclick = () => {
      if (draft) {
        draft.price = strike(nearest);
        ($("o-price") as HTMLInputElement).value = String(draft.price);
        editDraft();
      }
    };
  }
}
function getAvailableBalance(): number {
  const walletAcct = window.optionalityWallet?.account;
  if (walletAcct === null) return 0;
  const avail = Number(current?.you?.available);
  return Number.isFinite(avail) && avail >= 0 ? avail : 0;
}

function refreshBalanceState() {
  const availEl = document.getElementById("o-avail-bal");
  const warnEl = document.getElementById("o-balance-warn");
  const warnTextEl = document.getElementById("o-balance-warn-text");
  const buyBtn = document.getElementById("o-buy") as HTMLButtonElement | null;
  if (!availEl) return;

  const avail = getAvailableBalance();
  availEl.textContent = `${money(avail)} USDT`;
  availEl.style.color = avail > 0 ? "#5fc39c" : "#ff5a65";

  if (!latestQuote) {
    if (warnEl) {
      if (avail <= 0) {
        warnEl.hidden = false;
        if (warnTextEl) {
          warnTextEl.innerHTML = `⚠️ <b>No funds available ($0.00)</b> — You cannot place an order until you fund your account.`;
        }
      } else {
        warnEl.hidden = true;
      }
    }
    return;
  }

  const needed = Number(latestQuote.premium || 0);
  const insufficient = needed > avail || avail <= 0;
  if (warnEl) {
    warnEl.hidden = !insufficient;
    if (insufficient && warnTextEl) {
      warnTextEl.innerHTML =
        avail <= 0
          ? `⚠️ <b>Cannot place order ($0.00 available)</b> — This order requires <b>${money(needed)} USDT</b>. Fund your account first.`
          : `⚠️ <b>Insufficient balance</b> — Order costs <b>${money(needed)} USDT</b>, but you only have <b>${money(avail)}</b> available.`;
    }
  }
  if (buyBtn) {
    if (insufficient) {
      buyBtn.disabled = true;
      buyBtn.classList.add("insufficient");
      buyBtn.textContent = `Insufficient Balance (${money(avail)}) · Top Up Required`;
    } else {
      buyBtn.classList.remove("insufficient");
      buyBtn.disabled = busy;
      buyBtn.textContent = `Buy ${latestQuote.kind} · Pay ${money(needed)} USDT (${fmtQty(latestQuote.quantity)} ct)`;
    }
  }
}

async function quote() {
  const seq = ++quoteSequence,
    s = selected,
    d = draft ? { ...draft } : null,
    exp = expiry;
  latestQuote = null;
  refreshBalanceState();
  if (!d || !Number.isFinite(d.price) || d.price <= 0 || !exp || exp / 1e6 <= Date.now()) return;
  if (!isValidOrderQuantity(d.quantity)) return;
  $("o-px").textContent = "Fetching live quote…";
  ($("o-buy") as HTMLButtonElement).disabled = true;
  try {
    const params = new URLSearchParams({
      asset,
      kind: d.kind,
      price: String(d.price),
      expiry: String(exp),
      quantity: String(d.quantity),
    });
    if (s && s.expiryNs === exp) {
      params.set("series", String(s.seriesId));
    }
    const r = await fetch(`/chart-quote?${params.toString()}`, {
      cache: "no-store",
    });
    const q = await r.json();
    if (
      seq !== quoteSequence ||
      !draft ||
      draft.price !== d.price ||
      draft.kind !== d.kind ||
      draft.quantity !== d.quantity ||
      expiry !== exp
    )
      return;
    if (!r.ok || !q.available) {
      $("o-px").textContent = "Quote unavailable for these parameters";
      return;
    }
    let effQty = d.quantity;
    let totalCost = Number(q.premium);
    const unitCost = totalCost / Math.max(0.0001, d.quantity);
    // If the user typed a target USDT spend, refine fractional contracts to match their requested USDT spend
    if (sizingMode === "usdt" && targetUsdSpend !== null && targetUsdSpend > 0 && unitCost > 0) {
      const exactContracts = Number(Math.max(0.0001, Math.min(100000, targetUsdSpend / unitCost)).toFixed(4));
      if (Math.abs(exactContracts - d.quantity) > 0.0002) {
        effQty = exactContracts;
        draft.quantity = exactContracts;
        ($("o-amount") as HTMLInputElement).value = fmtQty(exactContracts);
        totalCost = Number((exactContracts * unitCost).toFixed(4));
      }
    }
    const bounds = computeSpreadBounds(asset, d.kind, d.price, s && s.expiryNs === exp ? s : null);
    const maxPayout = (bounds.high - bounds.low) * effQty;
    const midUnit = Number(q.midUnit ?? unitCost / 1.005);
    const midTotal = midUnit * effQty;
    const feeTotal = Math.max(0, totalCost - midTotal);
    const maxNetProfit = Math.max(0, maxPayout - totalCost);
    const maxRoiPct = totalCost > 0 ? (maxNetProfit / totalCost) * 100 : 0;

    latestQuote = {
      ...q,
      premium: totalCost,
      quantity: effQty,
      price: d.price,
      kind: d.kind,
      expiryNs: exp,
      asset,
      low: q.low ?? bounds.low,
      high: q.high ?? bounds.high,
      series: s && s.expiryNs === exp ? s : null,
    };

    const usdInput = document.getElementById("o-usd-budget") as HTMLInputElement | null;
    if (usdInput && document.activeElement !== usdInput) {
      usdInput.value = totalCost.toFixed(2);
    }

    $("o-px").innerHTML = `
      <div class="chart-cost-card">
        <div class="chart-cost-head">
          <div>
            <div style="font-size:10.5px;color:#9aa3ad;text-transform:uppercase;letter-spacing:.04em">Total Cost (USDT Stablecoin)</div>
            <div class="chart-cost-usd">${money(totalCost)} USDT</div>
          </div>
          <div class="cost-tip-wrap" tabindex="0" aria-label="View full cost breakdown">
            <span class="cost-tip-trigger">ⓘ Breakdown</span>
            <div class="cost-tip-box" role="tooltip">
              <div style="font-weight:700;color:#34d399;margin-bottom:5px;border-bottom:1px solid #26323f;padding-bottom:4px">Order Cost &amp; Payoff Components</div>
              <div class="cost-tip-row"><span>Option Spread Fair Value (${fmtQty(effQty)}×${money(midUnit)})</span><b>${money(midTotal)}</b></div>
              <div class="cost-tip-row"><span>LP Pool Margin (+50 bps / 0.50%)</span><b>${money(feeTotal)}</b></div>
              <div class="cost-tip-row"><span>Buy Price per Contract</span><b>${money(unitCost)} USDT</b></div>
              <div class="cost-tip-row"><span>On-Chain Execution / Gas Fee</span><b style="color:#5fc39c">$0.00</b></div>
              <div class="cost-tip-row"><span>Total USDT Cost (Max Loss)</span><b style="color:#34d399">${money(totalCost)} USDT</b></div>
              <div class="cost-tip-row"><span>Vault Locked Payout (${fmtQty(effQty)}×${money(bounds.high - bounds.low)})</span><b>${money(maxPayout)}</b></div>
              <div class="cost-tip-row"><span>Max Net Profit at Expiry</span><b style="color:#5fc39c">+${money(maxNetProfit)} (+${maxRoiPct.toFixed(0)}%)</b></div>
            </div>
          </div>
        </div>
        <div class="chart-cost-sub">Size: <b style="color:#f4ede4">${fmtQty(effQty)} ct</b> @ ${money(unitCost)}/ct · Max Payout <b style="color:#f4ede4">${money(maxPayout)}</b> · Max Profit <b style="color:#5fc39c">+${money(maxNetProfit)}</b></div>
      </div>
    `;
    refreshBalanceState();
  } catch {
    if (seq === quoteSequence)
      $("o-px").textContent = "Quote failed. Edit the order to retry.";
  }
}
async function buy() {
  if (busy || !latestQuote || !draft) return;
  const q = latestQuote;
  if (
    q.quantity !== draft.quantity ||
    q.price !== draft.price ||
    q.kind !== draft.kind ||
    q.expiryNs / 1e6 <= Date.now()
  )
    return;
  const avail = getAvailableBalance();
  if (q.premium > avail || avail <= 0) {
    const errMsg =
      avail <= 0
        ? `Cannot place order: Your balance is $0.00, and this order costs ${money(q.premium)} USDT. Click "+ Top Up $1,000" first.`
        : `Cannot place order: Insufficient balance (${money(avail)} available, order requires ${money(q.premium)} USDT).`;
    $("o-status").innerHTML = `<span style="color:#ff8b90">${errMsg}</span>`;
    window.dispatchEvent(
      new CustomEvent("optionality-toast", { detail: { text: errMsg, bad: true } }),
    );
    refreshBalanceState();
    return;
  }
  busy = true;
  ($("o-buy") as HTMLButtonElement).disabled = true;
  $("o-status").textContent = "Submitting order & minting position on NEAR…";
  try {
    await window.optionalityWallet.submit({
      type: "buy",
      asset: q.asset || asset,
      kind: q.kind,
      strike: q.price,
      expiry: String(q.expiryNs),
      quantity: q.quantity,
      limit: q.premium / q.quantity,
    });
    const successMsg = `Opened ${fmtQty(q.quantity)}x ${q.kind} @ ${money(q.price)} for ${money(q.premium)} USDT (Ends ${date(q.expiryNs / 1e6)} ${tzLabel()})`;
    if (draft) {
      $("o-status").innerHTML = `<span style="color:#5fc39c">✓ ${successMsg}</span>`;
    }
    window.dispatchEvent(
      new CustomEvent("optionality-toast", { detail: { text: `✓ ${successMsg}`, bad: false } }),
    );
    seriesAt = 0;
    window.dispatchEvent(new CustomEvent("optionality-refresh-state"));
  } catch (e: any) {
    if (draft) $("o-status").innerHTML = `<span style="color:#ff8b90">${e.message}</span>`;
    window.dispatchEvent(
      new CustomEvent("optionality-toast", { detail: { text: `Order failed: ${e.message}`, bad: true } }),
    );
  } finally {
    busy = false;
    latestQuote = null;
    if (draft) void quote();
  }
}
function mergeCandles(incoming: Candle[]) {
  const map = new Map(candles.map((c) => [c.time, c]));
  for (const c of incoming)
    if (
      Number.isFinite(c.time) &&
      [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0)
    )
      map.set(c.time, c);
  candles = [...map.values()].sort((a, b) => a.time - b.time);
  const livePx = smoothSpot ?? ticks.at(-1)?.price;
  if (livePx && livePx > 0) {
    syncLiveCandle(livePx, Date.now());
  }
}
async function loadCandles(force = false, before?: number) {
  const historical = before !== undefined;
  if (
    historical ? historyLoading || Date.now() < historyRetryAt : loadingCandles
  )
    return;
  if (
    !historical &&
    !force &&
    Date.now() - candlesAt < 950
  )
    return;
  const gen = generation,
    a = asset,
    i = interval;
  if (historical) historyLoading = true;
  else loadingCandles = true;
  try {
    const r = await fetch(
      `/chart-candles?asset=${a}&interval=${i}&limit=300${historical ? `&end=${before}` : ""}`,
      { cache: "no-store" },
    );
    if (!r.ok) throw Error("History unavailable");
    const body = await r.json();
    if (gen !== generation) return;
    const rows = Array.isArray(body.candles) ? body.candles : [];
    mergeCandles(rows);
    if (historical) {
      if (!rows.length || !rows.some((c: Candle) => c.time < before!))
        historyEnd = before!;
    } else candlesAt = Date.now();
    historyNotice = rows.length ? "" : "Historical feed unavailable";
    if (!view) resetView();
    scheduleDraw();
  } catch {
    if (gen === generation) {
      historyRetryAt = Date.now() + 5000;
      historyNotice = "History unavailable · retry by panning";
      scheduleDraw();
    }
  } finally {
    if (gen === generation) {
      if (historical) historyLoading = false;
      else loadingCandles = false;
    }
  }
}
function maybeLoadHistory() {
  const first = candles[0]?.time;
  if (
    view &&
    first &&
    view.time.min < first + step() * 20 &&
    historyEnd !== first - 1 &&
    !historyLoading
  )
    void loadCandles(false, first - 1);
}
function hitTestDraftOrder(p: { x: number; y: number }): "both" | "price" | "expiry" | null {
  if (!view) return null;
  const expX = expiry ? xAt(expiry / 1e6) : null;
  if (draft && draft.price > 0) {
    const y = yAt(draft.price);
    const lineEnd = expX !== null ? Math.max(plot.left + 20, Math.min(plot.right, expX)) : plot.right;
    // 1. Corner handle at (lineEnd, y)
    if (Math.hypot(p.x - lineEnd, p.y - y) <= 16) {
      return "both";
    }
    // 2. Right-axis draft price pill
    if (p.x >= plot.right && p.x <= plot.right + 84 && Math.abs(p.y - y) <= 14) {
      return "price";
    }
    // 3. Horizontal draft price line or draft drag pill badge
    if (p.x >= plot.left && p.x <= lineEnd + 16 && Math.abs(p.y - y) <= 14) {
      return "both";
    }
    // 4. Draft label / drag badge region above the line
    const labelY = Math.max(plot.top + 14, Math.min(plot.bottom - 5, y));
    if (p.x >= plot.left + 4 && p.x <= Math.min(plot.right, plot.left + 460) && p.y >= labelY - 26 && p.y <= labelY + 6) {
      return "both";
    }
  }
  // 5. Vertical expiry line
  if (expX !== null && expX >= plot.left && expX <= plot.right && Math.abs(p.x - expX) <= 12 && p.y >= plot.top && p.y <= plot.bottom) {
    return draft && draft.price > 0 ? "both" : "expiry";
  }
  return null;
}

function wireGestures() {
  const stage = $("timeline-stage");
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!view) return;
      if ((e.target as HTMLElement)?.closest?.("#chart-pos-popup")) return;
      e.preventDefault();
      const p = point(e);
      follow = false;
      if (p.x > plot.right || e.shiftKey)
        view.price = zoomAxis(
          view.price,
          priceAt(p.y),
          Math.exp(e.deltaY * 0.002),
          spot() * 0.00001,
          spot() * 100,
        );
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY))
        view.time = panAxis(view.time, e.deltaX / (plot.right - plot.left));
      else
        view.time = zoomAxis(
          view.time,
          timeAt(p.x),
          Math.exp(e.deltaY * 0.002),
          step() * 8,
          step() * 10000,
        );
      maybeLoadHistory();
      scheduleDraw();
    },
    { passive: false },
  );
  stage.onpointerdown = (e) => {
    if ((e.target as HTMLElement)?.closest?.("#chart-pos-popup")) return;
    if (!view || e.button > 0) return;
    const p = point(e);
    pointers.set(e.pointerId, p);
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {
      /* A cancelled pointer may already have left the surface. */
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        view: structuredClone(view),
        anchorTime: timeAt((a.x + b.x) / 2),
        anchorPrice: priceAt((a.y + b.y) / 2),
      };
      gesture = null;
      draftDrag = null;
      return;
    }
    const draftHit = hitTestDraftOrder(p);
    if (draftHit) {
      draftDrag = {
        mode: draftHit,
        startX: p.x,
        startY: p.y,
        moved: false,
      };
      gesture = null;
      stage.style.cursor = draftHit === "price" ? "ns-resize" : draftHit === "expiry" ? "ew-resize" : "move";
      return;
    }
    gesture = {
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
      view: structuredClone(view),
      moved: false,
      axis: p.x > plot.right,
    };
  };
  stage.onpointermove = (e) => {
    if ((e.target as HTMLElement)?.closest?.("#chart-pos-popup")) {
      crosshair = null;
      stage.style.cursor = "default";
      return;
    }
    const p = point(e);
    crosshair = inside(p) ? p : null;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

    if (draftDrag && view) {
      if (Math.hypot(p.x - draftDrag.startX, p.y - draftDrag.startY) > 3) {
        draftDrag.moved = true;
      }
      if (draftDrag.moved) {
        if ((draftDrag.mode === "both" || draftDrag.mode === "price") && draft) {
          const clampedY = Math.max(plot.top, Math.min(plot.bottom, p.y));
          const nextPx = Math.max(0.01, Math.round(priceAt(clampedY) * 100) / 100);
          draft.price = nextPx;
          ($("o-price") as HTMLInputElement).value = String(nextPx);
        }
        if (
          draftDrag.mode === "expiry" ||
          (draftDrag.mode === "both" && Math.abs(p.x - draftDrag.startX) > 6)
        ) {
          const clampedX = Math.max(plot.left, Math.min(plot.right, p.x));
          const rawTimeMs = timeAt(clampedX);
          const minAllowedMs = Date.now() + 60_000;
          const nextExpiryMs = Math.max(minAllowedMs, Math.round(rawTimeMs / 60_000) * 60_000);
          expiry = nextExpiryMs * 1e6;
          customExpiryMinutes = Math.max(1, Math.round((nextExpiryMs - Date.now()) / 60_000));
        }
        reconcileDraft();
        clearTimeout(draftDragQuoteTimer);
        draftDragQuoteTimer = setTimeout(() => void quote(), 95);
        scheduleDraw();
      }
      return;
    }

    if (!gesture && inside(p)) {
      const draftHit = hitTestDraftOrder(p);
      if (draftHit) {
        hoveredPositionKey = null;
        stage.style.cursor = draftHit === "price" ? "ns-resize" : draftHit === "expiry" ? "ew-resize" : "move";
      } else {
        const hit = hitTestPosition(p);
        const nextKey = hit ? posKeyOf(hit) : null;
        if (nextKey !== hoveredPositionKey) {
          hoveredPositionKey = nextKey;
        }
        stage.style.cursor = hit ? "pointer" : "crosshair";
      }
    } else if (!gesture) {
      hoveredPositionKey = null;
      stage.style.cursor = "crosshair";
    }
    if (pinch && pointers.size === 2 && view) {
      const [a, b] = [...pointers.values()],
        distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      follow = false;
      view.time = zoomAxis(
        pinch.view.time,
        pinch.anchorTime,
        pinch.distance / distance,
        step() * 8,
        step() * 10000,
      );
      view.price = zoomAxis(
        pinch.view.price,
        pinch.anchorPrice,
        pinch.distance / distance,
        spot() * 0.00001,
        spot() * 100,
      );
    } else if (gesture && view) {
      if (Math.hypot(p.x - gesture.startX, p.y - gesture.startY) > 5)
        gesture.moved = true;
      if (gesture.moved) {
        follow = false;
        stage.classList.add("dragging");
        if (gesture.axis)
          view.price = zoomAxis(
            gesture.view.price,
            (gesture.view.price.min + gesture.view.price.max) / 2,
            Math.exp((p.y - gesture.startY) * 0.008),
            spot() * 0.00001,
            spot() * 100,
          );
        else {
          view.time = panAxis(
            gesture.view.time,
            -(p.x - gesture.startX) / (plot.right - plot.left),
          );
          view.price = panAxis(
            gesture.view.price,
            (p.y - gesture.startY) / (plot.bottom - plot.top),
          );
        }
      }
    }
    scheduleDraw();
  };
  stage.onpointerup = (e) => {
    if ((e.target as HTMLElement)?.closest?.("#chart-pos-popup")) return;
    const p = point(e);
    if (draftDrag) {
      const wasMoved = draftDrag.moved;
      draftDrag = null;
      pointers.delete(e.pointerId);
      stage.classList.remove("dragging");
      if (wasMoved && draft && draft.price > 0) {
        clearTimeout(draftDragQuoteTimer);
        editDraft();
        $("o-status").innerHTML = `<span style="color:#34d399">✓ Adjusted pending order: Strike ${money(draft.price)} · Expiry ${expiry ? `${date(expiry / 1e6)} ${tzLabel()}` : ""}</span>`;
      } else if (!wasMoved && inside(p) && view) {
        openEditor(priceAt(p.y));
      }
      scheduleDraw();
      return;
    }
    const click = gesture && !gesture.moved && pointers.size === 1 && inside(p);
    pointers.delete(e.pointerId);
    gesture = null;
    pinch = null;
    stage.classList.remove("dragging");
    if (click && view) {
      const hitPos = hitTestPosition(p);
      if (hitPos) {
        openPositionPopup(hitPos, p);
      } else {
        closePositionPopup();
        openEditor(priceAt(p.y));
      }
    } else {
      maybeLoadHistory();
    }
  };
  stage.onpointercancel = (e) => {
    pointers.delete(e.pointerId);
    gesture = null;
    pinch = null;
    draftDrag = null;
    stage.classList.remove("dragging");
  };
  stage.onpointerleave = () => {
    if (!gesture) {
      crosshair = null;
      hoveredPositionKey = null;
      stage.style.cursor = "crosshair";
      scheduleDraw();
    }
  };
  stage.ondblclick = () => {
    closePositionPopup();
    closeEditor();
    resetView();
  };
  stage.onkeydown = (e) => {
    if (!view) return;
    if (e.key === "Escape") {
      closePositionPopup();
      closeEditor();
      return;
    }
    if (e.key.toLowerCase() === "r") {
      resetView();
      return;
    }
    if (e.key === "Enter") {
      openEditor(priceAt(crosshair?.y ?? (plot.top + plot.bottom) / 2));
      return;
    }
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "+",
        "=",
        "-",
      ].includes(e.key)
    )
      return;
    e.preventDefault();
    follow = false;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight")
      view.time = panAxis(view.time, e.key === "ArrowLeft" ? -0.15 : 0.15);
    else if (e.key === "ArrowUp" || e.key === "ArrowDown")
      view.price = panAxis(view.price, e.key === "ArrowUp" ? 0.15 : -0.15);
    else
      view.time = zoomAxis(
        view.time,
        (view.time.min + view.time.max) / 2,
        e.key === "-" ? 1.25 : 0.8,
        step() * 8,
        step() * 10000,
      );
    maybeLoadHistory();
    scheduleDraw();
  };
}

async function loadTicks() {
  if (ticksLoading || document.hidden) return;
  ticksLoading = true;
  const requested = asset;
  try {
    const r = await fetch(`/chart-ticks?asset=${asset}`, { cache: "no-store" });
    if (!r.ok) return;
    const body = await r.json();
    if (requested !== asset || !Array.isArray(body.ticks)) return;
    ticks = body.ticks.filter(
      (t: { time: number; price: number }) =>
        Number.isFinite(t.time) && Number.isFinite(t.price) && t.price > 0,
    );
    const last = ticks.at(-1)?.price;
    if (last && last > 0) {
      if (smoothSpot === null) {
        smoothSpot = smoother.sample(last, performance.now(), true);
      }
      syncLiveCandle(last, Date.now());
    }
    startSmooth();
    scheduleDraw();
  } catch {
  } finally {
    ticksLoading = false;
  }
}
async function loadStats() {
  const requested = asset;
  try {
    const r = await fetch(`/chart-stats?asset=${asset}`, { cache: "no-store" });
    if (!r.ok) return;
    const body = await r.json();
    if (requested === asset && body.stats) {
      marketStats = body.stats;
      scheduleDraw();
    }
  } catch {}
}
function startSmooth() {
  if (animating) return;
  animating = true;
  const frame = (now: number) => {
    if (
      document.hidden ||
      !document.getElementById("page-chart")?.classList.contains("on")
    ) {
      animating = false;
      return;
    }
    displayNow = displayClock.sample(Date.now(), now);
    const target = ticks.at(-1)?.price ?? spot();
    if (
      target > 0 &&
      document.getElementById("page-chart")?.classList.contains("on")
    ) {
      const next = smoother.sample(target, now, reducedMotion.matches);
      smoothSpot = next;
      syncLiveCandle(next, displayNow);
      const pixelsPerMs = view
        ? (plot.right - plot.left) / (view.time.max - view.time.min)
        : 0;
      const pricePixels = view
        ? (Math.abs(next - lastPaintPrice) * (plot.bottom - plot.top)) /
          (view.price.max - view.price.min)
        : Infinity;
      const currentSec = Math.floor(displayNow / 250);
      if (
        pricePixels >= 0.04 ||
        currentSec !== lastPaintSecond ||
        (follow && (displayNow - lastPaintTime) * pixelsPerMs >= 0.08)
      ) {
        lastPaintTime = displayNow;
        lastPaintPrice = next;
        lastPaintSecond = currentSec;
        scheduleDraw();
      }
    }
    if (document.getElementById("page-chart")?.classList.contains("on"))
      requestAnimationFrame(frame);
    else animating = false;
  };
  requestAnimationFrame(frame);
}
function renderStats() {
  const el = document.getElementById("chart-stats");
  if (!el) return;
  const px = smoothSpot ?? spot();
  const stats = marketStats;
  const pct = stats?.changePct24h;
  const cls = pct == null ? "" : pct >= 0 ? "up" : "down";
  const vol = stats
    ? stats.volumeUsd24h >= 1e9
      ? `$${(stats.volumeUsd24h / 1e9).toFixed(2)}B`
      : `$${(stats.volumeUsd24h / 1e6).toFixed(1)}M`
    : "—";
  const openPosCount = getOpenPositionsForAsset().length;
  const statsText = `${money(px)}:${pct}:${vol}:${stats?.high24h}:${stats?.low24h}:${stats?.trades24h}:${openPosCount}`;
  if (statsText === lastStatsText) return;
  lastStatsText = statsText;
  el.replaceChildren();
  const price = document.createElement("b");
  price.innerHTML = px ? `${chartIconSvg(asset, 16)}${asset}/USDT ${money(px)}` : "—";
  el.append(price);
  if (pct != null) {
    const chg = document.createElement("span");
    chg.className = cls;
    chg.textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% 24h`;
    el.append(chg);
  }
  if (stats) {
    for (const label of [
      `24h High ${money(stats.high24h)}`,
      `24h Low ${money(stats.low24h)}`,
      `24h Vol ${vol}`,
      openPosCount > 0 ? `${openPosCount} Open Position${openPosCount === 1 ? "" : "s"} on Chart` : "",
    ]) {
      if (!label) continue;
      const span = document.createElement("span");
      span.textContent = label;
      el.append(span);
    }
  }
}

function renderPositionsPanel() {
  const summaryEl = document.getElementById("chart-positions-summary");
  const bodyEl = document.getElementById("chart-positions-body");
  if (!summaryEl || !bodyEl) return;
  const allOpen = getOpenPositionsForAsset("");
  const allClosed = Array.isArray(current?.tape?.closed) ? current.tape.closed : [];
  const openBtn = document.getElementById("chart-tab-open");
  const histBtn = document.getElementById("chart-tab-history");
  if (openBtn) openBtn.textContent = `Positions (${allOpen.length})`;
  if (histBtn) histBtn.textContent = `Trade History (${allClosed.length})`;

  const popup = document.getElementById("chart-pos-popup");
  if (popup && !popup.hidden && popupPosition) {
    const freshPos = allOpen.find((p: any) => p.ticketId === popupPosition.ticketId);
    if (freshPos) {
      openPositionPopup(freshPos);
    }
  }
  const sig = JSON.stringify({
    tab: bottomPanelTab,
    open: allOpen.map((p: any) => [
      p.ticketId,
      p.asset,
      p.kind,
      p.low,
      p.high,
      p.contracts,
      p.cost,
      p.maxPayout,
      p.mark,
      p.exitUnit,
      p.open,
      p.expiryNs,
      Math.floor(Date.now() / 5000),
    ]),
    closed: allClosed.slice(0, 12).map((c: any) => [c.ticketId, c.series, c.pnl, c.atMs ?? c.at]),
    asset,
    tz: tzMode,
  });
  if (sig === lastPositionsSig) return;
  lastPositionsSig = sig;

  if (bottomPanelTab === "history") {
    if (!allClosed.length) {
      summaryEl.textContent = "0 closed or expired trades for this account yet";
      bodyEl.innerHTML = `<div style="color:#7d8792;font:11px var(--sans,'Satoshi',sans-serif);padding:4px 2px">No expired or closed trades yet. When a position expires or is closed back to the pool, it is permanently recorded here.</div>`;
      return;
    }
    const totalRealised = allClosed.reduce((acc: number, c: any) => acc + Number(c.pnl || 0), 0);
    const rColor = totalRealised >= 0 ? "#34d399" : "#ff5a65";
    summaryEl.innerHTML = `<span><b>${allClosed.length}</b> Settled / Closed Trade${allClosed.length === 1 ? "" : "s"}</span><span>Realised P&amp;L: <b style="color:${rColor}">${totalRealised >= 0 ? "+" : ""}${money(totalRealised)} USDT</b></span>`;

    const table = document.createElement("table");
    table.className = "chart-positions-table";
    table.innerHTML = `<thead><tr>
      <th>Settled / Expiry (${tzLabel()})</th>
      <th>Position / Spread</th>
      <th>Side</th>
      <th>Size</th>
      <th>Paid (USDT)</th>
      <th>Received (USDT)</th>
      <th>Realised P&amp;L</th>
      <th>Settlement</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const row of allClosed) {
      const tr = document.createElement("tr");
      const pnl = Number(row.pnl ?? 0);
      const pnlCls = pnl >= 0 ? "#34d399" : "#ff5a65";
      const timeMs = Number(row.atMs || (row.expiryNs ? Number(row.expiryNs) / 1e6 : 0));
      const timeStr = timeMs > 0 ? `${date(timeMs)} ${tzLabel()}` : String(row.at || "—");
      tr.innerHTML = `
        <td>${timeStr}</td>
        <td><b>${row.series}</b>${row.ticketId ? ` <span style="color:#7d8792">#${row.ticketId}</span>` : ""}</td>
        <td><span class="chart-pos-badge call">${String(row.side || "LONG").toUpperCase()}</span></td>
        <td><b>${fmtQty(Number(row.contracts || 1))}</b> ct</td>
        <td>${money(Number(row.cost ?? 0))}</td>
        <td>${money(Number(row.proceeds ?? 0))}</td>
        <td style="color:${pnlCls};font-weight:600">${pnl >= 0 ? "+" : ""}${money(pnl)}</td>
        <td style="color:#9aa3ad">${row.via || "settled at expiry"}</td>
      `;
      tbody.append(tr);
    }
    table.append(tbody);
    bodyEl.replaceChildren(table);
    return;
  }

  if (!allOpen.length) {
    summaryEl.textContent = allClosed.length
      ? `0 open positions · ${allClosed.length} settled/expired trade${allClosed.length === 1 ? "" : "s"} in Trade History tab`
      : "0 open positions · Click any price on the chart or enter any strike in New Order to open a position";
    bodyEl.innerHTML = `<div style="color:#7d8792;font:11px var(--sans,'Satoshi',sans-serif);padding:4px 2px">No open positions right now.${allClosed.length ? ` Click <b>Trade History (${allClosed.length})</b> above to view your expired &amp; settled trades.` : " Positions you open appear both here and as clickable bounded horizontal spread lines on the chart."}</div>`;
    return;
  }

  const totalContracts = Number(allOpen.reduce((acc: number, p: any) => acc + Number(p.contracts || 0), 0).toFixed(4));
  const totalCost = allOpen.reduce((acc: number, p: any) => acc + Number(p.cost || 0), 0);
  const totalMaxPayout = allOpen.reduce((acc: number, p: any) => acc + Number(p.maxPayout || 0), 0);
  const totalPnl = allOpen.reduce((acc: number, p: any) => acc + Number(p.open || 0), 0);
  const pnlColor = totalPnl >= 0 ? "#34d399" : "#ff5a65";
  summaryEl.innerHTML = `<span><b>${allOpen.length}</b> Active</span><span>Contracts: <b>${fmtQty(totalContracts)}</b></span><span>Total Size (Cost): <b>${money(totalCost)} USDT</b> (Max Payout <b>${money(totalMaxPayout)}</b>)</span><span>Unrealized P&L: <b style="color:${pnlColor}">${totalPnl >= 0 ? "+" : ""}${money(totalPnl)}</b></span>`;

  const table = document.createElement("table");
  table.className = "chart-positions-table";
  table.innerHTML = `<thead><tr>
    <th>Position / Spread</th>
    <th>Side</th>
    <th>Contracts</th>
    <th>Position Size (Cost / Max)</th>
    <th>Mark / Exit Value</th>
    <th>Unrealized P&L</th>
    <th>Ends (Expiry ${tzLabel()})</th>
    <th>Chart & Action</th>
  </tr></thead>`;
  const tbody = document.createElement("tbody");

  for (const pos of allOpen) {
    const tr = document.createElement("tr");
    const strike = pos.kind === "Call" ? Number(pos.low) : Number(pos.high);
    const breakEvenPx = computePositionBreakEven(pos);
    const expMs = Number(pos.expiryNs) / 1e6;
    const pnl = Number(pos.open ?? 0);
    const pnlCls = pnl >= 0 ? "#34d399" : "#ff5a65";
    const countdown = formatCountdown(expMs - Date.now());
    const contracts = Math.max(0.0001, Number(pos.contracts || 1));
    const unitExit = Number(pos.exitUnit ?? pos.mark ?? Number(pos.value ?? 0) / contracts);
    const totalExit = Number(pos.value ?? unitExit * contracts);
    tr.innerHTML = `
      <td><b>${pos.asset}</b> ${money(Number(pos.low))}–${money(Number(pos.high))} <span style="color:#7d8792">(Strike ${money(strike)} · <span style="color:#d8f894">BE ${money(breakEvenPx)}</span>)</span></td>
      <td><span class="chart-pos-badge ${String(pos.kind).toLowerCase()}">${pos.kind}</span></td>
      <td><b>${fmtQty(contracts)}</b> ct</td>
      <td><b>${money(Number(pos.cost ?? 0))} USDT</b> <span style="color:#8b9099">/ Max ${money(Number(pos.maxPayout ?? 0))}</span></td>
      <td><b>${money(totalExit)}</b> <span style="color:#8b9099">(${money(unitExit)}/ct)</span></td>
      <td style="color:${pnlCls};font-weight:600">${pnl >= 0 ? "+" : ""}${money(pnl)}</td>
      <td>${date(expMs)} ${tzLabel()} <span style="color:#34d399">(${countdown})</span></td>
      <td></td>
    `;
    const actionCell = tr.lastElementChild as HTMLElement;
    const focusBtn = document.createElement("button");
    focusBtn.type = "button";
    focusBtn.className = "chart-pos-btn";
    focusBtn.textContent = "Focus on Chart";
    focusBtn.onclick = () => {
      if (pos.asset !== asset) {
        window.dispatchEvent(new CustomEvent("optionality-chart-asset", { detail: pos.asset }));
        setTimeout(() => focusPositionOnChart(pos), 200);
      } else {
        focusPositionOnChart(pos);
      }
    };
    actionCell.append(focusBtn);

    if (pos.action === "close" || pos.settlement === "open") {
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "chart-pos-btn close";
      closeBtn.textContent = `Close @ ${money(unitExit)}`;
      closeBtn.onclick = async () => {
        closeBtn.disabled = true;
        closeBtn.textContent = "Closing…";
        try {
          await window.optionalityWallet.submit({
            type: "close",
            asset: pos.asset,
            kind: pos.kind,
            strike,
            ticket: pos.ticketId,
            limit: unitExit,
            quantity: Number(pos.contracts),
            expiry: String(pos.expiryNs),
          });
          window.dispatchEvent(new CustomEvent("optionality-refresh-state"));
        } catch (err: any) {
          closeBtn.disabled = false;
          closeBtn.textContent = "Retry Close";
        }
      };
      actionCell.append(closeBtn);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  bodyEl.replaceChildren(table);
}

function draw() {
  if (!document.getElementById("timeline-stage")) return;
  const stage = $("timeline-stage"),
    W = stage.clientWidth,
    H = stage.clientHeight;
  if (!W) return;
  plot = {
    left: 12,
    right: W - 84,
    top: 38,
    bottom: H - 35,
    width: W,
    height: H,
  };
  for (const b of document.querySelectorAll<HTMLElement>(
    "#chart-assets [data-asset]",
  ))
    b.classList.toggle("active", b.dataset.asset === asset);
  for (const b of document.querySelectorAll<HTMLElement>("[data-interval]"))
    b.classList.toggle("active", b.dataset.interval === interval);
  const hud = $("timeline-hud");
  hud.textContent = follow ? "● Live" : "⏸ Paused · Click for Live";
  hud.classList.toggle("live", follow);
  renderStats();
  renderPositionsPanel();
  const svg = node("svg", {
    viewBox: `0 0 ${W} ${H}`,
    "aria-label": `${asset} price chart`,
  });
  if (!view) {
    svg.append(
      node(
        "text",
        { x: 20, y: 80, fill: "#8b9099", "font-size": 13, "font-family": "Satoshi, Plus Jakarta Sans, sans-serif" },
        "Loading price history…",
      ),
    );
    if (canvas) paintScene(canvas, svg, W, H);
    return;
  }
  if (follow) {
    const span = view.time.max - view.time.min;
    view.time = {
      min: displayNow - span / 1.35,
      max: displayNow + (span * 0.35) / 1.35,
    };
  }
  const defs = node("defs"),
    clip = node("clipPath", { id: "chart-clip" });
  clip.append(
    node("rect", {
      x: plot.left,
      y: plot.top,
      width: plot.right - plot.left,
      height: plot.bottom - plot.top,
    }),
  );
  defs.append(clip);
  svg.append(defs);
  const layer = node("g", { "clip-path": "url(#chart-clip)" });
  const nowX = xAt(displayNow);
  layer.append(
    node("rect", {
      x: Math.max(plot.left, nowX),
      y: plot.top,
      width: Math.max(0, plot.right - Math.max(plot.left, nowX)),
      height: plot.bottom - plot.top,
      fill: "rgba(243,239,230,.02)",
    }),
  );
  const raw = (view.price.max - view.price.min) / 6,
    magnitude = 10 ** Math.floor(Math.log10(raw)),
    r = raw / magnitude;
  const tick = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * magnitude;
  for (
    let price = Math.ceil(view.price.min / tick) * tick, count = 0;
    price <= view.price.max && count < 20;
    price += tick, count++
  ) {
    const y = yAt(price);
    svg.append(
      node("line", {
        x1: plot.left,
        x2: plot.right,
        y1: y,
        y2: y,
        stroke: "#242424",
        "stroke-dasharray": "2 5",
      }),
    );
    svg.append(
      node(
        "text",
        {
          x: plot.right + 7,
          y: y + 4,
          fill: "#8f9399",
          "font-size": 11,
          "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
        },
        price.toLocaleString("en-US", { maximumFractionDigits: 4 }),
      ),
    );
  }
  const timeSpan = view.time.max - view.time.min;
  for (let j = 0; j <= 4; j++) {
    const t = view.time.min + (timeSpan * j) / 4,
      x = xAt(t);
    svg.append(
      node("line", {
        x1: x,
        x2: x,
        y1: plot.top,
        y2: plot.bottom,
        stroke: "#1f1f1f",
      }),
    );
    const label = timeOfDay(t, timeSpan < 300000);
    svg.append(
      node(
        "text",
        {
          x,
          y: plot.bottom + 22,
          "text-anchor": j === 0 ? "start" : j === 4 ? "end" : "middle",
          fill: "#8f9399",
          "font-size": 11,
          "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
        },
        timeSpan > 86400000 ? `${date(t)} ${tzLabel()}` : `${label}${j === 4 ? ` (${tzLabel()})` : ""}`,
      ),
    );
  }
  const visible = candles.filter(
    (c) =>
      c.time >= view!.time.min - step() && c.time <= view!.time.max + step(),
  );

  // Volume histogram along bottom 14% of plot (Binance style)
  if (visible.length) {
    const maxVol = Math.max(...visible.map((c) => c.volume || 0), 1e-6);
    const volMaxHeight = (plot.bottom - plot.top) * 0.14;
    const wVol = Math.max(
      1,
      Math.min(
        13,
        Math.abs(xAt(view.time.min + step()) - xAt(view.time.min)) * 0.68,
      ),
    );
    for (const c of visible) {
      const x = xAt(c.time);
      const vh = Math.max(1, ((c.volume || 0) / maxVol) * volMaxHeight);
      const vColor =
        c.close >= c.open
          ? "rgba(20,224,145,0.22)"
          : "rgba(240,60,86,0.22)";
      layer.append(
        node("rect", {
          x: x - wVol / 2,
          y: plot.bottom - vh,
          width: wVol,
          height: vh,
          fill: vColor,
        }),
      );
    }
  }

  if (chartStyle === "candles") {
    const w = Math.max(
      1.5,
      Math.min(
        14,
        Math.abs(xAt(view.time.min + step()) - xAt(view.time.min)) * 0.72,
      ),
    );
    for (const c of visible) {
      const x = xAt(c.time),
        color = c.close >= c.open ? "#14e091" : "#f03c56";
      layer.append(
        node("line", {
          x1: x,
          x2: x,
          y1: yAt(c.high),
          y2: yAt(c.low),
          stroke: color,
        }),
      );
      layer.append(
        node("rect", {
          x: x - w / 2,
          y: Math.min(yAt(c.open), yAt(c.close)),
          width: w,
          height: Math.max(1.2, Math.abs(yAt(c.open) - yAt(c.close))),
          fill: color,
        }),
      );
    }
  } else {
    let segment: string[] = [];
    const flush = () => {
      if (segment.length > 1)
        layer.append(
          node("polyline", {
            points: segment.join(" "),
            fill: "none",
            stroke: "#f4ede4",
            "stroke-width": 2,
            "stroke-linejoin": "round",
          }),
        );
      segment = [];
    };
    let previous = 0;
    for (const c of visible) {
      if (previous && c.time - previous > step() * 1.5) flush();
      segment.push(`${xAt(c.time)},${yAt(c.close)}`);
      previous = c.time;
    }
    flush();
  }

  const lastBar = candles.at(-1);
  if (
    !indicatorCache ||
    indicatorCache.source !== candles ||
    indicatorCache.len !== candles.length ||
    indicatorCache.lastClose !== (lastBar?.close ?? 0) ||
    indicatorCache.lastHigh !== (lastBar?.high ?? 0) ||
    indicatorCache.lastLow !== (lastBar?.low ?? 0)
  ) {
    const closes = candles.map((candle) => candle.close);
    indicatorCache = {
      source: candles,
      len: candles.length,
      lastClose: lastBar?.close ?? 0,
      lastHigh: lastBar?.high ?? 0,
      lastLow: lastBar?.low ?? 0,
      ema: calcEMA(closes, 20),
      vwap: calcVWAP(candles),
      bands: calcBollingerBands(closes, 20, 2),
    };
  }
  const overlays: Array<[boolean, Array<number | null>, string]> = [
    [indicators.ema, indicatorCache.ema, "#f0b90b"],
    [indicators.vwap, indicatorCache.vwap, "#8ec8ff"],
  ];
  if (indicators.bb) {
    const bands = indicatorCache.bands;
    overlays.push([true, bands.map((b) => b.upper), "rgba(198,242,78,.45)"]);
    overlays.push([true, bands.map((b) => b.lower), "rgba(198,242,78,.45)"]);
    overlays.push([true, bands.map((b) => b.middle), "rgba(198,242,78,.25)"]);
  }
  for (const [on, seriesValues, color] of overlays) {
    if (!on) continue;
    const pts = candles
      .map((c, i) => {
        const v = seriesValues[i];
        if (
          v == null ||
          c.time < view!.time.min - step() ||
          c.time > view!.time.max + step()
        )
          return "";
        return `${xAt(c.time)},${yAt(v)}`;
      })
      .filter(Boolean);
    if (pts.length > 1)
      layer.append(
        node("polyline", {
          points: pts.join(" "),
          fill: "none",
          stroke: color,
          "stroke-width": 1.35,
          "stroke-linejoin": "round",
        }),
      );
  }

  // Draw Open Positions on Chart Canvas (Bounded horizontal line + Break-Even line + spread band ending strictly at expiryX)
  positionHitRegions = [];
  const assetPositions = getOpenPositionsForAsset(asset);
  for (let idx = 0; idx < assetPositions.length; idx++) {
    const pos = assetPositions[idx];
    const posKind: Kind = pos.kind === "Put" ? "Put" : "Call";
    const posColor = COLOR[posKind];
    const posLow = Number(pos.low);
    const posHigh = Number(pos.high);
    const posStrike = posKind === "Call" ? posLow : posHigh;
    const posExpiryMs = Number(pos.expiryNs) / 1e6;
    if (!Number.isFinite(posStrike) || posStrike <= 0 || !Number.isFinite(posExpiryMs)) continue;

    const breakEvenPx = computePositionBreakEven(pos);
    const expiryX = xAt(posExpiryMs);
    const yStrike = yAt(posStrike);
    const yBreakEven = yAt(breakEvenPx);
    const yHigh = yAt(posHigh);
    const yLow = yAt(posLow);

    // Line & spread band start from left edge of plot and end strictly at expiryX
    const xStart = plot.left;
    const xEnd = Math.min(plot.right, expiryX);
    const pKey = posKeyOf(pos);
    const isHighlighted =
      hoveredPositionKey === pKey ||
      (popupPosition && posKeyOf(popupPosition) === pKey);
    const posBeColor =
      posKind === "Call"
        ? isHighlighted
          ? "rgba(232,252,184,0.95)"
          : "rgba(218,248,148,0.68)"
        : isHighlighted
          ? "rgba(255,184,188,0.95)"
          : "rgba(255,158,162,0.68)";

    if (xEnd > xStart) {
      const bandTop = Math.min(yHigh, yLow);
      const bandHeight = Math.max(2, Math.abs(yLow - yHigh));
      layer.append(
        node("rect", {
          x: xStart,
          y: bandTop,
          width: Math.max(0, xEnd - xStart),
          height: bandHeight,
          fill:
            posKind === "Call"
              ? isHighlighted
                ? "rgba(198,242,78,0.16)"
                : "rgba(198,242,78,0.08)"
              : isHighlighted
                ? "rgba(229,72,77,0.16)"
                : "rgba(229,72,77,0.08)",
        }),
      );
      // Cap line at the other bound of the spread
      const yCap = posKind === "Call" ? yHigh : yLow;
      layer.append(
        node("line", {
          x1: xStart,
          x2: xEnd,
          y1: yCap,
          y2: yCap,
          stroke: posKind === "Call" ? "rgba(198,242,78,0.45)" : "rgba(229,72,77,0.45)",
          "stroke-width": isHighlighted ? 1.5 : 1,
          "stroke-dasharray": "3 4",
        }),
      );
      // Break-Even horizontal line (lighter color, dashed, bounded at expiryX)
      layer.append(
        node("line", {
          class: "position-breakeven-line",
          x1: xStart,
          x2: xEnd,
          y1: yBreakEven,
          y2: yBreakEven,
          stroke: posBeColor,
          "stroke-width": isHighlighted ? 1.85 : 1.4,
          "stroke-dasharray": "6 4",
        }),
      );
      // Break-Even inline tag on the chart
      if (xEnd > xStart + 160 && yBreakEven >= plot.top + 8 && yBreakEven <= plot.bottom - 6) {
        const beText = `Break-Even ${money(breakEvenPx)}`;
        const beTagW = beText.length * 5.9 + 12;
        const beTagX = Math.max(xStart + 14, Math.min(xEnd - beTagW - 76, xEnd - beTagW - 14));
        const beTagY = Math.abs(yBreakEven - yStrike) < 18
          ? (posKind === "Call" ? yBreakEven - 17 : yBreakEven + 3)
          : yBreakEven - 9;
        layer.append(
          node("rect", {
            x: beTagX,
            y: beTagY,
            width: beTagW,
            height: 15,
            rx: 3,
            fill: "rgba(10,15,20,0.84)",
            stroke: posBeColor,
            "stroke-width": 0.9,
          }),
        );
        layer.append(
          node(
            "text",
            {
              x: beTagX + 6,
              y: beTagY + 10.5,
              fill: posBeColor,
              "font-size": 9.5,
              "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
            },
            beText,
          ),
        );
      }
      // Primary position strike line (solid, bounded at expiryX, clickable)
      layer.append(
        node("line", {
          class: "position-strike-line",
          x1: xStart,
          x2: xEnd,
          y1: yStrike,
          y2: yStrike,
          stroke: posColor,
          "stroke-width": isHighlighted ? 3.5 : 2.3,
        }),
      );
    }

    // Terminal marker at expiryX (where the position ends)
    if (expiryX >= plot.left && expiryX <= plot.right) {
      // Vertical bracket spanning the spread [high, low] at expiry
      layer.append(
        node("line", {
          x1: expiryX,
          x2: expiryX,
          y1: Math.min(yHigh, yLow),
          y2: Math.max(yHigh, yLow),
          stroke: posColor,
          "stroke-width": isHighlighted ? 3.2 : 2.5,
        }),
      );
      // Endpoint circle on the break-even line at expiryX
      layer.append(
        node("circle", {
          cx: expiryX,
          cy: yBreakEven,
          r: isHighlighted ? 4.2 : 3.2,
          fill: "#0a0f14",
          stroke: posBeColor,
          "stroke-width": 1.7,
        }),
      );
      // Endpoint circle on the strike line at expiryX
      layer.append(
        node("circle", {
          cx: expiryX,
          cy: yStrike,
          r: isHighlighted ? 5.8 : 4.5,
          fill: "#0a0f14",
          stroke: posColor,
          "stroke-width": 2.3,
        }),
      );
      // Expiry termination label right at the end of the position line
      const endLabelY = Math.max(plot.top + 14, Math.min(plot.bottom - 8, yStrike - 7));
      layer.append(
        node(
          "text",
          {
            x: Math.max(plot.left + 80, Math.min(plot.right - 8, expiryX - 6)),
            y: endLabelY,
            "text-anchor": "end",
            fill: posColor,
            "font-size": 10,
            "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
          },
          `Ends ${date(posExpiryMs)} ${tzLabel()}`,
        ),
      );
    }

    // Position details badge on the chart (Contracts, Break-Even, Size, P&L + Click to Close hint)
    let badgeRect: { x: number; y: number; width: number; height: number } | null = null;
    if (xEnd > plot.left + 40) {
      const badgeY = Math.max(plot.top + 18 + idx * 22, Math.min(plot.bottom - 18, yStrike));
      const pnlVal = Number(pos.open ?? 0);
      const pnlSign = pnlVal >= 0 ? "+" : "";
      const labelText = `${posKind.toUpperCase()} ${money(posLow)}/${money(posHigh)} · BE ${money(breakEvenPx)} · ${fmtQty(Number(pos.contracts || 1))} ct · Size ${money(Number(pos.cost ?? 0))} · P&L ${pnlSign}${money(pnlVal)} · Click to Close`;
      const badgeW = Math.min(plot.right - plot.left - 16, labelText.length * 6.2 + 16);
      badgeRect = {
        x: plot.left + 8,
        y: badgeY - 17,
        width: badgeW,
        height: 20,
      };
      layer.append(
        node("rect", {
          x: badgeRect.x,
          y: badgeRect.y,
          width: badgeRect.width,
          height: badgeRect.height,
          rx: 4,
          fill: isHighlighted ? "rgba(18,26,35,0.96)" : "rgba(10,15,20,0.88)",
          stroke: posColor,
          "stroke-width": isHighlighted ? 1.8 : 1.1,
        }),
      );
      layer.append(
        node(
          "text",
          {
            x: plot.left + 15,
            y: badgeY - 4,
            fill: posColor,
            "font-size": 10.5,
            "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
          },
          labelText,
        ),
      );
    }

    positionHitRegions.push({
      pos,
      yStrike,
      yBreakEven,
      yHigh,
      yLow,
      xStart,
      xEnd,
      badgeRect,
    });
  }

  // Vertical "now" divider
  layer.append(
    node("line", {
      x1: nowX,
      x2: nowX,
      y1: plot.top,
      y2: plot.bottom,
      stroke: "#48525c",
      "stroke-dasharray": "3 6",
    }),
  );

  // Binance-style full-width live price dashed line + right-axis live price pill + bar countdown
  const beacon = smoothSpot ?? spot();
  if (beacon) {
    const liveY = yAt(beacon);
    const liveCandle = candles.at(-1);
    const isUp = !liveCandle || liveCandle.close >= liveCandle.open;
    const liveColor = isUp ? "#34d399" : "#ff5a65";
    layer.append(
      node("line", {
        x1: plot.left,
        x2: plot.right,
        y1: liveY,
        y2: liveY,
        stroke: liveColor,
        "stroke-width": 1,
        "stroke-dasharray": "3 3",
      }),
    );
    layer.append(
      node("circle", { cx: nowX, cy: liveY, r: 4, fill: liveColor }),
    );
    if (liveY >= plot.top && liveY <= plot.bottom) {
      const remMs = Math.max(0, Math.ceil((Math.floor(displayNow / step()) + 1) * step() - displayNow));
      const remSec = Math.floor(remMs / 1000);
      const countdownStr =
        remSec >= 3600
          ? formatCountdown(remMs)
          : `${String(Math.floor(remSec / 60)).padStart(2, "0")}:${String(remSec % 60).padStart(2, "0")}`;
      svg.append(
        node("rect", {
          x: plot.right + 1,
          y: liveY - 15,
          width: 82,
          height: 30,
          fill: liveColor,
          rx: 3,
        }),
      );
      svg.append(
        node(
          "text",
          {
            x: plot.right + 5,
            y: liveY - 2,
            fill: "#090e11",
            "font-size": 11,
            "font-weight": "700",
            "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
          },
          money(beacon),
        ),
      );
      svg.append(
        node(
          "text",
          {
            x: plot.right + 5,
            y: liveY + 10,
            fill: "#090e11",
            "font-size": 9.5,
            "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
          },
          countdownStr,
        ),
      );
    }
  }

  // Top-left Binance-style OHLCV + Indicator Header Bar inside plot
  const inspectedCandle = (() => {
    if (crosshair && inside(crosshair) && visible.length) {
      const tHover = timeAt(crosshair.x);
      return visible.reduce((best, c) =>
        Math.abs(c.time - tHover) < Math.abs(best.time - tHover) ? c : best,
      visible[0]);
    }
    return candles.at(-1) ?? null;
  })();
  if (inspectedCandle) {
    const chg = inspectedCandle.close - inspectedCandle.open;
    const chgPct = inspectedCandle.open > 0 ? (chg / inspectedCandle.open) * 100 : 0;
    const ohlcColor = chg >= 0 ? "#34d399" : "#ff5a65";
    const emaVal = indicatorCache?.ema.at(-1);
    const vwapVal = indicatorCache?.vwap.at(-1);
    const headerStr = `O ${money(inspectedCandle.open)}   H ${money(inspectedCandle.high)}   L ${money(inspectedCandle.low)}   C ${money(inspectedCandle.close)} (${chg >= 0 ? "+" : ""}${chgPct.toFixed(2)}%)   Vol ${inspectedCandle.volume.toFixed(2)}${indicators.ema && emaVal ? `   EMA20 ${money(emaVal)}` : ""}${indicators.vwap && vwapVal ? `   VWAP ${money(vwapVal)}` : ""}`;
    svg.append(
      node(
        "text",
        {
          x: plot.left + 6,
          y: plot.top - 10,
          fill: ohlcColor,
          "font-size": 10.5,
          "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
        },
        headerStr,
      ),
    );
  }

  if (expiry) {
    const x = xAt(expiry / 1e6),
      g = node("g", { class: "expiry-wall" });
    g.append(
      node("line", {
        class: "expiry-line",
        stroke:
          crosshair && Math.abs(crosshair.x - x) < 14
            ? "#f4ede4"
            : "rgba(243,239,230,.5)",
        x1: x,
        x2: x,
        y1: plot.top,
        y2: plot.bottom,
      }),
    );
    g.append(
      node("rect", {
        x: x - 10,
        y: plot.top,
        width: 20,
        height: plot.bottom - plot.top,
        fill: "transparent",
      }),
    );
    layer.append(g);
    const isUtc0Daily = Math.floor(expiry / 1e9) % 86400 === 0;
    const expiryBannerText =
      customExpiryMinutes !== null
        ? `Order Expiry · +${customExpiryMinutes}m (${date(expiry / 1e6)} ${tzLabel()})`
        : isUtc0Daily
          ? `Order Expiry · ${date(expiry / 1e6)} ${tzLabel()} (00:00 UTC Daily)`
          : `Order Expiry · ${date(expiry / 1e6)} ${tzLabel()}`;
    if (x >= plot.left && x <= plot.right)
      svg.append(
        node(
          "text",
          {
            x: Math.max(plot.left + 160, Math.min(plot.right - 130, x)),
            y: plot.top + 13,
            "text-anchor": "middle",
            fill: isUtc0Daily || customExpiryMinutes !== null ? "#34d399" : "#a8afb7",
            "font-size": 10.5,
            "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
          },
          expiryBannerText,
        ),
      );
    else
      svg.append(
        node(
          "text",
          {
            x: plot.right - 6,
            y: plot.top + 13,
            "text-anchor": "end",
            fill: "#8b9099",
            "font-size": 10.5,
            "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
          },
          `${expiryBannerText} →`,
        ),
      );
  }
  if (draft && draft.price > 0) {
    const y = yAt(draft.price),
      color = COLOR[draft.kind];
    const draftExpX = expiry ? xAt(expiry / 1e6) : plot.right;
    const draftLineEnd = Math.max(plot.left + 20, Math.min(plot.right, draftExpX));
    const bounds = computeSpreadBounds(asset, draft.kind, draft.price, selected && selected.expiryNs === expiry ? selected : null);
    const yBoundLow = yAt(bounds.low);
    const yBoundHigh = yAt(bounds.high);
    const isDraggingThis = Boolean(draftDrag);
    const draftUnitCost =
      latestQuote && latestQuote.quantity > 0
        ? latestQuote.premium / latestQuote.quantity
        : null;
    const draftBreakEvenPx =
      draftUnitCost !== null && draftUnitCost > 0
        ? draft.kind === "Call"
          ? Math.min(bounds.high, bounds.low + draftUnitCost)
          : Math.max(bounds.low, bounds.high - draftUnitCost)
        : null;
    const draftBeColor =
      draft.kind === "Call" ? "rgba(218,248,148,0.65)" : "rgba(255,158,162,0.65)";
    if (draftLineEnd > plot.left) {
      layer.append(
        node("rect", {
          x: plot.left,
          y: Math.min(yBoundLow, yBoundHigh),
          width: draftLineEnd - plot.left,
          height: Math.max(2, Math.abs(yBoundLow - yBoundHigh)),
          fill: draft.kind === "Call"
            ? isDraggingThis ? "rgba(198,242,78,0.14)" : "rgba(198,242,78,0.06)"
            : isDraggingThis ? "rgba(229,72,77,0.14)" : "rgba(229,72,77,0.06)",
        }),
      );
      if (draftBreakEvenPx !== null) {
        const yDraftBe = yAt(draftBreakEvenPx);
        layer.append(
          node("line", {
            x1: plot.left,
            x2: draftLineEnd,
            y1: yDraftBe,
            y2: yDraftBe,
            stroke: draftBeColor,
            "stroke-width": 1.3,
            "stroke-dasharray": "5 4",
          }),
        );
      }
    }
    layer.append(
      node("line", {
        class: "draft-price-line",
        "data-price": draft.price,
        x1: plot.left,
        x2: draftLineEnd,
        y1: y,
        y2: y,
        stroke: color,
        "stroke-width": isDraggingThis ? 2.6 : 2.0,
        "stroke-dasharray": "7 4",
      }),
    );
    if (draftLineEnd < plot.right) {
      layer.append(
        node("line", {
          x1: draftLineEnd,
          x2: plot.right,
          y1: y,
          y2: y,
          stroke: color,
          "stroke-width": 0.8,
          "stroke-dasharray": "2 6",
        }),
      );
    }
    // 2D Drag Handle at the (expiry, strike) intersection
    layer.append(
      node("circle", {
        cx: draftLineEnd,
        cy: y,
        r: isDraggingThis ? 7.5 : 6,
        fill: "#0a0f14",
        stroke: color,
        "stroke-width": 2.4,
      }),
    );
    layer.append(
      node("circle", {
        cx: draftLineEnd,
        cy: y,
        r: 2.2,
        fill: color,
      }),
    );
    const labelY = Math.max(plot.top + 18, Math.min(plot.bottom - 6, y));
    const draftLabelText = `✥ Pending ${draft.kind} @ ${money(draft.price)} (${money(bounds.low)}–${money(bounds.high)})${draftBreakEvenPx !== null ? ` · BE ${money(draftBreakEvenPx)}` : ""} · ${fmtQty(draft.quantity)} ct${expiry ? ` · Ends ${date(expiry / 1e6)} ${tzLabel()}` : ""} · Drag to adjust`;
    const draftPillW = Math.min(plot.right - plot.left - 16, draftLabelText.length * 6.2 + 16);
    svg.append(
      node("rect", {
        x: plot.left + 6,
        y: labelY - 20,
        width: draftPillW,
        height: 19,
        rx: 4,
        fill: isDraggingThis ? "rgba(18,26,35,0.96)" : "rgba(10,15,20,0.88)",
        stroke: color,
        "stroke-width": isDraggingThis ? 1.8 : 1.1,
      }),
    );
    svg.append(
      node(
        "text",
        {
          class: "draft-price-label",
          x: plot.left + 12,
          y: labelY - 7,
          fill: color,
          "font-size": 11,
          "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
        },
        draftLabelText,
      ),
    );
    if (y >= plot.top && y <= plot.bottom) {
      svg.append(
        node("rect", {
          x: plot.right + 1,
          y: y - 10,
          width: 82,
          height: 20,
          fill: color,
          rx: 3,
        }),
      );
      svg.append(
        node(
          "text",
          {
            x: plot.right + 5,
            y: y + 4,
            fill: "#090e11",
            "font-size": 11,
            "font-weight": "700",
            "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
          },
          money(draft.price),
        ),
      );
    }
  }
  if (crosshair && inside(crosshair)) {
    layer.append(
      node("line", {
        x1: crosshair.x,
        x2: crosshair.x,
        y1: plot.top,
        y2: plot.bottom,
        stroke: "#69747d",
        "stroke-dasharray": "3 4",
      }),
    );
    layer.append(
      node("line", {
        x1: plot.left,
        x2: plot.right,
        y1: crosshair.y,
        y2: crosshair.y,
        stroke: "#69747d",
        "stroke-dasharray": "3 4",
      }),
    );
    svg.append(
      node(
        "text",
        {
          x: plot.right + 5,
          y: crosshair.y - 5,
          fill: "#f4ede4",
          "font-size": 11,
          "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
        },
        money(priceAt(crosshair.y)),
      ),
    );
  }
  svg.append(layer);
  svg.append(
    node("line", {
      x1: plot.right,
      x2: plot.right,
      y1: plot.top,
      y2: plot.bottom,
      stroke: "#29323a",
    }),
  );
  const notice = historyLoading ? "Loading earlier prices…" : historyNotice;
  if (notice)
    svg.append(
      node(
        "text",
        {
          x: plot.left + 6,
          y: plot.top + 28,
          fill: "#a8afb7",
          "font-size": 12,
          "font-family": "Satoshi, Plus Jakarta Sans, sans-serif",
        },
        notice,
      ),
    );
  if (canvas) paintScene(canvas, svg, W, H);
  stage.dataset.price = String(smoothSpot ?? spot());
  stage.dataset.draftPrice = draft ? String(draft.price) : "";
  stage.dataset.viewStart = String(view.time.min);
  stage.dataset.viewSpan = String(view.time.max - view.time.min);
}
async function update(input: any) {
  current = input.state;
  ensure();
  if (input.asset !== asset) {
    asset = input.asset;
    seriesAt = 0;
    ticks = [];
    marketStats = null;
    smoother.reset();
    smoothSpot = null;
    closePositionPopup();
    resetData();
    void loadTicks();
    void loadStats();
  }
  renderPositionsPanel();
  refreshBalanceState();
  scheduleDraw();
  void loadCandles();
  if (loadingSeries || Date.now() - seriesAt < 15000) return;
  loadingSeries = true;
  const requested = asset;
  try {
    const r = await fetch(`/chart-series?asset=${asset}`, {
      cache: "no-store",
    });
    if (!r.ok) return;
    const body = await r.json();
    if (requested !== asset) return;
    series = body.series;
    const expiries = [
      ...new Set(
        series
          .filter(
            (s) =>
              s.asset === asset &&
              s.settlement === "open" &&
              s.expiryNs / 1e6 > Date.now() + 30000,
          )
          .map((s) => s.expiryNs),
      ),
    ].sort((a, b) => a - b);
    const prev = expiry;
    const utc0Default = expiries.find((e) => Math.floor(e / 1e9) % 86400 === 0);
    if (customExpiryMinutes === null && (!expiry || expiry / 1e6 <= Date.now())) {
      expiry = utc0Default ?? expiries[0] ?? getNextUtcMidnightNs();
    }
    syncExpiryInputs();
    seriesAt = Date.now();
    if (!draft) draft = { price: 0, kind: "Call", quantity: 1 };
    if (draft && prev !== expiry) {
      editDraft();
    }
    scheduleDraw();
  } catch {
    syncExpiryInputs();
    historyNotice = "Market listings unavailable";
    scheduleDraw();
  } finally {
    loadingSeries = false;
  }
}
declare global {
  interface Window {
    optionalityWallet: any;
    optionalityChart: any;
  }
}
window.optionalityChart = { update };
window.dispatchEvent(new Event("optionality-chart-ready"));
