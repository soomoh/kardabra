/**
 * account.ts — recover the last 4 digits of the statement's card/account
 * number from the file's own contents. Filenames are unreliable (banks
 * name exports arbitrarily, users rename downloads), so truth has to come
 * from the data ("trust content, not names").
 */

import { cleanText } from './cells';
import { parseDate, type DateOrder } from './dates';
import { resolveTable, type Table } from './table';
import { StatementError } from './errors';

// A card/account number as banks print it: 12-19 digits with X or *
// masking, e.g. "4000 12XX XXXX 1111", "4111XXXXXXXX2222", "400012******3333".
const MASKED_NUMBER = /(?<![\dXx*])[\dXx*]{12,19}(?![\dXx*])/g;

function maskedLast4(cell: string, minLen: number): string | null {
  const tokens = cell.replace(/ /g, '').match(MASKED_NUMBER) ?? [];
  for (const token of tokens) {
    if (
      token.length >= minLen &&
      /[Xx*]/.test(token) &&
      /^\d{4}$/.test(token.slice(-4))
    ) {
      return token.slice(-4);
    }
  }
  return null;
}

/**
 * Last 4 digits of the statement's card/account number. Three passes, most
 * trusted first, so that noise like CKYC/customer-ID numbers never wins.
 *
 * Transaction rows are excluded from the scan: a narration can quote some
 * *other* account's number (HDFC autopay lines name the credit card being
 * paid). Metadata never lives in a dated, full-width table row — but it may
 * sit in a narrow row inside the table (ICICI card CSVs embed the card
 * number there), so exclusion is by shape, not by position alone.
 */
export function accountLast4(
  rows: unknown[][],
  dateOrder: DateOrder = 'dmy',
): string | null {
  let table: Table | null = null;
  let headerAt = -1;
  for (let i = 0; i < rows.length; i++) {
    const resolved = resolveTable(rows[i]);
    // A 'savings' header still marks a real header row, but there's no
    // Table (column widths, signedAmount) to test rows against — layout 1
    // is rejected upstream by extractTransactions and, in normal use,
    // never reaches this function at all. Treat it like "no header found"
    // rather than crash on a table that was never built.
    if (resolved !== null && resolved !== 'savings') {
      table = resolved;
      headerAt = i;
      break;
    }
  }

  function isTransaction(i: number, row: unknown[]): boolean {
    if (table === null || i <= headerAt || row.length < table.minWidth)
      return false;
    try {
      parseDate(row[table.dateCol], dateOrder);
      return true;
    } catch (error) {
      if (error instanceof StatementError && error.kind === 'unrecognised-date')
        return false;
      throw error; // a real bug, not an expected "this row has no date"
    }
  }

  // (whole line, lowered — for keyword context; cells — for extraction)
  const items: { line: string; cells: string[] }[] = [];
  // The first 60 rows, and always everything above the table header — all of
  // that is metadata. A PDF's summary pairs come first and can run past 60
  // (HDFC: ~90), which would otherwise hide its card-number line.
  const end = Math.min(rows.length, Math.max(60, headerAt));
  for (let i = 0; i < end; i++) {
    const row = rows[i];
    if (isTransaction(i, row)) continue;
    // .map(cleanText) coerces every cell to a cleaned string up front —
    // needed now that `row` may hold Excel cell values (numbers, not just
    // CSV strings); maskedLast4 below assumes a real string to call
    // .replace/.match on.
    const cells = row.map(cleanText).filter((c) => c !== '');
    if (cells.length > 0) {
      items.push({ line: cells.join(' ').toLowerCase(), cells });
    }
  }

  // 1. an explicit "card" line (HDFC, Axis, ICICI web)
  for (const { line, cells } of items) {
    if (line.includes('card')) {
      for (const cell of cells) {
        const last4 = maskedLast4(cell, 12);
        if (last4) return last4;
      }
    }
  }
  // 2. a bare card-length masked number (ICICI CSV)
  for (const { cells } of items) {
    for (const cell of cells) {
      const last4 = maskedLast4(cell, 15);
      if (last4) return last4;
    }
  }
  // 3. an account-number line (savings statements)
  for (const { line, cells } of items) {
    // "account no" does NOT match "account number" ("nu" breaks the
    // substring) — ICICI's detailed statement needs the longer keyword
    if (
      ['account no', 'account number', 'a/c', 'savings'].some((w) =>
        line.includes(w),
      )
    ) {
      for (const cell of cells) {
        const last4 = maskedLast4(cell, 10);
        if (last4) return last4;
        const bareDigits = cell.match(/(?<!\d)(\d{9,18})(?!\d)/);
        if (bareDigits) return bareDigits[1].slice(-4);
      }
    }
  }
  return null;
}
