/**
 * Builds a local, shareable report describing the files the parser genuinely
 * could not read, to help add support for their format.
 *
 * The report is generated on the device and downloaded locally — nothing is
 * uploaded. Each file's preview has numbers masked (amounts, account and card
 * numbers, dates-as-values), but may still contain text such as column headers
 * or descriptions from the top of the statement, so the report tells the user
 * to review it before sharing.
 */
import { previewRows, cleanText, type StatementErrorKind } from '../parser';
import type { FileOutcome } from './plan';

const PREVIEW_ROW_LIMIT = 12;
const CELL_CHAR_LIMIT = 40;

export interface FeedbackEntry {
  fileName: string;
  /** 'rejected' — a recognized-but-unsupported layout; 'failed' — unparseable. */
  kind: 'rejected' | 'failed';
  errorKind?: StatementErrorKind; // present for 'rejected'
  detail: string; // the advice (rejected) or the error message (failed)
  diagnostic?: string; // structural, number-masked preview (see fileDiagnostic)
}

/** Every run of digits becomes `#`, so amounts and account/card numbers are
 * hidden while the shape and any text labels remain legible. */
function maskNumbers(text: string): string {
  return text.replace(/\d/g, '#');
}

/** Most frequent value in a list — used for the "typical column count", which
 * tells at a glance how many columns the real rows have. */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    if (next > bestCount) {
      bestCount = next;
      best = value;
    }
  }
  return best;
}

/**
 * A structural, number-masked description of a file that couldn't be parsed:
 * its content type, row/column shape, and a short masked preview of the top
 * rows. Enough to diagnose a layout without exposing amounts or account numbers.
 */
export function fileDiagnostic(bytes: Uint8Array): string {
  const { contentType, rows } = previewRows(bytes);
  const shape =
    contentType === 'delimited'
      ? `delimited text, ~${mode(rows.map((r) => r.length))} columns, ${rows.length} rows`
      : `excel, ${rows.length} rows`;

  const preview = rows.slice(0, PREVIEW_ROW_LIMIT).map((row, index) => {
    const cells = row
      .map((cell) => maskNumbers(cleanText(cell)).slice(0, CELL_CHAR_LIMIT))
      .join(' | ');
    return `      ${String(index + 1).padStart(2)}: ${cells}`;
  });

  return [
    `    type: ${shape}`,
    '    first rows (numbers masked):',
    ...preview,
  ].join('\n');
}

/** A plain-text report a user can attach to a bug report. `generatedAt` is a
 * parameter so the output is deterministic under test. */
export function buildFeedbackReport(
  entries: FeedbackEntry[],
  generatedAt: Date = new Date(),
): string {
  const lines: string[] = [
    'Kardabra — unreadable statement report',
    `Generated: ${generatedAt.toISOString()}`,
    'Numbers are masked below, but the previews may still contain text from the',
    'top of your statement — review this file before sharing it.',
    '',
  ];
  for (const entry of entries) {
    const label = entry.kind === 'rejected' ? `[${entry.errorKind}] ` : '';
    lines.push(`${entry.fileName}  ${label}${entry.detail}`);
    if (entry.diagnostic !== undefined) lines.push(entry.diagnostic);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

// Rejections that are a CORRECT classification, not a failure to read the
// file: skipped cleanly, never offered as a "help us support this" report.
const UNDERSTOOD_REJECTIONS: StatementErrorKind[] = [
  'savings-statement',
  'pdf-locked',
];

/** The plan's files Kardabra genuinely couldn't read, as report entries,
 * each with its number-masked diagnostic when one was taken. */
export function feedbackEntriesFor(
  outcomes: FileOutcome[],
  diagnostics: Map<string, string>,
): FeedbackEntry[] {
  return outcomes.flatMap((outcome): FeedbackEntry[] => {
    if (outcome.kind === 'failed') {
      return [
        {
          fileName: outcome.fileName,
          kind: 'failed',
          detail: outcome.message,
          diagnostic: diagnostics.get(outcome.fileName),
        },
      ];
    }
    if (
      outcome.kind === 'rejected' &&
      !UNDERSTOOD_REJECTIONS.includes(outcome.errorKind)
    ) {
      return [
        {
          fileName: outcome.fileName,
          kind: 'rejected',
          errorKind: outcome.errorKind,
          detail: outcome.advice,
          diagnostic: diagnostics.get(outcome.fileName),
        },
      ];
    }
    return [];
  });
}
