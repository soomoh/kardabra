import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import { loadSampleData, resetSampleData } from '../sample/sample';
import { APP_URL } from '../lib/sites';
import type { View } from '../lib/route';

/** The demo site's banner, on every page: says the data is made up, links
 * to the real app, and resets the demo. It also keeps the sample card
 * there: loaded on arrival, and again after an erase or a delete. */
function DemoBar({ navigate }: { navigate: (view: View) => void }) {
  const db = useDb();
  const reportError = useReportError();
  const { bump } = useDataVersion();
  const resetting = useRef(false);
  const [status, setStatus] = useState('');

  // `bump` changes with every write, so this runs after each one; a load
  // that finds the sample already there loads nothing and doesn't bump.
  // No cleanup: a load that lands after a re-run must still refresh the
  // screens, or the dashboard stays on "Loading the demo…".
  useEffect(() => {
    loadSampleData(db)
      .then((loaded) => {
        if (loaded) bump();
      })
      .catch(reportError);
  }, [db, bump, reportError]);

  async function reset() {
    if (resetting.current) return;
    resetting.current = true;
    // Cleared first, so a second reset is announced again.
    setStatus('');
    try {
      await resetSampleData(db);
      bump();
      // The reset card has a new id: a page showing the old one is gone.
      navigate({ name: 'dashboard' });
      setStatus('Demo reset.');
    } finally {
      resetting.current = false;
    }
  }

  return (
    <div className="notice demo-bar">
      <p>
        This is a demo with made-up data. Nothing here is real, and import is
        turned off.
      </p>
      <div className="demo-actions">
        <span role="status" className="visually-hidden">
          {status}
        </span>
        <button onClick={() => void reset().catch(reportError)}>
          Reset demo
        </button>
        <a href={APP_URL}>Open Kardabra</a>
      </div>
    </div>
  );
}

/** The demo's Import page: no import here, so nothing real is stranded on
 * the demo site; the way to the real app instead. */
export function DemoImportOff() {
  return (
    <div className="empty-state">
      <h1>Import is off in the demo</h1>
      <p>
        Your statements belong in Kardabra itself, where they stay on your
        device and you can back them up.
      </p>
      <div className="demo-actions">
        <a href={APP_URL}>Open Kardabra</a>
      </div>
    </div>
  );
}

export default DemoBar;
