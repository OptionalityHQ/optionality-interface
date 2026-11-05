import { intrinsicValue, contractQuantity } from "./chart-model.ts";
/** A price/time view of actual listed spreads. No synthetic price forecasts. */
type Series = {
  seriesId: number;
  asset: string;
  kind: "Put" | "Call";
  low: number;
  high: number;
  expiryNs: number;
  settlement: string;
};
let current: any = null;
let asset = "ETH";
let series: Series[] = [];
let fetchedAt = 0;
let loading = false;
let selected: Series | null = null;
let quoteSequence = 0;
let latestQuote: any = null;
let busy = false;
const money = (value: number | null) =>
  value == null
    ? "unavailable"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 4,
      }).format(value);
const time = (ns: number) =>
  new Date(ns / 1e6).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const remaining = (ns: number) => {
  const seconds = Math.floor((ns / 1e6 - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  return seconds >= 86400
    ? `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
    : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};
const el = (tag: string, text?: string) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
};
function ensure() {
  const root = document.getElementById("positions-chart");
  if (!root || root.childElementCount) return root;
  const style = el("style");
  style.textContent = `
  .timeline-tools{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}.timeline-tools button,.timeline-list button{padding:9px 12px;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:5px;cursor:pointer}.timeline-plot{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden}.timeline-plot svg{display:block;width:100%;height:430px}.timeline-note{color:var(--dim);font-size:12px;line-height:1.6;margin:10px 0}.timeline-list{display:grid;gap:8px}.timeline-list button{text-align:left;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.timeline-order{color:var(--ink);background:var(--panel,var(--bg,#fff));border:1px solid var(--line);border-radius:12px;padding:24px;width:min(420px,90vw);box-sizing:border-box}.timeline-order::backdrop{background:rgba(0,0,0,.45)}.timeline-order label{display:block;margin:16px 0 6px}.timeline-order input,.timeline-order select{box-sizing:border-box;width:100%;padding:10px;background:transparent;color:inherit;border:1px solid var(--line);border-radius:4px}.timeline-order button{padding:10px 14px;margin:12px 6px 0 0;border:1px solid var(--line);border-radius:4px;background:transparent;color:inherit;cursor:pointer}.timeline-order p{font-size:13px;line-height:1.6}.timeline-order h2{margin:0}.timeline-order button:disabled{opacity:.5;cursor:wait}@media(max-width:600px){.timeline-plot svg{height:350px}.timeline-order{padding:18px}}
  `;
  root.append(style);
  const tools = el("div");
  tools.className = "timeline-tools";
  for (const symbol of ["ETH", "BTC"]) {
    const b = el("button", symbol);
    b.onclick = () => {
      window.dispatchEvent(
        new CustomEvent("optionality-chart-asset", { detail: symbol }),
      );
    };
    tools.append(b);
  }
  const select = el("select") as HTMLSelectElement;
  select.id = "timeline-range";
  select.setAttribute("aria-label", "Chart time range");
  for (const [label, value] of [
    ["Next 24 hours", "1"],
    ["Next 7 days", "7"],
  ]) {
    const o = el("option", label) as HTMLOptionElement;
    o.value = value;
    select.append(o);
  }
  select.onchange = draw;
  tools.append(select);
  tools.append(el("span", "Put · red   /   Call · green"));
  root.append(tools);
  const plot = el("div");
  plot.className = "timeline-plot";
  plot.id = "timeline-plot";
  root.append(plot);
  const note = el(
    "p",
    "The line shows observed session prices only. Future prices are unknown. Each wall spans the spread’s two strikes; coloured stripes mark your positions. ITM means intrinsic value above zero, not profit after premium.",
  );
  note.className = "timeline-note";
  root.append(note);
  root.append(el("h2", "Your positions"));
  const list = el("div");
  list.className = "timeline-list";
  list.id = "timeline-positions";
  root.append(list);
  const dialog = el("dialog") as HTMLDialogElement;
  dialog.className = "timeline-order";
  dialog.id = "timeline-order";
  dialog.innerHTML = `<form method="dialog"><h2 id="timeline-title">Spread</h2><p id="timeline-terms"></p><label for="timeline-kind">Option type</label><select id="timeline-kind"><option value="Put">Put</option><option value="Call">Call</option></select><label for="timeline-market">Listed spread</label><select id="timeline-market"></select><label for="timeline-size">Contracts</label><input id="timeline-size" type="number" min="1" step="1" value="1"><p id="timeline-quote" role="status"></p><button id="timeline-buy" type="button" disabled>Buy with wallet</button><button>Cancel</button><p id="timeline-result" role="status"></p></form>`;
  root.append(dialog);
  document.getElementById("timeline-kind")!.onchange = () =>
    chooseAlternatives();
  document.getElementById("timeline-market")!.onchange = () => {
    selected =
      series.find(
        (s) =>
          s.seriesId ===
          Number(
            (document.getElementById("timeline-market") as HTMLSelectElement)
              .value,
          ),
      ) ?? null;
    void quote();
  };
  document.getElementById("timeline-size")!.oninput = () => {
    latestQuote = null;
    void quote();
  };
  document.getElementById("timeline-buy")!.onclick = () => void buy();
  return root;
}
function svgNode(
  tag: string,
  attrs: Record<string, string | number>,
  text?: string,
) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    n.setAttribute(key, String(value));
  if (text != null) n.textContent = text;
  return n;
}
function draw() {
  if (!ensure()) return;
  const target = document.getElementById("timeline-plot")!;
  target.replaceChildren();
  if (!current) {
    target.append(el("p", "Waiting for live market data…"));
    return;
  }
  const now = Date.now();
  const days = Number(
    (document.getElementById("timeline-range") as HTMLSelectElement).value,
  );
  const start = now - 300000,
    end = now + days * 86400000;
  const visible = series.filter(
    (s) =>
      s.asset === asset && s.expiryNs / 1e6 >= start && s.expiryNs / 1e6 <= end,
  );
  const positions = (current.positions?.rows ?? []).filter(
    (p: any) => p.asset === asset,
  );
  const samples = (current.history?.points ?? []).filter(
    (p: any) => p.spot > 0 && p.atMs >= start,
  );
  const prices = [
    ...visible.flatMap((s) => [s.low, s.high]),
    ...positions.flatMap((p: any) => [p.low, p.high]),
    ...samples.map((p: any) => p.spot),
    current.spot,
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (!prices.length) {
    target.append(el("p", "No price data available yet."));
    return;
  }
  const W = Math.max(320, target.clientWidth || 800),
    H = W < 600 ? 350 : 430,
    left = W < 600 ? 54 : 76,
    right = 20,
    top = 26,
    bottom = 42;
  const min = Math.min(...prices),
    max = Math.max(...prices),
    pad = Math.max((max - min) * 0.12, (current.spot ?? min) * 0.005);
  const x = (ms: number) =>
    left + ((ms - start) / (end - start)) * (W - left - right);
  const y = (price: number) =>
    top + ((max + pad - price) / (max - min + 2 * pad)) * (H - top - bottom);
  const svg = svgNode("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `${asset} price over time with listed put and call spreads at expiry`,
  });
  for (let i = 0; i <= 4; i++) {
    const price = min - pad + ((max - min + 2 * pad) * i) / 4,
      yy = y(price);
    svg.append(
      svgNode("line", {
        x1: left,
        y1: yy,
        x2: W - right,
        y2: yy,
        stroke: "var(--line)",
        "stroke-width": 1,
      }),
    );
    svg.append(
      svgNode(
        "text",
        {
          x: left - 8,
          y: yy + 4,
          "text-anchor": "end",
          fill: "var(--dim)",
          "font-size": 11,
        },
        price.toLocaleString([], { maximumFractionDigits: 0 }),
      ),
    );
    const ms = now + ((end - now) * i) / 4;
    svg.append(
      svgNode(
        "text",
        {
          x: x(ms),
          y: H - 14,
          "text-anchor": i === 4 ? "end" : "middle",
          fill: "var(--dim)",
          "font-size": 11,
        },
        i === 0
          ? "Now"
          : new Date(ms).toLocaleString(
              [],
              days === 1
                ? { hour: "2-digit", minute: "2-digit" }
                : { month: "short", day: "numeric" },
            ),
      ),
    );
  }
  const nowX = x(now);
  svg.append(
    svgNode("line", {
      x1: nowX,
      y1: top,
      x2: nowX,
      y2: H - bottom,
      stroke: "var(--dim)",
      "stroke-dasharray": "3 4",
    }),
  );
  if (samples.length > 1)
    svg.append(
      svgNode("polyline", {
        points: samples.map((p: any) => `${x(p.atMs)},${y(p.spot)}`).join(" "),
        fill: "none",
        stroke: "var(--ink)",
        "stroke-width": 2,
      }),
    );
  if (current.spot > 0) {
    svg.append(
      svgNode("line", {
        x1: left,
        y1: y(current.spot),
        x2: W - right,
        y2: y(current.spot),
        stroke: "var(--dim)",
        "stroke-dasharray": "5 5",
      }),
    );
    svg.append(
      svgNode(
        "text",
        {
          x: left + 5,
          y: y(current.spot) - 7,
          fill: "var(--ink)",
          "font-size": 11,
        },
        `${asset} ${money(current.spot)}`,
      ),
    );
  }
  for (const s of visible) {
    const owned = positions.some((p: any) => p.seriesId === s.seriesId);
    const xx = x(s.expiryNs / 1e6) + (s.kind === "Put" ? -7 : 1),
      yy = y(s.high),
      height = Math.max(5, y(s.low) - yy);
    const g = svgNode("g", {
      role: "button",
      tabindex: 0,
      "aria-label": `${s.kind} ${s.low}/${s.high}, ${time(s.expiryNs)}${owned ? ", held position" : ""}`,
    });
    g.append(
      svgNode("rect", {
        x: xx,
        y: yy,
        width: 6,
        height,
        rx: 2,
        fill: s.kind === "Put" ? "var(--bid, #b54a4a)" : "var(--ask, #25866b)",
        opacity: owned ? 1 : 0.45,
        stroke: owned ? "var(--ink)" : "none",
        "stroke-width": owned ? 2 : 0,
      }),
    );
    g.append(
      svgNode(
        "title",
        {},
        `${s.kind} ${s.low}/${s.high} · ${time(s.expiryNs)} · ${remaining(s.expiryNs)}`,
      ),
    );
    g.style.cursor = "pointer";
    g.addEventListener("click", () => open(s));
    g.addEventListener("keydown", (e: any) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(s);
      }
    });
    svg.append(g);
  }
  target.append(svg);
  if (!visible.length)
    target.append(
      el(
        "p",
        "No listed expiries in this time range. Choose the next seven days.",
      ),
    );
  const list = document.getElementById("timeline-positions")!;
  list.replaceChildren();
  if (!positions.length)
    list.append(
      el(
        "p",
        window.optionalityWallet?.account
          ? `No open ${asset} positions. Select an expiry wall to trade.`
          : "Connect your wallet to display your positions.",
      ),
    );
  for (const p of positions) {
    const b = el("button");
    const intrinsic = intrinsicValue(p.kind, p.low, p.high, current.spot);
    b.append(
      el(
        "span",
        `${p.side} ${p.kind} ${p.low}/${p.high} · ${p.contracts} contracts`,
      ),
    );
    b.append(
      el(
        "span",
        `${intrinsic == null ? "ITM unavailable" : intrinsic > 0 ? "In the money" : "Out of the money"} · PnL ${money(p.open)} · ${remaining(p.expiryNs)} · ${time(p.expiryNs)}`,
      ),
    );
    b.onclick = () => {
      const s = series.find((s) => s.seriesId === p.seriesId);
      if (s) open(s);
    };
    list.append(b);
  }
}
function open(s: Series) {
  selected = s;
  latestQuote = null;
  (document.getElementById("timeline-kind") as HTMLSelectElement).value =
    s.kind;
  document.getElementById("timeline-result")!.textContent = "";
  chooseAlternatives();
  (document.getElementById("timeline-order") as HTMLDialogElement).showModal();
}
function chooseAlternatives() {
  if (!selected) return;
  const kind = (document.getElementById("timeline-kind") as HTMLSelectElement)
    .value;
  const options = series.filter(
    (s) =>
      s.asset === asset && s.expiryNs === selected!.expiryNs && s.kind === kind,
  );
  const market = document.getElementById(
    "timeline-market",
  ) as HTMLSelectElement;
  market.replaceChildren();
  for (const s of options) {
    const o = el("option", `${s.low} / ${s.high}`) as HTMLOptionElement;
    o.value = String(s.seriesId);
    market.append(o);
  }
  selected =
    options.find((s) => s.seriesId === selected!.seriesId) ??
    options[0] ??
    null;
  if (selected) market.value = String(selected.seriesId);
  void quote();
}
async function quote() {
  const seq = ++quoteSequence;
  latestQuote = null;
  const button = document.getElementById("timeline-buy") as HTMLButtonElement;
  button.disabled = true;
  const output = document.getElementById("timeline-quote")!;
  if (!selected) {
    output.textContent = "No listed spread of this type at this expiry.";
    return;
  }
  const s = selected;
  document.getElementById("timeline-title")!.textContent =
    `${asset} ${s.kind} spread`;
  document.getElementById("timeline-terms")!.textContent =
    `${s.low} / ${s.high} · expires ${time(s.expiryNs)} · ${remaining(s.expiryNs)}`;
  let quantity: number;
  try {
    quantity = contractQuantity(
      Number(
        (document.getElementById("timeline-size") as HTMLInputElement).value,
      ),
    );
  } catch (e: any) {
    output.textContent = e.message;
    return;
  }
  if (s.expiryNs / 1e6 <= Date.now() || s.settlement !== "open") {
    output.textContent =
      "This spread has expired. Select a future wall to open a new position.";
    return;
  }
  output.textContent = "Loading the venue quote…";
  try {
    const r = await fetch(
      `/chart-quote?series=${s.seriesId}&quantity=${quantity}`,
      { cache: "no-store" },
    );
    const q = await r.json();
    if (seq !== quoteSequence) return;
    if (!r.ok || !q.available)
      throw new Error(q.error ?? "No live pool quote; try another spread.");
    latestQuote = { ...q, quantity, seriesId: s.seriesId };
    output.textContent = `Total premium ${money(q.premium)} · maximum payout ${money((s.high - s.low) * quantity)}. Your wallet will ask you to approve the purchase.`;
    button.disabled = busy;
  } catch (e: any) {
    if (seq === quoteSequence) output.textContent = e.message;
  }
}
async function buy() {
  if (busy || !selected || !latestQuote) return;
  const q = latestQuote;
  busy = true;
  (document.getElementById("timeline-buy") as HTMLButtonElement).disabled =
    true;
  const result = document.getElementById("timeline-result")!;
  result.textContent = "Confirm in your wallet…";
  try {
    await window.optionalityWallet.submit({
      type: "buy",
      asset: selected.asset,
      kind: selected.kind,
      strike: selected.kind === "Put" ? selected.high : selected.low,
      expiry: String(selected.expiryNs),
      quantity: q.quantity,
      limit: q.premium / q.quantity,
    });
    result.textContent =
      "Transaction submitted. Your positions refresh after confirmation.";
  } catch (e: any) {
    result.textContent = e.message;
  } finally {
    busy = false;
    void quote();
  }
}
async function update(input: any) {
  current = input.state;
  if (input.asset !== asset) {
    asset = input.asset;
    fetchedAt = 0;
  }
  ensure();
  draw();
  if (loading || Date.now() - fetchedAt < 15000) return;
  loading = true;
  const requested = asset;
  try {
    const r = await fetch(`/chart-series?asset=${asset}`, {
      cache: "no-store",
    });
    if (!r.ok) throw new Error("Series are temporarily unavailable");
    const body = await r.json();
    if (asset === requested) {
      series = body.series;
      fetchedAt = Date.now();
      draw();
    }
  } catch (e: any) {
    const root = document.getElementById("timeline-plot");
    if (root && !series.length) root.textContent = e.message;
  } finally {
    loading = false;
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
