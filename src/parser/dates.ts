/**
 * Parse a statement's date cell into an ISO date string.
 *
 * `parseDate` returns 'YYYY-MM-DD', not a `Date` object. JS's `Date` is a
 * timezone landmine (it's really an instant, not a calendar date —
 * printing it, comparing it, or even constructing it can silently shift
 * the day depending on the runtime's local timezone). An ISO date *string*
 * has none of that: it sorts lexicographically in the same order as
 * chronologically, stores cleanly as an IndexedDB key, and needs no
 * timezone math anywhere in the app. Internally, known bank date formats
 * are kept as data in the DATE_FORMATS table below and walked by one
 * unchanging loop, rather than a growing if/elif chain per format.
 */

import { cleanText } from './cells';
import { StatementError } from './errors';

const MONTH_ABBREVIATIONS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** Three-letter month abbreviation -> 1-12, case-insensitive: "Nov" -> 11. */
function monthFromAbbreviation(name: string): number | null {
  const index = MONTH_ABBREVIATIONS.indexOf(name.slice(0, 3).toLowerCase());
  return index === -1 ? null : index + 1; // calendar months are 1-indexed
}

/** Expand a 2-digit year, pivoting at 68/69: 00-68 means 2000-2068, 69-99
 * means 1969-1999 — the standard strptime-style pivot, so a statement
 * dated "06 Nov '25" resolves to 2025, not 1925. */
function expandTwoDigitYear(twoDigits: number): number {
  return twoDigits <= 68 ? 2000 + twoDigits : 1900 + twoDigits;
}

/** Whether a file writes numeric dates day-first (India: 05/11/2025 is 5
 * November) or month-first (US). Decided once per file — see locale.ts. */
export type DateOrder = 'dmy' | 'mdy';

/** What each capture group of a format's regex holds, in order:
 *   'first' / 'second' — the two leading numeric fields of a numeric date,
 *       whose meaning (day vs month) is the FILE's DateOrder, not the
 *       format's. Field order is data, not a new branch per ordering.
 *   'day' / 'month'    — a numeric field with a fixed meaning (ISO).
 *   'monthName'        — "Nov" / "November".
 *   'year' / 'year2'   — four- / two-digit year. */
type DateField =
  'first' | 'second' | 'day' | 'month' | 'monthName' | 'year' | 'year2';

interface DateFormatEntry {
  regex: RegExp;
  fields: DateField[]; // one per capture group, in order
}

/** Build a real calendar date's ISO string, or null if year/month/day
 * don't actually name a date (e.g. day 31 of a 30-day month, or Feb 30). */
function isoDateOrNull(
  year: number,
  month: number,
  day: number,
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Date.UTC never throws on an out-of-range day — it rolls over instead
  // (e.g. Feb 31 becomes Mar 3). Round-tripping through getUTC*() and
  // checking for a match is how we catch that rollover and reject it.
  const asDate = new Date(Date.UTC(year, month - 1, day));
  const rolledOver =
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day;
  if (rolledOver) return null;
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Excel stores a date as a serial number — whole days since 1899-12-30, the
 * base that bakes in Excel's 1900 leap-year bug. With raw cell values, a
 * date-typed spreadsheet cell arrives here as that number rather than a string.
 * Convert it with UTC arithmetic so the calendar date never shifts with the
 * machine's timezone. Returns null for anything that isn't a plausible serial. */
function isoFromExcelSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const epochMs = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  const d = new Date(epochMs);
  return isoDateOrNull(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// Formats as data, walked by one unchanging loop — adding a bank's date
// format means adding an entry here, not a new branch. Order doesn't
// currently disambiguate anything (numeric vs. named-month, and 2- vs
// 4-digit year, are structurally distinct patterns), but each entry is
// commented with a bank that produces it, for reference.
const DATE_FORMATS: DateFormatEntry[] = [
  // HDFC            "20/09/2025"
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    fields: ['first', 'second', 'year'],
  },
  // Axis            "06 Nov '25"
  {
    regex: /^(\d{1,2}) ([A-Za-z]{3,9}) '(\d{2})$/,
    fields: ['day', 'monthName', 'year2'],
  },
  // ICICI, savings  "03-11-2025"
  {
    regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    fields: ['first', 'second', 'year'],
  },
  // "03-Nov-2025"
  {
    regex: /^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})$/,
    fields: ['day', 'monthName', 'year'],
  },
  // short year      "20/09/25"
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
    fields: ['first', 'second', 'year2'],
  },
  // "03-Nov-25"
  {
    regex: /^(\d{1,2})-([A-Za-z]{3,9})-(\d{2})$/,
    fields: ['day', 'monthName', 'year2'],
  },
  // short year      "05-11-25"
  {
    regex: /^(\d{1,2})-(\d{1,2})-(\d{2})$/,
    fields: ['first', 'second', 'year2'],
  },
  // ISO             "2025-09-20"
  {
    regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    fields: ['year', 'month', 'day'],
  },
  // "05 Nov 2025", "5 Nov, 2025"
  {
    regex: /^(\d{1,2}) ([A-Za-z]{3,9}),? (\d{4})$/,
    fields: ['day', 'monthName', 'year'],
  },
  // SBI PDF        "16 Jun 26"
  {
    regex: /^(\d{1,2}) ([A-Za-z]{3,9}),? (\d{2})$/,
    fields: ['day', 'monthName', 'year2'],
  },
  // "Nov 05, 2025"
  {
    regex: /^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})$/,
    fields: ['monthName', 'day', 'year'],
  },
  // "06/Nov/2025"
  {
    regex: /^(\d{1,2})\/([A-Za-z]{3,9})\/(\d{4})$/,
    fields: ['day', 'monthName', 'year'],
  },
];

/** Resolve one regex match into calendar parts under `order`. null when a
 * month name inside didn't resolve (caller tries the next format). */
function partsFromMatch(
  match: RegExpMatchArray,
  fields: DateField[],
  order: DateOrder,
): { year: number; month: number; day: number } | null {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const [i, field] of fields.entries()) {
    const text = match[i + 1];
    switch (field) {
      case 'first':
        if (order === 'dmy') day = Number(text);
        else month = Number(text);
        break;
      case 'second':
        if (order === 'dmy') month = Number(text);
        else day = Number(text);
        break;
      case 'day':
        day = Number(text);
        break;
      case 'month':
        month = Number(text);
        break;
      case 'monthName': {
        const named = monthFromAbbreviation(text);
        if (named === null) return null;
        month = named;
        break;
      }
      case 'year':
        year = Number(text);
        break;
      case 'year2':
        year = expandTwoDigitYear(Number(text));
        break;
    }
  }
  return { year, month, day };
}

// "13/11/2025": numeric date whose two leading fields are order-dependent.
const NUMERIC_FIRST_SECOND = /^(\d{1,2})[/-](\d{1,2})[/-]\d{2}(?:\d{2})?$/;

/** Infer a file's numeric date order from its date cells: any first
 * component above 12 can only be a day (day-first); otherwise any second
 * component above 12 can only be a day (month-first); otherwise the Indian
 * default, day-first. */
export function inferDateOrder(values: unknown[]): DateOrder {
  let secondAbove12 = false;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const match = cleanText(value).split(' ')[0].match(NUMERIC_FIRST_SECOND);
    if (match === null) continue;
    if (Number(match[1]) > 12) return 'dmy';
    if (Number(match[2]) > 12) secondAbove12 = true;
  }
  return secondAbove12 ? 'mdy' : 'dmy';
}

/**
 * Parse a statement's date cell into 'YYYY-MM-DD'.
 *
 * `order` says how numeric dates read (day-first by default — India).
 * Tries the whole cleaned string first (Axis dates contain spaces:
 * "06 Nov '25"), then just the first token (HDFC appends a time:
 * "20/09/2025 17:06:00"). Throws StatementError(kind: 'unrecognised-date')
 * if nothing in DATE_FORMATS matches either candidate.
 */
export function parseDate(value: unknown, order: DateOrder = 'dmy'): string {
  // A spreadsheet date cell read raw is a number, not a string — handle it
  // before the text formats below.
  if (typeof value === 'number') {
    const iso = isoFromExcelSerial(value);
    if (iso !== null) return iso;
  }
  // HDFC's PDFs glue a bar onto the date: "14/01/2026| 17:06".
  const s = cleanText(value).replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) {
    throw new StatementError(
      'unrecognised-date',
      'empty date cell',
      'This row has no date. Re-check the source file, or skip it if it is a blank spacer line.',
    );
  }
  // A Set de-duplicates while keeping insertion order (whole string
  // first), so if the first token IS the whole string, it isn't tried
  // twice.
  const candidates = [...new Set([s, s.split(' ')[0]])];
  for (const candidate of candidates) {
    for (const format of DATE_FORMATS) {
      const match = candidate.match(format.regex);
      if (!match) continue;
      const parts = partsFromMatch(match, format.fields, order);
      if (parts === null) continue;
      const iso = isoDateOrNull(parts.year, parts.month, parts.day);
      if (iso !== null) return iso;
    }
  }
  throw new StatementError(
    'unrecognised-date',
    `unrecognised date: ${JSON.stringify(value)}`,
    'This date format is not recognised. Re-download the statement, or report the format so it can be added.',
  );
}
