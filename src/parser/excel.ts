/**
 * Read an Excel workbook's first sheet into rows.
 *
 * Dependency: SheetJS (`xlsx`), pinned in package.json to the tarball at
 * https://cdn.sheetjs.com — NOT the `xlsx` package on the npm registry,
 * which has been frozen at 0.18.5 (known CVEs) since SheetJS moved
 * distribution off npm. It's also the only maintained browser-side
 * library that still reads the legacy OLE2 .xls format alongside modern
 * .xlsx, so one dependency covers both container types.
 *
 * Read options, and why (see excel.test.ts, which pins these down against
 * real sample .xlsx/.xls statement files):
 *   - `type: 'array'` — accepts a Uint8Array directly (what
 *     `file.arrayBuffer()` yields in the browser), no Node Buffer needed.
 *   - `header: 1` in sheet_to_json — rows of arrays, matching every other
 *     reader in this parser (parseDelimited returns the same shape).
 *   - `raw: true` — hand back each cell's stored value type as-is, rather
 *     than running it through the cell's display format string. Every
 *     cell in the test fixtures is stored as text already (verified
 *     directly against the cell objects, not just the visible output), so
 *     `raw` doesn't change their result here — but `raw: false` would
 *     additionally reformat any *genuinely* numeric/date cell through
 *     Excel's number-format string, a second, harder-to-predict source of
 *     drift. `raw: true` hands back exactly what the sheet has stored.
 *   - `defval: null` — pad missing cells with `null` rather than leaving
 *     them `undefined`, so every row comes out the same width and
 *     cells.ts's `cleanText`/`cleanAmount` (which already treat
 *     `null`/`undefined` identically) never have to special-case a
 *     missing trailing cell.
 *   - `cellDates` is left at its default (off). Most banks export dates as
 *     text, but some store real Excel date-serial cells; with `cellDates`
 *     off those arrive as raw serial numbers, and `parseDate` handles the
 *     numeric-serial case directly (see `isoFromExcelSerial` in dates.ts).
 *     Turning `cellDates` on would instead hand back `Date` objects — an
 *     extra typed branch to carry — for no gain, since the serial path
 *     already round-trips correctly. Left off deliberately.
 */

import * as XLSX from 'xlsx';
import { StatementError } from './errors';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // 'PK\x03\x04' — .xlsx (a zip container)
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .xls (an OLE2/BIFF container)

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

/** True if `bytes` opens with either Excel container's magic number.
 * Exported so the parseStatement façade can decide, before ever calling
 * loadExcelRows, whether to route a file to the Excel reader or the
 * delimited-text reader — the magic-byte check happens in exactly one
 * place regardless of which caller needs the answer. */
export function looksLikeExcel(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, OLE2_MAGIC);
}

/**
 * Rows of the first sheet of an Excel file (.xlsx or legacy .xls). The
 * reader is picked from the file's magic bytes, never its extension —
 * banks mislabel both ways (ICICI names .xlsx files .xls; HDFC ships
 * genuine legacy .xls) — trust content, not names.
 */
export function loadExcelRows(bytes: Uint8Array): unknown[][] {
  if (!looksLikeExcel(bytes)) {
    throw new StatementError(
      'not-excel',
      'not an Excel file (no .xlsx or legacy .xls signature)',
      're-download the statement, or export it as CSV instead',
    );
  }
  // Both containers go through the same SheetJS entry point — it sniffs
  // the format internally too, this check exists only to fail fast with a
  // Kardabra-specific error (and error kind) instead of SheetJS's own.
  const workbook = XLSX.read(bytes, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    raw: true,
    defval: null,
  });
}
