// Runs the real hledger on an export and the shipped rules file. Skipped
// where hledger isn't installed (CI); run locally before changing either.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  buildExportCsv as buildExport,
  type ExportInput,
} from '../../src/export/csv';

const buildExportCsv = (input: ExportInput) => buildExport(input).csv;

function hasHledger(): boolean {
  try {
    execFileSync('hledger', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const RULES = join(__dirname, '../../docs/hledger/kardabra.rules');
const dir = mkdtempSync(join(tmpdir(), 'kardabra-hledger-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The card owed ₹9,000 before October; October's rows net to +8,170, so the
// statement closes owing ₹830.
const OPENING = `2026-09-30 opening balance
    liabilities:creditcard:Regalia   INR -9000.00
    equity:opening
`;

const october: ExportInput = {
  cards: [
    {
      id: 'card-a',
      last4: '1234',
      nickname: 'Regalia',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  statements: [
    {
      id: 's-oct',
      cardId: 'card-a',
      period: '2026-10',
      totalDue: 830,
      openingBalance: 9000,
      currency: 'INR',
      fileName: 'oct.csv',
      txnCount: 5,
      importedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  transactions: [
    ['2026-10-03', 'PAYTM*BUNDL TECHNOLOGIES PVT BANGALORE IN', -450],
    ['2026-10-05', 'BBPS Payment Received', 9000],
    ['2026-10-09', 'ACME, AGENCIES', 120],
    ['2026-10-12', '10% Swiggy Cashback (Ref# ST574325291891941)', 45],
    ['2026-10-20', 'ANNUAL FEE', -545],
  ].map(([dateISO, payee, amount], i) => ({
    id: `t${i}`,
    statementId: 's-oct',
    cardId: 'card-a',
    dateISO: dateISO as string,
    payee: payee as string,
    amount: amount as number,
  })),
  cycles: [],
};

/** The real flow: a journal holding the opening balance, `hledger import`
 * of the export into it, then `args` run on that journal. (hledger checks a
 * CSV's balance assertions against that file alone when it reads one
 * directly, so only the imported journal shows the true picture.) */
function hledger(csv: string, ...args: string[]): string {
  const run = (...a: string[]) =>
    execFileSync('hledger', a, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const csvPath = join(dir, 'export.csv');
  const journal = join(dir, 'main.journal');
  writeFileSync(csvPath, csv);
  writeFileSync(journal, OPENING);
  rmSync(join(dir, '.latest.export.csv'), { force: true });
  // Assertions are checked after the import, on the whole journal.
  run('-f', journal, 'import', '--rules', RULES, csvPath, '-I');
  return run('-f', journal, ...args);
}

describe.skipIf(!hasHledger())('hledger reads the export', () => {
  test('balances land where the rules say, and the closing assertion holds', () => {
    const out = hledger(
      buildExportCsv(october),
      'balance',
      '--flat',
      '--no-total',
      '-O',
      'csv',
    );
    const balances = Object.fromEntries(
      out
        .trim()
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/"/g, '').split(',')),
    );
    expect(balances).toEqual({
      'assets:transfer:card-payments': 'INR -9000.00',
      'equity:opening': 'INR 9000.00',
      'expenses:fees': 'INR 545.00',
      'expenses:unknown': 'INR 330.00',
      'income:cashback': 'INR -45.00',
      'liabilities:creditcard:Regalia': 'INR -830.00',
    });
    // hledger skips assertions when it only reads a CSV; `check` (or a
    // journal the CSV was imported into) runs them.
    expect(() =>
      hledger(buildExportCsv(october), 'check', 'assertions'),
    ).not.toThrow();
  });

  test('payee is the clean merchant, the note keeps the raw text', () => {
    const out = hledger(buildExportCsv(october), 'print', '-O', 'csv');
    expect(out).toContain('Swiggy | PAYTM*BUNDL TECHNOLOGIES PVT BANGALORE IN');
    expect(out).toContain('ACME, AGENCIES');
  });

  test("a late-posted charge doesn't break the previous statement's check", () => {
    const withNovember: ExportInput = {
      ...october,
      statements: [
        { ...october.statements[0], statementDateISO: '2026-10-28' },
        {
          ...october.statements[0],
          id: 's-nov',
          period: '2026-11',
          statementDateISO: '2026-11-28',
          totalDue: 1130,
          openingBalance: 830,
        },
      ],
      transactions: [
        ...october.transactions,
        // Bought 25 Oct, after nothing; billed on November's statement.
        {
          id: 'late',
          statementId: 's-nov',
          cardId: 'card-a',
          dateISO: '2026-10-25',
          payee: 'COOL COFFEE',
          amount: -100,
        },
        {
          id: 'nov',
          statementId: 's-nov',
          cardId: 'card-a',
          dateISO: '2026-11-05',
          payee: 'ACME AGENCIES',
          amount: -200,
        },
      ],
    };
    expect(() =>
      hledger(buildExportCsv(withNovember), 'check', 'assertions'),
    ).not.toThrow();
    // The charge counts after October closed, its real date kept as date2.
    const out = hledger(
      buildExportCsv(withNovember),
      'print',
      'desc:COOL',
      '-O',
      'csv',
    );
    expect(out).toContain('"2026-10-29","2026-10-25"');
  });

  test('a missing row fails the import loudly', () => {
    const short = {
      ...october,
      transactions: october.transactions.filter((t) => t.id !== 't2'),
    };
    expect(() => hledger(buildExportCsv(short), 'check', 'assertions')).toThrow(
      /balance assertion/i,
    );
  });
});
