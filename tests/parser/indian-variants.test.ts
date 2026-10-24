/**
 * Realistic Indian credit-card statement variants (synthetic data only):
 * amount notations, marker columns, date formats, summary labels, table
 * shapes. Each expectation is the CORRECT behaviour justified from the domain.
 *
 * The catastrophic failure mode is a SIGN ERROR (a payment/refund counted as
 * spend or the reverse), so every case asserts the sign explicitly.
 * Sign convention: money out negative, money in positive.
 * Judgment calls are marked JUDGMENT in the test name.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStatementBytes,
  parseDate,
  cleanAmount,
  resolveTable,
  extractTransactions,
  StatementError,
} from '../../src/parser';
import { classifyCharge } from '../../src/lib/charges';

const enc = new TextEncoder();
const q = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
const csv = (rows: string[][], d = ',') =>
  rows.map((r) => r.map(q).join(d)).join('\n') + '\n';
const parse = (text: string) => parseStatementBytes('p.csv', enc.encode(text));
/** Parse; on throw return a descriptive string so the diff shows what happened. */
const safe = <T>(f: () => T): T | string => {
  try {
    return f();
  } catch (e) {
    return `THROWS ${(e as StatementError).kind ?? ''} ${(e as Error).message}`;
  }
};
const H3 = ['Date', 'Description', 'Amount'];

describe('amounts via layout 3 (single Amount column) -> signed amount', () => {
  // [cell, expected signed amount, why]
  const cases: [string, number | null, string][] = [
    ['1,500.00', -1500, 'plain debit'],
    ['₹1,23,456.78', -123456.78, 'lakh grouping + rupee sign, debit'],
    ['Rs. 1,500.00', -1500, 'Rs. prefix, debit'],
    ['INR 250', -250, 'INR prefix, debit'],
    ['1,200.00 Cr', 1200, 'Cr suffix = credit'],
    ['1,200.00 CR', 1200, 'CR suffix = credit'],
    ['1200.00Cr', 1200, 'Cr glued to digits = credit'],
    ['1,200.00 Dr', -1200, 'explicit Dr = debit'],
    // JUDGMENT: on a card statement a leading minus / parentheses mean the
    // balance went DOWN (refund/payment), i.e. a credit. Money in = positive.
    ['-500.00', 500, 'JUDGMENT: minus on card statement = credit'],
    ['(500.00)', 500, 'JUDGMENT: parentheses = credit'],
    // malformed: must be skipped or rejected, never NaN, never a guessed number
    ['12.34.56', null, 'malformed; reject'],
  ];
  it.each(cases)('cell %j -> %j (%s)', (cell, expected) => {
    const r = safe(
      () => parse(csv([H3, ['05/11/2025', 'TEST SHOP', cell]])).transactions,
    );
    if (expected === null) {
      // acceptable: row skipped or error; unacceptable: any NaN / invented amount
      if (typeof r === 'string') return;
      expect(r.every((t) => Number.isFinite(t.amount))).toBe(true);
      expect(r).toEqual([]);
    } else {
      expect(r).toEqual([
        { dateISO: '2025-11-05', payee: 'TEST SHOP', amount: expected },
      ]);
    }
  });

  it('cleanAmount("12.34.56") is null, never NaN', () => {
    expect(cleanAmount('12.34.56')).toBeNull();
  });
});

describe('Excel numeric cells (rows built directly)', () => {
  const serial = Math.round(Date.UTC(2025, 10, 5) / 86400000) + 25569;
  const header = ['Date', 'Description', 'Amount'];
  const run = (amt: unknown) => {
    const t = resolveTable(header);
    if (t === null || t === 'savings') throw new Error('no table');
    return extractTransactions([header, [serial, 'TEST SHOP', amt]], {
      table: t,
      headerAt: 0,
    });
  };
  it('positive numeric amount is a debit (-)', () => {
    expect(run(1234.5)).toEqual([
      { dateISO: '2025-11-05', payee: 'TEST SHOP', amount: -1234.5 },
    ]);
  });
  it('JUDGMENT: negative numeric amount is a credit (+), same as "-500.00" text', () => {
    expect(run(-500)).toEqual([
      { dateISO: '2025-11-05', payee: 'TEST SHOP', amount: 500 },
    ]);
  });
  it('numeric 0 is a genuine zero-amount row or skipped, never a nonzero', () => {
    const r = run(0);
    expect(r.every((t) => t.amount === 0)).toBe(true);
  });
  it('cleanAmount(-500) must not silently drop the sign (unsigned contract: returns 500)', () => {
    // documents the unsigned contract; the sign must be handled by the caller
    expect(cleanAmount(-500)).toBe(500);
  });
});

describe('marker column (Debit/Credit header) values', () => {
  const HM = ['Date', 'Description', 'Amount', 'Debit/Credit'];
  const cases: [string, number][] = [
    ['Dr', -100],
    ['DR', -100],
    ['D', -100],
    ['Debit', -100],
    ['Cr', 100],
    ['CR', 100],
    ['C', 100],
    ['Credit', 100],
  ];
  it.each(cases)('marker %j -> %i', (marker, expected) => {
    const r = parse(csv([HM, ['05/11/2025', 'TEST', '100.00', marker]]));
    expect(r.transactions[0].amount).toBe(expected);
  });
  it.each([['Dr/Cr'], ['Cr/Dr'], ['Type'], ['Transaction Type']])(
    'header %j is recognised as the marker column (credit row must be +)',
    (name) => {
      const r = parse(
        csv([
          ['Date', 'Description', 'Amount', name],
          ['05/11/2025', 'SHOP', '100.00', 'Dr'],
          ['06/11/2025', 'REFUND', '40.00', 'Cr'],
        ]),
      );
      expect(r.transactions.map((t) => t.amount)).toEqual([-100, 40]);
    },
  );
});

describe('dates', () => {
  const cases: [string, string][] = [
    ['05/11/2025', '2025-11-05'],
    ['05-11-2025', '2025-11-05'],
    ['05-Nov-25', '2025-11-05'],
    ['05 Nov 2025', '2025-11-05'],
    ["05 Nov '25", '2025-11-05'],
    ['Nov 05, 2025', '2025-11-05'],
    ['2025-11-05', '2025-11-05'],
    ['5/11/25', '2025-11-05'],
    ['05/11/2025 17:06:00', '2025-11-05'],
  ];
  it.each(cases)('%j -> %s (DD/MM, India)', (input, iso) => {
    expect(safe(() => parseDate(input))).toBe(iso);
  });
});

describe('summary labels', () => {
  const body = [H3, ['05/11/2025', 'SHOP', '10.00']];
  const cases: [string, string, string, unknown][] = [
    ['Total Dues', '1,200.00', 'totalDue', 1200],
    ['Total Amount Due', '1,200.00', 'totalDue', 1200],
    ['Amount Payable', '1,200.00', 'totalDue', 1200],
    ['Minimum Amount Due', '100.00', 'minDue', 100],
    ['Min. Amt. Due', '100.00', 'minDue', 100],
    ['Payment Due Date', '25/11/2025', 'paymentDueDateISO', '2025-11-25'],
    ['Due Date', '25/11/2025', 'paymentDueDateISO', '2025-11-25'],
    ['Statement Date', '10/11/2025', 'statementDateISO', '2025-11-10'],
    // JUDGMENT: a period range closes on its end date = statement date
    [
      'Statement Period',
      '11/10/2025 - 10/11/2025',
      'statementDateISO',
      '2025-11-10',
    ],
  ];
  it.each(cases)('label %j -> %s = %j', (label, value, field, expected) => {
    const s = parse(csv([[label, value], ...body])).summary as Record<
      string,
      unknown
    >;
    expect(s[field]).toBe(expected);
  });

  it('Total Due "1,200.00 Cr" (credit balance) is NOT read as 1200 owed; correct = 0 (or unset)', () => {
    const s = parse(
      csv([['Total Amount Due', '1,200.00 Cr'], ...body]),
    ).summary;
    expect([0, undefined]).toContain(s.totalDue);
  });

  it('labels in one row, values in the row below (HDFC/Axis grid layout)', () => {
    const s = parse(
      csv([
        ['Total Amount Due', 'Minimum Amount Due', 'Payment Due Date'],
        ['1,200.00', '100.00', '25/11/2025'],
        ...body,
      ]),
    ).summary;
    expect(s).toEqual({
      totalDue: 1200,
      minDue: 100,
      paymentDueDateISO: '2025-11-25',
    });
  });
});

describe('table shapes', () => {
  it('undated "PREVIOUS BALANCE" row with an amount does not end the table', () => {
    const r = parse(
      csv([
        H3,
        ['', 'PREVIOUS BALANCE', '5,000.00'],
        ['05/11/2025', 'SHOP A', '100.00'],
        ['06/11/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.payee)).toEqual(['SHOP A', 'SHOP B']);
  });

  it('dated "OPENING BALANCE" row is not a transaction (would be read as +5000 credit)', () => {
    const r = parse(
      csv([
        H3,
        ['01/11/2025', 'OPENING BALANCE', '5,000.00 Cr'],
        ['05/11/2025', 'SHOP A', '100.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.payee)).toEqual(['SHOP A']);
  });

  it('unsupported date mid-table: later rows are kept and the skip is reported, never silent', () => {
    const r = parse(
      csv([
        H3,
        ['05/11/2025', 'SHOP A', '100.00'],
        ['6th Nov 2025', 'SHOP B', '200.00'],
        ['07/11/2025', 'SHOP C', '300.00'],
        ['08/11/2025', 'SHOP D', '400.00'],
      ]),
    );
    expect(r.transactions.map((t) => [t.payee, t.amount])).toEqual([
      ['SHOP A', -100],
      ['SHOP C', -300],
      ['SHOP D', -400],
    ]);
    expect(r.warnings).toEqual([
      {
        kind: 'skipped-row',
        row: 2,
        reason: 'unrecognised date "6th Nov 2025" on "SHOP B"',
      },
    ]);
  });

  it('wrapped description continuation row is glued to the previous payee', () => {
    const r = parse(
      csv([
        H3,
        ['05/11/2025', 'LONG MERCHANT NAME', '100.00'],
        ['', 'MUMBAI IN', ''],
        ['06/11/2025', 'SHOP B', '50.00'],
      ]),
    );
    expect(r.transactions).toEqual([
      {
        dateISO: '2025-11-05',
        payee: 'LONG MERCHANT NAME MUMBAI IN',
        amount: -100,
      },
      { dateISO: '2025-11-06', payee: 'SHOP B', amount: -50 },
    ]);
  });

  it('two card sections (primary + add-on) with repeated header: all rows kept, last4 = primary', () => {
    const r = parse(
      csv([
        ['Card Number', '4XXX XXXX XXXX 1234', ''],
        H3,
        ['05/11/2025', 'SHOP A', '100.00'],
        ['Add-on Card 4XXX XXXX XXXX 5678', '', ''],
        H3,
        ['06/11/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.last4).toBe('1234');
    expect(r.transactions.map((t) => [t.payee, t.amount])).toEqual([
      ['SHOP A', -100],
      ['SHOP B', -200],
    ]);
  });

  it('add-on section title in the description column (blank date) is not glued onto the previous payee', () => {
    const r = parse(
      csv([
        H3,
        ['05/11/2025', 'SHOP A', '100.00'],
        ['', 'ADD-ON CARD 4XXX XXXX XXXX 5678', ''],
        ['06/11/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.transactions[0].payee).toBe('SHOP A');
  });

  it('per-card subtotal row mid-table does not drop the add-on card transactions', () => {
    const r = parse(
      csv([
        H3,
        ['05/11/2025', 'SHOP A', '100.00'],
        ['', 'Sub Total Primary Card', '100.00'],
        ['06/11/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.payee)).toEqual(['SHOP A', 'SHOP B']);
  });

  it('reward-points column beside Amount does not disturb the amount', () => {
    const r = parse(
      csv([
        ['Date', 'Details', 'Reward Points', 'Amount (in Rs.)'],
        ['05/11/2025', 'SHOP A', '25', '1,000.00'],
      ]),
    );
    expect(r.transactions[0].amount).toBe(-1000);
  });

  it('foreign-currency column ("USD 12.00") before the INR amount: amount is the INR one', () => {
    const r = parse(
      csv([
        ['Date', 'Details', 'Foreign Currency Amount', 'Amount (in Rs.)'],
        ['05/11/2025', 'INTL SHOP', 'USD 12.00', '1,000.00'],
      ]),
    );
    expect(r.transactions[0].amount).toBe(-1000);
  });

  it('pipe-delimited "Transaction Date | Details | Amount (in Rs.)" header', () => {
    const r = parse(
      csv(
        [
          ['Transaction Date', 'Details', 'Amount (in Rs.)'],
          ['05/11/2025', 'SHOP A', '1,500.00'],
          ['06/11/2025', 'REFUND B', '300.00 Cr'],
        ],
        '|',
      ),
    );
    expect(r.transactions.map((t) => t.amount)).toEqual([-1500, 300]);
  });
});

describe('charge classification (lib/charges.ts)', () => {
  const charge: [string, string | null][] = [
    ['LATE PAYMENT FEE', 'late'],
    ['FINANCE CHARGES', 'interest'],
    ['EMI PRINCIPAL', null], // principal is spend, not a charge
    ['EMI INTEREST', 'interest'],
    ['IGST @18%', null], // unattributable tax: documented as untracked
    // JUDGMENT: GST on a late fee only exists because a late fee was levied
    ['GST ON LATE FEE', 'late'],
  ];
  it.each(charge)('classifyCharge(%j) = %j', (payee, expected) => {
    expect(classifyCharge(payee)).toBe(expected);
  });
});
