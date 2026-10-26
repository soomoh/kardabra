import { describe, expect, it } from 'vitest';
import { parseThemeChoice } from '../../src/lib/theme';

describe('parseThemeChoice', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', 'system'],
    // Missing or unknown values follow the system, never throw.
    [null, 'system'],
    [undefined, 'system'],
    ['Dark', 'system'],
    [1, 'system'],
  ])('%j → %s', (value, choice) => {
    expect(parseThemeChoice(value)).toBe(choice);
  });
});
