/**
 * The app's entire cache-invalidation strategy: one counter, in one place.
 *
 * Every component that loads data from IndexedDB reads `version` and puts
 * it in its `useEffect` dependency array, so it re-fetches whenever the
 * counter changes. Every place that writes to IndexedDB (a commit, a
 * mark-paid toggle) calls `bump()` afterwards, which increments the
 * counter and so triggers every mounted data-loading effect to re-run.
 * There's no per-entity invalidation, no cache at all really — just
 * "something changed somewhere, everyone re-read everything". For an
 * app this size (a handful of small IndexedDB reads, all local, no
 * network latency) that's deliberately the simplest thing that works,
 * chosen instead of pulling in a data-fetching library.
 */

import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

interface DataVersionValue {
  version: number;
  bump: () => void;
}

const DataVersionContext = createContext<DataVersionValue | null>(null);

export function DataVersionProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);

  // useMemo so components consuming only `bump` (never `version`) don't
  // re-render every time some other component's effect happens to read
  // the context — the value object itself only changes when the count
  // actually changes.
  const value = useMemo<DataVersionValue>(
    () => ({ version, bump: () => setVersion((v) => v + 1) }),
    [version],
  );

  return (
    <DataVersionContext.Provider value={value}>
      {children}
    </DataVersionContext.Provider>
  );
}

export function useDataVersion(): DataVersionValue {
  const value = useContext(DataVersionContext);
  if (value === null) {
    // A programmer mistake (a component rendered outside the provider),
    // not a user-facing failure mode — throwing here is the guard clause
    // that catches it immediately instead of `version`/`bump` silently
    // being wrong later.
    throw new Error('useDataVersion must be used within a DataVersionProvider');
  }
  return value;
}
