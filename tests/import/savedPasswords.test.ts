/**
 * Remembered PDF passwords, end to end over the synthetic locked fixture:
 * unlock → seal → commit → the next import opens with what was saved.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IDBPDatabase } from 'idb';
import {
  readStatementFiles,
  skippedLockedResults,
  unlockFiles,
  type InputFile,
  type PdfReader,
} from '../../src/import/read';
import { planImport } from '../../src/import/plan';
import { commitImport } from '../../src/import/commit';
import {
  loadSavedPasswords,
  sealPasswords,
} from '../../src/import/savedPasswords';
import {
  getAllCards,
  getAllPdfPasswords,
  getAllStatements,
  getKey,
  openKardabraDb,
  putKeyIfAbsent,
  putPdfPassword,
} from '../../src/db/db';
import { generateSecretKey, open, seal } from '../../src/lib/secretBox';
import { readPdfText } from '../../src/parser';
import type { KardabraSchema } from '../../src/db/schema';

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
// Fabricated cardholder of the synthetic fixture (tests/fixtures/README.md).
const FIXTURE_PASSWORD = 'JANE2010'; // pragma: allowlist secret
const jane = { name: 'Jane Doe', dob: { day: 20, month: 10, year: 1990 } };
const LOCKED = 'pdf_statement_locked.pdf';

let db: IDBPDatabase<KardabraSchema>;
beforeEach(async () => {
  db = await openKardabraDb();
});
afterEach(async () => {
  db.close();
  await new Promise<void>((resolve) => {
    indexedDB.deleteDatabase('kardabra').onsuccess = () => resolve();
  });
});

/** Unlock the fixture from Jane's details and commit it, remembering the
 * password when `remember` is set — what ImportPage does. */
async function importLocked(remember: boolean) {
  const unlocked = await unlockFiles(
    [file(LOCKED)],
    { details: { ...jane, last4s: [] } },
    [],
    readPdf,
  );
  const sealedPasswords = remember
    ? await sealPasswords(db, unlocked.passwords)
    : undefined;
  await commitImport(db, planImport(unlocked.results, [], []), {
    nicknames: new Map([['4242', 'Example']]),
    dueDays: new Map([['4242', 9]]),
    sealedPasswords,
  });
}

describe('remembered PDF passwords', () => {
  it('ticked: saved on the card, encrypted, and opens the next import', async () => {
    await importLocked(true);
    const [card] = await getAllCards(db);
    const records = await getAllPdfPasswords(db);
    expect(records.map((r) => r.cardId)).toEqual([card.id]);
    const stored = new TextDecoder('latin1').decode(records[0].data);
    expect(stored).not.toContain(FIXTURE_PASSWORD);

    const saved = await loadSavedPasswords(db);
    expect(saved).toEqual([FIXTURE_PASSWORD]);
    const next = await readStatementFiles([file(LOCKED, 'next.pdf')], readPdf);
    const reopened = await unlockFiles(
      next.locked,
      { passwords: saved },
      [],
      readPdf,
    );
    expect(reopened.stillLocked).toEqual([]);
  });

  // Opt-in: nothing is kept unless asked, not even a key.
  it('unticked: nothing saved and no key created', async () => {
    await importLocked(false);
    expect(await getAllPdfPasswords(db)).toEqual([]);
    expect(await getKey(db, 'pdf-passwords')).toBeUndefined();
    expect(await loadSavedPasswords(db)).toEqual([]);
  });

  // False allow: a saved password that doesn't fit must leave the file
  // locked, so it still reaches the password step.
  it("a saved password that doesn't open the file leaves it locked", async () => {
    const sealed = await sealPasswords(db, new Map([['x', 'WRONG0101']]));
    await putPdfPassword(db, { cardId: 'c1', ...sealed.get('x')! });
    const out = await unlockFiles(
      [file(LOCKED)],
      { passwords: await loadSavedPasswords(db) },
      [],
      readPdf,
    );
    expect(out.stillLocked.map((f) => f.name)).toEqual([LOCKED]);
  });

  it('a record sealed under another key is passed over, not thrown', async () => {
    await putKeyIfAbsent(db, 'pdf-passwords', await generateSecretKey());
    const foreign = await seal(await generateSecretKey(), FIXTURE_PASSWORD);
    await putPdfPassword(db, { cardId: 'c1', ...foreign });
    expect(await loadSavedPasswords(db)).toEqual([]);
  });

  it('re-importing a month already stored still remembers the password', async () => {
    await importLocked(false);
    const unlocked = await unlockFiles(
      [file(LOCKED)],
      { passwords: [FIXTURE_PASSWORD] },
      [],
      readPdf,
    );
    const outcomes = planImport(
      unlocked.results,
      await getAllCards(db),
      await getAllStatements(db),
    );
    expect(outcomes[0].kind).toBe('duplicate');
    await commitImport(db, outcomes, {
      nicknames: new Map(),
      dueDays: new Map(),
      sealedPasswords: await sealPasswords(db, unlocked.passwords),
    });
    expect(await loadSavedPasswords(db)).toEqual([FIXTURE_PASSWORD]);
  });

  it('a new month on an existing card is saved on that card', async () => {
    await importLocked(false);
    const [card] = await getAllCards(db);
    const read = await readStatementFiles([file('pdf_statement.pdf')], readPdf);
    const result = read.results[0];
    if (!('parsed' in result)) throw result.error;
    const nextMonth = {
      fileName: 'next.pdf',
      parsed: {
        ...result.parsed,
        fileName: 'next.pdf',
        summary: { ...result.parsed.summary, statementDateISO: '2025-11-20' },
      },
    };
    const outcomes = planImport(
      [nextMonth],
      [card],
      await getAllStatements(db),
    );
    expect(outcomes[0].kind).toBe('new-statement');
    await commitImport(db, outcomes, {
      nicknames: new Map(),
      dueDays: new Map(),
      sealedPasswords: await sealPasswords(
        db,
        new Map([['next.pdf', FIXTURE_PASSWORD]]),
      ),
    });
    expect((await getAllPdfPasswords(db)).map((r) => r.cardId)).toEqual([
      card.id,
    ]);
  });

  // Kept only for a file that landed on a card.
  it('a skipped file saves nothing, even with a sealed password', async () => {
    const outcomes = planImport(skippedLockedResults([file(LOCKED)]), [], []);
    await commitImport(db, outcomes, {
      nicknames: new Map(),
      dueDays: new Map(),
      sealedPasswords: await sealPasswords(
        db,
        new Map([[LOCKED, FIXTURE_PASSWORD]]),
      ),
    });
    expect(await getAllPdfPasswords(db)).toEqual([]);
  });

  it('a failed read gives no saved passwords instead of throwing', async () => {
    await importLocked(true);
    db.close();
    expect(await loadSavedPasswords(db)).toEqual([]);
    db = await openKardabraDb(); // for afterEach
  });

  it('two tabs creating the key at once end up sharing one', async () => {
    const [a, b] = await Promise.all([
      putKeyIfAbsent(db, 'k', await generateSecretKey()),
      putKeyIfAbsent(db, 'k', await generateSecretKey()),
    ]);
    // A key read back is a clone, so prove sameness by use.
    expect(await open(b, await seal(a, 'x'))).toBe('x');
  });
});
