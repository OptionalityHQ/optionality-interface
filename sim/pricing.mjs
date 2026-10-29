// Deterministic market micro-structure helpers: a seeded random walk, the
// risk-neutral price of a put spread, and quoting from it. The contract only
// ever sees integers, so every price here is converted at the boundary.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * value);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-value * value);
  return sign * y;
}

export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/// Black-Scholes put with r = 0, quoted in price points. A prototype never
/// discounts over a week; Derive's own venues price off a similar curve.
export function putValue({ spot, strike, vol, years }) {
  if (years <= 0 || vol <= 0 || spot <= 0 || strike <= 0) {
    return Math.max(strike - spot, 0);
  }
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * vol * vol * sqrtT * sqrtT) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return strike * normalCdf(-d2) - spot * normalCdf(-d1);
}

export function putSpreadValue({ spot, low, high, vol, years }) {
  return Math.max(
    putValue({ spot, strike: high, vol, years }) - putValue({ spot, strike: low, vol, years }),
    0,
  );
}

/// Geometric random walk in price points, ending at expiry.
export function pricePath({ seed, spot, vol, years, steps, drift = 0 }) {
  const rng = mulberry32(seed);
  const dt = years / steps;
  const path = [spot];
  let price = spot;
  for (let step = 0; step < steps; step += 1) {
    const shock = normal(rng) * vol * Math.sqrt(dt);
    price = price * Math.exp((drift - 0.5 * vol * vol) * dt + shock);
    path.push(price);
  }
  return { path, rng };
}

/// Fair value of one offer, in integer token units, with the maker's edge.
/// `quantity` is already in token units, which is also the prototype's
/// "1 price point = 1 token" collateral equivalence.
export function quotePremium({ quantity, scale, spot, low, high, vol, years, edgeBps = 0n }) {
  const value = putSpreadValue({
    spot: Number(spot),
    low: Number(low) / Number(scale),
    high: Number(high) / Number(scale),
    vol,
    years,
  });
  const gross = Number(quantity) * value * (1 + Number(edgeBps) / 10_000);
  const rounded = BigInt(Math.ceil(gross));
  return rounded > 0n ? rounded : 1n;
}

export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export function yearsUntil(expiryNs, nowNs) {
  const seconds = Number(expiryNs - nowNs) / 1e9;
  return Math.max(seconds / SECONDS_PER_YEAR, 0);
}

const pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

function d1d2({ spot, strike, vol, years }) {
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * vol * vol * years) / (vol * sqrtT);
  return { d1, d2: d1 - vol * sqrtT, sqrtT };
}

/// Black-Scholes Greeks for one put, r = 0, per contract in price points.
export function putGreeks({ spot, strike, vol, years }) {
  if (years <= 0 || vol <= 0) {
    const intrinsic = Math.max(strike - spot, 0);
    return { delta: spot < strike ? -1 : 0, gamma: 0, vega: 0, theta: 0, price: intrinsic };
  }
  const { d1, sqrtT } = d1d2({ spot, strike, vol, years });
  const price = putValue({ spot, strike, vol, years });
  return {
    delta: -normalCdf(-d1),
    gamma: pdf(d1) / (spot * vol * sqrtT),
    vega: (spot * pdf(d1) * sqrtT) / 100,
    theta: (-(spot * pdf(d1) * vol) / (2 * sqrtT)) / 365,
    price,
  };
}

/// Greeks of buying the `high` put and selling the `low` put: our ticket.
export function putSpreadGreeks({ spot, low, high, vol, years }) {
  const long = putGreeks({ spot, strike: high, vol, years });
  const short = putGreeks({ spot, strike: low, vol, years });
  return {
    delta: long.delta - short.delta,
    gamma: long.gamma - short.gamma,
    vega: long.vega - short.vega,
    theta: long.theta - short.theta,
    price: long.price - short.price,
  };
}

/// Round strikes with tighter spacing near the money, mirroring the strike
/// grid observed in Derive's shipped chain table ($50/$25 on ETH, $1,000 on BTC).
export function strikeLadder(spotPrice, { step, nearSteps = 2, count = 14 }) {
  const half = step / 2;
  const atm = Math.round(spotPrice / half) * half;
  const strikes = new Set();
  for (let index = -count; index <= count; index += 1) {
    const candidate = Number((atm + index * half).toFixed(2));
    const near = Math.abs(candidate - spotPrice) <= nearSteps * step;
    const onGrid = Math.abs(candidate % step) < 1e-9;
    if (near || onGrid) strikes.add(candidate);
  }
  return [...strikes].sort((a, b) => a - b);
}


/// Makers price with a mild negative skew, the way listed crypto options do:
/// lower strikes carry more implied vol. `skew` is the log-moneyness slope.
export function smileVol({ spot, strike, atmVol, skew = 0.35 }) {
  const ratio = Math.log(spot / strike);
  return Math.max(0.05, atmVol * (1 + skew * ratio));
}

/// Value of one spread contract in price points, with each leg priced off the
/// smile. `kind` is "Put" or "Call"; the long leg is `high` for puts and `low`
/// for calls, matching the contract's payoff.
export function spreadValue({ spot, low, high, kind = "Put", atmVol, years, skew = 0.35 }) {
  if (years <= 0) {
    const intrinsic = kind === "Put" ? Math.max(high - spot, 0) : Math.max(spot - low, 0);
    return Math.min(intrinsic, high - low);
  }
  const volLow = smileVol({ spot, strike: low, atmVol, skew });
  const volHigh = smileVol({ spot, strike: high, atmVol, skew });
  const valueLow = putValue({ spot, strike: low, vol: volLow, years });
  const valueHigh = putValue({ spot, strike: high, vol: volHigh, years });
  if (kind === "Put") return Math.max(valueHigh - valueLow, 0);
  return Math.max(
    callPrice({ spot, strike: low, vol: volLow, years }) -
      callPrice({ spot, strike: high, vol: volHigh, years }),
    0,
  );
}

export function callPrice({ spot, strike, vol, years }) {
  return putValue({ spot, strike, vol, years }) - strike + spot;
}

/// Greeks of the spread with the smile applied to both legs.
export function spreadGreeks({ spot, low, high, kind = "Put", atmVol, years, skew = 0.35 }) {
  if (years <= 0) return { delta: 0, gamma: 0, vega: 0, theta: 0 };
  const volLow = smileVol({ spot, strike: low, atmVol, skew });
  const volHigh = smileVol({ spot, strike: high, atmVol, skew });
  const long = putGreeks({ spot, strike: kind === "Put" ? high : low, vol: kind === "Put" ? volHigh : volLow, years });
  const short = putGreeks({ spot, strike: kind === "Put" ? low : high, vol: kind === "Put" ? volLow : volHigh, years });
  if (kind === "Put") {
    return {
      delta: long.delta - short.delta,
      gamma: long.gamma - short.gamma,
      vega: long.vega - short.vega,
      theta: long.theta - short.theta,
    };
  }
  // A call's delta is the put's delta plus one; the spread cancels the shift.
  return {
    delta: long.delta - short.delta,
    gamma: long.gamma - short.gamma,
    vega: long.vega - short.vega,
    theta: long.theta - short.theta,
  };
}
