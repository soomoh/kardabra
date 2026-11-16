/** Hash routes: `#/`, `#/import`, `#/data`, `#/card/<id>`, `#/insights`,
 * `#/insights/<cardId>`. Hash rather than path routing so a static host
 * (GitHub Pages) serves every route from one index.html; five views don't
 * justify a router dependency. */
export type View =
  /** `notice`: a one-off confirmation shown on arrival (after an import).
   * Not part of the URL, so a refresh or Back doesn't show it again. */
  | { name: 'dashboard'; notice?: string }
  | { name: 'import' }
  | { name: 'data' }
  | { name: 'card'; cardId: string }
  /** No `cardId`: every card together. */
  | { name: 'insights'; cardId?: string };

/** The view a location hash names; anything unrecognised is the dashboard. */
export function parseRoute(hash: string): View {
  const path = hash.replace(/^#/, '');
  if (path === '/import') return { name: 'import' };
  if (path === '/data') return { name: 'data' };
  if (path === '/insights') return { name: 'insights' };
  const match = /^\/(card|insights)\/([^/]+)$/.exec(path);
  if (match) {
    try {
      return {
        name: match[1] as 'card' | 'insights',
        cardId: decodeURIComponent(match[2]),
      };
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
    case 'data':
      return '#/data';
    case 'card':
      return `#/card/${encodeURIComponent(view.cardId)}`;
    case 'insights':
      return view.cardId === undefined
        ? '#/insights'
        : `#/insights/${encodeURIComponent(view.cardId)}`;
  }
}
