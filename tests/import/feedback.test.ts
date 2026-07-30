/**
 * The unreadable-statement report must be useful for debugging a format while
 * masking sensitive numbers: it may carry column headers and structure, but
 * amounts and account/card numbers are replaced with `#`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFeedbackReport,
  fileDiagnostic,
  type FeedbackEntry,
} from '../../src/import/feedback';

const at = new Date('2025-11-01T00:00:00.000Z');

describe('buildFeedbackReport', () => {
  it('lists each unreadable file with its diagnosis and diagnostic', () => {
    const entries: FeedbackEntry[] = [
      {
        fileName: 'mystery.csv',
        kind: 'rejected',
        errorKind: 'no-table',
        detail: 'no transaction table found',
        diagnostic: '    type: delimited text, ~3 columns, 2 rows',
      },
      { fileName: 'weird.xls', kind: 'failed', detail: 'boom' },
    ];
    const report = buildFeedbackReport(entries, at);

    expect(report).toContain('2025-11-01T00:00:00.000Z');
    expect(report).toContain(
      'mystery.csv  [no-table] no transaction table found',
    );
    expect(report).toContain('type: delimited text, ~3 columns, 2 rows');
    expect(report).toContain('weird.xls  boom');
    expect(report.toLowerCase()).toContain('review this file before sharing');
  });
});

describe('fileDiagnostic', () => {
  it('masks numbers but keeps the column structure and header labels', () => {
    const csv =
      'Date,Narration,Debit Amount,Credit Amount\n01/03/26,SHOP PAYMENT,398.00,0.00\n';
    const diag = fileDiagnostic(new TextEncoder().encode(csv));

    expect(diag).toContain('Debit Amount'); // header text preserved
    expect(diag).toContain('Credit Amount');
    expect(diag).toContain('SHOP PAYMENT'); // payee text preserved
    expect(diag).not.toContain('398'); // amount masked
    expect(diag).toContain('##/##/##'); // date-as-value masked, shape kept
    expect(diag).toMatch(/~4 columns/); // structure reported
  });
});
