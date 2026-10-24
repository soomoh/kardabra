// Local-only probe: parses whatever is in inbox/templates (gitignored) and
// writes a structural summary to $PROBE_OUT.
// Run: PROBE_OUT=out.json npx vitest run --config tests/probe/vitest.probe.config.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, afterAll } from 'vitest';
import { parseStatementBytes } from '../../src/parser';

const dir = join(__dirname, '../../inbox/templates');
const files = readdirSync(dir).filter((f) => !f.includes(':'));
const results: unknown[] = [];
const sum = (xs: { amount: number }[]) =>
  Math.round(xs.reduce((s, t) => s + t.amount, 0) * 100) / 100;

test.each(files)('%s', (name) => {
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  try {
    const p = parseStatementBytes(name, bytes);
    const debits = p.transactions.filter((t) => t.amount < 0);
    const credits = p.transactions.filter((t) => t.amount > 0);
    const dates = p.transactions.map((t) => t.dateISO).sort();
    results.push({
      name,
      last4: p.last4,
      summary: p.summary,
      txns: p.transactions.length,
      debits: debits.length,
      debitTotal: sum(debits),
      credits: credits.length,
      creditTotal: sum(credits),
      nan: p.transactions.filter((t) => Number.isNaN(t.amount)).length,
      range: [dates[0], dates.at(-1)],
    });
  } catch (e) {
    results.push({ name, error: String(e) });
  }
});

afterAll(() =>
  writeFileSync(
    process.env.PROBE_OUT ?? 'probe-out.json',
    JSON.stringify(results, null, 1),
  ),
);

// Anonymizer round-trip on the real layouts: same structure after anonymizing.
test.each(files)('anonymized %s keeps its structure', async (name) => {
  const { anonymizeFile } = await import('../../src/anonymize');
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  const out = await anonymizeFile(bytes, { seed: 4242 });
  const shape = (n: string, b: Uint8Array) => {
    try {
      const p = parseStatementBytes(n, b);
      return {
        txns: p.transactions.map((t) => Math.sign(t.amount)),
        summary: Object.keys(p.summary).sort(),
        last4: p.last4 !== null,
      };
    } catch (e) {
      return { error: (e as Error).name };
    }
  };
  results.push({
    roundTrip: name,
    same:
      JSON.stringify(shape(name, bytes)) ===
      JSON.stringify(shape(out.fileName, out.data)),
    before: shape(name, bytes),
    after: shape(out.fileName, out.data),
  });
});

// Totals check on the real layouts: every card template must add up.
test.each(files)('totals check on %s', async (name) => {
  const { reconcile } = await import('../../src/lib/reconcile');
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  try {
    const p = parseStatementBytes(name, bytes);
    results.push({
      reconcile: name,
      result: reconcile(p.summary, p.transactions),
    });
  } catch {
    results.push({ reconcile: name, result: 'not a card statement' });
  }
});
