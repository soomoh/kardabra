/**
 * Regression tests for the Phase 1 import fixes (AUDIT #6, #7, #9, #11, #14)
 * and the v2 fields (stable ids, fingerprint, currency). Each test names the
 * failure it pins.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IDBPDatabase } from 'idb';
import { planImport, type ParseResult } from '../../src/import/plan';
import { commitImport, type CommitUserInput } from '../../src/import/commit';
import {
  getActionableCycleByCard,
  getAllCards,
  getAllStatements,
  getTransactionsForCard,
  openKardabraDb,
} from '../../src/db/db';
import type { KardabraSchema } from '../../src/db/schema';
import type { ParsedStatement, Transaction } from '../../src/parser';

function parsed(over: Partial<ParsedStatement>): ParsedStatement {
  return {
    fileName: 'stmt.csv',
    last4: '4321',
    currency: 'INR',
    summary: { statementDateISO: '2025-10-13' },
    transactions: [],
    warnings: [],
    ...over,
  };
}
const ok = (p: ParsedStatement): ParseResult => ({
  fileName: p.fileName,
  parsed: p,
});
const shop = (day: number, amount = -100): Transaction => ({
  dateISO: `2025-09-${String(day).padStart(2, '0')}`,
  payee: `SHOP ${day}`,
  amount,
});
const input = (over: Partial<CommitUserInput> = {}): CommitUserInput => ({
  nicknames: new Map([['4321', 'My Card']]),
  dueDays: new Map(),
  ...over,
});

async function importAll(
  db: IDBPDatabase<KardabraSchema>,
  files: ParsedStatement[],
  answers = input(),
) {
  const outcomes = planImport(
    files.map(ok),
    await getAllCards(db),
    await getAllStatements(db),
  );
  const result = await commitImport(db, outcomes, answers);
  return { outcomes, result };
}

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('kardabra');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
});

describe('#6 an existing card without a due day', () => {
  it('keeps the due day the user typed, and stops asking for it', async () => {
    const db = await openKardabraDb();
    await importAll(db, [parsed({ transactions: [shop(1)] })]);
    const [card] = await getAllCards(db);
    expect(card.dueDay).toBeUndefined();

    const nov = parsed({
      fileName: 'nov.csv',
      summary: { statementDateISO: '2025-11-13' },
      transactions: [shop(2)],
    });
    const { outcomes } = await importAll(
      db,
      [nov],
      input({ dueDays: new Map([[card.id, 5]]) }),
    );
    expect(outcomes[0]).toMatchObject({
      kind: 'new-statement',
      needsDueDay: true,
    });

    const [after] = await getAllCards(db);
    expect(after.dueDay).toBe(5);
    expect((await getActionableCycleByCard(db, card.id))?.dueDateISO).toBe(
      '2025-12-05',
    );

    const dec = parsed({
      fileName: 'dec.csv',
      summary: { statementDateISO: '2025-12-13' },
      transactions: [shop(3)],
    });
    const replan = planImport(
      [ok(dec)],
      await getAllCards(db),
      await getAllStatements(db),
    );
    expect(replan[0]).toMatchObject({ needsDueDay: false });
    db.close();
  });
});

describe('#7 a statement with no readable card number', () => {
  it('re-importing the same file finds its card instead of creating another', async () => {
    const db = await openKardabraDb();
    const file = parsed({
      fileName: 'mystery.csv',
      last4: null,
      transactions: [shop(1), shop(2)],
    });
    await importAll(
      db,
      [file],
      input({ nicknames: new Map([['new:mystery.csv', 'Mystery']]) }),
    );
    const { outcomes, result } = await importAll(
      db,
      [file],
      input({ nicknames: new Map() }),
    );

    expect(outcomes[0]).toMatchObject({ kind: 'duplicate', refreshes: true });
    expect(result.cardsCreated).toBe(0);
    expect(await getAllCards(db)).toHaveLength(1);
    db.close();
  });
});

describe('#9 two files for the same card and month in one batch', () => {
  it('writes only the fuller one, whichever order they arrive in', async () => {
    for (const order of [0, 1]) {
      const db = await openKardabraDb();
      const thin = parsed({ fileName: 'thin.csv', transactions: [shop(1)] });
      const full = parsed({
        fileName: 'full.csv',
        transactions: [shop(1), shop(2), shop(3)],
      });
      const files = order === 0 ? [thin, full] : [full, thin];
      const { outcomes, result } = await importAll(db, files);

      expect(result.statementsWritten).toBe(1);
      expect(outcomes.find((o) => o.kind === 'duplicate')).toMatchObject({
        inBatch: true,
      });
      const [stmt] = await getAllStatements(db);
      expect(stmt.txnCount).toBe(3);
      db.close();
      await new Promise<void>((r) => {
        const req = indexedDB.deleteDatabase('kardabra');
        req.onsuccess = () => r();
      });
    }
  });
});

describe('#11 re-imports never lose data', () => {
  it('a thinner, different file for a stored month changes nothing', async () => {
    const db = await openKardabraDb();
    const full = parsed({
      summary: { statementDateISO: '2025-10-13', totalDue: 300, minDue: 30 },
      transactions: [shop(1), shop(2), shop(3)],
    });
    await importAll(db, [full]);
    const [card] = await getAllCards(db);

    const thin = parsed({
      fileName: 'thin.csv',
      summary: { statementDateISO: '2025-10-13' },
      transactions: [shop(1)],
    });
    const { outcomes } = await importAll(db, [thin]);
    expect(outcomes[0]).toMatchObject({
      kind: 'duplicate',
      supersedes: false,
      refreshes: false,
    });

    const cycle = await getActionableCycleByCard(db, card.id);
    expect(cycle).toMatchObject({ totalDue: 300, minDue: 30 });
    db.close();
  });

  it('a superseding file without a summary keeps the stored totals', async () => {
    const db = await openKardabraDb();
    await importAll(db, [
      parsed({
        summary: { statementDateISO: '2025-10-13', totalDue: 300 },
        transactions: [shop(1)],
      }),
    ]);
    const [card] = await getAllCards(db);

    const fuller = parsed({
      fileName: 'fuller.csv',
      summary: { statementDateISO: '2025-10-13' },
      transactions: [shop(1), shop(2)],
    });
    const { outcomes } = await importAll(db, [fuller]);
    expect(outcomes[0]).toMatchObject({ kind: 'duplicate', supersedes: true });

    const [stmt] = await getAllStatements(db);
    expect(stmt).toMatchObject({ txnCount: 2, totalDue: 300 });
    expect((await getActionableCycleByCard(db, card.id))?.totalDue).toBe(300);
    db.close();
  });
});

describe('#14 due day validation', () => {
  it.each([0, 32, -3, 1.5])('rejects %s', async (day) => {
    const db = await openKardabraDb();
    const outcomes = planImport(
      [ok(parsed({ transactions: [shop(1)] }))],
      [],
      [],
    );
    await expect(
      commitImport(db, outcomes, input({ dueDays: new Map([['4321', day]]) })),
    ).rejects.toThrow(/invalid due day/);
    db.close();
  });
});

describe('v2 fields', () => {
  it('stores stable ids that survive a superseding re-import', async () => {
    const db = await openKardabraDb();
    await importAll(db, [parsed({ transactions: [shop(1), shop(2)] })]);
    const [card] = await getAllCards(db);
    const before = await getTransactionsForCard(db, card.id);

    await importAll(db, [
      parsed({
        fileName: 'more.csv',
        transactions: [shop(1), shop(2), shop(3)],
      }),
    ]);
    const after = await getTransactionsForCard(db, card.id);
    expect(after).toHaveLength(3);
    const idOf = (rows: typeof before, payee: string) =>
      rows.find((r) => r.payee === payee)?.id;
    expect(idOf(after, 'SHOP 1')).toBe(idOf(before, 'SHOP 1'));
    expect(idOf(after, 'SHOP 2')).toBe(idOf(before, 'SHOP 2'));
    db.close();
  });

  it('stores currency, fingerprint, skipped rows and balance lines', async () => {
    const db = await openKardabraDb();
    await importAll(db, [
      parsed({
        currency: 'INR',
        summary: {
          statementDateISO: '2025-10-13',
          totalDue: 200,
          openingBalance: 100,
          paymentsTotal: 100,
          purchasesTotal: 200,
          chargesTotal: 0,
        },
        transactions: [shop(1, -200)],
        warnings: [
          { kind: 'skipped-row', row: 7, reason: 'unrecognised date' },
        ],
      }),
    ]);
    const [stmt] = await getAllStatements(db);
    expect(stmt).toMatchObject({
      currency: 'INR',
      skippedRows: 1,
      openingBalance: 100,
      paymentsTotal: 100,
      purchasesTotal: 200,
      chargesTotal: 0,
    });
    expect(stmt.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect((await getAllCards(db))[0].currency).toBe('INR');
    db.close();
  });
});

// Review fix: an identical re-drop and a fuller file for the same month in
// one batch — the fuller one's totals must win regardless of order.
describe('refresh and supersede in one batch', () => {
  it.each([0, 1])('order %i: the fuller file wins', async (order) => {
    const db = await openKardabraDb();
    const old = parsed({
      fileName: 'old.csv',
      summary: { statementDateISO: '2025-10-13', totalDue: 100 },
      transactions: [shop(1)],
    });
    await importAll(db, [old]);
    const [card] = await getAllCards(db);

    const fuller = parsed({
      fileName: 'fuller.csv',
      summary: { statementDateISO: '2025-10-13', totalDue: 250 },
      transactions: [shop(1), shop(2)],
    });
    await importAll(db, order === 0 ? [fuller, old] : [old, fuller]);

    expect((await getActionableCycleByCard(db, card.id))?.totalDue).toBe(250);
    expect((await getAllStatements(db))[0].txnCount).toBe(2);
    db.close();
  });
});

it("a statement's printed due date wins over the card's saved due day", async () => {
  const db = await openKardabraDb();
  await importAll(
    db,
    [parsed({ fileName: 'oct.csv', transactions: [shop(1)] })],
    input({ dueDays: new Map([['4321', 5]]) }),
  );
  const [card] = await getAllCards(db);
  expect(card.dueDay).toBe(5);
  await importAll(db, [
    parsed({
      fileName: 'nov.csv',
      summary: {
        statementDateISO: '2025-11-13',
        paymentDueDateISO: '2025-12-03',
      },
      transactions: [shop(2)],
    }),
  ]);
  expect((await getActionableCycleByCard(db, card.id))?.dueDateISO).toBe(
    '2025-12-03',
  );
  db.close();
});
