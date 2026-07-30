import { describe, it, expect } from 'vitest';
import {
  clampDayToMonth,
  nextDueDateISO,
  nextDueDateWithGraceISO,
  daysBetweenISO,
  todayISO,
  formatPeriodLabel,
  formatDateLabel,
} from '../../src/lib/dates';

describe('clampDayToMonth', () => {
  it('leaves an in-range day untouched', () => {
    expect(clampDayToMonth(2025, 11, 15)).toBe(15);
  });

  it('clamps day 31 of February to 28 in a non-leap year (2025)', () => {
    expect(clampDayToMonth(2025, 2, 31)).toBe(28);
  });

  it('clamps day 31 of February to 29 in a leap year (2024) — the real Gregorian rule', () => {
    expect(clampDayToMonth(2024, 2, 31)).toBe(29);
  });

  it('clamps day 31 of a 30-day month (November) to 30', () => {
    expect(clampDayToMonth(2025, 11, 31)).toBe(30);
  });
});

describe('nextDueDateISO', () => {
  it('same month: dueDay still ahead of afterISO', () => {
    // statement dated the 13th, due day 20 -> still to come this month
    expect(nextDueDateISO('2025-11-13', 20)).toBe('2025-11-20');
  });

  it('next month: dueDay already passed this month (the ask-once example from the spec)', () => {
    expect(nextDueDateISO('2025-11-13', 1)).toBe('2025-12-01');
  });

  it("next month: dueDay equals afterISO's own day (not strictly after, so it rolls)", () => {
    expect(nextDueDateISO('2025-11-13', 13)).toBe('2025-12-13');
  });

  it('clamp on the target month: dueDay 31 rolls into February and clamps to 28', () => {
    // The 31st has already happened (today is the 31st itself, not before
    // it) so this rolls to next month, where 31 clamps down to 28.
    expect(nextDueDateISO('2025-01-31', 31)).toBe('2025-02-28');
  });

  it('wraps December into January of the following year', () => {
    expect(nextDueDateISO('2025-12-13', 1)).toBe('2026-01-01');
  });
});

describe('nextDueDateWithGraceISO', () => {
  it('regression (real incident): anchor 3 days before dueDay skips to the next month', () => {
    // Last txn 2026-05-19 + due-day 22 must NOT produce 2026-05-22 (a
    // 3-day interest-free window doesn't exist) — the bank meant 22 June.
    expect(nextDueDateWithGraceISO('2026-05-19', 22)).toBe('2026-06-22');
  });

  it('a comfortably-distant dueDay in the same month is kept', () => {
    // 21-day gap ≥ the 10-day minimum: no skipping.
    expect(nextDueDateWithGraceISO('2026-05-01', 22)).toBe('2026-05-22');
  });

  it('boundary: a gap of exactly minGapDays is accepted', () => {
    expect(nextDueDateWithGraceISO('2026-05-12', 22)).toBe('2026-05-22');
  });

  it('boundary: one day inside the grace gap rolls to next month', () => {
    expect(nextDueDateWithGraceISO('2026-05-13', 22)).toBe('2026-06-22');
  });

  it('clamped candidates count toward the gap too (Jan 31 → Feb 28)', () => {
    // Anchor 2026-01-25, dueDay 31: 2026-01-31 is only 6 days out, so it
    // skips to February — where day 31 clamps to the 28th.
    expect(nextDueDateWithGraceISO('2026-01-25', 31)).toBe('2026-02-28');
  });
});

describe('daysBetweenISO', () => {
  it('counts whole days within a month', () => {
    expect(daysBetweenISO('2025-11-01', '2025-11-09')).toBe(8);
  });

  it('counts across a month boundary', () => {
    expect(daysBetweenISO('2025-10-25', '2025-11-05')).toBe(11);
  });

  it('is negative when b is earlier than a', () => {
    expect(daysBetweenISO('2025-11-09', '2025-11-01')).toBe(-8);
  });

  it('is zero for the same date', () => {
    expect(daysBetweenISO('2025-11-09', '2025-11-09')).toBe(0);
  });
});

describe('todayISO', () => {
  it('returns a YYYY-MM-DD shaped string', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('display formatters (Indian conventions, not US month-first)', () => {
  it('formatPeriodLabel: YYYY-MM -> MM-YYYY', () => {
    expect(formatPeriodLabel('2026-05')).toBe('05-2026');
    expect(formatPeriodLabel('2025-12')).toBe('12-2025');
  });

  it('formatDateLabel: YYYY-MM-DD -> DD-MM-YYYY', () => {
    expect(formatDateLabel('2025-09-20')).toBe('20-09-2025');
    expect(formatDateLabel('2025-11-09')).toBe('09-11-2025');
  });

  it('malformed input is returned unchanged, not mangled', () => {
    expect(formatPeriodLabel('whatever')).toBe('whatever');
    expect(formatDateLabel('2025-09')).toBe('2025-09');
  });
});
