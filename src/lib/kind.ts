/**
 * What kind of line a card transaction is: a label, not a category. It
 * says what the line *is* (a purchase, the bill payment, a fee), never what
 * the money was spent on; categorising is the accounting tool's job.
 *
 * The sign carries the direction, the kind carries the subject: a fee
 * reversal ("PETRO SURCHARGE WAIVER", a credit) is still a `fee`, so fees
 * net out wherever they are summed. Likewise for interest and EMI lines.
 *
 * Whether a credit is the bill payment is not decided here: it comes from
 * lib/spend.ts's detectPayment (keyword, amount match, the user's pick), and
 * the caller passes it in, so this label can never disagree with spend.
 */

import { withoutOfferMarker } from './merchant';

export const TRANSACTION_KINDS = [
  'purchase',
  'refund',
  'cashback',
  'payment',
  'fee',
  'interest',
  'emi',
  'forex-markup',
] as const;

export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Checked in order, first match wins. Matched against the upper-cased payee
 * with dashes and whitespace runs collapsed to single spaces.
 * - Cashback first: "CASHBACK ON EMI" is cashback, not an instalment.
 * - EMI next: every part of an instalment plan ("EMI INTEREST", "GST ON EMI
 *   PROCESSING FEE") stays together for the EMI tracker.
 * - Forex markup before fee and interest: "CONSOLIDATED FCY MARKUP FEE" and
 *   "GST ON FOREX MARKUP" are the cost of spending abroad, not card fees.
 * - Interest before fee: "FINANCE CHARGES" also says CHARGES.
 * A shop whose name holds one of these words ("EV CHARGE STATION") gets the
 * wrong label; accepted, as the amount and spend are unaffected. */
const KIND_PATTERNS: [
  Exclude<TransactionKind, 'purchase' | 'refund' | 'payment'>,
  RegExp,
][] = [
  ['cashback', /\bCASH ?BACK\b/],
  ['emi', /\bEMI\b/],
  // On a card statement "markup" only ever means the foreign-currency
  // markup ("CONSOLIDATED FCY MARKUP FEE", "DCC MARKUP"), so the word alone
  // decides; no "FCY … MARKUP" pattern, whose .* is slow on hostile text.
  ['forex-markup', /\bMARK ?UP\b/],
  // Dynamic currency conversion: "1.75% on all DCC Transaction" is the
  // markup for paying in rupees abroad, charged as its own line. DCC alone
  // isn't enough: a shop can be called that ("DCC SWEETS").
  [
    'forex-markup',
    /\bON ALL DCC\b|\bDCC (?:TRANSACTIONS?|TXNS?|FEES?|CHARGES?)\b/,
  ],
  ['interest', /\bINTEREST\b|\bFINANCE CHARGES?\b|\bFIN CHGS?\b/],
  [
    'fee',
    /\bFEES?\b|\bCHARGES?\b|\bCHGS?\b|\bSURCHARGES?\b|\b[CSI]?GST\b|\bOVER ?LIMIT\b/,
  ],
];

/** The kind of one transaction. `isPayment` is detectPayment's verdict for
 * this row. Anything unmatched is a purchase when money went out and a
 * refund when it came in (a merchant credit that isn't the bill payment). */
export function transactionKind(
  payee: string,
  amount: number,
  isPayment: boolean,
): TransactionKind {
  if (isPayment) return 'payment';
  const text = withoutOfferMarker(payee)
    .toUpperCase()
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ');
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return amount > 0 ? 'refund' : 'purchase';
}
