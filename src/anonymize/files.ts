/**
 * Whole-file anonymization: bytes of a real statement in, bytes of a
 * synthetic one with the same layout out. The container is decided by the
 * file's content, like the parser does (trust content, not names), and is
 * reproduced: CSV stays CSV with its own delimiter, .xlsx stays .xlsx, legacy
 * .xls stays .xls. PDFs are not rewritten — they become the positioned text
 * the PDF importer consumes (see pdf.ts).
 *
 * Works on raw rows and cells, never on the parser's output, so it handles the
 * files Kardabra can't read yet — which is exactly what gets contributed.
 */

import * as XLSX from 'xlsx';
import {
  decodeText,
  detectDelimited,
  inferDateOrder,
  looksLikeExcel,
} from '../parser';
import { createAnonymizer, type Anonymizer } from './anonymizer';
import { anonymizePdf, looksLikePdf } from './pdf';

export interface AnonymizedFile {
  /** Neutral name — the original may contain a name or card digits. */
  fileName: string;
  data: Uint8Array;
  /** Plain-text review notes to read before sharing. Never contains the
   * offset, factor or any original value other than the verbatim list. */
  report: string;
  /** For a locked PDF: index into the passwords tried that opened it (null
   * when it needed none). Never the password itself. */
  unlockedWith?: number | null;
}

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const WHOLE_INTEGER = /^\s*-?\d+\s*$/;

function neutralName(ext: string): string {
  const buf = new Uint8Array(3);
  crypto.getRandomValues(buf);
  const id = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `synthetic-${id}.${ext}`;
}

/** One CSV/spreadsheet text cell. A cell that is only an integer is an amount
 * column value ("2672"), so it is scaled rather than digit-randomised. */
function cellText(anon: Anonymizer, cell: string): string {
  if (WHOLE_INTEGER.test(cell) && cell.trim().replace('-', '').length <= 9) {
    return cell.replace(/-?\d+/, (n) => String(anon.number(Number(n))));
  }
  return anon.text(cell);
}

function quoteCsv(cell: string, delimiter: string): string {
  return /["\r\n]/.test(cell) || cell.includes(delimiter)
    ? `"${cell.replace(/"/g, '""')}"`
    : cell;
}

function anonymizeCsv(bytes: Uint8Array, anon: Anonymizer): Uint8Array {
  const { delimiter, rows } = detectDelimited(decodeText(bytes));
  const text = rows
    .map((row) =>
      row.map((c) => quoteCsv(cellText(anon, c), delimiter)).join(delimiter),
    )
    .join('\r\n');
  return new TextEncoder().encode(text + '\r\n');
}

function anonymizeWorkbook(
  bytes: Uint8Array,
  anon: Anonymizer,
  legacy: boolean,
): Uint8Array {
  const wb = XLSX.read(bytes, {
    type: 'array',
    cellNF: true,
    cellFormula: false,
  });
  // Document properties often carry an author or account name.
  wb.Props = {};
  wb.Custprops = {};

  const renamed: string[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    for (const addr of Object.keys(sheet)) {
      if (addr.startsWith('!')) continue;
      const cell = sheet[addr] as XLSX.CellObject;
      delete cell.w; // cached formatted text would show the original
      delete cell.h;
      delete cell.r;
      delete cell.f;
      delete cell.c; // comments
      delete cell.l; // hyperlinks
      if (cell.t === 's' && typeof cell.v === 'string') {
        cell.v = cellText(anon, cell.v);
      } else if (cell.t === 'n' && typeof cell.v === 'number') {
        const isDate = typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z);
        cell.v = isDate ? anon.dateSerial(cell.v) : anon.number(cell.v);
      }
    }
    const newName = anon.text(name).slice(0, 31);
    wb.Sheets[newName] = sheet;
    if (newName !== name) delete wb.Sheets[name];
    renamed.push(newName);
  }
  wb.SheetNames = renamed;

  const out = XLSX.write(wb, {
    type: 'array',
    bookType: legacy ? 'biff8' : 'xlsx',
  });
  return new Uint8Array(out as ArrayBuffer);
}

function buildReport(
  kind: string,
  anon: Anonymizer,
  extra: string[] = [],
): string {
  const kept = anon.keptVerbatim();
  return [
    `Kardabra anonymizer report (${kind})`,
    '',
    'Changed: names, merchants, addresses and other words → look-alike',
    'pseudo-words; dates → shifted by a secret number of days; amounts →',
    'scaled by a secret factor (format kept); card numbers → same mask, fake',
    'digits after the first four; other numbers → random digits.',
    ...extra,
    '',
    `Kept exactly as-is (${kept.length}) — check nothing here is personal`,
    'before sharing:',
    ...kept.map((k) => `  ${k}`),
    '',
    `Words kept inside changed text (${anon.keptWords().length}) — these are`,
    'labels and keywords; check none of them is a name:',
    `  ${anon.keptWords().join(', ')}`,
    '',
  ].join('\n');
}

/**
 * Anonymize one statement file. `passwords` (or a single `password`) are tried
 * in order only for an encrypted PDF;
 * and is never stored or written out. Throws (with an actionable message)
 * only for a missing/wrong PDF password or an unreadable file.
 */
/** Every text cell of a tabular file — enough to infer its date order. */
function textCells(bytes: Uint8Array): string[] {
  if (looksLikeExcel(bytes)) {
    const wb = XLSX.read(bytes, { type: 'array' });
    return wb.SheetNames.flatMap((n) =>
      XLSX.utils
        .sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: false })
        .flat()
        .map(String),
    );
  }
  return detectDelimited(decodeText(bytes)).rows.flat();
}

export async function anonymizeFile(
  bytes: Uint8Array,
  options: { password?: string; passwords?: string[]; seed?: number } = {},
): Promise<AnonymizedFile> {
  // Day-first vs month-first is a property of the file, decided once (the
  // parser's own rule), so every date shifts the same way.
  const dateOrder = looksLikePdf(bytes)
    ? 'dmy'
    : inferDateOrder(textCells(bytes));
  const anon = createAnonymizer(options.seed, dateOrder);

  if (looksLikePdf(bytes)) {
    const passwords =
      options.passwords ??
      (options.password !== undefined ? [options.password] : []);
    const { text: json, unlockedWith } = await anonymizePdf(
      bytes,
      anon,
      passwords,
    );
    return {
      fileName: neutralName('pdf-text.json'),
      data: new TextEncoder().encode(JSON.stringify(json, null, 1) + '\n'),
      report: buildReport('PDF → positioned text', anon, [
        'The PDF itself is not shared: only its text and positions, which is',
        'what Kardabra reads. Fonts, images and page graphics are dropped.',
      ]),
      unlockedWith,
    };
  }
  if (looksLikeExcel(bytes)) {
    const legacy = OLE2_MAGIC.every((b, i) => bytes[i] === b);
    return {
      fileName: neutralName(legacy ? 'xls' : 'xlsx'),
      data: anonymizeWorkbook(bytes, anon, legacy),
      report: buildReport(legacy ? 'Excel 97–2003' : 'Excel', anon, [
        'Workbook properties (author, title), comments and links removed.',
      ]),
    };
  }
  return {
    fileName: neutralName('csv'),
    data: anonymizeCsv(bytes, anon),
    report: buildReport('delimited text', anon, [
      'Re-encoded as UTF-8 (the original encoding is not kept).',
    ]),
  };
}
