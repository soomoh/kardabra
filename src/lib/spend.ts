/**
 * What "spend" means for a statement, and which credit(s) are the bill
 * payment.
 *
 * Credits are two different things with the same sign: the BILL PAYMENT
 * (last month's money leaving a bank account — not negative spending) and
 * ADJUSTMENTS (refunds, cashback, reversals — the bank returning part of a
 * purchase). Spend excludes the payment and subtracts the adjustments. The
 * payment can be several rows (a bill paid in instalments).
 *
 * The payment set comes from a confidence ladder, most certain first
 * (identifyPaymentIndices):
 *   1. the user's OVERRIDE — they looked at their statement;
 *   2. a PAYMENT KEYWORD on the payee — the statement says so itself, and
 *      every line of a split payment matches;
 *   3. an AMOUNT MATCH with the prior statement's expected due — catches an
 *      unlabelled payment ('TELE TRANSFER CREDIT');
 *   4. the LARGEST CREDIT — a payment clears a month's balance, so it is
 *      almost always bigger than any refund; least certain, last resort;
 *   5. no credits — nothing to exclude.
 *
 * Not attempted: subset-sum for an unlabelled SPLIT payment. Several subsets
 * of credits can sum to the prior due by coincidence, and a wrong silent
 * guess is the error this module exists to avoid; the override covers it.
 */

import { previousPeriod } from './dates';

// Narrow on purpose: 'neft', 'imps', 'transfer' also describe refunds and
// person-to-person credits. A false positive drops a real credit from spend
// (overstating it); a false negative only falls through to rungs 3–4, the
// safer failure. "payment" counts only as a whole word ("XYZ PAYMENTS BANK
// REFUND" is a merchant refund). Matched against the lowercased payee with
// dashes and whitespace runs collapsed ("AUTO-DEBIT" -> "auto debit").
export const PAYMENT_KEYWORDS: RegExp[] = [
  /\bpayment\b/,
  /\bpymt\b/,
  /\bthank you\b/,
  /\bbppy\b/,
  /\bbbps\b/,
  /\bautopay\b/,
  /\bauto debit\b/,
];

// Payee text that vetoes a keyword match: a fee or its reversal is a charge
// line, not the bill payment, and a "... Payments Bank" merchant is just a
// merchant (listed for "PAYMENTS BANK ... PAYMENT" style narrations).
export const PAYMENT_EXCLUSIONS: RegExp[] = [
  /\bpayments bank\b/,
  /\bpayment gateway\b/,
  /\blate payment (fee|charge)/,
  /\blate fee\b/,
  /\breversal\b/,
];

/** Does this payee name a bill payment (and no exclusion)? Case-insensitive
 * — bank payee strings carry inconsistent casing ('BPPY CC PAYMENT' vs
 * 'Bppy Cc Payment'). */
export function hasPaymentKeyword(payee: string): boolean {
  const text = payee
    .toLowerCase()
    .replace(/[-\u2013\u2014]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (PAYMENT_EXCLUSIONS.some((re) => re.test(text))) return false;
  return PAYMENT_KEYWORDS.some((re) => re.test(text));
}

/** One payment row, identified by VALUE (amount + payee), not by index: a
 * re-import deletes and recreates a statement's rows, so no index survives.
 * How a user's manual pick is stored (CycleRecord.paymentOverride). */
export interface PaymentMark {
  amount: number; // positive (a credit)
  payee: string;
}

/** Indices of the rows the override names, each row used at most once. A
 * mark with no remaining match is skipped: the statement changed since it
 * was saved (a corrected re-import), and there is nothing safe to guess. */
function matchOverride(
  transactions: { payee: string; amount: number }[],
  override: PaymentMark[],
): number[] {
  const used = new Set<number>();
  const matched: number[] = [];
  for (const mark of override) {
    const index = transactions.findIndex(
      (txn, i) =>
        !used.has(i) && txn.amount === mark.amount && txn.payee === mark.payee,
    );
    if (index === -1) continue; // no (more) matching transaction — skip this mark
    used.add(index);
    matched.push(index);
  }
  return matched;
}

/** What a statement's payment is expected to clear, read off the PRIOR
 * statement: its Total Amount Due, or its spend when the export carried no
 * total (the best proxy for what was owed). null when unknown. */
export function expectedDue(
  priorTotalDue: number | undefined,
  priorSpend: number | undefined,
): number | null {
  return priorTotalDue ?? priorSpend ?? null;
}

/** expectedDue for the statement before `period`'s, or null when there is
 * none to compare with: the oldest statement, or one whose previous month
 * is missing — then "the statement before" is older than the bill this
 * month's payment paid, and matching against it would mislead. */
export function priorExpectedDue(
  period: string,
  priorStatement: { period: string; totalDue?: number } | undefined,
  priorCycle: { spend?: number } | undefined,
): number | null {
  if (priorStatement === undefined) return null;
  if (priorStatement.period !== previousPeriod(period)) return null;
  return expectedDue(priorStatement.totalDue, priorCycle?.spend);
}

/** How far a payment may be from the amount owed and still count as paying
 * it: autopay rounds to whole rupees, so 0.5% or ₹1, whichever is larger. */
export function paymentTolerance(owed: number): number {
  return Math.max(1, owed * 0.005);
}

/** The payment set as indices into `transactions` — the ladder in this
 * module's header, one branch per rung. An override that is an empty array
 * is the user saying "no payment here", distinct from no override. */
export function identifyPaymentIndices(
  transactions: { payee: string; amount: number }[],
  opts: { priorExpectedDue: number | null; override?: PaymentMark[] },
): number[] {
  if (opts.override !== undefined) {
    return matchOverride(transactions, opts.override);
  }

  const keywordIndices = transactions
    .map((txn, index) => ({ txn, index }))
    .filter(({ txn }) => txn.amount > 0 && hasPaymentKeyword(txn.payee))
    .map(({ index }) => index);
  if (keywordIndices.length > 0) return keywordIndices;

  const priorExpectedDue = opts.priorExpectedDue;
  if (priorExpectedDue !== null) {
    const tolerance = paymentTolerance(priorExpectedDue);
    let bestIndex = -1;
    let bestDistance = Infinity;
    transactions.forEach((txn, index) => {
      if (txn.amount <= 0) return;
      const distance = Math.abs(txn.amount - priorExpectedDue);
      if (distance > tolerance) return;
      if (distance < bestDistance) {
        bestIndex = index;
        bestDistance = distance;
      }
    });
    if (bestIndex !== -1) return [bestIndex];
  }

  let largestIndex = -1;
  let largestAmount = -Infinity;
  transactions.forEach((txn, index) => {
    if (txn.amount <= 0) return; // debit or zero: never a payment
    if (txn.amount > largestAmount) {
      largestIndex = index;
      largestAmount = txn.amount;
    }
  });
  if (largestIndex !== -1) return [largestIndex];

  return [];
}

/** Net spend (positive): debits add, every credit outside the payment set
 * subtracts. Takes the payment set rather than deriving it, so a caller that
 * also labels the rows can't disagree with itself. */
export function netSpend(
  transactions: { amount: number }[],
  paymentIndices: number[],
): number {
  const paymentSet = new Set(paymentIndices);
  let total = 0;
  transactions.forEach((txn, index) => {
    if (paymentSet.has(index)) return; // the payment: not spend
    total -= txn.amount; // debit (negative) adds; other credit (positive) subtracts
  });
  return total;
}

/** Total of every credit — payments and adjustments together. */
export function sumOfCredits(transactions: { amount: number }[]): number {
  let total = 0;
  for (const txn of transactions) {
    if (txn.amount > 0) total += txn.amount;
  }
  return total;
}

/**
 * Did this statement's credits fall short of the prior statement's expected
 * due — last bill probably not paid in full, so interest may follow?
 *
 * All credits count, not just the identified payment: a ₹20,000 bill met by
 * an ₹18,000 payment plus a ₹2,500 refund is covered. False when there is
 * nothing to judge (no prior bill, or nothing owed) or the shortfall is
 * within paymentTolerance; overpaying is never a shortfall.
 */
export function billUnderpaid(
  creditsTotal: number,
  priorExpectedDue: number | null,
): boolean {
  if (priorExpectedDue === null || priorExpectedDue <= 0) return false;
  return priorExpectedDue - creditsTotal > paymentTolerance(priorExpectedDue);
}
