/**
 * PDF text → the rows the rest of the parser already reads.
 *
 * A PDF has no rows or cells, only text placed on a page. This rebuilds
 * them: items on one baseline become a line, items close together become one
 * cell, and below a transaction-table header each item is snapped to the
 * header column nearest it — so a right-aligned amount lands under "Amount"
 * however far it drifts, and a date and description printed close together
 * still split into their own columns. Summary blocks print labels ABOVE their
 * values (HDFC, Axis, SBI); each such label is emitted as a [label, value]
 * row so the existing summary reader pairs them.
 *
 * Bank-agnostic on purpose: no per-issuer code. Layout differences are
 * absorbed by geometry and by the parser's existing keyword tables. Pure:
 * positioned text in, rows out.
 */

import { parseDate } from './dates';
import { resolveTable } from './table';

export interface PdfTextItem {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  text: string;
  x0: number;
  x1: number;
  y: number;
}
interface Line {
  y: number;
  /** Close-together items joined — for headers, labels and plain rows. */
  cells: Cell[];
  /** Every item on its own — what gets snapped to table columns. */
  items: Cell[];
}

const SAME_LINE = 2.5; // baseline tolerance, in PDF points
const SAME_CELL = 3; // gap below which two items are one cell
const HEADER_SECOND_LINE = 14; // a header wrapped onto a second line
const VALUE_BELOW = 40; // how far below a label its value may sit
const LABEL_CONTINUES = 12; // a label wrapped onto the next line

const hasDigit = (s: string) => /\d/.test(s);
// What a date cell starts with: a digit ("16 Jun 26", "14/01/2026|") or a
// month name ("Nov 05, 2025").
const DATE_START =
  /^(\d|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d)/i;
const hasLetter = (s: string) => /[A-Za-z]/.test(s);
const center = (c: Cell) => (c.x0 + c.x1) / 2;
const overlaps = (a: Cell, b: Cell, slack = 0) =>
  a.x0 - slack < b.x1 && b.x0 - slack < a.x1;
const texts = (cells: Cell[]) => cells.map((c) => c.text);

/** Items → visual lines, top to bottom. */
export function pageLines(items: PdfTextItem[]): Line[] {
  const visible = items.filter((i) => i.s.trim() !== '');
  visible.sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: PdfTextItem[][] = [];
  for (const item of visible) {
    const group = groups.find((g) => Math.abs(g[0].y - item.y) <= SAME_LINE);
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups.map((group) => {
    group.sort((a, b) => a.x - b.x);
    const items = group.map((i) => ({
      text: i.s.trim(),
      x0: i.x,
      x1: i.x + i.w,
      y: i.y,
    }));
    const cells: Cell[] = [];
    for (const item of items) {
      const last = cells.at(-1);
      const gap = last ? item.x0 - last.x1 : Infinity;
      if (last && gap < SAME_CELL) {
        last.text += (gap > 0.6 ? ' ' : '') + item.text;
        last.x1 = Math.max(last.x1, item.x1);
      } else {
        cells.push({ ...item });
      }
    }
    return { y: group[0].y, cells, items };
  });
}

/** Two header lines merged: cells that overlap horizontally are joined
 * top-then-bottom ("Reward" over "Points"); the rest are kept. */
function mergeHeaderLines(top: Cell[], bottom: Cell[]): Cell[] {
  const merged = top.map((c) => ({ ...c }));
  for (const cell of bottom) {
    const above = merged.find((c) => overlaps(c, cell, 4));
    if (above) {
      above.text += ' ' + cell.text;
      above.x0 = Math.min(above.x0, cell.x0);
      above.x1 = Math.max(above.x1, cell.x1);
    } else {
      merged.push({ ...cell });
    }
  }
  return merged.sort((a, b) => a.x0 - b.x0);
}

/** A header cell with no letters ("( ₹ )", rendered "( ` )") annotates the
 * column to its left — fold it in, so its values snap to that column. */
function foldUnitCells(cells: Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of cells) {
    const left = out.at(-1);
    if (left && !hasLetter(cell.text)) {
      left.text += ' ' + cell.text;
      left.x1 = Math.max(left.x1, cell.x1);
    } else {
      out.push({ ...cell });
    }
  }
  return out;
}

const isHeader = (cells: Cell[]) => {
  const t = resolveTable(texts(cells));
  return t !== null && t !== 'savings';
};

/** The table header starting at line i (alone, or wrapped onto line i+1),
 * and how many lines it spans; null if line i doesn't start one. */
function headerAt(
  lines: Line[],
  i: number,
): { cells: Cell[]; span: number } | null {
  if (isHeader(lines[i].cells)) {
    return { cells: foldUnitCells(lines[i].cells), span: 1 };
  }
  const next = lines[i + 1];
  if (next && lines[i].y - next.y <= HEADER_SECOND_LINE) {
    const merged = mergeHeaderLines(lines[i].cells, next.cells);
    if (isHeader(merged)) return { cells: foldUnitCells(merged), span: 2 };
  }
  return null;
}

/** A data line snapped into the header's columns: each item goes to the
 * column whose centre is nearest its own; items sharing a column are joined
 * in reading order ("835.49" + "D" → "835.49 D"). */
function snap(line: Line, columns: Cell[]): string[] {
  const row = columns.map(() => '');
  const table = resolveTable(texts(columns));
  const dateCol = table && table !== 'savings' ? table.dateCol : -1;
  const descCol = table && table !== 'savings' ? table.descCol : -1;
  for (const item of line.items) {
    let best = 0;
    for (let c = 1; c < columns.length; c++) {
      const d = Math.abs(center(columns[c]) - center(item));
      if (d < Math.abs(center(columns[best]) - center(item))) best = c;
    }
    // Headers are often centred over a wide column, so a short description
    // can sit nearer the Date header (SBI). The date column only takes what
    // looks like a date; any other text belongs to the description.
    if (best === dateCol && !DATE_START.test(item.text)) best = descCol;
    row[best] = row[best] ? `${row[best]} ${item.text}` : item.text;
  }
  return row;
}

/** Summary labels printed above their values, as [label, value] rows. A
 * label wrapped over two lines ("PAYMENTS/CREDITS" / "RECEIVED") is joined
 * first; marks with neither letters nor digits ("_", "+") are passed over. */
function labelValuePairs(lines: Line[]): string[][] {
  const pairs: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const label of lines[i].cells) {
      if (!hasLetter(label.text) || hasDigit(label.text)) continue;
      let text = label.text;
      let bottom = label.y;
      for (let j = i + 1; j < lines.length; j++) {
        if (label.y - lines[j].y > VALUE_BELOW) break;
        // Of what sits below the label, a cell with digits is the value
        // (the "C" that renders ₹ next to it is not).
        const below = lines[j].cells.filter(
          (c) =>
            overlaps(c, label, 12) && (hasLetter(c.text) || hasDigit(c.text)),
        );
        const under = below.find((c) => hasDigit(c.text)) ?? below[0];
        if (!under) continue;
        if (!hasDigit(under.text)) {
          if (bottom - under.y > LABEL_CONTINUES) break; // another label
          text += ' ' + under.text; // this label continues on the next line
          bottom = under.y;
          continue;
        }
        pairs.push([text, under.text]);
        break;
      }
    }
  }
  return pairs;
}

/** True when some line on the page, snapped to `columns`, has a real date
 * in the date column — i.e. the table continues on this page. Pages of
 * terms and worked examples ("Finance Charge on ₹1,424 from 3 April…") have
 * none, and must not be read as transactions. */
function continuesTable(lines: Line[], columns: Cell[]): boolean {
  const table = resolveTable(texts(columns));
  if (table === null || table === 'savings') return false;
  return lines.some((line) => {
    try {
      parseDate(snap(line, columns)[table.dateCol]);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Rows for the parser: first the label-over-value pairs (so the summary
 * reader sees them before the table), then page lines — plain cells above
 * the first table header, header-snapped rows from it on. After the first
 * table, only pages that have their own header or that continue the table
 * (a readable date in the date column) contribute rows.
 */
export function rowsFromPdfPages(
  pages: { items: PdfTextItem[] }[],
): unknown[][] {
  const pageLineSets = pages.map((p) => pageLines(p.items));
  const rows: unknown[][] = pageLineSets.flatMap(labelValuePairs);

  let columns: Cell[] | null = null;
  for (const lines of pageLineSets) {
    const hasHeader = lines.some((_, i) => headerAt(lines, i) !== null);
    if (columns && !hasHeader && !continuesTable(lines, columns)) continue;
    for (let i = 0; i < lines.length; i++) {
      const header = headerAt(lines, i);
      if (header) {
        columns = header.cells;
        rows.push(texts(columns));
        i += header.span - 1;
        continue;
      }
      rows.push(columns ? snap(lines[i], columns) : texts(lines[i].cells));
    }
  }
  return rows;
}
