/**
 * currency.ts — infer a statement's currency from its own text. A table of
 * (code, pattern) walked by one loop; adding a currency is adding a line.
 * Patterns are case-sensitive on purpose ("Rs" the prefix, not "rs" inside
 * a merchant name).
 */

import { cleanText } from './cells';
import type { HeaderMatch } from './table';

const CURRENCY_HINTS: { code: string; pattern: RegExp }[] = [
  { code: 'INR', pattern: /₹|\bRs\b\.?|\bINR\b/g },
  { code: 'USD', pattern: /\$|\bUSD\b/g },
  { code: 'EUR', pattern: /€|\bEUR\b/g },
  { code: 'GBP', pattern: /£|\bGBP\b/g },
];

const DEFAULT_CURRENCY = 'INR';

/**
 * The currency whose marker appears most in the statement's header block,
 * table header row, and amount column — NOT its narrations or other
 * columns, so a "USD 12.00" foreign-spend column on a rupee statement
 * can't flip the answer. 'INR' when nothing says otherwise.
 */
export function inferCurrency(rows: unknown[][], found: HeaderMatch): string {
  const { table, headerAt } = found;
  const cells: unknown[] = rows.slice(0, headerAt + 1).flat();
  for (const row of rows.slice(headerAt + 1)) cells.push(row[table.amtCol]);
  const text = cells.map(cleanText).join('\n');

  let best = DEFAULT_CURRENCY;
  let bestCount = 0;
  for (const { code, pattern } of CURRENCY_HINTS) {
    const count = text.match(pattern)?.length ?? 0;
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}
