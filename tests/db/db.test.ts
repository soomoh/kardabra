import 'fake-indexeddb/auto';
import { beforeEach, describe, it, expect } from 'vitest';
import {
  openKardabraDb,
  getAllCards,
  getCard,
  getCardByLast4,
  putCard,
  getStatement,
  getAllStatements,
  getStatementsForCard,
  putStatementWithTransactions,
  upsertCycle,
  setCyclePaid,
  getActionableCycleByCard,
  getCyclesForCard,
  getAllCycles,
  recomputeCardSpends,
  setPaymentOverride,
  deleteCardCascade,
  getTransactionsForStatement,
  getTransactionsForCard,
  getSetting,
  putSetting,
} from '../../src/db/db';
import type {
  CardRecord,
  StatementRecord,
  TransactionRecord,
} from '../../src/db/schema';

// fake-indexeddb/auto installs a real, in-memory IndexedDB implementation
// as the global `indexedDB` — this exercises the actual db.ts code (real
// object stores, real transactions, real indexes), not a mock standing in
// for one. Each test gets a fresh database: IndexedDB has no "drop
// database" call idb needs help with, so `deleteDatabase` runs before
// every test instead.
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('kardabra');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
});

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: crypto.randomUUID(),
    last4: '2836',
    nickname: 'Regalia',
    createdAt: '2025-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function statement(overrides: Partial<StatementRecord> = {}): StatementRecord {
  return {
    id: crypto.randomUUID(),
    cardId: 'card-1',
    period: '2025-10',
    fileName: 'regalia_oct.csv',
    txnCount: 2,
    importedAt: '2025-11-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('openKardabraDb', () => {
  it('creates all five stores with their indexes', async () => {
    const db = await openKardabraDb();
    expect([...db.objectStoreNames].sort()).toEqual(
      ['cards', 'cycles', 'settings', 'statements', 'transactions'].sort(),
    );

    const tx = db.transaction(
      ['cards', 'statements', 'transactions'],
      'readonly',
    );
    expect([...tx.objectStore('cards').indexNames]).toEqual(['by-last4']);
    expect([...tx.objectStore('statements').indexNames]).toEqual([
      'by-card-period',
    ]);
    expect([...tx.objectStore('transactions').indexNames].sort()).toEqual(
      ['by-card-date', 'by-statement'].sort(),
    );
    await tx.done;
    db.close();
  });
});

describe('cards', () => {
  it('putCard + getAllCards + getCardByLast4 round-trip', async () => {
    const db = await openKardabraDb();
    const regalia = card({ last4: '2836', nickname: 'Regalia' });
    const swiggy = card({
      id: crypto.randomUUID(),
      last4: '7259',
      nickname: 'Swiggy',
    });
    await putCard(db, regalia);
    await putCard(db, swiggy);

    expect(await getAllCards(db)).toHaveLength(2);
    expect(await getCardByLast4(db, '7259')).toEqual(swiggy);
    expect(await getCardByLast4(db, '0000')).toBeUndefined();
    db.close();
  });

  it('getCard finds by id, undefined for a missing id', async () => {
    const db = await openKardabraDb();
    const regalia = card({ last4: '2836', nickname: 'Regalia' });
    await putCard(db, regalia);

    expect(await getCard(db, regalia.id)).toEqual(regalia);
    expect(await getCard(db, 'no-such-id')).toBeUndefined();
    db.close();
  });
});

describe('putStatementWithTransactions — keep-fullest replace', () => {
  it('inserts a statement and its transactions together', async () => {
    const db = await openKardabraDb();
    const s = statement({ txnCount: 2 });
    const txns: TransactionRecord[] = [
      {
        statementId: s.id,
        cardId: s.cardId,
        dateISO: '2025-10-01',
        payee: 'A',
        amount: -100,
      },
      {
        statementId: s.id,
        cardId: s.cardId,
        dateISO: '2025-10-02',
        payee: 'B',
        amount: -200,
      },
    ];
    await putStatementWithTransactions(db, s, txns);

    expect(await getStatement(db, s.cardId, s.period)).toEqual(s);
    expect(await getTransactionsForStatement(db, s.id)).toHaveLength(2);
    db.close();
  });

  it('replacing (cardId, period) deletes the old statement and leaves no orphaned transactions', async () => {
    const db = await openKardabraDb();
    const first = statement({ txnCount: 2 });
    await putStatementWithTransactions(db, first, [
      {
        statementId: first.id,
        cardId: first.cardId,
        dateISO: '2025-10-01',
        payee: 'A',
        amount: -100,
      },
      {
        statementId: first.id,
        cardId: first.cardId,
        dateISO: '2025-10-02',
        payee: 'B',
        amount: -200,
      },
    ]);

    // A doctored re-import for the *same* (cardId, period) with one extra
    // transaction — commitImport calls this again unconditionally when a
    // duplicate outcome supersedes; the replace logic itself lives here.
    const second = statement({
      id: crypto.randomUUID(),
      cardId: first.cardId,
      period: first.period,
      txnCount: 3,
    });
    await putStatementWithTransactions(db, second, [
      {
        statementId: second.id,
        cardId: second.cardId,
        dateISO: '2025-10-01',
        payee: 'A',
        amount: -100,
      },
      {
        statementId: second.id,
        cardId: second.cardId,
        dateISO: '2025-10-02',
        payee: 'B',
        amount: -200,
      },
      {
        statementId: second.id,
        cardId: second.cardId,
        dateISO: '2025-10-03',
        payee: 'C',
        amount: -300,
      },
    ]);

    const stored = await getStatement(db, first.cardId, first.period);
    expect(stored?.id).toBe(second.id);
    expect(stored?.txnCount).toBe(3);

    // Only one statement row exists for this (cardId, period) — the old
    // one was deleted, not left behind as a second row.
    const allStatements = await db.getAll('statements');
    expect(allStatements).toHaveLength(1);

    // The old statement's transactions are gone entirely (no orphans);
    // only the new statement's three remain, findable via the by-statement
    // index that a naive delete-by-key would have missed.
    expect(await getTransactionsForStatement(db, first.id)).toEqual([]);
    expect(await getTransactionsForStatement(db, second.id)).toHaveLength(3);
    const allTxns = await db.getAll('transactions');
    expect(allTxns).toHaveLength(3);
    db.close();
  });
});

describe('getAllStatements / getStatementsForCard', () => {
  it('getAllStatements returns every statement across every card', async () => {
    const db = await openKardabraDb();
    const s1 = statement({ cardId: 'card-1', period: '2025-09' });
    const s2 = statement({
      id: crypto.randomUUID(),
      cardId: 'card-2',
      period: '2025-10',
    });
    await putStatementWithTransactions(db, s1, []);
    await putStatementWithTransactions(db, s2, []);

    expect(await getAllStatements(db)).toHaveLength(2);
    db.close();
  });

  it('getStatementsForCard filters to one card and sorts newest period first', async () => {
    const db = await openKardabraDb();
    const older = statement({ cardId: 'card-1', period: '2025-09' });
    const newer = statement({
      id: crypto.randomUUID(),
      cardId: 'card-1',
      period: '2025-11',
    });
    const otherCard = statement({
      id: crypto.randomUUID(),
      cardId: 'card-2',
      period: '2025-12',
    });
    await putStatementWithTransactions(db, older, []);
    await putStatementWithTransactions(db, newer, []);
    await putStatementWithTransactions(db, otherCard, []);

    const result = await getStatementsForCard(db, 'card-1');
    expect(result.map((s) => s.period)).toEqual(['2025-11', '2025-09']);
    db.close();
  });
});

describe('getTransactionsForCard', () => {
  it('returns every transaction for one card across statements, excludes other cards', async () => {
    const db = await openKardabraDb();
    const s1 = statement({ cardId: 'card-1', period: '2025-09' });
    const s2 = statement({
      id: crypto.randomUUID(),
      cardId: 'card-1',
      period: '2025-10',
    });
    const otherCardStatement = statement({
      id: crypto.randomUUID(),
      cardId: 'card-2',
      period: '2025-10',
    });
    await putStatementWithTransactions(db, s1, [
      {
        statementId: s1.id,
        cardId: 'card-1',
        dateISO: '2025-09-05',
        payee: 'A',
        amount: -100,
      },
    ]);
    await putStatementWithTransactions(db, s2, [
      {
        statementId: s2.id,
        cardId: 'card-1',
        dateISO: '2025-10-05',
        payee: 'B',
        amount: -200,
      },
    ]);
    await putStatementWithTransactions(db, otherCardStatement, [
      {
        statementId: otherCardStatement.id,
        cardId: 'card-2',
        dateISO: '2025-10-05',
        payee: 'C',
        amount: -300,
      },
    ]);

    const result = await getTransactionsForCard(db, 'card-1');
    expect(result.map((t) => t.payee).sort()).toEqual(['A', 'B']);
    db.close();
  });
});

describe('cycles', () => {
  it('upsertCycle preserves an existing paidAt across re-import', async () => {
    const db = await openKardabraDb();
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-10',
      dueDateISO: '2025-11-09',
      source: 'statement',
      totalDue: 7162,
      minDue: 360,
    });
    await setCyclePaid(db, 'card-1', '2025-10', '2025-11-05T10:00:00.000Z');

    // Re-importing recomputes totalDue/dueDateISO from a fresh statement —
    // must not silently un-pay the bill.
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-10',
      dueDateISO: '2025-11-09',
      source: 'statement',
      totalDue: 8000, // corrected amount from a re-download
      minDue: 400,
    });

    const cycle = await db.get('cycles', ['card-1', '2025-10']);
    expect(cycle?.paidAt).toBe('2025-11-05T10:00:00.000Z');
    expect(cycle?.totalDue).toBe(8000);
    db.close();
  });

  it('setCyclePaid(null) clears an existing paidAt; is a no-op for a cycle that does not exist', async () => {
    const db = await openKardabraDb();
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-10',
      dueDateISO: '2025-11-09',
      source: 'statement',
    });
    await setCyclePaid(db, 'card-1', '2025-10', '2025-11-05T00:00:00.000Z');
    await setCyclePaid(db, 'card-1', '2025-10', null);
    expect(
      (await db.get('cycles', ['card-1', '2025-10']))?.paidAt,
    ).toBeUndefined();

    // No cycle exists for card-2 yet — this must not throw.
    await expect(
      setCyclePaid(db, 'card-2', '2025-10', '2025-11-05T00:00:00.000Z'),
    ).resolves.toBeUndefined();
    db.close();
  });

  it('getActionableCycleByCard returns the latest (actionable) cycle per the settled-by-successor rule', async () => {
    const db = await openKardabraDb();
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-09',
      dueDateISO: null,
      source: 'statement',
    });
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-11',
      dueDateISO: null,
      source: 'statement',
    });
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-10',
      dueDateISO: null,
      source: 'statement',
    });
    await upsertCycle(db, {
      cardId: 'card-2',
      period: '2025-12',
      dueDateISO: null,
      source: 'statement',
    });

    expect((await getActionableCycleByCard(db, 'card-1'))?.period).toBe(
      '2025-11',
    );
    expect(await getActionableCycleByCard(db, 'no-such-card')).toBeNull();
    db.close();
  });

  it("getCyclesForCard returns only that card's cycles", async () => {
    const db = await openKardabraDb();
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-09',
      dueDateISO: null,
      source: 'statement',
    });
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-10',
      dueDateISO: null,
      source: 'statement',
    });
    await upsertCycle(db, {
      cardId: 'card-2',
      period: '2025-10',
      dueDateISO: null,
      source: 'statement',
    });

    const forCard1 = await getCyclesForCard(db, 'card-1');
    expect(forCard1.map((c) => c.period).sort()).toEqual([
      '2025-09',
      '2025-10',
    ]);
    expect(await getCyclesForCard(db, 'no-such-card')).toEqual([]);
    db.close();
  });

  it('getAllCycles returns every cycle across every card', async () => {
    const db = await openKardabraDb();
    await upsertCycle(db, {
      cardId: 'card-1',
      period: '2025-10',
      dueDateISO: null,
      source: 'statement',
    });
    await upsertCycle(db, {
      cardId: 'card-2',
      period: '2025-11',
      dueDateISO: null,
      source: 'statement',
    });
    expect(await getAllCycles(db)).toHaveLength(2);
    db.close();
  });
});

describe('recomputeCardSpends / setPaymentOverride — override round-trip', () => {
  // One statement, four transactions: two debits, and two credits shaped
  // so the auto-detection ladder (no keyword, no prior due — single
  // statement) falls to rung 4 (largest credit) and picks BIG CREDIT as
  // the "payment", netting SMALL CREDIT in as an ordinary adjustment.
  async function seedOneStatementCard(
    db: Awaited<ReturnType<typeof openKardabraDb>>,
  ) {
    const cardId = 'card-1';
    await putCard(db, {
      id: cardId,
      last4: '2836',
      nickname: 'Regalia',
      createdAt: '2025-11-01T00:00:00.000Z',
    });
    const s = statement({ cardId, period: '2025-10', txnCount: 4 });
    await putStatementWithTransactions(db, s, [
      {
        statementId: s.id,
        cardId,
        dateISO: '2025-10-01',
        payee: 'GROCERY',
        amount: -1000,
      },
      {
        statementId: s.id,
        cardId,
        dateISO: '2025-10-02',
        payee: 'FUEL',
        amount: -500,
      },
      {
        statementId: s.id,
        cardId,
        dateISO: '2025-10-03',
        payee: 'BIG CREDIT',
        amount: 5000,
      },
      {
        statementId: s.id,
        cardId,
        dateISO: '2025-10-04',
        payee: 'SMALL CREDIT',
        amount: 200,
      },
    ]);
    await upsertCycle(db, {
      cardId,
      period: '2025-10',
      dueDateISO: null,
      source: 'statement',
    });
    return cardId;
  }

  it('recomputeCardSpends computes the auto-detected spend (largest-credit fallback)', async () => {
    const db = await openKardabraDb();
    const cardId = await seedOneStatementCard(db);
    await recomputeCardSpends(db, cardId);

    // debits 1500, minus the 200 SMALL CREDIT (BIG CREDIT excluded as
    // the auto-picked "payment" — no keyword, no prior bill to match).
    const cycle = await db.get('cycles', [cardId, '2025-10']);
    expect(cycle?.spend).toBe(1300);
    db.close();
  });

  it('setPaymentOverride marks a different row as the payment and recomputes spend', async () => {
    const db = await openKardabraDb();
    const cardId = await seedOneStatementCard(db);
    await recomputeCardSpends(db, cardId);

    // The user corrects it: SMALL CREDIT (200) is the real payment, not
    // BIG CREDIT — so BIG CREDIT (5000) now nets in as an ordinary credit.
    await setPaymentOverride(db, cardId, '2025-10', [
      { amount: 200, payee: 'SMALL CREDIT' },
    ]);

    const cycle = await db.get('cycles', [cardId, '2025-10']);
    expect(cycle?.paymentOverride).toEqual([
      { amount: 200, payee: 'SMALL CREDIT' },
    ]);
    // debits 1500, minus the 5000 BIG CREDIT (now not the payment).
    expect(cycle?.spend).toBe(1500 - 5000);
    db.close();
  });

  it('setPaymentOverride(undefined) resets to automatic and restores the auto-detected spend', async () => {
    const db = await openKardabraDb();
    const cardId = await seedOneStatementCard(db);
    await recomputeCardSpends(db, cardId);
    await setPaymentOverride(db, cardId, '2025-10', [
      { amount: 200, payee: 'SMALL CREDIT' },
    ]);

    await setPaymentOverride(db, cardId, '2025-10', undefined);

    const cycle = await db.get('cycles', [cardId, '2025-10']);
    expect(cycle?.paymentOverride).toBeUndefined();
    expect(cycle?.spend).toBe(1300); // back to the largest-credit fallback
    db.close();
  });

  it('an empty override array asserts "no payment at all" — every credit nets in', async () => {
    const db = await openKardabraDb();
    const cardId = await seedOneStatementCard(db);
    await recomputeCardSpends(db, cardId);

    await setPaymentOverride(db, cardId, '2025-10', []);

    const cycle = await db.get('cycles', [cardId, '2025-10']);
    // debits 1500, minus BOTH credits (5000 + 200) — nothing excluded.
    expect(cycle?.spend).toBe(1500 - 5000 - 200);
    db.close();
  });

  it('setPaymentOverride is a no-op when the cycle does not exist yet', async () => {
    const db = await openKardabraDb();
    await expect(
      setPaymentOverride(db, 'no-such-card', '2025-10', []),
    ).resolves.toBeUndefined();
    expect(await db.get('cycles', ['no-such-card', '2025-10'])).toBeUndefined();
    db.close();
  });
});

describe('settings', () => {
  it('putSetting + getSetting round-trip, and undefined for a missing key', async () => {
    const db = await openKardabraDb();
    await putSetting(db, 'syncUrl', 'https://example.com/sync');
    expect(await getSetting(db, 'syncUrl')).toBe('https://example.com/sync');
    expect(await getSetting(db, 'missing')).toBeUndefined();
    db.close();
  });
});

describe('deleteCardCascade', () => {
  it('removes the card, its statements, transactions and cycles — and nothing belonging to other cards', async () => {
    const db = await openKardabraDb();

    // Two cards, each with a statement + transactions + a cycle.
    const keep = card({ id: 'card-keep', last4: '1111', nickname: 'Keep' });
    const gone = card({ id: 'card-gone', last4: '2222', nickname: 'Gone' });
    await putCard(db, keep);
    await putCard(db, gone);

    for (const c of [keep, gone]) {
      const s = statement({
        id: `stmt-${c.id}`,
        cardId: c.id,
        period: '2025-10',
      });
      await putStatementWithTransactions(db, s, [
        {
          statementId: s.id,
          cardId: c.id,
          dateISO: '2025-10-01',
          payee: 'A',
          amount: -100,
        },
      ]);
      await upsertCycle(db, {
        cardId: c.id,
        period: '2025-10',
        dueDateISO: '2025-11-09',
        source: 'statement',
      });
    }

    await deleteCardCascade(db, gone.id);

    // The deleted card's data is fully gone...
    expect(await getCard(db, gone.id)).toBeUndefined();
    expect(await getStatementsForCard(db, gone.id)).toEqual([]);
    expect(await getTransactionsForCard(db, gone.id)).toEqual([]);
    expect(await getActionableCycleByCard(db, gone.id)).toBeNull();

    // ...and the other card's is untouched (the cascade must be scoped,
    // not a table wipe).
    expect(await getCard(db, keep.id)).toBeDefined();
    expect(await getStatementsForCard(db, keep.id)).toHaveLength(1);
    expect(await getTransactionsForCard(db, keep.id)).toHaveLength(1);
    expect((await getActionableCycleByCard(db, keep.id))?.period).toBe(
      '2025-10',
    );
    db.close();
  });
});
