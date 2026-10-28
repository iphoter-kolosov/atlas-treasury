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
