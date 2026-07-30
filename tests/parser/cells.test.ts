import { describe, it, expect } from 'vitest';
import { cleanText, cleanAmount } from '../../src/parser/cells';

describe('cleanText', () => {
  it('collapses internal whitespace runs to a single space and trims the ends', () => {
    expect(cleanText('COOL COFFEE      BANGALORE ')).toBe(
      'COOL COFFEE BANGALORE',
    );
  });

  it('treats null/undefined as an empty string rather than the literal "null"/"undefined"', () => {
    expect(cleanText(null)).toBe('');
    expect(cleanText(undefined)).toBe('');
  });
});

describe('cleanAmount', () => {
  it('strips a rupee sign and surrounding space', () => {
    expect(cleanAmount('₹ 1,234.50')).toBe(1234.5);
  });

  it('strips Indian-style grouping commas and a trailing "Cr." suffix', () => {
    expect(cleanAmount('1,00,000.00 Cr.')).toBe(100000.0);
  });

  it('returns null (a sentinel, not 0) for a blank or dash placeholder cell', () => {
    // null here means "no amount at all" — a real zero-rupee transaction
    // must stay distinguishable from a blank cell, so this can never be 0.
    expect(cleanAmount(' - ')).toBeNull();
    expect(cleanAmount(null)).toBeNull();
  });
});
