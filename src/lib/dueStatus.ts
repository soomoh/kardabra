/**
 * Turns a cycle's due-date facts into what the dashboard should say and
 * how urgent it should look. Pure function (the "seam"): the component
 * that renders this just switches on `tone` for a CSS class and prints
 * `label` verbatim, no date logic in the component itself.
 */

import { daysBetweenISO, formatDateLabel } from './dates';
import { cycleNeedsPayment, type PaymentFacts } from './cycles';

export type DueTone = 'paid' | 'ok' | 'soon' | 'overdue' | 'unknown';

export interface DueStatus {
  label: string;
  tone: DueTone;
}

/** The minimal slice of CycleRecord this function needs — a subset, not
 * the whole record, so callers (and tests) don't have to build a full
 * CycleRecord just to ask this question. */
export interface DueFacts extends PaymentFacts {
  dueDateISO: string | null;
}

/**
 * Decide what to tell the user about a cycle's due date, as of `todayISO`.
 *
 * Order of checks matters here: "needs no payment" always wins even if
 * the due date has technically passed — once paid (or when the bill is a
 * known zero), "overdue" would be a lie (e.g. a card with no transactions
 * in the period showing 'Overdue' over a ₹0 balance). "unknown" comes
 * next because there's no date to reason about at all (dueDateISO is the
 * null sentinel — see schema.ts's comment on CycleRecord). Only once
 * those are ruled out does this compare against today.
 */
export function dueStatus(todayISO: string, cycle: DueFacts): DueStatus {
  if (!cycleNeedsPayment(cycle)) {
    if (cycle.paidAt !== undefined) {
      return { label: 'Paid ✓', tone: 'paid' };
    }
    // Not user-paid, so cycleNeedsPayment said no for an amount reason:
    // a known-zero bill, or a no-spend cycle with no bill figure.
    return cycle.totalDue === 0
      ? { label: 'Nothing due ✓', tone: 'paid' }
      : { label: 'No spend this cycle', tone: 'paid' };
  }
  if (cycle.dueDateISO === null) {
    return { label: 'Due date unknown', tone: 'unknown' };
  }

  const daysUntilDue = daysBetweenISO(todayISO, cycle.dueDateISO);

  // A due date more than a month gone means a whole new statement cycle
  // has passed without an upload — at that point "overdue" is more likely
  // stale data (bill long since paid, newer statement never imported)
  // than a genuinely forgotten payment, and screaming OVERDUE at the user
  // erodes trust in the reminders that matter (e.g. importing 4 months of
  // history at once would otherwise read "Overdue by 67 days").
  if (daysUntilDue < -30) {
    return {
      label: `Was due ${formatDateLabel(cycle.dueDateISO, todayISO)}. Import a newer statement to update.`,
      tone: 'unknown',
    };
  }
  if (daysUntilDue < 0) {
    return { label: `Overdue by ${-daysUntilDue} days`, tone: 'overdue' };
  }
  if (daysUntilDue === 0) {
    return { label: 'Due today', tone: 'soon' };
  }
  // <= 3 days out counts as "soon" (same threshold whether it's 1, 2 or 3
  // days away); 4+ days is still 'Due in N days' but with the calmer 'ok'
  // tone.
  if (daysUntilDue <= 3) {
    return { label: `Due in ${daysUntilDue} days`, tone: 'soon' };
  }
  return { label: `Due in ${daysUntilDue} days`, tone: 'ok' };
}
