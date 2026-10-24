/**
 * Phase 1 parser hardening: pins the behaviours beyond the per-case tables in
 * indian-variants.test.ts — amount parsing API, per-file locale inference,
 * skip-vs-stop in the transaction loop, summary grids and reconciliation,
 * credit balances, and currency. Synthetic data only.
 *
 * Sign convention: money out negative, money in positive. A sign error is the
 * catastrophic failure mode, so signs are asserted wherever money moves.
 */
import { describe, it, expect } from 'vitest';
import {
  parseStatementBytes,
  parseAmount,
  parseDate,
  extractTransactions,
  resolveTable,
} from '../../src/parser';
import { inferDateOrder } from '../../src/parser/dates';
import { inferDecimalStyle } from '../../src/parser/locale';

const enc = new TextEncoder();
const q = (c: string) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
const csv = (rows: string[][], d = ',') =>
  rows.map((r) => r.map(q).join(d)).join('\n') + '\n';
const parse = (text: string) => parseStatementBytes('p.csv', enc.encode(text));
const H3 = ['Date', 'Description', 'Amount'];

describe('parseAmount — magnitude plus explicit sign information', () => {
  const cases: [unknown, unknown][] = [
    ['1,234.50', { value: 1234.5, negative: false, plus: false, marker: null }],
    [
      '₹1,23,456.78',
      { value: 123456.78, negative: false, plus: false, marker: null },
    ],
    ['Rs.1000', { value: 1000, negative: false, plus: false, marker: null }],
    [
      '1,200.00 Cr.',
      { value: 1200, negative: false, plus: false, marker: 'cr' },
    ],
    ['1200.00Dr', { value: 1200, negative: false, plus: false, marker: 'dr' }],
    ['CR 500', { value: 500, negative: false, plus: false, marker: 'cr' }],
    ['-500.00', { value: 500, negative: true, plus: false, marker: null }],
    ['500.00-', { value: 500, negative: true, plus: false, marker: null }],
    ['(500.00)', { value: 500, negative: true, plus: false, marker: null }],
    [-12.5, { value: 12.5, negative: true, plus: false, marker: null }],
    [0, { value: 0, negative: false, plus: false, marker: null }],
    ['0.00', { value: 0, negative: false, plus: false, marker: null }],
  ];
  it.each(cases)('%j', (cell, expected) => {
    expect(parseAmount(cell)).toEqual(expected);
  });

  it.each(['12.34.56', '', ' - ', null, undefined, 'abc', '05/11/2025', NaN])(
    '%j is null (a sentinel), never NaN or a guessed number',
    (cell) => {
      expect(parseAmount(cell)).toBeNull();
    },
  );

  it('reads a decimal-comma amount only when told the file uses one', () => {
    expect(parseAmount('1.234,56', 'comma')?.value).toBe(1234.56);
    expect(parseAmount('12,50', 'comma')?.value).toBe(12.5);
    // dot style refuses a comma after the decimal point rather than
    // silently turning "1.234,56" into 1.23456
    expect(parseAmount('1.234,56', 'dot')).toBeNull();
  });
});

describe('per-file locale inference', () => {
  it('detects decimal-comma files from their amount cells, defaults to dot', () => {
    expect(inferDecimalStyle([['x', '1.234,56']])).toBe('comma');
    expect(inferDecimalStyle([['x', '12,50']])).toBe('comma');
    expect(inferDecimalStyle([['x', '1,23,456.78']])).toBe('dot'); // lakh
    expect(inferDecimalStyle([['x', '1,500.00']])).toBe('dot');
    expect(inferDecimalStyle([['x', 'MUMBAI 12,50 STORE']])).toBe('dot');
  });

  it('parses a decimal-comma statement end to end with correct signs', () => {
    const r = parse(
      csv(
        [
          ['Date', 'Description', 'Amount', 'Debit/Credit'],
          ['05/11/2025', 'SHOP', '1.234,56', 'Dr'],
          ['06/11/2025', 'REFUND', '12,50', 'Cr'],
        ],
        ';',
      ),
    );
    expect(r.transactions.map((t) => t.amount)).toEqual([-1234.56, 12.5]);
  });

  it('still reads Indian lakh grouping in a dot-decimal file', () => {
    const r = parse(csv([H3, ['05/11/2025', 'SHOP', '1,23,456.78']]));
    expect(r.transactions[0].amount).toBe(-123456.78);
  });

  it('infers date order: first component > 12 -> day-first', () => {
    expect(inferDateOrder(['13/11/2025', '05/11/2025'])).toBe('dmy');
  });
  it('infers date order: second component > 12 -> month-first', () => {
    expect(inferDateOrder(['11/13/2025', '05/11/2025'])).toBe('mdy');
  });
  it('infers date order: ambiguous -> day-first (India)', () => {
    expect(inferDateOrder(['05/11/2025', '06/11/2025'])).toBe('dmy');
  });

  it('reads a whole month-first file as month-first, including summary dates', () => {
    const r = parse(
      csv([
        ['Statement Date', '11/25/2025'],
        H3,
        ['11/05/2025', 'SHOP A', '100.00'],
        ['11/13/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.dateISO)).toEqual([
      '2025-11-05',
      '2025-11-13',
    ]);
    expect(r.summary.statementDateISO).toBe('2025-11-25');
  });

  it('keeps an ambiguous file day-first: 05/11/2025 is 5 November', () => {
    expect(parseDate('05/11/2025')).toBe('2025-11-05');
    expect(parseDate('05/11/2025', 'mdy')).toBe('2025-05-11');
  });
});

describe('dates — extra formats', () => {
  it.each([
    ['5 Nov, 2025', '2025-11-05'],
    ['06/Nov/2025', '2025-11-06'],
    ['05-11-25', '2025-11-05'],
    ['Nov 05, 2025', '2025-11-05'],
    ['05 Nov 2025', '2025-11-05'],
  ])('%j -> %s', (input, iso) => {
    expect(parseDate(input)).toBe(iso);
  });
});

describe('sign pinning (catastrophic failure mode)', () => {
  it('a refund written as -500.00 is money IN (+500), never spend', () => {
    const r = parse(csv([H3, ['05/11/2025', 'REFUND', '-500.00']]));
    expect(r.transactions[0].amount).toBe(500);
  });
  it('a plain amount with no marker is money OUT (negative)', () => {
    const r = parse(csv([H3, ['05/11/2025', 'SHOP', '500.00']]));
    expect(r.transactions[0].amount).toBe(-500);
  });
  it('an explicit marker column beats a stray minus: "-100" with Dr stays a debit', () => {
    const r = parse(
      csv([
        ['Date', 'Description', 'Amount', 'Dr/Cr'],
        ['05/11/2025', 'SHOP', '-100.00', 'Dr'],
      ]),
    );
    expect(r.transactions[0].amount).toBe(-100);
  });
  it('a zero amount is +0, not negative zero', () => {
    const r = parse(csv([H3, ['05/11/2025', 'FREE', '0.00']]));
    expect(Object.is(r.transactions[0].amount, 0)).toBe(true);
  });
  it('a "Transaction type" column of Domestic/International is not a marker', () => {
    const r = parse(
      csv([
        ['Transaction type', 'Date', 'Description', 'Amt', 'Debit / Credit'],
        ['Domestic', '05/11/2025', 'SHOP', '100.00', ' '],
        ['Domestic', '06/11/2025', 'REFUND', '40.00', 'Cr'],
      ]),
    );
    expect(r.transactions.map((t) => t.amount)).toEqual([-100, 40]);
  });
  it.each([
    ['Debit', -100],
    ['Credit', 100],
    ['D', -100],
    ['C', 100],
  ])('"Txn Type" values %j -> %i', (value, expected) => {
    const r = parse(
      csv([
        ['Date', 'Description', 'Amount', 'Txn Type'],
        ['05/11/2025', 'X', '100.00', value],
      ]),
    );
    expect(r.transactions[0].amount).toBe(expected);
  });
});

describe('amount column choice', () => {
  it('prefers the rupee column over a foreign-currency column, whatever the order', () => {
    const r = parse(
      csv([
        ['Date', 'Details', 'Amount (in Rs.)', 'Foreign Currency Amount'],
        ['05/11/2025', 'INTL SHOP', '1,000.00', 'USD 12.00'],
      ]),
    );
    expect(r.transactions[0].amount).toBe(-1000);
  });
  it('resolves the rupee column when the foreign one comes first', () => {
    const t = resolveTable([
      'Date',
      'Details',
      'Foreign Currency Amount',
      'Amount (INR)',
    ]);
    expect(t).not.toBe('savings');
    expect(t).not.toBeNull();
    if (t === null || t === 'savings') return;
    expect(t.amtCol).toBe(3);
  });
});

describe('transaction loop — skip vs stop', () => {
  it('an undated TOTAL row still ends the table (rows below are not transactions)', () => {
    const r = parse(
      csv([
        H3,
        ['05/11/2025', 'SHOP A', '100.00'],
        ['', 'TOTAL', '100.00'],
        ['06/11/2025', 'BELOW THE TOTAL', '50.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.payee)).toEqual(['SHOP A']);
  });

  it('a merchant merely containing "total" is a transaction, not a bookkeeping line', () => {
    const r = parse(csv([H3, ['05/11/2025', 'TOTAL WINE AND MORE', '100.00']]));
    expect(r.transactions.map((t) => t.payee)).toEqual(['TOTAL WINE AND MORE']);
  });

  it('a dated Opening Balance ... Cr is not a +credit', () => {
    const r = parse(
      csv([
        H3,
        ['01/11/2025', 'Opening Balance', '5,000.00 Cr'],
        ['05/11/2025', 'SHOP', '100.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.amount)).toEqual([-100]);
  });

  it('an unreadable date with an amount is skipped WITH a warning and keeps the rest', () => {
    const r = parse(
      csv([
        H3,
        ['31/02/2025', 'IMPOSSIBLE DAY', '100.00'],
        ['06/11/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.payee)).toEqual(['SHOP B']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({ kind: 'skipped-row', row: 1 });
  });

  it('a clean file has no warnings', () => {
    const r = parse(csv([H3, ['05/11/2025', 'SHOP', '100.00']]));
    expect(r.warnings).toEqual([]);
  });

  it('a section title is not glued to the previous payee', () => {
    const r = parse(
      csv([
        H3,
        ['05/11/2025', 'SHOP A', '100.00'],
        ['', 'Primary Card 4XXX XXXX XXXX 1234', ''],
        ['', 'ADD-ON CARD', ''],
        ['06/11/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.payee)).toEqual(['SHOP A', 'SHOP B']);
  });

  it('a balance line after a transaction is not glued either', () => {
    const r = parse(
      csv([
        H3,
        ['05/11/2025', 'SHOP A', '100.00'],
        ['', 'Previous Balance', ''],
        ['06/11/2025', 'SHOP B', '200.00'],
      ]),
    );
    expect(r.transactions.map((t) => t.payee)).toEqual(['SHOP A', 'SHOP B']);
  });

  it('extractTransactions accepts Excel numeric cells, including negative (credit)', () => {
    const header = ['Date', 'Description', 'Amount'];
    const serial = 45964; // 2025-11-03
    expect(
      extractTransactions([
        header,
        [serial, 'SHOP', 250],
        [serial, 'REFUND', -75],
      ]).map((t) => t.amount),
    ).toEqual([-250, 75]);
  });

  it('an HDFC-style rewards block under the table ends it without warnings', () => {
    const r = parse(
      csv(
        [
          [
            'Transaction type',
            'Name',
            'DATE',
            'Description',
            'Pts',
            'AMT',
            'Debit / Credit',
          ],
          ['Domestic', 'X', '20/09/2025', 'SHOP', '', '100', ' '],
          [],
          [
            'Opening Bal',
            'Earned',
            'Disbursed',
            'Adjusted',
            'Closing Balance',
            'Expiring in 30 days',
            'Expiring in 60 days',
          ],
          ['13004', '201', '0', '0', '13205', '0', '0'],
        ],
        '~',
      ),
    );
    expect(r.transactions.map((t) => t.amount)).toEqual([-100]);
    expect(r.warnings).toEqual([]);
  });
});

describe('summary — labels, grids, credit balance, reconciliation', () => {
  const body = [H3, ['05/11/2025', 'SHOP', '10.00']];

  it.each([
    ['Total Amount Payable', '900.00', 'totalDue', 900],
    ['Total Outstanding', '900.00', 'totalDue', 900],
    ['Minimum Due', '90.00', 'minDue', 90],
    ['Due By', '25/11/2025', 'paymentDueDateISO', '2025-11-25'],
    ['Pay By', '25/11/2025', 'paymentDueDateISO', '2025-11-25'],
    ['Payment Due On', '25/11/2025', 'paymentDueDateISO', '2025-11-25'],
  ])('label %j -> %s = %j', (label, value, field, expected) => {
    const s = parse(csv([[label, value], ...body])).summary as Record<
      string,
      unknown
    >;
    expect(s[field]).toBe(expected);
  });

  it('an explicit Statement Date beats a Statement Period end date', () => {
    const s = parse(
      csv([
        ['Statement Period', '11/10/2025 - 10/11/2025'],
        ['Statement Date', '12/11/2025'],
        ...body,
      ]),
    ).summary;
    expect(s.statementDateISO).toBe('2025-11-12');
  });

  it('reads "A TO B" period ranges (ICICI Coral)', () => {
    const s = parse(
      csv([['Statement Period', '24-10-2025 TO 13-11-2025'], ...body]),
    ).summary;
    expect(s.statementDateISO).toBe('2025-11-13');
  });

  it('a credit balance is totalDue 0 with the surplus in creditBalance', () => {
    const s = parse(
      csv([['Total Amount Due', '1,200.00 Cr'], ...body]),
    ).summary;
    expect(s.totalDue).toBe(0);
    expect(s.creditBalance).toBe(1200);
  });
  it('a negative total due is a credit balance too', () => {
    const s = parse(csv([['Total Amount Due', '-1,200.00'], ...body])).summary;
    expect(s.totalDue).toBe(0);
    expect(s.creditBalance).toBe(1200);
  });
  it('an ordinary total due sets no creditBalance', () => {
    const s = parse(csv([['Total Amount Due', '1,200.00'], ...body])).summary;
    expect(s.totalDue).toBe(1200);
    expect(s.creditBalance).toBeUndefined();
  });

  it('pairs an HDFC Account Summary label row with the value row below by column', () => {
    const r = parse(
      csv(
        [
          ['Account Summary'],
          [
            'Opening Bal',
            '-',
            'Payment / Credit',
            '+',
            'Purchases / Debits',
            '+',
            'Finance Charges',
            '=',
            'Total Dues',
          ],
          ['7628.49', '-', '8416.7', '+', '3460', '+', '0', '=', '2672'],
          ['Past Dues (If any)'],
          ['Overlimit', '3 Months', 'Current Dues', 'Minimum Amount Due'],
          ['0', '0', '360', '360'],
          ['DATE', 'Description', 'AMT', 'Debit / Credit'],
          ['20/09/2025', 'SHOP', '100', ' '],
        ],
        '~',
      ),
    );
    expect(r.summary).toEqual({
      openingBalance: 7628.49,
      paymentsTotal: 8416.7,
      purchasesTotal: 3460,
      chargesTotal: 0,
      totalDue: 2672,
      minDue: 360, // from the Past Dues grid: no earlier real minDue row here
    });
  });

  it('the real Minimum Amount Due row wins over the Past Dues repeat', () => {
    const s = parse(
      csv(
        [
          ['Minimum Amount Due', '617.28'],
          ['Past Dues'],
          ['Overlimit', 'Current Dues', 'Minimum Amount Due'],
          ['0', '9999', '9999'],
          ['DATE', 'Description', 'AMT', 'Debit / Credit'],
          ['20/09/2025', 'SHOP', '100', ' '],
        ],
        '~',
      ),
    ).summary;
    expect(s.minDue).toBe(617.28);
  });

  it('captures ICICI reconciliation labels', () => {
    const s = parse(
      csv([
        [
          'Previous Balance',
          'INR 925.65',
          'Payments and Other Credits',
          'INR 925.65',
        ],
        ['Purchases and Other Charges', 'INR 310.80'],
        ['Transaction Date', 'Details', 'Amount (INR)'],
        ['03-11-2025', 'SHOP', '310.80'],
      ]),
    ).summary;
    expect(s).toMatchObject({
      openingBalance: 925.65,
      paymentsTotal: 925.65,
      purchasesTotal: 310.8,
    });
  });

  it('captures Axis Opening Balance', () => {
    const s = parse(csv([['Opening Balance', '₹ 878.00'], ...body])).summary;
    expect(s.openingBalance).toBe(878);
  });
});

describe('currency', () => {
  it.each([
    ['₹ 100.00', 'INR'],
    ['Rs. 100.00', 'INR'],
    ['INR 100.00', 'INR'],
    ['$100.00', 'USD'],
    ['USD 100.00', 'USD'],
    ['€100.00', 'EUR'],
    ['EUR 100.00', 'EUR'],
    ['£100.00', 'GBP'],
    ['GBP 100.00', 'GBP'],
    ['100.00', 'INR'], // nothing says otherwise
  ])('amount cell %j -> %s', (cell, code) => {
    expect(parse(csv([H3, ['05/11/2025', 'SHOP', cell]])).currency).toBe(code);
  });

  it('a foreign-spend column on a rupee statement does not flip the currency', () => {
    const r = parse(
      csv([
        ['Date', 'Details', 'Foreign Amount', 'Amount (in Rs.)'],
        ['05/11/2025', 'A', 'USD 12.00', '1,000.00'],
        ['06/11/2025', 'B', 'USD 13.00', '1,100.00'],
        ['07/11/2025', 'C', 'USD 14.00', '1,200.00'],
      ]),
    );
    expect(r.currency).toBe('INR');
  });
});

// Review fix: one comma-looking cell must not flip a dot-decimal file.
describe('decimal style is a majority decision', () => {
  it('a stray "5,00" among rupee amounts keeps dot style', async () => {
    const { inferDecimalStyle } = await import('../../src/parser/locale');
    const rows = [
      ['Points', '5,00'],
      ['01/10/2025', 'SHOP A', '1,500.00'],
      ['02/10/2025', 'SHOP B', '925.65'],
    ];
    expect(inferDecimalStyle(rows)).toBe('dot');
  });

  it('a genuinely comma-decimal file is still comma style', async () => {
    const { inferDecimalStyle } = await import('../../src/parser/locale');
    expect(
      inferDecimalStyle([
        ['01/10/2025', 'A', '1.234,56'],
        ['02/10/2025', 'B', '12,50'],
      ]),
    ).toBe('comma');
  });
});

// PDF quirks: HDFC marks credits with a leading '+' and renders ₹ as a
// leading "C"; SBI prints a lone C/D after each amount.
describe('PDF amount quirks', () => {
  it.each([
    ['+ C 1.24', { value: 1.24, negative: false, plus: true, marker: null }],
    ['C 390.54', { value: 390.54, negative: false, plus: false, marker: null }],
    ['835.49 C', { value: 835.49, negative: false, plus: false, marker: 'cr' }],
    [
      '3,558.55 D',
      { value: 3558.55, negative: false, plus: false, marker: 'dr' },
    ],
  ])('%s', async (cell, expected) => {
    const { parseAmount } = await import('../../src/parser/cells');
    expect(parseAmount(cell)).toEqual(expected);
  });
});
