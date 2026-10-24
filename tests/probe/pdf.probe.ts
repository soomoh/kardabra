// Local-only PDF spike probe: parses the anonymized PDF text files in
// inbox/synthetic (gitignored) and scores each with the totals check.
// Run: PROBE_OUT=out.json npx vitest run --config tests/probe/vitest.probe.config.ts tests/probe/pdf.probe.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, test } from 'vitest';
import { parsePdfText } from '../../src/parser';
import { reconcile } from '../../src/lib/reconcile';

const dir = join(__dirname, '../../inbox/synthetic');
const files = readdirSync(dir).filter((f) => f.endsWith('.pdf-text.json'));
const results: unknown[] = [];
const BANKS = ['HDFC', 'ICICI', 'Axis', 'SBI'];

test.each(files)('%s', (name) => {
  const json = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  const allText = json.pages
    .flatMap((p: { items: { s: string }[] }) => p.items.map((i) => i.s))
    .join(' ');
  const bank = BANKS.find((b) => allText.includes(b)) ?? '?';
  try {
    const p = parsePdfText(name, json.pages);
    const sum = (xs: number[]) =>
      Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
    results.push({
      name,
      bank,
      last4: p.last4,
      txns: p.transactions.length,
      debits: sum(
        p.transactions.filter((t) => t.amount < 0).map((t) => -t.amount),
      ),
      credits: sum(
        p.transactions.filter((t) => t.amount > 0).map((t) => t.amount),
      ),
      summary: p.summary,
      warnings: p.warnings.length,
      reconcile: reconcile(p.summary, p.transactions),
    });
  } catch (e) {
    results.push({ name, bank, error: String(e) });
  }
});

afterAll(() =>
  writeFileSync(
    process.env.PROBE_OUT ?? 'probe-out.json',
    JSON.stringify(results, null, 1),
  ),
);
