import { describe, it, expect } from 'vitest';
import { parseDate } from '../../src/parser/dates';
import { StatementError } from '../../src/parser/errors';

describe('parseDate', () => {
  it('parses the whole string when it contains a space (Axis: "06 Nov \'25")', () => {
    // Must NOT be truncated to the first token ("06") before matching.
    expect(parseDate("06 Nov '25")).toBe('2025-11-06');
  });

  it('parses just the first token when HDFC appends a time', () => {
    expect(parseDate('20/09/2025 17:06:00')).toBe('2025-09-20');
  });

  it('parses every format in the DATE_FORMATS table', () => {
    expect(parseDate('20/09/2025')).toBe('2025-09-20'); // HDFC
    expect(parseDate('03-11-2025')).toBe('2025-11-03'); // ICICI, savings
    expect(parseDate('03-Nov-2025')).toBe('2025-11-03');
    expect(parseDate('20/09/25')).toBe('2025-09-20'); // short year
    expect(parseDate('03-Nov-25')).toBe('2025-11-03');
    expect(parseDate('2025-09-20')).toBe('2025-09-20'); // ISO
  });

  it('rejects unparseable junk with a StatementError instead of a silent bad date', () => {
    expect(() => parseDate('** End of Statement **')).toThrow(StatementError);
    expect(() => parseDate('')).toThrow(StatementError);
  });

  it('tags the failure with kind "unrecognised-date" so callers can branch on it', () => {
    let caught: unknown;
    try {
      parseDate('not a date');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StatementError);
    expect((caught as StatementError).kind).toBe('unrecognised-date');
  });
});
