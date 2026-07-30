/**
 * table.ts — detect a transaction table's shape from its header row.
 *
 * Strategy pattern: `resolveTable` inspects one header row and, if it
 * recognises the layout, hands back a small `signedAmount` function
 * (closed over that layout's column indices) that knows how to read a
 * signed amount out of any later row in *this* table. The extraction loop
 * in transactions.ts never branches on bank or layout itself — it just
 * calls the function it was handed. Adding a future layout means adding a
 * case here, not touching the loop.
 */

import { cleanAmount, norm } from './cells';
import { StatementError } from './errors';

export interface Table {
  dateCol: number;
  descCol: number;
  minWidth: number; // rows narrower than this are junk, not transactions
  signedAmount: (row: unknown[]) => number | null;
}

/** First header cell containing a keyword (specific keywords first), or
 * failing that, exactly equal to one of `exact`. */
function findColumn(
  header: string[],
  keywords: string[],
  exact: string[] = [],
): number | null {
  for (const keyword of keywords) {
    for (let i = 0; i < header.length; i++) {
      if (header[i].includes(keyword)) return i;
    }
  }
  for (let i = 0; i < header.length; i++) {
    if (exact.includes(header[i])) return i;
  }
  return null;
}

/**
 * If `row` is a transaction-table header, describe the table. Returns
 * `'savings'` for layout 1 (separate withdrawal/deposit columns) — a
 * bank-account statement, not a card one; Kardabra tracks credit cards
 * only, so this layout is rejected rather than parsed. Returns `null` if
 * `row` isn't a header at all.
 *
 * This doubles as the header detector: scanning a file top to bottom, the
 * first row that resolves (to a Table or to 'savings') is the start of the
 * transaction table.
 */
export function resolveTable(row: unknown[]): Table | 'savings' | null {
  const header = row.map(norm);

  const dateCol = findColumn(header, [
    'transaction date',
    'tran date',
    'value date',
    'date',
  ]);
  const descCol = findColumn(header, [
    'transaction details',
    'description',
    'details',
    'narration',
    'particulars',
    'remarks',
  ]);
  if (dateCol === null || descCol === null) return null;

  // Layout 1 — separate money-in / money-out columns (savings statements).
  const outCol = findColumn(header, ['withdrawal'], ['dr']);
  const inCol = findColumn(header, ['deposit'], ['cr']);
  if (outCol !== null && inCol !== null) {
    return 'savings';
  }

  const amtCol = findColumn(header, [
    'amount(in rs',
    'amount (inr',
    'amount',
    'amt',
  ]);
  if (amtCol === null) return null;

  // Layout 2 — a marker column naming each row Debit or Credit. Covers
  // "Debit / Credit" (HDFC, Axis) and "BillingAmountSign" (ICICI CSV).
  const markerCol = header.findIndex(
    (cell, i) =>
      i !== amtCol &&
      (cell.includes('sign') ||
        ((cell.includes('debit') || cell.includes('credit')) &&
          !cell.includes('amount') &&
          !cell.includes('amt'))),
  );
  if (markerCol !== -1) {
    const signedAmount = (r: unknown[]): number | null => {
      const amount = cleanAmount(r[amtCol]);
      if (amount === null) return null;
      return norm(r[markerCol]).startsWith('cr') ? amount : -amount;
    };
    const minWidth = Math.max(dateCol, descCol, amtCol, markerCol) + 1;
    return { dateCol, descCol, minWidth, signedAmount };
  }

  // Layout 3 — credit flagged inside the amount cell itself: "925.65 Cr."
  const signedAmount = (r: unknown[]): number | null => {
    const amount = cleanAmount(r[amtCol]);
    if (amount === null) return null;
    return norm(r[amtCol]).includes('cr') ? amount : -amount;
  };
  const minWidth = Math.max(dateCol, descCol, amtCol) + 1;
  return { dateCol, descCol, minWidth, signedAmount };
}

export interface HeaderMatch {
  table: Table;
  headerAt: number; // index of the header row itself; data starts below it
}

/**
 * Scan `rows` top to bottom for the first transaction-table header,
 * throwing the same two rejections every caller needs: a 'savings' layout
 * (bank account, not a card — Kardabra is card-only) or no recognisable
 * header at all. Shared by extractTransactions and the parseStatement
 * façade (which also needs headerAt, to know where the summary block
 * ends) so this scan and its error messages live in exactly one place.
 */
export function findTableHeader(rows: unknown[][]): HeaderMatch {
  for (let h = 0; h < rows.length; h++) {
    const resolved = resolveTable(rows[h]);
    if (resolved === 'savings') {
      throw new StatementError(
        'savings-statement',
        'this file has a bank-account layout (separate withdrawal/deposit columns), not a card layout',
        'This looks like a bank account statement, not a credit card statement. Kardabra tracks credit cards only.',
      );
    }
    if (resolved !== null) {
      return { table: resolved, headerAt: h };
    }
  }
  throw new StatementError(
    'no-table',
    'no transaction table found (no header row with date, description and amount columns)',
    'Re-download the statement and try again, or confirm this file is a credit card statement export.',
  );
}
