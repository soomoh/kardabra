/**
 * Formatting rupee amounts for display. Pure functions, no component or
 * DOM code, so they're testable exactly like dates.ts.
 */

// 'en-IN' is the locale that gives Indian digit grouping (lakh/crore: groups
// of 2 after the first 3, e.g. 1,00,000 not 100,000) — comes free from
// Intl, no hand-rolled grouping logic needed.
const formatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
});

/** Format a plain (unsigned) amount as Indian-grouped rupees, e.g.
 * `formatINR(100000)` -> '₹1,00,000.00'. */
export function formatINR(amount: number): string {
  return formatter.format(amount);
}

/**
 * Format a signed amount for a transaction row: a leading '+' on credits
 * (money in), nothing extra on debits (money in negative already reads as
 * '-' via the formatter). Follows the parser's sign convention (see
 * parser/types.ts: out negative, in positive) — this function doesn't
 * reinterpret the sign, only decides how to *display* it.
 */
export function formatSignedINR(amount: number): string {
  if (amount > 0) return `+${formatINR(amount)}`;
  return formatINR(amount);
}

// 'notation: compact' on the 'en-IN' locale is what makes this Indian
// units (K/L/Cr — thousand/lakh/crore) instead of the Western K/M/B a
// compact formatter would produce under almost any other locale; the
// Indian grouping and the Indian magnitude words come from the same
// locale tag, no separate lookup table needed.
const compactFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** Compact rupee amount for space-constrained UI (chart axis ticks,
 * small badges) where formatINR's full "₹1,00,000.00" would crowd the
 * space — e.g. `formatINRCompact(152000)` -> '₹1.5L'. Not a replacement
 * for formatINR anywhere precision matters (a bill total, a transaction
 * row): compact notation rounds to one decimal place. */
export function formatINRCompact(amount: number): string {
  return compactFormatter.format(amount);
}
