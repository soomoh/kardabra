// Local-only: list parsed transactions for one PDF text file (PROBE_FILE).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { parsePdfText } from '../../src/parser';

test('txns', () => {
  const file = join(
    __dirname,
    '../../inbox/synthetic',
    process.env.PROBE_FILE!,
  );
  const p = parsePdfText('x', JSON.parse(readFileSync(file, 'utf8')).pages);
  writeFileSync(
    process.env.PROBE_OUT!,
    JSON.stringify({ txns: p.transactions, warnings: p.warnings }, null, 1),
  );
});
