import { describe, it, expect } from 'vitest';
import {
  clampDayToMonth,
  nextDueDateISO,
  nextDueDateWithGraceISO,
  cycleDueDateISO,
  previousPeriod,
  periodsBetween,
  daysBetweenISO,
  todayISO,
  formatPeriodLabel,
  formatDateLabel,
  periodAxisLabel,
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

describe('display formatters (day first, never all-number)', () => {
  it("formatPeriodLabel: YYYY-MM -> 'Oct 2025'", () => {
    expect(formatPeriodLabel('2026-05')).toBe('May 2026');
    expect(formatPeriodLabel('2025-12')).toBe('Dec 2025');
    expect(formatPeriodLabel('2025-01')).toBe('Jan 2025');
  });

  it("formatDateLabel: '2 Nov', with the year only when it isn't this year", () => {
    expect(formatDateLabel('2025-11-02', '2025-12-31')).toBe('2 Nov');
    expect(formatDateLabel('2025-09-20', '2025-01-01')).toBe('20 Sep');
    expect(formatDateLabel('2024-12-31', '2025-01-01')).toBe('31 Dec 2024');
    expect(formatDateLabel('2026-01-05', '2025-12-28')).toBe('5 Jan 2026');
  });

  it('malformed input is returned unchanged, not mangled', () => {
    expect(formatPeriodLabel('whatever')).toBe('whatever');
    expect(formatDateLabel('2025-09')).toBe('2025-09');
  });
});

describe('periodAxisLabel', () => {
  it('splits a period into short month and year', () => {
    expect(periodAxisLabel('2025-06')).toEqual({ month: 'Jun', year: '2025' });
    expect(periodAxisLabel('2026-01')).toEqual({ month: 'Jan', year: '2026' });
  });
  it('falls back to the raw text when it is not a period', () => {
    expect(periodAxisLabel('2025-13')).toEqual({ month: '2025-13', year: '' });
    expect(periodAxisLabel('junk')).toEqual({ month: 'junk', year: '' });
  });
});

describe('cycleDueDateISO', () => {
  it('the printed date wins over any projection', () => {
    expect(cycleDueDateISO('2025-11-02', '2025-10-15', 20)).toBe('2025-11-02');
  });
  it('projects the due day from the anchor, past the grace gap', () => {
    expect(cycleDueDateISO(undefined, '2025-10-15', 20)).toBe('2025-11-20');
  });
  it('is null (unknown) without a due day or an anchor', () => {
    expect(cycleDueDateISO(undefined, '2025-10-15', undefined)).toBeNull();
    expect(cycleDueDateISO(undefined, null, 20)).toBeNull();
  });
});

describe('previousPeriod / periodsBetween', () => {
  it('steps back a month, across a year', () => {
    expect(previousPeriod('2025-10')).toBe('2025-09');
    expect(previousPeriod('2025-01')).toBe('2024-12');
  });
  it('lists the missing months, oldest first', () => {
    expect(periodsBetween('2025-07', '2025-09')).toEqual(['2025-08']);
    expect(periodsBetween('2025-11', '2026-02')).toEqual([
      '2025-12',
      '2026-01',
    ]);
    expect(periodsBetween('2025-07', '2025-08')).toEqual([]);
  });
});
