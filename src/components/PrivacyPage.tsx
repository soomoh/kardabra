import { useEffect, useRef, useState } from 'react';
import { useDb, useReportError } from '../db/DbProvider';
import { useDataVersion } from '../context/DataVersionContext';
import { countStoredData, eraseAllData } from '../db/db';
import { forgetSavedPasswords } from '../import/savedPasswords';
import { forgetThemeMirror } from '../lib/theme';
import { announceErased, startOver } from '../lib/erase';
import { useDocumentTitle } from './useDocumentTitle';
import { useReturnFocus } from './useReturnFocus';

type Counts = Awaited<ReturnType<typeof countStoredData>>;
/** `unsupported`: no StorageManager, or one without persist (older
 * browsers, some webviews) — the section is left out rather than guessed. */
type Persistence = 'checking' | 'unsupported' | 'kept' | 'may-clear' | 'denied';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** What Kardabra keeps on this device, and the controls to keep it or
 * remove it. Backup and restore join this page next. */
function PrivacyPage() {
  const db = useDb();
  const reportError = useReportError();
  const { version, bump } = useDataVersion();
  // 'error': the counts couldn't be read (reported in the banner); the page
  // still renders, so Erase stays reachable.
  const [counts, setCounts] = useState<Counts | 'error' | null>(null);
  const [persistence, setPersistence] = useState<Persistence>('checking');
  const [forgotten, setForgotten] = useState(false);
  const [confirmingErase, setConfirmingErase] = useState(false);
  const [erasing, setErasing] = useState(false);
  const eraseButton = useReturnFocus<HTMLButtonElement>(confirmingErase);
  const forgottenNote = useRef<HTMLParagraphElement>(null);
  const keptNote = useRef<HTMLParagraphElement>(null);
  useDocumentTitle('Privacy');

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

  useEffect(() => {
    let cancelled = false;
    if (!navigator.storage?.persisted || !navigator.storage.persist) {
      setPersistence('unsupported');
      return;
    }
    navigator.storage.persisted().then(
      (kept) => !cancelled && setPersistence(kept ? 'kept' : 'may-clear'),
      () => !cancelled && setPersistence('unsupported'),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function askToKeep() {
    const kept = await navigator.storage.persist();
    setPersistence(kept ? 'kept' : 'denied');
    // The button goes away once the browser agrees; focus follows the news.
    if (kept) setTimeout(() => keptNote.current?.focus());
  }

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
    announceErased();
    // A fresh load drops everything still held in memory (screens, theme).
    startOver();
  }

  return (
    <div className="privacy-page">
      <h1>Privacy</h1>
      <p className="privacy-lead">
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

      {persistence !== 'checking' && persistence !== 'unsupported' && (
        <section>
          <h2>Keeping your data</h2>
          {persistence === 'kept' ? (
            <p ref={keptNote} tabIndex={-1}>
              Your browser won’t clear this data on its own to free space.
            </p>
          ) : (
            <>
              <p>
                Your browser may clear this data on its own when the device runs
                low on space, or after weeks of not opening Kardabra.
              </p>
              {/* Always present, so the answer is announced when it lands. */}
              <p role="status" className="muted">
                {persistence === 'denied' &&
                  'The browser didn’t agree this time. Browsers decide this themselves, often by how much you use a site.'}
              </p>
              <div className="import-actions">
                <button onClick={() => void askToKeep().catch(reportError)}>
                  Ask the browser to keep it
                </button>
              </div>
            </>
          )}
        </section>
      )}

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
          ) : (
            <p
              ref={forgottenNote}
              tabIndex={forgotten ? -1 : undefined}
              role={forgotten ? 'status' : undefined}
            >
              {forgotten
                ? 'Forgotten. The next locked statement will ask for its password.'
                : 'None saved. When you unlock a statement, you can choose to remember its password on this device.'}
            </p>
          )}
        </section>
      )}

      <section>
        <h2>Erase everything</h2>
        <p>
          Removes every card, statement, transaction and saved password from
          this device, and resets the theme.
        </p>
        {confirmingErase ? (
          <div className="delete-confirm">
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

export default PrivacyPage;
