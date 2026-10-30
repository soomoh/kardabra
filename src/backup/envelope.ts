/**
 * The backup file: JSON whose only readable parts say what it is and how to
 * open it; everything else is AES-GCM ciphertext under a key derived from
 * the passphrase (PBKDF2-SHA256). WebCrypto only, no dependency.
 *
 *   { "kardabra": "backup", "version": 1,
 *     "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000,
 *              "salt": "<base64, 16 bytes>" },
 *     "iv": "<base64, 12 bytes>", "data": "<base64 ciphertext>" }
 *
 * Each backup gets a fresh salt and IV, so two backups of the same data
 * under the same passphrase share nothing an observer could match.
 */

import { normalizePassphrase } from './passphrase';

export const BACKUP_FORMAT_VERSION = 1;
/** OWASP's 2023 figure for PBKDF2-HMAC-SHA256. */
const ITERATIONS = 600_000;
/** A hostile file could ask for billions of rounds and hang the tab; a
 * Kardabra-made file is always within these. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;

export type OpenResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; problem: 'not-a-backup' | 'newer' | 'wrong-passphrase' };

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(normalizePassphrase(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function sealBackup(
  plaintext: Uint8Array<ArrayBuffer>,
  passphrase: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS, 'encrypt');
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  );
  return JSON.stringify({
    kardabra: 'backup',
    version: BACKUP_FORMAT_VERSION,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: ITERATIONS,
      salt: toBase64(salt),
    },
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
  });
}

interface Envelope {
  salt: Uint8Array<ArrayBuffer>;
  iterations: number;
  iv: Uint8Array<ArrayBuffer>;
  data: Uint8Array<ArrayBuffer>;
}

/** The envelope's fields, or why the text isn't one this version opens. */
export function parseEnvelope(
  text: string,
): Envelope | 'not-a-backup' | 'newer' {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'not-a-backup';
  }
  if (!isObject(json) || json.kardabra !== 'backup') return 'not-a-backup';
  const { version, kdf } = json;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return 'not-a-backup';
  }
  if (version > BACKUP_FORMAT_VERSION) return 'newer';
  if (version !== BACKUP_FORMAT_VERSION) return 'not-a-backup';
  if (
    !isObject(kdf) ||
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < MIN_ITERATIONS ||
    kdf.iterations > MAX_ITERATIONS
  ) {
    return 'not-a-backup';
  }
  const salt = fromBase64(kdf.salt);
  const iv = fromBase64(json.iv);
  const data = fromBase64(json.data);
  if (salt?.length !== 16 || iv?.length !== 12 || data === null) {
    return 'not-a-backup';
  }
  // GCM output is at least its 16-byte tag.
  if (data.length < 16) return 'not-a-backup';
  return { salt, iterations: kdf.iterations, iv, data };
}

/** Decrypt a backup file's text. GCM authenticates, so a wrong passphrase
 * and a file altered after it was made both fail here; neither yields
 * garbage. */
export async function openBackup(
  text: string,
  passphrase: string,
): Promise<OpenResult> {
  const envelope = parseEnvelope(text);
  if (typeof envelope === 'string') return { ok: false, problem: envelope };
  const key = await deriveKey(
    passphrase,
    envelope.salt,
    envelope.iterations,
    'decrypt',
  );
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv },
      key,
      envelope.data,
    );
    return { ok: true, plaintext: new Uint8Array(plain) };
  } catch {
    return { ok: false, problem: 'wrong-passphrase' };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// btoa/atob work on "binary strings"; chunked so a large backup doesn't
// overflow the argument limit of String.fromCharCode.
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string') return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
