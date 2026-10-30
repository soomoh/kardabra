/**
 * Backup and restore, end to end: the device's one remembered passphrase,
 * making a backup file, opening one, and replacing everything with it.
 *
 * The passphrase is generated for the first backup, shown and saved by the
 * user before anything downloads, and reused by every later one (each file still gets a fresh salt and IV). It's kept on this
 * device sealed under its own non-extractable key — the same protection as
 * saved PDF passwords, separate from them so "Forget saved passwords"
 * doesn't touch it — and it's never inside a backup.
 */

import type { IDBPDatabase } from 'idb';
import type { KardabraSchema } from '../db/schema';
import {
  getKey,
  getSetting,
  getStoredData,
  putKeyIfAbsent,
  putSetting,
  putSettingIfAbsent,
  replaceStoredData,
} from '../db/db';
import { generateSecretKey, open, seal, type Sealed } from '../lib/secretBox';
import { openBackup, parseEnvelope, sealBackup } from './envelope';
import { normalizePassphrase } from './passphrase';
import { parseBackupPayload, type BackupData } from './payload';

const KEY_NAME = 'backup-passphrase';
const SETTING_KEY = 'backupPassphrase';
/** Checked on File.size before reading. Years of statements come to a few
 * MB; this leaves wide room while keeping a phone from reading a huge
 * file into memory. */
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

function isSealed(value: unknown): value is Sealed {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Sealed).iv instanceof Uint8Array &&
    (value as Sealed).data instanceof ArrayBuffer
  );
}

/** The device's backup passphrase, or null when none is remembered (or the
 * one stored no longer opens). */
export async function loadPassphrase(
  db: IDBPDatabase<KardabraSchema>,
): Promise<string | null> {
  const sealed = await getSetting(db, SETTING_KEY);
  if (!isSealed(sealed)) return null;
  const key = await getKey(db, KEY_NAME);
  return key === undefined ? null : open(key, sealed);
}

async function sealPassphrase(
  db: IDBPDatabase<KardabraSchema>,
  passphrase: string,
): Promise<Sealed> {
  const key =
    (await getKey(db, KEY_NAME)) ??
    (await putKeyIfAbsent(db, KEY_NAME, await generateSecretKey()));
  return seal(key, passphrase);
}

/** Make `passphrase` the one every later backup on this device uses,
 * stored as it's shown (normalised: as typed, it may carry a capital). */
export async function rememberPassphrase(
  db: IDBPDatabase<KardabraSchema>,
  passphrase: string,
): Promise<void> {
  const shown = normalizePassphrase(passphrase);
  await putSetting(db, SETTING_KEY, await sealPassphrase(db, shown));
}

/** Keep `offered` (the passphrase the user was shown and saved) as this
 * device's first one, and return the passphrase now stored. That is
 * `offered`, unless another tab stored one first; then it's that one, and
 * the user must be shown it before any backup uses it. */
export async function rememberFirstPassphrase(
  db: IDBPDatabase<KardabraSchema>,
  offered: string,
): Promise<string> {
  const stored = await putSettingIfAbsent(
    db,
    SETTING_KEY,
    await sealPassphrase(db, offered),
  );
  const key = await getKey(db, KEY_NAME);
  const winner = isSealed(stored) && key ? await open(key, stored) : null;
  if (winner !== null) return winner;
  // A stored record that wouldn't open (its key since erased) is replaced.
  await rememberPassphrase(db, offered);
  return normalizePassphrase(offered);
}

export function backupFileName(now = new Date()): string {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `kardabra-backup-${day}.json`;
}

/** The data on this device wouldn't pass restore's checks; `message` is
 * the first problem. Nothing was downloaded. */
export class UnrestorableBackup extends Error {}

/** The encrypted backup file's text: every card, statement, transaction and
 * bill — nothing else. */
export async function makeBackup(
  db: IDBPDatabase<KardabraSchema>,
  passphrase: string,
  now = new Date(),
): Promise<string> {
  const payload: BackupData = {
    createdAt: now.toISOString(),
    ...(await getStoredData(db)),
  };
  const json = JSON.stringify(payload);
  // A backup is only worth making if it restores: run restore's own
  // parser on it now, not on the day the original device is gone.
  const check = parseBackupPayload(JSON.parse(json));
  if (!check.ok) throw new UnrestorableBackup(check.problem);
  return sealBackup(new TextEncoder().encode(json), passphrase);
}

export type OpenedBackup =
  | { ok: true; data: BackupData }
  | {
      ok: false;
      problem: 'too-big' | 'not-a-backup' | 'newer' | 'wrong-passphrase';
    }
  | { ok: false; problem: 'damaged'; detail: string };

/** Whether the file looks like a backup this version opens, before any
 * passphrase is asked for. Null when it does. */
export async function checkBackupFile(
  file: Blob,
): Promise<'too-big' | 'not-a-backup' | 'newer' | null> {
  if (file.size > MAX_BACKUP_BYTES) return 'too-big';
  const envelope = parseEnvelope(await file.text());
  return typeof envelope === 'string' ? envelope : null;
}

/** Read, decrypt and fully check a backup file. Nothing is written. */
export async function readBackupFile(
  file: Blob,
  passphrase: string,
): Promise<OpenedBackup> {
  if (file.size > MAX_BACKUP_BYTES) return { ok: false, problem: 'too-big' };
  const opened = await openBackup(await file.text(), passphrase);
  if (!opened.ok) return opened;
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(opened.plaintext),
    );
  } catch {
    return {
      ok: false,
      problem: 'damaged',
      detail: 'The backup isn’t readable',
    };
  }
  const parsed = parseBackupPayload(json);
  return parsed.ok
    ? parsed
    : { ok: false, problem: 'damaged', detail: parsed.problem };
}

/** Replace everything with the backup. A device with no passphrase yet
 * (the usual "move to a new phone") keeps the one that opened the file, so
 * the user has one passphrase everywhere. A device that has one keeps its
 * own: restoring an old file must not bring back a passphrase changed
 * after a leak, nor one someone else chose. */
export async function restoreBackup(
  db: IDBPDatabase<KardabraSchema>,
  data: BackupData,
  passphrase: string,
): Promise<void> {
  await replaceStoredData(db, data);
  try {
    if ((await loadPassphrase(db)) === null) {
      await rememberPassphrase(db, passphrase);
    }
  } catch {
    // The data is restored; the next backup simply makes a new passphrase.
  }
}
