/**
 * The shape of Kardabra's IndexedDB database, as types only
 * (no runtime code lives here — db.ts is where the stores actually get
 * created). `KardabraSchema` is idb's `DBSchema`: a plain TypeScript
 * interface that pins down, per object store, the key type, the value
 * type, and the index names/key types. Every `db.get`/`db.put`/
 * `db.transaction` call in db.ts is checked against this at compile time —
 * "typed schema": the same guarantee a SQL `CREATE TABLE` gives you, but
 * enforced by the compiler instead of the database engine, since
 * IndexedDB itself is schemaless (any object store will happily store any
 * shape of object).
 */

import type { DBSchema } from 'idb';

/** One physical credit card the user tracks. `dueDay` is deliberately
 * optional, not defaulted to some placeholder day — it's unknown until the
 * user answers the "which day of the month is your bill due?" prompt
 * (asked once, only for cards whose statements never state a due date,
 * e.g. ICICI's web-export snapshot). Leaving it `undefined` until then is
 * the sentinel: a real answer of "the 1st" must never be confused with
 * "not asked yet". */
export interface CardRecord {
  id: string; // crypto.randomUUID()
  last4: string | null; // null when no statement this card has produced states one
  nickname: string;
  dueDay?: number; // 1-31; the ask-once answer, see above
  createdAt: string; // ISO date-time, Date.prototype.toISOString()
  /** What the card was promised to cost each year; absent = not set. An
   * optional value field, so no DB_VERSION bump. Only 'AMOUNT' carries an
   * amount. Read by lib/charges.ts feeDiscrepancyNote. */
  feeLabel?: { type: 'LTF' | 'FYF' | 'AMOUNT'; amount?: number };
  /** ISO 4217 code from the card's statements; absent means INR (cards
   * created before currencies were stored). */
  currency?: string;
  /** Which password pattern (lib/pdfPassword.ts id, e.g. 'name4U+ddmm')
   * last opened this card's PDF statements — tried first next time. Only
   * the pattern's name: never a password, name or date of birth. An optional
   * value field, so no DB_VERSION bump (same reasoning as feeLabel). */
  pdfPasswordPattern?: string;
}

/** One imported statement file's metadata, one row per (card, period).
 * Every money/date field is optional for the same "parse, don't validate"
 * reason StatementSummary's fields are: a statement is still worth storing
 * even if the parser recovered only some of its fields. */
export interface StatementRecord {
  id: string; // crypto.randomUUID()
  cardId: string;
  period: string; // 'YYYY-MM' — the billing cycle this statement belongs to
  statementDateISO?: string;
  dueDateISO?: string;
  totalDue?: number;
  minDue?: number;
  creditLimit?: number;
  /** v2: what the statement itself reported — see parser StatementSummary. */
  currency?: string;
  creditBalance?: number;
  openingBalance?: number;
  paymentsTotal?: number;
  purchasesTotal?: number;
  chargesTotal?: number;
  /** Rows the parser skipped with a warning (0 when it read everything). */
  skippedRows?: number;
  /** v2: lib/txnId.ts statementFingerprint of the transaction list — how a
   * re-import of the same file is recognised even with no card number. */
  fingerprint?: string;
  fileName: string; // the uploaded file's own name, kept for the user's reference
  txnCount: number; // denormalised for the duplicate-detection "keep fullest" rule
  importedAt: string; // ISO date-time
}

/** One transaction line, always attached to the statement it was read
 * from. No `id` field: the store's key is an autoIncrement integer kept
 * *out of* the value (see db.ts's `createObjectStore('transactions')`,
 * which has no `keyPath`) — nothing downstream ever needs to name a
 * transaction by id, only to look transactions up by statement or by
 * card+date, which the two indexes below already cover. */
export interface TransactionRecord {
  /** v2: stable content-derived id (lib/txnId.ts) — the same purchase keeps
   * its id across re-imports, which exports rely on for de-duplication.
   * Not the store key (that stays the autoIncrement integer). */
  id: string;
  statementId: string;
  cardId: string; // denormalised from the statement, so by-card-date needs no join
  dateISO: string;
  payee: string;
  amount: number; // same sign convention as parser Transaction: out negative, in positive
}

/**
 * One billing cycle's payment status, one row per (card, period) — the
 * thing a "pay this bill" reminder is actually about. Deliberately a
 * separate store from `statements`, not just a due-date column on it:
 * a cycle can exist (and need paying) even before any statement has been
 * imported for it (`source: 'predicted'`, for a cycle whose due date is
 * projected rather than read off a statement), and a
 * cycle's `paidAt` must survive a statement being re-imported/replaced —
 * seeing new transaction data must never silently un-pay a bill.
 *
 * `dueDateISO: string | null` — null, not the string `''` or a missing
 * field, means "we don't know yet" (no due date on the statement itself,
 * and no card `dueDay` to project one from). Sentinels are not zero: an
 * unknown due date is a different fact from "there is no due date field to
 * store", and code reading this must be able to tell them apart.
 */
export interface CycleRecord {
  cardId: string;
  period: string; // 'YYYY-MM'
  dueDateISO: string | null;
  source: 'statement' | 'predicted';
  totalDue?: number;
  minDue?: number;
  /** Sum of the statement's debits (positive number), denormalized here
   * at commit time so the dashboard can show "Spend ₹X" for banks whose
   * exports carry no Total Amount Due — spend is a fact we always have,
   * distinct from the bill amount, which stays honestly absent. This is
   * THE single source of truth for "what did this cycle cost" — every
   * view (dashboard, card detail, trends chart) reads this stored value
   * rather than recomputing from transactions, so they can never disagree
   * (see db.ts's recomputeCardSpends, the only place that ever writes it).
   */
  spend?: number;
  paidAt?: string; // ISO date-time the user marked this cycle paid, if any
  /** The user's manual correction of which transaction(s) on this cycle's
   * statement are the bill payment, keyed by value (amount + payee) — see
   * lib/spend.ts's PaymentMark, which this is structurally identical to
   * (redeclared here rather than imported, to avoid a schema.ts -> lib/
   * import — schema.ts stays pure types with no dependency on app logic).
   *
   * A three-way sentinel, not a boolean flag (sentinels are not zero):
   *   - `undefined` — auto-detect, via lib/spend.ts's confidence ladder.
   *   - `[]` (empty array) — the user asserted "no payment on this
   *     statement at all" — a real, distinct answer, not "unanswered".
   *   - a non-empty array — the exact rows the user picked, re-matched
   *     against this statement's (possibly re-imported, re-created)
   *     transactions by value every time spend is recomputed.
   * Survives re-import because it lives on the cycle, not the statement —
   * re-importing replaces the statement and its transactions wholesale
   * (see db.ts's putStatementWithTransactions) but never touches the
   * cycle's paymentOverride, the same way it never touches paidAt. */
  paymentOverride?: { amount: number; payee: string }[];
}

/** Freeform key/value settings (e.g. sync config). `value: unknown`
 * because the set of settings this store holds isn't
 * fixed yet — callers narrow the type themselves at the point of use. */
export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface KardabraSchema extends DBSchema {
  cards: {
    key: string; // CardRecord.id
    value: CardRecord;
    indexes: { 'by-last4': string };
  };
  statements: {
    key: string; // StatementRecord.id
    value: StatementRecord;
    // [cardId, period] — unique (enforced in db.ts's upgrade callback,
    // idb's DBSchema typing has no way to express "unique" itself).
    indexes: { 'by-card-period': [string, string] };
  };
  transactions: {
    key: number; // autoIncrement, out-of-line (not a field on the value)
    value: TransactionRecord;
    indexes: {
      'by-statement': string;
      'by-card-date': [string, string];
      'by-id': string;
    };
  };
  cycles: {
    key: [string, string]; // [cardId, period] — keyPath, in-line
    value: CycleRecord;
  };
  settings: {
    key: string; // SettingRecord.key
    value: SettingRecord;
  };
}
