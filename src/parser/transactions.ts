/**
 * transactions.ts — locate the transaction table in a statement's rows and
 * read everything below it into Transaction objects, sorted by date
 * (statements sometimes arrive newest-first).
 */

import { cleanText, isBareAmount } from './cells';
import { parseDate } from './dates';
import { inferLocale, type Locale } from './locale';
import { findTableHeader, resolveTable, type HeaderMatch } from './table';
import { StatementError } from './errors';
import type { ParseWarning, Transaction } from './types';

const PARSEABLE_CHAR = /[0-9A-Za-z]/;
const MONTH_START =
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d/i;

// Descriptions that are bookkeeping lines, not transactions. Matched against
// the lowercased, whitespace-collapsed description, anchored at the start so
// a merchant that merely CONTAINS the words ("TOTAL WINE") is never hit.
// A table walked by one unchanging check — add a bank's wording as a line.
const BALANCE_LINES: RegExp[] = [
  /^(opening|previous|prev\.?|closing)\s+(statement\s+)?bal(ance)?\b/,
  /^balance\s+(b\/f|c\/f|b\/d|c\/d|brought forward|carried forward)\b/,
  /^(b\/f|c\/f|brought forward|carried forward)\b/,
  /^sub\s*-?\s*total\b/,
];

// A bare "TOTAL". Undated, it is the footer and the table has ENDED (rows
// below it are not transactions) — see the undated-with-amount rule below.
// Everything in BALANCE_LINES is merely SKIPPED — more transactions follow
// it (a per-card subtotal, say). A DATED bare total is skipped too.
const END_LINES: RegExp[] = [/^(grand\s+)?total$/];

// Rows that open a new section (an add-on card's block, a repeated header)
// rather than continuing the previous transaction's narration.
const SECTION_LINES: RegExp[] = [
  /\b(add[- ]?on|supplementary|primary|secondary)\s+card\b/,
  /\bcard\s*(no\.?|number)\b/,
];
// A masked card number as banks print it: 12-19 digit/mask characters,
// spaces ignored, containing at least one mask (X or *).
const MASKED_NUMBER = /(?<![\dXx*])(?=[\dXx*]*[Xx*])[\dXx*]{12,19}(?![\dXx*])/;

function lineMatches(patterns: RegExp[], description: string): boolean {
  const lower = description.toLowerCase();
  return patterns.some((pattern) => pattern.test(lower));
}

function isSectionTitle(description: string): boolean {
  return (
    lineMatches(SECTION_LINES, description) ||
    MASKED_NUMBER.test(description.replace(/ /g, ''))
  );
}

export interface ExtractedTransactions {
  transactions: Transaction[];
  warnings: ParseWarning[];
}

/**
 * `found`: the parseStatement façade already runs findTableHeader once
 * (it needs headerAt for extractSummary too) and passes the result
 * straight in here, so the scan never runs twice on the same rows. Tests
 * and any other caller that only wants transactions can omit it and let
 * this function do the scan itself. `locale` likewise defaults to what the
 * rows themselves imply.
 *
 * Every unusable row is one of three DIFFERENT decisions (skip vs stop):
 *   - noise (blank, decoration, footer text, bookkeeping lines): skipped
 *     silently;
 *   - end of table (a totals row with an amount but no date): stop;
 *   - a row that looks like a transaction but can't be read (a date cell
 *     in an unknown format, with an amount): skipped WITH a warning —
 *     never silently, and never allowed to truncate the rows after it.
 */
export function extractTransactionsWithWarnings(
  rows: unknown[][],
  found?: HeaderMatch,
  locale?: Locale,
): ExtractedTransactions {
  const match = found ?? findTableHeader(rows);
  const { table, headerAt } = match;
  const { decimal, dateOrder } = locale ?? inferLocale(rows, match);

  const txns: Transaction[] = [];
  const warnings: ParseWarning[] = [];
  // True only while the previous row was a transaction, so that a
  // description-only row below it may be its wrapped narration.
  let canContinue = false;

  for (let rowIndex = headerAt + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row.some((cell) => PARSEABLE_CHAR.test(cleanText(cell)))) {
      // Nothing parseable anywhere: blank spacer rows (ICICI leaves one
      // under the header) and decoration rows ('****', HDFC savings puts
      // one under the header AND one after the last transaction). These
      // are ignorable noise, distinct from a *worded* full-width row
      // ("STATEMENT SUMMARY"), which still ends the table below.
      continue;
    }
    if (row.length < table.minWidth) {
      continue; // stray narrow line, e.g. ICICI's embedded card number
    }
    const description = cleanText(row[table.descCol]);
    const dateCell = cleanText(row[table.dateCol]);

    // A repeated header (second card section) or a section title with no
    // date ("ADD-ON CARD 4XXX XXXX XXXX 5678"): a section break, never a
    // transaction and never narration to glue onto the previous payee.
    const repeatedHeader = (() => {
      const resolved = resolveTable(row);
      return resolved !== null && resolved !== 'savings';
    })();
    if (repeatedHeader || (dateCell === '' && isSectionTitle(description))) {
      canContinue = false;
      continue;
    }

    let dateISO: string;
    try {
      dateISO = parseDate(row[table.dateCol], dateOrder);
    } catch (error) {
      if (!(
        error instanceof StatementError && error.kind === 'unrecognised-date'
      )) {
        throw error; // a real bug, not an expected "this row has no date"
      }
      // Only a bare amount counts here: text that merely contains a number
      // ("Code: 971311" from a page header) is noise, not money.
      const amount = isBareAmount(row[table.amtCol], decimal)
        ? table.signedAmount(row, decimal)
        : null;
      // A charge printed under the transaction it belongs to — SBI's GST on
      // a fee, HDFC's IGST on a foreign spend — has no date of its own and
      // its words may sit under the date column. It inherits the previous
      // transaction's date rather than ending the table.
      const words = [dateCell, description].filter(Boolean).join(' ');
      const textInDateCol =
        /^[A-Za-z]/.test(dateCell) && !MONTH_START.test(dateCell);
      if (
        amount !== null &&
        canContinue &&
        txns.length > 0 &&
        (dateCell === '' || textInDateCol) &&
        /[A-Za-z]/.test(words) &&
        !lineMatches(END_LINES, words) &&
        !lineMatches(BALANCE_LINES, words)
      ) {
        txns.push({
          dateISO: txns[txns.length - 1].dateISO,
          payee: words,
          amount,
        });
        continue;
      }
      if (lineMatches(BALANCE_LINES, description)) {
        canContinue = false;
        continue; // opening/previous balance, subtotal: not a transaction
      }
      if (amount !== null && dateCell === '') {
        break; // amounts but no date -> totals/summary row: table ended
      }
      if (amount !== null) {
        // A date cell was there but isn't one we read. If the row otherwise
        // looks like a transaction (digits in the date cell, a worded
        // description), skip it LOUDLY; anything else is the table ending
        // (HDFC's rewards block puts numbers under the table).
        if (/\d/.test(dateCell) && /[A-Za-z]/.test(description)) {
          warnings.push({
            kind: 'skipped-row',
            row: rowIndex,
            reason: `unrecognised date ${JSON.stringify(dateCell)} on "${description}"`,
          });
          canContinue = false;
          continue;
        }
        break;
      }
      if (description && dateCell === '' && txns.length > 0 && canContinue) {
        // description only -> ICICI wraps long remarks onto a
        // continuation row; glue it back onto the previous transaction
        txns[txns.length - 1].payee += ' ' + description;
      }
      continue; // neither -> footer text (legends, disclaimers)
    }

    if (
      lineMatches(BALANCE_LINES, description) ||
      lineMatches(END_LINES, description)
    ) {
      canContinue = false;
      continue; // a DATED "OPENING BALANCE ... Cr" is not a +credit
    }
    const amount = table.signedAmount(row, decimal);
    if (amount === null) {
      continue; // no money moved (blank amount, "B/F" line)
    }
    txns.push({ dateISO, payee: description, amount });
    canContinue = true;
  }

  // ISO date strings sort lexicographically in calendar order, so a plain
  // string comparison is enough — no date parsing needed at sort time.
  txns.sort((a, b) =>
    a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : 0,
  );
  return { transactions: txns, warnings };
}

/** The transactions alone; see extractTransactionsWithWarnings. */
export function extractTransactions(
  rows: unknown[][],
  found?: HeaderMatch,
  locale?: Locale,
): Transaction[] {
  return extractTransactionsWithWarnings(rows, found, locale).transactions;
}
