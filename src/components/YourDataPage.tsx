import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import { countStoredData, eraseAllData } from '../db/db';
import { forgetSavedPasswords } from '../import/savedPasswords';
import { forgetThemeMirror } from '../lib/theme';
import { announceDataReplaced, startOver } from '../lib/erase';
import { plural } from '../lib/plural';
import BackupSection from './BackupSection';
import RestoreSection from './RestoreSection';
import { useDocumentTitle } from './useDocumentTitle';
import { useReturnFocus } from './useReturnFocus';

type Counts = Awaited<ReturnType<typeof countStoredData>>;

/** What Kardabra keeps on this device, and the controls to keep it, back
 * it up, move it, or remove it. */
function YourDataPage() {
  const db = useDb();
  const reportError = useReportError();
  const { version, bump } = useDataVersion();
  // 'error': the counts couldn't be read (reported in the banner); the page
  // still renders, so Erase stays reachable.
  const [counts, setCounts] = useState<Counts | 'error' | null>(null);
  const [forgotten, setForgotten] = useState(false);
  const [confirmingErase, setConfirmingErase] = useState(false);
  const [erasing, setErasing] = useState(false);
  const eraseButton = useReturnFocus<HTMLButtonElement>(confirmingErase);
  const forgottenNote = useRef<HTMLDivElement>(null);
  useDocumentTitle('Your data');

  useEffect(() => {
    let cancelled = false;
    countStoredData(db).then(
      (c) => !cancelled && setCounts(c),
      (error: unknown) => {
        if (cancelled) return;
        setCounts('error');
        reportError(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [db, version, reportError]);

  async function forgetPasswords() {
    await forgetSavedPasswords(db);
    setForgotten(true);
    bump();
  }

  const loaded = typeof counts === 'object' ? counts : null;
  const savedCount = loaded?.savedPasswords;
  // The Forget button is gone once there's nothing to forget; focus moves
  // to the line confirming it instead of falling to the page.
  useEffect(() => {
    if (forgotten && savedCount === 0) forgottenNote.current?.focus();
  }, [forgotten, savedCount]);

  async function eraseEverything() {
    if (erasing) return;
    setErasing(true);
    try {
      await eraseAllData(db);
    } catch (error) {
      setErasing(false);
      throw error;
    }
    forgetThemeMirror();
    announceDataReplaced();
    // A fresh load drops everything still held in memory (screens, theme).
    startOver();
  }

  return (
    <div className="data-page">
      <h1>Your data</h1>
      <p className="data-lead">
        Kardabra keeps everything in this browser, on this device. Nothing is
        uploaded: there’s no server, and the app blocks itself from connecting
        to the internet.
      </p>

      <section>
        <h2>What’s stored here</h2>
        <p role={loaded === null ? 'status' : undefined}>
          {counts === null
            ? 'Counting…'
            : counts === 'error'
              ? 'Kardabra couldn’t read what’s stored just now.'
              : counts.cards + counts.statements + counts.transactions === 0
                ? 'Nothing yet.'
                : `${plural(counts.cards, 'card')}, ${plural(counts.statements, 'statement')} and ${plural(counts.transactions, 'transaction')}.`}
        </p>
        <p className="muted">
          It’s stored as it is, not encrypted: anyone who can use this browser
          on this device can see it.
        </p>
      </section>

      <BackupSection hasData={loaded && loaded.cards + loaded.statements > 0} />
      <RestoreSection current={loaded} />

      {loaded !== null && (
        <section>
          <h2>Saved PDF passwords</h2>
          {loaded.savedPasswords > 0 ? (
            <>
              <p>
                {loaded.savedPasswords === 1
                  ? '1 card has a saved password.'
                  : `${loaded.savedPasswords} cards have a saved password.`}{' '}
                They’re encrypted, work only in this browser, and never leave
                it.
              </p>
              <div className="import-actions">
                <button
                  onClick={() => void forgetPasswords().catch(reportError)}
                >
                  Forget saved passwords
                </button>
              </div>
            </>
          ) : forgotten ? (
            <div
              ref={forgottenNote}
              tabIndex={-1}
              role="status"
              className="notice inline-notice"
            >
              <p>
                Forgotten. The next locked statement will ask for its password.
              </p>
            </div>
          ) : (
            <p>
              None saved. When you unlock a statement, you can choose to
              remember its password on this device.
            </p>
          )}
        </section>
      )}

      <section>
        <h2>Erase everything</h2>
        <p>
          Removes every card, statement, transaction and saved password from
          this device, forgets the backup passphrase, and resets the theme.
        </p>
        {confirmingErase ? (
          <div className="delete-confirm callout">
            <p id="erase-warning">
              There is no undo. Importing the statement files again brings the
              statements back, but not what you changed: names, due days and
              bills marked paid.
            </p>
            <div className="import-actions">
              <button
                className="danger"
                aria-describedby="erase-warning"
                onClick={() => void eraseEverything().catch(reportError)}
              >
                {erasing ? 'Erasing…' : 'Erase permanently'}
              </button>
              {/* Focus lands on the safe choice. */}
              <button
                autoFocus
                aria-describedby="erase-warning"
                onClick={() => setConfirmingErase(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="import-actions">
            <button
              ref={eraseButton}
              className="danger"
              onClick={() => setConfirmingErase(true)}
            >
              Erase everything
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default YourDataPage;
