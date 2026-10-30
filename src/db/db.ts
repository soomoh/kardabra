/**
 * Kardabra's IndexedDB: opening and upgrading it, and one small function per
 * query or write, named for what it touches. `idb` only makes the requests
 * awaitable; stores, indexes and transactions are used directly.
 */

import { openDB, type IDBPDatabase } from 'idb';
import { actionableCycle } from '../lib/cycles';
import { cycleDueDateISO, isValidDueDay, previousPeriod } from '../lib/dates';
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
  PdfPasswordRecord,
  StoredData,
} from './schema';

const DB_NAME = 'kardabra';
const DB_VERSION = 3;

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
      if (oldVersion < 3) {
        db.createObjectStore('pdfPasswords', { keyPath: 'cardId' });
        db.createObjectStore('keys', { keyPath: 'name' });
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
  let priorPeriod: string | null = null;
  for (const statement of statements) {
    // Only the previous month's bill is what this payment paid; across a
    // missing month there's nothing reliable to match against.
    if (priorPeriod !== previousPeriod(statement.period))
      priorExpectedDue = null;
    priorPeriod = statement.period;
    const cycle = await db.get('cycles', [cardId, statement.period]);
    if (cycle === undefined) {
      priorExpectedDue = null;
      continue;
    }

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

/** Store `value` under `key` unless something is already there, and return
 * whichever value is stored (same race rule as putKeyIfAbsent). */
export async function putSettingIfAbsent(
  db: IDBPDatabase<KardabraSchema>,
  key: string,
  value: unknown,
): Promise<unknown> {
  const tx = db.transaction('settings', 'readwrite');
  const existing = await tx.store.get(key);
  if (existing === undefined) await tx.store.put({ key, value });
  await tx.done;
  return existing === undefined ? value : existing.value;
}

/** Change a card's due day and re-project the due dates that came from it
 * (statements that printed none); printed dates stay. One transaction, so
 * the card and its bills never disagree. No-op for a missing card. */
export async function setCardDueDay(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
  dueDay: number,
): Promise<void> {
  // The UI validates first; a bad day here is a programmer's mistake.
  if (!isValidDueDay(dueDay)) throw new RangeError(`Invalid due day ${dueDay}`);
  const tx = db.transaction(
    ['cards', 'statements', 'transactions', 'cycles'],
    'readwrite',
  );
  const card = await tx.objectStore('cards').get(cardId);
  if (card === undefined) {
    await tx.done;
    return;
  }
  await tx.objectStore('cards').put({ ...card, dueDay });

  const cardRange = IDBKeyRange.bound([cardId, ''], [cardId, '\uffff']);
  const statements = await tx
    .objectStore('statements')
    .index('by-card-period')
    .getAll(cardRange);
  for (const statement of statements) {
    if (statement.dueDateISO !== undefined) continue;
    const cycle = await tx
      .objectStore('cycles')
      .get([cardId, statement.period]);
    if (cycle === undefined) continue;
    let anchorISO = statement.statementDateISO ?? null;
    if (anchorISO === null) {
      const txns = await tx
        .objectStore('transactions')
        .index('by-statement')
        .getAll(statement.id);
      for (const txn of txns) {
        if (anchorISO === null || txn.dateISO > anchorISO)
          anchorISO = txn.dateISO;
      }
    }
    await tx.objectStore('cycles').put({
      ...cycle,
      dueDateISO: cycleDueDateISO(undefined, anchorISO, dueDay),
    });
  }
  await tx.done;
}

/** Delete a card with all its statements, transactions and cycles in one
 * IndexedDB transaction (no foreign keys to cascade for us). Total on
 * purpose: the user asked for this card's data to be gone. */
export async function deleteCardCascade(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<void> {
  const tx = db.transaction(
    ['cards', 'statements', 'transactions', 'cycles', 'pdfPasswords'],
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

  await tx.objectStore('pdfPasswords').delete(cardId);
  await tx.objectStore('cards').delete(cardId);
  await tx.done;
}

/** Remove from a stored statement (an export) the transactions that match
 * `rows` on date and amount — each row at most once — in one transaction.
 * Its other rows stay; emptied, it goes with its month's cycle. Returns
 * how many rows were removed. No-op if the statement is gone. */
export async function removeMatchingTransactions(
  db: IDBPDatabase<KardabraSchema>,
  statementId: string,
  rows: readonly { dateISO: string; amount: number }[],
): Promise<number> {
  const tx = db.transaction(
    ['statements', 'transactions', 'cycles'],
    'readwrite',
  );
  const statement = await tx.objectStore('statements').get(statementId);
  if (statement === undefined) {
    await tx.done;
    return 0;
  }
  const wanted = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.dateISO}|${r.amount}`;
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }
  const index = tx.objectStore('transactions').index('by-statement');
  const kept: TransactionRecord[] = [];
  let removed = 0;
  let cursor = await index.openCursor(statementId);
  while (cursor) {
    const key = `${cursor.value.dateISO}|${cursor.value.amount}`;
    const left = wanted.get(key) ?? 0;
    if (left > 0) {
      wanted.set(key, left - 1);
      await cursor.delete();
      removed++;
    } else {
      kept.push(cursor.value);
    }
    cursor = await cursor.continue();
  }
  if (kept.length === 0) {
    await tx.objectStore('cycles').delete([statement.cardId, statement.period]);
    await tx.objectStore('statements').delete(statementId);
  } else if (removed > 0) {
    await tx.objectStore('statements').put({
      ...statement,
      txnCount: kept.length,
      fingerprint: statementFingerprint(kept),
    });
  }
  await tx.done;
  return removed;
}

/** Every remembered PDF password (still encrypted), one per card. */
export async function getAllPdfPasswords(
  db: IDBPDatabase<KardabraSchema>,
): Promise<PdfPasswordRecord[]> {
  return db.getAll('pdfPasswords');
}

export async function putPdfPassword(
  db: IDBPDatabase<KardabraSchema>,
  record: PdfPasswordRecord,
): Promise<void> {
  await db.put('pdfPasswords', record);
}

export async function getKey(
  db: IDBPDatabase<KardabraSchema>,
  name: string,
): Promise<CryptoKey | undefined> {
  return (await db.get('keys', name))?.key;
}

/** Store `candidate` under `name` unless a key is already there, and return
 * whichever key is stored. Generating happens before this call (WebCrypto
 * can't run inside an IndexedDB transaction), so two tabs racing both
 * end up with the first key written, never two keys. */
export async function putKeyIfAbsent(
  db: IDBPDatabase<KardabraSchema>,
  name: string,
  candidate: CryptoKey,
): Promise<CryptoKey> {
  const tx = db.transaction('keys', 'readwrite');
  const existing = await tx.store.get(name);
  if (existing === undefined) await tx.store.put({ name, key: candidate });
  await tx.done;
  return existing?.key ?? candidate;
}

/** Forget every remembered PDF password and the key that sealed them, in
 * one transaction. Without the key, a record a racing import writes
 * afterwards can't be opened either (loadSavedPasswords passes it over). */
export async function clearPdfPasswords(
  db: IDBPDatabase<KardabraSchema>,
  keyName: string,
): Promise<void> {
  const tx = db.transaction(['pdfPasswords', 'keys'], 'readwrite');
  await tx.objectStore('pdfPasswords').clear();
  await tx.objectStore('keys').delete(keyName);
  await tx.done;
}

/** How much the user has stored, for the Your data page. */
export async function countStoredData(db: IDBPDatabase<KardabraSchema>) {
  const tx = db.transaction(
    ['cards', 'statements', 'transactions', 'pdfPasswords'],
    'readonly',
  );
  const [cards, statements, transactions, savedPasswords] = await Promise.all([
    tx.objectStore('cards').count(),
    tx.objectStore('statements').count(),
    tx.objectStore('transactions').count(),
    tx.objectStore('pdfPasswords').count(),
  ]);
  await tx.done;
  return { cards, statements, transactions, savedPasswords };
}

/** Empty every store — data, settings, saved passwords and keys — in one
 * transaction, so an erase never stops halfway. The stores themselves stay
 * (no deleteDatabase: that would tell other open tabs the app was updated). */
export async function eraseAllData(
  db: IDBPDatabase<KardabraSchema>,
): Promise<void> {
  const names = [...db.objectStoreNames];
  const tx = db.transaction(names, 'readwrite');
  await Promise.all(names.map((name) => tx.objectStore(name).clear()));
  await tx.done;
}

/** The stores a backup carries, read in one transaction so the copy is
 * consistent even while another tab imports. */
const BACKED_UP = ['cards', 'statements', 'transactions', 'cycles'] as const;

export async function getStoredData(
  db: IDBPDatabase<KardabraSchema>,
): Promise<StoredData> {
  const tx = db.transaction(BACKED_UP, 'readonly');
  const [cards, statements, transactions, cycles] = await Promise.all([
    tx.objectStore('cards').getAll(),
    tx.objectStore('statements').getAll(),
    tx.objectStore('transactions').getAll(),
    tx.objectStore('cycles').getAll(),
  ]);
  await tx.done;
  return { cards, statements, transactions, cycles };
}

/** Replace every card, statement, transaction and bill with `data`, in one
 * transaction: a failed restore leaves the old data as it was. Saved PDF
 * passwords of cards that aren't in `data` go too; settings (theme, the
 * backup passphrase) stay, being this device's own. */
export async function replaceStoredData(
  db: IDBPDatabase<KardabraSchema>,
  data: StoredData,
): Promise<void> {
  const tx = db.transaction([...BACKED_UP, 'pdfPasswords'], 'readwrite');
  const passwords = tx.objectStore('pdfPasswords');
  const kept = new Set(data.cards.map((c) => c.id));
  const orphaned = (await passwords.getAllKeys()).filter((id) => !kept.has(id));
  const writes: Promise<unknown>[] = BACKED_UP.map((name) =>
    tx.objectStore(name).clear(),
  );
  for (const cardId of orphaned) writes.push(passwords.delete(cardId));
  for (const card of data.cards) writes.push(tx.objectStore('cards').put(card));
  for (const s of data.statements) {
    writes.push(tx.objectStore('statements').put(s));
  }
  for (const t of data.transactions) {
    writes.push(tx.objectStore('transactions').put(t));
  }
  for (const c of data.cycles) writes.push(tx.objectStore('cycles').put(c));
  // tx.done joins the same await: when a write fails, the transaction's
  // abort must not surface later as an unhandled rejection.
  await Promise.all([...writes, tx.done]);
}
