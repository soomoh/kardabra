/**
 * Encrypt and decrypt short secrets (remembered PDF passwords) with AES-GCM
 * under a non-extractable WebCrypto key. The key can be used by this origin
 * but never read out, so neither a backup nor a copy of the stored records
 * carries anything that opens them. It does not protect against code running
 * in the page or someone using this browser profile — that reach already
 * covers the statements themselves.
 */

export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

export function generateSecretKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function seal(key: CryptoKey, text: string): Promise<Sealed> {
  // A fresh random 96-bit IV per secret: GCM must never reuse one per key.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text),
  );
  return { iv, data };
}

/** The secret, or null when it can't be opened (another key, altered data). */
export async function open(
  key: CryptoKey,
  sealed: Sealed,
): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.iv },
      key,
      sealed.data,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
