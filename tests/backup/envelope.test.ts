/**
 * The encrypted file: round trip, fresh salt/IV per file, and every way a
 * file can fail to open — none of them yields data.
 */
import { describe, expect, it } from 'vitest';
import {
  openBackup,
  parseEnvelope,
  sealBackup,
} from '../../src/backup/envelope';

const PASS = 'acid acorn acre acts afar'; // pragma: allowlist secret
const plain = () => new TextEncoder().encode('{"hello":"world"}');

describe('sealBackup / openBackup', () => {
  it('opens with its passphrase, however it is typed', async () => {
    const text = await sealBackup(plain(), PASS);
    const opened = await openBackup(text, '  Acid Acorn  acre acts AFAR ');
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(new TextDecoder().decode(opened.plaintext)).toBe(
        '{"hello":"world"}',
      );
    }
  });

  it('carries no readable data: only the envelope fields', async () => {
    const text = await sealBackup(plain(), PASS);
    expect(text).not.toContain('hello');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ['data', 'iv', 'kardabra', 'kdf', 'version'].sort(),
    );
  });

  it('two backups of the same data differ byte-wise (fresh salt and IV)', async () => {
    const a = JSON.parse(await sealBackup(plain(), PASS));
    const b = JSON.parse(await sealBackup(plain(), PASS));
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('refuses a wrong passphrase', async () => {
    const text = await sealBackup(plain(), PASS);
    expect(await openBackup(text, 'acid acorn acre acts afro')).toEqual({
      ok: false,
      problem: 'wrong-passphrase',
    });
  });

  it('refuses a file altered after it was made', async () => {
    const env = JSON.parse(await sealBackup(plain(), PASS));
    const bytes = Uint8Array.from(atob(env.data), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    env.data = btoa(String.fromCharCode(...bytes));
    expect(await openBackup(JSON.stringify(env), PASS)).toEqual({
      ok: false,
      problem: 'wrong-passphrase',
    });
  });

  it('refuses a newer format version without trying to open it', async () => {
    const env = JSON.parse(await sealBackup(plain(), PASS));
    env.version = 2;
    expect(await openBackup(JSON.stringify(env), PASS)).toEqual({
      ok: false,
      problem: 'newer',
    });
  });
});

describe('parseEnvelope refuses what Kardabra never writes', () => {
  const good = {
    kardabra: 'backup',
    version: 1,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 600000,
      salt: btoa('s'.repeat(16)),
    },
    iv: btoa('i'.repeat(12)),
    data: btoa('d'.repeat(32)),
  };
  const variant = (change: (e: typeof good) => unknown) => {
    const copy = structuredClone(good);
    return JSON.stringify(change(copy) ?? copy);
  };

  it('accepts the well-formed envelope', () => {
    expect(typeof parseEnvelope(JSON.stringify(good))).toBe('object');
  });

  it.each([
    ['empty file', ''],
    ['not JSON', 'hello'],
    ['a JSON array', '[]'],
    ['a statement CSV', 'Date,Description,Amount\n01/09/2026,X,10'],
    ['another app’s JSON', '{"version":1}'],
    ['version 0', variant((e) => ({ ...e, version: 0 }))],
    ['fractional version', variant((e) => ({ ...e, version: 1.5 }))],
    ['version as text', variant((e) => ({ ...e, version: '1' }))],
    // A hostile file could otherwise hang the tab deriving a key.
    [
      'billions of rounds',
      variant((e) => {
        e.kdf.iterations = 4e9;
      }),
    ],
    [
      'too few rounds',
      variant((e) => {
        e.kdf.iterations = 1000;
      }),
    ],
    [
      'another hash',
      variant((e) => {
        e.kdf.hash = 'SHA-1';
      }),
    ],
    [
      'a short salt',
      variant((e) => {
        e.kdf.salt = btoa('s');
      }),
    ],
    ['a long IV', variant((e) => ({ ...e, iv: btoa('i'.repeat(16)) }))],
    ['data not base64', variant((e) => ({ ...e, data: '***' }))],
    ['data shorter than a tag', variant((e) => ({ ...e, data: btoa('d') }))],
    ['data missing', variant((e) => ({ ...e, data: undefined }))],
  ])('%s', (_name, text) => {
    expect(parseEnvelope(text)).toBe('not-a-backup');
  });
});
