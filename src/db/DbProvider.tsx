/**
 * Opens the database once for the whole app and hands it to every screen.
 * Children render only once it is open, so no component ever sees a missing
 * database. If it can't open (storage blocked, private mode, another tab on
 * an older version) the user gets a message that says what to do, not an
 * endless "Loading…".
 *
 * Also owns the app's one error banner: any write that fails reports here
 * via useReportError(), so a failed save is never silent.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { IDBPDatabase } from 'idb';
import { openKardabraDb } from './db';
import type { KardabraSchema } from './schema';

type Db = IDBPDatabase<KardabraSchema>;
type State =
  | { status: 'opening' }
  | { status: 'blocked' }
  | { status: 'reload' }
  | { status: 'error'; message: string }
  | { status: 'open'; db: Db };

const DbContext = createContext<Db | null>(null);
const ReportErrorContext = createContext<(error: unknown) => void>(() => {});

/** Turn a storage failure into words a person can act on. */
export function describeDbError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'QuotaExceededError') {
    return 'Your browser is out of storage space for this site. Free some space or remove old cards, then try again.';
  }
  if (name === 'InvalidStateError' || name === 'SecurityError') {
    return 'This browser is blocking on-device storage (common in private windows). Open Kardabra in a normal window to use it.';
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Something went wrong saving your data (${detail}). Reload the page and try again.`;
}

export function DbProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'opening' });
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    openKardabraDb({
      onBlocked: () => !cancelled && setState({ status: 'blocked' }),
      onVersionChange: () => !cancelled && setState({ status: 'reload' }),
    }).then(
      (db) => !cancelled && setState({ status: 'open', db }),
      (error: unknown) =>
        !cancelled &&
        setState({ status: 'error', message: describeDbError(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const reportError = useCallback((error: unknown) => {
    setBanner(describeDbError(error));
  }, []);

  if (state.status !== 'open') {
    const message = {
      opening: 'Opening your data…',
      blocked:
        'Kardabra is open in another tab with an older version. Close that tab to continue.',
      reload:
        'Kardabra was updated in another tab. Reload this page to continue.',
      error: state.status === 'error' ? state.message : '',
    }[state.status];
    return (
      <div
        className="db-status"
        role={state.status === 'opening' ? 'status' : 'alert'}
      >
        <p>{message}</p>
        {state.status === 'reload' && (
          <button onClick={() => window.location.reload()}>Reload</button>
        )}
      </div>
    );
  }

  return (
    <DbContext.Provider value={state.db}>
      <ReportErrorContext.Provider value={reportError}>
        {banner !== null && (
          <div className="error-banner" role="alert">
            <p>{banner}</p>
            <button onClick={() => setBanner(null)}>Dismiss</button>
          </div>
        )}
        {children}
      </ReportErrorContext.Provider>
    </DbContext.Provider>
  );
}

/** The open database. Only valid inside <DbProvider>. */
export function useDb(): Db {
  const db = useContext(DbContext);
  if (db === null) {
    throw new Error('useDb must be used inside <DbProvider>');
  }
  return db;
}

/** Report a failed write so the user sees it. */
export function useReportError(): (error: unknown) => void {
  return useContext(ReportErrorContext);
}
