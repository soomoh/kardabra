/**
 * The unrecognized-statement report must be shareable without leaking financial
 * data: it may name files and quote the parser's diagnosis, but must never
 * contain statement contents (amounts, payees, card numbers).
 */
import { describe, it, expect } from 'vitest';
import {
  buildFeedbackReport,
  type FeedbackEntry,
} from '../../src/import/feedback';

const at = new Date('2025-11-01T00:00:00.000Z');

describe('buildFeedbackReport', () => {
  it('lists each unhandled file with its kind and diagnosis', () => {
    const entries: FeedbackEntry[] = [
      {
        fileName: 'savings.csv',
        kind: 'rejected',
        errorKind: 'savings-statement',
        detail: 'Looks like a bank account, not a card.',
      },
      {
        fileName: 'weird.xls',
        kind: 'failed',
        detail: 'no transaction table found',
      },
    ];
    const report = buildFeedbackReport(entries, at);

    expect(report).toContain('2025-11-01T00:00:00.000Z');
    expect(report).toContain('REJECTED  savings.csv  [savings-statement]');
    expect(report).toContain('FAILED    weird.xls  no transaction table found');
  });

  it('states plainly that it carries no statement contents', () => {
    const report = buildFeedbackReport([], at);
    expect(report.toLowerCase()).toContain('no statement contents');
  });
});
