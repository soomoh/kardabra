/**
 * Structured failures for the statement parser.
 *
 * A bare `Error(message)` is fine for a script that prints the message and
 * moves on, but a UI needs to branch on *what kind* of failure happened
 * (show a different message for "wrong statement type" vs "couldn't read
 * this file at all") without parsing English out of an error string.
 * `StatementError` splits a failure into three parts: a machine-checkable
 * `kind`, a plain `message` (what went wrong), and `advice` (what the user
 * should do next) — every failure states both.
 */

/**
 * Not exhaustive by design — new failure kinds get added here as new
 * cases are handled elsewhere in the parser, so treat this union as
 * open-ended rather than a fixed final set.
 */
export type StatementErrorKind =
  | 'savings-statement' // layout 1 (withdrawal/deposit columns): a bank account, not a card
  | 'no-table' // no header row with date + description + amount columns
  | 'unrecognised-date' // a date cell matched none of the known formats
  | 'not-excel' // file has neither the .xlsx (zip) nor legacy .xls (OLE2) magic bytes
  | 'unreadable-workbook' // Excel signature, but damaged or with no sheets
  | 'too-large' // over the size cap (import/read.ts MAX_FILE_BYTES); never read
  | 'pdf-locked'; // a password-protected PDF the user chose not to unlock

export class StatementError extends Error {
  readonly kind: StatementErrorKind;
  readonly advice: string;

  constructor(kind: StatementErrorKind, message: string, advice: string) {
    super(message);
    this.name = 'StatementError';
    this.kind = kind;
    this.advice = advice;
  }
}
