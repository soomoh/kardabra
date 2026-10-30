/**
 * Remembered PDF passwords: opt-in, one per card, encrypted at rest
 * (lib/secretBox.ts). Only the password that opened a file is kept — never
 * the name or date of birth it was made from.
 */

import type { IDBPDatabase } from 'idb';
import type { KardabraSchema } from '../db/schema';
import {
  clearPdfPasswords,
  getAllPdfPasswords,
  getKey,
  putKeyIfAbsent,
} from '../db/db';
import { generateSecretKey, open, seal, type Sealed } from '../lib/secretBox';

const KEY_NAME = 'pdf-passwords';

/** Every remembered password that still opens, without duplicates. Records
 * that don't decrypt (key erased, data altered) are passed over, and a
 * failed read gives none: the files then just ask, as with nothing saved —
 * an optional convenience never stops an import. */
export async function loadSavedPasswords(
  db: IDBPDatabase<KardabraSchema>,
): Promise<string[]> {
  try {
    const records = await getAllPdfPasswords(db);
    if (records.length === 0) return [];
    const key = await getKey(db, KEY_NAME);
    if (key === undefined) return [];
    const opened = await Promise.all(records.map((r) => open(key, r)));
    return [...new Set(opened.filter((p): p is string => p !== null))];
  } catch {
    return [];
  }
}

/** Encrypt each file's password, so only ciphertext waits for the commit.
 * The key is created on first use. */
export async function sealPasswords(
  db: IDBPDatabase<KardabraSchema>,
  passwords: ReadonlyMap<string, string>,
): Promise<Map<string, Sealed>> {
  const out = new Map<string, Sealed>();
  if (passwords.size === 0) return out;
  const key =
    (await getKey(db, KEY_NAME)) ??
    (await putKeyIfAbsent(db, KEY_NAME, await generateSecretKey()));
  for (const [fileName, password] of passwords) {
    out.set(fileName, await seal(key, password));
  }
  return out;
}

/** Forget every saved password and its key; the next one saved gets a new
 * key. */
export function forgetSavedPasswords(
  db: IDBPDatabase<KardabraSchema>,
): Promise<void> {
  return clearPdfPasswords(db, KEY_NAME);
}
