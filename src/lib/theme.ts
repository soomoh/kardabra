/** Theme choice: the settings store holds it (backed up with the user's
 * data); localStorage mirrors it because index.html's pre-paint script
 * can't wait for IndexedDB. Applying it (setting `data-theme`) is that
 * script's job alone — the app only announces changes to it. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_SETTING_KEY = 'theme';
/** Must match index.html's inline script. */
export const THEME_MIRROR_KEY = 'kardabra-theme';
/** Event the inline script listens for; `detail` is the ThemeChoice. */
export const THEME_EVENT = 'kardabra-theme';

/** Anything stored that isn't a known choice means "follow the system". */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readThemeMirror(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(THEME_MIRROR_KEY));
  } catch {
    return 'system'; // storage blocked: the inline script fell back the same way
  }
}

/** Mirror the choice for the next page load and apply it now. The event
 * carries the choice, so it applies even when localStorage is blocked. */
export function announceThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_MIRROR_KEY, choice);
  } catch {
    // Blocked storage: this page still switches; the next load follows
    // the settings store once it opens.
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: choice }));
}

/** Drop the mirror (erase-all): the next load follows the system again. */
export function forgetThemeMirror(): void {
  try {
    localStorage.removeItem(THEME_MIRROR_KEY);
  } catch {
    // Blocked storage held nothing to forget.
  }
}
