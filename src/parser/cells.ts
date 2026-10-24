/**
 * Low-level cell cleaning. Every other module in src/parser/ builds on
 * these: normalise whitespace, case, and numeric noise once, here, rather
 * than defensively everywhere downstream ("normalize at the boundary").
 */

/** Collapse whitespace: 'COOL COFFEE      BLR ' -> 'COOL COFFEE BLR'.
 *
 * `cell` is `unknown`, not `string`, because callers pull it straight out
 * of a row — a CSV row is always strings, but an Excel row can hold
 * numbers, booleans, or null for a blank cell — never trust the shape
 * without checking.
 */
export function cleanText(cell: unknown): string {
  const asString = cell === null || cell === undefined ? '' : String(cell);
  return asString.replace(/\s+/g, ' ').trim();
}

/** cleanText, lowercased — for comparing header names and Cr/Dr markers. */
export function norm(cell: unknown): string {
  return cleanText(cell).toLowerCase();
}

/** How a file writes its decimal separator. Decided once per file (see
 * locale.ts), then passed to every amount read — never guessed per cell. */
export type DecimalStyle = 'dot' | 'comma';

/** An explicit Cr/Dr tag printed next to an amount. */
export type AmountMarker = 'cr' | 'dr';

/** An amount split into its magnitude and the sign information printed
 * with it. `value` is never negative and never NaN; direction lives in
 * `negative` (leading/trailing minus, parentheses) and `marker`. */
export interface ParsedAmount {
  value: number;
  negative: boolean;
  /** An explicit leading '+' — HDFC's PDF statements mark credits this way. */
  plus: boolean;
  marker: AmountMarker | null;
}

// A numeric run: digits with '.'/',' separators between/around them. A cell
// with two separate runs ("05/11/2025", "3 of 5") is not one amount.
const NUMERIC_RUN = /[\d.,]*\d[\d.,]*/g;
const MARKER = /(?<![A-Za-z])(cr|dr)(?![A-Za-z])/i;
const MINUS = /[-\u2212\u2013]/;

/** The pieces of an amount-looking cell, or null if it is not exactly one
 * numeric run. `clean` is true when nothing but currency text, signs,
 * parentheses and a Cr/Dr tag surrounds the run. */
function splitAmount(cell: unknown): {
  body: string;
  negative: boolean;
  plus: boolean;
  marker: AmountMarker | null;
  clean: boolean;
} | null {
  if (cell === null || cell === undefined || typeof cell === 'boolean') {
    return null;
  }
  const text = cleanText(cell);
  const runs = [...text.matchAll(NUMERIC_RUN)];
  if (runs.length !== 1) return null;
  const run = runs[0];
  const start = run.index ?? 0;
  // A '.' glued to the front of the run is currency punctuation ("Rs.1000"),
  // and one at the back is sentence punctuation ("1,200.00 Cr.") — never
  // part of the number.
  const body = run[0].replace(/^[.,]+|[.,]+$/g, '');
  const prefix = text.slice(0, start) + run[0].match(/^[.,]*/)![0];
  const suffix = run[0].match(/[.,]*$/)![0] + text.slice(start + run[0].length);
  const markerText = (prefix.match(MARKER) ?? suffix.match(MARKER))?.[1];
  // A lone trailing C/D is a marker too (SBI prints one after each amount).
  // Only trailing: a LEADING "C" is how some PDF fonts render the ₹ sign.
  const letter = /^\s*([CD])\s*$/.exec(suffix)?.[1];
  const marker: AmountMarker | null = markerText
    ? (markerText.toLowerCase() as AmountMarker)
    : letter
      ? letter === 'C'
        ? 'cr'
        : 'dr'
      : null;
  const plus = /\+/.test(prefix);
  const negative =
    MINUS.test(prefix) ||
    /^\s*[-\u2212\u2013]/.test(suffix) ||
    (prefix.includes('(') && suffix.includes(')'));
  const leftover = (prefix + ' ' + suffix)
    .replace(MARKER, '')
    .replace(/\b(inr|rs|usd|eur|gbp)\b/gi, '')
    .replace(/^\s*C\s|\s[CD]\s*$/g, ' ')
    .replace(/[\s\u20b9$\u20ac\u00a3().,\-\u2212\u2013*/`+]/g, '');
  return { body, negative, plus, marker, clean: leftover === '' };
}

/** '1,23,456.78' -> 123456.78 (dot style) or '1.234,56' -> 1234.56 (comma
 * style). null for anything that is not one well-formed number in that
 * style ('12.34.56', or a comma after the decimal point in dot style). */
function numberFromBody(body: string, style: DecimalStyle): number | null {
  let normalised: string;
  if (style === 'dot') {
    if (/\.[^,]*,/.test(body)) return null; // comma after the decimal point
    normalised = body.replace(/,/g, '');
  } else {
    if (/,[^.]*\./.test(body) || (body.match(/,/g) ?? []).length > 1) {
      return null;
    }
    normalised = body.replace(/\./g, '').replace(',', '.');
  }
  if (!/^\d+(\.\d+)?$/.test(normalised)) return null;
  return Number(normalised);
}

/**
 * Read an amount cell as magnitude + sign information.
 *
 * Recognises a leading/trailing minus, parentheses, and a Cr/Dr tag on
 * either side ('1,200.00 Cr.', 'Dr 500', '(500.00)', '-500', '500-'),
 * strips currency text ('₹', 'Rs.', 'INR'), and understands Indian lakh
 * grouping ('1,23,456.78'). Excel numeric cells may be negative.
 *
 * `null` (a sentinel, distinct from a real 0) when the cell holds no
 * amount at all — blank, '-', text — or holds a malformed one ('12.34.56').
 * Never NaN.
 */
export function parseAmount(
  cell: unknown,
  decimal: DecimalStyle = 'dot',
): ParsedAmount | null {
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return null;
    return {
      value: Math.abs(cell),
      negative: cell < 0,
      plus: false,
      marker: null,
    };
  }
  const parts = splitAmount(cell);
  if (parts === null) return null;
  const value = numberFromBody(parts.body, decimal);
  if (value === null) return null;
  return {
    value,
    negative: parts.negative,
    plus: parts.plus,
    marker: parts.marker,
  };
}

/**
 * '₹ 1,234.50' / '1,00,000.00 Cr.' -> 1234.5 / 100000.0 (unsigned).
 *
 * The magnitude of parseAmount, for callers that don't care about
 * direction. `null` when the cell holds no (well-formed) amount — a
 * *sentinel*, distinct from 0 (a value that really is zero rupees); see
 * table.ts, which relies on the distinction to tell "no money moved, skip
 * this row" apart from "a genuine zero-amount transaction".
 */
export function cleanAmount(
  cell: unknown,
  decimal: DecimalStyle = 'dot',
): number | null {
  return parseAmount(cell, decimal)?.value ?? null;
}

/** True when `cell` is a bare amount (nothing but one number plus currency
 * text/sign/Cr-Dr) whose text only makes sense with a decimal comma:
 * '1.234,56' or '12,50'. Evidence for locale.ts's per-file decision. */
export function looksDecimalComma(cell: unknown): boolean {
  if (typeof cell !== 'string') return false;
  const parts = splitAmount(cell);
  if (parts === null || !parts.clean) return false;
  return (
    /^\d{1,3}(\.\d{3})+,\d{2}$/.test(parts.body) ||
    /^\d+,\d{2}$/.test(parts.body)
  );
}

/** True when `cell` is a bare amount that only makes sense with a decimal
 * point: '1,234.56', '1,23,456.78', '925.65'. Counter-evidence to
 * looksDecimalComma, so one stray '12,50' can't flip a whole file. */
export function looksDecimalDot(cell: unknown): boolean {
  if (typeof cell !== 'string') return false;
  const parts = splitAmount(cell);
  if (parts === null || !parts.clean) return false;
  return /^\d{1,3}(,\d{2,3})*\.\d{1,2}$|^\d+\.\d{1,2}$/.test(parts.body);
}

/** True when `cell` is nothing but one well-formed amount (plus currency
 * text, sign, Cr/Dr) — stricter than parseAmount, which tolerates words
 * around the number. For telling a value cell from a label cell. */
export function isBareAmount(
  cell: unknown,
  decimal: DecimalStyle = 'dot',
): boolean {
  if (typeof cell === 'number') return Number.isFinite(cell);
  const parts = splitAmount(cell);
  return (
    parts !== null &&
    parts.clean &&
    numberFromBody(parts.body, decimal) !== null
  );
}
