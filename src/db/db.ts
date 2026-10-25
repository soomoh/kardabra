/**
 * Kardabra's IndexedDB: opening and upgrading it, and one small function per
 * query or write, named for what it touches. `idb` only makes the requests
 * awaitable; stores, indexes and transactions are used directly.
 */

import { openDB, type IDBPDatabase } from 'idb';
import { actionableCycle } from '../lib/cycles';
import { cardIdKey, statementFingerprint, transactionIds } from '../lib/txnId';
import {
  identifyPaymentIndices,
  netSpend,
  expectedDue,
  type PaymentMark,
} from '../lib/spend';
import type {
  KardabraSchema,
  CardRecord,
  StatementRecord,
  TransactionRecord,
  CycleRecord,
} from './schema';

const DB_NAME = 'kardabra';
const DB_VERSION = 2;

/** What the app needs to hear about while the database is open. */
export interface DbLifecycle {
  /** An older version is open in another tab and is holding up the upgrade. */
  onBlocked?: () => void;
  /** A newer version of the app wants to upgrade the database; this
   * connection has been closed and the page must reload. */
  onVersionChange?: () => void;
}

/** Open (creating or upgrading as needed) the database. Each schema version
 * is one step in `upgrade`, run only for versions the stored database is
 * behind — so a v1 user upgrades in place and a new user runs every step. */
export function openKardabraDb(
  lifecycle: DbLifecycle = {},
): Promise<IDBPDatabase<KardabraSchema>> {
  return openDB<KardabraSchema>(DB_NAME, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const cards = db.createObjectStore('cards', { keyPath: 'id' });
        cards.createIndex('by-last4', 'last4');
        const statements = db.createObjectStore('statements', {
          keyPath: 'id',
        });
        // unique: putStatementWithTransactions replaces "the" statement for
        // a (cardId, period), so there must never be two.
        statements.createIndex('by-card-period', ['cardId', 'period'], {
          unique: true,
        });
        const transactions = db.createObjectStore('transactions', {
          autoIncrement: true,
        });
        transactions.createIndex('by-statement', 'statementId');
        transactions.createIndex('by-card-date', ['cardId', 'dateISO']);
        db.createObjectStore('cycles', { keyPath: ['cardId', 'period'] });
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        // Stable transaction ids. Existing rows are backfilled per statement
        // in key order — the order they were written in, i.e. statement order
        // — so the ids match what a re-import would produce. Only IDB
        // requests are awaited here (txnId is synchronous), which keeps the
        // upgrade transaction alive.
        const transactions = tx.objectStore('transactions');
        transactions.createIndex('by-id', 'id');
        const cards = new Map(
          (await tx.objectStore('cards').getAll()).map((c) => [c.id, c]),
        );
        const byStatement = new Map<
          string,
          { key: number; value: TransactionRecord }[]
        >();
        let cursor = await transactions.openCursor();
        while (cursor) {
          const rows = byStatement.get(cursor.value.statementId) ?? [];
          rows.push({ key: cursor.primaryKey, value: cursor.value });
          byStatement.set(cursor.value.statementId, rows);
          cursor = await cursor.continue();
        }
        const statements = tx.objectStore('statements');
        for (const [statementId, rows] of byStatement) {
          const card = cards.get(rows[0].value.cardId);
          const key = card ? cardIdKey(card) : rows[0].value.cardId;
          const values = rows.map((r) => r.value);
          const ids = transactionIds(key, values);
          for (const [i, row] of rows.entries()) {
            await transactions.put({ ...row.value, id: ids[i] }, row.key);
          }
          const statement = await statements.get(statementId);
          if (statement !== undefined) {
            await statements.put({
              ...statement,
              fingerprint: statementFingerprint(values),
            });
          }
        }
      }
    },
    blocked() {
      lifecycle.onBlocked?.();
    },
    blocking() {
      lifecycle.onVersionChange?.();
    },
  }).then((db) => {
    // Close as soon as another tab asks, so its upgrade isn't stuck behind us.
    db.addEventListener('versionchange', () => db.close());
    return db;
  });
}

export async function getAllCards(
  db: IDBPDatabase<KardabraSchema>,
): Promise<CardRecord[]> {
  return db.getAll('cards');
}

export async function getCard(
  db: IDBPDatabase<KardabraSchema>,
  id: string,
): Promise<CardRecord | undefined> {
  return db.get('cards', id);
}

export async function putCard(
  db: IDBPDatabase<KardabraSchema>,
  card: CardRecord,
): Promise<void> {
  await db.put('cards', card);
}

export async function getStatement(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
  period: string,
): Promise<StatementRecord | undefined> {
  return db.getFromIndex('statements', 'by-card-period', [cardId, period]);
}

/** Every statement on every card — planImport's duplicate snapshot. */
export async function getAllStatements(
  db: IDBPDatabase<KardabraSchema>,
): Promise<StatementRecord[]> {
  return db.getAll('statements');
}

/** One card's statements, newest first. A filtered scan: per-card lists are
 * small, so no extra index. */
export async function getStatementsForCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<StatementRecord[]> {
  const all = await db.getAll('statements');
  return all
    .filter((statement) => statement.cardId === cardId)
    .sort((a, b) => b.period.localeCompare(a.period));
}

/** Write a statement and its transactions, replacing any statement for the
 * same (card, period) and all of its transactions, in one IndexedDB
 * transaction — a failure leaves the old state or the new, never orphans. */
export async function putStatementWithTransactions(
  db: IDBPDatabase<KardabraSchema>,
  statement: StatementRecord,
  txns: TransactionRecord[],
): Promise<void> {
  const tx = db.transaction(['statements', 'transactions'], 'readwrite');
  const statements = tx.objectStore('statements');
  const transactions = tx.objectStore('transactions');

  const existing = await statements
    .index('by-card-period')
    .get([statement.cardId, statement.period]);
  if (existing !== undefined) {
    const staleKeys = await transactions
      .index('by-statement')
      .getAllKeys(existing.id);
    await Promise.all(staleKeys.map((key) => transactions.delete(key)));
    await statements.delete(existing.id);
  }

  await statements.put(statement);
  await Promise.all(txns.map((txn) => transactions.add(txn)));

  await tx.done;
}

/**
 * Insert or update a cycle, keeping its `paidAt` and `paymentOverride`.
 * Those are the user's facts, not the statement's: a re-import must never
 * un-pay a bill or drop a manual payment fix. The `spend` written here is
 * provisional; commitImport's recomputeCardSpends pass finalises it.
 */
export async function upsertCycle(
  db: IDBPDatabase<KardabraSchema>,
  cycle: CycleRecord,
): Promise<void> {
  const existing = await db.get('cycles', [cycle.cardId, cycle.period]);
  const paidAt = existing?.paidAt ?? cycle.paidAt;
  const paymentOverride = existing?.paymentOverride ?? cycle.paymentOverride;
  const merged: CycleRecord = { ...cycle, paidAt };
  if (paymentOverride !== undefined) merged.paymentOverride = paymentOverride;
  await db.put('cycles', merged);
}

/** One card's cycles, in no particular order. */
export async function getCyclesForCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<CycleRecord[]> {
  const all = await db.getAll('cycles');
  return all.filter((cycle) => cycle.cardId === cardId);
}

export async function getAllCycles(
  db: IDBPDatabase<KardabraSchema>,
): Promise<CycleRecord[]> {
  return db.getAll('cycles');
}

/**
 * Recompute and store `spend` for each of a card's cycles — the only writer
 * of the final value, so it is right whatever order statements arrived in.
 *
 * Oldest first: a statement's priorExpectedDue (the amount-match rung) may be
 * the previous statement's spend, so that spend must already be recomputed.
 * A statement with no cycle row is skipped.
 */
export async function recomputeCardSpends(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<void> {
  const statements = (await getStatementsForCard(db, cardId))
    .slice()
    .sort((a, b) => a.period.localeCompare(b.period));

  let priorExpectedDue: number | null = null;
  for (const statement of statements) {
    const cycle = await db.get('cycles', [cardId, statement.period]);
    if (cycle === undefined) continue;

    const txns = await getTransactionsForStatement(db, statement.id);
    const paymentIndices = identifyPaymentIndices(txns, {
      priorExpectedDue,
      override: cycle.paymentOverride,
    });
    const spend = netSpend(txns, paymentIndices);
    await db.put('cycles', { ...cycle, spend });

    priorExpectedDue = expectedDue(statement.totalDue, spend);
  }
}

/** Set a cycle's payment override (undefined returns it to auto-detection)
 * and recompute the card's spends. No-op if the cycle doesn't exist. */
export async function setPaymentOverride(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
  period: string,
  override: PaymentMark[] | undefined,
): Promise<void> {
  const existing = await db.get('cycles', [cardId, period]);
  if (existing === undefined) return;

  const updated: CycleRecord = { ...existing };
  if (override === undefined) {
    delete updated.paymentOverride;
  } else {
    updated.paymentOverride = override;
  }
  await db.put('cycles', updated);

  await recomputeCardSpends(db, cardId);
}

/** Mark a cycle paid, or unpaid with `null` (not undefined, which reads as
 * an omitted argument). No-op if the cycle doesn't exist. */
export async function setCyclePaid(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
  period: string,
  paidAt: string | null,
): Promise<void> {
  const existing = await db.get('cycles', [cardId, period]);
  if (existing === undefined) return;
  await db.put('cycles', { ...existing, paidAt: paidAt ?? undefined });
}

/** The card's actionable cycle (lib/cycles.ts), or null. */
export async function getActionableCycleByCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<CycleRecord | null> {
  const forCard = (await db.getAll('cycles')).filter(
    (cycle) => cycle.cardId === cardId,
  );
  return actionableCycle(forCard);
}

/** Every transaction on every card (for the Phase 5 backup). */
export async function getAllTransactions(
  db: IDBPDatabase<KardabraSchema>,
): Promise<TransactionRecord[]> {
  return db.getAll('transactions');
}

export async function getTransactionsForStatement(
  db: IDBPDatabase<KardabraSchema>,
  statementId: string,
): Promise<TransactionRecord[]> {
  return db.getAllFromIndex('transactions', 'by-statement', statementId);
}

/** Every transaction on one card, in one by-card-date range query. */
export async function getTransactionsForCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<TransactionRecord[]> {
  // '\uffff' sorts after any real date string.
  const range = IDBKeyRange.bound([cardId, ''], [cardId, '￿']);
  return db.getAllFromIndex('transactions', 'by-card-date', range);
}

export async function getSetting(
  db: IDBPDatabase<KardabraSchema>,
  key: string,
): Promise<unknown> {
  return (await db.get('settings', key))?.value;
}

export async function putSetting(
  db: IDBPDatabase<KardabraSchema>,
  key: string,
  value: unknown,
): Promise<void> {
  await db.put('settings', { key, value });
}

/** Delete a card with all its statements, transactions and cycles in one
 * IndexedDB transaction (no foreign keys to cascade for us). Total on
 * purpose: the user asked for this card's data to be gone. */
export async function deleteCardCascade(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<void> {
  const tx = db.transaction(
    ['cards', 'statements', 'transactions', 'cycles'],
    'readwrite',
  );

  // [cardId, ''] .. [cardId, '\uffff'] covers every row of this card on each
  // compound key or index.
  const cardRange = IDBKeyRange.bound([cardId, ''], [cardId, '￿']);

  const statementKeys = await tx
    .objectStore('statements')
    .index('by-card-period')
    .getAllKeys(cardRange);
  for (const key of statementKeys) {
    await tx.objectStore('statements').delete(key);
  }

  const txnKeys = await tx
    .objectStore('transactions')
    .index('by-card-date')
    .getAllKeys(cardRange);
  for (const key of txnKeys) {
    await tx.objectStore('transactions').delete(key);
  }

  const cycleKeys = await tx.objectStore('cycles').getAllKeys(cardRange);
  for (const key of cycleKeys) {
    await tx.objectStore('cycles').delete(key);
  }

  await tx.objectStore('cards').delete(cardId);
  await tx.done;
}
