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

interface DateFormatEntry {
  regex: RegExp;
  // Returns null (not a throw) when the regex matched shape-wise but the
  // month name inside didn't resolve — lets the caller fall through to
  // try the next format instead of aborting the whole search.
  extract: (
    match: RegExpMatchArray,
  ) => { year: number; month: number; day: number } | null;
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
    extract: (m) => ({
      day: Number(m[1]),
      month: Number(m[2]),
      year: Number(m[3]),
    }),
  },
  // Axis            "06 Nov '25"
  {
    regex: /^(\d{1,2}) ([A-Za-z]{3}) '(\d{2})$/,
    extract: (m) => {
      const month = monthFromAbbreviation(m[2]);
      return month === null
        ? null
        : { day: Number(m[1]), month, year: expandTwoDigitYear(Number(m[3])) };
    },
  },
  // ICICI, savings  "03-11-2025"
  {
    regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    extract: (m) => ({
      day: Number(m[1]),
      month: Number(m[2]),
      year: Number(m[3]),
    }),
  },
  // "03-Nov-2025"
  {
    regex: /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/,
    extract: (m) => {
      const month = monthFromAbbreviation(m[2]);
      return month === null
        ? null
        : { day: Number(m[1]), month, year: Number(m[3]) };
    },
  },
  // short year      "20/09/25"
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/,
    extract: (m) => ({
      day: Number(m[1]),
      month: Number(m[2]),
      year: expandTwoDigitYear(Number(m[3])),
    }),
  },
  // "03-Nov-25"
  {
    regex: /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/,
    extract: (m) => {
      const month = monthFromAbbreviation(m[2]);
      return month === null
        ? null
        : { day: Number(m[1]), month, year: expandTwoDigitYear(Number(m[3])) };
    },
  },
  // ISO             "2025-09-20"
  {
    regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
    extract: (m) => ({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
    }),
  },
];

/**
 * Parse a statement's date cell into 'YYYY-MM-DD'.
 *
 * Tries the whole cleaned string first (Axis dates contain spaces:
 * "06 Nov '25"), then just the first token (HDFC appends a time:
 * "20/09/2025 17:06:00"). Throws StatementError(kind: 'unrecognised-date')
 * if nothing in DATE_FORMATS matches either candidate.
 */
export function parseDate(value: unknown): string {
  // A spreadsheet date cell read raw is a number, not a string — handle it
  // before the text formats below.
  if (typeof value === 'number') {
    const iso = isoFromExcelSerial(value);
    if (iso !== null) return iso;
  }
  const s = cleanText(value);
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
      const parts = format.extract(match);
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
