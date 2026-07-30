/**
 * Spots the charges that signal something about the card itself:
 * interest and late fees (a carried balance), and the annual fee (the
 * card's one real ownership cost). A sibling to lib/spend.ts, but a
 * different question: spend.ts decides whether a transaction counts as
 * spend at all; this module asks "is this line a cost signal worth
 * flagging" — a debit can be both at once (an annual fee is spend AND
 * a fee).
 *
 * Deliberately narrow: the only *card cost* tracked is the annual fee.
 * GST, surcharges, processing/cash-advance/redemption fees and SMS
 * charges are transactional friction — a per-purchase cost of using the
 * card, not of owning it — so they're not classified here at all. (A
 * surcharge waiver still nets correctly into spend via lib/spend.ts,
 * which nets every non-payment credit regardless of wording.)
 * There is also no visible "trailing cost report" anywhere: interest/late
 * totals surface only as the per-statement hint in CardDetail, and the
 * annual fee only as a discrepancy note against the user's own fee label.
 *
 * Classification happens at READ time, never stored on the transaction
 * record — the same read-time approach lib/spend.ts uses. classifyCharge
 * is a cheap pure function over a string, so storing its result would
 * mean migrating (or dropping and re-importing) every already-imported
 * transaction just to add or fix a keyword; deriving it fresh on every
 * render means a better keyword list heals every past statement for
 * free. Contrast CycleRecord.spend (db/schema.ts), which IS stored: the
 * dashboard needs a card's spend total without loading every transaction
 * for every card on every render, so that one number earns its
 * denormalization. Nothing here needs to be visible without opening a
 * card's own detail view, so nothing here is stored.
 */

import { daysBetweenISO } from './dates';

export type ChargeCategory = 'interest' | 'late' | 'annual-fee';

/** category -> keyword list, matched case-insensitively against the
 * payee (data over code: supporting a new keyword is adding a string,
 * never a branch). No two categories' keywords overlap as substrings,
 * so CATEGORY_ORDER below only pins determinism, not any real payee's
 * outcome today. */
const CHARGE_PATTERNS: Record<ChargeCategory, string[]> = {
  interest: ['finance charge', 'interest'],
  late: ['late fee', 'late payment', 'overlimit', 'over limit'],
  'annual-fee': ['annual fee', 'membership fee', 'renewal fee', 'joining fee'],
};

/** Fixed category iteration order for classifyCharge — matters only for
 * a payee that could match keywords from two categories at once (none
 * do today; see CHARGE_PATTERNS's comment). Most severe first, purely
 * for stability. */
const CATEGORY_ORDER: ChargeCategory[] = ['interest', 'late', 'annual-fee'];

/** Which charge category `payee` belongs to, or null if it isn't a
 * tracked charge line at all (an ordinary purchase, a bill payment, a
 * surcharge/GST line — see the header on why those are deliberately
 * untracked). */
export function classifyCharge(payee: string): ChargeCategory | null {
  const normalized = payee.toLowerCase();
  for (const category of CATEGORY_ORDER) {
    if (
      CHARGE_PATTERNS[category].some((keyword) => normalized.includes(keyword))
    ) {
      return category;
    }
  }
  return null;
}

/**
 * Sign-aware charge totals across a set of transactions, one number per
 * category (always present, 0 when nothing matched — a plain lookup
 * table for callers, never a possibly-missing key).
 *
 * `totals[category] -= txn.amount` is the same trick spend.ts's netSpend
 * uses for debits: since amounts are negative for money out (parser's
 * sign convention), subtracting a charge-classified DEBIT's (negative)
 * amount ADDS its magnitude to the total, while subtracting a charge-
 * classified CREDIT's (positive) amount SUBTRACTS it — a fee reversal
 * hands the charge back, netting against the same bucket its matching
 * debit added to. One line handles both directions; no separate
 * debit/credit branch needed.
 *
 * A credit that matches no charge keyword (a bill payment, a cashback)
 * is `classifyCharge`-null and therefore never touches this table at
 * all. That's the catastrophic failure mode this function must never
 * produce: a large bill-payment credit (routinely tens of thousands of
 * rupees) misread as a "fee reversal" would swamp every real total on
 * the card — see the catastrophic-mode test, same shape as
 * spend.test.ts's pin on netSpend.
 */
export function chargeTotals(
  transactions: { payee: string; amount: number }[],
): Record<ChargeCategory, number> {
  const totals: Record<ChargeCategory, number> = {
    interest: 0,
    late: 0,
    'annual-fee': 0,
  };
  for (const txn of transactions) {
    const category = classifyCharge(txn.payee);
    if (category === null) continue;
    totals[category] -= txn.amount;
  }
  return totals;
}

/**
 * Net annual fee actually charged in the trailing 365-day window ending
 * `todayISO` (a fee debit adds, a fee reversal credit subtracts — same
 * sign-aware netting as chargeTotals, which this delegates to). This is
 * the number CardDetail's fee-label discrepancy note compares against
 * what the card was promised to cost; it is never shown as a report of
 * its own.
 *
 * Window boundary, inclusive on both ends: a transaction dated exactly
 * 365 days before `todayISO` (the "this day last year" anniversary) IS
 * counted; one dated 366 days before is not. Computed via daysBetweenISO
 * (calendar-field day counting, not millisecond-epoch subtraction) for
 * the same DST-safety reasons documented in lib/dates.ts's header. A
 * transaction dated in the future relative to `todayISO` (age < 0 —
 * shouldn't occur in real imported data) is excluded too, as a
 * defensive floor rather than a real expected case.
 */
export function annualFeeNet(
  transactions: { payee: string; amount: number; dateISO: string }[],
  todayISO: string,
): number {
  const inWindow = transactions.filter((txn) => {
    const ageInDays = daysBetweenISO(txn.dateISO, todayISO);
    return ageInDays >= 0 && ageInDays <= 365;
  });
  return chargeTotals(inWindow)['annual-fee'];
}
