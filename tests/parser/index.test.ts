import { describe, it, expect } from 'vitest';
import { parseStatementBytes } from '../../src/parser/index';

describe('parseStatementBytes — content decides the format, never the filename', () => {
  it('parses a comma-delimited CSV string even when the filename says .xls', () => {
    // A bank can mislabel a plain-text export with a .xls extension just
    // as easily as it can mislabel a real .xlsx workbook with .xls. Magic
    // bytes decide which reader runs; the filename is along for the ride.
    const text =
      'Date,Description,Amount,Debit/Credit\n' +
      '01-10-2025,COOL COFFEE,100.00,Dr\n' +
      '05-10-2025,SALARY CREDIT,25000.00,Cr\n';
    const bytes = new TextEncoder().encode(text);

    const parsed = parseStatementBytes('fake.xls', bytes);

    expect(parsed.fileName).toBe('fake.xls');
    expect(parsed.transactions).toEqual([
      { dateISO: '2025-10-01', payee: 'COOL COFFEE', amount: -100 },
      { dateISO: '2025-10-05', payee: 'SALARY CREDIT', amount: 25000 },
    ]);
  });
});
