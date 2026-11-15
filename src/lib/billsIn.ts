/**
 * "Are this month's bills in?" — one bill per card per calendar month, so
 * a month's bills can be paid together from that month's income.
 *
 * A card's bill is in for the month once a statement for that month
 * (its `period`) is imported. Paying a bill never changes the count: a
 * paid bill is still in. A card without this month's bill is still to
 * come when its usual statement day says one is due this month (or one is
 * late); a card that can't be predicted, or has gone a whole cycle without
 * a statement (likely closed), isn't counted at all.
 *
 * The count is about arrivals; the earliest unpaid due date is reported
 * alongside it on its own, so waiting for the rest of the month's bills
 * can never hide a payment that falls due first.
 */

import type { CardRecord, CycleRecord, StatementRecord } from '../db/schema';
import { actionableCycle, cycleNeedsPayment } from './cycles';
import {
  daysBetweenISO,
  monthName,
  nextDueDateWithGraceISO,
  ordinal,
} from './dates';

/** Statements usually come a month apart; never expect the next one sooner
 * than this after the latest (a statement dated a day early would
 * otherwise "expect" the next one tomorrow). */
const MIN_STATEMENT_GAP_DAYS = 20;
/** A statement can run this many days past its usual day; later than
 * that it's called out as late... */
const LATE_AFTER_DAYS = 3;
/** ...until a whole cycle has passed: by then the card is likely closed or
 * no longer imported, and its tile already asks for a newer statement. */
const STALE_AFTER_DAYS = 31;
/** Recent statements only: a bank can move a card's statement day. */
const HISTORY = 6;
/** Past due by more than this, the date is more likely stale data than a
 * forgotten payment (same threshold as lib/dueStatus.ts). */
const STALE_DUE_DAYS = 30;

export interface AwaitedBill {
  card: CardRecord;
  /** When the next statement should arrive. */
  expectedISO: string;
  /** Usual day of the month it's generated, e.g. 18. */
  usualDay: number;
  /** Expected more than a few days ago and still not imported. */
  late: boolean;
}

export interface BillsIn {
  /** The calendar month counted, 'YYYY-MM' (today's). */
  month: string;
  /** Cards with a bill this month: in, or still to come. */
  cardCount: number;
  /** Cards whose statement for this month is imported, paid or not. */
  inCount: number;
  /** Every bill that's in needs no payment (false when none is in). */
  allInPaid: boolean;
  /** Still to come, earliest expected first. */
  awaited: AwaitedBill[];
  /** Earliest due date among unpaid bills, of any month, skipping any
   * more than a cycle past (see earliestDue). */
  earliestDueISO: string | null;
  /** Cards with an unpaid bill whose due date isn't known. */
  undatedUnpaid: CardRecord[];
}

/** Median day of the month of the card's recent statement dates, or null
 * when no statement carries a date. */
export function usualStatementDay(
  statements: StatementRecord[],
): number | null {
  const days = statements
    .filter((s) => s.statementDateISO !== undefined)
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, HISTORY)
    .map((s) => Number(s.statementDateISO!.slice(8, 10)))
    .sort((a, b) => a - b);
  if (days.length === 0) return null;
  return days[Math.floor((days.length - 1) / 2)];
}

/** When the card's next statement is expected, or null when that can't be
 * told (no dated history, or the newest statement carries no date). */
export function expectedNextStatementISO(
  statements: StatementRecord[],
): string | null {
  const usualDay = usualStatementDay(statements);
  const newest = statements.reduce<StatementRecord | undefined>(
    (best, s) => (best === undefined || s.period > best.period ? s : best),
    undefined,
  );
  const latest = newest?.statementDateISO;
  if (usualDay === null || latest === undefined) return null;
  return nextDueDateWithGraceISO(latest, usualDay, MIN_STATEMENT_GAP_DAYS);
}

/** The due date to headline. A date more than a cycle past is likely
 * stale data (lib/dueStatus.ts) and must not hide a payment due next
 * week, so it's shown only when nothing more recent is unpaid. */
function earliestDue(dueDates: string[], todayISO: string): string | null {
  const recent = dueDates.filter(
    (d) => daysBetweenISO(d, todayISO) <= STALE_DUE_DAYS,
  );
  return (recent.length > 0 ? recent : dueDates).sort()[0] ?? null;
}

export function billsIn(
  cards: CardRecord[],
  statements: StatementRecord[],
  cycles: CycleRecord[],
  todayISO: string,
): BillsIn {
  const month = todayISO.slice(0, 7);
  let inCount = 0;
  let allInPaid = true;
  const awaited: AwaitedBill[] = [];
  const dueDates: string[] = [];
  const undated: CardRecord[] = [];

  for (const card of cards) {
    const ownCycles = cycles.filter((c) => c.cardId === card.id);
    const actionable = actionableCycle(ownCycles);
    if (actionable !== null && cycleNeedsPayment(actionable)) {
      if (actionable.dueDateISO === null) undated.push(card);
      else dueDates.push(actionable.dueDateISO);
    }

    const own = statements.filter((s) => s.cardId === card.id);
    const expectedISO = expectedNextStatementISO(own);
    if (own.some((s) => s.period === month)) {
      inCount += 1;
      // The actionable cycle, not this month's: a newer statement's bill
      // is what's owed now. No cycle: status unknown, so not "paid".
      if (actionable === null || cycleNeedsPayment(actionable))
        allInPaid = false;
      continue;
    }

    const usualDay = usualStatementDay(own);
    // Can't tell when it comes: don't count it.
    if (expectedISO === null || usualDay === null) continue;
    const daysLate = daysBetweenISO(expectedISO, todayISO);
    if (daysLate > STALE_AFTER_DAYS) continue;
    // Its next statement belongs to a later month: no bill this month.
    if (expectedISO.slice(0, 7) > month) continue;
    awaited.push({
      card,
      expectedISO,
      usualDay,
      late: daysLate > LATE_AFTER_DAYS,
    });
  }
  awaited.sort((a, b) => a.expectedISO.localeCompare(b.expectedISO));

  return {
    month,
    cardCount: inCount + awaited.length,
    inCount,
    allInPaid: inCount > 0 && allInPaid,
    awaited,
    earliestDueISO: earliestDue(dueDates, todayISO),
    undatedUnpaid: undated,
  };
}

/** The headline's payment line: `prefix` + the date (drawn emphasised). */
export interface PaymentLine {
  prefix: string;
  dateISO: string;
}

/** A timely update below the headline. `importCard` names the card whose
 * statement to import: the line ends with an Import link for it. */
export interface Nudge {
  text: string;
  importCard?: string;
}

/** The headline's words, each its own short line so they read as separate
 * updates: the next payment, then how many of the month's bills are in
 * (null for fewer than two cards), then nudges shown only when they apply
 * (an unknown due date, a statement past its usual day). */
export interface BillsInCopy {
  payment: PaymentLine | null;
  count: string | null;
  nudges: Nudge[];
}

export function billsInCopy(result: BillsIn, todayISO: string): BillsInCopy {
  const { month, cardCount, inCount, allInPaid, awaited } = result;
  const { earliestDueISO } = result;
  const allIn = awaited.length === 0;
  const bills = `${monthName(month)} bills`;
  const count =
    cardCount < 2
      ? null
      : allIn
        ? `All ${cardCount} ${bills} are ${allInPaid ? 'paid' : 'in'}`
        : `${inCount} of ${cardCount} ${bills} are in${allInPaid ? ' and paid' : ''}`;

  let payment: PaymentLine | null = null;
  if (earliestDueISO !== null) {
    const pastDays = daysBetweenISO(earliestDueISO, todayISO);
    payment = {
      // "Before", not "due": it errs a day early, which is the safe side.
      prefix:
        pastDays > STALE_DUE_DAYS
          ? 'A payment was due'
          : pastDays > 0
            ? 'Payment overdue since'
            : 'Next payment before',
      dateISO: earliestDueISO,
    };
  }

  const nudges: Nudge[] = [
    // No date to headline: name it, or the payment would go unmentioned.
    ...result.undatedUnpaid.map((card) => ({
      text: `${card.nickname}'s due date isn't known. Check its statement.`,
    })),
    // Worded as a habit, not a claim: a bank may skip a month with no
    // spend, and then no statement is coming at all.
    ...awaited
      .filter((a) => a.late)
      .map((a) => ({
        text: `${a.card.nickname}'s ${monthName(a.expectedISO.slice(0, 7))} statement usually comes by the ${ordinal(a.usualDay)}.`,
        importCard: a.card.nickname,
      })),
  ];
  return { payment, count, nudges };
}
