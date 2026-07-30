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

/**
 * '₹ 1,234.50' / '1,00,000.00 Cr.' -> 1234.5 / 100000.0 (unsigned).
 *
 * `null` when the cell holds no digits at all (blank, '-', ...). This is a
 * *sentinel*, distinct from 0 (a value that really is zero rupees) — see
 * table.ts, which relies on the distinction to tell "no money moved, skip
 * this row" apart from "a genuine zero-amount transaction".
 */
export function cleanAmount(cell: unknown): number | null {
  // A falsy cell (0, '', null, undefined) collapses to '' here — so a
  // genuine numeric 0 cell (possible from an Excel sheet, never from CSV
  // text) reads as "no digits" and returns null rather than 0. That's the
  // same null-vs-0 sentinel distinction this function's return type relies
  // on, just showing up one step earlier than the caller sees it.
  const raw = cell ? String(cell) : '';
  const digitsAndDot = raw.replace(/[^0-9.]/g, '');
  const trimmed = digitsAndDot.replace(/^\.+|\.+$/g, ''); // strip stray leading/trailing dots
  return trimmed ? Number(trimmed) : null;
}
