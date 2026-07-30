/**
 * Opens Kardabra's IndexedDB database and exposes small, focused
 * data-access functions over it. No generic "repository" abstraction on
 * top (YAGNI): each function does exactly one query or one write, named
 * for what it does, so a caller (the import pipeline, later the UI) never
 * has to guess what a call will touch.
 *
 * Why `idb` (a ~1KB dependency) instead of the raw IndexedDB API: raw
 * IndexedDB is a callback/event API designed in 2010, before Promises
 * existed in the language — every read or write means wiring up
 * `onsuccess`/`onerror` handlers by hand. `idb` wraps each of those in a
 * Promise so the calls below can use plain `await`, without hiding any of
 * the underlying concepts — object stores, transactions, and indexes are
 * still exactly what you see in every function here, just awaitable.
 */

import { openDB, type IDBPDatabase } from 'idb';
import { actionableCycle } from '../lib/cycles';
import {
  identifyPaymentIndices,
  netSpend,
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
const DB_VERSION = 1;

/** Open (and, on first run, create) the database. Safe to call more than
 * once — IndexedDB itself de-dupes concurrent opens of the same
 * name+version, and idb's `upgrade` callback only fires when the stored
 * version is behind `DB_VERSION`. */
export function openKardabraDb(): Promise<IDBPDatabase<KardabraSchema>> {
  return openDB<KardabraSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const cards = db.createObjectStore('cards', { keyPath: 'id' });
      cards.createIndex('by-last4', 'last4');

      const statements = db.createObjectStore('statements', { keyPath: 'id' });
      // unique: true — a (cardId, period) pair identifies at most one
      // statement; putStatementWithTransactions relies on this index to
      // find "the" existing statement to replace, not "a" one of several.
      statements.createIndex('by-card-period', ['cardId', 'period'], {
        unique: true,
      });

      // No keyPath: the key (an autoIncrement integer) is out-of-line,
      // not a field on TransactionRecord — nothing ever needs to name one
      // transaction directly, only look several up via an index.
      const transactions = db.createObjectStore('transactions', {
        autoIncrement: true,
      });
      transactions.createIndex('by-statement', 'statementId');
      transactions.createIndex('by-card-date', ['cardId', 'dateISO']);

      // keyPath is an array here (an in-line compound key): CycleRecord
      // already carries both cardId and period as real fields, so there's
      // no separate id to invent.
      db.createObjectStore('cycles', { keyPath: ['cardId', 'period'] });

      db.createObjectStore('settings', { keyPath: 'key' });
    },
  });
}

export async function getAllCards(
  db: IDBPDatabase<KardabraSchema>,
): Promise<CardRecord[]> {
  return db.getAll('cards');
}

/** One card by id, or `undefined` if it doesn't exist — the lookup
 * CardDetail needs that neither `getAllCards` nor `getCardByLast4` (keyed
 * on the wrong field) already cover. */
export async function getCard(
  db: IDBPDatabase<KardabraSchema>,
  id: string,
): Promise<CardRecord | undefined> {
  return db.get('cards', id);
}

/** `last4` is always a real 4-digit string here, never null — a card with
 * no last4 can't be looked up this way (see plan.ts: such cards are never
 * matched against existing ones, only ever created new). */
export async function getCardByLast4(
  db: IDBPDatabase<KardabraSchema>,
  last4: string,
): Promise<CardRecord | undefined> {
  return db.getFromIndex('cards', 'by-last4', last4);
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

/** Every statement ever imported, across every card — the snapshot
 * `planImport` needs to detect duplicates against (see plan.ts). */
export async function getAllStatements(
  db: IDBPDatabase<KardabraSchema>,
): Promise<StatementRecord[]> {
  return db.getAll('statements');
}

/** All statements for one card, newest-first by period. No dedicated
 * index for "by card alone" (YAGNI — same reasoning as
 * `getLatestCycleByCard`): `by-card-period`'s compound key isn't worth a
 * range-query trick for what's still a small per-card list, so this is a
 * full scan filtered by cardId. */
export async function getStatementsForCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<StatementRecord[]> {
  const all = await db.getAll('statements');
  return all
    .filter((statement) => statement.cardId === cardId)
    .sort((a, b) => b.period.localeCompare(a.period));
}

/**
 * Write a statement and its transactions as one atomic unit, replacing
 * whatever previously existed for the same (cardId, period).
 *
 * This is the "keep fullest" rule: when a statement for a period is
 * imported twice (e.g. the user re-downloads because the first export was
 * incomplete), the newer parse simply replaces the older one outright —
 * delete the old statement row and every transaction the by-statement
 * index says belongs to it, *then*
 * insert the new statement and its transactions — all inside one
 * IndexedDB transaction, so a failure partway through leaves either the
 * complete old state or the complete new state, never a mix with orphaned
 * transactions pointing at a deleted statement.
 */
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
 * Insert or update a cycle, preserving any existing `paidAt` and
 * `paymentOverride`.
 *
 * Re-importing a statement (a corrected download, a supersede) recomputes
 * everything the statement itself says — due date, totalDue, minDue — but
 * "has the user paid this bill" and "which rows did the user pick as the
 * payment" are facts that live outside the statement entirely. Overwriting
 * either on every import would silently un-pay a bill, or silently discard
 * a manual payment fix, just because its statement was re-imported;
 * carrying both existing values forward is what makes `upsertCycle` safe
 * to call on every commit, not just the first one. (The `spend` this
 * function writes is only the provisional first-pass value — see plan.ts's
 * buildCycleRecord; commitImport's later recomputeCardSpends pass is what
 * actually finalises it, using this row's preserved paymentOverride.)
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

/** All cycles for one card, in no particular order — the input
 * `recomputeCardSpends` re-sorts by period itself, and CardDetail only
 * needs to index this by period, not walk it in any order. No dedicated
 * index (YAGNI, same reasoning as `getActionableCycleByCard`): `cycles` is
 * small per card, so a full scan filtered by cardId is simplest. */
export async function getCyclesForCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<CycleRecord[]> {
  const all = await db.getAll('cycles');
  return all.filter((cycle) => cycle.cardId === cardId);
}

/** Every cycle across every card — the flat input the trends chart needs
 * (lib/trends.ts's monthlyTrends reads cycle.spend directly now, rather
 * than recomputing from transactions), same "flat array, caller groups it"
 * shape as getAllStatements/getAllTransactions. */
export async function getAllCycles(
  db: IDBPDatabase<KardabraSchema>,
): Promise<CycleRecord[]> {
  return db.getAll('cycles');
}

/**
 * Recompute and store `spend` for every one of a card's cycles, in
 * statement-period order — the authoritative pass that makes cycle.spend
 * correct regardless of what order statements were imported in, and the
 * ONLY place that ever writes `spend` after the initial (provisional)
 * write in plan.ts's buildCycleRecord.
 *
 * Walking oldest-to-newest matters: each statement's `priorExpectedDue`
 * (what identifyPaymentIndices needs for its amount-match rung) is the
 * PRECEDING statement's own totalDue, or — when the bank's export carries
 * no total — that preceding statement's freshly-recomputed spend. Going in
 * order guarantees the preceding cycle's spend is already correct and
 * up to date before it's used as this cycle's fallback; computing in
 * import order (or in parallel) could use a stale or not-yet-recomputed
 * prior spend instead.
 *
 * A statement with no matching cycle row is skipped (shouldn't normally
 * happen — commitImport always upserts a cycle alongside its statement —
 * but this function has no write of its own to make there, so skipping is
 * the correct no-op rather than fabricating a cycle here).
 */
export async function recomputeCardSpends(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<void> {
  const statements = (await getStatementsForCard(db, cardId))
    .slice()
    .sort((a, b) => a.period.localeCompare(b.period)); // ascending — see header comment

  let priorExpectedDue: number | null = null;
  for (const statement of statements) {
    const cycle = await db.get('cycles', [cardId, statement.period]);
    if (cycle === undefined) continue; // no cycle row for this statement — nothing to update

    const txns = await getTransactionsForStatement(db, statement.id);
    const paymentIndices = identifyPaymentIndices(txns, {
      priorExpectedDue,
      override: cycle.paymentOverride,
    });
    const spend = netSpend(txns, paymentIndices);
    await db.put('cycles', { ...cycle, spend });

    // This statement's own totalDue wins as the next cycle's expected due
    // when the bank supplied one; otherwise the spend just computed is the
    // best available proxy for what was owed (same fallback as
    // CardDetail's priorExpectedDue helper).
    priorExpectedDue = statement.totalDue ?? spend;
  }
}

/**
 * Set (or, passing `undefined`, clear back to auto-detect) a cycle's
 * payment override, then immediately recompute that card's spends so
 * `cycle.spend` reflects the change everywhere it's read from (single
 * source of truth — see schema.ts's CycleRecord.spend comment). A no-op
 * if the cycle doesn't exist yet (nothing to set an override on) — the
 * same "not an error, just nothing to do" shape as `setCyclePaid`.
 */
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

/**
 * Mark (or un-mark, via `paidAt: null`) a cycle as paid. Does nothing if
 * the cycle doesn't exist yet — a guard clause, not an error: there's
 * nothing wrong with marking a not-yet-imported cycle paid from the UI
 * being asked to do something before its data exists, it's just a no-op.
 *
 * `paidAt: string | null` (not `string | undefined`) because this
 * function's whole job is to let the caller *clear* the field, and
 * `undefined` can't be distinguished from "argument omitted" the way
 * `null` can.
 */
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

/** The card's one actionable cycle — its latest — or `null` if it has
 * none yet. "Latest wins" is a domain rule, not a display choice: see
 * lib/cycles.ts's header comment (a newer statement's total already
 * absorbs any unpaid carry-forward, so older cycles are settled by
 * successor). No dedicated index (YAGNI — `cycles` is small): a full
 * scan filtered by cardId, then the shared actionableCycle helper. */
export async function getActionableCycleByCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<CycleRecord | null> {
  const forCard = (await db.getAll('cycles')).filter(
    (cycle) => cycle.cardId === cardId,
  );
  return actionableCycle(forCard);
}

/** Every transaction across every card — the flat input TrendsChart's
 * monthlyTrends transform groups by statement itself (see lib/trends.ts),
 * same "give the caller a flat array, let the pure function group it"
 * shape as getAllStatements feeds planImport. */
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

/** Every transaction for one card, across every statement — one query via
 * the `by-card-date` compound index (a range covering every `dateISO` for
 * this `cardId`), rather than CardDetail fetching per-statement in a loop.
 * Used to compute each statement's spend total without a second round of
 * per-statement queries. */
export async function getTransactionsForCard(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<TransactionRecord[]> {
  // '￿' sorts after any real dateISO string ('YYYY-MM-DD' never
  // contains a character that high), so the upper bound covers every date
  // this card could have without needing to know the actual max in advance.
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

/**
 * Delete a card and everything derived from it — statements,
 * transactions, cycles — in one atomic IndexedDB transaction, so an
 * interruption can't leave orphaned rows pointing at a card that no
 * longer exists. Same cascade instinct as SQL's ON DELETE CASCADE, done
 * by hand because IndexedDB has no foreign keys.
 *
 * Deliberately irreversible and total: the user asked for the card to be
 * gone from this device, and half-deleting (say, keeping transactions)
 * would leak exactly the data they asked to remove.
 */
export async function deleteCardCascade(
  db: IDBPDatabase<KardabraSchema>,
  cardId: string,
): Promise<void> {
  const tx = db.transaction(
    ['cards', 'statements', 'transactions', 'cycles'],
    'readwrite',
  );

  // Every store keyed or indexed on cardId supports a range covering all
  // of that card's rows: [cardId, lowest] .. [cardId, highest] on the
  // compound key/index. '￿' is a string ceiling no real period/date
  // reaches.
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
