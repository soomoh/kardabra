import { WORDS } from './words';

const WORD_COUNT = 5;

/** Five words from the list, picked uniformly with the browser's CSPRNG.
 * Rejection sampling: a 16-bit value is used only below the largest
 * multiple of the list length, so `% WORDS.length` favours no word. */
export function generatePassphrase(): string {
  const limit = 65536 - (65536 % WORDS.length);
  const picked: string[] = [];
  while (picked.length < WORD_COUNT) {
    for (const n of crypto.getRandomValues(new Uint16Array(WORD_COUNT))) {
      if (n < limit && picked.length < WORD_COUNT) {
        picked.push(WORDS[n % WORDS.length]);
      }
    }
  }
  return picked.join(' ');
}

/** What a typed passphrase means: case, extra spaces and a phone's
 * autocapitalised first letter don't change it. Applied both when a backup
 * is made and when it's opened. */
export function normalizePassphrase(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase().split(/\s+/).join(' ');
}
