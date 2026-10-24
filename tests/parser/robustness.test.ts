/**
 * Robustness for messy real-world exports that the happy-path fixtures don't
 * cover: dates stored as Excel serial numbers, and CSVs that aren't UTF-8.
 * These are whole categories of statement that a stranger will feed the app,
 * so each has an end-to-end fixture plus a focused unit check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStatementBytes, parseDate } from '../../src/parser';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);
function parse(name: string) {
  return parseStatementBytes(
    name,
    new Uint8Array(readFileSync(join(FIXTURES, name))),
  );
}

describe('Excel serial dates', () => {
  it('parses a bare serial number to the right calendar date', () => {
    // 45964 is 2025-11-03 in Excel's day count; the fractional time part is
    // ignored. Verified against the known anchor serial 45658 = 2025-01-01.
    expect(parseDate(45964)).toBe('2025-11-03');
    expect(parseDate(45658)).toBe('2025-01-01');
  });

  it('reads a workbook whose date column is stored as serials', () => {
    expect(parse('serial_dates.xlsx')).toEqual({
      fileName: 'serial_dates.xlsx',
      last4: null,
      currency: 'INR',
      warnings: [],
      summary: { statementDateISO: '2025-11-15' },
      transactions: [
        { dateISO: '2025-11-03', payee: 'STORE ONE', amount: -1000 },
        { dateISO: '2025-11-08', payee: 'STORE TWO', amount: -500 },
      ],
    });
  });
});

describe('non-UTF-8 encodings', () => {
  it('recovers a Windows-1252 CSV whose accented bytes are invalid UTF-8', () => {
    const result = parse('windows1252.csv');
    expect(result.transactions).toEqual([
      { dateISO: '2025-10-01', payee: 'CAFÉ MÜNCHEN', amount: -250 },
    ]);
  });

  it('reads a UTF-16 LE CSV via its byte-order mark', () => {
    const result = parse('utf16.csv');
    expect(result.transactions).toEqual([
      { dateISO: '2025-10-02', payee: 'METRO CARD', amount: -99 },
    ]);
  });
});
