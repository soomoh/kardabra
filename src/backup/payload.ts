/**
 * What's inside a backup once decrypted, and the strict parser restore
 * runs on it. Parse, don't validate: every record is rebuilt field by
 * field from the allowed fields only (never spread from the parsed JSON,
 * so stray keys such as `__proto__` go nowhere), and the first problem
 * stops the whole restore. Saved PDF passwords, keys and settings are not
 * part of a backup by construction: there's no field for them.
 */

import type {
  CardRecord,
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';

export interface BackupData {
  createdAt: string;
  cards: CardRecord[];
  statements: StatementRecord[];
  transactions: TransactionRecord[];
  cycles: CycleRecord[];
}

export type ParsedBackup =
  { ok: true; data: BackupData } | { ok: false; problem: string };

/** A problem in plain words; thrown inside the parser, caught at its edge. */
class Problem extends Error {}

type Fields = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?Z$/;
/** Far past any card's money (₹1 lakh crore), short of where sums lose
 * precision or overflow. */
const MAX_AMOUNT = 1e12;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Far beyond anything the app writes (no input caps a name or a
 * description): a backup the app made must always restore. Only a hostile
 * file gets near it, and the file-size cap already bounds memory. */
const MAX_TEXT = 100_000;

/** Reads one record's fields, naming the record in any problem. */
class Reader {
  private readonly fields: Fields;
  private readonly name: string;

  constructor(value: unknown, name: string) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Problem(`${name} isn’t readable`);
    }
    this.fields = value as Fields;
    this.name = name;
  }

  problem(what: string): Problem {
    return new Problem(`${this.name} has ${what}`);
  }

  private has(key: string): boolean {
    return Object.hasOwn(this.fields, key) && this.fields[key] !== undefined;
  }

  text(key: string, label: string): string {
    const value = this.fields[key];
    if (typeof value !== 'string' || value.length > MAX_TEXT) {
      throw this.problem(`no readable ${label}`);
    }
    return value;
  }

  id(key: string, label: string): string {
    const value = this.text(key, label);
    if (value === '') throw this.problem(`an empty ${label}`);
    return value;
  }

  optionalText(key: string, label: string) {
    return this.has(key) ? this.text(key, label) : undefined;
  }

  number(key: string, label: string): number {
    const value = this.fields[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw this.problem(`${label} that isn’t a number`);
    }
    if (Math.abs(value) > MAX_AMOUNT) {
      throw this.problem(`${label} that’s far too large`);
    }
    return value;
  }

  optionalNumber(key: string, label: string): number | undefined {
    return this.has(key) ? this.number(key, label) : undefined;
  }

  count(key: string, label: string): number {
    const value = this.number(key, label);
    if (!Number.isInteger(value) || value < 0) {
      throw this.problem(`${label} that isn’t a whole number`);
    }
    return value;
  }

  date(key: string, label: string): string {
    const value = this.fields[key];
    if (typeof value !== 'string' || !DATE.test(value) || !isRealDate(value)) {
      throw this.problem(`${label} that isn’t a date`);
    }
    return value;
  }

  optionalDate(key: string, label: string): string | undefined {
    return this.has(key) ? this.date(key, label) : undefined;
  }

  dateTime(key: string, label: string): string {
    const value = this.fields[key];
    if (
      typeof value !== 'string' ||
      !DATE_TIME.test(value) ||
      !isRealDate(value.slice(0, 10))
    ) {
      throw this.problem(`${label} that isn’t a date and time`);
    }
    return value;
  }

  period(): string {
    const value = this.fields.period;
    if (typeof value !== 'string' || !PERIOD.test(value)) {
      throw this.problem('a month that isn’t a month');
    }
    return value;
  }

  optionalCurrency(): string | undefined {
    if (!this.has('currency')) return undefined;
    const value = this.fields.currency;
    if (typeof value !== 'string' || !CURRENCY.test(value)) {
      throw this.problem('a currency that isn’t a currency code');
    }
    return value;
  }

  raw(key: string): unknown {
    return this.fields[key];
  }

  present(key: string): boolean {
    return this.has(key);
  }
}

function isRealDate(iso: string): boolean {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso
  );
}

/** Keeps only defined fields, so a restored record looks like one the app
 * wrote (absent, not `undefined`, for a missing optional). */
function defined<T extends object>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, v]) => v !== undefined),
  ) as T;
}

function parseCard(value: unknown, n: number): CardRecord {
  const r = new Reader(value, `Card ${n}`);
  const last4 = r.raw('last4');
  if (
    last4 !== null &&
    (typeof last4 !== 'string' || last4.length > MAX_TEXT)
  ) {
    throw r.problem('no readable card number ending');
  }
  let dueDay: number | undefined;
  if (r.present('dueDay')) {
    dueDay = r.count('dueDay', 'a due day');
    if (dueDay < 1 || dueDay > 31)
      throw r.problem('a due day that isn’t 1 to 31');
  }
  let feeLabel: CardRecord['feeLabel'];
  if (r.present('feeLabel')) {
    const f = new Reader(r.raw('feeLabel'), `Card ${n}’s annual fee`);
    const type = f.raw('type');
    if (type !== 'LTF' && type !== 'FYF' && type !== 'AMOUNT') {
      throw r.problem('an annual fee of an unknown kind');
    }
    const amount = f.optionalNumber('amount', 'an amount');
    if (amount !== undefined && amount < 0)
      throw r.problem('a negative annual fee');
    feeLabel = defined<NonNullable<CardRecord['feeLabel']>>({
      type,
      amount: type === 'AMOUNT' ? amount : undefined,
    });
  }
  return defined({
    id: r.id('id', 'id'),
    last4,
    nickname: r.text('nickname', 'name'),
    dueDay,
    createdAt: r.dateTime('createdAt', 'a creation date'),
    feeLabel,
    currency: r.optionalCurrency(),
    pdfPasswordPattern: r.optionalText(
      'pdfPasswordPattern',
      'password pattern',
    ),
  });
}

function parseStatement(value: unknown, n: number): StatementRecord {
  const r = new Reader(value, `Statement ${n}`);
  const skippedRows = r.present('skippedRows')
    ? r.count('skippedRows', 'a skipped-row count')
    : undefined;
  return defined({
    id: r.id('id', 'id'),
    cardId: r.id('cardId', 'card'),
    period: r.period(),
    statementDateISO: r.optionalDate('statementDateISO', 'a statement date'),
    dueDateISO: r.optionalDate('dueDateISO', 'a due date'),
    totalDue: r.optionalNumber('totalDue', 'a total due'),
    minDue: r.optionalNumber('minDue', 'a minimum due'),
    creditLimit: r.optionalNumber('creditLimit', 'a credit limit'),
    currency: r.optionalCurrency(),
    creditBalance: r.optionalNumber('creditBalance', 'a credit balance'),
    openingBalance: r.optionalNumber('openingBalance', 'an opening balance'),
    paymentsTotal: r.optionalNumber('paymentsTotal', 'a payments total'),
    purchasesTotal: r.optionalNumber('purchasesTotal', 'a purchases total'),
    chargesTotal: r.optionalNumber('chargesTotal', 'a charges total'),
    skippedRows,
    fingerprint: r.optionalText('fingerprint', 'fingerprint'),
    fileName: r.text('fileName', 'file name'),
    txnCount: r.count('txnCount', 'a transaction count'),
    importedAt: r.dateTime('importedAt', 'an import date'),
  });
}

function parseTransaction(value: unknown, n: number): TransactionRecord {
  const r = new Reader(value, `Transaction ${n}`);
  return {
    id: r.id('id', 'id'),
    statementId: r.id('statementId', 'statement'),
    cardId: r.id('cardId', 'card'),
    dateISO: r.date('dateISO', 'a date'),
    payee: r.text('payee', 'description'),
    amount: r.number('amount', 'an amount'),
  };
}

function parseCycle(value: unknown, n: number): CycleRecord {
  const r = new Reader(value, `Bill ${n}`);
  const due = r.raw('dueDateISO');
  const source = r.raw('source');
  if (source !== 'statement' && source !== 'predicted') {
    throw r.problem('an unknown source');
  }
  let paymentOverride: CycleRecord['paymentOverride'];
  if (r.present('paymentOverride')) {
    const marks = r.raw('paymentOverride');
    if (!Array.isArray(marks))
      throw r.problem('an unreadable bill payment choice');
    paymentOverride = marks.map((mark: unknown) => {
      const m = new Reader(mark, `Bill ${n}’s payment choice`);
      return {
        amount: m.number('amount', 'an amount'),
        payee: m.text('payee', 'description'),
      };
    });
  }
  // Older versions stored a date and time; today's store a date.
  let paidAt: string | undefined;
  if (r.present('paidAt')) {
    const value = r.raw('paidAt');
    if (
      typeof value !== 'string' ||
      !(DATE.test(value) || DATE_TIME.test(value)) ||
      !isRealDate(value.slice(0, 10))
    ) {
      throw r.problem('a paid date that isn’t a date');
    }
    paidAt = value;
  }
  // Spend can be negative: a month of refunds nets below zero.
  const spend = r.optionalNumber('spend', 'a spend');
  return defined({
    cardId: r.id('cardId', 'card'),
    period: r.period(),
    dueDateISO: due === null ? null : r.date('dueDateISO', 'a due date'),
    source,
    totalDue: r.optionalNumber('totalDue', 'a total due'),
    minDue: r.optionalNumber('minDue', 'a minimum due'),
    spend,
    paidAt,
    paymentOverride,
  });
}

function list<T>(
  value: unknown,
  what: string,
  parse: (item: unknown, n: number) => T,
): T[] {
  if (!Array.isArray(value))
    throw new Problem(`the list of ${what} is missing`);
  return value.map((item, i) => parse(item, i + 1));
}

function unique<T>(
  items: readonly T[],
  key: (item: T) => string,
  problem: (n: number) => string,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) throw new Problem(problem(i + 1));
    seen.add(k);
  });
}

/** Every record fully typed and every link between them intact — or the
 * first problem, in words a person can act on. */
export function parseBackupPayload(json: unknown): ParsedBackup {
  try {
    const top = new Reader(json, 'The backup');
    const data: BackupData = {
      createdAt: top.dateTime('createdAt', 'a creation date'),
      cards: list(top.raw('cards'), 'cards', parseCard),
      statements: list(top.raw('statements'), 'statements', parseStatement),
      transactions: list(
        top.raw('transactions'),
        'transactions',
        parseTransaction,
      ),
      cycles: list(top.raw('cycles'), 'bills', parseCycle),
    };
    unique(
      data.cards,
      (c) => c.id,
      (n) => `Card ${n} repeats another card`,
    );
    unique(
      data.statements,
      (s) => s.id,
      (n) => `Statement ${n} repeats another statement`,
    );
    unique(
      data.statements,
      (s) => `${s.cardId}\u0000${s.period}`,
      (n) => `Statement ${n} is a second statement for the same card and month`,
    );
    unique(
      data.cycles,
      (c) => `${c.cardId}\u0000${c.period}`,
      (n) => `Bill ${n} repeats another bill`,
    );
    const cardIds = new Set(data.cards.map((c) => c.id));
    const statementCards = new Map(
      data.statements.map((s) => [s.id, s.cardId]),
    );
    data.statements.forEach((s, i) => {
      if (!cardIds.has(s.cardId)) {
        throw new Problem(
          `Statement ${i + 1} belongs to a card that isn’t there`,
        );
      }
    });
    data.transactions.forEach((t, i) => {
      if (statementCards.get(t.statementId) !== t.cardId) {
        throw new Problem(
          `Transaction ${i + 1} belongs to a statement that isn’t there`,
        );
      }
    });
    data.cycles.forEach((c, i) => {
      if (!cardIds.has(c.cardId)) {
        throw new Problem(`Bill ${i + 1} belongs to a card that isn’t there`);
      }
    });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: error.message };
    throw error;
  }
}
