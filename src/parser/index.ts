/**
 * The statement parser's public entry point: turn one uploaded file into a
 * ParsedStatement. `parseStatement` reads a browser File; `parseStatementBytes`
 * is the synchronous, pure core it wraps (no I/O — easy to test and reusable
 * from a web worker). Individual pipeline steps are re-exported below for
 * callers that want just one stage.
 */

import { looksLikeExcel, loadExcelRows } from './excel';
import { parseDelimited } from './csv';
import { findTableHeader } from './table';
import { extractSummary } from './summary';
import { extractTransactions } from './transactions';
import { accountLast4 } from './account';
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

  // One header scan feeds both extractors: extractSummary needs headerAt to
  // know where the metadata block ends, and extractTransactions needs the
  // resolved table. Passing `found` in avoids scanning the rows twice.
  const found = findTableHeader(rows);
  const summary = extractSummary(rows, found.headerAt);
  const transactions = extractTransactions(rows, found);
  const last4 = accountLast4(rows);

  return { fileName, last4, summary, transactions };
}

/**
 * Decode CSV bytes to text, detecting the encodings banks still export beyond
 * UTF-8. A UTF-16 byte-order mark selects that encoding explicitly. Otherwise
 * the bytes are read as UTF-8; if that yields replacement characters (U+FFFD,
 * the signature of non-UTF-8 bytes decoded as UTF-8) they're re-read as
 * Windows-1252, the single-byte encoding those legacy exports almost always
 * use. TextDecoder strips a leading BOM on its own.
 */
function decodeText(bytes: Uint8Array): string {
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

export type { Transaction, StatementSummary, ParsedStatement } from './types';
export { StatementError, type StatementErrorKind } from './errors';
export { cleanText, norm, cleanAmount } from './cells';
export { parseDate } from './dates';
export { parseDelimited } from './csv';
export { resolveTable, findTableHeader, type Table } from './table';
export { loadExcelRows, looksLikeExcel } from './excel';
export { extractSummary } from './summary';
export { extractTransactions } from './transactions';
export { accountLast4 } from './account';
