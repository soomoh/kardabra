import { describe, expect, it } from 'vitest';
import { generateSecretKey, open, seal } from '../../src/lib/secretBox';

describe('secretBox', () => {
  it('round-trips a secret, with a fresh IV each time', async () => {
    const key = await generateSecretKey();
    const a = await seal(key, 'JANE2010');
    const b = await seal(key, 'JANE2010');
    expect(await open(key, a)).toBe('JANE2010');
    expect(a.iv).not.toEqual(b.iv);
  });

  it('never stores the plaintext in what it returns', async () => {
    const sealed = await seal(await generateSecretKey(), 'JANE2010');
    const bytes = new TextDecoder('latin1').decode(sealed.data);
    expect(bytes).not.toContain('JANE2010');
  });

  it('keys cannot be exported', async () => {
    const key = await generateSecretKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  // False allow, the catastrophic case: another key or altered bytes must
  // never yield a password.
  it('returns null under another key or for altered data', async () => {
    const sealed = await seal(await generateSecretKey(), 'JANE2010');
    expect(await open(await generateSecretKey(), sealed)).toBeNull();

    const key = await generateSecretKey();
    const good = await seal(key, 'JANE2010');
    const altered = new Uint8Array(good.data.slice(0));
    altered[0] ^= 1;
    expect(await open(key, { iv: good.iv, data: altered.buffer })).toBeNull();
  });
});
