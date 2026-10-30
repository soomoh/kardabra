import { describe, expect, it } from 'vitest';
import {
  generatePassphrase,
  normalizePassphrase,
} from '../../src/backup/passphrase';
import { WORDS } from '../../src/backup/words';

describe('generatePassphrase', () => {
  it('is five words from the list, separated by single spaces', () => {
    const list = new Set(WORDS);
    for (let i = 0; i < 50; i++) {
      const words = generatePassphrase().split(' ');
      expect(words).toHaveLength(5);
      for (const w of words) expect(list.has(w)).toBe(true);
    }
  });

  it('differs between calls', () => {
    const seen = new Set(Array.from({ length: 20 }, generatePassphrase));
    expect(seen.size).toBe(20);
  });
});

describe('the word list', () => {
  it('has 1,295 distinct lower-case words, none needing a space or hyphen', () => {
    expect(WORDS).toHaveLength(1295);
    expect(new Set(WORDS).size).toBe(1295);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]+$/);
  });
});

describe('normalizePassphrase', () => {
  it.each([
    ['acid acorn acre', 'acid acorn acre'],
    ['  Acid  ACORN\tacre \n', 'acid acorn acre'],
    ['Acid acorn acre', 'acid acorn acre'], // phone autocapitalisation
  ])('%j → %j', (input, expected) => {
    expect(normalizePassphrase(input)).toBe(expected);
  });
});
