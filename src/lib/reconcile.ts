/**
 * The totals check: does what the parser read add up to what the bank says?
 *
 * Every parser miss — a dropped row, a credit read as a debit, a foreign
 * amount taken as rupees — shows up as a statement whose transactions don't
 * add up to its own printed totals. Checking that turns silent misreads into
 * a visible warning.
 *
 * Needs the statement's opening balance and total due (or credit balance);
 * without both there is nothing to check against and the result says so.
 * When the bank also prints its own components (payments, purchases,
 * charges), they narrow down which side is off.
 */

import type { StatementSummary } from '../parser';

export type Reconciliation =
  | { status: 'unknown' }
  | { status: 'ok' }
  | {
      status: 'mismatch';
      /** What the bank says is owed at the close (credit balance negative). */
      expectedClosing: number;
      /** Opening + debits − credits, from the rows that were read. */
      computedClosing: number;
      /** Which side looks wrong, when the bank printed its components. */
      likely: 'debits' | 'credits' | 'unclear';
    };

/** Rounding slack: a rupee, or 0.1% on large statements (banks round the
 * printed total; HDFC prints 7161.94 as "7162"). */
function tolerance(...values: number[]): number {
  return Math.max(1, 0.001 * Math.max(...values.map(Math.abs)));
}

export function reconcile(
  summary: StatementSummary,
  transactions: { amount: number }[],
): Reconciliation {
  const { openingBalance, totalDue, creditBalance } = summary;
  if (openingBalance === undefined) return { status: 'unknown' };
  if (totalDue === undefined && creditBalance === undefined) {
    return { status: 'unknown' };
  }

  let debits = 0;
  let credits = 0;
  for (const { amount } of transactions) {
    if (amount < 0) debits -= amount;
    else credits += amount;
  }
  const expectedClosing = (totalDue ?? 0) - (creditBalance ?? 0);
  const computedClosing = openingBalance + debits - credits;
  const slack = tolerance(expectedClosing, computedClosing, debits, credits);
  if (Math.abs(expectedClosing - computedClosing) <= slack) {
    return { status: 'ok' };
  }
  const near = (a: number | undefined, b: number) =>
    a !== undefined && Math.abs(a - b) <= tolerance(a, b);
  const bankDebits =
    summary.purchasesTotal !== undefined
      ? summary.purchasesTotal + (summary.chargesTotal ?? 0)
      : undefined;
  const debitsOk = near(bankDebits, debits);
  const creditsOk = near(summary.paymentsTotal, credits);

  // The opening balance is stored as a magnitude and banks don't always mark
  // a credit opening ("Previous Balance 500.00 Cr"). Reading it as a credit
  // is accepted only when the bank's own payment and purchase totals confirm
  // the rows were read right — otherwise a payment misread as a purchase
  // could "add up" this way too, hiding exactly the misread this check is for.
  const fromCreditOpening = -openingBalance + debits - credits;
  if (
    debitsOk &&
    creditsOk &&
    Math.abs(expectedClosing - fromCreditOpening) <= slack
  ) {
    return { status: 'ok' };
  }

  const likely =
    debitsOk && !creditsOk
      ? 'credits'
      : creditsOk && !debitsOk
        ? 'debits'
        : 'unclear';
  return { status: 'mismatch', expectedClosing, computedClosing, likely };
}
