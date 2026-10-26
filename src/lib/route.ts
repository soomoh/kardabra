/** Hash routes: `#/`, `#/import`, `#/card/<id>`. Hash rather than path
 * routing so a static host (GitHub Pages) serves every route from one
 * index.html; three views don't justify a router dependency. */
export type View =
  /** `notice`: a one-off confirmation shown on arrival (after an import).
   * Not part of the URL, so a refresh or Back doesn't show it again. */
  | { name: 'dashboard'; notice?: string }
  | { name: 'import' }
  | { name: 'card'; cardId: string };

/** The view a location hash names; anything unrecognised is the dashboard. */
export function parseRoute(hash: string): View {
  const path = hash.replace(/^#/, '');
  if (path === '/import') return { name: 'import' };
  const card = /^\/card\/([^/]+)$/.exec(path);
  if (card) {
    try {
      return { name: 'card', cardId: decodeURIComponent(card[1]) };
    } catch {
      // Malformed %-escape: fall through to the dashboard.
    }
  }
  return { name: 'dashboard' };
}

/** The hash for a view (`#/card/<id>`, id URI-encoded). */
export function routeHash(view: View): string {
  switch (view.name) {
    case 'dashboard':
      return '#/';
    case 'import':
      return '#/import';
    case 'card':
      return `#/card/${encodeURIComponent(view.cardId)}`;
  }
}
