/** Shared data types for the statement parser. Every function under
 * src/parser/ takes and returns plain data (strings, arrays, these types)
 * — no Node or browser APIs — so the same code runs in tests, the app, and
 * (unchanged) a future web worker. */

/** One parsed transaction line from a statement.
 *
 * Sign convention: money OUT is negative (purchases, withdrawals); money
 * IN is positive (payments, refunds, cashback, deposits). This matches how
 * a card balance actually moves — a purchase increases what you owe, i.e.
 * moves the balance in the negative direction — and it's the convention
 * every downstream sum has to agree on, so it's pinned here once rather
 * than re-decided per feature.
 */
export interface Transaction {
  dateISO: string; // 'YYYY-MM-DD' — see dates.ts for why not a Date
  payee: string;
  amount: number; // money out negative, money in positive
}

/**
 * Fields read from the rows *above* the transaction table — statement
 * metadata such as due date, minimum due, and credit limit. Every field is
 * optional and independent: "parse, don't validate" — there's no separate
 * "is this a valid summary?" check, because a statement missing one or two
 * fields is still a valid, partial result (see summary.ts). Amounts share
 * Transaction's convention of representing money as a plain number, but
 * are always positive here (a due amount, a limit — never signed).
 */
export interface StatementSummary {
  statementDateISO?: string;
  paymentDueDateISO?: string;
  /** What the bank says is owed. A credit balance ("1,200.00 Cr" in the total
   * due cell) is 0 here, with the surplus in `creditBalance` — nothing is due. */
  totalDue?: number;
  minDue?: number;
  creditLimit?: number;
  /** Positive amount the bank owes the cardholder, when the statement closes
   * in credit. */
  creditBalance?: number;
  /** The bank's own reconciliation line, when printed (HDFC "Opening Bal −
   * Payment/Credit + Purchases/Debits + Finance Charges = Total Dues"; ICICI
   * "Previous Balance", "Payments and Other Credits", "Purchases and Other
   * Charges"; Axis "Opening Balance"). All positive magnitudes. */
  openingBalance?: number;
  paymentsTotal?: number;
  purchasesTotal?: number;
  chargesTotal?: number;
}

/** Something the parser chose to skip rather than fail on. Surfaced in import
 * review so a partial read is never silent. */
export interface ParseWarning {
  kind: 'skipped-row';
  /** 0-based row index in the file's rows. */
  row: number;
  reason: string;
}

/** The façade's return value — everything `parseStatement` recovers from
 * one file. */
export interface ParsedStatement {
  fileName: string;
  last4: string | null;
  /** ISO 4217 code inferred from the statement text (₹/Rs/INR → 'INR');
   * 'INR' when nothing says otherwise. */
  currency: string;
  summary: StatementSummary;
  transactions: Transaction[];
  warnings: ParseWarning[];
}
