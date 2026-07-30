/**
 * The two-phase import: planImport decides what would happen per file (pure, no
 * database), commitImport writes it. The catastrophic failures to guard against
 * are a bill payment counted as spend (overstating what a cycle cost) and a
 * user's "paid" mark or manual payment pick being silently wiped by a re-import.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  planImport,
  commitImport,
  type ParseResult,
  type CommitUserInput,
} from '../../src/import/plan';
import {
  openKardabraDb,
  getAllCards,
  getAllStatements,
  getActionableCycleByCard,
  setCyclePaid,
} from '../../src/db/db';
import { StatementError, type ParsedStatement } from '../../src/parser';

function parsed(over: Partial<ParsedStatement>): ParsedStatement {
  return {
    fileName: over.fileName ?? 'stmt.csv',
    last4: 'last4' in over ? (over.last4 as string | null) : null,
    summary: over.summary ?? {},
    transactions: over.transactions ?? [],
  };
}

function ok(p: ParsedStatement): ParseResult {
  return { fileName: p.fileName, parsed: p };
}

describe('planImport — pure planning, no writes', () => {
  it('plans a new statement for an unseen card and asks for its nickname', () => {
    const p = parsed({
      fileName: 'oct.csv',
      last4: '4321',
      summary: {
        statementDateISO: '2025-10-13',
        paymentDueDateISO: '2025-11-02',
      },
      transactions: [{ dateISO: '2025-09-20', payee: 'SHOP', amount: -100 }],
    });
    const [outcome] = planImport([ok(p)], [], []);
    expect(outcome.kind).toBe('new-statement');
    if (outcome.kind !== 'new-statement') return;
    expect(outcome.period).toBe('2025-10');
    expect(outcome.cardRef).toEqual({
      kind: 'new',
      last4: '4321',
      suggestedNickname: 'Card ····4321',
    });
    // Due date came from the statement itself, so no need to ask the user.
    expect(outcome.needsDueDay).toBe(false);
  });

  it('flags needsDueDay only when neither statement nor card supplies one', () => {
    const noDue = parsed({
      last4: '4321',
      summary: { statementDateISO: '2025-10-13' },
    });
    const [out] = planImport([ok(noDue)], [], []);
    expect(out.kind === 'new-statement' && out.needsDueDay).toBe(true);
  });

  it("prefers the statement's own date over transaction dates for the period", () => {
    // Statement dated end-October covering late-September transactions belongs
    // to the October cycle by the bank's accounting, not September.
    const p = parsed({
      summary: { statementDateISO: '2025-10-31' },
      transactions: [{ dateISO: '2025-09-24', payee: 'X', amount: -1 }],
    });
    const [out] = planImport([ok(p)], [], []);
    expect(out.kind === 'new-statement' && out.period).toBe('2025-10');
  });

  it('falls back to the latest transaction date when no statement date exists', () => {
    const p = parsed({
      transactions: [
        { dateISO: '2025-09-02', payee: 'A', amount: -1 },
        { dateISO: '2025-09-28', payee: 'B', amount: -1 },
      ],
    });
    const [out] = planImport([ok(p)], [], []);
    expect(out.kind === 'new-statement' && out.period).toBe('2025-09');
  });

  it('fails a file with no statement date and no transactions', () => {
    const [out] = planImport([ok(parsed({ fileName: 'empty.csv' }))], [], []);
    expect(out.kind).toBe('failed');
  });

  it('dedupes two files for the same new card to a single shared CardRef', () => {
    const a = parsed({
      fileName: 'a.csv',
      last4: '9999',
      summary: { statementDateISO: '2025-09-30' },
    });
    const b = parsed({
      fileName: 'b.csv',
      last4: '9999',
      summary: { statementDateISO: '2025-10-31' },
    });
    const [oa, ob] = planImport([ok(a), ok(b)], [], []);
    // Same object reference => the UI asks for one nickname, not two.
    if (oa.kind !== 'new-statement' || ob.kind !== 'new-statement')
      throw new Error('expected new');
    expect(oa.cardRef).toBe(ob.cardRef);
  });

  it('never merges cards with an unrecoverable (null) last4', () => {
    const a = parsed({
      fileName: 'a.csv',
      last4: null,
      summary: { statementDateISO: '2025-09-30' },
    });
    const b = parsed({
      fileName: 'b.csv',
      last4: null,
      summary: { statementDateISO: '2025-10-31' },
    });
    const [oa, ob] = planImport([ok(a), ok(b)], [], []);
    if (oa.kind !== 'new-statement' || ob.kind !== 'new-statement')
      throw new Error('expected new');
    expect(oa.cardRef).not.toBe(ob.cardRef);
  });

  it('supersedes an existing statement only when the re-import has strictly more rows', () => {
    const card = {
      id: 'c1',
      last4: '4321',
      nickname: 'Card',
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    const existing = {
      id: 's1',
      cardId: 'c1',
      period: '2025-10',
      fileName: 'old.csv',
      txnCount: 3,
      importedAt: '2025-10-15T00:00:00.000Z',
    };
    const threeRows = parsed({
      last4: '4321',
      summary: { statementDateISO: '2025-10-13' },
      transactions: Array(3).fill({
        dateISO: '2025-09-20',
        payee: 'X',
        amount: -1,
      }),
    });
    const fiveRows = parsed({
      last4: '4321',
      summary: { statementDateISO: '2025-10-13' },
      transactions: Array(5).fill({
        dateISO: '2025-09-20',
        payee: 'X',
        amount: -1,
      }),
    });

    const [same] = planImport([ok(threeRows)], [card], [existing]);
    expect(same.kind === 'duplicate' && same.supersedes).toBe(false);
    const [more] = planImport([ok(fiveRows)], [card], [existing]);
    expect(more.kind === 'duplicate' && more.supersedes).toBe(true);
  });

  it('reports a StatementError as a rejection with its kind and advice', () => {
    const err: ParseResult = {
      fileName: 'savings.csv',
      error: new StatementError(
        'savings-statement',
        'bank account',
        'use a card statement',
      ),
    };
    const [out] = planImport([err], [], []);
    expect(out).toMatchObject({
      kind: 'rejected',
      errorKind: 'savings-statement',
      advice: 'use a card statement',
    });
  });

  it('contains an unexpected error as a per-file failure, not a thrown batch abort', () => {
    const boom: ParseResult = {
      fileName: 'weird.csv',
      error: new Error('boom'),
    };
    const [out] = planImport([boom], [], []);
    expect(out).toMatchObject({
      kind: 'failed',
      fileName: 'weird.csv',
      message: 'boom',
    });
  });
});

describe('commitImport — writes, and preserves user facts across re-import', () => {
  beforeEach(async () => {
    // Each test gets a fresh database — IndexedDB has no "drop database", so
    // delete it before every test.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('kardabra');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  const withPayment = parsed({
    fileName: 'oct.csv',
    last4: '4321',
    summary: {
      statementDateISO: '2025-10-13',
      paymentDueDateISO: '2025-11-02',
      totalDue: 5000,
    },
    transactions: [
      { dateISO: '2025-09-20', payee: 'GROCERY SHOP', amount: -1000 },
      { dateISO: '2025-09-22', payee: 'BPPY CC PAYMENT', amount: 5000 },
    ],
  });
  const input: CommitUserInput = {
    nicknames: new Map([['4321', 'My Card']]),
    dueDays: new Map(),
  };

  it('creates the card and excludes the identified bill payment from spend', async () => {
    const db = await openKardabraDb();
    const outcomes = planImport([ok(withPayment)], [], []);
    const result = await commitImport(db, outcomes, input);

    expect(result).toMatchObject({ cardsCreated: 1, statementsWritten: 1 });
    const [card] = await getAllCards(db);
    expect(card.nickname).toBe('My Card');
    const cycle = await getActionableCycleByCard(db, card.id);
    // Debit 1000 counts; the 5000 payment does not. Spend is 1000, not 6000/−4000.
    expect(cycle?.spend).toBe(1000);
    db.close();
  });

  it('keeps a paid mark when the same statement is re-imported', async () => {
    const db = await openKardabraDb();
    await commitImport(db, planImport([ok(withPayment)], [], []), input);
    const [card] = await getAllCards(db);
    await setCyclePaid(db, card.id, '2025-10', '2025-11-01T00:00:00.000Z');

    // Re-import the identical file: a non-superseding duplicate.
    const cards = await getAllCards(db);
    const statements = await getAllStatements(db);
    const dupOutcomes = planImport([ok(withPayment)], cards, statements);
    expect(dupOutcomes[0].kind).toBe('duplicate');
    await commitImport(db, dupOutcomes, input);

    const cycle = await getActionableCycleByCard(db, card.id);
    expect(cycle?.paidAt).toBe('2025-11-01T00:00:00.000Z');
    db.close();
  });
});
