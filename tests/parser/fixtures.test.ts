/**
 * End-to-end parse of every synthetic fixture. Each fixture reproduces a real
 * statement shape (see tests/fixtures/README.md); the assertions below are the
 * full expected output, so this doubles as the parser's behavioral contract and
 * as documentation of what each layout yields.
 *
 * The catastrophic failure mode for this domain is a sign error — a payment or
 * refund (money in) counted as spend, or a purchase counted as a credit — so
 * the sign of every amount is asserted explicitly, not just its magnitude.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStatementBytes, StatementError } from '../../src/parser';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

function parse(name: string) {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
  return parseStatementBytes(name, bytes);
}

describe('hdfc_style.csv — ~-delimited, Debit/Credit marker, full summary', () => {
  it('parses summary, last-4, and correctly signed transactions', () => {
    expect(parse('hdfc_style.csv')).toEqual({
      fileName: 'hdfc_style.csv',
      last4: '4321',
      currency: 'INR',
      warnings: [],
      summary: {
        statementDateISO: '2025-10-13',
        paymentDueDateISO: '2025-11-02',
        totalDue: 12345.67,
        minDue: 617.28,
        creditLimit: 200000,
      },
      transactions: [
        { dateISO: '2025-09-20', payee: 'AMAZON RETAIL BLR', amount: -1500 },
        { dateISO: '2025-09-22', payee: 'SALARY REVERSAL', amount: 5000 },
        { dateISO: '2025-09-25', payee: 'SWIGGY BANGALORE', amount: -450.5 },
      ],
    });
  });
});

describe('layout3_incell.csv — comma-delimited, in-cell Cr, quoted fields', () => {
  it('reads the credit flag from the amount cell and preserves quoted commas', () => {
    expect(parse('layout3_incell.csv')).toEqual({
      fileName: 'layout3_incell.csv',
      last4: null, // no card number anywhere in this statement
      currency: 'INR',
      warnings: [],
      summary: {
        statementDateISO: '2025-10-15',
        paymentDueDateISO: '2025-11-05',
        totalDue: 8000,
      },
      transactions: [
        { dateISO: '2025-09-18', payee: 'COFFEE DAY', amount: -250 },
        { dateISO: '2025-09-20', payee: 'REFUND STORE', amount: 300 },
        { dateISO: '2025-09-28', payee: 'BOOKSTORE, MG ROAD', amount: -1200 },
      ],
    });
  });
});

describe('axis_style.xlsx — .xlsx, newline summary block, wrapped narration', () => {
  it('reads newline-packed summary cells and glues the continuation row', () => {
    expect(parse('axis_style.xlsx')).toEqual({
      fileName: 'axis_style.xlsx',
      last4: '7788',
      currency: 'INR',
      warnings: [],
      summary: {
        statementDateISO: '2025-11-05',
        paymentDueDateISO: '2025-11-30',
        totalDue: 9500,
      },
      transactions: [
        { dateISO: '2025-11-06', payee: 'BIG BAZAAR MUMBAI', amount: -2500 },
        { dateISO: '2025-11-07', payee: 'ONLINE PYMT RECEIVED', amount: 9500 },
        {
          dateISO: '2025-11-09',
          payee: 'RESTAURANT MG ROAD TABLE BOOKING CONTINUED',
          amount: -1200,
        },
      ],
    });
  });
});

describe('legacy.xls — legacy OLE2 container', () => {
  it('reads a legacy .xls workbook the same as any other statement', () => {
    expect(parse('legacy.xls')).toEqual({
      fileName: 'legacy.xls',
      last4: null,
      currency: 'INR',
      warnings: [],
      summary: { statementDateISO: '2025-10-10' },
      transactions: [
        { dateISO: '2025-10-01', payee: 'GROCERY MART', amount: -800 },
        { dateISO: '2025-10-03', payee: 'CASHBACK OFFER', amount: 150 },
      ],
    });
  });
});

describe('bank-account layouts are rejected, not parsed as a card', () => {
  it.each(['savings_reject.csv', 'savings_debit_credit.csv'])(
    'rejects %s (separate money-out / money-in columns)',
    (name) => {
      try {
        parse(name);
        expect.unreachable('a bank-account statement must be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(StatementError);
        expect((error as StatementError).kind).toBe('savings-statement');
      }
    },
  );
});
