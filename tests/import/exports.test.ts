/**
 * Transaction exports (a bank's "download transactions" CSV): rows over any
 * date range, no statement date. Each is cut into one piece per billing
 * cycle, rows already stored are left out, and a statement takes its rows
 * back from exports. The catastrophic failures: spend counted twice, and
 * months of an export silently given up.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { IDBPDatabase } from 'idb';
import {
  cyclePeriod,
  isExport,
  splitByCycle,
  statementDayOf,
  withoutKnown,
} from '../../src/import/exports';
import {
  planImport,
  type FileOutcome,
  type ParseResult,
} from '../../src/import/plan';
import { commitImport } from '../../src/import/commit';
import { readStatementFiles } from '../../src/import/read';
import {
  getAllCards,
  getAllCycles,
  getAllStatements,
  getAllTransactions,
  openKardabraDb,
} from '../../src/db/db';
import type { KardabraSchema } from '../../src/db/schema';
import type { ParsedStatement, Transaction } from '../../src/parser';

const row = (dateISO: string, amount: number, payee = 'SHOP'): Transaction => ({
  dateISO,
  payee,
  amount,
});

const txns: Transaction[] = [
  row('2025-09-20', -1500, 'CAFE MOCHA KORAMANGALA'),
  row('2025-09-22', 5000, 'PAYMENT RECEIVED'),
  row('2025-09-25', -450.5, 'BOOK NOOK INDIRANAGAR'),
];

/** The October PDF statement: dated the 20th, card number printed. */
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

/** An export: no summary at all, the bank's own wording for each row. */
function exportOf(
  rows: Transaction[],
  fileName = 'export.csv',
  last4: string | null = null,
): ParsedStatement {
  return {
    fileName,
    last4,
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
const none = { nicknames: new Map(), dueDays: new Map() };
const nameOf = (o: FileOutcome) =>
  o.kind === 'new-statement' ? o.parsed.fileName : o.fileName;
const summary = (outcomes: FileOutcome[]) =>
  outcomes.map((o) => [
    nameOf(o),
    'period' in o ? o.period : null,
    o.kind,
    o.kind === 'new-statement' || o.kind === 'duplicate'
      ? o.parsed.transactions.length
      : 0,
  ]);

let db: IDBPDatabase<KardabraSchema>;
afterEach(async () => {
  db?.close();
  await new Promise<void>((resolve) => {
    indexedDB.deleteDatabase('kardabra').onsuccess = () => resolve();
  });
});

/** Plan against the database, every file assigned to the one card. */
async function plan(files: ParsedStatement[]) {
  const cards = await getAllCards(db);
  return planImport(
    files.map(ok),
    cards,
    await getAllStatements(db),
    cards.length === 1
      ? new Map(files.map((f) => [f.fileName, cards[0].id]))
      : new Map(),
    await getAllTransactions(db),
  );
}

async function importFirst(file: ParsedStatement) {
  db = await openKardabraDb();
  await commitImport(db, planImport([ok(file)], [], []), {
    nicknames: new Map([['4242', 'Mine']]),
    dueDays: new Map([['4242', 9]]),
  });
}

const cycles = async () =>
  (await getAllCycles(db)).map((c) => [c.period, c.spend]).sort();

describe('exports.ts', () => {
  it('tells an export from a statement missing only its date', () => {
    expect(isExport(exportOf(txns))).toBe(true);
    const undatedStatement = {
      ...exportOf(txns),
      summary: { paymentDueDateISO: '2025-11-09', totalDue: 100 },
    };
    expect(isExport(undatedStatement)).toBe(false);
  });

  it('files a day into the cycle whose statement date it falls before', () => {
    expect(cyclePeriod('2025-09-20', 20)).toBe('2025-09'); // on the day
    expect(cyclePeriod('2025-09-21', 20)).toBe('2025-10');
    expect(cyclePeriod('2025-12-25', 20)).toBe('2026-01'); // year rolls
    expect(cyclePeriod('2025-02-28', 31)).toBe('2025-02'); // short month
    expect(cyclePeriod('2025-09-25', null)).toBe('2025-09'); // calendar
  });

  // A February statement on the 28th must not redefine a 30th card.
  it("takes the card's most common statement day, the later on a tie", () => {
    expect(statementDayOf(['2025-01-30', '2025-02-28', '2025-03-30'])).toBe(30);
    expect(statementDayOf(['2025-01-15', '2025-02-20'])).toBe(20);
    expect(statementDayOf([undefined])).toBeNull();
  });

  it('cuts rows into cycles, oldest first, each row once', () => {
    const pieces = splitByCycle(
      exportOf([
        row('2025-10-05', -1),
        row('2025-08-03', -2),
        row('2025-08-25', -3),
      ]),
      20,
    );
    expect(pieces.map((p) => [p.period, p.parsed.transactions.length])).toEqual(
      [
        ['2025-08', 1],
        ['2025-09', 1],
        ['2025-10', 1],
      ],
    );
  });

  it('leaves out known rows as a multiset', () => {
    const ride = row('2025-11-03', -10, 'METRO');
    const { kept, removed } = withoutKnown(
      [ride, ride, ride, ride],
      [ride, ride, ride],
    );
    expect([kept.length, removed]).toEqual([1, 3]);
  });
});

describe('an export after its statement', () => {
  it('adds nothing when every row is already here', async () => {
    await importFirst(statement);
    const outcomes = await plan([exportOf(txns)]);
    expect(outcomes.every((o) => o.kind === 'duplicate')).toBe(true);
    await commitImport(db, outcomes, none);
    expect(await cycles()).toEqual([['2025-10', 1950.5]]);
  });

  // The case that prompted this: a long export, one month already in.
  it('adds every other month of a six-month export, in its own cycle', async () => {
    await importFirst(statement);
    const sixMonths = exportOf([
      row('2025-06-01', -100),
      row('2025-07-10', -200),
      row('2025-08-15', -300),
      ...txns, // already in oct.pdf
      row('2025-10-25', -400),
      row('2025-11-10', -500),
    ]);
    const outcomes = await plan([sixMonths]);
    // Cut by the card's statement day (the 20th), not calendar months.
    expect(summary(outcomes)).toEqual([
      ['export.csv', '2025-06', 'new-statement', 1],
      ['export.csv', '2025-07', 'new-statement', 1],
      ['export.csv', '2025-08', 'new-statement', 1],
      ['export.csv', '2025-09', 'duplicate', 1], // Sep 20: in oct.pdf
      ['export.csv', '2025-10', 'duplicate', 2], // Sep 22, 25: in oct.pdf
      ['export.csv', '2025-11', 'new-statement', 2], // Oct 25, Nov 10
    ]);
    await commitImport(db, outcomes, none);
    expect(await cycles()).toEqual([
      ['2025-06', 100],
      ['2025-07', 200],
      ['2025-08', 300],
      ['2025-10', 1950.5],
      ['2025-11', 900],
    ]);
    expect(await getAllTransactions(db)).toHaveLength(8);
  });

  it('adds new rows to a month an earlier export already holds', async () => {
    await importFirst(statement);
    await commitImport(
      db,
      await plan([
        exportOf([row('2025-11-02', -1), row('2025-11-03', -2)], 'a.csv'),
      ]),
      none,
    );
    const outcomes = await plan([
      exportOf(
        [row('2025-11-02', -1), row('2025-11-03', -2), row('2025-11-10', -3)],
        'b.csv',
      ),
    ]);
    expect(outcomes[0]).toMatchObject({
      kind: 'duplicate',
      supersedes: true,
      adds: 1,
    });
    await commitImport(db, outcomes, none);
    expect(await getAllTransactions(db)).toHaveLength(6); // 3 + 2 + 1
    expect(await cycles()).toEqual([
      ['2025-10', 1950.5],
      ['2025-11', 6],
    ]);
  });
});

describe('stored files that are not exports', () => {
  // ICICI/Axis style: due date and total, but no statement date.
  const undated = (period: string, rows: Transaction[]): ParsedStatement => ({
    ...statement,
    fileName: `undated-${period}.xlsx`,
    summary: { paymentDueDateISO: `${period}-28`, totalDue: 100 },
    transactions: rows,
  });

  it('an export never adds rows to a real statement missing its date', async () => {
    await importFirst(
      undated('2025-11', [row('2025-11-02', -1), row('2025-11-03', -2)]),
    );
    const outcomes = await plan([exportOf([row('2025-11-10', -3)])]);
    expect(outcomes[0]).toMatchObject({
      kind: 'duplicate',
      supersedes: false,
      notAdded: 1,
    });
  });

  it('a statement never trims a real statement missing its date', async () => {
    await importFirst(undated('2025-09', txns));
    expect((await plan([statement]))[0]).not.toHaveProperty('trims');
  });
});

describe('two exports in one batch, a month already holding an export', () => {
  it('both add their new rows', async () => {
    await importFirst(statement);
    await commitImport(
      db,
      await plan([
        exportOf([row('2025-11-02', -1), row('2025-11-03', -2)], 'a.csv'),
      ]),
      none,
    );
    const outcomes = await plan([
      exportOf([row('2025-11-02', -1), row('2025-11-10', -3)], 'b.csv'),
      exportOf([row('2025-11-11', -4)], 'c.csv'),
    ]);
    expect(outcomes[0]).toMatchObject({ kind: 'duplicate', adds: 2 });
    expect(outcomes[1]).toMatchObject({
      kind: 'duplicate',
      alreadyIn: 'b.csv',
    });
    await commitImport(db, outcomes, none);
    expect(await cycles()).toEqual([
      ['2025-10', 1950.5],
      ['2025-11', 10], // 1 + 2 + 3 + 4
    ]);
  });
});

describe('a statement after its export', () => {
  const exportFirst = exportOf(
    [
      row('2025-08-03', -20000, 'RENT'),
      row('2025-08-15', -1200, 'GYM'),
      ...txns,
      row('2025-10-05', -99, 'LATE'),
    ],
    'export.csv',
    '4242',
  );

  it("takes back its rows; the export's other months stay", async () => {
    // No statement yet, so the export is cut by calendar month.
    await importFirst(exportFirst);
    expect(await cycles()).toEqual([
      ['2025-08', 21200],
      ['2025-09', 1950.5], // the 5000 credit is a bill payment, not spend
      ['2025-10', 99],
    ]);
    const outcomes = await plan([statement]);
    expect(outcomes[0]).toMatchObject({
      kind: 'duplicate', // October holds the export's October piece
      supersedes: true, // a statement always replaces an export piece
      exportRowsDropped: 1, // the Oct 5 row isn't in this statement
      trims: [{ fileName: 'export.csv', period: '2025-09' }],
    });
    await commitImport(db, outcomes, none);
    expect(await cycles()).toEqual([
      ['2025-08', 21200], // stays
      ['2025-10', 1950.5],
    ]);
    expect(await getAllTransactions(db)).toHaveLength(5);
  });

  it('re-dropping the export afterwards counts nothing twice', async () => {
    await importFirst(exportFirst);
    await commitImport(db, await plan([statement]), none);
    const again = await plan([exportFirst]);
    // Oct 5 now falls in the October cycle, whose statement doesn't hold
    // it: not added, and said so.
    expect(
      again.find((o) => o.kind === 'duplicate' && o.notAdded),
    ).toMatchObject({
      period: '2025-10',
      notAdded: 1,
    });
    await commitImport(db, again, none);
    expect(await getAllTransactions(db)).toHaveLength(5);
  });
});

describe('one batch', () => {
  it.each([
    ['statement first, export unnumbered', [statement, exportOf(txns)]],
    ['export first, unnumbered', [exportOf(txns), statement]],
    [
      'export names the card',
      [exportOf(txns, 'export.csv', '4242'), statement],
    ],
  ])("an export's rows in the statement are already in it (%s)", (_, files) => {
    const outcomes = planImport(files.map(ok), [], []);
    const pieces = outcomes.filter((o) => nameOf(o) === 'export.csv');
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      expect(piece).toMatchObject({ kind: 'duplicate', alreadyIn: 'oct.pdf' });
    }
    expect(outcomes.find((o) => nameOf(o) === 'oct.pdf')?.kind).toBe(
      'new-statement',
    );
  });

  it("two exports' pieces for the same month become one", () => {
    const a = exportOf(
      [row('2025-11-02', -1), row('2025-11-03', -2)],
      'a.csv',
      '4242',
    );
    const b = exportOf(
      [row('2025-11-03', -2), row('2025-11-10', -3)],
      'b.csv',
      '4242',
    );
    const outcomes = planImport([ok(a), ok(b)], [], []);
    expect(summary(outcomes)).toEqual([
      ['a.csv', '2025-11', 'new-statement', 3],
      ['b.csv', '2025-11', 'duplicate', 2],
    ]);
  });

  // The first import of all: nothing to ask "which card" against.
  it("an unnumbered export's other months join the statement's card", () => {
    const spread: ParsedStatement = {
      ...statement,
      transactions: [row('2025-09-28', -10), row('2025-10-02', -20)],
    };
    // Calendar pieces share one row each; the file shares two.
    const exp = exportOf([
      row('2025-09-28', -10),
      row('2025-10-02', -20),
      row('2025-11-05', -30),
    ]);
    const outcomes = planImport([ok(spread), ok(exp)], [], []);
    const nov = outcomes.find(
      (o) => nameOf(o) === 'export.csv' && o.kind === 'new-statement',
    );
    expect(nov).toMatchObject({
      period: '2025-11',
      cardRef: { kind: 'new', last4: '4242' },
    });
    expect(
      outcomes.filter(
        (o) => nameOf(o) === 'export.csv' && o.kind === 'duplicate',
      ),
    ).toHaveLength(2);
  });

  // One shared row can be two cards paying the same subscription.
  it("unnumbered exports of different cards sharing one row don't merge", () => {
    const a = exportOf(
      [row('2025-10-01', -649, 'NETFLIX'), row('2025-10-05', -1)],
      'a.csv',
    );
    const b = exportOf(
      [row('2025-10-01', -649, 'NETFLIX'), row('2025-10-06', -2)],
      'b.csv',
    );
    expect(planImport([ok(a), ok(b)], [], []).map((o) => o.kind)).toEqual([
      'new-statement',
      'new-statement',
    ]);
  });
});

describe('statements', () => {
  // Cycles never overlap, so shared rows between statements are coincidence.
  it('never block each other, even sharing rows', async () => {
    await importFirst(statement);
    const november: ParsedStatement = {
      ...statement,
      fileName: 'nov.pdf',
      summary: { statementDateISO: '2025-11-20' },
      transactions: [txns[0], txns[2], row('2025-11-02', -2000)],
    };
    expect((await plan([november]))[0].kind).toBe('new-statement');
  });

  it('a statement missing only its date is one file, never cut', () => {
    const undated: ParsedStatement = {
      ...statement,
      fileName: 'myzone.xlsx',
      summary: { paymentDueDateISO: '2025-11-09', totalDue: 100 },
      transactions: [row('2025-09-25', -1), row('2025-10-15', -2)],
    };
    expect(planImport([ok(undated)], [], [])).toHaveLength(1);
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
