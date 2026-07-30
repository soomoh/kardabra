/**
 * Builds a local, shareable report of the files the parser could not handle.
 *
 * The report contains only file names and the parser's own diagnosis — never
 * statement contents — so a user can send it to get a new bank's format
 * supported without exposing their financial data. It is generated on the
 * device and downloaded locally; nothing is uploaded anywhere.
 */
import type { StatementErrorKind } from '../parser';

export interface FeedbackEntry {
  fileName: string;
  /** 'rejected' — a recognized-but-unsupported layout; 'failed' — unparseable. */
  kind: 'rejected' | 'failed';
  errorKind?: StatementErrorKind; // present for 'rejected'
  detail: string; // the advice (rejected) or the error message (failed)
}

/** A plain-text report a user can attach to a bug report. `generatedAt` is a
 * parameter so the output is deterministic under test. */
export function buildFeedbackReport(
  entries: FeedbackEntry[],
  generatedAt: Date = new Date(),
): string {
  const lines = [
    'Kardabra — unrecognized statement report',
    `Generated: ${generatedAt.toISOString()}`,
    'Contains file names and parser diagnostics only — no statement contents.',
    '',
    ...entries.map((entry) =>
      entry.kind === 'rejected'
        ? `REJECTED  ${entry.fileName}  [${entry.errorKind}]  ${entry.detail}`
        : `FAILED    ${entry.fileName}  ${entry.detail}`,
    ),
  ];
  return lines.join('\n');
}
