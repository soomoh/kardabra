/**
 * The same transactions arriving twice in different files — a bank's CSV
 * export beside its PDF statement. The catastrophic failure is spend
 * counted twice: an export follows no billing cycle, so it is filed under
 * another month and slips past same-month duplicate detection.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { planImport, type ParseResult } from '../../src/import/plan';
import { commitImport } from '../../src/import/commit';
import { readStatementFiles } from '../../src/import/read';
import {
  getAllCards,
  getAllCycles,
  getAllStatements,
  getAllTransactions,
  openKardabraDb,
} from '../../src/db/db';
import type { ParsedStatement, Transaction } from '../../src/parser';

const txns: Transaction[] = [
  { dateISO: '2025-09-20', payee: 'CAFE MOCHA KORAMANGALA', amount: -1500 },
  { dateISO: '2025-09-22', payee: 'PAYMENT RECEIVED', amount: 5000 },
  { dateISO: '2025-09-25', payee: 'BOOK NOOK INDIRANAGAR', amount: -450.5 },
];

/** The October PDF statement: dated, card number printed. */
const statement: ParsedStatement = {
  fileName: 'oct.pdf',
  last4: '4242',
  currency: 'INR',
  summary: {
    statementDateISO: '2025-10-20',
    paymentDueDateISO: '2025-11-09',
    totalDue: 12345.67,
  },
  transactions: txns,
  warnings: [],
};

/** The same card's net-banking CSV: no date, no card number, and the
 * bank's own wording for each row. Filed by its last row: September. */
function exportOf(
  rows: Transaction[],
  fileName = 'export.csv',
): ParsedStatement {
  return {
    fileName,
    last4: null,
    currency: 'INR',
    summary: {},
    transactions: rows.map((t) => ({ ...t, payee: `${t.payee} REF123` })),
    warnings: [],
  };
}

const ok = (p: ParsedStatement): ParseResult => ({
  fileName: p.fileName,
  parsed: p,
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    indexedDB.deleteDatabase('kardabra').onsuccess = () => resolve();
  });
});

async function withOctoberImported() {
  const db = await openKardabraDb();
  await commitImport(db, planImport([ok(statement)], [], []), {
    nicknames: new Map([['4242', 'Mine']]),
    dueDays: new Map(),
  });
  const cards = await getAllCards(db);
  /** Plan files against the database, the export assigned to the card. */
  const plan = async (files: ParsedStatement[]) =>
    planImport(
      files.map(ok),
      cards,
      await getAllStatements(db),
      new Map(files.map((f) => [f.fileName, cards[0].id])),
      await getAllTransactions(db),
    );
  return { db, plan };
}

describe('a file whose transactions are already stored', () => {
  it('is not written, and says which statement already has them', async () => {
    const { db, plan } = await withOctoberImported();
    const outcomes = await plan([exportOf(txns)]);
    expect(outcomes[0]).toMatchObject({
      kind: 'duplicate',
      period: '2025-09',
      supersedes: false,
      refreshes: false,
      overlaps: { period: '2025-10', fileName: 'oct.pdf' },
    });

    await commitImport(db, outcomes, {
      nicknames: new Map(),
      dueDays: new Map(),
    });
    // Still one month, spend counted once.
    expect((await getAllCycles(db)).map((c) => [c.period, c.spend])).toEqual([
      ['2025-10', 1950.5],
    ]);
    db.close();
  });

  it('also when the export runs into the next month', async () => {
    const { db, plan } = await withOctoberImported();
    const straddle = exportOf([
      ...txns,
      { dateISO: '2025-11-05', payee: 'NEXT MONTH SHOP', amount: -500 },
    ]);
    expect((await plan([straddle]))[0]).toMatchObject({
      kind: 'duplicate',
      overlaps: { period: '2025-10' },
    });
    db.close();
  });

  // One coincidence (same amount, same day) must not block an export.
  it('an export sharing a single row with a statement still imports', async () => {
    const { db, plan } = await withOctoberImported();
    const november = exportOf(
      [
        txns[0], // a repeat visit, same price, same day: rare but real
        { dateISO: '2025-10-28', payee: 'GROCER', amount: -800 },
        { dateISO: '2025-11-02', payee: 'FUEL', amount: -2000 },
        { dateISO: '2025-11-10', payee: 'PHARMACY', amount: -350 },
      ],
      'nov.csv',
    );
    expect((await plan([november]))[0].kind).toBe('new-statement');
    db.close();
  });

  // The accepted gap: one shared row is never enough, even in a tiny file.
  it('a one-row export is never treated as an overlap', async () => {
    const { db, plan } = await withOctoberImported();
    expect((await plan([exportOf([txns[0]], 'one.csv')]))[0].kind).toBe(
      'new-statement',
    );
    db.close();
  });

  it("an export with more rows doesn't replace the same month's statement", async () => {
    const { db, plan } = await withOctoberImported();
    const sameMonth = exportOf([
      ...txns,
      { dateISO: '2025-10-01', payee: 'EXTRA', amount: -10 },
    ]);
    expect((await plan([sameMonth]))[0]).toMatchObject({
      kind: 'duplicate',
      period: '2025-10',
      supersedes: false,
      overlaps: { period: '2025-10', fileName: 'oct.pdf' },
    });
    db.close();
  });
});

describe('two files in one batch holding the same transactions', () => {
  // A real export has no card number; on a first import there's no card
  // to ask about, so it must still be matched to the statement.
  it.each([
    ['statement first', [statement, exportOf(txns)]],
    ['export first', [exportOf(txns), statement]],
    [
      'export names the card',
      [{ ...exportOf(txns), last4: '4242' }, statement],
    ],
  ])('the dated statement is written, the export is not (%s)', (_, files) => {
    const outcomes = planImport(files.map(ok), [], []);
    const byFile = new Map(
      outcomes.map((o) => [
        o.kind === 'new-statement'
          ? o.parsed.fileName
          : (o as { fileName: string }).fileName,
        o,
      ]),
    );
    expect(byFile.get('oct.pdf')?.kind).toBe('new-statement');
    expect(byFile.get('export.csv')).toMatchObject({
      kind: 'duplicate',
      inBatch: true,
      overlaps: { period: '2025-10', fileName: 'oct.pdf' },
    });
  });
});

describe('order and coincidence', () => {
  it('a statement imported after its export replaces it', async () => {
    const db = await openKardabraDb();
    await commitImport(
      db,
      planImport([ok({ ...exportOf(txns), last4: '4242' })], [], []),
      {
        nicknames: new Map([['4242', 'Mine']]),
        dueDays: new Map([['4242', 9]]),
      },
    );
    const outcomes = planImport(
      [ok(statement)],
      await getAllCards(db),
      await getAllStatements(db),
      new Map(),
      await getAllTransactions(db),
    );
    expect(outcomes[0]).toMatchObject({
      kind: 'new-statement',
      period: '2025-10',
      trims: [{ fileName: 'export.csv', period: '2025-09' }],
    });
    await commitImport(db, outcomes, {
      nicknames: new Map(),
      dueDays: new Map(),
    });
    expect((await getAllStatements(db)).map((s) => s.fileName)).toEqual([
      'oct.pdf',
    ]);
    expect((await getAllCycles(db)).map((c) => [c.period, c.spend])).toEqual([
      ['2025-10', 1950.5],
    ]);
    expect(await getAllTransactions(db)).toHaveLength(3);
    db.close();
  });

  // Two statements' cycles never overlap, so shared rows are coincidence.
  it('statements never block each other, even sharing two rows', async () => {
    const { db, plan } = await withOctoberImported();
    const november: ParsedStatement = {
      ...statement,
      fileName: 'nov.pdf',
      summary: { statementDateISO: '2025-11-20' },
      transactions: [
        txns[0],
        txns[2],
        { dateISO: '2025-11-02', payee: 'FUEL', amount: -2000 },
      ],
    };
    expect((await plan([november]))[0].kind).toBe('new-statement');
    db.close();
  });

  it('repeated identical rows count once per row, not per stored copy', async () => {
    const { db, plan } = await withOctoberImported();
    const metro = { dateISO: '2025-11-03', payee: 'METRO', amount: -10 };
    const rides = exportOf([metro, metro, metro], 'rides.csv');
    await commitImport(db, await plan([rides]), {
      nicknames: new Map(),
      dueDays: new Map(),
    });
    // One ride matches; three new rows don't: not an overlap.
    const later = exportOf(
      [
        metro,
        { dateISO: '2025-12-20', payee: 'A', amount: -1 },
        { dateISO: '2025-12-21', payee: 'B', amount: -2 },
        { dateISO: '2025-12-22', payee: 'C', amount: -3 },
      ],
      'later.csv',
    );
    expect((await plan([later]))[0].kind).toBe('new-statement');
    db.close();
  });

  it('a second, overlapping export is not added', async () => {
    const { db, plan } = await withOctoberImported();
    const first = exportOf(
      [
        { dateISO: '2025-11-02', payee: 'A', amount: -1 },
        { dateISO: '2025-11-03', payee: 'B', amount: -2 },
      ],
      'nov1.csv',
    );
    await commitImport(db, await plan([first]), {
      nicknames: new Map(),
      dueDays: new Map(),
    });
    const second = exportOf(
      [
        ...first.transactions,
        { dateISO: '2025-12-01', payee: 'C', amount: -3 },
      ],
      'dec.csv',
    );
    expect((await plan([second]))[0]).toMatchObject({
      kind: 'duplicate',
      overlaps: { fileName: 'nov1.csv' },
    });
    db.close();
  });
});

describe('a statement and an export that came first', () => {
  it("takes back only its own rows; the export's other months stay", async () => {
    const db = await openKardabraDb();
    const august = [
      { dateISO: '2025-08-03', payee: 'RENT', amount: -20000 },
      { dateISO: '2025-08-15', payee: 'GYM', amount: -1200 },
    ];
    // Aug + Sep rows in one export, filed under September (its last row).
    const multiMonth = { ...exportOf([...august, ...txns]), last4: '4242' };
    await commitImport(db, planImport([ok(multiMonth)], [], []), {
      nicknames: new Map([['4242', 'Mine']]),
      dueDays: new Map([['4242', 9]]),
    });
    const outcomes = planImport(
      [ok(statement)],
      await getAllCards(db),
      await getAllStatements(db),
      new Map(),
      await getAllTransactions(db),
    );
    await commitImport(db, outcomes, {
      nicknames: new Map(),
      dueDays: new Map(),
    });

    const rows = await getAllTransactions(db);
    expect(rows).toHaveLength(5); // 3 in the statement, 2 August rows kept
    const statements = await getAllStatements(db);
    const exportLeft = statements.find((s) => s.fileName === 'export.csv');
    expect(exportLeft?.txnCount).toBe(2);
    expect(
      rows
        .filter((r) => r.statementId === exportLeft?.id)
        .map((r) => r.dateISO),
    ).toEqual(['2025-08-03', '2025-08-15']);
    expect(
      (await getAllCycles(db)).map((c) => [c.period, c.spend]).sort(),
    ).toEqual([
      ['2025-09', 21200],
      ['2025-10', 1950.5],
    ]);
    db.close();
  });

  // Dropping the original export again after the trim must not bring the
  // trimmed rows back.
  it('re-dropping the trimmed export changes nothing', async () => {
    const db = await openKardabraDb();
    const august = [
      { dateISO: '2025-08-03', payee: 'RENT', amount: -20000 },
      { dateISO: '2025-08-15', payee: 'GYM', amount: -1200 },
    ];
    const multiMonth = { ...exportOf([...august, ...txns]), last4: '4242' };
    const planNow = async (p: ParsedStatement) =>
      planImport(
        [ok(p)],
        await getAllCards(db),
        await getAllStatements(db),
        new Map(),
        await getAllTransactions(db),
      );
    await commitImport(db, planImport([ok(multiMonth)], [], []), {
      nicknames: new Map([['4242', 'Mine']]),
      dueDays: new Map([['4242', 9]]),
    });
    const none = { nicknames: new Map(), dueDays: new Map() };
    await commitImport(db, await planNow(statement), none);

    const again = await planNow(multiMonth);
    expect(again[0]).toMatchObject({
      kind: 'duplicate',
      supersedes: false,
      overlaps: { fileName: 'oct.pdf' },
    });
    await commitImport(db, again, none);
    expect(await getAllTransactions(db)).toHaveLength(5);
    db.close();
  });

  it('in the same month, it replaces the export and says how many rows go', async () => {
    const db = await openKardabraDb();
    // Filed under October: its last row is in October.
    const octExport = {
      ...exportOf([
        ...txns,
        { dateISO: '2025-10-25', payee: 'LATE', amount: -99 },
      ]),
      last4: '4242',
    };
    await commitImport(db, planImport([ok(octExport)], [], []), {
      nicknames: new Map([['4242', 'Mine']]),
      dueDays: new Map([['4242', 9]]),
    });
    const [outcome] = planImport(
      [ok(statement)],
      await getAllCards(db),
      await getAllStatements(db),
      new Map(),
      await getAllTransactions(db),
    );
    expect(outcome).toMatchObject({
      kind: 'duplicate',
      supersedes: true, // fewer rows, but a statement beats an export
      exportRowsDropped: 1,
    });
    await commitImport(db, [outcome], {
      nicknames: new Map(),
      dueDays: new Map(),
    });
    expect((await getAllStatements(db)).map((s) => s.fileName)).toEqual([
      'oct.pdf',
    ]);
    expect(await getAllTransactions(db)).toHaveLength(3);
    db.close();
  });

  it('in one batch, a statement beats a fuller export for the same month', () => {
    const octExport = {
      ...exportOf([
        ...txns,
        { dateISO: '2025-10-25', payee: 'LATE', amount: -99 },
      ]),
      last4: '4242',
    };
    const outcomes = planImport([ok(octExport), ok(statement)], [], []);
    expect(outcomes.map((o) => o.kind)).toEqual(['duplicate', 'new-statement']);
  });

  it('two unnumbered exports from different cards sharing one row both import', () => {
    const a = exportOf(
      [
        { dateISO: '2025-10-01', payee: 'NETFLIX', amount: -649 },
        { dateISO: '2025-10-05', payee: 'A', amount: -1 },
        { dateISO: '2025-10-06', payee: 'B', amount: -2 },
      ],
      'a.csv',
    );
    const b = exportOf(
      [
        { dateISO: '2025-10-01', payee: 'NETFLIX', amount: -649 },
        { dateISO: '2025-11-05', payee: 'C', amount: -3 },
        { dateISO: '2025-11-06', payee: 'D', amount: -4 },
      ],
      'b.csv',
    );
    expect(planImport([ok(a), ok(b)], [], []).map((o) => o.kind)).toEqual([
      'new-statement',
      'new-statement',
    ]);
  });
});

describe('an unreadable spreadsheet', () => {
  it('suggests the PDF statement first', async () => {
    const bytes = new TextEncoder().encode(
      'Statement for card\nSl,Info,Value\n1,x,100\n',
    );
    const { results } = await readStatementFiles(
      [{ name: 'odd.csv', bytes }],
      async () => {
        throw new Error('no PDFs here');
      },
    );
    const [outcome] = planImport(results, [], []);
    expect(outcome).toMatchObject({ kind: 'rejected', errorKind: 'no-table' });
    if (outcome.kind !== 'rejected') return;
    expect(outcome.advice).toMatch(
      /^If your bank emails you PDF statements, import the PDF instead\./,
    );
  });
});
