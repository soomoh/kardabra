/**
 * Read statement metadata (due date, minimum due, credit limit, ...) out
 * of the rows *above* the transaction table. The keyword lists below are
 * data walked by unchanging logic, in the same data-over-code style as
 * table.ts's `resolveTable` — adding a field a bank uses means adding a
 * table entry, not a branch.
 */

import { cleanText, isBareAmount, parseAmount, norm } from './cells';
import { parseDate } from './dates';
import { StatementError } from './errors';
import type { Locale } from './locale';
import type { StatementSummary } from './types';

/** A candidate (label, value) pair pulled out of a pre-table row. `label`
 * is already norm()-ed; `value` stays raw (`unknown`) so it can go
 * straight into parseDate/cleanAmount, which already know how to coerce
 * any cell type. */
interface Candidate {
  label: string;
  value: unknown;
}

/** A label cell, lowercased, with the punctuation banks sprinkle through
 * labels removed ("Min. Amt. Due:" -> "min amt due") so keywords stay plain. */
function labelOf(cell: unknown): string {
  return norm(cell).replace(/[.:]/g, '').replace(/\s+/g, ' ').trim();
}

const OPERATOR = /^[+\-=\u2212/]+$/;

/** A cell that reads as a value (an amount, a date, an operator like
 * '+', '-', '='), as opposed to a label. */
function looksLikeValue(cell: unknown, locale: Locale): boolean {
  const text = cleanText(cell);
  if (text === '') return false;
  if (OPERATOR.test(text)) return true;
  if (isBareAmount(cell, locale.decimal)) return true;
  try {
    parseDate(cell, locale.dateOrder);
    return true;
  } catch {
    return false;
  }
}

/** A cell that reads as a label: has letters, and is not a date/amount. */
function looksLikeLabel(cell: unknown, locale: Locale): boolean {
  return /[A-Za-z]/.test(cleanText(cell)) && !looksLikeValue(cell, locale);
}

/**
 * Shape (c): a row of labels directly above a row of values, paired by
 * column index. HDFC's "Account Summary":
 *   Opening Bal ~ - ~ Payment / Credit ~ + ~ Purchases / Debits ~ ...
 *   7628.49     ~ - ~ 8416.7           ~ + ~ 3460             ~ ...
 * Returns null unless `labels` is a label row (two or more labels) and
 * `values` is a pure value row (every non-blank cell an amount, a date or
 * an operator) — a row of text beneath a row of text is not a grid.
 */
function gridPairs(
  labels: unknown[],
  values: unknown[],
  locale: Locale,
): Candidate[] | null {
  const labelCols = labels
    .map((cell, i) => (looksLikeLabel(cell, locale) ? i : -1))
    .filter((i) => i !== -1);
  const labelCells = labels.filter((cell) => cleanText(cell) !== '');
  const valueCells = values.filter((cell) => cleanText(cell) !== '');
  if (labelCols.length < 2 || valueCells.length === 0) return null;
  // Every non-blank label-row cell is a label or an operator: a row that
  // also carries values of its own ("Statement Date~20/10/2025~...") is a
  // row of pairs, not a grid header.
  if (
    !labelCells.every(
      (cell) => looksLikeLabel(cell, locale) || OPERATOR.test(cleanText(cell)),
    )
  ) {
    return null;
  }
  if (!valueCells.every((cell) => looksLikeValue(cell, locale))) return null;
  const pairs: Candidate[] = [];
  for (const col of labelCols) {
    if (cleanText(values[col]) !== '') {
      pairs.push({ label: labelOf(labels[col]), value: values[col] });
    }
  }
  return pairs;
}

/**
 * Shape (a): drop the blank cells from a row, then pair up what's left —
 * consecutive survivors i, i+1. This covers two layouts that look
 * different at the raw-column level but are the same shape once blanks
 * are filtered out:
 *   - HDFC/Axis CSV, where label and value are already next to each other:
 *     "Payment Due Date~09/11/2025~~~~~~~".
 *   - ICICI Coral's Excel export, where merged header cells leave several
 *     blank columns between a label and its value — after filtering,
 *     "Statement Date" and "13-11-2025" are adjacent, same as the CSV case.
 */
function adjacentPairs(row: unknown[]): Candidate[] {
  // A cell containing '\n' belongs to shape (b) only — norm() collapses
  // that newline to a plain space, so "Total Payment Due\n₹ 2,027.80"
  // would otherwise still satisfy label.includes('total payment due')
  // here too, matching as an (accidental) shape-(a) label and stealing
  // the *next* filtered cell as its "value" instead of the text after its
  // own newline. Excluding newline cells from this scan entirely keeps
  // the two shapes from cross-contaminating each other's candidates.
  const nonBlank = row.filter(
    (cell) =>
      cleanText(cell) !== '' &&
      !(typeof cell === 'string' && cell.includes('\n')),
  );
  const pairs: Candidate[] = [];
  for (let i = 0; i < nonBlank.length - 1; i++) {
    pairs.push({ label: labelOf(nonBlank[i]), value: nonBlank[i + 1] });
  }
  return pairs;
}

/**
 * Shape (b): a single cell holding "label\nvalue" as one string — Axis's
 * xlsx packs its Payment Summary block this way, one field per cell:
 * "Payment Due Date\n30 Nov '25". Only fires on cells that actually
 * contain a newline; everything else is shape (a)'s job. Splits on the
 * *first* newline only (norm() would collapse a `\n` to a space, so this
 * must run on the raw string before any cleaning).
 */
function newlinePairs(row: unknown[]): Candidate[] {
  const pairs: Candidate[] = [];
  for (const cell of row) {
    if (typeof cell !== 'string' || !cell.includes('\n')) continue;
    const newlineAt = cell.indexOf('\n');
    pairs.push({
      label: labelOf(cell.slice(0, newlineAt)),
      value: cell.slice(newlineAt + 1),
    });
  }
  return pairs;
}

/** First candidate (scanning in the order the list was built — top to
 * bottom through the file) whose label contains one of `keywords`. */
function firstMatch(
  candidates: Candidate[],
  keywords: string[],
): Candidate | null {
  for (const candidate of candidates) {
    if (keywords.some((keyword) => candidate.label.includes(keyword))) {
      return candidate;
    }
  }
  return null;
}

interface DateField {
  field: 'statementDateISO' | 'paymentDueDateISO';
  keywords: string[];
  /** The value is a range ("11/10/2025 - 10/11/2025"); the END date counts. */
  range?: boolean;
  /** Only consulted when no earlier entry set the field. */
  fallback?: boolean;
}
interface AmountField {
  field:
    | 'totalDue'
    | 'minDue'
    | 'creditLimit'
    | 'openingBalance'
    | 'paymentsTotal'
    | 'purchasesTotal'
    | 'chargesTotal';
  keywords: string[];
}

// Keywords are matched against labelOf() text: lowercase, no '.' or ':'.
const DATE_FIELDS: DateField[] = [
  { field: 'statementDateISO', keywords: ['statement date'] },
  // A period closes on its end date = the statement date, but an explicit
  // "Statement Date" always wins.
  {
    field: 'statementDateISO',
    keywords: ['statement period'],
    range: true,
    fallback: true,
  },
  {
    field: 'paymentDueDateISO',
    keywords: [
      'payment due date',
      'payment due on',
      'due date',
      'due by',
      'pay by',
    ],
  },
];

const AMOUNT_FIELDS: AmountField[] = [
  {
    field: 'totalDue',
    keywords: [
      'total amount due',
      'total payment due',
      'total dues',
      'total amount payable',
      'amount payable',
      'total outstanding',
    ],
  },
  // 'minimum amount due' also appears as a *column header* with no
  // adjacent value in HDFC/ICICI's "Past Dues" mini-table, further down
  // the same pre-table block, after the real minDue row. Since firstMatch
  // scans top to bottom and stops at the first label match, the real row
  // wins — the Past Dues header either produces no candidate at all (its
  // "value" cell is blank) or, if it did, would already be too late.
  {
    field: 'minDue',
    keywords: [
      'minimum amount due',
      'minimum payment due',
      'minimum due',
      'min amount due',
      'min amt due',
    ],
  },
  { field: 'creditLimit', keywords: ['credit limit'] },
  // The bank's own reconciliation: opening - payments + purchases + charges
  // = total due. HDFC prints it as a label/value grid; ICICI and Axis as
  // plain label/value pairs.
  {
    field: 'openingBalance',
    keywords: ['opening bal', 'previous balance', 'previous statement dues'],
  },
  {
    field: 'paymentsTotal',
    keywords: [
      'payment / credit',
      'payment/credit',
      'payments/credits',
      '& other credits',
      'payments / credits',
      'payments and other credits',
    ],
  },
  {
    field: 'purchasesTotal',
    keywords: [
      'purchases / debits',
      'purchases/debit',
      'purchases / charges',
      'purchases & other',
      'purchases and other charges',
    ],
  },
  {
    field: 'chargesTotal',
    keywords: ['finance charges', 'fee, taxes', 'interest charges'],
  },
];

/** The value of a range cell: its last date ("A - B", "A to B"). */
function rangeEnd(value: unknown): unknown {
  const parts = cleanText(value).split(/\s+(?:to|[-\u2013\u2014])\s+/i);
  return parts.length > 1 ? parts[parts.length - 1] : value;
}

/**
 * Read statement metadata from the rows above the transaction table.
 * `headerAt` is the index of the transaction-table header row (from the
 * same resolveTable scan extractTransactions uses) — everything at or
 * below it is transaction data, not metadata, and is never scanned here.
 *
 * All fields are optional and independent ("parse, don't validate" — no
 * separate validity check): a date that fails to parse, or an amount cell
 * with no digits, just leaves that one field unset rather than failing
 * the whole statement. An empty summary (nothing recognised) is a valid
 * result.
 */
export function extractSummary(
  rows: unknown[][],
  headerAt: number,
  locale: Locale = { decimal: 'dot', dateOrder: 'dmy' },
): StatementSummary {
  const candidates: Candidate[] = [];
  const metaRows = rows.slice(0, headerAt);
  for (let i = 0; i < metaRows.length; i++) {
    const row = metaRows[i];
    const grid =
      i + 1 < metaRows.length ? gridPairs(row, metaRows[i + 1], locale) : null;
    if (grid !== null) {
      // A label row over a value row: the labels pair with the values
      // BELOW them, not with each other (adjacentPairs would pair each
      // label with its neighbouring label and shadow the real match).
      candidates.push(...grid, ...newlinePairs(row));
      i++; // the value row has no labels of its own
      continue;
    }
    candidates.push(...adjacentPairs(row), ...newlinePairs(row));
  }

  const summary: StatementSummary = {};

  for (const { field, keywords, range, fallback } of DATE_FIELDS) {
    if (fallback && summary[field] !== undefined) continue;
    const candidate = firstMatch(candidates, keywords);
    if (candidate === null) continue;
    try {
      summary[field] = parseDate(
        range ? rangeEnd(candidate.value) : candidate.value,
        locale.dateOrder,
      );
    } catch (error) {
      if (!(
        error instanceof StatementError && error.kind === 'unrecognised-date'
      )) {
        throw error; // a real bug, not an expected "this cell isn't a date"
      }
      // leave the field unset
    }
  }

  for (const { field, keywords } of AMOUNT_FIELDS) {
    const candidate = firstMatch(candidates, keywords);
    if (candidate === null) continue;
    const amount = parseAmount(candidate.value, locale.decimal);
    if (amount === null) continue;
    if (field === 'totalDue' && (amount.marker === 'cr' || amount.negative)) {
      // A statement closing in credit ("1,200.00 Cr"): nothing is due, and
      // the surplus is the bank's debt to the cardholder — never "owed".
      summary.totalDue = 0;
      if (amount.value > 0) summary.creditBalance = amount.value;
      continue;
    }
    summary[field] = amount.value;
  }

  return summary;
}
