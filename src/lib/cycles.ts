/**
 * Which of a card's cycles is actually actionable.
 *
 * Domain rule (this is a fact about how card billing works, not a UI
 * preference): each statement's "Total Amount Due" already includes any
 * unpaid balance carried forward from earlier statements — that's the
 * "Opening Bal" term in the statement's own Account Summary line. So the
 * moment a newer statement exists, every older cycle stops being
 * independently payable: whatever was left unpaid on it has been rolled
 * into the newer total. The bank has done the reconciliation for us.
 *
 * Consequence: exactly one cycle per card — the latest — is ever
 * actionable (payable, remindable, countable as "unpaid"). Older unpaid
 * cycles are "settled by successor": not paid, not outstanding, just
 * absorbed. This rule is derived fresh from the data every time rather
 * than stored as a flag, so it can never go stale; anything that counts,
 * sums, or reasons about which cycle to act on must go through these two
 * functions.
 */

import type { CycleRecord } from '../db/schema';

/** The one cycle of `cycles` that is currently actionable — the latest by
 * period ('YYYY-MM' compares lexicographically = chronologically) — or
 * null for an empty list. Assumes all cycles belong to the same card. */
export function actionableCycle(cycles: CycleRecord[]): CycleRecord | null {
  if (cycles.length === 0) return null;
  return cycles.reduce((latest, cycle) =>
    cycle.period > latest.period ? cycle : latest,
  );
}

/** True when `period` has been superseded by a newer cycle in `cycles`
 * and is therefore settled-by-successor (see the header comment). */
export function isSettledBySuccessor(
  period: string,
  cycles: CycleRecord[],
): boolean {
  const actionable = actionableCycle(cycles);
  return actionable !== null && period < actionable.period;
}

/** The slice of CycleRecord the needs-payment question depends on — a
 * subset so callers/tests don't have to build a full record. */
export interface PaymentFacts {
  paidAt?: string;
  totalDue?: number;
  spend?: number;
}

/**
 * Does this cycle actually require a payment from the user?
 *
 * False when any of these hold, checked in trust order:
 *   1. the user marked it paid;
 *   2. the bank says the total due is zero — `totalDue === 0` is a KNOWN
 *      zero from the statement's own summary, entirely different from
 *      `undefined` ("the file had no total"); sentinels are not zero,
 *      and this is the one place the distinction pays rent — a ₹0 bill
 *      with a printed due date must never show as overdue;
 *   3. the file had no total AND the cycle had no spend — a statement
 *      with zero purchases and no bill figure has nothing to pay (any
 *      unpaid carry-forward from before would appear in this statement's
 *      own transactions as a balance line or in its total, which this
 *      bank's export doesn't carry — so "no spend" is the best available
 *      evidence of "nothing due").
 *
 * Everything that counts, sums, or warns must go through this predicate,
 * not through ad-hoc paidAt checks.
 */
export function cycleNeedsPayment(cycle: PaymentFacts): boolean {
  if (cycle.paidAt !== undefined) return false;
  if (cycle.totalDue === 0) return false;
  if (cycle.totalDue === undefined && cycle.spend === 0) return false;
  return true;
}
