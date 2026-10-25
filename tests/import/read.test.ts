/**
 * Step zero of an import: files → ParseResults, with password-protected
 * PDFs set aside and unlocked once per batch. Runs pdf.js's legacy (Node)
 * build through the same readPdfText the browser uses.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  candidatesFor,
  readStatementFiles,
  skippedLockedResults,
  unlockFiles,
  type InputFile,
  type PdfReader,
} from '../../src/import/read';
import { planImport } from '../../src/import/plan';
import { commitImport } from '../../src/import/commit';
import { getAllCards, openKardabraDb } from '../../src/db/db';
import { readPdfText } from '../../src/parser';

const dir = join(__dirname, '../fixtures');
const file = (name: string, as = name): InputFile => ({
  name: as,
  bytes: new Uint8Array(readFileSync(join(dir, name))),
});
const readPdf: PdfReader = async (bytes, passwords) =>
  readPdfText(
    await import('pdfjs-dist/legacy/build/pdf.mjs'),
    bytes,
    passwords,
  );
// The synthetic fixture's cardholder: "JANE DOE", born 20/10. Its password
// is fabricated (see tests/fixtures/README.md).
const FIXTURE_PASSWORD = 'JANE2010'; // pragma: allowlist secret
const jane = { name: 'Jane Doe', dob: { day: 20, month: 10, year: 1990 } };

describe('readStatementFiles', () => {
  it('parses an unlocked PDF like a spreadsheet', async () => {
    const { results, locked } = await readStatementFiles(
      [file('pdf_statement.pdf')],
      readPdf,
    );
    expect(locked).toEqual([]);
    const [result] = results;
    if (!('parsed' in result)) throw result.error;
    expect(result.parsed.last4).toBe('4242');
    expect(result.parsed.summary.totalDue).toBe(12345.67);
    expect(result.parsed.transactions).toHaveLength(3);
  });

  it('sets a locked PDF aside and still parses the rest of the batch', async () => {
    const { results, locked } = await readStatementFiles(
      [file('pdf_statement_locked.pdf'), file('hdfc_style.csv')],
      readPdf,
    );
    expect(locked.map((f) => f.name)).toEqual(['pdf_statement_locked.pdf']);
    expect(results.map((r) => r.fileName)).toEqual(['hdfc_style.csv']);
    expect('parsed' in results[0]).toBe(true);
  });

  it('contains a broken PDF to its own error result', async () => {
    const broken = {
      name: 'broken.pdf',
      bytes: new TextEncoder().encode('%PDF-1.4 junk'),
    };
    const { results, locked } = await readStatementFiles([broken], readPdf);
    expect(locked).toEqual([]);
    expect('error' in results[0]).toBe(true);
  });
});

describe('unlockFiles', () => {
  const locked = () => [file('pdf_statement_locked.pdf')];

  it('opens a locked PDF from the cardholder details and names the pattern', async () => {
    const out = await unlockFiles(
      locked(),
      { details: { ...jane, last4s: [] } },
      [],
      readPdf,
    );
    expect(out.stillLocked).toEqual([]);
    expect(out.patterns.get('pdf_statement_locked.pdf')).toBe('name4U+ddmm');
    expect('parsed' in out.results[0]).toBe(true);
  });

  it('opens with one of several typed passwords, never remembering it', async () => {
    // Passwords for other banks' files come first: each is tried on every file.
    const out = await unlockFiles(
      locked(),
      { passwords: ['OTHER0101', 'third', FIXTURE_PASSWORD] },
      [],
      readPdf,
    );
    expect(out.stillLocked).toEqual([]);
    expect(out.patterns.size).toBe(0);
  });

  it('leaves the file locked when nothing matches', async () => {
    const out = await unlockFiles(
      locked(),
      {
        details: {
          name: 'Someone Else',
          dob: { day: 1, month: 1, year: 1980 },
          last4s: [],
        },
      },
      [],
      readPdf,
    );
    expect(out.stillLocked.map((f) => f.name)).toEqual([
      'pdf_statement_locked.pdf',
    ]);
    expect(out.results).toEqual([]);
  });

  it('skipped files become an understood rejection, not a failure', () => {
    const [result] = skippedLockedResults(locked());
    const [outcome] = planImport([result], [], []);
    expect(outcome).toMatchObject({
      kind: 'rejected',
      errorKind: 'pdf-locked',
    });
  });
});

describe('candidatesFor', () => {
  const details = { ...jane, last4s: ['4242'] };

  it('tries typed passwords first, then known patterns, without repeats', () => {
    const list = candidatesFor(
      'x.pdf',
      { details, passwords: ['other', FIXTURE_PASSWORD, 'other', ''] },
      ['ddmmyyyy'],
    );
    expect(list.slice(0, 2)).toEqual([
      { pattern: 'typed', password: 'other' },
      { pattern: 'typed', password: FIXTURE_PASSWORD },
    ]);
    expect(list[2].pattern).toBe('ddmmyyyy');
    expect(list.filter((c) => c.password === FIXTURE_PASSWORD)).toHaveLength(1);
  });

  it('starts from the bank the file name points to', () => {
    expect(candidatesFor('sbi_statement.pdf', { details }, [])[0].pattern).toBe(
      'ddmmyyyy+last4',
    );
  });
});

describe('the winning pattern is remembered on the card', () => {
  afterEach(async () => {
    indexedDB.deleteDatabase('kardabra');
  });

  it('on a new card, and updated on an existing one', async () => {
    const db = await openKardabraDb();
    const unlocked = await unlockFiles(
      [file('pdf_statement_locked.pdf')],
      { details: { ...jane, last4s: [] } },
      [],
      readPdf,
    );
    const outcomes = planImport(unlocked.results, [], []);
    await commitImport(db, outcomes, {
      nicknames: new Map([['4242', 'Example']]),
      dueDays: new Map([['4242', 9]]),
      passwordPatterns: unlocked.patterns,
    });
    expect((await getAllCards(db))[0].pdfPasswordPattern).toBe('name4U+ddmm');

    // A later month opened by a different pattern replaces it.
    const later = await readStatementFiles(
      [file('pdf_statement.pdf', 'next.pdf')],
      readPdf,
    );
    const result = later.results[0];
    if (!('parsed' in result)) throw result.error;
    const nextMonth = {
      fileName: 'next.pdf',
      parsed: {
        ...result.parsed,
        fileName: 'next.pdf',
        summary: { ...result.parsed.summary, statementDateISO: '2025-11-20' },
      },
    };
    const cards = await getAllCards(db);
    await commitImport(db, planImport([nextMonth], cards, []), {
      nicknames: new Map(),
      dueDays: new Map(),
      passwordPatterns: new Map([['next.pdf', 'name4U+ddmmyyyy']]),
    });
    expect((await getAllCards(db))[0].pdfPasswordPattern).toBe(
      'name4U+ddmmyyyy',
    );
    db.close();
  });
});
