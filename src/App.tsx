import { useEffect, useRef, useState } from 'react';
import { DataVersionProvider } from './context/DataVersionContext';
import { DbProvider } from './db/DbProvider';
import Dashboard from './components/Dashboard';
import ImportPage from './components/ImportPage';
import CardDetail from './components/CardDetail';

// State-based navigation: a deliberate alternative to react-router. Three
// views don't justify a routing dependency — `view` is just one piece of
// React state, and each screen gets a setter to change it. No URL, no
// history stack, no back/forward beyond what each screen wires up itself
// (e.g. CardDetail's "back to dashboard" link).
export type View =
  { name: 'dashboard' } | { name: 'import' } | { name: 'card'; cardId: string };

function App() {
  const [view, setView] = useState<View>({ name: 'dashboard' });
  const mainRef = useRef<HTMLElement>(null);

  // On every view change (not the first load), move keyboard and
  // screen-reader focus to the new page, so it's announced and Tab starts
  // from its top instead of the old page's position. Compared with the
  // previous view rather than a "first render" flag, which StrictMode's
  // double-run of effects would defeat.
  const viewKey = view.name === 'card' ? `card:${view.cardId}` : view.name;
  const shownViewKey = useRef(viewKey);
  useEffect(() => {
    if (shownViewKey.current === viewKey) return;
    shownViewKey.current = viewKey;
    mainRef.current?.focus();
    window.scrollTo(0, 0);
  }, [viewKey]);

  // Persistent top nav: every view can always reach Dashboard and Import,
  // so changing your mind mid-flow never leaves you stranded.
  // `aria-current` marks the active view for assistive tech; CSS styles
  // off it too, so the highlight can't disagree with what a screen
  // reader announces.
  const nav = (
    <nav className="app-nav" aria-label="Main">
      <span className="app-nav-brand">Kardabra</span>
      <button
        onClick={() => setView({ name: 'dashboard' })}
        aria-current={view.name === 'dashboard' ? 'page' : undefined}
      >
        Dashboard
      </button>
      <button
        onClick={() => setView({ name: 'import' })}
        aria-current={view.name === 'import' ? 'page' : undefined}
      >
        Import
      </button>
    </nav>
  );

  return (
    <DataVersionProvider>
      <div className="app">
        <header>{nav}</header>
        {/* tabIndex -1: focusable from script (above), not in the Tab order. */}
        <main ref={mainRef} tabIndex={-1} className="app-main">
          <DbProvider>
            {view.name === 'dashboard' && <Dashboard setView={setView} />}
            {view.name === 'import' && <ImportPage setView={setView} />}
            {view.name === 'card' && (
              <CardDetail cardId={view.cardId} setView={setView} />
            )}
          </DbProvider>
        </main>
      </div>
    </DataVersionProvider>
  );
}

export default App;
