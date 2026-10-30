/**
 * Backup and restore over a real (fake-indexeddb) database: the round trip
 * is exact, saved PDF passwords never travel and are cleared for cards the
 * backup doesn't have, a refused or failed restore leaves the data alone,
 * and the device's one passphrase is made once and reused.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IDBPDatabase } from 'idb';
import {
  getAllPdfPasswords,
  getStoredData,
  openKardabraDb,
  putPdfPassword,
  replaceStoredData,
} from '../../src/db/db';
import type { KardabraSchema } from '../../src/db/schema';
import {
  MAX_BACKUP_BYTES,
  backupFileName,
  loadPassphrase,
  makeBackup,
  passphraseForBackup,
  readBackupFile,
  rememberPassphrase,
  restoreBackup,
  UnrestorableBackup,
} from '../../src/backup/backup';
import { openBackup } from '../../src/backup/envelope';
import { forgetSavedPasswords } from '../../src/import/savedPasswords';
import { sampleData } from './sample';

const PASS = 'acid acorn acre acts afar'; // pragma: allowlist secret
const NOW = new Date('2026-10-30T08:00:00.000Z');

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

const fileOf = (text: string) => new Blob([text], { type: 'application/json' });
const password = (cardId: string) => ({
  cardId,
  iv: new Uint8Array(12),
  data: new ArrayBuffer(20),
});
const sorted = (data: Awaited<ReturnType<typeof getStoredData>>) => ({
  cards: [...data.cards].sort((a, b) => a.id.localeCompare(b.id)),
  statements: [...data.statements].sort((a, b) => a.id.localeCompare(b.id)),
  transactions: [...data.transactions].sort((a, b) => a.id.localeCompare(b.id)),
  cycles: [...data.cycles].sort((a, b) => a.cardId.localeCompare(b.cardId)),
});

describe('backup → restore', () => {
  it('brings back exactly what was stored, on a fresh device', async () => {
    await replaceStoredData(db, sampleData());
    const text = await makeBackup(db, PASS, NOW);

    // "Another device": an empty database.
    await replaceStoredData(db, {
      cards: [],
      statements: [],
      transactions: [],
      cycles: [],
    });
    const opened = await readBackupFile(fileOf(text), PASS);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.createdAt).toBe(NOW.toISOString());
    await restoreBackup(db, opened.data, PASS);
    expect(sorted(await getStoredData(db))).toEqual(sorted(sampleData()));
  });

  it('never carries saved PDF passwords, keys or settings', async () => {
    await replaceStoredData(db, sampleData());
    await putPdfPassword(db, password('card-a'));
    await rememberPassphrase(db, PASS);
    const opened = await openBackup(await makeBackup(db, PASS, NOW), PASS);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const inside = JSON.parse(new TextDecoder().decode(opened.plaintext));
    expect(Object.keys(inside).sort()).toEqual(
      ['createdAt', 'cards', 'cycles', 'statements', 'transactions'].sort(),
    );
    const raw = new TextDecoder().decode(opened.plaintext);
    expect(raw).not.toContain(PASS);
    expect(raw).not.toMatch(/pdfPasswords|backupPassphrase|"keys"/);
  });

  it('replaces what was there, and clears saved passwords of cards that are gone', async () => {
    const backup = await (async () => {
      await replaceStoredData(db, sampleData());
      return makeBackup(db, PASS, NOW);
    })();
    // The device now has a different card, with a saved password, and
    // card-a's saved password.
    await replaceStoredData(db, {
      cards: [
        {
          id: 'card-local',
          last4: '9999',
          nickname: 'Local only',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      statements: [],
      transactions: [],
      cycles: [],
    });
    await putPdfPassword(db, password('card-local'));
    await putPdfPassword(db, password('card-a'));

    const opened = await readBackupFile(fileOf(backup), PASS);
    if (!opened.ok) throw new Error('backup did not open');
    await restoreBackup(db, opened.data, PASS);

    const cards = (await getStoredData(db)).cards.map((c) => c.id).sort();
    expect(cards).toEqual(['card-a', 'card-b']);
    const saved = (await getAllPdfPasswords(db)).map((p) => p.cardId);
    expect(saved).toEqual(['card-a']);
  });

  it('a refused file changes nothing', async () => {
    await replaceStoredData(db, sampleData());
    const before = sorted(await getStoredData(db));
    const backup = await makeBackup(db, PASS, NOW);
    expect(
      await readBackupFile(fileOf(backup), 'acid acorn acre acts afro'),
    ).toEqual({ ok: false, problem: 'wrong-passphrase' });
    expect(await readBackupFile(fileOf('not a backup'), PASS)).toEqual({
      ok: false,
      problem: 'not-a-backup',
    });
    expect(sorted(await getStoredData(db))).toEqual(before);
  });

  it('a write that fails halfway leaves the old data whole', async () => {
    await replaceStoredData(db, sampleData());
    const before = sorted(await getStoredData(db));
    const broken = sampleData();
    // Bypasses the parser: two statements for one (card, period) break the
    // unique index mid-transaction.
    broken.statements[1].cardId = 'card-a';
    await expect(replaceStoredData(db, broken)).rejects.toThrow();
    expect(sorted(await getStoredData(db))).toEqual(before);
  });

  it('restores a bill whose refunds outweigh its spend', async () => {
    const data = sampleData();
    data.cycles[1].spend = -250; // netSpend: a refund-only month
    await replaceStoredData(db, data);
    const opened = await readBackupFile(
      fileOf(await makeBackup(db, PASS, NOW)),
      PASS,
    );
    expect(opened.ok).toBe(true);
  });

  it('refuses to make a backup that would not restore', async () => {
    const data = sampleData();
    data.transactions[0].amount = Infinity;
    await replaceStoredData(db, data);
    await expect(makeBackup(db, PASS, NOW)).rejects.toThrow(
      new UnrestorableBackup('Transaction 1 has an amount that isn’t a number'),
    );
  });

  it('refuses an oversized file before reading it', async () => {
    const huge = {
      size: MAX_BACKUP_BYTES + 1,
      text: () => {
        throw new Error('read');
      },
    } as unknown as Blob;
    expect(await readBackupFile(huge, PASS)).toEqual({
      ok: false,
      problem: 'too-big',
    });
  });

  it('a damaged payload names its first problem', async () => {
    const { sealBackup } = await import('../../src/backup/envelope');
    const payload = { createdAt: NOW.toISOString(), ...sampleData() };
    (payload.transactions[0] as { amount: unknown }).amount = '12';
    const text = await sealBackup(
      new TextEncoder().encode(JSON.stringify(payload)),
      PASS,
    );
    expect(await readBackupFile(fileOf(text), PASS)).toEqual({
      ok: false,
      problem: 'damaged',
      detail: 'Transaction 1 has an amount that isn’t a number',
    });
  });
});

describe('the device passphrase', () => {
  it('is made on the first backup, then reused', async () => {
    expect(await loadPassphrase(db)).toBeNull();
    const first = await passphraseForBackup(db);
    expect(first.isNew).toBe(true);
    const second = await passphraseForBackup(db);
    expect(second).toEqual({ passphrase: first.passphrase, isNew: false });
    expect(await loadPassphrase(db)).toBe(first.passphrase);
  });

  it('is stored sealed, never as plain text', async () => {
    const { passphrase } = await passphraseForBackup(db);
    const stored = await db.getAll('settings');
    expect(JSON.stringify(stored)).not.toContain(passphrase);
    expect(stored.some((s) => s.value === passphrase)).toBe(false);
  });

  it('after a change, old files open only with the old one', async () => {
    await replaceStoredData(db, sampleData());
    const { passphrase: old } = await passphraseForBackup(db);
    const oldFile = await makeBackup(db, old, NOW);
    await rememberPassphrase(db, 'brisk camel dense eagle fable');
    const { passphrase: next, isNew } = await passphraseForBackup(db);
    expect(isNew).toBe(false);
    expect(next).toBe('brisk camel dense eagle fable');
    expect((await readBackupFile(fileOf(oldFile), next)).ok).toBe(false);
    expect((await readBackupFile(fileOf(oldFile), old)).ok).toBe(true);
  });

  it('a device with no passphrase keeps the one that opened the file', async () => {
    await replaceStoredData(db, sampleData());
    const text = await makeBackup(db, PASS, NOW);
    const opened = await readBackupFile(fileOf(text), PASS);
    if (!opened.ok) throw new Error('backup did not open');
    await restoreBackup(db, opened.data, '  Acid acorn acre acts afar');
    expect(await loadPassphrase(db)).toBe(PASS);
  });

  it('a device with its own passphrase keeps it (an old or someone else’s file can’t replace it)', async () => {
    await replaceStoredData(db, sampleData());
    const text = await makeBackup(db, PASS, NOW);
    await rememberPassphrase(db, 'brisk camel dense eagle fable');
    const opened = await readBackupFile(fileOf(text), PASS);
    if (!opened.ok) throw new Error('backup did not open');
    await restoreBackup(db, opened.data, PASS);
    expect(await loadPassphrase(db)).toBe('brisk camel dense eagle fable');
  });

  it('survives "Forget saved passwords"', async () => {
    const { passphrase } = await passphraseForBackup(db);
    await forgetSavedPasswords(db);
    expect(await loadPassphrase(db)).toBe(passphrase);
  });
});

it('backupFileName uses the local calendar day', () => {
  expect(backupFileName(new Date(2026, 9, 3, 23, 30))).toBe(
    'kardabra-backup-2026-10-03.json',
  );
});
