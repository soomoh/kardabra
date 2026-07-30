/**
 * Regenerates the synthetic Excel fixtures used by the parser tests.
 *
 *   node tests/fixtures/generate.mjs
 *
 * Every value here is fabricated. The point of these files is to reproduce the
 * *shapes* real bank exports use (a newline-packed summary block, a Debit/Credit
 * marker column, a wrapped-narration continuation row, both Excel container
 * formats) so the parser is tested against those shapes, never against anyone's
 * real statement. The CSV fixtures next to this script are hand-written; only
 * the binary Excel files need generating.
 */
import * as XLSX from 'xlsx';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Write one sheet-of-arrays workbook to `name` in this directory. SheetJS's
 * ESM build doesn't wire up Node's fs, so serialize to a buffer and write it
 * ourselves rather than calling XLSX.writeFile. */
function write(name, aoa, bookType) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Statement');
  const buf = XLSX.write(wb, { bookType, type: 'buffer' });
  writeFileSync(join(here, name), buf);
}

// axis_style.xlsx — .xlsx container (ZIP). Summary packed one field per cell as
// "label\nvalue" (the newline-pair shape), a "06 Nov '25" style date, a card
// line for last-4 recovery, and a wrapped narration that continues on the next
// row with no date of its own.
write(
  'axis_style.xlsx',
  [
    [
      "Statement Date\n05 Nov '25",
      "Payment Due Date\n30 Nov '25",
      'Total Payment Due\n9,500.00',
    ],
    [],
    ['Card No: 5610 52XX XXXX 7788'],
    [],
    ['Date', 'Transaction Details', 'Amount', 'Debit/Credit'],
    ["06 Nov '25", 'BIG BAZAAR MUMBAI', '2,500.00', 'Dr'],
    ["07 Nov '25", 'ONLINE PYMT RECEIVED', '9,500.00', 'Cr'],
    ["09 Nov '25", 'RESTAURANT MG ROAD', '1,200.00', 'Dr'],
    ['', 'TABLE BOOKING CONTINUED', '', ''],
  ],
  'xlsx',
);

// legacy.xls — legacy BIFF8 container (OLE2), the format that only survives in
// old bank exports. A plain Debit/Credit marker layout.
write(
  'legacy.xls',
  [
    ['Statement Date', '10/10/2025'],
    [],
    ['Date', 'Description', 'Amount', 'Debit/Credit'],
    ['01/10/2025', 'GROCERY MART', '800.00', 'Dr'],
    ['03/10/2025', 'CASHBACK OFFER', '150.00', 'Cr'],
  ],
  'biff8',
);

// serial_dates.xlsx — date cells stored as real Excel date serials (numbers),
// the way many bank exports store dates rather than as text.
write(
  'serial_dates.xlsx',
  [
    ['Statement Date', '15/11/2025'],
    [],
    ['Date', 'Description', 'Amount', 'Debit/Credit'],
    [new Date(Date.UTC(2025, 10, 3)), 'STORE ONE', '1000.00', 'Dr'],
    [new Date(Date.UTC(2025, 10, 8)), 'STORE TWO', '500.00', 'Dr'],
  ],
  'xlsx',
);

// windows1252.csv — a non-UTF-8 (Windows-1252 / Latin-1) export: the accented
// bytes are invalid UTF-8 and must be recovered by the encoding fallback.
writeFileSync(
  join(here, 'windows1252.csv'),
  Buffer.from(
    'Date,Description,Amount\n01-10-2025,CAFÉ MÜNCHEN,250.00\n',
    'latin1',
  ),
);

// utf16.csv — UTF-16 little-endian with a byte-order mark.
writeFileSync(
  join(here, 'utf16.csv'),
  Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(
      'Date,Description,Amount\n02-10-2025,METRO CARD,99.00\n',
      'utf16le',
    ),
  ]),
);

console.log(
  'wrote axis_style.xlsx, legacy.xls, serial_dates.xlsx, windows1252.csv, utf16.csv',
);
