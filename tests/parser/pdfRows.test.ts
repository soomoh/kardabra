/**
 * PDF text → rows, pinned on hand-built page layouts (fabricated data) that
 * reproduce the geometry found in real HDFC, SBI, ICICI and Axis statements
 * during the PDF spike. Each test names the quirk it pins.
 */
import { describe, expect, it } from 'vitest';
import { parsePdfText } from '../../src/parser';
import { rowsFromPdfPages, type PdfTextItem } from '../../src/parser/pdfRows';
import { reconcile } from '../../src/lib/reconcile';

/** One text item; width approximated from its length. */
const t = (s: string, x: number, y: number, w = s.length * 5): PdfTextItem => ({
  s,
  x,
  y,
  w,
  h: 9,
});
const page = (...items: PdfTextItem[]) => ({ items });

// HDFC-style: labels above values (one wrapped, one blocked by a stray "_"),
// "C" for ₹, "+" marking a credit, a bar glued to the date.
const hdfcLike = page(
  t('Statement Date', 190, 715),
  t('13 Feb, 2026', 340, 715),
  t('PAYMENTS/CREDITS', 155, 620),
  t('PREVIOUS STATEMENT DUES', 40, 615),
  t('FINANCE CHARGES', 350, 615),
  t('TOTAL AMOUNT DUE', 445, 615),
  t('RECEIVED', 170, 611),
  t('PURCHASES/DEBIT', 255, 620),
  t('_', 133, 596),
  t('C', 63, 592, 4),
  t('1,000.00', 67, 592),
  t('C', 167, 592, 4),
  t('1,000.00', 171, 592),
  t('C', 268, 592, 4),
  t('500.00', 271, 592),
  t('C', 372, 592, 4),
  t('0.00', 376, 592),
  t('C', 446, 592, 4),
  t('500.00', 453, 592),
  t('MINIMUM DUE', 446, 562),
  t('DUE DATE', 512, 562),
  t('C', 446, 544, 4),
  t('25.00', 450, 544),
  t('05 Mar, 2026', 512, 544),
  t('DATE & TIME', 170, 145),
  t('TRANSACTION DESCRIPTION', 251, 145),
  t('REWARDS', 463, 145),
  t('AMOUNT', 530, 145),
  t('14/01/2026| 10:23', 170, 116),
  t('CAFE ONE', 251, 116),
  t('+ 4', 472, 116),
  t('C', 533, 116, 4),
  t('300.00', 539, 116),
  t('20/01/2026| 11:00', 170, 101),
  t('BOOK SHOP', 251, 101),
  t('C', 533, 101, 4),
  t('200.00', 539, 101),
  t('01/02/2026| 09:00', 170, 87),
  t('BPPY CC PAYMENT', 251, 87),
  t('+', 528, 87, 4),
  t('C', 533, 87, 4),
  t('1,000.00', 539, 87),
);

describe('HDFC-style layout', () => {
  const p = parsePdfText('hdfc.pdf', [hdfcLike]);

  it('pairs labels with the values printed below them (wrapped label, stray "_")', () => {
    expect(p.summary).toMatchObject({
      statementDateISO: '2026-02-13',
      openingBalance: 1000,
      paymentsTotal: 1000,
      purchasesTotal: 500,
      chargesTotal: 0,
      totalDue: 500,
      minDue: 25,
      paymentDueDateISO: '2026-03-05',
    });
  });

  it('reads dates with a glued bar, "C" as ₹, and "+" as a credit', () => {
    expect(p.transactions.map((x) => [x.dateISO, x.amount])).toEqual([
      ['2026-01-14', -300],
      ['2026-01-20', -200],
      ['2026-02-01', 1000],
    ]);
  });

  it('adds up', () => {
    expect(reconcile(p.summary, p.transactions)).toEqual({ status: 'ok' });
  });
});

// SBI-style: header wrapped over two lines, a "( ` )" unit cell, a lone C/D
// after each amount, a description header centred far right of where
// descriptions start, an undated GST line under a fee, and a later page of
// worked examples that must not be read as transactions.
const sbiLike = [
  page(
    t('Transaction Details', 179, 570),
    t('Amount', 372, 568),
    t('( ` )', 403, 567),
    t('Date', 34, 566),
    t('16 Jun 26', 26, 540),
    t('PAYMENT RECEIVED', 71, 540),
    t('500.00', 380, 540),
    t('C', 415, 540, 5),
    t('13 Jul 26', 26, 529),
    t('ANNUAL FEE', 71, 529),
    t('400.00', 380, 529),
    t('D', 415, 529, 5),
    t('IGST @ 18%', 26, 517),
    t('72.00', 385, 517),
    t('D', 415, 517, 5),
    t('19 Jun 26', 26, 481),
    t('GROCER', 71, 481),
    t('1,000.00', 373, 481),
    t('D', 415, 481, 5),
  ),
  page(
    t('Example: Finance Charge on 1,424', 26, 700),
    t('from 3 April', 200, 700),
    t('36.87', 380, 700),
    t('D', 415, 700, 5),
  ),
];

describe('SBI-style layout', () => {
  const p = parsePdfText('sbi.pdf', sbiLike);

  it('splits date from a description that sits nearer the Date header', () => {
    expect(p.transactions.find((x) => x.amount === -1000)?.payee).toBe(
      'GROCER',
    );
  });

  it('reads the lone C/D after each amount as its direction', () => {
    expect(
      p.transactions.find((x) => x.payee.startsWith('PAYMENT'))?.amount,
    ).toBe(500);
  });

  it('gives an undated GST line the date of the fee above it', () => {
    expect(p.transactions.find((x) => x.payee.includes('IGST'))).toMatchObject({
      dateISO: '2026-07-13',
      amount: -72,
    });
  });

  it('does not read worked examples on a later page as transactions', () => {
    expect(p.transactions).toHaveLength(4);
    expect(p.transactions.some((x) => x.amount === -36.87)).toBe(false);
  });
});

describe('table header detection', () => {
  it('ignores prose that mentions date, details and amount in one cell', () => {
    const rows = rowsFromPdfPages([
      page(
        t('3.', 175, 400),
        t('PAYMENT DETAILS: MINIMUM AMOUNT DUE BY DUE DATE', 185, 400, 300),
      ),
      page(
        t('DATE', 50, 300),
        t('TRANSACTION DETAILS', 184, 300),
        t('AMOUNT (Rs.)', 514, 300),
        t('18/08/2025', 35, 280),
        t('SHOP', 90, 280),
        t('216.98 Dr', 550, 280),
      ),
    ]);
    expect(rows).toContainEqual([
      'DATE',
      'TRANSACTION DETAILS',
      'AMOUNT (Rs.)',
    ]);
    expect(rows).toContainEqual(['18/08/2025', 'SHOP', '216.98 Dr']);
  });

  it('continues a table onto a page with dates but no header of its own', () => {
    const p = parsePdfText('two.pdf', [
      page(
        t('DATE', 50, 300),
        t('TRANSACTION DETAILS', 184, 300),
        t('AMOUNT (Rs.)', 514, 300),
        t('18/08/2025', 35, 280),
        t('SHOP', 190, 280),
        t('100.00 Dr', 550, 280),
      ),
      page(
        t('19/08/2025', 35, 700),
        t('CAFE', 190, 700),
        t('50.00 Dr', 550, 700),
      ),
    ]);
    expect(p.transactions.map((x) => x.amount)).toEqual([-100, -50]);
  });
});

// Text under the table that is not part of any row: page footers, fine
// print, legends, a card-number line — and real wrapped descriptions, which
// must still be kept. Positions copied from real statements' geometry.
describe('text lines under the table', () => {
  const header = [
    t('Statement Date', 50, 700),
    t('13/02/2026', 200, 700),
    t('DATE', 50, 600),
    t('TRANSACTION DESCRIPTION', 140, 600),
    t('AMOUNT', 500, 600),
  ];
  const payees = (...items: PdfTextItem[]) =>
    parsePdfText('x.pdf', [page(...header, ...items)]).transactions.map(
      (txn) => txn.payee,
    );

  it('keeps a page footer and fine print out of the last payee', () => {
    expect(
      payees(
        t('20/01/2026', 50, 580),
        t('CAFE ONE', 140, 580),
        t('300.00', 500, 580),
        t('*Transaction time is in IST.', 20, 552),
        t('Page 1 of 2', 27, 20),
      ),
    ).toEqual(['CAFE ONE']);
  });

  it('keeps a description wrapped onto the next line', () => {
    expect(
      payees(
        t('20/01/2026', 50, 580),
        t('PAYMENT RECEIVED', 140, 580),
        t('300.00', 500, 580),
        t('(Ref# AB123)', 140, 570),
        t('21/01/2026', 50, 556),
        t('BOOK SHOP', 140, 556),
        t('200.00', 500, 556),
      ),
    ).toEqual(['PAYMENT RECEIVED (Ref# AB123)', 'BOOK SHOP']);
  });

  it('joins a description centred on its row, half above and half below (HDFC)', () => {
    expect(
      payees(
        t('16/01/2026', 50, 580),
        t('SHOP ABROAD', 140, 580),
        t('1,400.00', 500, 580),
        t('IGST-RATE 18.0 (Ref#', 140, 569.5),
        t('17/01/2026', 50, 565.2),
        t('5.00', 500, 565.2),
        t('AB123)', 140, 560.9),
      ),
    ).toEqual(['SHOP ABROAD', 'IGST-RATE 18.0 (Ref# AB123)']);
  });

  it('ignores a legend that starts left of the descriptions (ICICI)', () => {
    expect(
      payees(
        t('14/04/2026', 50, 580),
        t('SHOP IN', 140, 580),
        t('379.98', 500, 580),
        t('# International Spends', 45, 572),
      ),
    ).toEqual(['SHOP IN']);
  });

  it('ignores a card-number line just above the first row (Axis)', () => {
    const rows = [
      t('Card No: 4111XXXXXXXX4242', 45, 590),
      t('18/08/2025', 50, 580),
      t('SHOP ONE', 140, 580),
      t('216.98', 500, 580),
    ];
    expect(payees(...rows)).toEqual(['SHOP ONE']);
    // Still visible to the card-number search.
    expect(parsePdfText('x.pdf', [page(...header, ...rows)]).last4).toBe(
      '4242',
    );
  });

  it('does not turn a summary box under the table into a transaction', () => {
    const { transactions } = parsePdfText('x.pdf', [
      page(
        ...header,
        t('20/01/2026', 50, 580),
        t('CAFE ONE', 140, 580),
        t('300.00', 500, 580),
        t('Transactions for EMI', 54, 520),
        t('CONVERTED TO EMI', 494, 520),
        t('3', 226, 514),
        t('13,838.83', 500, 514),
      ),
    ]);
    expect(transactions).toEqual([
      { dateISO: '2026-01-20', payee: 'CAFE ONE', amount: -300 },
    ]);
  });
});

it('finds the card number below a long summary block (HDFC: ~90 label pairs)', () => {
  // Labels printed above their values each become a pair row, all emitted
  // before the page's own lines — enough of them once hid the card number.
  const letters = (k: number) =>
    String.fromCharCode(65 + (k % 26)) +
    String.fromCharCode(65 + Math.floor(k / 26));
  const summary = Array.from({ length: 70 }, (_, k) => [
    t(`REWARD LEVEL ${letters(k)}`, 50, 2000 - k * 25),
    t(String(k + 1), 50, 1990 - k * 25),
  ]).flat();
  const { last4 } = parsePdfText('x.pdf', [
    page(
      ...summary,
      t('Credit Card No.', 50, 200),
      t('411111XXXXXX4242', 200, 200),
      t('DATE', 50, 150),
      t('TRANSACTION DESCRIPTION', 140, 150),
      t('AMOUNT', 500, 150),
      t('20/01/2026', 50, 130),
      t('CAFE ONE', 140, 130),
      t('300.00', 500, 130),
    ),
  ]);
  expect(last4).toBe('4242');
});
