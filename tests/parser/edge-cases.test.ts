/**
 * Parser edge cases that the fixture round-trips don't isolate: the messy inputs
 * a general statement importer has to survive. Each uses inline data so the
 * behavior under test is visible in the test itself.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDelimited,
  extractTransactions,
  extractSummary,
  accountLast4,
  looksLikeExcel,
  loadExcelRows,
} from '../../src/parser';

describe('parseDelimited — delimiter detection and quoting', () => {
  it('picks the delimiter that yields the most real (multi-column) rows', () => {
    // '~' produces three-column rows; comma would leave one column each.
    expect(parseDelimited('a~b~c\nd~e~f\n')).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it('keeps a delimiter and a newline that sit inside a quoted field', () => {
    const rows = parseDelimited('a,b,c\n"has, comma\nand newline",d,e\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['has, comma\nand newline', 'd', 'e'],
    ]);
  });
});

describe('extractTransactions — where the table stops and what it skips', () => {
  it('stops at a totals row (an amount with no date) and ignores rows past it', () => {
    const rows = [
      ['Date', 'Description', 'Amount', 'Debit/Credit'],
      ['01/10/2025', 'SHOP', '100.00', 'Dr'],
      ['', 'TOTAL', '100.00', 'Dr'], // amount but no date -> table ended
      ['02/10/2025', 'BELOW THE TOTAL', '50.00', 'Dr'],
    ];
    expect(extractTransactions(rows)).toEqual([
      { dateISO: '2025-10-01', payee: 'SHOP', amount: -100 },
    ]);
  });
});

describe('extractSummary — first match wins', () => {
  it('takes the real minimum-due row, not a later "Past Dues" repeat', () => {
    const rows = [
      ['Minimum Amount Due', '617.28'],
      ['Past Dues', ''],
      ['Minimum Amount Due', '9999.00'],
      ['Date', 'Description', 'Amount', 'Debit/Credit'],
    ];
    expect(extractSummary(rows, 3).minDue).toBe(617.28);
  });
});

describe('accountLast4 — trust a card number, not any long number', () => {
  it('does not mistake an unmasked id (CKYC/customer no.) for a card number', () => {
    const rows = [
      ['CKYC Number', '12345678901234'],
      ['Date', 'Description', 'Amount', 'Debit/Credit'],
      ['01/10/2025', 'SHOP', '100.00', 'Dr'],
    ];
    expect(accountLast4(rows)).toBe(null);
  });
});

describe('Excel container detection', () => {
  it('recognizes both Excel magic numbers and rejects anything else', () => {
    expect(looksLikeExcel(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true); // .xlsx (ZIP)
    expect(looksLikeExcel(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe(true); // .xls (OLE2)
    expect(looksLikeExcel(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  it('throws a typed error when handed bytes that are not an Excel file', () => {
    expect(() => loadExcelRows(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});
