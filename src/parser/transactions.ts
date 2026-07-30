/**
 * transactions.ts — locate the transaction table in a statement's rows and
 * read everything below it into Transaction objects, sorted by date
 * (statements sometimes arrive newest-first).
 */

import { cleanText } from './cells';
import { parseDate } from './dates';
import { findTableHeader, type HeaderMatch } from './table';
import { StatementError } from './errors';
import type { Transaction } from './types';

const PARSEABLE_CHAR = /[0-9A-Za-z]/;

/**
 * `found`: the parseStatement façade already runs findTableHeader once
 * (it needs headerAt for extractSummary too) and passes the result
 * straight in here, so the scan never runs twice on the same rows. Tests
 * and any other caller that only wants transactions can omit it and let
 * this function do the scan itself.
 */
export function extractTransactions(
  rows: unknown[][],
  found?: HeaderMatch,
): Transaction[] {
  const { table, headerAt } = found ?? findTableHeader(rows);

  const txns: Transaction[] = [];
  for (const row of rows.slice(headerAt + 1)) {
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

    let dateISO: string;
    try {
      dateISO = parseDate(row[table.dateCol]);
    } catch (error) {
      if (!(
        error instanceof StatementError && error.kind === 'unrecognised-date'
      )) {
        throw error; // a real bug, not an expected "this row has no date"
      }
      // An undateable full-width row means one of three things; the money
      // columns disambiguate ("skip" and "stop" are different decisions):
      if (table.signedAmount(row) !== null) {
        break; // amounts but no date -> totals/summary row: table ended
      }
      const fragment = cleanText(row[table.descCol]);
      if (fragment && !cleanText(row[table.dateCol]) && txns.length > 0) {
        // description only -> ICICI wraps long remarks onto a
        // continuation row; glue it back onto the previous transaction
        txns[txns.length - 1].payee += ' ' + fragment;
      }
      continue; // neither -> footer text (legends, disclaimers)
    }

    const amount = table.signedAmount(row);
    if (amount === null) {
      continue; // no money moved (blank amount, "B/F" line)
    }
    txns.push({ dateISO, payee: cleanText(row[table.descCol]), amount });
  }

  // ISO date strings sort lexicographically in calendar order, so a plain
  // string comparison is enough — no date parsing needed at sort time.
  txns.sort((a, b) =>
    a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : 0,
  );
  return txns;
}
