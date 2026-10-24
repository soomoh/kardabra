// Local-only: dump rebuilt PDF rows for one file (PROBE_FILE) to PROBE_OUT.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { rowsFromPdfPages } from '../../src/parser/pdfRows';
import { findTableHeader } from '../../src/parser';

test('dump', () => {
  const file = join(
    __dirname,
    '../../inbox/synthetic',
    process.env.PROBE_FILE!,
  );
  const rows = rowsFromPdfPages(JSON.parse(readFileSync(file, 'utf8')).pages);
  let header = -1;
  try {
    header = findTableHeader(rows).headerAt;
  } catch {
    /* none */
  }
  writeFileSync(
    process.env.PROBE_OUT!,
    rows
      .map((r, i) => `${i === header ? '>>' : '  '}${i}: ${JSON.stringify(r)}`)
      .join('\n'),
  );
});
