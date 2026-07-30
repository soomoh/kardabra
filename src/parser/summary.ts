/**
 * Read statement metadata (due date, minimum due, credit limit, ...) out
 * of the rows *above* the transaction table. The keyword lists below are
 * data walked by unchanging logic, in the same data-over-code style as
 * table.ts's `resolveTable` — adding a field a bank uses means adding a
 * table entry, not a branch.
 */

import { cleanText, cleanAmount, norm } from './cells';
import { parseDate } from './dates';
import { StatementError } from './errors';
import type { StatementSummary } from './types';

/** A candidate (label, value) pair pulled out of a pre-table row. `label`
 * is already norm()-ed; `value` stays raw (`unknown`) so it can go
 * straight into parseDate/cleanAmount, which already know how to coerce
 * any cell type. */
interface Candidate {
  label: string;
  value: unknown;
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
    pairs.push({ label: norm(nonBlank[i]), value: nonBlank[i + 1] });
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
      label: norm(cell.slice(0, newlineAt)),
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
}
interface AmountField {
  field: 'totalDue' | 'minDue' | 'creditLimit';
  keywords: string[];
}

const DATE_FIELDS: DateField[] = [
  { field: 'statementDateISO', keywords: ['statement date'] },
  { field: 'paymentDueDateISO', keywords: ['payment due date'] },
];

const AMOUNT_FIELDS: AmountField[] = [
  { field: 'totalDue', keywords: ['total amount due', 'total payment due'] },
  // 'minimum amount due' also appears as a *column header* with no
  // adjacent value in HDFC/ICICI's "Past Dues" mini-table, further down
  // the same pre-table block, after the real minDue row. Since firstMatch
  // scans top to bottom and stops at the first label match, the real row
  // wins — the Past Dues header either produces no candidate at all (its
  // "value" cell is blank) or, if it did, would already be too late.
  { field: 'minDue', keywords: ['minimum amount due', 'minimum payment due'] },
  { field: 'creditLimit', keywords: ['credit limit'] },
];

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
): StatementSummary {
  const candidates: Candidate[] = [];
  for (const row of rows.slice(0, headerAt)) {
    candidates.push(...adjacentPairs(row), ...newlinePairs(row));
  }

  const summary: StatementSummary = {};

  for (const { field, keywords } of DATE_FIELDS) {
    const candidate = firstMatch(candidates, keywords);
    if (candidate === null) continue;
    try {
      summary[field] = parseDate(candidate.value);
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
    const amount = cleanAmount(candidate.value);
    if (amount !== null) summary[field] = amount;
  }

  return summary;
}
