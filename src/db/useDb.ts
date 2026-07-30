/**
 * The one place components ask for the open database.
 *
 * `openKardabraDb()` is safe to call more than once (see its own comment
 * in db.ts), so every data-loading component could call it directly in
 * its own effect — this hook just avoids repeating that same
 * "open, store in state, none yet means still loading" boilerplate in
 * every component that needs it.
 */

import { useEffect, useState } from 'react';
import type { IDBPDatabase } from 'idb';
import { openKardabraDb } from './db';
import type { KardabraSchema } from './schema';

/** The open database, or `null` while it's still opening. */
export function useDb(): IDBPDatabase<KardabraSchema> | null {
  const [db, setDb] = useState<IDBPDatabase<KardabraSchema> | null>(null);

  useEffect(() => {
    let cancelled = false;
    openKardabraDb().then((opened) => {
      if (!cancelled) setDb(opened);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return db;
}
