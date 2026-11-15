import { describe, it, expect } from 'vitest';
import { dueStatus } from '../../src/lib/dueStatus';

const TODAY = '2025-11-10';

describe('dueStatus', () => {
  it('is "Paid" when paidAt is set, even if the due date has already passed', () => {
    // paidAt must win over an overdue-looking date — see the comment in
    // dueStatus.ts on why this check runs first.
    expect(
      dueStatus(TODAY, {
        dueDateISO: '2025-11-01',
        paidAt: '2025-11-02T00:00:00.000Z',
      }),
    ).toEqual({ label: 'Paid ✓', tone: 'paid' });
  });

  it('is "Due date unknown" when dueDateISO is the null sentinel', () => {
    expect(dueStatus(TODAY, { dueDateISO: null })).toEqual({
      label: 'Due date unknown',
      tone: 'unknown',
    });
  });

  it('regression (real incident): a ₹0 bill with a past due date is "Nothing due", never overdue', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-05', totalDue: 0 })).toEqual(
      { label: 'Nothing due ✓', tone: 'paid' },
    );
  });

  it('a no-spend cycle with no bill figure is calm, not overdue', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-05', spend: 0 })).toEqual({
      label: 'No spend this cycle',
      tone: 'paid',
    });
  });

  it('is overdue when the due date is in the past', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-05' })).toEqual({
      label: 'Overdue by 5 days',
      tone: 'overdue',
    });
  });

  it('boundary: 30 days overdue still reads as overdue', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-10-11' })).toEqual({
      label: 'Overdue by 30 days',
      tone: 'overdue',
    });
  });

  it('regression (real incident): >30 days overdue reads as stale data, not a scream', () => {
    // Four months of history imported at once showed "Overdue by 67
    // days" for a bill that was long since paid — past a full statement
    // cycle, missing-newer-statement is the far likelier explanation.
    expect(dueStatus(TODAY, { dueDateISO: '2025-10-10' })).toEqual({
      label: 'Was due 10 Oct.',
      stale: true,
      tone: 'unknown',
    });
  });

  it('regression: one day overdue is singular', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-09' }).label).toBe(
      'Overdue by 1 day',
    );
  });

  it('is "Pay today" (tone soon) when the due date is today', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-10' })).toEqual({
      label: 'Pay today',
      tone: 'soon',
    });
  });

  it('within the last week: the date, a countdown, and the soon tone', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-11' })).toEqual({
      label: 'Pay before 11 Nov',
      tone: 'soon',
      countdown: '1 day left',
    });
  });

  it('boundary: 7 days out still counts down', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-17' })).toEqual({
      label: 'Pay before 17 Nov',
      tone: 'soon',
      countdown: '7 days left',
    });
  });

  it('boundary: 8 days out shows only the date, calmly', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-18' })).toEqual({
      label: 'Pay before 18 Nov',
      tone: 'ok',
    });
  });

  it('a due date next year carries its year', () => {
    expect(dueStatus('2025-12-20', { dueDateISO: '2026-01-05' })).toEqual({
      label: 'Pay before 5 Jan 2026',
      tone: 'ok',
    });
  });
});
