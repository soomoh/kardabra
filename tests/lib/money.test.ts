import { describe, it, expect } from 'vitest';
import {
  formatINR,
  formatSignedINR,
  formatINRCompact,
} from '../../src/lib/money';

// Node's ICU data can format the ₹-number gap as either an ordinary space
// or a non-breaking space (U+00A0) depending on the build — a difference
// invisible in a terminal/diff but one that breaks a naive `.toBe(...)`
// comparison typed with an ordinary space. Normalizing every space
// character to U+0020 before comparing sidesteps that gotcha rather than
// hardcoding whichever one this machine's ICU happens to produce.
function normalizeSpaces(s: string): string {
  return s.replace(/\s/g, ' ');
}

describe('formatINR', () => {
  it('groups by the Indian numbering system (lakh grouping, not thousands)', () => {
    expect(normalizeSpaces(formatINR(100000))).toBe('₹1,00,000.00');
  });

  it('formats a small amount with two decimal places', () => {
    expect(normalizeSpaces(formatINR(360))).toBe('₹360.00');
  });

  it('formats zero', () => {
    expect(normalizeSpaces(formatINR(0))).toBe('₹0.00');
  });
});

describe('formatSignedINR', () => {
  it('prefixes a credit (positive amount) with +', () => {
    expect(normalizeSpaces(formatSignedINR(500))).toBe('+₹500.00');
  });

  it('leaves a debit (negative amount) with the formatter’s own minus sign', () => {
    expect(normalizeSpaces(formatSignedINR(-500))).toBe('-₹500.00');
  });

  it('does not prefix zero with +', () => {
    expect(normalizeSpaces(formatSignedINR(0))).toBe('₹0.00');
  });
});

describe('formatINRCompact', () => {
  it('formats lakhs with the Indian "L" unit, not a Western "M"', () => {
    // 152000 = 1.52 lakh -> '₹1.5L' territory. Asserted against the
    // function's own output shape (contains 'L', no comma-grouped
    // digits) rather than a hardcoded string, since exact ICU spacing
    // varies by build (see normalizeSpaces above) — the property under
    // test is "Indian compact units", not one exact byte sequence.
    const result = normalizeSpaces(formatINRCompact(152000));
    expect(result).toContain('L');
    expect(result).not.toContain(',');
  });

  it('formats thousands with "K"', () => {
    expect(normalizeSpaces(formatINRCompact(12340))).toBe('₹12.3K');
  });

  it('formats crores with "Cr"', () => {
    expect(normalizeSpaces(formatINRCompact(10000000))).toBe('₹1Cr');
  });

  it('formats a sub-thousand amount with no compact suffix at all', () => {
    expect(normalizeSpaces(formatINRCompact(999))).toBe('₹999');
  });

  it('formats zero', () => {
    expect(normalizeSpaces(formatINRCompact(0))).toBe('₹0');
  });
});
