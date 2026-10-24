/**
 * The anonymizer's real contract, pinned on every committed fixture: the
 * synthetic file parses to the same *structure* as the original (so it is a
 * valid test fixture), and none of the original's personal words survive.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import {
  anonymizeFile,
  isStructuralWord,
  PdfPasswordError,
} from '../../src/anonymize';
import {
  decodeText,
  parseStatementBytes,
  StatementError,
} from '../../src/parser';

const dir = join(__dirname, '../fixtures');
const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
const SEED = 777;

/** Every non-structural word in a file's text (the things that must vanish). */
function personalWords(text: string): string[] {
  return [...new Set(text.match(/\p{L}{3,}/gu) ?? [])].filter(
    (w) => !isStructuralWord(w) && !/^[Xx]+$/.test(w), // XXXX is a card mask
  );
}

function textOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x50 || bytes[0] === 0xd0) {
    const wb = XLSX.read(bytes, { type: 'array' });
    return wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join(
      '\n',
    );
  }
  return decodeText(bytes);
}

const CARD_FIXTURES = [
  'hdfc_style.csv',
  'layout3_incell.csv',
  'axis_style.xlsx',
  'legacy.xls',
  'serial_dates.xlsx',
  'windows1252.csv',
  'utf16.csv',
];

describe.each(CARD_FIXTURES)('%s', (name) => {
  const original = read(name);

  it('parses to the same structure after anonymizing', async () => {
    const out = await anonymizeFile(original, { seed: SEED });
    const before = parseStatementBytes(name, original);
    const after = parseStatementBytes(out.fileName, out.data);

    expect(after.transactions).toHaveLength(before.transactions.length);
    // The catastrophic failure for a fixture: a credit turning into a debit.
    expect(after.transactions.map((t) => Math.sign(t.amount))).toEqual(
      before.transactions.map((t) => Math.sign(t.amount)),
    );
    expect(Object.keys(after.summary).sort()).toEqual(
      Object.keys(before.summary).sort(),
    );
    expect(after.last4 === null).toBe(before.last4 === null);
    if (before.last4 !== null) expect(after.last4).not.toBe(before.last4);

    // One offset for every date in the file.
    const offsets = before.transactions.map(
      (t, i) =>
        Date.parse(after.transactions[i].dateISO) - Date.parse(t.dateISO),
    );
    expect(new Set(offsets).size).toBe(1);
  });

  it('removes every non-structural word', async () => {
    const out = await anonymizeFile(original, { seed: SEED });
    const outText = textOf(out.data);
    for (const word of personalWords(textOf(original))) {
      expect(outText, `"${word}" survived`).not.toContain(word);
    }
  });

  it('keeps the container type and uses a neutral file name', async () => {
    const out = await anonymizeFile(original, { seed: SEED });
    expect(out.fileName).toMatch(/^synthetic-[0-9a-f]{6}\.(csv|xlsx|xls)$/);
    expect(out.data[0] === original[0] || name.endsWith('.csv')).toBe(true);
    expect(out.report).toContain('Kept exactly as-is');
  });
});

it('a bank-account statement is still rejected the same way after anonymizing', async () => {
  const out = await anonymizeFile(read('savings_reject.csv'), { seed: SEED });
  expect(() => parseStatementBytes(out.fileName, out.data)).toThrow(
    StatementError,
  );
});

describe('PDF → positioned text', () => {
  it('extracts and anonymizes an unencrypted statement', async () => {
    const out = await anonymizeFile(read('pdf_statement.pdf'), { seed: SEED });
    expect(out.fileName).toMatch(/\.pdf-text\.json$/);
    const json = JSON.parse(new TextDecoder().decode(out.data));
    expect(json.format).toBe('kardabra-pdf-text/1');
    const text = json.pages[0].items.map((i: { s: string }) => i.s).join(' ');
    expect(text).toContain('Total Amount Due');
    expect(text).toContain('PAYMENT RECEIVED THANK YOU');
    expect(text).toMatch(/4111 \d\dXX XXXX \d{4}/);
    for (const word of [
      'JANE',
      'DOE',
      'SAMPLE',
      'PUNE',
      'MOCHA',
      'KORAMANGALA',
      'NOOK',
      'INDIRANAGAR',
    ]) {
      expect(text).not.toContain(word);
    }
    expect(text).not.toContain('12,345.67');
  });

  it('asks for a password, rejects a wrong one, opens with the right one', async () => {
    const locked = read('pdf_statement_locked.pdf');
    await expect(anonymizeFile(locked)).rejects.toMatchObject({
      reason: 'needed',
    });
    await expect(
      anonymizeFile(locked, { password: 'WRONG' }),
    ).rejects.toBeInstanceOf(PdfPasswordError);
    const out = await anonymizeFile(locked, {
      // Fabricated password of the synthetic fixture (see generate-pdf.sh).
      password: 'JANE2010', // pragma: allowlist secret
      seed: SEED,
    });
    const json = JSON.parse(new TextDecoder().decode(out.data));
    expect(JSON.stringify(json)).not.toContain('JANE');
    expect(JSON.stringify(json)).not.toContain('JANE2010');
  });
});

// Tries a list in order and reports which one opened it — never the password.
it('opens a locked PDF from a candidate list and reports the winning index', async () => {
  const locked = read('pdf_statement_locked.pdf');
  const out = await anonymizeFile(locked, {
    // Fabricated fixture password is the third candidate.
    passwords: ['nope', 'jane2010', 'JANE2010'], // pragma: allowlist secret
    seed: SEED,
  });
  expect(out.unlockedWith).toBe(2);
  const plain = await anonymizeFile(read('pdf_statement.pdf'), {
    passwords: ['x'],
  });
  expect(plain.unlockedWith).toBeNull();
});
