/**
 * What can honestly be said about a statement once a newer one exists.
 *
 * Its due date is no longer a deadline either way: the newest statement's
 * total is what's owed (lib/cycles.ts). But whether THIS bill was paid is
 * only known from the following month's statement, where its payment
 * appears. With that month missing, the answer is "unknown" — never a
 * claim that it was carried forward or paid.
 */
import { billUnderpaid, priorExpectedDue } from './spend';
import { nextPeriod } from './dates';

export type OlderBillStatus =
  /** The user marked it paid. */
  | { kind: 'marked-paid' }
  /** The next month's credits (payments, and refunds — spend.ts counts
   * both) cover it. Worded "covered", not "paid", for that reason. */
  | { kind: 'covered'; by: string }
  /** The next month's credits fall short. */
  | { kind: 'not-covered'; by: string }
  /** The next month's statement, which would show the payment, is missing. */
  | { kind: 'unknown'; missing: string }
  /** The statement printed a ₹0 total. */
  | { kind: 'nothing-due' }
  /** No bill amount to judge the payment against. */
  | { kind: 'no-amount' };

export function olderBillStatus(
  statement: { period: string; totalDue?: number },
  cycle: { spend?: number; paidAt?: string } | undefined,
  /** The next newer imported statement and its credits (payments plus
   * refunds), if any. */
  next: { period: string; credits: number } | undefined,
): OlderBillStatus {
  if (cycle?.paidAt !== undefined) return { kind: 'marked-paid' };
  const following = nextPeriod(statement.period);
  if (next === undefined || next.period !== following) {
    return { kind: 'unknown', missing: following };
  }
  if (statement.totalDue === 0) return { kind: 'nothing-due' };
  const owed = priorExpectedDue(next.period, statement, cycle);
  // A spend-only estimate at or below zero is no amount to judge against.
  if (owed === null || owed <= 0) return { kind: 'no-amount' };
  // The same rule as the newer row's "didn't cover last month's bill"
  // hint, so the two rows can never disagree.
  return billUnderpaid(next.credits, owed)
    ? { kind: 'not-covered', by: next.period }
    : { kind: 'covered', by: next.period };
}
