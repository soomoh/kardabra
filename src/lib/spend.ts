/**
 * What "spend" means for a statement, and which credit(s) are the bill
 * payment.
 *
 * A statement's credits (money in) are two different things wearing the
 * same sign: the monthly BILL PAYMENT that settles the previous cycle's
 * balance, and SPEND ADJUSTMENTS (refunds, cashback, reversals) that hand
 * back part of what was spent this cycle. The bill payment is NOT negative
 * spending (it's last month's money leaving a bank account); an adjustment
 * IS (the bank returning part of a purchase). So spend must exclude the
 * payment but subtract the adjustments.
 *
 * The payment is a SET, not a single transaction: a user can pay a bill in
 * installments within one cycle (two BPPY lines, say), so "the payment" can
 * legitimately be several rows. This module picks out that whole set.
 *
 * How we tell the set apart — a confidence ladder, tried in order, the
 * first rung that applies wins (see `identifyPaymentIndices`):
 *
 *   1. an explicit user OVERRIDE, when supplied — the user looked at the
 *      statement and said "these rows are the payment" (or "none of them
 *      are"). Always wins: a human looking at their own bank statement
 *      knows more than any heuristic below.
 *   2. a PAYMENT KEYWORD match on the payee — every credit whose payee
 *      mentions 'payment', 'bppy' or 'bbps' (see PAYMENT_KEYWORDS below).
 *      This is how splits are caught automatically: every BPPY line in a
 *      two-part payment matches, so all of them are excluded together.
 *   3. an AMOUNT MATCH against the prior statement's expected due — no
 *      keyword fired, but one credit's amount lands within tolerance of
 *      what was owed (catches a no-keyword payment like 'TELE TRANSFER
 *      CREDIT' whose payee gives no hint, but whose amount gives it away).
 *   4. the LARGEST-CREDIT fallback — no keyword, no prior bill to match
 *      against, so the biggest credit on the statement is assumed to be
 *      the payment (a payment clears a whole month's balance, so it's
 *      almost always larger than any single refund or cashback). This is
 *      the least certain signal, kept only as a last resort now that
 *      better signals are tried first.
 *   5. no credits at all — nothing to exclude.
 *
 * Why keyword beats amount-match beats largest-credit, not the reverse:
 * each rung is progressively less certain. A keyword is the statement
 * itself telling us "this is a payment" — a fact, not an inference. An
 * amount match is circumstantial (a refund could coincidentally equal the
 * prior bill) but still a real signal. Largest-credit is pure magnitude
 * with no corroborating evidence at all, so it only runs when there's
 * nothing better to go on.
 *
 * Deliberately NOT attempted: subset-sum search for a no-keyword SPLIT
 * payment (e.g. two unlabelled transfers that together equal the prior
 * due, but neither alone does). That is genuinely ambiguous — several
 * different subsets of a statement's credits can sum to the same total by
 * coincidence — and a wrong automatic guess here is exactly the kind of
 * silent money error this module is designed to avoid. The manual
 * override (rung 1) is the intended fix for that case, not a smarter
 * search.
 */

// Narrow on purpose: generic words like 'neft', 'imps' or 'transfer' also
// describe non-payment credits (a refund routed back via NEFT, a person-
// to-person transfer that happens to land on a card's linked account). A
// false positive here would exclude a real credit from spend and OVERSTATE
// it — the more dangerous direction, since a payment miscounted as spend
// would UNDERSTATE it instead. A narrow keyword list produces false
// negatives (a payment falls through to a lower rung), which is the safer
// failure: rungs 3 and 4 below exist precisely to catch what rung 2 misses.
export const PAYMENT_KEYWORDS = ['payment', 'bppy', 'bbps'];

/** Does this payee mention a payment keyword? Case-insensitive substring
 * match — bank payee strings carry inconsistent casing ('BPPY CC PAYMENT'
 * vs 'Bppy Cc Payment') and this only needs to catch the word, not parse
 * the payee's structure. */
export function hasPaymentKeyword(payee: string): boolean {
  const lower = payee.toLowerCase();
  return PAYMENT_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** One payment row, identified by VALUE (amount + payee), not by array
 * index. This is how a user's manual pick is stored (CycleRecord.
 * paymentOverride) and re-matched against a fresh transaction list —
 * statements are deleted and recreated whole on every re-import (see
 * db.ts's putStatementWithTransactions), so no transaction ever has a
 * stable id an index-based reference could survive across that. */
export interface PaymentMark {
  amount: number; // positive (a credit)
  payee: string;
}

/**
 * Match each `override` entry to a transaction by (amount, payee), each
 * transaction consumed at most once. Walks the override entries in order;
 * for each, finds the first not-yet-matched transaction with an equal
 * amount and payee. An override entry with no remaining match is simply
 * skipped (the statement changed since the override was saved — e.g. a
 * corrected re-import — so that mark no longer applies; there is nothing
 * safe to guess in its place).
 */
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

/**
 * The confidence-ranked payment SET: which indices of `transactions` are
 * the bill payment. See this module's header comment for the full ladder;
 * this function is that ladder, one branch per rung.
 *
 * `opts.override`, when it is an array (not `undefined`), always wins —
 * including an EMPTY array, which is the user's real, distinct assertion
 * "there is no payment on this statement" (sentinels are not zero: `[]`
 * here means something different from "not specified", the same way
 * CycleRecord.dueDateISO's `null` means something different from a missing
 * field — see schema.ts).
 */
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
    const tolerance = Math.max(1, priorExpectedDue * 0.005); // 0.5% or ₹1
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

/** Net spend for a statement (positive number): every debit adds, every
 * credit EXCEPT the identified payment set subtracts. Signature takes the
 * payment index set directly (from `identifyPaymentIndices`) rather than
 * computing it itself, so a caller that already has the set (to label rows
 * in the UI, say) never derives it twice and risks disagreeing with
 * itself. Sign convention as everywhere: amounts are negative for money
 * out. */
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

/** Sum of every positive amount (every credit) in `transactions` —
 * payments and adjustments together, the input `billUnderpaid` below
 * reconciles against the prior bill. */
export function sumOfCredits(transactions: { amount: number }[]): number {
  let total = 0;
  for (const txn of transactions) {
    if (txn.amount > 0) total += txn.amount;
  }
  return total;
}

/**
 * Does this statement's total credits fall short of the prior statement's
 * amount due — i.e. last cycle probably wasn't paid in full, so interest
 * may be levied next time? The soft-warning signal the user asked for.
 *
 * The question is "did this cycle's total CREDITS cover the prior bill",
 * not "did the identified payment alone cover it". A refund genuinely
 * reduces what's owed — if a ₹20,000 bill is met with an ₹18,000 payment
 * plus a ₹2,500 refund, the bill is covered, full stop, even though the
 * payment transaction alone falls short. Comparing only the identified
 * payment amount would produce a false warning in exactly this
 * refund-plus-partial-payment case. Summing every credit sidesteps the
 * question of which credit *is* the payment entirely — this check doesn't
 * need `identifyPaymentIndices` at all.
 *
 * `priorExpectedDue` is the previous statement's Total Amount Due, or its
 * spend when the bank's export carried no total (the best proxy for what
 * was owed). Returns false — no warning — when there's nothing to judge
 * against (no prior statement, or nothing was owed: `priorExpectedDue`
 * null or <= 0), or when total credits cleared the bill within a small
 * tolerance: autopay rounds to whole rupees, and *over*crediting is not a
 * shortfall.
 */
export function billUnderpaid(
  creditsTotal: number,
  priorExpectedDue: number | null,
): boolean {
  if (priorExpectedDue === null || priorExpectedDue <= 0) return false;
  const tolerance = Math.max(1, priorExpectedDue * 0.005); // 0.5% or ₹1
  return priorExpectedDue - creditsTotal > tolerance;
}
