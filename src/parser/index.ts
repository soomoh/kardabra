/**
 * The statement parser's public entry point: turn one uploaded file into a
 * ParsedStatement. `parseStatement` reads a browser File; `parseStatementBytes`
 * is the synchronous, pure core it wraps (no I/O — easy to test and reusable
 * from a web worker). Individual pipeline steps are re-exported below for
 * callers that want just one stage.
 */

import { issuerFromRows } from './issuer';
import { looksLikeExcel, loadExcelRows } from './excel';
import { parseDelimited } from './csv';
import { findTableHeader } from './table';
import { extractSummary } from './summary';
import { extractTransactionsWithWarnings } from './transactions';
import { inferLocale } from './locale';
import { inferCurrency } from './currency';
import { accountLast4 } from './account';
import { rowsFromPdfPages, type PdfTextItem } from './pdfRows';
import type { ParsedStatement } from './types';

/**
 * Parse a statement file's raw bytes into a ParsedStatement.
 *
 * The file's *content* decides how it's read, never its name. Banks mislabel
 * exports both ways — a real .xlsx workbook saved as ".xls", or a plain-text
 * CSV renamed ".xls" by a user re-saving a download — so the extension can't be
 * trusted. The magic bytes at the start of the file can't lie about which
 * reader the data actually needs.
 */
export function parseStatementBytes(
  fileName: string,
  bytes: Uint8Array,
): ParsedStatement {
  const rows: unknown[][] = looksLikeExcel(bytes)
    ? loadExcelRows(bytes)
    : parseDelimited(decodeText(bytes));
  return parseRows(fileName, rows);
}

/** Parse a PDF statement from its positioned text (what pdf.js extracts, or
 * an anonymized `kardabra-pdf-text/1` file) — rows are rebuilt from the
 * text's geometry, then read exactly like a spreadsheet's. */
export function parsePdfText(
  fileName: string,
  pages: { items: PdfTextItem[] }[],
): ParsedStatement {
  return parseRows(fileName, rowsFromPdfPages(pages));
}

/** The shared pipeline: rows (from any container) → a parsed statement. */
export function parseRows(
  fileName: string,
  rows: unknown[][],
): ParsedStatement {
  // One header scan feeds both extractors: extractSummary needs headerAt to
  // know where the metadata block ends, and extractTransactions needs the
  // resolved table. Passing `found` in avoids scanning the rows twice.
  const found = findTableHeader(rows);
  // Decimal style and date order are decided once, from the whole file.
  const locale = inferLocale(rows, found);
  const summary = extractSummary(rows, found.headerAt, locale);
  const { transactions, warnings } = extractTransactionsWithWarnings(
    rows,
    found,
    locale,
  );
  const last4 = accountLast4(rows, locale.dateOrder);
  const currency = inferCurrency(rows, found);
  const issuer = issuerFromRows(rows, found.headerAt);

  return {
    fileName,
    last4,
    currency,
    ...(issuer !== undefined && { issuer }),
    summary,
    transactions,
    warnings,
  };
}

/**
 * Decode CSV bytes to text, detecting the encodings banks still export beyond
 * UTF-8. A UTF-16 byte-order mark selects that encoding explicitly. Otherwise
 * the bytes are read as UTF-8; if that yields replacement characters (U+FFFD,
 * the signature of non-UTF-8 bytes decoded as UTF-8) they're re-read as
 * Windows-1252, the single-byte encoding those legacy exports almost always
 * use. TextDecoder strips a leading BOM on its own.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1252').decode(bytes);
}

/** Read a browser File and parse it. `File` is a global in both the browser and
 * Node's test environment, so this needs no runtime-specific handling. */
export async function parseStatement(file: File): Promise<ParsedStatement> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return parseStatementBytes(file.name, bytes);
}

/** Best-effort row preview for diagnostics — the same content routing as
 * parseStatementBytes, but it never throws, so a file that failed to parse can
 * still be described. Returns whatever rows the reader produced (possibly none). */
export function previewRows(bytes: Uint8Array): {
  contentType: 'excel' | 'delimited';
  rows: unknown[][];
} {
  const isExcel = looksLikeExcel(bytes);
  const contentType = isExcel ? 'excel' : 'delimited';
  try {
    const rows = isExcel
      ? loadExcelRows(bytes)
      : parseDelimited(decodeText(bytes));
    return { contentType, rows };
  } catch {
    return { contentType, rows: [] };
  }
}

export type {
  Transaction,
  StatementSummary,
  ParsedStatement,
  ParseWarning,
} from './types';
export { StatementError, type StatementErrorKind } from './errors';
export {
  cleanText,
  norm,
  cleanAmount,
  parseAmount,
  type ParsedAmount,
  type AmountMarker,
  type DecimalStyle,
} from './cells';
export { parseDate, inferDateOrder, type DateOrder } from './dates';
export { inferLocale, type Locale } from './locale';
export { inferCurrency } from './currency';
export { parseDelimited, detectDelimited } from './csv';
export { resolveTable, findTableHeader, type Table } from './table';
export { loadExcelRows, looksLikeExcel } from './excel';
export { extractSummary } from './summary';
export {
  extractTransactions,
  extractTransactionsWithWarnings,
} from './transactions';
export { accountLast4 } from './account';
export {
  looksLikePdf,
  readPdfText,
  PdfPasswordError,
  type PdfJs,
  type PdfPage,
} from './pdf';
