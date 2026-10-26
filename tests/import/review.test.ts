/**
 * The import review's decisions: which file asks each question, when the
 * plan is complete, what a blank card name becomes, and which files are
 * offered for the unreadable-file report.
 */
import { describe, expect, it } from 'vitest';
import { planImport, type ParseResult } from '../../src/import/plan';
import type { CommitUserInput } from '../../src/import/commit';
import {
  importCount,
  planIsComplete,
  questionOwners,
  reviewGroups,
  withSuggestedNames,
} from '../../src/import/review';
import { feedbackEntriesFor } from '../../src/import/feedback';
import { StatementError, type ParsedStatement } from '../../src/parser';

function file(
  fileName: string,
  last4: string | null,
  statementDateISO: string,
  paymentDueDateISO?: string,
): ParseResult {
  const parsed: ParsedStatement = {
    fileName,
    last4,
    currency: 'INR',
    summary: { statementDateISO, paymentDueDateISO },
    transactions: [{ dateISO: statementDateISO, payee: 'SHOP', amount: -1 }],
    warnings: [],
  };
  return { fileName, parsed };
}
const answers = (dueDays: [string, number][] = []): CommitUserInput => ({
  nicknames: new Map(),
  dueDays: new Map(dueDays),
});

describe('questionOwners', () => {
  it('asks once per new card, from its first file; due day only where needed', () => {
    const outcomes = planImport(
      [
        file('sep.csv', '1111', '2025-09-13', '2025-10-02'),
        file('oct.csv', '1111', '2025-10-13'),
        file('nov.csv', '1111', '2025-11-13'),
      ],
      [],
      [],
    );
    const owners = questionOwners(outcomes);
    expect([...owners.name]).toEqual(['sep.csv']);
    // sep.csv prints its due date; oct.csv is the first that needs one.
    expect([...owners.dueDay]).toEqual(['oct.csv']);
  });
});

describe('planIsComplete', () => {
  const outcomes = planImport([file('a.csv', '1111', '2025-10-13')], [], []);

  it('waits for a valid due day where one is asked', () => {
    expect(planIsComplete(outcomes, answers())).toBe(false);
    expect(planIsComplete(outcomes, answers([['1111', 32]]))).toBe(false);
    expect(planIsComplete(outcomes, answers([['1111', 5]]))).toBe(true);
  });

  it('never waits for a card name', () => {
    const printed = planImport(
      [file('a.csv', '1111', '2025-10-13', '2025-11-02')],
      [],
      [],
    );
    expect(planIsComplete(printed, answers())).toBe(true);
  });
});

it('a blank card name takes the suggestion; a typed one is kept', () => {
  const outcomes = planImport(
    [
      file('a.csv', '1111', '2025-10-13', '2025-11-02'),
      file('b.csv', '2222', '2025-10-13', '2025-11-02'),
    ],
    [],
    [],
  );
  const filled = withSuggestedNames(outcomes, {
    nicknames: new Map([
      ['1111', '  '],
      ['2222', 'Travel'],
    ]),
    dueDays: new Map(),
  });
  expect(filled.nicknames.get('1111')).toBe('Card ····1111');
  expect(filled.nicknames.get('2222')).toBe('Travel');
});

it('reports unreadable files, not understood skips', () => {
  const outcomes = planImport(
    [
      {
        fileName: 'savings.csv',
        error: new StatementError('savings-statement', 'm', 'a'),
      },
      {
        fileName: 'locked.pdf',
        error: new StatementError('pdf-locked', 'm', 'a'),
      },
      { fileName: 'odd.csv', error: new StatementError('no-table', 'm', 'a') },
      { fileName: 'bug.csv', error: new Error('boom') },
    ],
    [],
    [],
  );
  const entries = feedbackEntriesFor(outcomes, new Map([['odd.csv', 'shape']]));
  expect(entries.map((e) => [e.fileName, e.kind, e.diagnostic])).toEqual([
    ['odd.csv', 'rejected', 'shape'],
    ['bug.csv', 'failed', undefined],
  ]);
});

it('statements of a card showing two digits group into one card', () => {
  const outcomes = planImport(
    [
      file('jan.pdf', 'XX34', '2026-01-13', '2026-02-02'),
      file('feb.pdf', 'XX34', '2026-02-13', '2026-03-04'),
    ],
    [],
    [],
  );
  expect([...questionOwners(outcomes).name]).toEqual(['jan.pdf']);
  const [jan] = outcomes;
  expect(jan.kind === 'new-statement' && jan.cardRef).toMatchObject({
    suggestedNickname: 'Card ····34',
  });
});

describe('reviewGroups and importCount', () => {
  it('groups statements by card, newest first, and counts what Import writes', () => {
    const outcomes = planImport(
      [
        file('a-sep.csv', '1111', '2025-09-13', '2025-10-02'),
        file('b-oct.csv', '2222', '2025-10-13', '2025-11-02'),
        file('a-oct.csv', '1111', '2025-10-13', '2025-11-02'),
        {
          fileName: 'junk.csv',
          error: new StatementError('no-table', 'x', 'y'),
        },
      ],
      [],
      [],
    );
    const { groups, unreadable } = reviewGroups(outcomes);
    expect(groups.map((g) => g.key)).toEqual(['1111', '2222']);
    expect(groups[0].outcomes.map((o) => o.period)).toEqual([
      '2025-10',
      '2025-09',
    ]);
    expect(groups.map((g) => g.toImport)).toEqual([2, 1]);
    expect(unreadable.map((o) => o.kind)).toEqual(['rejected']);
    expect(importCount(outcomes)).toBe(3);
  });

  it('an in-batch duplicate is grouped with its card but not counted', () => {
    const outcomes = planImport(
      [
        file('one.csv', '1111', '2025-10-13', '2025-11-02'),
        file('copy.csv', '1111', '2025-10-13', '2025-11-02'),
      ],
      [],
      [],
    );
    const { groups } = reviewGroups(outcomes);
    expect(groups).toHaveLength(1);
    expect(groups[0].outcomes).toHaveLength(2);
    expect(groups[0].toImport).toBe(1);
    expect(importCount(outcomes)).toBe(1);
  });
});
