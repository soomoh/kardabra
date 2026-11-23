/**
 * The transaction CSV export: one row per card transaction, in a fixed,
 * documented layout any tool can read (hledger first; beancount, Actual or a
 * spreadsheet just as well). Pure: stored records in, CSV text out.
 *
 * The layout is a public contract (README "Exporting to hledger"): headings
 * are never renamed and new columns are only appended, because people's
 * import rules and scripts recognise the file by them.
 *
 * Signs follow the card's view for every money column: money out (or an
 * amount owed) negative, money in (or a credit balance) positive.
 */

import { nextDayISO } from '../lib/dates';
import { transactionKind } from '../lib/kind';
import { nameMerchants, type MerchantRename } from '../lib/merchantGroups';
import { walkCardPayments } from '../lib/spend';
import type {
  CardRecord,
  CycleRecord,
  StatementRecord,
  TransactionRecord,
} from '../db/schema';

export const EXPORT_COLUMNS = [
  'id',
  'date',
  'posted',
  'description',
  'merchant',
  'amount',
  'currency',
  'kind',
  'card_last4',
  'card_nickname',
  'card_issuer',
  'statement_id',
  'period',
  'opening_balance',
  'closing_balance',
  'booked',
] as const;

type Column = (typeof EXPORT_COLUMNS)[number];
type Row = Record<Column, string>;

export interface ExportInput {
  cards: CardRecord[];
  statements: StatementRecord[];
  /** Every stored transaction, in store order (the statement's own order
   * within each statement). */
  transactions: TransactionRecord[];
  cycles: CycleRecord[];
  /** The user's merchant names; none when left out. */
  merchantNames?: MerchantRename[];
}

/** Text a spreadsheet would run as a formula: `=`, `+`, `-`, `@`, or a tab
 * or carriage return before one. Such a cell gets a leading `'`, which
 * spreadsheets read as "this is text" (user decision, 2026-11-16: the one
 * exception to the raw description being verbatim). */
const FORMULA_START = /^[=+\-@\t\r]/;

function safeText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** RFC 4180: quote a field holding a comma, quote or line break (and one
 * with edge spaces, which some readers trim); double inner quotes. */
function csvField(value: string): string {
  if (/[",\r\n]|^\s|\s$/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** A plain decimal with two places, no grouping or currency sign. */
function money(value: number): string {
  return value.toFixed(2);
}

/** The statement's closing balance in the export's sign: a credit balance
 * positive, an amount due negative; empty when the statement states neither
 * (a transaction export).
 *
 * Banks round the printed total to the rupee (HDFC prints 7161.94 as "7162")
 * but carry the exact balance into the next statement's opening, so a
 * balance check against the printed total fails by paise every month. When
 * the printed total is a whole rupee and the exact balance (opening plus
 * every row) rounds to it, the exact balance is exported. Otherwise the
 * printed figure stands, so a misread row still fails the check. */
function closingBalance(
  statement: StatementRecord,
  txns: TransactionRecord[],
): string {
  let printed: number;
  if (statement.creditBalance !== undefined && statement.creditBalance > 0) {
    printed = statement.creditBalance;
  } else if (statement.totalDue !== undefined) {
    printed = -statement.totalDue;
  } else {
    return '';
  }
  if (statement.openingBalance === undefined || !Number.isInteger(printed)) {
    return money(printed);
  }
  // In paise, so float sums can't drift. The opening is read as an amount owed.
  const paise = (v: number) => Math.round(v * 100);
  const exact =
    -paise(statement.openingBalance) +
    txns.reduce((sum, txn) => sum + paise(txn.amount), 0);
  return Math.abs(exact - paise(printed)) <= 50
    ? money(exact / 100)
    : money(printed);
}

/** The last day a card's statement covers: its printed date, else (a
 * transaction export) its latest transaction. Null when it has neither. */
function statementEnd(
  statement: StatementRecord,
  txns: TransactionRecord[],
): string | null {
  if (statement.statementDateISO !== undefined)
    return statement.statementDateISO;
  let latest: string | null = null;
  for (const txn of txns)
    if (latest === null || txn.dateISO > latest) latest = txn.dateISO;
  return latest;
}

/**
 * The date a row counts in the card's balance: its transaction date, except
 * a late-posted charge (bought before the previous statement closed, billed
 * on this one) moves to the day after that statement. Without it, a balance
 * check on the previous statement's closing balance would count the charge
 * there and fail, though nothing is wrong. Derived, not printed: a statement
 * that prints a posting date doesn't exist yet in what Kardabra reads.
 */
function bookedDate(dateISO: string, previousEnd: string | null): string {
  if (previousEnd === null || dateISO > previousEnd) return dateISO;
  return nextDayISO(previousEnd);
}

/** The CSV text (CRLF line ends, header first) and its number of
 * transaction rows. Rows oldest first and in
 * statement order within a day. `since` ('YYYY-MM-DD') keeps rows dated on
 * or after it; a statement cut by it keeps its closing balance (the balance
 * after all its rows, whichever import brought the earlier ones) but not its
 * opening balance. */
export function buildExportCsv(
  input: ExportInput,
  opts: { since?: string } = {},
): { csv: string; rows: number } {
  const cardsById = new Map(input.cards.map((card) => [card.id, card]));
  const txnsByStatement = new Map<string, TransactionRecord[]>();
  for (const txn of input.transactions) {
    const list = txnsByStatement.get(txn.statementId) ?? [];
    list.push(txn);
    txnsByStatement.set(txn.statementId, list);
  }
  // Named over every transaction, not just the exported ones, so a
  // merchant's name doesn't change with the date range chosen; the same
  // names Insights shows.
  const named = nameMerchants(
    input.transactions.map((txn) => txn.payee),
    input.merchantNames,
  );
  const merchantOf = new Map(
    input.transactions.map((txn, i) => [txn, named[i].merchant]),
  );
  const cycleKey = (cardId: string, period: string) => `${cardId}|${period}`;
  const cycles = new Map(
    input.cycles.map((c) => [cycleKey(c.cardId, c.period), c]),
  );

  // Payment sets need each card's statements oldest first (walkCardPayments).
  const statementsByCard = new Map<string, StatementRecord[]>();
  for (const statement of input.statements) {
    const list = statementsByCard.get(statement.cardId) ?? [];
    list.push(statement);
    statementsByCard.set(statement.cardId, list);
  }

  const rows: { row: Row; statementId: string; order: number }[] = [];
  const fullStatements = new Set<string>();
  for (const [cardId, statements] of statementsByCard) {
    const card = cardsById.get(cardId);
    if (card === undefined) continue; // orphan: nothing to name it by
    statements.sort((a, b) => a.period.localeCompare(b.period));
    // The newest statement that names its bank speaks for the card.
    const issuer =
      [...statements].reverse().find((s) => s.issuer !== undefined)?.issuer ??
      '';
    const walked = walkCardPayments(
      statements.map((statement) => {
        const cycle = cycles.get(cycleKey(cardId, statement.period));
        return {
          period: statement.period,
          totalDue: statement.totalDue,
          transactions: txnsByStatement.get(statement.id) ?? [],
          hasCycle: cycle !== undefined,
          override: cycle?.paymentOverride,
        };
      }),
    );

    let previousEnd: string | null = null;
    statements.forEach((statement, s) => {
      const txns = txnsByStatement.get(statement.id) ?? [];
      const cutoff = previousEnd;
      previousEnd = statementEnd(statement, txns) ?? previousEnd;
      const payments = new Set(walked[s].indices);
      const kept = txns.filter(
        (txn) => opts.since === undefined || txn.dateISO >= opts.since,
      );
      if (kept.length === txns.length) fullStatements.add(statement.id);
      txns.forEach((txn, t) => {
        if (opts.since !== undefined && txn.dateISO < opts.since) return;
        rows.push({
          statementId: statement.id,
          order: rows.length,
          row: {
            id: txn.id,
            date: txn.dateISO,
            posted: '', // not stored yet: no statement read so far prints one
            description: safeText(txn.payee),
            merchant: safeText(merchantOf.get(txn)!),
            amount: money(txn.amount),
            currency: statement.currency ?? card.currency ?? 'INR',
            kind: transactionKind(txn.payee, txn.amount, payments.has(t)),
            card_last4: safeText(card.last4 ?? ''), // free text after a restore
            card_nickname: safeText(card.nickname),
            card_issuer: safeText(issuer),
            statement_id: statement.id,
            period: statement.period,
            opening_balance: '',
            closing_balance: '',
            booked: bookedDate(txn.dateISO, cutoff),
          },
        });
      });
    });
  }

  // Oldest first; Array.prototype.sort is stable, and `order` breaks ties
  // explicitly so a day's rows keep their statement order.
  rows.sort(
    (a, b) => a.row.date.localeCompare(b.row.date) || a.order - b.order,
  );

  const statementsById = new Map(input.statements.map((s) => [s.id, s]));
  const first = new Map<string, Row>();
  const last = new Map<string, Row>();
  for (const { row, statementId } of rows) {
    if (!first.has(statementId)) first.set(statementId, row);
    last.set(statementId, row);
  }
  for (const [statementId, row] of last) {
    const statement = statementsById.get(statementId);
    if (statement === undefined) continue;
    row.closing_balance = closingBalance(
      statement,
      txnsByStatement.get(statementId) ?? [],
    );
    const opening = first.get(statementId);
    if (
      opening !== undefined &&
      fullStatements.has(statementId) &&
      statement.openingBalance !== undefined
    ) {
      // The parser reads the opening balance as a positive amount owed.
      opening.opening_balance = money(-statement.openingBalance);
    }
  }

  const lines = [EXPORT_COLUMNS.join(',')];
  for (const { row } of rows) {
    lines.push(EXPORT_COLUMNS.map((column) => csvField(row[column])).join(','));
  }
  return { csv: lines.join('\r\n') + '\r\n', rows: rows.length };
}
