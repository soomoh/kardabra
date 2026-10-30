/**
 * A bank's transaction export (net-banking "download transactions"): rows
 * over whatever date range the user picked, with no statement date, due
 * date or total. Kardabra tracks billing cycles, so an export is cut into
 * one piece per cycle and each piece is planned like a statement file —
 * nothing here parses; it only regroups rows already parsed.
 */

import type { ParsedStatement, Transaction } from '../parser';

/** An export prints none of a statement's summary: no statement date, due
 * date or total due. A statement missing only its date (some ICICI and
 * Axis files) still has the others, and is never cut up. */
export function isExport(parsed: ParsedStatement): boolean {
  const { statementDateISO, paymentDueDateISO, totalDue } = parsed.summary;
  return (
    statementDateISO === undefined &&
    paymentDueDateISO === undefined &&
    totalDue === undefined
  );
}

/** The day of the month the card's statements are made: the most common
 * day among its statement dates, the later on a tie — so a February
 * statement on the 28th, or one moved by a holiday, doesn't redefine a
 * card that bills on the 30th. Null when no statement says. */
export function statementDayOf(
  statementDates: readonly (string | undefined)[],
): number | null {
  const counts = new Map<number, number>();
  for (const d of statementDates) {
    if (d === undefined) continue;
    const day = Number(d.slice(8, 10));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  let best: number | null = null;
  for (const [day, n] of counts) {
    const bestN = best === null ? 0 : counts.get(best)!;
    if (n > bestN || (n === bestN && day > best!)) best = day;
  }
  return best;
}

/** The billing period ('YYYY-MM') a transaction on `dateISO` falls in: the
 * month of the first statement date on or after it. A day past the month's
 * end (statements on the 31st) is the month's last day. With no known
 * statement day, the calendar month stands in. */
export function cyclePeriod(
  dateISO: string,
  statementDay: number | null,
): string {
  const month = dateISO.slice(0, 7);
  if (statementDay === null) return month;
  const [y, m, d] = dateISO.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d <= Math.min(statementDay, daysInMonth)) return month;
  const next = new Date(Date.UTC(y, m, 1)); // month index m = next month
  return next.toISOString().slice(0, 7);
}

/** One piece per billing period, oldest first; rows keep their order. */
export function splitByCycle(
  parsed: ParsedStatement,
  statementDay: number | null,
): { parsed: ParsedStatement; period: string }[] {
  const byPeriod = new Map<string, Transaction[]>();
  for (const t of parsed.transactions) {
    const period = cyclePeriod(t.dateISO, statementDay);
    byPeriod.set(period, [...(byPeriod.get(period) ?? []), t]);
  }
  return [...byPeriod]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, transactions]) => ({
      period,
      parsed: { ...parsed, transactions },
    }));
}

/** Date and amount: banks word one transaction differently in an export
 * and a statement, but never change when or how much. On one card, the
 * same day and amount is the same transaction. */
const rowKey = (t: { dateISO: string; amount: number }) =>
  `${t.dateISO}|${t.amount}`;

/** `rows` without those already in `known`, each known row matching at
 * most one (three identical metro rides stay three). */
export function withoutKnown<T extends { dateISO: string; amount: number }>(
  rows: readonly T[],
  known: readonly { dateISO: string; amount: number }[],
): { kept: T[]; removed: number } {
  const left = new Map<string, number>();
  for (const k of known) left.set(rowKey(k), (left.get(rowKey(k)) ?? 0) + 1);
  const kept: T[] = [];
  for (const row of rows) {
    const n = left.get(rowKey(row)) ?? 0;
    if (n > 0) left.set(rowKey(row), n - 1);
    else kept.push(row);
  }
  return { kept, removed: rows.length - kept.length };
}

/** How many rows two lists share (same matching as withoutKnown). */
export function sharedCount(
  a: readonly { dateISO: string; amount: number }[],
  b: readonly { dateISO: string; amount: number }[],
): number {
  return withoutKnown(a, b).removed;
}
