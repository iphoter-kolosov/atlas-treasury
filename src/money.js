// Money is always integer cents internally; PayPal wants decimal strings with exactly two digits.

export const MAX_REQUEST_CENTS = 200_000; // $2,000 hard ceiling per agent-created request

export function toCents(usd) {
  if (typeof usd === 'string' && !/^\d+(\.\d{1,2})?$/.test(usd.trim())) throw new Error(`Invalid amount "${usd}"`);
  const n = typeof usd === 'string' ? Number(usd) : usd;
  if (!Number.isFinite(n)) throw new Error('Amount must be a number');
  const cents = Math.round(n * 100);
  if (Math.abs(cents / 100 - n) > 1e-9) throw new Error('Amount must have at most 2 decimals');
  return cents;
}

export const fromCents = (cents) => (cents / 100).toFixed(2);
export const fmtUsd = (cents) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// PayPal currencies that have no minor unit: amounts must be whole numbers.
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD']);

/**
 * Convert a USD amount (cents) into the merchant's settlement currency for a payout.
 * Returns {currency, value} where value is the exact string PayPal expects.
 */
export function settlementAmount(cents, settlement) {
  if (!settlement?.currency || settlement.currency === 'USD') return { currency: 'USD', value: fromCents(cents) };
  if (!(settlement.fxRate > 0)) throw new Error(`No FX rate configured for settlement in ${settlement.currency}`);
  const units = (cents / 100) * settlement.fxRate;
  const value = ZERO_DECIMAL.has(settlement.currency) ? String(Math.round(units)) : units.toFixed(2);
  return { currency: settlement.currency, value };
}
