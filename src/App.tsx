import { useCallback, useEffect, useRef, useState } from 'react';
import { DataVersionProvider } from './context/DataVersionContext';
import { DbProvider } from './db/DbProvider';
import Dashboard from './components/Dashboard';
import ImportPage from './components/ImportPage';
import CardDetail from './components/CardDetail';
import PrivacyPage from './components/PrivacyPage';
import { parseRoute, routeHash, type View } from './lib/route';
import { followErasesElsewhere } from './lib/erase';
import {
  announceThemeChoice,
  readThemeMirror,
  THEME_MIRROR_KEY,
  parseThemeChoice,
  type ThemeChoice,
} from './lib/theme';
import { ThemeSettingSync, ThemeToggle } from './components/ThemeToggle';

function App() {
  // The URL hash is the source of truth for which view shows, so Back,
  // Forward and refresh work; `view` mirrors it plus the transient notice.
  const [view, setView] = useState<View>(() =>
    parseRoute(window.location.hash),
  );
  const mainRef = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<ThemeChoice>(readThemeMirror);
  // A pick made while the database is still opening beats the stored one.
  const themePicked = useRef(false);
  const pickTheme = useCallback((choice: ThemeChoice) => {
    themePicked.current = true;
    setTheme(choice);
  }, []);
  const loadStoredTheme = useCallback((stored: ThemeChoice) => {
    if (!themePicked.current) setTheme(stored);
  }, []);

  useEffect(() => announceThemeChoice(theme), [theme]);
  // Another tab changed the theme: follow it.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === THEME_MIRROR_KEY) {
        setTheme(parseThemeChoice(event.newValue));
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(followErasesElsewhere, []);

  useEffect(() => {
    function onHashChange() {
      const next = parseRoute(window.location.hash);
      // Same route (e.g. the hashchange that follows `navigate`): keep the
      // current view so its notice survives.
      setView((current) =>
        routeHash(current) === routeHash(next) ? current : next,
      );
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /** Go to a view from code (links navigate on their own): a new history
   * entry when the route changes, so Back returns here. `replace` swaps the
   * current entry instead, for a page that no longer exists (a deleted card). */
  const navigate = useCallback(
    (next: View, options?: { replace?: boolean }) => {
      const hash = routeHash(next);
      if (options?.replace) {
        // replaceState fires no hashchange; setView below does the update.
        window.history.replaceState(null, '', hash);
      } else if (routeHash(parseRoute(window.location.hash)) !== hash) {
        window.location.hash = hash;
      }
      setView(next);
    },
    [],
  );

  // On every view change (not the first load), move keyboard and
  // screen-reader focus to the new page, so it's announced and Tab starts
  // from its top instead of the old page's position. Compared with the
  // previous view rather than a "first render" flag, which StrictMode's
  // double-run of effects would defeat.
  const viewKey = routeHash(view);

  // A file dropped anywhere but the import drop zone would make the browser
  // open it and leave the app; refuse such drops.
  useEffect(() => {
    function guard(event: DragEvent) {
      const target = event.target as Element | null;
      if (target?.closest?.('.dropzone')) return;
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        if (event.type === 'dragover') event.dataTransfer.dropEffect = 'none';
      }
    }
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);
  const shownViewKey = useRef(viewKey);
  useEffect(() => {
    if (shownViewKey.current === viewKey) return;
    shownViewKey.current = viewKey;
    mainRef.current?.focus();
    window.scrollTo(0, 0);
  }, [viewKey]);

  // Persistent top nav: every view can always reach every page,
  // so changing your mind mid-flow never leaves you stranded.
  // `aria-current` marks the active view for assistive tech; CSS styles
  // off it too, so the highlight can't disagree with what a screen
  // reader announces.
  const nav = (
    <nav className="app-nav" aria-label="Main">
      <a
        href={routeHash({ name: 'dashboard' })}
        aria-current={view.name === 'dashboard' ? 'page' : undefined}
      >
        Dashboard
      </a>
      <a
        href={routeHash({ name: 'import' })}
        aria-current={view.name === 'import' ? 'page' : undefined}
      >
        Import
      </a>
      <a
        href={routeHash({ name: 'privacy' })}
        aria-current={view.name === 'privacy' ? 'page' : undefined}
      >
        Privacy
      </a>
    </nav>
  );

  return (
    <DataVersionProvider>
      <div className="app">
        <header className="app-header">
          <span className="app-brand">Kardabra</span>
          {nav}
          <ThemeToggle choice={theme} onChange={pickTheme} />
        </header>
        {/* tabIndex -1: focusable from script (above), not in the Tab order. */}
        <main ref={mainRef} tabIndex={-1} className="app-main">
          <DbProvider>
            <ThemeSettingSync choice={theme} onLoad={loadStoredTheme} />
            {view.name === 'dashboard' && (
              <Dashboard navigate={navigate} notice={view.notice} />
            )}
            {view.name === 'import' && <ImportPage navigate={navigate} />}
            {view.name === 'privacy' && <PrivacyPage />}
            {view.name === 'card' && (
              <CardDetail
                key={view.cardId}
                cardId={view.cardId}
                navigate={navigate}
              />
            )}
          </DbProvider>
        </main>
      </div>
    </DataVersionProvider>
  );
}

export default App;
