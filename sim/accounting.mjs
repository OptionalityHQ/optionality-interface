// Mirror of contracts/bounded-options/src/accounting.rs.
// Every function returns null where the Rust version returns None, so the
// simulator rejects exactly what the contract rejects. BigInt truncates toward
// zero and never overflows, so both guards are explicit here.
const U128_MAX = (1n << 128n) - 1n;

const fits = (value) => (value >= 0n && value <= U128_MAX ? value : null);

export function maxPayout(quantity, width, scale) {
  // The contract computes width with checked_sub, so a negative width is None.
  if (scale <= 0n || width < 0n) return null;
  const numerator = quantity * width + (scale - 1n);
  if (numerator > U128_MAX) return null;
  return fits(numerator / scale);
}

export function payout(quantity, scale, high, low, price) {
  if (scale === 0n || high <= low) return null;
  const width = high - low;
  const intrinsic = price >= high ? 0n : high - price;
  const capped = intrinsic < width ? intrinsic : width;
  const product = quantity * capped;
  if (product > U128_MAX) return null;
  return fits(product / scale);
}

export function payoutCall(quantity, scale, high, low, price) {
  if (scale === 0n || high <= low) return null;
  const width = high - low;
  const intrinsic = price <= low ? 0n : price - low;
  const capped = intrinsic < width ? intrinsic : width;
  const product = quantity * capped;
  if (product > U128_MAX) return null;
  return product / scale;
}

export function splitSettlement(collateral, premium, ticketPayout, voided) {
  if (ticketPayout > collateral) return null;
  if (voided) return { buyer: premium, maker: collateral };
  const total = premium + (collateral - ticketPayout);
  if (total > U128_MAX) return null;
  return { buyer: ticketPayout, maker: total };
}

/// One row of the shared fixture: reservation, payoff and both splits. Each is
/// reported independently, exactly as the Rust vector generator emits them.
export function settlement(quantity, scale, low, high, price, premium) {
  const collateral = maxPayout(quantity, high - low, scale);
  const ticketPayout = payout(quantity, scale, high, low, price);
  const valid = collateral !== null && ticketPayout !== null;
  return {
    valid,
    collateral,
    payout: ticketPayout,
    fixed: valid ? splitSettlement(collateral, premium, ticketPayout, false) : null,
    voided: valid ? splitSettlement(collateral, premium, ticketPayout, true) : null,
  };
}

export const UNIT_PRECISION = 1_000_000n;

export function unitPremium(premium, quantity) {
  const scaled = premium * UNIT_PRECISION;
  if (quantity === 0n || scaled > U128_MAX) return U128_MAX;
  return scaled / quantity;
}
