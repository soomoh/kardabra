import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, type View } from '../../src/lib/route';

describe('parseRoute', () => {
  it.each<[string, View]>([
    ['', { name: 'dashboard' }],
    ['#', { name: 'dashboard' }],
    ['#/', { name: 'dashboard' }],
    ['#/import', { name: 'import' }],
    ['#/card/abc-123', { name: 'card', cardId: 'abc-123' }],
    ['#/card/a%2Fb', { name: 'card', cardId: 'a/b' }],
    // Unknown or malformed routes fall back to the dashboard, never throw.
    ['#/nope', { name: 'dashboard' }],
    ['#/card/', { name: 'dashboard' }],
    ['#/card/a/b', { name: 'dashboard' }],
    ['#/card/%E0%A4', { name: 'dashboard' }],
    ['#/import/extra', { name: 'dashboard' }],
  ])('%j → %j', (hash, view) => {
    expect(parseRoute(hash)).toEqual(view);
  });
});

describe('routeHash', () => {
  it('round-trips every view, ignoring the notice', () => {
    const views: View[] = [
      { name: 'dashboard' },
      { name: 'import' },
      { name: 'card', cardId: '4f1c/ä?#' },
    ];
    for (const view of views) expect(parseRoute(routeHash(view))).toEqual(view);
    expect(routeHash({ name: 'dashboard', notice: 'Imported' })).toBe('#/');
  });
});
