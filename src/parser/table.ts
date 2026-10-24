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

import { parseAmount, norm, type DecimalStyle } from './cells';
import { StatementError } from './errors';

export interface Table {
  dateCol: number;
  descCol: number;
  amtCol: number;
  minWidth: number; // rows narrower than this are junk, not transactions
  /** Signed amount of one row (money out negative), or null when the row
   * holds no readable amount. `decimal` is the file's decimal style. */
  signedAmount: (row: unknown[], decimal?: DecimalStyle) => number | null;
}

// Marker-column vocabulary, as data. A "marker" column names each row's
// direction in words/letters instead of in the amount cell itself.
// Debit-like and credit-like values are tables, tested after norm():
//   credit if the value is in CREDIT_MARKERS, debit if in DEBIT_MARKERS.
const CREDIT_MARKERS = ['cr', 'cr.', 'c', 'credit'];
const DEBIT_MARKERS = ['dr', 'dr.', 'd', 'debit'];

// Header texts that mark a marker column. STRONG headers are always the
// marker column; WEAK ones ("Type") are often something else (HDFC's
// "Transaction type" holds Domestic/International), so they only count on
// rows where their VALUE is actually a Dr/Cr marker.
const STRONG_MARKER_EXACT = ['dr/cr', 'cr/dr', 'drcr', 'crdr'];
const WEAK_MARKER_EXACT = [
  'type',
  'transaction type',
  'txn type',
  'trans type',
];

// Amount-column headers (in preference order), and the hints that pick
// between several candidates.
const AMOUNT_KEYWORDS = ['amount', 'amt'];
// "`" and a leading "C" are how some PDF fonts render ₹ ("Amount (in `)").
const INR_HINT = /\b(inr|rs)\b|₹|\(in\s*`\s*\)/;
const FOREIGN_HINT =
  /foreign|currency|forex|\bintl\b|international|\busd\b|\beur\b|\bgbp\b/;

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

/** The amount column: among headers mentioning "amount"/"amt" (never a
 * "...sign" marker column), prefer one naming rupees (INR/Rs/₹), then one
 * that isn't a foreign-currency column, then the first. */
function findAmountColumn(header: string[]): number | null {
  const tiers: ((h: string) => boolean)[] = [
    (h) => INR_HINT.test(h),
    (h) => !FOREIGN_HINT.test(h),
    () => true,
  ];
  for (const inTier of tiers) {
    for (const keyword of AMOUNT_KEYWORDS) {
      for (let i = 0; i < header.length; i++) {
        const h = header[i];
        if (h.includes(keyword) && !h.includes('sign') && inTier(h)) return i;
      }
    }
  }
  return null;
}

function isStrongMarkerHeader(h: string, isAmountCol: boolean): boolean {
  if (isAmountCol) return false;
  const compact = h.replace(/\s*\/\s*/g, '/');
  return (
    h.includes('sign') ||
    STRONG_MARKER_EXACT.includes(compact) ||
    ((h.includes('debit') || h.includes('credit')) &&
      !h.includes('amount') &&
      !h.includes('amt'))
  );
}

type Direction = 'credit' | 'debit';

/** Direction named by a marker cell's value, or null if it isn't one. */
function markerDirection(value: unknown): Direction | null {
  const v = norm(value);
  if (CREDIT_MARKERS.includes(v)) return 'credit';
  if (DEBIT_MARKERS.includes(v)) return 'debit';
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

  // Layout 1 — a bank account statement: separate money-out and money-in
  // columns (withdrawal/deposit, or debit-amount/credit-amount) instead of one
  // signed amount column. Detected by two DISTINCT columns, one per direction.
  // A card's single "Debit/Credit" marker column contains both words and so
  // resolves to the same column — requiring outCol !== inCol keeps that card
  // layout out of here.
  const outCol = findColumn(header, ['withdrawal', 'debit'], ['dr']);
  const inCol = findColumn(header, ['deposit', 'credit'], ['cr']);
  if (outCol !== null && inCol !== null && outCol !== inCol) {
    return 'savings';
  }

  const amtCol = findAmountColumn(header);
  if (amtCol === null) return null;
  // Date, description and amount must be three different columns: a
  // paragraph that merely mentions "date", "details" and "amount" in one
  // cell is prose, not a table header.
  if (new Set([dateCol, descCol, amtCol]).size < 3) return null;

  // Direction of a row from the amount cell itself: an in-cell Cr/Dr tag
  // wins; otherwise an explicit minus/parentheses means credit (on a card
  // statement the balance went DOWN: a refund or payment); otherwise debit.
  const inCellDirection = (
    amount: NonNullable<ReturnType<typeof parseAmount>>,
  ): Direction => {
    if (amount.marker !== null)
      return amount.marker === 'cr' ? 'credit' : 'debit';
    // An explicit minus/parentheses (or a leading '+', HDFC's PDF credit
    // mark) means money came in.
    return amount.negative || amount.plus ? 'credit' : 'debit';
  };

  // Layout 2 — marker column(s) naming each row Debit or Credit. Covers
  // "Debit / Credit" (HDFC, Axis), "Dr/Cr", "BillingAmountSign" (ICICI CSV),
  // and (by value) "Type" / "Transaction Type" / "Txn Type".
  const strongCols = header
    .map((h, i) => (isStrongMarkerHeader(h, i === amtCol) ? i : -1))
    .filter((i) => i !== -1);
  const weakCols = header
    .map((h, i) => (i !== amtCol && WEAK_MARKER_EXACT.includes(h) ? i : -1))
    .filter((i) => i !== -1);
  const markerCols = [...strongCols, ...weakCols].sort((a, b) => a - b);

  const signedAmount = (
    r: unknown[],
    decimal: DecimalStyle = 'dot',
  ): number | null => {
    const amount = parseAmount(r[amtCol], decimal);
    if (amount === null) return null;
    let direction: Direction | null = null;
    for (const col of markerCols) {
      direction = markerDirection(r[col]);
      if (direction !== null) break;
    }
    direction ??= inCellDirection(amount);
    // `0 : -0` — a zero amount must stay +0, not the negative zero that
    // `-amount` would produce.
    return direction === 'credit' || amount.value === 0
      ? amount.value
      : -amount.value;
  };
  const minWidth = Math.max(dateCol, descCol, amtCol, ...strongCols) + 1;
  return { dateCol, descCol, amtCol, minWidth, signedAmount };
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
