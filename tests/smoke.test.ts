import { describe, it, expect } from 'vitest';
import { formatPeriod } from '../src/lib/period';

describe('formatPeriod', () => {
  it('formats a mid-year date as YYYY-MM', () => {
    // Month index 5 is June — checks the "happy path" mapping.
    expect(formatPeriod(new Date(2025, 5, 15))).toBe('2025-06');
  });

  it('pads January (month index 0) to "01" instead of "0"', () => {
    // The January boundary: getMonth() returns 0, and padStart must
    // still produce a two-digit month rather than a single "1".
    expect(formatPeriod(new Date(2026, 0, 3))).toBe('2026-01');
  });
});
