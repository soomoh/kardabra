/**
 * locale.ts — the two per-file reading conventions that can't be decided
 * cell by cell: how decimals are written ("1,234.56" vs "1.234,56") and
 * whether numeric dates are day-first or month-first. Each is inferred
 * ONCE from the whole file, then passed to every read, so one ambiguous
 * cell ("05/11/2025", "12,50") never flips the interpretation of another.
 */

import { looksDecimalComma, looksDecimalDot, type DecimalStyle } from './cells';
import { inferDateOrder, type DateOrder } from './dates';
import type { HeaderMatch } from './table';

export interface Locale {
  decimal: DecimalStyle;
  dateOrder: DateOrder;
}

/** Decimal comma only when cells that can only be read that way ("1.234,56",
 * "12,50") outnumber cells that can only be read with a decimal point
 * ("1,234.56", "925.65") — a majority, so one stray cell can't flip how
 * every other amount in the file is read. Indian lakh grouping
 * ("1,23,456.78") counts as dot evidence. */
export function inferDecimalStyle(rows: unknown[][]): DecimalStyle {
  let comma = 0;
  let dot = 0;
  for (const row of rows) {
    for (const cell of row) {
      if (looksDecimalComma(cell)) comma++;
      else if (looksDecimalDot(cell)) dot++;
    }
  }
  return comma > dot ? 'comma' : 'dot';
}

export function inferLocale(rows: unknown[][], found: HeaderMatch): Locale {
  const { table, headerAt } = found;
  const dateCells = rows
    .slice(headerAt + 1)
    .filter((row) => row.length >= table.minWidth)
    .map((row) => row[table.dateCol]);
  return {
    decimal: inferDecimalStyle(rows),
    dateOrder: inferDateOrder(dateCells),
  };
}
