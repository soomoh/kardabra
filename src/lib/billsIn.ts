/**
 * "Are all the bills in?" — for paying a month's bills in one go without
 * letting any of them go overdue while waiting.
 *
 * Each card's usual statement day is learned from its history; its next
 * statement is expected around that day after its latest one. A card is
 * still to come when its bill isn't waiting to be paid and its next
 * statement should land before the last unpaid bill is due — it can still
 * join this batch. A card whose next statement lands after every unpaid
 * bill is due belongs to the next batch, so it isn't waited for.
 *
 * Waiting must never make a bill overdue: any unpaid bill due on or before
 * a still-to-come statement's expected day is "pay now".
 */

import type { CardRecord, CycleRecord, StatementRecord } from '../db/schema';
import { actionableCycle, cycleNeedsPayment } from './cycles';
import {
  daysBetweenISO,
  formatDateLabel,
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

export interface AwaitedBill {
  card: CardRecord;
  /** When the next statement should arrive. */
  expectedISO: string;
  /** Usual day of the month it's generated, e.g. 18. */
  usualDay: number;
  /** Expected more than a few days ago and still not imported. */
  late: boolean;
}

export interface PayNow {
  card: CardRecord;
  dueISO: string;
}

export interface BillsIn {
  cardCount: number;
  /** Cards whose bill is waiting to be paid, or that aren't waited for. */
  inCount: number;
  /** Still to come, earliest expected first. */
  awaited: AwaitedBill[];
  /** Unpaid bills due before a still-to-come statement arrives. */
  payNow: PayNow[];
  /** Earliest due date among unpaid bills. */
  earliestDueISO: string | null;
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

/** ISO date `days` after `iso`. */
function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function billsIn(
  cards: CardRecord[],
  statements: StatementRecord[],
  cycles: CycleRecord[],
  todayISO: string,
): BillsIn {
  const unpaid: { card: CardRecord; cycle: CycleRecord }[] = [];
  const others: CardRecord[] = [];
  for (const card of cards) {
    const cycle = actionableCycle(cycles.filter((c) => c.cardId === card.id));
    if (cycle !== null && cycleNeedsPayment(cycle))
      unpaid.push({ card, cycle });
    else others.push(card);
  }

  const dueDates = unpaid
    .map(({ cycle }) => cycle.dueDateISO)
    .filter((d): d is string => d !== null)
    .sort();
  const lastDueISO = dueDates.at(-1) ?? null;

  const awaited: AwaitedBill[] = [];
  for (const card of others) {
    const own = statements.filter((s) => s.cardId === card.id);
    const expectedISO = expectedNextStatementISO(own);
    const usualDay = usualStatementDay(own);
    // Can't tell when it comes: don't wait on it.
    if (expectedISO === null || usualDay === null) continue;
    const daysLate = daysBetweenISO(expectedISO, todayISO);
    if (daysLate > STALE_AFTER_DAYS) continue;
    const late = daysLate > LATE_AFTER_DAYS;
    // A late statement is always worth naming; an on-time one only when it
    // can still be paid with the bills already in.
    if (late || (lastDueISO !== null && expectedISO <= lastDueISO)) {
      awaited.push({ card, expectedISO, usualDay, late });
    }
  }
  awaited.sort((a, b) => a.expectedISO.localeCompare(b.expectedISO));

  // The latest a still-to-come statement may arrive: its expected day plus
  // the days it can run late (a late one: from today). Any unpaid bill due
  // by then can't safely wait for it.
  const waitUntilISO = awaited
    .map((a) => addDaysISO(a.late ? todayISO : a.expectedISO, LATE_AFTER_DAYS))
    .sort()
    .at(-1);
  const payNow: PayNow[] =
    waitUntilISO === undefined
      ? []
      : unpaid
          .filter(
            ({ cycle }) =>
              cycle.dueDateISO !== null && cycle.dueDateISO <= waitUntilISO,
          )
          .map(({ card, cycle }) => ({ card, dueISO: cycle.dueDateISO! }))
          .sort((a, b) => a.dueISO.localeCompare(b.dueISO));

  return {
    cardCount: cards.length,
    inCount: cards.length - awaited.length,
    awaited,
    payNow,
    earliestDueISO: dueDates[0] ?? null,
  };
}

/** The headline's words: `lead` (how many bills are in, null for one card),
 * then the due-date sentence (`duePrefix` + `dueISO`, drawn emphasised), and
 * notes — what's still to come, what's late, what to pay now. */
export interface BillsInCopy {
  lead: string | null;
  duePrefix: string;
  dueISO: string | null;
  notes: string[];
}

function names(cards: CardRecord[]): string {
  const all = cards.map((c) => c.nickname);
  return all.length <= 1
    ? (all[0] ?? '')
    : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
}

export function billsInCopy(result: BillsIn, todayISO: string): BillsInCopy {
  const { cardCount, inCount, awaited, payNow, earliestDueISO } = result;
  const lead =
    cardCount < 2
      ? null
      : inCount === cardCount
        ? `All ${cardCount} bills are in`
        : `${inCount} of ${cardCount} bills are in`;
  const duePrefix =
    earliestDueISO !== null && earliestDueISO < todayISO
      ? 'One was due'
      : inCount === cardCount
        ? 'Pay before' // before, not by: leaves a day's buffer
        : 'First due';

  const notes: string[] = [];
  const coming = awaited.filter((a) => !a.late);
  if (coming.length > 0) {
    notes.push(
      `Still to come: ${coming
        .map(
          (a) =>
            `${a.card.nickname} around ${formatDateLabel(a.expectedISO, todayISO)}`,
        )
        .join(', ')}.`,
    );
  }
  for (const a of awaited.filter((a) => a.late)) {
    notes.push(
      `${a.card.nickname}'s statement usually comes by the ${ordinal(a.usualDay)} and isn't in yet.`,
    );
  }
  if (payNow.length > 0) {
    const which = names(payNow.map((p) => p.card));
    const before =
      awaited.length === 1
        ? `before ${awaited[0].card.nickname}'s statement arrives`
        : 'before the rest arrive';
    notes.push(
      payNow.length === 1
        ? `Pay ${which} now: it's due ${formatDateLabel(payNow[0].dueISO, todayISO)}, ${before}.`
        : `Pay ${which} now: they're due ${before}.`,
    );
  }
  return { lead, duePrefix, dueISO: earliestDueISO, notes };
}
