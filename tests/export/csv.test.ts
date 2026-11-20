import { describe, expect, test } from 'vitest';
import {
  buildExportCsv as buildExport,
  EXPORT_COLUMNS,
  type ExportInput,
} from '../../src/export/csv';
import type {
  CardRecord,
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../../src/db/schema';

const card = (over: Partial<CardRecord> = {}): CardRecord => ({
  id: 'card-a',
  last4: '1234',
  nickname: 'Regalia',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const statement = (over: Partial<StatementRecord> = {}): StatementRecord => ({
  id: 's-oct',
  cardId: 'card-a',
  period: '2026-10',
  fileName: 'oct.csv',
  txnCount: 0,
  importedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

let seq = 0;
const txn = (
  statementId: string,
  dateISO: string,
  payee: string,
  amount: number,
  cardId = 'card-a',
): TransactionRecord => ({
  id: `t${++seq}`,
  statementId,
  cardId,
  dateISO,
  payee,
  amount,
});

const cycle = (over: Partial<CycleRecord> = {}): CycleRecord => ({
  cardId: 'card-a',
  period: '2026-10',
  dueDateISO: '2026-11-05',
  source: 'statement',
  ...over,
});

/** Parse the export back into records: a strict RFC 4180 reader, so the
 * test checks quoting rather than trusting it. */
function parseCsv(text: string): Record<string, string>[] {
  expect(text.endsWith('\r\n')).toBe(true);
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }
  const [header, ...body] = rows;
  expect(header).toEqual([...EXPORT_COLUMNS]);
  return body.map((cells) => {
    expect(cells).toHaveLength(EXPORT_COLUMNS.length);
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

const buildExportCsv = (...args: Parameters<typeof buildExport>) =>
  buildExport(...args).csv;

const input = (over: Partial<ExportInput>): ExportInput => ({
  cards: [card()],
  statements: [],
  transactions: [],
  cycles: [],
  ...over,
});

describe('buildExportCsv', () => {
  test('an empty store gives the header alone', () => {
    expect(buildExport(input({}))).toEqual({
      csv: EXPORT_COLUMNS.join(',') + '\r\n',
      rows: 0,
    });
  });

  test('the row count is the transactions, not the lines', () => {
    const { rows } = buildExport(
      input({
        statements: [statement()],
        transactions: [
          txn('s-oct', '2026-10-01', 'TWO\r\nLINES', -1),
          txn('s-oct', '2026-10-02', 'ONE', -1),
        ],
      }),
    );
    expect(rows).toBe(2);
  });

  test('one statement: signs, kinds, merchant, balances', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [
            statement({
              totalDue: 12500,
              openingBalance: 9000,
              currency: 'INR',
              issuer: 'HDFC Bank',
            }),
          ],
          transactions: [
            txn(
              's-oct',
              '2026-10-03',
              'PAYTM*BUNDL TECHNOLOGIES PVT BANGALORE IN',
              -450,
            ),
            txn('s-oct', '2026-10-05', 'BBPS Payment Received', 9000),
            txn('s-oct', '2026-10-09', 'ACME AGENCIES', 120),
            txn('s-oct', '2026-10-20', 'ANNUAL FEE', -499),
          ],
          cycles: [cycle()],
        }),
      ),
    );
    expect(rows.map((r) => [r.date, r.amount, r.kind, r.merchant])).toEqual([
      ['2026-10-03', '-450.00', 'purchase', 'Swiggy'],
      ['2026-10-05', '9000.00', 'payment', 'BBPS Payment Received'],
      ['2026-10-09', '120.00', 'refund', 'ACME AGENCIES'],
      ['2026-10-20', '-499.00', 'fee', 'ANNUAL FEE'],
    ]);
    // No earlier statement: every row is booked on its own date
    expect(rows.every((r) => r.booked === r.date)).toBe(true);
    // Raw description untouched
    expect(rows[0].description).toBe(
      'PAYTM*BUNDL TECHNOLOGIES PVT BANGALORE IN',
    );
    // Owed is negative in every money column; first row opens, last closes
    expect(rows.map((r) => [r.opening_balance, r.closing_balance])).toEqual([
      ['-9000.00', ''],
      ['', ''],
      ['', ''],
      ['', '-12500.00'],
    ]);
    expect(rows[0]).toMatchObject({
      posted: '',
      currency: 'INR',
      card_last4: '1234',
      card_nickname: 'Regalia',
      card_issuer: 'HDFC Bank',
      statement_id: 's-oct',
      period: '2026-10',
    });
  });

  test('a statement closing in credit has a positive closing balance', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [statement({ totalDue: 0, creditBalance: 1200 })],
          transactions: [txn('s-oct', '2026-10-03', 'ACME AGENCIES', 1200)],
        }),
      ),
    );
    expect(rows[0].closing_balance).toBe('1200.00');
  });

  test('a transaction export with no total has no balances', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [statement()],
          transactions: [txn('s-oct', '2026-10-03', 'ACME AGENCIES', -10)],
        }),
      ),
    );
    expect([rows[0].opening_balance, rows[0].closing_balance]).toEqual([
      '',
      '',
    ]);
  });

  test("the payment matches the app's: an unlabelled one found by last month's due", () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [
            statement({ id: 's-sep', period: '2026-09', totalDue: 5000 }),
            statement({ id: 's-oct', period: '2026-10', totalDue: 300 }),
          ],
          transactions: [
            txn('s-sep', '2026-09-10', 'COOL COFFEE', -5000),
            txn('s-oct', '2026-10-04', 'TELE TRANSFER CREDIT', 5000),
            txn('s-oct', '2026-10-06', 'ACME AGENCIES', 6000),
            txn('s-oct', '2026-10-08', 'COOL COFFEE', -300),
          ],
          cycles: [cycle({ period: '2026-09' }), cycle({ period: '2026-10' })],
        }),
      ),
    );
    // The amount rung picks the ₹5,000 credit, not the larger ₹6,000 one
    expect(rows.map((r) => r.kind)).toEqual([
      'purchase',
      'payment',
      'refund',
      'purchase',
    ]);
  });

  test("the user's own payment pick wins", () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [statement()],
          transactions: [
            txn('s-oct', '2026-10-04', 'BBPS Payment Received', 700),
            txn('s-oct', '2026-10-05', 'GIFT FROM FRIEND', 900),
          ],
          cycles: [
            cycle({
              paymentOverride: [{ amount: 900, payee: 'GIFT FROM FRIEND' }],
            }),
          ],
        }),
      ),
    );
    expect(rows.map((r) => r.kind)).toEqual(['refund', 'payment']);
  });

  test('rows from all cards, oldest first, statement order within a day', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          cards: [
            card(),
            card({ id: 'card-b', last4: null, nickname: 'Coral' }),
          ],
          statements: [statement(), statement({ id: 's-b', cardId: 'card-b' })],
          transactions: [
            txn('s-oct', '2026-10-09', 'SECOND', -2),
            txn('s-oct', '2026-10-09', 'THIRD', -3),
            txn('s-b', '2026-10-01', 'FIRST', -1, 'card-b'),
            txn('s-b', '2026-10-09', 'FOURTH', -4, 'card-b'),
          ],
        }),
      ),
    );
    expect(rows.map((r) => r.description)).toEqual([
      'FIRST',
      'SECOND',
      'THIRD',
      'FOURTH',
    ]);
    expect(rows[0].card_last4).toBe('');
    expect(rows[0].card_nickname).toBe('Coral');
  });

  test('since: earlier rows go; a cut statement keeps its closing, not its opening', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [statement({ totalDue: 800, openingBalance: 100 })],
          transactions: [
            txn('s-oct', '2026-10-03', 'BEFORE', -1),
            txn('s-oct', '2026-10-15', 'ON THE DAY', -2),
            txn('s-oct', '2026-10-20', 'AFTER', -3),
          ],
        }),
        { since: '2026-10-15' },
      ),
    );
    expect(rows.map((r) => r.description)).toEqual(['ON THE DAY', 'AFTER']);
    expect(rows.map((r) => [r.opening_balance, r.closing_balance])).toEqual([
      ['', ''],
      ['', '-800.00'],
    ]);
  });

  // Banks print the total due rounded to the rupee and carry the exact
  // balance forward: the export closes on the exact balance, or hledger's
  // check fails by paise every month. The catastrophic case is the reverse:
  // a misread row hidden by the exact sum, so anything beyond rounding keeps
  // the printed total.
  test.each([
    ['rounded down: the exact balance', 7161.94, 7162, '-7161.94'],
    ['rounded up: the exact balance', 7162.5, 7162, '-7162.50'],
    ['beyond rounding: the printed total', 7161.4, 7162, '-7162.00'],
    ['a total with paise: printed as is', 7161.94, 7161.9, '-7161.90'],
  ])('closing, %s', (_, owed, totalDue, closing) => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [statement({ totalDue, openingBalance: 1000 })],
          transactions: [
            txn('s-oct', '2026-10-03', 'EARLY', -1000.1),
            txn('s-oct', '2026-10-20', 'LATE', -(owed - 2000.1)),
          ],
        }),
        // Cut: the closing still counts the rows before `since`.
        { since: '2026-10-15' },
      ),
    );
    expect(rows.map((r) => r.closing_balance)).toEqual([closing]);
  });

  // Credit closes. An opening the bank didn't mark as credit is read as owed,
  // so the sum lands far off and the printed total stands (fails safe).
  test.each([
    ['from an amount owed: the exact credit', 500, 1699.6, '1199.60'],
    ['unmarked credit opening: the printed total', 500, 699.6, '1200.00'],
    ['no opening: the printed total', undefined, 1199.6, '1200.00'],
  ])('closing in credit, %s', (_, openingBalance, paid, closing) => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [
            statement({ totalDue: 0, creditBalance: 1200, openingBalance }),
          ],
          transactions: [txn('s-oct', '2026-10-05', 'PAYMENT', paid)],
        }),
      ),
    );
    expect(rows[0].closing_balance).toBe(closing);
  });

  test('booked: a late-posted charge moves to the day after the previous statement', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [
            statement({
              id: 's-sep',
              period: '2026-09',
              statementDateISO: '2026-09-28',
            }),
            statement({
              id: 's-oct',
              period: '2026-10',
              statementDateISO: '2026-10-28',
            }),
          ],
          transactions: [
            txn('s-sep', '2026-09-10', 'ON TIME', -1),
            txn('s-sep', '2026-09-28', 'ON THE CLOSING DAY', -2),
            txn('s-oct', '2026-09-27', 'LATE POSTED', -3),
            txn('s-oct', '2026-10-03', 'OCTOBER', -4),
          ],
        }),
      ),
    );
    expect(rows.map((r) => [r.description, r.date, r.booked])).toEqual([
      ['ON TIME', '2026-09-10', '2026-09-10'],
      ['LATE POSTED', '2026-09-27', '2026-09-29'],
      ['ON THE CLOSING DAY', '2026-09-28', '2026-09-28'],
      ['OCTOBER', '2026-10-03', '2026-10-03'],
    ]);
  });

  test('booked: an undated previous statement ends at its last transaction', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [
            statement({ id: 's-dec', period: '2026-12' }),
            statement({ id: 's-jan', period: '2027-01' }),
          ],
          transactions: [
            txn('s-dec', '2026-12-31', 'NEW YEAR EVE', -1),
            txn('s-jan', '2026-12-30', 'LATE POSTED', -2),
          ],
        }),
      ),
    );
    expect(rows.map((r) => r.booked)).toEqual(['2027-01-01', '2026-12-31']);
  });

  test('currency: the statement, then the card, then INR', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          cards: [
            card({ currency: 'USD' }),
            card({ id: 'card-b', nickname: 'B' }),
          ],
          statements: [
            statement({ currency: 'SGD' }),
            statement({ id: 's-2', period: '2026-11' }),
            statement({ id: 's-b', cardId: 'card-b' }),
          ],
          transactions: [
            txn('s-oct', '2026-10-01', 'A', -1),
            txn('s-2', '2026-11-01', 'B', -1),
            txn('s-b', '2026-10-02', 'C', -1, 'card-b'),
          ],
        }),
      ),
    );
    expect(rows.map((r) => r.currency)).toEqual(['SGD', 'INR', 'USD']);
  });

  test('the newest statement naming a bank names the card', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [
            statement({ id: 's-sep', period: '2026-09', issuer: 'Axis Bank' }),
            statement({ id: 's-oct', period: '2026-10', issuer: 'HDFC Bank' }),
            statement({ id: 's-nov', period: '2026-11' }),
          ],
          transactions: [txn('s-sep', '2026-09-01', 'A', -1)],
        }),
      ),
    );
    expect(rows[0].card_issuer).toBe('HDFC Bank');
  });

  test('a statement whose card is gone is left out', () => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          statements: [statement({ cardId: 'gone' })],
          transactions: [txn('s-oct', '2026-10-01', 'A', -1, 'gone')],
        }),
      ),
    );
    expect(rows).toEqual([]);
  });
});

describe('text safety', () => {
  test.each([
    ['=HYPERLINK("http://x","y")', '\'=HYPERLINK("http://x","y")'],
    ['+91 STORE', "'+91 STORE"],
    ['-ADJUSTMENT', "'-ADJUSTMENT"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTAB', "'\tTAB"],
    ['PLAIN, WITH COMMA', 'PLAIN, WITH COMMA'],
    ['SAYS "HI"', 'SAYS "HI"'],
    ['LINE\nBREAK', 'LINE\nBREAK'],
  ])('%j comes back as %j', (payee, expected) => {
    const rows = parseCsv(
      buildExportCsv(
        input({
          cards: [card({ nickname: '=CMD()' })],
          statements: [statement()],
          transactions: [txn('s-oct', '2026-10-01', payee, -5)],
        }),
      ),
    );
    expect(rows[0].description).toBe(expected);
    expect(rows[0].card_nickname).toBe("'=CMD()");
    // Money columns stay plain numbers, never prefixed
    expect(rows[0].amount).toBe('-5.00');
  });
});
