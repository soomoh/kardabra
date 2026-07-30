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
      label: 'Was due 10-10-2025 — import a newer statement to update',
      tone: 'unknown',
    });
  });

  it('is "Due today" (tone soon) when the due date is today', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-10' })).toEqual({
      label: 'Due today',
      tone: 'soon',
    });
  });

  it('boundary: 3 days out is still "soon"', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-13' })).toEqual({
      label: 'Due in 3 days',
      tone: 'soon',
    });
  });

  it('boundary: 4 days out drops to "ok"', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-14' })).toEqual({
      label: 'Due in 4 days',
      tone: 'ok',
    });
  });

  it('is "ok" well in advance', () => {
    expect(dueStatus(TODAY, { dueDateISO: '2025-11-30' })).toEqual({
      label: 'Due in 20 days',
      tone: 'ok',
    });
  });
});
